/**
 * Tests for lib/secret-detect.js (0.15). Uses FAKE/example secrets only.
 * Run: node --test tests/secret-detect.test.js
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detectSecrets, redactText, sha256 } = require('../lib/secret-detect');

const names = (text) => detectSecrets(text).map((d) => d.rule);

describe('detectSecrets — HIGH rules match their shapes', () => {
  const cases = {
    'aws-akia': 'key AKIAIOSFODNN7EXAMPLE here',
    'github-token': `tok ghp_${'a'.repeat(36)} x`,
    'github-pat': `pat github_pat_${'A'.repeat(82)} x`,
    // NB: token bodies are built with repeat()/interpolation so no contiguous
    // provider-key-shaped literal exists in source — otherwise GitHub push
    // protection blocks the push on these (entirely fake) fixtures.
    'anthropic': `key sk-ant-${'a'.repeat(28)} here`,
    'openai': `key sk-${'a'.repeat(26)} here`,
    'slack': `tok xoxb-${'1'.repeat(12)}-${'a'.repeat(12)} here`,
    'gcp-api': `AIza${'A'.repeat(35)} here`,
    'stripe': `key sk_live_${'a'.repeat(24)} here`,
    'tg-bot-token': `1234567890:${'A'.repeat(35)} x`,
    'jwt': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP',
  };
  for (const [rule, text] of Object.entries(cases)) {
    test(`detects ${rule}`, () => assert.ok(names(text).includes(rule), `expected ${rule} in ${JSON.stringify(names(text))}`));
  }
  test('private-key block (BEGIN..END) detected as one match', () => {
    const pk = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADAN\noQ==\n-----END PRIVATE KEY-----';
    const d = detectSecrets(`here is ${pk} ok`);
    assert.equal(d.length, 1);
    assert.equal(d[0].rule, 'private-key');
    assert.ok(d[0].value.includes('END PRIVATE KEY'));
  });
});

describe('detectSecrets — no false positives on ordinary prose', () => {
  for (const t of [
    'Can you review the PR and merge it after CI passes?',
    'the meeting is at 3pm, bring the slides',
    'error code 1234567 happened in the parser',
    'https://example.com/path?x=1 is the link',
  ]) {
    test(`clean: ${t.slice(0, 30)}`, () => assert.deepEqual(detectSecrets(t), []));
  }
});

describe('detectSecrets — group rules redact only the value', () => {
  test('bearer captures the token, not the word Bearer', () => {
    const d = detectSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
    assert.equal(d.length, 1);
    assert.equal(d[0].rule, 'bearer');
    assert.ok(!d[0].value.toLowerCase().includes('bearer'));
  });
  test('kv-secret captures the value, not the key', () => {
    const d = detectSecrets('password: hunter2xy');
    assert.equal(d[0].rule, 'kv-secret');
    assert.equal(d[0].value, 'hunter2xy');
  });

  // Regression (correctness reviewer): when the captured VALUE also appears
  // inside the KEY (e.g. the literal `secret` in `client_secret=secret`), the
  // old indexOf-based offset located the FIRST occurrence (inside the key) and
  // would have spliced the key while leaving the real value in plaintext. The
  // `d`-flag (m.indices) fix locates the exact capture-group span.
  test('kv-secret: value that also appears in the key is located by exact span', () => {
    const d = detectSecrets('client_secret=secret');
    assert.equal(d.length, 1);
    assert.equal(d[0].rule, 'kv-secret');
    assert.equal(d[0].value, 'secret');
    // span must map to the trailing value, not the `secret` inside the key
    assert.equal('client_secret=secret'.slice(d[0].start, d[0].end), 'secret');
    assert.equal(d[0].start, 14);
  });

  test('kv-secret: value-in-key redaction (low on) wipes the VALUE, keeps the key', () => {
    const r = redactText('client_secret=secret', { redactTiers: ['high', 'medium', 'low'] });
    // exact match proves the trailing value `secret` (after `=`) is replaced by
    // the placeholder and the `client_secret` key is preserved intact. (The
    // placeholder itself contains the literal "kv-secret", so a /secret/ regex
    // can't be used here — the exact-equality assertion is the precise check.)
    assert.equal(r.text, 'client_secret=‹redacted:kv-secret›');
  });
});

describe('redactText — HIGH+MEDIUM auto-redact, LOW flagged', () => {
  test('redacts a high token in place, preserving surrounding text', () => {
    const r = redactText('my key is AKIAIOSFODNN7EXAMPLE thanks');
    assert.equal(r.text, 'my key is ‹redacted:aws-akia› thanks');
    assert.equal(r.changed, true);
    assert.equal(r.redacted[0].rule, 'aws-akia');
    assert.equal(r.redacted[0].sha256, sha256('AKIAIOSFODNN7EXAMPLE'));
  });
  test('redacts JWT (medium)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP';
    const r = redactText(`token ${jwt}`);
    assert.equal(r.text, 'token ‹redacted:jwt›');
  });
  test('LOW (kv) is FLAGGED, not redacted (no destroying "password: required")', () => {
    const r = redactText('password: required');
    assert.equal(r.changed, false, 'low not auto-redacted');
    assert.equal(r.text, 'password: required', 'text unchanged');
    assert.equal(r.flagged.length, 1);
    assert.equal(r.flagged[0].rule, 'kv-secret');
  });
  test('LOW redacts when explicitly opted in (redact_secret tool path)', () => {
    const r = redactText('password: hunter2xy', { redactTiers: ['high', 'medium', 'low'] });
    assert.equal(r.text, 'password: ‹redacted:kv-secret›');
  });
  test('bearer redacts only the token', () => {
    const r = redactText('use Bearer abcdefghijklmnopqrstuvwxyz012345 now');
    assert.equal(r.text, 'use Bearer ‹redacted:bearer› now');
  });
  test('multiple secrets in one message all redacted', () => {
    const r = redactText(`a AKIAIOSFODNN7EXAMPLE b ghp_${'a'.repeat(36)} c`);
    assert.equal(r.redacted.length, 2);
    assert.ok(!/AKIA|ghp_/.test(r.text));
  });
  test('idempotent: re-redacting redacted text changes nothing', () => {
    const once = redactText('key AKIAIOSFODNN7EXAMPLE end').text;
    const twice = redactText(once);
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once);
  });
  test('empty / non-string → no-op', () => {
    assert.deepEqual(redactText('').redacted, []);
    assert.deepEqual(redactText(null).redacted, []);
  });
});

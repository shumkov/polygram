const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isSafeToRetry,
  isTransientNetworkError,
  extractCode,
  redactBotToken,
} = require('../lib/net-errors');

function codeErr(code) {
  return Object.assign(new Error(`fake ${code}`), { code });
}

function nameErr(name) {
  const e = new Error('fake');
  e.name = name;
  return e;
}

describe('extractCode', () => {
  test('reads .code directly', () => {
    assert.equal(extractCode(codeErr('ECONNREFUSED')), 'ECONNREFUSED');
  });
  test('reads nested cause.code', () => {
    const inner = codeErr('ENOTFOUND');
    const outer = Object.assign(new Error('wrapped'), { cause: inner });
    assert.equal(extractCode(outer), 'ENOTFOUND');
  });
  test('returns null on plain Error', () => {
    assert.equal(extractCode(new Error('nope')), null);
  });
});

describe('isSafeToRetry', () => {
  test('ECONNREFUSED / ENOTFOUND / EAI_AGAIN / ENETUNREACH / EHOSTUNREACH', () => {
    for (const c of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET']) {
      assert.equal(isSafeToRetry(codeErr(c)), true, `expected ${c} safe`);
    }
  });

  test('ETIMEDOUT / EPIPE are NOT safe (message may have landed)', () => {
    assert.equal(isSafeToRetry(codeErr('ETIMEDOUT')), false);
    assert.equal(isSafeToRetry(codeErr('EPIPE')), false);
  });

  test('HTTP errors (400/500) are NOT safe-to-retry', () => {
    assert.equal(isSafeToRetry({ error_code: 400, description: 'Bad Request' }), false);
    assert.equal(isSafeToRetry({ error_code: 500 }), false);
  });

  test('null / undefined return false', () => {
    assert.equal(isSafeToRetry(null), false);
    assert.equal(isSafeToRetry(undefined), false);
  });
});

describe('isTransientNetworkError', () => {
  test('all pre-connect errors are transient', () => {
    assert.equal(isTransientNetworkError(codeErr('ECONNREFUSED')), true);
    assert.equal(isTransientNetworkError(codeErr('ETIMEDOUT')), true);
  });
  test('abort/timeout/fetch errors match by name', () => {
    assert.equal(isTransientNetworkError(nameErr('AbortError')), true);
    assert.equal(isTransientNetworkError(nameErr('TimeoutError')), true);
    assert.equal(isTransientNetworkError(nameErr('FetchError')), true);
  });
  test('random errors return false', () => {
    assert.equal(isTransientNetworkError(new Error('weird')), false);
  });
});

describe('redactBotToken', () => {
  test('redacts canonical bot${TOKEN} URL form', () => {
    const s = 'fetch failed: https://api.telegram.org/bot1234567890:AAEabcdefghijklmnopqrstuvwxyz012345/sendMessage 401';
    const out = redactBotToken(s);
    assert.match(out, /bot<redacted>\/sendMessage/);
    assert.doesNotMatch(out, /AAH2y3z4/);
  });

  test('redacts URL-encoded colon (bot1234%3AAAH...)', () => {
    const s = 'request to bot987654321%3AAAH-foo-bar-baz-qux-quux-corge-grault-garply timed out';
    const out = redactBotToken(s);
    assert.match(out, /bot<redacted>/);
    assert.doesNotMatch(out, /987654321/);
  });

  test('redacts bare canonical token shape anywhere in string', () => {
    const s = 'log line: token=1234567890:AAEabcdefghijklmnopqrstuvwxyz012345 more text';
    const out = redactBotToken(s);
    assert.match(out, /token=<redacted-token>/);
  });

  test('redacts Authorization: Bearer header form', () => {
    const s = 'request headers: Authorization: Bearer 1234567890:AAEabcdefghijklmnopqrstuvwxyz012345 content-type: ...';
    const out = redactBotToken(s);
    assert.match(out, /Authorization: Bearer <redacted>/);
    assert.doesNotMatch(out, /AAH2y3z4/);
  });

  test('redacts bot_token=... query string form', () => {
    const s = 'callback?bot_token=1234567890:AAEabcdefghijklmnopqrstuvwxyz012345&chat_id=42';
    const out = redactBotToken(s);
    assert.match(out, /bot_token=<redacted>/);
    assert.match(out, /chat_id=42/);
  });

  test('passes through strings with no token', () => {
    assert.equal(redactBotToken('plain error: ECONNREFUSED'), 'plain error: ECONNREFUSED');
  });

  test('null/undefined/empty pass through', () => {
    assert.equal(redactBotToken(null), null);
    assert.equal(redactBotToken(undefined), undefined);
    assert.equal(redactBotToken(''), '');
  });

  test('non-string coerces to string', () => {
    const out = redactBotToken({ toString: () => 'bot1234567890:AAEabcdefghijklmnopqrstuvwxyz012345' });
    assert.match(out, /bot<redacted>/);
  });
});


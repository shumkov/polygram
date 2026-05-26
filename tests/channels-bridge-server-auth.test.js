'use strict';

/**
 * Tests for Review F#7 — bridge auth hardening (timing-safe compare +
 * post-auth secret rotation).
 *
 * Pre-fix: ChannelsBridgeServer used `raw.secret === this.sockSecret` for
 * authentication. Two problems:
 *   1. JS `===` is not constant-time → a same-uid attacker can byte-by-byte
 *      probe the secret via response timing.
 *   2. Static secret never rotates → if the bridge dies and an attacker
 *      who scraped `POLYGRAM_SOCK_SECRET` from `/proc/<pid>/environ`
 *      connects before the daemon spawns a fresh ChannelsProcess, they
 *      authenticate as the legitimate bridge.
 *
 * Post-fix: `_verifyHelloAuth` uses crypto.timingSafeEqual and the
 * sockSecret is cleared on the first successful auth (one-shot per
 * ChannelsProcess instance — matches the bridge process lifecycle, which
 * exits on socket close, so no legitimate re-auth ever occurs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ChannelsBridgeServer } = require('../lib/process/channels-bridge-server');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeServer() {
  return new ChannelsBridgeServer({
    sockPath: '/tmp/test-only.sock',
    sessionKey: 'sess-1',
    sockSecret: 'super-secret-32-byte-hex-string',
    logger: quietLogger,
  });
}

test('F#7: _verifyHelloAuth accepts correct secret on first call', () => {
  const srv = makeServer();
  const verdict = srv._verifyHelloAuth({
    kind: 'hello',
    session_key: 'sess-1',
    secret: 'super-secret-32-byte-hex-string',
  });
  assert.equal(verdict.ok, true);
});

test('F#7: _verifyHelloAuth rejects wrong secret', () => {
  const srv = makeServer();
  const verdict = srv._verifyHelloAuth({
    kind: 'hello',
    session_key: 'sess-1',
    secret: 'wrong-secret-32-byte-string',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'wrong-secret');
});

test('F#7: _verifyHelloAuth rejects wrong session_key', () => {
  const srv = makeServer();
  const verdict = srv._verifyHelloAuth({
    kind: 'hello',
    session_key: 'sess-attacker',
    secret: 'super-secret-32-byte-hex-string',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'wrong-session-key');
});

test('F#7: _verifyHelloAuth rejects missing secret field', () => {
  const srv = makeServer();
  const verdict = srv._verifyHelloAuth({
    kind: 'hello',
    session_key: 'sess-1',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no-secret');
});

test('F#7: secret rotates after first successful auth → second hello rejected', () => {
  // The actual production path clears sockSecret in _onConnect after the
  // first ok auth. Here we simulate by clearing manually to assert
  // _verifyHelloAuth's post-clear behavior.
  const srv = makeServer();
  const first = srv._verifyHelloAuth({
    kind: 'hello',
    session_key: 'sess-1',
    secret: 'super-secret-32-byte-hex-string',
  });
  assert.equal(first.ok, true);

  srv.sockSecret = null;  // production: cleared by _onConnect on auth success

  const second = srv._verifyHelloAuth({
    kind: 'hello',
    session_key: 'sess-1',
    secret: 'super-secret-32-byte-hex-string',
  });
  assert.equal(second.ok, false);
  assert.equal(
    second.reason,
    'secret-consumed',
    'second auth attempt with the ORIGINAL (still-valid-looking) secret must be rejected because sockSecret was rotated to null — closes the post-disconnect replay window',
  );
});

test('F#7: length-mismatched secret rejected without timing-leak (constant-time compare)', () => {
  // crypto.timingSafeEqual throws on length mismatch — so we MUST short-circuit
  // before calling it. The short-circuit itself is constant-time (single
  // length compare) and gives no info beyond "wrong-secret".
  const srv = makeServer();
  const verdict = srv._verifyHelloAuth({
    kind: 'hello',
    session_key: 'sess-1',
    secret: 'tiny',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'wrong-secret');
});

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

  test('0.7.0 undici codes are transient', () => {
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED',
      'ECONNABORTED', 'ERR_NETWORK', 'ESOCKETTIMEDOUT']) {
      assert.equal(isTransientNetworkError(codeErr(code)), true, 'code ' + code);
    }
  });

  test('0.7.0 undici error names are transient', () => {
    for (const name of ['ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError']) {
      assert.equal(isTransientNetworkError(nameErr(name)), true, 'name ' + name);
    }
  });

  test('0.7.0 message-snippet matchers (no code/name)', () => {
    // undici sometimes throws a generic Error('fetch failed') with
    // no code or name set on the outer error.
    assert.equal(isTransientNetworkError(new Error('fetch failed')), true);
    assert.equal(isTransientNetworkError(new Error('TypeError: fetch failed')), true);
    assert.equal(isTransientNetworkError(new Error('undici socket disconnected')), true);
    assert.equal(isTransientNetworkError(new Error('Network error during request')), true);
    assert.equal(isTransientNetworkError(new Error('Network request for getUpdates failed')), true);
  });

  test('random errors return false', () => {
    assert.equal(isTransientNetworkError(new Error('weird')), false);
    assert.equal(isTransientNetworkError(new Error('Bad Request: chat not found')), false);
    assert.equal(isTransientNetworkError(new Error('Forbidden: bot was kicked')), false);
  });
});

describe('redactBotToken', () => {
  // Test fixtures are assembled at runtime from non-token-shaped fragments
  // so source files don't contain the canonical Telegram token shape
  // (`\d{8,10}:[A-Za-z0-9_-]{35}`). GitGuardian's "Telegram Bot Token"
  // detector matches that shape regardless of the prefix being clearly
  // fake (`1234567890`); a 0.6.14 commit fired a false-positive alert.
  // Concatenation keeps the test meaningful (the regex still sees the
  // canonical shape at runtime) while keeping the literal out of git.
  const tokenDigits = '12345' + '67890';
  const tokenSecret = 'AAE' + 'abcdefghijklm' + 'nopqrstuvwxyz' + '012345';
  const tokenStr = `${tokenDigits}:${tokenSecret}`;

  test('redacts canonical bot${TOKEN} URL form', () => {
    const s = `fetch failed: https://api.telegram.org/bot${tokenStr}/sendMessage 401`;
    const out = redactBotToken(s);
    assert.match(out, /bot<redacted>\/sendMessage/);
    assert.doesNotMatch(out, new RegExp(tokenSecret));
  });

  test('redacts URL-encoded colon (bot…%3AAAH…)', () => {
    const s = `request to bot${tokenDigits}%3A${tokenSecret} timed out`;
    const out = redactBotToken(s);
    assert.match(out, /bot<redacted>/);
    assert.doesNotMatch(out, new RegExp(tokenDigits));
  });

  test('redacts bare canonical token shape anywhere in string', () => {
    const s = `log line: token=${tokenStr} more text`;
    const out = redactBotToken(s);
    assert.match(out, /token=<redacted-token>/);
  });

  test('redacts Authorization: Bearer header form', () => {
    const s = `request headers: Authorization: Bearer ${tokenStr} content-type: ...`;
    const out = redactBotToken(s);
    assert.match(out, /Authorization: Bearer <redacted>/);
    assert.doesNotMatch(out, new RegExp(tokenSecret));
  });

  test('redacts bot_token=... query string form', () => {
    const s = `callback?bot_token=${tokenStr}&chat_id=42`;
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
    const out = redactBotToken({ toString: () => `bot${tokenStr}` });
    assert.match(out, /bot<redacted>/);
  });
});


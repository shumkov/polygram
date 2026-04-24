const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isSafeToRetry,
  isTransientNetworkError,
  extractCode,
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

/**
 * Tests for lib/error/classify.js.
 *
 * Covers every PATTERNS entry, every CODES short-circuit, every
 * SDK_MESSAGE_ERROR / SDK_RESULT_SUBTYPE map entry, plus defensive
 * handling of null/undefined/non-Error inputs.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  classify,
  isTransientHttpError,
  PATTERNS,
  USER_MESSAGES,
  AUTO_RECOVER,
  CODES,
} = require('../lib/error/classify');

describe('classify — typed-code short-circuit', () => {
  test('QUEUE_OVERFLOW returns the queue-overflow shape exactly', () => {
    const err = Object.assign(new Error('queue full'), { code: 'QUEUE_OVERFLOW' });
    const r = classify(err);
    assert.equal(r.kind, 'queueOverflow');
    assert.match(r.userMessage, /Couldn't keep up/);
    assert.equal(r.isTransient, false);
    assert.equal(r.autoRecover, null);
  });

  test('INTERRUPTED suppresses user message (returns null)', () => {
    const err = Object.assign(new Error('aborted'), { code: 'INTERRUPTED' });
    const r = classify(err);
    assert.equal(r.kind, 'interrupted');
    assert.equal(r.userMessage, null);
  });

  test('RESET_SESSION returns the fresh-session message', () => {
    const r = classify({ code: 'RESET_SESSION' });
    assert.equal(r.kind, 'resetSession');
    assert.match(r.userMessage, /fresh session/);
  });

  test('AUTH_EXPIRED returns the operator-notified message', () => {
    const r = classify({ code: 'AUTH_EXPIRED' });
    assert.equal(r.kind, 'authExpired');
    assert.match(r.userMessage, /operator has been notified/);
  });

  test('typed code wins over pattern even when message would also match', () => {
    // A QUEUE_OVERFLOW error whose message ALSO mentions 429 — code
    // takes priority so we never accidentally surface "rate-limited"
    // to a user whose message was just dropped.
    const err = Object.assign(new Error('429 rate limit'), { code: 'QUEUE_OVERFLOW' });
    const r = classify(err);
    assert.equal(r.kind, 'queueOverflow');
  });
});

describe('classify — PATTERNS coverage (one sample per kind)', () => {
  test('rateLimit matches 429', () => {
    assert.equal(classify(new Error('HTTP 429: Too Many Requests')).kind, 'rateLimit');
  });
  test('rateLimit matches "rate-limit" text', () => {
    assert.equal(classify(new Error('rate-limit exceeded for tokens per minute')).kind, 'rateLimit');
  });
  test('billing matches 402', () => {
    assert.equal(classify(new Error('HTTP 402 Payment Required')).kind, 'billing');
  });
  test('billing matches "insufficient credit"', () => {
    assert.equal(classify(new Error('insufficient credit on workspace')).kind, 'billing');
  });
  test('authExpired matches 401', () => {
    assert.equal(classify(new Error('HTTP 401 Unauthorized')).kind, 'authExpired');
  });
  test('authExpired matches OAuth refresh failure', () => {
    assert.equal(classify(new Error('oauth token refresh failed')).kind, 'authExpired');
  });
  test('contextOverflow matches "prompt is too long"', () => {
    assert.equal(classify(new Error('prompt is too long for the model')).kind, 'contextOverflow');
  });
  test('contextOverflow matches context window message', () => {
    assert.equal(classify(new Error('context window exceeded by 5000 tokens')).kind, 'contextOverflow');
  });
  test('roleOrdering matches alternation error', () => {
    assert.equal(classify(new Error('roles must alternate between user and assistant')).kind, 'roleOrdering');
  });
  test('missingToolInput matches', () => {
    assert.equal(classify(new Error('tool_use block is missing input field')).kind, 'missingToolInput');
  });
  test('timeout matches polygram idle', () => {
    assert.equal(classify(new Error('Timeout: 600s idle with no Claude activity')).kind, 'timeout');
  });
  test('timeout matches polygram wall-clock', () => {
    assert.equal(classify(new Error('Turn exceeded 1800s wall-clock ceiling')).kind, 'timeout');
  });
  test('timeout matches generic "timed out"', () => {
    assert.equal(classify(new Error('request timed out after 30s')).kind, 'timeout');
  });
  test('format matches invalid_request', () => {
    assert.equal(classify(new Error('invalid_request: bad parameter')).kind, 'format');
  });
  test('transient5xx matches 503', () => {
    assert.equal(classify(new Error('HTTP 503 Service Unavailable')).kind, 'transient5xx');
  });
  test('transient5xx matches Cloudflare 521-524', () => {
    for (const code of [521, 522, 523, 524, 529]) {
      assert.equal(
        classify(new Error(`upstream returned status ${code}`)).kind,
        'transient5xx',
        `code ${code} should classify as transient5xx`,
      );
    }
  });
  test('transient5xx matches "temporarily overloaded"', () => {
    assert.equal(classify(new Error('The AI service is temporarily overloaded')).kind, 'transient5xx');
  });
});

describe('classify — fall-through to "unknown"', () => {
  test('unmatched message produces "Hit a snag: ..." reply', () => {
    const r = classify(new Error('something went totally wrong in flux capacitor'));
    assert.equal(r.kind, 'unknown');
    assert.match(r.userMessage, /Hit a snag/);
    assert.match(r.userMessage, /flux capacitor/);
  });

  test('unknown reason truncates at 120 chars', () => {
    const longMsg = 'x'.repeat(500);
    const r = classify(new Error(longMsg));
    assert.equal(r.kind, 'unknown');
    // The reason snippet is 120 chars max; user message includes
    // wrapping text ("Hit a snag: " + reason + ". Try resending.")
    assert.ok(r.userMessage.length < 200);
  });

  test('unknown takes only first line', () => {
    const r = classify(new Error('first line\nsecond line\nthird line'));
    assert.match(r.userMessage, /first line/);
    assert.doesNotMatch(r.userMessage, /second line/);
  });
});

describe('classify — defensive against weird inputs', () => {
  test('null input returns unknown', () => {
    const r = classify(null);
    assert.equal(r.kind, 'unknown');
    assert.match(r.userMessage, /Hit a snag/);
  });
  test('undefined input returns unknown', () => {
    const r = classify(undefined);
    assert.equal(r.kind, 'unknown');
  });
  test('plain string passes through pattern matching', () => {
    const r = classify('HTTP 429: rate limit');
    assert.equal(r.kind, 'rateLimit');
  });
  test('object without message but with err.error matches', () => {
    const r = classify({ error: 'context window exceeded' });
    assert.equal(r.kind, 'contextOverflow');
  });
  test('numeric input does not crash', () => {
    assert.doesNotThrow(() => classify(42));
    assert.equal(classify(42).kind, 'unknown');
  });
});

describe('classify — autoRecover semantics (G9 wiring)', () => {
  // The kinds mapped to autoRecover='reset_session' are what
  // polygram's classifier-driven auto-recovery uses to decide
  // whether to call pm.resetSession on a failed turn (Phase 2
  // step 8). Pin the exact set so a future classifier extension
  // can't silently change which kinds auto-heal.

  test('contextOverflow → autoRecover=reset_session', () => {
    assert.equal(
      classify(new Error('prompt is too long')).autoRecover,
      'reset_session',
    );
  });

  test('roleOrdering → autoRecover=reset_session', () => {
    assert.equal(
      classify(new Error('role alternation violated')).autoRecover,
      'reset_session',
    );
  });

  test('missingToolInput → autoRecover=reset_session', () => {
    assert.equal(
      classify(new Error('tool_use input is missing')).autoRecover,
      'reset_session',
    );
  });

  test('rateLimit / billing / authExpired do NOT auto-recover', () => {
    // Auto-resetting on rate-limit would burn quota + kill resume.
    // Auth-expired needs operator action, not a fresh Query.
    // Billing needs operator action, same.
    assert.equal(classify(new Error('429 too many requests')).autoRecover, null);
    assert.equal(classify(new Error('payment required')).autoRecover, null);
    assert.equal(classify(new Error('401 unauthorized')).autoRecover, null);
  });

  test('transient5xx does NOT auto-recover (pm retries first)', () => {
    // pm.send() handles its own one-shot transient retry; resetSession
    // would clobber the in-flight context.
    assert.equal(classify(new Error('HTTP 503 service unavailable')).autoRecover, null);
  });

  test('unknown does NOT auto-recover', () => {
    assert.equal(classify(new Error('mysterious failure')).autoRecover, null);
  });

  test('SDK subtype mapping inherits the kind\'s autoRecover', () => {
    // error_max_turns maps to "format" kind which is null autoRecover.
    // Documents that subtype-mapped kinds get the same auto-recover
    // policy as their pattern-matched siblings.
    assert.equal(
      classify({ subtype: 'error_max_turns' }).autoRecover,
      null,
    );
  });
});

describe('classify — SDK error subtypes (post-0.8.0 forward-compat)', () => {
  test('SDKAssistantMessage.error="authentication_failed" → authExpired', () => {
    // Plain string per sdk.d.ts:2343 union.
    assert.equal(classify('authentication_failed').kind, 'authExpired');
  });
  test('SDKAssistantMessage.error="billing_error" → billing', () => {
    assert.equal(classify('billing_error').kind, 'billing');
  });
  test('SDKAssistantMessage.error="rate_limit" → rateLimit', () => {
    assert.equal(classify('rate_limit').kind, 'rateLimit');
  });
  test('SDKAssistantMessage.error="invalid_request" → format', () => {
    assert.equal(classify('invalid_request').kind, 'format');
  });
  test('SDKAssistantMessage.error="server_error" → transient5xx (auto-retry eligible)', () => {
    const r = classify('server_error');
    assert.equal(r.kind, 'transient5xx');
    assert.equal(r.isTransient, true);
  });
  test('SDKAssistantMessage.error="max_output_tokens" → format', () => {
    assert.equal(classify('max_output_tokens').kind, 'format');
  });
  test('SDKAssistantMessage.error="unknown" falls through to pattern matching', () => {
    // The literal string "unknown" hits no pattern → "unknown" kind.
    assert.equal(classify('unknown').kind, 'unknown');
  });

  test('SDKResultMessage{subtype:"error_max_budget_usd"} → billing', () => {
    assert.equal(classify({ subtype: 'error_max_budget_usd' }).kind, 'billing');
  });
  test('SDKResultMessage{subtype:"error_max_turns"} → format', () => {
    assert.equal(classify({ subtype: 'error_max_turns' }).kind, 'format');
  });
  test('SDKResultMessage{subtype:"error_max_structured_output_retries"} → format', () => {
    assert.equal(classify({ subtype: 'error_max_structured_output_retries' }).kind, 'format');
  });
  test('SDKResultMessage{subtype:"error_during_execution"} falls through (kind→unknown unless message matches)', () => {
    // We let the message text carry the real diagnosis on this
    // generic subtype — it's the catch-all.
    const r = classify({ subtype: 'error_during_execution', message: 'HTTP 503' });
    assert.equal(r.kind, 'transient5xx');
  });
  test('SDKResultMessage{subtype:"success"} returns null subtype-match (callers handle separately)', () => {
    // success isn't actually an "error" — this exercise confirms the
    // subtype matcher doesn't accidentally claim success means
    // something. Falls through to "unknown" because there's no
    // message text.
    assert.equal(classify({ subtype: 'success' }).kind, 'unknown');
  });
});

describe('isTransientHttpError', () => {
  test('returns true for 5xx', () => {
    assert.equal(isTransientHttpError(new Error('HTTP 503')), true);
    assert.equal(isTransientHttpError(new Error('HTTP 502')), true);
    assert.equal(isTransientHttpError(new Error('HTTP 521 — Cloudflare')), true);
  });
  test('returns true for rate-limit (also retryable)', () => {
    assert.equal(isTransientHttpError(new Error('429 rate-limit')), true);
  });
  test('returns false for auth/billing/context (not retryable)', () => {
    assert.equal(isTransientHttpError(new Error('HTTP 401')), false);
    assert.equal(isTransientHttpError(new Error('HTTP 402')), false);
    assert.equal(isTransientHttpError(new Error('context window exceeded')), false);
  });
  test('returns false for unknown', () => {
    assert.equal(isTransientHttpError(new Error('weird')), false);
  });
  test('returns false for typed codes', () => {
    assert.equal(isTransientHttpError({ code: 'QUEUE_OVERFLOW' }), false);
    assert.equal(isTransientHttpError({ code: 'INTERRUPTED' }), false);
  });
});

describe('public exports — sanity', () => {
  test('PATTERNS is exported with all keys having USER_MESSAGES', () => {
    for (const kind of Object.keys(PATTERNS)) {
      assert.ok(USER_MESSAGES[kind], `kind ${kind} must have a user message`);
    }
  });
  test('AUTO_RECOVER keys are subset of PATTERNS keys', () => {
    for (const kind of Object.keys(AUTO_RECOVER)) {
      assert.ok(PATTERNS[kind] || CODES[kind.toUpperCase()],
        `AUTO_RECOVER kind ${kind} must exist in PATTERNS or CODES`);
    }
  });
  test('every CODES entry has a kind, userMessage handling, isTransient, autoRecover', () => {
    for (const [code, shape] of Object.entries(CODES)) {
      assert.ok(typeof shape.kind === 'string', `CODES.${code}.kind`);
      assert.ok('userMessage' in shape, `CODES.${code}.userMessage`); // null is valid
      assert.equal(typeof shape.isTransient, 'boolean', `CODES.${code}.isTransient`);
      assert.ok('autoRecover' in shape, `CODES.${code}.autoRecover`);
    }
  });
});

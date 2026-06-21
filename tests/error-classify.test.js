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

  // ─── Review F#5: channels-specific error codes get proper user messages ──
  //
  // Pre-fix all four channels error codes fell through CODES table to the
  // generic 'unknown' kind → user saw "Hit a snag: bridge disconnected. Try
  // resending." (or worse: the raw 'turn timeout (600000ms)' string). Mirrors
  // the rc.46→rc.47 tmuxToolWedge incident exactly.

  test('F#5: BRIDGE_DISCONNECTED has a dedicated kind + user-facing message', () => {
    const err = Object.assign(new Error('bridge disconnected'), { code: 'BRIDGE_DISCONNECTED' });
    const r = classify(err);
    assert.notEqual(r.kind, 'unknown', 'must not fall through to unknown');
    assert.equal(r.kind, 'bridgeDisconnected');
    assert.ok(r.userMessage && r.userMessage.length > 0, 'must surface a user-facing message');
  });

  test('F#5: CHANNELS_HANDSHAKE_TIMEOUT has a dedicated kind + user-facing message', () => {
    const err = Object.assign(new Error('handshake timeout'), { code: 'CHANNELS_HANDSHAKE_TIMEOUT' });
    const r = classify(err);
    assert.notEqual(r.kind, 'unknown');
    assert.equal(r.kind, 'channelsHandshakeTimeout');
    assert.ok(r.userMessage && r.userMessage.length > 0);
  });

  test('F#5: CHANNELS_DIALOG_TIMEOUT has a dedicated kind + user-facing message', () => {
    const err = Object.assign(new Error('dialog timeout'), { code: 'CHANNELS_DIALOG_TIMEOUT' });
    const r = classify(err);
    assert.notEqual(r.kind, 'unknown');
    assert.equal(r.kind, 'channelsDialogTimeout');
    assert.ok(r.userMessage && r.userMessage.length > 0);
  });

  test('F#5: TURN_TIMEOUT has a dedicated kind + user-facing message', () => {
    const err = Object.assign(new Error('turn timeout (600000ms)'), { code: 'TURN_TIMEOUT' });
    const r = classify(err);
    assert.notEqual(r.kind, 'unknown');
    assert.equal(r.kind, 'turnTimeout');
    assert.ok(r.userMessage && r.userMessage.length > 0);
  });

  // 0.16 busy-aware ceiling: a turn that kept extending while working but hit
  // the hard wall-clock backstop gets a DISTINCT code + message from a
  // went-quiet TURN_TIMEOUT, so the user knows it ran long vs stalled.
  test('0.16: TURN_MAX_EXCEEDED has its own kind + message, distinct from TURN_TIMEOUT', () => {
    const maxed = classify(Object.assign(new Error('turn timeout (5400000ms, reason=hard-max)'), { code: 'TURN_MAX_EXCEEDED' }));
    assert.equal(maxed.kind, 'turnMaxExceeded');
    assert.ok(maxed.userMessage && maxed.userMessage.length > 0);
    assert.equal(maxed.isTransient, false);
    const quiet = classify(Object.assign(new Error('turn timeout'), { code: 'TURN_TIMEOUT' }));
    assert.notEqual(maxed.userMessage, quiet.userMessage, 'max-exceeded copy must differ from went-quiet copy');
  });
});

describe('classifyTurnEndError — streamer suffix + reactor state for turn-end errors', () => {
  const { classifyTurnEndError } = require('../lib/error/classify');
  test('TURN_TIMEOUT (went quiet) → stream-interrupted suffix + TIMEOUT reactor', () => {
    const r = classifyTurnEndError(Object.assign(new Error('turn timeout'), { code: 'TURN_TIMEOUT' }));
    assert.equal(r.errorSuffix, 'stream interrupted');
    assert.equal(r.reactorState, 'TIMEOUT');
  });
  test('TURN_MAX_EXCEEDED (hit hard cap) → TIMEOUT reactor (not generic ERROR)', () => {
    const r = classifyTurnEndError(Object.assign(new Error('hard max'), { code: 'TURN_MAX_EXCEEDED' }));
    assert.equal(r.reactorState, 'TIMEOUT');
  });
  test('an unrelated error → generic ERROR reactor', () => {
    const r = classifyTurnEndError(new Error('something else blew up'));
    assert.equal(r.reactorState, 'ERROR');
  });
  // Regression (0.16 code review finding #1): SDK + tmux backends reject with a
  // MESSAGE and NO err.code. Without the legacy regex fallback their timeouts
  // flip from the calm ⏱ TIMEOUT reactor to the scary ERROR one.
  test('SDK-shaped wall-clock timeout (message, NO code) → TIMEOUT reactor', () => {
    const r = classifyTurnEndError(new Error('Turn exceeded 1800s wall-clock ceiling'));
    assert.equal(r.reactorState, 'TIMEOUT');
  });
  test('SDK-shaped idle timeout (message, NO code) → TIMEOUT reactor', () => {
    const r = classifyTurnEndError(new Error('Timeout: 600s idle with no Claude activity'));
    assert.equal(r.reactorState, 'TIMEOUT');
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

  // 2026-05-13 production incident: shumabit Dina DM accumulated 53
  // images over 2 weeks. Session got wedged returning 400 "Could not
  // process image" on EVERY new turn (Anthropic rejecting an old image
  // block in the resumed transcript). Pre-fix this fell through to
  // 'unknown' → raw JSON dumped into the chat as bot's reply.
  test('imageProcess matches Anthropic "Could not process image" 400', () => {
    const r = classify(new Error(
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"Could not process image"},"request_id":"req_011Cayz1auK3HVVWsG49JdBn"}'
    ));
    assert.equal(r.kind, 'imageProcess');
    assert.match(r.userMessage, /image/i);
    // Friendly message — NOT the raw API JSON.
    assert.doesNotMatch(r.userMessage, /\{"type":"error"/);
    // Session unwedge: this kind of error means the persisted transcript
    // has bad image data. /compact may also fail (it has to load the
    // same history). Reset is the only reliable recovery.
    assert.equal(r.autoRecover, 'reset_session');
  });

  test('imageProcess matches bare "Could not process image"', () => {
    assert.equal(classify(new Error('Could not process image')).kind, 'imageProcess');
  });

  test('imageProcess matches "invalid image" variations', () => {
    assert.equal(classify(new Error('image content is invalid or corrupted')).kind, 'imageProcess');
    assert.equal(classify(new Error('unsupported image type')).kind, 'imageProcess');
  });

  test('imageProcess does NOT match generic image references (regression guard)', () => {
    // We don't want innocuous mentions of "image" to wrongly classify.
    assert.notEqual(classify(new Error('Read the image at /tmp/foo.jpg')).kind, 'imageProcess');
    assert.notEqual(classify(new Error('user shared a photo')).kind, 'imageProcess');
  });
});

describe('detectWedgedSessionError', () => {
  const { detectWedgedSessionError } = require('../lib/error/classify');

  test('detects the 2026-05-13 Dina DM incident text', () => {
    const text = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"},"request_id":"req_011Cayz1auK3HVVWsG49JdBn"}';
    const r = detectWedgedSessionError(text);
    assert.ok(r, 'must detect wrapped API error in assistant text');
    assert.equal(r.kind, 'imageProcess');
    assert.equal(r.autoRecover, 'reset_session');
    assert.match(r.userMessage, /image/i);
    // Friendly text — NOT raw JSON.
    assert.doesNotMatch(r.userMessage, /\{"type"/);
  });

  test('detects API Error wrapping for other classes (rate-limit on resume)', () => {
    const text = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}';
    const r = detectWedgedSessionError(text);
    assert.ok(r);
    assert.equal(r.kind, 'rateLimit');
  });

  test('null when assistant text is a normal reply', () => {
    assert.equal(detectWedgedSessionError('Hello! Here is your answer.'), null);
    assert.equal(detectWedgedSessionError('The order total is $42.00.'), null);
  });

  test('null when text MENTIONS API Error without the wrapper prefix', () => {
    // A user could legitimately ask "explain API Error: 400 codes" and
    // get a Claude response that includes that phrase mid-sentence.
    // The detector should NOT classify these.
    assert.equal(detectWedgedSessionError(
      'When the API returns a 400 error, you should check the request body.'
    ), null);
    assert.equal(detectWedgedSessionError(
      'Here is an example response:\nAPI Error: 400 {"type":"error"...}\nNotice it is structured JSON.'
    ), null, 'embedded in body, not the literal prefix');
  });

  test('null on empty / non-string input', () => {
    assert.equal(detectWedgedSessionError(''), null);
    assert.equal(detectWedgedSessionError(null), null);
    assert.equal(detectWedgedSessionError(undefined), null);
    assert.equal(detectWedgedSessionError(42), null);
  });

  test('unknown wedge class still triggers reset_session (safe default)', () => {
    // A wrapped API error with an unrecognised body — we still know the
    // session is wedged because the SDK shouldn't be emitting these as
    // assistant text. Return a safe imageProcess shape so the recovery
    // path runs.
    const text = 'API Error: 400 {"type":"error","error":{"type":"unknown_future_error","message":"something new"}}';
    const r = detectWedgedSessionError(text);
    assert.ok(r);
    assert.equal(r.autoRecover, 'reset_session');
  });
});

describe('classify — fall-through to "unknown" NEVER leaks raw internals (known-issue #2.2)', () => {
  // 2026-06-03 incident: the unknown fallthrough echoed the raw error string
  // into the chat — users saw "Hit a snag: [Shumabit@HOME:startup-gate] tmux
  // session disappeared … ▰▰▰ 27%". The raw detail belongs in the events log
  // (handler-error.detail_json), NOT in a user's chat. The user gets a calm,
  // generic, actionable line; the raw text must NOT appear in userMessage.
  test('unmatched message → generic calm line, raw text suppressed', () => {
    const r = classify(new Error('[Shumabit@HOME:startup-gate] tmux session disappeared for polygram-x ▰▰▰ 27%'));
    assert.equal(r.kind, 'unknown');
    assert.doesNotMatch(r.userMessage, /tmux|startup-gate|Shumabit|▰|polygram-x/,
      'no internal identifiers may reach the user');
    assert.match(r.userMessage, /try resending|\/new/i, 'must still tell the user what to do');
  });

  test('a long/multi-line raw error never bloats or leaks into the reply', () => {
    const r = classify(new Error('secret internal line\n' + 'x'.repeat(500)));
    assert.equal(r.kind, 'unknown');
    assert.doesNotMatch(r.userMessage, /secret internal line|xxxx/);
    assert.ok(r.userMessage.length < 160, 'generic line stays short');
  });

  test('process-exit codes get a friendly transient line, not a leak (observed: code 129)', () => {
    const r = classify(new Error('Claude Code process exited with code 129'));
    assert.notEqual(r.kind, 'unknown', 'a recurring kind should be classified, not generic');
    assert.doesNotMatch(r.userMessage, /129|exited with code/, 'no raw exit detail to the user');
    assert.match(r.userMessage, /resend|again|moment/i);
    assert.equal(r.isTransient, true, 'a respawn fixes it → transient');
  });
});

describe('classify — defensive against weird inputs', () => {
  test('null input returns unknown', () => {
    const r = classify(null);
    assert.equal(r.kind, 'unknown');
    assert.match(r.userMessage, /Something went wrong/);
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

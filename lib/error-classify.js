/**
 * Error classifier — maps any error from any source to a stable shape.
 *
 * Sources today (0.7.7): stream-json `result` events with error
 * subtypes, child_process `'close'`/`'error'` event errors, idle
 * timer fires, polygram-internal Errors with `err.code` set.
 *
 * Sources after 0.8.0 SDK migration: SDK iterator throws
 * (`AbortError` named class plus plain `Error`s), `SDKResultMessage`
 * with subtypes `error_during_execution` / `error_max_turns` /
 * `error_max_budget_usd` / `error_max_structured_output_retries`,
 * per-message `SDKAssistantMessage.error` subtypes
 * (`authentication_failed` / `billing_error` / `rate_limit` /
 * `invalid_request` / `server_error` / `unknown` / `max_output_tokens`),
 * 5xx HTTP errors that bubble through the SDK transport.
 *
 * Returning the same shape regardless of transport means
 * `errorReplyText` in polygram.js doesn't grow N branches every time
 * a new error class shows up — we just add a row to PATTERNS or a
 * `code:` short-circuit at the top.
 *
 * Layered ship order (per v4 plan §6.5.1):
 *   - 0.7.7 (this file): transport-agnostic patterns and the public
 *     `classify()` API. Polygram.js's `errorReplyText` consults this
 *     module directly.
 *   - Phase 1 of 0.8.0 (later): adds typed-code branches for
 *     `INTERRUPTED`, plus SDK `error_max_structured_output_retries`,
 *     plus per-message SDK error subtypes.
 *   - Phase 2 of 0.8.0 (later): adds AUTO_RECOVER actions
 *     (`reset_session` etc) so pm can self-heal stuck sessions
 *     without waiting for the user to type /new.
 */

'use strict';

// Substring/regex patterns matched against the error string. Order
// is significant only when patterns overlap — `transient5xx` is last
// because the others (auth/billing/format) carry their own status
// codes too. First match wins.
const PATTERNS = {
  // Anthropic API rate limit (429) — "rate-limited", "Too Many
  // Requests", token-bucket exhaustion text.
  rateLimit:        /\b429\b|rate[_ ]?limit|too[_ ]many[_ ]requests|tokens? per minute/i,

  // Billing / quota (402, "insufficient credit"). Fires before any
  // model call when the workspace is out of funds.
  billing:          /\b402\b|payment[_ ]required|billing|insufficient[_ ]credit/i,

  // Auth: 401/403, OAuth token expiry, refresh failure. The 0.8.0
  // plan ships an explicit auth-expired UX (admin-chat notify +
  // pause); 0.7.7 just maps to a friendlier user message.
  authExpired:      /\b401\b|\b403\b|unauthor(ized|ised)|forbidden|token[_ ]expired|oauth[_ ]token[_ ]refresh[_ ]failed/i,

  // Context window exceeded — too many tokens for the model. Usually
  // surfaces as `prompt is too long` from Anthropic; sometimes as
  // generic "exceeds maximum context" depending on SDK version.
  contextOverflow:  /context[_ ](window|length)|prompt[_ ]too[_ ]large|exceeds[_ ]maximum[_ ]context|prompt is too long/i,

  // Role alternation / message ordering — fires when transcript has
  // consecutive same-role messages or a tool_use without matching
  // tool_result. Polygram doesn't generate these directly, but they
  // can surface after an interrupted turn.
  roleOrdering:     /role.*alternat|message[_ ]ordering|consecutive (user|assistant)/i,

  // Tool call missing required `input` field. Indicates corrupted
  // history; user-facing message tells them to /new. Word order
  // varies across Anthropic SDK versions — accept either
  // "input...missing" or "missing...input" within a tool_use mention.
  missingToolInput: /tool[_ ]use.*(input.*missing|missing.*input)|missing tool call input|tool input required/i,

  // Idle/wall-clock timeout from polygram's pm timers, OR
  // model-side timeout. Mapped to a single class; user message is
  // identical either way.
  timeout:          /timed[_ ]out|deadline|idle with no Claude activity|wall-clock ceiling/i,

  // Generic format/validation errors (400 with no other class
  // matching). Rare in practice; included so we don't fall through
  // to "unknown".
  format:           /invalid[_ ]request|invalid[_ ]json|malformed|bad request/i,

  // Transient HTTP (5xx upstream Anthropic outage / overload). Only
  // these get retried by pm. 521-524/529 are Cloudflare codes seen
  // when Anthropic's edge is degraded.
  transient5xx:     /\b5(00|02|03|2[1-4]|29)\b|temporarily overloaded|server[_ ]error|service unavailable/i,
};

// User-facing message per kind. Polygram-style emoji + concise
// action hint. `null` means "suppress the user-facing reply" (used
// for INTERRUPTED inside the abort-grace window — the user already
// saw their /stop ack).
const USER_MESSAGES = {
  rateLimit:        '⚠️ Rate-limited by Anthropic. Try again in a minute.',
  billing:          '💳 Billing issue on Anthropic — operator needs to top up credits.',
  authExpired:      '🔑 Claude auth expired. Operator has been notified.',
  contextOverflow:  '📚 Conversation got too long. Send /new to start fresh.',
  roleOrdering:     '⚠️ Conversation got into a tangled state. Try /new.',
  missingToolInput: '⚠️ Session history looks corrupted. Try /new.',
  timeout:          '⏳ I went quiet too long without finishing. Try resending or simplifying.',
  format:           '⚠️ Invalid request format. Try rephrasing or /new.',
  // Used both for in-flight retry attempts AND for the post-retry-failed
  // bubble-up message. Avoid promising "retrying once" since by the
  // time the user reads it pm has already retried and given up.
  transient5xx:     '☁️ Server hiccup — please try again in a moment.',
};

// Auto-recovery actions for kinds where the session is irrecoverable
// without a reset. Phase 2 of 0.8.0 wires `pm.resetSession()` to
// these; 0.7.7 just exports the table for forward-compat.
//
// Values map to action names that pm understands:
//   'reset_session' — close current Query, clear sessionId, fresh start
//   (future) 'compact' — manual compact request, if SDK exposes it
const AUTO_RECOVER = {
  roleOrdering:     'reset_session',
  contextOverflow:  'reset_session',
  missingToolInput: 'reset_session',
};

// Typed-code short-circuits — set on errors polygram throws itself
// (see lib/process-manager.js), not pattern-matched. Keep these in
// sync with the codes pm emits.
const CODES = {
  // 0.7.6 (item H): queue cap drop. Pre-empts pattern matching so
  // the queue-overflow message is exact, not classified.
  QUEUE_OVERFLOW: {
    kind: 'queueOverflow',
    userMessage: '⏭ Couldn\'t keep up — this message was skipped while I was processing newer ones. Resend if it still matters.',
    isTransient: false,
    autoRecover: null,
  },
  // 0.8.0 Phase 1 will set this on pendings rejected via
  // pm.interrupt(). Matched here so the abort-grace silence works
  // before the SDK migration lands (pm could start setting it
  // earlier as a no-op).
  INTERRUPTED: {
    kind: 'interrupted',
    userMessage: null, // suppressed; user already saw the /stop ack
    isTransient: false,
    autoRecover: null,
  },
  // Phase 2 will set this when pm.resetSession() drains the queue
  // for any reason (auto-recovery, /new, /reset, auth-expired).
  RESET_SESSION: {
    kind: 'resetSession',
    userMessage: '✨ Started a fresh session.',
    isTransient: false,
    autoRecover: null,
  },
  // 0.8.0 auth-expired path — set on every pending the daemon
  // rejects after a 401 surface. Distinct from authExpired pattern
  // because it's polygram saying "I already noticed and paused"
  // rather than "I just hit a 401 and am about to handle it".
  AUTH_EXPIRED: {
    kind: 'authExpired',
    userMessage: '🔑 The bot needs re-auth. The operator has been notified. Try again in a few minutes.',
    isTransient: false,
    autoRecover: null,
  },
};

/**
 * Classify an error from any source.
 *
 * Accepts:
 *   - Error / object with `code` / `message`
 *   - SDKResultMessage with `subtype` and optional `error`
 *   - SDKAssistantMessage.error (string subtype like 'rate_limit')
 *   - plain string
 *   - null/undefined (returns the 'unknown' shape)
 *
 * Returns an object with stable shape:
 *   {
 *     kind: 'rateLimit' | 'billing' | ... | 'unknown' | code-keyed kind,
 *     userMessage: string | null,   // null means suppress reply
 *     isTransient: boolean,         // true → pm should retry once
 *     autoRecover: 'reset_session' | null,
 *   }
 */
function classify(err) {
  // Typed-code short-circuit takes priority over pattern matching.
  // Errors polygram constructs internally (QUEUE_OVERFLOW etc.) set
  // `err.code` so we don't depend on string content.
  const code = err?.code;
  if (code && CODES[code]) {
    return { ...CODES[code] };
  }

  // SDKAssistantMessage.error is a short string code from a fixed
  // union — match those directly, not via regex. Result subtypes
  // are checked LATER (after pattern matching) so a more-specific
  // pattern in the message text (e.g. 'HTTP 401' inside an
  // error_during_execution subtype) wins over the generic subtype
  // mapping that defaults the entire error_during_execution class
  // to transient.
  if (typeof err === 'string') {
    const sdkMessageError = matchSdkMessageError(err);
    if (sdkMessageError) return sdkMessageError;
  }

  const msg = extractMessage(err);
  for (const [kind, re] of Object.entries(PATTERNS)) {
    if (re.test(msg)) {
      return {
        kind,
        userMessage: USER_MESSAGES[kind],
        isTransient: kind === 'transient5xx' || kind === 'rateLimit',
        autoRecover: AUTO_RECOVER[kind] ?? null,
      };
    }
  }

  // After pattern matching: try SDK result subtypes. A bare string
  // like 'error_during_execution' (no message context) lands here
  // and gets the friendly transient5xx kind. Object inputs with a
  // subtype field also land here when their message text didn't
  // match a more specific pattern.
  if (typeof err === 'string') {
    const sdkResultSubtype = matchSdkResultSubtype(err);
    if (sdkResultSubtype) return sdkResultSubtype;
  }
  if (err?.subtype && typeof err.subtype === 'string') {
    const sdkResultSubtype = matchSdkResultSubtype(err.subtype);
    if (sdkResultSubtype) return sdkResultSubtype;
  }

  // Fall-through: surface a snippet of the raw error so users at
  // least know SOMETHING happened. Same shape as before, just
  // routed through the classifier so callers get a uniform return.
  const reason = msg.split('\n')[0].slice(0, 120);
  return {
    kind: 'unknown',
    userMessage: `Hit a snag: ${reason || 'unknown error'}. Try resending.`,
    isTransient: false,
    autoRecover: null,
  };
}

// Pull a string out of whatever shape the caller passed.
function extractMessage(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (err.error) return String(err.error);
  return String(err);
}

// SDKAssistantMessage.error fields are a small fixed union
// (sdk.d.ts:2343). Map directly so we don't depend on transport-
// specific error text.
const SDK_MESSAGE_ERROR_MAP = {
  authentication_failed: 'authExpired',
  billing_error:         'billing',
  rate_limit:            'rateLimit',
  invalid_request:       'format',
  server_error:          'transient5xx',
  unknown:               'unknown',
  max_output_tokens:     'format', // closest match — model gave up
};
function matchSdkMessageError(s) {
  const kind = SDK_MESSAGE_ERROR_MAP[s];
  if (!kind) return null;
  if (kind === 'unknown') return null; // fall through to pattern match
  return {
    kind,
    userMessage: USER_MESSAGES[kind] ?? null,
    isTransient: kind === 'transient5xx' || kind === 'rateLimit',
    autoRecover: AUTO_RECOVER[kind] ?? null,
  };
}

// SDKResultMessage.subtype values (sdk.d.ts:3121). Most are
// terminal-error indicators that don't have a clean pattern equivalent.
//
// `error_during_execution` is the SDK's catch-all for "something went
// wrong mid-turn" — could be a transient stream/network blip OR a
// systemic model issue. We treat it as transient (1 retry is cheap;
// if it's systemic the second attempt fails fast). Pre-rc.5 this was
// mapped to 'unknown' which fell through to the default "Hit a snag:
// error_during_execution" template — leaking the SDK enum to users.
const SDK_RESULT_SUBTYPE_MAP = {
  error_during_execution:           'transient5xx',
  error_max_turns:                  'format',
  error_max_budget_usd:             'billing',
  error_max_structured_output_retries: 'format',
};
function matchSdkResultSubtype(s) {
  if (s === 'success') return null;
  const kind = SDK_RESULT_SUBTYPE_MAP[s];
  if (!kind || kind === 'unknown') return null;
  return {
    kind,
    userMessage: USER_MESSAGES[kind] ?? null,
    // Derive transience from the kind so error_during_execution →
    // transient5xx → isTransient=true, matching the pattern-match
    // branch's behaviour. pm guards retry with firstAssistantSeen=
    // false, which prevents budget waste when the turn already had
    // billable assistant output.
    isTransient: kind === 'transient5xx' || kind === 'rateLimit',
    autoRecover: AUTO_RECOVER[kind] ?? null,
  };
}

// True if pm's iteration loop should sleep and retry the user
// message ONCE before giving up. Currently only transient5xx and
// rateLimit. Per v4 plan §6.6 H1/M2, retry only fires when the
// turn produced ZERO assistant messages (idempotency); pm checks
// that flag, not this function.
function isTransientHttpError(err) {
  return classify(err).isTransient;
}

module.exports = {
  classify,
  isTransientHttpError,
  PATTERNS,
  USER_MESSAGES,
  AUTO_RECOVER,
  CODES,
};

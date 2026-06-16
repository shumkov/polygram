/**
 * Unified Telegram send API with write-before-send atomicity.
 *
 * Flow per outbound:
 *   1. Insert `messages` row with status='pending' + synthetic negative msg_id.
 *   2. Call Telegram API via grammy's `bot.api.raw.<method>(params)`.
 *   3a. On success → UPDATE row: msg_id = real, status = 'sent'.
 *   3b. On failure → UPDATE row: status = 'failed', error = err.message; log
 *       a `telegram-api-error` event. Row stays for post-mortem.
 *
 * A crash between (1) and (2) leaves an orphan pending row that
 * `markStalePending()` sweeps to 'failed' on next boot — polygram never
 * auto-retries (risk of double-send if Telegram actually received the first).
 *
 * Reactions (`setMessageReaction`) do not create messages in Telegram, so they
 * skip the DB row entirely.
 *
 * DB failures never block the send — logged to `logger.error` and the call
 * proceeds. Telegram delivery is the priority; transcript is best-effort.
 */

const crypto = require('crypto');
const {
  toTelegramMarkdown,
  isHtmlParseError,
  isMessageNotModifiedError,
  isRateLimitError,
  getRetryAfterMs,
} = require('./format');
const { isSafeToRetry, redactBotToken } = require('../error/net');
const { coerceFileParams, localFileBytes, FILE_FIELD_BY_METHOD } = require('./input-file');
const { resolveFileCaps, resolveMaxFileOverride } = require('../attachments');

// Topic deletion race: a user can delete a forum topic while a turn is in
// flight, turning a valid `message_thread_id` into a 404. Telegram's error
// string is specific enough to pattern-match; on hit we retry without the
// thread param so the reply still lands in the chat root.
const THREAD_NOT_FOUND_RE = /(Bad Request:\s*message thread not found|TOPIC_DELETED)/i;

function isThreadNotFound(err) {
  const msg = err && (err.description || err.message);
  return typeof msg === 'string' && THREAD_NOT_FOUND_RE.test(msg);
}

// Short linear backoff before the single pre-connect retry. 150ms is long
// enough for DNS / local network glitches to clear, short enough that a
// user turn finishing doesn't notice.
const PRE_CONNECT_RETRY_DELAY_MS = 150;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Methods whose `text` / `caption` fields we auto-format into Telegram HTML.
// Anything else passes through untouched (setMessageReaction, sendSticker,
// deleteMessage, etc. have no text to format).
const FORMATTABLE_METHODS = new Set(['sendMessage', 'editMessageText']);

// Apply Claude-markdown → Telegram HTML conversion in-place on the
// params object. Skipped if:
//   - Method doesn't carry formattable text.
//   - Caller already set a parse_mode (respect explicit choice).
//   - Caller opted out via meta.plainText.
// On any conversion failure we silently fall through to plain text.
function applyFormatting(method, params, meta) {
  if (meta.plainText === true) return;
  if (!FORMATTABLE_METHODS.has(method)) return;
  if (params.parse_mode != null) return;
  const field = params.text ? 'text' : (params.caption ? 'caption' : null);
  if (!field) return;
  const { text: converted, parseMode } = toTelegramMarkdown(params[field]);
  if (parseMode) {
    params[field] = converted;
    params.parse_mode = parseMode;
  }
}

// Synthetic negative msg_id for a pending outbound row. 48 random bits — the
// birthday bound for collision within the (chat_id, msg_id) unique constraint
// is ~16M rows, far beyond any realistic retention window. Negative to stay
// disjoint from real Telegram message_ids (always positive).
function nextPendingId() {
  const v = crypto.randomBytes(6).readUIntBE(0, 6);
  return -(v + 1);
}

// Methods we don't insert a `messages` row for. Reactions/deletes/markup
// edits never produced a chat message in the first place. editMessageText
// DOES modify a message, but creating a new DB row per edit collides with
// the UNIQUE(chat_id, msg_id) constraint on the 2nd edit — the stream
// edits one bubble N times in a single turn. The initial sendMessage
// already persisted the row; edits just update the live bubble.
const METHODS_WITHOUT_MSG = new Set([
  'setMessageReaction',
  'deleteMessage',
  'editMessageReplyMarkup',
  'editMessageText',
]);

// Derive the row's `text` column. sendSticker has no text/caption, so we
// synthesize `[sticker:<name>]` (or file_id as fallback) — without this the
// transcript shows an empty outbound that's impossible to interpret later.
function deriveOutboundText(method, params, meta) {
  if (params.text) return params.text;
  if (params.caption) return params.caption;
  if (method === 'sendSticker') {
    const label = meta.stickerName || params.sticker || 'unknown';
    return `[sticker:${label}]`;
  }
  return '';
}

async function send({ bot, method, params, db = null, meta = {}, logger = console, config = null }) {
  const chatId = params.chat_id != null ? String(params.chat_id) : null;
  const threadId = params.message_thread_id != null ? String(params.message_thread_id) : null;

  // Outbound per-file size cap (topic → chat → bot → default → backend ceiling).
  // Enforced HERE, the single send choke point, so every path is capped
  // uniformly: CLI reply(files), IPC/cron job sends, and any media polygram
  // itself emits. Runs BEFORE coerceFileParams while the param is still a raw
  // statable path/Buffer (coerceFileParams turns {source} into an opaque
  // InputFile). Only locally-statable files are checked — file_id / URL sends
  // can't be sized and pass through (Telegram's own limit applies). Throwing
  // here is before insertOutboundPending, so no orphan DB row is left.
  if (config) {
    const fileField = FILE_FIELD_BY_METHOD[method];
    if (fileField && params[fileField] != null) {
      const bytes = localFileBytes(params[fileField]);
      if (bytes != null) {
        const cap = resolveFileCaps({
          localApi: !!config.bot?.apiRoot,
          override: resolveMaxFileOverride(config, chatId, threadId),
        }).outBytes;
        if (bytes > cap) {
          const mb = (n) => (n / (1024 * 1024)).toFixed(1);
          throw new Error(`telegram ${method}: file ${mb(bytes)}MB exceeds the ${mb(cap)}MB send limit`);
        }
      }
    }
  }

  // File-upload bug fix (2026-05-31): coerce a `{ source: '/abs/path' }`
  // file param into a grammy InputFile so local-file uploads actually work.
  // grammy doesn't recognize the bare envelope → it failed every send with
  // "Wrong port number". Single choke point: fixes channels reply(files)
  // AND the IPC send path at once. No-op for non-file methods / file_id /
  // URL strings / existing InputFile instances.
  coerceFileParams(method, params);

  // 0.7.4: empty-text short-circuit. Pre-fix, an empty params.text on
  // sendMessage/editMessageText reached Telegram and 400'd with
  // "message text is empty"; the row was marked failed and propagated
  // as a user-facing "Hit a snag" — confusing because the bot didn't
  // really fail. Throw a typed error before the API call so callers
  // can detect + skip silently if appropriate.
  if (method === 'sendMessage' || method === 'editMessageText') {
    const t = params.text;
    if (typeof t !== 'string' || t.length === 0) {
      throw new Error(`telegram ${method}: text is empty`);
    }
  }
  if (method === 'sendPhoto' || method === 'sendVideo'
      || method === 'sendAudio' || method === 'sendDocument' || method === 'sendAnimation') {
    // Caption is optional for media sends; only check if explicitly set
    // to a non-string. Empty caption is fine (just send the media).
    if (params.caption != null && typeof params.caption !== 'string') {
      throw new Error(`telegram ${method}: caption must be a string when set`);
    }
  }

  // Capture outbound text BEFORE markdown-escaping so the transcript stays
  // human-readable. "Mr. O'Brien said 3.14" is searchable; "Mr\. O'Brien
  // said 3\.14" is not. The user's chat view shows the rendered text, which
  // matches the DB row modulo heading/bullet downgrades.
  const text = deriveOutboundText(method, params, meta);
  const tracksMessage = !METHODS_WITHOUT_MSG.has(method);

  // 0.7.0: snapshot the field that applyFormatting will convert and the
  // current parse_mode state, so the HTML→plain fallback (if Telegram
  // rejects the converted payload with `400 can't parse entities`) can
  // restore the raw value and retry without parse_mode. Mirrors the
  // applyFormatting decision (must run BEFORE applyFormatting mutates).
  const willFormat = !meta.plainText
    && FORMATTABLE_METHODS.has(method)
    && params.parse_mode == null;
  const formatField = willFormat ? (params.text ? 'text' : (params.caption ? 'caption' : null)) : null;
  const rawFieldValue = formatField ? params[formatField] : null;

  applyFormatting(method, params, meta);
  const formattingApplied = formatField && params.parse_mode === 'HTML';

  // 0.7.0: per-bot/chat link-preview opt-out. When meta.linkPreview is
  // explicitly false, suppress Telegram's auto-generated preview cards
  // for any URL in the body (they clutter chats and add visual noise).
  // Default (no flag set) preserves Telegram's native preview behavior
  // — matches OpenClaw's account.config.linkPreview opt-out.
  if (meta.linkPreview === false
      && (method === 'sendMessage' || method === 'editMessageText')
      && params.link_preview_options == null) {
    params.link_preview_options = { is_disabled: true };
  }

  // Capture which inbound this reply targets so the boot-replay dedupe
  // (`hasOutboundReplyTo`) can match outbound→inbound. Without this every
  // restart would re-dispatch already-answered messages.
  const replyToId = params.reply_parameters?.message_id ?? null;

  let rowId = null;
  if (db && tracksMessage && chatId) {
    const pendingId = nextPendingId();
    try {
      const result = db.insertOutboundPending({
        chat_id: chatId,
        thread_id: threadId,
        user: meta.user || null,
        text,
        source: meta.source || 'bot-reply',
        bot_name: meta.botName || null,
        turn_id: meta.turnId || null,
        session_id: meta.sessionId || null,
        pending_id: pendingId,
        reply_to_id: replyToId,
      });
      rowId = result?.lastInsertRowid ?? null;
    } catch (err) {
      logger.error(`[telegram] insertOutboundPending failed: ${err.message}`);
    }
  }

  let res;
  const rawAttempt = async (p) => bot.api.raw[method](p);

  // OpenClaw-style fallback layers, composing outermost-to-innermost:
  //
  //   withThreadFallback (outer)  — strips message_thread_id and
  //                                 retries on TOPIC_DELETED / "thread
  //                                 not found"
  //   withPreConnectRetry         — single retry on transient pre-
  //                                 connect errors (DNS flap, TCP
  //                                 refused, ENETUNREACH); never
  //                                 retries post-connect errors that
  //                                 might have landed
  //   safeAttempt                 — sleeps `retry_after` and retries
  //                                 once on 429
  //   tryOnce (innermost)         — handles two per-call recoveries:
  //                                 (a) MESSAGE_NOT_MODIFIED on
  //                                 editMessageText → synthetic
  //                                 success (streamer debounce often
  //                                 lands on no-op edits, Telegram
  //                                 returns 400 we don't want to
  //                                 propagate); (b) HTML parse error
  //                                 → retry as plain text with the
  //                                 raw pre-conversion field value
  //                                 restored
  //   rawAttempt                  — bot.api.raw[method](params)
  //
  // Each layer is a closure built per call; allocation cost is
  // negligible vs. network RTT.
  // 0.7.4: aligned with OpenClaw's 30s cap. A misconfigured retry_after
  // (Telegram occasionally returns 5+ minute hints during outages)
  // shouldn't park the call beyond a reasonable user-attention budget.
  const RETRY_AFTER_CAP_MS = 30_000;
  const tryOnce = async (p) => {
    try {
      return await rawAttempt(p);
    } catch (err) {
      if (method === 'editMessageText' && isMessageNotModifiedError(err)) {
        try { db?.logEvent('telegram-edit-skip-not-modified', { chat_id: chatId, message_id: p.message_id }); }
        catch {}
        // Synthetic success — message_id known, date best-effort.
        return { message_id: p.message_id, date: Math.floor(Date.now() / 1000), _notModified: true };
      }
      if (formattingApplied && isHtmlParseError(err)) {
        logger.warn?.(`[telegram] ${method}: HTML parse error, retrying as plain text`);
        try {
          db?.logEvent('telegram-html-fallback', {
            chat_id: chatId, method,
            error: redactBotToken(err.message)?.slice(0, 200),
          });
        } catch {}
        const plainParams = { ...p };
        delete plainParams.parse_mode;
        plainParams[formatField] = rawFieldValue;
        try {
          return await rawAttempt(plainParams);
        } catch (plainErr) {
          // 0.7.1: if the plain retry also fails, preserve BOTH errors
          // in the message that propagates. Pre-fix, only `plainErr`
          // bubbled up — operators investigating from markOutboundFailed
          // saw e.g. "Forbidden: bot was kicked" and missed that the
          // ORIGINAL failure was a markdown→HTML parse bug.
          const origMsg = redactBotToken(err.message)?.slice(0, 200);
          const wrapped = new Error(`plain-retry failed (after HTML parse error: ${origMsg}): ${plainErr.message}`);
          if (plainErr.code) wrapped.code = plainErr.code;
          if (plainErr.parameters) wrapped.parameters = plainErr.parameters;
          throw wrapped;
        }
      }
      throw err;
    }
  };
  const safeAttempt = async (p) => {
    try {
      return await tryOnce(p);
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      // Sleep retry_after then retry once. Cap at 60s so a misconfigured
      // value can't park the call indefinitely.
      const ms = Math.min(getRetryAfterMs(err) ?? 1000, RETRY_AFTER_CAP_MS);
      logger.warn?.(`[telegram] ${method}: 429 rate-limited, retry-after ${ms}ms`);
      try { db?.logEvent('telegram-rate-limit', { chat_id: chatId, method, retry_after_ms: ms }); }
      catch {}
      await sleep(ms);
      return await tryOnce(p);
    }
  };

  // 0.7.0: pre-connect retry layer (single retry on transient pre-conn
  // errors). Composes inside thread-fallback so a re-attempt without
  // thread_id also benefits from the retry.
  const withPreConnectRetry = async (p) => {
    try {
      return await safeAttempt(p);
    } catch (err) {
      // Pre-connect errors (DNS flap, TCP refused, net unreach) never
      // reached Telegram, so retrying can't double-send. Retry ONCE
      // after a short delay before treating as fatal. Post-connect
      // errors (ETIMEDOUT, EPIPE, 5xx) are NOT retried — the message
      // might have landed server-side.
      if (isSafeToRetry(err)) {
        try { db?.logEvent('telegram-retry', { chat_id: chatId, method, code: err.code, name: err.name }); }
        catch {}
        await sleep(PRE_CONNECT_RETRY_DELAY_MS);
        return await safeAttempt(p);
      }
      throw err;
    }
  };

  // 0.7.0: thread-fallback layer (port of OpenClaw's
  // withTelegramThreadFallback). On `message thread not found` /
  // TOPIC_DELETED, retry once with thread_id stripped — the reply
  // lands in the chat root instead of the deleted topic.
  const withThreadFallback = async (p) => {
    try {
      return await withPreConnectRetry(p);
    } catch (err) {
      if (!isThreadNotFound(err) || p.message_thread_id == null) throw err;
      const retryParams = { ...p };
      delete retryParams.message_thread_id;
      logger.error?.(`[telegram] ${method}: thread gone, retrying without thread_id`);
      try {
        const out = await withPreConnectRetry(retryParams);
        try { db?.logEvent('telegram-thread-fallback', { chat_id: chatId, method, original_thread_id: String(p.message_thread_id) }); }
        catch {}
        return out;
      } catch (err2) {
        // Re-throw with the SECOND error — that's the actually-fatal
        // one (the thread-fallback retry didn't save us).
        throw err2;
      }
    }
  };

  try {
    res = await withThreadFallback(params);
  } catch (err) {
    if (rowId != null && db) {
      // 0.6.14: redact bot tokens before persisting err.message —
      // some undici/network error shapes embed the request URL
      // (which carries `bot${TOKEN}`) into err.message.
      const safe = redactBotToken(err.message);
      try { db.markOutboundFailed(rowId, safe); }
      catch (e) { logger.error(`[telegram] markOutboundFailed: ${e.message}`); }
      try { db.logEvent('telegram-api-error', { chat_id: chatId, method, error: safe }); }
      catch (e) { logger.error(`[telegram] logEvent: ${e.message}`); }
    }
    throw err;
  }

  if (rowId != null && db) {
    try {
      db.markOutboundSent(rowId, {
        msg_id: res?.message_id ?? 0,
        ts: (res?.date ? res.date * 1000 : Date.now()),
      });
    } catch (err) {
      logger.error(`[telegram] markOutboundSent: ${err.message}`);
    }
  }
  return res;
}

function createSender(db, logger = console, config = null) {
  return (bot, method, params, meta) => send({ bot, method, params, db, meta, logger, config });
}

module.exports = { send, createSender, nextPendingId };

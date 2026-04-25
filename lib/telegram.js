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
const { toTelegramMarkdown } = require('./telegram-format');
const { isSafeToRetry } = require('./net-errors');

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

async function send({ bot, method, params, db = null, meta = {}, logger = console }) {
  const chatId = params.chat_id != null ? String(params.chat_id) : null;
  const threadId = params.message_thread_id != null ? String(params.message_thread_id) : null;
  // Capture outbound text BEFORE markdown-escaping so the transcript stays
  // human-readable. "Mr. O'Brien said 3.14" is searchable; "Mr\. O'Brien
  // said 3\.14" is not. The user's chat view shows the rendered text, which
  // matches the DB row modulo heading/bullet downgrades.
  const text = deriveOutboundText(method, params, meta);
  const tracksMessage = !METHODS_WITHOUT_MSG.has(method);

  applyFormatting(method, params, meta);

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
  const attempt = async (p) => bot.api.raw[method](p);
  try {
    try {
      res = await attempt(params);
    } catch (err) {
      // Pre-connect errors (DNS flap, TCP refused, net unreach) never
      // reached Telegram, so retrying can't double-send. Retry ONCE after
      // a short delay before treating as fatal. Post-connect errors
      // (ETIMEDOUT, EPIPE, 5xx) are NOT retried — the message might have
      // landed server-side.
      if (isSafeToRetry(err)) {
        try { db?.logEvent('telegram-retry', { chat_id: chatId, method, code: err.code, name: err.name }); }
        catch {}
        await sleep(PRE_CONNECT_RETRY_DELAY_MS);
        res = await attempt(params);
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Forum topic was deleted mid-turn — retry to chat root rather than
    // failing the whole reply. Only for methods that accept a thread id
    // (send*), and only once per call.
    if (isThreadNotFound(err) && params.message_thread_id != null) {
      const retryParams = { ...params };
      delete retryParams.message_thread_id;
      try {
        logger.error?.(`[telegram] ${method}: thread gone, retrying without thread_id`);
        res = await bot.api.raw[method](retryParams);
        try { db?.logEvent('telegram-thread-fallback', { chat_id: chatId, method, original_thread_id: String(params.message_thread_id) }); }
        catch {}
      } catch (err2) {
        if (rowId != null && db) {
          try { db.markOutboundFailed(rowId, err2.message); }
          catch (e) { logger.error(`[telegram] markOutboundFailed: ${e.message}`); }
          try { db.logEvent('telegram-api-error', { chat_id: chatId, method, error: err2.message }); }
          catch (e) { logger.error(`[telegram] logEvent: ${e.message}`); }
        }
        throw err2;
      }
    } else {
      if (rowId != null && db) {
        try { db.markOutboundFailed(rowId, err.message); }
        catch (e) { logger.error(`[telegram] markOutboundFailed: ${e.message}`); }
        try { db.logEvent('telegram-api-error', { chat_id: chatId, method, error: err.message }); }
        catch (e) { logger.error(`[telegram] logEvent: ${e.message}`); }
      }
      throw err;
    }
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

function createSender(db, logger = console) {
  return (bot, method, params, meta) => send({ bot, method, params, db, meta, logger });
}

module.exports = { send, createSender, nextPendingId };

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

// Synthetic negative msg_id for a pending outbound row. 48 random bits — the
// birthday bound for collision within the (chat_id, msg_id) unique constraint
// is ~16M rows, far beyond any realistic retention window. Negative to stay
// disjoint from real Telegram message_ids (always positive).
function nextPendingId() {
  const v = crypto.randomBytes(6).readUIntBE(0, 6);
  return -(v + 1);
}

const METHODS_WITHOUT_MSG = new Set(['setMessageReaction', 'deleteMessage', 'editMessageReplyMarkup']);

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
  const text = deriveOutboundText(method, params, meta);
  const tracksMessage = !METHODS_WITHOUT_MSG.has(method);

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
      });
      rowId = result?.lastInsertRowid ?? null;
    } catch (err) {
      logger.error(`[telegram] insertOutboundPending failed: ${err.message}`);
    }
  }

  let res;
  try {
    res = await bot.api.raw[method](params);
  } catch (err) {
    if (rowId != null && db) {
      try { db.markOutboundFailed(rowId, err.message); }
      catch (e) { logger.error(`[telegram] markOutboundFailed: ${e.message}`); }
      try { db.logEvent('telegram-api-error', { chat_id: chatId, method, error: err.message }); }
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

function createSender(db, logger = console) {
  return (bot, method, params, meta) => send({ bot, method, params, db, meta, logger });
}

module.exports = { send, createSender, nextPendingId };

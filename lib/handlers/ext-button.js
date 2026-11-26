/**
 * Presses on buttons owned by external IPC senders: callback_data
 * `ext:<owner>:<payload>`, such as agent-org's `ext:ao:ap:<requestId>`.
 *
 * polygram knows nothing about what a press means. It records the press in
 * `button_presses`, on a chat this bot owns only, and answers at once. The
 * owner reads the table and decides whether the press counts.
 *
 * The insert is synchronous and runs before the answer, so the toast always
 * matches the row: `Received` only once the press is stored (by this delivery
 * or an earlier one of the same update), `Not recorded, try again` when it is
 * not. The insert is called directly, never through the best-effort DB
 * wrapper, because that wrapper swallows the very error the toast reports.
 * Telemetry runs after the answer and can never stop it. See
 * docs/EXT_BUTTONS_SPEC.md.
 *
 * The payload is untrusted (a client can send data that no button carries)
 * and is stored only in the row. Logs carry the owner tag at most.
 */

'use strict';

const { STALE_BUTTON } = require('./callback-router');

const RECEIVED = 'Received';
const NOT_RECORDED = 'Not recorded, try again';

// Telegram's own limit for callback_data. A forged query is held to it here,
// which keeps every row small.
const MAX_DATA_BYTES = 64;

// The owner tag is the segment between `ext:` and the next `:`.
const OWNER_TAG = /^ext:([a-z0-9_-]{1,16}):/;

// The owner tag for logs, or 'invalid'. Never the payload.
function ownerTag(data) {
  return OWNER_TAG.exec(data)?.[1] ?? 'invalid';
}

/**
 * @param {object} deps
 * @param {{insertButtonPress: (row: object) => {inserted: boolean}}} deps.db
 * @param {(chatId: string) => boolean} deps.ownsChat
 * @param {(kind: string, detail: object) => void} deps.logEvent
 * @param {string} deps.botName
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now]
 */
function createHandleExtButtonCallback({ db, ownsChat, logEvent, botName, logger = console, now = Date.now }) {
  const safely = (fn) => { try { fn(); } catch {} };

  return async function handleExtButtonCallback(ctx) {
    const query = ctx.callbackQuery;
    const message = query.message;
    const chatId = String(message.chat.id);
    const owner = ownerTag(query.data);
    const reply = async (text, telemetry) => {
      await ctx.answerCallbackQuery({ text }).catch(() => {});
      if (telemetry) safely(telemetry);
    };

    if (!ownsChat(chatId)) {
      return reply(STALE_BUTTON, () => logEvent('button-press-foreign-chat', {
        chat_id: chatId, bot: botName, owner, msg_id: message.message_id,
      }));
    }

    const bytes = Buffer.byteLength(query.data);
    if (bytes > MAX_DATA_BYTES) {
      return reply(STALE_BUTTON, () => logEvent('button-press-oversized', {
        chat_id: chatId, bot: botName, owner, msg_id: message.message_id, bytes,
      }));
    }

    const userId = String(query.from.id);
    try {
      db.insertButtonPress({
        chat_id: chatId,
        thread_id: message.message_thread_id != null ? String(message.message_thread_id) : null,
        msg_id: message.message_id,
        user_id: userId,
        data: query.data,
        ts: now(),
        callback_query_id: String(query.id),
      });
    } catch (err) {
      const errorCode = err?.code || err?.name || 'Error';
      return reply(NOT_RECORDED, () => {
        safely(() => logEvent('button-press-not-recorded', {
          chat_id: chatId, bot: botName, owner, msg_id: message.message_id,
          user_id: userId, error_code: errorCode,
        }));
        // The error message can quote the statement's values; only its code is logged.
        logger.error(`[${botName}] button press not recorded in ${chatId} (owner ${owner}): ${errorCode}`);
      });
    }
    return reply(RECEIVED);
  };
}

module.exports = { createHandleExtButtonCallback, RECEIVED, NOT_RECORDED };

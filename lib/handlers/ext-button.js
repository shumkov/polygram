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
 * not. See docs/EXT_BUTTONS_SPEC.md.
 *
 * The payload is untrusted (a client can send data that no button carries)
 * and is stored only in the row. Logs carry the owner tag at most.
 */

'use strict';

const { STALE_BUTTON } = require('./callback-router');

const RECEIVED = 'Received';
const NOT_RECORDED = 'Not recorded, try again';

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
  return async function handleExtButtonCallback(ctx) {
    const query = ctx.callbackQuery;
    const answer = (text) => ctx.answerCallbackQuery({ text }).catch(() => {});
    const message = query.message;
    const chatId = String(message.chat.id);
    const owner = ownerTag(query.data);

    if (!ownsChat(chatId)) {
      logEvent('button-press-foreign-chat', { chat_id: chatId, bot: botName, owner, msg_id: message.message_id });
      return answer(STALE_BUTTON);
    }

    try {
      db.insertButtonPress({
        chat_id: chatId,
        thread_id: message.message_thread_id != null ? String(message.message_thread_id) : null,
        msg_id: message.message_id,
        user_id: String(query.from.id),
        data: query.data,
        ts: now(),
        callback_query_id: String(query.id),
      });
    } catch (err) {
      const errorCode = err?.code || err?.name || 'Error';
      logEvent('button-press-not-recorded', {
        chat_id: chatId, bot: botName, owner, msg_id: message.message_id,
        user_id: String(query.from.id), error_code: errorCode,
      });
      // The error message can quote the statement's values; only its code is logged.
      logger.error(`[${botName}] button press not recorded in ${chatId} (owner ${owner}): ${errorCode}`);
      return answer(NOT_RECORDED);
    }
    return answer(RECEIVED);
  };
}

module.exports = { createHandleExtButtonCallback, RECEIVED, NOT_RECORDED };

/**
 * Cron / IPC `send` handler — wraps tg() for external callers
 * (cron jobs, CLI scripts) that talk to polygram via the Unix
 * socket IPC.
 *
 * Allowlist: only non-destructive Telegram Bot API methods. cron
 * has no business calling deleteMessage / banChatMember etc.
 *
 * Cross-bot guard: chat_id MUST belong to this bot (after
 * filterConfigToBot, config.chats only contains our chats — so
 * lookup-by-chat-id naturally enforces ownership).
 *
 * File-param validation: validateIpcFileParam catches the most
 * common upload-shape mistakes before Telegram rejects with a
 * confusing error.
 */

'use strict';

const { validateIpcFileParam } = require('../ipc/file-validator');

// Allowed Telegram Bot API methods. Broader than sendMessage to
// cover receipts, error reports, quick replies. Deliberately
// excludes destructive ops.
const IPC_SEND_ALLOWED_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendSticker',
  'sendChatAction',
  'editMessageText',
  'setMessageReaction',
]);

function createHandleSendOverIpc({ config, bot, tg, botName } = {}) {
  return async function handleSendOverIpc(req) {
    const { method, params = {}, source } = req || {};
    if (!method) throw new Error('method required');
    if (!IPC_SEND_ALLOWED_METHODS.has(method)) {
      throw new Error(`method not allowed: ${method}`);
    }
    if (!bot) throw new Error('bot process not ready');

    // Enforce: chat_id must belong to this bot (no cross-bot sends).
    const chatId = params.chat_id != null ? String(params.chat_id) : null;
    if (chatId && !config.chats[chatId]) {
      throw new Error(`chat not owned by ${botName}: ${chatId}`);
    }

    // editMessageText accepts (chat_id+message_id) OR
    // inline_message_id as the addressing mode. The chat_id branch
    // above gates the first; inline_message_id has no owner field
    // a cron caller can be checked against, so a malicious or buggy
    // caller could edit any inline message system-wide. Polygram
    // never sends inline-mode messages (we have no inline-bot
    // handlers), so reject inline_message_id outright.
    if (params.inline_message_id != null) {
      throw new Error('inline_message_id editing not supported by polygram IPC');
    }
    // editMessageText with neither chat_id nor inline_message_id
    // would silently succeed-with-error from Telegram; fail fast.
    if (method === 'editMessageText' && !chatId) {
      throw new Error('editMessageText requires chat_id');
    }

    const fileParamErr = validateIpcFileParam(method, params);
    if (fileParamErr) throw new Error(fileParamErr);

    const sendRes = await tg(bot, method, params, {
      source: source || 'ipc',
      botName,
    });
    return { result: sendRes };
  };
}

module.exports = {
  createHandleSendOverIpc,
  IPC_SEND_ALLOWED_METHODS,
};

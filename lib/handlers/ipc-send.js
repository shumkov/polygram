/**
 * Cron / IPC `send` handler — wraps tg() for external callers
 * (cron jobs, CLI scripts) that talk to polygram via the Unix
 * socket IPC.
 *
 * Allowlist: only non-destructive Telegram Bot API methods, plus
 * deleteMessage on the caller's own IPC messages. cron has no business
 * calling banChatMember etc.
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

const { validateIpcFileParam, validateIpcMedia } = require('../ipc/file-validator');
const { sendRichCard } = require('../telegram/rich-card-send');

// Allowed Telegram Bot API methods. Broader than sendMessage to
// cover receipts, error reports, quick replies. Deliberately
// excludes destructive ops. editMessageReplyMarkup lets a sender
// remove or replace buttons on messages in chats this bot owns.
// editMessageMedia and editMessageCaption replace a message's picture or
// caption, and deleteMessage removes one, only on a message the same IPC
// sender sent (see below).
const IPC_SEND_ALLOWED_METHODS = new Set([
  'sendMessage',
  'sendRichMessage',
  'sendPhoto',
  'sendDocument',
  'sendSticker',
  'sendChatAction',
  'editMessageText',
  'editMessageReplyMarkup',
  'editMessageMedia',
  'editMessageCaption',
  'deleteMessage',
  'setMessageReaction',
]);

// Edits address a message by chat_id + message_id; see the guard below.
const EDIT_METHODS = new Set(['editMessageText', 'editMessageReplyMarkup', 'editMessageMedia', 'editMessageCaption', 'deleteMessage']);
// Edits that change what a message shows, and its deletion. A caller may
// make them only on a message this bot recorded as sent through IPC by that
// same sender, so it can never rewrite or remove an agent's reply, a user's
// message or another sender's. This guards against bugs, not attackers: the
// IPC `source` is declared by the caller, and any local process that can
// reach the socket could claim another sender's name.
const OWN_MESSAGE_EDITS = new Set(['editMessageMedia', 'editMessageCaption', 'deleteMessage']);
// Telegram lets a bot delete its own group messages only for 48 hours,
// unless it is an admin allowed to delete messages; its refusal says neither.
const DELETE_REFUSED_RE = /message can't be deleted/i;
const DELETE_GONE_RE = /message to delete not found/i;

function createHandleSendOverIpc({ config, bot, tg, botName, sendRich, getMessage = null } = {}) {
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

    // The edit methods accept (chat_id+message_id) OR
    // inline_message_id as the addressing mode. The chat_id branch
    // above gates the first; inline_message_id has no owner field
    // a cron caller can be checked against, so a malicious or buggy
    // caller could edit any inline message system-wide. Polygram
    // never sends inline-mode messages (we have no inline-bot
    // handlers), so reject inline_message_id outright.
    if (params.inline_message_id != null) {
      throw new Error('inline_message_id editing not supported by polygram IPC');
    }
    // An edit with neither chat_id nor inline_message_id would
    // silently succeed-with-error from Telegram; fail fast.
    if (EDIT_METHODS.has(method) && !chatId) {
      throw new Error(`${method} requires chat_id`);
    }

    if (OWN_MESSAGE_EDITS.has(method)) {
      if (!Number.isInteger(params.message_id)) throw new Error(`${method} requires message_id`);
      const sender = source || 'ipc';
      const row = getMessage ? getMessage(chatId, params.message_id) : null;
      if (!row || row.direction !== 'out' || row.bot_name !== botName || row.source !== sender) {
        throw new Error(`${method}: message ${params.message_id} was not sent by this IPC sender (${sender})`);
      }
    }
    if (method === 'editMessageMedia') {
      const mediaErr = validateIpcMedia(params.media);
      if (mediaErr) throw new Error(mediaErr);
    }

    const fileParamErr = validateIpcFileParam(method, params);
    if (fileParamErr) throw new Error(fileParamErr);

    if (method === 'sendRichMessage') {
      if (!chatId) throw new Error('sendRichMessage requires chat_id');
      const rich = params.rich_message;
      if (!Array.isArray(rich?.blocks) || !rich.blocks.length || rich.html != null || rich.markdown != null) {
        throw new Error('sendRichMessage requires typed rich_message.blocks');
      }
      const fallback = req.fallback;
      if (fallback !== undefined && (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)
        || typeof fallback.text !== 'string' || !fallback.text || fallback.parse_mode !== 'HTML'
        || Object.keys(fallback).some((key) => !['text', 'parse_mode'].includes(key)))) {
        throw new Error('Invalid rich fallback: use {text, parse_mode:"HTML"}');
      }
      // The keyboard comes from params, never from the fallback, so both
      // transports carry the same buttons.
      const replyMarkup = params.reply_markup;
      if (replyMarkup !== undefined && (!replyMarkup || typeof replyMarkup !== 'object' || Array.isArray(replyMarkup))) {
        throw new Error('sendRichMessage reply_markup must be an object');
      }
      return sendRichCard({ sendRich, tg, bot, chatId, threadId: params.message_thread_id,
        blocks: rich.blocks, fallback, replyMarkup, meta: { source: source || 'ipc', botName } });
    }

    if (method === 'deleteMessage') {
      try {
        return { result: await tg(bot, method, params, { source: source || 'ipc', botName }) };
      } catch (err) {
        const said = String(err?.description || err?.message || err).replace(/^Bad Request:\s*/i, '');
        if (DELETE_REFUSED_RE.test(said)) {
          throw new Error(`deleteMessage refused by Telegram (${said}): a bot deletes its own messages in a group only within 48 hours, unless it is an admin allowed to delete messages`);
        }
        if (DELETE_GONE_RE.test(said)) throw new Error('deleteMessage: message to delete not found');
        throw err;
      }
    }

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

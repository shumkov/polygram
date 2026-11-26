'use strict';

const { richMessageToText } = require('./rich-inbound');

// One rich attempt through the shared sender, then one destination-preserving
// HTML fallback. The sender owns capability decisions and transcript recording.
// A keyboard goes on both attempts, so the card keeps its buttons whichever
// transport delivers it.
async function sendRichCard({ sendRich, tg, bot, chatId, threadId = null, blocks, fallback, replyMarkup = null, meta = {} }) {
  const strictMeta = { ...meta, strictDestination: true, linkPreview: false };
  const sent = sendRich ? await sendRich({ bot, chatId, threadId, blocks, replyMarkup,
    sourceText: richMessageToText({ blocks }), meta: strictMeta }) : { wentRich: false };
  if (sent.wentRich) return { result: sent.result, rich: true };
  if (!fallback) throw new Error(`Rich send failed (${sent.fallback || 'unsupported'})`);
  const result = await tg(bot, 'sendMessage', {
    chat_id: chatId, ...(threadId == null ? {} : { message_thread_id: threadId }),
    text: fallback.text, parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }, strictMeta);
  return { result, rich: false };
}

module.exports = { sendRichCard };

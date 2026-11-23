'use strict';

// Deep links into private supergroups (https://core.telegram.org/api/links).
// `t.me/c/` takes the Bot API chat id without its -100 prefix. A forum
// topic's id is the id of the message that created it, so a topic link has
// the same shape as a message link; message id 1 in a forum opens General.
// Basic groups and private chats have no such links. Every function returns
// null for anything it cannot prove right, because a link to the wrong place
// is worse than none.

const SUPERGROUP = /^-100([1-9]\d*)$/;
const THREAD = /^[1-9]\d*$/;
const MESSAGE_LINK = /^https:\/\/t\.me\/c\/([1-9]\d*)\/([1-9]\d*)(?:\/([1-9]\d*))?$/;

const channelOf = (chatId) => SUPERGROUP.exec(String(chatId ?? ''))?.[1] ?? null;
// undefined for an invalid thread, null for none.
const threadOf = (threadId) => (threadId == null ? null : THREAD.test(String(threadId)) ? String(threadId) : undefined);
const validMessageId = (messageId) => Number.isSafeInteger(messageId) && messageId > 0;

// A topic, or a forum's General when `forum` is true. A General session of a
// chat not proven to be a forum has no link: there /1 opens the first message.
function topicLink({ chatId, threadId = null, forum = false }) {
  const channel = channelOf(chatId);
  const thread = threadOf(threadId);
  if (!channel || thread === undefined) return null;
  if (thread === null) return forum === true ? `https://t.me/c/${channel}/1` : null;
  return `https://t.me/c/${channel}/${thread}`;
}

// One message: through its topic, or straight to the chat for a message in
// General or in a plain supergroup.
function messageLink({ chatId, threadId = null, messageId }) {
  const channel = channelOf(chatId);
  const thread = threadOf(threadId);
  if (!channel || thread === undefined || !validMessageId(messageId)) return null;
  return thread === null ? `https://t.me/c/${channel}/${messageId}` : `https://t.me/c/${channel}/${thread}/${messageId}`;
}

// The destination a message link names, or null. A two-part link reads as a
// message in General or a plain supergroup; it is also a topic's shape, so
// callers that need a real message check it against what was sent.
function parseMessageLink(url) {
  const match = typeof url === 'string' ? MESSAGE_LINK.exec(url) : null;
  if (!match) return null;
  const [, channel, first, second] = match;
  const messageId = Number(second ?? first);
  if (!validMessageId(messageId)) return null;
  return { chatId: `-100${channel}`, threadId: second === undefined ? null : first, messageId };
}

// The link to a sent message when Telegram's receipt proves it landed where
// it was sent, by the same proof the recorded-delivery path uses: the message
// id, and the chat and thread echoed back. Null otherwise.
function verifiedMessageLink(result, { chatId, threadId = null }) {
  if (!validMessageId(result?.message_id) || String(result?.chat?.id ?? '') !== String(chatId ?? '')
    || String(result?.message_thread_id ?? '') !== String(threadId ?? '')) return null;
  return messageLink({ chatId, threadId, messageId: result.message_id });
}

module.exports = { topicLink, messageLink, parseMessageLink, verifiedMessageLink };

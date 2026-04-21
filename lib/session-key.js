/**
 * Session-key derivation for per-chat (and optionally per-topic) Claude
 * sessions.
 *
 * Default behaviour (no `isolateTopics` or `false`): all topics in a chat
 * collapse into a single session keyed by chat_id. Claude sees every
 * topic's messages in one context window. This is the intuitive default —
 * topics are usually organisational (like Slack #channels), not genuine
 * project boundaries. Outbound replies still land in the originating topic
 * via `message_thread_id`, and the prompt stamps `topic="..."` on every
 * inbound message so Claude can follow parallel dialogs within the shared
 * session.
 *
 * Opt-in (`isolateTopics: true`): each topic gets its own Claude session
 * with its own `claude_session_id`. Context is tightly isolated — Orders
 * topic's conversation can't bleed into Billing topic's memory. This
 * matches OpenClaw's model and is the right call when topics represent
 * genuinely separate projects.
 */

function getSessionKey(chatId, threadId, chatConfig) {
  const isolate = chatConfig?.isolateTopics === true;
  if (threadId && isolate) return `${chatId}:${threadId}`;
  return chatId;
}

function getChatIdFromKey(sessionKey) {
  return sessionKey.split(':')[0];
}

module.exports = { getSessionKey, getChatIdFromKey };

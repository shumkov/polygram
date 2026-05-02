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

/**
 * Inverse of `getChatIdFromKey`: returns the thread_id portion of an
 * isolated-topic sessionKey, or null when there's no thread suffix.
 * Used by rc.47 autonomous-wakeup routing — when ScheduleWakeup
 * fires inside a polygram-spawned Query without a corresponding
 * pm.send, we derive (chat_id, thread_id) from sessionKey to route
 * the autonomous output back to the right Telegram chat/topic.
 */
function getThreadIdFromKey(sessionKey) {
  if (typeof sessionKey !== 'string' || !sessionKey) return null;
  const idx = sessionKey.indexOf(':');
  if (idx < 0) return null;
  const thread = sessionKey.slice(idx + 1);
  return thread || null;
}

module.exports = { getSessionKey, getChatIdFromKey, getThreadIdFromKey };

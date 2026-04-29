/**
 * Subagent / informational announces — a thin OpenClaw-style helper for
 * sending small "I'm doing X" messages to a chat without mixing into
 * the main reply flow.
 *
 * Polygram's user-facing surface for "shumabit is working" is the
 * status reaction on the user's message (👀 → 🤔 → tool icons →
 * 👍/💥). For tool-heavy turns where the user wants more visibility
 * — e.g. shumabit delegating to a subagent via Claude Code's Task
 * tool — an opt-in announce can post a brief informational message
 * to the chat. Off by default (`config.bots.<bot>.announceSubagents`
 * or `config.chats.<id>.announceSubagents`), so existing chats see
 * no behavior change.
 *
 * Note: this is the minimal MVP of OpenClaw's full subagent-announce
 * queue (which has debounce, drop policies, multi-channel routing).
 * Polygram's "subagents" are in-process (Claude Code Task tool), so
 * the announce path is just a one-shot informational sendMessage.
 */

const SUBAGENT_DEBOUNCE_MS = 30_000;

/**
 * Per-chat debounce so a turn that spawns 5 subagents back-to-back
 * doesn't post 5 announces. Module-scoped Map keyed by chatId →
 * timestamp of last announce.
 */
const lastAnnounceByChat = new Map();

function shouldAnnounce(chatId, now = Date.now(), debounceMs = SUBAGENT_DEBOUNCE_MS) {
  const prev = lastAnnounceByChat.get(String(chatId));
  if (prev != null && now - prev < debounceMs) return false;
  lastAnnounceByChat.set(String(chatId), now);
  return true;
}

/**
 * Send a plain-text announce (no markdown processing, no reply linkage).
 * Caller passes `tg(bot, method, params, meta)` as `send` so we don't
 * have to import the full lib/telegram.js dependency tree here.
 */
async function announce({
  send,
  bot,
  chatId,
  threadId = null,
  text,
  meta = {},
  logger = console,
}) {
  if (!text) return null;
  const params = {
    chat_id: chatId,
    text,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  };
  try {
    return await send(bot, 'sendMessage', params, {
      ...meta,
      source: meta.source || 'announce',
      plainText: true,            // skip markdown→HTML
      linkPreview: false,         // never preview-card for announces
    });
  } catch (err) {
    logger.error?.(`[announce] failed: ${err.message}`);
    return null;
  }
}

module.exports = { announce, shouldAnnounce, SUBAGENT_DEBOUNCE_MS };

/**
 * In-memory cache of message IDs the bot has sent, per chat.
 *
 * Port of OpenClaw's `sent-message-cache` (send-DVX_zY9w.js:1014-1041).
 * Use case: filter the bot's own messages out of activation logic in
 * group chats — a bot reply with a URL would otherwise auto-trigger
 * a self-reply if the chat's activation rule includes "any message
 * with a URL". Polygram's existing `messages` table can answer the
 * same question via SQL (`direction = 'out' AND chat_id AND msg_id`),
 * but the in-memory cache is O(1) for the high-frequency callers
 * (every inbound message reaction handler).
 *
 * 24-hour TTL: Telegram messages older than 48h can't be reacted to
 * anyway, so 24h is a comfortable working set. Per-chat cleanup runs
 * lazily when the chat exceeds 100 entries.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_THRESHOLD = 100;

function createSentCache() {
  // chatKey → Map<msgId, ts>
  const sentMessages = new Map();

  function chatKey(chatId) { return String(chatId); }

  function record(chatId, messageId) {
    if (chatId == null || messageId == null) return;
    const key = chatKey(chatId);
    let entry = sentMessages.get(key);
    if (!entry) {
      entry = new Map();
      sentMessages.set(key, entry);
    }
    entry.set(messageId, Date.now());
    // Lazy GC: when the per-chat map gets crowded, drop expired
    // entries. Cheap (O(n) over n ≤ 100 + a bit) and amortises to O(1).
    if (entry.size > CLEANUP_THRESHOLD) {
      const cutoff = Date.now() - TTL_MS;
      for (const [id, ts] of entry) if (ts < cutoff) entry.delete(id);
    }
  }

  function wasSent(chatId, messageId) {
    if (chatId == null || messageId == null) return false;
    const key = chatKey(chatId);
    const entry = sentMessages.get(key);
    if (!entry) return false;
    const ts = entry.get(messageId);
    if (ts == null) return false;
    if (Date.now() - ts > TTL_MS) {
      entry.delete(messageId);
      return false;
    }
    return true;
  }

  function size() {
    let total = 0;
    for (const entry of sentMessages.values()) total += entry.size;
    return total;
  }

  function clear() {
    sentMessages.clear();
  }

  return { record, wasSent, size, clear };
}

module.exports = { createSentCache, TTL_MS, CLEANUP_THRESHOLD };

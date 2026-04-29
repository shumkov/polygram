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
// 0.7.1: hard cap on per-chat Map size. CLEANUP_THRESHOLD only drops
// EXPIRED entries — if a busy chat sends >100 fresh messages within
// 24h, GC finds nothing to drop and the inner Map grows unbounded.
// Cap evicts oldest entries past this point regardless of TTL.
const MAX_PER_CHAT = 500;
// 0.7.1: outer Map sweep — drop chats whose inner Map has been empty
// long enough that we're sure no live caller still references it.
const OUTER_SWEEP_THRESHOLD = 1000;

function createSentCache({
  ttlMs = TTL_MS,
  cleanupThreshold = CLEANUP_THRESHOLD,
  maxPerChat = MAX_PER_CHAT,
  outerSweepThreshold = OUTER_SWEEP_THRESHOLD,
  clock = Date.now,
} = {}) {
  // chatKey → Map<msgId, ts>
  const sentMessages = new Map();

  function chatKey(chatId) { return String(chatId); }

  function gcInner(entry) {
    const cutoff = clock() - ttlMs;
    for (const [id, ts] of entry) if (ts < cutoff) entry.delete(id);
    // After TTL prune, if still over the hard cap, drop oldest entries
    // (insertion order in Map iteration). This handles the busy-chat
    // case where 1000 messages all sent within 24h would otherwise
    // leak.
    if (entry.size > maxPerChat) {
      const dropCount = entry.size - maxPerChat;
      let i = 0;
      for (const id of entry.keys()) {
        if (i >= dropCount) break;
        entry.delete(id);
        i += 1;
      }
    }
  }

  function gcOuter() {
    // Drop chat entries that are entirely empty (their inner Map was
    // drained by gcInner). Without this the outer Map's chatId set
    // grows by one per ever-active-then-idle chat, slowly leaking.
    for (const [k, entry] of sentMessages) {
      if (entry.size === 0) sentMessages.delete(k);
    }
  }

  function record(chatId, messageId) {
    if (chatId == null || messageId == null) return;
    const key = chatKey(chatId);
    let entry = sentMessages.get(key);
    if (!entry) {
      entry = new Map();
      sentMessages.set(key, entry);
    }
    entry.set(messageId, clock());
    if (entry.size > cleanupThreshold) gcInner(entry);
    // Periodic outer sweep — runs only when the outer Map gets crowded.
    if (sentMessages.size > outerSweepThreshold) gcOuter();
  }

  function wasSent(chatId, messageId) {
    if (chatId == null || messageId == null) return false;
    const key = chatKey(chatId);
    const entry = sentMessages.get(key);
    if (!entry) return false;
    const ts = entry.get(messageId);
    if (ts == null) return false;
    if (clock() - ts > ttlMs) {
      entry.delete(messageId);
      // If we just emptied the inner Map, drop the outer entry too.
      if (entry.size === 0) sentMessages.delete(key);
      return false;
    }
    return true;
  }

  function size() {
    let total = 0;
    for (const entry of sentMessages.values()) total += entry.size;
    return total;
  }

  function chatCount() { return sentMessages.size; }

  function clear() {
    sentMessages.clear();
  }

  return { record, wasSent, size, chatCount, clear };
}

module.exports = {
  createSentCache,
  TTL_MS,
  CLEANUP_THRESHOLD,
  MAX_PER_CHAT,
  OUTER_SWEEP_THRESHOLD,
};

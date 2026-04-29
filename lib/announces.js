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
 * 0.7.1 redesign: factory-based with split read/write predicates
 * (canAnnounce / markAnnounced) and lazy GC. Pre-0.7.1 had a
 * module-scoped Map and a mutate-on-check `shouldAnnounce` predicate
 * — both anti-patterns flagged in design review. The free-function
 * API (`shouldAnnounce`, `announce`) is preserved for back-compat,
 * delegating to a default singleton.
 */

const SUBAGENT_DEBOUNCE_MS = 30_000;

/**
 * Per-chat debounce tracker. Returns:
 *   - canAnnounce(chatId): true if this chat hasn't announced within
 *     the debounce window. Pure read, NO mutation — safe for
 *     speculative checks.
 *   - markAnnounced(chatId): records `now` as the last announce time
 *     for this chat. Caller invokes after a successful send.
 *   - sweep(): drops entries older than `2 * debounceMs`. Called lazily
 *     on every canAnnounce check past a soft threshold.
 *   - size(): for tests / diagnostics.
 *   - clear(): for test isolation.
 */
function createAnnouncer({
  debounceMs = SUBAGENT_DEBOUNCE_MS,
  clock = Date.now,
  sweepThreshold = 1000,
} = {}) {
  const lastAnnounceByChat = new Map();

  function key(chatId) { return String(chatId); }

  function sweep() {
    const cutoff = clock() - 2 * debounceMs;
    for (const [k, ts] of lastAnnounceByChat) {
      if (ts < cutoff) lastAnnounceByChat.delete(k);
    }
  }

  function canAnnounce(chatId) {
    if (lastAnnounceByChat.size > sweepThreshold) sweep();
    const prev = lastAnnounceByChat.get(key(chatId));
    return prev == null || (clock() - prev) >= debounceMs;
  }

  function markAnnounced(chatId) {
    lastAnnounceByChat.set(key(chatId), clock());
  }

  return {
    canAnnounce, markAnnounced, sweep,
    get size() { return lastAnnounceByChat.size; },
    clear() { lastAnnounceByChat.clear(); },
  };
}

// Default per-process state for the back-compat free-function API.
// Pre-0.7.1, this was the only API. Long-running daemons should still
// prefer createAnnouncer() for tests / multi-bot isolation, but
// polygram.js's single-bot-per-process model means the singleton works
// fine for the production path. The Map is pruned lazily inside
// shouldAnnounce when it grows past the sweep threshold.
const _defaultLastAnnouncements = new Map();
const _DEFAULT_SWEEP_THRESHOLD = 1000;

/**
 * Back-compat: pre-0.7.1 callers used `shouldAnnounce(chatId, now?,
 * debounceMs?)` which is a "predicate that mutates" — call site is
 * `if (shouldAnnounce(id)) await sendAnnounce()`. The mutation happens
 * eagerly. Preserved verbatim for callers; new code should use
 * `createAnnouncer()` and the explicit canAnnounce/markAnnounced split.
 *
 * 0.7.1: added lazy sweep so the Map doesn't grow unbounded over a
 * multi-week-uptime daemon.
 */
function shouldAnnounce(chatId, now = Date.now(), debounceMs = SUBAGENT_DEBOUNCE_MS) {
  if (_defaultLastAnnouncements.size > _DEFAULT_SWEEP_THRESHOLD) {
    const cutoff = now - 2 * debounceMs;
    for (const [k, ts] of _defaultLastAnnouncements) {
      if (ts < cutoff) _defaultLastAnnouncements.delete(k);
    }
  }
  const key = String(chatId);
  const prev = _defaultLastAnnouncements.get(key);
  if (prev != null && now - prev < debounceMs) return false;
  _defaultLastAnnouncements.set(key, now);
  return true;
}

/**
 * Reset the default singleton state (for tests). Not exported in
 * production docs.
 */
function _resetDefaultAnnouncerForTests() {
  _defaultLastAnnouncements.clear();
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

module.exports = {
  announce,
  shouldAnnounce,
  createAnnouncer,
  SUBAGENT_DEBOUNCE_MS,
  _resetDefaultAnnouncerForTests,
};

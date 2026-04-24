/**
 * Buffer Telegram messages that share a `media_group_id` so they can be
 * dispatched as ONE logical turn to Claude.
 *
 * Why: when a user uploads N photos "in one message," Telegram delivers N
 * distinct Message updates (one per photo, all tagged with the same
 * `media_group_id`). Without this buffer, polygram sees each photo as a
 * separate turn — Claude answers the first and the others either queue
 * behind it (consuming warm-process capacity) or fire their own turns
 * with no text.
 *
 * Pattern (matches OpenClaw's `MEDIA_GROUP_TIMEOUT_MS`):
 *   - Messages arriving faster than `flushMs` apart stay in the same
 *     group; timer resets on each arrival.
 *   - Group flushes `flushMs` after the LAST sibling arrives.
 *   - Stragglers arriving after a flush create a new group (new turn).
 *     Telegram usually ships all siblings within ~100ms, so 500ms of
 *     headroom catches virtually everything.
 *
 * I/O-pure: accepts `timerFn`/`clearTimerFn` for test injection.
 */

const DEFAULT_FLUSH_MS = 500;

function createMediaGroupBuffer({
  flushMs = DEFAULT_FLUSH_MS,
  onFlush,
  timerFn = setTimeout,
  clearTimerFn = clearTimeout,
} = {}) {
  if (typeof onFlush !== 'function') throw new Error('onFlush required');
  const entries = new Map(); // key → { messages, timer }

  const flushKey = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    // Defensive: onFlush errors must not break future group buffering.
    try { onFlush(entry.messages, key); }
    catch { /* caller can log if it cares */ }
  };

  const add = (key, msg) => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { messages: [], timer: null };
      entries.set(key, entry);
    }
    entry.messages.push(msg);
    if (entry.timer) clearTimerFn(entry.timer);
    const t = timerFn(() => flushKey(key), flushMs);
    // Don't keep the node event loop alive waiting for a buffered group
    // that never grew further — especially in tests.
    t?.unref?.();
    entry.timer = t;
  };

  const flushAll = () => {
    for (const key of Array.from(entries.keys())) {
      const entry = entries.get(key);
      if (entry?.timer) clearTimerFn(entry.timer);
      flushKey(key);
    }
  };

  return {
    add,
    flushAll,
    get size() { return entries.size; },
  };
}

module.exports = { createMediaGroupBuffer, DEFAULT_FLUSH_MS };

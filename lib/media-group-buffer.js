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
// 0.6.14 caps. The buffer is a single in-memory Map shared across every
// chat the bot serves; without bounds a hostile sender (or buggy client)
// could keep entries retained indefinitely by drip-feeding siblings under
// the flushMs window, OR balloon a single entry's messages array to the
// point of OOM. Reasonable defaults for typical Telegram album behavior:
// max 10 messages per group (Telegram's own album limit), max 64 entries
// in flight (one per active chat is plenty), and a hard 5s wall-clock
// retention regardless of arrivals.
const DEFAULT_MAX_MESSAGES_PER_GROUP = 10;
const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_AGE_MS = 5_000;

function createMediaGroupBuffer({
  flushMs = DEFAULT_FLUSH_MS,
  maxMessagesPerGroup = DEFAULT_MAX_MESSAGES_PER_GROUP,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  onFlush,
  timerFn = setTimeout,
  clearTimerFn = clearTimeout,
  nowFn = Date.now,
} = {}) {
  if (typeof onFlush !== 'function') throw new Error('onFlush required');
  const entries = new Map(); // key → { messages, timer, firstAddedTs }

  const flushKey = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimerFn(entry.timer);
    entries.delete(key);
    // Defensive: onFlush errors must not break future group buffering.
    try { onFlush(entry.messages, key); }
    catch { /* caller can log if it cares */ }
  };

  const add = (key, msg) => {
    let entry = entries.get(key);
    if (!entry) {
      // Cap total entries: if we're at the limit, force-flush the oldest
      // first. Avoids unbounded memory if a hostile sender spams keys.
      if (entries.size >= maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) flushKey(oldestKey);
      }
      entry = { messages: [], timer: null, firstAddedTs: nowFn() };
      entries.set(key, entry);
    }
    entry.messages.push(msg);

    // Per-group size cap: flush immediately when we hit the limit.
    if (entry.messages.length >= maxMessagesPerGroup) {
      flushKey(key);
      return;
    }

    // Per-group wall-clock cap: don't let drip-feeding indefinitely
    // postpone the flush via the resetting timer. If the group has been
    // open longer than maxAgeMs, flush now even though new siblings keep
    // arriving.
    if (nowFn() - entry.firstAddedTs >= maxAgeMs) {
      flushKey(key);
      return;
    }

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

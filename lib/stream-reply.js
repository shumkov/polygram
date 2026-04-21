/**
 * Live streaming-reply state machine for a single turn.
 *
 * Lifecycle per turn:
 *   idle  -> (text >= minChars) -> live
 *   live  -> (subsequent chunks) -> live       (throttled edits)
 *   idle|live -> finalize(finalText) -> done
 *
 * The streamer never talks to Telegram directly — callers inject
 * `send(text)` (returns {message_id}) and `edit(msg_id, text)`. That keeps
 * polygram.js in charge of transcript writes, sticker/reaction routing, and
 * error handling; this module is just a cadence machine.
 *
 * Test-friendly: inject `clock` (now() fn) and `schedule` (setTimeout-like)
 * so a fake clock can drive throttle timing deterministically.
 */

const DEFAULT_MIN_CHARS = 30;
const DEFAULT_THROTTLE_MS = 500;

function createStreamer({
  send,                                   // async (text) -> { message_id }
  edit,                                   // async (msg_id, text) -> void
  minChars = DEFAULT_MIN_CHARS,
  throttleMs = DEFAULT_THROTTLE_MS,
  maxLen = 4096,
  clock = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  logger = console,
} = {}) {
  let state = 'idle';       // 'idle' | 'live' | 'finalized'
  let msgId = null;
  let currentText = '';     // what's on screen right now (truncated to maxLen)
  let latestText = '';      // latest we've been told about
  let lastEditTs = 0;
  let pendingEdit = null;   // timer id
  let flushPromise = null;  // ongoing edit promise (for back-pressure)

  function truncate(s) {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 3) + '...';
  }

  async function onChunk(text) {
    if (state === 'finalized') return;
    latestText = text;

    // idle: not yet sent the initial message. Only fire the initial send
    // once we cross the threshold. Short responses stay in-buffer and are
    // delivered via the caller's normal path on finalize().
    if (state === 'idle') {
      if (text.length < minChars) return;
      state = 'live';
      currentText = truncate(text);
      try {
        const res = await send(currentText);
        msgId = res?.message_id ?? null;
        lastEditTs = clock();
        if (msgId == null) {
          // Caller failed to get a message_id — revert to idle; finalize
          // will fall through to normal send path.
          state = 'idle';
          msgId = null;
        }
      } catch (err) {
        logger.error(`[stream] initial send failed: ${err.message}`);
        state = 'idle';
      }
      return;
    }

    // live: debounce edits. If we're inside the throttle window, schedule
    // a delayed flush; otherwise flush now.
    scheduleEdit();
  }

  function scheduleEdit() {
    const now = clock();
    const elapsed = now - lastEditTs;
    if (pendingEdit) return;  // already queued
    const delay = Math.max(0, throttleMs - elapsed);
    pendingEdit = schedule(flush, delay);
  }

  async function flush() {
    pendingEdit = null;
    if (state !== 'live' || msgId == null) return;
    const next = truncate(latestText);
    if (next === currentText) return;
    lastEditTs = clock();
    currentText = next;
    try {
      flushPromise = edit(msgId, currentText);
      await flushPromise;
    } catch (err) {
      // Non-fatal — maybe 429. Log and keep going; next chunk will retry.
      logger.error(`[stream] edit failed: ${err.message}`);
    } finally {
      flushPromise = null;
    }
  }

  async function finalize(finalText, { errorSuffix = null } = {}) {
    if (state === 'finalized') return { streamed: false, msgId };
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; }
    if (flushPromise) { try { await flushPromise; } catch {} }

    if (state === 'idle') {
      state = 'finalized';
      return { streamed: false, msgId: null };
    }

    // live → finalize: one last edit with the full answer.
    state = 'finalized';
    let body = finalText ?? latestText;
    if (errorSuffix) body = `${body}\n\n⚠️ ${errorSuffix}`;
    const next = truncate(body);
    if (next !== currentText) {
      try { await edit(msgId, next); currentText = next; }
      catch (err) { logger.error(`[stream] final edit failed: ${err.message}`); }
    }
    return { streamed: true, msgId, finalText: next };
  }

  return {
    onChunk,
    finalize,
    // Introspection for tests:
    get state() { return state; },
    get msgId() { return msgId; },
    get currentText() { return currentText; },
  };
}

module.exports = {
  createStreamer,
  DEFAULT_MIN_CHARS,
  DEFAULT_THROTTLE_MS,
};

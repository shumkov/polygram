/**
 * Live streaming-reply state machine for a single turn.
 *
 * Lifecycle (0.7.0):
 *   idle  -> (text >= minChars) -> live
 *   live  -> (subsequent chunks) -> live       (throttled edits)
 *   live  -> forceNewMessage()    -> idle      (next chunk = new bubble)
 *   live  -> discard()            -> finalized (bubble deleted)
 *   any   -> finalize(finalText)  -> finalized
 *
 * The streamer never talks to Telegram directly — callers inject `send(text)`,
 * `edit(msg_id, text)`, and (new in 0.7.0) optional `deleteMessage(msg_id)`.
 * That keeps polygram.js in charge of transcript writes, sticker/reaction
 * routing, and error handling; this module is just a cadence machine.
 *
 * 0.7.0 finalize() returns rich result so the caller can decide whether the
 * preview's last edit IS the final reply, or whether to discard the preview
 * and redeliver via deliverReplies (overflow / final edit failed). This is
 * the OpenClaw pattern: short replies preview-becomes-final (no flicker),
 * long replies preview-deleted-redelivered (single coherent bubble flow at
 * chat bottom).
 *
 * Test-friendly: inject `clock` (now() fn) and `schedule` (setTimeout-like)
 * so a fake clock can drive throttle timing deterministically.
 */

const DEFAULT_MIN_CHARS = 30;
// Matches OpenClaw's edit throttle. 500ms was edit-storm territory on long
// turns — every token burst triggered an API call, risking 429s and burning
// Telegram's edit-rate budget faster than necessary. 1000ms feels
// identical to a viewer and halves the edit volume.
const DEFAULT_THROTTLE_MS = 1000;

function createStreamer({
  send,                                   // async (text) -> { message_id }
  edit,                                   // async (msg_id, text) -> void
  deleteMessage = null,                   // async (msg_id) -> void  [optional]
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

  // 0.7.0: this is the LIVE-EDIT truncation, used during streaming
  // when latestText overshoots maxLen. The trailing "..." signals to
  // the user that more is coming. At finalize time, we DON'T truncate
  // — we either edit-to-final-as-is (caller already chunked correctly)
  // or signal overflow back to the caller.
  function truncateForLive(s) {
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
      currentText = truncateForLive(text);
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
    const next = truncateForLive(latestText);
    if (next === currentText) return;
    lastEditTs = clock();
    currentText = next;
    try {
      flushPromise = edit(msgId, currentText);
      await flushPromise;
    } catch (err) {
      // Non-fatal — maybe 429 or transient. Log and keep going; next
      // chunk will retry. The HTML→plain fallback in lib/telegram.js
      // already handles the most common cause (parse error from
      // truncate cutting mid-tag).
      logger.error(`[stream] edit failed: ${err.message}`);
    } finally {
      flushPromise = null;
    }
  }

  // 0.7.0: explicitly drain any pending edit. Useful when the caller
  // is about to make a finalize/discard decision and wants the bubble's
  // visual state to be accurate (no stale half-rendered text under a
  // pending timer).
  async function flushDraft() {
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; await flush(); }
    if (flushPromise) { try { await flushPromise; } catch {} }
  }

  // 0.7.0: reset bubble state so the next onChunk creates a NEW message.
  // Used by the upcoming Phase 7 F (forceNewMessage on assistant-
  // message-start) — when Claude emits a new top-level assistant message
  // mid-turn (post tool-result), we want it in its own bubble below
  // the previous one, not appended via edit.
  function forceNewMessage() {
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; }
    // Don't await flushPromise — the caller has decided to start a new
    // message; whatever the old bubble shows is "done".
    msgId = null;
    currentText = '';
    latestText = '';
    state = 'idle';
    lastEditTs = 0;
  }

  // 0.7.0: delete the current bubble via the injected deleteMessage
  // callback. Used when the final reply overflows the preview's single-
  // message capacity, so handleMessage will discard the preview and
  // redeliver via deliverReplies (chunks land at chat bottom).
  //
  // If deleteMessage isn't provided, we just transition state without
  // touching Telegram — the bubble stays at its last edited content,
  // becoming a vestigial "head" of the conversation. Caller chooses.
  async function discard() {
    if (state === 'finalized') {
      const lingering = msgId;
      msgId = null;
      return { msgId: lingering, deleted: false };
    }
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; }
    if (flushPromise) { try { await flushPromise; } catch {} }
    const idToDelete = msgId;
    state = 'finalized';
    msgId = null;
    let deleted = false;
    if (idToDelete && typeof deleteMessage === 'function') {
      try {
        await deleteMessage(idToDelete);
        deleted = true;
      } catch (err) {
        // Telegram rejects deletions of messages older than 48h or
        // already-deleted ones. Non-fatal — the redelivery happens
        // either way.
        logger.warn?.(`[stream] discard deleteMessage failed: ${err.message}`);
      }
    }
    return { msgId: idToDelete, deleted };
  }

  // 0.7.0: snapshot for callers that want to track the bubble's id
  // for later cleanup (e.g. archive a superseded preview when
  // forceNewMessage was called and the previous bubble should be
  // deleted at end-of-turn).
  function archive() {
    return { msgId, currentText };
  }

  // 0.7.0: rich result. `finalEditOk` tells caller whether the preview
  // can stand as the final reply (true) or needs to be replaced via
  // discard + deliverReplies (false). `overflow` is the one specific
  // reason: body wouldn't fit in a single Telegram message.
  async function finalize(finalText, { errorSuffix = null } = {}) {
    if (state === 'finalized') return { streamed: false, msgId, finalEditOk: false, overflow: false };
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; }
    if (flushPromise) { try { await flushPromise; } catch {} }

    if (state === 'idle') {
      state = 'finalized';
      return { streamed: false, msgId: null, finalEditOk: false, overflow: false };
    }

    // live → finalize.
    state = 'finalized';
    let body = finalText ?? latestText;
    if (errorSuffix) body = `${body}\n\n⚠️ ${errorSuffix}`;

    // If body overflows the single-message cap, the caller needs to
    // discard this bubble and redeliver via chunks. Don't try to edit.
    if (body.length > maxLen) {
      return { streamed: true, msgId, finalText: body, finalEditOk: false, overflow: true };
    }

    // Body fits. Try one last edit to bring the bubble to the final
    // text. If that succeeds, preview-IS-final and caller can return
    // without redelivering. If it fails (e.g. parse error after our
    // wrapper exhausts its retry, or a 5xx), caller should discard
    // and redeliver — the bubble's content is unreliable.
    if (body === currentText) {
      // Already correct — no edit needed.
      return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
    }
    try {
      await edit(msgId, body);
      currentText = body;
      return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
    } catch (err) {
      logger.error(`[stream] final edit failed: ${err.message}`);
      return { streamed: true, msgId, finalText: body, finalEditOk: false, overflow: false };
    }
  }

  return {
    onChunk,
    finalize,
    flushDraft,
    forceNewMessage,
    discard,
    archive,
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

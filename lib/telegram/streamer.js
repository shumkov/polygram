/**
 * Live streaming-reply state machine for a single turn.
 *
 * Lifecycle:
 *   idle  -> (text >= minChars) -> live
 *   live  -> (subsequent chunks) -> live       (throttled edits)
 *   live  -> flushDraft()         -> live      (drains pending edit)
 *   live  -> forceNewMessage()    -> idle      (next chunk = new bubble)
 *   live  -> discard()            -> finalized (bubble deleted)
 *   any   -> finalize(finalText)  -> finalized
 *
 * The streamer never talks to Telegram directly — callers inject
 * `send(text)`, `edit(msg_id, text)`, and (optional) `deleteMessage(msg_id)`.
 * That keeps polygram.js in charge of transcript writes, sticker/reaction
 * routing, and error handling; this module is just a cadence machine.
 *
 * `finalize()` returns a rich result so the caller can decide whether the
 * preview's last edit IS the final reply, or whether to discard the
 * preview and redeliver via deliverReplies (overflow / final edit failed):
 *
 *   { kind: implicit, see flags below }
 *   { streamed: false }                                  — never went live
 *   { streamed: true, finalEditOk: true }                — preview = final
 *   { streamed: true, finalEditOk: false, overflow: true } — body too long
 *   { streamed: true, finalEditOk: false, overflow: false } — edit failed
 *
 * Short replies preview-becomes-final (no flicker, single bubble); long
 * replies preview-deleted-redelivered (chunks land at chat bottom).
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

// 0.7.4: floor matches OpenClaw's `Math.max(250, throttleMs)` clamp —
// any value below 250ms would burn through Telegram's per-message edit-
// rate budget faster than necessary. Defends against operator misconfig
// (`streamThrottleMs: 50`) without rejecting the config outright.
const THROTTLE_FLOOR_MS = 250;

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
  // rc.67: pre-processor applied to every chunk before send/edit. polygram
  // passes stripInlineTags(...) so [sticker:NAME] / [react:EMOJI] never
  // reach the bubble or the messages.text DB row. Default identity keeps
  // existing tests + non-polygram callers untouched.
  //
  // Why here (streamer) and not in polygram's send callback: the streamer
  // owns currentText/latestText state used by finalize's no-op-edit
  // optimisation. If pre-processing only happened in send/edit closures,
  // the streamer's internal state would carry raw text and finalize's
  // body-vs-currentText comparison would still fire spurious edits.
  // Applying transformText here means the WHOLE state machine sees clean
  // text — finalize correctly takes the no-op branch when the bubble is
  // already final.
  transformText = null,
  // rc.44: by default, KEEP intermediate text bubbles when
  // forceNewMessage transitions to a fresh bubble for a new
  // top-level assistant message. These are NOT "thinking" tokens
  // (those are filtered out by extractAssistantText —
  // b.type === 'text' only). They're regular text segments the
  // model emitted as part of the reply (e.g. "Let me check that..."
  // → tool runs → "Found it. Here's the answer..."). Pre-0.7.2
  // these were preserved (the original 0.7.0 multi-bubble design);
  // 0.7.2 added archive-and-delete-at-turn-end as OpenClaw-parity
  // cleanup. rc.44 reverts to the 0.7.0 preserve-all default
  // because the intermediate text is substantive reply content,
  // not noise. Set to false to restore the 0.7.2 deletion behaviour
  // (only final bubble visible) for partner-facing chats that
  // prefer terse output.
  preserveIntermediateBubbles = true,
  // Optional progressive rich-message rendering. A null callback keeps
  // the streamer on its plain-text path.
  //
  // toRichPayload(text, { partial }) -> { blocks, usedRich } | null
  //   Called on every flush/finalize with the CURRENT latestText/finalText
  //   (untruncated — rich content is never char-truncated with a "..."
  //   the way plain live-preview text is; partial:true tells it to hold
  //   back a possibly-incomplete trailing block, see lib/telegram/rich.js).
  //   usedRich:false (or a null return) means "not rich this tick" — the
  //   streamer falls through to the existing plain-text path unchanged.
  //   The callback may return a different result on each call when live
  //   configuration or capability state changes.
  toRichPayload = null,
  // Rich messages have a larger Bot API character cap than plain
  // messages, so rich edits and finalization must use this limit.
  richMaxLen = 32768,
  // Fires for each successful plain-to-rich transition. Caller wires this
  // to instrumentation for the visible bubble-shape change.
  onRichUpgrade = () => {},
} = {}) {
  throttleMs = Math.max(THROTTLE_FLOOR_MS, throttleMs);
  let state = 'idle';       // 'idle' | 'live' | 'finalized'
  let msgId = null;
  let currentText = '';     // what's on screen right now (truncated to maxLen) — plain-path only
  let currentRichJson = null; // JSON.stringify of the last-sent rich blocks, or null when not in rich mode
  let latestText = '';      // latest we've been told about
  let lastEditTs = 0;
  let pendingEdit = null;   // timer id
  let flushPromise = null;  // serialized flush chain (for back-pressure)
  let flushQueued = false;  // latest text changed while a flush was active
  let bubbleGeneration = 0; // invalidates state commits from superseded bubbles
  // 0.7.2: msg_ids of bubbles that have been superseded by
  // forceNewMessage(). The caller (polygram.js handleMessage at
  // end-of-turn) reads getArchived() and issues deleteMessage on
  // each.
  //
  // History note (rc.44 correction): the 0.7.2 commit claimed this
  // was "OpenClaw-parity / archivedAnswerPreviews cleanup" — that
  // was wrong. The OFFICIAL OpenClaw + pi-telegram model is
  // single-bubble-per-turn edited in place via sendMessageDraft (or
  // sendMessage + editMessageText fallback); intermediate text
  // segments don't exist there because the streamer concatenates
  // everything into the same bubble. Polygram's multi-bubble shape
  // is a 0.7.0 polygram-specific decision (one bubble per top-level
  // assistant-message id, motivated by the SDK's segmentation), and
  // the 0.7.2 archive-and-delete was a polygram-specific terseness
  // cleanup, not OpenClaw porting. rc.44 made preserve-all the
  // default again — archived[] only fills when
  // preserveIntermediateBubbles=false (opt-out for partner-facing
  // chats that prefer only-final-answer-visible output).
  const archived = [];

  // LIVE-EDIT truncation only — used during streaming when latestText
  // overshoots maxLen. The trailing "..." signals to the user that more
  // is coming. Finalize doesn't truncate: overflow is handled by
  // signalling the caller to discard-and-redeliver via chunkMarkdownText,
  // which preserves all content without any byte-cut.
  function truncateForLive(s) {
    if (s.length <= maxLen) return s;
    // Back off one unit if the cut would split a surrogate pair (emoji /
    // astral chars) — a lone high surrogate renders as � in the live bubble.
    let cut = maxLen - 3;
    const cc = s.charCodeAt(cut - 1);
    if (cc >= 0xD800 && cc <= 0xDBFF) cut -= 1;
    return s.slice(0, cut) + '...';
  }

  // rc.67: scrub recognised inline tags BEFORE the streamer commits text
  // to its state machine. Identity when no transformer was configured.
  // Defensive: if transformText throws, fall back to the raw text rather
  // than swallow the chunk — log via injected logger.
  function applyTransform(text) {
    if (!transformText) return text;
    try {
      return transformText(text);
    } catch (err) {
      logger.error?.(`[stream] transformText threw, falling back to raw: ${err.message}`);
      return text;
    }
  }

  async function onChunk(text) {
    if (state === 'finalized') return;
    text = applyTransform(text);
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

  // Decide the rich-vs-plain payload for the CURRENT latestText/finalText.
  // Shared by flush() and finalize() so the "only attempt rich under the
  // rich char cap" guard and the upgrade-event firing live in one place.
  function resolveRichPayload(text, { partial }) {
    if (!toRichPayload) return null;
    if (text.length > richMaxLen) {
      // Edge case, not fully engineered (documented limitation): a
      // mid-stream reply that's ALREADY past the rich cap while still
      // growing. Rather than flap into a truncated/ellipsis rich render
      // (which has no real analog — rich has no "..." convention), skip
      // rich for this tick; finalize()'s own overflow check (against
      // richMaxLen) is what actually decides discard-and-redeliver-plain
      // once streaming ends.
      return null;
    }
    let payload;
    try {
      payload = toRichPayload(text, { partial });
    } catch (err) {
      logger.error?.(`[stream] toRichPayload threw, falling back to plain: ${err.message}`);
      return null;
    }
    return payload && payload.usedRich ? payload : null;
  }

  async function flush() {
    pendingEdit = null;
    if (state !== 'live' || msgId == null) return;

    if (flushPromise) {
      flushQueued = true;
      return flushPromise;
    }

    const run = (async () => {
      do {
        flushQueued = false;
        await flushOnce();
      } while (flushQueued && state === 'live' && msgId != null);
    })();
    flushPromise = run;
    try {
      await run;
    } finally {
      if (flushPromise === run) flushPromise = null;
    }
  }

  async function flushOnce() {
    if (state !== 'live' || msgId == null) return;
    const editMsgId = msgId;
    const generation = bubbleGeneration;
    const sourceText = latestText;

    const richPayload = resolveRichPayload(sourceText, { partial: true });
    if (richPayload) {
      const json = JSON.stringify(richPayload.blocks);
      if (json === currentRichJson) return; // no structural change since last edit
      const wasRich = currentRichJson !== null;
      lastEditTs = clock();
      try {
        // Keep the source beside its blocks so a content-error fallback
        // can render the same Markdown through the plain-text path.
        const editResult = await edit(editMsgId, {
          rich: true, blocks: richPayload.blocks, sourceText,
        });
        if (generation !== bubbleGeneration || msgId !== editMsgId) return;
        // A rich editor can resolve successfully after sending the same
        // source as plain fallback. Track what actually landed.
        const wentRich = editResult == null || editResult.wentRich !== false;
        if (wentRich) {
          currentRichJson = json;
          if (!wasRich) onRichUpgrade();
        } else {
          currentText = sourceText;
          currentRichJson = null;
        }
      } catch (err) {
        logger.error(`[stream] rich edit failed: ${err.message}`);
      }
      return;
    }

    const next = truncateForLive(sourceText);
    if (currentRichJson === null && next === currentText) return;
    lastEditTs = clock();
    try {
      await edit(editMsgId, next);
      if (generation !== bubbleGeneration || msgId !== editMsgId) return;
      currentText = next;
      currentRichJson = null;
    } catch (err) {
      // Non-fatal — maybe 429 or transient. Log and keep going; next
      // chunk will retry. The HTML→plain fallback in lib/telegram.js
      // already handles the most common cause (parse error from
      // truncate cutting mid-tag).
      logger.error(`[stream] edit failed: ${err.message}`);
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

  // Reset bubble state so the next onChunk creates a NEW message.
  // Used by `onAssistantMessageStart` in lib/process-manager-sdk.js
  // when Claude emits a new top-level assistant message mid-turn
  // (post tool-result): we want it in its own bubble below the
  // previous one, not appended via editMessageText to the original.
  //
  // rc.44: by default, the previous bubble is PRESERVED (not archived
  // for end-of-turn deletion). Intermediate text segments are
  // substantive reply content the user typed up — not "thinking"
  // tokens (those are filtered upstream). Pre-0.7.2 polygram kept
  // them all; 0.7.2 added deletion for OpenClaw-parity terseness.
  // rc.44 reverts to the 0.7.0 preserve-all default. Opt back into
  // the 0.7.2 behaviour with `preserveIntermediateBubbles: false`.
  //
  // When preserving, we still cancel the pending throttled edit (it
  // wouldn't fire after we transition to a new bubble anyway) but
  // there may be a recently-flushed edit in flight whose result we
  // don't await — the bubble will display whatever its last
  // successful edit landed, which is typically very close to the
  // segment's final text (throttle is 250ms; segments take seconds).
  function forceNewMessage() {
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; }
    if (msgId != null && !preserveIntermediateBubbles) {
      archived.push(msgId);
    }
    msgId = null;
    currentText = '';
    currentRichJson = null; // new bubble starts plain — see toRichPayload doc
    latestText = '';
    state = 'idle';
    lastEditTs = 0;
    flushQueued = false;
    bubbleGeneration += 1;
  }

  // 0.7.0: delete the current bubble via the injected deleteMessage
  // callback. Used when the final reply overflows the preview's single-
  // message capacity, so handleMessage will discard the preview and
  // redeliver via deliverReplies (chunks land at chat bottom).
  //
  // Works whether state is 'live' OR 'finalized' — handleMessage's
  // typical flow is finalize() → finalEditOk false → discard. The
  // bubble's msgId is preserved through finalize so we can still
  // delete it. If deleteMessage isn't provided, we just transition
  // state without touching Telegram — the bubble stays at its last
  // edited content, becoming a vestigial "head" of the conversation.
  async function discard() {
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
    // rc.67: defense-in-depth — even if a caller passes raw text to
    // finalize, transformText scrubs it before the bubble's last edit.
    // Apply to BOTH branches (explicit finalText AND fallback to
    // latestText) so the comparison `body === currentText` is always
    // apples-to-apples (currentText was already transformed in onChunk).
    let body = applyTransform(finalText ?? latestText);
    if (errorSuffix) body = `${body}\n\n⚠️ ${errorSuffix}`;

    // Finalization evaluates the complete body, so no trailing block is
    // held back as potentially incomplete.
    const richPayload = resolveRichPayload(body, { partial: false });
    if (richPayload) {
      // Rich finalization uses the rich-message cap; applying the smaller
      // plain-message cap would unnecessarily redeliver valid rich bodies.
      if (body.length > richMaxLen) {
        return { streamed: true, msgId, finalText: body, finalEditOk: false, overflow: true };
      }
      const json = JSON.stringify(richPayload.blocks);
      if (json === currentRichJson) {
        return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
      }
      const wasRich = currentRichJson !== null;
      try {
        const editResult = await edit(msgId, { rich: true, blocks: richPayload.blocks, sourceText: body });
        // A fallback still delivered the final content, but as plain text.
        const wentRich = editResult == null || editResult.wentRich !== false;
        if (wentRich) {
          currentRichJson = json;
          if (!wasRich) onRichUpgrade();
        } else {
          currentText = body;
          currentRichJson = null;
        }
        return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
      } catch (err) {
        logger.error(`[stream] final rich edit failed: ${err.message}`);
        return { streamed: true, msgId, finalText: body, finalEditOk: false, overflow: false };
      }
    }

    // Plain finalization uses the regular message cap.
    //
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
    if (currentRichJson === null && body === currentText) {
      // Already correct — no edit needed.
      return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
    }
    try {
      await edit(msgId, body);
      currentText = body;
      currentRichJson = null;
      return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
    } catch (err) {
      logger.error(`[stream] final edit failed: ${err.message}`);
      return { streamed: true, msgId, finalText: body, finalEditOk: false, overflow: false };
    }
  }

  // 0.7.2: snapshot of bubble msgIds that forceNewMessage() superseded.
  // Returns a copy so callers can't mutate internal state. polygram.js
  // reads this at end-of-turn and issues deleteMessage on each.
  function getArchived() { return archived.slice(); }

  return {
    onChunk,
    finalize,
    flushDraft,
    forceNewMessage,
    discard,
    archive,
    getArchived,
    // Introspection for tests:
    get state() { return state; },
    get msgId() { return msgId; },
    get currentText() { return currentText; },
    get isRichMode() { return currentRichJson !== null; },
    get currentRichBlocks() { return currentRichJson ? JSON.parse(currentRichJson) : null; },
  };
}

module.exports = {
  createStreamer,
  DEFAULT_MIN_CHARS,
  DEFAULT_THROTTLE_MS,
};

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
 * `send(payload)`, `edit(msg_id, payload)`, and (optional)
 * `deleteMessage(msg_id)`.
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

/**
 * The part of a snapshot the reader has already seen as COMPLETE: everything
 * up to and including the last blank line. What follows it is the block still
 * being written, which the model may revise freely.
 *
 * A blank line stands in for a real block boundary on purpose. It mirrors what
 * the rich renderer already does — partial mode holds back the last top-level
 * block, so the completed-blocks prefix IS what reached the screen — without
 * a lexer call on the hot path, and it works identically on the plain path
 * where rich rendering is not involved at all. It also fails OPEN: text with
 * no blank line anywhere yields an empty prefix and pins nothing, matching
 * rich's own rule that a single in-progress block renders as-is.
 */
function committedPrefix(text) {
  const i = text.lastIndexOf('\n\n');
  if (i === -1) return '';
  const prefix = text.slice(0, i + 2);
  // An unterminated ``` fence is ONE top-level block, and the renderer holds
  // the whole block back — a snapshot that is nothing but an open fence draws
  // zero blocks. So a blank line INSIDE it separates nothing the reader has
  // seen, and pinning there would freeze the preview the moment the model
  // edits a line of the snippet it is still writing. An odd number of fence
  // markers means the last one is still open: cut back to before it.
  const openFence = (prefix.split('```').length - 1) % 2 === 1;
  return openFence ? prefix.slice(0, prefix.lastIndexOf('```')) : prefix;
}

// A task-list marker at the head of a list item, and only there. `[x]` inside
// a sentence is prose — rewriting it IS losing text, and must still be caught.
const TASK_MARKER_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\]/gm;

/**
 * Flatten checkbox STATE so ticking an item reads as the same text.
 *
 * Polygram's own display hint tells the agent to "send an updated list with
 * items checked off as you complete them" — a deliberate mutation of a line
 * the reader has already seen. Comparing snapshots verbatim would refuse it
 * and freeze the preview for the rest of the turn on the exact feature the
 * prompt asks for. A tick loses nothing: the item is still there, in place,
 * saying the same thing about a different state.
 *
 * Length-preserving on purpose ('[x]' and '[ ]' are both three characters),
 * so a prefix stays a prefix and the comparison needs no index arithmetic.
 */
function normalizeTaskMarkers(text) {
  return text.replace(TASK_MARKER_RE, '$1[ ]');
}

/**
 * The form both sides of the guard comparison are read in.
 *
 * CRLF is folded first, and not for tidiness: `lastIndexOf('\n\n')` never
 * matches `\r\n\r\n`, so a CRLF document would find no boundary at all and
 * silently switch the guard off — the one failure mode a guard must not have.
 * Canonicalizing BOTH sides before the boundary is computed keeps the prefix
 * relationship exact without any index arithmetic.
 */
function canonicalizeForGuard(text) {
  return normalizeTaskMarkers(text.replace(/\r\n/g, '\n'));
}

function createStreamer({
  // async (payload) -> { message_id, _hadReplyAnchor?, wentRich? }
  //
  // payload is a plain string, or — when the very first qualifying chunk
  // already renders as structure — the rich shape { rich: true, blocks,
  // sourceText, plainText }. (No `phase`, unlike an edit: a send is only
  // ever the open.) A caller that cannot open rich delivers `plainText`
  // instead and reports `wentRich: false`; the streamer then holds PLAIN
  // state so the next flush edits the bubble it actually has. An absent
  // `wentRich` means the payload landed as sent (backward compatible with
  // plain-only callers).
  send,
  edit,                                   // async (msg_id, payload) -> void
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
  // toRichPayload(text, { partial }) ->
  //   { blocks, usedRich, rescueEntries? } | null
  //   Called on every flush/finalize with the CURRENT latestText/finalText
  //   (untruncated — rich content is never char-truncated with a "..."
  //   the way plain live-preview text is; partial:true tells it to hold
  //   back a possibly-incomplete trailing block, see lib/telegram/rich.js).
  //   usedRich:false (or a null return) means "not rich this tick" — the
  //   streamer falls through to the existing plain-text path unchanged.
  //   Final media-bearing payloads include rescueEntries. The streamer
  //   carries them into redelivery results and uses their presence to
  //   decide whether a detached intermediate bubble needs sealing.
  //   The callback may return a different result on each call when live
  //   configuration or capability state changes.
  toRichPayload = null,
  // Rich messages have a larger Bot API character cap than plain
  // messages, so rich edits and finalization must use this limit.
  richMaxLen = 32768,
  // Fires for each successful plain-to-rich transition. Caller wires this
  // to instrumentation for the visible bubble-shape change. A bubble that
  // OPENS rich never had a plain shape to change, so it does not fire —
  // the metric stays a count of visible flips.
  onRichUpgrade = () => {},
  // Fires once per refused snapshot — one that lost text the reader had
  // already seen. Receives { prevLen, newLen }; the caller owns the chat and
  // turn identifiers, which this module has no business knowing, and a turn
  // that keeps offending is a count over the rows it writes.
  onNonCumulativeSnapshot = () => {},
  // Optional "still writing" tail for partial renders.
  //
  //   toComposingMarker() -> { block, plainSuffix } | null
  //
  // Called per partial render, so a caller whose rendering capabilities shift
  // mid-turn (typed nodes refused, say) answers with the shape that fits NOW —
  // the same reason toRichPayload is a callback rather than a value. null
  // keeps every bubble exactly as it was before this existed.
  //
  // Deliberately NOT applied to: the initial send (sendMessage and
  // sendRichMessage are the only streamer verbs that write a transcript row —
  // skipping them is what keeps the marker out of storage without threading a
  // do-not-persist signal through the send path), finalize, or a seal. Those
  // render a bubble that is DONE, and a finished bubble must not claim
  // otherwise.
  toComposingMarker = null,
} = {}) {
  // throttleMs may be a number OR a function evaluated per edit. Telegram's
  // rate limits are per CHAT, but a streamer is per turn — several forum topics
  // in one chat each edit at their own cadence and share one budget. A caller
  // that knows how many previews are live in the chat right now passes a
  // function so the cadence scales as topics come and go mid-turn.
  const fixedThrottleMs = typeof throttleMs === 'function'
    ? null
    : Math.max(THROTTLE_FLOOR_MS, throttleMs);
  function currentThrottleMs() {
    if (fixedThrottleMs != null) return fixedThrottleMs;
    const n = Number(throttleMs());
    return Math.max(THROTTLE_FLOOR_MS, Number.isFinite(n) && n > 0 ? n : DEFAULT_THROTTLE_MS);
  }
  let state = 'idle';       // 'idle' | 'live' | 'finalized'
  let msgId = null;
  let hadReplyAnchor = false;
  let currentText = '';     // what's on screen right now (truncated to maxLen) — plain-path only
  let currentRichJson = null; // JSON.stringify of the last-sent rich blocks, or null when not in rich mode
  // Whether the bubble is currently showing the composing marker. Tracked
  // beside the content state rather than inside it: currentText and
  // currentRichJson answer "is the content on screen current?", and folding a
  // presentation suffix into them would re-edit unchanged bubbles. It is a
  // second reason to edit, never a change of what the answer says.
  let currentMarkerShown = false;
  let latestText = '';      // latest we've been told about
  let lastEditTs = 0;
  let pendingEdit = null;   // timer id
  let flushPromise = null;  // serialized flush chain (for back-pressure)
  let flushQueued = false;  // latest text changed while a flush was active
  let initialSendPromise = null; // active generation's initial send
  let sealChain = Promise.resolve(); // detached bubbles, in boundary order
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
  function truncateForLive(s, limit = maxLen) {
    if (s.length <= limit) return s;
    // Back off one unit if the cut would split a surrogate pair (emoji /
    // astral chars) — a lone high surrogate renders as � in the live bubble.
    let cut = limit - 3;
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

    // Snapshots must only ever grow. Backends that build the text by
    // appending satisfy this by construction; a model driving the snapshot
    // itself can send a longer one that dropped earlier sections, and
    // rendering it wipes text the reader is part-way through. Refuse it:
    // leave the bubble on the last good snapshot and let the turn's reply
    // deliver the truth, which is what it does anyway.
    //
    // latestText IS the last ACCEPTED snapshot — a refusal returns before
    // assigning — so the anchor never moves to text nobody saw.
    const committed = committedPrefix(canonicalizeForGuard(latestText));
    if (committed && !canonicalizeForGuard(text).startsWith(committed)) {
      try {
        onNonCumulativeSnapshot({
          prevLen: latestText.length,
          newLen: text.length,
        });
      } catch (err) {
        logger.error?.(`[stream] onNonCumulativeSnapshot threw: ${err.message}`);
      }
      return;
    }
    latestText = text;

    // idle: not yet sent the initial message. Only fire the initial send
    // once we cross the threshold. Short responses stay in-buffer and are
    // delivered via the caller's normal path on finalize().
    if (state === 'idle') {
      if (text.length < minChars) return;
      const generation = bubbleGeneration;
      state = 'live';
      // Open the bubble RICH when the first qualifying chunk already
      // renders as structure. Without this the preview streams plain for
      // the whole turn and converts to the rich document in one jump at
      // finalize; opening rich means every later flush appends completed
      // blocks to a document that was rich from its first frame.
      // The rich payload measures against the rich cap, not the plain
      // live-edit cap — resolveRichPayload owns that check, so an
      // over-cap first chunk falls through to the truncated plain open.
      const openRich = resolveRichPayload(text, { partial: true });
      const plainText = truncateForLive(text);
      currentText = openRich ? '' : plainText;
      let sendPromise;
      try {
        sendPromise = Promise.resolve(send(openRich
          ? {
            rich: true, blocks: openRich.blocks, sourceText: text,
            // What the plain path would have sent, so a caller that has to
            // downgrade delivers a bubble under the PLAIN cap.
            plainText,
          }
          : currentText));
      } catch (err) {
        sendPromise = Promise.reject(err);
      }
      initialSendPromise = sendPromise;
      try {
        const res = await sendPromise;
        if (generation !== bubbleGeneration) return;
        msgId = res?.message_id ?? null;
        hadReplyAnchor = res?._hadReplyAnchor === true;
        lastEditTs = clock();
        if (msgId == null) {
          // Caller failed to get a message_id — revert to idle; finalize
          // will fall through to normal send path.
          state = 'idle';
          msgId = null;
          hadReplyAnchor = false;
          currentRichJson = null;
        } else if (openRich) {
          // The open can resolve after delivering the same source as plain
          // text (capability latch, refused payload). Seed rich state only
          // for what actually landed: claiming rich over a plain bubble
          // would let the next flush skip its edit as a no-op, and claiming
          // plain over a rich one would overwrite the document with a plain
          // edit — a visible downgrade.
          if (res?.wentRich === false) {
            currentText = plainText;
            currentRichJson = null;
          } else {
            currentRichJson = JSON.stringify(openRich.blocks);
          }
        }
        // The open carries no marker, and flush only ever runs off a LATER
        // snapshot — so a turn that emits one snapshot and then goes quiet,
        // the sharpest form of "is it still writing or did it die?", would
        // never show one. Schedule the frame that adds it. Content is
        // unchanged, so for a caller with no marker this flush finds nothing
        // to do and issues no edit; gated anyway, since scheduling a timer at
        // all is a change those callers did not ask for.
        if (msgId != null && toComposingMarker) scheduleEdit();
      } catch (err) {
        if (generation !== bubbleGeneration) return;
        logger.error(`[stream] initial send failed: ${err.message}`);
        state = 'idle';
        hadReplyAnchor = false;
        currentRichJson = null;
      } finally {
        if (initialSendPromise === sendPromise) initialSendPromise = null;
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
    const delay = Math.max(0, currentThrottleMs() - elapsed);
    pendingEdit = schedule(flush, delay);
  }

  // Decide the rich-vs-plain payload for the CURRENT latestText/finalText.
  // Shared by flush() and finalize() so the "only attempt rich under the
  // rich char cap" guard and the upgrade-event firing live in one place.
  function resolveRichPayload(text, { partial, allowOverflow = false }) {
    if (!toRichPayload) return null;
    if (text.length > richMaxLen && !allowOverflow) {
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

  // The marker for THIS partial render, or null when there is none to show or
  // no room for it. `contentLen` is measured on the content alone and the
  // marker has to fit beside it: a bubble gives up the marker before it gives
  // up a character of the answer.
  // The marker this render would carry, before any question of whether it
  // fits. `blocks` is the planned content (null on the plain path): the
  // builder needs it because a marker that is styled while the content is not
  // would make polygram's own decoration the thing rich-edit.js's styling
  // verdicts are recorded about.
  function buildComposingMarker(blocks) {
    if (!toComposingMarker) return null;
    let marker;
    try {
      marker = toComposingMarker({ blocks });
    } catch (err) {
      logger.error?.(`[stream] toComposingMarker threw, rendering without it: ${err.message}`);
      return null;
    }
    if (!marker || !marker.block || typeof marker.plainSuffix !== 'string') return null;
    return marker;
  }

  // Whether `marker` fits beside content of `contentLen` under `cap`. One
  // budget for both shapes: the rich block's rendered weight is the same line
  // of text the plain suffix carries, and a single measurement keeps the two
  // paths from disagreeing about whether there is room.
  function markerFits(marker, contentLen, cap) {
    return marker != null && contentLen + marker.plainSuffix.length <= cap;
  }

  async function flush() {
    pendingEdit = null;
    if (state !== 'live' || msgId == null) return;

    if (flushPromise) {
      flushQueued = true;
      return flushPromise;
    }

    const generation = bubbleGeneration;
    const run = (async () => {
      do {
        flushQueued = false;
        await flushOnce();
      } while (flushQueued
        && generation === bubbleGeneration
        && state === 'live'
        && msgId != null);
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
      const built = buildComposingMarker(richPayload.blocks);
      const marker = markerFits(built, sourceText.length, richMaxLen) ? built : null;
      // Appearing or disappearing is itself a change worth an edit — the
      // content-only comparison would otherwise leave the bubble mismatched.
      if (json === currentRichJson && !!marker === currentMarkerShown) return;
      const wasRich = currentRichJson !== null;
      lastEditTs = clock();
      // Committed BEFORE the await, unlike the content state beside it. This
      // flag's job is to tell a later seal that a marker may be on screen, and
      // a detach landing during this await would otherwise snapshot "no
      // marker" for a bubble about to display one — with nothing left that
      // will ever edit it again. Wrong-in-the-true-direction costs one
      // redundant strip edit; wrong the other way is permanent.
      currentMarkerShown = !!marker;
      try {
        // Keep the source beside its blocks so a content-error fallback
        // can render the same Markdown through the plain-text path. The
        // marker is not in it: a fallback delivers the answer, not the
        // decoration.
        const editResult = await edit(editMsgId, {
          rich: true,
          blocks: marker ? [...richPayload.blocks, marker.block] : richPayload.blocks,
          sourceText,
          phase: 'preview', hadReplyAnchor,
        });
        if (generation !== bubbleGeneration || msgId !== editMsgId) return;
        // A rich editor can resolve successfully after sending the same
        // source as plain fallback. Track what actually landed.
        const wentRich = editResult == null || editResult.wentRich !== false;
        if (wentRich) {
          currentRichJson = json;
          if (!wasRich) onRichUpgrade();
        } else {
          // The fallback rendered sourceText, which never carries the marker.
          currentText = sourceText;
          currentRichJson = null;
          currentMarkerShown = false;
        }
      } catch (err) {
        logger.error(`[stream] rich edit failed: ${err.message}`);
      }
      return;
    }

    const built = buildComposingMarker(null);
    let next = truncateForLive(sourceText);
    let marker = markerFits(built, next.length, maxLen) ? built : null;
    if (built && !marker && sourceText.length > maxLen) {
      // The bubble is already eliding — the text on screen is a view of the
      // answer, not the answer, and finalize delivers the whole thing. Moving
      // the cut back far enough to keep the marker costs nothing anyone would
      // otherwise have read, and a reply long enough to be truncated is the
      // one that streams longest and most needs to say it is still going.
      // Content that fits WITHOUT truncation is never cut to make room: there
      // the marker gives way instead.
      next = truncateForLive(sourceText, maxLen - built.plainSuffix.length);
      marker = built;
    }
    if (currentRichJson === null && next === currentText && !!marker === currentMarkerShown) return;
    lastEditTs = clock();
    currentMarkerShown = !!marker;   // before the await — see the rich branch
    try {
      await edit(editMsgId, marker ? next + marker.plainSuffix : next);
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

  function appendSealJob(job, label = 'seal') {
    const run = sealChain.then(job);
    sealChain = run.catch((err) => {
      const errorClass = err?.name || 'Error';
      logger.error?.(`[stream] ${label} failed (${errorClass})`);
    });
    return sealChain;
  }

  // The initial send is what turns the bubble from an intention into a
  // message_id. onChunk flips to 'live' synchronously but assigns msgId only
  // once that send resolves, so anything acting on the bubble in between —
  // a final edit, a drain, a delete — would target msgId=null and the message
  // that lands a moment later becomes an unreachable orphan in the chat.
  // Everything that touches the bubble waits here first.
  async function awaitInitialSend() {
    while (initialSendPromise) {
      const pending = initialSendPromise;
      try { await pending; } catch { /* onChunk owns the failure path */ }
      // onChunk's own continuation clears the field (it was registered on the
      // promise first, so it has already committed msgId by now). If it somehow
      // hasn't, stop rather than spin.
      if (initialSendPromise === pending) return;
    }
  }

  async function drainSeals() {
    while (true) {
      const pending = sealChain;
      await pending;
      if (pending === sealChain) return;
    }
  }

  async function awaitDetached(promise, label) {
    try {
      await promise;
    } catch (err) {
      logger.error?.(`[stream] ${label} failed (${err?.name || 'Error'})`);
    }
  }

  async function sealBubble(snapshot) {
    let targetMsgId = snapshot.msgId;
    let targetHadReplyAnchor = snapshot.hadReplyAnchor;

    if (snapshot.initialSendPromise) {
      const res = await snapshot.initialSendPromise;
      targetMsgId = res?.message_id ?? targetMsgId;
      targetHadReplyAnchor = res?._hadReplyAnchor === true;
    }
    if (snapshot.flushPromise) {
      await awaitDetached(snapshot.flushPromise, 'detached bubble flush');
    }
    if (targetMsgId == null) return;

    // This bubble is finished — the stream has moved to a new one and nothing
    // will edit this again. A composing marker on it is now a lie, so it is a
    // reason to seal in its own right, alongside media that never resolved.
    const stripMarker = snapshot.markerShown === true;

    const payload = (toRichPayload && snapshot.sourceText.length <= richMaxLen)
      ? toRichPayload(snapshot.sourceText, { partial: false })
      : null;

    if (payload?.usedRich) {
      const hasRescue = Array.isArray(payload.rescueEntries) && payload.rescueEntries.length > 0;
      if (!hasRescue && !stripMarker) return;
      const json = JSON.stringify(payload.blocks);
      // Identical blocks still need the edit when a marker block is riding on
      // top of them — that extra block is exactly what has to go.
      if (json === snapshot.currentRichJson && !stripMarker) return;

      await edit(targetMsgId, {
        rich: true,
        blocks: payload.blocks,
        sourceText: snapshot.sourceText,
        phase: 'seal',
        hadReplyAnchor: targetHadReplyAnchor,
      });
      return;
    }

    // Only a bubble that is actually PLAIN may be sealed with plain text.
    // toRichPayload can render rich while partial and decline at
    // partial:false — rich.js demotes a media-only document whose media never
    // resolved, and that check is gated on !partial, so it cannot fire during
    // the live ticks. Overwriting a long rich document with maxLen characters
    // of truncated text would destroy content the reader already read; a
    // marker left on a finished bubble is only cosmetic. Content wins.
    if (!stripMarker || snapshot.currentRichJson !== null) return;
    // A plain bubble: the content alone is the same text it already shows,
    // minus the marker. truncateForLive keeps the plain path's existing cap
    // contract rather than inventing a second one here.
    await edit(targetMsgId, truncateForLive(snapshot.sourceText));
  }

  // 0.7.0: explicitly drain any pending edit. Useful when the caller
  // is about to make a finalize/discard decision and wants the bubble's
  // visual state to be accurate (no stale half-rendered text under a
  // pending timer).
  async function flushDraft() {
    await awaitInitialSend();
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; await flush(); }
    if (flushPromise) { try { await flushPromise; } catch {} }
    await drainSeals();
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
  // The old bubble is detached synchronously. Preserved bubbles enqueue
  // one final media-aware edit behind any request already targeting that
  // message; terse bubbles retain late initial-send ids for cleanup.
  function forceNewMessage() {
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; }
    const snapshot = {
      sourceText: latestText,
      msgId,
      hadReplyAnchor,
      currentRichJson,
      markerShown: currentMarkerShown,
      initialSendPromise,
      flushPromise,
    };
    const hadOutgoingMessage = state === 'live'
      && (snapshot.msgId != null || snapshot.initialSendPromise != null);

    // Detach in-flight work before resetting. Conditional identity checks
    // in onChunk()/flush() keep old completions from clearing new promises
    // or committing state into the next generation.
    initialSendPromise = null;
    flushPromise = null;
    msgId = null;
    hadReplyAnchor = false;
    currentText = '';
    currentRichJson = null; // new bubble starts plain — see toRichPayload doc
    currentMarkerShown = false;
    latestText = '';
    state = 'idle';
    lastEditTs = 0;
    flushQueued = false;
    bubbleGeneration += 1;

    if (!hadOutgoingMessage) return;

    if (preserveIntermediateBubbles) {
      appendSealJob(() => sealBubble(snapshot));
      return;
    }

    if (snapshot.msgId != null) archived.push(snapshot.msgId);
    if (snapshot.initialSendPromise || snapshot.flushPromise) {
      appendSealJob(async () => {
        if (snapshot.initialSendPromise) {
          const res = await snapshot.initialSendPromise;
          const lateMsgId = res?.message_id ?? null;
          if (lateMsgId != null) archived.push(lateMsgId);
        }
        if (snapshot.flushPromise) {
          await awaitDetached(snapshot.flushPromise, 'detached bubble cleanup flush');
        }
      }, 'detached bubble cleanup');
    }
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
    await awaitInitialSend();
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; }
    if (flushPromise) { try { await flushPromise; } catch {} }
    await drainSeals();
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
    // An in-flight send can still resolve the bubble into existence (or fail
    // and drop us back to 'idle'), and another caller can finalize while we
    // wait — hence the re-check on the far side.
    await awaitInitialSend();
    if (state === 'finalized') return { streamed: false, msgId, finalEditOk: false, overflow: false };
    if (pendingEdit) { cancel(pendingEdit); pendingEdit = null; }
    if (flushPromise) { try { await flushPromise; } catch {} }
    await drainSeals();

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
    const finalHadReplyAnchor = hadReplyAnchor;

    // Finalization evaluates the complete body, so no trailing block is
    // held back as potentially incomplete.
    const richPayload = resolveRichPayload(body, { partial: false, allowOverflow: true });
    if (richPayload) {
      // Rich finalization uses the rich-message cap; applying the smaller
      // plain-message cap would unnecessarily redeliver valid rich bodies.
      if (body.length > richMaxLen) {
        return {
          streamed: true, msgId, finalText: body, finalEditOk: false, overflow: true,
          rescueEntries: richPayload.rescueEntries || [],
          hadReplyAnchor: finalHadReplyAnchor,
        };
      }
      const json = JSON.stringify(richPayload.blocks);
      // A bubble showing the composing marker is NOT already correct, however
      // right its content is — skipping the edit here would leave the finished
      // answer claiming to still be written, permanently.
      if (json === currentRichJson && !currentMarkerShown) {
        return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
      }
      const wasRich = currentRichJson !== null;
      try {
        const editResult = await edit(msgId, {
          rich: true, blocks: richPayload.blocks, sourceText: body,
          phase: 'final', hadReplyAnchor: finalHadReplyAnchor,
        });
        // A fallback still delivered the final content, but as plain text.
        const wentRich = editResult == null || editResult.wentRich !== false;
        currentMarkerShown = false;   // whichever shape landed, it was the final render
        if (wentRich) {
          currentRichJson = json;
          if (!wasRich) onRichUpgrade();
        } else {
          currentText = body;
          currentRichJson = null;
        }
        if (editResult?.bubbleRemoved) {
          msgId = null;
          currentText = '';
          currentRichJson = null;
          hadReplyAnchor = false;
        }
        return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
      } catch (err) {
        logger.error(`[stream] final rich edit failed: ${err.message}`);
        return {
          streamed: true, msgId, finalText: body, finalEditOk: false, overflow: false,
          rescueEntries: richPayload.rescueEntries || [],
          hadReplyAnchor: finalHadReplyAnchor,
        };
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
    // Already correct — no edit needed. A marker on screen means it is not:
    // the content matches, the bubble still says it is being written.
    if (currentRichJson === null && body === currentText && !currentMarkerShown) {
      return { streamed: true, msgId, finalText: body, finalEditOk: true, overflow: false };
    }
    try {
      await edit(msgId, body);
      currentText = body;
      currentRichJson = null;
      currentMarkerShown = false;
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
    drainSeals,
    discard,
    archive,
    getArchived,
    // Introspection for tests:
    get state() { return state; },
    get msgId() { return msgId; },
    // The most recent text the streamer was told about, which is NOT always
    // what's on screen (a throttled edit may still be pending) and NOT always
    // what a reply delivered. A caller reconciling a live preview at turn end
    // needs it to decide whether the draft still holds undelivered content.
    get latestText() { return latestText; },
    get currentText() { return currentText; },
    get isRichMode() { return currentRichJson !== null; },
    get currentRichBlocks() { return currentRichJson ? JSON.parse(currentRichJson) : null; },
  };
}

module.exports = {
  createStreamer,
  committedPrefix,
  DEFAULT_MIN_CHARS,
  DEFAULT_THROTTLE_MS,
};

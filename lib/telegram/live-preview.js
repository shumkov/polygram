/**
 * The live-preview bubble's lifecycle, outside handleMessage's closure.
 *
 * A streamer is created per turn inside handleMessage, but three things need to
 * reach it from elsewhere:
 *
 *   1. The CLI reply path. Replies arrive through the channels tool dispatcher,
 *      a different call stack entirely, and a reply must CONSUME the live
 *      preview rather than send a second bubble under it saying the same thing.
 *   2. Turn-completion exits. A turn can end many ways, and each one has to
 *      settle whatever the preview is holding — identically.
 *   3. The edit cadence. Telegram rate-limits per CHAT, but forum topics share
 *      one chat_id and each live topic edits at its own 1 Hz.
 *
 * The registry keyed on sessionKey answers all three — polygram's own
 * bookkeeping, not a reach into process-manager internals.
 *
 * The governing rule, stated once: a live preview ALWAYS consumes the next
 * non-interim reply; a new bubble is sent only when no preview is live. Every
 * turn shape in this module follows from it.
 */

'use strict';

const { resolveBoolOverride } = require('../config-override');

/**
 * Per-chat opt-in for the CLI `stream` tool. Default OFF: registering the tool
 * changes what the agent is taught to do, so it rolls out per chat rather than
 * fleet-wide.
 */
function resolveStreamPreviewEnabled(config, chatId, threadId = null) {
  return resolveBoolOverride(config, 'streamPreview', chatId, threadId);
}

function createStreamerRegistry() {
  const bySessionKey = new Map();   // sessionKey → { streamer, chatId }

  /**
   * Register the turn's streamer. Returns a release function that removes the
   * entry ONLY if it is still the one registered here — a later turn on the
   * same session that has already taken over must not be evicted by an earlier
   * turn's cleanup.
   */
  function register(sessionKey, { streamer, chatId, deliveredTexts = [], getTurnId = null }) {
    if (sessionKey == null || !streamer) return () => {};
    // deliveredTexts is the CALLER's array by reference: the reply path appends
    // to it here, and the turn's own reconciliation reads it from the handler's
    // closure. One list, two readers, no copy to fall out of date.
    const entry = {
      streamer,
      chatId: String(chatId),
      deliveredTexts,
      // Read lazily: the engine publishes the turn id onto the caller's context
      // object during dispatch, which happens after registration.
      getTurnId: typeof getTurnId === 'function' ? getTurnId : () => null,
      // Text handed to the delivery pipeline but not yet confirmed delivered.
      // Promoted into deliveredTexts only once the send succeeds — a failed
      // reply the user never saw must not make a later draft look redundant.
      pendingDelivered: null,
      // Replies are serialized through this: two concurrent calls would
      // otherwise race one preview through flush/finalize/discard.
      chain: Promise.resolve(),
    };
    bySessionKey.set(sessionKey, entry);
    return () => {
      if (bySessionKey.get(sessionKey) === entry) bySessionKey.delete(sessionKey);
    };
  }

  function get(sessionKey) {
    return sessionKey == null ? null : (bySessionKey.get(sessionKey) || null);
  }

  /** How many previews are currently live (initial send landed) in this chat. */
  function liveCount(chatId) {
    const want = String(chatId);
    let n = 0;
    for (const entry of bySessionKey.values()) {
      if (entry.chatId === want && entry.streamer.state === 'live') n += 1;
    }
    return n;
  }

  /**
   * A reply's text has been handed to the delivery pipeline but has not landed
   * yet. Held aside until settlePending says whether it did.
   */
  function notePending(sessionKey, text) {
    const entry = get(sessionKey);
    if (entry) entry.pendingDelivered = typeof text === 'string' ? text : null;
  }

  /**
   * The pipeline finished. On success the text joins the delivered set; on
   * failure it is dropped, because the user never saw it and a later draft
   * repeating it is the only copy they will get.
   */
  function settlePending(sessionKey, ok) {
    const entry = get(sessionKey);
    if (!entry) return;
    if (ok && entry.pendingDelivered) entry.deliveredTexts.push(entry.pendingDelivered);
    entry.pendingDelivered = null;
  }

  return {
    register, get, liveCount, notePending, settlePending,
    get size() { return bySessionKey.size; },
  };
}

/**
 * Is the draft's content already in the user's hands?
 *
 * A delivered reply must contain the COMPLETE draft. The containment is
 * deliberately one-directional: `reply("A")` followed by `stream("A and also
 * B")` is NOT covered — the draft holds B, which nobody delivered, and treating
 * the shorter reply as covering it deletes B for good. Only "everything the
 * draft says has already been said" justifies discarding it.
 */
function isCoveredByDelivered(latestText, deliveredTexts) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const draft = norm(latestText);
  if (!draft) return true;   // nothing to lose
  for (const delivered of (deliveredTexts || [])) {
    const d = norm(delivered);
    if (d && d.includes(draft)) return true;
  }
  return false;
}

/**
 * Settle a live preview at any turn-completion exit — the shared answer to
 * "the turn is over; what happens to the half-written bubble?"
 *
 * Every exit runs this, so there is one rule instead of one decision per exit:
 *
 *   - not live                → nothing to settle.
 *   - the draft's content was already delivered by a reply → delete it; leaving
 *     it would show the answer twice.
 *   - reason 'no-reply'       → delete it. The agent explicitly chose silence,
 *     and a half-written draft is not consent to speak.
 *   - otherwise               → finalize it in place. The turn ended holding
 *     text nobody else delivered (it died mid-compose, or answered via a
 *     stream call and never replied) — the user should get what was written,
 *     not an empty chat.
 *
 * @param {object|null} streamer
 * @param {string[]} deliveredTexts — reply bodies this turn already delivered
 * @param {object} [opts]
 * @param {?string} [opts.reason]   — 'no-reply' honors an explicit silence
 * @param {?Function} [opts.logEvent]
 * @param {object} [opts.detail]    — merged into the emitted event
 * @param {?Function} [opts.redeliver] — async (text) → boolean. Used when the
 *   draft cannot fit one bubble: same escape hatch the consume rule has, so an
 *   over-long orphan is delivered whole instead of surviving as a truncation.
 * @returns {Promise<{action: 'none'|'discarded'|'finalized'|'redelivered'|'finalize-failed', msgId: ?number, text: ?string}>}
 */
async function reconcileStreamer(streamer, deliveredTexts = [], {
  reason = null,
  logEvent = null,
  detail = {},
  redeliver = null,
} = {}) {
  if (!streamer) return { action: 'none', msgId: null, text: null };

  // Drains the pending throttled edit AND the in-flight initial send, so the
  // state and msgId read below are the real ones.
  try { await streamer.flushDraft(); } catch { /* best effort */ }
  if (streamer.state !== 'live') return { action: 'none', msgId: null, text: null };

  const latest = streamer.latestText || '';
  const covered = isCoveredByDelivered(latest, deliveredTexts);

  if (covered || reason === 'no-reply') {
    let discarded = { msgId: streamer.msgId, deleted: false };
    try { discarded = await streamer.discard(); } catch { /* bubble may be gone */ }
    logEvent?.('stream-orphan-discarded', {
      ...detail,
      reason: reason || (latest.trim() ? 'covered-by-reply' : 'empty-draft'),
      deleted: discarded.deleted === true,
    });
    return { action: 'discarded', msgId: discarded.msgId ?? null, text: null };
  }

  const fin = await streamer.finalize(latest);
  if (fin.finalEditOk && fin.msgId != null) {
    logEvent?.('stream-orphan-finalized', { ...detail, reason: reason || 'undelivered-draft', len: latest.length });
    return { action: 'finalized', msgId: fin.msgId, text: fin.finalText ?? latest };
  }

  // The draft outgrew one bubble, or the last edit failed. The bubble holds at
  // best a truncation of the answer, so hand the WHOLE text to the chunked path
  // and delete the stump — the same escape the consume rule takes, for the same
  // reason: a preview must never be the only copy of a partial answer.
  if (typeof redeliver === 'function') {
    let sent = false;
    try { sent = await redeliver(fin.finalText ?? latest); } catch { sent = false; }
    if (sent) {
      try { await streamer.discard(); } catch { /* bubble may be gone */ }
      logEvent?.('stream-orphan-redelivered', {
        ...detail,
        reason: fin.overflow ? 'overflow' : 'edit-failed',
        len: latest.length,
      });
      return { action: 'redelivered', msgId: null, text: fin.finalText ?? latest };
    }
  }

  // No redelivery path, or it failed. Leave the bubble standing: deleting it
  // would destroy the only copy the user has.
  logEvent?.('stream-orphan-finalize-failed', {
    ...detail,
    overflow: fin.overflow === true,
    len: latest.length,
  });
  return { action: 'finalize-failed', msgId: fin.msgId ?? null, text: latest };
}

/**
 * Bind the turn-completion rule to one turn's state.
 *
 * handleMessage calls the returned `settle(reason)` at every exit. Everything
 * the settlement DOES — reconcile, bring the transcript row along, hand an
 * over-long draft to the chunked path — lives here rather than in the handler's
 * closure, so it can be executed in a test instead of only pattern-matched in
 * the source.
 *
 * @param {object} deps
 * @param {?object} deps.streamer
 * @param {string[]} deps.deliveredTexts
 * @param {boolean} [deps.enabled]      — false makes settle a no-op, so a chat
 *   without live previews behaves exactly as it did before this feature
 * @param {?Function} [deps.persistBubbleText] — (chatId, msgId, text) → void
 * @param {?Function} [deps.redeliver]  — async (text) → boolean
 * @param {?Function} [deps.logEvent]
 * @param {string|number} [deps.chatId]
 * @param {object} [deps.detail]        — merged into emitted events
 */
function createTurnSettler({
  streamer,
  deliveredTexts,
  enabled = true,
  persistBubbleText = null,
  redeliver = null,
  logEvent = null,
  chatId = null,
  detail = {},
} = {}) {
  return async function settle(reason = null) {
    if (!enabled) return { action: 'none', msgId: null, text: null };
    const res = await reconcileStreamer(streamer, deliveredTexts, {
      reason, logEvent, detail, redeliver,
    });
    // The bubble now holds the final body; its row still holds the ~30
    // characters the initial send wrote.
    if (res.action === 'finalized') persistBubbleText?.(chatId, res.msgId, res.text);
    return res;
  };
}

/**
 * The reply-side half of the rule: build the `deliverText` strategy factory the
 * channels dispatcher hands to the agent-reply pipeline.
 *
 * `makeDeliverText({sessionKey, chatId, threadId, interim, turnId})` returns
 * either a strategy or null (no live-preview surface for that session → the
 * pipeline delivers normally).
 *
 * @param {object} deps
 * @param {object} deps.registry          — createStreamerRegistry() instance
 * @param {Function} [deps.logEvent]      — (kind, detail) → void
 * @param {Function} [deps.persistBubbleText] — (chatId, msgId, text) → void
 * @param {object} [deps.logger]
 * @param {?string} [deps.botName]        — event payload tag
 */
function createDeliverTextFactory({
  registry,
  logEvent = null,
  persistBubbleText = null,
  logger = console,
  botName = null,
} = {}) {
  return function makeDeliverText({ sessionKey, chatId, interim, turnId } = {}) {
    const entry = registry.get(sessionKey);
    if (!entry) return null;              // no live-preview surface for this turn
    const { streamer } = entry;

    return function deliverText({ text }) {
      // Replies are serialized per session. Two concurrent calls would
      // otherwise race one preview through flushDraft → finalize → discard →
      // forceNewMessage and interleave halfway, consuming the same bubble
      // twice or deleting one the other just finalized.
      const run = entry.chain.then(() => consume({ text }));
      entry.chain = run.then(() => {}, () => {});
      return run;
    };

    async function consume({ text }) {
      // A reply is bound to the turn it names. A delayed reply from an earlier
      // turn must not finalize the CURRENT turn's preview with stale text; it
      // still gets delivered, just as its own bubble.
      const ownTurnId = entry.getTurnId();
      const turnMismatch = turnId != null && ownTurnId != null && turnId !== ownTurnId;

      // An interim status is not the turn's answer, so its text must never
      // enter the coverage set: a later draft holding the status AND the answer
      // would look covered and be deleted.
      if (!interim) entry.pendingDelivered = text;

      // Drains the pending throttled edit AND the in-flight initial send, so
      // the state and msgId read below are the real ones.
      await streamer.flushDraft();

      // An interim status must not eat the preview the answer is still being
      // written into. It goes out as its own bubble; forceNewMessage then opens
      // the next preview BELOW it, which keeps the visual order truthful.
      if (interim || turnMismatch || streamer.state !== 'live') {
        if (turnMismatch) {
          logEvent?.('stream-preview-turn-mismatch', {
            chat_id: chatId, session_key: sessionKey,
            reply_turn_id: turnId, preview_turn_id: ownTurnId, bot: botName,
          });
        }
        detachCurrentPreview();
        return { handled: false };
      }

      const fin = await streamer.finalize(text);
      // finalEditOk with no msgId means the bubble is gone (a rich edit removed
      // it). There is nothing to hand back as the reply's message_id, so this
      // is a fallthrough, not a consumption — never answer {ok:true, id:null}.
      if (fin.streamed && fin.finalEditOk && fin.msgId != null) {
        openNextPreview();
        persistBubbleText?.(chatId, fin.msgId, fin.finalText ?? text);
        if (!interim) {
          // The finalize edit IS the delivery, and it succeeded.
          entry.pendingDelivered = null;
          entry.deliveredTexts.push(text);
        }
        logEvent?.('stream-preview-consumed', {
          chat_id: chatId, session_key: sessionKey,
          msg_id: fin.msgId, chars: text.length, bot: botName,
        });
        return { handled: true, sent: [fin.msgId], failed: [] };
      }

      // The answer outgrew one bubble (the common case past 4,096 characters)
      // or the last edit failed. Delete the preview and let the normal chunked
      // path deliver the whole thing at the bottom of the chat — no content is
      // lost, and no stale half-answer is left standing above it.
      try { await streamer.discard(); }
      catch (err) { logger?.error?.(`[live-preview] discard failed: ${err.message}`); }
      openNextPreview();
      logEvent?.('stream-preview-redelivered', {
        chat_id: chatId, session_key: sessionKey,
        reason: fin.overflow ? 'overflow' : 'edit-failed',
        chars: text.length, bot: botName,
      });
      return { handled: false };
    }

    /**
     * Open a fresh preview slot after WE settled the bubble (finalized it into
     * a reply, or discarded it). Unconditional: we know the settle just
     * happened and that the next snapshot deserves a new bubble below it.
     */
    function openNextPreview() {
      streamer.forceNewMessage();
    }

    /**
     * Leave the current preview standing and open a fresh slot below it — the
     * interim-status path, where the bubble is substantive content the user
     * should keep reading.
     *
     * A streamer someone ELSE settled is left completely alone. forceNewMessage
     * resets state to 'idle', so calling it on a finalized streamer un-finalizes
     * it, and a chunk arriving afterwards opens a bubble that no turn-completion
     * exit will ever reconcile.
     *
     * The persist covers the bubble being left behind: it keeps whatever it last
     * showed on screen, but its transcript row still holds the first ~30
     * characters from the initial send, and no edit ever revisits that row.
     */
    function detachCurrentPreview() {
      if (streamer.state === 'finalized') return;
      if (streamer.state === 'live') {
        persistBubbleText?.(chatId, streamer.msgId, streamer.latestText);
      }
      streamer.forceNewMessage();
    }
  };
}

module.exports = {
  createStreamerRegistry,
  createDeliverTextFactory,
  createTurnSettler,
  reconcileStreamer,
  isCoveredByDelivered,
  resolveStreamPreviewEnabled,
};

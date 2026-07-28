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

const { getTopicConfig } = require('../session-key');

/**
 * Per-chat opt-in for the CLI `stream` tool, resolved with polygram's standard
 * override precedence (topic → chat → active bot → defaults), matching
 * resolveRichTextEnabled. Default OFF: registering the tool changes what the
 * agent is taught to do, so it rolls out per chat rather than fleet-wide.
 */
function resolveStreamPreviewEnabled(config, chatId, threadId = null) {
  if (!config) return false;
  const chat = config.chats?.[String(chatId)] || null;
  const topicCfg = (chat && threadId != null) ? getTopicConfig(chat, String(threadId)) : null;
  const pick = (v) => (typeof v === 'boolean' ? v : undefined);
  const resolved = pick(topicCfg?.streamPreview)
    ?? pick(chat?.streamPreview)
    ?? pick(config.bot?.streamPreview)
    ?? pick(config.defaults?.streamPreview);
  return resolved === true;
}

function createStreamerRegistry() {
  const bySessionKey = new Map();   // sessionKey → { streamer, chatId }

  /**
   * Register the turn's streamer. Returns a release function that removes the
   * entry ONLY if it is still the one registered here — a later turn on the
   * same session that has already taken over must not be evicted by an earlier
   * turn's cleanup.
   */
  function register(sessionKey, { streamer, chatId, deliveredTexts = [] }) {
    if (sessionKey == null || !streamer) return () => {};
    // deliveredTexts is the CALLER's array by reference: the reply path appends
    // to it here, and the turn's own reconciliation reads it from the handler's
    // closure. One list, two readers, no copy to fall out of date.
    const entry = { streamer, chatId: String(chatId), deliveredTexts };
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

  return { register, get, liveCount, get size() { return bySessionKey.size; } };
}

/**
 * Is the draft's content already in the user's hands?
 *
 * Snapshots are cumulative and the final reply normally restates the whole
 * answer, so containment (either direction, whitespace-insensitive) is the
 * honest test: if a delivered reply says everything the draft says, finalizing
 * the draft too would duplicate it.
 */
function isCoveredByDelivered(latestText, deliveredTexts) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const draft = norm(latestText);
  if (!draft) return true;   // nothing to lose
  for (const delivered of (deliveredTexts || [])) {
    const d = norm(delivered);
    if (!d) continue;
    if (d.includes(draft) || draft.includes(d)) return true;
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
 * @returns {Promise<{action: 'none'|'discarded'|'finalized'|'finalize-failed', msgId: ?number, text: ?string}>}
 */
async function reconcileStreamer(streamer, deliveredTexts = [], {
  reason = null,
  logEvent = null,
  detail = {},
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
  if (!fin.finalEditOk) {
    // The bubble already shows (a truncated form of) this text and there is no
    // redelivery path from here — deleting it would destroy the only copy the
    // user has. Leave it standing and say so.
    logEvent?.('stream-orphan-finalize-failed', {
      ...detail,
      overflow: fin.overflow === true,
      len: latest.length,
    });
    return { action: 'finalize-failed', msgId: fin.msgId ?? null, text: latest };
  }
  logEvent?.('stream-orphan-finalized', { ...detail, reason: reason || 'undelivered-draft', len: latest.length });
  return { action: 'finalized', msgId: fin.msgId ?? null, text: fin.finalText ?? latest };
}

/**
 * The reply-side half of the rule: build the `deliverText` strategy factory the
 * channels dispatcher hands to the agent-reply pipeline.
 *
 * `makeDeliverText({sessionKey, chatId, threadId, interim})` returns either a
 * strategy or null (no live-preview surface for that session → the pipeline
 * delivers normally).
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
  return function makeDeliverText({ sessionKey, chatId, interim } = {}) {
    const entry = registry.get(sessionKey);
    if (!entry) return null;              // no live-preview surface for this turn
    const { streamer } = entry;

    return async function deliverText({ text }) {
      entry.deliveredTexts.push(text);
      // Drains the pending throttled edit AND the in-flight initial send, so
      // the state and msgId read below are the real ones.
      await streamer.flushDraft();

      // An interim status is NOT the turn's answer, so it must not eat the
      // preview the answer is still being written into. It goes out as its own
      // bubble; forceNewMessage then opens the next preview BELOW it, which is
      // what keeps the visual order truthful.
      if (interim || streamer.state !== 'live') {
        streamer.forceNewMessage();
        return { handled: false };
      }

      const fin = await streamer.finalize(text);
      if (fin.streamed && fin.finalEditOk) {
        streamer.forceNewMessage();
        persistBubbleText?.(chatId, fin.msgId, fin.finalText ?? text);
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
      streamer.forceNewMessage();
      logEvent?.('stream-preview-redelivered', {
        chat_id: chatId, session_key: sessionKey,
        reason: fin.overflow ? 'overflow' : 'edit-failed',
        chars: text.length, bot: botName,
      });
      return { handled: false };
    };
  };
}

module.exports = {
  createStreamerRegistry,
  createDeliverTextFactory,
  reconcileStreamer,
  isCoveredByDelivered,
  resolveStreamPreviewEnabled,
};

/**
 * Per-session tracker for messages that received the ✍ AUTOSTEERED
 * reaction, so they can be cleared at turn-end.
 *
 * Why this exists (rc.14): each autosteer invocation runs inside its
 * own `handleMessage` scope with its own `reactor`. When the original
 * (trigger) message's reactor calls `.clear()` at turn-end, it can
 * only clear *its own* message — not the follow-ups whose reactors
 * already called `.stop()` after acking ✍. So we track the
 * (chat_id, message_id) pairs centrally per session and the success-
 * path handler in polygram.js calls `clear(sessionKey)` to drop the
 * reactions in one go.
 *
 * Concurrency: this is a plain Map indexed by sessionKey. Single-
 * thread Node, so add/get/clear race-free.
 *
 * The `applyClear` callback abstracts Telegram's setMessageReaction
 * so tests can inject a fake without spinning up grammy/bot.
 */

'use strict';

/**
 * @typedef {object} MsgRef
 * @property {number|string} chatId
 * @property {number} msgId
 */

/**
 * @typedef {object} AutosteeredRefs
 * @property {(sessionKey: string, ref: MsgRef) => void} add
 * @property {(sessionKey: string) => MsgRef[]} get
 * @property {(sessionKey: string) => Promise<number>} clear
 *   resolves with the count of refs that were cleared.
 * @property {(sessionKey: string) => number} size
 * @property {(sessionKey: string) => void} dropSession
 *   discard all refs for a session WITHOUT calling applyClear (used
 *   when the chat is being torn down — Telegram side will be cleared
 *   by the parent reactor).
 */

/**
 * @param {object} opts
 * @param {(ref: MsgRef) => Promise<void>} opts.applyClear
 *   invoked once per ref during clear(). Errors are caught and
 *   logged to opts.logger?.error — they never block clearing of
 *   subsequent refs.
 * @param {{ error?: (msg: string) => void }} [opts.logger]
 * @returns {AutosteeredRefs}
 */
function createAutosteeredRefs({ applyClear, logger = console } = {}) {
  if (typeof applyClear !== 'function') {
    throw new TypeError('applyClear function required');
  }
  /** @type {Map<string, MsgRef[]>} */
  const refs = new Map();

  function add(sessionKey, ref) {
    if (!sessionKey || !ref || ref.msgId == null || ref.chatId == null) return;
    let list = refs.get(sessionKey);
    if (!list) { list = []; refs.set(sessionKey, list); }
    list.push({ chatId: ref.chatId, msgId: ref.msgId });
  }

  function get(sessionKey) {
    return refs.get(sessionKey)?.slice() || [];
  }

  function size(sessionKey) {
    return refs.get(sessionKey)?.length || 0;
  }

  function dropSession(sessionKey) {
    refs.delete(sessionKey);
  }

  async function clear(sessionKey) {
    const list = refs.get(sessionKey);
    if (!list || list.length === 0) return 0;
    refs.delete(sessionKey);
    let cleared = 0;
    for (const ref of list) {
      try {
        await applyClear(ref);
        cleared += 1;
      } catch (err) {
        // Ack-clear failures are silent — the ✍ stays on screen but
        // doesn't block the in-flight turn's reply UX.
        logger?.error?.(
          `autosteer-clear failed (chat=${ref.chatId} msg=${ref.msgId}): ${err?.message || err}`,
        );
      }
    }
    return cleared;
  }

  return { add, get, clear, size, dropSession };
}

module.exports = { createAutosteeredRefs };

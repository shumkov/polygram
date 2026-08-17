'use strict';

/**
 * redeliverAsFreshTurn — the ONE redelivery tail (0.13 D4,
 * docs/0.13-channels-lifecycle-design.md §3 D4+D5).
 *
 * Pre-0.13, "re-dispatch a message as a fresh turn" existed in five shapes
 * (seam S10) — boot-replay, edit-redelivery, startup-auto-retry, auto-resume,
 * compact-replay — each with different gating, one-shot, ack, and tagging
 * semantics. This module is the shared tail every re-dispatch converges on:
 *
 *   1. once-only per (chatId, msgId) for the daemon lifetime — duplicates are
 *      the double-answer failure mode, hard-capped here (FIFO-bounded set);
 *   2. `_isReplay` tag — no new editable row, excluded from boot replay,
 *      error replies suppressed (the boot-replay contract, generalized);
 *   3. gate at tier 'redelivery' (D5) — abort/admin-shaped content is
 *      EVALUATED but never auto-re-executed (logged `input-dropped-no-redeliver`);
 *      skippable for same-process retries whose object already passed the
 *      full fresh gate this boot (startup-auto-retry);
 *   4. optional one-shot DB pre-mark (the boot-replay 'replay-attempted'
 *      pattern: even if THIS attempt dies mid-turn, the next boot won't loop);
 *   5. ack reaction (👀) — a re-dispatch must never be silent (rc.33 lesson);
 *      callers may suppress for deliberately-silent retries;
 *   6. dispatchHandleMessage — the normal turn path.
 *
 * Callers (P2): boot-replay. Callers (P3): the InputLedger drop-redeliverer.
 * Deliberately NOT callers: edit-redelivery (edits are legitimately repeatable
 * per message — this module's once-only is drop/replay semantics; edits share
 * the D5 gate upstream instead), startup-auto-retry (its error path must
 * SURFACE the friendly reset reply, which the _isReplay tag would suppress;
 * its msg object already passed the full fresh gate this boot), compact-replay
 * (a system re-push of the operator's own recorded command — outside the
 * user-message gate by design, §6.7), and auto-resume (a continuation of a
 * live turn, not a redelivery).
 */

const REDELIVERED_CAP = 256;

function createRedeliver({
  gateInbound,
  dispatchHandleMessage,
  getSessionKey,
  config,
  db = null,
  dbWrite = (fn) => fn(),
  setInboundHandlerStatus = null,   // override for tests; defaults to db.setInboundHandlerStatus
  react = null,
  bot,
  logEvent = () => {},
  logger = console,
} = {}) {
  if (typeof dispatchHandleMessage !== 'function') throw new TypeError('redeliver: dispatchHandleMessage required');
  if (typeof getSessionKey !== 'function') throw new TypeError('redeliver: getSessionKey required');

  const redelivered = new Set();   // `${chatId}:${msgId}` — once-only, FIFO-bounded
  const redeliveredOrder = [];

  /**
   * @param {object} opts
   * @param {string} opts.chatId
   * @param {object} opts.msg       — grammy-shaped message (fresh, reconstructed, or synthetic)
   * @param {string} opts.source    — 'boot-replay' | 'edit' | 'drop' | 'startup-retry' (telemetry)
   * @param {string|null} [opts.preMark]  — handler_status to pre-mark (one-shot guard), e.g. 'replay-attempted'
   * @param {boolean} [opts.gate=true]    — run the D5 gate at tier 'redelivery'
   * @param {boolean} [opts.ack=true]     — 👀 on the redelivered message
   * @param {Function|null} [opts.prepareDispatch] — post-gate durable setup
   *   returning private context for the normal dispatcher
   * @param {Function|null} [opts.onGateBlocked] — terminalize a blocked replay
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  return async function redeliverAsFreshTurn({
    chatId,
    msg,
    source,
    preMark = null,
    gate = true,
    ack = true,
    prepareDispatch = null,
    onGateBlocked = null,
  } = {}) {
    if (!msg || !msg.chat || msg.message_id == null) return { ok: false, reason: 'malformed message' };
    const chatConfig = config.chats[String(chatId)];
    if (!chatConfig) return { ok: false, reason: 'unconfigured chat' };

    const key = `${chatId}:${msg.message_id}`;
    if (redelivered.has(key)) {
      logEvent('redeliver-suppressed-duplicate', { chat_id: chatId, msg_id: msg.message_id, source });
      return { ok: false, reason: 'already-redelivered' };
    }
    redelivered.add(key);
    redeliveredOrder.push(key);
    while (redeliveredOrder.length > REDELIVERED_CAP) redelivered.delete(redeliveredOrder.shift());

    msg._isReplay = true;

    // Pre-mark BEFORE the gate: the one-shot DB guard must hold even when the
    // gate blocks the content — otherwise a blocked row (abort/admin-shaped)
    // would stay replay-eligible and re-block on every subsequent boot.
    if (preMark) {
      const mark = setInboundHandlerStatus || ((args) => db?.setInboundHandlerStatus?.(args));
      dbWrite(
        () => mark({ chat_id: chatId, msg_id: msg.message_id, status: preMark }),
        `set handler_status=${preMark}`,
      );
    }

    if (gate) {
      if (typeof gateInbound !== 'function') return { ok: false, reason: 'gate unavailable' };
      const res = await gateInbound(msg, { tier: 'redelivery' });
      if (res.action !== 'pass') {
        logEvent('input-dropped-no-redeliver', {
          chat_id: chatId, msg_id: msg.message_id, source, stage: res.stage ?? null,
        });
        if (typeof onGateBlocked === 'function') {
          await onGateBlocked({
            chatId,
            msg,
            source,
            stage: res.stage ?? null,
            action: res.action,
          });
        }
        return {
          ok: false,
          reason: res.stage || res.action,
          ...(typeof onGateBlocked === 'function' ? { terminal: true } : {}),
        };
      }
    }

    const threadId = msg.message_thread_id?.toString();
    const sessionKey = getSessionKey(String(chatId), threadId, chatConfig);
    const dispatchContext = typeof prepareDispatch === 'function'
      ? await prepareDispatch({ chatId, msg, source, sessionKey })
      : null;
    if (ack) {
      try { react?.(chatId, msg.message_id); } catch { /* best-effort — never blocks */ }
    }
    logEvent('redelivered-as-fresh-turn', {
      chat_id: chatId, msg_id: msg.message_id, source, session_key: sessionKey,
    });
    const task = dispatchHandleMessage(
      sessionKey,
      String(chatId),
      msg,
      bot,
      dispatchContext,
    );
    return { ok: true, task };
  };
}

module.exports = { createRedeliver };

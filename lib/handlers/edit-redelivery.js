'use strict';

/**
 * Post-turn edit re-delivery. When the user edits a Telegram message after a
 * turn has finished, re-dispatch the edited message as a new turn so the model
 * acts on the change — the "an edit is just a message" model.
 *
 * Claude retains its per-message mid-turn injection behavior. Codex edits are
 * deferred and dispatched as normal visible turns only when the exact process
 * generation that observed them becomes idle. Teardown or replacement cancels
 * the deferred content.
 *
 * Spec: docs/0.12.0-edit-redelivery-spec.md (twice-reviewed). Key correctness points the review
 * surfaced:
 *   - Convey the change via reply_to carrying the OLD text (the caller captures it before
 *     recordInbound overwrites the row) — replying to the live row would quote the NEW text, so
 *     claude would see no before/after and couldn't tell it's an edit.
 *   - GATE on the REAL edited message, NOT the synthetic: a self-reply_to trips shouldHandle's
 *     `repliesToOtherUser` and drops paired users in mention-gated groups.
 *   - The synthetic is `_isReplay`-tagged → no new editable row, never replay-eligible, error
 *     reply suppressed.
 *   - A re-edit while our re-run is in flight FOLDS via inject (the interlock) rather than
 *     starting a second turn.
 *
 * @param {object} deps
 * @param {object} deps.pm                    ProcessManager (get(sessionKey).inFlight, injectUserMessage)
 * @param {object} deps.config
 * @param {Function} deps.getSessionKey       (chatId, threadId, chatConfig) => sessionKey
 * @param {Function} deps.shouldHandle        (msg, chatConfig, botUsername) => boolean — the real gate
 * @param {Function} deps.dispatchHandleMessage (sessionKey, chatId, msg, bot) => void
 * @param {object} deps.bot
 * @param {Function} [deps.react]             (chatId, msgId) => void|Promise — on-edit acknowledgment
 * @param {Function} [deps.logEvent]
 * @param {object} [deps.logger]
 * @returns {(editedMsg, oldText, botUsername, mentionRe?) => boolean} true when a fresh turn was
 *   dispatched. botUsername / mentionRe are passed at CALL time (not construction): they are
 *   resolved asynchronously via getMe and live in the createBot scope, so capturing them in the
 *   factory (built in main()) would both be out of scope and freeze the empty initial values.
 */
function createEditRedelivery({
  pm, config, getSessionKey, shouldHandle, dispatchHandleMessage, bot,
  react, logEvent = () => {}, logger = console,
} = {}) {
  // botUsername / mentionRe arrive at CALL time — see @returns. Constructing with them threw
  // `ReferenceError: mentionRe is not defined` at boot (rc.34): the factory runs in main() where
  // those createBot locals don't exist. The edited_message handler passes the live values.
  //
  // 0.13 D5 (spec §5 as written): the in-flight interlock is per-(chatId,msgId),
  // not per-session. A re-edit of the SAME message while its re-dispatch runs
  // folds via inject; an edit of a DIFFERENT message proceeds as its own
  // redelivery (dispatchHandleMessage autosteers it naturally if a turn is in
  // flight — through the formatted-prompt path, not a hand-built string).
  const redeliveredAt = new Map();   // `${chatId}:${msgId}` → ts
  const deferredCodexBySession = new Map();
  const INTERLOCK_TTL_MS = 10 * 60 * 1000;

  function codexGenerationId(proc) {
    return typeof proc?.generationId === 'string' && proc.generationId.length > 0
      ? proc.generationId
      : null;
  }

  function isCodexProcess(sessionKey, proc) {
    const backend = typeof pm?.getBackend === 'function'
      ? pm.getBackend(sessionKey)
      : proc?.backend ?? proc?.runtime;
    return backend === 'codex' || proc?.backend === 'codex' || proc?.runtime === 'codex';
  }

  function removeDeferredListeners(state) {
    state.proc.removeListener?.('idle', state.onIdle);
    state.proc.removeListener?.('close', state.onClose);
    state.proc.removeListener?.('session-reset', state.onSessionReset);
    state.proc.removeListener?.('codex-settled', state.onCodexSettled);
    state.proc.removeListener?.('codex-lifecycle', state.onCodexLifecycle);
  }

  function safeLogDeferredEvent(kind, detail) {
    try {
      logEvent(kind, detail);
    } catch (error) {
      try {
        logger.error?.(`[edit-redelivery] deferred event log failed: ${error.message}`);
      } catch {
        // Process lifecycle listeners must never throw back into supervision.
      }
    }
  }

  function cancelDeferred(state, reason) {
    if (deferredCodexBySession.get(state.sessionKey) !== state) return;
    deferredCodexBySession.delete(state.sessionKey);
    removeDeferredListeners(state);
    safeLogDeferredEvent('edit-redelivery-deferred-cancelled', {
      session_key: state.sessionKey,
      generation_id: state.generationId,
      reason,
      message_count: state.entries.size,
    });
  }

  function dispatchDeferredSynthetic({
    sessionKey,
    chatId,
    msgId,
    synthetic,
    oldLength,
    newLength,
  }) {
    dispatchHandleMessage(sessionKey, chatId, synthetic, bot);
    safeLogDeferredEvent('edit-redelivered', {
      chat_id: chatId,
      session_key: sessionKey,
      msg_id: msgId,
      old_len: oldLength,
      new_len: newLength,
    });
  }

  function flushDeferred(state) {
    if (deferredCodexBySession.get(state.sessionKey) !== state) return;
    const current = pm?.get?.(state.sessionKey);
    if (
      current !== state.proc
      || codexGenerationId(current) !== state.generationId
    ) {
      cancelDeferred(state, 'generation-replaced');
      return;
    }
    if (current.closed) {
      cancelDeferred(state, 'close');
      return;
    }
    // An idle-shaped event is not enough: process state is the final fence
    // against dispatching while the generation still owns a live turn.
    if (current.inFlight) return;

    deferredCodexBySession.delete(state.sessionKey);
    removeDeferredListeners(state);
    for (const entry of state.entries.values()) {
      try {
        dispatchDeferredSynthetic(entry);
      } catch (error) {
        try {
          logger.error?.(`[edit-redelivery] deferred dispatch failed: ${error.message}`);
        } catch {
          // Process lifecycle listeners must never throw back into supervision.
        }
        safeLogDeferredEvent('edit-redelivery-deferred-cancelled', {
          session_key: state.sessionKey,
          generation_id: state.generationId,
          reason: 'dispatch-failed',
          message_count: 1,
          msg_id: entry.msgId,
        });
      }
    }
  }

  function deferCodexEdit(entry, proc) {
    const generationId = codexGenerationId(proc);
    if (!generationId) {
      safeLogDeferredEvent('edit-redelivery-deferred-cancelled', {
        session_key: entry.sessionKey,
        generation_id: null,
        reason: 'missing-generation-id',
        message_count: 1,
        msg_id: entry.msgId,
      });
      return false;
    }
    if (
      typeof proc.on !== 'function'
      || typeof proc.removeListener !== 'function'
    ) {
      safeLogDeferredEvent('edit-redelivery-deferred-cancelled', {
        session_key: entry.sessionKey,
        generation_id: generationId,
        reason: 'event-interface-unavailable',
        message_count: 1,
        msg_id: entry.msgId,
      });
      return false;
    }

    let state = deferredCodexBySession.get(entry.sessionKey);
    if (
      state
      && (
        state.proc !== proc
        || state.generationId !== generationId
      )
    ) {
      cancelDeferred(state, 'generation-replaced');
      state = null;
    }
    if (!state) {
      state = {
        sessionKey: entry.sessionKey,
        generationId,
        proc,
        entries: new Map(),
      };
      state.onIdle = () => flushDeferred(state);
      state.onClose = () => cancelDeferred(state, 'close');
      state.onSessionReset = () => cancelDeferred(state, 'session-reset');
      state.onCodexSettled = (event) => {
        if (event?.kind === 'stopped') cancelDeferred(state, 'stop');
      };
      state.onCodexLifecycle = () => cancelDeferred(state, 'lifecycle-failed');
      deferredCodexBySession.set(entry.sessionKey, state);
      proc.on('idle', state.onIdle);
      proc.on('close', state.onClose);
      proc.on('session-reset', state.onSessionReset);
      proc.on('codex-settled', state.onCodexSettled);
      proc.on('codex-lifecycle', state.onCodexLifecycle);
    }

    const interlockKey = `${entry.chatId}:${entry.msgId}`;
    const coalesced = state.entries.has(interlockKey);
    // Map#set replaces the value without changing insertion order.
    state.entries.set(interlockKey, entry);
    safeLogDeferredEvent('edit-redelivery-deferred', {
      chat_id: entry.chatId,
      session_key: entry.sessionKey,
      generation_id: generationId,
      msg_id: entry.msgId,
      coalesced,
    });
    // Close the check→listener registration race. If the turn settled (or the
    // process was replaced) while the edit was being gated, release or cancel
    // through the same generation-fenced path immediately.
    if (
      pm?.get?.(entry.sessionKey) !== proc
      || proc.closed
      || !proc.inFlight
    ) {
      flushDeferred(state);
    }
    return true;
  }

  return function maybePostTurnEdit(editedMsg, oldText, botUsername, mentionRe = null) {
  try {
    if (!editedMsg?.chat) return false;
    const chatId = editedMsg.chat.id.toString();
    const chatConfig = config.chats[chatId];
    if (!chatConfig) return false;

    // Per-chat / bot-level opt-out (shared with the mid-turn injector). Default on.
    const optOut = chatConfig.editCorrection != null
      ? chatConfig.editCorrection === false
      : config.bot?.editCorrection === false;
    if (optOut) return false;

    const newText = editedMsg.text || editedMsg.caption || '';
    if (!newText) return false;                              // blanked / media-only → nothing to act on
    // Changed-guard: skip metadata-only edits (link-preview load fires edited_message too). The
    // caller MUST have read oldText before recordInbound overwrote the row; null = unknown → proceed.
    if (oldText != null && oldText === newText) return false;

    const threadId = editedMsg.message_thread_id?.toString() || null;
    const sessionKey = getSessionKey(chatId, threadId, chatConfig);

    // Interlock (per-message, 0.13 D5): only a re-edit of a message whose OWN
    // re-dispatch is still running folds via inject — pre-0.13 this was
    // per-session (any in-flight turn folded any edit, and it injected
    // BEFORE the gate; the gate now runs upstream in the edited_message
    // handler, so every path through here is already gated).
    const proc = pm?.get?.(sessionKey);
    if (proc?.inFlight && isCodexProcess(sessionKey, proc)) {
      // Re-run the real-message gate before retaining content in memory. The
      // outer edited-message path already gates today, but this handler keeps
      // its own contract when reused independently.
      if (!shouldHandle(editedMsg, chatConfig, botUsername)) return false;
      const cleanNew = mentionRe ? newText.replace(mentionRe, '').trim() : newText.trim();
      const synthetic = {
        chat: editedMsg.chat,
        message_id: editedMsg.message_id,
        from: editedMsg.from,
        text: cleanNew,
        date: editedMsg.date,
        ...(threadId && { message_thread_id: Number(threadId) }),
        reply_to_message: {
          message_id: editedMsg.message_id,
          from: editedMsg.from,
          text: oldText || '',
          date: editedMsg.date,
        },
        _isReplay: true,
        _requiredProvider: 'codex',
      };
      const deferred = deferCodexEdit({
        sessionKey,
        chatId,
        msgId: editedMsg.message_id,
        synthetic,
        oldLength: (oldText || '').length,
        newLength: newText.length,
      }, proc);
      if (!deferred) return false;
      try { react?.(chatId, editedMsg.message_id); } catch { /* best-effort */ }
      return false;
    }

    const interlockKey = `${chatId}:${editedMsg.message_id}`;
    const lastRedeliveredAt = redeliveredAt.get(interlockKey) || 0;
    if (proc?.inFlight && (Date.now() - lastRedeliveredAt) < INTERLOCK_TTL_MS && lastRedeliveredAt > 0) {
      pm.injectUserMessage?.(sessionKey, {
        content: `[edit] I edited my message again — it now reads: ${newText}`,
        priority: 'next',
        msgId: editedMsg.message_id,
        source: 'edit-fold',   // 0.13 D2
      });
      logEvent('edit-redelivery-folded', { chat_id: chatId, session_key: sessionKey, msg_id: editedMsg.message_id });
      return false;
    }

    // GATE on the REAL edited message (its real from / new text / its own real reply_to, if any).
    // NOT the synthetic — a self-reply_to would trip shouldHandle.repliesToOtherUser and drop a
    // paired user editing an un-mentioned message in a mention-gated group.
    if (!shouldHandle(editedMsg, chatConfig, botUsername)) return false;

    // Acknowledge immediately: a silent edit produces no new bubble, so show it registered before
    // claude's reply lands (the rc.33 lesson). Best-effort; never blocks the re-dispatch.
    try { react?.(chatId, editedMsg.message_id); } catch { /* best-effort */ }

    // Synthetic turn: NEW text in the body, OLD text in the reply_to so claude sees the change.
    // reply_to_message carries `from` + `text` so resolveReplyTo takes the telegram branch and
    // renders the OLD text — NOT db.getMessage (which now holds the overwritten new text).
    const cleanNew = mentionRe ? newText.replace(mentionRe, '').trim() : newText.trim();
    const synthetic = {
      chat: editedMsg.chat,
      message_id: editedMsg.message_id,
      from: editedMsg.from,
      text: cleanNew,
      date: editedMsg.date,
      ...(threadId && { message_thread_id: Number(threadId) }),
      reply_to_message: {
        message_id: editedMsg.message_id,
        from: editedMsg.from,
        text: oldText || '',
        date: editedMsg.date,
      },
      _isReplay: true,   // no new editable row, not replay-eligible, error reply suppressed
    };
    redeliveredAt.set(interlockKey, Date.now());
    dispatchHandleMessage(sessionKey, chatId, synthetic, bot);
    logEvent('edit-redelivered', {
      chat_id: chatId, session_key: sessionKey, msg_id: editedMsg.message_id,
      old_len: (oldText || '').length, new_len: newText.length,
    });
    return true;
  } catch (e) {
    // Never throw out of the edited_message handler.
    logger.error?.(`[edit-redelivery] ${e.message}`);
    return false;
  }
};
}

module.exports = { createEditRedelivery };

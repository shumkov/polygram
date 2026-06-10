'use strict';

/**
 * Post-turn edit re-delivery (0.12.0). When the user edits a Telegram message AFTER claude's turn
 * has finished, re-dispatch the edited message as a NEW turn so claude acts on the change — the
 * "an edit is just a message" model. The mid-turn case (turn still in flight) stays with the
 * existing injector (lib/handlers/edit-correction.js); this is the post-turn path.
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

      // Interlock: a turn is in flight (most likely OUR own re-run, whose _isReplay row reads
      // not-live so the mid-turn injector skipped it and fell through to here). Fold the re-edit
      // via inject instead of spawning a SECOND re-dispatch turn for the same message.
      const proc = pm?.get?.(sessionKey);
      if (proc?.inFlight) {
        pm.injectUserMessage?.(sessionKey, {
          content: `[edit] I edited my message again — it now reads: ${newText}`,
          priority: 'next',
          msgId: editedMsg.message_id,
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

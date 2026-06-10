'use strict';

/**
 * Edit-correction injector.
 *
 * When the user edits a Telegram message that's still being processed
 * by the SDK turn loop, inject a correction note into the active turn
 * via the same hook channel autosteer uses (pm.injectUserMessage,
 * priority: 'next'). Lets users fix typos mid-turn without /stop +
 * resend.
 *
 * Skipped when the turn already finished — at that point the
 * conversation has moved on and re-opening it would confuse Claude
 * more than help. Also skipped when the SDK session has been
 * LRU-evicted (no live target to inject into).
 *
 * Architectural note: there's no polygram-side "buffer" to replace.
 * pm.send and pm.injectUserMessage push the message text directly into
 * the SDK's inputController AsyncIterable; once pushed, polygram has
 * no way to retract it. So edit handling is always "inject correction
 * note as additional context" — Claude reconciles.
 */

function createEditCorrectionInjector({
  pm,
  db,
  getSessionKey,
  config,
  logEvent,
  logger = console,
} = {}) {

  return function maybeInjectEditCorrection(editedMsg) {
    if (!editedMsg?.chat) return false;
    const chatId = editedMsg.chat.id.toString();
    const chatConfig = config.chats[chatId];
    if (!chatConfig) return false;

    // Per-chat / bot-level opt-out. Default on.
    const optOut = chatConfig.editCorrection != null
      ? chatConfig.editCorrection === false
      : config.bot?.editCorrection === false;
    if (optOut) return false;

    const threadIdStr = editedMsg.message_thread_id?.toString() || null;
    const sessionKey = getSessionKey(chatId, threadIdStr, chatConfig);

    // Three skip gates — all must be true for an injection:
    //   1. SDK session exists (not LRU-evicted)
    //   2. session has a turn in flight
    //   3. the edited msg is still in the dispatched/processing pipeline
    if (!pm.has(sessionKey)) return false;
    if (!pm.get(sessionKey)?.inFlight) return false;
    if (!db.isInboundLive({ chat_id: chatId, msg_id: editedMsg.message_id })) return false;

    const newText = editedMsg.text || editedMsg.caption || '';
    if (!newText) return false;

    const ok = pm.injectUserMessage(sessionKey, {
      content: `[edit] I corrected my previous message — it now reads: ${newText}`,
      priority: 'next',
      msgId: editedMsg.message_id,
      source: 'edit-fold',   // 0.13 D2: ledgered (telemetry; edits have their own redelivery path)
    });
    if (!ok) {
      logger.error?.(`[${chatConfig.name || chatId}] edit-correction inject failed`);
      return false;
    }
    logEvent('message-edit-injected', {
      chat_id: chatId,
      msg_id: editedMsg.message_id,
      session_key: sessionKey,
      text_len: newText.length,
    });
    return true;
  };
}

module.exports = { createEditCorrectionInjector };

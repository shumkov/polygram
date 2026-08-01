'use strict';

const PRIMARY_BLOCKING_CODEX_DECISIONS = new Set([
  'duplicate',
  'ambiguous',
  'unavailable',
]);

/**
 * Complete ownership of a follow-up that the Claude injection path accepted.
 *
 * Codex acceptance is deliberately a no-op here: its linked target turn and
 * Telegram delivery checkpoint own the eventual terminal status.
 */
function settleAcceptedAutosteerOwnership({
  selectedProvider,
  steered,
  db,
  chatId,
  msgId,
  sessionKey,
  logLabel = sessionKey,
  logEvent = () => {},
  logger = console,
} = {}) {
  if (selectedProvider !== 'claude' || steered?.autosteered !== true) {
    return steered;
  }

  try {
    db.completeAcceptedClaudeAutosteer({
      chat_id: chatId,
      msg_id: msgId,
    });
    return steered;
  } catch (error) {
    const errorCode = error?.code || error?.name || 'unknown';
    logger.error(
      `[${logLabel}] accepted Claude follow-up persistence failed: ${errorCode}`,
    );
    logEvent('autosteer-handler-status-failed', {
      chat_id: chatId,
      msg_id: msgId,
      session_key: sessionKey,
      code: errorCode,
    });
    return {
      ...steered,
      autosteered: false,
      outcome: 'accepted-persistence-ambiguous',
      errorCode,
    };
  }
}

function shouldDispatchPrimaryAfterAutosteer({
  steered,
  codexDispatchDecision = null,
} = {}) {
  return (
    steered?.autosteered !== true
    && steered?.outcome !== 'accepted-persistence-ambiguous'
    && !PRIMARY_BLOCKING_CODEX_DECISIONS.has(codexDispatchDecision)
  );
}

module.exports = {
  settleAcceptedAutosteerOwnership,
  shouldDispatchPrimaryAfterAutosteer,
};

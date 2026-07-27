'use strict';

const {
  resolveProviderSessionForSpawn,
} = require('../db/sessions');

async function buildCodexSpawnContext({
  sessionKey,
  chatId,
  threadId,
  chatConfig,
  db,
  pm,
  runtimeController,
  getSessionLabel,
  logEvent,
}) {
  const prepared = await runtimeController.prepareSession({
    sessionKey,
    chatId,
    threadId,
  });
  const runtime = prepared.runtimeConfig;
  let liveProcess = pm?.get(sessionKey) ?? null;
  const replacementReason = (
    liveProcess
    && !liveProcess.closed
  ) ? runtimeController.processReplacementReason(
      sessionKey,
      liveProcess,
    ) : null;
  if (replacementReason) {
    logEvent('codex-runtime-state-replacement', {
      chat_id: chatId,
      thread_id: threadId,
      session_key: sessionKey,
      generation_id: liveProcess.generationId,
      reason: replacementReason,
    });
    await pm.kill(sessionKey, replacementReason);
    liveProcess = null;
  }

  const isColdSpawn = !liveProcess || liveProcess.closed;
  let existingSessionId = null;
  if (isColdSpawn) {
    const resolved = resolveProviderSessionForSpawn(db, sessionKey, {
      runtime: 'codex',
      backend: 'codex',
      agent: null,
      cwd: runtime.cwd,
      model: runtime.model,
      effort: runtime.effort,
    });
    existingSessionId = resolved.existingSessionId;
    if (resolved.drift) {
      logEvent('session-config-drift', {
        chat_id: chatId,
        thread_id: threadId,
        session_key: sessionKey,
        provider: 'codex',
        fields: resolved.drift.fields,
        before: resolved.drift.before,
        after: resolved.drift.after,
      });
    }
  } else {
    existingSessionId = liveProcess.providerSessionId ?? null;
  }

  return {
    runtime: 'codex',
    spawnProfileId: runtime.spawnProfileId,
    modelSettings: {
      model: runtime.model,
      effort: runtime.effort,
    },
    chatId,
    threadId,
    label: getSessionLabel(chatConfig, threadId),
    existingSessionId,
  };
}

module.exports = {
  buildCodexSpawnContext,
};

'use strict';

const {
  resolveProviderSessionForSpawn,
} = require('../db/sessions');
const {
  processMatchesRuntime,
} = require('../runtime-config');

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
  mutateSessionOnDrift = true,
}) {
  const prepared = await runtimeController.prepareSession({
    sessionKey,
    chatId,
    threadId,
  });
  const runtime = prepared.runtimeConfig;
  let liveProcess = pm?.get(sessionKey) ?? null;
  let liveCodexProcess = processMatchesRuntime(
    liveProcess,
    'codex',
    'codex',
  );
  const replacementReason = (
    liveCodexProcess
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
    liveCodexProcess = false;
  }

  const isColdSpawn = !liveCodexProcess;
  let existingSessionId = null;
  if (isColdSpawn) {
    const resolved = resolveProviderSessionForSpawn(db, sessionKey, {
      runtime: 'codex',
      backend: 'codex',
      agent: null,
      cwd: runtime.cwd,
      model: runtime.model,
      effort: runtime.effort,
    }, { mutateOnDrift: mutateSessionOnDrift });
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

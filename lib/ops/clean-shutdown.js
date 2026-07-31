'use strict';

async function prepareCleanRetirement({
  pm,
  deliveryBarrier,
  awaitHandlerSettlement,
  settlementTimeoutMs = 30_000,
} = {}) {
  if (typeof deliveryBarrier?.fenceAndDrain !== 'function'
      || typeof deliveryBarrier?.inspect !== 'function') {
    throw new TypeError('clean shutdown requires a delivery barrier');
  }
  if (typeof pm?.retireForCleanRestart !== 'function') {
    throw new TypeError('ProcessManager.retireForCleanRestart is required');
  }
  if (typeof awaitHandlerSettlement !== 'function') {
    throw new TypeError('clean shutdown requires handler settlement');
  }

  const deliveryDrain = deliveryBarrier.fenceAndDrain();
  const processRetirement = pm.retireForCleanRestart({
    getDeliveryEvidence: (sessionKey, sourceMsgId) => (
      deliveryBarrier.inspect(sessionKey, sourceMsgId)
    ),
  });
  const [, snapshots] = await Promise.all([
    deliveryDrain,
    processRetirement,
  ]);
  await awaitHandlerSettlement({ timeoutMs: settlementTimeoutMs });
  return { snapshots: Array.isArray(snapshots) ? snapshots : [] };
}

function buildResumeIntents({
  snapshots = [],
  resolveSourceMessageId,
  policyVersion = 1,
} = {}) {
  if (typeof resolveSourceMessageId !== 'function') {
    throw new TypeError('retirement source resolver is required');
  }
  const seenSessions = new Set();
  const seenSources = new Set();
  const resumeIntents = [];
  const classified = snapshots.map((snapshot) => {
    const result = {
      ...snapshot,
      eligible: snapshot?.eligible === true,
      reason: snapshot?.reason ?? null,
    };
    if (!result.eligible) return result;
    const codex = result.runtime === 'codex'
      || result.namespace === 'codex:app-server';
    if (
      codex
      && (
        result.runtime !== 'codex'
        || result.namespace !== 'codex:app-server'
        || typeof result.providerSessionId !== 'string'
        || result.providerSessionId.length === 0
        || typeof result.providerTurnId !== 'string'
        || result.providerTurnId.length === 0
        || typeof result.cwd !== 'string'
        || result.cwd.length === 0
        || typeof result.model !== 'string'
        || result.model.length === 0
        || typeof result.effort !== 'string'
        || result.effort.length === 0
        || typeof result.spawnProfileId !== 'string'
        || result.spawnProfileId.length === 0
        || policyVersion !== 2
      )
    ) {
      return {
        ...result,
        eligible: false,
        reason: 'codex-retirement-binding-missing',
      };
    }
    if (seenSessions.has(result.sessionKey)) {
      throw new Error(`duplicate retirement snapshot for ${result.sessionKey}`);
    }
    seenSessions.add(result.sessionKey);
    const sourceMessageId = resolveSourceMessageId(result);
    if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
      return {
        ...result,
        eligible: false,
        reason: 'source-message-missing',
      };
    }
    if (seenSources.has(sourceMessageId)) {
      throw new Error(`duplicate retirement source ${sourceMessageId}`);
    }
    seenSources.add(sourceMessageId);
    resumeIntents.push({
      sessionKey: result.sessionKey,
      sourceMessageId,
      policyVersion,
      ...(codex ? {
        interruptedProviderTurnId: result.providerTurnId,
        interruptedSpawnProfileId: result.spawnProfileId,
        expectedProviderSessionId: result.providerSessionId,
        expectedCwd: result.cwd,
        expectedModel: result.model,
        expectedEffort: result.effort,
      } : {}),
    });
    return {
      ...result,
      sourceMessageId,
    };
  });
  return { resumeIntents, snapshots: classified };
}

module.exports = {
  prepareCleanRetirement,
  buildResumeIntents,
};

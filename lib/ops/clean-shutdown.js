'use strict';

async function prepareCleanRetirement({
  pm,
  deliveryBarrier,
  awaitIngressSettlement,
  awaitHandlerSettlement,
  settlementTimeoutMs = 30_000,
  qualificationExpectation,
} = {}) {
  if (typeof deliveryBarrier?.fenceAndDrain !== 'function'
      || typeof deliveryBarrier?.inspect !== 'function') {
    throw new TypeError('clean shutdown requires a delivery barrier');
  }
  if (typeof pm?.retireForCleanRestart !== 'function') {
    throw new TypeError('ProcessManager.retireForCleanRestart is required');
  }
  if (typeof awaitIngressSettlement !== 'function') {
    throw new TypeError('clean shutdown requires ingress settlement');
  }
  if (typeof awaitHandlerSettlement !== 'function') {
    throw new TypeError('clean shutdown requires handler settlement');
  }

  const deliveryDrain = captureSettlement(() => deliveryBarrier.fenceAndDrain());
  const processRetirement = captureSettlement(() => pm.retireForCleanRestart({
    getDeliveryEvidence: (sessionKey, sourceMsgId) => (
      deliveryBarrier.inspect(sessionKey, sourceMsgId)
    ),
    ...(qualificationExpectation !== undefined
      ? { qualificationExpectation }
      : {}),
  }));
  const [deliveryResult, retirementResult] = await Promise.allSettled([
    deliveryDrain,
    processRetirement,
  ]);

  let fallbackResult = null;
  if (retirementResult.status === 'rejected') {
    fallbackResult = await settleOne(() => {
      if (typeof pm?.shutdown !== 'function') {
        throw new TypeError('ProcessManager.shutdown fallback is required');
      }
      return pm.shutdown();
    });
  }

  const ingressResult = await settleOne(() => (
    awaitIngressSettlement({ timeoutMs: settlementTimeoutMs })
  ));
  const handlerResult = await settleOne(() => (
    awaitHandlerSettlement({ timeoutMs: settlementTimeoutMs })
  ));

  throwFirstRejected([
    retirementResult,
    deliveryResult,
    fallbackResult,
    ingressResult,
    handlerResult,
  ]);
  const snapshots = retirementResult.value;
  const normalizedSnapshots = Array.isArray(snapshots) ? snapshots : [];
  return {
    snapshots: normalizedSnapshots,
    qualification: Object.hasOwn(normalizedSnapshots, 'qualification')
      ? normalizedSnapshots.qualification
      : null,
  };
}

async function settleCrashShutdown({
  pm,
  deliveryBarrier,
  awaitIngressSettlement,
  awaitHandlerSettlement,
  settlementTimeoutMs = 30_000,
} = {}) {
  if (typeof deliveryBarrier?.fenceAndDrain !== 'function') {
    throw new TypeError('crash shutdown requires a delivery barrier');
  }
  if (typeof pm?.shutdown !== 'function') {
    throw new TypeError('ProcessManager.shutdown is required');
  }
  if (typeof awaitIngressSettlement !== 'function') {
    throw new TypeError('crash shutdown requires ingress settlement');
  }
  if (typeof awaitHandlerSettlement !== 'function') {
    throw new TypeError('crash shutdown requires handler settlement');
  }

  const deliveryDrain = captureSettlement(() => deliveryBarrier.fenceAndDrain());
  const processShutdown = captureSettlement(() => pm.shutdown());
  const [deliveryResult, shutdownResult] = await Promise.allSettled([
    deliveryDrain,
    processShutdown,
  ]);
  const ingressResult = await settleOne(() => (
    awaitIngressSettlement({ timeoutMs: settlementTimeoutMs })
  ));
  const handlerResult = await settleOne(() => (
    awaitHandlerSettlement({ timeoutMs: settlementTimeoutMs })
  ));

  throwFirstRejected([
    shutdownResult,
    deliveryResult,
    ingressResult,
    handlerResult,
  ]);
}

function captureSettlement(operation) {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function settleOne(operation) {
  const [result] = await Promise.allSettled([captureSettlement(operation)]);
  return result;
}

function throwFirstRejected(results) {
  const rejected = results.find((result) => result?.status === 'rejected');
  if (rejected) throw rejected.reason;
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
  settleCrashShutdown,
  buildResumeIntents,
};

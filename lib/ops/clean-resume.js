'use strict';

const CLAUDE_NAMESPACE = 'claude:channels';
const CODEX_NAMESPACE = 'codex:app-server';
const CLEAN_RESUME_POLICY_VERSION = 2;
const SUPPORTED_CLEAN_RESUME_POLICY_VERSIONS = Object.freeze([1, 2]);

function recoveryNoticeText({ ambiguous = false } = {}) {
  if (ambiguous) {
    return '↺ Restart recovery could not confirm whether the answer was delivered. I will not retry it automatically; send the message again if you still need a reply.';
  }
  return '↺ Restarted — I couldn\'t safely resume this message. If it still needs a reply, send it again.';
}

function isCodexClaim(claim) {
  return claim?.interrupted_provider_turn_id != null
    || claim?.interrupted_spawn_profile_id != null
    || claim?.provider_namespace === CODEX_NAMESPACE;
}

function attestsExactResume(attestation, expectedSessionId, claim = null) {
  const codex = isCodexClaim(claim);
  return attestation?.namespace === (codex ? CODEX_NAMESPACE : CLAUDE_NAMESPACE)
    && attestation.sessionId === expectedSessionId
    && attestation.resumed === true
    && attestation.freshFallback === false
    && (!codex || (
      attestation.interruptedTurnId
        === claim.interrupted_provider_turn_id
      && attestation.idle === true
    ));
}

function validateStrictResumeSpawn({
  strictResume,
  promptBackend,
  liveProcess,
  runtime,
  resolved,
} = {}) {
  if (liveProcess && !liveProcess.closed) {
    const error = new Error('strict clean resume requires an unspawned session');
    error.code = 'CLEAN_RESUME_SESSION_ALREADY_SPAWNED';
    throw error;
  }

  if (promptBackend === 'codex') {
    const providerDrift = runtime?.namespace !== CODEX_NAMESPACE
      || resolved?.runtime !== 'codex'
      || resolved?.backend !== 'codex';
    const driftFields = [
      ['cwd', 'cwd'],
      ['model', 'model'],
      ['effort', 'effort'],
      ['spawn_profile_id', 'spawnProfileId'],
    ].filter(([stored, current]) => (
      (runtime?.[stored] || null) !== (resolved?.[current] || null)
    ));
    if (
      !runtime
      || runtime.namespace !== CODEX_NAMESPACE
      || runtime.generation_id !== strictResume?.expectedGenerationId
      || runtime.provider_session_id !== strictResume?.expectedSessionId
      || runtime.spawn_profile_id !== strictResume?.expectedSpawnProfileId
      || resolved?.runtime !== 'codex'
      || resolved?.backend !== 'codex'
      || driftFields.length > 0
    ) {
      const error = new Error(
        'strict Codex resume session identity or config changed',
      );
      error.code = providerDrift || driftFields.length > 0
        ? 'CLEAN_RESUME_CONFIG_DRIFT'
        : 'CLEAN_RESUME_SESSION_CHANGED';
      throw error;
    }
    return strictResume.expectedSessionId;
  }

  const driftFields = ['agent', 'cwd'].filter(
    (field) => (runtime?.[field] || null) !== (resolved?.[field] || null),
  );
  if (
    !runtime
    || runtime.generation_id !== strictResume?.expectedGenerationId
    || runtime.provider_session_id !== strictResume?.expectedSessionId
    || !['cli', 'channels'].includes(runtime.pm_backend)
    || !['cli', 'channels'].includes(resolved?.backend)
    || driftFields.length > 0
  ) {
    const error = new Error('strict clean resume session identity or config changed');
    error.code = driftFields.length > 0
      ? 'CLEAN_RESUME_CONFIG_DRIFT'
      : 'CLEAN_RESUME_SESSION_CHANGED';
    throw error;
  }
  return strictResume.expectedSessionId;
}

function createCleanResumeTurnContext({ sourceMsgId, threadId = null } = {}) {
  return {
    streamer: {
      onChunk: async () => {},
      forceNewMessage: () => {},
      finalize: async () => ({ streamed: false }),
      flushDraft: async () => {},
      discard: async () => {},
    },
    reactor: {
      setState: () => {},
      heartbeat: () => {},
      clear: async () => {},
      stop: () => {},
    },
    sourceMsgId,
    threadId,
    onFirstStream: () => {},
  };
}

async function executeCleanResumeClaim(claim, {
  enabled = false,
  loadSource,
  sessionKeyForSource,
  loadRuntimeSession,
  resolveStrictSpawnContext,
  strictSpawn,
  discardSpawn,
  sendContinue,
  deliverResult,
  settleProviderDelivery,
  sendNotice,
  complete,
  logEvent = () => {},
  onReady = () => {},
} = {}) {
  let ready = false;
  const markReady = () => {
    if (ready) return;
    ready = true;
    onReady();
  };
  const eventDetail = {
    bot: claim?.bot_name ?? null,
    session_key: claim?.session_key ?? null,
    source_message_id: claim?.source_message_id ?? null,
    policy_version: claim?.policy_version ?? null,
  };
  const codex = isCodexClaim(claim);
  let continuationDispatched = false;
  const markContinuationDispatched = () => {
    if (continuationDispatched) return;
    continuationDispatched = true;
    logEvent('clean-resume-continuation-dispatched', {
      ...eventDetail,
      provider: codex ? 'codex' : 'claude',
      command_kind: 'continue',
    });
    markReady();
  };
  const source = typeof loadSource === 'function'
    ? loadSource(claim.source_message_id)
    : null;

  async function fallback(reason, { ambiguous = false } = {}) {
    markReady();
    const text = recoveryNoticeText({ ambiguous });
    await sendNotice({
      claim,
      source,
      text,
      ambiguous,
      reason,
    });
    await complete({
      sourceMessageId: claim.source_message_id,
      status: 'replay-skipped',
    });
    logEvent('clean-resume-fallback', {
      ...eventDetail,
      reason,
      ambiguous: ambiguous || undefined,
    });
    return { status: 'replay-skipped', reason };
  }

  function rejected(reason) {
    logEvent('clean-resume-rejected', {
      ...eventDetail,
      reason,
    });
    return fallback(reason);
  }

  function failed(reason, { ambiguous = false } = {}) {
    logEvent('clean-resume-failed', {
      ...eventDetail,
      reason,
      ambiguous: ambiguous || undefined,
    });
    return fallback(reason, { ambiguous });
  }

  if (!enabled) return fallback('rollout-disabled');
  if (claim?.executable !== true) {
    return fallback(claim?.reason || 'claim-not-executable');
  }
  const hasInterruptedTurn = typeof claim?.interrupted_provider_turn_id === 'string'
    && claim.interrupted_provider_turn_id.length > 0;
  const hasInterruptedProfile = typeof claim?.interrupted_spawn_profile_id === 'string'
    && claim.interrupted_spawn_profile_id.length > 0;
  if (
    codex
    && (
      claim?.policy_version !== 2
      || !hasInterruptedTurn
      || !hasInterruptedProfile
    )
  ) {
    return rejected('unsupported-codex-policy');
  }

  if (
    !source
    || source.id !== claim.source_message_id
    || source.bot_name !== claim.bot_name
    || source.handler_status !== 'resume-attempted'
    || sessionKeyForSource(source) !== claim.session_key
  ) {
    return fallback('source-message-mismatch');
  }

  const runtime = loadRuntimeSession(claim.session_key, claim);
  const expectedNamespace = codex ? CODEX_NAMESPACE : CLAUDE_NAMESPACE;
  if (
    !runtime
    || runtime.namespace !== expectedNamespace
    || runtime.generation_id !== claim.session_generation_id
    || typeof runtime.provider_session_id !== 'string'
    || runtime.provider_session_id.length === 0
    || (codex
      ? runtime.pm_backend !== 'codex'
      : !['cli', 'channels'].includes(runtime.pm_backend))
    || (codex && (
      runtime.spawn_profile_id !== claim.interrupted_spawn_profile_id
      || typeof claim.interrupted_provider_turn_id !== 'string'
      || claim.interrupted_provider_turn_id.length === 0
    ))
  ) {
    return rejected(
      runtime?.generation_id !== claim.session_generation_id
        ? 'session-generation-replaced'
        : 'session-runtime-incompatible',
    );
  }

  let resolved;
  try {
    resolved = await resolveStrictSpawnContext({
      claim,
      source,
      runtime,
    });
  } catch (error) {
    return rejected(error?.code || 'session-config-drift');
  }
  if (!resolved?.ok) {
    return rejected(resolved?.reason || 'session-config-drift');
  }

  let spawned;
  try {
    spawned = await strictSpawn({
      sessionKey: claim.session_key,
      context: resolved.context,
    });
  } catch (error) {
    return rejected(error?.code || 'strict-resume-failed');
  }
  if (
    !spawned?.process
    || !attestsExactResume(
      spawned.attestation,
      runtime.provider_session_id,
      claim,
    )
  ) {
    if (spawned?.process) {
      if (typeof discardSpawn !== 'function') {
        throw new TypeError('clean resume rejected spawn requires exact-process cleanup');
      }
      await discardSpawn({
        sessionKey: claim.session_key,
        process: spawned.process,
        reason: 'resume-attestation-mismatch',
      });
    }
    return rejected('resume-attestation-mismatch');
  }
  logEvent('clean-resume-attested', eventDetail);

  let result;
  try {
    result = await sendContinue({
      sessionKey: claim.session_key,
      text: 'continue',
      sourceMsgId: codex ? null : source.msg_id,
      expectedProcess: spawned.process,
      onDispatched: markContinuationDispatched,
    });
    markReady();
  } catch (error) {
    markReady();
    const ambiguous = error?.deliveryAmbiguous === true;
    return failed(
      ambiguous ? 'continuation-delivery-ambiguous' : 'continuation-failed',
      { ambiguous },
    );
  }

  const settleCodexDelivery = async (disposition) => {
    if (!codex) return;
    if (typeof settleProviderDelivery !== 'function') {
      throw new TypeError('Codex clean resume requires delivery settlement');
    }
    await settleProviderDelivery({ claim, result, disposition });
  };

  if (result?.deliveryAmbiguous === true) {
    await settleCodexDelivery('failed');
    return failed('continuation-delivery-ambiguous', { ambiguous: true });
  }
  if (result?.error) {
    await settleCodexDelivery('failed');
    return failed('continuation-failed');
  }
  if (codex && result?.alreadyDelivered) {
    await settleCodexDelivery('failed');
    return failed('continuation-delivery-incompatible');
  }
  if (!result?.alreadyDelivered) {
    if (typeof result?.text !== 'string' || result.text.trim().length === 0) {
      await settleCodexDelivery('failed');
      return failed('continuation-empty');
    }
    let delivered;
    try {
      delivered = await deliverResult({
        claim,
        source,
        text: result.text,
        result,
      });
    } catch (error) {
      await settleCodexDelivery('failed');
      const ambiguous = error?.deliveryAmbiguous === true;
      return failed(
        ambiguous ? 'continuation-delivery-ambiguous' : 'continuation-delivery-failed',
        { ambiguous },
      );
    }
    if (delivered?.ok !== true) {
      await settleCodexDelivery('failed');
      return failed(
        delivered?.ambiguous
          ? 'continuation-delivery-ambiguous'
          : 'continuation-delivery-failed',
        { ambiguous: delivered?.ambiguous === true },
      );
    }
  }

  await settleCodexDelivery('delivered');

  await complete({
    sourceMessageId: claim.source_message_id,
    status: 'replied',
  });
  logEvent('clean-resume-succeeded', eventDetail);
  return { status: 'replied', reason: null };
}

async function startCleanRestartRecovery({
  db,
  botName,
  maxAgeMs,
  olderThanMs,
  supportedPolicyVersions = SUPPORTED_CLEAN_RESUME_POLICY_VERSIONS,
  sessionKeyForSource,
  executeClaim,
  trackTask = (task) => task,
  onClaim = () => {},
  onTaskError = () => {},
} = {}) {
  const recovery = db.claimCleanRestartRecovery({
    botName,
    maxAgeMs,
    olderThanMs,
    supportedPolicyVersions,
  });
  const claims = [
    ...(recovery.claims || []),
    ...(recovery.stranded || []).map((row) => ({
      bot_name: botName,
      session_key: sessionKeyForSource(row),
      session_generation_id: null,
      source_message_id: row.id,
      policy_version: CLEAN_RESUME_POLICY_VERSION,
      executable: false,
      reason: 'stranded-resume-attempt',
    })),
  ];
  for (let index = 0; index < claims.length; index += 1) {
    onClaim(index < (recovery.claims || []).length ? 'claimed' : 'stranded', claims[index]);
  }

  const launches = claims.map((claim) => {
    let releaseReady;
    let rejectReady;
    let ready = false;
    const readiness = new Promise((resolve, reject) => {
      rejectReady = reject;
      releaseReady = () => {
        if (ready) return;
        ready = true;
        resolve();
      };
    });
    const task = Promise.resolve()
      .then(() => executeClaim(claim, { onReady: releaseReady }))
      .catch((error) => {
        try { onTaskError(error, claim); } catch {}
        if (!ready) {
          ready = true;
          rejectReady(error);
        }
        return {
          status: 'failed',
          reason: error?.code || 'unexpected-recovery-error',
        };
      })
      .finally(releaseReady);
    trackTask(task);
    return { task, readiness };
  });

  await Promise.all(launches.map(({ readiness }) => readiness));
  return {
    clean: recovery.clean,
    claims,
    tasks: launches.map(({ task }) => task),
  };
}

module.exports = {
  CLEAN_RESUME_POLICY_VERSION,
  SUPPORTED_CLEAN_RESUME_POLICY_VERSIONS,
  executeCleanResumeClaim,
  recoveryNoticeText,
  attestsExactResume,
  createCleanResumeTurnContext,
  startCleanRestartRecovery,
  validateStrictResumeSpawn,
};

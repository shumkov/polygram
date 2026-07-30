'use strict';

const EXPECTED_NAMESPACE = 'claude:channels';
const CLEAN_RESUME_POLICY_VERSION = 1;

function recoveryNoticeText({ ambiguous = false } = {}) {
  if (ambiguous) {
    return '↺ Restart recovery could not confirm whether the answer was delivered. I will not retry it automatically; send the message again if you still need a reply.';
  }
  return '↺ Restarted — I couldn\'t safely resume this message. If it still needs a reply, send it again.';
}

function attestsExactResume(attestation, expectedSessionId) {
  return attestation?.namespace === EXPECTED_NAMESPACE
    && attestation.sessionId === expectedSessionId
    && attestation.resumed === true
    && attestation.freshFallback === false;
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

  if (
    !source
    || source.id !== claim.source_message_id
    || source.bot_name !== claim.bot_name
    || source.handler_status !== 'resume-attempted'
    || sessionKeyForSource(source) !== claim.session_key
  ) {
    return fallback('source-message-mismatch');
  }

  const runtime = loadRuntimeSession(claim.session_key);
  if (
    !runtime
    || runtime.namespace !== EXPECTED_NAMESPACE
    || runtime.generation_id !== claim.session_generation_id
    || typeof runtime.provider_session_id !== 'string'
    || runtime.provider_session_id.length === 0
    || !['cli', 'channels'].includes(runtime.pm_backend)
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
    || !attestsExactResume(spawned.attestation, runtime.provider_session_id)
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
      sourceMsgId: source.msg_id,
      expectedProcess: spawned.process,
      onDispatched: markReady,
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

  if (result?.deliveryAmbiguous === true) {
    return failed('continuation-delivery-ambiguous', { ambiguous: true });
  }
  if (result?.error) {
    return failed('continuation-failed');
  }
  if (!result?.alreadyDelivered) {
    if (typeof result?.text !== 'string' || result.text.trim().length === 0) {
      return failed('continuation-empty');
    }
    try {
      const delivered = await deliverResult({
        claim,
        source,
        text: result.text,
        result,
      });
      if (delivered?.ok !== true) {
        return failed(
          delivered?.ambiguous
            ? 'continuation-delivery-ambiguous'
            : 'continuation-delivery-failed',
          { ambiguous: delivered?.ambiguous === true },
        );
      }
    } catch (error) {
      const ambiguous = error?.deliveryAmbiguous === true;
      return failed(
        ambiguous ? 'continuation-delivery-ambiguous' : 'continuation-delivery-failed',
        { ambiguous },
      );
    }
  }

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
  supportedPolicyVersions = [CLEAN_RESUME_POLICY_VERSION],
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
  executeCleanResumeClaim,
  recoveryNoticeText,
  attestsExactResume,
  createCleanResumeTurnContext,
  startCleanRestartRecovery,
};

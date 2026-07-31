'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  executeCleanResumeClaim,
  recoveryNoticeText,
  startCleanRestartRecovery,
  validateStrictResumeSpawn,
} = require('../lib/ops/clean-resume');

const claim = {
  bot_name: 'shumabit',
  session_key: '100:3',
  session_generation_id: 'generation-a',
  source_message_id: 55,
  policy_version: 1,
  executable: true,
  reason: null,
};

const source = {
  id: 55,
  bot_name: 'shumabit',
  chat_id: '100',
  thread_id: '3',
  msg_id: 9,
  handler_status: 'resume-attempted',
};
const resumedProcess = { id: 'resumed-process' };

function strictSpawnFixture(overrides = {}) {
  return {
    strictResume: {
      expectedGenerationId: 'generation-a',
      expectedSessionId: 'session-a',
    },
    promptBackend: 'channels',
    liveProcess: null,
    runtime: {
      generation_id: 'generation-a',
      provider_session_id: 'session-a',
      pm_backend: 'cli',
      agent: 'reviewer',
      cwd: '/srv/polygram',
    },
    resolved: {
      agent: 'reviewer',
      cwd: '/srv/polygram',
      backend: 'channels',
    },
    ...overrides,
  };
}

describe('strict clean-resume spawn validation', () => {
  test('accepts only the exact dormant Codex thread, profile, and settings', () => {
    assert.equal(
      validateStrictResumeSpawn({
        strictResume: {
          expectedGenerationId: 'generation-codex',
          expectedSessionId: 'thread-codex',
          expectedInterruptedTurnId: 'turn-interrupted',
          expectedSpawnProfileId: 'profile-codex',
        },
        promptBackend: 'codex',
        liveProcess: null,
        runtime: {
          namespace: 'codex:app-server',
          generation_id: 'generation-codex',
          provider_session_id: 'thread-codex',
          pm_backend: 'codex',
          cwd: '/srv/polygram',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          spawn_profile_id: 'profile-codex',
        },
        resolved: {
          runtime: 'codex',
          backend: 'codex',
          cwd: '/srv/polygram',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          spawnProfileId: 'profile-codex',
        },
      }),
      'thread-codex',
    );
  });

  test('accepts only the exact dormant Claude CLI session generation', () => {
    assert.equal(
      validateStrictResumeSpawn(strictSpawnFixture()),
      'session-a',
    );
  });

  test('rejects a configured switch to Codex before a different provider can spawn', () => {
    assert.throws(
      () => validateStrictResumeSpawn(strictSpawnFixture({
        promptBackend: 'codex',
      })),
      { code: 'CLEAN_RESUME_CONFIG_DRIFT' },
    );
  });

  test('rejects an already-live process instead of attaching continue to it', () => {
    assert.throws(
      () => validateStrictResumeSpawn(strictSpawnFixture({
        liveProcess: {
          runtime: 'claude',
          backend: 'channels',
          closed: false,
        },
      })),
      { code: 'CLEAN_RESUME_SESSION_ALREADY_SPAWNED' },
    );
  });

  test('rejects a live mismatched runtime instead of replacing it', () => {
    assert.throws(
      () => validateStrictResumeSpawn(strictSpawnFixture({
        liveProcess: {
          runtime: 'codex',
          backend: 'codex',
          closed: false,
        },
      })),
      { code: 'CLEAN_RESUME_SESSION_ALREADY_SPAWNED' },
    );
  });

  for (const field of ['agent', 'cwd']) {
    test(`rejects ${field} drift without mutating the dormant runtime row`, () => {
      const runtime = strictSpawnFixture().runtime;
      const before = structuredClone(runtime);
      const resolved = {
        ...strictSpawnFixture().resolved,
        [field]: `${runtime[field]}-changed`,
      };

      assert.throws(
        () => validateStrictResumeSpawn(strictSpawnFixture({
          runtime,
          resolved,
        })),
        { code: 'CLEAN_RESUME_CONFIG_DRIFT' },
      );
      assert.deepEqual(runtime, before);
    });
  }

  for (const [label, override] of [
    ['generation', { generation_id: 'generation-b' }],
    ['provider session', { provider_session_id: 'session-b' }],
  ]) {
    test(`rejects a replaced ${label}`, () => {
      assert.throws(
        () => validateStrictResumeSpawn(strictSpawnFixture({
          runtime: {
            ...strictSpawnFixture().runtime,
            ...override,
          },
        })),
        { code: 'CLEAN_RESUME_SESSION_CHANGED' },
      );
    });
  }
});

function fixture(overrides = {}) {
  const calls = {
    spawn: [],
    send: [],
    deliver: [],
    notice: [],
    discard: [],
    complete: [],
    events: [],
    settle: [],
    order: [],
  };
  const deps = {
    enabled: overrides.enabled ?? true,
    loadSource: () => overrides.source === undefined ? source : overrides.source,
    sessionKeyForSource: () => overrides.sourceSessionKey ?? '100:3',
    loadRuntimeSession: () => overrides.runtimeSession || {
      namespace: 'claude:channels',
      generation_id: 'generation-a',
      provider_session_id: 'session-a',
      pm_backend: 'cli',
    },
    resolveStrictSpawnContext: () => overrides.spawnContext === undefined
      ? { ok: true, context: { label: 'Music' } }
      : overrides.spawnContext,
    strictSpawn: async (input) => {
      calls.spawn.push(input);
      if (overrides.spawnError) throw overrides.spawnError;
      return overrides.spawnResult || {
        process: resumedProcess,
        attestation: {
          namespace: 'claude:channels',
          sessionId: 'session-a',
          resumed: true,
          freshFallback: false,
        },
      };
    },
    discardSpawn: async (input) => {
      calls.discard.push(input);
      if (overrides.discardError) throw overrides.discardError;
    },
    sendContinue: async (input) => {
      calls.send.push(input);
      if (overrides.sendError) throw overrides.sendError;
      return overrides.sendResult || {
        text: 'finished answer',
        alreadyDelivered: true,
      };
    },
    deliverResult: async (input) => {
      calls.deliver.push(input);
      calls.order.push('deliver');
      if (overrides.deliveryError) throw overrides.deliveryError;
      return overrides.deliveryResult || { ok: true };
    },
    settleProviderDelivery: async (input) => {
      calls.settle.push(input);
      calls.order.push(`settle:${input.disposition}`);
      if (overrides.settlementError) throw overrides.settlementError;
      return { committed: true };
    },
    sendNotice: async (input) => {
      calls.notice.push(input);
      calls.order.push('notice');
      if (overrides.noticeError) throw overrides.noticeError;
      return { ok: true };
    },
    complete: async (input) => {
      calls.complete.push(input);
      calls.order.push(`complete:${input.status}`);
      if (overrides.completeError) throw overrides.completeError;
      return overrides.completeResult;
    },
    logEvent: (kind, detail) => calls.events.push({ kind, detail }),
  };
  return { deps, calls };
}

describe('clean resume boot coordinator', () => {
  test('rejects a malformed Codex policy-v1 claim before spawning', async () => {
    const malformed = {
      ...claim,
      policy_version: 1,
      provider_namespace: 'codex:app-server',
      interrupted_provider_turn_id: 'turn-interrupted',
      interrupted_spawn_profile_id: 'profile-codex',
    };
    const { deps, calls } = fixture();

    const result = await executeCleanResumeClaim(malformed, deps);

    assert.equal(result.reason, 'unsupported-codex-policy');
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.send.length, 0);
  });

  test('rejects a profile-only malformed claim before treating it as Claude', async () => {
    const malformed = {
      ...claim,
      policy_version: 1,
      interrupted_provider_turn_id: null,
      interrupted_spawn_profile_id: '',
    };
    const { deps, calls } = fixture();

    const result = await executeCleanResumeClaim(malformed, deps);

    assert.equal(result.reason, 'unsupported-codex-policy');
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.send.length, 0);
  });

  test('Codex resumes the exact interrupted tail and settles delivery before source completion', async () => {
    const codexClaim = {
      ...claim,
      policy_version: 2,
      session_generation_id: 'generation-codex',
      provider_namespace: 'codex:app-server',
      interrupted_provider_turn_id: 'turn-interrupted',
      interrupted_spawn_profile_id: 'profile-codex',
    };
    const { deps, calls } = fixture({
      runtimeSession: {
        namespace: 'codex:app-server',
        generation_id: 'generation-codex',
        provider_session_id: 'thread-codex',
        pm_backend: 'codex',
        spawn_profile_id: 'profile-codex',
      },
      spawnResult: {
        process: resumedProcess,
        attestation: {
          namespace: 'codex:app-server',
          sessionId: 'thread-codex',
          interruptedTurnId: 'turn-interrupted',
          resumed: true,
          freshFallback: false,
          idle: true,
        },
      },
      sendResult: {
        runtime: 'codex',
        text: 'finished answer',
        alreadyDelivered: false,
        generationId: 'generation-codex-new',
        attemptId: 'attempt-continue',
        providerSessionId: 'thread-codex',
        providerTurnId: 'turn-continue',
      },
    });

    await executeCleanResumeClaim(codexClaim, deps);

    assert.equal(calls.send[0].sourceMsgId, null);
    assert.equal(calls.deliver.length, 1);
    assert.deepEqual(calls.settle, [{
      claim: codexClaim,
      result: calls.send[0] && {
        runtime: 'codex',
        text: 'finished answer',
        alreadyDelivered: false,
        generationId: 'generation-codex-new',
        attemptId: 'attempt-continue',
        providerSessionId: 'thread-codex',
        providerTurnId: 'turn-continue',
      },
      disposition: 'delivered',
    }]);
    assert.equal(calls.complete[0].status, 'replied');
    assert.deepEqual(calls.order, [
      'deliver',
      'settle:delivered',
      'complete:replied',
    ]);
  });

  test('Codex records failed delivery before notice and source completion', async () => {
    const codexClaim = {
      ...claim,
      policy_version: 2,
      session_generation_id: 'generation-codex',
      provider_namespace: 'codex:app-server',
      interrupted_provider_turn_id: 'turn-interrupted',
      interrupted_spawn_profile_id: 'profile-codex',
    };
    const { deps, calls } = fixture({
      runtimeSession: {
        namespace: 'codex:app-server',
        generation_id: 'generation-codex',
        provider_session_id: 'thread-codex',
        pm_backend: 'codex',
        spawn_profile_id: 'profile-codex',
      },
      spawnResult: {
        process: resumedProcess,
        attestation: {
          namespace: 'codex:app-server',
          sessionId: 'thread-codex',
          interruptedTurnId: 'turn-interrupted',
          resumed: true,
          freshFallback: false,
          idle: true,
        },
      },
      sendResult: {
        runtime: 'codex',
        text: 'finished answer',
        alreadyDelivered: false,
        generationId: 'generation-codex-new',
        attemptId: 'attempt-continue',
        providerSessionId: 'thread-codex',
        providerTurnId: 'turn-continue',
      },
      deliveryResult: { ok: false, ambiguous: false },
    });

    const result = await executeCleanResumeClaim(codexClaim, deps);

    assert.equal(result.reason, 'continuation-delivery-failed');
    assert.deepEqual(calls.order, [
      'deliver',
      'settle:failed',
      'notice',
      'complete:replay-skipped',
    ]);
  });

  test('Codex settlement failure blocks source completion', async () => {
    const codexClaim = {
      ...claim,
      policy_version: 2,
      session_generation_id: 'generation-codex',
      provider_namespace: 'codex:app-server',
      interrupted_provider_turn_id: 'turn-interrupted',
      interrupted_spawn_profile_id: 'profile-codex',
    };
    const { deps, calls } = fixture({
      runtimeSession: {
        namespace: 'codex:app-server',
        generation_id: 'generation-codex',
        provider_session_id: 'thread-codex',
        pm_backend: 'codex',
        spawn_profile_id: 'profile-codex',
      },
      spawnResult: {
        process: resumedProcess,
        attestation: {
          namespace: 'codex:app-server',
          sessionId: 'thread-codex',
          interruptedTurnId: 'turn-interrupted',
          resumed: true,
          freshFallback: false,
          idle: true,
        },
      },
      sendResult: {
        runtime: 'codex',
        text: 'finished answer',
        alreadyDelivered: false,
        generationId: 'generation-codex-new',
        attemptId: 'attempt-continue',
        providerSessionId: 'thread-codex',
        providerTurnId: 'turn-continue',
      },
      settlementError: new Error('delivery fence unavailable'),
    });

    await assert.rejects(
      () => executeCleanResumeClaim(codexClaim, deps),
      /delivery fence unavailable/,
    );
    assert.deepEqual(calls.order, ['deliver', 'settle:delivered']);
    assert.equal(calls.complete.length, 0);
  });

  test('strictly resumes the exact generation and sends one tracked literal continue', async () => {
    const { deps, calls } = fixture();
    const result = await executeCleanResumeClaim(claim, deps);

    assert.deepEqual(calls.spawn, [{
      sessionKey: '100:3',
      context: { label: 'Music' },
    }]);
    assert.deepEqual(calls.send, [{
      sessionKey: '100:3',
      text: 'continue',
      sourceMsgId: 9,
      expectedProcess: resumedProcess,
      onDispatched: calls.send[0].onDispatched,
    }]);
    assert.equal(typeof calls.send[0].onDispatched, 'function');
    assert.deepEqual(calls.complete, [{
      sourceMessageId: 55,
      status: 'replied',
    }]);
    assert.equal(calls.notice.length, 0);
    assert.equal(result.status, 'replied');
  });

  test('delivers final text when the CLI reply tool did not already deliver it', async () => {
    const { deps, calls } = fixture({
      sendResult: { text: 'late final', alreadyDelivered: false },
    });
    await executeCleanResumeClaim(claim, deps);

    assert.equal(calls.deliver.length, 1);
    assert.equal(calls.deliver[0].text, 'late final');
    assert.equal(calls.complete[0].status, 'replied');
  });

  test('a replaced generation is notice-only and never spawns or continues', async () => {
    const { deps, calls } = fixture({
      runtimeSession: {
        namespace: 'claude:channels',
        generation_id: 'generation-b',
        provider_session_id: 'session-b',
        pm_backend: 'cli',
      },
    });
    const result = await executeCleanResumeClaim(claim, deps);

    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.send.length, 0);
    assert.equal(calls.discard.length, 0);
    assert.equal(calls.notice.length, 1);
    assert.equal(calls.complete[0].status, 'replay-skipped');
    assert.equal(result.reason, 'session-generation-replaced');
  });

  test('attestation cleanup failure aborts boot before polling can reuse the process', async () => {
    const { deps, calls } = fixture({
      spawnResult: {
        process: resumedProcess,
        attestation: {
          namespace: 'claude:channels',
          sessionId: 'wrong-session',
          resumed: true,
          freshFallback: false,
        },
      },
      discardError: new Error('exact process retirement failed'),
    });

    await assert.rejects(
      () => executeCleanResumeClaim(claim, deps),
      /exact process retirement failed/,
    );
    assert.equal(calls.notice.length, 0);
    assert.equal(calls.complete.length, 0);
  });

  test('a mismatched resume attestation cannot receive continue', async () => {
    const { deps, calls } = fixture({
      spawnResult: {
        process: resumedProcess,
        attestation: {
          namespace: 'claude:channels',
          sessionId: 'another-session',
          resumed: true,
          freshFallback: false,
        },
      },
    });
    const result = await executeCleanResumeClaim(claim, deps);

    assert.equal(calls.send.length, 0);
    assert.deepEqual(calls.discard, [{
      sessionKey: '100:3',
      process: resumedProcess,
      reason: 'resume-attestation-mismatch',
    }]);
    assert.equal(calls.notice.length, 1);
    assert.equal(result.reason, 'resume-attestation-mismatch');
    assert.ok(calls.events.some((event) => (
      event.kind === 'clean-resume-rejected'
      && event.detail.reason === 'resume-attestation-mismatch'
    )));
  });

  test('disabled rollout and unsupported claims are consumed as notice-only', async () => {
    for (const [candidate, overrides, reason] of [
      [claim, { enabled: false }, 'rollout-disabled'],
      [{ ...claim, executable: false, reason: 'unsupported-policy-version' }, {}, 'unsupported-policy-version'],
    ]) {
      const { deps, calls } = fixture(overrides);
      const result = await executeCleanResumeClaim(candidate, deps);
      assert.equal(calls.spawn.length, 0);
      assert.equal(calls.send.length, 0);
      assert.equal(calls.notice.length, 1);
      assert.equal(calls.complete[0].status, 'replay-skipped');
      assert.equal(result.reason, reason);
    }
  });

  test('ambiguous continuation delivery uses the uncertainty notice and never retries answer work', async () => {
    const error = Object.assign(new Error('Telegram response lost'), {
      deliveryAmbiguous: true,
    });
    const { deps, calls } = fixture({ sendError: error });
    const result = await executeCleanResumeClaim(claim, deps);

    assert.equal(calls.send.length, 1);
    assert.equal(calls.notice.length, 1);
    assert.equal(calls.notice[0].ambiguous, true);
    assert.match(calls.notice[0].text, /could not confirm/i);
    assert.equal(calls.complete[0].status, 'replay-skipped');
    assert.equal(result.reason, 'continuation-delivery-ambiguous');
    assert.ok(calls.events.some((event) => (
      event.kind === 'clean-resume-failed'
      && event.detail.reason === 'continuation-delivery-ambiguous'
    )));
  });

  test('an ambiguous tracked result cannot be mistaken for an empty safe result', async () => {
    const { deps, calls } = fixture({
      sendResult: { deliveryAmbiguous: true },
    });
    const result = await executeCleanResumeClaim(claim, deps);

    assert.equal(calls.notice[0].ambiguous, true);
    assert.equal(result.reason, 'continuation-delivery-ambiguous');
  });

  test('terminal completion is awaited before recovery reports success', async () => {
    const { deps } = fixture({
      completeError: new Error('terminal write failed'),
    });

    await assert.rejects(
      () => executeCleanResumeClaim(claim, deps),
      /terminal write failed/,
    );
  });

  test('notice is sent before replay-skipped; a failed notice leaves the tombstone retryable', async () => {
    const { deps, calls } = fixture({
      enabled: false,
      noticeError: new Error('Telegram unavailable'),
    });
    await assert.rejects(
      () => executeCleanResumeClaim(claim, deps),
      /Telegram unavailable/,
    );
    assert.equal(calls.complete.length, 0);
  });

  test('notice copy distinguishes ordinary and ambiguous recovery failure', () => {
    assert.match(recoveryNoticeText({ ambiguous: false }), /send it again/i);
    assert.match(recoveryNoticeText({ ambiguous: true }), /will not retry/i);
  });

  test('fallback branches stop before unsafe downstream work', async () => {
    const cases = [
      {
        name: 'source mismatch',
        overrides: { sourceSessionKey: 'other' },
        reason: 'source-message-mismatch',
        spawn: 0,
        send: 0,
      },
      {
        name: 'spawn context drift',
        overrides: { spawnContext: { ok: false, reason: 'session-config-drift' } },
        reason: 'session-config-drift',
        spawn: 0,
        send: 0,
      },
      {
        name: 'strict spawn failure',
        overrides: {
          spawnError: Object.assign(new Error('missing transcript'), {
            code: 'STRICT_RESUME_MISSING',
          }),
        },
        reason: 'STRICT_RESUME_MISSING',
        spawn: 1,
        send: 0,
      },
      {
        name: 'empty continuation',
        overrides: { sendResult: { text: ' ', alreadyDelivered: false } },
        reason: 'continuation-empty',
        spawn: 1,
        send: 1,
      },
      {
        name: 'failed result delivery',
        overrides: {
          sendResult: { text: 'answer', alreadyDelivered: false },
          deliveryResult: { ok: false, ambiguous: false },
        },
        reason: 'continuation-delivery-failed',
        spawn: 1,
        send: 1,
      },
    ];

    for (const candidate of cases) {
      const { deps, calls } = fixture(candidate.overrides);
      const result = await executeCleanResumeClaim(claim, deps);
      assert.equal(result.reason, candidate.reason, candidate.name);
      assert.equal(calls.spawn.length, candidate.spawn, candidate.name);
      assert.equal(calls.send.length, candidate.send, candidate.name);
      assert.equal(calls.notice.length, 1, candidate.name);
      assert.equal(calls.complete[0].status, 'replay-skipped', candidate.name);
    }
  });

  test('boot recovery returns after dispatch while tracked continuation work remains owned', async () => {
    let finishContinuation;
    const continuation = new Promise((resolve) => {
      finishContinuation = resolve;
    });
    const tracked = [];
    const executed = [];
    const observedClaims = [];
    const recovery = await startCleanRestartRecovery({
      db: {
        claimCleanRestartRecovery: () => ({
          clean: true,
          claims: [claim],
          stranded: [{ ...source, id: 56 }],
        }),
      },
      botName: 'shumabit',
      maxAgeMs: 1000,
      olderThanMs: 500,
      sessionKeyForSource: () => '100:3',
      executeClaim: async (candidate, { onReady }) => {
        executed.push(candidate);
        onReady();
        if (candidate.executable) await continuation;
      },
      trackTask: (task) => tracked.push(task),
      onClaim: (kind, candidate) => observedClaims.push({ kind, candidate }),
    });

    assert.equal(recovery.clean, true);
    assert.equal(executed.length, 2);
    assert.equal(tracked.length, 2);
    assert.equal(recovery.tasks.length, 2);
    assert.equal(executed[1].executable, false);
    assert.equal(executed[1].reason, 'stranded-resume-attempt');
    assert.deepEqual(
      observedClaims.map(({ kind }) => kind),
      ['claimed', 'stranded'],
    );

    let settled = false;
    Promise.all(recovery.tasks).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    finishContinuation();
    await Promise.all(recovery.tasks);
  });

  test('one boot claims both Claude and Codex recovery policies', async () => {
    const codexClaim = {
      ...claim,
      policy_version: 2,
      provider_namespace: 'codex:app-server',
      interrupted_provider_turn_id: 'turn-interrupted',
      interrupted_spawn_profile_id: 'profile-codex',
    };
    let claimOptions;
    const executed = [];

    const recovery = await startCleanRestartRecovery({
      db: {
        claimCleanRestartRecovery: (options) => {
          claimOptions = options;
          return {
            clean: true,
            claims: [claim, codexClaim],
            stranded: [],
          };
        },
      },
      botName: 'shumabit',
      sessionKeyForSource: () => claim.session_key,
      executeClaim: async (candidate, { onReady }) => {
        executed.push(candidate);
        onReady();
      },
    });

    await Promise.all(recovery.tasks);
    assert.deepEqual(claimOptions.supportedPolicyVersions, [1, 2]);
    assert.deepEqual(executed, [claim, codexClaim]);
  });

  test('boot recovery rejects when a claim fails before declaring its session ready', async () => {
    const db = {
      claimCleanRestartRecovery: () => ({
        clean: true,
        claims: [claim],
        stranded: [],
      }),
    };

    await assert.rejects(
      () => startCleanRestartRecovery({
        db,
        botName: 'shumabit',
        sessionKeyForSource: () => claim.session_key,
        executeClaim: async () => {
          throw new Error('unsafe spawned process could not be retired');
        },
      }),
      /unsafe spawned process could not be retired/,
    );
  });
});

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbClient = require('../lib/db');
const {
  CodexRuntimeControllerError,
  createCodexRuntimeController,
} = require('../lib/codex/runtime-controller');

function fixture({
  recoveryStatus = 'clear',
  dbOverride = null,
  homeAttestations = null,
  codexAttempt = null,
  configOverride = null,
  modelCatalogOverride = null,
  catalogSnapshots = null,
  catalogModels = [{
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['high', 'xhigh'],
  }],
  staticProfileExtras = null,
  controllerOptions = null,
} = {}) {
  const calls = [];
  const checkpointPayloads = [];
  let homeAttestationIndex = 0;
  let modelCatalogIndex = 0;
  const receipt = Object.freeze({
    runtime: 'codex',
    spawnProfileId: 'a'.repeat(64),
    expectedStaticProfile: Object.freeze({
      binary: '/opt/codex',
      codexHome: '/srv/codex-home',
      cwd: '/srv/workspace',
      env: Object.freeze({ PATH: '/usr/bin:/bin' }),
      ownedConfigSha256: 'b'.repeat(64),
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      ...(staticProfileExtras || {}),
    }),
  });
  const fakeDb = {
    raw: {
      transaction(fn) {
        return () => {
          calls.push('transaction:start');
          const result = fn();
          calls.push('transaction:commit');
          return result;
        };
      },
    },
    reconstructCodexRecovery(input) {
      calls.push(['reconstruct', input]);
      return {
        status: recoveryStatus,
        reason: recoveryStatus === 'clear' ? null : 'persisted-containment',
        containmentReleased: false,
        replayableAttemptIds: [],
        unresolvedAttemptIds: [],
      };
    },
    getCodexLease() {
      return recoveryStatus === 'clear'
        ? null
        : {
          generation_id: 'incident-generation',
          stable_host_id: 'host:incident',
          boot_session_id: 'boot:incident',
          status: 'quarantined',
        };
    },
    createCodexGeneration(input) {
      calls.push(['create-generation', input]);
    },
    acquireCodexLease(input) {
      calls.push(['acquire-lease', input]);
    },
    recordCodexCheckpoint(input) {
      checkpointPayloads.push(input);
      calls.push(['checkpoint', input.kind]);
    },
    recordCodexDeliveryCheckpoint(input) {
      calls.push(['delivery-checkpoint', input.retireGeneration]);
      this.recordCodexCheckpoint(input.checkpoint);
      if (input.retireGeneration) {
        this.markCodexGenerationRetired({
          generation_id: input.checkpoint.generationId,
          ts: input.checkpoint.ts,
        });
      }
      return {
        changes: 1,
        attemptId: input.checkpoint.attemptId,
        kind: input.checkpoint.kind,
        retired: input.retireGeneration,
      };
    },
    getCodexAttempt(attemptId) {
      calls.push(['get-attempt', attemptId]);
      return typeof codexAttempt === 'function'
        ? codexAttempt(attemptId)
        : codexAttempt;
    },
    markCodexGenerationRetired(input) {
      calls.push(['retire', input]);
    },
    settleCodexStoppedGeneration(input) {
      calls.push(['settle-stopped-generation', input]);
      return {
        changes: 0,
        disposition: 'already-disposed',
      };
    },
    settleCodexFailedGeneration(input) {
      calls.push(['settle-failed-generation', input]);
      return {
        committed: true,
        disposition: 'failed-settled',
        generationId: input.generation_id,
      };
    },
    claimCodexDispatchReservation(input) {
      calls.push(['claim-dispatch', input]);
      return {
        claimed: true,
        reservation: {
          reservation_id: input.reservation_id,
          generation_id: input.generation_id,
          state: 'reserved',
        },
      };
    },
    finalizeCodexAcceptedSteer(input) {
      calls.push(['finalize-steer', input]);
      return {
        changes: 1,
        reservation: {
          reservation_id: input.reservation_id,
          generation_id: input.generation_id,
          state: 'steer-accepted',
        },
      };
    },
    markCodexDispatchDisposition(input) {
      calls.push(['dispatch-disposition', input]);
      return {
        changes: 1,
        reservation: {
          reservation_id: input.reservation_id,
          generation_id: input.generation_id,
          state: input.disposition,
        },
      };
    },
    settleCodexQueuedDispatch(input) {
      calls.push(['settle-queued-dispatch', input]);
      return {
        changes: 1,
        outcome: 'settled',
        reservation: {
          generation_id: input.generation_id,
          target_attempt_id: input.attempt_id,
          state: 'settled',
        },
      };
    },
  };
  const db = dbOverride ?? fakeDb;
  const clientOptions = [];
  class FakeClient {
    constructor(options) {
      clientOptions.push(options);
    }
  }
  const controller = createCodexRuntimeController({
    config: configOverride ?? {
      codex: {
        home: '/srv/codex-home',
        daemonSecretRoots: ['/srv/polygram'],
      },
      defaults: { codexEnabled: true },
      chats: {
        '100': {
          pm: 'codex',
          cwd: '/srv/workspace',
          codexModel: 'gpt-5.6-sol',
          codexEffort: 'xhigh',
        },
      },
    },
    db,
    processEnv: { POLYGRAM_CODEX_BIN: '/opt/codex' },
    resolveHostIdentity: () => ({
      stableHostId: 'host:current',
      bootSessionId: 'boot:current',
    }),
    resolveBinary: async () => ({
      path: '/opt/codex',
      version: 'codex-cli 0.145.0',
      sha256: 'c'.repeat(64),
      fingerprint: Object.freeze({ ino: '1' }),
    }),
    runtimeProfileBuilder: {
      async prepare(input) {
        calls.push(['prepare-profile', input]);
        return receipt.expectedStaticProfile;
      },
    },
    modelCatalog: modelCatalogOverride ?? {
      async preflight(profile, options) {
        calls.push(['model-preflight', profile, options]);
        const snapshot = catalogSnapshots
          ? catalogSnapshots[Math.min(
            modelCatalogIndex,
            catalogSnapshots.length - 1,
          )]
          : catalogModels;
        modelCatalogIndex += 1;
        if (snapshot instanceof Error) throw snapshot;
        return {
          state: 'available',
          spawnProfile: receipt,
          models: snapshot,
          selected: {
            model: 'gpt-5.6-sol',
            effort: 'xhigh',
          },
        };
      },
      invalidate(options) {
        calls.push(['model-invalidate', options]);
      },
    },
    attestCodexHome: async () => {
      const attestation = homeAttestations
        ? homeAttestations[Math.min(
          homeAttestationIndex,
          homeAttestations.length - 1,
        )]
        : {
          authFingerprint: { ino: 'auth-1' },
          configFingerprint: { ino: 'config-1' },
        };
      homeAttestationIndex += 1;
      if (attestation instanceof Error) throw attestation;
      calls.push(['attest-home', attestation]);
      return attestation;
    },
    createAvailability: (value) => Object.freeze({
      state: 'available',
      receipt: value,
    }),
    resolveRuntime: ({ codexAvailability }) => Object.freeze({
      runtime: 'codex',
      backend: 'codex',
      spawnProfileId: codexAvailability.receipt.spawnProfileId,
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      cwd: '/srv/workspace',
    }),
    orchestra: { CodexAppServerClient: FakeClient },
    logger: { error() {}, warn() {}, info() {} },
    ...(controllerOptions || {}),
  });
  return {
    calls,
    checkpointPayloads,
    clientOptions,
    controller,
    db,
    receipt,
  };
}

test('different chats serialize native preflight admission daemon-wide', async () => {
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  let enteredFirst;
  const firstEntered = new Promise((resolve) => {
    enteredFirst = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const catalog = {
    calls: 0,
    async preflight(profile) {
      this.calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (this.calls === 1) {
        enteredFirst();
        await firstGate;
      }
      active -= 1;
      return {
        state: 'available',
        spawnProfile: Object.freeze({
          runtime: 'codex',
          spawnProfileId: 'a'.repeat(64),
          expectedStaticProfile: profile,
        }),
        selected: {
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
        },
      };
    },
    invalidate() {},
  };
  const { controller } = fixture({
    configOverride: {
      codex: {
        home: '/srv/codex-home',
        daemonSecretRoots: ['/srv/polygram'],
      },
      defaults: { codexEnabled: true },
      chats: {
        '100': {
          pm: 'codex',
          cwd: '/srv/workspace',
          codexModel: 'gpt-5.6-sol',
          codexEffort: 'xhigh',
        },
        '200': {
          pm: 'codex',
          cwd: '/srv/workspace',
          codexModel: 'gpt-5.6-sol',
          codexEffort: 'xhigh',
        },
      },
    },
    modelCatalogOverride: catalog,
  });

  const first = controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  await firstEntered;
  const second = controller.prepareSession({
    sessionKey: '200',
    chatId: '200',
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(catalog.calls, 2);
  assert.equal(maxActive, 1);
});

test('preflight admission wait is bounded without starting a competing app-server', async () => {
  let releaseFirst;
  let enteredFirst;
  const firstEntered = new Promise((resolve) => {
    enteredFirst = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const catalog = {
    calls: 0,
    async preflight(profile) {
      this.calls += 1;
      if (this.calls === 1) {
        enteredFirst();
        await firstGate;
      }
      return {
        state: 'available',
        spawnProfile: Object.freeze({
          runtime: 'codex',
          spawnProfileId: 'a'.repeat(64),
          expectedStaticProfile: profile,
        }),
        selected: {
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
        },
      };
    },
    invalidate() {},
  };
  const { controller } = fixture({
    configOverride: {
      codex: {
        home: '/srv/codex-home',
        daemonSecretRoots: ['/srv/polygram'],
      },
      defaults: { codexEnabled: true },
      chats: {
        '100': {
          pm: 'codex',
          cwd: '/srv/workspace',
          codexModel: 'gpt-5.6-sol',
          codexEffort: 'xhigh',
        },
        '200': {
          pm: 'codex',
          cwd: '/srv/workspace',
          codexModel: 'gpt-5.6-sol',
          codexEffort: 'xhigh',
        },
      },
    },
    modelCatalogOverride: catalog,
    controllerOptions: { preflightAdmissionTimeoutMs: 10 },
  });

  const first = controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  await firstEntered;
  await assert.rejects(
    controller.prepareSession({
      sessionKey: '200',
      chatId: '200',
    }),
    { code: 'CODEX_PREFLIGHT_ADMISSION_TIMEOUT' },
  );
  assert.equal(catalog.calls, 1);
  releaseFirst();
  await first;
});

test('safe pre-write startup close reclaims the provisional generation record', async () => {
  const { calls, controller, receipt } = fixture();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  const first = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'provisional-generation',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: true,
    closed: true,
  });
  controller.registerProcess(first);
  first.emit('close');
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  assert.equal(
    calls.filter((entry) => entry[0] === 'model-preflight').length,
    2,
  );

  const replacement = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'provisional-generation',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  assert.doesNotThrow(() => controller.registerProcess(replacement));
});

test('retiring an old generation preserves a newer prepared receipt', async () => {
  let currentTime = 1_000;
  let latestReceipt = null;
  const catalog = {
    async preflight(profile) {
      latestReceipt = Object.freeze({
        runtime: 'codex',
        spawnProfileId: 'a'.repeat(64),
        expectedStaticProfile: profile,
      });
      return {
        state: 'available',
        spawnProfile: latestReceipt,
        models: [{
          model: 'gpt-5.6-sol',
          displayName: 'GPT-5.6 Sol',
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: ['high', 'xhigh'],
        }],
        selected: {
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
        },
      };
    },
    invalidate() {},
  };
  const { controller } = fixture({
    modelCatalogOverride: catalog,
    controllerOptions: {
      catalogMaxAgeMs: 10,
      now: () => currentTime,
    },
  });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  const firstReceipt = latestReceipt;
  const first = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'retiring-generation',
    spawnProfileId: firstReceipt.spawnProfileId,
    startupReleaseSafe: true,
    closed: true,
  });
  controller.registerProcess(first);

  currentTime += 11;
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  const newerReceipt = latestReceipt;
  assert.notEqual(newerReceipt, firstReceipt);
  first.emit('close');

  assert.equal(controller.resolveReceipt('100', {
    runtime: 'codex',
    spawnProfileId: newerReceipt.spawnProfileId,
  }), newerReceipt);
});

async function registerDurableProcess(controller, receipt, {
  generationId = 'generation-dispatch',
  sessionKey = '100',
} = {}) {
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    backend: 'codex',
    sessionKey,
    generationId,
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);
  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: `attempt-${generationId}`,
    method: 'thread/start',
  });
  await controller.checkpointSink({
    kind: 'request-write-attempted',
    generationId,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: `attempt-${generationId}`,
    method: 'thread/start',
  });
  return proc;
}

test('durable dispatch wrappers bind reservation mutations to the current generation owner', async () => {
  const { calls, controller, receipt } = fixture();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  await registerDurableProcess(controller, receipt);

  const claimed = controller.claimDispatchReservation({
    sessionKey: '100',
    generationId: 'generation-dispatch',
    botName: 'bot-a',
    telegramChatId: '100',
    telegramMessageId: '42',
  });
  assert.equal(claimed.claimed, true);
  assert.match(
    claimed.reservationId,
    /^codex-dispatch:v1:[a-f0-9]{64}$/,
  );

  const duplicateIdentity = controller.claimDispatchReservation({
    sessionKey: '100',
    generationId: 'generation-dispatch',
    botName: 'bot-a',
    telegramChatId: '100',
    telegramMessageId: '42',
  });
  assert.equal(duplicateIdentity.reservationId, claimed.reservationId);

  controller.finalizeAcceptedSteer({
    sessionKey: '100',
    generationId: 'generation-dispatch',
    reservationId: claimed.reservationId,
    steerAttemptId: 'steer-attempt',
    targetAttemptId: 'target-attempt',
  });
  controller.markDispatchDisposition({
    sessionKey: '100',
    generationId: 'generation-dispatch',
    reservationId: claimed.reservationId,
    disposition: 'queue-authorized',
  });
  controller.settleQueuedDispatch({
    sessionKey: '100',
    generationId: 'generation-dispatch',
    reservationId: claimed.reservationId,
    attemptId: 'queued-attempt',
    botName: 'bot-a',
    telegramChatId: '100',
    telegramMessageId: '42',
  });

  const mutations = calls.filter((entry) => (
    Array.isArray(entry)
    && [
      'claim-dispatch',
      'finalize-steer',
      'dispatch-disposition',
      'settle-queued-dispatch',
    ].includes(entry[0])
  ));
  assert.deepEqual(
    mutations.map(([kind, input]) => ({
      kind,
      generation: input.generation_id,
      host: input.stable_host_id,
      boot: input.boot_session_id,
    })),
    [
      {
        kind: 'claim-dispatch',
        generation: 'generation-dispatch',
        host: 'host:current',
        boot: 'boot:current',
      },
      {
        kind: 'claim-dispatch',
        generation: 'generation-dispatch',
        host: 'host:current',
        boot: 'boot:current',
      },
      {
        kind: 'finalize-steer',
        generation: 'generation-dispatch',
        host: 'host:current',
        boot: 'boot:current',
      },
      {
        kind: 'dispatch-disposition',
        generation: 'generation-dispatch',
        host: 'host:current',
        boot: 'boot:current',
      },
      {
        kind: 'settle-queued-dispatch',
        generation: 'generation-dispatch',
        host: 'host:current',
        boot: 'boot:current',
      },
    ],
  );
});

test('dispatch wrappers fail closed for stale, non-durable, and malformed bindings', async () => {
  const { calls, controller, receipt } = fixture();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    backend: 'codex',
    sessionKey: '100',
    generationId: 'generation-not-durable',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);

  assert.throws(
    () => controller.claimDispatchReservation({
      sessionKey: '100',
      generationId: 'generation-not-durable',
      botName: 'bot-a',
      telegramChatId: '100',
      telegramMessageId: '42',
    }),
    (error) => error.code === 'CODEX_DISPATCH_BINDING_MISSING',
  );

  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: 'generation-not-durable',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-not-durable',
    method: 'thread/start',
  });
  assert.throws(
    () => controller.settleQueuedDispatch({
      sessionKey: '100',
      generationId: 'generation-not-durable',
      reservationId: 'wrong-reservation',
      attemptId: 'queued-attempt',
      botName: 'bot-a',
      telegramChatId: '100',
      telegramMessageId: '42',
    }),
    (error) => error.code === 'CODEX_QUEUE_SETTLEMENT_CONFLICT',
  );
  assert.throws(
    () => controller.claimDispatchReservation({
      sessionKey: '100',
      generationId: 'generation-stale',
      botName: 'bot-a',
      telegramChatId: '100',
      telegramMessageId: '42',
    }),
    (error) => error.code === 'CODEX_DISPATCH_BINDING_MISSING',
  );
  proc.closed = true;
  assert.throws(
    () => controller.markDispatchDisposition({
      sessionKey: '100',
      generationId: 'generation-not-durable',
      reservationId: 'reservation-a',
      disposition: 'cancelled',
    }),
    (error) => error.code === 'CODEX_DISPATCH_BINDING_MISSING',
  );
  assert.equal(
    calls.some((entry) => entry[0] === 'claim-dispatch'),
    false,
  );
});

test('replaces prepared catalog state when the Codex auth file changes', async () => {
  const { calls, controller } = fixture({
    homeAttestations: [
      {
        authFingerprint: { ino: 'auth-1' },
        configFingerprint: { ino: 'config-1' },
      },
      {
        authFingerprint: { ino: 'auth-2' },
        configFingerprint: { ino: 'config-1' },
      },
    ],
  });

  const first = await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const second = await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });

  assert.notEqual(second, first);
  const preflights = calls.filter((entry) => entry[0] === 'model-preflight');
  assert.equal(preflights.length, 2);
  assert.notEqual(
    preflights[1][2].deploymentIdentity,
    preflights[0][2].deploymentIdentity,
  );
  assert.deepEqual(
    calls.filter((entry) => entry[0] === 'model-invalidate'),
    [[
      'model-invalidate',
      { deploymentIdentity: preflights[0][2].deploymentIdentity },
    ]],
  );
});

test('a transient credential-home read error keeps the valid prepared receipt', async () => {
  const transient = Object.assign(
    new Error('temporary credential-home read failure'),
    { code: 'EIO' },
  );
  const { calls, controller } = fixture({
    homeAttestations: [
      {
        authFingerprint: { ino: 'auth-1' },
        configFingerprint: { ino: 'config-1' },
      },
      transient,
      {
        authFingerprint: { ino: 'auth-1' },
        configFingerprint: { ino: 'config-1' },
      },
    ],
  });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });

  await assert.rejects(
    controller.prepareSession({
      sessionKey: '100',
      chatId: '100',
    }),
    transient,
  );
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });

  assert.equal(
    calls.filter((entry) => entry[0] === 'model-preflight').length,
    1,
  );
  assert.equal(
    calls.filter((entry) => entry[0] === 'model-invalidate').length,
    0,
  );
});

test('model changes reuse the authenticated static receipt and preflight', async () => {
  const config = {
    codex: {
      home: '/srv/codex-home',
      daemonSecretRoots: ['/srv/polygram'],
    },
    defaults: { codexEnabled: true },
    chats: {
      '100': {
        pm: 'codex',
        cwd: '/srv/workspace',
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'xhigh',
      },
    },
  };
  const { calls, controller, receipt } = fixture({
    configOverride: config,
    catalogModels: [
      {
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh'],
      },
      {
        model: 'gpt-5.5-codex',
        displayName: 'GPT-5.5 Codex',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
    controllerOptions: {
      resolveRuntime: ({ config: currentConfig, chatId, codexAvailability }) => {
        const selected = currentConfig.chats[chatId];
        return Object.freeze({
          runtime: 'codex',
          backend: 'codex',
          spawnProfileId: codexAvailability.receipt.spawnProfileId,
          model: selected.codexModel,
          effort: selected.codexEffort,
          cwd: selected.cwd,
        });
      },
    },
  });

  const first = await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  config.chats['100'].codexModel = 'gpt-5.5-codex';
  config.chats['100'].codexEffort = 'low';
  const second = await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });

  assert.equal(first.runtimeConfig.spawnProfileId, receipt.spawnProfileId);
  assert.equal(second.runtimeConfig.spawnProfileId, receipt.spawnProfileId);
  assert.deepEqual(
    {
      model: second.runtimeConfig.model,
      effort: second.runtimeConfig.effort,
    },
    { model: 'gpt-5.5-codex', effort: 'low' },
  );
  assert.equal(
    calls.filter((entry) => entry[0] === 'prepare-profile').length,
    1,
  );
  assert.equal(
    calls.filter((entry) => entry[0] === 'model-preflight').length,
    1,
  );
});

test('expired catalogs block a turn when the durable model disappeared', async () => {
  let currentTime = 1_000;
  const unavailable = Object.assign(
    new Error('Requested Codex model is unavailable'),
    { code: 'CODEX_MODEL_UNAVAILABLE' },
  );
  const config = {
    codex: {
      home: '/srv/codex-home',
      daemonSecretRoots: ['/srv/polygram'],
    },
    defaults: { codexEnabled: true },
    chats: {
      '100': {
        pm: 'codex',
        cwd: '/srv/workspace',
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'xhigh',
      },
    },
  };
  const { calls, controller } = fixture({
    configOverride: config,
    catalogSnapshots: [[{
      model: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['high', 'xhigh'],
    }], unavailable],
    controllerOptions: {
      catalogMaxAgeMs: 10,
      now: () => currentTime,
    },
  });

  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  currentTime += 11;

  await assert.rejects(
    controller.prepareSession({
      sessionKey: '100',
      chatId: '100',
    }),
    { code: 'CODEX_MODEL_UNAVAILABLE' },
  );
  assert.deepEqual(
    {
      model: config.chats['100'].codexModel,
      effort: config.chats['100'].codexEffort,
    },
    {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    },
  );
  assert.equal(
    calls.filter((entry) => entry[0] === 'model-preflight').length,
    2,
  );
  assert.equal(
    calls.filter((entry) => entry[0] === 'model-invalidate').length,
    1,
  );
});

test('catalog capability drift requires a controlled warm-process replacement', async () => {
  let currentTime = 1_000;
  const originalModels = [{
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['high', 'xhigh'],
  }];
  const { controller, receipt } = fixture({
    catalogSnapshots: [
      originalModels,
      [...originalModels, {
        model: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium', 'high'],
      }],
    ],
    controllerOptions: {
      catalogMaxAgeMs: 10,
      now: () => currentTime,
    },
  });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-catalog',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);
  assert.equal(
    controller.processReplacementReason('100', proc),
    null,
  );

  currentTime += 11;
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });

  assert.equal(
    controller.processReplacementReason('100', proc),
    'model-catalog-drift',
  );
  assert.equal(
    controller.requiresProcessReplacement('100', proc),
    true,
  );
});

test('reports credential drift only for the exact registered Codex process', async () => {
  const { controller, receipt } = fixture({
    homeAttestations: [
      {
        authFingerprint: { ino: 'auth-1' },
        configFingerprint: { ino: 'config-1' },
      },
      {
        authFingerprint: { ino: 'auth-2' },
        configFingerprint: { ino: 'config-1' },
      },
    ],
  });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const first = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-first',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(first);
  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: 'generation-first',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-first',
    method: 'thread/start',
  });
  assert.equal(
    controller.requiresProcessReplacement('100', first),
    false,
  );

  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  assert.equal(
    controller.requiresProcessReplacement('100', first),
    true,
  );

  const replacement = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-replacement',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(replacement);
  assert.equal(
    controller.requiresProcessReplacement('100', replacement),
    false,
  );

  first.startupReleaseSafe = true;
  first.closed = true;
  first.emit('close');
  assert.equal(
    controller.requiresProcessReplacement('100', replacement),
    false,
  );
  assert.throws(
    () => controller.requiresProcessReplacement('100', first),
    (error) => (
      error instanceof CodexRuntimeControllerError
      && error.code === 'CODEX_PROCESS_CREDENTIAL_BINDING_MISSING'
    ),
  );
  assert.throws(
    () => controller.requiresProcessReplacement('100', {
      runtime: 'codex',
      sessionKey: '100',
      generationId: 'generation-unknown',
    }),
    (error) => (
      error instanceof CodexRuntimeControllerError
      && error.code === 'CODEX_PROCESS_CREDENTIAL_BINDING_MISSING'
    ),
  );
});

test('settles Telegram delivery only for the exact registered Codex result', async () => {
  const attempt = {
    attempt_id: 'attempt-delivery',
    generation_id: 'generation-delivery',
    session_key: '100',
    thread_id: 'thread-delivery',
    turn_id: 'turn-delivery',
  };
  const {
    checkpointPayloads,
    controller,
    receipt,
  } = fixture({ codexAttempt: attempt });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: attempt.generation_id,
    providerSessionId: attempt.thread_id,
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);
  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: attempt.generation_id,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: attempt.attempt_id,
    method: 'turn/start',
  });
  const result = {
    runtime: 'codex',
    backend: 'codex',
    generationId: attempt.generation_id,
    attemptId: attempt.attempt_id,
    providerSessionId: attempt.thread_id,
    providerTurnId: attempt.turn_id,
  };

  assert.deepEqual(
    await controller.settleTelegramDelivery('100', result),
    {
      committed: true,
      disposition: 'delivered',
      generationId: 'generation-delivery',
      attemptId: 'attempt-delivery',
    },
  );
  await controller.settleTelegramDelivery('100', result);

  assert.deepEqual(
    checkpointPayloads.slice(-2).map(({ ts, ...payload }) => {
      assert.equal(Number.isSafeInteger(ts), true);
      return payload;
    }),
    [0, 1].map(() => ({
      kind: 'telegram-delivery-settled',
      generationId: 'generation-delivery',
      hostIdentity: 'host:current',
      bootSessionIdentity: 'boot:current',
      attemptId: 'attempt-delivery',
      threadId: 'thread-delivery',
      turnId: 'turn-delivery',
    })),
  );
});

test('persists an explicit failed delivery disposition for the exact registered result', async () => {
  const attempt = {
    attempt_id: 'attempt-delivery-failed',
    generation_id: 'generation-delivery-failed',
    session_key: '100',
    thread_id: 'thread-delivery-failed',
    turn_id: 'turn-delivery-failed',
  };
  const {
    checkpointPayloads,
    controller,
    receipt,
  } = fixture({ codexAttempt: attempt });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: attempt.generation_id,
    providerSessionId: attempt.thread_id,
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);
  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: attempt.generation_id,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: attempt.attempt_id,
    method: 'turn/start',
  });
  const result = {
    runtime: 'codex',
    backend: 'codex',
    generationId: attempt.generation_id,
    attemptId: attempt.attempt_id,
    providerSessionId: attempt.thread_id,
    providerTurnId: attempt.turn_id,
  };

  assert.deepEqual(
    await controller.settleTelegramDelivery(
      '100',
      result,
      { disposition: 'failed' },
    ),
    {
      committed: true,
      disposition: 'failed',
      generationId: attempt.generation_id,
      attemptId: attempt.attempt_id,
    },
  );
  assert.equal(
    checkpointPayloads.at(-1).kind,
    'telegram-delivery-failed',
  );
  await assert.rejects(
    controller.settleTelegramDelivery(
      '100',
      result,
      { disposition: 'unknown' },
    ),
    (error) => error.code === 'CODEX_DELIVERY_DISPOSITION_INVALID',
  );
});

test('delivery checkpoint failure fences the exact live generation before preserving the original error', async () => {
  const attempt = {
    attempt_id: 'attempt-delivery-checkpoint-failure',
    generation_id: 'generation-delivery-checkpoint-failure',
    session_key: '100',
    thread_id: 'thread-delivery-checkpoint-failure',
    turn_id: 'turn-delivery-checkpoint-failure',
  };
  const {
    calls,
    controller,
    db,
    receipt,
  } = fixture({ codexAttempt: attempt });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const blocked = [];
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    backend: 'codex',
    sessionKey: '100',
    generationId: attempt.generation_id,
    providerSessionId: attempt.thread_id,
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
    blockDurability(error) {
      blocked.push(error);
      this.state = 'DurabilityBlocked';
      return true;
    },
  });
  controller.registerProcess(proc);
  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: attempt.generation_id,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: attempt.attempt_id,
    method: 'turn/start',
  });
  const checkpointError = Object.assign(
    new Error('delivery checkpoint unavailable'),
    { code: 'SQLITE_IOERR' },
  );
  const recordCheckpoint = db.recordCodexCheckpoint.bind(db);
  db.recordCodexCheckpoint = (checkpoint) => {
    if (checkpoint.kind === 'telegram-delivery-settled') {
      throw checkpointError;
    }
    return recordCheckpoint(checkpoint);
  };
  const result = {
    runtime: 'codex',
    backend: 'codex',
    generationId: attempt.generation_id,
    attemptId: attempt.attempt_id,
    providerSessionId: attempt.thread_id,
    providerTurnId: attempt.turn_id,
  };

  await assert.rejects(
    controller.settleTelegramDelivery('100', result),
    (error) => error === checkpointError,
  );

  assert.deepEqual(blocked, [checkpointError]);
  assert.equal(proc.state, 'DurabilityBlocked');
  assert.equal(
    calls.filter((entry) => entry[0] === 'claim-dispatch').length,
    0,
  );
  assert.throws(
    () => controller.claimDispatchReservation({
      sessionKey: '100',
      generationId: attempt.generation_id,
      botName: 'bot-a',
      telegramChatId: '100',
      telegramMessageId: '43',
    }),
    (error) => error.code === 'CODEX_DURABILITY_FAILED',
  );
  await assert.rejects(
    controller.settleTelegramDelivery('100', result),
    (error) => error === checkpointError,
    'in-process retry must retain the original durable recovery fence',
  );
  assert.deepEqual(blocked, [checkpointError]);
});

test('real SQLite delivery settlement is idempotent through the controller', async (t) => {
  const scratch = mkdtempSync(path.join(
    os.tmpdir(),
    'polygram-codex-delivery-',
  ));
  const db = dbClient.open(path.join(scratch, 'delivery.db'));
  t.after(() => {
    db.raw.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const { controller, receipt } = fixture({ dbOverride: db });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-delivery-real',
    providerSessionId: 'thread-delivery-real',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);
  const owner = {
    generationId: proc.generationId,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-delivery-real',
    threadId: proc.providerSessionId,
  };
  await controller.checkpointSink({
    ...owner,
    kind: 'request-prepared',
    method: 'turn/start',
  });
  await controller.checkpointSink({
    ...owner,
    kind: 'request-write-attempted',
    requestId: 'request-delivery-real',
  });
  await controller.checkpointSink({
    ...owner,
    kind: 'request-response-observed',
    requestId: 'request-delivery-real',
    outcome: 'result',
  });
  await controller.checkpointSink({
    ...owner,
    kind: 'turn-accepted',
    turnId: 'turn-delivery-real',
  });
  await controller.checkpointSink({
    ...owner,
    kind: 'turn-terminal',
    turnId: 'turn-delivery-real',
    terminalStatus: 'completed',
  });
  await controller.checkpointSink({
    ...owner,
    kind: 'stop-terminal-reconciled',
    turnId: 'turn-delivery-real',
  });
  await controller.checkpointSink({
    ...owner,
    kind: 'stop-empty-registry-observed',
    turnId: 'turn-delivery-real',
  });
  const result = {
    runtime: 'codex',
    backend: 'codex',
    generationId: proc.generationId,
    attemptId: owner.attemptId,
    providerSessionId: proc.providerSessionId,
    providerTurnId: 'turn-delivery-real',
  };

  await controller.settleTelegramDelivery('100', result);
  await controller.settleTelegramDelivery('100', result);

  assert.equal(db.getCodexAttempt(owner.attemptId).recovery_state, 'settled');
  assert.equal(
    db.getCodexLease().status,
    'active',
    'delivery cannot retire a generation before transport closure and verification',
  );
  assert.equal(
    db.listCodexAttemptCheckpoints(owner.attemptId)
      .filter((checkpoint) => (
        checkpoint.kind === 'telegram-delivery-settled'
      ))
      .length,
    1,
  );
});

test('rejects malformed, mismatched, stale, and Claude delivery results', async () => {
  const attempts = new Map([
    ['attempt-first', {
      attempt_id: 'attempt-first',
      generation_id: 'generation-first',
      session_key: '100',
      thread_id: 'thread-first',
      turn_id: 'turn-first',
    }],
    ['attempt-replacement', {
      attempt_id: 'attempt-replacement',
      generation_id: 'generation-replacement',
      session_key: '100',
      thread_id: 'thread-replacement',
      turn_id: 'turn-replacement',
    }],
  ]);
  const { controller, receipt } = fixture({
    codexAttempt: (attemptId) => attempts.get(attemptId),
  });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const first = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-first',
    providerSessionId: 'thread-first',
    spawnProfileId: receipt.spawnProfileId,
    closed: false,
  });
  controller.registerProcess(first);
  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: 'generation-first',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-first',
    method: 'turn/start',
  });
  const validFirst = {
    runtime: 'codex',
    backend: 'codex',
    generationId: 'generation-first',
    attemptId: 'attempt-first',
    providerSessionId: 'thread-first',
    providerTurnId: 'turn-first',
  };

  for (const [field, value] of [
    ['generationId', ''],
    ['attemptId', 'x'.repeat(513)],
    ['providerSessionId', null],
    ['providerTurnId', 42],
  ]) {
    await assert.rejects(
      controller.settleTelegramDelivery('100', {
        ...validFirst,
        [field]: value,
      }),
      (error) => (
        error instanceof CodexRuntimeControllerError
        && error.code === 'CODEX_DELIVERY_RESULT_INVALID'
      ),
    );
  }

  for (const changed of [
    { providerSessionId: 'thread-other' },
    { providerTurnId: 'turn-other' },
    { attemptId: 'attempt-unknown' },
  ]) {
    await assert.rejects(
      controller.settleTelegramDelivery('100', {
        ...validFirst,
        ...changed,
      }),
      (error) => (
        error instanceof CodexRuntimeControllerError
        && error.code === 'CODEX_DELIVERY_IDENTITY_MISMATCH'
      ),
    );
  }

  const replacement = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-replacement',
    providerSessionId: 'thread-replacement',
    spawnProfileId: receipt.spawnProfileId,
    closed: false,
  });
  controller.registerProcess(replacement);
  await assert.rejects(
    controller.settleTelegramDelivery('100', validFirst),
    (error) => (
      error instanceof CodexRuntimeControllerError
      && error.code === 'CODEX_DELIVERY_BINDING_MISSING'
    ),
  );
  await assert.rejects(
    controller.settleTelegramDelivery('100', {
      runtime: 'codex',
      backend: 'codex',
      generationId: 'generation-claude',
      attemptId: 'attempt-first',
      providerSessionId: 'thread-first',
      providerTurnId: 'turn-first',
    }),
    (error) => (
      error instanceof CodexRuntimeControllerError
      && error.code === 'CODEX_DELIVERY_BINDING_MISSING'
    ),
  );
});

test('ignores explicitly non-Codex delivery results without reading bindings', async () => {
  const { calls, checkpointPayloads, controller } = fixture();

  assert.equal(
    await controller.settleTelegramDelivery(null, {
      runtime: 'claude',
      backend: 'sdk',
      generationId: 'not-a-codex-generation',
    }),
    undefined,
  );
  assert.equal(
    calls.some((entry) => entry[0] === 'get-attempt'),
    false,
  );
  assert.deepEqual(checkpointPayloads, []);
});

test('restores durable ownership before preparing an exact Codex session', async () => {
  const { calls, controller, receipt } = fixture();

  const initialized = controller.initialize();
  assert.deepEqual(
    {
      ...initialized.managerOptions,
      codexRetirementVerifier:
        typeof initialized.managerOptions.codexRetirementVerifier,
    },
    {
      codexHostIdentity: 'host:current',
      codexBootSessionIdentity: 'boot:current',
      codexRecoveryState: { status: 'clear' },
      codexRetirementVerifier: 'function',
    },
  );

  const prepared = await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  assert.equal(prepared.runtimeConfig.spawnProfileId, receipt.spawnProfileId);
  assert.equal(
    controller.resolveReceipt('100', {
      runtime: 'codex',
      spawnProfileId: receipt.spawnProfileId,
    }),
    receipt,
  );
  assert.ok(calls.some((entry) => entry[0] === 'prepare-profile'));
  assert.ok(calls.some((entry) => entry[0] === 'model-preflight'));
  assert.deepEqual(
    await controller.resolveRuntimeView({
      sessionKey: '100',
      chatId: '100',
      threadId: null,
    }),
    {
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      models: [{
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh'],
      }],
      efforts: ['high', 'xhigh'],
    },
  );
});

test('prospective Codex preflight is cached without changing the configured Claude runtime', async () => {
  const config = {
    codex: {
      home: '/srv/codex-home',
      daemonSecretRoots: ['/srv/polygram'],
    },
    defaults: { codexEnabled: true },
    chats: {
      '100': {
        pm: 'sdk',
        cwd: '/srv/workspace',
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'xhigh',
      },
    },
  };
  const { calls, controller } = fixture({ configOverride: config });

  assert.deepEqual(
    await controller.resolveCandidateRuntimeView({
      sessionKey: '100',
      chatId: '100',
    }),
    {
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      models: [{
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh'],
      }],
      efforts: ['high', 'xhigh'],
    },
  );
  assert.equal(config.chats['100'].pm, 'sdk');
  assert.equal(
    await controller.prepareSession({
      sessionKey: '100',
      chatId: '100',
    }),
    null,
  );

  config.chats['100'].pm = 'codex';
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });

  assert.equal(
    calls.filter((entry) => entry[0] === 'prepare-profile').length,
    1,
  );
  assert.equal(
    calls.filter((entry) => entry[0] === 'model-preflight').length,
    1,
  );
});

test('unused prospective Codex preflight can be discarded without touching config', async () => {
  const config = {
    codex: {
      home: '/srv/codex-home',
      daemonSecretRoots: ['/srv/polygram'],
    },
    defaults: { codexEnabled: true },
    chats: {
      '100': {
        pm: 'sdk',
        cwd: '/srv/workspace',
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'xhigh',
      },
    },
  };
  const { calls, controller, receipt } = fixture({ configOverride: config });
  await controller.resolveCandidateRuntimeView({
    sessionKey: '100',
    chatId: '100',
  });

  assert.equal(controller.discardCandidateRuntime('100'), true);
  assert.equal(config.chats['100'].pm, 'sdk');
  assert.throws(
    () => controller.resolveReceipt('100', {
      runtime: 'codex',
      spawnProfileId: receipt.spawnProfileId,
    }),
    { code: 'CODEX_PREFLIGHT_RECEIPT_MISSING' },
  );
  assert.equal(
    calls.filter((entry) => entry[0] === 'model-invalidate').length,
    0,
    'discarding one unused session receipt must retain the shared catalog',
  );
});

test('candidate discard refuses a receipt bound to a registered Codex process', async () => {
  const { controller, receipt } = fixture();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-candidate-bound',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);

  assert.equal(controller.discardCandidateRuntime('100'), false);
  assert.equal(
    controller.resolveReceipt('100', {
      runtime: 'codex',
      spawnProfileId: receipt.spawnProfileId,
    }),
    receipt,
  );
});

test('normal prepare revalidates configured Codex selection after candidate preflight', async () => {
  const config = {
    codex: {
      home: '/srv/codex-home',
      daemonSecretRoots: ['/srv/polygram'],
    },
    defaults: { codexEnabled: true },
    chats: {
      '100': {
        pm: 'sdk',
        cwd: '/srv/workspace',
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'xhigh',
      },
    },
  };
  const { controller } = fixture({
    configOverride: config,
    controllerOptions: {
      resolveRuntime: ({ config: currentConfig, codexAvailability }) => {
        const selected = currentConfig.chats['100'];
        if (selected.pm !== 'codex') {
          return Object.freeze({ runtime: 'claude', backend: 'sdk' });
        }
        return Object.freeze({
          runtime: 'codex',
          backend: 'codex',
          spawnProfileId: codexAvailability.receipt.spawnProfileId,
          model: selected.codexModel,
          effort: selected.codexEffort,
          cwd: selected.cwd,
        });
      },
    },
  });
  await controller.resolveCandidateRuntimeView({
    sessionKey: '100',
    chatId: '100',
  });

  config.chats['100'].pm = 'codex';
  const preparing = controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
  });
  config.chats['100'].pm = 'sdk';

  await assert.rejects(
    preparing,
    { code: 'CODEX_PREFLIGHT_PROFILE_MISMATCH' },
  );
});

test('constructs the app-server client only from the preflighted static profile', async () => {
  const { clientOptions, controller, receipt } = fixture();
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });

  const onNotification = () => {};
  const onFault = () => {};
  controller.clientFactory({
    sessionKey: '100',
    expectedStaticProfile: receipt.expectedStaticProfile,
    onNotification,
    onFault,
  });

  assert.deepEqual(clientOptions, [{
    binary: '/opt/codex',
    codexHome: '/srv/codex-home',
    cwd: '/srv/workspace',
    env: { PATH: '/usr/bin:/bin' },
    expectedConfigSha256: 'b'.repeat(64),
    onNotification,
    onFault,
  }]);
});

test('constructs a contained app-server client with the attested launcher receipt', async () => {
  const launcher = '/usr/local/libexec/claude-session-scope';
  const launcherSha256 = 'd'.repeat(64);
  const { clientOptions, controller, receipt } = fixture({
    staticProfileExtras: {
      sessionLauncher: launcher,
      sessionLauncherSha256: launcherSha256,
    },
    controllerOptions: { sessionLauncher: launcher },
  });
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });

  controller.clientFactory({
    sessionKey: '100',
    expectedStaticProfile: receipt.expectedStaticProfile,
    onNotification() {},
    onFault() {},
  });

  assert.equal(clientOptions[0].sessionLauncher, launcher);
  assert.equal(
    clientOptions[0].expectedSessionLauncherSha256,
    launcherSha256,
  );
});

test('first prepared checkpoint atomically establishes durable generation ownership', async () => {
  const { calls, controller, receipt } = fixture();
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-a',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);

  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: 'generation-a',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-a',
    method: 'thread/start',
  });
  let writeCommitted = false;
  await controller.checkpointSink(Object.defineProperty({
    kind: 'request-write-attempted',
    generationId: 'generation-a',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-a',
    method: 'thread/start',
  }, 'markWriteCommitted', {
    enumerable: false,
    value() {
      assert.ok(calls.some((entry) => (
        Array.isArray(entry)
        && entry[0] === 'checkpoint'
        && entry[1] === 'request-write-attempted'
      )));
      writeCommitted = true;
      calls.push('write-marker');
    },
  }));

  assert.equal(writeCommitted, true);
  assert.deepEqual(calls.slice(-2), [
    ['checkpoint', 'request-write-attempted'],
    'write-marker',
  ]);
  const firstKinds = calls.map((entry) => (
    Array.isArray(entry) ? entry[0] : entry
  ));
  assert.deepEqual(
    firstKinds.slice(firstKinds.indexOf('transaction:start')),
    [
      'transaction:start',
      'create-generation',
      'checkpoint',
      'acquire-lease',
      'transaction:commit',
      'checkpoint',
      'write-marker',
    ],
  );
});

test('thread-accepted-before-startup-failure settles before the first durable checkpoint', async () => {
  const { calls, controller, receipt } = fixture();
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-before-first-checkpoint',
    providerSessionId: 'thread-rejected-before-startup',
    appServerSessionId: 'app-server-rejected-before-startup',
    containmentReason: 'thread-accepted-before-startup-failure',
    state: 'ContainmentFailed',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);

  assert.deepEqual(
    await controller.checkpointSink({
      kind: 'containment-cleanup-completed',
      generationId: proc.generationId,
      hostIdentity: 'host:current',
      bootSessionIdentity: 'boot:current',
      threadId: proc.providerSessionId,
      appServerSessionId: proc.appServerSessionId,
      reason: proc.containmentReason,
      ts: 1200,
    }),
    {
      committed: true,
      disposition: 'failed-settled',
      generationId: proc.generationId,
    },
  );
  assert.deepEqual(
    calls.find((entry) => entry[0] === 'settle-failed-generation'),
    [
      'settle-failed-generation',
      {
        generation_id: proc.generationId,
        session_key: proc.sessionKey,
        stable_host_id: 'host:current',
        incident_boot_session_id: 'boot:current',
        current_boot_session_id: 'boot:current',
        provider_session_id: proc.providerSessionId,
        app_server_session_id: proc.appServerSessionId,
        reason: proc.containmentReason,
        source: 'managed-group-empty',
        allow_missing_generation: true,
        ts: 1200,
      },
    ],
  );
  assert.equal(
    controller.discardCandidateRuntime(proc.sessionKey),
    false,
    'the settled process and its matching preflight receipt are already gone',
  );
  proc.closed = true;
  proc.emit('close', 1, {
    backend: 'codex',
    generationId: proc.generationId,
    reason: 'containment-cleanup',
    containmentReason: proc.containmentReason,
    containmentCleanupCommitted: true,
  });
  assert.equal(calls.some((entry) => entry[0] === 'retire'), false);
});

test('containment cleanup requires the process to retain exact host and boot ownership', async () => {
  const { calls, controller, receipt } = fixture();
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-missing-process-owner',
    providerSessionId: 'thread-missing-process-owner',
    appServerSessionId: 'app-server-missing-process-owner',
    containmentReason: 'startup-failed',
    state: 'ContainmentFailed',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);

  await assert.rejects(
    controller.checkpointSink({
      kind: 'containment-cleanup-completed',
      generationId: proc.generationId,
      hostIdentity: 'host:current',
      bootSessionIdentity: 'boot:current',
      threadId: proc.providerSessionId,
      appServerSessionId: proc.appServerSessionId,
      reason: proc.containmentReason,
      ts: 1200,
    }),
    (error) => error.code === 'CODEX_CHECKPOINT_STALE_GENERATION',
  );
  assert.equal(
    calls.some((entry) => entry[0] === 'settle-failed-generation'),
    false,
  );
});

test('retirement waits for healthy stop, transport close, and the manager handshake', async () => {
  const { calls, controller, receipt } = fixture();
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-a',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);
  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: 'generation-a',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-a',
    method: 'thread/start',
  });

  proc.closed = true;
  proc.emit('close');
  assert.equal(calls.some((entry) => entry[0] === 'retire'), false);

  await controller.checkpointSink({
    kind: 'stop-empty-registry-observed',
    generationId: 'generation-a',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
  });
  assert.equal(calls.some((entry) => entry[0] === 'retire'), false);

  const outcome = await controller.verifyCodexRetirement({
    sessionKey: '100',
    generationId: 'generation-a',
    reason: 'kill',
    terminalStatus: null,
    turnId: null,
  });
  assert.deepEqual(outcome, {
    committed: true,
    disposition: 'retired',
  });
  assert.equal(calls.filter((entry) => entry[0] === 'retire').length, 1);
});

test('an aborted retirement verifier keeps late delivery from releasing the durable lease', async () => {
  const attempt = {
    attempt_id: 'attempt-retirement-timeout',
    generation_id: 'generation-retirement-timeout',
    session_key: '100',
    thread_id: 'thread-retirement-timeout',
    turn_id: 'turn-retirement-timeout',
  };
  const { calls, controller, db, receipt } = fixture({
    codexAttempt: attempt,
  });
  db.settleCodexStoppedGeneration = () => ({
    changes: 0,
    disposition: 'pending-delivery',
  });
  db.markCodexGenerationRetired = () => {
    const error = new Error('delivery remains unresolved');
    error.code = 'CODEX_RETIREMENT_UNVERIFIED';
    throw error;
  };
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    backend: 'codex',
    sessionKey: '100',
    generationId: attempt.generation_id,
    providerSessionId: attempt.thread_id,
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);
  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: attempt.generation_id,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: attempt.attempt_id,
    method: 'turn/start',
  });
  await controller.checkpointSink({
    kind: 'stop-empty-registry-observed',
    generationId: attempt.generation_id,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
  });
  proc.closed = true;
  proc.emit('close');
  const abortController = new AbortController();
  const retirement = controller.verifyCodexRetirement({
    sessionKey: '100',
    generationId: attempt.generation_id,
    signal: abortController.signal,
  });

  abortController.abort(new Error('manager deadline elapsed'));
  await assert.rejects(
    Promise.race([
      retirement,
      new Promise((resolve, reject) => {
        setTimeout(
          () => reject(new Error('retirement ignored abort signal')),
          50,
        );
      }),
    ]),
    (error) => error.code === 'CODEX_RETIREMENT_VERIFICATION_ABORTED',
  );

  await controller.settleTelegramDelivery('100', {
    runtime: 'codex',
    backend: 'codex',
    generationId: attempt.generation_id,
    attemptId: attempt.attempt_id,
    providerSessionId: attempt.thread_id,
    providerTurnId: attempt.turn_id,
  });
  assert.equal(
    calls.some((entry) => entry[0] === 'retire'),
    false,
    'late delivery cannot release ownership after the manager deadline',
  );
});

test('real SQLite keeps the lease after an aborted verifier and late delivery', async (t) => {
  const scratch = mkdtempSync(path.join(
    os.tmpdir(),
    'polygram-codex-aborted-retirement-',
  ));
  const db = dbClient.open(path.join(scratch, 'retirement.db'));
  t.after(() => {
    db.raw.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const { controller, receipt } = fixture({ dbOverride: db });
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    backend: 'codex',
    sessionKey: '100',
    generationId: 'generation-aborted-real',
    providerSessionId: 'thread-aborted-real',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);
  const owner = {
    generationId: proc.generationId,
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-aborted-real',
    threadId: proc.providerSessionId,
  };
  for (const checkpoint of [
    {
      kind: 'request-prepared',
      method: 'turn/start',
    },
    {
      kind: 'request-write-attempted',
      method: 'turn/start',
      requestId: 'request-aborted-real',
    },
    {
      kind: 'request-response-observed',
      method: 'turn/start',
      requestId: 'request-aborted-real',
      outcome: 'result',
    },
    {
      kind: 'turn-accepted',
      turnId: 'turn-aborted-real',
    },
    {
      kind: 'turn-terminal',
      turnId: 'turn-aborted-real',
      terminalStatus: 'completed',
    },
    {
      kind: 'stop-terminal-reconciled',
      turnId: 'turn-aborted-real',
    },
    {
      kind: 'stop-empty-registry-observed',
      turnId: 'turn-aborted-real',
    },
  ]) {
    await controller.checkpointSink({ ...owner, ...checkpoint });
  }
  proc.closed = true;
  proc.emit('close');

  const abortController = new AbortController();
  const retirement = controller.verifyCodexRetirement({
    sessionKey: proc.sessionKey,
    generationId: proc.generationId,
    terminalStatus: 'completed',
    turnId: 'turn-aborted-real',
    signal: abortController.signal,
  });
  abortController.abort(new Error('manager deadline elapsed'));
  await assert.rejects(
    retirement,
    (error) => error.code === 'CODEX_RETIREMENT_VERIFICATION_ABORTED',
  );

  await controller.settleTelegramDelivery(proc.sessionKey, {
    runtime: 'codex',
    backend: 'codex',
    generationId: proc.generationId,
    attemptId: owner.attemptId,
    providerSessionId: proc.providerSessionId,
    providerTurnId: 'turn-aborted-real',
  });
  assert.equal(db.getCodexAttempt(owner.attemptId).recovery_state, 'settled');
  assert.equal(db.getCodexLease().status, 'active');
  assert.equal(
    db.raw.prepare(`
      SELECT state FROM codex_generations WHERE generation_id = ?
    `).get(proc.generationId).state,
    'healthy-stopped',
  );
});

test('persisted containment blocks preflight and carries incident ownership to manager', async () => {
  const { controller } = fixture({ recoveryStatus: 'quarantined' });
  const initialized = controller.initialize();
  assert.deepEqual(initialized.managerOptions.codexRecoveryState, {
    status: 'quarantined',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    generationId: 'incident-generation',
  });
  await assert.rejects(
    controller.prepareSession({
      sessionKey: '100',
      chatId: '100',
      threadId: null,
    }),
    (error) => (
      error instanceof CodexRuntimeControllerError
      && error.code === 'CODEX_RECOVERY_BLOCKED'
    ),
  );
});

test('real SQLite transaction commits generation, prepared attempt, and lease together', async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'polygram-codex-controller-'));
  const dbPath = path.join(scratch, 'controller.db');
  const db = dbClient.open(dbPath);
  t.after(() => {
    db.raw.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const { controller, receipt } = fixture({ dbOverride: db });
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  const proc = Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-real',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  });
  controller.registerProcess(proc);

  await controller.checkpointSink({
    kind: 'request-prepared',
    generationId: 'generation-real',
    hostIdentity: 'host:current',
    bootSessionIdentity: 'boot:current',
    attemptId: 'attempt-real',
    method: 'thread/start',
  });

  assert.equal(
    db.raw.prepare(`
      SELECT state FROM codex_generations WHERE generation_id = ?
    `).get('generation-real').state,
    'active',
  );
  assert.equal(db.getCodexAttempt('attempt-real').delivery_state, 'prepared');
  assert.deepEqual(
    {
      generation_id: db.getCodexLease().generation_id,
      status: db.getCodexLease().status,
    },
    {
      generation_id: 'generation-real',
      status: 'active',
    },
  );
});

test('failed durable lease acquisition rolls back generation and prepared attempt', async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'polygram-codex-rollback-'));
  const db = dbClient.open(path.join(scratch, 'rollback.db'));
  t.after(() => {
    db.raw.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const { controller, receipt } = fixture({ dbOverride: db });
  controller.initialize();
  await controller.prepareSession({
    sessionKey: '100',
    chatId: '100',
    threadId: null,
  });
  controller.registerProcess(Object.assign(new EventEmitter(), {
    runtime: 'codex',
    sessionKey: '100',
    generationId: 'generation-rollback',
    spawnProfileId: receipt.spawnProfileId,
    startupReleaseSafe: false,
    closed: false,
  }));
  db.acquireCodexLease = () => {
    const error = new Error('lease rejected');
    error.code = 'CODEX_DAEMON_GENERATION_BUSY';
    throw error;
  };

  await assert.rejects(
    controller.checkpointSink({
      kind: 'request-prepared',
      generationId: 'generation-rollback',
      hostIdentity: 'host:current',
      bootSessionIdentity: 'boot:current',
      attemptId: 'attempt-rollback',
      method: 'thread/start',
    }),
    (error) => error.code === 'CODEX_DAEMON_GENERATION_BUSY',
  );
  assert.equal(
    db.raw.prepare(`
      SELECT 1 FROM codex_generations WHERE generation_id = ?
    `).get('generation-rollback'),
    undefined,
  );
  assert.equal(db.getCodexAttempt('attempt-rollback'), undefined);
});

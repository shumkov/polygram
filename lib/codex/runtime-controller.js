'use strict';

const { createHash } = require('node:crypto');

const orchestraDefault = require('@shumkov/orchestra');
const { resolvePinnedCodexBinary } = require('./binary');
const { resolveCodexHostIdentity } = require('./host-identity');
const { CodexModelCatalog } = require('./model-catalog');
const {
  sanitizeCodexFaultProvenance,
} = require('./fault-provenance');
const {
  createCodexRuntimeProfileBuilder,
} = require('./runtime-profile');
const {
  createCodexRuntimeAvailability,
  resolveCodexRuntimeCandidate,
  resolveCodexRuntimeRequest,
  resolveRuntimeConfig,
} = require('../runtime-config');

const DEFAULT_CATALOG_MAX_AGE_MS = 15 * 60 * 1_000;

class CodexRuntimeControllerError extends Error {
  constructor(message, code, action, options) {
    super(message, options);
    this.name = 'CodexRuntimeControllerError';
    this.code = code;
    this.action = action;
  }
}

function controllerError(message, code, action, cause) {
  return new CodexRuntimeControllerError(
    message,
    code,
    action,
    cause ? { cause } : undefined,
  );
}

function boundedString(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > 4096
  ) {
    throw controllerError(
      `Codex ${label} must be a bounded non-empty string.`,
      'CODEX_DEPLOYMENT_CONFIG_INVALID',
      'Configure the dedicated Codex deployment before selecting pm:codex.',
    );
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function sameProfileRequest(profile, request) {
  return profile?.cwd === request.cwd;
}

function catalogSupports(catalog, request) {
  if (!Array.isArray(catalog?.models)) return false;
  const matches = catalog.models.filter(
    (entry) => entry?.model === request.model,
  );
  return (
    matches.length === 1
    && Array.isArray(matches[0].supportedReasoningEfforts)
    && matches[0].supportedReasoningEfforts.includes(request.effort)
  );
}

function catalogCapabilityFingerprint(catalog) {
  return digest({
    runtimeVersion: catalog?.runtimeVersion ?? null,
    schemaVersion: catalog?.schemaVersion ?? null,
    models: catalog?.models ?? null,
  });
}

function credentialStateFingerprint(attestation) {
  if (
    !attestation
    || typeof attestation.configFingerprint !== 'object'
    || attestation.configFingerprint === null
    || (
      attestation.authFingerprint !== null
      && attestation.authFingerprint !== undefined
      && typeof attestation.authFingerprint !== 'object'
    )
  ) {
    throw controllerError(
      'Codex credential-state attestation was incomplete.',
      'CODEX_CREDENTIAL_STATE_INVALID',
      'Re-attest the dedicated Codex credential home before preflight.',
    );
  }
  return digest({
    authFingerprint: attestation.authFingerprint ?? null,
    configFingerprint: attestation.configFingerprint,
  });
}

function deliveryResultString(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 512
  ) {
    throw controllerError(
      `Codex delivery ${label} must be a bounded non-empty string.`,
      'CODEX_DELIVERY_RESULT_INVALID',
      'Discard the malformed result without settling durable delivery.',
    );
  }
  return value;
}

async function resolveCodexStartupRecovery(pidClaim, {
  claimThrowsOnSurvivingPredecessor = false,
  persistedLeaseStatus = null,
  supervisorGraceMs = null,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const unproven = Object.freeze({
    exclusive_daemon_ownership: false,
    supervisor_grace_elapsed: false,
  });
  if (claimThrowsOnSurvivingPredecessor !== true) return unproven;

  const priorAction = pidClaim?.priorAction;
  const hasPersistedOwnership = ['active', 'quarantined'].includes(
    persistedLeaseStatus,
  );
  if (
    persistedLeaseStatus != null
    && persistedLeaseStatus !== 'clear'
    && !hasPersistedOwnership
  ) {
    return unproven;
  }
  if (priorAction === 'malformed-overwritten') return unproven;
  if (
    priorAction === 'self-skip'
    || (priorAction === 'no-prior' && !hasPersistedOwnership)
  ) {
    return Object.freeze({
      exclusive_daemon_ownership: true,
      supervisor_grace_elapsed: true,
    });
  }
  if (
    priorAction !== 'no-prior'
    && ![
      'stale-overwritten',
      'sigterm-killed',
      'sigkill-killed',
    ].includes(priorAction)
  ) {
    return unproven;
  }
  if (!Number.isSafeInteger(supervisorGraceMs) || supervisorGraceMs < 0) {
    return unproven;
  }
  await wait(supervisorGraceMs);
  return Object.freeze({
    exclusive_daemon_ownership: true,
    supervisor_grace_elapsed: true,
  });
}

function createCodexRuntimeController({
  config,
  db,
  processEnv = process.env,
  sessionLauncher = null,
  defaultDaemonSecretRoots = [],
  resolveHostIdentity = resolveCodexHostIdentity,
  resolveBinary = resolvePinnedCodexBinary,
  runtimeProfileBuilder = createCodexRuntimeProfileBuilder(),
  modelCatalog = new CodexModelCatalog(),
  attestCodexHome = orchestraDefault.attestPinnedCodexHome,
  createAvailability = createCodexRuntimeAvailability,
  resolveRuntime = resolveRuntimeConfig,
  resolveCandidate = resolveCodexRuntimeCandidate,
  resolveRequest = resolveCodexRuntimeRequest,
  orchestra = orchestraDefault,
  logger = console,
  preflightAdmissionTimeoutMs = 120_000,
  catalogMaxAgeMs = DEFAULT_CATALOG_MAX_AGE_MS,
  startupRecovery = Object.freeze({
    exclusive_daemon_ownership: false,
    supervisor_grace_elapsed: false,
  }),
  now = Date.now,
} = {}) {
  if (
    !config
    || !db
    || typeof db.reconstructCodexRecovery !== 'function'
    || typeof db.getCodexLease !== 'function'
    || typeof db.getCodexAttempt !== 'function'
    || typeof db.claimCodexDispatchReservation !== 'function'
    || typeof db.finalizeCodexAcceptedSteer !== 'function'
    || typeof db.markCodexDispatchDisposition !== 'function'
    || typeof db.settleCodexQueuedDispatch !== 'function'
    || typeof db.settleCodexStoppedGeneration !== 'function'
    || typeof db.settleCodexFailedGeneration !== 'function'
    || typeof db.prepareCodexCleanRetirement !== 'function'
    || typeof db.recordCodexDeliveryCheckpoint !== 'function'
    || typeof resolveHostIdentity !== 'function'
    || typeof resolveBinary !== 'function'
    || typeof runtimeProfileBuilder?.prepare !== 'function'
    || typeof modelCatalog?.preflight !== 'function'
    || typeof attestCodexHome !== 'function'
    || typeof createAvailability !== 'function'
    || typeof resolveRuntime !== 'function'
    || typeof resolveCandidate !== 'function'
    || typeof resolveRequest !== 'function'
    || typeof orchestra?.CodexAppServerClient !== 'function'
    || !Array.isArray(defaultDaemonSecretRoots)
    || !Number.isSafeInteger(preflightAdmissionTimeoutMs)
    || preflightAdmissionTimeoutMs <= 0
    || !Number.isSafeInteger(catalogMaxAgeMs)
    || catalogMaxAgeMs <= 0
    || typeof now !== 'function'
    || (
      sessionLauncher !== null
      && (
        typeof sessionLauncher !== 'string'
        || sessionLauncher.length === 0
        || /[\u0000-\u001f\u007f]/u.test(sessionLauncher)
      )
    )
  ) {
    throw new TypeError('Codex runtime controller dependencies are incomplete');
  }

  const receiptsBySession = new Map();
  const processesByGeneration = new Map();
  const currentProcessBySession = new Map();
  const retiredStopCancellations = new Map();
  const preparingByKey = new Map();
  let preflightAdmissionTail = Promise.resolve();
  let initialization = null;
  let initializationError = null;

  async function withPreflightAdmission(operation) {
    let release;
    const admitted = new Promise((resolve) => {
      release = resolve;
    });
    const predecessor = preflightAdmissionTail.catch(() => {});
    preflightAdmissionTail = predecessor.then(() => admitted);

    let timeout;
    try {
      await Promise.race([
        predecessor,
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => {
            reject(controllerError(
              'Codex native preflight admission timed out.',
              'CODEX_PREFLIGHT_ADMISSION_TIMEOUT',
              'Wait for the active Codex preflight to finish before retrying.',
            ));
          }, preflightAdmissionTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      release();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    try {
      return await operation();
    } finally {
      release();
    }
  }

  function rememberStopCancellation(binding) {
    retiredStopCancellations.set(binding.generationId, binding);
    while (retiredStopCancellations.size > 32) {
      retiredStopCancellations.delete(
        retiredStopCancellations.keys().next().value,
      );
    }
  }

  function invalidatePreparedSession(sessionKey, entry) {
    receiptsBySession.delete(sessionKey);
    if (
      entry?.deploymentIdentity
      && typeof modelCatalog.invalidate === 'function'
    ) {
      modelCatalog.invalidate({
        deploymentIdentity: entry.deploymentIdentity,
      });
    }
  }

  function prepareRuntimeView(entry, request, chatId, threadId) {
    const runtimeConfig = resolveRuntime({
      config,
      chatId,
      threadId,
      defaultPm: 'sdk',
      codexAvailability: entry.availability,
      logger,
    });
    if (
      runtimeConfig.runtime !== 'codex'
      || runtimeConfig.spawnProfileId !== entry.receipt.spawnProfileId
      || runtimeConfig.cwd !== request.cwd
      || runtimeConfig.model !== request.model
      || runtimeConfig.effort !== request.effort
    ) {
      throw controllerError(
        'Codex runtime selection changed during preflight.',
        'CODEX_PREFLIGHT_PROFILE_MISMATCH',
        'Retry after configuration changes settle.',
      );
    }
    return Object.freeze({
      runtimeConfig,
      availability: entry.availability,
      catalog: entry.catalog,
    });
  }

  function deploymentConfig() {
    const configured = config.codex ?? {};
    const codexHome = boundedString(
      configured.home ?? processEnv.POLYGRAM_CODEX_HOME,
      'credential home',
    );
    const configuredSecretRoots = configured.daemonSecretRoots ?? [];
    if (
      !Array.isArray(configuredSecretRoots)
      || [...defaultDaemonSecretRoots, ...configuredSecretRoots].some((root) => (
        typeof root !== 'string'
        || root.length === 0
      ))
    ) {
      throw controllerError(
        'Codex daemon-secret roots must be an array of paths.',
        'CODEX_DEPLOYMENT_CONFIG_INVALID',
        'Configure every daemon secret root before selecting pm:codex.',
      );
    }
    return {
      codexHome,
      binaryPath: configured.binary ?? processEnv.POLYGRAM_CODEX_BIN,
      sessionLauncher,
      daemonSecretRoots: [
        ...new Set([...defaultDaemonSecretRoots, ...configuredSecretRoots]),
      ],
    };
  }

  function initialize() {
    if (initialization) return initialization;
    if (initializationError) throw initializationError;
    try {
      const identity = resolveHostIdentity();
      const recovery = db.reconstructCodexRecovery({
        stable_host_id: identity.stableHostId,
        boot_session_id: identity.bootSessionId,
        startup_recovery: startupRecovery,
        now: Date.now(),
      });
      let codexRecoveryState;
      if (recovery.status === 'clear') {
        codexRecoveryState = Object.freeze({ status: 'clear' });
      } else {
        const lease = db.getCodexLease();
        codexRecoveryState = Object.freeze({
          status: 'quarantined',
          hostIdentity: boundedString(
            identity.stableHostId,
            'incident stable host identity',
          ),
          bootSessionIdentity: boundedString(
            identity.bootSessionId,
            'incident boot-session identity',
          ),
          generationId: boundedString(
            lease?.generation_id ?? 'persisted-codex-quarantine',
            'incident generation identity',
          ),
        });
      }
      initialization = Object.freeze({
        identity: Object.freeze({ ...identity }),
        recovery: Object.freeze({ ...recovery }),
        managerOptions: Object.freeze({
          codexHostIdentity: identity.stableHostId,
          codexBootSessionIdentity: identity.bootSessionId,
          codexRecoveryState,
          codexRetirementPreparer: prepareCodexRetirement,
          codexRetirementVerifier: verifyCodexRetirement,
        }),
      });
      return initialization;
    } catch (cause) {
      initializationError = cause instanceof CodexRuntimeControllerError
        ? cause
        : controllerError(
          'Codex boot ownership reconstruction failed closed.',
          'CODEX_BOOT_RECONSTRUCTION_FAILED',
          'Inspect the durable Codex lease and host/boot identity before enabling Codex.',
          cause,
        );
      throw initializationError;
    }
  }

  function requireAvailableInitialization() {
    const state = initialize();
    if (state.recovery.status !== 'clear') {
      throw controllerError(
        `Codex recovery is blocked: ${state.recovery.reason ?? 'unknown reason'}.`,
        'CODEX_RECOVERY_BLOCKED',
        'Keep Codex unavailable until exclusive cleanup or persisted integrity is verified.',
      );
    }
    return state;
  }

  async function prepareCodexRequest({ sessionKey, request, state }) {
    const existing = receiptsBySession.get(sessionKey);
    if (existing && sameProfileRequest(
      existing.receipt.expectedStaticProfile,
      request,
    )) {
      const catalogAgeMs = now() - existing.catalogPreparedAt;
      let currentCredentialState;
      try {
        const homeAttestation = await attestCodexHome(
          existing.receipt.expectedStaticProfile.codexHome,
          existing.receipt.expectedStaticProfile.ownedConfigSha256,
        );
        currentCredentialState = credentialStateFingerprint(homeAttestation);
      } catch (error) {
        throw error;
      }
      if (
        currentCredentialState === existing.credentialStateFingerprint
        && catalogAgeMs >= 0
        && catalogAgeMs < catalogMaxAgeMs
        && catalogSupports(existing.catalog, request)
      ) {
        return existing;
      }
      invalidatePreparedSession(sessionKey, existing);
    }

    const configured = deploymentConfig();
    const key = digest({
      sessionKey,
      request,
      codexHome: configured.codexHome,
      binaryPath: configured.binaryPath,
      sessionLauncher: configured.sessionLauncher,
      daemonSecretRoots: configured.daemonSecretRoots,
    });
    if (preparingByKey.has(key)) return preparingByKey.get(key);

    const promise = (async () => {
      const binaryReceipt = await resolveBinary({
        binaryPath: configured.binaryPath,
        env: processEnv,
      });
      const expectedStaticProfile = await runtimeProfileBuilder.prepare({
        binaryReceipt,
        codexHome: configured.codexHome,
        workspace: request.cwd,
        daemonSecretRoots: configured.daemonSecretRoots,
        model: request.model,
        effort: request.effort,
        processEnv,
        sessionLauncher: configured.sessionLauncher,
      });
      const homeAttestation = await attestCodexHome(
        expectedStaticProfile.codexHome,
        expectedStaticProfile.ownedConfigSha256,
      );
      const attestedCredentialState = credentialStateFingerprint(
        homeAttestation,
      );
      const deploymentIdentity = `codex-deployment:v1:${digest({
        stableHostId: state.identity.stableHostId,
        codexHome: expectedStaticProfile.codexHome,
        authFingerprint: homeAttestation.authFingerprint ?? null,
        configFingerprint: homeAttestation.configFingerprint,
      })}`;
      const catalog = await withPreflightAdmission(() => (
        modelCatalog.preflight(expectedStaticProfile, {
          deploymentIdentity,
        })
      ));
      if (
        catalog?.selected?.model !== request.model
        || catalog?.selected?.effort !== request.effort
      ) {
        throw controllerError(
          'Authenticated Codex catalog did not confirm the selected model and effort.',
          'CODEX_MODEL_SELECTION_MISMATCH',
          'Choose a model and effort returned by the authenticated Codex catalog.',
        );
      }
      const receipt = catalog.spawnProfile;
      const entry = {
        receipt,
        availability: createAvailability(receipt),
        catalog,
        catalogCapabilityFingerprint:
          catalogCapabilityFingerprint(catalog),
        catalogPreparedAt: now(),
        credentialStateFingerprint: attestedCredentialState,
        deploymentIdentity,
      };
      receiptsBySession.set(sessionKey, entry);
      return entry;
    })();
    preparingByKey.set(key, promise);
    try {
      return await promise;
    } finally {
      if (preparingByKey.get(key) === promise) preparingByKey.delete(key);
    }
  }

  async function prepareCandidate({
    sessionKey,
    chatId,
    threadId = null,
  } = {}) {
    boundedString(sessionKey, 'session key');
    const state = requireAvailableInitialization();
    const request = resolveCandidate({
      config,
      chatId,
      threadId,
    });
    if (!request) return null;
    const entry = await prepareCodexRequest({ sessionKey, request, state });
    return Object.freeze({
      request,
      availability: entry.availability,
      catalog: entry.catalog,
    });
  }

  async function prepareSession({ sessionKey, chatId, threadId = null } = {}) {
    boundedString(sessionKey, 'session key');
    const state = requireAvailableInitialization();
    const request = resolveRequest({
      config,
      chatId,
      threadId,
      defaultPm: 'sdk',
    });
    if (!request) return null;
    const entry = await prepareCodexRequest({ sessionKey, request, state });
    return prepareRuntimeView(entry, request, chatId, threadId);
  }

  function runtimeCatalogView({ model, effort, catalog }) {
    const models = Array.isArray(catalog.models)
      ? catalog.models.map((entry) => Object.freeze({
        model: entry.model,
        displayName: entry.displayName,
        defaultReasoningEffort: entry.defaultReasoningEffort,
        supportedReasoningEfforts: Object.freeze([
          ...entry.supportedReasoningEfforts,
        ]),
      }))
      : [];
    return Object.freeze({
      runtime: 'codex',
      model,
      effort,
      models: Object.freeze(models),
      efforts: Object.freeze(
        models.find((entry) => entry.model === model)
          ?.supportedReasoningEfforts ?? [],
      ),
    });
  }

  async function resolveCandidateRuntimeView({
    sessionKey,
    chatId,
    threadId = null,
  } = {}) {
    const prepared = await prepareCandidate({ sessionKey, chatId, threadId });
    if (!prepared) return Object.freeze({ runtime: 'claude' });
    return runtimeCatalogView({
      model: prepared.request.model,
      effort: prepared.request.effort,
      catalog: prepared.catalog,
    });
  }

  function discardCandidateRuntime(sessionKey) {
    boundedString(sessionKey, 'session key');
    if (currentProcessBySession.has(sessionKey)) return false;
    const entry = receiptsBySession.get(sessionKey);
    if (!entry) return false;
    receiptsBySession.delete(sessionKey);
    return true;
  }

  async function resolveRuntimeView({
    sessionKey,
    chatId,
    threadId = null,
  } = {}) {
    const prepared = await prepareSession({ sessionKey, chatId, threadId });
    if (!prepared) return Object.freeze({ runtime: 'claude' });
    const { runtimeConfig, catalog } = prepared;
    return runtimeCatalogView({
      model: runtimeConfig.model,
      effort: runtimeConfig.effort,
      catalog,
    });
  }

  function resolveReceipt(sessionKey, identity) {
    const entry = receiptsBySession.get(sessionKey);
    if (
      identity?.runtime !== 'codex'
      || !entry
      || identity.spawnProfileId !== entry.receipt.spawnProfileId
    ) {
      throw controllerError(
        'No exact preflight receipt exists for this Codex spawn.',
        'CODEX_PREFLIGHT_RECEIPT_MISSING',
        'Run preflight for the exact session runtime profile before spawning.',
      );
    }
    return entry.receipt;
  }

  function clientFactory({
    sessionKey,
    expectedStaticProfile,
    onNotification,
    onFault,
  } = {}) {
    const entry = receiptsBySession.get(sessionKey);
    if (!entry || entry.receipt.expectedStaticProfile !== expectedStaticProfile) {
      throw controllerError(
        'Codex client construction did not match the preflighted profile.',
        'CODEX_PREFLIGHT_PROFILE_MISMATCH',
        'Discard the stale spawn and rerun exact preflight.',
      );
    }
    return new orchestra.CodexAppServerClient({
      binary: expectedStaticProfile.binary,
      codexHome: expectedStaticProfile.codexHome,
      cwd: expectedStaticProfile.cwd,
      env: expectedStaticProfile.env,
      expectedConfigSha256: expectedStaticProfile.ownedConfigSha256,
      ...(expectedStaticProfile.sessionLauncher == null ? {} : {
        sessionLauncher: expectedStaticProfile.sessionLauncher,
        expectedSessionLauncherSha256:
          expectedStaticProfile.sessionLauncherSha256,
      }),
      onNotification,
      onFault,
    });
  }

  function processReplacementReason(sessionKey, proc) {
    const entry = receiptsBySession.get(sessionKey);
    const record = typeof proc?.generationId === 'string'
      ? processesByGeneration.get(proc.generationId)
      : null;
    if (
      !entry
      || !record
      || currentProcessBySession.get(sessionKey) !== record
      || record.proc !== proc
      || proc.sessionKey !== sessionKey
      || typeof entry.credentialStateFingerprint !== 'string'
      || typeof record.credentialStateFingerprint !== 'string'
      || typeof entry.catalogCapabilityFingerprint !== 'string'
      || typeof record.catalogCapabilityFingerprint !== 'string'
    ) {
      throw controllerError(
        'No exact runtime-state binding exists for this Codex process.',
        'CODEX_PROCESS_CREDENTIAL_BINDING_MISSING',
        'Do not reuse the process; prepare and register an exact replacement.',
      );
    }
    if (
      entry.credentialStateFingerprint
      !== record.credentialStateFingerprint
    ) {
      return 'credential-state-drift';
    }
    if (
      entry.catalogCapabilityFingerprint
      !== record.catalogCapabilityFingerprint
    ) {
      return 'model-catalog-drift';
    }
    return null;
  }

  function requiresProcessReplacement(sessionKey, proc) {
    return processReplacementReason(sessionKey, proc) !== null;
  }

  function registerProcess(proc) {
    if (
      proc?.runtime !== 'codex'
      || typeof proc.generationId !== 'string'
      || typeof proc.sessionKey !== 'string'
    ) {
      throw new TypeError('Codex runtime controller requires a Codex process');
    }
    const receipt = resolveReceipt(proc.sessionKey, {
      runtime: 'codex',
      spawnProfileId: proc.spawnProfileId,
    });
    if (processesByGeneration.has(proc.generationId)) {
      throw controllerError(
        'Codex generation ID was reused.',
        'CODEX_GENERATION_ID_REUSED',
        'Discard the process and create a fresh generation.',
      );
    }
    const record = {
      proc,
      receipt,
      durable: false,
      durabilityBlocked: false,
      durabilityError: null,
      retirementVerificationFailed: false,
      closed: false,
      healthyStopObserved: false,
      retirementRequested: false,
      retirementWaiters: [],
      retired: false,
      credentialStateFingerprint: receiptsBySession
        .get(proc.sessionKey)
        .credentialStateFingerprint,
      catalogCapabilityFingerprint: receiptsBySession
        .get(proc.sessionKey)
        .catalogCapabilityFingerprint,
    };
    processesByGeneration.set(proc.generationId, record);
    currentProcessBySession.set(proc.sessionKey, record);
    proc.once?.('close', () => {
      record.closed = true;
      try {
        if (record.retired) return;
        if (!record.durable && proc.startupReleaseSafe === true) {
          record.retired = true;
          processesByGeneration.delete(proc.generationId);
          forgetRetiredSession(record);
          return;
        }
        maybeRetire(record);
      } catch (error) {
        logger.error?.(
          `[codex] durable retirement failed for ${proc.sessionKey}: ${error.message}`,
        );
      }
    });
    return proc;
  }

  function forgetRetiredSession(record) {
    if (currentProcessBySession.get(record.proc.sessionKey) !== record) {
      return;
    }
    currentProcessBySession.delete(record.proc.sessionKey);
    const entry = receiptsBySession.get(record.proc.sessionKey);
    if (entry?.receipt === record.receipt) {
      receiptsBySession.delete(record.proc.sessionKey);
    }
  }

  function requireCurrentDispatchOwner(sessionKey, generationId) {
    const exactSessionKey = deliveryResultString(sessionKey, 'session key');
    const exactGenerationId = deliveryResultString(
      generationId,
      'generation ID',
    );
    const record = processesByGeneration.get(exactGenerationId);
    if (
      record
      && currentProcessBySession.get(exactSessionKey) === record
      && record.proc.sessionKey === exactSessionKey
      && record.proc.generationId === exactGenerationId
      && record.durabilityBlocked
    ) {
      throw controllerError(
        'Codex generation is blocked by a delivery durability failure.',
        'CODEX_DURABILITY_FAILED',
        'Keep the exact generation fenced and recover from its durable lease.',
        record.durabilityError,
      );
    }
    if (
      !record
      || currentProcessBySession.get(exactSessionKey) !== record
      || record.proc.sessionKey !== exactSessionKey
      || record.proc.generationId !== exactGenerationId
      || record.proc.closed
      || !record.durable
      || !(
        record.proc.runtime === 'codex'
        || record.proc.backend === 'codex'
      )
    ) {
      throw controllerError(
        'Codex dispatch does not belong to the current durable process.',
        'CODEX_DISPATCH_BINDING_MISSING',
        'Do not steer, queue, or mutate a reservation for a stale process.',
      );
    }
    return {
      record,
      sessionKey: exactSessionKey,
      generationId: exactGenerationId,
      identity: requireAvailableInitialization().identity,
    };
  }

  function dispatchReservationId({
    botName,
    telegramChatId,
    telegramMessageId,
  }) {
    return `codex-dispatch:v1:${digest({
      botName,
      telegramChatId,
      telegramMessageId,
    })}`;
  }

  function claimDispatchReservation({
    sessionKey,
    generationId,
    botName,
    telegramChatId,
    telegramMessageId,
  } = {}) {
    const owner = requireCurrentDispatchOwner(sessionKey, generationId);
    const exactBotName = deliveryResultString(botName, 'bot name');
    const exactChatId = deliveryResultString(
      telegramChatId,
      'Telegram chat ID',
    );
    const exactMessageId = deliveryResultString(
      telegramMessageId,
      'Telegram message ID',
    );
    const reservationId = dispatchReservationId({
      botName: exactBotName,
      telegramChatId: exactChatId,
      telegramMessageId: exactMessageId,
    });
    const result = db.claimCodexDispatchReservation({
      reservation_id: reservationId,
      generation_id: owner.generationId,
      session_key: owner.sessionKey,
      bot_name: exactBotName,
      telegram_chat_id: exactChatId,
      telegram_message_id: exactMessageId,
      stable_host_id: owner.identity.stableHostId,
      boot_session_id: owner.identity.bootSessionId,
      ts: Date.now(),
    });
    return Object.freeze({
      ...result,
      reservationId,
      generationId: owner.generationId,
    });
  }

  function finalizeAcceptedSteer({
    sessionKey,
    generationId,
    reservationId,
    steerAttemptId,
    targetAttemptId,
  } = {}) {
    const owner = requireCurrentDispatchOwner(sessionKey, generationId);
    return db.finalizeCodexAcceptedSteer({
      reservation_id: deliveryResultString(
        reservationId,
        'dispatch reservation ID',
      ),
      generation_id: owner.generationId,
      steer_attempt_id: deliveryResultString(
        steerAttemptId,
        'steer attempt ID',
      ),
      target_attempt_id: deliveryResultString(
        targetAttemptId,
        'target attempt ID',
      ),
      stable_host_id: owner.identity.stableHostId,
      boot_session_id: owner.identity.bootSessionId,
      ts: Date.now(),
    });
  }

  function markDispatchDisposition({
    sessionKey,
    generationId,
    reservationId,
    disposition,
  } = {}) {
    const owner = requireCurrentDispatchOwner(sessionKey, generationId);
    if (!['queue-authorized', 'ambiguous', 'cancelled'].includes(disposition)) {
      throw controllerError(
        'Codex dispatch disposition is invalid.',
        'CODEX_DISPATCH_DISPOSITION_INVALID',
        'Use a supported durable dispatch disposition.',
      );
    }
    return db.markCodexDispatchDisposition({
      reservation_id: deliveryResultString(
        reservationId,
        'dispatch reservation ID',
      ),
      generation_id: owner.generationId,
      disposition,
      stable_host_id: owner.identity.stableHostId,
      boot_session_id: owner.identity.bootSessionId,
      ts: Date.now(),
    });
  }

  function settleQueuedDispatch({
    sessionKey,
    generationId,
    reservationId,
    attemptId,
    botName,
    telegramChatId,
    telegramMessageId,
  } = {}) {
    const owner = requireCurrentDispatchOwner(sessionKey, generationId);
    const exactBotName = deliveryResultString(botName, 'bot name');
    const exactChatId = deliveryResultString(
      telegramChatId,
      'Telegram chat ID',
    );
    const exactMessageId = deliveryResultString(
      telegramMessageId,
      'Telegram message ID',
    );
    const exactReservationId = deliveryResultString(
      reservationId,
      'dispatch reservation ID',
    );
    if (exactReservationId !== dispatchReservationId({
      botName: exactBotName,
      telegramChatId: exactChatId,
      telegramMessageId: exactMessageId,
    })) {
      throw controllerError(
        'Codex queued settlement reservation identity conflicts.',
        'CODEX_QUEUE_SETTLEMENT_CONFLICT',
        'Do not settle a queued turn against another Telegram input.',
      );
    }
    return db.settleCodexQueuedDispatch({
      attempt_id: deliveryResultString(attemptId, 'attempt ID'),
      generation_id: owner.generationId,
      session_key: owner.sessionKey,
      bot_name: exactBotName,
      telegram_chat_id: exactChatId,
      telegram_message_id: exactMessageId,
      stable_host_id: owner.identity.stableHostId,
      boot_session_id: owner.identity.bootSessionId,
      ts: Date.now(),
    });
  }

  async function settleTelegramDelivery(
    sessionKey,
    result,
    { disposition = 'delivered' } = {},
  ) {
    const claimsCodex = (
      result?.runtime === 'codex'
      || result?.backend === 'codex'
    );
    if (!claimsCodex) return;
    if (!['delivered', 'failed'].includes(disposition)) {
      throw controllerError(
        'Codex delivery disposition is invalid.',
        'CODEX_DELIVERY_DISPOSITION_INVALID',
        'Use delivered or failed for the exact Telegram outcome.',
      );
    }
    if (
      (
        result.runtime !== undefined
        && result.runtime !== 'codex'
      )
      || (
        result.backend !== undefined
        && result.backend !== 'codex'
      )
    ) {
      throw controllerError(
        'Codex delivery runtime evidence is contradictory.',
        'CODEX_DELIVERY_RESULT_INVALID',
        'Discard the malformed result without settling durable delivery.',
      );
    }
    const exactSessionKey = deliveryResultString(sessionKey, 'session key');
    const generationId = deliveryResultString(
      result?.generationId,
      'generation ID',
    );
    const attemptId = deliveryResultString(
      result?.attemptId,
      'attempt ID',
    );
    const providerSessionId = deliveryResultString(
      result?.providerSessionId,
      'provider session ID',
    );
    const providerTurnId = deliveryResultString(
      result?.providerTurnId,
      'provider turn ID',
    );
    const record = processesByGeneration.get(generationId);
    if (
      record
      && currentProcessBySession.get(exactSessionKey) === record
      && record.proc.sessionKey === exactSessionKey
      && record.proc.generationId === generationId
      && record.durabilityBlocked
    ) {
      throw record.durabilityError;
    }
    if (
      !record
      || currentProcessBySession.get(exactSessionKey) !== record
      || record.proc.sessionKey !== exactSessionKey
      || record.proc.generationId !== generationId
      || !record.durable
      || !(
        record.proc.runtime === 'codex'
        || record.proc.backend === 'codex'
      )
    ) {
      const stopped = retiredStopCancellations.get(generationId);
      if (
        disposition === 'failed'
        && stopped?.sessionKey === exactSessionKey
        && stopped.attemptId === attemptId
        && stopped.providerSessionId === providerSessionId
        && stopped.providerTurnId === providerTurnId
      ) {
        return Object.freeze({
          committed: true,
          disposition: 'stop-cancelled',
          generationId,
          attemptId,
        });
      }
      throw controllerError(
        'Codex delivery does not belong to the current registered process.',
        'CODEX_DELIVERY_BINDING_MISSING',
        'Do not settle delivery for a stale or unregistered process.',
      );
    }
    const attempt = db.getCodexAttempt(attemptId);
    if (
      record.proc.providerSessionId !== providerSessionId
      || !attempt
      || attempt.attempt_id !== attemptId
      || attempt.generation_id !== generationId
      || attempt.session_key !== exactSessionKey
      || attempt.thread_id !== providerSessionId
      || attempt.turn_id !== providerTurnId
    ) {
      throw controllerError(
        'Codex delivery identities do not match the registered turn attempt.',
        'CODEX_DELIVERY_IDENTITY_MISMATCH',
        'Discard the mismatched result without settling durable delivery.',
      );
    }
    const state = requireAvailableInitialization();
    try {
      const retireGeneration = (
        record.closed
        && record.healthyStopObserved
        && record.retirementRequested
        && !record.retirementVerificationFailed
        && !record.durabilityBlocked
      );
      const checkpoint = {
        kind: disposition === 'delivered'
          ? 'telegram-delivery-settled'
          : 'telegram-delivery-failed',
        generationId: record.proc.generationId,
        hostIdentity: state.identity.stableHostId,
        bootSessionIdentity: state.identity.bootSessionId,
        attemptId: attempt.attempt_id,
        threadId: attempt.thread_id,
        turnId: attempt.turn_id,
        ts: Date.now(),
      };
      const persisted = db.recordCodexDeliveryCheckpoint({
        checkpoint,
        retireGeneration,
      });
      if (
        retireGeneration
        && persisted.retired !== true
        && persisted.deferred !== true
      ) {
        throw controllerError(
          'Codex delivery did not retire the verified stopped generation.',
          'CODEX_RETIREMENT_UNVERIFIED',
          'Keep the exact generation and daemon lease fenced.',
        );
      }
      maybeRetire(record);
    } catch (error) {
      record.durabilityBlocked = true;
      record.durabilityError = error;
      try {
        record.proc.blockDurability(error);
      } catch (fenceError) {
        logger.error?.(
          `[codex] failed to apply delivery durability fence for ${exactSessionKey}: ${fenceError.message}`,
        );
      }
      throw error;
    }
    return Object.freeze({
      committed: true,
      disposition,
      generationId,
      attemptId,
    });
  }

  function activateWithPreparedCheckpoint(record, payload) {
    if (payload.kind !== 'request-prepared') {
      throw controllerError(
        'Codex generation reached durability out of order.',
        'CODEX_GENERATION_NOT_DURABLE',
        'Quarantine the generation and inspect its first checkpoint.',
      );
    }
    const state = requireAvailableInitialization();
    const transaction = db.raw?.transaction?.(() => {
      db.createCodexGeneration({
        generation_id: record.proc.generationId,
        session_key: record.proc.sessionKey,
        thread_id: record.proc.spawnOptions?.existingSessionId ?? null,
        app_server_session_id: null,
        stable_host_id: state.identity.stableHostId,
        boot_session_id: state.identity.bootSessionId,
        ts: Date.now(),
      });
      db.recordCodexCheckpoint(payload);
      db.acquireCodexLease({
        generation_id: record.proc.generationId,
        stable_host_id: state.identity.stableHostId,
        boot_session_id: state.identity.bootSessionId,
        ts: Date.now(),
      });
    });
    if (typeof transaction !== 'function') {
      throw new TypeError('Codex durability requires transactional DB access');
    }
    transaction();
    record.durable = true;
  }

  function maybeRetire(record) {
    if (
      record.retired
      || record.durabilityBlocked
      || record.retirementVerificationFailed
      || !record.retirementRequested
      || !record.durable
      || !record.closed
      || !(
        record.healthyStopObserved
        || record.proc.startupReleaseSafe === true
      )
    ) return false;
    try {
      db.markCodexGenerationRetired({
        generation_id: record.proc.generationId,
        ts: Date.now(),
      });
      record.retired = true;
      if (record.stopCancellation) {
        rememberStopCancellation(record.stopCancellation);
      }
      processesByGeneration.delete(record.proc.generationId);
      forgetRetiredSession(record);
      for (const waiter of record.retirementWaiters.splice(0)) {
        waiter.resolve(Object.freeze({
          committed: true,
          disposition: record.stopCancellation
            ? 'stop-cancelled'
            : 'retired',
          ...(record.stopCancellation ?? {}),
        }));
      }
      return true;
    } catch (error) {
      if (error?.code === 'CODEX_RETIREMENT_UNVERIFIED') return false;
      throw error;
    }
  }

  function prepareCodexRetirement(input = {}) {
    const expectedKeys = [
      'sessionKey',
      'generationId',
      'attemptId',
      'providerSessionId',
      'providerTurnId',
      'sourceMsgId',
    ];
    const keys = input && typeof input === 'object'
      ? Reflect.ownKeys(input)
      : [];
    const reject = (message, cause) => {
      throw controllerError(
        message,
        'CODEX_RETIREMENT_PREPARATION_REJECTED',
        'Do not interrupt or continue the unproven Codex turn.',
        cause,
      );
    };
    if (
      keys.length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.hasOwn(input, key))
    ) {
      reject('Codex retirement preparation binding is incomplete.');
    }
    for (const key of expectedKeys.slice(0, 5)) {
      if (
        typeof input[key] !== 'string'
        || input[key].length === 0
        || input[key].length > 512
      ) {
        reject('Codex retirement preparation binding is malformed.');
      }
    }
    if (!(
      (
        typeof input.sourceMsgId === 'string'
        && input.sourceMsgId.length > 0
        && input.sourceMsgId.length <= 512
      )
      || (
        Number.isSafeInteger(input.sourceMsgId)
        && input.sourceMsgId > 0
      )
    )) {
      reject('Codex retirement source message binding is malformed.');
    }

    const record = processesByGeneration.get(input.generationId);
    if (
      !record
      || currentProcessBySession.get(input.sessionKey) !== record
      || record.proc.sessionKey !== input.sessionKey
      || record.proc.generationId !== input.generationId
      || record.proc.providerSessionId !== input.providerSessionId
      || !record.durable
      || record.durabilityBlocked
      || record.retired
      || !(
        record.proc.runtime === 'codex'
        || record.proc.backend === 'codex'
      )
    ) {
      reject('Codex retirement preparation does not own the exact live turn.');
    }

    const state = requireAvailableInitialization();
    let result;
    try {
      result = db.prepareCodexCleanRetirement({
        generation_id: input.generationId,
        session_key: input.sessionKey,
        attempt_id: input.attemptId,
        provider_session_id: input.providerSessionId,
        provider_turn_id: input.providerTurnId,
        source_message_id: String(input.sourceMsgId),
        stable_host_id: state.identity.stableHostId,
        boot_session_id: state.identity.bootSessionId,
        ts: Date.now(),
      });
    } catch (cause) {
      reject('Codex retirement preparation was not committed.', cause);
    }
    if (
      !result
      || ![0, 1].includes(result.changes)
      || result.disposition !== 'retirement-requested'
      || result.generationId !== input.generationId
      || result.attemptId !== input.attemptId
    ) {
      reject('Codex retirement preparation acknowledgement is inexact.');
    }
    return Object.freeze({
      committed: true,
      disposition: 'retirement-requested',
      ...input,
    });
  }

  async function verifyCodexRetirement({
    sessionKey,
    generationId,
    terminalStatus = null,
    turnId = null,
    signal = null,
  } = {}) {
    const exactSessionKey = deliveryResultString(sessionKey, 'session key');
    const exactGenerationId = deliveryResultString(
      generationId,
      'generation ID',
    );
    const record = processesByGeneration.get(exactGenerationId);
    if (
      !record
      || currentProcessBySession.get(exactSessionKey) !== record
      || record.proc.sessionKey !== exactSessionKey
      || record.proc.generationId !== exactGenerationId
      || !record.durable
      || !record.closed
      || !record.healthyStopObserved
      || !(
        record.proc.runtime === 'codex'
        || record.proc.backend === 'codex'
      )
    ) {
      throw controllerError(
        'Codex retirement does not belong to the exact stopped generation.',
        'CODEX_RETIREMENT_BINDING_MISSING',
        'Keep the daemon ownership fence and quarantine stale retirement.',
      );
    }
    if (
      terminalStatus != null
      && !['completed', 'interrupted', 'failed'].includes(terminalStatus)
    ) {
      throw controllerError(
        'Codex retirement terminal status is invalid.',
        'CODEX_RETIREMENT_RESULT_INVALID',
        'Keep the exact generation fenced.',
      );
    }
    if (turnId != null) deliveryResultString(turnId, 'turn ID');
    if (
      signal != null
      && (
        typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
      )
    ) {
      throw new TypeError('Codex retirement signal must be an AbortSignal');
    }

    record.retirementRequested = true;
    try {
      if (signal?.aborted) {
        throw controllerError(
          'Codex retirement verification was aborted.',
          'CODEX_RETIREMENT_VERIFICATION_ABORTED',
          'Keep the exact generation and durable lease fenced.',
          signal.reason,
        );
      }
      const state = requireAvailableInitialization();
      const settlement = db.settleCodexStoppedGeneration({
        generation_id: exactGenerationId,
        stable_host_id: state.identity.stableHostId,
        boot_session_id: state.identity.bootSessionId,
        ts: Date.now(),
      });
      if (settlement.disposition === 'stop-cancelled') {
        const attempt = db.getCodexAttempt(settlement.attemptId);
        if (
          !attempt
          || attempt.generation_id !== exactGenerationId
          || attempt.session_key !== exactSessionKey
          || attempt.recovery_state !== 'cancelled'
          || attempt.terminal_status !== 'interrupted'
          || typeof attempt.thread_id !== 'string'
          || typeof attempt.turn_id !== 'string'
        ) {
          throw controllerError(
            'Codex stop cancellation lacks an exact durable attempt binding.',
            'CODEX_RETIREMENT_UNVERIFIED',
            'Keep the daemon ownership fence and inspect the stopped attempt.',
          );
        }
        record.stopCancellation = Object.freeze({
          sessionKey: exactSessionKey,
          generationId: exactGenerationId,
          attemptId: attempt.attempt_id,
          providerSessionId: attempt.thread_id,
          providerTurnId: attempt.turn_id,
          sourceMsgId: attempt.telegram_source_message_id,
        });
      }
      if (maybeRetire(record)) {
        return Object.freeze({
          committed: true,
          disposition: settlement.disposition === 'stop-cancelled'
            ? 'stop-cancelled'
            : 'retired',
          ...(record.stopCancellation ?? {}),
        });
      }
      if (settlement.disposition !== 'pending-delivery') {
        throw controllerError(
          'Codex durable retirement remained unresolved after disposal.',
          'CODEX_RETIREMENT_UNVERIFIED',
          'Keep the daemon ownership fence and inspect unresolved attempts.',
        );
      }
      return await new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) {
            signal?.removeEventListener?.('abort', onAbort);
            resolve(value);
          },
          reject(error) {
            signal?.removeEventListener?.('abort', onAbort);
            reject(error);
          },
        };
        function onAbort() {
          const index = record.retirementWaiters.indexOf(waiter);
          if (index !== -1) record.retirementWaiters.splice(index, 1);
          waiter.reject(controllerError(
            'Codex retirement verification was aborted.',
            'CODEX_RETIREMENT_VERIFICATION_ABORTED',
            'Keep the exact generation and durable lease fenced.',
            signal.reason,
          ));
        }
        record.retirementWaiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    } catch (error) {
      record.retirementVerificationFailed = true;
      throw error;
    }
  }

  async function checkpointSink(payload) {
    const record = processesByGeneration.get(payload?.generationId);
    const state = requireAvailableInitialization();
    if (
      !record
      || payload.hostIdentity !== state.identity.stableHostId
      || payload.bootSessionIdentity !== state.identity.bootSessionId
    ) {
      throw controllerError(
        'Codex checkpoint does not belong to the registered generation owner.',
        'CODEX_CHECKPOINT_STALE_GENERATION',
        'Quarantine the stale generation.',
      );
    }

    if (payload.kind === 'containment-cleanup-completed') {
      const expectedThreadId = (
        record.proc.providerSessionId
        ?? record.proc.attachingThreadId
        ?? null
      );
      const expectedAppServerSessionId =
        record.proc.appServerSessionId ?? null;
      if (
        currentProcessBySession.get(record.proc.sessionKey) !== record
        || record.proc.generationId !== payload.generationId
        || record.proc.state !== 'ContainmentFailed'
        || record.proc.hostIdentity !== payload.hostIdentity
        || record.proc.bootSessionIdentity !== payload.bootSessionIdentity
        || expectedThreadId !== (payload.threadId ?? null)
        || expectedAppServerSessionId
          !== (payload.appServerSessionId ?? null)
        || (
          record.proc.containmentReason != null
          && record.proc.containmentReason !== payload.reason
        )
      ) {
        throw controllerError(
          'Codex containment cleanup does not match the failed process owner.',
          'CODEX_CHECKPOINT_STALE_GENERATION',
          'Keep the failed generation fenced.',
        );
      }
      const result = db.settleCodexFailedGeneration({
        generation_id: record.proc.generationId,
        session_key: record.proc.sessionKey,
        stable_host_id: state.identity.stableHostId,
        incident_boot_session_id: state.identity.bootSessionId,
        current_boot_session_id: state.identity.bootSessionId,
        provider_session_id: expectedThreadId,
        app_server_session_id: expectedAppServerSessionId,
        reason: deliveryResultString(payload.reason, 'containment reason'),
        source: 'managed-group-empty',
        ...sanitizeCodexFaultProvenance(payload),
        allow_missing_generation: !record.durable,
        ts: payload.ts ?? Date.now(),
      });
      record.retired = true;
      if (processesByGeneration.get(record.proc.generationId) === record) {
        processesByGeneration.delete(record.proc.generationId);
      }
      forgetRetiredSession(record);
      return Object.freeze({ ...result });
    }

    if (!record.durable) {
      activateWithPreparedCheckpoint(record, payload);
    } else {
      db.recordCodexCheckpoint(payload);
    }
    if (payload.kind === 'request-write-attempted') {
      payload.markWriteCommitted?.();
    }
    if (payload.kind === 'stop-empty-registry-observed') {
      record.healthyStopObserved = true;
    }
    maybeRetire(record);
  }

  return Object.freeze({
    initialize,
    prepareSession,
    discardCandidateRuntime,
    resolveCandidateRuntimeView,
    resolveRuntimeView,
    resolveReceipt,
    clientFactory,
    requiresProcessReplacement,
    processReplacementReason,
    registerProcess,
    claimDispatchReservation,
    finalizeAcceptedSteer,
    markDispatchDisposition,
    settleQueuedDispatch,
    settleTelegramDelivery,
    verifyCodexRetirement,
    checkpointSink,
  });
}

module.exports = {
  CodexRuntimeControllerError,
  createCodexRuntimeController,
  resolveCodexStartupRecovery,
};

'use strict';

const { createHash } = require('node:crypto');

const MAX_ID_BYTES = 512;
const MAX_MODELS = 1_000;
const MAX_EFFORTS = 32;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PREFLIGHT_ACTIONS = Object.freeze({
  CODEX_AUTH_UNAVAILABLE:
    'Authenticate the pinned CLI in the dedicated deployment CODEX_HOME, then rerun preflight.',
  CODEX_MODEL_UNAVAILABLE:
    'Choose a model returned by authenticated Codex model preflight.',
  CODEX_EFFORT_UNAVAILABLE:
    'Choose a reasoning effort supported by the selected Codex model.',
  CODEX_BINARY_MISMATCH:
    'Restore the reviewed pinned Codex executable, then rerun preflight.',
  CODEX_CONFIG_MISMATCH:
    'Restore the owned Codex configuration and credential-home permissions, then rerun preflight.',
});

class CodexCatalogError extends Error {
  constructor(message, code, action, options) {
    super(message, options);
    this.name = 'CodexCatalogError';
    this.code = code;
    this.action = action;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
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

function boundedString(value, label, maxBytes = MAX_ID_BYTES) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > maxBytes
  ) {
    throw new CodexCatalogError(
      `Codex ${label} must be a bounded non-empty string.`,
      label === 'authenticated deployment identity'
        ? 'CODEX_DEPLOYMENT_IDENTITY_INVALID'
        : 'CODEX_PREFLIGHT_INVALID',
      'Rerun Codex preflight with the exact configured runtime profile.',
    );
  }
  return value;
}

function deploymentKey(identity) {
  return digest({
    authenticatedDeploymentIdentity: boundedString(
      identity,
      'authenticated deployment identity',
    ),
  });
}

function actionablePreflightError(error) {
  if (error?.action || !PREFLIGHT_ACTIONS[error?.code]) return error;
  return new CodexCatalogError(
    error.message,
    error.code,
    PREFLIGHT_ACTIONS[error.code],
    { cause: error },
  );
}

function cloneModel(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new CodexCatalogError(
      'Codex preflight returned a malformed model catalog.',
      'CODEX_PREFLIGHT_INVALID',
      'Rerun authenticated Codex model preflight.',
    );
  }
  const supportedReasoningEfforts = entry.supportedReasoningEfforts;
  if (
    !Array.isArray(supportedReasoningEfforts)
    || supportedReasoningEfforts.length === 0
    || supportedReasoningEfforts.length > MAX_EFFORTS
  ) {
    throw new CodexCatalogError(
      'Codex preflight returned malformed reasoning efforts.',
      'CODEX_PREFLIGHT_INVALID',
      'Rerun authenticated Codex model preflight.',
    );
  }
  const efforts = supportedReasoningEfforts.map((effort) => (
    boundedString(effort, 'reasoning effort')
  ));
  if (new Set(efforts).size !== efforts.length) {
    throw new CodexCatalogError(
      'Codex preflight returned duplicate reasoning efforts.',
      'CODEX_PREFLIGHT_INVALID',
      'Rerun authenticated Codex model preflight.',
    );
  }
  if (
    typeof entry.isDefault !== 'boolean'
    || !efforts.includes(entry.defaultReasoningEffort)
  ) {
    throw new CodexCatalogError(
      'Codex preflight returned an inconsistent default effort.',
      'CODEX_PREFLIGHT_INVALID',
      'Rerun authenticated Codex model preflight.',
    );
  }
  return {
    id: boundedString(entry.id, 'model ID'),
    model: boundedString(entry.model, 'model name'),
    displayName: boundedString(entry.displayName, 'model display name'),
    defaultReasoningEffort: entry.defaultReasoningEffort,
    supportedReasoningEfforts: efforts,
    isDefault: entry.isDefault,
  };
}

function projectPreflight(result) {
  if (
    !result
    || typeof result !== 'object'
    || Array.isArray(result)
    || result.runtime !== 'codex'
    || !SHA256_RE.test(result.spawnProfileId)
    || result.auth?.authenticated !== true
    || result.auth?.accountType !== 'chatgpt'
    || typeof result.auth?.requiresOpenaiAuth !== 'boolean'
    || !Array.isArray(result.models)
    || result.models.length === 0
    || result.models.length > MAX_MODELS
    || !Array.isArray(result.efforts)
  ) {
    throw new CodexCatalogError(
      'Codex preflight returned an invalid authenticated catalog.',
      'CODEX_PREFLIGHT_INVALID',
      'Rerun authenticated Codex preflight with the reviewed Orchestra runtime.',
    );
  }

  const models = result.models.map(cloneModel);
  if (
    new Set(models.map(({ id }) => id)).size !== models.length
    || new Set(models.map(({ model }) => model)).size !== models.length
  ) {
    throw new CodexCatalogError(
      'Codex preflight returned duplicate model identities.',
      'CODEX_PREFLIGHT_INVALID',
      'Rerun authenticated Codex model preflight.',
    );
  }
  const selectedModel = boundedString(result.selected?.model, 'selected model');
  const selectedEffort = boundedString(
    result.selected?.effort,
    'selected reasoning effort',
  );
  const selected = models.filter(({ model }) => model === selectedModel);
  if (
    selected.length !== 1
    || !selected[0].supportedReasoningEfforts.includes(selectedEffort)
    || JSON.stringify(result.efforts)
      !== JSON.stringify(selected[0].supportedReasoningEfforts)
  ) {
    throw new CodexCatalogError(
      'Codex preflight selected model or effort is inconsistent.',
      'CODEX_PREFLIGHT_INVALID',
      'Select a model and effort returned by authenticated model preflight.',
    );
  }

  return {
    runtimeVersion: boundedString(result.runtimeVersion, 'runtime version'),
    schemaVersion: boundedString(result.schemaVersion, 'schema version'),
    spawnProfileId: result.spawnProfileId,
    auth: {
      authenticated: true,
      accountType: 'chatgpt',
      requiresOpenaiAuth: result.auth.requiresOpenaiAuth,
    },
    models,
    efforts: [...selected[0].supportedReasoningEfforts],
    selected: {
      model: selectedModel,
      effort: selectedEffort,
    },
  };
}

function resolveOrchestra(orchestra) {
  const loaded = orchestra ?? require('@shumkov/orchestra');
  for (const method of [
    'preflightCodexRuntime',
    'createCodexSpawnProfile',
    'assertCodexSpawnProfile',
  ]) {
    if (typeof loaded?.[method] !== 'function') {
      throw new CodexCatalogError(
        `Installed Orchestra does not expose ${method}.`,
        'CODEX_PREFLIGHT_UNWIRED',
        'Install the exact reviewed Orchestra Codex runtime before enabling Codex.',
      );
    }
  }
  return loaded;
}

class CodexModelCatalog {
  constructor({ orchestra = null } = {}) {
    this.orchestra = orchestra;
    this.cache = new Map();
    this.currentKeyByDeployment = new Map();
    this.generationByDeployment = new Map();
  }

  _invalidateKey(key) {
    const current = this.currentKeyByDeployment.get(key);
    if (current) this.cache.delete(current);
    this.currentKeyByDeployment.delete(key);
  }

  invalidate({ deploymentIdentity } = {}) {
    if (deploymentIdentity === undefined) {
      this.cache.clear();
      this.currentKeyByDeployment.clear();
      this.generationByDeployment.clear();
      return;
    }
    const key = deploymentKey(deploymentIdentity);
    this._invalidateKey(key);
    this.generationByDeployment.set(
      key,
      (this.generationByDeployment.get(key) ?? 0) + 1,
    );
  }

  getCached({ deploymentIdentity, spawnProfileId } = {}) {
    const key = deploymentKey(deploymentIdentity);
    boundedString(spawnProfileId, 'spawn profile ID');
    if (!SHA256_RE.test(spawnProfileId)) {
      throw new CodexCatalogError(
        'Codex spawn profile ID must be a lowercase SHA-256.',
        'CODEX_PREFLIGHT_INVALID',
        'Use the exact spawn profile returned by authenticated preflight.',
      );
    }
    const cacheKey = digest({ deploymentKey: key, spawnProfileId });
    return this.cache.get(cacheKey) ?? null;
  }

  /**
   * `deploymentIdentity` is an opaque fingerprint of the provisioned
   * credential deployment, not credential contents. It must change when that
   * deployment is replaced so an authenticated catalog cannot cross stores.
   */
  async preflight(expectedStaticProfile, { deploymentIdentity } = {}) {
    const key = deploymentKey(deploymentIdentity);
    const generation = (this.generationByDeployment.get(key) ?? 0) + 1;
    this.generationByDeployment.set(key, generation);
    this._invalidateKey(key);

    let orchestra;
    try {
      orchestra = resolveOrchestra(this.orchestra);
    } catch (error) {
      if (this.generationByDeployment.get(key) === generation) {
        this._invalidateKey(key);
      }
      throw error;
    }

    let result;
    try {
      result = await orchestra.preflightCodexRuntime(expectedStaticProfile);
    } catch (error) {
      if (this.generationByDeployment.get(key) === generation) {
        this._invalidateKey(key);
      }
      throw actionablePreflightError(error);
    }
    if (this.generationByDeployment.get(key) !== generation) {
      throw new CodexCatalogError(
        'Codex preflight result was superseded by a newer request.',
        'CODEX_PREFLIGHT_SUPERSEDED',
        'Use the newest completed Codex preflight result.',
      );
    }

    try {
      const projection = projectPreflight(result);
      const spawnProfile = orchestra.createCodexSpawnProfile(
        expectedStaticProfile,
        result,
      );
      const asserted = orchestra.assertCodexSpawnProfile(spawnProfile);
      if (
        asserted !== spawnProfile
        || spawnProfile.runtime !== 'codex'
        || spawnProfile.spawnProfileId !== projection.spawnProfileId
      ) {
        throw new CodexCatalogError(
          'Orchestra returned an inconsistent Codex spawn-profile receipt.',
          'CODEX_PREFLIGHT_RECEIPT_INVALID',
          'Rerun preflight with the exact selected static profile.',
        );
      }

      const cacheIdentity = digest({
        deploymentKey: key,
        ...projection,
      });
      const available = deepFreeze({
        state: 'available',
        cacheIdentity,
        ...projection,
        spawnProfile,
      });
      const cacheKey = digest({
        deploymentKey: key,
        spawnProfileId: projection.spawnProfileId,
      });
      this._invalidateKey(key);
      this.cache.set(cacheKey, available);
      this.currentKeyByDeployment.set(key, cacheKey);
      return available;
    } catch (error) {
      if (this.generationByDeployment.get(key) === generation) {
        this._invalidateKey(key);
      }
      throw error;
    }
  }
}

module.exports = {
  CodexCatalogError,
  CodexModelCatalog,
};

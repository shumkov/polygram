/**
 * Pure runtime selection for one chat/topic.
 *
 * Claude backend selection delegates to Orchestra's established resolver so
 * aliases, warning behavior, truthy fallthrough, and unknown-value fallback do
 * not drift. Codex is the sole fail-closed extension: it can be selected only
 * with an availability object constructed from Orchestra's branded, asserted
 * spawn-profile receipt.
 */

'use strict';

const { createHash } = require('crypto');
const { pickBackend } = require('@shumkov/orchestra');

const PM_DESCRIPTORS = Object.freeze({
  sdk: Object.freeze({
    provider: 'claude',
    runtime: 'claude',
    backend: 'sdk',
    sessionNamespace: 'claude:inline',
    promptMode: 'inline',
  }),
  cli: Object.freeze({
    provider: 'claude',
    runtime: 'claude',
    backend: 'cli',
    sessionNamespace: 'claude:channels',
    promptMode: 'channels',
  }),
  codex: Object.freeze({
    provider: 'codex',
    runtime: 'codex',
    backend: 'codex',
    sessionNamespace: 'codex:app-server',
    promptMode: 'codex',
  }),
});

const CODEX_ERROR_BY_STATE = Object.freeze({
  loading: Object.freeze({
    code: 'CODEX_PREFLIGHT_LOADING',
    action: 'Wait for Codex startup preflight to finish, then try again.',
  }),
  unavailable: Object.freeze({
    code: 'CODEX_RUNTIME_UNAVAILABLE',
    action: 'Fix Codex app-server credentials or startup preflight, then try again.',
  }),
  ineligible: Object.freeze({
    code: 'CODEX_RUNTIME_INELIGIBLE',
    action: 'Choose an eligible Codex account/model or keep this session on Claude.',
  }),
});

const DEFAULT_CODEX_AVAILABILITY = Object.freeze({
  state: 'unavailable',
  reason: 'Codex runtime availability is not wired',
});
const MAX_CONFIG_VALUE_LENGTH = 4096;
const assertedReceiptByAvailability = new WeakMap();

class RuntimeConfigError extends Error {
  constructor(message, {
    code,
    source = null,
    value = null,
    runtime = null,
    availabilityState = null,
    reason = null,
    action = null,
  }) {
    super(message);
    this.name = 'RuntimeConfigError';
    this.code = code;
    this.source = source;
    this.value = value;
    this.runtime = runtime;
    this.availabilityState = availabilityState;
    this.reason = reason;
    this.action = action;
  }
}

/**
 * Convert an Orchestra-branded preflight receipt into the only availability
 * object that can enable Codex. The assertion is required lazily so a
 * Claude-only installation remains loadable when Codex exports are absent.
 */
function createCodexRuntimeAvailability(receipt) {
  const orchestra = require('@shumkov/orchestra');
  if (typeof orchestra.assertCodexSpawnProfile !== 'function') {
    throw new RuntimeConfigError(
      'Codex preflight receipt assertion is not installed.',
      {
        code: 'CODEX_PREFLIGHT_UNWIRED',
        runtime: 'codex',
        availabilityState: 'unavailable',
        reason: 'Installed Orchestra does not expose assertCodexSpawnProfile',
        action: 'Install the reviewed Orchestra Codex runtime before enabling Codex.',
      },
    );
  }

  // Do not emulate or partially duplicate Orchestra's private branding check.
  // Invalid receipts retain Orchestra's CODEX_PREFLIGHT_RECEIPT_INVALID error.
  const asserted = orchestra.assertCodexSpawnProfile(receipt);
  if (asserted !== receipt) {
    throw new RuntimeConfigError(
      'Codex preflight assertion returned a different receipt.',
      {
        code: 'CODEX_PREFLIGHT_INVALID',
        runtime: 'codex',
        availabilityState: 'available',
      },
    );
  }
  const profile = asserted?.expectedStaticProfile;
  const spawnProfileId = requireConfigString(
    asserted?.spawnProfileId,
    'spawn profile ID',
    'codexAvailability',
  );
  for (const [field, label] of [
    ['model', 'Codex model'],
    ['effort', 'Codex effort'],
    ['cwd', 'Codex cwd'],
  ]) {
    requireConfigString(profile?.[field], label, 'codexAvailability');
  }

  const availability = Object.freeze({
    state: 'available',
    spawnProfileId,
  });
  assertedReceiptByAvailability.set(availability, asserted);
  return availability;
}

/**
 * @param {object} opts
 * @param {object} [opts.config]
 * @param {string|number|null} [opts.chatId]
 * @param {string|number|null} [opts.threadId]
 * @param {string} [opts.defaultPm='sdk']
 * @param {object} [opts.codexAvailability]
 * @param {object|null} [opts.composedClaudeOptions]
 *   The final result of Polygram's buildSdkOptions composition. Without it,
 *   model/effort remain unknown rather than inventing precedence.
 * @param {object} [opts.logger]
 * @returns {object}
 */
function resolveRuntimeConfig({
  config = {},
  chatId = null,
  threadId = null,
  defaultPm = 'sdk',
  codexAvailability,
  composedClaudeOptions = null,
  logger = console,
} = {}) {
  const scopes = configScopes(config, chatId, threadId);
  const selection = resolveRuntimeDescriptor({
    config,
    chatId,
    threadId,
    defaultPm,
    logger,
  });
  const pmChoice = {
    value: selection.configuredPm,
    source: selection.source,
  };
  const isCodex = selection.runtime === 'codex';
  const descriptor = selection.descriptor;

  let modelChoice;
  let effortChoice;
  let cwdChoice;
  let agentChoice;
  let spawnProfileId = null;

  if (isCodex) {
    const receipt = validateCodexAvailability(codexAvailability);
    modelChoice = resolveScopedValue(
      scopes.providerOptions,
      'codexModel',
      null,
    );
    effortChoice = resolveScopedValue(
      scopes.providerOptions,
      'codexEffort',
      null,
    );
    cwdChoice = resolveScopedValue(scopes.codexSpawn, 'cwd', null);
    agentChoice = { value: null, source: null };

    modelChoice.value = requireConfigString(
      modelChoice.value,
      'Codex model',
      modelChoice.source,
      'CODEX_RUNTIME_SELECTION_INCOMPLETE',
    );
    effortChoice.value = requireConfigString(
      effortChoice.value,
      'Codex effort',
      effortChoice.source,
      'CODEX_RUNTIME_SELECTION_INCOMPLETE',
    );
    cwdChoice.value = requireConfigString(
      cwdChoice.value,
      'Codex cwd',
      cwdChoice.source,
      'CODEX_RUNTIME_SELECTION_INCOMPLETE',
    );

    const expected = receipt.expectedStaticProfile;
    if (expected.cwd !== cwdChoice.value) {
      throw new RuntimeConfigError(
        'Codex preflight profile does not match selected cwd.',
        {
          code: 'CODEX_PREFLIGHT_PROFILE_MISMATCH',
          runtime: 'codex',
          availabilityState: 'available',
          reason: 'mismatched fields: cwd',
          action: 'Run preflight with the exact selected cwd.',
        },
      );
    }
    const selectedModels = Array.isArray(receipt.modelCatalog)
      ? receipt.modelCatalog.filter(
        (entry) => entry?.model === modelChoice.value,
      )
      : [];
    if (
      selectedModels.length !== 1
      || !Array.isArray(selectedModels[0].supportedReasoningEfforts)
      || !selectedModels[0].supportedReasoningEfforts
        .includes(effortChoice.value)
    ) {
      throw new RuntimeConfigError(
        'Codex model and effort are not in the authenticated catalog.',
        {
          code: 'CODEX_PREFLIGHT_PROFILE_MISMATCH',
          runtime: 'codex',
          availabilityState: 'available',
          reason: 'selected model/effort pair is unavailable',
          action: 'Choose a model and effort from the authenticated Codex catalog.',
        },
      );
    }
    spawnProfileId = receipt.spawnProfileId;
  } else {
    const chat = scopes.chat;
    const topic = scopes.topic;
    cwdChoice = resolveTruthyValue([
      ['topic', topic],
      ['chat', chat],
    ], 'cwd');
    agentChoice = resolveTruthyValue([
      ['topic', topic],
      ['chat', chat],
    ], 'agent');
    cwdChoice.value = optionalConfigString(
      cwdChoice.value,
      'Claude cwd',
      cwdChoice.source,
    );
    agentChoice.value = optionalConfigString(
      agentChoice.value,
      'Claude agent',
      agentChoice.source,
    );

    if (composedClaudeOptions == null) {
      modelChoice = { value: null, source: null };
      effortChoice = { value: null, source: null };
    } else {
      if (
        typeof composedClaudeOptions !== 'object'
        || Array.isArray(composedClaudeOptions)
      ) {
        throw invalidConfigValue(
          'composed Claude options',
          composedClaudeOptions,
          'composed-options',
        );
      }
      modelChoice = {
        value: optionalConfigString(
          composedClaudeOptions.model,
          'composed Claude model',
          'composed-options',
        ),
        source: 'composed-options',
      };
      effortChoice = {
        value: optionalConfigString(
          composedClaudeOptions.effort,
          'composed Claude effort',
          'composed-options',
        ),
        source: 'composed-options',
      };
    }
  }

  const modelFamily = descriptor.provider;
  const identity = stableRuntimeConfigIdentity({
    runtime: descriptor.runtime,
    backend: descriptor.backend,
    sessionNamespace: descriptor.sessionNamespace,
    promptMode: descriptor.promptMode,
    modelFamily,
    model: modelChoice.value,
    effort: effortChoice.value,
    cwd: cwdChoice.value,
    agent: agentChoice.value,
    spawnProfileId,
  });

  return Object.freeze({
    configuredPm: pmChoice.value,
    ...descriptor,
    modelFamily,
    modelField: modelFamily === 'codex' ? 'codexModel' : 'model',
    effortField: modelFamily === 'codex' ? 'codexEffort' : 'effort',
    model: modelChoice.value,
    effort: effortChoice.value,
    cwd: cwdChoice.value,
    agent: agentChoice.value,
    sources: Object.freeze({
      pm: pmChoice.source,
      model: modelChoice.source,
      effort: effortChoice.source,
      cwd: cwdChoice.source,
      agent: agentChoice.source,
    }),
    spawnProfileId,
    // This digest belongs to Polygram's config/application layer. Orchestra's
    // strict replaceRuntime uses its own runtime/backend/profile identity.
    runtimeConfigIdentity: identity,
  });
}

/**
 * Resolve only the operator-selected Codex inputs needed to run the matching
 * preflight. This does not make Codex available and carries no receipt.
 */
function resolveCodexRuntimeRequest({
  config = {},
  chatId = null,
  threadId = null,
  defaultPm = 'sdk',
} = {}) {
  const pmChoice = resolvePmChoice(config, chatId, threadId, defaultPm);
  if (!chatId || pmChoice.value !== 'codex') return null;

  const scopes = configScopes(config, chatId, threadId);
  const modelChoice = resolveScopedValue(
    scopes.providerOptions,
    'codexModel',
    null,
  );
  const effortChoice = resolveScopedValue(
    scopes.providerOptions,
    'codexEffort',
    null,
  );
  const cwdChoice = resolveScopedValue(scopes.codexSpawn, 'cwd', null);
  const sources = Object.freeze({
    pm: pmChoice.source,
    model: modelChoice.source,
    effort: effortChoice.source,
    cwd: cwdChoice.source,
  });

  return Object.freeze({
    runtime: 'codex',
    model: requireConfigString(
      modelChoice.value,
      'Codex model',
      modelChoice.source,
      'CODEX_RUNTIME_SELECTION_INCOMPLETE',
    ),
    effort: requireConfigString(
      effortChoice.value,
      'Codex effort',
      effortChoice.source,
      'CODEX_RUNTIME_SELECTION_INCOMPLETE',
    ),
    cwd: requireConfigString(
      cwdChoice.value,
      'Codex cwd',
      cwdChoice.source,
      'CODEX_RUNTIME_SELECTION_INCOMPLETE',
    ),
    sources,
  });
}

function configScopes(config, chatId, threadId) {
  const hasChat = Boolean(chatId);
  const chat = hasChat ? config?.chats?.[chatId] : null;
  const topic = hasChat && threadId ? chat?.topics?.[threadId] : null;
  return {
    chat,
    topic,
    providerOptions: [
      ['topic', topic],
      ['chat', chat],
      ['bot', config?.bot],
      ['default', config?.defaults],
    ],
    codexSpawn: [
      ['topic', topic],
      ['chat', chat],
      ['default', config?.defaults],
    ],
  };
}

function resolvePmChoice(config, chatId, threadId, defaultPm) {
  if (!chatId) return { value: defaultPm, source: 'default' };
  const chat = config?.chats?.[chatId];
  const topic = threadId && chat?.topics?.[threadId];
  if (topic?.pm) return { value: topic.pm, source: 'topic' };
  if (chat?.pm) return { value: chat.pm, source: 'chat' };
  if (config?.bot?.pm) return { value: config.bot.pm, source: 'bot' };
  return { value: defaultPm, source: 'default' };
}

function resolveRuntimeDescriptor({
  config = {},
  chatId = null,
  threadId = null,
  defaultPm = 'sdk',
  logger = console,
} = {}) {
  const pmChoice = resolvePmChoice(config, chatId, threadId, defaultPm);
  const isCodex = Boolean(chatId) && pmChoice.value === 'codex';
  const pickedBackend = isCodex
    ? 'codex'
    : pickBackend({
      config,
      chatId,
      threadId,
      logger,
      pmDefault: defaultPm,
    });
  // Orchestra's factory treats every non-CLI result as SDK. In particular,
  // pickBackend returns pmDefault untouched when chatId is falsy.
  const canonicalBackend = isCodex
    ? 'codex'
    : pickedBackend === 'cli'
      ? 'cli'
      : 'sdk';
  return Object.freeze({
    configuredPm: pmChoice.value,
    source: pmChoice.source,
    runtime: PM_DESCRIPTORS[canonicalBackend].runtime,
    backend: canonicalBackend,
    promptMode: PM_DESCRIPTORS[canonicalBackend].promptMode,
    descriptor: PM_DESCRIPTORS[canonicalBackend],
  });
}

function resolveScopedValue(scopes, field, fallback) {
  for (const [source, scope] of scopes) {
    if (
      scope
      && Object.hasOwn(scope, field)
      && scope[field] !== null
      && scope[field] !== undefined
    ) {
      return { value: scope[field], source };
    }
  }
  return { value: fallback, source: 'default' };
}

function resolveTruthyValue(scopes, field) {
  for (const [source, scope] of scopes) {
    if (scope?.[field]) return { value: scope[field], source };
  }
  return { value: null, source: null };
}

function validateCodexAvailability(input) {
  const availability = input ?? DEFAULT_CODEX_AVAILABILITY;
  if (availability?.state === 'available') {
    const receipt = (
      availability
      && typeof availability === 'object'
      && assertedReceiptByAvailability.get(availability)
    );
    if (!receipt) {
      throw new RuntimeConfigError(
        'Codex availability was not constructed from an asserted spawn receipt.',
        {
          code: 'CODEX_PREFLIGHT_INVALID',
          runtime: 'codex',
          availabilityState: 'available',
          reason: 'unbranded or copied availability object',
          action: 'Use createCodexRuntimeAvailability with the exact preflight receipt.',
        },
      );
    }
    return receipt;
  }

  const errorInfo = CODEX_ERROR_BY_STATE[availability?.state];
  if (!errorInfo) {
    throw new RuntimeConfigError(
      `Unknown Codex availability state '${String(availability?.state)}'`,
      {
        code: 'RUNTIME_CONFIG_INVALID',
        source: 'codexAvailability',
        value: availability?.state,
        runtime: 'codex',
        action: 'Use available, loading, unavailable, or ineligible.',
      },
    );
  }

  const reason = typeof availability.reason === 'string' && availability.reason
    ? availability.reason
    : 'No additional reason was provided';
  throw new RuntimeConfigError(
    `Codex runtime is ${availability.state}: ${reason}. ${errorInfo.action}`,
    {
      code: errorInfo.code,
      runtime: 'codex',
      availabilityState: availability.state,
      reason,
      action: errorInfo.action,
    },
  );
}

function invalidConfigValue(label, value, source, code = 'RUNTIME_CONFIG_VALUE_INVALID') {
  return new RuntimeConfigError(
    `${label} at ${source ?? 'unknown'} scope must be a bounded string.`,
    {
      code,
      source,
      value: (
        typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
      ) ? value : null,
      runtime: label.startsWith('Codex') ? 'codex' : null,
    },
  );
}

function requireConfigString(
  value,
  label,
  source,
  missingCode = 'RUNTIME_CONFIG_VALUE_INVALID',
) {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_CONFIG_VALUE_LENGTH
  ) {
    const code = value == null || value === ''
      ? missingCode
      : 'RUNTIME_CONFIG_VALUE_INVALID';
    throw invalidConfigValue(label, value, source, code);
  }
  return value;
}

function optionalConfigString(value, label, source) {
  if (value == null) return null;
  return requireConfigString(value, label, source);
}

function stableRuntimeConfigIdentity(fields) {
  const model = fields.runtime === 'codex' ? null : fields.model;
  const effort = fields.runtime === 'codex' ? null : fields.effort;
  const canonical = JSON.stringify([
    fields.runtime,
    fields.backend,
    fields.sessionNamespace,
    fields.promptMode,
    fields.modelFamily,
    model,
    effort,
    fields.cwd,
    fields.agent,
    fields.spawnProfileId,
  ]);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `runtime-config:v1:${digest}`;
}

module.exports = {
  createCodexRuntimeAvailability,
  RuntimeConfigError,
  resolveCodexRuntimeRequest,
  resolveRuntimeConfig,
  resolveRuntimeDescriptor,
};

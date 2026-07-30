/**
 * Config card UI builders — inline keyboard + descriptive body
 * shown above it. Used by polygram's /config slash command and
 * the runtime/model/effort callback re-render paths
 * (lib/handlers/config-callback.js).
 *
 * Pure functions (no DB / fs). `formatConfigInfoText` is factory-wrapped
 * only so a caller can supply the async runtime-view resolver; the
 * keyboard builder is a top-level export.
 *
 * MODEL_VERSIONS_DESC bumps with each Claude release — see polygram's
 * release notes for the verification step (`claude --model <alias>`
 * + check the system:init event's `model` field). Surfaced by the
 * /model reply, not by the card.
 */

'use strict';

const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'];
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Which runtimes the card offers. The sdk backend stays fully supported in
// code and config files — it is per-token and nobody picks it from a chat, so
// it has no button. A chat configured on it simply shows no ✓ on this row.
const RUNTIME_OPTIONS = Object.freeze([
  Object.freeze({ backend: 'cli', label: 'Claude' }),
  Object.freeze({ backend: 'codex', label: 'Codex' }),
]);

function isCodexRuntimeView(runtimeView) {
  return runtimeView?.runtime === 'codex';
}

function canonicalRuntimeBackend(runtimeView) {
  const backend = runtimeView?.backend;
  if (backend === 'sdk' || backend === 'cli' || backend === 'codex') {
    return backend;
  }
  if (backend === 'tmux' || backend === 'channels') return 'cli';
  if (
    runtimeView?.runtime === 'codex'
    || runtimeView?.runtime === 'cli'
    || runtimeView?.runtime === 'sdk'
  ) {
    return runtimeView.runtime;
  }
  return 'sdk';
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(
    (value) => typeof value === 'string' && value.length > 0,
  ))];
}

function getCodexCatalogModels(runtimeView) {
  if (!isCodexRuntimeView(runtimeView) || !Array.isArray(runtimeView.models)) {
    return [];
  }
  const seen = new Set();
  return runtimeView.models.filter((entry) => {
    if (
      !entry
      || typeof entry.model !== 'string'
      || entry.model.length === 0
      || seen.has(entry.model)
    ) {
      return false;
    }
    seen.add(entry.model);
    return true;
  });
}

function getCodexCatalogEfforts(runtimeView, model = runtimeView?.model) {
  if (!isCodexRuntimeView(runtimeView)) return [];
  const catalogEfforts = uniqueStrings(runtimeView.efforts);
  const modelEntry = getCodexCatalogModels(runtimeView)
    .find((entry) => entry.model === model);
  const modelEfforts = uniqueStrings(modelEntry?.supportedReasoningEfforts);
  if (modelEntry) return modelEfforts;
  return model === runtimeView.model ? catalogEfforts : [];
}

function resolveCodexEffortForModel(runtimeView, model, currentEffort) {
  const modelEntry = getCodexCatalogModels(runtimeView)
    .find((entry) => entry.model === model);
  if (!modelEntry) return null;
  const supported = uniqueStrings(modelEntry.supportedReasoningEfforts);
  if (supported.includes(currentEffort)) return currentEffort;
  return supported.includes(modelEntry.defaultReasoningEffort)
    ? modelEntry.defaultReasoningEffort
    : null;
}

function formatSettingsPair(settings) {
  if (
    !settings
    || typeof settings.model !== 'string'
    || typeof settings.effort !== 'string'
  ) {
    return null;
  }
  return `${settings.model}/${settings.effort}`;
}

function formatCodexSettingsOutcome(result) {
  const next = formatSettingsPair(result?.nextTurn);
  switch (result?.outcome) {
    case 'updated-live': {
      const current = formatSettingsPair(result.currentTurn);
      return current
        ? ` — current turn ${current} unchanged; next turn ${next}`
        : ' — selected for next turn';
    }
    case 'not-loaded':
      return " — selected for this chat's next session";
    case 'daemon-busy':
      return ' — selected; this chat is not loaded; its next message may be busy';
    case 'unavailable':
      return ' — selected durably, but the current process did not accept it'
        + (result.reason ? ` (${result.reason})` : '');
    case 'live-status-unknown':
      return ' — selected durably; live status is unknown';
    default:
      return ' — selected durably; live status is unknown';
  }
}

function withCodexSettingsOutcome(runtimeView, result) {
  if (!isCodexRuntimeView(runtimeView)) return runtimeView;
  const desiredSettings = result?.nextTurn ?? runtimeView.desiredSettings ?? {
    model: runtimeView.model,
    effort: runtimeView.effort,
  };
  let processStatus = runtimeView.processStatus;
  let activeTurnSettings = runtimeView.activeTurnSettings ?? null;
  let nextTurnSettings = runtimeView.nextTurnSettings ?? null;
  let unavailableReason = runtimeView.unavailableReason ?? null;
  switch (result?.outcome) {
    case 'updated-live':
      processStatus = 'loaded';
      activeTurnSettings = result.currentTurn ?? null;
      nextTurnSettings = result.nextTurn ?? null;
      unavailableReason = null;
      break;
    case 'not-loaded':
    case 'daemon-busy':
      processStatus = result.outcome;
      activeTurnSettings = null;
      nextTurnSettings = null;
      break;
    case 'unavailable':
      processStatus = 'unavailable';
      unavailableReason = result.reason ?? null;
      break;
    case 'live-status-unknown':
      processStatus = 'unknown';
      break;
    default:
      break;
  }
  return Object.freeze({
    ...runtimeView,
    model: desiredSettings.model,
    effort: desiredSettings.effort,
    desiredSettings: Object.freeze({ ...desiredSettings }),
    activeTurnSettings,
    nextTurnSettings,
    processStatus,
    unavailableReason,
  });
}

function configuredRuntimeValue(
  chatConfig,
  topicConfig,
  runtimeView,
  setting,
) {
  const codex = isCodexRuntimeView(runtimeView);
  const field = codex
    ? setting === 'model' ? 'codexModel' : 'codexEffort'
    : setting;
  return (
    (topicConfig && topicConfig[field])
    || chatConfig[field]
    || (codex ? runtimeView[setting] : null)
  );
}

// Runtime callers pass the value resolved from the full config hierarchy.
// Direct callers may omit it and retain the local topic/chat behavior.
function resolveDisplayRichText(chatConfig, topicConfig, effectiveRichText) {
  if (typeof effectiveRichText === 'boolean') return effectiveRichText;
  const pick = (v) => (typeof v === 'boolean' ? v : undefined);
  return pick(topicConfig?.richText)
    ?? pick(chatConfig?.richText)
    ?? false;
}

// Mirrors what `claude --model <alias>` resolves to. Display only —
// polygram passes the alias (opus / sonnet / haiku) and lets claude
// resolve. Bump on Claude release.
const MODEL_VERSIONS_DESC = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

/**
 * Build the inline keyboard for /model + /effort.
 *   show = 'model' | 'effort' | 'all'
 * The current value gets a ✓ prefix. `topicConfig` (per-topic overrides, or
 * null for the chat-level card) wins over chatConfig so the ✓ matches what a
 * topic actually runs — mirrors the spawn-path precedence (topic > chat).
 */
function buildConfigKeyboard(
  chatConfig,
  show = 'all',
  topicConfig = null,
  effectiveRichText,
  runtimeView = null,
) {
  const codex = isCodexRuntimeView(runtimeView);
  const model = configuredRuntimeValue(
    chatConfig,
    topicConfig,
    runtimeView,
    'model',
  );
  const effort = configuredRuntimeValue(
    chatConfig,
    topicConfig,
    runtimeView,
    'effort',
  );
  const modelOptions = codex
    ? getCodexCatalogModels(runtimeView)
    : MODEL_OPTIONS.map((value) => ({ model: value, displayName: value }));
  const effortOptions = codex
    ? getCodexCatalogEfforts(runtimeView, model)
    : EFFORT_OPTIONS;
  const rows = [];
  if (show === 'all') {
    const currentBackend = canonicalRuntimeBackend(runtimeView);
    rows.push(RUNTIME_OPTIONS.map(({ backend, label }) => ({
      text: backend === currentBackend ? `✓ ${label}` : label,
      callback_data: `cfg:runtime:${backend}`,
    })));
  }
  if ((show === 'model' || show === 'all') && modelOptions.length > 0) {
    rows.push(modelOptions.map((entry) => {
      const label = (
        typeof entry.displayName === 'string'
        && entry.displayName.length > 0
      ) ? entry.displayName : entry.model;
      return {
        text: entry.model === model ? `✓ ${label}` : label,
        callback_data: `cfg:model:${entry.model}`,
      };
    }));
  }
  if ((show === 'effort' || show === 'all') && effortOptions.length > 0) {
    rows.push(effortOptions.map((e) => ({
      text: e === effort ? `✓ ${e}` : e,
      callback_data: `cfg:effort:${e}`,
    })));
  }
  // Rich text is a boolean toggle on the full config card. Model-only
  // and effort-only cards keep their focused layouts.
  if (show === 'all') {
    const on = resolveDisplayRichText(chatConfig, topicConfig, effectiveRichText);
    rows.push([{
      text: on ? '✓ Rich text: on' : 'Rich text: off',
      callback_data: `cfg:richtext:${on ? 'off' : 'on'}`,
    }]);
  }
  return { inline_keyboard: rows };
}

/**
 * Factory for the card-body formatter.
 *
 * @param {object} [deps]
 * @param {(ctx: {sessionKey: string, chatId: string, threadId: ?string}) => object} [deps.resolveRuntimeView]
 *   — resolves the runtime view for callers that don't pass one; the view
 *   decides which runtime's help sections the card carries.
 */
function createFormatConfigInfoText({
  resolveRuntimeView = null,
} = {}) {
  function formatWithRuntimeView(
    chatConfig,
    show,
    sessionKey,
    topicConfig,
    effectiveRichText,
    runtimeView,
  ) {
    const codex = isCodexRuntimeView(runtimeView);
    // The selected Codex model decides which reasoning efforts its help section
    // may list — per-topic overrides win over chat-level, mirroring the spawn
    // path. Nothing else about the configuration is read here: the buttons under
    // the card carry it, each with its own ✓.
    const codexModels = codex ? getCodexCatalogModels(runtimeView) : [];
    const codexModel = codex
      ? configuredRuntimeValue(chatConfig, topicConfig, runtimeView, 'model')
      : null;
    const codexEfforts = codex
      ? getCodexCatalogEfforts(runtimeView, codexModel)
      : [];
    const modelHelp = codex
      ? codexModels.length > 0 ? [
        '',
        '**Models**',
        ...codexModels.map((entry) => {
          const displayName = (
            typeof entry.displayName === 'string'
            && entry.displayName.length > 0
            && entry.displayName !== entry.model
          ) ? ` — ${entry.displayName}` : '';
          return `• **${entry.model}**${displayName}`;
        }),
      ].join('\n') : [
        '',
        '**Models**',
        'Models are unavailable until Codex preflight succeeds.',
      ].join('\n')
      : [
        '',
        '**Models**',
        '🧠 **opus** — deep analysis, code refactor, multi-source reconciliation. ~1.7× sonnet cost.',
        '🤖 **sonnet** — default. Most ops, code review, document summary.',
        '⚡ **haiku** — quick simple tasks, classification, lookup.',
      ].join('\n');

    const effortHelp = codex
      ? codexEfforts.length > 0 ? [
        '',
        `**Effort** — authenticated options for ${codexModel}:`,
        ...codexEfforts.map((value) => `• **${value}**`),
        'Model and effort changes apply to the next turn; an active turn is unchanged.',
      ].join('\n') : [
        '',
        '**Effort**',
        'Effort options are unavailable until Codex preflight succeeds.',
      ].join('\n')
      : [
        '',
        '**Effort** — ceiling on how much Claude can think. Simple questions get fast replies; hard ones spend more tokens. Safe to set higher — Claude scales down automatically when it doesn\'t need to think.',
        '• **low** — fast replies, minimum reasoning. Casual chat, simple lookups.',
        '• **medium** — balanced default. Fits most use cases.',
        '• **high** — multi-step tasks. Audit, debug, multi-source analysis.',
        '• **xhigh** / **max** — heaviest. Hard reasoning, edge cases.',
      ].join('\n');

    // The card is its buttons. Everything the body used to state — model,
    // effort, rich text, runtime, agent, process, session — is already on a
    // button below it, with a ✓ on the current value. What is left is the
    // header (Telegram rejects an empty message) and the help that has no
    // button to live on.
    let body = '⚙️ Settings';
    if (codex) {
      body += '\n\nNative Codex beta: command network and web search are disabled. '
        + 'Product MCP tools and interactive approvals are unavailable. '
        + 'Detached/background servers are unsupported and may survive hard runtime loss. '
        + 'Native goals are disabled for Polygram-managed Codex sessions until '
        + 'native goal support is implemented.';
    }
    if (show === 'model' || show === 'all') body += '\n' + modelHelp;
    if (show === 'effort' || show === 'all') body += '\n' + effortHelp;
    return body;
  }

  return function formatConfigInfoText(
    chatConfig,
    show,
    sessionKey,
    topicConfig = null,
    effectiveRichText,
    runtimeView = null,
  ) {
    if (typeof resolveRuntimeView !== 'function' || runtimeView != null) {
      return formatWithRuntimeView(
        chatConfig,
        show,
        sessionKey,
        topicConfig,
        effectiveRichText,
        runtimeView,
      );
    }
    const separator = String(sessionKey).indexOf(':');
    const chatId = separator < 0
      ? String(sessionKey)
      : String(sessionKey).slice(0, separator);
    const threadId = separator < 0
      ? null
      : String(sessionKey).slice(separator + 1) || null;
    return Promise.resolve(resolveRuntimeView({
      sessionKey,
      chatId,
      threadId,
    })).then((resolvedView) => formatWithRuntimeView(
      chatConfig,
      show,
      sessionKey,
      topicConfig,
      effectiveRichText,
      resolvedView,
    ));
  };
}

module.exports = {
  buildConfigKeyboard,
  createFormatConfigInfoText,
  RUNTIME_OPTIONS,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  MODEL_VERSIONS_DESC,
  configuredRuntimeValue,
  getCodexCatalogEfforts,
  getCodexCatalogModels,
  isCodexRuntimeView,
  formatCodexSettingsOutcome,
  resolveCodexEffortForModel,
  withCodexSettingsOutcome,
};

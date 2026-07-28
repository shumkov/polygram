/**
 * Config card UI builders — inline keyboard + descriptive body
 * shown above it. Used by polygram's /config slash command and
 * the /model + /effort callback re-render path
 * (lib/handlers/config-callback.js).
 *
 * Pure functions (no DB / fs) but `formatConfigInfoText` needs
 * runtime context (pm to check warm/cold, db + getClaudeSessionId
 * to fetch session id) → factory wraps it. Keyboard builder is a
 * top-level export.
 *
 * MODEL_VERSIONS_DESC bumps with each Claude release — see polygram's
 * release notes for the verification step (`claude --model <alias>`
 * + check the system:init event's `model` field).
 */

'use strict';

const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'];
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];

function isCodexRuntimeView(runtimeView) {
  return runtimeView?.runtime === 'codex';
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

function sameSettingsPair(left, right) {
  return (
    left?.model === right?.model
    && left?.effort === right?.effort
  );
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
  if (show === 'model' || show === 'all') {
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
  if (show === 'effort' || show === 'all') {
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
 * Factory for the card-body formatter. Needs runtime pm + db + a
 * getClaudeSessionId fetcher.
 *
 * @param {object} deps
 * @param {object} deps.pm
 * @param {object} deps.db
 * @param {(db, sessionKey) => string|null} deps.getClaudeSessionId
 */
function createFormatConfigInfoText({
  pm,
  db,
  getClaudeSessionId,
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
    const alive = pm.has(sessionKey) && !pm.get(sessionKey).closed;
    const codex = isCodexRuntimeView(runtimeView);
    // Per-topic overrides win over chat-level for the displayed values,
    // mirroring the spawn path (polygram.js: topicConfig.agent ||
    // chatConfig.agent). Pre-fix the card always read chat-level, so a topic's
    // /model showed the WRONG agent — shumorobot Music topic (thread 3) showed
    // "Agent: shumabit" instead of its music-curation:music-curator override
    // (2026-06-03). topicConfig defaults to null (chat-level) for callers with
    // no active topic.
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
    const agent = (topicConfig && topicConfig.agent) || chatConfig.agent;
    const codexModelEntry = codex
      ? getCodexCatalogModels(runtimeView)
        .find((entry) => entry.model === model)
      : null;
    const codexDisplayName = codexModelEntry?.displayName;
    const ver = codex
      ? (
        typeof codexDisplayName === 'string'
        && codexDisplayName.length > 0
        && codexDisplayName !== model
          ? codexDisplayName
          : model
      )
      : MODEL_VERSIONS_DESC[model] || model;
    const sess = codex
      ? 'managed by Codex'
      : getClaudeSessionId(db, sessionKey)?.slice(0, 8) || 'new';
    // Running vs configured: cli can't hot-swap model/effort, so a /model or
    // /effort change is PENDING until the session reloads (on the next message).
    // Show the truth — the live proc's spawn-time value (proc.model/proc.effort)
    // vs the configured one — so the card never claims a model the session
    // isn't actually running (the "says opus, runs sonnet" confusion). SDK
    // applies live (its proc value tracks config) so no drift line ever shows.
    const proc = alive ? pm.get(sessionKey) : null;
    const runModel = proc && proc.model;
    const runEffort = proc && proc.effort;
    const modelLine = (runModel && runModel !== model)
      ? `Model: ${runModel} (running) → ${model} (pending — applies on your next message)`
      : `Model: ${model} (${ver})`;
    const effortLine = (runEffort && runEffort !== effort)
      ? `Effort: ${runEffort} (running) → ${effort} (pending — applies on your next message)`
      : `Effort: ${effort}`;
    // Delivery reads richText live, while the authoring hint is fixed at
    // session spawn. Explain that lag separately from model/effort,
    // which have concrete running and configured values to compare.
    const richText = resolveDisplayRichText(chatConfig, topicConfig, effectiveRichText);
    const richTextLine = richText
      ? 'Rich text: on (headings/tables/checklists on qualifying replies; agent authors for it once this session next (re)spawns)'
      : 'Rich text: off';
    const identityLine = codex
      ? 'Runtime: Codex app-server'
      : `Agent: ${agent}`;
    let head;
    if (codex) {
      const desired = runtimeView.desiredSettings ?? { model, effort };
      const desiredPair = formatSettingsPair(desired) ?? `${model}/${effort}`;
      const activePair = formatSettingsPair(runtimeView.activeTurnSettings);
      const nextTurn = runtimeView.nextTurnSettings;
      const nextTurnPair = formatSettingsPair(nextTurn);
      const observedPair = formatSettingsPair(
        runtimeView.observedThreadSettings,
      );
      const processStatus = runtimeView.processStatus
        ?? (alive ? 'loaded' : 'not-loaded');
      const settingsLines = [];
      if (processStatus === 'loaded') {
        if (activePair) {
          settingsLines.push(`Current turn: ${activePair}`);
          settingsLines.push(`Next turn: ${nextTurnPair ?? desiredPair}`);
        } else {
          settingsLines.push(
            `Selected for next turn: ${nextTurnPair ?? desiredPair}`,
          );
        }
        if (
          nextTurnPair
          && !sameSettingsPair(nextTurn, desired)
        ) {
          settingsLines.push(
            `Saved selection awaiting live reconciliation: ${desiredPair}`,
          );
        }
      } else if (processStatus === 'not-loaded') {
        settingsLines.push(
          `Selected for this chat's next session: ${desiredPair}`,
        );
      } else {
        settingsLines.push(`Selected: ${desiredPair}`);
      }
      if (observedPair) {
        settingsLines.push(`Observed thread: ${observedPair}`);
      }
      let processLine;
      if (processStatus === 'daemon-busy') {
        processLine = 'Process: not loaded; its next message may be busy';
      } else if (processStatus === 'unavailable') {
        processLine = 'Process: unavailable'
          + (
            runtimeView.unavailableReason
              ? ` (${runtimeView.unavailableReason})`
              : ''
          );
      } else if (processStatus === 'unknown') {
        processLine = 'Process: live status unknown';
      } else {
        processLine = `Process: ${
          processStatus === 'loaded' ? 'warm' : 'not loaded'
        }`;
      }
      head = [
        ...settingsLines,
        richTextLine,
        identityLine,
        processLine,
        `Session: ${sess}`,
      ].join('\n');
    } else {
      head =
        `${modelLine}\n` +
        `${effortLine}\n` +
        `${richTextLine}\n` +
        `${identityLine}\n` +
        `Process: ${alive ? 'warm' : 'cold'}\n` +
        `Session: ${sess}`;
    }

    const modelHelp = codex
      ? [
        '',
        '**Models**',
        ...getCodexCatalogModels(runtimeView).map((entry) => {
          const displayName = (
            typeof entry.displayName === 'string'
            && entry.displayName.length > 0
            && entry.displayName !== entry.model
          ) ? ` — ${entry.displayName}` : '';
          return `• **${entry.model}**${displayName}`;
        }),
      ].join('\n')
      : [
        '',
        '**Models**',
        '🧠 **opus** — deep analysis, code refactor, multi-source reconciliation. ~1.7× sonnet cost.',
        '🤖 **sonnet** — default. Most ops, code review, document summary.',
        '⚡ **haiku** — quick simple tasks, classification, lookup.',
      ].join('\n');

    const effortHelp = codex
      ? [
        '',
        `**Effort** — authenticated options for ${model}:`,
        ...getCodexCatalogEfforts(runtimeView, model)
          .map((value) => `• **${value}**`),
        'Model and effort changes apply to the next turn; an active turn is unchanged.',
      ].join('\n')
      : [
        '',
        '**Effort** — ceiling on how much Claude can think. Simple questions get fast replies; hard ones spend more tokens. Safe to set higher — Claude scales down automatically when it doesn\'t need to think.',
        '• **low** — fast replies, minimum reasoning. Casual chat, simple lookups.',
        '• **medium** — balanced default. Fits most use cases.',
        '• **high** — multi-step tasks. Audit, debug, multi-source analysis.',
        '• **xhigh** / **max** — heaviest. Hard reasoning, edge cases.',
      ].join('\n');

    let body = head;
    if (codex) {
      body += '\n\nNative Codex beta: command network and web search are disabled. '
        + 'Product MCP tools and interactive approvals are unavailable. '
        + 'Detached/background servers are unsupported and may survive hard runtime loss.';
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

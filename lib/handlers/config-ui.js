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
  opus: 'claude-opus-4-8',
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
function buildConfigKeyboard(chatConfig, show = 'all', topicConfig = null, effectiveRichText) {
  const model = (topicConfig && topicConfig.model) || chatConfig.model;
  const effort = (topicConfig && topicConfig.effort) || chatConfig.effort;
  const rows = [];
  if (show === 'model' || show === 'all') {
    rows.push(MODEL_OPTIONS.map((m) => ({
      text: m === model ? `✓ ${m}` : m,
      callback_data: `cfg:model:${m}`,
    })));
  }
  if (show === 'effort' || show === 'all') {
    rows.push(EFFORT_OPTIONS.map((e) => ({
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
function createFormatConfigInfoText({ pm, db, getClaudeSessionId } = {}) {
  return function formatConfigInfoText(chatConfig, show, sessionKey, topicConfig = null, effectiveRichText) {
    const alive = pm.has(sessionKey) && !pm.get(sessionKey).closed;
    // Per-topic overrides win over chat-level for the displayed values,
    // mirroring the spawn path (polygram.js: topicConfig.agent ||
    // chatConfig.agent). Pre-fix the card always read chat-level, so a topic's
    // /model showed the WRONG agent — shumorobot Music topic (thread 3) showed
    // "Agent: shumabit" instead of its music-curation:music-curator override
    // (2026-06-03). topicConfig defaults to null (chat-level) for callers with
    // no active topic.
    const model = (topicConfig && topicConfig.model) || chatConfig.model;
    const effort = (topicConfig && topicConfig.effort) || chatConfig.effort;
    const agent = (topicConfig && topicConfig.agent) || chatConfig.agent;
    const ver = MODEL_VERSIONS_DESC[model] || model;
    const sess = getClaudeSessionId(db, sessionKey)?.slice(0, 8) || 'new';
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
    const head =
      `${modelLine}\n` +
      `${effortLine}\n` +
      `${richTextLine}\n` +
      `Agent: ${agent}\n` +
      `Process: ${alive ? 'warm' : 'cold'}\n` +
      `Session: ${sess}`;

    const modelHelp = [
      '',
      '**Models**',
      '🧠 **opus** — deep analysis, code refactor, multi-source reconciliation. ~5× sonnet cost.',
      '🤖 **sonnet** — default. Most ops, code review, document summary.',
      '⚡ **haiku** — quick simple tasks, classification, lookup.',
    ].join('\n');

    const effortHelp = [
      '',
      '**Effort** — ceiling on how much Claude can think. Simple questions get fast replies; hard ones spend more tokens. Safe to set higher — Claude scales down automatically when it doesn\'t need to think.',
      '• **low** — fast replies, minimum reasoning. Casual chat, simple lookups.',
      '• **medium** — balanced default. Fits most use cases.',
      '• **high** — multi-step tasks. Audit, debug, multi-source analysis.',
      '• **xhigh** / **max** — heaviest. Hard reasoning, edge cases.',
    ].join('\n');

    let body = head;
    if (show === 'model' || show === 'all') body += '\n' + modelHelp;
    if (show === 'effort' || show === 'all') body += '\n' + effortHelp;
    return body;
  };
}

module.exports = {
  buildConfigKeyboard,
  createFormatConfigInfoText,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  MODEL_VERSIONS_DESC,
};

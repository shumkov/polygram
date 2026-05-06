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

// Mirrors what `claude --model <alias>` resolves to. Display only —
// polygram passes the alias (opus / sonnet / haiku) and lets claude
// resolve. Bump on Claude release.
const MODEL_VERSIONS_DESC = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

/**
 * Build the inline keyboard for /model + /effort.
 *   show = 'model' | 'effort' | 'all'
 * The current value gets a ✓ prefix.
 */
function buildConfigKeyboard(chatConfig, show = 'all') {
  const rows = [];
  if (show === 'model' || show === 'all') {
    rows.push(MODEL_OPTIONS.map((m) => ({
      text: m === chatConfig.model ? `✓ ${m}` : m,
      callback_data: `cfg:model:${m}`,
    })));
  }
  if (show === 'effort' || show === 'all') {
    rows.push(EFFORT_OPTIONS.map((e) => ({
      text: e === chatConfig.effort ? `✓ ${e}` : e,
      callback_data: `cfg:effort:${e}`,
    })));
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
  return function formatConfigInfoText(chatConfig, show, sessionKey) {
    const alive = pm.has(sessionKey) && !pm.get(sessionKey).closed;
    const ver = MODEL_VERSIONS_DESC[chatConfig.model] || chatConfig.model;
    const sess = getClaudeSessionId(db, sessionKey)?.slice(0, 8) || 'new';
    const head =
      `Model: ${chatConfig.model} (${ver})\n` +
      `Effort: ${chatConfig.effort}\n` +
      `Agent: ${chatConfig.agent}\n` +
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

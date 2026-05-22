/**
 * Polygram-side display constraints injected into every chat's system
 * prompt. This is INFRASTRUCTURE knowledge — the agent's business
 * logic shouldn't have to know that Telegram's `<pre>` block on a
 * portrait iPhone wraps at ~36 monospace chars. The agent decides
 * *what* to render; polygram tells it *how* the surface displays.
 *
 * Why a polygram concern, not an agent concern:
 *   - Same agent runs across surfaces (Telegram bot, CLI, future
 *     surfaces). Each has its own width / markdown / image support.
 *   - Mixing display rules into agent prompts means every agent doc
 *     has to be updated when Telegram's rendering changes (or when
 *     we onboard a new chat surface). Centralising here keeps
 *     `_shumabit-base.md` and friends focused on business logic.
 *   - Tested in isolation; no risk of agent drift breaking tables.
 *
 * Width budget — measured 2026-04-30 from production screenshots:
 *   - iPhone portrait, default Telegram font: ~36 monospace chars
 *     per line in a `<pre>` block before wrap.
 *   - iPhone landscape: ~70.
 *   - Desktop client (macOS, default): ~85+.
 * Agents see the conservative number (40) so output stays clean on
 * the smallest reasonable surface.
 */

'use strict';

const TELEGRAM_TABLE_WIDTH_BUDGET = 40;

const POLYGRAM_DISPLAY_HINT = [
  '## Telegram display rules',
  '',
  'Your replies render in the Telegram client. Phone is the design target.',
  '',
  '### Tables — HARD RULE',
  '',
  `Before emitting any markdown table, count the longest row in characters (including pipes \`|\`, padding, and separator dashes). If that row is longer than ${TELEGRAM_TABLE_WIDTH_BUDGET}, you MUST NOT emit a table. Use row blocks instead.`,
  '',
  'This applies even when the user is on desktop. Tables don\'t scroll horizontally on mobile; they wrap and become unreadable. Row blocks always work on every surface.',
  '',
  '**Row block format:** one entity per paragraph, **bold** headline, then `Field: value` lines.',
  '',
  '```',
  '**Mini dress Keen → Black dress mini**',
  'COGS: ฿546 → ฿1144 (2.1×)',
  'Margin: 84.8% → 77% ↓',
  '',
  '**Tank top Sway → Top voluminous cotton**',
  'COGS: ฿360 → ฿947 (2.6×)',
  'Margin: 78.7% → 73% ↓',
  '```',
  '',
  'Do NOT start a wide table assuming the user can scroll. Decide BEFORE you start writing the first `|` whether all rows will fit. If unsure, use row blocks — they\'re always safe.',
  '',
  '### Other Telegram quirks',
  '',
  '- Headers `#`, `##`, `###` render as plain text — use **bold** for emphasis.',
  '- Horizontal rules render as a thin divider line.',
  '- Long replies stream in chunks; prefer concise structure over walls of text.',
  '',
  '### NEVER emit shell-context canned strings — HARD RULE',
  '',
  'You are running as a Telegram chat bot, NOT as a script being piped into a shell. Certain phrases are CLI-context boilerplate from the underlying environment and MUST NEVER appear in a reply, because the user sees them as a literal message from you and they look like a system error:',
  '',
  '- `No response requested.`',
  '- `No response needed.`',
  '- `Continuing...` as a standalone reply',
  '- Any other shell-prompt-style filler that acknowledges silence',
  '',
  'If a user message is short, ambiguous, or feels like a no-op acknowledgement (e.g. `okay`, `ok`, `yes`, `got it`, `thanks`), reply with a brief substantive line — acknowledge what you understood and what (if anything) you will do next. If you genuinely have nothing useful to say, ask ONE specific clarifying question. NEVER emit a placeholder or a shell-style canned string — the chat surface has no silent-no-op state. Every reply must be intentional content.',
].join('\n');

/**
 * Append the polygram display hint to an existing systemPrompt option,
 * preserving the original shape (string / preset object / undefined).
 * Pure function — does not mutate input.
 *
 * Shapes handled (matches @anthropic-ai/claude-agent-sdk's Options.systemPrompt):
 *   - undefined / null     → returns `{ type: 'preset', preset: 'claude_code', append: hint }`
 *   - string               → returns `string + '\n\n' + hint`
 *   - { type: 'preset', append?: string }
 *                          → merges hint into `append`
 *   - other (string[], etc.) → returns input unchanged (caller's responsibility)
 *
 * @param {*} systemPromptOpt — current SdkOptions.systemPrompt value
 * @param {string} [hint]    — override the default hint (used by tests)
 * @returns {*} new systemPrompt option with the hint appended
 */
function appendDisplayHint(systemPromptOpt, hint = POLYGRAM_DISPLAY_HINT) {
  if (!hint) return systemPromptOpt;

  if (systemPromptOpt == null) {
    return { type: 'preset', preset: 'claude_code', append: hint };
  }

  if (typeof systemPromptOpt === 'string') {
    return `${systemPromptOpt}\n\n${hint}`;
  }

  if (typeof systemPromptOpt === 'object' && systemPromptOpt.type === 'preset') {
    const existingAppend = typeof systemPromptOpt.append === 'string' ? systemPromptOpt.append : '';
    const newAppend = existingAppend ? `${existingAppend}\n\n${hint}` : hint;
    return { ...systemPromptOpt, append: newAppend };
  }

  // Unknown shape (e.g. string[]) — return as-is. Caller can opt in
  // by passing a supported shape.
  return systemPromptOpt;
}

module.exports = {
  POLYGRAM_DISPLAY_HINT,
  TELEGRAM_TABLE_WIDTH_BUDGET,
  appendDisplayHint,
};

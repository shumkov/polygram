/**
 * Pure formatters for /context command output and the context-full hint.
 *
 * Lifted from polygram.js so the formatting can be unit-tested without
 * spinning up the full handleMessage stack. Both functions are pure —
 * no I/O, no Date.now, no module-level state.
 *
 * Background — rc.4 percentage scale:
 *   The SDK's `getContextUsage()` returns `percentage` already on a
 *   0-100 scale (verified in rc.3 production: a 77%-used context
 *   reported `percentage: 77`). Pre-rc.4 polygram treated it as a
 *   0-1 ratio and multiplied by 100, which displayed "7700% full" and
 *   skipped the 85% hint threshold. The formatters below assume the
 *   0-100 scale; do not multiply or divide.
 *
 * rc.56 threshold change: default lowered from 85 → 70.
 *   Background: at 85% the SDK has typically already auto-compacted
 *   mid-turn, so polygram's post-turn check sees a low percentage
 *   and the hint never fires. Production data showed 0 user-visible
 *   hint triggers across 15 auto-compactions in May 2026, all of
 *   which fired at pre_tokens 167-262k (≈85% of Sonnet's 200k
 *   window). Lowering to 70% means polygram warns ~30k tokens
 *   before the SDK auto-compacts, giving the user 1-3 turns of
 *   headroom to choose /new vs /compact vs continue. Configurable
 *   per-bot or per-chat via `contextHintThreshold` (number, 0-100).
 */

'use strict';

const HINT_THRESHOLD_PCT = 70;

/**
 * Format a getContextUsage() result into a multi-line chat reply.
 *
 * @param {object} usage    — return value from `Query.getContextUsage()`.
 *   Expected fields (all optional, all from SDK):
 *     percentage:        number (0-100)
 *     totalTokens:       number
 *     maxTokens:         number
 *     model:             string
 *     isAutoCompactEnabled: boolean
 *     autoCompactThreshold: number (0-100)
 *     categories:        Array<{ label?: string, name?: string, tokens: number }>
 * @returns {string} pre-formatted text suitable for sendMessage
 */
function formatContextReply(usage) {
  const u = usage || {};
  const pct = (u.percentage ?? 0).toFixed(0);
  const total = (u.totalTokens ?? 0).toLocaleString();
  const max = (u.maxTokens ?? 0).toLocaleString();
  const lines = [`📚 Context: ${total} / ${max} tokens (${pct}%)`];
  if (u.model) lines.push(`Model: ${u.model}`);
  if (u.isAutoCompactEnabled && u.autoCompactThreshold) {
    const thrPct = u.autoCompactThreshold.toFixed(0);
    lines.push(`Auto-compact at ${thrPct}%.`);
  }
  if (Array.isArray(u.categories) && u.categories.length) {
    const top = [...u.categories]
      .filter((c) => Number.isFinite(c?.tokens) && c.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map((c) => `  • ${c.label || c.name || '?'}: ${c.tokens.toLocaleString()}`);
    if (top.length) lines.push('Top categories:', ...top);
  }
  return lines.join('\n');
}

/**
 * Decide whether to send the context-full hint and return the hint
 * text if so.
 *
 * @param {object} usage  — same shape as formatContextReply input.
 * @param {object} [opts]
 * @param {number} [opts.threshold] — override the default percent
 *   threshold (rc.56). Caller resolves per-chat / per-bot config
 *   and passes it in. Defaults to HINT_THRESHOLD_PCT (70).
 * @returns {string|null} the hint text to send, or null when below
 *   threshold.
 */
function maybeContextFullHint(usage, { threshold = HINT_THRESHOLD_PCT } = {}) {
  const pct = usage?.percentage ?? 0;
  if (pct < threshold) return null;
  return [
    `📚 Context window ${pct.toFixed(0)}% full. Three options:`,
    '',
    '• `/new` — start fresh; this conversation ends.',
    '• `/compact` — summarise older messages. Add a hint after the command (e.g. `/compact keep the Q3 commission decisions`) and that becomes the compactor\'s guidance.',
    '• Keep chatting — I\'ll auto-compact when needed; key context is preserved automatically.',
  ].join('\n');
}

module.exports = {
  formatContextReply,
  maybeContextFullHint,
  HINT_THRESHOLD_PCT,
};

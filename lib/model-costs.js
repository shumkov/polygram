/**
 * Anthropic Claude API price rates per million tokens.
 *
 * Used by TmuxProcess to compute `cost_usd` per turn, since the
 * per-session JSON log only carries token counts, not cost. SDK
 * backend doesn't need this — Anthropic's claude-agent-sdk reports
 * `total_cost_usd` directly in the result event.
 *
 * **Update reminder:** these rates can change. Last verified
 * 2026-05-15 against https://www.anthropic.com/pricing. When rates
 * shift, update the table here and bump the comment date.
 *
 * If a model isn't in the table, the `default` rates apply (Sonnet
 * 4.6 today). Adding a new model is a 5-line PR.
 */

'use strict';

// Per-million-token rates ($ USD). Cache-read and cache-creation
// follow Anthropic's prompt-caching pricing — read is ~10% of normal
// input; 1-hour creation is ~125% of normal input.
const MODEL_COSTS = {
  // Claude Sonnet 4.6
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75 },
  // Claude Haiku 4.5 (date-suffixed model names map here via the
  // `.replace(/-\d{8}$/, '')` strip in computeCostUsd; no need for
  // a duplicate entry per snapshot).
  'claude-haiku-4-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheCreation: 1 },
  // Claude Opus 4.7 (1M context)
  'claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.50, cacheCreation: 18.75 },
  // Default fallback — Sonnet rates (safest mid-tier estimate).
  default: { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75 },
};

/**
 * Compute USD cost from a token-usage snapshot.
 *
 * @param {object} usage  — { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
 * @param {string|null} model  — e.g. 'claude-haiku-4-5-20251001'
 * @returns {number} cost in USD; 0 if usage is missing
 */
function computeCostUsd(usage, model) {
  if (!usage) return 0;
  // Try exact match first; then prefix match (strip date suffix like -20251001).
  let rate = MODEL_COSTS[model];
  if (!rate && typeof model === 'string') {
    const stripped = model.replace(/-\d{8}$/, '');
    rate = MODEL_COSTS[stripped];
  }
  if (!rate) rate = MODEL_COSTS.default;
  const M = 1_000_000;
  return (
    (usage.inputTokens || 0) * rate.input / M
    + (usage.outputTokens || 0) * rate.output / M
    + (usage.cacheReadTokens || 0) * rate.cacheRead / M
    + (usage.cacheCreationTokens || 0) * rate.cacheCreation / M
  );
}

module.exports = { computeCostUsd, MODEL_COSTS };

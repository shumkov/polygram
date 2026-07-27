'use strict';

function isCodexProcess(entry) {
  return entry?.runtime === 'codex' || entry?.backend === 'codex';
}

function isCodexResult(result) {
  return (
    typeof result?.generationId === 'string'
    && result.generationId.length > 0
    && typeof result?.providerTurnId === 'string'
    && result.providerTurnId.length > 0
  );
}

/**
 * Orchestra already converts Codex deltas and authoritative item completions
 * into cumulative snapshots. Polygram must forward each snapshot as-is: the
 * Telegram streamer replaces its current body, so appending here would repeat
 * prefixes on every event.
 *
 * Claude values deliberately bypass validation to preserve its existing
 * callback contract exactly.
 */
function normalizeStreamText(value, entry) {
  if (!isCodexProcess(entry)) return value;
  return typeof value === 'string' ? value : null;
}

/**
 * CodexProcess returns its authoritative final item text in result.text. The
 * generation and provider-turn IDs are the pinned public discriminator; Claude
 * results continue through unchanged.
 */
function normalizeFinalText(result) {
  if (!isCodexResult(result)) return result?.text;
  if (typeof result.text !== 'string') {
    const error = new TypeError('Codex final result text must be a string');
    error.code = 'CODEX_TEXT_EVENT_INVALID';
    throw error;
  }
  return result.text;
}

module.exports = {
  isCodexProcess,
  isCodexResult,
  normalizeStreamText,
  normalizeFinalText,
};

/**
 * sanitize-reply — outbound assistant-text sanitizer for claude-CLI
 * canned-string leakage.
 *
 * The model occasionally emits CLI-context boilerplate strings
 * verbatim as Telegram replies — typically when its reasoning
 * decides "no response needed." `POLYGRAM_DISPLAY_HINT` (rc.37
 * hardening) explicitly forbids them, but the hint mitigation
 * proved partial: the model still leaked `No response requested.`
 * on a substantive user question (shumorobot Music, 2026-05-22
 * 14:14). Likely CLI-internal, not prompt-driven.
 *
 * This sanitizer is the polygram-side safety net. Runs AFTER
 * `parseResponse` — sees the parsed text the streamer/deliver
 * path will send. On a verbatim match against a narrow allowlist
 * of known canned strings, replaces with an honest brief message
 * the user can act on (rephrase / retry).
 *
 * Narrow allowlist on purpose:
 *   - Exact full-text match (not substring) — paranoia against
 *     accidentally rewriting legitimate replies that mention these
 *     phrases (e.g. an explanation of the issue itself).
 *   - Does NOT include `No response generated. Please try again.`
 *     because that's polygram's own R10 empty-turn fallback, which
 *     is intentional output.
 *   - Does NOT include `Stopped.` because that's polygram's `/stop`
 *     confirmation.
 *
 * If new canned strings are observed in production, add them to
 * CANNED_STRINGS with a comment naming the production trace.
 */

'use strict';

// Exact-match (trimmed) canned strings to intercept. Keep this list
// short and explicit — every entry is a known production leak.
const CANNED_STRINGS = new Set([
  // shumorobot 2026-05-22 (Music topic, 13:17 and 14:14, both on
  // rc.36/37). Model emitted this verbatim on the first occurrence
  // after an ambiguous ack ("okay"); on the second, after a real
  // substantive question. Prompt-side mitigation (rc.37) didn't
  // catch the second case — confirming this is CLI-internal.
  'No response requested.',
  // Listed in the rc.37 display hint as an adjacent variant. Treated
  // the same way if it ever appears.
  'No response needed.',
]);

// Replacement text — italic, brief, honest, actionable. Avoids
// pretending the bot did useful work; tells the user explicitly that
// the model didn't generate a real reply.
const SANITIZED_REPLACEMENT =
  '_(the model returned no actual reply — try rephrasing or asking again)_';

/**
 * Inspect an outbound assistant text. If the FULL TRIMMED text
 * matches a known CLI-context canned string, return the honest
 * replacement and a `replaced` flag so the caller can log the
 * substitution. Otherwise return the original text unchanged.
 *
 * @param {string} text — the assistant text about to be sent.
 * @returns {{ text: string, replaced: boolean, original?: string }}
 */
function sanitizeAssistantReply(text) {
  if (typeof text !== 'string') return { text, replaced: false };
  const trimmed = text.trim();
  if (!trimmed) return { text, replaced: false };
  if (CANNED_STRINGS.has(trimmed)) {
    return {
      text: SANITIZED_REPLACEMENT,
      replaced: true,
      original: trimmed,
    };
  }
  return { text, replaced: false };
}

module.exports = {
  CANNED_STRINGS,
  SANITIZED_REPLACEMENT,
  sanitizeAssistantReply,
};

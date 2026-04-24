/**
 * Detect "stop working on the current turn" signals in natural language.
 *
 * Mirrors OpenClaw's isAbortRequestText semantics: users should be able to
 * say "stop" / "подожди" / "cancel" / or just `/stop` and have polygram
 * interrupt the in-flight turn instead of queueing the message behind it.
 *
 * Conservative on purpose. False positives hijack user intent — "stop using
 * emoji" should NOT abort. So we require:
 *   1. The message (after stripping leading @-mention + trailing punctuation)
 *      must be an exact match against a known abort phrase, OR
 *   2. It must start with an explicit slash command: /stop, /abort, /cancel.
 *
 * Not detected (on purpose):
 *   - "wait a sec while I finish typing" → too long, real content
 *   - "stop using markdown" → has trailing content
 *   - "I said stop" → not at start / not exact match
 */

const ABORT_PHRASES = new Set([
  // English
  'stop', 'wait', 'cancel', 'abort', 'halt',
  'hold on', 'hold up', 'nevermind', 'never mind', 'nvm',
  'forget it', 'forget that',
  // Russian
  'стоп', 'подожди', 'подожди-ка', 'остановись', 'остановить',
  'отмена', 'отставить', 'прекрати', 'прекращай', 'хватит',
  'забей', 'не надо', 'отмени',
]);

const ABORT_SLASH_RE = /^\/(stop|abort|cancel)(\s|$|@)/i;

// Strip leading @botname mentions ("@shumobot stop" → "stop"). Matches any
// @-prefixed word up to the first whitespace — loose because we check the
// remainder against an allowlist anyway.
const LEADING_MENTION_RE = /^@\S+\s+/;

// Trailing punctuation that doesn't change the meaning.
const TRAILING_PUNCT_RE = /[.!?,;:\s]+$/;

function normalize(text) {
  if (typeof text !== 'string') return '';
  return text
    .trim()
    .replace(LEADING_MENTION_RE, '')
    .replace(TRAILING_PUNCT_RE, '')
    .toLowerCase();
}

function isAbortRequest(text) {
  if (!text || typeof text !== 'string') return false;
  // Explicit slash command: /stop, /abort, /cancel (optionally @-suffixed)
  if (ABORT_SLASH_RE.test(text.trim())) return true;

  const n = normalize(text);
  if (!n) return false;
  // Cap length: a long message that happens to start with "stop" is real
  // content, not an abort. 40 chars covers all phrases above with headroom.
  if (n.length > 40) return false;
  return ABORT_PHRASES.has(n);
}

module.exports = { isAbortRequest, ABORT_PHRASES };

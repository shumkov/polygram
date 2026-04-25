/**
 * Detect "stop working on the current turn" signals in natural language.
 *
 * Mirrors OpenClaw's isAbortRequestText semantics: users should be able to
 * say "stop" / "подожди" / "cancel" / or just `/stop` and have polygram
 * interrupt the in-flight turn instead of queueing the message behind it.
 *
 * Conservative on purpose. False positives hijack user intent — "stop using
 * emoji" should NOT abort. So we require ONE of:
 *   1. The whole message (after stripping leading @-mention + trailing
 *      punctuation) is an exact match against a known abort phrase, OR
 *   2. It starts with an explicit slash command: /stop, /abort, /cancel, OR
 *   3. The FIRST SENTENCE (split on . ! ?) is an exact abort phrase. This
 *      catches "Stop. I'll ask in another session." — clear abort intent
 *      with continuation explaining what comes next. Comma is not a split
 *      character ("Stop, look here" is ambiguous and stays non-abort).
 *
 * Not detected (on purpose):
 *   - "stop using markdown" → first sentence is the whole thing, not exact
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
  // Whole-message exact match (capped — a long message that happens to
  // start with "stop" is real content, not an abort).
  if (n.length <= 40 && ABORT_PHRASES.has(n)) return true;

  // First-sentence exact match. Splits on . ! ? (NOT comma — "Stop, look
  // here" is ambiguous and stays non-abort). The leading @-mention has
  // already been stripped by normalize but only on the whole string, so
  // we strip it again on the raw text before splitting.
  const head = text.trim().replace(LEADING_MENTION_RE, '');
  const firstSentence = head.split(/[.!?]/, 1)[0]?.trim().toLowerCase();
  if (firstSentence && firstSentence.length <= 40 && ABORT_PHRASES.has(firstSentence)) {
    return true;
  }

  return false;
}

module.exports = { isAbortRequest, ABORT_PHRASES };

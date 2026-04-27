/**
 * Network error classification + safe-retry helpers.
 *
 * Polygram's outbound policy has been "write DB row first, then send; never
 * auto-retry" — correctly paranoid about double-sends. That leaves a gap
 * though: transient pre-connect failures (DNS flap, local network blip,
 * TCP refused) never actually hit Telegram. Retrying them once is safe
 * because the request never reached the server — no risk of delivering
 * the same message twice.
 *
 * Set names and error codes ported from OpenClaw's extensions/telegram/
 * src/network-errors.ts, which came from production experience.
 */

// Pre-connect errors: the TCP/TLS handshake never completed, so the HTTP
// request never went out. Retry is idempotent by definition.
const PRE_CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',  // nothing listening on target port
  'ENOTFOUND',     // DNS failed
  'EAI_AGAIN',     // DNS timeout / temporary failure
  'ENETUNREACH',   // no route to host (WAN drop)
  'EHOSTUNREACH',  // host unreachable (local firewall / sleep)
  'ECONNRESET',    // peer sent RST before reply — *usually* safe to retry;
                   // technically the server might have started processing
                   // before resetting. Include conservatively because the
                   // alternative is a lost message. Telegram doesn't commit
                   // a sendMessage server-side until it returns 200.
]);

// Transient errors that are recoverable but may have made it partway. DO
// NOT auto-retry these — the risk of double-delivery outweighs the gain.
// Surface them to the caller and let humans decide.
const RECOVERABLE_ERROR_CODES = new Set([
  'ETIMEDOUT',    // TCP timeout after connect (message may have landed)
  'EPIPE',        // write after close — outcome indeterminate
  'EAGAIN',       // socket would block — reader should retry
]);

// Error.name values emitted by undici/node for transient conditions.
const RECOVERABLE_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'FetchError',
  'SocketError',
]);

function extractCode(err) {
  if (!err) return null;
  return err.code
    || err.cause?.code
    || err.errno
    || null;
}

function extractName(err) {
  if (!err) return null;
  return err.name || err.cause?.name || null;
}

/**
 * Can we safely retry this error ONCE without risking double-delivery?
 * Only true for errors that definitionally occurred before the HTTP request
 * reached the server.
 */
function isSafeToRetry(err) {
  const code = extractCode(err);
  return code != null && PRE_CONNECT_ERROR_CODES.has(code);
}

/**
 * Is this a transient network error — recoverable in the sense that the
 * connection may work next time, but NOT safe to auto-retry because the
 * message might have landed?
 */
function isTransientNetworkError(err) {
  if (!err) return false;
  const code = extractCode(err);
  if (code && (PRE_CONNECT_ERROR_CODES.has(code) || RECOVERABLE_ERROR_CODES.has(code))) {
    return true;
  }
  const name = extractName(err);
  if (name && RECOVERABLE_ERROR_NAMES.has(name)) return true;
  return false;
}

/**
 * Strip Telegram bot tokens from a message string before logging or
 * persisting. The fetch-CDN URL embeds `bot${TOKEN}` literally, but
 * various error stringifiers / proxy layers may leak the same token in
 * other shapes — URL-encoded in query strings, percent-encoded
 * (`bot1234%3AAAH…`), or as a bare `Authorization: Bearer …` header.
 *
 * Telegram tokens have the canonical shape `\d{8,10}:[A-Za-z0-9_-]{35}`
 * — match on that shape directly so the leading `bot` literal isn't
 * load-bearing. Three patterns:
 *   1. `bot1234567:AAH…` (canonical, used by the file CDN URL)
 *   2. `bot1234567%3AAAH…` (URL-encoded `:`)
 *   3. bare token shape anywhere in the string
 *
 * Pattern 3 is intentionally broad — false positives (some random
 * `1234567:abcdef…35chars` that isn't a token) are vanishingly rare.
 */
function redactBotToken(s) {
  if (!s) return s;
  return String(s)
    .replace(/bot\d+(?::|%3A)[A-Za-z0-9_%-]+/gi, 'bot<redacted>')
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '<redacted-token>')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/(bot_token=)[^&\s]+/gi, '$1<redacted>');
}

module.exports = {
  PRE_CONNECT_ERROR_CODES,
  RECOVERABLE_ERROR_CODES,
  RECOVERABLE_ERROR_NAMES,
  isSafeToRetry,
  isTransientNetworkError,
  extractCode,
  extractName,
  redactBotToken,
};

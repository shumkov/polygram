/**
 * Abort-grace tracker — per-session timestamps marking "user just
 * /stop'd this session, suppress the next batch of generic error
 * replies".
 *
 * Why this exists: when the user types /stop (or natural-language
 * "стоп"), polygram calls pm.kill(sessionKey). The kill SIGTERM's
 * the in-flight process — every pending in the queue rejects with
 * "Process killed" or INTERRUPTED. WITHOUT abort-grace, polygram
 * would post "💥 Hit a snag" for each rejected pending, even though
 * the user already saw the /stop ack and these errors are caused
 * by their own action.
 *
 * Timestamp model (vs the earlier "delete after first read" Set):
 * a single /stop can drain many pendings, so we mark a TS and let
 * every error within ABORT_GRACE_MS see "yes, aborted, stay quiet".
 *
 * Closes v6 plan §7.1 G11 unit gate.
 */

'use strict';

const DEFAULT_ABORT_GRACE_MS = 15_000;

/**
 * @param {object} [opts]
 * @param {number} [opts.windowMs]   — grace window (default 15s)
 * @param {() => number} [opts.now]  — clock injection for tests
 */
function createAbortGrace({ windowMs = DEFAULT_ABORT_GRACE_MS, now = () => Date.now() } = {}) {
  const aborted = new Map();        // sessionKey → ts of abort

  function mark(sessionKey) {
    if (!sessionKey) return;
    const ts = now();
    aborted.set(sessionKey, ts);
    // Sweep old entries opportunistically. Use 2× window so a
    // session that's marked-and-checked at the boundary doesn't
    // disappear before the check completes.
    for (const [k, t] of aborted) {
      if (ts - t > windowMs * 2) aborted.delete(k);
    }
  }

  function isRecent(sessionKey) {
    const ts = aborted.get(sessionKey);
    return ts != null && (now() - ts) < windowMs;
  }

  function clear(sessionKey) {
    aborted.delete(sessionKey);
  }

  return {
    mark,
    isRecent,
    clear,
    get size() { return aborted.size; },
  };
}

module.exports = { createAbortGrace, DEFAULT_ABORT_GRACE_MS };

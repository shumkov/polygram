/**
 * Shared decision for when a rich-message capability error is enough to
 * disable rich for the rest of the process.
 *
 * The latch it guards is process-wide and never cleared, and it disables
 * every rich path at once. That makes the evidence bar worth stating:
 *
 *   - An error that NAMES the missing capability can only come from a server
 *     that read our payload and cannot serve it. One is conclusive.
 *   - A bare 404 is ALSO what a restarting or briefly misrouted bot-api
 *     server returns. One buys a strike; two in a row are the verdict.
 *
 * The counter belongs here rather than in either sender because both the
 * send and the edit path draw on it. Owned per-module, one path would latch
 * on its first 404 while the other still believed it was protected — which
 * is exactly the restart blip the rule exists to survive.
 *
 * The VERDICT, unlike the counter, follows the EVIDENCE rather than the path
 * that happened to collect it, and the two kinds of evidence say different
 * things:
 *
 *   - Verb-specific evidence stays per verb. A bare 404, or a rejection
 *     naming a missing METHOD, is about one endpoint: a server can implement
 *     `editMessageText{rich_message}` and not the newer `sendRichMessage`,
 *     answering the latter with a 404. One shared verdict would let a probe
 *     of the new verb permanently disable rich edits that are working.
 *   - Shared-field rejections condemn both verbs, by design. `rich_message`
 *     is the same field on both requests, so a server that cannot read it on
 *     one cannot read it on the other — whichever path happened to hear it
 *     first. This is not a leak in the per-verb rule; it is what the rule
 *     says once you ask what the error was actually about.
 *
 * "Consecutive" means consecutive RICH ATTEMPTS across both paths, not
 * consecutive replies and not consecutive minutes: attempts that never
 * happen (plain prose, over-length, an already-tripped latch) cannot clear
 * a strike, so two 404s far apart in wall-clock time still latch.
 */

'use strict';

const VERBS = ['send', 'edit'];

/**
 * @param {object} deps
 * @param {(err) => boolean} [deps.isExplicit] — true when the error names the
 *   missing capability rather than being a bare 404. Defaults to treating
 *   every capability error as conclusive, which is the behavior of a caller
 *   that has not opted into the distinction.
 * @param {(err) => boolean} [deps.isFieldRejection] — true when the error names
 *   the `rich_message` FIELD rather than a missing method.
 * @param {(verb: 'send'|'edit') => void} deps.setUnsupported
 * @returns {{recordCapabilityError: (err, verb) => boolean, recordHealthyOutcome: () => void}}
 */
function createRichCapabilityLatch({
  isExplicit = () => true,
  isFieldRejection = () => true,
  setUnsupported = () => {},
} = {}) {
  let consecutiveBare404 = 0;

  const test = (fn, err) => {
    try { return fn(err) === true; }
    catch { return true; }
  };

  return {
    /**
     * Record a capability error from one verb and decide what it disables.
     * @param {*} err
     * @param {'send'|'edit'} verb — the verb that got this error
     * @returns {boolean} true when this verb was disabled by this error.
     */
    recordCapabilityError(err, verb = 'send') {
      if (test(isExplicit, err)) {
        consecutiveBare404 = 0;
        // A rejection of the shared field condemns both verbs; a missing
        // method condemns only itself. Getting this backwards lets a probe
        // of the newer verb disable rich edits that are working right now.
        if (test(isFieldRejection, err)) {
          for (const v of VERBS) setUnsupported(v);
        } else {
          setUnsupported(verb);
        }
        return true;
      }

      consecutiveBare404 += 1;
      if (consecutiveBare404 >= 2) {
        consecutiveBare404 = 0;
        // Ambiguous errors never condemn a verb that did not report one.
        setUnsupported(verb);
        return true;
      }
      return false;
    },

    // Anything that proves the endpoint is present and answering — a
    // successful rich message, or a rejection of this specific payload.
    recordHealthyOutcome() {
      consecutiveBare404 = 0;
    },
  };
}

module.exports = { createRichCapabilityLatch };

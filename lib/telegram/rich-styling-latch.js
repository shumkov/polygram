/**
 * Shared decision for when to stop emitting inline styling.
 *
 * Deliberately NOT the capability latch. That one answers "can this server do
 * rich at all", and tripping it costs every heading, table and task list on
 * every path. This one answers a much smaller question — "does this server
 * accept typed RichText nodes inside block text" — and tripping it costs
 * bold, italic, code spans and links. A server that predates typed nodes
 * still renders rich perfectly well, so conflating the two would trade the
 * whole feature for a sub-feature.
 *
 * The failure mode this guards is therefore "no styling", never "no rich".
 *
 * Evidence, and why it is weaker than the capability latch's:
 *
 *   A content-class rejection does not say WHY the payload was refused. The
 *   styled render and the flattened one differ in exactly one respect, so a
 *   styled send that is rejected and whose flattened retry SUCCEEDS is a
 *   controlled experiment with one variable — that is the only evidence
 *   counted here. A rejection whose retry also fails says nothing about
 *   styling (the blocks themselves were bad) and buys no strike.
 *
 *   One such result could still be a coincidence: two payloads, two moments,
 *   possibly a transient in between. Two in a row are the verdict. Same
 *   "consecutive rich attempts" meaning as the capability latch — a healthy
 *   styled send clears the count, and attempts that never happen cannot.
 *
 * Untripping is not offered. A process that has decided to stop styling
 * degrades to exactly today's output, which is a state the fleet ran in for
 * two releases; re-arming on a timer would trade that certainty for a retry
 * of an experiment the operator can rerun by restarting.
 */

'use strict';

const DEFAULT_STRIKES = 2;

/**
 * @param {object} deps
 * @param {() => void} deps.setUnsupported — called once, when the verdict lands
 * @param {number} [deps.strikes] — consecutive confirmations required
 * @returns {{recordStylingRejection: () => boolean, recordHealthyOutcome: () => void,
 *   get tripped(): boolean}}
 */
function createRichStylingLatch({ setUnsupported = () => {}, strikes = DEFAULT_STRIKES } = {}) {
  const required = Number.isInteger(strikes) && strikes > 0 ? strikes : DEFAULT_STRIKES;
  let consecutive = 0;
  let tripped = false;

  return {
    /**
     * Record one confirmed styling rejection: a styled send refused, whose
     * flattened re-render then landed. Callers must not report anything
     * weaker — an unconfirmed rejection is not evidence about styling.
     *
     * @returns {boolean} true when THIS call tripped the latch (log once)
     */
    recordStylingRejection() {
      if (tripped) return false;
      consecutive += 1;
      if (consecutive < required) return false;
      tripped = true;
      try { setUnsupported(); } catch { /* the verdict stands either way */ }
      return true;
    },

    /**
     * A styled payload the server accepted. Proof that typed nodes work here,
     * so any run of suspicion ends — otherwise two unrelated content errors,
     * months apart, would eventually disable a working feature.
     */
    recordHealthyOutcome() {
      if (!tripped) consecutive = 0;
    },

    get tripped() { return tripped; },
  };
}

module.exports = { createRichStylingLatch, DEFAULT_STYLING_STRIKES: DEFAULT_STRIKES };

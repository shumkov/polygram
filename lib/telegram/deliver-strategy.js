/**
 * Chaining `deliverText` strategies.
 *
 * Two features now want the pipeline's text-delivery step — the live preview
 * (a reply consumes the bubble the answer was streaming into) and rich
 * rendering (a reply with structure goes out as blocks). They are independent
 * decisions about the same reply, and neither may switch the other off, so the
 * seam takes an ordered chain rather than one strategy.
 *
 * The order is meaningful, not arbitrary: the preview strategy runs first
 * because only it knows whether a bubble is already on screen holding this
 * answer. When it consumes, the reply is delivered and nothing downstream
 * should run. When it declines, whatever it did NOT deliver flows on to the
 * next strategy, and finally to the pipeline's own chunked path.
 *
 * A declining strategy may hand the next one a rewritten body (the rich
 * strategy uses this to strip media markdown from a fallback), and the rewrite
 * carries through to the chunked path.
 */

'use strict';

/**
 * @param {Array<?Function>} factories — makeDeliverText factories, in the order
 *   they should get first refusal. Nullish entries are ignored.
 * @returns {Function} a makeDeliverText factory, or one returning null when no
 *   member built a strategy for this call.
 */
function composeDeliverTextFactories(factories) {
  const built = (factories || []).filter((f) => typeof f === 'function');
  if (built.length === 0) return null;

  return function makeDeliverText(args) {
    const strategies = built
      .map((factory) => factory(args))
      .filter((s) => typeof s === 'function');
    if (strategies.length === 0) return null;

    return async function deliverText(callArgs) {
      let text = callArgs.text;
      for (const strategy of strategies) {
        const out = await strategy({ ...callArgs, text });
        if (out?.handled) return out;
        // A decline may still have projected the body for whoever delivers it.
        if (typeof out?.text === 'string') text = out.text;
      }
      return { handled: false, text };
    };
  };
}

module.exports = { composeDeliverTextFactories };

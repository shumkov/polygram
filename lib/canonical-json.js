/**
 * Canonical-JSON stringification for chat_tool_decisions dedup.
 *
 * Used by polygram.js's canUseTool flow (rc.6 Phase 2 step 6):
 *   - lookup key for `chat_tool_decisions match_type='exact'`
 *   - input_pattern stored on "Always allow / Always deny" clicks
 *
 * Why canonical: Claude can reorder JSON keys between retries of
 * the same tool call (different SDK versions, different temperature
 * sampling). Without canonicalisation, the dedup digest would
 * differ for semantically-identical calls and the user would see
 * the same approval card twice (v4 plan §6.6 ship-breaker M8
 * mitigation).
 *
 * Properties:
 *   - Keys sorted alphabetically at every nesting level
 *   - Arrays preserve order (only object keys are sorted)
 *   - No whitespace in output
 *   - null / undefined / primitive inputs round-trip via JSON.stringify
 *
 * NOT a full JSON canonicalisation spec (RFC 8785 / I-D
 * cyberphone-json-canonicalization-scheme); we don't normalise
 * number representations (1.0 vs 1, exponents) or string escapes.
 * Sufficient for SDK-shaped tool inputs which are well-formed JSON
 * objects with string keys.
 */

'use strict';

function canonicalizeToolInput(input) {
  if (input == null || typeof input !== 'object') {
    return JSON.stringify(input);
  }
  const sortRec = (v) => {
    if (Array.isArray(v)) return v.map(sortRec);
    if (v == null || typeof v !== 'object') return v;
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortRec(v[k]);
    return out;
  };
  return JSON.stringify(sortRec(input));
}

module.exports = { canonicalizeToolInput };

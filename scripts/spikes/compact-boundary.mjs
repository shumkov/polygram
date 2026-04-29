/**
 * G3/G4: Auto-compact (between turns + mid-turn).
 *
 * Validates that:
 *  - SDK auto-compacts when context approaches the model's window
 *  - SDKCompactBoundaryMessage is emitted into the event stream
 *  - The compact_metadata field has pre_tokens / post_tokens we can read
 *
 * Pass criterion: at least one event with type === 'system' AND
 *   subtype === 'compact_boundary' (OR the SDK's specific shape) appears
 *   AND the turn finishes with subtype: 'success' afterward.
 *
 * Strategy: feed a single very-long user message (~150K tokens of
 * filler) to push the context near the threshold, then ask a
 * follow-up. Compaction should kick in either between turns or
 * mid-turn during processing.
 *
 * NOTE: This is expensive — single run can burn $1-3 in API costs.
 * Skip unless you really want to verify auto-compact behaviour.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

// 200K tokens of filler — should push near the auto-compact threshold.
// Each "lorem ipsum dolor sit amet, " is ~6 tokens; 35K repetitions ≈ 210K.
const FILLER = 'lorem ipsum dolor sit amet, '.repeat(35_000);

let sawCompactBoundary = false;
let resultSubtype = null;

const q = query({
  prompt: `Here is a large document for context — read it then I'll ask a question.\n\n${FILLER}\n\nThat's the whole doc. Now please count how many "lorem" tokens were in it (rough estimate is fine).`,
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  },
});

for await (const m of q) {
  // The exact shape of compact-boundary differs across SDK versions.
  // Check several possibilities.
  if (m.type === 'system' && (m.subtype === 'compact_boundary' || m.compact_metadata)) {
    sawCompactBoundary = true;
    console.log('compact_boundary observed:', JSON.stringify(m).slice(0, 200));
  }
  if (m.type === 'result') {
    resultSubtype = m.subtype;
    break;
  }
}

console.log('compact_boundary seen:', sawCompactBoundary);
console.log('result subtype:', resultSubtype);

if (sawCompactBoundary && resultSubtype === 'success') {
  console.log('PASS — auto-compact fired and turn succeeded');
  process.exit(0);
} else if (resultSubtype === 'success') {
  console.log('PARTIAL — turn succeeded but no compact_boundary observed (input may not have been large enough OR SDK uses a different event shape)');
  process.exit(2);
} else {
  console.log('FAIL — turn did not complete cleanly:', resultSubtype);
  process.exit(1);
}

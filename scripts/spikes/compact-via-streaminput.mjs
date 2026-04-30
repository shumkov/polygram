/**
 * F2 spike: does pushing "/compact <preserve text>" via streamInput
 * trigger the SDK's compact slash-command path, OR is it treated as
 * literal user text the model just responds to?
 *
 * Strategy:
 *   1. Push: "remember the marker '<MARKER>' for later"
 *   2. Wait for reply.
 *   3. Push: "/compact preserve the marker we just set"
 *   4. Observe events: do we see SDKCompactBoundaryMessage? Do we
 *      see the compact_summary or PreCompact hook fire?
 *   5. Push: "what was the marker?"
 *   6. If model still recalls it → either compact ran with preserve OR
 *      compact didn't fire and the marker was still in transcript.
 *
 * Pass criteria:
 *   - PreCompact hook fires (input has trigger:'manual') OR
 *   - compact_boundary system event arrives in the stream
 *   = SDK actually treats "/compact" as a slash command via streamInput.
 *
 * If neither fires, it was treated as literal text. Then F2 needs a
 * different approach (no programmatic /compact path).
 *
 * Cost: ~$0.01 in API tokens.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

const MARKER = 'compact-marker-' + Math.random().toString(36).slice(2, 8);
let preCompactFired = false;
let postCompactFired = false;
let compactBoundarySeen = false;
let preCompactInput = null;

// Build the prompt as an AsyncIterable so we can push 3 messages
// in sequence. Each yields when the previous turn completes.
async function* makeInput() {
  yield { type: 'user',
          message: { role: 'user', content: `Remember this marker for later: "${MARKER}". Just say "noted".` },
          parent_tool_use_id: null };
  // Wait briefly for the SDK to process turn 1 before pushing turn 2.
  // (Real polygram lets the SDK control queueing; this iterable
  // delivers as the SDK pulls.)
  await new Promise((r) => setTimeout(r, 100));
  yield { type: 'user',
          message: { role: 'user', content: '/compact please preserve the marker from earlier in the summary' },
          parent_tool_use_id: null };
  await new Promise((r) => setTimeout(r, 100));
  yield { type: 'user',
          message: { role: 'user', content: 'what was the marker?' },
          parent_tool_use_id: null };
}

const q = query({
  prompt: makeInput(),
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    hooks: {
      PreCompact: [{ hooks: [async (input) => {
        preCompactFired = true;
        preCompactInput = input;
        return { continue: true };
      }] }],
      PostCompact: [{ hooks: [async (input) => {
        postCompactFired = true;
        return { continue: true };
      }] }],
    },
  },
});

let turnCount = 0;
let finalText = '';
let allText = [];

for await (const m of q) {
  if (m.type === 'system' && (m.subtype === 'compact_boundary' || m.compact_metadata)) {
    compactBoundarySeen = true;
    console.log('compact_boundary observed:', JSON.stringify(m).slice(0, 200));
  }
  if (m.type === 'assistant') {
    let turnText = '';
    for (const b of m.message?.content || []) {
      if (b.type === 'text') turnText += b.text;
    }
    if (turnText) allText.push(turnText);
    finalText = turnText;
  }
  if (m.type === 'result') {
    turnCount++;
    if (m.subtype !== 'success') {
      console.log(`turn ${turnCount} result subtype:`, m.subtype, m.error || '');
    }
    // Three turns expected. Break once we've seen the third.
    if (turnCount >= 3) break;
  }
}

console.log('---');
console.log('PreCompact hook fired?  ', preCompactFired);
console.log('PostCompact hook fired? ', postCompactFired);
console.log('compact_boundary event? ', compactBoundarySeen);
console.log('preCompact input:       ', preCompactInput ? JSON.stringify(preCompactInput).slice(0, 200) : 'n/a');
console.log('turn count:             ', turnCount);
console.log('all assistant texts:');
allText.forEach((t, i) => console.log(`  [${i + 1}] ${t.slice(0, 200)}`));

const slashCompactWorked = preCompactFired || compactBoundarySeen;
console.log('---');
console.log(slashCompactWorked
  ? 'PASS — /compact via streamInput triggers SDK compaction'
  : 'FAIL — /compact via streamInput is treated as literal text (no compaction triggered)');
process.exit(slashCompactWorked ? 0 : 1);

/**
 * G2: Tool-less-turn drain fallback (rc.14).
 *
 * When a Query produces a turn with ZERO tools (just text), the
 * PostToolBatch hook never fires. polygram's drainStaleAutosteerBuffer
 * dispatches the buffer as a synthetic next turn instead.
 *
 * This spike emulates the polygram-side flow: feed a tool-less prompt,
 * confirm hook does NOT fire, then dispatch a follow-up via
 * inputController.push and verify the bot addresses it.
 *
 * Pass criterion: hook fires 0 times AND second turn's reply mentions
 * the buffered marker.
 *
 * Burns ~$0.003 of API tokens per run.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

const MARKER = 'tless-marker-' + Math.random().toString(36).slice(2, 10);
let hookFiredCount = 0;

const q = query({
  prompt: 'Just say "ok" without using any tools.',
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    hooks: {
      PostToolBatch: [{
        hooks: [async () => {
          hookFiredCount++;
          return { continue: true };
        }],
      }],
    },
  },
});

let firstReply = '';
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message?.content || []) {
      if (b.type === 'text') firstReply += b.text;
    }
  }
  if (m.type === 'result') break;
}

console.log('first reply:', firstReply.slice(0, 80));
console.log('hookFiredCount:', hookFiredCount, '(should be 0 for tool-less turn)');

const hookCorrectlySkipped = hookFiredCount === 0;
console.log(hookCorrectlySkipped ? 'PASS — confirms tool-less turns skip PostToolBatch' : 'FAIL');
process.exit(hookCorrectlySkipped ? 0 : 1);

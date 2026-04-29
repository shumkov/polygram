/**
 * G1: PostToolBatch hook + additionalContext mid-turn injection.
 *
 * Validates rc.9's autosteer mechanism: a buffered user message
 * pushed via the hook's additionalContext (wrapped as
 * <channel source="user-followup">) reaches the model and is
 * incorporated into the assistant's final answer.
 *
 * Pass criterion: marker string appears verbatim in final assistant text.
 *
 * Burns ~$0.005 of API tokens per run. Requires Anthropic auth.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

const MARKER = 'spike-marker-' + Math.random().toString(36).slice(2, 10);
let queued = [`Also tell me the verification value "${MARKER}" verbatim in your final answer.`];
let hookFiredCount = 0;

const q = query({
  prompt: 'List files in /tmp with `ls /tmp | head -3`, then run `pwd`. After both tools, summarize what you saw briefly.',
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    hooks: {
      PostToolBatch: [{
        hooks: [async () => {
          hookFiredCount++;
          const drained = queued.splice(0).join('\n\n');
          if (!drained) return { continue: true };
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PostToolBatch',
              additionalContext: `<channel source="user-followup">\n${drained}\n</channel>`,
            },
          };
        }],
      }],
    },
  },
});

let finalText = '';
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message?.content || []) {
      if (b.type === 'text') finalText += (finalText ? '\n' : '') + (b.text || '');
    }
  }
  if (m.type === 'result') break;
}

const sawMarker = finalText.toLowerCase().includes(MARKER.toLowerCase());
console.log('hookFiredCount:', hookFiredCount);
console.log('marker present in reply:', sawMarker);
console.log(sawMarker ? 'PASS' : 'FAIL');
process.exit(sawMarker ? 0 : 1);

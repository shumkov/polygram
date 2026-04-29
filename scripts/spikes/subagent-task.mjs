/**
 * G7: Subagent (Task tool) integration under SDK pm.
 *
 * Validates that:
 *  - Task tool can be invoked
 *  - The subagent's stream events have parent_tool_use_id != null
 *  - polygram's pm-sdk filter at process-manager-sdk.js:387 keeps
 *    subagent text out of the main streamer
 *
 * Pass criterion: at least one assistant message has
 *   parent_tool_use_id !== null AND turn completes with success.
 *
 * Burns ~$0.02 of API tokens per run (subagents do their own LLM
 * calls).
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

const q = query({
  prompt: 'Use the Task tool to spawn a subagent that briefly counts files in /tmp. Then summarize.',
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  },
});

let parentToolUseIds = new Set();
let topLevelMessages = 0;
let subagentMessages = 0;
let resultSubtype = null;

for await (const m of q) {
  if (m.type === 'assistant') {
    if (m.parent_tool_use_id) {
      subagentMessages++;
      parentToolUseIds.add(m.parent_tool_use_id);
    } else {
      topLevelMessages++;
    }
  }
  if (m.type === 'result') {
    resultSubtype = m.subtype;
    break;
  }
}

console.log('top-level assistant messages:', topLevelMessages);
console.log('subagent messages (parent_tool_use_id != null):', subagentMessages);
console.log('distinct parent_tool_use_ids:', parentToolUseIds.size);
console.log('result subtype:', resultSubtype);

const sawSubagent = subagentMessages > 0 && parentToolUseIds.size > 0;
const cleanFinish = resultSubtype === 'success';
const pass = sawSubagent && cleanFinish;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);

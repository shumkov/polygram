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
import {
  buildClaudeGateSdkOptions,
  createClaudeGateSelection,
} from './claude-executable.mjs';
import {
  createSdkGateObserver,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';

const gate = await createClaudeGateSelection();
const observer = createSdkGateObserver(gate);

const q = query({
  prompt: 'Use the Task tool to spawn a subagent that briefly counts files in /tmp. Then summarize.',
  options: buildClaudeGateSdkOptions(gate, {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  }),
});

let parentToolUseIds = new Set();
let topLevelMessages = 0;
let subagentMessages = 0;
let resultSubtype = null;

for await (const m of q) {
  observer.observe(m);
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

console.log('attestation:', JSON.stringify(gate.sanitizedAttestation));
console.log('top-level assistant messages:', topLevelMessages);
console.log('subagent messages (parent_tool_use_id != null):', subagentMessages);
console.log('distinct parent_tool_use_ids:', parentToolUseIds.size);
console.log('result subtype:', resultSubtype);

const sawSubagent = subagentMessages > 0 && parentToolUseIds.size > 0;
const cleanFinish = resultSubtype === 'success';
const sdkEvidence = observer.finish();
const pass = sawSubagent && cleanFinish && sdkEvidence.pass;
writeSanitizedGateResult(gate.artifactDir, {
  evidenceSchemaVersion: 1,
  matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'sdk-subagent',
  scenario: 'sdk-subagent',
  status: pass ? 'PASS' : 'FAIL',
  attestation: gate.sanitizedAttestation,
  resolvedModel: sdkEvidence.resolvedModel,
  lifecycle: sdkEvidence.lifecycle,
  wrapperRecords: sdkEvidence.wrapperRecords,
  processEvidence: sdkEvidence.processEvidence,
  topLevelMessages,
  subagentMessages,
  distinctParentCount: parentToolUseIds.size,
  resultSubtype,
  reasonCount: sdkEvidence.reasons.length,
});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);

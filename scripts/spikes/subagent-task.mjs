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

import fs from 'node:fs';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeGateSdkOptions,
  createClaudeGateSelection,
} from './claude-executable.mjs';
import {
  collectGateLifecycleEvidence,
  createSdkGateObserver,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import {
  createSubagentLifecycleProof,
  evaluateSubagentEvidence,
} from './subagent-gate.mjs';

const gate = await createClaudeGateSelection();
const observer = createSdkGateObserver(gate);
const privateDir = path.join(gate.artifactDir, 'raw-private');
const streamPath = path.join(privateDir, 'sdk-stream.ndjson');
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(privateDir, 0o700);
const streamFd = fs.openSync(streamPath, 'wx', 0o600);

const q = query({
  prompt: 'Use the Task tool to spawn a subagent that briefly counts files in /tmp. Then summarize.',
  options: buildClaudeGateSdkOptions(gate, {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  }),
});

const messages = [];
const parentToolUseIds = new Set();
let topLevelMessages = 0;
let subagentMessages = 0;
let resultSubtype = null;

for await (const m of q) {
  fs.writeSync(streamFd, `${JSON.stringify(m)}\n`);
  messages.push(m);
  observer.observe(m);
  if (
    ['assistant', 'user'].includes(m.type)
    && m.parent_tool_use_id
  ) {
    parentToolUseIds.add(m.parent_tool_use_id);
  }
  if (m.type === 'assistant') {
    if (m.parent_tool_use_id) {
      subagentMessages++;
    } else {
      topLevelMessages++;
    }
  }
  if (m.type === 'result') {
    resultSubtype = m.subtype;
    break;
  }
}
fs.closeSync(streamFd);
const streamEvidence = collectGateLifecycleEvidence(streamPath, {
  stream: 'sdk',
});

console.log('attestation:', JSON.stringify(gate.sanitizedAttestation));
console.log('top-level assistant messages:', topLevelMessages);
console.log('subagent messages (parent_tool_use_id != null):', subagentMessages);
console.log('distinct parent_tool_use_ids:', parentToolUseIds.size);
console.log('result subtype:', resultSubtype);

const sawSubagent = subagentMessages > 0 && parentToolUseIds.size > 0;
const cleanFinish = resultSubtype === 'success';
const sdkEvidence = observer.finish();
const evidence = {
  evidenceSchemaVersion: 1,
  matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'sdk-subagent',
  scenario: 'sdk-subagent',
  attestation: gate.sanitizedAttestation,
  resolvedModel: sdkEvidence.resolvedModel,
  lifecycle: sdkEvidence.lifecycle,
  lifecycleSources: {
    sdk: streamEvidence.source,
  },
  lifecycleProofs: [],
  wrapperRecords: sdkEvidence.wrapperRecords,
  processEvidence: sdkEvidence.processEvidence,
  topLevelMessages,
  subagentMessages,
  distinctParentCount: parentToolUseIds.size,
  resultSubtype,
  reasonCount: sdkEvidence.reasons.length,
  subagentLifecycleProof: createSubagentLifecycleProof(messages),
};
const subagentEvaluation = evaluateSubagentEvidence(evidence, {
  isCandidate: gate.version === '2.1.220',
});
const pass = (
  sawSubagent
  && cleanFinish
  && sdkEvidence.pass
  && subagentEvaluation.pass
);
writeSanitizedGateResult(gate.artifactDir, {
  ...evidence,
  status: pass ? 'PASS' : 'FAIL',
  reasonCount:
    sdkEvidence.reasons.length + subagentEvaluation.reasons.length,
});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);

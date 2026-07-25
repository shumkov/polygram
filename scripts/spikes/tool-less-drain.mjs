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
import { createRequire } from 'node:module';
import {
  buildClaudeGateSdkOptions,
  createClaudeGateSelection,
} from './claude-executable.mjs';
import {
  createSdkGateObserver,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import { evaluateToolLessDrainEvidence } from './sdk-gate-oracles.mjs';

const MARKER = 'tless-marker-' + Math.random().toString(36).slice(2, 10);
let hookFiredCount = 0;
const gate = await createClaudeGateSelection();
const observer = createSdkGateObserver(gate);
const require = createRequire(import.meta.url);
const { makeInputController } = require('@shumkov/orchestra');
const inputController = makeInputController();

const q = query({
  prompt: inputController.iter,
  options: buildClaudeGateSdkOptions(gate, {
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
  }),
});

const resultSubtypes = [];
let bufferedMarkerCount = 0;
let awaitingBufferedReply = false;
inputController.push({
  type: 'user',
  message: {
    role: 'user',
    content: 'Just say "ok" without using any tools.',
  },
  parent_tool_use_id: null,
});
for await (const m of q) {
  observer.observe(m);
  if (m.type === 'assistant') {
    for (const b of m.message?.content || []) {
      if (
        awaitingBufferedReply
        && b.type === 'text'
        && typeof b.text === 'string'
      ) {
        bufferedMarkerCount += b.text.split(MARKER).length - 1;
      }
    }
  }
  if (m.type === 'result') {
    resultSubtypes.push(m.subtype);
    if (resultSubtypes.length === 1) {
      awaitingBufferedReply = true;
      inputController.push({
        type: 'user',
        message: {
          role: 'user',
          content: `Reply with exactly this buffered marker: ${MARKER}`,
        },
        parent_tool_use_id: null,
        priority: 'next',
      });
    } else {
      break;
    }
  }
}
inputController.close();

console.log('attestation:', JSON.stringify(gate.sanitizedAttestation));
console.log('hookFiredCount:', hookFiredCount, '(should be 0 for tool-less turn)');

const sdkEvidence = observer.finish();
const evaluation = evaluateToolLessDrainEvidence({
  hookFiredCount,
  resultSubtypes,
  bufferedMarkerCount,
});
const pass = evaluation.pass && sdkEvidence.pass;
writeSanitizedGateResult(gate.artifactDir, {
  evidenceSchemaVersion: 1,
  matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'sdk-tool-less-drain',
  scenario: 'sdk-tool-less-drain',
  status: pass ? 'PASS' : 'FAIL',
  attestation: gate.sanitizedAttestation,
  resolvedModel: sdkEvidence.resolvedModel,
  lifecycle: sdkEvidence.lifecycle,
  wrapperRecords: sdkEvidence.wrapperRecords,
  processEvidence: sdkEvidence.processEvidence,
  hookFiredCount,
  resultSubtypes,
  bufferedMarkerCount,
  reasonCount: evaluation.reasons.length + sdkEvidence.reasons.length,
});
console.log(pass ? 'PASS — tool-less fallback drained the buffered turn' : 'FAIL');
process.exit(pass ? 0 : 1);

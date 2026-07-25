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
import {
  buildClaudeGateSdkOptions,
  createClaudeGateSelection,
} from './claude-executable.mjs';
import {
  createSdkGateObserver,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';

const MARKER = 'spike-marker-' + Math.random().toString(36).slice(2, 10);
let queued = [`Also tell me the verification value "${MARKER}" verbatim in your final answer.`];
let hookFiredCount = 0;
const gate = await createClaudeGateSelection();
const observer = createSdkGateObserver(gate);

const q = query({
  prompt: 'List files in /tmp with `ls /tmp | head -3`, then run `pwd`. After both tools, summarize what you saw briefly.',
  options: buildClaudeGateSdkOptions(gate, {
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
  }),
});

let finalText = '';
let resultSubtype = null;
for await (const m of q) {
  observer.observe(m);
  if (m.type === 'assistant') {
    for (const b of m.message?.content || []) {
      if (b.type === 'text') finalText += (finalText ? '\n' : '') + (b.text || '');
    }
  }
  if (m.type === 'result') {
    resultSubtype = m.subtype;
    break;
  }
}

const sdkEvidence = observer.finish();
const sawMarker = finalText.toLowerCase().includes(MARKER.toLowerCase());
const pass = sawMarker && resultSubtype === 'success' && sdkEvidence.pass;
writeSanitizedGateResult(gate.artifactDir, {
  evidenceSchemaVersion: 1,
  matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'sdk-post-tool-batch',
  scenario: 'sdk-post-tool-batch',
  status: pass ? 'PASS' : 'FAIL',
  attestation: gate.sanitizedAttestation,
  resolvedModel: sdkEvidence.resolvedModel,
  lifecycle: sdkEvidence.lifecycle,
  wrapperRecords: sdkEvidence.wrapperRecords,
  processEvidence: sdkEvidence.processEvidence,
  hookFiredCount,
  markerPresent: sawMarker,
  resultSubtype,
  reasonCount: sdkEvidence.reasons.length,
});
console.log('attestation:', JSON.stringify(gate.sanitizedAttestation));
console.log('hookFiredCount:', hookFiredCount);
console.log('marker present in reply:', sawMarker);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);

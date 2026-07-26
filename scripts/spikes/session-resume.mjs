/**
 * G12: Session resume after daemon restart.
 *
 * Validates that an SDK Query started in one process can be resumed
 * with the saved claude_session_id in a NEW process and the
 * conversation continues coherently.
 *
 * Strategy:
 *   1. Spawn a Query, ask "remember the magic word: <marker>".
 *   2. Capture the result.session_id.
 *   3. Spawn a NEW Query with `resume: <session_id>`.
 *   4. Ask "what was the magic word?".
 *   5. Pass criterion: response includes the marker.
 *
 * Burns ~$0.005 per run.
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
import { evaluateSessionResumeEvidence } from './sdk-gate-oracles.mjs';

const MARKER = 'magic-' + Math.random().toString(36).slice(2, 8);
const gate = await createClaudeGateSelection();
const observer = createSdkGateObserver(gate);

async function runQuery(prompt, resumeId) {
  const q = query({
    prompt,
    options: buildClaudeGateSdkOptions(gate, {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(resumeId && { resume: resumeId }),
    }),
  });
  let text = '';
  let sessionId = null;
  let resultSubtype = null;
  for await (const m of q) {
    observer.observe(m);
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text') text += b.text;
      }
    }
    if (m.type === 'result') {
      sessionId = m.session_id;
      resultSubtype = m.subtype;
      break;
    }
  }
  return { text, sessionId, resultSubtype };
}

console.log('attestation:', JSON.stringify(gate.sanitizedAttestation));
console.log('Step 1: priming a fresh session');
const first = await runQuery(`Please remember this magic word: ${MARKER}. Just acknowledge briefly.`);
console.log('first turn returned a session:', Boolean(first.sessionId));

if (!first.sessionId) {
  const sdkEvidence = observer.finish();
  writeSanitizedGateResult(gate.artifactDir, {
    evidenceSchemaVersion: 1,
    matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'sdk-resume',
    scenario: 'sdk-resume',
    status: 'FAIL',
    attestation: gate.sanitizedAttestation,
    resolvedModel: sdkEvidence.resolvedModel,
    lifecycle: sdkEvidence.lifecycle,
    wrapperRecords: sdkEvidence.wrapperRecords,
    processEvidence: sdkEvidence.processEvidence,
    firstSessionPresent: false,
    secondSessionPresent: false,
    firstResultSubtype: first.resultSubtype,
    secondResultSubtype: null,
    markerRecalled: false,
    reasonCount: sdkEvidence.reasons.length + 1,
  });
  console.log('FAIL — first turn did not return a session_id');
  process.exit(1);
}

console.log('\nStep 2: resuming session in fresh Query');
const second = await runQuery('What was the magic word I asked you to remember? Just the word, nothing else.', first.sessionId);

const recalled = second.text.toLowerCase().includes(MARKER.toLowerCase());
const sdkEvidence = observer.finish();
const evaluation = evaluateSessionResumeEvidence({
  firstResultSubtype: first.resultSubtype,
  secondResultSubtype: second.resultSubtype,
  markerRecalled: recalled,
});
const pass = evaluation.pass && sdkEvidence.pass;
writeSanitizedGateResult(gate.artifactDir, {
  evidenceSchemaVersion: 1,
  matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'sdk-resume',
  scenario: 'sdk-resume',
  status: pass ? 'PASS' : 'FAIL',
  attestation: gate.sanitizedAttestation,
  resolvedModel: sdkEvidence.resolvedModel,
  lifecycle: sdkEvidence.lifecycle,
  wrapperRecords: sdkEvidence.wrapperRecords,
  processEvidence: sdkEvidence.processEvidence,
  firstSessionPresent: true,
  secondSessionPresent: Boolean(second.sessionId),
  firstResultSubtype: first.resultSubtype,
  secondResultSubtype: second.resultSubtype,
  markerRecalled: recalled,
  reasonCount: evaluation.reasons.length + sdkEvidence.reasons.length,
});
console.log(pass ? '\nPASS — session resume preserved transcript' : '\nFAIL — resume evidence incomplete');
process.exit(pass ? 0 : 1);

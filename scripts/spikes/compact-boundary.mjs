/**
 * Manual SDK compaction compatibility gate.
 *
 * Validates one causally ordered session:
 * marker turn → /compact → PreCompact(manual) → compact_boundary →
 * marker-free recall turn. Automatic compaction timing is observed in
 * staging because token-pressure thresholds vary by model context window.
 */

import crypto from 'node:crypto';

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeGateSdkOptions,
  createClaudeGateSelection,
} from './claude-executable.mjs';
import {
  createSdkGateObserver,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import { evaluateManualCompactEvidence } from './manual-compact-evidence.mjs';

const STEP_TIMEOUT_MS = 120_000;
const COMPACT_MINIMUM_EXCHANGES = 5;
const marker = `compact-marker-${crypto.randomBytes(8).toString('hex')}`;
const establishPrompt = `Remember this marker for later: "${marker}". Reply only "noted".`;
const primingPrompts = [
  establishPrompt,
  ...Array.from(
    { length: COMPACT_MINIMUM_EXCHANGES - 1 },
    (_, index) => `Context checkpoint ${index + 1}. Reply only "ack-${index + 1}".`,
  ),
];
const compactPrompt = '/compact preserve the marker from the previous turn';
const recallPrompt = 'What marker did I ask you to remember? Reply with only that marker.';

const gate = await createClaudeGateSelection();
const observer = createSdkGateObserver(gate);
const timeline = [];
const compactShapes = [];
let resultSubtype = null;
let runtimeErrorPresent = false;

function record(entry) {
  timeline.push(entry);
  return entry;
}

async function runTurn(prompt, resumeId, hooks) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), STEP_TIMEOUT_MS);
  const q = query({
    prompt,
    options: buildClaudeGateSdkOptions(gate, {
      abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(resumeId && { resume: resumeId }),
      ...(hooks && { hooks }),
    }),
  });
  let result = null;

  try {
    for await (const message of q) {
      observer.observe(message);
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        record({
          kind: 'compact-boundary',
          sessionId: message.session_id,
          trigger: message.compact_metadata?.trigger,
        });
        compactShapes.push({
          subtype: message.subtype,
          trigger: message.compact_metadata?.trigger || null,
          hasMetadata: Boolean(message.compact_metadata),
          preTokens: Number.isFinite(message.compact_metadata?.pre_tokens)
            ? message.compact_metadata.pre_tokens
            : null,
          postTokens: Number.isFinite(message.compact_metadata?.post_tokens)
            ? message.compact_metadata.post_tokens
            : null,
        });
      }
      if (message.type === 'result') result = message;
    }
  } finally {
    clearTimeout(timeout);
    if (!result) q.close();
  }

  if (!result) throw new Error('turn ended without a result');
  return result;
}

try {
  const establishPromptEntry = record({
    kind: 'establish-prompt',
    sessionId: '',
    value: establishPrompt,
  });
  let activeSessionId = null;
  for (const prompt of primingPrompts) {
    const turn = await runTurn(prompt, activeSessionId);
    if (!turn.session_id) throw new Error('priming turn returned no session');
    if (activeSessionId && turn.session_id !== activeSessionId) {
      throw new Error('priming turn changed sessions');
    }
    if (!activeSessionId) {
      establishPromptEntry.sessionId = turn.session_id;
      record({
        kind: 'establish-result',
        sessionId: turn.session_id,
        subtype: turn.subtype,
        value: turn.subtype === 'success' ? turn.result : '',
      });
    }
    activeSessionId = turn.session_id;
  }

  record({
    kind: 'compact-prompt',
    sessionId: activeSessionId,
    value: compactPrompt,
  });
  const compact = await runTurn(compactPrompt, activeSessionId, {
    PreCompact: [{
      hooks: [async (input) => {
        record({
          kind: 'pre-compact',
          sessionId: input.session_id,
          trigger: input.trigger,
        });
        return { continue: true };
      }],
    }],
  });
  record({
    kind: 'compact-result',
    sessionId: compact.session_id,
    subtype: compact.subtype,
    value: compact.subtype === 'success' ? compact.result : '',
  });

  record({
    kind: 'recall-prompt',
    sessionId: compact.session_id,
    value: recallPrompt,
  });
  const recall = await runTurn(recallPrompt, compact.session_id);
  record({
    kind: 'recall-result',
    sessionId: recall.session_id,
    subtype: recall.subtype,
    value: recall.subtype === 'success' ? recall.result : '',
  });
  resultSubtype = recall.subtype;
} catch {
  runtimeErrorPresent = true;
}

const sdkEvidence = observer.finish();
const compactEvidence = evaluateManualCompactEvidence({ timeline, marker });
const pass = compactEvidence.pass
  && sdkEvidence.pass
  && runtimeErrorPresent === false
  && resultSubtype === 'success';

console.log('attestation:', JSON.stringify(gate.sanitizedAttestation));
console.log('manual PreCompact count:', compactEvidence.preCompactCount);
console.log('compact boundary count:', compactEvidence.compactBoundaryCount);
console.log('result count:', compactEvidence.resultCount);
console.log('same session:', compactEvidence.sameSession);
console.log('ordered:', compactEvidence.ordered);
console.log('result subtype:', resultSubtype);

writeSanitizedGateResult(gate.artifactDir, {
  evidenceSchemaVersion: 1,
  matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'sdk-compact',
  scenario: 'sdk-compact',
  status: pass ? 'PASS' : 'FAIL',
  attestation: gate.sanitizedAttestation,
  resolvedModel: sdkEvidence.resolvedModel,
  lifecycle: sdkEvidence.lifecycle,
  wrapperRecords: sdkEvidence.wrapperRecords,
  processEvidence: sdkEvidence.processEvidence,
  compactShapes,
  preCompactCount: compactEvidence.preCompactCount,
  compactBoundaryCount: compactEvidence.compactBoundaryCount,
  resultCount: compactEvidence.resultCount,
  sameSession: compactEvidence.sameSession,
  ordered: compactEvidence.ordered,
  recallPromptMarkerFree: compactEvidence.recallPromptMarkerFree,
  markerRecallCount: compactEvidence.markerRecallCount,
  orderedEvidence: compactEvidence.orderedEvidence,
  resultSubtype,
  runtimeErrorPresent,
  reasonCount: compactEvidence.reasons.length + sdkEvidence.reasons.length
    + (runtimeErrorPresent ? 1 : 0),
});

console.log(pass
  ? 'PASS — manual compaction preserved one same-session marker'
  : 'FAIL — manual compaction evidence was incomplete');
process.exit(pass ? 0 : 1);

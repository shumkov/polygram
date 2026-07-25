#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  buildClaudeGateSdkOptions,
  createClaudeGateSelection,
  hashSensitiveString,
} from './claude-executable.mjs';
import {
  createSdkGateObserver,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import {
  evaluateOpusProjection,
  inspectWorkflowSizeGuidelineDefault,
} from './workflow-fixture.mjs';

const workflowDriver = fileURLToPath(
  new URL('./workflow-autonomous-completion.mjs', import.meta.url),
);
const expectedResolvedModel = process.env.CLAUDE_GATE_EXPECTED_RESOLVED_MODEL;
const documentedWorkflowSizeGuideline = (
  process.env.CLAUDE_GATE_DOCUMENTED_WORKFLOW_SIZE_GUIDELINE
);
if (!expectedResolvedModel || !documentedWorkflowSizeGuideline) {
  throw new Error(
    'candidate projection requires expected model and documented Workflow guideline',
  );
}

const selection = await createClaudeGateSelection();
if (selection.version !== '2.1.220' || selection.model !== 'opus') {
  throw new Error('candidate projection must select Claude Code 2.1.220 with model opus');
}
const workflowSizeGuidelineEvidence = await inspectWorkflowSizeGuidelineDefault({
  executablePath: selection.executablePath,
  executableSha256: selection.sha256,
  expectedGuideline: documentedWorkflowSizeGuideline,
});
const observer = createSdkGateObserver(selection, { expectedResolvedModel });

const marker = `OPUS-PROJECTION:${crypto.randomBytes(4).toString('hex')}`;
const privateDir = path.join(selection.artifactDir, 'raw-private');
const streamPath = path.join(privateDir, 'sdk-stream.ndjson');
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(privateDir, 0o700);
const streamFd = fs.openSync(streamPath, 'wx', 0o600);

let resolvedModel = null;
let resultSubtype = null;
let markerCount = 0;
const q = query({
  prompt: `Reply with exactly ${marker} and nothing else.`,
  options: buildClaudeGateSdkOptions(selection, {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 2,
  }),
});
for await (const message of q) {
  fs.writeSync(streamFd, `${JSON.stringify(message)}\n`);
  observer.observe(message);
  if (
    message.type === 'system'
    && message.subtype === 'init'
    && typeof message.model === 'string'
  ) {
    resolvedModel = message.model;
  }
  if (message.type === 'assistant') {
    for (const block of message.message?.content || []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        markerCount += block.text.split(marker).length - 1;
      }
    }
  }
  if (message.type === 'result') resultSubtype = message.subtype;
}
fs.closeSync(streamFd);

const childArtifactBase = path.join(selection.artifactDir, 'nested-runs');
fs.mkdirSync(childArtifactBase, { mode: 0o700 });
const childRunId = 'workflow';
const workflowRun = spawnSync(
  process.execPath,
  [workflowDriver, '--delivery', 'direct'],
  {
    encoding: 'utf8',
    timeout: 420_000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      CLAUDE_GATE_BIN: selection.executablePath,
      CLAUDE_GATE_EXPECTED_VERSION: selection.version,
      CLAUDE_GATE_RUN_ID: childRunId,
      CLAUDE_GATE_ARTIFACT_BASE: childArtifactBase,
      CLAUDE_GATE_MODEL: 'opus',
      CLAUDE_GATE_EFFORT: selection.effort,
      CLAUDE_GATE_EXPECTED_RESOLVED_MODEL: expectedResolvedModel,
    },
  },
);
const workflowLogPath = path.join(privateDir, 'workflow-driver.log');
fs.writeFileSync(
  workflowLogPath,
  `${workflowRun.stdout || ''}${workflowRun.stderr || ''}`,
  { encoding: 'utf8', mode: 0o600 },
);
fs.chmodSync(workflowLogPath, 0o600);

const workflowResultPath = path.join(
  childArtifactBase,
  childRunId,
  'sanitized-result.json',
);
const workflowResult = fs.existsSync(workflowResultPath)
  ? JSON.parse(fs.readFileSync(workflowResultPath, 'utf8'))
  : null;
const sdkEvidence = observer.finish();
const projection = evaluateOpusProjection({
  resolvedModel,
  expectedResolvedModel,
  selectedExecutableSha256: selection.sha256,
  documentedWorkflowSizeGuideline,
  workflowSizeGuidelineEvidence,
  workflowPolicyOverridePresent: workflowResult?.workflowPolicyOverridePresent,
  workflowExitStatus: workflowRun.status,
  workflowMetadata: workflowResult?.workflowMetadata,
});
const reasons = [...projection.reasons];
if (resultSubtype !== 'success') reasons.push('Opus model projection query did not succeed');
if (markerCount !== 1) reasons.push('Opus model projection marker was not emitted exactly once');
reasons.push(...sdkEvidence.reasons);
const status = reasons.length === 0 ? 'PASS' : 'FAIL';
const resultPath = writeSanitizedGateResult(selection.artifactDir, {
  evidenceSchemaVersion: 1,
  matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID
    || 'candidate-opus-projection',
  scenario: 'candidate-opus-projection',
  status,
  attestation: selection.sanitizedAttestation,
  resolvedModel,
  expectedResolvedModel,
  documentedWorkflowSizeGuideline,
  workflowSizeGuidelineEvidence,
  lifecycle: sdkEvidence.lifecycle,
  wrapperRecords: sdkEvidence.wrapperRecords,
  processEvidence: sdkEvidence.processEvidence,
  workflowPolicyOverridePresent: workflowResult?.workflowPolicyOverridePresent ?? null,
  workflowStatus: workflowResult?.status ?? null,
  workflowMetadata: workflowResult?.workflowMetadata ?? [],
  resultSubtype,
  markerCount,
  reasonCount: reasons.length,
  reasonHashes: reasons.map(hashSensitiveString),
});

console.log('attestation:', JSON.stringify(selection.sanitizedAttestation));
console.log('resolved model:', resolvedModel);
console.log('sanitized result:', resultPath);
console.log(status);
if (reasons.length > 0) {
  for (const reason of reasons) console.error(`- ${reason}`);
}
process.exit(status === 'PASS' ? 0 : 1);

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '..', 'scripts', 'spikes', 'workflow-fixture.mjs'),
).href;

test('Workflow gate prepares a private project-local skill that mandates native bounded Workflow', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-workflow-fixture-'));
  t.after(() => fs.rmSync(parentDir, { recursive: true, force: true }));

  const { prepareWorkflowProject } = await import(moduleUrl);
  const prepared = await prepareWorkflowProject({ parentDir });
  const skillPath = path.join(
    prepared.cwd,
    '.claude',
    'skills',
    'completion-sentinel',
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');

  assert.equal(fs.statSync(prepared.cwd).mode & 0o777, 0o700);
  assert.equal(fs.statSync(skillPath).mode & 0o777, 0o600);
  assert.match(content, /^---\nname: completion-sentinel\n/m);
  assert.match(content, /native `Workflow` tool exactly once/i);
  assert.match(content, /at most three agents/i);
  assert.match(content, /\$ARGUMENTS/);
  assert.match(prepared.fixtureHash, /^[a-f0-9]{64}$/);
  assert.equal(prepared.skillName, 'completion-sentinel');
  assert.equal(prepared.workflowPolicyOverridePresent, false);
});

test('Workflow evidence records topology and completeness without result bodies', async () => {
  const { summarizeWorkflowRecord } = await import(moduleUrl);
  const summary = summarizeWorkflowRecord({
    status: 'completed',
    agentCount: 3,
    defaultModel: 'claude-opus-5',
    durationMs: 2_500,
    totalTokens: 800,
    totalToolCalls: 4,
    result: 'sensitive terminal report',
    phases: [{ title: 'sensitive title' }, { title: 'another title' }],
    workflowProgress: [
      { type: 'agent_started', title: 'sensitive agent' },
      { type: 'agent_completed', title: 'sensitive agent' },
      { type: 'agent_started', title: 'sensitive agent' },
    ],
  });

  assert.deepEqual(summary, {
    status: 'completed',
    agentCount: 3,
    defaultModel: 'claude-opus-5',
    durationMs: 2_500,
    totalTokens: 800,
    totalToolCalls: 4,
    phaseCount: 2,
    progressCount: 3,
    progressTypes: {
      agent_completed: 1,
      agent_started: 2,
    },
    reportComplete: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /sensitive/);
});

test('Workflow default evidence is fingerprinted from the exact selected binary', async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-workflow-default-'));
  t.after(() => fs.rmSync(parentDir, { recursive: true, force: true }));

  const executablePath = path.join(parentDir, 'claude');
  const runtimeText = [
    '"medium" (the default) fewer than 15',
    'var rLs,_Td="medium",oko',
    'settings.workflowSizeGuideline)??Msn(e);return t===void 0?{size:_Td,isDefault:!0}',
  ].join('\0');
  fs.writeFileSync(executablePath, runtimeText);
  const executableSha256 = crypto
    .createHash('sha256')
    .update(runtimeText)
    .digest('hex');

  const { inspectWorkflowSizeGuidelineDefault } = await import(moduleUrl);
  assert.deepEqual(
    await inspectWorkflowSizeGuidelineDefault({
      executablePath,
      executableSha256,
      expectedGuideline: 'medium',
    }),
    {
      source: 'selected-binary-runtime-default',
      value: 'medium',
      executableSha256,
      fingerprintMatched: true,
    },
  );

  fs.writeFileSync(executablePath, '"medium" (the default) fewer than 15');
  const changedSha256 = crypto
    .createHash('sha256')
    .update('"medium" (the default) fewer than 15')
    .digest('hex');
  const missingRuntimeAssignment = await inspectWorkflowSizeGuidelineDefault({
    executablePath,
    executableSha256: changedSha256,
    expectedGuideline: 'medium',
  });
  assert.equal(missingRuntimeAssignment.fingerprintMatched, false);
});

test('Opus projection requires Opus 5 and a complete unoverridden Workflow', async () => {
  const { evaluateOpusProjection } = await import(moduleUrl);
  const valid = evaluateOpusProjection({
    resolvedModel: 'claude-opus-5',
    expectedResolvedModel: 'claude-opus-5',
    selectedExecutableSha256: 'a'.repeat(64),
    documentedWorkflowSizeGuideline: 'medium',
    workflowSizeGuidelineEvidence: {
      source: 'selected-binary-runtime-default',
      value: 'medium',
      executableSha256: 'a'.repeat(64),
      fingerprintMatched: true,
    },
    workflowPolicyOverridePresent: false,
    workflowExitStatus: 0,
    workflowMetadata: [{
      status: 'completed',
      agentCount: 3,
      reportComplete: true,
    }],
  });
  assert.deepEqual(valid, { pass: true, reasons: [] });

  const invalid = evaluateOpusProjection({
    resolvedModel: 'claude-opus-4-7',
    expectedResolvedModel: 'claude-opus-5',
    selectedExecutableSha256: 'a'.repeat(64),
    documentedWorkflowSizeGuideline: 'medium',
    workflowSizeGuidelineEvidence: null,
    workflowPolicyOverridePresent: true,
    workflowExitStatus: 1,
    workflowMetadata: [{
      status: 'failed',
      agentCount: 4,
      reportComplete: false,
    }],
  });
  assert.equal(invalid.pass, false);
  assert.match(invalid.reasons.join('\n'), /resolved model/);
  assert.match(invalid.reasons.join('\n'), /size guideline/);
  assert.match(invalid.reasons.join('\n'), /policy override/);
  assert.match(invalid.reasons.join('\n'), /bounded Workflow gate/);
  assert.match(invalid.reasons.join('\n'), /report/);
});

test('Workflow delivery oracle requires one exact visible completion on the origin route', async () => {
  const { evaluateWorkflowDeliveryEvidence } = await import(moduleUrl);
  const common = {
    marker: 'WF-COMPLETE:test',
    originRoute: '-100:37',
    foreignRoutes: ['-100:root', '-100:38'],
  };
  assert.deepEqual(evaluateWorkflowDeliveryEvidence({
    ...common,
    deliveryMode: 'fail',
    directAttempts: [{
      route: '-100:37',
      text: 'WF-COMPLETE:test',
      delivered: false,
    }],
    fallbackDeliveries: [{
      route: '-100:37',
      text: 'WF-COMPLETE:test',
      delivered: true,
    }],
    fallbackPipeline: 'helper',
    fallbackSentCount: 1,
    fallbackFailedCount: 0,
  }), { pass: true, reasons: [] });

  const duplicate = evaluateWorkflowDeliveryEvidence({
    ...common,
    deliveryMode: 'fail',
    directAttempts: [
      { route: '-100:37', text: 'WF-COMPLETE:test', delivered: false },
      { route: '-100:37', text: 'WF-COMPLETE:test', delivered: false },
    ],
    fallbackDeliveries: [{
      route: '-100:37',
      text: 'WF-COMPLETE:test WF-COMPLETE:test',
      delivered: true,
    }],
    fallbackPipeline: 'legacy',
    fallbackSentCount: 1,
    fallbackFailedCount: 0,
  });
  assert.equal(duplicate.pass, false);
  assert.match(duplicate.reasons.join('\n'), /exactly one direct attempt/);
  assert.match(duplicate.reasons.join('\n'), /exact completion text/);
  assert.match(duplicate.reasons.join('\n'), /production helper pipeline/);
});

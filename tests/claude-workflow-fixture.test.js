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

test('Workflow gate socket prefix fits the reproduced macOS Unix-path limit', async () => {
  const { WORKFLOW_GATE_SESSION_PREFIX } = await import(moduleUrl);
  assert.equal(typeof WORKFLOW_GATE_SESSION_PREFIX, 'string');
  const reproducedTmpDir = '/var/folders/1m/jkbsl8jn10d6pm5wqqt682ym0000gp/T';
  const socketPath = path.join(
    reproducedTmpDir,
    `${WORKFLOW_GATE_SESSION_PREFIX}-${'f'.repeat(32)}.sock`,
  );
  assert.ok(Buffer.byteLength(socketPath) < 104);

  const driver = fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'spikes',
    'workflow-autonomous-completion.mjs',
  ), 'utf8');
  assert.equal(
    driver.match(/sessionPrefix: WORKFLOW_GATE_SESSION_PREFIX/g)?.length,
    2,
    'the tmux runner and CliProcess must share the sweep prefix',
  );
  assert.doesNotMatch(driver, /sessionPrefix: 'polygram-workflow-gate'/);
  assert.ok(
    driver.indexOf("path.join(fixture.cwd, '.workflow-completion-marker')")
      > driver.indexOf('launchTurnClosedAt = Date.now()'),
    'the completion marker must not exist before the launch turn closes',
  );
});

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
  assert.match(content, /sleep 20/);
  assert.match(content, /\.workflow-completion-marker/);
  assert.match(content, /wait.*marker file.*appear/i);
  assert.match(content, /ordinary JavaScript/i);
  assert.match(content, /\^WF-COMPLETE:\[a-f0-9\]\{32\}\$/);
  assert.match(content, /require\s+exactly one match/i);
  assert.match(content, /return that match directly/i);
  assert.match(content, /do not ask.*agent.*restate/i);
  assert.doesNotMatch(content, /WF-COMPLETE:\$ARGUMENTS/);
  assert.match(content, /never call.*WF-COMPLETE.*launch turn/i);
  assert.match(content, /current user event.*<task-notification>/i);
  assert.match(content, /without quotes, backticks, labels, or commentary/i);
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

test('Workflow metadata evidence selects only the task-notification-linked run', async () => {
  const { summarizeWorkflowRecordsForTask } = await import(moduleUrl);
  const summaries = summarizeWorkflowRecordsForTask([
    {
      taskId: 'failed-preflight',
      status: 'failed',
      agentCount: 0,
      result: null,
    },
    {
      taskId: 'notified-task',
      status: 'completed',
      agentCount: 2,
      result: 'WF-COMPLETE:expected',
    },
  ], {
    taskId: 'notified-task',
    expectedResult: 'WF-COMPLETE:expected',
  });

  assert.deepEqual(summaries, [{
    status: 'completed',
    agentCount: 2,
    defaultModel: null,
    durationMs: null,
    totalTokens: null,
    totalToolCalls: null,
    phaseCount: null,
    progressCount: null,
    progressTypes: {},
    reportComplete: true,
    reportMatchesExpected: true,
  }]);
  assert.throws(
    () => summarizeWorkflowRecordsForTask([
      { taskId: 'unrelated', status: 'completed', result: 'WF-COMPLETE:expected' },
    ], {
      taskId: 'notified-task',
      expectedResult: 'WF-COMPLETE:expected',
    }),
    /exactly one notification-linked run/,
  );
  assert.throws(
    () => summarizeWorkflowRecordsForTask([
      { taskId: 'notified-task', status: 'completed', result: 'WF-COMPLETE:expected' },
      { taskId: 'notified-task', status: 'completed', result: 'WF-COMPLETE:expected' },
    ], {
      taskId: 'notified-task',
      expectedResult: 'WF-COMPLETE:expected',
    }),
    /exactly one notification-linked run/,
  );
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

test('Workflow delivery oracle requires one unambiguous visible completion on the origin route', async () => {
  const { evaluateWorkflowDeliveryEvidence } = await import(moduleUrl);
  const common = {
    marker: 'WF-COMPLETE:test',
    completionPrefix: 'WF-COMPLETE:',
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
  assert.match(duplicate.reasons.join('\n'), /unambiguous completion/);
  assert.match(duplicate.reasons.join('\n'), /production helper pipeline/);

  const premature = evaluateWorkflowDeliveryEvidence({
    ...common,
    deliveryMode: 'direct',
    directAttempts: [
      {
        route: '-100:37',
        text: 'WF-COMPLETE:guessed',
        delivered: true,
      },
      {
        route: '-100:37',
        text: 'WF-COMPLETE:test',
        delivered: true,
      },
    ],
  });
  assert.equal(premature.pass, false);
  assert.match(premature.reasons.join('\n'), /unexpected completion-shaped/);

  assert.deepEqual(evaluateWorkflowDeliveryEvidence({
    ...common,
    deliveryMode: 'direct',
    directAttempts: [{
      route: '-100:37',
      text: '"WF-COMPLETE:test"',
      delivered: true,
    }],
  }), { pass: true, reasons: [] });
});

test('Workflow timing oracle rejects a task notification inside stop grace', async (t) => {
  const {
    evaluateWorkflowOutOfTurnTiming,
    readWorkflowTaskNotificationAt,
    readWorkflowTaskNotificationEvidence,
  } = await import(moduleUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-workflow-timing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(sessionPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-25T19:16:40.543Z',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: {
        content: [
          '<task-notification>',
          '<task-id>notified-task</task-id>',
          '<result>WF-COMPLETE:expected</result>',
          '</task-notification>',
        ].join('\n'),
      },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-25T19:16:43.473Z',
      message: { content: [{ type: 'text', text: 'sensitive' }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-25T19:17:00.000Z',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: { content: 'not a task notification envelope' },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-25T19:17:10.000Z',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: {
        content: '<task-notification>WF-COMPLETE:unrelated</task-notification>',
      },
    }),
  ].join('\n'));
  assert.equal(
    readWorkflowTaskNotificationAt(sessionPath, 'WF-COMPLETE:expected'),
    Date.parse('2026-07-25T19:16:40.543Z'),
  );
  assert.deepEqual(
    readWorkflowTaskNotificationEvidence(sessionPath, 'WF-COMPLETE:expected'),
    {
      timestamp: Date.parse('2026-07-25T19:16:40.543Z'),
      taskId: 'notified-task',
    },
  );

  const common = {
    launchStopHookAt: 1_000,
    launchTurnClosedAt: 3_100,
    completionAt: 24_000,
    stopGraceMs: 2_000,
    schedulingMarginMs: 500,
    completionProcessingMarginMs: 100,
  };

  const inGrace = evaluateWorkflowOutOfTurnTiming({
    ...common,
    taskNotificationAt: 1_269,
  });
  assert.equal(inGrace.pass, false);
  assert.equal(inGrace.taskNotificationAfterStopMs, 269);
  assert.match(inGrace.reasons.join('\n'), /stop-grace boundary/);

  assert.equal(evaluateWorkflowOutOfTurnTiming({
    ...common,
    launchStopHookAt: null,
    taskNotificationAt: 21_000,
  }).pass, false);

  const earlyCompletion = evaluateWorkflowOutOfTurnTiming({
    ...common,
    completionAt: 20_000,
    taskNotificationAt: 21_000,
  });
  assert.equal(earlyCompletion.pass, false);
  assert.match(earlyCompletion.reasons.join('\n'), /after the task notification/);

  assert.deepEqual(evaluateWorkflowOutOfTurnTiming({
    ...common,
    taskNotificationAt: 21_000,
  }), {
    pass: true,
    reasons: [],
    requiredTaskNotificationDelayMs: 2_500,
    requiredCompletionAfterNotificationMs: 100,
    taskNotificationAfterStopMs: 20_000,
    completionAfterLaunchTurnMs: 20_900,
    completionAfterTaskNotificationMs: 3_000,
  });
});

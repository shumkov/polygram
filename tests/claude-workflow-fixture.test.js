'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
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
  assert.match(driver, /collectGateSessionEvidence\(privateSession\)/);
  assert.match(driver, /lifecycleSources,/);
  assert.match(driver, /lifecycleProofs,/);

  const preLaunchCount = driver.indexOf('terminalBeforeLaunch');
  const launchCallStart = driver.indexOf('launchCallStart = directCalls.length');
  const launchSend = driver.indexOf('const launchResult = await proc.send');
  const launchSettlement = driver.indexOf('launchTerminal = await waitForGateSessionTerminal');
  const launchCallSnapshot = driver.indexOf(
    'launchCalls = directCalls.slice(launchCallStart)',
  );
  const completionWaiter = driver.indexOf(
    'completionTurnEvidence = waitForWorkflowCompletionTurnEvidence',
  );
  const markerRelease = driver.indexOf(
    "path.join(fixture.cwd, '.workflow-completion-marker')",
  );
  assert.ok(preLaunchCount >= 0, 'the driver must record a pre-launch terminal count');
  assert.ok(
    launchCallStart >= 0 && launchCallStart < launchSend,
    'the launch dispatcher slice must start immediately before the launch send',
  );
  assert.ok(
    launchSettlement > preLaunchCount,
    'the launch terminal suffix must settle against the pre-launch count',
  );
  assert.ok(
    launchCallSnapshot > launchSettlement
      && completionWaiter > launchCallSnapshot
      && completionWaiter < markerRelease,
    'the frozen launch slice and completion waiter must precede marker release',
  );
  assert.doesNotMatch(
    driver,
    /await sleep\(4_000\)/,
    'a fixed delay cannot prove completion-turn durability',
  );
});

function writeSessionRows(filePath, rows) {
  fs.writeFileSync(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

function appendSessionRows(filePath, rows) {
  fs.appendFileSync(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

function workflowReplyToolUse({ toolUseId, toolName, marker }) {
  return {
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: toolName,
        input: { text: marker },
      }],
    },
  };
}

function workflowReplyToolResult({
  toolUseId,
  payload,
  isError = false,
  arrayContent = false,
}) {
  const content = JSON.stringify(payload);
  return {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        ...(isError && { is_error: true }),
        content: arrayContent ? [{ type: 'text', text: content }] : content,
      }],
    },
  };
}

test('fresh Workflow sessions use a zero pre-launch count before JSONL creation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-workflow-prelaunch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionPath = path.join(dir, 'not-created-yet.jsonl');
  const {
    readWorkflowPreLaunchTerminalState,
  } = await import(moduleUrl);

  assert.deepEqual(readWorkflowPreLaunchTerminalState(sessionPath), {
    turnDurationCount: 0,
    pivotalSuffix: [],
  });

  writeSessionRows(sessionPath, [
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'system', subtype: 'turn_duration' },
  ]);
  assert.equal(
    readWorkflowPreLaunchTerminalState(sessionPath).turnDurationCount,
    1,
  );
  fs.writeFileSync(sessionPath, '{malformed');
  assert.throws(
    () => readWorkflowPreLaunchTerminalState(sessionPath),
    /malformed/i,
  );
});

test('Workflow completion evidence waits for the marker-bound direct result, Stop, and durable suffix', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-workflow-direct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionPath = path.join(dir, 'session.jsonl');
  writeSessionRows(sessionPath, [
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'system', subtype: 'turn_duration' },
  ]);

  const {
    waitForWorkflowCompletionTurnEvidence,
  } = await import(moduleUrl);
  const emitter = new EventEmitter();
  const marker = 'WF-COMPLETE:direct-marker';
  const toolName = 'mcp__polygram-workflow-gate-bridge__reply';
  const pending = waitForWorkflowCompletionTurnEvidence({
    emitter,
    sessionPath,
    completionMarker: marker,
    replyToolName: toolName,
    deliveryMode: 'direct',
    afterTurnDurationCount: 1,
    eventTimeoutMs: 250,
    durableTimeoutMs: 250,
    pollMs: 5,
  });

  emitter.emit('stop-hook', {});
  emitter.emit('tool-result', {
    name: toolName,
    toolUseId: 'stale-result',
    isError: false,
  });
  emitter.emit('tool-use-detail', {
    name: toolName,
    input: { text: `prefix ${marker}` },
    toolUseId: 'transformed-direct',
  });
  emitter.emit('tool-result', {
    name: toolName,
    toolUseId: 'transformed-direct',
    isError: false,
  });
  emitter.emit('stop-hook', {});
  emitter.emit('tool-use-detail', {
    name: toolName,
    input: { text: marker },
    toolUseId: 'target-direct',
  });
  emitter.emit('stop-hook', {});
  emitter.emit('tool-result', {
    name: toolName,
    toolUseId: 'stale-result',
    isError: false,
  });

  let settled = false;
  pending.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'stale result and early Stop must not settle');

  appendSessionRows(sessionPath, [
    workflowReplyToolUse({
      toolUseId: 'target-direct',
      toolName,
      marker,
    }),
    workflowReplyToolResult({
      toolUseId: 'target-direct',
      payload: { ok: true, message_id: 220 },
      arrayContent: true,
    }),
  ]);
  emitter.emit('tool-result', {
    name: toolName,
    toolUseId: 'target-direct',
    isError: false,
  });
  emitter.emit('stop-hook', {});
  appendSessionRows(sessionPath, [
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, 'Stop summary without turn duration is not durable');

  appendSessionRows(sessionPath, [
    { type: 'system', subtype: 'turn_duration' },
  ]);
  assert.deepEqual(await pending, {
    toolUseMatched: true,
    toolResultEventMatched: true,
    stopAfterToolUse: true,
    transcriptToolUseCount: 1,
    transcriptToolResultCount: 1,
    receiptOk: true,
    receiptIsError: false,
    terminalAdvanced: true,
    turnDurationCount: 2,
  });
});

test('Workflow gate waits for duplicate-suppression delivery work before accepting no fallback', async () => {
  const {
    waitForWorkflowDeliveryWorkSettled,
  } = await import('../scripts/spikes/workflow-fixture.mjs');
  const emitter = new EventEmitter();
  let pending = true;
  emitter.hasPendingDeliveryWork = () => pending;

  let settled = false;
  const wait = waitForWorkflowDeliveryWorkSettled(emitter, {
    timeoutMs: 250,
  }).then(() => {
    settled = true;
  });
  emitter.emit('delivery-work-settled');
  await Promise.resolve();
  assert.equal(settled, false, 'an intermediate settlement cannot release the gate');

  pending = false;
  emitter.emit('delivery-work-settled');
  await wait;
  assert.equal(settled, true);
  assert.equal(emitter.listenerCount('delivery-work-settled'), 0);

  const raced = new EventEmitter();
  let checks = 0;
  raced.hasPendingDeliveryWork = () => {
    checks += 1;
    return checks === 1;
  };
  await waitForWorkflowDeliveryWorkSettled(raced, { timeoutMs: 250 });
  assert.equal(
    raced.listenerCount('delivery-work-settled'),
    0,
    'the post-listener recheck must close the registration race',
  );
});

test('Workflow durable completion receipt requires exact marker text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-workflow-exact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionPath = path.join(dir, 'session.jsonl');
  writeSessionRows(sessionPath, [
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'system', subtype: 'turn_duration' },
  ]);

  const {
    waitForWorkflowCompletionTurnEvidence,
  } = await import(moduleUrl);
  const emitter = new EventEmitter();
  const marker = 'WF-COMPLETE:exact-marker';
  const toolName = 'mcp__polygram-workflow-gate-bridge__reply';
  const pending = waitForWorkflowCompletionTurnEvidence({
    emitter,
    sessionPath,
    completionMarker: marker,
    replyToolName: toolName,
    deliveryMode: 'direct',
    afterTurnDurationCount: 1,
    eventTimeoutMs: 250,
    durableTimeoutMs: 250,
    pollMs: 5,
  });

  emitter.emit('tool-use-detail', {
    name: toolName,
    input: { text: marker },
    toolUseId: 'target-exact',
  });
  emitter.emit('tool-result', {
    name: toolName,
    toolUseId: 'target-exact',
    isError: false,
  });
  emitter.emit('stop-hook', {});
  appendSessionRows(sessionPath, [
    workflowReplyToolUse({
      toolUseId: 'target-exact',
      toolName,
      marker: `"${marker}"`,
    }),
    workflowReplyToolResult({
      toolUseId: 'target-exact',
      payload: { ok: true, message_id: 220 },
    }),
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'system', subtype: 'turn_duration' },
  ]);

  await assert.rejects(pending, /does not match the captured reply/);
});

test('Workflow fallback evidence proves the failed raw receipt without a PostToolUse event', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-workflow-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionPath = path.join(dir, 'session.jsonl');
  writeSessionRows(sessionPath, [
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'system', subtype: 'turn_duration' },
  ]);

  const {
    waitForWorkflowCompletionTurnEvidence,
  } = await import(moduleUrl);
  const emitter = new EventEmitter();
  const marker = 'WF-COMPLETE:fallback-marker';
  const toolName = 'mcp__polygram-workflow-gate-bridge__reply';
  const pending = waitForWorkflowCompletionTurnEvidence({
    emitter,
    sessionPath,
    completionMarker: marker,
    replyToolName: toolName,
    deliveryMode: 'fail',
    afterTurnDurationCount: 1,
    eventTimeoutMs: 250,
    durableTimeoutMs: 250,
    pollMs: 5,
  });

  emitter.emit('tool-result', {
    name: toolName,
    toolUseId: 'target-fallback',
    isError: true,
  });
  emitter.emit('stop-hook', {});
  emitter.emit('tool-use-detail', {
    name: toolName,
    input: { text: marker },
    toolUseId: 'target-fallback',
  });
  appendSessionRows(sessionPath, [
    workflowReplyToolUse({
      toolUseId: 'target-fallback',
      toolName,
      marker,
    }),
    workflowReplyToolResult({
      toolUseId: 'target-fallback',
      payload: { ok: false, error: 'synthetic failure' },
      isError: true,
    }),
  ]);
  emitter.emit('stop-hook', {});
  appendSessionRows(sessionPath, [
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'system', subtype: 'turn_duration' },
  ]);

  assert.deepEqual(await pending, {
    toolUseMatched: true,
    toolResultEventMatched: false,
    stopAfterToolUse: true,
    transcriptToolUseCount: 1,
    transcriptToolResultCount: 1,
    receiptOk: false,
    receiptIsError: true,
    terminalAdvanced: true,
    turnDurationCount: 2,
  });
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
  assert.match(content, /already contains.*complete.*WF-COMPLETE.*line/i);
  assert.match(content, /output.*line.*byte-for-byte/i);
  assert.match(content, /one trailing LF line\s+terminator/i);
  assert.match(content, /do not.*(?:hash|digest|checksum|encode|transform)/i);
  for (const command of ['md5', 'md5sum', 'shasum', 'sha256sum']) {
    assert.match(content, new RegExp(`\\b${command}\\b`));
  }
  assert.match(content, /ordinary JavaScript/i);
  assert.match(content, /\^WF-COMPLETE:\[a-f0-9\]\{32\}\$/);
  assert.match(content, /require\s+exactly one match/i);
  assert.match(content, /return that match directly/i);
  assert.match(content, /end with\s+exactly `return matches\[0\]`/i);
  assert.match(content, /do not use `replace`, `slice`, or `substring`/i);
  assert.match(content, /do not ask.*agent.*restate/i);
  assert.doesNotMatch(content, /WF-COMPLETE:\$ARGUMENTS/);
  assert.match(content, /never call.*WF-COMPLETE.*launch turn/i);
  assert.match(content, /current user event.*<task-notification>/i);
  assert.match(content, /without quotes, backticks, labels, or commentary/i);
  assert.match(content, /reply.*exactly once/i);
  assert.match(content, /no attached files/i);
  assert.match(content, /no further channel (?:tool )?call/i);
  assert.match(content, /do not send a progress\/status\s+reply/i);
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
  assert.deepEqual(summarizeWorkflowRecordsForTask([
    {
      taskId: 'notified-task',
      status: 'completed',
      agentCount: 2,
      result: ' WF-COMPLETE:expected',
    },
  ], {
    taskId: 'notified-task',
    expectedResult: 'WF-COMPLETE:expected',
  })[0], {
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
    reportMatchesExpected: false,
  });
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

  for (const text of [
    '"WF-COMPLETE:test"',
    'prefix WF-COMPLETE:test',
    'WF-COMPLETE:test suffix',
    'WF-COMPLETE:test\n',
    '`WF-COMPLETE:test`',
    '```\nWF-COMPLETE:test\n```',
  ]) {
    const transformed = evaluateWorkflowDeliveryEvidence({
      ...common,
      deliveryMode: 'direct',
      directAttempts: [{
        route: '-100:37',
        text,
        delivered: true,
      }],
    });
    assert.equal(transformed.pass, false);
  }
});

test('Workflow launch oracle rejects the reproduced sentinel plus progress reply', async () => {
  const { evaluateWorkflowLaunchDeliveryEvidence } = await import(moduleUrl);
  const common = {
    launchMarker: 'WF-LAUNCHED:test',
    originRoute: '-100:37',
  };
  const validCall = {
    route: '-100:37',
    toolName: 'reply',
    text: 'WF-LAUNCHED:test',
    delivered: true,
    interim: false,
    files: [],
  };
  assert.deepEqual(evaluateWorkflowLaunchDeliveryEvidence({
    ...common,
    calls: [validCall],
  }), {
    pass: true,
    reasons: [],
    proof: {
      launchDeliveryCount: 1,
      exactlyOneCall: true,
      replyToolMatched: true,
      originRouteMatched: true,
      exactTextMatched: true,
      deliverySucceeded: true,
      nonInterim: true,
      zeroFiles: true,
    },
  });

  const reproduced = evaluateWorkflowLaunchDeliveryEvidence({
    ...common,
    calls: [
      validCall,
      {
        ...validCall,
        text: 'Workflow running in background.',
      },
    ],
  });
  assert.equal(reproduced.pass, false);
  assert.equal(reproduced.proof.launchDeliveryCount, 2);
  assert.match(reproduced.reasons.join('\n'), /exactly one/i);

  const invalidCases = [
    [{ ...validCall, route: '-100:38' }, /origin route/i],
    [{ ...validCall, text: 'prefix WF-LAUNCHED:test' }, /exact text/i],
    [{ ...validCall, delivered: false }, /successful delivery/i],
    [{ ...validCall, interim: true }, /non-interim/i],
    [{ ...validCall, files: ['/private/file'] }, /without files/i],
    [{ ...validCall, toolName: 'edit_message' }, /reply tool/i],
  ];
  for (const [call, reason] of invalidCases) {
    const result = evaluateWorkflowLaunchDeliveryEvidence({
      ...common,
      calls: [call],
    });
    assert.equal(result.pass, false);
    assert.match(result.reasons.join('\n'), reason);
  }
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
          '<result>"WF-COMPLETE:expected"</result>',
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

  for (const result of [
    'WF-COMPLETE:expected',
    '"prefix WF-COMPLETE:expected"',
    '"WF-COMPLETE:expected "',
    '"wf-complete:expected"',
  ]) {
    fs.writeFileSync(sessionPath, JSON.stringify({
      type: 'user',
      timestamp: '2026-07-25T19:16:40.543Z',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: {
        content: [
          '<task-notification>',
          '<task-id>notified-task</task-id>',
          `<result>${result}</result>`,
          '</task-notification>',
        ].join('\n'),
      },
    }));
    assert.throws(
      () => readWorkflowTaskNotificationEvidence(
        sessionPath,
        'WF-COMPLETE:expected',
      ),
      /exactly one timed matching task notification/,
    );
  }

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

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { encodeCwd } = require('../lib/util/claude-session-jsonl');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(
  repoRoot,
  'scripts/spikes/claude-2.1.283-matrix.json',
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const OLD_VERSION = manifest.versions.old;
const CANDIDATE_VERSION = manifest.versions.candidate;
const OLD_EXPECTATIONS = manifest.expectations[OLD_VERSION];
const CANDIDATE_EXPECTATIONS = manifest.expectations[CANDIDATE_VERSION];
const MANIFEST_EXPECTATIONS = {
  oldExpectations: OLD_EXPECTATIONS,
  candidateExpectations: CANDIDATE_EXPECTATIONS,
};
const REPLY_TOOL = 'mcp__polygram-gate-bridge__reply';
const WORKFLOW_REPLY_TOOL = 'mcp__polygram-workflow-gate-bridge__reply';
const SESSION_SOURCE_SHA = 'a'.repeat(64);

function channelUser(hasParent) {
  return {
    type: 'user',
    hasParent,
    contentKind: 'string',
    contentTypes: [],
    originKind: 'channel',
    promptSource: 'system',
  };
}

function queue(operation) {
  return { type: 'queue-operation', operation };
}

function attachment(attachmentType) {
  return { type: 'attachment', attachmentType };
}

function system(subtype) {
  return { type: 'system', subtype };
}

function hook(hookEventName, toolName) {
  return {
    type: 'hook',
    hookEventName,
    ...(toolName && { toolName }),
  };
}

const CLI_SESSION_PROJECTION = [
  queue('enqueue'),
  queue('dequeue'),
  channelUser(false),
  attachment('deferred_tools_delta'),
  attachment('agent_listing_delta'),
  attachment('mcp_instructions_delta'),
  attachment('skill_listing'),
  system('stop_hook_summary'),
  system('turn_duration'),
  queue('enqueue'),
  queue('dequeue'),
  channelUser(true),
  system('stop_hook_summary'),
  system('turn_duration'),
  queue('enqueue'),
  queue('dequeue'),
  channelUser(true),
  queue('enqueue'),
  queue('remove'),
  attachment('queued_command'),
  system('stop_hook_summary'),
  system('turn_duration'),
  queue('enqueue'),
  queue('dequeue'),
  channelUser(true),
  queue('enqueue'),
  queue('dequeue'),
  channelUser(true),
  system('stop_hook_summary'),
  system('turn_duration'),
  queue('enqueue'),
  queue('dequeue'),
  channelUser(true),
  system('stop_hook_summary'),
  system('turn_duration'),
];

const CLI_TRANSPORT_HOOKS = [
  hook('UserPromptSubmit'),
  hook('PreToolUse', REPLY_TOOL),
  hook('PostToolUse', REPLY_TOOL),
  hook('Stop'),
  hook('UserPromptSubmit'),
  hook('PreToolUse', REPLY_TOOL),
  hook('PostToolUse', REPLY_TOOL),
  hook('Stop'),
  hook('UserPromptSubmit'),
  hook('PreToolUse', REPLY_TOOL),
  hook('PostToolUse', REPLY_TOOL),
  hook('Stop'),
  hook('UserPromptSubmit'),
  hook('UserPromptSubmit'),
  hook('PreToolUse', REPLY_TOOL),
  hook('PostToolUse', REPLY_TOOL),
  hook('Stop'),
  hook('UserPromptSubmit'),
  hook('PreToolUse', REPLY_TOOL),
  hook('PostToolUse', REPLY_TOOL),
  hook('Stop'),
];

const WORKFLOW_SESSION_PROJECTION = [
  queue('enqueue'),
  queue('dequeue'),
  channelUser(false),
  attachment('deferred_tools_delta'),
  attachment('agent_listing_delta'),
  attachment('mcp_instructions_delta'),
  attachment('skill_listing'),
  attachment('command_permissions'),
  system('stop_hook_summary'),
  system('turn_duration'),
  queue('enqueue'),
  queue('dequeue'),
  {
    type: 'user',
    hasParent: true,
    contentKind: 'string',
    contentTypes: [],
    originKind: 'task-notification',
    promptSource: 'system',
    hasTaskNotification: true,
  },
  system('stop_hook_summary'),
  system('turn_duration'),
];

const WORKFLOW_DIRECT_HOOKS = [
  hook('UserPromptSubmit'),
  hook('PreToolUse', 'Workflow'),
  hook('PostToolUse', 'Workflow'),
  hook('PreToolUse', WORKFLOW_REPLY_TOOL),
  hook('PostToolUse', WORKFLOW_REPLY_TOOL),
  hook('Stop'),
  hook('UserPromptSubmit'),
  hook('PreToolUse', WORKFLOW_REPLY_TOOL),
  hook('PostToolUse', WORKFLOW_REPLY_TOOL),
  hook('Stop'),
];

const WORKFLOW_FALLBACK_HOOKS = [
  ...WORKFLOW_DIRECT_HOOKS.slice(0, -2),
  hook('Stop'),
];

function cliLifecycleFixture({
  fileTool,
  subagentStops,
  extraToolPair = false,
  taskReminderIndex = null,
}) {
  const session = CLI_SESSION_PROJECTION.map((record) => structuredClone(record));
  if (Number.isInteger(taskReminderIndex)) {
    session.splice(taskReminderIndex, 0, attachment('task_reminder'));
  }
  session.splice(4, 0, {
    type: 'assistant',
    hasParent: true,
    stopReason: 'tool_use',
    contentTypes: ['tool_use'],
    toolNames: [fileTool],
  });
  if (extraToolPair) {
    session.splice(
      18,
      0,
      {
        type: 'assistant',
        hasParent: true,
        stopReason: 'tool_use',
        contentTypes: ['tool_use'],
        toolNames: ['Bash'],
      },
      {
        type: 'user',
        hasParent: true,
        contentKind: 'blocks',
        contentTypes: ['tool_result'],
      },
    );
  }

  return {
    session,
    hooks: [
      ...CLI_TRANSPORT_HOOKS.map((record) => structuredClone(record)),
      hook('PreToolUse', fileTool),
      hook('PostToolUse', fileTool),
      ...Array.from({ length: subagentStops }, () => hook('SubagentStop')),
    ],
  };
}

function taskReminderProof(overrides = {}) {
  return compositeRemovalProof({
    taskReminderCount: 1,
    overrides,
  });
}

function compositeRemovalProof({
  taskReminderCount = 0,
  hookCancelledCount = 0,
  overrides = {},
} = {}) {
  const targets = [];
  if (hookCancelledCount > 0) {
    targets.push({
      record: attachment('hook_cancelled'),
      rawTargetCount: hookCancelledCount,
      normalizedTargetCount: hookCancelledCount,
      eligibility: {
        type: 'interrupt-user-prompt-submit-v1',
        allMainline: true,
        allHookNamesMatch: true,
        allParentsMatchInterrupt: true,
      },
    });
  }
  if (taskReminderCount > 0) {
    targets.push({
      record: attachment('task_reminder'),
      rawTargetCount: taskReminderCount,
      normalizedTargetCount: taskReminderCount,
      eligibility: { type: 'task-reminder-v1' },
    });
  }
  return {
    type: 'session-event-aggregator-removal',
    stream: 'session',
    sourceSha256: SESSION_SOURCE_SHA,
    targets,
    totalTargetCount: taskReminderCount + hookCancelledCount,
    targetBatchesEmpty: true,
    retainedPushBatchesEqual: true,
    flushBatchEqual: true,
    originalEventCount: 82,
    filteredEventCount: 82,
    flattenedEventsEqual: true,
    ...overrides,
  };
}

function matrixResult(lifecycle, { taskReminder = false } = {}) {
  const sessionRecordCount = lifecycle.session.length;
  return {
    resolvedModel: 'claude-sonnet-4-6',
    fileObserved: true,
    spawnCount: 2,
    lifecycle,
    lifecycleSources: {
      session: {
        stream: 'session',
        file: 'session.jsonl',
        sha256: SESSION_SOURCE_SHA,
        rawRecordCount: sessionRecordCount,
        normalizedRecordCount: sessionRecordCount,
      },
    },
    lifecycleProofs: taskReminder ? [taskReminderProof()] : [],
  };
}

// Rows Claude Code 2.1.283 adds to the same flows, as observed in the
// authoritative 2.1.220 -> 2.1.283 run: five attachments before the first
// enqueue, environment and model right after the first channel prompt, and
// deferred_tools_record after the first turn's context attachments.
const CONTEXT_ATTACHMENTS_283 = [
  'instructions',
  'session_context',
  'date',
  'credential_org',
  'remote_session_change',
  'environment',
  'model',
  'deferred_tools_record',
];
const SESSION_START_ATTACHMENTS_283 = [
  'instructions',
  'session_context',
  'date',
  'credential_org',
  'remote_session_change',
].map(attachment);

function with283SessionRows(lifecycle, { recordAfter }) {
  const session = structuredClone(lifecycle.session);
  const firstPrompt = session.findIndex(
    (record) => record.type === 'user' && record.hasParent === false,
  );
  session.splice(
    firstPrompt + 1,
    0,
    attachment('environment'),
    attachment('model'),
  );
  const contextEnd = session.findIndex(
    (record) => record.attachmentType === recordAfter,
  );
  session.splice(contextEnd + 1, 0, attachment('deferred_tools_record'));
  session.unshift(...structuredClone(SESSION_START_ATTACHMENTS_283));
  return { ...lifecycle, session };
}

// 2.1.283 also fires UserPromptSubmit for the prompt folded into the third
// turn, so that turn's transport hooks start with two of them.
function with283FoldPromptHook(lifecycle) {
  const hooks = structuredClone(lifecycle.hooks);
  const promptHooks = hooks.flatMap((record, index) => (
    record.hookEventName === 'UserPromptSubmit' ? [index] : []
  ));
  hooks.splice(promptHooks[2] + 1, 0, hook('UserPromptSubmit'));
  return { ...lifecycle, hooks };
}

function cli283Lifecycle(lifecycle) {
  return with283FoldPromptHook(
    with283SessionRows(lifecycle, { recordAfter: 'skill_listing' }),
  );
}

// Both pinned versions emit one task_reminder in the CLI contract flow; the
// manifest declares that count per version and the comparator removes it.
const CLI_LIFECYCLE_FIXTURES = {
  old1: matrixResult(cliLifecycleFixture({
    fileTool: 'Bash',
    subagentStops: 5,
    taskReminderIndex: 28,
  }), { taskReminder: true }),
  old2: matrixResult(cliLifecycleFixture({
    fileTool: 'Write',
    subagentStops: 4,
    taskReminderIndex: 28,
  }), { taskReminder: true }),
  old3: matrixResult(cliLifecycleFixture({
    fileTool: 'Write',
    subagentStops: 4,
    extraToolPair: true,
    taskReminderIndex: 33,
  }), { taskReminder: true }),
  candidate1: matrixResult(cli283Lifecycle(cliLifecycleFixture({
    fileTool: 'Bash',
    subagentStops: 5,
    taskReminderIndex: 28,
  })), { taskReminder: true }),
  candidate2: matrixResult(cli283Lifecycle(cliLifecycleFixture({
    fileTool: 'Write',
    subagentStops: 4,
    extraToolPair: true,
    taskReminderIndex: 33,
  })), { taskReminder: true }),
};

function workflowLifecycleFixture({ deliveryMode, bashPairs, subagentStops }) {
  const transportHooks = deliveryMode === 'direct'
    ? WORKFLOW_DIRECT_HOOKS
    : WORKFLOW_FALLBACK_HOOKS;
  return {
    session: [
      ...WORKFLOW_SESSION_PROJECTION.map((record) => structuredClone(record)),
      {
        type: 'assistant',
        hasParent: true,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
        contentTypes: ['text'],
        toolNames: [],
      },
    ],
    hooks: [
      ...transportHooks.map((record) => structuredClone(record)),
      ...Array.from({ length: bashPairs }, () => [
        hook('PreToolUse', 'Bash'),
        hook('PostToolUse', 'Bash'),
      ]).flat(),
      ...Array.from({ length: subagentStops }, () => hook('SubagentStop')),
    ],
  };
}

function workflowMatrixResult(lifecycle, deliveryMode) {
  const result = matrixResult(lifecycle);
  return {
    ...result,
    directCompletionCount: 1,
    fallbackCount: deliveryMode === 'direct' ? 0 : 1,
    deliveryPipeline: deliveryMode === 'direct' ? null : 'helper',
    deliverySentCount: deliveryMode === 'direct' ? 0 : 1,
    deliveryFailedCount: 0,
  };
}

function delayedMcpEvidence(expectedMode) {
  const background = expectedMode === 'background';
  return {
    expectedMode,
    thresholdMs: 1_000,
    handlerDurationMs: background ? 5_003 : 5_001,
    toolUseCount: 1,
    markerCount: 1,
    resultSubtype: 'success',
    toolResultBeforeHandlerCompletion: background,
    nativeLifecycleProof: {
      schemaVersion: 1,
      expectedMode,
      counts: {
        targetToolUse: 1,
        targetToolResult: 1,
        nonEmptyMembership: background ? 1 : 0,
        emptyMembership: background ? 1 : 0,
        taskStarted: background ? 1 : 0,
        taskCompleted: background ? 1 : 0,
        taskNotification: background ? 1 : 0,
        marker: 1,
      },
      ordinals: {
        toolUse: 14,
        membershipListed: background ? 15 : null,
        taskStarted: background ? 16 : null,
        toolResult: background ? 17 : 15,
        membershipCleared: background ? 23 : null,
        taskCompleted: background ? 24 : null,
        taskNotification: background ? 25 : null,
        marker: background ? 27 : 16,
      },
      membership: {
        listedTaskCount: background ? 1 : null,
        clearedTaskCount: background ? 0 : null,
      },
      correlations: {
        listedTaskIsTargetMcp: background ? true : null,
        startedTaskIsTargetMcp: background ? true : null,
        listedTaskMatchesStarted: background ? true : null,
        startedToolUseMatchesTarget: background ? true : null,
        toolResultMatchesTarget: true,
        completedTaskMatchesStarted: background ? true : null,
        notificationTaskMatchesStarted: background ? true : null,
        notificationToolUseMatchesTarget: background ? true : null,
      },
      statuses: {
        asyncPlaceholder: background,
        taskCompleted: background,
        notificationCompleted: background,
      },
      timing: {
        asyncResultDelayMs: background ? 1_002 : null,
        asyncResultLeadMs: background ? 4_001 : null,
      },
    },
  };
}

function delayedMcpMatrixResult(expectedMode) {
  return {
    resolvedModel: 'claude-sonnet-4-6',
    lifecycle: expectedMode === 'background'
      ? [
          system('background_tasks_changed'),
          system('task_started'),
          system('task_updated'),
          system('task_notification'),
          { type: 'result', subtype: 'success' },
        ]
      : [{ type: 'result', subtype: 'success' }],
    markerCount: 1,
    resultSubtype: 'success',
    evidence: delayedMcpEvidence(expectedMode),
  };
}

function completeDelayedMcpResult(expectedMode = 'foreground') {
  const fragment = delayedMcpMatrixResult(expectedMode);
  return {
    evidenceSchemaVersion: 1,
    matrixScenario: 'delayed-mcp',
    scenario: 'delayed-mcp',
    status: 'PASS',
    attestation: {
      runId: 'delayed-schema-test',
      version: '2.1.220',
      sha256: 'a'.repeat(64),
      executablePathHash: 'b'.repeat(64),
      wrapperRequired: false,
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    ...fragment,
    lifecycleSources: {
      sdk: {
        stream: 'sdk',
        file: 'sdk-stream.ndjson',
        sha256: 'c'.repeat(64),
        rawRecordCount: fragment.lifecycle.length,
        normalizedRecordCount: fragment.lifecycle.length,
      },
    },
    lifecycleProofs: [],
    wrapperRecords: [],
    processEvidence: {
      rootPids: [2200],
      selectedBinaryPids: [2200],
      selectedBinaryProcesses: [{ pid: 2200, ppid: 2199 }],
      sampleCount: 1,
      samplingFailed: false,
      samplingFailureCount: 0,
      samplingErrorHash: null,
    },
    markerHash: 'd'.repeat(64),
    reasonCount: 0,
    reasonHashes: [],
  };
}

test('Claude 2.1.283 matrix declares every mandatory old/new gate', () => {
  const oldNewIds = manifest.scenarios
    .filter((scenario) => !scenario.candidateOnly)
    .map((scenario) => scenario.id)
    .sort();

  assert.deepEqual(oldNewIds, [
    'cli-contract',
    'delayed-mcp',
    'delayed-mcp-foreground',
    'sdk-compact',
    'sdk-post-tool-batch',
    'sdk-resume',
    'sdk-subagent',
    'sdk-tool-less-drain',
    'workflow-direct',
    'workflow-fallback',
  ]);
  assert.equal(manifest.versions.old, '2.1.220');
  assert.equal(manifest.versions.candidate, '2.1.283');
  assert.equal(manifest.comparator.model, 'claude-sonnet-4-6');
  assert.equal(manifest.comparator.effort, 'medium');
});

test('matrix holds the Agent SDK constant at the installed exact version', () => {
  // Both sides drive the same SDK and vary only pathToClaudeCodeExecutable,
  // so an SDK bump must be reviewed together with the manifest.
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  let sdkDir = path.dirname(sdkEntry);
  while (!fs.existsSync(path.join(sdkDir, 'package.json'))) {
    sdkDir = path.dirname(sdkDir);
  }
  const sdkPackage = JSON.parse(
    fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8'),
  );
  assert.equal(sdkPackage.name, '@anthropic-ai/claude-agent-sdk');
  assert.equal(manifest.sdkVersion, sdkPackage.version);
});

test('every compared CLI version has reviewed per-version expectations', async () => {
  const {
    expectationsFor,
    gateExpectationsSchemaMatches,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  assert.deepEqual(
    Object.keys(manifest.expectations).sort(),
    [OLD_VERSION, CANDIDATE_VERSION].sort(),
  );
  for (const version of [OLD_VERSION, CANDIDATE_VERSION]) {
    assert.equal(
      gateExpectationsSchemaMatches(manifest.expectations[version]),
      true,
      version,
    );
    assert.deepEqual(
      expectationsFor(manifest.expectations, version),
      manifest.expectations[version],
    );
  }
  // The accepted 2.1.220 candidate behaviour becomes the old baseline.
  assert.deepEqual(
    Object.fromEntries(Object.entries(OLD_EXPECTATIONS).filter(
      ([key]) => key !== 'workflowSizeGuidelineAnchors',
    )),
    {
      wrapperRequired: true,
      // Production never opts into auto-background, so its foreground
      // default is gated; the opt-in path is too flaky on 2.1.220 to gate.
      delayedMcpModes: {
        autoBackground: 'not-gated',
        default: 'foreground',
        waiverReason: OLD_EXPECTATIONS.delayedMcpModes.waiverReason,
      },
      subagentTaskUpdated: 1,
      taskReminderInsertions: 1,
      resolvedOpus: 'claude-opus-5',
      workflowSizeGuideline: 'medium',
      // 2.1.220 writes none of 2.1.283's per-session context attachments.
      passiveSessionAttachmentCounts: Object.fromEntries(
        CONTEXT_ATTACHMENTS_283.map((type) => [type, 0]),
      ),
      opusPassiveSessionAttachmentCounts: {},
      projectedInsertions: {},
    },
  );
  // 2.1.283 changes only the production Opus default and the Workflow
  // size-default code the projection anchors against.
  assert.equal(CANDIDATE_EXPECTATIONS.resolvedOpus, 'claude-opus-5-5');
  for (const key of [
    'wrapperRequired',
    'subagentTaskUpdated',
    'taskReminderInsertions',
    'workflowSizeGuideline',
  ]) {
    assert.deepEqual(CANDIDATE_EXPECTATIONS[key], OLD_EXPECTATIONS[key], key);
  }
  // The production delayed-MCP path keeps the old declaration; the opt-in
  // path is a deterministic upstream regression on 2.1.283.
  assert.equal(
    CANDIDATE_EXPECTATIONS.delayedMcpModes.default,
    OLD_EXPECTATIONS.delayedMcpModes.default,
  );
  assert.equal(
    CANDIDATE_EXPECTATIONS.delayedMcpModes.autoBackground,
    'known-regression',
  );
  assert.match(
    CANDIDATE_EXPECTATIONS.delayedMcpModes.waiverReason,
    /CLAUDE_AUTO_BACKGROUND_TASKS/,
  );
  assert.match(
    OLD_EXPECTATIONS.delayedMcpModes.waiverReason,
    /unused in production/,
  );
  assert.notDeepEqual(
    CANDIDATE_EXPECTATIONS.workflowSizeGuidelineAnchors,
    OLD_EXPECTATIONS.workflowSizeGuidelineAnchors,
  );

  // An undeclared or malformed version has no accepted behaviour.
  assert.throws(
    () => expectationsFor(manifest.expectations, '2.1.173'),
    /no gate expectations are declared for Claude Code 2\.1\.173/,
  );
  assert.throws(
    () => expectationsFor(manifest.expectations, '__proto__'),
    /no gate expectations are declared/,
  );
  assert.throws(
    () => expectationsFor(undefined, CANDIDATE_VERSION),
    /no gate expectations are declared/,
  );
  assert.throws(
    () => expectationsFor({
      [CANDIDATE_VERSION]: {
        ...CANDIDATE_EXPECTATIONS,
        delayedMcpModes: { autoBackground: 'maybe', default: 'foreground' },
      },
    }, CANDIDATE_VERSION),
    /malformed/,
  );
});

test('drivers read expectations only from the manifest bytes the runner scheduled', async () => {
  const { readGateExpectations } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const manifestSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(manifestPath, 'utf8'))
    .digest('hex');
  assert.deepEqual(
    readGateExpectations(CANDIDATE_VERSION, {
      expectedManifestSha256: manifestSha256,
    }),
    CANDIDATE_EXPECTATIONS,
  );
  assert.throws(() => readGateExpectations(CANDIDATE_VERSION, {
    expectedManifestSha256: 'f'.repeat(64),
  }), /manifest changed/);
  assert.throws(
    () => readGateExpectations('2.1.173', { expectedManifestSha256: manifestSha256 }),
    /no gate expectations are declared/,
  );
});

test('matrix runs refuse a manifest version without declared expectations', async () => {
  const { buildClaudeMatrixRuns } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  for (const versionKey of ['old', 'candidate']) {
    const invalidManifest = structuredClone(manifest);
    delete invalidManifest.expectations[manifest.versions[versionKey]];
    assert.throws(() => buildClaudeMatrixRuns({
      manifest: invalidManifest,
      binaries: {
        old: '/private/bin/claude-old',
        candidate: '/private/bin/claude-candidate',
      },
      artifactBaseDir: '/private/artifacts',
      runPrefix: 'matrix-missing-expectations',
    }), /no gate expectations are declared/);
  }
});

test('sanitized delayed-MCP schema rejects arbitrary nested payloads', async () => {
  const { sanitizedGateResultSchemaMatches } = await import(
    '../scripts/spikes/claude-gate-evidence.mjs'
  );
  const valid = completeDelayedMcpResult();
  assert.equal(
    sanitizedGateResultSchemaMatches(valid, 'delayed-mcp'),
    true,
  );
  for (const invalid of [
    {
      ...valid,
      evidence: { ...valid.evidence, privateDiagnostic: 'raw' },
    },
    {
      ...valid,
      lifecycleSources: {
        sdk: { ...valid.lifecycleSources.sdk, payload: 'raw' },
      },
    },
    {
      ...valid,
      lifecycleProofs: [{ payload: 'raw' }],
    },
    {
      ...valid,
      evidence: {
        ...valid.evidence,
        resultSubtype: 'PRIVATE-NESTED-SCALAR',
      },
    },
    {
      ...valid,
      evidence: {
        ...valid.evidence,
        resultSubtype: 'error_during_execution',
      },
    },
  ]) {
    assert.equal(
      sanitizedGateResultSchemaMatches(invalid, 'delayed-mcp'),
      false,
    );
  }
});

test('every matrix cell has a real driver, oracle, cost, and artifact collector', () => {
  for (const scenario of manifest.scenarios) {
    assert.match(scenario.id, /^[a-z0-9-]+$/);
    assert.equal(
      fs.existsSync(path.join(repoRoot, scenario.driver)),
      true,
      `${scenario.id} driver must exist`,
    );
    assert.equal(typeof scenario.cost.usdEstimate, 'number');
    assert.equal(typeof scenario.cost.destructive, 'boolean');
    assert.ok(scenario.artifactCollector);
    assert.ok(scenario.oracle.candidate);
    if (!scenario.candidateOnly) {
      assert.ok(scenario.oracle.old);
      assert.ok(Array.isArray(scenario.comparison?.equalFields));
      assert.ok(scenario.comparison.equalFields.includes('resolvedModel'));
      if (scenario.id === 'cli-contract') {
        assert.equal(scenario.comparison.runsPerVersion, 2);
        assert.equal(scenario.comparison.sameVersion, 'required');
        assert.equal(scenario.comparison.crossVersion, 'all-pairs');
        assert.equal(
          scenario.comparison.lifecycle.mode,
          'projected-compatible',
        );
        assert.equal(
          scenario.comparison.lifecycle.streams.session.projection,
          'session-pivotal-v1',
        );
        assert.deepEqual(
          scenario.comparison.lifecycle.streams.hooks.selectors,
          [
            { hookEventName: 'UserPromptSubmit' },
            { hookEventName: 'Stop' },
            { hookEventName: 'PreToolUse', toolName: REPLY_TOOL },
            { hookEventName: 'PostToolUse', toolName: REPLY_TOOL },
          ],
        );
        assert.deepEqual(
          scenario.comparison.lifecycle.versionedInsertions,
          [{
            stream: 'session',
            record: attachment('task_reminder'),
            expectedCountKey: 'taskReminderInsertions',
            proof: {
              type: 'session-event-aggregator-removal',
              eligibility: 'task-reminder-v1',
            },
          }],
        );
        assert.deepEqual(
          scenario.comparison.lifecycle.optionalInsertions,
          [{
            stream: 'session',
            record: attachment('hook_cancelled'),
            maxCount: 1,
            proof: {
              type: 'session-event-aggregator-removal',
              eligibility: 'interrupt-user-prompt-submit-v1',
            },
          }],
        );
        assert.deepEqual(
          scenario.comparison.lifecycle.projectedBaseline,
          {
            session: CLI_SESSION_PROJECTION,
            hooks: CLI_TRANSPORT_HOOKS,
          },
        );
      } else if (
        scenario.id === 'workflow-direct'
        || scenario.id === 'workflow-fallback'
      ) {
        assert.equal(
          scenario.comparison.lifecycle.mode,
          'projected-compatible',
        );
        assert.equal(
          scenario.comparison.lifecycle.streams.session.projection,
          'session-pivotal-v1',
        );
        assert.deepEqual(
          scenario.comparison.lifecycle.streams.hooks.selectors,
          [
            { hookEventName: 'UserPromptSubmit' },
            { hookEventName: 'Stop' },
            { hookEventName: 'PreToolUse', toolName: 'Workflow' },
            { hookEventName: 'PostToolUse', toolName: 'Workflow' },
            {
              hookEventName: 'PreToolUse',
              toolName: WORKFLOW_REPLY_TOOL,
            },
            {
              hookEventName: 'PostToolUse',
              toolName: WORKFLOW_REPLY_TOOL,
            },
          ],
        );
        assert.deepEqual(
          scenario.comparison.lifecycle.versionedInsertions,
          [],
        );
        assert.deepEqual(
          scenario.comparison.lifecycle.optionalInsertions,
          [],
        );
        assert.deepEqual(
          scenario.comparison.lifecycle.projectedBaseline,
          {
            session: WORKFLOW_SESSION_PROJECTION,
            hooks: scenario.id === 'workflow-direct'
              ? WORKFLOW_DIRECT_HOOKS
              : WORKFLOW_FALLBACK_HOOKS,
          },
        );
      } else if (
        scenario.id === 'delayed-mcp'
        || scenario.id === 'delayed-mcp-foreground'
      ) {
        assert.deepEqual(scenario.comparison.lifecycle, {
          mode: 'version-specific-oracle',
          oracle: 'delayed-mcp-v1',
        });
      } else if (scenario.id === 'sdk-subagent') {
        assert.deepEqual(scenario.comparison.lifecycle, {
          mode: 'version-specific-oracle',
          oracle: 'sdk-subagent-v1',
        });
      } else {
        assert.equal(scenario.comparison.runsPerVersion, undefined);
        assert.equal(
          scenario.comparison.lifecycle,
          'sdk-semantic-shape-v1',
        );
      }
    }
  }
});

test('delayed MCP gates the production default path and the opt-in path with per-version modes', async () => {
  const {
    buildClaudeMatrixRuns,
    matrixWaivedCells,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const optIn = manifest.scenarios.find(({ id }) => id === 'delayed-mcp');
  const productionPath = manifest.scenarios.find(
    ({ id }) => id === 'delayed-mcp-foreground',
  );

  for (const scenario of [optIn, productionPath]) {
    assert.equal(
      scenario.environment.common.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS,
      '1000',
    );
    // The mode is derived from the attested version, never duplicated here.
    assert.deepEqual(scenario.args, { old: [], candidate: [] });
    for (const versionKey of ['old', 'candidate']) {
      assert.equal(scenario.environment[versionKey], undefined);
    }
  }
  // Production never sets the opt-in, so one cell must run without it.
  assert.equal(optIn.environment.common.CLAUDE_AUTO_BACKGROUND_TASKS, '1');
  assert.equal(
    Object.hasOwn(productionPath.environment.common, 'CLAUDE_AUTO_BACKGROUND_TASKS'),
    false,
  );

  const runs = buildClaudeMatrixRuns({
    manifest,
    binaries: {
      old: '/private/bin/claude-old',
      candidate: '/private/bin/claude-candidate',
    },
    artifactBaseDir: '/private/artifacts',
    runPrefix: 'delayed-modes',
  });
  for (const versionKey of ['old', 'candidate']) {
    const modes = manifest.expectations[manifest.versions[versionKey]]
      .delayedMcpModes;
    const defaultRun = runs.find(
      (run) => run.id === `${versionKey}:delayed-mcp-foreground`,
    );
    assert.deepEqual(defaultRun.args, ['--expected-mode', modes.default]);
    assert.equal(defaultRun.delayedMcpAutoBackground, false);
  }
  // Both versions waive the opt-in path: neither run is scheduled, and the
  // summary reports each waiver instead of silently dropping the cell.
  assert.equal(runs.some((run) => run.scenarioId === 'delayed-mcp'), false);
  assert.deepEqual(matrixWaivedCells(manifest), [
    {
      id: 'old:delayed-mcp',
      version: OLD_VERSION,
      waiver: 'not-gated',
      reason: OLD_EXPECTATIONS.delayedMcpModes.waiverReason,
    },
    {
      id: 'candidate:delayed-mcp',
      version: CANDIDATE_VERSION,
      waiver: 'known-regression',
      reason: CANDIDATE_EXPECTATIONS.delayedMcpModes.waiverReason,
    },
  ]);

  // The default path is what production runs, so it can never be waived.
  for (const delayedMcpModes of [
    {
      autoBackground: 'background',
      default: 'known-regression',
      waiverReason: 'waived',
    },
    {
      autoBackground: 'background',
      default: 'not-gated',
      waiverReason: 'waived',
    },
    { autoBackground: 'known-regression', default: 'foreground' },
    { autoBackground: 'not-gated', default: 'foreground' },
    {
      autoBackground: 'not-gated',
      default: 'foreground',
      waiverReason: ' ',
    },
    {
      autoBackground: 'background',
      default: 'foreground',
      waiverReason: 'stray reason',
    },
    {
      autoBackground: 'skipped',
      default: 'foreground',
      waiverReason: 'unknown waiver',
    },
  ]) {
    const waived = structuredClone(manifest);
    waived.expectations[OLD_VERSION].delayedMcpModes = delayedMcpModes;
    assert.throws(() => buildClaudeMatrixRuns({
      manifest: waived,
      binaries: {
        old: '/private/bin/claude-old',
        candidate: '/private/bin/claude-candidate',
      },
      artifactBaseDir: '/private/artifacts',
      runPrefix: 'delayed-waived',
    }), /malformed/, JSON.stringify(delayedMcpModes));
  }

  for (const mutate of [
    (invalid) => {
      invalid.scenarios.find(({ id }) => id === 'delayed-mcp')
        .args.old = ['--expected-mode', 'background'];
    },
    (invalid) => {
      invalid.scenarios.find(({ id }) => id === 'delayed-mcp-foreground')
        .environment.candidate = { CLAUDE_AUTO_BACKGROUND_TASKS: '1' };
    },
  ]) {
    const invalid = structuredClone(manifest);
    mutate(invalid);
    assert.throws(() => buildClaudeMatrixRuns({
      manifest: invalid,
      binaries: {
        old: '/private/bin/claude-old',
        candidate: '/private/bin/claude-candidate',
      },
      artifactBaseDir: '/private/artifacts',
      runPrefix: 'delayed-modes-invalid',
    }), /expected mode comes from the version expectations|for both versions/);
  }
});

test('SDK compact gate uses one ordered manual same-session boundary', () => {
  const scenario = manifest.scenarios.find(({ id }) => id === 'sdk-compact');
  const driver = fs.readFileSync(path.join(repoRoot, scenario.driver), 'utf8');

  assert.deepEqual(scenario.environment.common, {});
  assert.match(scenario.oracle.old, /manual PreCompact.*compact boundary.*recall/i);
  assert.match(scenario.oracle.candidate, /same/i);
  assert.doesNotMatch(driver, /async function\* makeInput/);
  assert.doesNotMatch(driver, /prompt: makeInput\(\)/);
  assert.match(driver, /async function runTurn/);
  assert.match(driver, /resume: resumeId/);
  assert.match(driver, /const COMPACT_MINIMUM_EXCHANGES = 5/);
  assert.match(driver, /for \(const prompt of primingPrompts\)/);
  assert.match(driver, /PreCompact/);
  assert.match(driver, /evaluateManualCompactEvidence/);
});

test('candidate-only production projection proves the declared Opus resolution', () => {
  const scenario = manifest.scenarios.find(
    ({ id }) => id === 'candidate-opus-projection',
  );

  assert.equal(scenario.candidateOnly, true);
  assert.equal(scenario.environment.candidate.CLAUDE_GATE_MODEL, 'opus');
  // Expected values come only from the attested version's expectations.
  assert.equal(Object.hasOwn(scenario, 'expectedResolvedModel'), false);
  assert.equal(Object.hasOwn(scenario, 'documentedWorkflowSizeGuideline'), false);
  assert.match(scenario.artifactCollector, /private SDK stream/);
  assert.match(scenario.artifactCollector, /nested Workflow session/);
});

test('matrix parent rejects shared Workflow delivery failures and false Opus PASS claims', async () => {
  const { matrixScenarioOracleMatches } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const originRouteHash = crypto.createHash('sha256')
    .update('-999000220:220')
    .digest('hex');
  const workflow = {
    status: 'PASS',
    workflowPolicyOverridePresent: false,
    launchTurnClosedBeforeCompletion: true,
    outOfTurnTiming: {
      pass: true,
      reasonCount: 0,
      requiredTaskNotificationDelayMs: 2_500,
      requiredCompletionAfterNotificationMs: 100,
      taskNotificationAfterStopMs: 3_000,
      completionAfterLaunchTurnMs: 3_500,
      completionAfterTaskNotificationMs: 500,
    },
    launchDeliveryCount: 1,
    launchDeliveryReasonCount: 0,
    launchDeliveryProof: {
      launchDeliveryCount: 1,
      exactlyOneCall: true,
      replyToolMatched: true,
      originRouteMatched: true,
      exactTextMatched: true,
      deliverySucceeded: true,
      nonInterim: true,
      zeroFiles: true,
    },
    completionTurnProof: {
      toolUseMatched: true,
      toolResultEventMatched: true,
      stopAfterToolUse: true,
      transcriptToolUseCount: 1,
      transcriptToolResultCount: 1,
      receiptOk: true,
      receiptIsError: false,
      terminalAdvanced: true,
      turnDurationCount: 2,
    },
    directCompletionCount: 1,
    fallbackCount: 0,
    deliveryPipeline: null,
    deliverySentCount: 0,
    deliveryFailedCount: 0,
    deliveryReasonCount: 0,
    directRouteCounts: {
      [originRouteHash]: 2,
    },
    fallbackRouteCounts: {},
    workflowMetadata: [{
      status: 'completed',
      agentCount: 2,
      reportComplete: true,
      reportMatchesExpected: true,
    }],
  };
  assert.equal(
    matrixScenarioOracleMatches('workflow-direct', workflow).pass,
    true,
  );
  for (const mutate of [
    (result) => {
      result.outOfTurnTiming.pass = false;
      result.outOfTurnTiming.reasonCount = 1;
    },
    (result) => {
      result.launchDeliveryProof.deliverySucceeded = false;
    },
    (result) => {
      result.directCompletionCount = 0;
    },
    (result) => {
      result.directRouteCounts['b'.repeat(64)] = 1;
    },
    (result) => {
      result.directRouteCounts = { ['f'.repeat(64)]: 2 };
    },
  ]) {
    const invalid = structuredClone(workflow);
    mutate(invalid);
    assert.equal(
      matrixScenarioOracleMatches('workflow-direct', invalid).pass,
      false,
    );
  }
  const fallback = structuredClone(workflow);
  fallback.completionTurnProof.toolResultEventMatched = false;
  fallback.completionTurnProof.receiptOk = false;
  fallback.completionTurnProof.receiptIsError = true;
  fallback.fallbackCount = 1;
  fallback.deliveryPipeline = 'helper';
  fallback.deliverySentCount = 1;
  fallback.fallbackRouteCounts = {
    [originRouteHash]: 1,
  };
  assert.equal(
    matrixScenarioOracleMatches('workflow-fallback', fallback).pass,
    true,
  );
  fallback.fallbackRouteCounts = {
    ['b'.repeat(64)]: 1,
  };
  assert.equal(
    matrixScenarioOracleMatches('workflow-fallback', fallback).pass,
    false,
  );

  const opus = {
    status: 'PASS',
    resolvedModel: 'claude-opus-5-5',
    expectedResolvedModel: 'claude-opus-5-5',
    documentedWorkflowSizeGuideline: 'medium',
    workflowPolicyOverridePresent: false,
    workflowSizeGuidelineEvidence: {
      source: 'selected-binary-runtime-default',
      value: 'medium',
      executableSha256: 'a'.repeat(64),
      fingerprintMatched: true,
    },
    attestation: { sha256: 'a'.repeat(64) },
    workflowStatus: 'PASS',
    workflowMetadata: [{
      status: 'completed',
      agentCount: 2,
      reportComplete: true,
      reportMatchesExpected: true,
    }],
    resultSubtype: 'success',
    markerCount: 1,
    reasonCount: 0,
    reasonHashes: [],
  };
  assert.equal(
    matrixScenarioOracleMatches(
      'candidate-opus-projection',
      opus,
      CANDIDATE_EXPECTATIONS,
    ).pass,
    true,
  );
  for (const mutation of [
    { workflowStatus: 'FAIL' },
    { workflowPolicyOverridePresent: true },
    { workflowMetadata: [] },
    { markerCount: 0 },
    { reasonCount: 1, reasonHashes: ['b'.repeat(64)] },
    // A self-consistent claim for the previous Opus default is still wrong
    // for a candidate whose declared `opus` resolution moved on.
    { resolvedModel: 'claude-opus-5', expectedResolvedModel: 'claude-opus-5' },
    { documentedWorkflowSizeGuideline: 'small' },
  ]) {
    assert.equal(matrixScenarioOracleMatches(
      'candidate-opus-projection',
      { ...opus, ...mutation },
      CANDIDATE_EXPECTATIONS,
    ).pass, false);
  }
  assert.equal(
    matrixScenarioOracleMatches('candidate-opus-projection', opus).pass,
    false,
    'an Opus claim without declared expectations must not pass',
  );
});

test('matrix parent binds the Opus projection to nested Workflow source evidence', async (t) => {
  const { nestedOpusWorkflowEvidenceMatches } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const runDir = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'polygram-opus-nested-source-',
  ));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const privateArtifactDir = path.join(runDir, 'raw-private');
  fs.mkdirSync(privateArtifactDir, { mode: 0o700 });

  assert.equal(nestedOpusWorkflowEvidenceMatches({
    run: {
      scenarioId: 'candidate-opus-projection',
      versionKey: 'candidate',
      version: '2.1.283',
      model: 'opus',
      effort: 'medium',
      expectedResolvedModel: 'claude-opus-5-5',
      expectations: CANDIDATE_EXPECTATIONS,
      env: {
        CLAUDE_GATE_BIN: '/private/claude-2.1.283',
      },
    },
    result: {
      workflowStatus: 'PASS',
      workflowPolicyOverridePresent: false,
      workflowMetadata: [{ status: 'completed' }],
    },
    privateArtifactDir,
  }), false, 'an outer PASS cannot substitute for missing nested evidence');
});

test('nested Opus Workflow evidence must match the checked Workflow lifecycle baseline', async () => {
  const {
    buildClaudeMatrixRuns,
    evaluateMatrixVersionEvidence,
    nestedWorkflowLifecycleMatches,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const workflowScenario = manifest.scenarios.find(
    ({ id }) => id === 'workflow-direct',
  );
  const runs = buildClaudeMatrixRuns({
    manifest,
    binaries: {
      old: '/private/bin/claude-2.1.220',
      candidate: '/private/bin/claude-2.1.283',
    },
    artifactBaseDir: '/private/artifacts',
    runPrefix: 'nested-workflow-policy',
  });
  const opusRun = runs.find(
    ({ scenarioId }) => scenarioId === 'candidate-opus-projection',
  );
  assert.deepEqual(
    opusRun.nestedWorkflowLifecyclePolicy,
    workflowScenario.comparison.lifecycle,
  );

  const nestedResultFor = (lifecycle) => ({
    lifecycle,
    lifecycleSources: {
      session: {
        file: 'session.jsonl',
        stream: 'session',
        sha256: 'a'.repeat(64),
        rawRecordCount: lifecycle.session.length,
        normalizedRecordCount: lifecycle.session.length,
      },
    },
    lifecycleProofs: [],
  });
  const baseline = structuredClone(
    workflowScenario.comparison.lifecycle.projectedBaseline,
  );
  // The nested Workflow runs on the candidate, so it is held to the
  // candidate's declared session rows; the old-shaped transcript is not.
  assert.equal(nestedWorkflowLifecycleMatches({
    result: nestedResultFor(baseline),
    policy: opusRun.nestedWorkflowLifecyclePolicy,
    expectations: opusRun.expectations,
  }), false);
  const sonnetShaped = with283SessionRows(
    baseline,
    { recordAfter: 'skill_listing' },
  );
  // On Opus the real nested Workflow also carries the bypass-mode auto_mode
  // steer before command_permissions; the Sonnet cells never do.
  assert.equal(nestedWorkflowLifecycleMatches({
    result: nestedResultFor(sonnetShaped),
    policy: opusRun.nestedWorkflowLifecyclePolicy,
    expectations: opusRun.expectations,
  }), false);
  const opusShaped = structuredClone(sonnetShaped);
  opusShaped.session.splice(
    opusShaped.session.findIndex(
      (record) => record.attachmentType === 'command_permissions',
    ),
    0,
    attachment('auto_mode'),
  );
  const nestedResult = nestedResultFor(opusShaped);
  assert.equal(nestedWorkflowLifecycleMatches({
    result: nestedResult,
    policy: opusRun.nestedWorkflowLifecyclePolicy,
    expectations: opusRun.expectations,
  }), true);
  const twoSteers = structuredClone(opusShaped);
  twoSteers.session.push(attachment('auto_mode'));
  assert.equal(nestedWorkflowLifecycleMatches({
    result: nestedResultFor(twoSteers),
    policy: opusRun.nestedWorkflowLifecyclePolicy,
    expectations: opusRun.expectations,
  }), false);
  // The Opus-only allowance never applies to the Sonnet Workflow cells.
  assert.equal(evaluateMatrixVersionEvidence({
    scenario: workflowScenario,
    versionKey: 'candidate',
    expectations: opusRun.expectations,
    results: [workflowMatrixResult(opusShaped, 'direct')],
  }).pass, false);
  nestedResult.lifecycle.session.pop();
  assert.equal(nestedWorkflowLifecycleMatches({
    result: nestedResult,
    policy: opusRun.nestedWorkflowLifecyclePolicy,
    expectations: opusRun.expectations,
  }), false);
});

test('matrix runner schedules every old gate before candidate gates with exact selectors', async () => {
  const { buildClaudeMatrixRuns } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const runs = buildClaudeMatrixRuns({
    manifest,
    binaries: {
      old: '/private/bin/claude-2.1.220',
      candidate: '/private/bin/claude-2.1.283',
    },
    artifactBaseDir: '/private/artifacts',
    runPrefix: 'matrix-test',
  });

  // 24 cells minus the two waived opt-in delayed-MCP cells.
  assert.equal(runs.length, 22);
  assert.ok(runs.slice(0, 10).every((run) => run.versionKey === 'old'));
  assert.ok(runs.slice(10).every((run) => run.versionKey === 'candidate'));
  // Each cell carries the expectations of the version its binary must attest.
  for (const run of runs) {
    assert.deepEqual(
      run.expectations,
      manifest.expectations[manifest.versions[run.versionKey]],
      run.id,
    );
  }
  assert.deepEqual(
    runs.filter((run) => run.scenarioId === 'cli-contract').map((run) => ({
      id: run.id,
      repeatIndex: run.repeatIndex,
      repeatCount: run.repeatCount,
      runId: run.env.CLAUDE_GATE_RUN_ID,
    })),
    [
      {
        id: 'old:cli-contract:1',
        repeatIndex: 1,
        repeatCount: 2,
        runId: 'matrix-test-old-cli-contract-1',
      },
      {
        id: 'old:cli-contract:2',
        repeatIndex: 2,
        repeatCount: 2,
        runId: 'matrix-test-old-cli-contract-2',
      },
      {
        id: 'candidate:cli-contract:1',
        repeatIndex: 1,
        repeatCount: 2,
        runId: 'matrix-test-candidate-cli-contract-1',
      },
      {
        id: 'candidate:cli-contract:2',
        repeatIndex: 2,
        repeatCount: 2,
        runId: 'matrix-test-candidate-cli-contract-2',
      },
    ],
  );
  assert.ok(
    runs
      .filter((run) => run.scenarioId !== 'cli-contract')
      .every((run) => run.repeatIndex === 1 && run.repeatCount === 1),
  );
  assert.equal(
    runs.find((run) => run.id === 'old:delayed-mcp-foreground').env.CLAUDE_GATE_BIN,
    '/private/bin/claude-2.1.220',
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:delayed-mcp-foreground')
      .env.CLAUDE_GATE_EXPECTED_VERSION,
    '2.1.283',
  );
  // With the opt-in path waived on both versions, no scheduled cell opts in.
  assert.equal(
    runs.some((run) => Object.hasOwn(run.env, 'CLAUDE_AUTO_BACKGROUND_TASKS')),
    false,
  );
  assert.ok(
    runs
      .filter((run) => run.scenarioId === 'delayed-mcp')
      .every((run) => run.versionSpecificLifecycleOracle === 'delayed-mcp-v1'),
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:candidate-opus-projection')
      .env.CLAUDE_GATE_MODEL,
    'opus',
  );
  assert.equal(
    runs.some((run) => run.id === 'old:candidate-opus-projection'),
    false,
  );
  assert.equal(
    new Set(runs.map((run) => run.env.CLAUDE_GATE_RUN_ID)).size,
    runs.length,
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:candidate-opus-projection')
      .env.CLAUDE_GATE_DOCUMENTED_WORKFLOW_SIZE_GUIDELINE,
    'medium',
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:candidate-opus-projection')
      .expectedResolvedModel,
    'claude-opus-5-5',
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:candidate-opus-projection')
      .env.CLAUDE_GATE_EXPECTED_RESOLVED_MODEL,
    'claude-opus-5-5',
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:candidate-system-prompt-snapshot')
      .model,
    manifest.comparator.model,
  );
  assert.equal(
    runs.some((run) => run.id === 'old:candidate-system-prompt-snapshot'),
    false,
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:workflow-direct')
      .env.CLAUDE_GATE_SCENARIO_ID,
    'workflow-direct',
  );
  assert.ok(
    runs
      .filter((run) => run.scenarioId === 'cli-contract')
      .every((run) => run.maxBridgeReadyToMcpReadyMs === 20_000),
  );

  const invalidManifest = structuredClone(manifest);
  invalidManifest.scenarios.find(
    ({ id }) => id === 'cli-contract',
  ).comparison.crossVersion = 'first-only';
  assert.throws(() => buildClaudeMatrixRuns({
    manifest: invalidManifest,
    binaries: {
      old: '/private/bin/claude-2.1.220',
      candidate: '/private/bin/claude-2.1.283',
    },
    artifactBaseDir: '/private/artifacts',
    runPrefix: 'matrix-invalid',
  }), /crossVersion comparison is not recognized/);
});

test('matrix child environments clear ambient SDK auto-background before the declared opt-in', async () => {
  const {
    buildClaudeMatrixChildEnv,
    buildClaudeMatrixRuns,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const runs = buildClaudeMatrixRuns({
    manifest,
    binaries: {
      old: '/private/bin/claude-2.1.220',
      candidate: '/private/bin/claude-2.1.283',
    },
    artifactBaseDir: '/private/artifacts',
    runPrefix: 'matrix-env',
  });
  const ambient = {
    CLAUDE_AUTO_BACKGROUND_TASKS: 'ambient-leak',
    PRESERVE_ME: 'yes',
  };
  // Cells that do not declare the opt-in must not inherit it from the shell.
  for (const versionKey of ['old', 'candidate']) {
    const undeclaredEnv = buildClaudeMatrixChildEnv(
      ambient,
      runs.find((run) => run.id === `${versionKey}:sdk-resume`).env,
    );
    assert.equal(
      Object.hasOwn(undeclaredEnv, 'CLAUDE_AUTO_BACKGROUND_TASKS'),
      false,
    );
    assert.equal(undeclaredEnv.PRESERVE_ME, 'yes');

  }
  const declaredEnv = buildClaudeMatrixChildEnv(ambient, {
    ...runs.find((run) => run.id === 'old:delayed-mcp-foreground').env,
    CLAUDE_AUTO_BACKGROUND_TASKS: '1',
  });
  assert.equal(declaredEnv.CLAUDE_AUTO_BACKGROUND_TASKS, '1');
  assert.equal(declaredEnv.PRESERVE_ME, 'yes');
});

test('matrix scenarios cannot replace runner-owned gate selectors', async () => {
  const { buildClaudeMatrixRuns } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );

  for (const protectedKey of [
    'CLAUDE_GATE_BIN',
    'CLAUDE_GATE_EXPECTED_VERSION',
    'CLAUDE_GATE_ARTIFACT_BASE',
    'CLAUDE_GATE_RUN_ID',
    'CLAUDE_GATE_EFFORT',
    'CLAUDE_GATE_SCENARIO_ID',
    'CLAUDE_GATE_EXPECTED_RESOLVED_MODEL',
    'CLAUDE_GATE_DOCUMENTED_WORKFLOW_SIZE_GUIDELINE',
  ]) {
    const invalidManifest = structuredClone(manifest);
    invalidManifest.scenarios[0].environment.common[protectedKey] = 'override';
    assert.throws(() => buildClaudeMatrixRuns({
      manifest: invalidManifest,
      binaries: {
        old: '/private/bin/claude-2.1.220',
        candidate: '/private/bin/claude-2.1.283',
      },
      artifactBaseDir: '/private/artifacts',
      runPrefix: 'matrix-protected-env',
    }), new RegExp(`${protectedKey}.*runner-owned`));
  }
});

test('declared SDK compatibility deltas use strict version-specific lifecycle oracles', async () => {
  const {
    evaluateMatrixEvidencePair,
    evaluateMatrixRunResult,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const scenario = manifest.scenarios.find(({ id }) => id === 'delayed-mcp');
  const oldResult = delayedMcpMatrixResult('background');
  const candidateResult = delayedMcpMatrixResult('background');
  const foregroundResult = delayedMcpMatrixResult('foreground');
  // A version that keeps the delayed handler in the foreground, as releases
  // before native MCP auto-background did.
  const foregroundExpectations = {
    ...OLD_EXPECTATIONS,
    delayedMcpModes: { autoBackground: 'foreground', default: 'foreground' },
  };
  // Both pinned versions waive the opt-in path, so the oracle is exercised
  // with a version that declares it as native background.
  const backgroundExpectations = {
    ...OLD_EXPECTATIONS,
    delayedMcpModes: { autoBackground: 'background', default: 'foreground' },
  };
  const BACKGROUND_OPT_IN = {
    oldExpectations: backgroundExpectations,
    candidateExpectations: backgroundExpectations,
  };

  assert.equal(evaluateMatrixEvidencePair({
    ...BACKGROUND_OPT_IN,
    scenario,
    oldResult,
    candidateResult,
  }).pass, true);
  assert.equal(evaluateMatrixEvidencePair({
    scenario,
    oldResult: foregroundResult,
    candidateResult,
    oldExpectations: foregroundExpectations,
    candidateExpectations: backgroundExpectations,
  }).pass, true);
  // A waived path accepts no evidence at all.
  assert.deepEqual(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult,
    candidateResult,
  }).differences, ['lifecycle']);
  // The old binary is judged by its own declaration: a foreground run from a
  // version declared as backgrounding is a regression, not an old baseline.
  assert.deepEqual(evaluateMatrixEvidencePair({
    ...BACKGROUND_OPT_IN,
    scenario,
    oldResult: foregroundResult,
    candidateResult,
  }).differences, ['lifecycle']);
  assert.deepEqual(evaluateMatrixEvidencePair({
    scenario,
    oldResult,
    candidateResult,
  }).differences, ['lifecycle']);
  const delayedRun = {
    scenarioId: 'delayed-mcp',
    versionKey: 'old',
    version: OLD_VERSION,
    expectations: backgroundExpectations,
    delayedMcpAutoBackground: true,
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    versionSpecificLifecycleOracle: 'delayed-mcp-v1',
  };
  const delayedRunResult = {
    ...candidateResult,
    evidenceSchemaVersion: 1,
    matrixScenario: 'delayed-mcp',
    status: 'PASS',
    attestation: {
      version: OLD_VERSION,
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
  };
  assert.equal(evaluateMatrixRunResult({
    run: delayedRun,
    result: delayedRunResult,
  }).pass, true);
  assert.equal(evaluateMatrixRunResult({
    run: { ...delayedRun, expectations: undefined },
    result: delayedRunResult,
  }).pass, false);
  // Without the opt-in the same version is declared foreground, so a
  // background run on the production path is a behaviour change.
  assert.equal(evaluateMatrixRunResult({
    run: {
      ...delayedRun,
      scenarioId: 'delayed-mcp-foreground',
      delayedMcpAutoBackground: false,
    },
    result: { ...delayedRunResult, matrixScenario: 'delayed-mcp-foreground' },
  }).pass, false);
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario: manifest.scenarios.find(
      ({ id }) => id === 'delayed-mcp-foreground',
    ),
    oldResult: foregroundResult,
    candidateResult: foregroundResult,
  }).pass, true);
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario: manifest.scenarios.find(
      ({ id }) => id === 'delayed-mcp-foreground',
    ),
    oldResult: foregroundResult,
    candidateResult,
  }).pass, false);

  const mismatched = structuredClone(candidateResult);
  mismatched.evidence.nativeLifecycleProof
    .correlations.notificationTaskMatchesStarted = false;
  assert.equal(evaluateMatrixEvidencePair({
    ...BACKGROUND_OPT_IN,
    scenario,
    oldResult,
    candidateResult: mismatched,
  }).pass, false);

  for (const lifecycle of [null, 'shape-equal', {
    mode: 'version-specific-oracle',
    oracle: 'unknown',
  }]) {
    const invalidScenario = structuredClone(scenario);
    invalidScenario.comparison.lifecycle = lifecycle;
    assert.equal(evaluateMatrixEvidencePair({
      ...BACKGROUND_OPT_IN,
      scenario: invalidScenario,
      oldResult,
      candidateResult,
    }).pass, false);
  }
  assert.deepEqual(
    manifest.scenarios
      .filter(({ comparison }) => (
        comparison?.lifecycle?.mode === 'version-specific-oracle'
      ))
      .map(({ id }) => id),
    ['delayed-mcp', 'delayed-mcp-foreground', 'sdk-subagent'],
  );
});

test('matrix evidence rejects a green exit with missing or mismatched artifacts', async () => {
  const {
    evaluateMatrixRunResult,
    evaluateMatrixEvidencePair,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const run = {
    scenarioId: 'sdk-resume',
    version: '2.1.220',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
  };

  assert.equal(evaluateMatrixRunResult({ run, result: null }).pass, false);
  const validResult = {
    evidenceSchemaVersion: 1,
    matrixScenario: 'sdk-resume',
    status: 'PASS',
    resolvedModel: 'claude-sonnet-4-6',
    attestation: {
      version: '2.1.220',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    lifecycle: [{ type: 'result', subtype: 'success' }],
  };
  assert.equal(evaluateMatrixRunResult({ run, result: validResult }).pass, true);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: { ...validResult, lifecycle: [{ type: 'malformed' }] },
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: { ...validResult, lifecycle: null },
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      evidenceSchemaVersion: 1,
      matrixScenario: 'sdk-resume',
      status: 'PASS',
      resolvedModel: 'claude-opus-5',
      attestation: {
        version: '2.1.220',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
      },
    },
  }).pass, false);

  const scenario = {
    id: 'sdk-resume',
    comparison: {
      equalFields: ['resolvedModel', 'resultSubtype'],
    },
  };
  const oldResult = {
    resolvedModel: 'claude-sonnet-4-6',
    resultSubtype: 'success',
  };
  assert.deepEqual(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult,
    candidateResult: { ...oldResult },
  }), { pass: true, differences: [] });
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult,
    candidateResult: { ...oldResult, resolvedModel: 'claude-opus-5' },
  }).pass, false);
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult: { resolvedModel: 'claude-sonnet-4-6' },
    candidateResult: { resolvedModel: 'claude-sonnet-4-6' },
  }).pass, false);
});

test('matrix parent independently attests the binary and exact common evidence', async (t) => {
  const { evaluateMatrixRunResult } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-parent-attest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = path.join(dir, 'claude-2.1.220');
  fs.writeFileSync(executablePath, 'immutable selected binary', { mode: 0o700 });
  const realExecutable = fs.realpathSync(executablePath);
  const sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(realExecutable))
    .digest('hex');
  const executablePathHash = crypto.createHash('sha256')
    .update(realExecutable)
    .digest('hex');
  const run = {
    scenarioId: 'sdk-resume',
    versionKey: 'old',
    version: OLD_VERSION,
    expectations: OLD_EXPECTATIONS,
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    env: {
      CLAUDE_GATE_BIN: executablePath,
      CLAUDE_GATE_RUN_ID: 'parent-attest-run',
    },
  };
  const result = {
    evidenceSchemaVersion: 1,
    matrixScenario: 'sdk-resume',
    scenario: 'sdk-resume',
    status: 'PASS',
    attestation: {
      runId: 'parent-attest-run',
      version: OLD_VERSION,
      sha256,
      executablePathHash,
      wrapperRequired: true,
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    resolvedModel: 'claude-sonnet-4-6',
    lifecycle: [{ type: 'result', subtype: 'success' }],
    wrapperRecords: [],
    processEvidence: {
      rootPids: [2200],
      selectedBinaryPids: [2200],
      selectedBinaryProcesses: [{ pid: 2200, ppid: 2199 }],
      sampleCount: 1,
      samplingFailed: false,
      samplingFailureCount: 0,
      samplingErrorHash: null,
    },
    firstSessionPresent: true,
    secondSessionPresent: true,
    firstResultSubtype: 'success',
    secondResultSubtype: 'success',
    markerRecalled: true,
    reasonCount: 0,
  };
  const privateArtifactDir = path.join(dir, 'raw-private');
  fs.mkdirSync(privateArtifactDir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(privateArtifactDir, 'sdk-process-evidence.json'),
    `${JSON.stringify(result.processEvidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  const processSnapshotsPath = path.join(
    privateArtifactDir,
    'sdk-process-snapshots.ndjson',
  );
  fs.writeFileSync(
    processSnapshotsPath,
    `${JSON.stringify({
      sampleIndex: 1,
      activeRootPids: [2200],
      processes: [{
        pid: 2200,
        ppid: 2199,
        executable: realExecutable,
      }],
    })}\n`,
    { mode: 0o600 },
  );

  assert.equal(evaluateMatrixRunResult({
    run,
    result,
    privateArtifactDir,
  }).pass, true);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      attestation: {
        ...result.attestation,
        sha256: 'f'.repeat(64),
      },
    },
    privateArtifactDir,
  }).pass, false);
  // The declared wrapper requirement is per version, not per matrix side: an
  // old binary that skipped wrapper provenance fails like a candidate would.
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      attestation: {
        ...result.attestation,
        wrapperRequired: false,
      },
    },
    privateArtifactDir,
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run: { ...run, expectations: undefined },
    result,
    privateArtifactDir,
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      processEvidence: {
        ...result.processEvidence,
        unexpected: true,
      },
    },
    privateArtifactDir,
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      arbitraryReviewPayload: true,
    },
    privateArtifactDir,
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      processEvidence: {
        ...result.processEvidence,
        sampleCount: 2,
      },
    },
    privateArtifactDir,
  }).pass, false);
  fs.writeFileSync(
    path.join(privateArtifactDir, 'sdk-process-evidence.json'),
    `${JSON.stringify({
      ...result.processEvidence,
      samplingFailed: true,
      samplingFailureCount: 1,
      samplingErrorHash: 'e'.repeat(64),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      processEvidence: {
        ...result.processEvidence,
        samplingFailed: true,
        samplingFailureCount: 1,
        samplingErrorHash: 'e'.repeat(64),
      },
    },
    privateArtifactDir,
  }).pass, false);
  fs.writeFileSync(
    path.join(privateArtifactDir, 'sdk-process-evidence.json'),
    `${JSON.stringify(result.processEvidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.rmSync(processSnapshotsPath);
  assert.equal(evaluateMatrixRunResult({
    run,
    result,
    privateArtifactDir,
  }).pass, false);
  fs.writeFileSync(
    processSnapshotsPath,
    `${JSON.stringify({
      sampleIndex: 1,
      activeRootPids: [2200],
      processes: [{
        pid: 2200,
        ppid: 2199,
        executable: '/private/forged-claude',
      }],
    })}\n`,
    { mode: 0o600 },
  );
  assert.equal(evaluateMatrixRunResult({
    run,
    result,
    privateArtifactDir,
  }).pass, false);
});

test('matrix parent regenerates CLI process claims from private snapshots', async (t) => {
  const { privateProcessEvidenceMatches } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-cli-process-source-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const privateArtifactDir = path.join(runDir, 'raw-private');
  fs.mkdirSync(privateArtifactDir, { mode: 0o700 });
  const executable = '/private/claude-2.1.220';
  const executablePathHash = crypto.createHash('sha256')
    .update(executable)
    .digest('hex');
  const rawTree = [{
    pid: 2200,
    ppid: 2199,
    executable,
    executablePathHash,
  }];
  fs.writeFileSync(
    path.join(privateArtifactDir, 'process-tree-startup.json'),
    `${JSON.stringify(rawTree, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(privateArtifactDir, 'process-tree-index.ndjson'),
    `${JSON.stringify({ file: 'process-tree-startup.json' })}\n`,
    { mode: 0o600 },
  );
  const result = {
    processTree: rawTree.map(({ pid, ppid, executablePathHash: hash }) => ({
      pid,
      ppid,
      executablePathHash: hash,
    })),
    wrapperRecords: [],
  };

  assert.equal(privateProcessEvidenceMatches(
    { scenarioId: 'cli-contract' },
    result,
    privateArtifactDir,
  ), true);
  fs.writeFileSync(
    path.join(runDir, 'process-wrapper.ndjson'),
    `${JSON.stringify({ runId: 'candidate-run' })}\n`,
    { mode: 0o600 },
  );
  const withWrapper = {
    ...result,
    wrapperRecords: [{ runId: 'candidate-run' }],
  };
  assert.equal(privateProcessEvidenceMatches(
    { scenarioId: 'cli-contract' },
    withWrapper,
    privateArtifactDir,
  ), true);
  assert.equal(privateProcessEvidenceMatches(
    { scenarioId: 'cli-contract' },
    {
      ...withWrapper,
      wrapperRecords: [{ runId: 'forged-run' }],
    },
    privateArtifactDir,
  ), false);
  assert.equal(privateProcessEvidenceMatches(
    { scenarioId: 'cli-contract' },
    {
      ...result,
      processTree: [{
        ...result.processTree[0],
        executablePathHash: 'f'.repeat(64),
      }],
    },
    privateArtifactDir,
  ), false);
});

test('CLI cells require at least ten seconds of MCP-ready deadline headroom', async () => {
  const { evaluateMatrixRunResult } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const run = {
    scenarioId: 'cli-contract',
    version: '2.1.283',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    maxBridgeReadyToMcpReadyMs: 20_000,
  };
  const result = {
    evidenceSchemaVersion: 1,
    matrixScenario: 'cli-contract',
    status: 'PASS',
    resolvedModel: 'claude-sonnet-4-6',
    attestation: {
      version: '2.1.283',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    lifecycle: [{ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }],
    startupHandshake: {
      bridgeReadyMs: 25_000,
      mcpReadyMs: 45_000,
      bridgeReadyToMcpReadyMs: 20_000,
    },
  };

  assert.equal(evaluateMatrixRunResult({ run, result }).pass, true);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      startupHandshake: {
        ...result.startupHandshake,
        mcpReadyMs: 45_001,
        bridgeReadyToMcpReadyMs: 20_001,
      },
    },
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: { ...result, startupHandshake: undefined },
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      startupHandshake: {
        bridgeReadyMs: 25_000,
        mcpReadyMs: 24_999,
        bridgeReadyToMcpReadyMs: -1,
      },
    },
  }).pass, false);
});

test('matrix runner independently verifies CLI lifecycle source evidence', async (t) => {
  const { evaluateMatrixRunResult } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const {
    collectGateLifecycleEvidence,
    collectGateSessionEvidence,
  } = await import('../scripts/spikes/claude-gate-evidence.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateArtifactDir = path.join(dir, 'raw-private');
  fs.mkdirSync(privateArtifactDir, { mode: 0o700 });
  const privateSessionPath = path.join(privateArtifactDir, 'session.jsonl');
  const privateHooksPath = path.join(privateArtifactDir, 'hooks.ndjson');
  const rawSession = `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
  })}\n`;
  const rawHooks = `${JSON.stringify({
    hook_event_name: 'Stop',
  })}\n`;
  fs.writeFileSync(privateSessionPath, rawSession, { mode: 0o600 });
  fs.writeFileSync(privateHooksPath, rawHooks, { mode: 0o600 });
  const sessionEvidence = collectGateSessionEvidence(privateSessionPath);
  const hookEvidence = collectGateLifecycleEvidence(privateHooksPath, {
    stream: 'hooks',
  });
  const run = {
    scenarioId: 'cli-contract',
    version: '2.1.220',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    evidenceSources: {
      session: 'session.jsonl',
      hooks: 'hooks.ndjson',
    },
  };
  const result = {
    evidenceSchemaVersion: 1,
    matrixScenario: 'cli-contract',
    status: 'PASS',
    resolvedModel: 'claude-sonnet-4-6',
    attestation: {
      version: '2.1.220',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    lifecycle: {
      session: sessionEvidence.records,
      hooks: hookEvidence.records,
    },
    lifecycleSources: {
      session: sessionEvidence.source,
      hooks: hookEvidence.source,
    },
    lifecycleProofs: [],
  };

  assert.equal(evaluateMatrixRunResult({
    run,
    result,
    privateArtifactDir,
  }).pass, true);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      lifecycleSources: {
        session: {
          ...result.lifecycleSources.session,
          sha256: 'b'.repeat(64),
        },
        hooks: result.lifecycleSources.hooks,
      },
    },
    privateArtifactDir,
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      lifecycleSources: {
        session: {
          ...result.lifecycleSources.session,
          rawRecordCount: 2,
        },
        hooks: result.lifecycleSources.hooks,
      },
    },
    privateArtifactDir,
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      lifecycleSources: {
        session: {
          ...result.lifecycleSources.session,
          unexpected: true,
        },
        hooks: result.lifecycleSources.hooks,
      },
    },
    privateArtifactDir,
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      lifecycle: {
        ...result.lifecycle,
        hooks: [hook('UserPromptSubmit')],
      },
    },
    privateArtifactDir,
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...result,
      lifecycleSources: {
        session: result.lifecycleSources.session,
      },
    },
    privateArtifactDir,
  }).pass, false);
});

test('matrix parent binds delayed result claims to the raw terminal SDK result', async (t) => {
  const {
    evaluateMatrixRunResult,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const {
    collectGateLifecycleEvidence,
  } = await import('../scripts/spikes/claude-gate-evidence.mjs');
  const {
    createDelayedMcpLifecycleProof,
  } = await import('../scripts/spikes/delayed-mcp-gate.mjs');
  const dir = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'polygram-delayed-result-source-',
  ));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateArtifactDir = path.join(dir, 'raw-private');
  fs.mkdirSync(privateArtifactDir, { mode: 0o700 });
  const sourcePath = path.join(privateArtifactDir, 'sdk-stream.ndjson');
  const marker = 'MCP-COMPLETE:2.1.283:result-source';
  const markerHash = crypto.createHash('sha256').update(marker).digest('hex');
  const records = [
    {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'mcp__polygram-delayed-gate__delayed_marker',
        }],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1' }],
      },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: marker }] },
    },
    { type: 'result', subtype: 'error_during_execution' },
  ];
  fs.writeFileSync(
    sourcePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  const collected = collectGateLifecycleEvidence(sourcePath, {
    stream: 'sdk',
  });
  const claimed = completeDelayedMcpResult('foreground');
  claimed.markerHash = markerHash;
  claimed.lifecycle = collected.records;
  claimed.lifecycleSources = { sdk: collected.source };
  claimed.evidence.nativeLifecycleProof = createDelayedMcpLifecycleProof(
    records,
    {
      expectedMode: 'foreground',
      markerHash,
      asyncPlaceholder: false,
      timing: {
        asyncResultDelayMs: null,
        asyncResultLeadMs: null,
      },
    },
  );
  const run = {
    scenarioId: 'delayed-mcp',
    versionKey: 'old',
    version: '2.1.220',
    // The claim is a foreground run on the default path, so the raw
    // terminal-result mismatch is the only lifecycle failure.
    expectations: OLD_EXPECTATIONS,
    delayedMcpAutoBackground: false,
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    evidenceSources: { sdk: 'sdk-stream.ndjson' },
    versionSpecificLifecycleOracle: 'delayed-mcp-v1',
  };

  const validation = evaluateMatrixRunResult({
    run,
    result: claimed,
    privateArtifactDir,
  });
  assert.equal(validation.pass, false);
  assert.ok(validation.reasons.includes(
    'sanitized lifecycle source does not match the private session artifact',
  ));
  assert.equal(validation.reasons.includes(
    'sanitized result does not satisfy the version-specific lifecycle oracle',
  ), false);
});

test('matrix parent rejects gate-owned raw sources that are not private', async (t) => {
  const {
    privateGateArtifactPermissionsMatch,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const runDir = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'polygram-private-source-mode-',
  ));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.chmodSync(runDir, 0o700);
  const workspace = path.join(runDir, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  const hookPath = path.join(workspace, 'hooks.ndjson');
  fs.writeFileSync(hookPath, '{"cwd":"private"}\n', { mode: 0o644 });

  assert.equal(privateGateArtifactPermissionsMatch(runDir), false);
  fs.chmodSync(hookPath, 0o600);
  assert.equal(privateGateArtifactPermissionsMatch(runDir), true);
});

test('matrix evidence rejects unknown and malformed normalized lifecycle records', async () => {
  const {
    evaluateMatrixEvidencePair,
    evaluateMatrixRunResult,
  } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const run = {
    scenarioId: 'sdk-resume',
    version: '2.1.220',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
  };
  const validResult = {
    evidenceSchemaVersion: 1,
    matrixScenario: 'sdk-resume',
    status: 'PASS',
    resolvedModel: 'claude-sonnet-4-6',
    attestation: {
      version: '2.1.220',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
  };

  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...validResult,
      lifecycle: [
        { type: 'last-prompt' },
        { type: 'mode' },
        { type: 'permission-mode' },
        { type: 'rate_limit_event' },
        // 2.1.283 writes `{"type":"atis-latch","atis":"", sessionId}` rows:
        // no uuid, no parent, nothing Polygram reads. Recognized, not ignored,
        // so a change in its shape still surfaces as an unknown row.
        { type: 'atis-latch' },
        // 2.1.283 writes a running `cost-state` total (USD, durations,
        // per-model usage) that nothing in the lifecycle depends on.
        { type: 'cost-state' },
      ],
    },
  }).pass, true);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...validResult,
      lifecycle: [{ type: 'brand-new-upstream-row' }],
    },
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...validResult,
      lifecycle: [{
        type: 'assistant',
        hasParent: false,
        contentTypes: [],
        toolNames: 'not-an-array',
      }],
    },
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      ...validResult,
      lifecycle: [{
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-6',
        unexpected: true,
      }],
    },
  }).pass, false);

  const cliScenario = manifest.scenarios.find(
    ({ id }) => id === 'cli-contract',
  );
  const oldWithUnknownRecord = structuredClone(
    CLI_LIFECYCLE_FIXTURES.old1,
  );
  oldWithUnknownRecord.lifecycle.session.splice(
    4,
    0,
    { type: 'brand-new-upstream-row' },
  );
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario: cliScenario,
    oldResult: oldWithUnknownRecord,
    candidateResult: CLI_LIFECYCLE_FIXTURES.candidate1,
  }).pass, false);

  const oldWithMalformedStream = structuredClone(
    CLI_LIFECYCLE_FIXTURES.old1,
  );
  oldWithMalformedStream.lifecycle.unexpected = 'not-a-record-stream';
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario: cliScenario,
    oldResult: oldWithMalformedStream,
    candidateResult: CLI_LIFECYCLE_FIXTURES.candidate1,
  }).pass, false);
});

test('matrix evidence compares normalized lifecycle shapes fail closed', async () => {
  const { evaluateMatrixEvidencePair } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const scenario = {
    comparison: {
      equalFields: ['resolvedModel'],
      lifecycle: 'shape-equal',
    },
  };
  const common = {
    resolvedModel: 'claude-sonnet-4-6',
    lifecycle: [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      {
        type: 'assistant',
        hasParent: false,
        contentTypes: ['tool_use'],
        toolNames: ['Bash'],
      },
      { type: 'result', subtype: 'success' },
    ],
  };

  assert.deepEqual(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult: common,
    candidateResult: { ...common, lifecycle: [...common.lifecycle] },
  }), { pass: true, differences: [] });
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult: common,
    candidateResult: {
      ...common,
      lifecycle: [
        ...common.lifecycle,
        { type: 'system', subtype: 'task_notification' },
      ],
    },
  }).pass, false);
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult: common,
    candidateResult: {
      ...common,
      lifecycle: [
        ...common.lifecycle,
        common.lifecycle[1],
      ],
    },
  }).pass, false);
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult: common,
    candidateResult: { resolvedModel: common.resolvedModel },
  }).pass, false);
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario: {
      comparison: {
        equalFields: ['resolvedModel'],
        lifecycle: { mode: 'unrecognized' },
      },
    },
    oldResult: common,
    candidateResult: common,
  }).pass, false);
});

test('SDK semantic comparison ignores the timing-dependent commands_changed notice only', async () => {
  const { evaluateMatrixEvidencePair } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const scenario = {
    comparison: {
      lifecycle: 'sdk-semantic-shape-v1',
      equalFields: ['resolvedModel'],
    },
  };
  const turn = [
    system('init'),
    {
      type: 'assistant',
      hasParent: false,
      contentTypes: ['text'],
      toolNames: [],
    },
    { type: 'result', subtype: 'success' },
  ];
  const oldResult = {
    resolvedModel: 'claude-sonnet-4-6',
    lifecycle: [...turn, ...turn],
  };
  // Real 2.1.283 sdk-resume: the notice followed the second query's init
  // but not the first, so its count is not a property of the turn.
  const candidateResult = {
    resolvedModel: 'claude-sonnet-4-6',
    lifecycle: [...turn, system('init'), system('commands_changed'), ...turn.slice(1)],
  };
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult,
    candidateResult,
  }).pass, true);
  // Any other new system row is still lifecycle drift.
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult,
    candidateResult: {
      ...candidateResult,
      lifecycle: candidateResult.lifecycle.map((record) => (
        record.subtype === 'commands_changed' ? system('commands_reloaded') : record
      )),
    },
  }).pass, false);
});

test('SDK semantic lifecycle comparison ignores streaming noise but rejects missing tools', async () => {
  const { evaluateMatrixEvidencePair } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const scenario = {
    comparison: {
      lifecycle: 'sdk-semantic-shape-v1',
      equalFields: ['resolvedModel'],
    },
  };
  const common = {
    resolvedModel: 'claude-sonnet-4-6',
  };
  const oldLifecycle = [
    system('init'),
    system('thinking_tokens'),
    system('thinking_tokens'),
    {
      type: 'assistant',
      hasParent: false,
      contentTypes: ['tool_use'],
      toolNames: ['Bash'],
    },
    {
      type: 'assistant',
      hasParent: false,
      contentTypes: ['tool_use'],
      toolNames: ['Bash'],
    },
    {
      type: 'user',
      hasParent: false,
      contentKind: 'blocks',
      contentTypes: ['tool_result'],
    },
    {
      type: 'user',
      hasParent: false,
      contentKind: 'blocks',
      contentTypes: ['tool_result'],
    },
    { type: 'rate_limit_event' },
    { type: 'result', subtype: 'success' },
  ];
  const candidateLifecycle = [
    system('init'),
    system('thinking_tokens'),
    {
      type: 'assistant',
      hasParent: false,
      contentTypes: ['tool_use'],
      toolNames: ['Bash'],
    },
    {
      type: 'user',
      hasParent: false,
      contentKind: 'blocks',
      contentTypes: ['tool_result'],
    },
    {
      type: 'assistant',
      hasParent: false,
      contentTypes: ['tool_use'],
      toolNames: ['Bash'],
    },
    { type: 'rate_limit_event' },
    {
      type: 'user',
      hasParent: false,
      contentKind: 'blocks',
      contentTypes: ['tool_result'],
    },
    { type: 'result', subtype: 'success' },
  ];

  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult: { ...common, lifecycle: oldLifecycle },
    candidateResult: { ...common, lifecycle: candidateLifecycle },
  }).pass, true);
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult: { ...common, lifecycle: oldLifecycle },
    candidateResult: {
      ...common,
      lifecycle: candidateLifecycle.filter(
        (record) => !record.toolNames?.includes('Bash'),
      ),
    },
  }).pass, false);
});

test('Workflow lifecycle comparison excludes only worker-internal volatility', async () => {
  const { evaluateMatrixEvidencePair } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );

  for (const deliveryMode of ['direct', 'fallback']) {
    const scenario = manifest.scenarios.find(
      ({ id }) => id === `workflow-${deliveryMode}`,
    );
    const oldResult = workflowMatrixResult(workflowLifecycleFixture({
      deliveryMode,
      bashPairs: 2,
      subagentStops: 3,
    }), deliveryMode);
    const candidateResult = workflowMatrixResult(with283SessionRows(
      workflowLifecycleFixture({
        deliveryMode,
        bashPairs: 4,
        subagentStops: 4,
      }),
      { recordAfter: 'skill_listing' },
    ), deliveryMode);

    assert.equal(evaluateMatrixEvidencePair({
      ...MANIFEST_EXPECTATIONS,
      scenario: {
        comparison: {
          ...scenario.comparison,
          lifecycle: 'shape-equal',
        },
      },
      oldResult,
      candidateResult,
    }).pass, false);
    assert.equal(evaluateMatrixEvidencePair({
      ...MANIFEST_EXPECTATIONS,
      scenario,
      oldResult,
      candidateResult,
    }).pass, true);

    const lifecycleMutations = [
      (result) => {
        const index = result.lifecycle.session.findIndex(
          (record) => record.operation === 'enqueue',
        );
        result.lifecycle.session.splice(index, 1);
      },
      (result) => {
        const index = result.lifecycle.session.findIndex(
          (record) => record.hasTaskNotification,
        );
        result.lifecycle.session.splice(index, 1);
      },
      (result) => {
        const index = result.lifecycle.hooks.findIndex(
          (record) => (
            record.hookEventName === 'PreToolUse'
            && record.toolName === 'Workflow'
          ),
        );
        result.lifecycle.hooks.splice(index, 1);
      },
      (result) => {
        const index = result.lifecycle.hooks.findIndex(
          (record) => (
            record.hookEventName === 'PreToolUse'
            && record.toolName === WORKFLOW_REPLY_TOOL
          ),
        );
        [result.lifecycle.hooks[index], result.lifecycle.hooks[index + 1]] = [
          result.lifecycle.hooks[index + 1],
          result.lifecycle.hooks[index],
        ];
      },
      (result) => {
        result.lifecycle.session.push(attachment('task_reminder'));
      },
      (result) => {
        result.lifecycleProofs.push(taskReminderProof());
      },
    ];
    for (const mutate of lifecycleMutations) {
      const mutated = structuredClone(candidateResult);
      mutate(mutated);
      assert.equal(evaluateMatrixEvidencePair({
        ...MANIFEST_EXPECTATIONS,
        scenario,
        oldResult,
        candidateResult: mutated,
      }).pass, false);
    }

    const policyMutations = [
      (mutatedScenario) => {
        delete mutatedScenario.comparison.lifecycle.versionedInsertions;
      },
      (mutatedScenario) => {
        mutatedScenario.comparison.lifecycle.versionedInsertions = null;
      },
      (mutatedScenario) => {
        mutatedScenario.comparison.lifecycle.versionedInsertions = {};
      },
      (mutatedScenario) => {
        delete mutatedScenario.comparison.lifecycle.optionalInsertions;
      },
      (mutatedScenario) => {
        mutatedScenario.comparison.lifecycle.optionalInsertions = null;
      },
      (mutatedScenario) => {
        mutatedScenario.comparison.lifecycle.optionalInsertions = {};
      },
      (mutatedScenario) => {
        mutatedScenario.comparison.lifecycle.projectedBaseline.hooks.pop();
      },
    ];
    for (const mutate of policyMutations) {
      const mutatedScenario = structuredClone(scenario);
      mutate(mutatedScenario);
      assert.equal(evaluateMatrixEvidencePair({
        ...MANIFEST_EXPECTATIONS,
        scenario: mutatedScenario,
        oldResult,
        candidateResult,
      }).pass, false);
    }

    const evidenceMutations = [
      (result) => {
        delete result.lifecycleProofs;
      },
      (result) => {
        result.lifecycleProofs = null;
      },
      (result) => {
        result.lifecycleProofs = {};
      },
      (result) => {
        delete result.lifecycleSources;
      },
      (result) => {
        result.lifecycleSources = null;
      },
      (result) => {
        result.lifecycleSources.session.sha256 = 'invalid';
      },
      (result) => {
        result.lifecycleSources.session.rawRecordCount += 1;
      },
      (result) => {
        delete result.lifecycleSources.session.normalizedRecordCount;
      },
    ];
    for (const mutate of evidenceMutations) {
      const mutated = structuredClone(candidateResult);
      mutate(mutated);
      assert.equal(evaluateMatrixEvidencePair({
        ...MANIFEST_EXPECTATIONS,
        scenario,
        oldResult,
        candidateResult: mutated,
      }).pass, false);
    }
  }
});

test('single-run Workflow evidence must match its absolute lifecycle baseline', async () => {
  const { evaluateMatrixVersionEvidence } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const scenario = manifest.scenarios.find(
    ({ id }) => id === 'workflow-direct',
  );
  const result = workflowMatrixResult(workflowLifecycleFixture({
    deliveryMode: 'direct',
    bashPairs: 2,
    subagentStops: 3,
  }), 'direct');
  const invalid = structuredClone(result);
  invalid.lifecycle.session.shift();

  assert.equal(evaluateMatrixVersionEvidence({
    scenario,
    versionKey: 'old',
    expectations: OLD_EXPECTATIONS,
    results: [result],
  }).pass, true);
  assert.equal(evaluateMatrixVersionEvidence({
    scenario,
    versionKey: 'old',
    expectations: OLD_EXPECTATIONS,
    results: [invalid],
  }).pass, false);
});

test('CLI lifecycle comparison tolerates only demonstrated same-version volatility', async () => {
  const {
    evaluateMatrixEvidencePair,
    evaluateMatrixScenarioEvidence,
    evaluateMatrixVersionEvidence,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const cliScenario = manifest.scenarios.find(({ id }) => id === 'cli-contract');
  const strictScenario = {
    comparison: {
      equalFields: ['resolvedModel', 'fileObserved', 'spawnCount'],
      lifecycle: 'shape-equal',
    },
  };

  assert.equal(CLI_SESSION_PROJECTION.length, 35);
  assert.equal(CLI_TRANSPORT_HOOKS.length, 21);
  const strictVolatilityPairs = [
    [
      matrixResult(cliLifecycleFixture({
        fileTool: 'Bash',
        subagentStops: 4,
      })),
      CLI_LIFECYCLE_FIXTURES.old2,
    ],
    [
      matrixResult(cliLifecycleFixture({
        fileTool: 'Write',
        subagentStops: 5,
      })),
      CLI_LIFECYCLE_FIXTURES.old2,
    ],
    [
      CLI_LIFECYCLE_FIXTURES.old2,
      CLI_LIFECYCLE_FIXTURES.old3,
    ],
  ];
  for (const [left, right] of strictVolatilityPairs) {
    assert.equal(evaluateMatrixEvidencePair({
      ...MANIFEST_EXPECTATIONS,
      scenario: strictScenario,
      oldResult: left,
      candidateResult: right,
    }).pass, false);
  }

  const oldPairs = [
    [CLI_LIFECYCLE_FIXTURES.old1, CLI_LIFECYCLE_FIXTURES.old2],
    [CLI_LIFECYCLE_FIXTURES.old1, CLI_LIFECYCLE_FIXTURES.old3],
    [CLI_LIFECYCLE_FIXTURES.old2, CLI_LIFECYCLE_FIXTURES.old3],
  ];
  assert.equal(evaluateMatrixVersionEvidence({
    scenario: cliScenario,
    versionKey: 'old',
    expectations: OLD_EXPECTATIONS,
    results: oldPairs[0],
  }).pass, true);
  const incompatibleOld = structuredClone(CLI_LIFECYCLE_FIXTURES.old2);
  [incompatibleOld.lifecycle.session[0], incompatibleOld.lifecycle.session[1]] = [
    incompatibleOld.lifecycle.session[1],
    incompatibleOld.lifecycle.session[0],
  ];
  assert.equal(evaluateMatrixVersionEvidence({
    scenario: cliScenario,
    versionKey: 'old',
    expectations: OLD_EXPECTATIONS,
    results: [CLI_LIFECYCLE_FIXTURES.old1, incompatibleOld],
  }).pass, false);
  const outcomes = oldPairs.map((oldResults) => (
    evaluateMatrixScenarioEvidence({
      ...MANIFEST_EXPECTATIONS,
      scenario: cliScenario,
      oldResults,
      candidateResults: [
        CLI_LIFECYCLE_FIXTURES.candidate1,
        CLI_LIFECYCLE_FIXTURES.candidate2,
      ],
    })
  ));
  assert.ok(outcomes.every((outcome) => outcome.pass));
  const [outcome] = outcomes;
  assert.deepEqual(
    outcome.comparisons.map((comparison) => comparison.id),
    [
      'absolute-baseline:old:1',
      'absolute-baseline:old:2',
      'same-version:old:1-2',
      'absolute-baseline:candidate:1',
      'absolute-baseline:candidate:2',
      'same-version:candidate:1-2',
      'cross-version:old-1:candidate-1',
      'cross-version:old-1:candidate-2',
      'cross-version:old-2:candidate-1',
      'cross-version:old-2:candidate-2',
    ],
  );
  assert.ok(outcome.comparisons.every((comparison) => comparison.pass));

  const invalidPolicyScenario = structuredClone(cliScenario);
  invalidPolicyScenario.comparison.crossVersion = 'first-only';
  assert.deepEqual(evaluateMatrixScenarioEvidence({
    ...MANIFEST_EXPECTATIONS,
    scenario: invalidPolicyScenario,
    oldResults: oldPairs[0],
    candidateResults: [
      CLI_LIFECYCLE_FIXTURES.candidate1,
      CLI_LIFECYCLE_FIXTURES.candidate2,
    ],
  }), {
    pass: false,
    comparisons: [{
      id: 'comparison-policy',
      pass: false,
      differences: ['comparison-policy'],
    }],
  });
});

test('CLI lifecycle comparison accepts only a proved interrupt-correlated cancellation union', async () => {
  const {
    evaluateMatrixEvidencePair,
    evaluateMatrixVersionEvidence,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const scenario = structuredClone(
    manifest.scenarios.find(({ id }) => id === 'cli-contract'),
  );
  scenario.comparison.lifecycle.optionalInsertions = [{
    stream: 'session',
    record: attachment('hook_cancelled'),
    maxCount: 1,
    proof: {
      type: 'session-event-aggregator-removal',
      eligibility: 'interrupt-user-prompt-submit-v1',
    },
  }];
  scenario.comparison.lifecycle.versionedInsertions[0].proof.eligibility =
    'task-reminder-v1';

  const oldWithoutCancellation = structuredClone(
    CLI_LIFECYCLE_FIXTURES.old2,
  );
  const oldWithCancellation = structuredClone(
    CLI_LIFECYCLE_FIXTURES.old1,
  );
  oldWithCancellation.lifecycle.session.splice(
    28,
    0,
    attachment('hook_cancelled'),
  );
  oldWithCancellation.lifecycleSources.session.rawRecordCount += 1;
  oldWithCancellation.lifecycleSources.session.normalizedRecordCount += 1;
  oldWithCancellation.lifecycleProofs = [compositeRemovalProof({
    taskReminderCount: 1,
    hookCancelledCount: 1,
  })];

  assert.equal(evaluateMatrixVersionEvidence({
    scenario,
    versionKey: 'old',
    expectations: OLD_EXPECTATIONS,
    results: [oldWithCancellation, oldWithoutCancellation],
  }).pass, true);

  const candidateWithUnion = structuredClone(
    CLI_LIFECYCLE_FIXTURES.candidate1,
  );
  candidateWithUnion.lifecycle.session.splice(
    30,
    0,
    attachment('hook_cancelled'),
  );
  candidateWithUnion.lifecycleSources.session.rawRecordCount += 1;
  candidateWithUnion.lifecycleSources.session.normalizedRecordCount += 1;
  candidateWithUnion.lifecycleProofs = [compositeRemovalProof({
    taskReminderCount: 1,
    hookCancelledCount: 1,
  })];
  assert.equal(evaluateMatrixEvidencePair({
    ...MANIFEST_EXPECTATIONS,
    scenario,
    oldResult: oldWithoutCancellation,
    candidateResult: candidateWithUnion,
  }).pass, true);

  const mutations = [
    (result) => {
      result.lifecycleProofs[0].targets[0]
        .eligibility.allParentsMatchInterrupt = false;
    },
    (result) => {
      result.lifecycleProofs[0].targets[0].rawTargetCount = 2;
    },
    (result) => {
      result.lifecycleProofs[0].targetBatchesEmpty = false;
    },
    (result) => {
      result.lifecycleProofs = [
        compositeRemovalProof({ hookCancelledCount: 1 }),
        compositeRemovalProof({ taskReminderCount: 1 }),
      ];
    },
    (result) => {
      result.lifecycle.session.push(attachment('hook_cancelled'));
      result.lifecycleSources.session.rawRecordCount += 1;
      result.lifecycleSources.session.normalizedRecordCount += 1;
    },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(candidateWithUnion);
    mutate(invalid);
    assert.equal(evaluateMatrixEvidencePair({
      ...MANIFEST_EXPECTATIONS,
      scenario,
      oldResult: oldWithoutCancellation,
      candidateResult: invalid,
    }).pass, false);
  }
});

// The projected CLI-contract session sequence of an authoritative 2.1.283
// run (total_tokens_reminder already excluded). In other runs the five
// context records before the first enqueue land after the first channel
// prompt instead, because Claude writes them while that prompt arrives.
const OBSERVED_CLI_SESSION_283 = [
  'a:instructions', 'a:session_context', 'a:date', 'a:credential_org',
  'a:remote_session_change', 'q:enqueue', 'q:dequeue', 'u:root',
  'a:environment', 'a:model', 'a:deferred_tools_delta',
  'a:agent_listing_delta', 'a:mcp_instructions_delta', 'a:skill_listing',
  'a:deferred_tools_record', 's:stop_hook_summary', 's:turn_duration',
  'q:enqueue', 'q:dequeue', 'u:child', 's:stop_hook_summary',
  's:turn_duration', 'q:enqueue', 'q:dequeue', 'u:child', 'q:enqueue',
  'q:remove', 'a:queued_command', 's:stop_hook_summary', 's:turn_duration',
  'q:enqueue', 'q:dequeue', 'u:child', 'a:task_reminder', 'q:enqueue',
  'q:dequeue', 'u:child', 's:stop_hook_summary', 's:turn_duration',
  'q:enqueue', 'q:dequeue', 'u:child', 's:stop_hook_summary',
  's:turn_duration',
];
const OBSERVED_CLI_SESSION_283_LATE_CONTEXT = [
  ...OBSERVED_CLI_SESSION_283.slice(5, 8),
  ...OBSERVED_CLI_SESSION_283.slice(0, 5),
  ...OBSERVED_CLI_SESSION_283.slice(8),
];
const OBSERVED_CLI_HOOKS_283 = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
  'UserPromptSubmit', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
  'UserPromptSubmit', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
];

function decodeObservedSession(code) {
  const [kind, value] = code.split(':');
  if (kind === 'a') return attachment(value);
  if (kind === 'q') return queue(value);
  if (kind === 's') return system(value);
  return channelUser(value === 'child');
}

function observedHooks(names) {
  return names.map((name) => (
    name === 'PreToolUse' || name === 'PostToolUse'
      ? hook(name, REPLY_TOOL)
      : hook(name)
  ));
}

function observedCliResult({ session, hooks }) {
  return matrixResult({ session, hooks }, { taskReminder: true });
}

test('2.1.283 context attachments count once each in either observed order', async () => {
  const {
    evaluateMatrixScenarioEvidence,
    evaluateMatrixVersionEvidence,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const cliScenario = manifest.scenarios.find(({ id }) => id === 'cli-contract');
  const hooks = observedHooks(OBSERVED_CLI_HOOKS_283);
  const early = {
    session: OBSERVED_CLI_SESSION_283.map(decodeObservedSession),
    hooks,
  };
  const late = {
    session: OBSERVED_CLI_SESSION_283_LATE_CONTEXT.map(decodeObservedSession),
    hooks,
  };
  assert.equal(OBSERVED_CLI_HOOKS_283.length, CLI_TRANSPORT_HOOKS.length + 1);
  const withoutReminder = (session) => session.filter(
    (record) => record.attachmentType !== 'task_reminder',
  );
  assert.deepEqual(
    withoutReminder(CLI_LIFECYCLE_FIXTURES.candidate1.lifecycle.session.filter(
      (record) => record.type !== 'assistant'
        && !(record.type === 'user' && !record.originKind),
    )),
    withoutReminder(early.session),
  );

  const oldResults = [CLI_LIFECYCLE_FIXTURES.old1, CLI_LIFECYCLE_FIXTURES.old2];
  const outcome = evaluateMatrixScenarioEvidence({
    ...MANIFEST_EXPECTATIONS,
    scenario: cliScenario,
    oldResults,
    candidateResults: [observedCliResult(early), observedCliResult(late)],
  });
  assert.equal(outcome.pass, true);
  assert.ok(outcome.comparisons.every((comparison) => comparison.pass));

  const judgeCandidate = (lifecycle, expectations = CANDIDATE_EXPECTATIONS) => (
    evaluateMatrixVersionEvidence({
      scenario: cliScenario,
      versionKey: 'candidate',
      expectations,
      results: [observedCliResult(lifecycle), observedCliResult(early)],
    }).pass
  );
  const mutate = (base, stream, change) => {
    const copy = structuredClone(base);
    change(copy[stream]);
    return copy;
  };
  const at = (session, type) => session.findIndex(
    (record) => record.attachmentType === type,
  );
  assert.equal(judgeCandidate(late), true);
  for (const base of [early, late]) {
    for (const [name, lifecycle] of Object.entries({
      'context row missing': mutate(base, 'session', (session) => {
        session.splice(at(session, 'model'), 1);
      }),
      'context row duplicated': mutate(base, 'session', (session) => {
        session.push(attachment('date'));
      }),
      'context row renamed': mutate(base, 'session', (session) => {
        session[at(session, 'deferred_tools_record')] =
          attachment('deferred_tools_snapshot');
      }),
      'undeclared new attachment': mutate(base, 'session', (session) => {
        session.splice(1, 0, attachment('output_style_instructions'));
      }),
      'non-context rows reordered': mutate(base, 'session', (session) => {
        const skill = at(session, 'skill_listing');
        [session[skill - 1], session[skill]] = [session[skill], session[skill - 1]];
      }),
      'fold prompt hook missing': mutate(base, 'hooks', (list) => list.splice(9, 1)),
      // An extra prompt hook on a turn other than the folded one is a
      // different behaviour, even though the count matches.
      'extra prompt hook on the first turn instead': mutate(base, 'hooks', (list) => {
        list.splice(9, 1);
        list.splice(1, 0, hook('UserPromptSubmit'));
      }),
      'second extra prompt hook': mutate(base, 'hooks', (list) => {
        list.splice(9, 0, hook('UserPromptSubmit'));
      }),
    })) {
      assert.equal(judgeCandidate(lifecycle), false, name);
    }
  }

  // The rows are declared for 2.1.283 only: the same transcript attested as
  // 2.1.220 fails, and a 2.1.220 transcript fails the 2.1.283 entry.
  assert.equal(judgeCandidate(early, OLD_EXPECTATIONS), false);
  assert.equal(evaluateMatrixVersionEvidence({
    scenario: cliScenario,
    versionKey: 'candidate',
    expectations: CANDIDATE_EXPECTATIONS,
    results: oldResults,
  }).pass, false);
  const oldWithContext = withSessionRecords(CLI_LIFECYCLE_FIXTURES.old2, (session) => {
    session.unshift(attachment('date'));
  });
  assert.equal(evaluateMatrixVersionEvidence({
    scenario: cliScenario,
    versionKey: 'old',
    expectations: OLD_EXPECTATIONS,
    results: [CLI_LIFECYCLE_FIXTURES.old1, oldWithContext],
  }).pass, false);

  // A projected-compatible policy without a baseline id cannot be judged.
  const anonymous = structuredClone(cliScenario);
  delete anonymous.comparison.lifecycle.baselineId;
  assert.equal(evaluateMatrixScenarioEvidence({
    ...MANIFEST_EXPECTATIONS,
    scenario: anonymous,
    oldResults,
    candidateResults: [observedCliResult(early), observedCliResult(late)],
  }).pass, false);
});

test('2.1.283 Workflow accepts its context attachments in either observed order', async () => {
  const {
    evaluateMatrixScenarioEvidence,
    evaluateMatrixVersionEvidence,
    nestedWorkflowLifecycleMatches,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  // Six real 2.1.283 runs wrote deferred_tools_record on either side of
  // command_permissions, and the session-start records race the first prompt.
  const indexOf = (session, type) => session.findIndex(
    (record) => record.attachmentType === type,
  );
  for (const deliveryMode of ['direct', 'fallback']) {
    const scenario = manifest.scenarios.find(
      ({ id }) => id === `workflow-${deliveryMode}`,
    );
    const recordFirst = workflowMatrixResult(with283SessionRows(
      workflowLifecycleFixture({ deliveryMode, bashPairs: 2, subagentStops: 3 }),
      { recordAfter: 'skill_listing' },
    ), deliveryMode);
    const permissionsFirst = withSessionRecords(recordFirst, (session) => {
      const record = indexOf(session, 'deferred_tools_record');
      [session[record], session[record + 1]] = [session[record + 1], session[record]];
    });
    const lateContext = withSessionRecords(permissionsFirst, (session) => {
      const context = session.splice(0, 5);
      session.splice(indexOf(session, 'environment'), 0, ...context);
    });

    const judge = (result) => evaluateMatrixVersionEvidence({
      scenario,
      versionKey: 'candidate',
      expectations: CANDIDATE_EXPECTATIONS,
      results: [result],
    }).pass;
    for (const result of [recordFirst, permissionsFirst, lateContext]) {
      assert.equal(judge(result), true);
    }
    assert.equal(evaluateMatrixScenarioEvidence({
      ...MANIFEST_EXPECTATIONS,
      scenario,
      oldResults: [workflowMatrixResult(workflowLifecycleFixture({
        deliveryMode,
        bashPairs: 2,
        subagentStops: 3,
      }), deliveryMode)],
      candidateResults: [lateContext],
    }).pass, true);
    if (deliveryMode === 'direct') {
      const opusShaped = withSessionRecords(permissionsFirst, (session) => {
        session.splice(indexOf(session, 'command_permissions'), 0, attachment('auto_mode'));
      });
      assert.equal(nestedWorkflowLifecycleMatches({
        result: opusShaped,
        policy: scenario.comparison.lifecycle,
        expectations: CANDIDATE_EXPECTATIONS,
      }), true);
    }

    for (const [name, change] of Object.entries({
      missing: (session) => {
        session.splice(indexOf(session, 'deferred_tools_record'), 1);
      },
      duplicated: (session) => {
        session.push(attachment('deferred_tools_record'));
      },
      'non-context rows reordered': (session) => {
        const skill = indexOf(session, 'skill_listing');
        [session[skill - 1], session[skill]] = [session[skill], session[skill - 1]];
      },
      'command_permissions moved': (session) => {
        const [permissions] = session.splice(indexOf(session, 'command_permissions'), 1);
        session.splice(indexOf(session, 'skill_listing'), 0, permissions);
      },
    })) {
      for (const base of [recordFirst, permissionsFirst]) {
        assert.equal(
          judge(withSessionRecords(base, change)),
          false,
          `${deliveryMode}: ${name}`,
        );
      }
    }
  }
});

test('context-count and positional declarations are validated before any run', async () => {
  const {
    buildClaudeMatrixRuns,
    expectationsFor,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const declared = CANDIDATE_EXPECTATIONS.projectedInsertions['cli-contract-v1'];
  for (const projectedInsertions of [
    { 'cli-contract-v1': { hooks: [...declared.hooks, ...declared.hooks] } },
    { 'cli-contract-v1': { hooks: [] } },
    { 'cli-contract-v1': { transcript: declared.hooks } },
    { 'cli-contract-v1': { hooks: [{ index: -1, record: hook('UserPromptSubmit') }] } },
    { 'cli-contract-v1': { hooks: [{ index: [9, 10], record: hook('UserPromptSubmit') }] } },
    { 'cli-contract-v1': { session: [{ index: 0, record: { type: 'unknown-row' } }] } },
  ]) {
    assert.throws(() => expectationsFor({
      [CANDIDATE_VERSION]: { ...CANDIDATE_EXPECTATIONS, projectedInsertions },
    }, CANDIDATE_VERSION), /malformed/);
  }
  for (const passiveSessionAttachmentCounts of [
    { date: -1 },
    { date: 1.5 },
    { 'Date Record': 1 },
    [],
  ]) {
    assert.throws(() => expectationsFor({
      [CANDIDATE_VERSION]: {
        ...CANDIDATE_EXPECTATIONS,
        passiveSessionAttachmentCounts,
      },
    }, CANDIDATE_VERSION), /malformed/);
  }
  assert.deepEqual(
    CANDIDATE_EXPECTATIONS.passiveSessionAttachmentCounts,
    Object.fromEntries(CONTEXT_ATTACHMENTS_283.map((type) => [type, 1])),
  );
  assert.deepEqual(CANDIDATE_EXPECTATIONS.opusPassiveSessionAttachmentCounts, {
    auto_mode: 1,
  });
  // An Opus-only type must not also be counted for every session.
  assert.throws(() => expectationsFor({
    [CANDIDATE_VERSION]: {
      ...CANDIDATE_EXPECTATIONS,
      opusPassiveSessionAttachmentCounts: { date: 1 },
    },
  }, CANDIDATE_VERSION), /malformed/);
  assert.deepEqual(OLD_EXPECTATIONS.projectedInsertions, {});

  // A type counted for one version must be counted (as zero) for the other.
  const onlyCandidate = structuredClone(manifest);
  delete onlyCandidate.expectations[OLD_VERSION]
    .passiveSessionAttachmentCounts.model;
  assert.throws(() => buildClaudeMatrixRuns({
    manifest: onlyCandidate,
    binaries: {
      old: '/private/bin/claude-old',
      candidate: '/private/bin/claude-candidate',
    },
    artifactBaseDir: '/private/artifacts',
    runPrefix: 'passive-types',
  }), /same passive session attachments/);

  const baselineIds = manifest.scenarios
    .map((scenario) => scenario.comparison?.lifecycle?.baselineId)
    .filter(Boolean);
  assert.deepEqual(baselineIds, [
    'cli-contract-v1',
    'workflow-direct-v1',
    'workflow-fallback-v1',
  ]);
  for (const baselineId of Object.keys(CANDIDATE_EXPECTATIONS.projectedInsertions)) {
    assert.ok(baselineIds.includes(baselineId), baselineId);
  }
});

function withSessionRecords(result, mutate) {
  const copy = structuredClone(result);
  mutate(copy.lifecycle.session);
  copy.lifecycleSources.session.rawRecordCount = copy.lifecycle.session.length;
  copy.lifecycleSources.session.normalizedRecordCount =
    copy.lifecycle.session.length;
  return copy;
}

test('service context-usage reminders are not lifecycle drift, other attachments still are', async () => {
  const {
    evaluateMatrixScenarioEvidence,
    evaluateMatrixVersionEvidence,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const cliScenario = manifest.scenarios.find(({ id }) => id === 'cli-contract');
  // Reproduced on an unchanged 2.1.220 binary: two runs carried two and
  // three total_tokens_reminder attachments at different turns.
  const reminder = attachment('total_tokens_reminder');
  const oldResults = [
    withSessionRecords(CLI_LIFECYCLE_FIXTURES.old1, (session) => {
      session.splice(12, 0, reminder);
      session.splice(24, 0, reminder);
    }),
    withSessionRecords(CLI_LIFECYCLE_FIXTURES.old2, (session) => {
      session.splice(8, 0, reminder);
      session.splice(20, 0, reminder);
      session.push(reminder);
    }),
  ];
  assert.equal(evaluateMatrixVersionEvidence({
    scenario: cliScenario,
    versionKey: 'old',
    expectations: OLD_EXPECTATIONS,
    results: oldResults,
  }).pass, true);
  assert.equal(evaluateMatrixScenarioEvidence({
    ...MANIFEST_EXPECTATIONS,
    scenario: cliScenario,
    oldResults,
    candidateResults: [
      CLI_LIFECYCLE_FIXTURES.candidate1,
      CLI_LIFECYCLE_FIXTURES.candidate2,
    ],
  }).pass, true);

  // Every other attachment stays pivotal: the queue fold marker, the
  // declared task reminder, and unknown attachments are still compared.
  for (const [name, mutate] of Object.entries({
    'extra queued_command': (session) => {
      session.splice(12, 0, attachment('queued_command'));
    },
    'missing queued_command': (session) => {
      session.splice(session.findIndex(
        (record) => record.attachmentType === 'queued_command',
      ), 1);
    },
    'extra task_reminder': (session) => {
      session.splice(12, 0, attachment('task_reminder'));
    },
    'unknown attachment': (session) => {
      session.splice(12, 0, attachment('total_tokens_reminder_v2'));
    },
  })) {
    assert.equal(evaluateMatrixVersionEvidence({
      scenario: cliScenario,
      versionKey: 'old',
      expectations: OLD_EXPECTATIONS,
      results: [oldResults[0], withSessionRecords(oldResults[1], mutate)],
    }).pass, false, name);
  }
});

test('CLI lifecycle comparison rejects undeclared pivotal and transport drift', async () => {
  const { evaluateMatrixScenarioEvidence } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const cliScenario = manifest.scenarios.find(({ id }) => id === 'cli-contract');
  const candidate = structuredClone(CLI_LIFECYCLE_FIXTURES.candidate1);

  function evaluateMutation(mutate) {
    const mutated = [
      structuredClone(candidate),
      structuredClone(CLI_LIFECYCLE_FIXTURES.candidate2),
    ];
    for (const result of mutated) mutate(result.lifecycle);
    return evaluateMatrixScenarioEvidence({
      ...MANIFEST_EXPECTATIONS,
      scenario: cliScenario,
      oldResults: [
        CLI_LIFECYCLE_FIXTURES.old1,
        CLI_LIFECYCLE_FIXTURES.old2,
      ],
      candidateResults: mutated,
    });
  }

  const mutations = {
    missing: (lifecycle) => {
      lifecycle.session = lifecycle.session.filter(
        (record) => record.attachmentType !== 'task_reminder',
      );
    },
    duplicate: (lifecycle) => {
      const index = lifecycle.session.findIndex(
        (record) => record.attachmentType === 'task_reminder',
      );
      lifecycle.session.splice(index, 0, attachment('task_reminder'));
    },
    'wrong stream': (lifecycle) => {
      lifecycle.session = lifecycle.session.filter(
        (record) => record.attachmentType !== 'task_reminder',
      );
      lifecycle.hooks.push(attachment('task_reminder'));
    },
    'changed attachment': (lifecycle) => {
      const reminder = lifecycle.session.find(
        (record) => record.attachmentType === 'task_reminder',
      );
      reminder.attachmentType = 'task_reminder_v2';
    },
    'pivotal reorder': (lifecycle) => {
      const first = lifecycle.session.findIndex(
        (record) => record.type === 'queue-operation',
      );
      [lifecycle.session[first], lifecycle.session[first + 1]] = [
        lifecycle.session[first + 1],
        lifecycle.session[first],
      ];
    },
    'reply hook reorder': (lifecycle) => {
      const pre = lifecycle.hooks.findIndex(
        (record) => record.hookEventName === 'PreToolUse'
          && record.toolName === REPLY_TOOL,
      );
      [lifecycle.hooks[pre], lifecycle.hooks[pre + 1]] = [
        lifecycle.hooks[pre + 1],
        lifecycle.hooks[pre],
      ];
    },
    'dropped reply hook': (lifecycle) => {
      const post = lifecycle.hooks.findIndex(
        (record) => record.hookEventName === 'PostToolUse'
          && record.toolName === REPLY_TOOL,
      );
      lifecycle.hooks.splice(post, 1);
    },
  };

  assert.equal(evaluateMutation(() => {}).pass, true, 'unmutated control');
  for (const [name, mutate] of Object.entries(mutations)) {
    assert.equal(evaluateMutation(mutate).pass, false, name);
  }
});

test('CLI lifecycle comparison rejects a false or stale reminder proof', async () => {
  const { evaluateMatrixScenarioEvidence } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const cliScenario = manifest.scenarios.find(
    ({ id }) => id === 'cli-contract',
  );
  const mutations = [
    (result) => {
      result.lifecycleProofs[0].targetBatchesEmpty = false;
    },
    (result) => {
      result.lifecycleProofs[0].retainedPushBatchesEqual = false;
    },
    (result) => {
      result.lifecycleProofs[0].flushBatchEqual = false;
    },
    (result) => {
      result.lifecycleProofs[0].sourceSha256 = 'b'.repeat(64);
    },
    (result) => {
      result.lifecycleProofs = [];
    },
    (result) => {
      result.lifecycleProofs.push(taskReminderProof());
    },
    (result) => {
      result.lifecycleProofs[0].type = 'unreviewed-proof';
    },
    (result) => {
      result.lifecycleProofs[0].unexpected = true;
    },
    (result) => {
      result.lifecycle.session = 'x'.repeat(
        result.lifecycleSources.session.normalizedRecordCount,
      );
    },
  ];

  for (const mutate of mutations) {
    const candidateResults = [
      structuredClone(CLI_LIFECYCLE_FIXTURES.candidate1),
      structuredClone(CLI_LIFECYCLE_FIXTURES.candidate2),
    ];
    mutate(candidateResults[0]);
    assert.equal(evaluateMatrixScenarioEvidence({
      ...MANIFEST_EXPECTATIONS,
      scenario: cliScenario,
      oldResults: [
        CLI_LIFECYCLE_FIXTURES.old1,
        CLI_LIFECYCLE_FIXTURES.old2,
      ],
      candidateResults,
    }).pass, false);
  }

  const oldResults = [
    structuredClone(CLI_LIFECYCLE_FIXTURES.old1),
    structuredClone(CLI_LIFECYCLE_FIXTURES.old2),
  ];
  // A proof retained for a reminder the old transcript no longer contains is
  // stale: the old version is declared to emit exactly one.
  oldResults[0].lifecycle.session = oldResults[0].lifecycle.session.filter(
    (record) => record.attachmentType !== 'task_reminder',
  );
  oldResults[0].lifecycleSources.session.rawRecordCount -= 1;
  oldResults[0].lifecycleSources.session.normalizedRecordCount -= 1;
  assert.equal(evaluateMatrixScenarioEvidence({
    ...MANIFEST_EXPECTATIONS,
    scenario: cliScenario,
    oldResults,
    candidateResults: [
      CLI_LIFECYCLE_FIXTURES.candidate1,
      CLI_LIFECYCLE_FIXTURES.candidate2,
    ],
  }).pass, false);
});

function cliScenarioWithProjectedBaseline() {
  const scenario = structuredClone(
    manifest.scenarios.find(({ id }) => id === 'cli-contract'),
  );
  scenario.comparison.lifecycle.projectedBaseline = {
    session: structuredClone(CLI_SESSION_PROJECTION),
    hooks: structuredClone(CLI_TRANSPORT_HOOKS),
  };
  return scenario;
}

function evaluateSharedCliLifecycleLoss(mutate) {
  const results = {
    oldResults: [
      structuredClone(CLI_LIFECYCLE_FIXTURES.old1),
      structuredClone(CLI_LIFECYCLE_FIXTURES.old2),
    ],
    candidateResults: [
      structuredClone(CLI_LIFECYCLE_FIXTURES.candidate1),
      structuredClone(CLI_LIFECYCLE_FIXTURES.candidate2),
    ],
  };
  for (const result of [...results.oldResults, ...results.candidateResults]) {
    mutate(result.lifecycle);
  }
  return results;
}

test('CLI lifecycle comparison rejects shared reply transport loss', async () => {
  const { evaluateMatrixScenarioEvidence } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const results = evaluateSharedCliLifecycleLoss((lifecycle) => {
    const preIndex = lifecycle.hooks.findIndex((record, index) => (
      record.hookEventName === 'PreToolUse'
      && record.toolName === REPLY_TOOL
      && lifecycle.hooks[index + 1]?.hookEventName === 'PostToolUse'
      && lifecycle.hooks[index + 1]?.toolName === REPLY_TOOL
    ));
    lifecycle.hooks.splice(preIndex, 2);
  });

  assert.equal(evaluateMatrixScenarioEvidence({
    ...MANIFEST_EXPECTATIONS,
    scenario: cliScenarioWithProjectedBaseline(),
    ...results,
  }).pass, false);
});

test('CLI lifecycle comparison rejects shared pivotal session loss', async () => {
  const { evaluateMatrixScenarioEvidence } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const results = evaluateSharedCliLifecycleLoss((lifecycle) => {
    const lastTurnDuration = lifecycle.session.findLastIndex(
      (record) => (
        record.type === 'system'
        && record.subtype === 'turn_duration'
      ),
    );
    lifecycle.session.splice(lastTurnDuration, 1);
  });

  assert.equal(evaluateMatrixScenarioEvidence({
    ...MANIFEST_EXPECTATIONS,
    scenario: cliScenarioWithProjectedBaseline(),
    ...results,
  }).pass, false);
});

const AUTHORITATIVE_RUN_COUNT = 24;

function acceptedGateRuns(runPrefix = 'matrix', executablePath = null) {
  return Array.from({ length: AUTHORITATIVE_RUN_COUNT }, (_, index) => ({
    id: `old:sdk-resume:${index + 1}`,
    scenarioId: 'sdk-resume',
    versionKey: 'old',
    version: OLD_VERSION,
    expectations: OLD_EXPECTATIONS,
    model: 'claude-sonnet-4-6',
    expectedResolvedModel: 'claude-sonnet-4-6',
    effort: 'medium',
    env: {
      CLAUDE_GATE_BIN: executablePath,
      CLAUDE_GATE_RUN_ID: `${runPrefix}-old-sdk-resume-${index + 1}`,
    },
    driver: `driver-${index + 1}.mjs`,
    args: [],
    cost: { usdEstimate: 0, destructive: false },
    oracle: `oracle-${index + 1}`,
    artifactCollector: `collector-${index + 1}`,
    pairComparisonRequired: false,
  }));
}

function acceptedGateScenarios() {
  return [{
    id: 'sdk-resume',
    candidateOnly: true,
    comparison: null,
  }];
}

function acceptedGateSummary(
  runs,
  manifestSha256 = 'a'.repeat(64),
  waivedCells = [],
) {
  return {
    schemaVersion: 1,
    runPrefix: 'matrix',
    authoritative: true,
    selectedRunCount: runs.length,
    expectedAuthoritativeRunCount: runs.length,
    manifestSha256,
    waivedCells,
    results: runs.map((run, index) => ({
      id: run.id,
      runId: run.env.CLAUDE_GATE_RUN_ID,
      status: 'PASS',
      exitCode: 0,
      elapsedMs: index,
      driver: run.driver,
      args: run.args,
      cost: run.cost,
      oracle: run.oracle,
      artifactCollector: run.artifactCollector,
      artifactValidation: { pass: true, reasons: [] },
      pairComparison: null,
    })),
    completedRunCount: runs.length,
    passCount: runs.length,
    notApplicableCount: 0,
    failCount: 0,
    blockedCount: 0,
    maxBridgeReadyToMcpReadyMs: 0,
    status: 'PASS',
  };
}

function createAcceptedGateFixture(dir, runPrefix = 'matrix') {
  const executablePath = path.join(dir, 'claude-2.1.220');
  fs.writeFileSync(executablePath, 'immutable selected binary', { mode: 0o700 });
  const realExecutable = fs.realpathSync(executablePath);
  const sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(realExecutable))
    .digest('hex');
  const executablePathHash = crypto.createHash('sha256')
    .update(realExecutable)
    .digest('hex');
  const runs = acceptedGateRuns(runPrefix, executablePath);
  const results = [];
  for (const [index, run] of runs.entries()) {
    const runDir = path.join(dir, run.env.CLAUDE_GATE_RUN_ID);
    const privateArtifactDir = path.join(runDir, 'raw-private');
    fs.mkdirSync(privateArtifactDir, { recursive: true, mode: 0o700 });
    const pid = 2200 + index;
    const processEvidence = {
      rootPids: [pid],
      selectedBinaryPids: [pid],
      selectedBinaryProcesses: [{ pid, ppid: pid - 1 }],
      sampleCount: 1,
      samplingFailed: false,
      samplingFailureCount: 0,
      samplingErrorHash: null,
    };
    const result = {
      evidenceSchemaVersion: 1,
      matrixScenario: 'sdk-resume',
      scenario: 'sdk-resume',
      status: 'PASS',
      attestation: {
        runId: run.env.CLAUDE_GATE_RUN_ID,
        version: run.version,
        sha256,
        executablePathHash,
        wrapperRequired: true,
        model: run.model,
        effort: run.effort,
      },
      resolvedModel: run.expectedResolvedModel,
      lifecycle: [{ type: 'result', subtype: 'success' }],
      wrapperRecords: [],
      processEvidence,
      firstSessionPresent: true,
      secondSessionPresent: true,
      firstResultSubtype: 'success',
      secondResultSubtype: 'success',
      markerRecalled: true,
      reasonCount: 0,
    };
    fs.writeFileSync(
      path.join(privateArtifactDir, 'sdk-process-evidence.json'),
      `${JSON.stringify(processEvidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(privateArtifactDir, 'sdk-process-snapshots.ndjson'),
      `${JSON.stringify({
        sampleIndex: 1,
        activeRootPids: [pid],
        processes: [{
          pid,
          ppid: pid - 1,
          executable: realExecutable,
        }],
      })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(runDir, 'sanitized-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 },
    );
    results.push(result);
  }
  return {
    runs,
    results,
    scenarios: acceptedGateScenarios(),
  };
}

test('accepted matrix cleanup rejects a forgeable one-cell authoritative summary', async (t) => {
  const dir = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'polygram-gate-incomplete-summary-',
  ));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const runId = 'matrix-old-sdk-resume';
  const runDir = path.join(dir, runId);
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.mkdirSync(path.join(runDir, 'raw-private'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(runDir, 'sanitized-result.json'),
    '{"status":"PASS"}',
    { mode: 0o600 },
  );

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const expectedRuns = acceptedGateRuns();
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    claudeProjectsDir: path.join(dir, 'fake-claude-projects'),
    expectedManifestSha256: 'a'.repeat(64),
    expectedRuns,
    summary: {
      schemaVersion: 1,
      manifestSha256: 'a'.repeat(64),
      authoritative: true,
      status: 'PASS',
      runPrefix: 'matrix',
      selectedRunCount: 1,
      expectedAuthoritativeRunCount: 1,
      completedRunCount: 1,
      passCount: 1,
      failCount: 0,
      blockedCount: 0,
      maxBridgeReadyToMcpReadyMs: 0,
      results: [{ status: 'PASS', runId }],
    },
  }), /complete authoritative PASS/);

  const duplicateSummary = acceptedGateSummary(expectedRuns);
  duplicateSummary.results[1].id = duplicateSummary.results[0].id;
  duplicateSummary.results[1].runId = duplicateSummary.results[0].runId;
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    claudeProjectsDir: path.join(dir, 'fake-claude-projects'),
    expectedManifestSha256: 'a'.repeat(64),
    expectedRuns,
    summary: duplicateSummary,
  }), /complete authoritative PASS/);

  // NOT-APPLICABLE is reserved for the snapshot cell; any other cell must
  // PASS for the matrix to be accepted.
  const notApplicableSummary = acceptedGateSummary(expectedRuns);
  notApplicableSummary.results[0].status = 'NOT-APPLICABLE';
  notApplicableSummary.results[0].exitCode = 3;
  notApplicableSummary.passCount -= 1;
  notApplicableSummary.notApplicableCount = 1;
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    claudeProjectsDir: path.join(dir, 'fake-claude-projects'),
    expectedManifestSha256: 'a'.repeat(64),
    expectedRuns,
    summary: notApplicableSummary,
  }), /complete authoritative PASS/);

  const invalidArtifactSummary = acceptedGateSummary(expectedRuns);
  invalidArtifactSummary.results[0].artifactValidation.pass = false;
  invalidArtifactSummary.results[0].artifactValidation.reasons = ['missing'];
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    claudeProjectsDir: path.join(dir, 'fake-claude-projects'),
    expectedManifestSha256: 'a'.repeat(64),
    expectedRuns,
    summary: invalidArtifactSummary,
  }), /complete authoritative PASS/);

  const pairRequiredRuns = structuredClone(expectedRuns);
  pairRequiredRuns[0].pairComparisonRequired = true;
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    claudeProjectsDir: path.join(dir, 'fake-claude-projects'),
    expectedManifestSha256: 'a'.repeat(64),
    expectedRuns: pairRequiredRuns,
    summary: acceptedGateSummary(pairRequiredRuns),
  }), /complete authoritative PASS/);

  assert.equal(fs.existsSync(path.join(runDir, 'raw-private')), true);
});

test('accepted matrix cleanup revalidates retained evidence before purging it', async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'polygram-gate-accept-revalidation-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const mutations = [
    {
      name: 'malformed sanitized artifact',
      apply({ dir, runs }) {
        fs.writeFileSync(
          path.join(
            dir,
            runs[0].env.CLAUDE_GATE_RUN_ID,
            'sanitized-result.json',
          ),
          '{"status":"PASS"}\n',
          { mode: 0o600 },
        );
      },
    },
    {
      name: 'swapped sanitized artifacts',
      apply({ dir, runs }) {
        const left = path.join(
          dir,
          runs[0].env.CLAUDE_GATE_RUN_ID,
          'sanitized-result.json',
        );
        const right = path.join(
          dir,
          runs[1].env.CLAUDE_GATE_RUN_ID,
          'sanitized-result.json',
        );
        const leftContent = fs.readFileSync(left);
        const rightContent = fs.readFileSync(right);
        fs.writeFileSync(left, rightContent, { mode: 0o600 });
        fs.writeFileSync(right, leftContent, { mode: 0o600 });
      },
    },
    {
      name: 'forged pair-comparison success',
      apply({ summary }) {
        summary.results[0].pairComparison = {
          pass: true,
          comparisons: [{
            id: 'forged',
            pass: true,
            differences: [],
          }],
        };
      },
    },
  ];

  for (const [index, mutation] of mutations.entries()) {
    const dir = path.join(root, `case-${index + 1}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    const {
      runs,
      scenarios: expectedScenarios,
    } = createAcceptedGateFixture(dir);
    const summary = acceptedGateSummary(runs);
    mutation.apply({ dir, runs, summary });
    assert.throws(() => purgeAcceptedGateArtifacts({
      artifactBaseDir: dir,
      runPrefix: 'matrix',
      claudeProjectsDir: path.join(dir, 'fake-claude-projects'),
      expectedManifestSha256: 'a'.repeat(64),
      expectedRuns: runs,
      expectedScenarios,
      summary,
    }), /revalidate|comparison/, mutation.name);
    assert.equal(
      fs.existsSync(path.join(
        dir,
        runs[0].env.CLAUDE_GATE_RUN_ID,
        'raw-private',
      )),
      true,
      mutation.name,
    );
  }
});

test('accepted matrix cleanup binds startup handshakes to revalidated evidence', async () => {
  const { acceptedStartupHandshakeSummaryMatches } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const expectedRuns = [
    { maxBridgeReadyToMcpReadyMs: 20_000 },
    {},
    { maxBridgeReadyToMcpReadyMs: 20_000 },
  ];
  const sanitizedResults = [
    {
      startupHandshake: {
        bridgeReadyMs: 1_000,
        mcpReadyMs: 2_250,
        bridgeReadyToMcpReadyMs: 1_250,
      },
    },
    {},
    {
      startupHandshake: {
        bridgeReadyMs: 3_000,
        mcpReadyMs: 4_500,
        bridgeReadyToMcpReadyMs: 1_500,
      },
    },
  ];
  const summaryResults = sanitizedResults.map((result) => (
    result.startupHandshake
      ? { startupHandshake: structuredClone(result.startupHandshake) }
      : {}
  ));

  assert.equal(acceptedStartupHandshakeSummaryMatches({
    expectedRuns,
    sanitizedResults,
    summaryResults,
    summaryMaximumMs: 1_500,
  }), true);
  assert.equal(acceptedStartupHandshakeSummaryMatches({
    expectedRuns,
    sanitizedResults,
    summaryResults: summaryResults.map((result, index) => (
      index === 0
        ? { startupHandshake: 'PRIVATE-FORGED-HANDSHAKE' }
        : result
    )),
    summaryMaximumMs: 1_500,
  }), false);
  assert.equal(acceptedStartupHandshakeSummaryMatches({
    expectedRuns,
    sanitizedResults,
    summaryResults,
    summaryMaximumMs: 0,
  }), false);
});

test('accepted matrix cleanup accepts waived cells only when the summary lists them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-known-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const { runs, scenarios } = createAcceptedGateFixture(dir);
  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const waivedCells = [
    {
      id: 'old:delayed-mcp',
      version: OLD_VERSION,
      waiver: 'not-gated',
      reason: 'opt-in path unused in production',
    },
    {
      id: 'candidate:delayed-mcp',
      version: CANDIDATE_VERSION,
      waiver: 'known-regression',
      reason: 'declared upstream regression',
    },
  ];
  const expectedRuns = runs.slice(0, AUTHORITATIVE_RUN_COUNT - waivedCells.length);
  const purge = (summary, expectedWaivedCells) => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    claudeProjectsDir: path.join(dir, 'fake-claude-projects'),
    expectedRuns,
    expectedScenarios: scenarios,
    expectedManifestSha256: 'a'.repeat(64),
    expectedWaivedCells,
    summary,
  });
  // A summary that silently drops a waived cell is not authoritative.
  assert.throws(
    () => purge(acceptedGateSummary(expectedRuns), waivedCells),
    /complete authoritative PASS/,
  );
  assert.throws(
    () => purge(
      acceptedGateSummary(expectedRuns, 'a'.repeat(64), waivedCells.slice(1)),
      waivedCells,
    ),
    /complete authoritative PASS/,
  );
  // Nor may cells short of the full matrix pass without a declaration.
  assert.throws(
    () => purge(acceptedGateSummary(expectedRuns), []),
    /complete authoritative PASS/,
  );
  purge(
    acceptedGateSummary(expectedRuns, 'a'.repeat(64), waivedCells),
    waivedCells,
  );
  assert.equal(
    fs.existsSync(path.join(dir, expectedRuns[0].env.CLAUDE_GATE_RUN_ID, 'raw-private')),
    false,
  );
});

test('accepted matrix cleanup removes private evidence and preserves sanitized results', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-accept-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const {
    runs: expectedRuns,
    scenarios: expectedScenarios,
  } = createAcceptedGateFixture(dir);
  const runId = expectedRuns[0].env.CLAUDE_GATE_RUN_ID;
  const runDir = path.join(dir, runId);
  fs.writeFileSync(path.join(runDir, 'run-metadata.json'), '{}', { mode: 0o600 });
  const sdkCwd = path.join(runDir, 'sdk.workspace');
  fs.mkdirSync(sdkCwd, { mode: 0o700 });
  const emptySdkCwd = path.join(runDir, 'empty-sdk.workspace');
  fs.mkdirSync(emptySdkCwd, { mode: 0o700 });
  fs.writeFileSync(
    path.join(runDir, 'session-projects.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      projects: [
        { cwd: sdkCwd, sessionIds: ['gate-session-1'] },
        { cwd: emptySdkCwd, sessionIds: [] },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const claudeProjectsDir = path.join(dir, 'fake-claude-projects');
  fs.mkdirSync(claudeProjectsDir, { mode: 0o700 });
  const sourceProjectDir = path.join(
    claudeProjectsDir,
    encodeCwd(fs.realpathSync(sdkCwd)),
  );
  fs.mkdirSync(sourceProjectDir, { mode: 0o700 });
  const unrelatedSessionPath = path.join(sourceProjectDir, 'private.jsonl');
  fs.writeFileSync(unrelatedSessionPath, 'raw', {
    mode: 0o600,
  });
  const gateSessionPath = path.join(
    sourceProjectDir,
    'gate-session-1.jsonl',
  );
  fs.writeFileSync(gateSessionPath, 'gate raw', {
    mode: 0o600,
  });
  fs.mkdirSync(path.join(dir, 'matrix-runner-private'), { mode: 0o700 });

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    claudeProjectsDir,
    expectedRuns,
    expectedScenarios,
    expectedManifestSha256: 'a'.repeat(64),
    summary: acceptedGateSummary(expectedRuns),
  });

  assert.equal(fs.existsSync(path.join(runDir, 'sanitized-result.json')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'raw-private')), false);
  assert.equal(fs.existsSync(path.join(runDir, 'run-metadata.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'matrix-runner-private')), false);
  assert.equal(fs.existsSync(sourceProjectDir), true);
  assert.equal(fs.existsSync(unrelatedSessionPath), true);
  assert.equal(fs.existsSync(gateSessionPath), false);
});

test('accepted matrix cleanup rejects an unsafe prefix before deleting evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-unsafe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const runId = 'matrix-old-sdk-resume';
  const runDir = path.join(dir, runId);
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.writeFileSync(path.join(runDir, 'run-metadata.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(runDir, 'sanitized-result.json'), '{}', { mode: 0o600 });

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: '../escape',
    summary: {
      authoritative: true,
      status: 'PASS',
      runPrefix: '../escape',
      selectedRunCount: 1,
      passCount: 1,
      results: [{ status: 'PASS', runId }],
    },
  }), /unsafe run prefix/);

  assert.equal(fs.existsSync(path.join(runDir, 'run-metadata.json')), true);
});

test('accepted matrix cleanup preflights every run before deleting evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const {
    runs: expectedRuns,
    scenarios: expectedScenarios,
  } = createAcceptedGateFixture(dir);
  const validRunId = expectedRuns[0].env.CLAUDE_GATE_RUN_ID;
  const validRunDir = path.join(dir, validRunId);
  fs.writeFileSync(path.join(validRunDir, 'run-metadata.json'), '{}', { mode: 0o600 });
  fs.rmSync(
    path.join(dir, expectedRuns.at(-1).env.CLAUDE_GATE_RUN_ID),
    { recursive: true },
  );

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    expectedRuns,
    expectedScenarios,
    expectedManifestSha256: 'a'.repeat(64),
    summary: acceptedGateSummary(expectedRuns),
  }), /run artifact directory/);

  assert.equal(fs.existsSync(path.join(validRunDir, 'run-metadata.json')), true);
});

test('accepted matrix cleanup rejects a session project outside its run', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-project-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const {
    runs: expectedRuns,
    scenarios: expectedScenarios,
  } = createAcceptedGateFixture(dir);
  const runId = expectedRuns[0].env.CLAUDE_GATE_RUN_ID;
  const runDir = path.join(dir, runId);
  fs.writeFileSync(path.join(runDir, 'run-metadata.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(
    path.join(runDir, 'session-projects.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      projects: [{ cwd: dir, sessionIds: ['gate-session-1'] }],
    })}\n`,
    { mode: 0o600 },
  );

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    expectedRuns,
    expectedScenarios,
    expectedManifestSha256: 'a'.repeat(64),
    summary: acceptedGateSummary(expectedRuns),
  }), /escapes the dedicated artifact base/);

  assert.equal(fs.existsSync(path.join(runDir, 'run-metadata.json')), true);
});

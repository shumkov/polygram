const assert = require('node:assert/strict');
const { test } = require('node:test');

function foregroundEvidence() {
  return {
    expectedMode: 'foreground',
    thresholdMs: 1_000,
    handlerDurationMs: 1_500,
    toolUseCount: 1,
    markerCount: 1,
    resultSubtype: 'success',
    toolResultBeforeHandlerCompletion: false,
    nativeLifecycleProof: {
      schemaVersion: 1,
      expectedMode: 'foreground',
      counts: {
        targetToolUse: 1,
        targetToolResult: 1,
        nonEmptyMembership: 0,
        emptyMembership: 0,
        taskStarted: 0,
        taskCompleted: 0,
        taskNotification: 0,
        marker: 1,
      },
      ordinals: {
        toolUse: 10,
        membershipListed: null,
        taskStarted: null,
        toolResult: 11,
        membershipCleared: null,
        taskCompleted: null,
        taskNotification: null,
        marker: 12,
      },
      membership: {
        listedTaskCount: null,
        clearedTaskCount: null,
      },
      correlations: {
        listedTaskIsTargetMcp: null,
        startedTaskIsTargetMcp: null,
        listedTaskMatchesStarted: null,
        startedToolUseMatchesTarget: null,
        toolResultMatchesTarget: true,
        completedTaskMatchesStarted: null,
        notificationTaskMatchesStarted: null,
        notificationToolUseMatchesTarget: null,
      },
      statuses: {
        asyncPlaceholder: false,
        taskCompleted: false,
        notificationCompleted: false,
      },
      timing: {
        asyncResultDelayMs: null,
        asyncResultLeadMs: null,
      },
    },
  };
}

function candidateEvidence() {
  return {
    expectedMode: 'background',
    thresholdMs: 1_000,
    handlerDurationMs: 5_003,
    toolUseCount: 1,
    markerCount: 1,
    resultSubtype: 'success',
    toolResultBeforeHandlerCompletion: true,
    nativeLifecycleProof: {
      schemaVersion: 1,
      expectedMode: 'background',
      counts: {
        targetToolUse: 1,
        targetToolResult: 1,
        nonEmptyMembership: 1,
        emptyMembership: 1,
        taskStarted: 1,
        taskCompleted: 1,
        taskNotification: 1,
        marker: 1,
      },
      ordinals: {
        toolUse: 14,
        membershipListed: 15,
        taskStarted: 16,
        toolResult: 17,
        membershipCleared: 23,
        taskCompleted: 24,
        taskNotification: 25,
        marker: 27,
      },
      membership: {
        listedTaskCount: 1,
        clearedTaskCount: 0,
      },
      correlations: {
        listedTaskIsTargetMcp: true,
        startedTaskIsTargetMcp: true,
        listedTaskMatchesStarted: true,
        startedToolUseMatchesTarget: true,
        toolResultMatchesTarget: true,
        completedTaskMatchesStarted: true,
        notificationTaskMatchesStarted: true,
        notificationToolUseMatchesTarget: true,
      },
      statuses: {
        asyncPlaceholder: true,
        taskCompleted: true,
        notificationCompleted: true,
      },
      timing: {
        asyncResultDelayMs: 1_002,
        asyncResultLeadMs: 4_001,
      },
    },
  };
}

test('delayed MCP prompt cannot disclose the tool-only completion marker', async () => {
  const { buildDelayedMcpGatePrompt } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );
  const prompt = buildDelayedMcpGatePrompt();

  assert.doesNotMatch(prompt, /MCP-COMPLETE|2\.1\.220|completion marker:/i);
  assert.match(prompt, /marker returned by the tool/i);
});

test('delayed MCP comparator accepts the old foreground completion shape', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );

  const result = evaluateDelayedMcpEvidence(foregroundEvidence());

  assert.deepEqual(result, { pass: true, reasons: [] });
});

test('2.1.220 delayed MCP accepts the reproduced correlated native background shape', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );

  const result = evaluateDelayedMcpEvidence(candidateEvidence());

  assert.deepEqual(result, { pass: true, reasons: [] });
});

test('delayed MCP comparator rejects silent and duplicate candidate delivery', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );

  const result = evaluateDelayedMcpEvidence({
    ...candidateEvidence(),
    markerCount: 2,
    toolResultBeforeHandlerCompletion: false,
    nativeLifecycleProof: {
      ...candidateEvidence().nativeLifecycleProof,
      counts: {
        ...candidateEvidence().nativeLifecycleProof.counts,
        marker: 2,
        taskStarted: 0,
        taskNotification: 0,
      },
    },
  });

  assert.equal(result.pass, false);
  assert.match(result.reasons.join('\n'), /exactly one marker/);
  assert.match(result.reasons.join('\n'), /before the handler completed/);
  assert.match(result.reasons.join('\n'), /native lifecycle proof/);
});

test('delayed MCP rejects mismatched identities and reordered terminal evidence', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );
  const mismatched = candidateEvidence();
  mismatched.nativeLifecycleProof.correlations.notificationToolUseMatchesTarget = false;
  assert.equal(evaluateDelayedMcpEvidence(mismatched).pass, false);

  const reordered = candidateEvidence();
  reordered.nativeLifecycleProof.ordinals.taskNotification =
    reordered.nativeLifecycleProof.ordinals.taskCompleted - 1;
  assert.equal(evaluateDelayedMcpEvidence(reordered).pass, false);
});

test('delayed MCP accepts either clear/update order but enforces threshold timing and lead', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );
  const clearAfterUpdate = candidateEvidence();
  [
    clearAfterUpdate.nativeLifecycleProof.ordinals.membershipCleared,
    clearAfterUpdate.nativeLifecycleProof.ordinals.taskCompleted,
  ] = [
    clearAfterUpdate.nativeLifecycleProof.ordinals.taskCompleted,
    clearAfterUpdate.nativeLifecycleProof.ordinals.membershipCleared,
  ];
  assert.equal(evaluateDelayedMcpEvidence(clearAfterUpdate).pass, true);

  for (const timing of [
    { asyncResultDelayMs: 749, asyncResultLeadMs: 4_254 },
    { asyncResultDelayMs: 3_001, asyncResultLeadMs: 2_002 },
    { asyncResultDelayMs: 1_002, asyncResultLeadMs: 1_999 },
  ]) {
    const invalid = candidateEvidence();
    invalid.nativeLifecycleProof.timing = timing;
    assert.equal(evaluateDelayedMcpEvidence(invalid).pass, false);
  }
});

test('delayed MCP proof rejects missing and unknown fields', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );
  const missing = candidateEvidence();
  delete missing.nativeLifecycleProof.correlations.completedTaskMatchesStarted;
  assert.equal(evaluateDelayedMcpEvidence(missing).pass, false);

  const unknown = candidateEvidence();
  unknown.nativeLifecycleProof.ordinals.backgroundTransition = 18;
  assert.equal(evaluateDelayedMcpEvidence(unknown).pass, false);
});

test('delayed MCP evidence rejects unknown fields and type coercion', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );

  for (const invalid of [
    { ...candidateEvidence(), privateDiagnostic: 'raw' },
    { ...candidateEvidence(), thresholdMs: '1000' },
    {
      ...candidateEvidence(),
      toolResultBeforeHandlerCompletion: 'yes',
    },
    {
      ...candidateEvidence(),
      nativeLifecycleProof: {
        ...candidateEvidence().nativeLifecycleProof,
        timing: {
          asyncResultDelayMs: '1002',
          asyncResultLeadMs: 4_001,
        },
      },
    },
  ]) {
    assert.equal(evaluateDelayedMcpEvidence(invalid).pass, false);
  }
});

test('2.1.220 delayed MCP counts only the target result when ToolSearch and TaskGet follow', async () => {
  const { isTargetDelayedMcpToolResult } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );
  const blocks = [
    { type: 'tool_result', tool_use_id: 'delayed-target' },
    { type: 'tool_result', tool_use_id: 'tool-search' },
    { type: 'tool_result', tool_use_id: 'task-get' },
  ];

  assert.equal(
    blocks.filter((block) => (
      isTargetDelayedMcpToolResult(block, 'delayed-target')
    )).length,
    1,
  );
});

test('delayed MCP structural proof is regenerated from private SDK records', async () => {
  const {
    createDelayedMcpLifecycleProof,
  } = await import('../scripts/spikes/delayed-mcp-gate.mjs');
  const marker = 'MCP-COMPLETE:2.1.220:abcd1234';
  const markerHash = require('node:crypto')
    .createHash('sha256')
    .update(marker)
    .digest('hex');
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
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{
        task_id: 'task-1',
        task_type: 'mcp_task',
        description: 'polygram-delayed-gate/delayed_marker',
      }],
    },
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      task_type: 'mcp_task',
      description: 'polygram-delayed-gate/delayed_marker',
    },
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
        }],
      },
    },
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
    },
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-1',
      patch: { status: 'completed' },
    },
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      status: 'completed',
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: marker }],
      },
    },
  ];

  const proof = createDelayedMcpLifecycleProof(records, {
    expectedMode: 'background',
    markerHash,
    asyncPlaceholder: true,
    timing: {
      asyncResultDelayMs: 1_002,
      asyncResultLeadMs: 4_001,
    },
  });
  assert.deepEqual(proof.counts, {
    targetToolUse: 1,
    targetToolResult: 1,
    nonEmptyMembership: 1,
    emptyMembership: 1,
    taskStarted: 1,
    taskCompleted: 1,
    taskNotification: 1,
    marker: 1,
  });
  assert.equal(proof.correlations.listedTaskMatchesStarted, true);
  assert.equal(proof.correlations.notificationTaskMatchesStarted, true);

  records[6].task_id = 'task-other';
  assert.equal(createDelayedMcpLifecycleProof(records, {
    expectedMode: 'background',
    markerHash,
    asyncPlaceholder: true,
    timing: proof.timing,
  }).correlations.notificationTaskMatchesStarted, false);
});

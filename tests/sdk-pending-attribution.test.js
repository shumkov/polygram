const { test } = require('node:test');
const assert = require('node:assert/strict');

async function evaluate(overrides = {}) {
  const { evaluatePendingAttribution } = await import('../scripts/spikes/sdk-pending-attribution-oracle.mjs');
  return evaluatePendingAttribution({
    actualPermissionMode: 'auto', failure: null, taskCount: 2, notificationCount: 2, followupsQueued: true,
    tasks: [{ taskId: 'agent-a', runId: 'run-a', notified: true }, { taskId: 'agent-b', runId: 'run-b', notified: true }],
    rawResults: [
      { subtype: 'success', isError: false, numTurns: 1, textPresent: true, originKind: 'peer', senderTaskId: 'agent-a', before: [2, 3], after: [2, 3], notificationCount: 2, notificationTaskIds: ['agent-a', 'agent-b'] },
      { subtype: 'success', isError: false, numTurns: 0, textPresent: false, originKind: 'task-notification', originRunId: 'run-b', before: [2, 3], after: [2, 3], notificationCount: 2, notificationTaskIds: ['agent-a', 'agent-b'] },
    ],
    completions: [1, 2, 3].map((sourceMsgId) => ({ sourceMsgId, markerMatches: [1, 2, 3].map((id) => id === sourceMsgId) })),
    ...overrides,
  });
}

test('batched empty results must overlap pending user work and task reports', async () => {
  assert.equal((await evaluate()).status, 'PASS');
  for (const witness of [{ before: [], after: [], notificationCount: 2 }, { before: [2], after: [2], notificationCount: 0 }, { before: [2], after: [], notificationCount: 2 }]) {
    assert.equal((await evaluate({ rawResults: [{ subtype: 'success', isError: false, numTurns: 0, textPresent: false, ...witness }] })).status, 'INCONCLUSIVE');
  }
});

test('a wrong completed marker fails even while other prompts remain unsettled', async () => {
  assert.equal((await evaluate({ completions: [{ sourceMsgId: 2, markerMatches: [true, false, false] }] })).status, 'FAIL');
});

test('provider errors and missing auto capability cannot prove batching compatibility', async () => {
  assert.equal((await evaluate({ rawResults: [{ subtype: 'success', isError: true, numTurns: 0, textPresent: false, before: [2], after: [2], notificationCount: 2 }] })).status, 'INCONCLUSIVE');
  assert.equal((await evaluate({ actualPermissionMode: 'bypassPermissions' })).status, 'INCONCLUSIVE');
  assert.equal((await evaluate({ rawResults: [] })).status, 'INCONCLUSIVE');
});


test('cleanup rejection and incomplete evidence remain inconclusive', async () => {
  assert.equal((await evaluate({ failure: 'observation-deadline', completions: [{ sourceMsgId: 1, rejected: true }] })).status, 'INCONCLUSIVE');
  assert.equal((await evaluate({ completions: [1, 1, 1].map((sourceMsgId) => ({ sourceMsgId, markerMatches: [true, false, false] })) })).status, 'INCONCLUSIVE');
});

test('fixture sleep hook prevents native Bash detachment without changing permission decisions', async () => {
  const { foregroundFixtureSleep } = await import('../scripts/spikes/sdk-pending-attribution-oracle.mjs');
  for (const seconds of [20, 22, 30]) {
    const input = { tool_name: 'Bash', tool_input: { command: `sleep ${seconds}`, description: 'synthetic hold' } };
    const reply = foregroundFixtureSleep(input);
    assert.deepEqual(reply, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, timeout: 60000, run_in_background: false } } });
    assert.equal(input.tool_input.timeout, undefined);
  }
  for (const input of [{ tool_name: 'Bash', tool_input: { command: 'sleep 30; echo other' } }, { tool_name: 'Agent', tool_input: { command: 'sleep 30' } }, {}]) {
    assert.deepEqual(foregroundFixtureSleep(input), {});
  }
});

test('legacy pair needs real overlapping report completion without claiming a zero-turn capability', async () => {
  const reports = ['agent-a', 'agent-b'].map(senderTaskId => ({ subtype: 'success', isError: false, numTurns: 1, textPresent: true,
    originKind: 'peer', senderTaskId, before: [2, 3], after: [2, 3], notificationCount: 2, notificationTaskIds: ['agent-a', 'agent-b'] }));
  assert.equal((await evaluate({ rawResults: reports, requireEmptyWitness: false })).status, 'PASS');
  assert.equal((await evaluate({ rawResults: reports })).status, 'INCONCLUSIVE');
  assert.equal((await evaluate({ rawResults: reports.slice(0, 1), requireEmptyWitness: false })).status, 'INCONCLUSIVE');
});

test('duplicate or unrelated reports cannot prove two distinct started-agent terminals', async () => {
  const reports = [1, 2].map(() => ({ subtype: 'success', isError: false, numTurns: 0, textPresent: false,
    originKind: 'task-notification', originRunId: 'unrelated', before: [2, 3], after: [2, 3], notificationCount: 2 }));
  assert.equal((await evaluate({ rawResults: reports })).status, 'INCONCLUSIVE');
  assert.equal((await evaluate({ rawResults: reports, requireEmptyWitness: false })).status, 'INCONCLUSIVE');
});

test('followups wait for a real autonomous report frame rather than task startup', async () => {
  const { pendingAttributionFollowupReady } = await import('../scripts/spikes/sdk-pending-attribution-oracle.mjs');
  const ready = { message: { type: 'assistant', parent_tool_use_id: null }, actualPermissionMode: 'auto', firstUserCompleted: true, pendingCount: 0, taskCount: 2, notificationCount: 2 };
  assert.equal(pendingAttributionFollowupReady(ready), true);
  for (const change of [{ message: { type: 'system', subtype: 'task_started' } }, { message: { type: 'assistant', parent_tool_use_id: 'child' } },
    { firstUserCompleted: false }, { pendingCount: 1 }, { taskCount: 1 }, { actualPermissionMode: 'bypassPermissions' }]) {
    assert.equal(pendingAttributionFollowupReady({ ...ready, ...change }), false);
  }
});

test('both distinct reports need completion evidence while only one needs user overlap', async () => {
  const reports = [
    { subtype: 'success', isError: false, numTurns: 1, textPresent: true, originKind: 'peer', senderTaskId: 'agent-a', before: [], after: [], notificationCount: 1, notificationTaskIds: ['agent-a'] },
    { subtype: 'success', isError: false, numTurns: 0, textPresent: false, originKind: 'task-notification', originRunId: 'run-b', before: [2, 3], after: [2, 3], notificationCount: 2, notificationTaskIds: ['agent-a', 'agent-b'] },
  ];
  assert.equal((await evaluate({ rawResults: reports })).status, 'PASS');
  assert.equal((await evaluate({ rawResults: reports.map(r => ({ ...r, before: [], after: [] })) })).status, 'INCONCLUSIVE');
});

test('legacy peer handbacks can precede their matching completed notification edges', async () => {
  const reports = ['agent-a', 'agent-b'].map(senderTaskId => ({ subtype: 'success', isError: false, numTurns: 1, textPresent: true,
    originKind: 'peer', senderTaskId, before: [2, 3], after: [2, 3], notificationCount: 0, notificationTaskIds: [] }));
  assert.equal((await evaluate({ rawResults: reports, requireEmptyWitness: false })).status, 'PASS');
  assert.equal((await evaluate({ rawResults: reports, requireEmptyWitness: false, notificationCount: 1 })).status, 'INCONCLUSIVE');
});

test('genuine autonomous frame can trigger followups before late notification edges', async () => {
  const { pendingAttributionFollowupReady } = await import('../scripts/spikes/sdk-pending-attribution-oracle.mjs');
  assert.equal(pendingAttributionFollowupReady({ message: { type: 'assistant' }, actualPermissionMode: 'auto',
    firstUserCompleted: true, pendingCount: 0, taskCount: 2, notificationCount: 0 }), true);
});

test('candidate zero-turn witness needs task-notification run provenance, not a peer ID alone', async () => {
  const reports = ['agent-a', 'agent-b'].map(senderTaskId => ({ subtype: 'success', isError: false, numTurns: 0, textPresent: false,
    originKind: 'peer', senderTaskId, before: [2, 3], after: [2, 3], notificationCount: 2 }));
  assert.equal((await evaluate({ rawResults: reports })).status, 'INCONCLUSIVE');
  assert.equal((await evaluate({ rawResults: reports, requireEmptyWitness: false })).status, 'PASS');
});

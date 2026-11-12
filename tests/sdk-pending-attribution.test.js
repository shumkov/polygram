const { test } = require('node:test');
const assert = require('node:assert/strict');

async function evaluate(overrides = {}) {
  const { evaluatePendingAttribution } = await import('../scripts/spikes/sdk-pending-attribution-oracle.mjs');
  return evaluatePendingAttribution({
    actualPermissionMode: 'auto', failure: null, taskCount: 2, notificationCount: 2, followupsQueued: true,
    rawResults: [{ subtype: 'success', isError: false, numTurns: 0, textPresent: false, before: [2, 3], after: [2, 3], notificationCount: 2 }],
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

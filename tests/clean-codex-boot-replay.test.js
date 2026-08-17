'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  scheduleCleanCodexReplaySessions,
} = require('../lib/ops/clean-codex-boot-replay');
const {
  createCleanReplaySessionCoordinator,
} = require('../lib/ops/clean-replay-session-coordinator');

test('boot scheduler runs continuation before saved followers and reports outcomes', async () => {
  const coordinator = createCleanReplaySessionCoordinator();
  const order = [];
  const tracked = [];
  const outcomes = [];
  let resolveContinuation;
  const continuation = new Promise((resolve) => {
    resolveContinuation = resolve;
  }).then(() => {
    order.push('continue');
    return { status: 'replied' };
  });

  const result = scheduleCleanCodexReplaySessions({
    candidates: [
      { session_key: 'chat:topic', msg_id: 2 },
      { session_key: 'chat:topic', msg_id: 3 },
    ],
    getSessionKey: (row) => row.session_key,
    getContinuationTasks: () => [continuation],
    coordinator,
    recover: async (row) => {
      order.push(`follower:${row.msg_id}`);
      return { status: 'dispatched' };
    },
    trackTask: (task) => tracked.push(task),
    onOutcome: (value) => outcomes.push(value),
  });

  assert.deepEqual(result, { scheduled: 2, sessions: 1 });
  await Promise.resolve();
  assert.deepEqual(order, []);
  resolveContinuation();
  await Promise.all(tracked);
  assert.deepEqual(order, ['continue', 'follower:2', 'follower:3']);
  assert.deepEqual(outcomes, [{
    sessionKey: 'chat:topic',
    outcome: {
      status: 'complete',
      admitted: 2,
      terminal: 0,
      deferred: 0,
      reason: null,
    },
  }]);
});

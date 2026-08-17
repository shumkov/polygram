'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCleanReplaySessionCoordinator,
} = require('../lib/ops/clean-replay-session-coordinator');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('recovery receipt bypasses its own barrier while ordinary ingress waits', async () => {
  const coordinator = createCleanReplaySessionCoordinator();
  const admitted = deferred();
  const recoveryStarted = deferred();
  const task = coordinator.schedule({
    sessionKey: 'chat:topic',
    continuationTasks: [Promise.resolve({ status: 'replied' })],
    followers: [{ id: 1 }],
    recover: async (follower, { receipt }) => {
      await coordinator.wait('chat:topic', receipt);
      recoveryStarted.resolve();
      await admitted.promise;
      return { status: 'dispatched', follower };
    },
  });

  let ordinaryReleased = false;
  const ordinary = coordinator.wait('chat:topic').then(() => {
    ordinaryReleased = true;
  });
  await recoveryStarted.promise;
  assert.equal(ordinaryReleased, false);

  admitted.resolve();
  assert.equal((await task).status, 'complete');
  await ordinary;
  assert.equal(ordinaryReleased, true);
});

test('two saved followers admit in order before fresh same-session work', async () => {
  const coordinator = createCleanReplaySessionCoordinator();
  const first = deferred();
  const second = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const calls = [];
  const task = coordinator.schedule({
    sessionKey: 'chat:topic',
    continuationTasks: [],
    followers: [{ id: 1 }, { id: 2 }],
    recover: async (follower, { receipt }) => {
      await coordinator.wait('chat:topic', receipt);
      calls.push(`start:${follower.id}`);
      (follower.id === 1 ? firstStarted : secondStarted).resolve();
      await (follower.id === 1 ? first.promise : second.promise);
      calls.push(`admitted:${follower.id}`);
      return { status: 'dispatched' };
    },
  });
  const ordinary = coordinator.wait('chat:topic').then(() => {
    calls.push('fresh');
  });

  await firstStarted.promise;
  assert.deepEqual(calls, ['start:1']);
  first.resolve();
  await secondStarted.promise;
  assert.deepEqual(calls, ['start:1', 'admitted:1', 'start:2']);
  second.resolve();
  await task;
  await ordinary;
  assert.deepEqual(calls, [
    'start:1',
    'admitted:1',
    'start:2',
    'admitted:2',
    'fresh',
  ]);
});

test('failed follower defers later saved work but releases fresh ingress', async () => {
  const coordinator = createCleanReplaySessionCoordinator();
  const calls = [];
  const task = coordinator.schedule({
    sessionKey: 'chat:topic',
    continuationTasks: [],
    followers: [{ id: 1 }, { id: 2 }],
    recover: async (follower) => {
      calls.push(follower.id);
      return { status: 'failed', reason: 'process-drift' };
    },
  });
  const ordinary = coordinator.wait('chat:topic').then(() => {
    calls.push('fresh');
  });

  const result = await task;
  await ordinary;
  assert.deepEqual(calls, [1, 'fresh']);
  assert.deepEqual(result, {
    status: 'deferred',
    admitted: 0,
    terminal: 0,
    deferred: 2,
    reason: 'process-drift',
  });
});

test('gate-terminal follower does not release fresh ingress before later admission', async () => {
  const coordinator = createCleanReplaySessionCoordinator();
  const secondAdmission = deferred();
  const secondStarted = deferred();
  const calls = [];
  const task = coordinator.schedule({
    sessionKey: 'chat:topic',
    continuationTasks: [],
    followers: [{ id: 1 }, { id: 2 }],
    recover: async (follower, { receipt }) => {
      await coordinator.wait('chat:topic', receipt);
      calls.push(`start:${follower.id}`);
      if (follower.id === 1) return { status: 'gate-terminal' };
      secondStarted.resolve();
      await secondAdmission.promise;
      calls.push('admitted:2');
      return { status: 'dispatched' };
    },
  });
  const ordinary = coordinator.wait('chat:topic').then(() => {
    calls.push('fresh');
  });

  await secondStarted.promise;
  assert.deepEqual(calls, ['start:1', 'start:2']);
  secondAdmission.resolve();
  assert.deepEqual(await task, {
    status: 'complete',
    admitted: 1,
    terminal: 1,
    deferred: 0,
    reason: null,
  });
  await ordinary;
  assert.deepEqual(calls, ['start:1', 'start:2', 'admitted:2', 'fresh']);
});

test('failed continuation releases the session without touching followers', async () => {
  const coordinator = createCleanReplaySessionCoordinator();
  let recovered = false;
  const task = coordinator.schedule({
    sessionKey: 'chat:topic',
    continuationTasks: [Promise.resolve({
      status: 'failed',
      reason: 'strict-resume-failed',
    })],
    followers: [{ id: 1 }],
    recover: async () => {
      recovered = true;
      return { status: 'dispatched' };
    },
  });
  const ordinary = coordinator.wait('chat:topic');

  assert.deepEqual(await task, {
    status: 'deferred',
    admitted: 0,
    terminal: 0,
    deferred: 1,
    reason: 'continuation-not-replied',
  });
  await ordinary;
  assert.equal(recovered, false);
});

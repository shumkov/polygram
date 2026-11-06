'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');

const target = { chatId: '-1001', threadId: '12', sessionKey: '-1001:12' };
const job = { id: 7, routeId: 'marketing', requestId: 'mailbox:m_0000000000000001', task: 'Envelope', payload: { body: 'x' }, target };

function fixture({ mailbox = null, notifications = null } = {}) {
  const calls = { events: [], runtime: [] };
  const dispatch = createExternalJobDispatch({
    dispatchExternalEvent: (origin, run) => { calls.events.push(origin); return run(); },
    runtime: { dispatch: async (j, hooks) => { calls.runtime.push({ job: j, hooks }); hooks.onSend?.(); hooks.onTurnId?.('turn-1'); return { outcome: 'succeeded' }; } },
    getNotifications: () => notifications, getMailbox: () => mailbox,
  });
  return { dispatch, calls };
}

test('the dispatched prompt carries both instruction blocks for the target session', async () => {
  const sessions = [];
  const f = fixture({
    notifications: { instructions: (key) => { sessions.push(key); return '\n[notify]'; } },
    mailbox: { instructions: (key) => { sessions.push(key); return '\n[mailbox]'; }, noteJobSend() {}, enabled: true },
  });
  await f.dispatch(job, {});
  assert.equal(f.calls.runtime[0].job.task, 'Envelope\n[notify]\n[mailbox]');
  assert.deepEqual(sessions, ['-1001:12', '-1001:12']);
  assert.deepEqual(f.calls.events, [{ ...target, eventId: job.requestId }]);
});

test('the send-point hook records the delivered job and keeps the caller hooks', async () => {
  const noted = []; const turns = [];
  const f = fixture({ mailbox: { instructions: () => '', noteJobSend: (j) => noted.push(j), enabled: true } });
  await f.dispatch(job, { onTurnId: (id) => turns.push(id) });
  assert.deepEqual(noted, [job], 'the depth hook sees the stored job, not the prompt with instructions');
  assert.deepEqual(turns, ['turn-1']);
});

test('without a mailbox or notifications the task is dispatched unchanged', async () => {
  const f = fixture();
  await f.dispatch({ ...job, requestId: 'notifications:1' }, {});
  assert.equal(f.calls.runtime[0].job.task, 'Envelope');
  assert.doesNotThrow(() => f.calls.runtime[0].hooks.onSend());
});

test('kill switch: mailbox-owned jobs are withdrawn unsent while the mailbox is disabled', async () => {
  for (const mailbox of [null, { enabled: false, instructions: () => '', noteJobSend() {} }]) {
    for (const requestId of ['mailbox:m_0000000000000001', 'mailbox-notice:m_0000000000000001']) {
      const f = fixture({ mailbox });
      assert.deepEqual(await f.dispatch({ ...job, requestId }, {}), { outcome: 'failed', inactive: true, error: 'withdrawn' });
      assert.equal(f.calls.events.length, 0, 'nothing reaches the tracked dispatch');
    }
  }
});

test('kill switch: other jobs and an enabled mailbox dispatch normally', async () => {
  const f = fixture({ mailbox: null });
  assert.equal((await f.dispatch({ ...job, requestId: 'notifications:1' }, {})).outcome, 'succeeded');
  const g = fixture({ mailbox: { enabled: true, instructions: () => '', noteJobSend() {} } });
  assert.equal((await g.dispatch(job, {})).outcome, 'succeeded');
  assert.equal(g.calls.events.length, 1);
});

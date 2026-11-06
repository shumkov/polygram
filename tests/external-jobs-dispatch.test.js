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
    mailbox: { instructions: (key) => { sessions.push(key); return '\n[mailbox]'; }, noteJobSend() {}, withdrawn: () => null },
  });
  await f.dispatch(job, {});
  assert.equal(f.calls.runtime[0].job.task, 'Envelope\n[notify]\n[mailbox]');
  assert.deepEqual(sessions, ['-1001:12', '-1001:12']);
  assert.deepEqual(f.calls.events, [{ ...target, eventId: job.requestId }]);
});

test('the send-point hook records the delivered job and keeps the caller hooks', async () => {
  const noted = []; const turns = [];
  const f = fixture({ mailbox: { instructions: () => '', noteJobSend: (j) => noted.push(j), withdrawn: () => null } });
  await f.dispatch(job, { onTurnId: (id) => turns.push(id) });
  assert.deepEqual(noted, [job], 'the depth hook sees the stored job, not the prompt with instructions');
  assert.deepEqual(turns, ['turn-1']);
});

test('without a mailbox or notifications the task is dispatched unchanged', async () => {
  const f = fixture();
  await f.dispatch(job, {});
  assert.equal(f.calls.runtime[0].job.task, 'Envelope');
  assert.doesNotThrow(() => f.calls.runtime[0].hooks.onSend());
});

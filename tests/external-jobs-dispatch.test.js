'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { renderJobVoice } = require('../lib/external-jobs/voice');

const target = { chatId: '-1001', threadId: '12', sessionKey: '-1001:12' };
const job = { id: 7, routeId: 'marketing', requestId: 'mailbox:m_0000000000000001', task: 'Envelope', payload: { body: 'x' }, target };

function fixture({ mailbox = null, notifications = null, history = null } = {}) {
  const calls = { events: [], runtime: [], warnings: [], logged: [] };
  const dispatch = createExternalJobDispatch({
    dispatchExternalEvent: (origin, run) => { calls.events.push(origin); return run(); },
    runtime: { dispatch: async (j, hooks) => { calls.runtime.push({ job: j, hooks }); hooks.onSend?.(); hooks.onTurnId?.('turn-1'); return { outcome: 'succeeded' }; } },
    getNotifications: () => notifications, getMailbox: () => mailbox, getHistory: () => history,
    logger: { warn: (line) => calls.warnings.push(line) }, logEvent: (kind, detail) => calls.logged.push([kind, detail]),
  });
  return { dispatch, calls };
}

test('the dispatched prompt carries every instruction block for the target session', async () => {
  const sessions = [];
  const f = fixture({
    notifications: { instructions: (key) => { sessions.push(key); return '\n[notify]'; } },
    mailbox: { instructions: (key) => { sessions.push(key); return '\n[mailbox]'; }, noteJobSend() {}, enabled: true },
    history: { instructions: (key, forJob) => { sessions.push(key); assert.equal(forJob, job, 'retries of one job reuse its history token'); return '\n[history]'; },
      noteJobSend: (sent) => sessions.push(['history-sent', sent.requestId]) },
  });
  await f.dispatch(job, {});
  assert.deepEqual(sessions.at(-1), ['history-sent', job.requestId], 'the send point demotes the session\'s admin history reach');
  sessions.pop();
  assert.equal(f.calls.runtime[0].job.task, 'Envelope\n[notify]\n[mailbox]\n[history]', 'the tool blocks follow the stored task');
  assert.equal(f.calls.runtime[0].job.voice, renderJobVoice(), 'the job-turn rule travels apart, to end the prompt');
  assert.deepEqual(sessions, ['-1001:12', '-1001:12', '-1001:12']);
  assert.deepEqual(f.calls.events, [{ ...target, eventId: job.requestId }]);
});

test('the send-point hook records the delivered job and keeps the caller hooks', async () => {
  const noted = []; const turns = [];
  const f = fixture({ mailbox: { instructions: () => '', noteJobSend: (j) => noted.push(j), enabled: true } });
  await f.dispatch(job, { onTurnId: (id) => turns.push(id) });
  assert.deepEqual(noted, [job], 'the depth hook sees the stored job, not the prompt with instructions');
  assert.deepEqual(turns, ['turn-1']);
});

test('without a mailbox or notifications the task gets only the job-turn rule', async () => {
  const f = fixture();
  await f.dispatch({ ...job, requestId: 'notifications:1' }, {});
  assert.equal(f.calls.runtime[0].job.task, 'Envelope');
  assert.equal(f.calls.runtime[0].job.voice, renderJobVoice());
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

test('kill switch: every withdrawal is logged and recorded as an event', async () => {
  const f = fixture({ mailbox: { enabled: false, instructions: () => '', noteJobSend() {} } });
  await f.dispatch(job, {});
  assert.equal(f.calls.warnings.length, 1);
  assert.match(f.calls.warnings[0], /mailbox:m_0000000000000001/);
  assert.deepEqual(f.calls.logged, [['mailbox-withdrawn', { request_id: job.requestId, route_id: 'marketing', session_key: '-1001:12' }]]);
  const g = fixture({ mailbox: { enabled: true, instructions: () => '', noteJobSend() {} } });
  await g.dispatch(job, {});
  assert.deepEqual([g.calls.warnings, g.calls.logged], [[], []], 'normal dispatch records nothing');
});

test('a job\'s turn ends its own mailbox turn when it settles, so a person\'s assistant cannot act on its grant afterwards', async () => {
  const ended = [];
  const f = fixture({ mailbox: { enabled: true, instructions: () => '', noteJobSend() {}, noteTurnEnd: (key, owner) => ended.push([key, owner]) } });
  await f.dispatch(job, {});
  assert.deepEqual(ended, [['-1001:12', `job:marketing\0${job.requestId}`]]);
});

test('the job\'s turn ends after the send point, and also when the turn fails', async () => {
  const order = [];
  const mailbox = { enabled: true, instructions: () => '', noteJobSend: () => order.push('send'), noteTurnEnd: () => order.push('end') };
  const failing = createExternalJobDispatch({
    dispatchExternalEvent: (_origin, run) => run(),
    runtime: { dispatch: async (_job, hooks) => { hooks.onSend?.(); order.push('turn'); throw new Error('turn failed'); } },
    getMailbox: () => mailbox,
  });
  await assert.rejects(failing(job, {}), /turn failed/);
  assert.deepEqual(order, ['send', 'turn', 'end']);
});


test('the job\'s working state is prepared with its mailbox card and handed to the runtime', async () => {
  const card = Promise.resolve({ chatId: '-1001', threadId: '12', messageId: 9 });
  const prepared = [];
  const handle = { context: {}, begin() {}, end() {} };
  const f = createExternalJobDispatch({
    dispatchExternalEvent: (_origin, run) => run(),
    runtime: { dispatch: async (_job, hooks) => { assert.equal(hooks.presence, handle); return { outcome: 'succeeded' }; } },
    getMailbox: () => ({ enabled: true, instructions: () => '', noteJobSend() {}, cardFor: (j) => (j === job ? card : null) }),
    getPresence: () => ({ prepare: async (j, options) => { prepared.push([j, options.card]); return handle; } }),
  });
  assert.equal((await f(job, {})).outcome, 'succeeded');
  assert.deepEqual(prepared, [[job, card]]);
});

test('a failure preparing the working state is logged and the job runs without it', async () => {
  for (const broken of [
    { mailbox: { cardFor: () => { throw new Error('database is locked'); } }, presence: { prepare: async () => ({}) } },
    { mailbox: {}, presence: { prepare: async () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); } } },
  ]) {
    const warnings = []; const seen = [];
    const f = createExternalJobDispatch({
      dispatchExternalEvent: (_origin, run) => run(),
      runtime: { dispatch: async (_job, hooks) => { seen.push(hooks.presence); return { outcome: 'succeeded' }; } },
      getMailbox: () => ({ enabled: true, instructions: () => '', noteJobSend() {}, ...broken.mailbox }),
      getPresence: () => broken.presence, logger: { warn: (line) => warnings.push(line) },
    });
    assert.equal((await f(job, {})).outcome, 'succeeded');
    assert.deepEqual(seen, [null]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /mailbox:m_0000000000000001/);
  }
});

test('the rule is worded for the backend the target runs, and a resolver that throws falls back to the Claude CLI wording', async () => {
  const seen = [];
  for (const getBackend of [() => 'codex', () => 'cli', () => { throw new Error('unknown chat'); }]) {
    const dispatch = createExternalJobDispatch({
      dispatchExternalEvent: (_origin, run) => run(),
      runtime: { dispatch: async (j) => { seen.push(j.voice); return { outcome: 'succeeded' }; } },
      getBackend,
    });
    assert.equal((await dispatch({ ...job, requestId: 'notifications:1' }, {})).outcome, 'succeeded');
  }
  assert.deepEqual(seen, [renderJobVoice({ backend: 'codex' }), renderJobVoice(), renderJobVoice()]);
});

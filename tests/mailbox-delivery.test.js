'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createMailboxService } = require('../lib/mailbox/service');
const envelope = require('../lib/mailbox/envelope');

const routes = {
  orchestrator: { chatId: '-1001', threadId: '11' },
  marketing: { chatId: '-1001', threadId: '12' },
  ops: { chatId: '-1001', threadId: '13' },
};
const session = (role) => `${routes[role].chatId}:${routes[role].threadId}`;
const resolveTarget = (route) => ({ chatId: route.chatId, threadId: route.threadId, sessionKey: `${route.chatId}:${route.threadId}` });
const HOUR = 3600000;
const quiet = { error() {}, warn() {}, log() {} };

// Real external jobs and mailbox over one SQLite file; only the agent turn
// is simulated. `turn(job, f)` decides how each delivered prompt ends.
function fixture(t, { mailbox = {}, jobs: jobSettings = {}, turn, recoverInactive } = {}) {
  const { db, dbPath } = freshDb('mailbox-delivery');
  let clock = 10 * HOUR;
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes), ...jobSettings }, mailbox: {
    enabled: true,
    roles: { orchestrator: { about: 'Owns strategy' }, marketing: { about: 'Campaigns' }, ops: { about: 'Operations' } },
    allow: { orchestrator: ['*'], marketing: ['orchestrator'] },
    ...mailbox,
  } } };
  const f = { db, config, turns: [], recoveries: [], advance(ms) { clock += ms; }, now: () => clock };
  const runtime = { dispatch: async (job, hooks) => {
    hooks.onSend?.();
    f.turns.push(job);
    return (turn || (async () => ({ outcome: 'succeeded', text: '', inactive: true })))(job, f);
  } };
  f.jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget, now: () => clock,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (origin, run) => run(), runtime, getMailbox: () => f.mailbox }),
    checkInactive: async () => false,
    recoverInactive: async (job, confirm) => { f.recoveries.push(job.requestId); return (recoverInactive || (async () => false))(job, confirm, f); },
    deliverPart: async () => ({ messageId: 1 }), logger: quiet });
  f.make = (overrides = {}) => createMailboxService({ config: { bot: { ...config.bot, mailbox: { ...config.bot.mailbox, ...overrides } } },
    db, botName: 'test', jobs: f.jobs, resolveTarget, now: () => clock, logger: quiet });
  f.mailbox = f.make();
  f.jobs.start(); f.mailbox.start();
  t.after(() => { f.mailbox.stop(); f.jobs.stop(); cleanupDb(dbPath, db); });
  f.human = (role) => { f.mailbox.noteHumanPrompt(session(role)); return f.mailbox.scope(session(role)); };
  f.job = (routeId, requestId) => db.raw.prepare('SELECT * FROM external_jobs WHERE route_id=? AND request_id=?').get(routeId, requestId);
  f.notices = () => db.raw.prepare("SELECT * FROM external_jobs WHERE request_id GLOB 'mailbox-notice:*' ORDER BY id").all();
  f.row = (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id);
  return f;
}
const ask = (to, body = 'What is the Q3 budget?') => ({ to, kind: 'ask', body });

test('a message is stored and queued as one external job on the frozen target route', (t) => {
  const f = fixture(t);
  const token = f.human('orchestrator');
  const sent = f.mailbox.send(token, ask('marketing'));
  const row = f.row(sent.id);
  const job = f.job('marketing', `mailbox:${sent.id}`);
  assert.equal(job.state, 'queued');
  assert.equal(job.task, envelope.renderTask(row));
  assert.deepEqual(JSON.parse(job.payload), envelope.renderPayload(row));
  assert.equal(JSON.parse(job.target).sessionKey, session('marketing'));
  for (const secret of [token, f.mailbox.scope(session('marketing'))]) assert.ok(!job.task.includes(secret) && !job.payload.includes(secret), 'no token is stored with the job');
});

test('a refused submit rolls back the message and the refusal reaches the caller', (t) => {
  const f = fixture(t, { jobs: { maxPending: 1 } });
  const token = f.human('orchestrator');
  f.mailbox.send(token, ask('marketing', 'first'));
  assert.throws(() => f.mailbox.send(token, ask('ops', 'second')), /queue full/);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM mailbox_messages').get().n, 1);
});

test('the job submit joins an enclosing transaction instead of committing on its own', (t) => {
  const f = fixture(t);
  const input = { routeId: 'marketing', requestId: 'mailbox:m_nested', task: 'Envelope', payload: { body: 'x' } };
  assert.throws(() => f.db.raw.transaction(() => { f.jobs.submit(input); throw new Error('later failure'); }).immediate(), /later failure/);
  assert.equal(f.job('marketing', 'mailbox:m_nested'), undefined, 'the inner immediate transaction became a savepoint and rolled back');
  f.db.raw.transaction(() => f.jobs.submit(input)).immediate();
  assert.equal(f.job('marketing', 'mailbox:m_nested').state, 'queued');
});

test('ask, reply and the asker turn: the reply quotes the ask and nothing else returns', async (t) => {
  const f = fixture(t, { turn: async (job, fx) => {
    if (job.routeId === 'marketing') {
      assert.match(job.task, /^\[Inter-session message\] from=role:orchestrator to=role:marketing kind=ask/);
      assert.ok(job.task.includes(fx.mailbox.scope(session('marketing'))), 'the delivered prompt carries the target session token');
      fx.mailbox.reply(fx.mailbox.scope(session('marketing')), { inReplyTo: job.payload.message.id, body: 'Budget is 10k' });
    }
    return { outcome: 'succeeded', text: 'Answered.', inactive: true };
  } });
  const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
  await f.jobs.tick(); await f.jobs.tick();
  assert.deepEqual(f.turns.map((job) => job.routeId), ['marketing', 'orchestrator']);
  const back = f.turns[1];
  assert.match(back.task, /kind=reply/);
  assert.match(back.task, new RegExp(`This answers your ask ${question.id}`));
  assert.equal(back.payload.message.body, 'Budget is 10k');
  assert.deepEqual(back.payload.ask, { id: question.id, from: 'role:orchestrator', to: 'role:marketing', body: 'What is the Q3 budget?' });
  await f.mailbox.tick(); await f.jobs.tick();
  assert.deepEqual(f.notices(), [], 'an answered ask gets no notice');
  assert.equal(f.turns.length, 2);
});

test('asks to two roles run as concurrent turns', async (t) => {
  const open = [];
  const f = fixture(t, { turn: () => new Promise((resolve) => open.push(resolve)) });
  const token = f.human('orchestrator');
  f.mailbox.send(token, ask('marketing')); f.mailbox.send(token, ask('ops'));
  const ticking = f.jobs.tick();
  for (let n = 0; n < 20; n++) await new Promise(setImmediate);
  try { assert.deepEqual(f.turns.map((job) => job.routeId).sort(), ['marketing', 'ops']); }
  finally { for (const resolve of open) resolve({ outcome: 'succeeded', text: '', inactive: true }); }
  await ticking;
});

test('a turn that ends without a reply yields one notice; a late reply still arrives', async (t) => {
  const f = fixture(t);
  const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
  await f.mailbox.tick();
  assert.deepEqual(f.notices(), [], 'no notice while the delivery is still queued');
  await f.jobs.tick();
  await f.mailbox.tick(); await f.mailbox.tick();
  const notices = f.notices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].request_id, `mailbox-notice:${question.id}`);
  assert.equal(notices[0].route_id, 'orchestrator');
  assert.match(notices[0].task, /^\[Inter-session notice\] from=system:polygram to=role:orchestrator/);
  assert.match(notices[0].task, /turn ended without a reply/);
  assert.equal(f.row(question.id).notice_sent, 1);

  await f.jobs.tick();
  assert.equal(f.turns.at(-1).requestId, `mailbox-notice:${question.id}`);
  assert.throws(() => f.mailbox.send(f.mailbox.scope(session('orchestrator')), ask('ops')), /depth/i, 'a notice turn can only reply');

  const late = f.mailbox.reply(f.mailbox.scope(session('marketing')), { inReplyTo: question.id, body: 'Sorry, 10k' });
  await f.jobs.tick(); await f.mailbox.tick();
  assert.equal(f.turns.at(-1).requestId, `mailbox:${late.id}`);
  assert.equal(f.notices().length, 1, 'notices never repeat');
});

test('failed and interrupted deliveries each produce a notice with their reason', async (t) => {
  for (const [result, reason] of [[{ outcome: 'failed', error: 'provider rejected', inactive: true }, /delivery failed/], [{ outcome: 'interrupted', inactive: true }, /interrupted/]]) {
    const f = fixture(t, { turn: async () => result });
    const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
    await f.jobs.tick(); await f.mailbox.tick();
    const [notice] = f.notices();
    assert.match(notice.task, reason);
    assert.equal(JSON.parse(notice.payload).ask.id, question.id);
  }
});

test('an uncertain delivery gets a recovery probe with backoff and a notice, and is never replayed', async (t) => {
  let idle = false;
  const f = fixture(t, {
    turn: async (job) => { if (job.routeId === 'marketing') throw new Error('Lost turn receipt'); return { outcome: 'succeeded', inactive: true }; },
    recoverInactive: async (job, confirm) => { if (!idle) return false; confirm(); return true; },
  });
  const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
  await f.jobs.tick();
  assert.equal(f.job('marketing', `mailbox:${question.id}`).state, 'unknown');
  await f.mailbox.tick();
  assert.deepEqual(f.recoveries, [`mailbox:${question.id}`]);
  assert.match(f.notices()[0].task, /uncertain/, 'the asker hears about it whether or not recovery worked');
  await f.mailbox.tick();
  assert.equal(f.recoveries.length, 1, 'a failed recovery waits for its backoff');
  idle = true;
  f.advance(61000); await f.mailbox.tick();
  assert.equal(f.recoveries.length, 2);
  assert.equal(f.job('marketing', `mailbox:${question.id}`).inactive, 1, 'recovery unblocks the session queue');
  f.advance(HOUR); await f.mailbox.tick();
  assert.equal(f.recoveries.length, 2, 'a recovered job is not probed again');
  const tell = f.mailbox.send(f.mailbox.scope(session('orchestrator')), { to: 'marketing', kind: 'tell', body: 'FYI' });
  await f.jobs.tick();
  assert.equal(f.turns.filter((job) => job.requestId === `mailbox:${question.id}`).length, 1, 'the uncertain message is never replayed');
  assert.ok(f.turns.some((job) => job.requestId === `mailbox:${tell.id}`), 'the recovered session takes new work');
});

test('an uncertain notice turn is recovered too', async (t) => {
  const f = fixture(t, {
    turn: async (job) => { if (job.requestId.startsWith('mailbox-notice:')) throw new Error('Lost turn receipt'); return { outcome: 'succeeded', inactive: true }; },
    recoverInactive: async (job, confirm) => { confirm(); return true; },
  });
  const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
  await f.jobs.tick(); await f.mailbox.tick(); await f.jobs.tick(); await f.mailbox.tick();
  assert.deepEqual(f.recoveries, [`mailbox-notice:${question.id}`]);
  assert.equal(f.notices().length, 1, 'notices never produce notices');
});

test('kill switch: a disabled mailbox withdraws its queued jobs without sending or blocking the session', async (t) => {
  const f = fixture(t);
  const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
  f.mailbox.stop();
  f.mailbox = f.make({ enabled: false });
  f.jobs.submit({ routeId: 'marketing', requestId: 'notifications:after', task: 'Read notifications', payload: {} });
  await f.jobs.tick(); await f.jobs.tick();
  const withdrawn = f.job('marketing', `mailbox:${question.id}`);
  assert.equal(withdrawn.state, 'failed'); assert.equal(withdrawn.error, 'withdrawn'); assert.equal(withdrawn.inactive, 1);
  assert.deepEqual(f.turns.map((job) => job.requestId), ['notifications:after'], 'nothing was sent for the withdrawn job and the queue moved on');
});

test('a paused target holds delivery until resume', async (t) => {
  const f = fixture(t);
  f.jobs.pauseSession(session('marketing'), true);
  const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
  assert.equal(question.state, 'paused');
  await f.jobs.tick(); await f.mailbox.tick();
  assert.equal(f.turns.length, 0); assert.deepEqual(f.notices(), []);
  f.jobs.pauseSession(session('marketing'), false);
  await f.jobs.tick();
  assert.equal(f.turns[0].requestId, `mailbox:${question.id}`);
});

test('the poller runs once at start', async (t) => {
  const f = fixture(t);
  const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
  await f.jobs.tick();
  f.mailbox.stop();
  f.mailbox = f.make();
  f.mailbox.start();
  for (let n = 0; n < 20 && !f.notices().length; n++) await new Promise(setImmediate);
  assert.equal(f.notices()[0]?.request_id, `mailbox-notice:${question.id}`);
});

test('a reply whose delivery fails leaves the ask open and gives the asker one notice', async (t) => {
  const f = fixture(t, { turn: async (job, fx) => {
    if (job.routeId === 'marketing') {
      fx.mailbox.reply(fx.mailbox.scope(session('marketing')), { inReplyTo: job.payload.message.id, body: 'Budget is 10k' });
      return { outcome: 'succeeded', inactive: true };
    }
    if (job.requestId.startsWith('mailbox:')) return { outcome: 'failed', error: 'provider rejected', inactive: true };
    return { outcome: 'succeeded', inactive: true };
  } });
  const question = f.mailbox.send(f.human('orchestrator'), ask('marketing'));
  await f.jobs.tick(); await f.jobs.tick();
  const reply = f.db.raw.prepare("SELECT * FROM mailbox_messages WHERE kind='reply'").get();
  assert.equal(f.job('orchestrator', `mailbox:${reply.id}`).state, 'failed');
  await f.mailbox.tick(); await f.mailbox.tick();
  const notices = f.notices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].request_id, `mailbox-notice:${question.id}`);
  assert.match(notices[0].task, /role:marketing replied but delivery of the reply failed; ask again if you still need it/);
  assert.deepEqual(JSON.parse(notices[0].payload).reply, { id: reply.id, state: 'failed', error: 'provider rejected' });
  await f.jobs.tick(); await f.mailbox.tick();
  assert.equal(f.notices().length, 1, 'still exactly one notice');
});

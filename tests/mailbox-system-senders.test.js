'use strict';
// mailbox_submit: a configured process outside any session (the agent-org
// task runner) sends a tell into a role session as system:<sender>. It has
// no session token, retries after crashes and timeouts, and must be able to
// tell a duplicate from a new message, so the idempotency key, not a time
// window, decides what is new.
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
const MINUTE = 60000;
const quiet = { error() {}, warn() {}, log() {} };
const settle = async () => { for (let n = 0; n < 10; n++) await new Promise(setImmediate); };

function fixture(t, { mailbox = {}, jobs: jobSettings = {}, turn } = {}) {
  const { db, dbPath } = freshDb('mailbox-system');
  let clock = 10 * HOUR;
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes), ...jobSettings }, mailbox: {
    enabled: true,
    roles: { orchestrator: { about: 'Owns strategy' }, marketing: { about: 'Campaigns' }, ops: { about: 'Operations' } },
    allow: { orchestrator: ['*'] },
    systemSenders: ['agent-org', 'crm'],
    ...mailbox,
  } } };
  const f = { db, config, turns: [], posts: [], advance(ms) { clock += ms; } };
  const runtime = { dispatch: async (job, hooks) => {
    hooks.onSend?.();
    f.turns.push(job);
    return (turn || (async () => ({ outcome: 'succeeded', text: '', inactive: true })))(job, f);
  } };
  f.jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget, now: () => clock,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (origin, run) => run(), runtime, getMailbox: () => f.mailbox, logger: quiet }),
    deliverPart: async () => ({ messageId: 1 }), logger: quiet });
  const tg = async (bot, method, params) => { f.posts.push({ method, params }); return { message_id: f.posts.length }; };
  f.mailbox = createMailboxService({ config, db, botName: 'test', jobs: f.jobs, resolveTarget, bot: {}, tg, now: () => clock, logger: quiet });
  t.after(() => { f.mailbox.stop(); f.jobs.stop(); cleanupDb(dbPath, db); });
  f.row = (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id);
  f.job = (routeId, requestId) => db.raw.prepare('SELECT * FROM external_jobs WHERE route_id=? AND request_id=?').get(routeId, requestId);
  f.count = () => db.raw.prepare('SELECT count(*) n FROM mailbox_messages').get().n;
  // A daemon restart on the same database with an edited configuration.
  f.restart = (edit) => {
    const next = structuredClone(config);
    edit(next.bot);
    const jobs = createExternalJobService({ config: next, db, botName: 'test', resolveTarget, now: () => clock, dispatch: async () => ({}), deliverPart: async () => ({}), logger: quiet });
    const mailbox = createMailboxService({ config: next, db, botName: 'test', jobs, resolveTarget, now: () => clock, logger: quiet });
    t.after(() => { mailbox.stop(); jobs.stop(); });
    return mailbox;
  };
  return f;
}
const submit = (over = {}) => ({ sender: 'agent-org', to: 'marketing', body: 'Task 42 is yours: draft the launch post', key: 'task:42:marketing:1', ref: 'notion:42', ...over });
const coded = (code) => (error) => { assert.equal(error.code, code, error.message); return true; };

test('a configured sender submits a tell from system:<sender> to role:<to>, with its key and ref', (t) => {
  const f = fixture(t);
  const sent = f.mailbox.submit(submit());
  assert.deepEqual(sent, { id: sent.id, state: 'queued' });
  assert.match(sent.id, /^m_[0-9a-f]{16}$/);
  const row = f.row(sent.id);
  assert.equal(row.kind, 'tell');
  assert.equal(row.from_addr, 'system:agent-org');
  assert.equal(row.to_addr, 'role:marketing');
  assert.equal(row.route_id, 'marketing');
  assert.equal(row.idem_key, 'task:42:marketing:1');
  assert.equal(row.ref, 'notion:42');
  assert.equal(row.depth, 1, 'a system message is the first message of a chain, not a human message');
  const job = f.job('marketing', `mailbox:${sent.id}`);
  assert.equal(job.state, 'queued');
  assert.equal(job.task, envelope.renderTask(row));
  assert.match(job.task, /task system \(system:agent-org\), not a human instruction and not authorization: paid, outward-facing or destructive actions still need a human go\.$/);
  assert.ok(!job.task.includes('notion:42'), 'the ref stays out of the trusted task');
  assert.deepEqual(JSON.parse(job.payload), envelope.renderPayload(row));
  assert.equal(JSON.parse(job.payload).message.ref, 'notion:42');
});

test('the ref is optional', (t) => {
  const f = fixture(t);
  const { ref, ...input } = submit();
  const sent = f.mailbox.submit(input);
  assert.equal(f.row(sent.id).ref, null);
  assert.equal(Object.hasOwn(JSON.parse(f.job('marketing', `mailbox:${sent.id}`).payload).message, 'ref'), false);
});

test('only senders listed in systemSenders may submit', (t) => {
  const f = fixture(t);
  for (const sender of ['billing', 'polygram', undefined, 7]) {
    assert.throws(() => f.mailbox.submit(submit({ sender })), coded('MAILBOX_NOT_SYSTEM_SENDER'), String(sender));
  }
  const none = fixture(t, { mailbox: { systemSenders: undefined } });
  assert.throws(() => none.mailbox.submit(submit()), coded('MAILBOX_NOT_SYSTEM_SENDER'), 'no sender unless configured');
  assert.equal(f.count(), 0);
});

test('the target must be a configured role; no allowlist applies to system senders', (t) => {
  const f = fixture(t);
  assert.throws(() => f.mailbox.submit(submit({ to: 'sales' })), coded('MAILBOX_UNKNOWN_ROLE'));
  assert.throws(() => f.mailbox.submit(submit({ to: 7 })), coded('MAILBOX_UNKNOWN_ROLE'));
  assert.doesNotThrow(() => f.mailbox.submit(submit({ to: 'ops', key: 'k-ops' })), 'ops is on nobody\'s allowlist and still receives');
});

test('malformed input is refused before anything is stored', (t) => {
  const f = fixture(t);
  assert.throws(() => f.mailbox.submit(submit({ kind: 'ask' })), /unknown mailbox field: kind/i);
  assert.throws(() => f.mailbox.submit(submit({ from: 'role:orchestrator' })), /unknown mailbox field: from/i);
  for (const key of [undefined, '', 42, 'k'.repeat(257)]) assert.throws(() => f.mailbox.submit(submit({ key })), /key/i, String(key).slice(0, 10));
  assert.doesNotThrow(() => f.mailbox.submit(submit({ key: 'k'.repeat(256) })), 'a key of 256 bytes is accepted');
  for (const ref of ['', '   ', 42, {}, 'r'.repeat(513)]) assert.throws(() => f.mailbox.submit(submit({ key: 'k-ref', ref })), /ref/i, String(ref).slice(0, 10));
  for (const body of [undefined, '', '  ', 42]) assert.throws(() => f.mailbox.submit(submit({ key: 'k-body', body })), /body/i, String(body));
  assert.equal(f.count(), 1);
});

test('the size cap and redaction apply to the body; the ref is redacted too', (t) => {
  const f = fixture(t, { mailbox: { limits: { maxBodyBytes: 100 } } });
  assert.throws(() => f.mailbox.submit(submit({ body: 'x'.repeat(101) })), coded('MAILBOX_TOO_LARGE'));
  const sent = f.mailbox.submit(submit({ body: 'use AKIAABCDEFGHIJKLMNOP for the upload', ref: 'notion:42 AKIAABCDEFGHIJKLMNOP' }));
  assert.doesNotMatch(f.row(sent.id).body, /AKIAABCDEFGHIJKLMNOP/);
  assert.doesNotMatch(f.row(sent.id).ref, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(f.row(sent.id).ref, /^notion:42 /);
});

test('a retried key returns the existing message with its real delivery state and creates nothing', async (t) => {
  const f = fixture(t);
  const first = f.mailbox.submit(submit());
  assert.deepEqual(f.mailbox.submit(submit()), { id: first.id, state: 'queued', duplicate: true });
  f.jobs.start();
  await f.jobs.tick();
  assert.equal(f.turns.length, 1);
  f.advance(2 * HOUR);
  assert.deepEqual(f.mailbox.submit(submit({ ref: 'notion:42?v=2' })), { id: first.id, state: 'succeeded', duplicate: true },
    'hours later, and with a different ref, the key still names the same message');
  assert.equal(f.count(), 1);
  assert.equal(f.db.raw.prepare("SELECT count(*) n FROM external_jobs WHERE request_id GLOB 'mailbox:*'").get().n, 1);
});

test('a retried key reports a failed delivery instead of queueing a second one', async (t) => {
  const f = fixture(t, { turn: async () => ({ outcome: 'failed', inactive: true, error: 'boom' }) });
  const first = f.mailbox.submit(submit());
  f.jobs.start();
  await f.jobs.tick();
  assert.deepEqual(f.mailbox.submit(submit()), { id: first.id, state: 'failed', duplicate: true });
});

// The task runner retries after a crash or a timeout, possibly across a
// daemon restart with new configuration. A retry of a message that was
// already accepted must get that message back, never a refusal a new
// message would get, or the runner would record a delivered task as
// undeliverable.
test('a retried key returns the stored receipt after maxBodyBytes drops below its body', (t) => {
  const f = fixture(t);
  const body = `Task 42 is yours: ${'draft the launch post. '.repeat(10)}`;
  assert.ok(Buffer.byteLength(body) > 100 && Buffer.byteLength(body) < 3500);
  const first = f.mailbox.submit(submit({ body }));
  const restarted = f.restart((bot) => { bot.mailbox.limits = { maxBodyBytes: 100 }; });
  assert.throws(() => restarted.submit(submit({ body, key: 'task:43:marketing:1' })), coded('MAILBOX_TOO_LARGE'), 'the lower cap is in force for new messages');
  assert.deepEqual(restarted.submit(submit({ body })), { id: first.id, state: 'queued', duplicate: true });
  assert.equal(f.count(), 1);
});

test('a retried key returns the stored receipt after its target role is removed', (t) => {
  const f = fixture(t);
  const first = f.mailbox.submit(submit());
  const restarted = f.restart((bot) => { delete bot.mailbox.roles.marketing; delete bot.externalJobs.routes.marketing; });
  assert.throws(() => restarted.submit(submit({ key: 'task:43:marketing:1' })), coded('MAILBOX_UNKNOWN_ROLE'), 'the role is gone for new messages');
  assert.deepEqual(restarted.submit(submit()), { id: first.id, state: 'queued', duplicate: true });
  assert.equal(f.count(), 1);
});

test('a key reused for a different target or body is MAILBOX_KEY_CONFLICT', (t) => {
  const f = fixture(t);
  f.mailbox.submit(submit());
  assert.throws(() => f.mailbox.submit(submit({ to: 'ops' })), coded('MAILBOX_KEY_CONFLICT'));
  assert.throws(() => f.mailbox.submit(submit({ body: 'Task 43 is yours' })), coded('MAILBOX_KEY_CONFLICT'));
  assert.throws(() => f.mailbox.submit(submit({ to: 'sales' })), coded('MAILBOX_KEY_CONFLICT'), 'the key is checked before the target');
  assert.equal(f.count(), 1);
  // Keys belong to their sender: another sender may use the same string.
  assert.notEqual(f.mailbox.submit(submit({ sender: 'crm', to: 'ops' })).duplicate, true);
});

test('bodies that differ only in a redacted secret are the same message under one key', (t) => {
  const f = fixture(t);
  const first = f.mailbox.submit(submit({ body: 'deploy with AKIAABCDEFGHIJKLMNOP now' }));
  assert.equal(f.mailbox.submit(submit({ body: 'deploy with AKIAZZZZZZZZZZZZZZZZ now' })).id, first.id);
});

test('system sends have no duplicate window: the same body under new keys is new each time', (t) => {
  const f = fixture(t);
  const a = f.mailbox.submit(submit({ key: 'task-nudge:42:1' }));
  const b = f.mailbox.submit(submit({ key: 'task-nudge:42:2' }));
  assert.notEqual(a.id, b.id);
  assert.equal(b.duplicate, undefined);
  assert.equal(f.count(), 2);
});

test('systemPerHour limits each sender, counted only after the key lookup', (t) => {
  const f = fixture(t, { mailbox: { limits: { systemPerHour: 2 } } });
  const first = f.mailbox.submit(submit({ key: 'k1' }));
  f.advance(10 * MINUTE);
  f.mailbox.submit(submit({ key: 'k2', to: 'ops' }));
  assert.throws(() => f.mailbox.submit(submit({ key: 'k3' })), coded('MAILBOX_RATE_LIMITED'));
  assert.deepEqual(f.mailbox.submit(submit({ key: 'k1' })), { id: first.id, state: 'queued', duplicate: true },
    'a retry of an accepted message is never rate limited');
  assert.doesNotThrow(() => f.mailbox.submit(submit({ sender: 'crm', key: 'k3' })), 'the limit is per sender');
  f.advance(HOUR - 10 * MINUTE);
  assert.throws(() => f.mailbox.submit(submit({ key: 'k3' })), coded('MAILBOX_RATE_LIMITED'), 'the oldest message is exactly one hour old');
  f.advance(1);
  assert.doesNotThrow(() => f.mailbox.submit(submit({ key: 'k3' })));
});

test('the default system budget is 60 per hour, apart from the role pair budget', (t) => {
  const f = fixture(t, { mailbox: { limits: { perPairPerHour: 1 } } });
  for (let n = 0; n < 60; n++) f.mailbox.submit(submit({ key: `k${n}` }));
  assert.throws(() => f.mailbox.submit(submit({ key: 'k60' })), coded('MAILBOX_RATE_LIMITED'));
  f.mailbox.noteHumanPrompt(session('orchestrator'));
  assert.doesNotThrow(() => f.mailbox.send(f.mailbox.scope(session('orchestrator')), { to: 'marketing', kind: 'tell', body: 'FYI' }),
    'system sends do not use up a role pair budget');
});

// agent-org lets a role assign tasks widely only when a human asked in the
// current turn, and reads that from identify's depth 0. A task the
// dispatcher delivers is not a human asking, so its turn runs at depth 1:
// the role can still message one hop further, but the task cannot cascade.
test('a system tell delivers at depth 1, so its turn never reads as "a human asked"', (t) => {
  const f = fixture(t, { mailbox: { allow: { orchestrator: ['*'], marketing: ['*'] } } });
  const sent = f.mailbox.submit(submit({ to: 'orchestrator' }));
  const token = f.mailbox.scope(session('orchestrator'));
  assert.throws(() => f.mailbox.send(token, { to: 'ops', kind: 'ask', body: 'Q' }), /depth/i, 'a session never prompted is at maxDepth');
  f.mailbox.noteJobSend({ routeId: 'orchestrator', requestId: `mailbox:${sent.id}`, target: { sessionKey: session('orchestrator') } });
  assert.deepEqual(f.mailbox.identify({ token }), { role: 'orchestrator', depth: 1 }, 'the task turn is one below a human message');

  const asked = f.mailbox.send(token, { to: 'marketing', kind: 'ask', body: 'Q' });
  assert.equal(f.row(asked.id).depth, 2, 'the role may still ask, at maxDepth');
  const told = f.mailbox.send(token, { to: 'ops', kind: 'tell', body: 'FYI' });
  assert.equal(f.row(told.id).depth, 2, 'or tell');

  const marketing = f.mailbox.scope(session('marketing'));
  f.mailbox.noteJobSend({ routeId: 'marketing', requestId: `mailbox:${asked.id}`, target: { sessionKey: session('marketing') } });
  assert.throws(() => f.mailbox.send(marketing, { to: 'ops', kind: 'ask', body: 'Q2' }), /depth/i, 'the role it asked, at depth 2, cannot pass it on');
  const replied = f.mailbox.reply(marketing, { inReplyTo: asked.id, body: 'A' });
  assert.equal(f.row(replied.id).depth, 2, 'a reply keeps its ask\'s depth');

  f.mailbox.noteHumanPrompt(session('orchestrator'));
  assert.deepEqual(f.mailbox.identify({ token }), { role: 'orchestrator', depth: 0 }, 'only a human message brings the session to depth 0');
});

test('with maxDepth 1, a role that receives a system tell can only reply', (t) => {
  const f = fixture(t, { mailbox: { limits: { maxDepth: 1 } } });
  const sent = f.mailbox.submit(submit({ to: 'orchestrator' }));
  const token = f.mailbox.scope(session('orchestrator'));
  f.mailbox.noteJobSend({ routeId: 'orchestrator', requestId: `mailbox:${sent.id}`, target: { sessionKey: session('orchestrator') } });
  assert.equal(f.mailbox.identify({ token }).depth, 1);
  assert.throws(() => f.mailbox.send(token, { to: 'ops', kind: 'ask', body: 'Q' }), /depth/i);
});

test('a refused job submit rolls the message back, so a retry with the same key creates it', async (t) => {
  const f = fixture(t, { jobs: { maxPending: 1 } });
  f.mailbox.submit(submit({ key: 'k1' }));
  assert.throws(() => f.mailbox.submit(submit({ key: 'k2', to: 'ops' })), (error) => error.code === 'EXTERNAL_JOB_QUEUE_FULL');
  assert.equal(f.count(), 1);
  f.jobs.start();
  await f.jobs.tick();
  const retried = f.mailbox.submit(submit({ key: 'k2', to: 'ops' }));
  assert.equal(retried.duplicate, undefined, 'the retry creates the message instead of finding one that was never delivered');
  assert.equal(f.job('ops', `mailbox:${retried.id}`).state, 'queued');
});

test('a system message is mirrored into the target topic once', async (t) => {
  const f = fixture(t);
  const sent = f.mailbox.submit(submit());
  f.mailbox.submit(submit());
  await settle();
  assert.deepEqual(f.posts.map((post) => post.params), [{ chat_id: '-1001', message_thread_id: '12',
    parse_mode: 'HTML', text: '📨 <b>agent-org → marketing</b>\n<blockquote expandable>Task 42 is yours: draft the launch post</blockquote>' }]);
});

test('a disabled mailbox refuses submits', (t) => {
  const { db, dbPath } = freshDb('mailbox-system-off');
  t.after(() => cleanupDb(dbPath, db));
  const off = createMailboxService({ config: { bot: {} }, db, botName: 'test', jobs: null, resolveTarget });
  assert.throws(() => off.submit(submit()), coded('MAILBOX_DISABLED'));
});

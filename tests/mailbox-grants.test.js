'use strict';
// Per-prompt grants. Every prompt polygram sends a session mints a new grant
// (the token in its mailbox command) that records that prompt's depth and
// taint. A newer prompt demotes the previous grant to reply-only, so a
// background process, or a later turn reusing an old command from its own
// context, can never start a message with a stronger, older grant.
//
// The taint rule is what makes a personal ask safe to treat as Ivan in UMI:
// a grant that has seen foreign content must never start an ask or tell.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createMailboxService } = require('../lib/mailbox/service');

const routes = { lead: { chatId: '-1001', threadId: '11' }, music: { chatId: '-1001', threadId: '12' }, ops: { chatId: '-1001', threadId: '13' } };
const session = (role) => `${routes[role].chatId}:${routes[role].threadId}`;
const resolveTarget = (route) => ({ chatId: route.chatId, threadId: route.threadId, sessionKey: `${route.chatId}:${route.threadId}` });
const TOKEN = /"([0-9a-f-]{36})"/;

function fixture(t) {
  const { db, dbPath } = freshDb('mailbox-grants');
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes) }, mailbox: {
    enabled: true, roles: { lead: {}, music: {}, ops: {} }, allow: { lead: ['*'], music: ['lead', 'ops'] },
  } } };
  const jobs = createExternalJobService({ config, db, botName: 'b', resolveTarget,
    dispatch: async () => ({ outcome: 'succeeded', inactive: true }), deliverPart: async () => ({}), logger: { error() {} } });
  const service = createMailboxService({ config, db, botName: 'b', jobs, resolveTarget, logger: { error() {}, warn() {} } });
  t.after(() => { service.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  const human = (role, operator = true, newTurn = true) => { service.noteHumanPrompt(session(role), { operator, newTurn }); return service.scope(session(role)); };
  const jobFor = (role, requestId) => ({ routeId: role, requestId, target: { sessionKey: session(role) } });
  const deliveryJob = (id) => jobFor('music', `mailbox:${id}`);
  return { db, service, human, jobFor, deliveryJob };
}
const tell = (to, body = 'note') => ({ to, kind: 'tell', body });
const coded = (code) => (error) => error?.code === code;

test('a newer prompt demotes the previous grant to reply-only', (t) => {
  const f = fixture(t);
  const ask = f.service.send(f.human('lead'), { to: 'music', kind: 'ask', body: 'Q' });
  const first = f.human('music');
  const second = f.human('music');
  assert.notEqual(first, second, 'each prompt mints its own grant');
  assert.throws(() => f.service.send(first, tell('ops')), coded('MAILBOX_NOT_ALLOWED'), 'the old command cannot start a message');
  assert.doesNotThrow(() => f.service.reply(first, { inReplyTo: ask.id, body: 'A' }),
    'it can still answer, so a turn overtaken by a queued message is not left unable to reply');
  assert.doesNotThrow(() => f.service.send(second, tell('ops')));
});

test('identify reports maxDepth for a demoted grant, so an old human-turn command cannot pass as a human asking now', (t) => {
  const f = fixture(t);
  const old = f.human('music');
  assert.deepEqual(f.service.identify({ token: old }), { role: 'music', depth: 0 });
  f.service.noteJobSend(f.jobFor('music', 'notifications:1'));
  assert.deepEqual(f.service.identify({ token: old }), { role: 'music', depth: 2 });
});

test('a job\'s grant is minted with its instructions and takes effect only when its prompt is sent', (t) => {
  const f = fixture(t);
  const sent = f.service.send(f.human('lead'), { to: 'music', kind: 'ask', body: 'Q' });
  const before = f.human('music');
  const job = f.deliveryJob(sent.id);
  const token = TOKEN.exec(f.service.instructions(session('music'), job))[1];
  assert.notEqual(token, before);
  assert.throws(() => f.service.send(token, tell('ops')), /token/i, 'not usable before the prompt is sent');
  assert.doesNotThrow(() => f.service.send(before, tell('ops')), 'the current grant is untouched while the job waits');
  f.service.noteJobSend(job);
  assert.deepEqual(f.service.identify({ token }), { role: 'music', depth: 1 }, 'the delivered message\'s depth');
  assert.throws(() => f.service.send(before, tell('lead')), coded('MAILBOX_NOT_ALLOWED'), 'the human-turn grant is now reply-only');
});

test('a deferred job\'s grant never takes effect', (t) => {
  const f = fixture(t);
  f.human('music');
  const deferred = TOKEN.exec(f.service.instructions(session('music'), f.jobFor('music', 'notifications:1')))[1];
  const next = f.jobFor('music', 'notifications:2');
  const token = TOKEN.exec(f.service.instructions(session('music'), next))[1];
  f.service.noteJobSend(next);
  assert.throws(() => f.service.identify({ token: deferred }), /token/i);
  assert.deepEqual(f.service.identify({ token }), { role: 'music', depth: 2 });
});

test('only a few demoted grants stay usable, so tokens do not accumulate', (t) => {
  const f = fixture(t);
  const first = f.human('music');
  for (let n = 0; n < 8; n++) f.human('music');
  assert.throws(() => f.service.identify({ token: first }), /token/i);
});

// Decision 2 dependency: a personal ask is delivered to UMI as Ivan at depth
// 0. That is safe only if a grant that has seen foreign content can never
// start a message, whatever its depth.
test('identify never reports a tainted grant as a human asking, so tools gated on depth 0 refuse it', (t) => {
  const f = fixture(t);
  const token = f.human('music', false);
  assert.deepEqual(f.service.identify({ token }), { role: 'music', depth: 0 });
  f.service.taint(session('music'));
  assert.deepEqual(f.service.identify({ token }), { role: 'music', depth: 2 });
});

test('a grant minted for one job never takes effect for another', (t) => {
  const f = fixture(t);
  f.human('music');
  const forA = TOKEN.exec(f.service.instructions(session('music'), f.jobFor('music', 'notifications:a')))[1];
  f.service.noteJobSend(f.jobFor('music', 'notifications:b'));
  assert.throws(() => f.service.identify({ token: forA }), /token/i, 'job A\'s grant is discarded, not activated for job B');
  assert.notEqual(f.service.scope(session('music')), forA);
});

test('a tainted grant can never start an ask or tell, though it has depth to spare and can still reply', (t) => {
  const f = fixture(t);
  const ask = f.service.send(f.human('lead'), { to: 'music', kind: 'ask', body: 'Q' });
  const token = f.human('music');
  f.service.taint(session('music'));
  for (const kind of ['ask', 'tell']) {
    assert.throws(() => f.service.send(token, { to: 'ops', kind, body: 'relay this' }),
      (error) => error.code === 'MAILBOX_NOT_ALLOWED' && /foreign/.test(error.message), kind);
  }
  assert.doesNotThrow(() => f.service.reply(token, { inReplyTo: ask.id, body: 'A' }));
  assert.equal(f.db.raw.prepare("SELECT count(*) n FROM mailbox_messages WHERE from_addr='role:music' AND kind<>'reply'").get().n, 0);
});

test('taint survives new grants until the operator writes: jobs, wakeups and other people\'s messages keep it', (t) => {
  const f = fixture(t);
  f.human('music');
  f.service.taint(session('music'));
  const job = f.jobFor('music', 'notifications:1');
  const jobToken = TOKEN.exec(f.service.instructions(session('music'), job))[1];
  f.service.noteJobSend(job);
  assert.throws(() => f.service.send(jobToken, tell('ops')), coded('MAILBOX_NOT_ALLOWED'), 'a job prompt after foreign content is tainted');
  const someoneElse = f.human('music', false);
  assert.throws(() => f.service.send(someoneElse, tell('ops')), coded('MAILBOX_NOT_ALLOWED'), 'a message from anyone but the operator keeps it');
  const folded = f.human('music', true, false);
  assert.throws(() => f.service.send(folded, tell('ops')), coded('MAILBOX_NOT_ALLOWED'),
    'the operator\'s message folded into the running tainted turn does not clear it');
  const ivan = f.human('music', true);
  assert.doesNotThrow(() => f.service.send(ivan, tell('ops')), 'the operator\'s own new turn clears it');
  assert.throws(() => f.service.send(jobToken, tell('lead')), coded('MAILBOX_NOT_ALLOWED'),
    'clearing the session never cleans an old tainted grant');
});

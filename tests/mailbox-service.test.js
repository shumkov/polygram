'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createMailboxService } = require('../lib/mailbox/service');

const routes = {
  orchestrator: { chatId: '-1001', threadId: '11' },
  marketing: { chatId: '-1001', threadId: '12' },
  ops: { chatId: '-1001', threadId: '13' },
  reports: { chatId: '-1001', threadId: '14' },
};
const session = (role) => `${routes[role].chatId}:${routes[role].threadId}`;
const resolveTarget = (route) => ({ chatId: route.chatId, threadId: route.threadId, sessionKey: `${route.chatId}:${route.threadId}` });
const HOUR = 3600000;
const MINUTE = 60000;

function fixture(t, mailbox = {}) {
  const { db, dbPath } = freshDb('mailbox-service');
  let clock = 10 * HOUR;
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes) }, mailbox: {
    enabled: true,
    roles: { orchestrator: { about: 'Owns strategy; routes work' }, marketing: { about: 'Campaigns, content, ads' }, ops: { about: 'Operations' } },
    allow: { orchestrator: ['*'], marketing: ['orchestrator'] },
    ...mailbox,
  } } };
  const jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget, now: () => clock,
    dispatch: async () => ({ outcome: 'succeeded', inactive: true }), deliverPart: async () => ({}), logger: { error() {} } });
  const make = () => createMailboxService({ config, db, botName: 'test', jobs, resolveTarget, now: () => clock, logger: { error() {}, warn() {} } });
  const service = make();
  t.after(() => { service.stop?.(); jobs.stop(); cleanupDb(dbPath, db); });
  const human = (role) => { service.noteHumanPrompt(session(role)); return service.scope(session(role)); };
  const row = (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id);
  return { db, config, jobs, service, make, human, row, advance(ms) { clock += ms; } };
}
const ask = (to, body = 'What is the Q3 budget?') => ({ to, kind: 'ask', body });

test('tokens exist only for role sessions, are stable per session and differ between sessions', (t) => {
  const f = fixture(t);
  const a = f.service.scope(session('orchestrator'));
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(f.service.scope(session('orchestrator')), a);
  assert.notEqual(f.service.scope(session('marketing')), a);
  assert.equal(f.service.scope(session('reports')), null, 'a route that is not a role gets no token');
  assert.equal(f.service.scope('-1001:99'), null);
});

test('a restart issues new tokens; an old or invented token is refused', (t) => {
  const f = fixture(t);
  const old = f.human('orchestrator');
  const restarted = f.make();
  assert.throws(() => restarted.send(old, ask('marketing')), /token/i);
  assert.throws(() => f.service.send('invented', ask('marketing')), /token/i);
  assert.throws(() => f.service.send(undefined, ask('marketing')), /token/i);
});

test('identify resolves a live role-session token to its role, so an outside tool can stamp identity', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.service.identify({ token: f.service.scope(session('marketing')) }), { role: 'marketing' },
    'a session never prompted still identifies; depth is irrelevant here');
  assert.deepEqual(f.service.identify({ token: f.human('orchestrator') }), { role: 'orchestrator' });
  const old = f.service.scope(session('ops'));
  assert.throws(() => f.make().identify({ token: old }), /token/i, 'a token from before a restart is not live');
  for (const token of ['invented', undefined, 42, '']) assert.throws(() => f.service.identify({ token }), /token/i, String(token));
  assert.throws(() => f.service.identify({ token: old, role: 'orchestrator' }), /unknown mailbox field: role/i);
  assert.throws(() => f.service.identify(null), /object/i);
});

test('the daemon stamps the sender; the agent cannot assert identity', (t) => {
  const f = fixture(t);
  const token = f.human('marketing');
  assert.throws(() => f.service.send(token, { ...ask('orchestrator'), from: 'role:orchestrator' }), /unknown mailbox field: from/i);
  const sent = f.service.send(token, ask('orchestrator'));
  assert.equal(f.row(sent.id).from_addr, 'role:marketing');
  assert.equal(f.row(sent.id).to_addr, 'role:orchestrator');
  assert.equal(f.row(sent.id).route_id, 'orchestrator', 'the target route is frozen on the row');
  assert.match(sent.id, /^m_[0-9a-f]{16}$/);
  assert.deepEqual(sent, { id: sent.id, state: 'queued' });
});

test('depth: a human prompt is 0, a mailbox delivery is the message depth, any other job is maxDepth', (t) => {
  const f = fixture(t);
  const first = f.service.send(f.human('orchestrator'), ask('marketing'));
  assert.equal(f.row(first.id).depth, 1, 'a human-started message is depth 1');

  const marketing = f.service.scope(session('marketing'));
  f.service.noteJobSend({ routeId: 'marketing', requestId: `mailbox:${first.id}`, target: { sessionKey: session('marketing') } });
  const second = f.service.send(marketing, ask('orchestrator', 'Need the brief first'));
  assert.equal(f.row(second.id).depth, 2, 'a message started from a delivery turn is one deeper');

  const orchestrator = f.service.scope(session('orchestrator'));
  f.service.noteJobSend({ routeId: 'orchestrator', requestId: `mailbox:${second.id}`, target: { sessionKey: session('orchestrator') } });
  assert.throws(() => f.service.send(orchestrator, ask('ops')), /depth/i, 'depth 3 exceeds maxDepth 2');
  const replied = f.service.reply(orchestrator, { inReplyTo: second.id, body: 'Brief attached at /tmp/brief.md' });
  assert.equal(f.row(replied.id).depth, 2, 'a reply carries its ask depth and is never refused for depth');

  f.service.noteJobSend({ routeId: 'orchestrator', requestId: 'notifications:abc', target: { sessionKey: session('orchestrator') } });
  assert.throws(() => f.service.send(orchestrator, ask('ops')), /depth/i, 'a non-mailbox job turn can only reply');
  f.service.noteJobSend({ routeId: 'orchestrator', requestId: `mailbox-notice:${first.id}`, target: { sessionKey: session('orchestrator') } });
  assert.throws(() => f.service.send(orchestrator, ask('ops')), /depth/i, 'notice turns carry maxDepth');

  f.service.noteHumanPrompt(session('orchestrator'));
  assert.equal(f.row(f.service.send(orchestrator, ask('ops')).id).depth, 1, 'a human prompt resets depth to 0');
});

test('depth: a session with no prompt since boot is treated as maxDepth', (t) => {
  const f = fixture(t);
  const token = f.service.scope(session('orchestrator'));
  assert.throws(() => f.service.send(token, ask('marketing')), /depth/i);
});

test('depth: a mailbox job whose row is for another route is treated as maxDepth', (t) => {
  const f = fixture(t);
  const first = f.service.send(f.human('orchestrator'), ask('marketing'));
  f.service.noteJobSend({ routeId: 'ops', requestId: `mailbox:${first.id}`, target: { sessionKey: session('ops') } });
  f.service.noteJobSend({ routeId: 'orchestrator', requestId: `mailbox:${first.id}`, target: { sessionKey: session('orchestrator') } });
  assert.throws(() => f.service.send(f.service.scope(session('orchestrator')), ask('ops')), /depth/i);
});

test('the allowlist governs asks and tells; nobody messages itself', (t) => {
  const f = fixture(t);
  const marketing = f.human('marketing');
  assert.throws(() => f.service.send(marketing, ask('ops')), /not allowed/i);
  assert.throws(() => f.service.send(f.human('orchestrator'), ask('orchestrator')), /itself/i);
  assert.throws(() => f.service.send(f.human('ops'), { to: 'orchestrator', kind: 'tell', body: 'FYI' }), /not allowed/i);
  assert.throws(() => f.service.send(marketing, ask('sales')), /unknown role/i);
  assert.throws(() => f.service.send(marketing, { ...ask('orchestrator'), kind: 'reply' }), /kind/i);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM mailbox_messages').get().n, 0);
});

test('rate: perPairPerHour asks and tells per pair, counted over the last hour', (t) => {
  const f = fixture(t, { limits: { perPairPerHour: 3 } });
  const token = f.human('orchestrator');
  f.service.send(token, ask('marketing', 'one'));
  f.advance(10 * MINUTE + 1);
  f.service.send(token, { to: 'marketing', kind: 'tell', body: 'two' });
  f.service.send(token, ask('marketing', 'three'));
  assert.throws(() => f.service.send(token, ask('marketing', 'four')), /rate/i);
  assert.doesNotThrow(() => f.service.send(token, ask('ops', 'other pair')), 'the limit is per pair');
  f.advance(HOUR - 10 * MINUTE - 1);
  assert.throws(() => f.service.send(token, ask('marketing', 'four')), /rate/i, 'the oldest message is exactly one hour old');
  f.advance(1);
  assert.doesNotThrow(() => f.service.send(token, ask('marketing', 'four')));
});

test('a duplicate within ten minutes returns the existing message', (t) => {
  const f = fixture(t);
  const token = f.human('orchestrator');
  const first = f.service.send(token, ask('marketing'));
  f.advance(10 * MINUTE);
  const again = f.service.send(token, ask('marketing'));
  assert.deepEqual(again, { id: first.id, state: 'queued', duplicate: true });
  f.advance(1);
  const later = f.service.send(token, ask('marketing'));
  assert.notEqual(later.id, first.id);
  assert.equal(later.duplicate, undefined);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM mailbox_messages').get().n, 2);
});

test('the same body as a different kind is a new message, not a duplicate', (t) => {
  const f = fixture(t);
  const token = f.human('orchestrator');
  const tell = f.service.send(token, { to: 'marketing', kind: 'tell', body: 'Launch is Monday' });
  const question = f.service.send(token, { to: 'marketing', kind: 'ask', body: 'Launch is Monday' });
  assert.notEqual(question.id, tell.id, 'an ask after a tell must not die as the tell');
  assert.equal(question.duplicate, undefined);
  assert.equal(f.row(question.id).kind, 'ask');
  assert.equal(f.service.send(token, { to: 'marketing', kind: 'tell', body: 'Launch is Monday' }).id, tell.id);
});

test('bodies are bounded and redacted before they are persisted or hashed', (t) => {
  const f = fixture(t, { limits: { maxBodyBytes: 100 } });
  const token = f.human('orchestrator');
  assert.throws(() => f.service.send(token, ask('marketing', 'x'.repeat(101))), /exceeds 100 bytes/);
  assert.throws(() => f.service.send(token, ask('marketing', '')), /body/i);
  const sent = f.service.send(token, ask('marketing', 'deploy with AKIAABCDEFGHIJKLMNOP now'));
  assert.doesNotMatch(f.row(sent.id).body, /AKIAABCDEFGHIJKLMNOP/);
  const again = f.service.send(token, ask('marketing', 'deploy with AKIAZZZZZZZZZZZZZZZZ now'));
  assert.equal(again.id, sent.id, 'two bodies that differ only in a secret hash the same once redacted');
});

test('a reply answers one open ask addressed to the caller, exactly once', (t) => {
  const f = fixture(t);
  const question = f.service.send(f.human('orchestrator'), ask('ops'));
  const ops = f.service.scope(session('ops'));
  const marketing = f.human('marketing');
  assert.throws(() => f.service.reply(marketing, { inReplyTo: question.id, body: 'Mine' }), /not addressed/i);
  const answer = f.service.reply(ops, { inReplyTo: question.id, body: 'Budget is 10k' });
  const row = f.row(answer.id);
  assert.equal(row.kind, 'reply'); assert.equal(row.from_addr, 'role:ops'); assert.equal(row.to_addr, 'role:orchestrator');
  assert.equal(row.in_reply_to, question.id); assert.equal(row.route_id, 'orchestrator');
  assert.deepEqual(f.service.reply(ops, { inReplyTo: question.id, body: 'Budget is 10k' }), { ...answer, duplicate: true }, 'a retried reply is idempotent');
  assert.throws(() => f.service.reply(ops, { inReplyTo: question.id, body: 'Actually 12k' }), /already/i);
  assert.throws(() => f.service.reply(ops, { inReplyTo: 'm_0000000000000000', body: 'x' }), /no such ask/i);
  const tell = f.service.send(f.service.scope(session('orchestrator')), { to: 'ops', kind: 'tell', body: 'FYI' });
  assert.throws(() => f.service.reply(ops, { inReplyTo: tell.id, body: 'ok' }), /not an ask/i);
  assert.throws(() => f.service.reply(ops, { inReplyTo: answer.id, body: 'ok' }), /not an ask/i);
  assert.throws(() => f.service.reply(ops, { inReplyTo: question.id, body: 'x', to: 'marketing' }), /unknown mailbox field/i);
});

test('a reply to a role that is no longer configured is refused', (t) => {
  const f = fixture(t);
  const question = f.service.send(f.human('orchestrator'), ask('ops'));
  delete f.config.bot.mailbox.roles.orchestrator;
  f.config.bot.mailbox.allow = {};
  const restarted = f.make();
  restarted.noteHumanPrompt(session('ops'));
  assert.throws(() => restarted.reply(restarted.scope(session('ops')), { inReplyTo: question.id, body: 'x' }), /no longer configured/i);
});

test('a paused target reports paused instead of queued', (t) => {
  const f = fixture(t);
  f.jobs.pauseSession(session('marketing'), true);
  assert.equal(f.service.send(f.human('orchestrator'), ask('marketing')).state, 'paused');
});

test('instructions name the caller, the roles it may message, both commands and the guidance', (t) => {
  const f = fixture(t);
  const text = f.service.instructions(session('marketing'));
  const token = f.service.scope(session('marketing'));
  assert.ok(text.includes(token), 'the session token travels in the instructions');
  assert.match(text, /role:marketing/);
  assert.match(text, /orchestrator \(Owns strategy; routes work\)/);
  assert.doesNotMatch(text, /ops \(Operations\)/, 'only roles on the caller allowlist are offered');
  assert.ok(text.includes(JSON.stringify(process.execPath)));
  assert.ok(text.includes(JSON.stringify(require('node:path').resolve(__dirname, '../skills/mailbox/scripts/msg.js'))));
  assert.match(text, / send '\{"to":/); assert.match(text, / reply '\{"id":/);
  assert.match(text, /exactly once/i); assert.match(text, /never wait or poll/i);
  assert.match(text, /summaries and file paths, never transcripts/i);
  assert.match(f.service.instructions(session('ops')), /may message: none/i);
  assert.equal(f.service.instructions(session('reports')), '', 'non-role sessions get nothing');
});

test('with no mailbox key nothing is exposed and nothing is required', (t) => {
  const { db, dbPath } = freshDb('mailbox-off');
  t.after(() => cleanupDb(dbPath, db));
  const service = createMailboxService({ config: { bot: {} }, db, botName: 'test', jobs: null, resolveTarget });
  assert.equal(service.enabled, false);
  assert.equal(service.scope('-1001:11'), null);
  assert.equal(service.instructions('-1001:11'), '');
  service.noteHumanPrompt('-1001:11');
  service.noteJobSend({ routeId: 'x', requestId: 'mailbox:m_1', target: { sessionKey: '-1001:11' } });
  assert.throws(() => service.send('t', ask('x')), /disabled/i);
  assert.throws(() => service.reply('t', { inReplyTo: 'm_1', body: 'x' }), /disabled/i);
  assert.throws(() => service.identify({ token: 't' }), (error) => error.code === 'MAILBOX_DISABLED');
});

test('invalid configuration fails at construction', (t) => {
  const f = fixture(t);
  f.config.bot.externalJobs.routes.ops = routes.marketing;
  assert.throws(() => f.make(), /share a session/);
});

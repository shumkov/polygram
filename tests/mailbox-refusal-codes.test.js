'use strict';
// The codes a caller outside the daemon relies on to classify a mailbox
// refusal: the agent-org task runner retries a rate limit later and gives up
// on a permanent refusal. The strings are a contract; changing one breaks
// that caller silently, so each is pinned here exactly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createMailboxService } = require('../lib/mailbox/service');
const rules = require('../lib/mailbox/rules');
const { createIpcHandlers } = require('../lib/ipc/handlers');
const server = require('../lib/ipc/server');
const client = require('../lib/ipc/client');

const routes = { orchestrator: { chatId: '-1001', threadId: '11' }, marketing: { chatId: '-1001', threadId: '12' } };
const session = (role) => `${routes[role].chatId}:${routes[role].threadId}`;
const resolveTarget = (route) => ({ chatId: route.chatId, threadId: route.threadId, sessionKey: `${route.chatId}:${route.threadId}` });
const quiet = { error() {}, warn() {}, log() {} };

function fixture(t, mailbox = {}) {
  const { db, dbPath } = freshDb('mailbox-codes');
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes) }, mailbox: {
    enabled: true, roles: { orchestrator: { about: 'Strategy' }, marketing: { about: 'Campaigns' } }, allow: { orchestrator: ['*'] },
    systemSenders: ['agent-org'], ...mailbox,
  } } };
  const jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget, dispatch: async () => ({}), deliverPart: async () => ({}), logger: quiet });
  const service = createMailboxService({ config, db, botName: 'test', jobs, resolveTarget, logger: quiet });
  t.after(() => { service.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  service.noteHumanPrompt(session('orchestrator'));
  return { service, token: service.scope(session('orchestrator')) };
}
const coded = (code) => (error) => { assert.equal(error.code, code, error.message); return true; };

test('the refusal codes are exactly the contracted strings', () => {
  assert.deepEqual(Object.values(rules.REFUSAL).sort(), [
    'MAILBOX_DISABLED', 'MAILBOX_KEY_CONFLICT', 'MAILBOX_NOT_SYSTEM_SENDER', 'MAILBOX_RATE_LIMITED', 'MAILBOX_TOO_LARGE', 'MAILBOX_UNKNOWN_ROLE',
  ]);
});

test('a sender missing from mailbox.systemSenders is MAILBOX_NOT_SYSTEM_SENDER', (t) => {
  const f = fixture(t);
  assert.throws(() => f.service.submit({ sender: 'billing', to: 'marketing', body: 'B', key: 'k' }), coded('MAILBOX_NOT_SYSTEM_SENDER'));
});

test('a key reused with a different target or body is MAILBOX_KEY_CONFLICT', (t) => {
  const f = fixture(t);
  f.service.submit({ sender: 'agent-org', to: 'marketing', body: 'B', key: 'k' });
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'marketing', body: 'other', key: 'k' }), coded('MAILBOX_KEY_CONFLICT'));
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'orchestrator', body: 'B', key: 'k' }), coded('MAILBOX_KEY_CONFLICT'));
});

test('the system hourly budget is MAILBOX_RATE_LIMITED, like the per-pair limit', (t) => {
  const f = fixture(t, { limits: { systemPerHour: 1 } });
  f.service.submit({ sender: 'agent-org', to: 'marketing', body: 'B', key: 'k1' });
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'marketing', body: 'B', key: 'k2' }), coded('MAILBOX_RATE_LIMITED'));
});

test('an unknown target role is MAILBOX_UNKNOWN_ROLE', (t) => {
  const f = fixture(t);
  assert.throws(() => f.service.send(f.token, { to: 'sales', kind: 'ask', body: 'Q' }), coded('MAILBOX_UNKNOWN_ROLE'));
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'sales', body: 'B', key: 'k' }), coded('MAILBOX_UNKNOWN_ROLE'));
});

test('a body over maxBodyBytes, before or after redaction, is MAILBOX_TOO_LARGE', (t) => {
  const f = fixture(t, { limits: { maxBodyBytes: 36 } });
  assert.throws(() => f.service.send(f.token, { to: 'marketing', kind: 'ask', body: 'x'.repeat(37) }), coded('MAILBOX_TOO_LARGE'));
  // 35 bytes as sent, 38 once the key becomes its longer placeholder.
  assert.throws(() => f.service.send(f.token, { to: 'marketing', kind: 'ask', body: `key AKIAABCDEFGHIJKLMNOP ${'x'.repeat(10)}` }),
    (error) => /Redacted/.test(error.message) && coded('MAILBOX_TOO_LARGE')(error));
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'marketing', body: 'x'.repeat(37), key: 'k' }), coded('MAILBOX_TOO_LARGE'));
});

test('the per-pair rate limit for agent sends is MAILBOX_RATE_LIMITED', (t) => {
  const f = fixture(t, { limits: { perPairPerHour: 1 } });
  f.service.send(f.token, { to: 'marketing', kind: 'tell', body: 'one' });
  assert.throws(() => f.service.send(f.token, { to: 'marketing', kind: 'tell', body: 'two' }), coded('MAILBOX_RATE_LIMITED'));
});

test('a disabled mailbox is MAILBOX_DISABLED, from the service and from the IPC op', async (t) => {
  const { db, dbPath } = freshDb('mailbox-codes-off');
  t.after(() => cleanupDb(dbPath, db));
  const off = createMailboxService({ config: { bot: {} }, db, botName: 'test', jobs: null, resolveTarget });
  assert.throws(() => off.send('t', { to: 'marketing', kind: 'ask', body: 'Q' }), coded('MAILBOX_DISABLED'));
  assert.throws(() => off.reply('t', { inReplyTo: 'm_1', body: 'A' }), coded('MAILBOX_DISABLED'));
  assert.throws(() => off.submit({ sender: 'agent-org', to: 'marketing', body: 'B', key: 'k' }), coded('MAILBOX_DISABLED'));
  await assert.rejects(async () => createIpcHandlers().mailbox_send({ token: 't', to: 'marketing', kind: 'ask', body: 'Q' }), coded('MAILBOX_DISABLED'));
  await assert.rejects(async () => createIpcHandlers().mailbox_submit({ sender: 'agent-org', to: 'marketing', body: 'B', key: 'k' }), coded('MAILBOX_DISABLED'));
});

test('a refusal code reaches an IPC client unchanged', async (t) => {
  const f = fixture(t);
  const socket = path.join(os.tmpdir(), `mbx-codes-${process.pid}-${Date.now()}.sock`);
  const ipc = await server.start({ path: socket, handlers: createIpcHandlers({ mailbox: f.service }), logger: quiet });
  t.after(() => ipc.close());
  const res = await client.call({ path: socket, op: 'mailbox_send', payload: { token: f.token, to: 'sales', kind: 'ask', body: 'Q' } });
  assert.deepEqual({ ok: res.ok, code: res.code }, { ok: false, code: 'MAILBOX_UNKNOWN_ROLE' });
  const accepted = await client.call({ path: socket, op: 'mailbox_submit', payload: { sender: 'agent-org', to: 'marketing', body: 'B', key: 'k' } });
  assert.deepEqual({ ok: accepted.ok, state: accepted.state }, { ok: true, state: 'queued' });
  const conflict = await client.call({ path: socket, op: 'mailbox_submit', payload: { sender: 'agent-org', to: 'marketing', body: 'other', key: 'k' } });
  assert.deepEqual({ ok: conflict.ok, code: conflict.code }, { ok: false, code: 'MAILBOX_KEY_CONFLICT' });
});

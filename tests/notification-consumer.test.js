'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb, insertInbound } = require('./helpers/db-fixture');
const { createNotificationService } = require('../lib/external-jobs/notifications');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createSender } = require('../lib/telegram/api');
function fixture(t, overrides = {}) {
  const { db, dbPath } = freshDb('notification'); let clock = 100000; let messageId = 70;
  const calls = []; const sends = [];
  const config = { bot: { externalJobs: { enabled: true, routes: { admin: { chatId: '-1001', threadId: '2995' } } }, notifications: {
    enabled: true, sources: { host: { routeId: 'admin' }, coverage: { routeId: 'admin', eligible: false } },
    consumers: { admin: { routeId: 'admin', generation: 'test-v1', baseline: 0 } },
  } } };
  const resolveTarget = (route) => ({ ...route, sessionKey: `${route.chatId}:${route.threadId}` });
  const jobOptions = { db, config, botName: 'test', resolveTarget, now: () => clock,
    dispatch: async (job) => { calls.push(job); return { outcome: 'succeeded', channelsAcknowledged: true, inactive: true }; },
    checkInactive: async () => false, deliverPart: async () => ({}), ...overrides.jobs };
  const jobs = createExternalJobService(jobOptions);
  const bot = { api: { raw: { sendMessage: async (params) => { sends.push(params); if (overrides.sendError) throw overrides.sendError;
    return { message_id: ++messageId, date: clock / 1000, chat: { id: Number(params.chat_id) }, message_thread_id: Number(params.message_thread_id) }; } } } };
  const notificationOptions = { db, config, botName: 'test', jobs, resolveTarget, bot, tg: createSender(db), now: () => clock, logger: { error() {} } };
  const notifications = createNotificationService(notificationOptions);
  t.after(() => { notifications.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  return { db, dbPath, config, jobs, notifications, jobOptions, notificationOptions, calls, sends, advance(ms = 5001) { clock += ms; } };
}
const alert = (eventId = '1', sourceId = 'host') => ({ sourceId, eventId, text: 'Disk WARNING', data: { host: 'shumabook' } });
test('accepted source input is one outbound history row before send; exact retries do not send twice', async (t) => {
  const f = fixture(t); const receipt = f.notifications.notify(alert());
  assert.equal(receipt.accepted, true); assert.equal(f.sends.length, 0);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM messages').get().n, 1);
  assert.equal(f.notifications.notify(alert()).duplicate, true);
  assert.throws(() => f.notifications.notify({ ...alert(), text: 'different' }), /conflict/i);
  f.notifications.start(); await f.notifications.tick();
  const row = f.db.raw.prepare('SELECT * FROM messages').get();
  assert.equal(row.direction, 'out'); assert.equal(row.source, 'host'); assert.equal(row.msg_id, 71);
  assert.equal(f.notifications.get({ sourceId: 'host', eventId: '1' }).notification.deliveryState, 'delivered');
  await f.notifications.tick(); assert.equal(f.sends.length, 1);
});
test('burst coalesces with scoped human history; succeeded execution advances despite unknown report', async (t) => {
  const f = fixture(t); insertInbound(f.db, { chat_id: '-1001', thread_id: '2995', text: 'What happened?', msg_id: 1 });
  insertInbound(f.db, { chat_id: '-1001', thread_id: '9', text: 'PRIVATE OTHER TOPIC', msg_id: 2 });
  f.notifications.notify(alert()); f.notifications.notify(alert('2')); f.advance();
  f.jobs.start(); f.notifications.start(); await f.notifications.tick(); await f.jobs.tick(); await f.notifications.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.notifications.length, 2);
  assert.match(JSON.stringify(f.calls[0].payload.history), /What happened/); assert.doesNotMatch(JSON.stringify(f.calls[0].payload), /PRIVATE OTHER TOPIC/);
  assert.equal(f.jobs.get({ routeId: 'admin', requestId: f.calls[0].requestId }).job.reportState, 'unknown');
  f.notifications.notify(alert('3')); f.advance(); await f.notifications.tick(); await f.jobs.tick(); await f.notifications.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.notifications.status('admin').unread, 0);
});
test('paused automation still exposes pending context to a resumed human turn and excludes own notices', async (t) => {
  const f = fixture(t); f.jobs.pauseSession('-1001:2995', true); f.notifications.notify(alert()); f.notifications.notify(alert('coverage', 'coverage'));
  f.notifications.start(); f.jobs.start(); f.advance(); await f.notifications.tick(); await f.jobs.tick();
  assert.equal(f.calls.length, 0); assert.match(f.notifications.context('-1001:2995'), /Disk WARNING/);
  assert.equal(f.notifications.status('admin').unread, 1);
});
test('ambiguous Telegram delivery stays unknown while its source input is processed', async (t) => {
  const f = fixture(t, { sendError: new Error('socket reset after write') }); f.notifications.notify(alert());
  f.notifications.start(); await f.notifications.tick(); f.advance();
  f.jobs.start(); await f.notifications.tick(); await f.jobs.tick(); await f.notifications.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.notifications[0].deliveryState, 'unknown');
  assert.equal(f.notifications.status('admin').unread, 0); f.advance(600000); await f.notifications.tick(); assert.equal(f.sends.length, 1);
});
test('an unknown execution holds its frozen batch without replay or cursor advancement', async (t) => {
  let turns = 0; const f = fixture(t, { jobs: { dispatch: async () => { turns++; return { outcome: 'unknown', inactive: true }; } } });
  f.notifications.notify(alert()); f.advance(); f.jobs.start(); f.notifications.start(); await f.notifications.tick(); await f.jobs.tick();
  f.advance(600000); await f.notifications.tick(); await f.jobs.tick(); assert.equal(turns, 1);
  assert.equal(f.notifications.status('admin').unread, 1); assert.equal(f.notifications.status('admin').batch.state, 'unknown');
});
test('a due wake runs without new input and old completion cannot consume a replacement revision', async (t) => {
  const f = fixture(t); const scope = f.notifications.scope('-1001:2995');
  const scheduled = f.notifications.schedule(scope, { key: 'disk', dueAt: 101000, context: 'Check current Netdata disk evidence', notificationIds: [] });
  assert.equal(scheduled.revision, 1); f.advance(1001); f.notifications.start(); await f.notifications.tick();
  f.notifications.schedule(scope, { key: 'disk', dueAt: 200000, context: 'Later check', notificationIds: [] });
  f.jobs.start(); await f.jobs.tick(); await f.notifications.tick();
  const status = f.notifications.status('admin'); assert.equal(f.calls.length, 1); assert.equal(status.wakes[0].revision, 2); assert.equal(status.wakes[0].dueAt, 200000);
});
test('storage refusal rejects intake before network and preserves notification identity', async (t) => {
  const f = fixture(t); f.db.raw.exec("CREATE TRIGGER deny_history BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.throws(() => f.notifications.notify(alert()), /disk full/); assert.equal(f.sends.length, 0);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM recorded_notifications').get().n, 0);
});

test('replying after processing still identifies the exact source and transport outcome', async (t) => {
  const f = fixture(t); f.notifications.notify(alert()); f.advance(); f.jobs.start(); f.notifications.start();
  await f.notifications.tick(); await f.jobs.tick(); await f.notifications.tick();
  assert.equal(f.notifications.status('admin').unread, 0);
  const context = f.notifications.context('-1001:2995', 71);
  assert.match(context, /host/); assert.match(context, /Disk WARNING/); assert.match(context, /delivered/);
  assert.equal(f.notifications.context('-1001:9', 71), '');
  const row = require('../lib/history').getMsg(f.db, { chatId: '-1001', msgId: 71, allowedChatIds: ['-1001'] });
  assert.equal(row.notification.sourceId, 'host'); assert.equal(row.notification.deliveryState, 'delivered');
});
test('a new notification during execution remains unread until the next frozen batch', async (t) => {
  let release; const f = fixture(t, { jobs: { dispatch: (job) => { f.calls.push(job); return new Promise((resolve) => { release = resolve; }); } } });
  f.notifications.notify(alert()); f.advance(); f.jobs.start(); f.notifications.start(); await f.notifications.tick();
  const execution = f.jobs.tick(); await new Promise(setImmediate);
  f.notifications.notify(alert('2')); release({ outcome: 'succeeded', channelsAcknowledged: true, inactive: true }); await execution;
  await f.notifications.tick(); assert.equal(f.notifications.status('admin').unread, 1); assert.equal(f.calls[0].payload.notifications.length, 1);
});
test('a canceled key stays canceled after the older running check completes', async (t) => {
  const f = fixture(t); const scope = f.notifications.scope('-1001:2995');
  f.notifications.schedule(scope, { key: 'disk', dueAt: 101000, context: 'Check', notificationIds: [] });
  f.advance(1001); f.notifications.start(); await f.notifications.tick();
  f.notifications.schedule(scope, { key: 'disk', dueAt: null }); f.jobs.start(); await f.jobs.tick(); await f.notifications.tick();
  const wake = f.notifications.status('admin').wakes[0]; assert.equal(wake.revision, 2); assert.equal(wake.dueAt, null);
  f.advance(600000); await f.notifications.tick(); await f.jobs.tick(); assert.equal(f.calls.length, 1);
});
test('bounded batches preserve overflow in order and do not treat coverage notices as work', async (t) => {
  const f = fixture(t); for (let n = 1; n <= 22; n++) f.notifications.notify({ ...alert(String(n)), text: `Alert ${n}` });
  f.notifications.notify(alert('coverage', 'coverage')); f.advance(); f.jobs.start(); f.notifications.start();
  await f.notifications.tick(); await f.jobs.tick(); await f.notifications.tick(); await f.jobs.tick(); await f.notifications.tick();
  assert.deepEqual(f.calls.map((job) => job.payload.notifications.length), [20, 2]);
  assert.deepEqual(f.calls.flatMap((job) => job.payload.notifications.map((n) => n.eventId)), Array.from({ length: 22 }, (_, n) => String(n + 1)));
});
test('scheduling cannot target another destination or use an unissued scope', (t) => {
  const f = fixture(t); assert.throws(() => f.notifications.schedule('invented', { key: 'x', dueAt: 101000, context: 'x' }), /scope/);
  assert.throws(() => f.notifications.schedule(f.notifications.scope('-1001:2995'), { key: 'x', dueAt: 101000, context: 'x', chatId: '-1002' }), /Unknown wake/);
});

test('reopening SQLite retains unread source input, pause and overdue wake without historical replay', async (t) => {
  const f = fixture(t); f.notifications.notify(alert()); f.jobs.pauseSession('-1001:2995', true);
  f.notifications.schedule(f.notifications.scope('-1001:2995'), { key: 'disk', dueAt: 101000, context: 'Fresh evidence', notificationIds: [1] });
  f.notifications.stop(); f.jobs.stop(); f.db.raw.close(); f.advance(120000);
  const db = require('../lib/db').open(f.dbPath);
  const jobs = createExternalJobService({ ...f.jobOptions, db });
  const notifications = createNotificationService({ ...f.notificationOptions, db, jobs, tg: createSender(db) });
  t.after(() => { notifications.stop(); jobs.stop(); db.raw.close(); });
  jobs.start(); notifications.start(); await notifications.tick(); await jobs.tick(); assert.equal(f.calls.length, 0);
  assert.equal(notifications.status('admin').unread, 1); assert.equal(notifications.status('admin').paused, true);
  assert.match(notifications.context('-1001:2995'), /Disk WARNING/);
  jobs.pauseSession('-1001:2995', false); await notifications.tick(); await jobs.tick(); await notifications.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.checks.length, 1); assert.equal(notifications.status('admin').unread, 0);
  assert.equal(f.sends.length, 1);
});
test('two monitors share one frozen request and one Telegram receipt', async (t) => {
  const f = fixture(t); const other = createNotificationService(f.notificationOptions); t.after(() => other.stop());
  f.notifications.notify(alert()); f.advance(); f.jobs.start(); f.notifications.start(); other.start();
  await Promise.all([f.notifications.tick(), other.tick()]); await f.jobs.tick(); await Promise.all([f.notifications.tick(), other.tick()]);
  assert.equal(f.sends.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.notifications.status('admin').unread, 0);
});
test('lost notification IPC acknowledgement is recovered by stable identity over authenticated socket', async (t) => {
  const f = fixture(t); const os = require('node:os'); const path = require('node:path');
  const server = require('../lib/ipc/server'); const client = require('../lib/ipc/client'); const { createIpcHandlers } = require('../lib/ipc/handlers');
  const socket = path.join(os.tmpdir(), `notify-${process.pid}-${Date.now()}.sock`);
  const handlers = createIpcHandlers({ notifications: f.notifications });
  let first = true;
  const ipc = await server.start({ path: socket, secret: 'test-secret', handlers: { ...handlers, notify: async (request) => {
    const result = handlers.notify(request); if (first) { first = false; await new Promise((resolve) => setTimeout(resolve, 100)); } return result;
  } }, logger: { error() {}, log() {} } }); t.after(() => ipc.close());
  const call = (op, payload, secret = 'test-secret', callTimeoutMs = 2000) => client.call({ path: socket, op, secret, payload, callTimeoutMs });
  assert.equal((await call('notify', alert(), 'bad')).ok, false);
  await assert.rejects(call('notify', alert(), 'test-secret', 20), /timeout/);
  const retry = await call('notify', alert()); assert.equal(retry.ok, true); assert.equal(retry.duplicate, true);
  const readback = await call('notification_get', { sourceId: 'host', eventId: '1' }); assert.equal(readback.notification.id, retry.notification.id);
  const scope = f.notifications.scope('-1001:2995');
  const scheduled = await call('notification_wake', { scope, key: 'check', dueAt: 101000, context: 'Read current evidence', notificationIds: [1] });
  assert.equal(scheduled.ok, true); assert.equal(scheduled.revision, 1);
  assert.equal((await call('notification_wake', { scope: 'invented', key: 'x', dueAt: 101000, context: 'x' })).ok, false);
  f.notifications.start(); await f.notifications.tick(); assert.equal(f.sends.length, 1);
});

test('valid escaped wake contexts cannot poison a frozen batch beyond the external job envelope limit', async (t) => {
  const f = fixture(t); const scope = f.notifications.scope('-1001:2995');
  for (const key of ['first', 'second']) f.notifications.schedule(scope, { key, dueAt: 101000, context: '\u0001'.repeat(2048), notificationIds: [] });
  for (let n = 0; n < 4; n++) f.notifications.notify({ ...alert(String(n)), text: 'WARNING ' + 'x'.repeat(3900) });
  f.advance(5001); f.jobs.start(); f.notifications.start();
  for (let n = 0; n < 5; n++) { await f.notifications.tick(); await f.jobs.tick(); }
  await f.notifications.tick();
  assert.equal(f.notifications.status('admin').unread, 0);
  assert.ok(f.calls.length > 0); assert.equal(f.calls.flatMap((job) => job.payload.checks).length, 2);
  for (const job of f.calls) assert.ok(Buffer.byteLength(JSON.stringify({ task: job.task, payload: job.payload })) <= 32768);
});

test('a stalled Telegram send cannot delay source diagnosis or an independently due check', async (t) => {
  const f = fixture(t); let releaseSend;
  const bot = { api: { raw: { sendMessage: (params) => new Promise((resolve) => { releaseSend = () => resolve({ message_id: 99, date: 100, chat: { id: Number(params.chat_id) }, message_thread_id: Number(params.message_thread_id) }); }) } } };
  const monitor = createNotificationService({ ...f.notificationOptions, bot }); t.after(() => monitor.stop());
  monitor.notify(alert()); monitor.schedule(monitor.scope('-1001:2995'), { key: 'disk', dueAt: 101000, context: 'Fresh check', notificationIds: [1] });
  f.advance(); f.jobs.start(); monitor.start(); const delivery = monitor.tick();
  try {
    await new Promise(setImmediate); await f.jobs.tick();
    assert.equal(f.calls.length, 1, 'execution must start before the blocked network request completes');
    assert.equal(f.calls[0].payload.checks.length, 1);
  } finally { releaseSend?.(); await delivery; }
});

test('secret redaction expansion is rejected before acceptance and legacy oversized rows never trigger empty turns', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.notifications.notify({ ...alert(), data: { passwords: Array(1500).fill('x') } }), /sanitized.*size|sanitized.*limit/i);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM messages').get().n, 0);
  f.notifications.notify(alert('legacy'));
  f.db.raw.prepare('UPDATE recorded_notifications SET data=?').run(JSON.stringify({ historical: 'x'.repeat(40000) }));
  f.advance(); f.jobs.start(); f.notifications.start(); await f.notifications.tick(); await f.jobs.tick(); await f.notifications.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.notifications.status('admin').unread, 1);
  assert.match(f.notifications.status('admin').error, /size|budget/i);
});

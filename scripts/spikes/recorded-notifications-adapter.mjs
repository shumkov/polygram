#!/usr/bin/env node
// Offline contract gate across separate adapter and Polygram checkouts.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const adapterRoot = process.argv[2];
if (!adapterRoot || !path.isAbsolute(adapterRoot)) throw new Error('Usage: node scripts/spikes/recorded-notifications-adapter.mjs /absolute/infra-agent-checkout');
const adapter = require(path.join(adapterRoot, 'scripts/infra.js'));
const { open } = require('../../lib/db');
const ipc = require('../../lib/ipc/client');
const { start } = require('../../lib/ipc/server');
const { createIpcHandlers } = require('../../lib/ipc/handlers');
const { createExternalJobService } = require('../../lib/external-jobs/service');
const { createNotificationService } = require('../../lib/external-jobs/notifications');
const { createSender } = require('../../lib/telegram/api');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-adapter-contract-')));
let db, server, jobs, notifications;
try {
  db = open(path.join(temporary, 'polygram.db'));
  let clock = 100000, reads = 0, ackLost = false, messageId = 70;
  const sends = [], turns = [];
  const config = { bot: { externalJobs: { enabled: true, routes: { admin: { chatId: '-1001', threadId: '2995' } } }, notifications: {
    enabled: true, sources: { mac: { routeId: 'admin' }, 'mac-coverage': { routeId: 'admin', eligible: false }, 'mac-cargo-sweep': { routeId: 'admin' } },
    consumers: { admin: { routeId: 'admin', generation: 'contract-v1', baseline: 0 } },
  } } };
  const resolveTarget = (route) => ({ ...route, sessionKey: '-1001:2995' });
  jobs = createExternalJobService({ config, db, botName: 'fixture', resolveTarget, now: () => clock,
    dispatch: async (job) => { turns.push(job); return { outcome: 'succeeded', inactive: true, channelsAcknowledged: true }; },
    deliverPart: async () => { throw new Error('Unexpected report retry'); },
  });
  const bot = { api: { raw: { sendMessage: async (params) => { sends.push(params); return { message_id: ++messageId, date: clock / 1000, chat: { id: -1001 }, message_thread_id: 2995 }; } } } };
  notifications = createNotificationService({ config, db, botName: 'fixture', jobs, resolveTarget, bot, tg: createSender(db), now: () => clock });
  const socket = path.join(temporary, 'ipc.sock');
  server = await start({ path: socket, secret: 'offline-fixture-secret', handlers: createIpcHandlers({ notifications }), logger: { error() {}, log() {} } });
  // The adapter uses the public client's real socket call; only endpoint/secret resolution is fixture-local.
  const client = { ...ipc, socketPathFor: () => socket, readSecret: () => 'offline-fixture-secret', call: async (request) => {
    const result = await ipc.call(request);
    if (request.op === 'notify' && result.accepted && !ackLost) { ackLost = true; throw new Error('Synthetic lost acceptance response'); }
    return result;
  } };
  const configPath = path.join(temporary, 'adapter.json');
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, botName: 'fixture', routeId: 'admin', polygramDataDir: path.join(temporary, 'polygram-ipc'), dataDir: path.join(temporary, 'adapter'), sources: { netdata: { hosts: ['mac'] }, maintenance: { hosts: ['mac'] } }, hosts: [{ name: 'mac', roles: ['sysadmin'] }] }), { mode: 0o600 });
  const transition = (gi, status) => ({ gi, transition_id: `offline-${gi}`, machine_guid: 'fixture-machine', instance: 'disk', alert: 'space', when: gi, new: { status }, old: { status: 'CLEAR' }, notification: { to: 'sysadmin', flags: [] }, summary: status });
  const dependencies = { client, readHost: async (_host, _previous, persist) => {
    reads++; const fence = { cursor: 10, machine: 'fixture-machine' }; persist(fence);
    return { fence, snapshot: { latest_alarm_log_unique_id: 999, alarms: {} }, log: { api: 2, transitions: [transition(30, 'CLEAR'), transition(20, 'WARNING'), transition(10, 'CLEAR')], items: { returned: 3, after: 0 } } };
  } };
  await assert.rejects(adapter.main(['--config', configPath, 'collect'], dependencies), /lost acceptance/);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM recorded_notifications').get().n, 1);
  await adapter.main(['--config', configPath, 'collect'], dependencies);
  assert.equal(reads, 1, 'frozen source cycle is retried without a new read');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM recorded_notifications').get().n, 2, 'lost ACK does not duplicate the source row');
  assert.equal(sends.length, 0, 'accepted input is in history before any Telegram send');
  await adapter.main(['--config', configPath, '--host', 'mac', '--resource', 'cargo-sweep', '--event-id', 'maintenance-fixed', 'notify'], { client, stdin: Readable.from(['Maintenance warning']) });
  assert.equal(db.raw.prepare('SELECT count(*) n FROM recorded_notifications').get().n, 3);
  clock += 5001; jobs.start(); notifications.start(); await notifications.tick(); await jobs.tick(); await notifications.tick();
  assert.equal(turns.length, 1); assert.equal(turns[0].payload.notifications.length, 3);
  assert.deepEqual(turns[0].payload.notifications.slice(0, 2).map((row) => row.data.status), ['WARNING', 'CLEAR']);
  assert.equal(notifications.status('admin').unread, 0);
  assert.equal(notifications.status('admin').lastJob.report_state, 'unknown');
  const rows = db.raw.prepare('SELECT * FROM messages ORDER BY id').all();
  assert.equal(rows.length, 3); assert.ok(rows.every((row) => row.status === 'sent' && row.thread_id === '2995' && row.msg_id > 0));
  assert.equal(rows[2].source, 'mac-cargo-sweep');
  const reply = notifications.context('-1001:2995', rows[0].msg_id);
  assert.match(reply, /WARNING/); assert.match(reply, /unknown/);
  const scope = notifications.scope('-1001:2995');
  const response = await ipc.call({ path: socket, secret: 'offline-fixture-secret', op: 'notification_wake', payload: { scope, key: 'verify', dueAt: clock + 1000, context: 'Check fresh source evidence', notificationIds: [1] } });
  assert.equal(response.ok, true); jobs.pauseSession('-1001:2995', true); clock += 1001;
  await notifications.tick(); await jobs.tick(); assert.equal(turns.length, 1);
  jobs.pauseSession('-1001:2995', false); await notifications.tick(); await jobs.tick(); await notifications.tick(); assert.equal(turns.length, 2);
  assert.equal(turns[1].payload.notifications.length, 0); assert.equal(turns[1].payload.checks.length, 1);
  console.log(JSON.stringify({ passed: true, adapterRoot, sourceReads: reads, recordedNotifications: rows.length, telegramFixtureSends: sends.length, fixtureExecutions: turns.length, lostAckDuplicateRows: 0, reportState: 'unknown', actualNetwork: 'authenticated local IPC only', skipped: 0 }));
} finally {
  notifications?.stop(); jobs?.stop(); await server?.close(); db?.raw.close(); fs.rmSync(temporary, { recursive: true, force: true });
}

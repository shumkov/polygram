'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIpcHandlers } = require('../lib/ipc/handlers');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createInfraService } = require('../lib/infra/service');
const ipcServer = require('../lib/ipc/server');
const ipcClient = require('../lib/ipc/client');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

test('authenticated intake commits once without a Telegram message or source-chosen destination', async (t) => {
  const { db, dbPath } = freshDb('infra-ipc');
  t.after(() => cleanupDb(dbPath, db));
  const config = { bot: { infraAdmin: { enabled: true, chatId: '-1001', threadId: 2995, sources: { netdata: { hosts: ['mac'] } } } }, chats: { '-1001': { isolateTopics: true, topics: { '2995': {} } } } };
  const infra = createInfraService({ config, db, botName: 'home', dispatch: async () => { throw new Error('not started'); } });
  const socket = path.join(os.tmpdir(), `infra-${randomUUID()}.sock`);
  const secret = randomUUID();
  const server = await ipcServer.start({ path: socket, secret, handlers: createIpcHandlers({ infra }), logger: { log() {}, error() {} } });
  t.after(() => server.close());
  const event = { source: 'netdata', host: 'mac', eventId: 'one', resource: 'disk', state: 'WARNING', observedAt: Date.now(), evidence: { kind: 'snapshot' } };
  const call = (auth, payload) => ipcClient.call({ path: socket, secret: auth, op: 'ingest_event', payload });
  assert.equal((await call('wrong', { event })).ok, false);
  assert.equal(infra.status().pending, 0);
  const receipt = await call(secret, { event });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.accepted, true);
  assert.equal((await call(secret, { event })).duplicate, true);
  assert.equal((await call(secret, { event: { ...event, chatId: 'elsewhere' } })).ok, false);
  assert.equal(infra.status().pending, 1);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM messages').get().n, 0);
  const incident = await ipcClient.call({ path: socket, secret, op: 'infra_incidents', payload: { action: 'get', incidentId: receipt.incidentId } });
  assert.equal(incident.incident.events.length, 1);
});

test('registered event intake returns durable receipt and exposes no pause operation', async () => {
  const seen = [];
  const handlers = createIpcHandlers({ infra: {
    ingest: (event) => { seen.push(event); return { accepted: true, receiptId: 12 }; },
    incidents: (req) => ({ incident: req.incidentId }),
    status: () => ({ paused: true }),
    tick: () => ({ scheduled: true }),
  } });
  assert.equal((await handlers.ingest_event({ event: { eventId: 'stable' } })).receiptId, 12);
  assert.deepEqual(seen, [{ eventId: 'stable' }]);
  assert.deepEqual(await handlers.infra_status({}), { paused: true });
  assert.equal(handlers.infra_pause, undefined);
  assert.deepEqual(await handlers.infra_incidents({ incidentId: 'x' }), { incident: 'x' });
});
test('disabled infrastructure intake fails explicitly instead of claiming delivery', async () => {
  const handlers = createIpcHandlers();
  await assert.rejects(async () => handlers.ingest_event({ event: {} }), /not enabled/);
});

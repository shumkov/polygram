'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createInfraService } = require('../lib/infra/service');
const route = { enabled: true, chatId: '-1001', threadId: '2995', sources: { netdata: { hosts: ['mac'] } } };
const alarm = (id = 'one') => ({ source: 'netdata', host: 'mac', eventId: id, resource: 'disk', state: 'WARNING', observedAt: 1000, evidence: { kind: 'snapshot' } });
const flush = () => new Promise((r) => setImmediate(r));
function fixture(t, overrides = {}) {
  const { db, dbPath } = freshDb('infra-service'); t.after(() => cleanupDb(dbPath, db));
  let now = 2000; const calls = []; const notices = [];
  const service = createInfraService({ config: { bot: { infraAdmin: route }, chats: { '-1001': { isolateTopics: true, topics: { '2995': 'Admin' } } } }, db, botName: 'home', now: () => now,
    dispatch: async (work) => { calls.push(work); return { reportReceipt: { messageId: 1 } }; }, notify: async (text) => notices.push(text), ...overrides });
  t.after(() => service.stop()); return { service, calls, notices, db, advance: (ms) => { now += ms; } };
}
test('durable intake acknowledges before a slow agent and serializes each incident', async (t) => {
  let resolve; const calls = []; const f = fixture(t, { dispatch: async (work) => { calls.push(work); return new Promise((r) => { resolve = r; }); } });
  f.service.start(); const receipt = f.service.ingest(alarm()); assert.equal(receipt.accepted, true);
  await flush(); f.service.tick(); f.service.tick(); assert.equal(calls.length, 1);
  resolve({ reportReceipt: { messageId: 2 } }); await flush(); assert.equal(f.service.status().pending, 0);
  assert.ok(f.service.incidents({ action: 'get', incidentId: receipt.incidentId }).incident.events[0].report_receipt);
});
test('pause retains intake and resume schedules it; incident update cannot grant permissions', async (t) => {
  const f = fixture(t); f.service.start(); f.service.pause(true); f.service.ingest(alarm()); await flush(); assert.equal(f.calls.length, 0);
  assert.throws(() => f.service.incidents({ action: 'update', paused: false }), /field|incident/i);
  f.service.pause(false); await flush(); assert.equal(f.calls.length, 1);
});
test('provider outage retains work and fallback does not create another event', async (t) => {
  const f = fixture(t, { dispatch: async () => { throw new Error('offline'); } }); f.service.start(); f.service.ingest(alarm()); await flush();
  assert.equal(f.service.status().pending, 1); assert.equal(f.notices.length, 1);
  f.advance(61000); f.service.tick(); await flush(); assert.equal(f.notices.length, 1);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM external_events').get().n, 1);
});
test('absent configuration is inert and configured nonisolated destination fails closed', (t) => {
  const f = fixture(t, { config: {} }); f.service.start(); assert.equal(f.service.status().enabled, false); assert.throws(() => f.service.ingest(alarm()), /disabled/i);
  assert.throws(() => createInfraService({ config: { bot: { infraAdmin: route }, chats: { '-1001': { topics: { '2995': 'Admin' } } } } }), /isolat/i);
});

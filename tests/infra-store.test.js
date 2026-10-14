'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createInfraStore } = require('../lib/infra/store');

const route = { enabled: true, chatId: '-1001', threadId: '2995', sources: { netdata: { hosts: ['mac'] } } };
const alarm = (extra = {}) => ({ source: 'netdata', host: 'mac', eventId: 'epoch:1', resource: 'disk.root', state: 'WARNING', observedAt: 1000, evidence: { kind: 'snapshot', summary: 'Disk full' }, ...extra });
function fixture(t) {
  const { db, dbPath } = freshDb('infra');
  t.after(() => cleanupDb(dbPath, db));
  let time = 2000;
  return { db, store: createInfraStore(db.raw, { botName: 'home', route, now: () => time }), advance: (n) => { time += n; } };
}

test('externally posted alert is durable actionable work without a Telegram inbound row', (t) => {
  const { db, store } = fixture(t);
  const receipt = store.ingest(alarm());
  assert.equal(receipt.accepted, true);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM messages').get().n, 0);
  const reopened = createInfraStore(db.raw, { botName: 'home', route });
  assert.equal(reopened.list()[0].id, receipt.incidentId);
  assert.equal(reopened.claim().events[0].eventId, 'epoch:1');
});

test('duplicate event cannot repeat work, conflicting reuse fails', (t) => {
  const { store } = fixture(t);
  const first = store.ingest(alarm());
  assert.equal(store.ingest(alarm()).duplicate, true);
  assert.throws(() => store.ingest(alarm({ state: 'CRITICAL' })), /conflict/i);
  const claim = store.claim();
  store.complete(claim.token);
  assert.equal(store.claim(), null);
  assert.equal(store.get(first.incidentId).events.length, 1);
});

test('escalation during investigation stays queued and stale diagnosis cannot overwrite it', (t) => {
  const { store } = fixture(t);
  const { incidentId } = store.ingest(alarm());
  const work = store.claim();
  store.ingest(alarm({ eventId: 'epoch:2', state: 'CRITICAL', observedAt: 1500 }));
  assert.throws(() => store.update({ incidentId, revision: work.incident.revision, summary: 'old' }), /revision/i);
  store.complete(work.token);
  assert.equal(store.claim().events[0].state, 'CRITICAL');
});

test('stop persists across store recreation and new events cannot resume automation', (t) => {
  const { store, db } = fixture(t);
  store.setPaused(true);
  store.ingest(alarm());
  const reopened = createInfraStore(db.raw, { botName: 'home', route });
  assert.equal(reopened.claim(), null);
  reopened.setPaused(false);
  assert.ok(reopened.claim());
});

test('unreachable or disappeared resource is not a verified recovery', (t) => {
  const { store } = fixture(t);
  const { incidentId } = store.ingest(alarm({ state: 'UNKNOWN' }));
  assert.throws(() => store.update({ incidentId, revision: 1, state: 'resolved', verification: 'not listed' }), /healthy/i);
  store.ingest(alarm({ eventId: 'epoch:2', state: 'CLEAR', observedAt: 1500 }));
  assert.throws(() => store.update({ incidentId, revision: 2, state: 'resolved' }), /verification/i);
  store.update({ incidentId, revision: 2, state: 'resolved', verification: 'Fresh snapshot says CLEAR' });
  assert.equal(store.get(incidentId).state, 'resolved');
});

test('failed delivery and interrupted daemon retain work with bounded retry', (t) => {
  const { store, advance } = fixture(t);
  store.ingest(alarm());
  const work = store.claim();
  store.fail(work.token, 'provider unavailable');
  assert.equal(store.claim(), null);
  advance(60001);
  assert.ok(store.claim());
  store.recover();
  advance(60001);
  assert.ok(store.claim());
});

test('due incident wakes even without a new alarm', (t) => {
  const { store, advance } = fixture(t);
  const { incidentId } = store.ingest(alarm());
  const work = store.claim();
  store.update({ incidentId, revision: 1, summary: 'Watching', nextCheckAt: 3000 });
  store.complete(work.token);
  advance(1001);
  assert.equal(store.claim().incident.id, incidentId);
});

test('source cannot choose destination or inject unknown fields and secrets are masked', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.ingest(alarm({ chatId: 'other' })), /field/i);
  assert.throws(() => store.ingest(alarm({ host: 'other' })), /source|host/i);
  const { incidentId } = store.ingest(alarm({ evidence: { summary: 'password=example-private-value' } }));
  assert.ok(!JSON.stringify(store.get(incidentId)).includes('example-private-value'));
});

test('older replay cannot overwrite current healthy observation', (t) => {
  const { store } = fixture(t);
  const { incidentId } = store.ingest(alarm({ state: 'CLEAR', observedAt: 5000 }));
  store.ingest(alarm({ eventId: 'older', state: 'CRITICAL', observedAt: 1000 }));
  assert.equal(store.get(incidentId).latest_state, 'CLEAR');
});

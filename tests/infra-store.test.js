'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createInfraStore } = require('../lib/infra/store');

const route = { enabled: true, chatId: '-1001', threadId: '2995', sources: { netdata: { hosts: ['mac'] } } };
const alarm = (extra = {}) => ({ source: 'netdata', host: 'mac', eventId: 'epoch:1', resource: 'disk.root', state: 'WARNING', observedAt: 1000, evidence: { kind: 'snapshot', summary: 'Disk full' }, ...extra });
function fixture(t, configuredRoute = route) {
  const { db, dbPath } = freshDb('infra');
  t.after(() => cleanupDb(dbPath, db));
  let time = 2000;
  return { db, store: createInfraStore(db.raw, { botName: 'home', route: configuredRoute, now: () => time }), advance: (n) => { time += n; } };
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

for (const interrupted of [false, true]) {
  test(`resolved eventless followup retains its ${interrupted ? 'interrupted' : 'failed'} report`, (t) => {
    const { store, advance } = fixture(t);
    const { incidentId } = store.ingest(alarm({ state: 'CLEAR' }));
    const first = store.claim();
    store.update({ incidentId, revision: 1, nextCheckAt: 3000 });
    store.complete(first.token);
    advance(1001);
    const followup = store.claim();
    assert.equal(followup.events.length, 0);
    store.update({ incidentId, revision: 2, state: 'resolved', verification: 'Health checked' });
    if (interrupted) store.recover();
    else store.fail(followup.token, 'Telegram unavailable');
    store.update({ incidentId, revision: 3, summary: 'Health still verified; report waiting', verification: 'Health checked' });
    advance(60001);
    const retry = store.claim();
    assert.ok(retry, 'resolved health must not discard an undelivered report');
    store.complete(retry.token, { messageIds: [1] });
    advance(1800001);
    assert.equal(store.claim(), null);
  });
}

test('day-old CLEAR cannot close an incident until a fresh source snapshot arrives', (t) => {
  const { store, advance } = fixture(t);
  const { incidentId } = store.ingest(alarm({ state: 'CLEAR' }));
  advance(86400000);
  assert.throws(() => store.update({ incidentId, revision: 1, state: 'resolved', verification: 'Old evidence' }), /fresh|healthy/i);
  store.ingest(alarm({ eventId: 'fresh', state: 'CLEAR', observedAt: 86402000 }));
  store.update({ incidentId, revision: 2, state: 'resolved', verification: 'Read live health again' });
  assert.equal(store.get(incidentId).state, 'resolved');
});

test('all retained incidents and transitions remain accessible through bounded cursors', (t) => {
  const { store } = fixture(t);
  const { incidentId } = store.ingest(alarm());
  for (let n = 1; n <= 150; n++) {
    store.ingest(alarm({ eventId: `history-${n}` }));
    store.ingest(alarm({ eventId: `resource-${n}`, resource: `resource-${n}` }));
  }
  const first = store.get(incidentId);
  assert.equal(first.events.length, 100);
  assert.ok(first.nextBefore);
  const second = store.get(incidentId, first.nextBefore);
  assert.equal(second.events.length, 51);
  assert.equal(second.nextBefore, null);
  assert.equal(new Set([...first.events, ...second.events].map(e => e.eventId)).size, 151);
  const incidents = store.list();
  assert.equal(incidents.length, 100);
  const older = store.list(incidents.at(-1).sequence);
  assert.equal(older.length, 51);
  assert.equal(new Set([...incidents, ...older].map(i => i.id)).size, 151);
  assert.throws(() => store.list(-1), /cursor/i);
});

test('fresh unchanged health refreshes evidence without another agent wakeup', (t) => {
  const { store, advance } = fixture(t);
  const { incidentId } = store.ingest(alarm({ state: 'CLEAR' }));
  store.complete(store.claim().token);
  advance(86400000);
  const receipt = store.observe(alarm({ state: 'CLEAR', eventId: 'live-check', observedAt: 86402000 }));
  assert.equal(receipt.refreshed, true);
  const current = store.get(incidentId);
  store.update({ incidentId, revision: current.revision, state: 'resolved', verification: 'Live source checked' });
  assert.equal(store.claim(), null);
  store.observe(alarm({ state: 'CRITICAL', eventId: 'changed', observedAt: 86402000 }));
  assert.equal(store.claim().events[0].state, 'CRITICAL');
});

test('producer maintenance recovery closes followups and can be refreshed after a delay', (t) => {
  const { maintenanceEvent } = require('../scripts/infra');
  const { store, advance } = fixture(t, { ...route, sources: { maintenance: { hosts: ['mac'] } } });
  const producer = { host: 'mac', resource: 'cargo-sweep', state: 'WARNING' };
  const { incidentId } = store.ingest(maintenanceEvent(producer, 'Disk pressure', 2000));
  store.complete(store.claim().token);
  store.ingest(maintenanceEvent({ ...producer, state: 'CLEAR' }, 'Fresh free-space check healthy', 2000));
  store.complete(store.claim().token);
  advance(86400000);
  assert.throws(() => store.update({ incidentId, revision: 2, state: 'resolved', verification: 'Old producer check' }), /fresh/i);
  store.observe(maintenanceEvent({ ...producer, state: 'CLEAR' }, 'Independent df check meets producer threshold', 86402000));
  store.update({ incidentId, revision: 3, state: 'resolved', verification: 'Repeated read-only free-space check' });
  advance(1800001);
  assert.equal(store.claim(), null);
});

test('unresolved diagnosis gets a default followup only after thirty minutes', (t) => {
  const { store, advance } = fixture(t);
  store.ingest(alarm());
  store.complete(store.claim().token);
  advance(1799999);
  assert.equal(store.claim(), null);
  advance(2);
  assert.ok(store.claim());
});

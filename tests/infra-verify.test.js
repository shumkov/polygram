'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verificationEvent } = require('../lib/infra/verify');
const incident = { source: 'netdata', host: 'mac', resource: 'disk/full' };
const route = { hosts: [{ name: 'mac' }] };
const snapshot = { latest_alarm_log_unique_id: 12, alarms: { disk: { id: 1, chart: 'disk', name: 'full', status: 'CLEAR', active: true } } };

test('explicit verification refreshes unchanged current health through configured source', async () => {
  const event = await verificationEvent(incident, route, { now: () => 5000, readHost: async (host, previous) => {
    assert.equal(host.name, 'mac'); assert.equal(previous, undefined); return { snapshot };
  } });
  assert.equal(event.state, 'CLEAR'); assert.equal(event.observedAt, 5000);
  assert.equal(event.evidence.kind, 'snapshot');
});
test('missing, disabled and unreachable are never healthy verification', async () => {
  for (const readHost of [async () => ({ snapshot: { ...snapshot, alarms: {} } }), async () => ({ snapshot: { ...snapshot, alarms: { disk: { ...snapshot.alarms.disk, disabled: true } } } }), async () => { throw new Error('offline'); }]) {
    assert.equal((await verificationEvent(incident, route, { readHost })).state, 'UNKNOWN');
  }
  await assert.rejects(verificationEvent({ ...incident, host: 'other' }, route), /host/i);
  await assert.rejects(verificationEvent({ ...incident, source: 'maintenance' }, route), /Netdata/i);
});
test('coverage verification requires both current snapshot and available history', async () => {
  const coverage = { ...incident, resource: '__collector__' };
  assert.equal((await verificationEvent(coverage, route, { readHost: async () => ({ snapshot, log: null }) })).state, 'UNKNOWN');
  assert.equal((await verificationEvent(coverage, route, { readHost: async () => ({ snapshot, log: [{ unique_id: 12, when: 4, alarm_id: 1 }] }) })).state, 'CLEAR');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectNetdata } = require('../lib/infra/netdata');
const alarm = (status, extra = {}) => ({ id: 7, name: 'disk', chart: 'disk.space', status, active: true, disabled: false, last_status_change: 90, summary: 'Disk utilization', ...extra });
const snapshot = (status, cursor = 100, extra = {}) => ({ hostname: 'test', latest_alarm_log_unique_id: cursor, alarms: status ? { disk: alarm(status) } : {}, ...extra });
const transition = (unique_id, status, when = 101) => ({ unique_id, alarm_id: 7, name: 'disk', chart: 'disk.space', status, old_status: 'CLEAR', when });
const collect = (previous, snap, log = [], now = 200000) => collectNetdata({ host: 'test', previous, snapshot: snap, log, now });

test('first collection seeds only current active alarms and does not replay history', () => {
  const result = collect(null, snapshot('WARNING'), [transition(99, 'CRITICAL')]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].state, 'WARNING');
  assert.equal(result.events[0].evidence.kind, 'snapshot');
  assert.equal(result.state.cursor, 100);
  assert.equal(collect(null, snapshot('CLEAR'), [transition(99, 'WARNING')]).events.length, 0);
});

test('unchanged polls do not wake the agent and identities repeat deterministically', () => {
  const first = collect(null, snapshot('WARNING'));
  assert.deepEqual(first, collect(null, snapshot('WARNING')));
  assert.deepEqual(collect(first.state, snapshot('WARNING'), [transition(100, 'WARNING')], 201000).events, []);
});

test('transient transitions survive polling but fresh snapshot governs the incident', () => {
  const first = collect(null, snapshot('CLEAR'));
  const result = collect(first.state, snapshot('CLEAR', 102), [transition(100, 'CLEAR'), transition(101, 'WARNING'), transition(102, 'CLEAR', 102)]);
  assert.deepEqual(result.events.map((event) => event.state), ['WARNING', 'CLEAR', 'CLEAR']);
  assert.equal(result.events.at(-1).evidence.kind, 'snapshot');
  assert.equal(result.events.at(-1).observedAt, 200000);
  assert.ok(result.events[0].observedAt < result.events.at(-1).observedAt);
});

test('disappeared disabled and unreachable alarms remain unknown until explicitly healthy', () => {
  const first = collect(null, snapshot('WARNING'));
  for (const snap of [snapshot(null), snapshot('CLEAR', 100, { alarms: { disk: alarm('CLEAR', { disabled: true }) } }), null]) {
    const result = collect(first.state, snap);
    assert.equal(result.events.find((event) => event.resource === first.events[0].resource).state, 'UNKNOWN');
    assert.ok(!result.events.some((event) => event.state === 'CLEAR'));
    assert.deepEqual(collect(result.state, snap, [], 201000).events, []);
    const healthy = collect(result.state, snapshot('CLEAR'), [transition(100, 'WARNING')], 202000);
    assert.equal(healthy.events.find((event) => event.resource === first.events[0].resource).state, 'CLEAR');
  }
});

test('source reset changes identity and retention gap produces explicit unknown coverage', () => {
  const first = collect(null, snapshot('WARNING'));
  const reset = collect(first.state, snapshot('WARNING', 2), [transition(2, 'WARNING')]);
  assert.ok(reset.events.some((event) => event.evidence.reason === 'source-reset'));
  assert.notEqual(reset.events.find((event) => event.resource === first.events[0].resource).eventId, first.events[0].eventId);
  const gap = collect(first.state, snapshot('WARNING', 105), [transition(104, 'WARNING'), transition(105, 'CRITICAL')]);
  assert.ok(gap.events.some((event) => event.evidence.reason === 'log-gap'));
  assert.equal(gap.events.at(-1).state, 'WARNING');
});

test('malformed snapshot cannot become a healthy observation and evidence stays bounded', () => {
  const first = collect(null, snapshot('WARNING'));
  const invalid = collect(first.state, { alarms: {} });
  assert.equal(invalid.events.find((event) => event.resource === first.events[0].resource)?.state, 'UNKNOWN');
  assert.equal(invalid.events.find((event) => event.resource === '__collector__')?.state, 'UNKNOWN');
  const result = collect(null, snapshot('WARNING', 100, { alarms: { disk: alarm('WARNING', { summary: 'x'.repeat(50000) }) } }));
  assert.ok(Buffer.byteLength(JSON.stringify(result.events[0])) < 16384);
});

test('missing alarm log does not discard current health and retains transitions for recovery', () => {
  const first = collect(null, snapshot('WARNING', 100));
  const unavailable = collect(first.state, snapshot('CLEAR', 102), null, 201000);
  assert.equal(unavailable.events.find((event) => event.resource === '__collector__').evidence.reason, 'log-unavailable');
  assert.equal(unavailable.events.find((event) => event.resource === first.events[0].resource).state, 'CLEAR');
  assert.equal(unavailable.state.cursor, 100);
  const unchanged = collect(unavailable.state, snapshot('CLEAR', 102), null, 202000);
  assert.deepEqual(unchanged.events, []);
  assert.equal(unchanged.state.cursor, 100);
  const restored = collect(unchanged.state, snapshot('CLEAR', 102), [transition(100, 'WARNING'), transition(101, 'CRITICAL'), transition(102, 'CLEAR')], 203000);
  assert.deepEqual(restored.events.filter((event) => event.evidence.kind === 'transition').map((event) => event.state), ['CRITICAL', 'CLEAR']);
  assert.equal(restored.events.at(-1).state, 'CLEAR');
  assert.equal(restored.events.at(-1).evidence.kind, 'snapshot');
  assert.equal(restored.state.cursor, 102);
});

test('a source reset during log outage increments epoch once and recovers the new source cursor', () => {
  const first = collect(null, snapshot('WARNING', 100));
  const reset = collect(first.state, snapshot('CRITICAL', 2), null, 201000);
  assert.equal(reset.state.epoch, 1);
  assert.equal(reset.state.cursor, 100);
  const repeated = collect(reset.state, snapshot('CRITICAL', 2), null, 202000);
  assert.equal(repeated.state.epoch, 1);
  assert.deepEqual(repeated.events, []);
  const restored = collect(repeated.state, snapshot('CLEAR', 3), [transition(2, 'CRITICAL'), transition(3, 'CLEAR')], 203000);
  assert.equal(restored.state.epoch, 1);
  assert.equal(restored.state.cursor, 3);
  assert.equal(restored.events.at(-1).state, 'CLEAR');
});

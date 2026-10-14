'use strict';

const { createHash } = require('node:crypto');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = (status) => status === 'WARNING' || status === 'CRITICAL';
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const clip = (value, limit = 1000) => String(value ?? '').slice(0, limit);

function resourceOf(alarm) {
  const name = alarm.chart && alarm.name ? `${alarm.chart}/${alarm.name}` : `alarm:${alarm.id ?? alarm.alarm_id}`;
  return name.length <= 200 ? name : `alarm:${hash(name)}`;
}
function alarmState(alarm) {
  if (alarm.disabled === true || alarm.disabled === 1 || alarm.active === false || alarm.active === 0) return 'UNKNOWN';
  return ['WARNING', 'CRITICAL', 'CLEAR'].includes(alarm.status) ? alarm.status : 'UNKNOWN';
}
function validSnapshot(snapshot) {
  return !!(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && integer(snapshot.latest_alarm_log_unique_id) && snapshot.alarms && typeof snapshot.alarms === 'object'
    && !Array.isArray(snapshot.alarms)
    && Object.values(snapshot.alarms).every((alarm) => alarm && typeof alarm === 'object' && !Array.isArray(alarm)
      && (integer(alarm.id) || (typeof alarm.chart === 'string' && typeof alarm.name === 'string'))));
}
function validLog(log) {
  return Array.isArray(log) && log.every((row) => row && typeof row === 'object' && integer(row.unique_id)
    && integer(row.when) && (integer(row.alarm_id) || (typeof row.chart === 'string' && typeof row.name === 'string')));
}

/** Convert source observations into transitions plus authoritative current evidence. */
function collectNetdata({ host, previous, snapshot, log = [], now = Date.now() }) {
  if (typeof host !== 'string' || !host || host.length > 200 || !integer(now)) throw new Error('Invalid collection host/time');
  const state = structuredClone(previous || { epoch: 0, seeded: false, cursor: 0, alarms: {}, coverage: null, coverageRevision: 0 });
  const events = [];
  function event(resource, status, id, evidence, observedAt = now) {
    events.push({ source: 'netdata', host, eventId: id, resource, state: status, observedAt, evidence });
  }
  function coverage(reason) {
    if (state.coverage === reason) return;
    const wasUnknown = state.coverage != null;
    state.coverage = reason;
    if (!reason && !wasUnknown) return;
    state.coverageRevision++;
    event('__collector__', reason ? 'UNKNOWN' : 'CLEAR', `coverage:${state.coverageRevision}`, {
      kind: 'snapshot', reason: reason || 'reachable', summary: reason ? `Netdata coverage incomplete: ${reason}` : 'Netdata collection restored',
    });
  }
  if (!validSnapshot(snapshot)) {
    coverage('unreachable-or-invalid');
    for (const [resource, alarm] of Object.entries(state.alarms)) {
      if (!alarm.tracked || alarm.state === 'UNKNOWN') continue;
      alarm.state = 'UNKNOWN';
      alarm.fingerprint = 'unreachable';
      alarm.revision++;
      event(resource, 'UNKNOWN', `snapshot:${state.epoch}:${hash(resource)}:${alarm.revision}`, {
        kind: 'snapshot', reason: 'unreachable', summary: 'Alarm health cannot be observed',
      });
    }
    return { events, state };
  }

  const cursor = snapshot.latest_alarm_log_unique_id;
  const logAvailable = validLog(log);
  state.cursorEpoch ??= state.epoch;
  const reset = state.seeded && cursor < (state.snapshotCursor ?? state.cursor);
  if (reset) state.epoch++;
  const resetPending = state.cursorEpoch !== state.epoch;
  const logCursor = resetPending ? 0 : state.cursor;
  const gap = logAvailable && state.seeded && !resetPending && cursor > logCursor && logCursor > 0
    && !log.some((row) => row.unique_id === logCursor);
  coverage(!logAvailable ? 'log-unavailable' : resetPending ? 'source-reset' : gap ? 'log-gap' : null);
  const current = new Map(Object.values(snapshot.alarms).map((alarm) => [resourceOf(alarm), alarm]));
  const touched = new Set();
  if (state.seeded && logAvailable) {
    const seen = new Set();
    for (const row of [...log].sort((a, b) => a.unique_id - b.unique_id)) {
      if (row.unique_id <= logCursor || row.unique_id > cursor || seen.has(row.unique_id)) continue;
      seen.add(row.unique_id);
      const resource = resourceOf(row);
      touched.add(resource);
      const status = ['WARNING', 'CRITICAL', 'CLEAR'].includes(row.status) ? row.status : 'UNKNOWN';
      event(resource, status, `transition:${state.epoch}:${row.unique_id}`, {
        kind: 'transition', summary: clip(row.summary || `${row.name || 'Alarm'}: ${row.old_status || 'UNKNOWN'} → ${row.status || 'UNKNOWN'}`),
        sourceTime: row.when, alarmId: row.alarm_id ?? null,
      }, Math.min(now, row.when * 1000));
    }
  }
  for (const resource of new Set([...Object.keys(state.alarms), ...current.keys(), ...touched])) {
    const alarm = current.get(resource);
    const old = state.alarms[resource];
    const status = alarm ? alarmState(alarm) : 'UNKNOWN';
    const fingerprint = hash([status, alarm?.last_status_change ?? null, alarm ? 'present' : 'missing']);
    const tracked = old?.tracked || active(status) || touched.has(resource);
    const changed = reset || !old || old.fingerprint !== fingerprint || old.state !== status || touched.has(resource);
    const revision = (old?.revision || 0) + Number(changed);
    state.alarms[resource] = { state: status, fingerprint, revision, tracked: !!tracked };
    if (!changed || !tracked) continue;
    event(resource, status, `snapshot:${state.epoch}:${hash(resource)}:${revision}`, {
      kind: 'snapshot', reason: !alarm ? 'missing' : status === 'UNKNOWN' ? 'disabled-or-unknown' : 'observed',
      summary: clip(alarm?.summary || (alarm ? `${alarm.name || 'Alarm'}: ${status}` : 'Alarm disappeared from the current snapshot')),
    });
  }
  // Snapshot progress is independent of history delivery: an unavailable log
  // must not lose transitions or repeatedly advance the source epoch on reset.
  state.snapshotCursor = cursor;
  if (!state.seeded || logAvailable) {
    state.cursor = cursor;
    state.cursorEpoch = state.epoch;
  }
  state.seeded = true;
  return { events, state };
}

module.exports = { collectNetdata, resourceOf, alarmState, validSnapshot, validLog };

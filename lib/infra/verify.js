'use strict';

const { randomUUID } = require('node:crypto');
const { readNetdataHost } = require('./collector');
const { resourceOf, alarmState, validSnapshot, validLog } = require('./netdata');

async function verificationEvent(incident, route, { readHost = readNetdataHost, now = Date.now } = {}) {
  if (incident.source !== 'netdata') throw new Error('Live verification supports Netdata; maintenance recovery must come from its health-check producer');
  const host = route.hosts?.find((candidate) => candidate.name === incident.host);
  if (!host) throw new Error('Incident host is not configured');
  const coverage = incident.resource === '__collector__';
  let observation;
  try { observation = await readHost(host, coverage ? { seeded: true, cursor: 0 } : undefined); }
  catch { observation = {}; }
  let state = 'UNKNOWN';
  let reason = 'unreachable-or-invalid';
  if (validSnapshot(observation.snapshot)) {
    if (coverage) {
      const cursor = observation.snapshot.latest_alarm_log_unique_id;
      const available = validLog(observation.log) && (cursor === 0 || observation.log.some((row) => row.unique_id === cursor));
      state = available ? 'CLEAR' : 'UNKNOWN';
      reason = available ? 'reachable' : 'log-unavailable';
    } else {
      const alarm = Object.values(observation.snapshot.alarms).find((item) => resourceOf(item) === incident.resource);
      state = alarm ? alarmState(alarm) : 'UNKNOWN';
      reason = alarm ? 'observed' : 'missing';
    }
  }
  return { source: 'netdata', host: incident.host, resource: incident.resource,
    eventId: `verification:${randomUUID()}`, state, observedAt: now(),
    evidence: { kind: 'snapshot', reason, summary: `Live Netdata verification: ${state} (${reason})` } };
}

module.exports = { verificationEvent };

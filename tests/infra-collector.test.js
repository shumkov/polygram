'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSpool } = require('../lib/infra/spool');
const { runCollector, readNetdataHost } = require('../lib/infra/collector');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'infra-collector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { config: { hosts: [{ name: 'test' }] }, statePath: path.join(root, 'state.sqlite'), spool: createSpool({ directory: path.join(root, 'spool') }) };
}
const input = { snapshot: { latest_alarm_log_unique_id: 10, alarms: { disk: { id: 7, chart: 'disk', name: 'space', status: 'WARNING', active: true } } }, log: [] };

test('failed handoff retains the exact pending cycle until durable ACK before polling again', async (t) => {
  const opts = fixture(t);
  let reads = 0;
  const delivered = [];
  const readHost = async () => { reads++; return input; };
  const send = async (event) => { delivered.push(event); return { ok: false }; };
  assert.equal((await runCollector({ ...opts, readHost, send, now: () => 1000 })).pending, 1);
  assert.equal((await runCollector({ ...opts, readHost, send: async (event) => { delivered.push(event); return { ok: true, accepted: true }; }, now: () => 2000 })).pending, 0);
  assert.equal(reads, 1);
  assert.deepEqual(delivered[1], delivered[0]);
  assert.equal((await runCollector({ ...opts, readHost, send, now: () => 3000 })).events, 0);
  assert.equal(reads, 2);
  assert.equal(fs.statSync(opts.statePath).mode & 0o777, 0o600);
});

test('transport success without durable acceptance retains source events and cursor', async (t) => {
  const opts = fixture(t);
  assert.equal((await runCollector({ ...opts, readHost: async () => input, send: async () => ({ ok: true }), now: () => 1000 })).pending, 1);
  const result = await runCollector({ ...opts, readHost: async () => { assert.fail('pending cycle must be retried first'); }, send: async () => ({ ok: true, accepted: true }), now: () => 2000 });
  assert.equal(result.pending, 0);
});

test('one process owns collection across asynchronous reads', async (t) => {
  const opts = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runCollector({ ...opts, readHost: async () => { await gate; return input; }, send: async () => ({ ok: true, accepted: true }), now: () => 1000 });
  const second = await runCollector({ ...opts, readHost: async () => { assert.fail('concurrent read'); }, send: async () => { assert.fail('concurrent send'); } });
  assert.equal(second.busy, true);
  release();
  assert.equal((await first).pending, 0);
});

test('read failures become unknown coverage and unchanged outage does not wake repeatedly', async (t) => {
  const opts = fixture(t);
  const events = [];
  const params = { ...opts, readHost: async () => { throw new Error('offline'); }, send: async (event) => { events.push(event); return { ok: true, accepted: true }; } };
  await runCollector({ ...params, now: () => 1000 });
  await runCollector({ ...params, now: () => 2000 });
  assert.equal(events.length, 1);
  assert.equal(events[0].state, 'UNKNOWN');
});

test('source selection rejects SSH options and shell syntax before running a process', async () => {
  for (const ssh of ['-oProxyCommand=evil', 'host; evil', 'host$(evil)', 'user@host\nwhoami']) {
    await assert.rejects(readNetdataHost({ name: 'test', ssh }), /SSH|target/i);
  }
});

test('crash window after intake ACK replays identical IDs without repolling or losing the cursor', async (t) => {
  const opts = fixture(t);
  const received = [];
  const spool = { enqueue: opts.spool.enqueue, drain: async (send) => {
    await opts.spool.drain(send);
    throw new Error('crash after ACK');
  } };
  await assert.rejects(runCollector({ ...opts, spool, readHost: async () => input, send: async (event) => {
    received.push(event); return { ok: true, accepted: true };
  }, now: () => 1000 }), /crash after ACK/);
  const result = await runCollector({ ...opts, readHost: async () => { assert.fail('must recover frozen cycle'); }, send: async (event) => {
    received.push(event); return { ok: true, accepted: true };
  }, now: () => 5000 });
  assert.equal(result.pending, 0);
  assert.deepEqual(received[0], received[1]);
});

test('configured host names cannot be confused with inherited object properties', async (t) => {
  const opts = fixture(t);
  const result = await runCollector({ ...opts, config: { hosts: [{ name: 'constructor' }] }, readHost: async (_host, previous) => {
    assert.equal(previous, undefined); return input;
  }, send: async () => ({ ok: true, accepted: true }), now: () => 1000 });
  assert.equal(result.pending, 0);
  assert.equal(result.events, 1);
});

test('shared state permissions and symlink replacements are rejected', async (t) => {
  const opts = fixture(t);
  const args = { ...opts, readHost: async () => input, send: async () => ({ ok: true, accepted: true }) };
  await runCollector(args);
  fs.chmodSync(opts.statePath, 0o644);
  await assert.rejects(runCollector(args), /owner-only/);
  fs.chmodSync(opts.statePath, 0o600);
  fs.renameSync(opts.statePath, `${opts.statePath}.saved`);
  fs.symlinkSync(`${opts.statePath}.saved`, opts.statePath);
  await assert.rejects(runCollector(args), /symlink/);
});

test('a collection larger than spool capacity drains incrementally without stranding the source cursor', async (t) => {
  const opts = fixture(t);
  const directory = path.join(path.dirname(opts.statePath), 'small-spool');
  opts.spool = createSpool({ directory, maxEvents: 2 });
  const snapshot = { latest_alarm_log_unique_id: 30, alarms: Object.fromEntries([1, 2, 3].map((id) => [id, {
    id, chart: 'disk', name: `disk${id}`, status: 'WARNING', active: true,
  }])) };
  const events = [];
  let reads = 0;
  const readHost = async () => { reads++; return { snapshot, log: [] }; };
  const result = await runCollector({ ...opts, readHost, send: async (event) => {
    events.push(event); return { ok: true, accepted: true };
  }, now: () => 1000 });
  assert.equal(result.pending, 0);
  assert.equal(result.sent, 3);
  assert.equal(events.length, 3);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 3);
  const unchanged = await runCollector({ ...opts, readHost, send: async () => { assert.fail('unchanged source should not dispatch'); }, now: () => 2000 });
  assert.equal(unchanged.events, 0);
  assert.equal(reads, 2);
});

test('failed incremental handoff preserves the frozen entire cycle until every event is accepted', async (t) => {
  const opts = fixture(t);
  opts.spool = createSpool({ directory: path.join(path.dirname(opts.statePath), 'small-spool'), maxEvents: 2 });
  const snapshot = { latest_alarm_log_unique_id: 30, alarms: Object.fromEntries([1, 2, 3].map((id) => [id, {
    id, chart: 'disk', name: `disk${id}`, status: 'WARNING', active: true,
  }])) };
  const attempted = [];
  const first = await runCollector({ ...opts, readHost: async () => ({ snapshot, log: [] }), send: async (event) => {
    attempted.push(event); return { ok: attempted.length === 1, accepted: attempted.length === 1 };
  }, now: () => 1000 });
  assert.equal(first.pending, 1);
  const accepted = [];
  const retried = await runCollector({ ...opts, readHost: async () => { assert.fail('cursor cannot advance past partially accepted cycle'); }, send: async (event) => {
    accepted.push(event); return { ok: true, accepted: true };
  }, now: () => 2000 });
  assert.equal(retried.pending, 0);
  assert.equal(new Set(accepted.map((event) => event.eventId)).size, 3);
  for (const event of attempted) assert.deepEqual(accepted.find((row) => row.eventId === event.eventId), event);
});

test('Netdata v2.10.3 empty alarm_log body preserves a valid current alarms snapshot', async () => {
  const requests = [];
  const observation = await readNetdataHost({ name: 'umi-vps', ssh: 'umi-vps' }, { seeded: true, cursor: 10 }, async (_command, args) => {
    requests.push(args.at(-1));
    return { stdout: args.at(-1).includes('alarms?all') ? JSON.stringify(input.snapshot) : '' };
  });
  assert.deepEqual(observation.snapshot, input.snapshot);
  assert.equal(observation.log, null);
  assert.equal(requests.length, 2);
  assert.match(requests[1], /alarm_log\?after=9/);
});

test('durable collection keeps the history cursor through empty responses and resumes its transitions', async (t) => {
  const opts = fixture(t);
  let cycle = 0;
  const requests = [];
  const accepted = [];
  const readHost = (host, previous) => readNetdataHost(host, previous, async (_command, args) => {
    const url = args.at(-1);
    requests.push(url);
    const snapshot = { latest_alarm_log_unique_id: cycle === 0 ? 10 : 12, alarms: {
      disk: { id: 7, chart: 'disk', name: 'space', status: cycle === 0 ? 'WARNING' : 'CLEAR', active: true },
    } };
    if (url.includes('alarms?all')) return { stdout: JSON.stringify(snapshot) };
    return { stdout: cycle === 1 ? '' : JSON.stringify([10, 11, 12].map((unique_id) => ({
      unique_id, alarm_id: 7, chart: 'disk', name: 'space', when: unique_id,
      status: unique_id === 10 ? 'WARNING' : unique_id === 11 ? 'CRITICAL' : 'CLEAR',
    }))) };
  });
  const send = async (event) => { accepted.push(event); return { ok: true, accepted: true }; };
  for (cycle = 0; cycle < 3; cycle++) await runCollector({ ...opts, readHost, send, now: () => 100000 + cycle * 1000 });
  assert.equal(requests.filter((url) => url.includes('alarm_log')).length, 2);
  assert.ok(requests.filter((url) => url.includes('alarm_log')).every((url) => url.endsWith('after=9')));
  assert.deepEqual(accepted.filter((event) => event.evidence.kind === 'transition').map((event) => event.state), ['CRITICAL', 'CLEAR']);
  assert.equal(accepted.filter((event) => event.resource === 'disk/space' && event.state === 'UNKNOWN').length, 0);
  assert.equal(accepted.at(-1).evidence.kind, 'snapshot');
  assert.equal(accepted.at(-1).state, 'CLEAR');
});

test('history read starts at the new epoch after reset even if the old cursor remains retained', async () => {
  const snapshot = { ...input.snapshot, latest_alarm_log_unique_id: 3 };
  const requests = [];
  await readNetdataHost({ name: 'test' }, { seeded: true, cursor: 100, snapshotCursor: 2, epoch: 1, cursorEpoch: 0 }, async (_command, args) => {
    requests.push(args.at(-1));
    return { stdout: args.at(-1).includes('alarms?all') ? JSON.stringify(snapshot) : '[]' };
  });
  assert.match(requests[1], /alarm_log\?after=0$/);
});

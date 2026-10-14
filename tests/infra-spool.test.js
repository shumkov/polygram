'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const { createSpool } = require('../lib/infra/spool');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'infra-spool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'events');
}
const event = (eventId = 'maintenance-1', extra = {}) => ({
  eventId, source: 'maintenance', host: 'test-host', resource: 'backup',
  state: 'WARNING', observedAt: '2026-10-15T00:00:00Z', evidence: {}, ...extra,
});

test('unavailable intake retains accepted events across producer recreation', async (t) => {
  const directory = fixture(t);
  const spool = createSpool({ directory });
  const receipt = spool.enqueue(event());
  await assert.rejects(spool.drain(async () => { throw new Error('intake offline'); }), /offline/);
  const restarted = createSpool({ directory });
  assert.deepEqual(restarted.enqueue(event()), receipt);
  const delivered = [];
  assert.deepEqual(await restarted.drain(async (row) => { delivered.push(row); return { ok: true }; }), { sent: 1, pending: 0 });
  assert.deepEqual(delivered, [event()]);
});

test('duplicate identity is stable and conflicting payload cannot replace an alert', async (t) => {
  const spool = createSpool({ directory: fixture(t) });
  const receipt = spool.enqueue(event());
  assert.deepEqual(spool.enqueue({ ...event(), evidence: {} }), receipt);
  assert.throws(() => spool.enqueue(event(undefined, { state: 'CLEAR' })), /conflict/i);
  spool.enqueue(event(undefined, { host: 'other-host' }));
  assert.deepEqual(await spool.drain(async () => ({ ok: true })), { sent: 2, pending: 0 });
});

test('capacity limits fail loudly without evicting an unacknowledged event', async (t) => {
  const spool = createSpool({ directory: fixture(t), maxEvents: 1, maxBytes: 1000 });
  spool.enqueue(event());
  assert.throws(() => spool.enqueue(event('second')), /capacity|full|limit/i);
  assert.deepEqual(await spool.drain(async () => ({ ok: false })), { sent: 0, pending: 1 });
  const small = createSpool({ directory: path.join(fixture(t), 'small'), maxBytes: 10 });
  assert.throws(() => small.enqueue(event()), /capacity|full|limit/i);
});

test('only an explicit positive durable receipt removes a queued event', async (t) => {
  const spool = createSpool({ directory: fixture(t) });
  spool.enqueue(event());
  for (const reply of [undefined, null, {}, { ok: false }, { ok: 'true' }]) {
    assert.deepEqual(await spool.drain(async () => reply), { sent: 0, pending: 1 });
  }
  assert.deepEqual(await spool.drain(async () => ({ ok: true })), { sent: 1, pending: 0 });
});

test('one drainer holds ownership while new events may still be spooled', async (t) => {
  const directory = fixture(t);
  const first = createSpool({ directory });
  const second = createSpool({ directory });
  first.enqueue(event());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = first.drain(async () => { await gate; return { ok: true }; });
  assert.deepEqual(await second.drain(async () => { assert.fail('concurrent delivery'); }), { sent: 0, pending: 1 });
  second.enqueue(event('new-arrival'));
  release();
  assert.deepEqual(await running, { sent: 1, pending: 1 });
  assert.deepEqual(await second.drain(async () => ({ ok: true })), { sent: 1, pending: 0 });
});

test('drainer ownership excludes another process and is recoverable after a crash', async (t) => {
  const directory = fixture(t);
  const spool = createSpool({ directory });
  spool.enqueue(event());
  const child = fork('-e', [
    `const { createSpool } = require(${JSON.stringify(require.resolve('../lib/infra/spool'))});
     createSpool({ directory: process.argv[1] }).drain(async () => {
       process.send('sending'); await new Promise(() => {});
     }); setInterval(() => {}, 1000);`, directory,
  ], { silent: true });
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'message');
  assert.deepEqual(await spool.drain(async () => { assert.fail('live owner bypassed'); }), { sent: 0, pending: 1 });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.deepEqual(await spool.drain(async () => ({ ok: true })), { sent: 1, pending: 0 });
});

test('secrets are redacted before disk persistence and delivery', async (t) => {
  const directory = fixture(t);
  const spool = createSpool({ directory });
  const secret = 'fake-maintenance-password-123';
  spool.enqueue(event(undefined, { evidence: { password: secret, detail: 'backup failed' } }));
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name);
    if (fs.statSync(filename).isFile()) assert.ok(!fs.readFileSync(filename, 'utf8').includes(secret));
  }
  await spool.drain(async (row) => {
    assert.equal(row.evidence.detail, 'backup failed');
    assert.match(row.evidence.password, /redacted/);
    return { ok: true };
  });
});

test('owner-only permissions, symlink rejection and corrupt rows preserve evidence', async (t) => {
  const directory = fixture(t);
  const spool = createSpool({ directory });
  spool.enqueue(event());
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const row = fs.readdirSync(directory).find((name) => name.endsWith('.sqlite'));
  assert.equal(fs.statSync(path.join(directory, row)).mode & 0o777, 0o600);
  const alias = `${directory}-alias`;
  fs.symlinkSync(directory, alias);
  assert.throws(() => createSpool({ directory: alias }), /symlink/i);
  fs.writeFileSync(path.join(directory, row), '{broken', { mode: 0o600 });
  await assert.rejects(spool.drain(async () => ({ ok: true })), /invalid|corrupt|not a database/i);
  assert.equal(fs.readFileSync(path.join(directory, row), 'utf8'), '{broken');
});

test('a malformed queued row stops delivery and remains available for repair', async (t) => {
  const directory = fixture(t);
  const spool = createSpool({ directory });
  const { id } = spool.enqueue(event());
  const db = new Database(path.join(directory, 'spool.sqlite'));
  t.after(() => db.close());
  db.prepare('UPDATE events SET payload = ? WHERE id = ?').run('{broken', id);
  await assert.rejects(spool.drain(async () => { assert.fail('corrupt row was delivered'); }), /invalid/i);
  assert.equal(db.prepare('SELECT payload FROM events WHERE id = ?').get(id).payload, '{broken');
});

test('a replaced database symlink or shared permissions cannot be used for spooling', (t) => {
  const directory = fixture(t);
  const spool = createSpool({ directory });
  const filename = path.join(directory, 'spool.sqlite');
  fs.chmodSync(filename, 0o644);
  assert.throws(() => spool.enqueue(event()), /owner-only/i);
  fs.chmodSync(filename, 0o600);
  fs.renameSync(filename, `${filename}.saved`);
  fs.symlinkSync(`${filename}.saved`, filename);
  assert.throws(() => spool.enqueue(event()), /symlink/i);
});

test('unsupported object input cannot leave an undeliverable queue entry', (t) => {
  const spool = createSpool({ directory: fixture(t) });
  class UnsupportedEvent { constructor() { Object.assign(this, event()); } }
  assert.throws(() => spool.enqueue(new UnsupportedEvent()), /event/i);
});

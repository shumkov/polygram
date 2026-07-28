/**
 * Tests for lib/ops/heartbeat.js — the Netdata-visibility file writer for
 * AUTH_DISABLED occurrences (docs/AUTH_DISABLED_HANDLING_SPEC.md, Layer 3.3).
 *
 * File-only (no HTTP /healthz — this repo has no HTTP listener to hang a
 * route on). Wiring heartbeat.json into an actual Netdata alert is VPS-side
 * ops, out of scope here; this only covers the file-writer itself.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHeartbeat } = require('../lib/ops/heartbeat');
const { createAuthDisabledGate } = require('../lib/ops/auth-disabled-gate');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-heartbeat-test-'));
}

describe('createHeartbeat — beat()', () => {
  test('writes heartbeat.json reflecting the gate snapshot', () => {
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate({ now: () => 12345 });
    gate.noteFailure();
    gate.noteFailure();
    const hb = createHeartbeat({ dataDir, botName: 'shumabit', authDisabledGate: gate, now: () => 99999 });

    hb.beat();

    const written = JSON.parse(fs.readFileSync(hb.file, 'utf8'));
    assert.equal(written.ts, 99999);
    assert.equal(written.authDisabled, 2);
    assert.equal(written.authDisabledLastAt, 12345);
  });

  test('beat() returns the same snapshot it writes', () => {
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate();
    const hb = createHeartbeat({ dataDir, botName: 'shumabit', authDisabledGate: gate });
    const snap = hb.beat();
    const written = JSON.parse(fs.readFileSync(hb.file, 'utf8'));
    assert.deepEqual(snap, written);
  });

  test('write is atomic (temp file does not linger after a successful beat)', () => {
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate();
    const hb = createHeartbeat({ dataDir, botName: 'shumabit', authDisabledGate: gate });
    hb.beat();
    const entries = fs.readdirSync(dataDir);
    assert.deepEqual(entries, [path.basename(hb.file)]);
  });

  test('a write failure is caught, logged, and does not throw out of beat()', (t) => {
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate();
    const hb = createHeartbeat({ dataDir, botName: 'shumabit', authDisabledGate: gate });

    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('disk full'); };
    const errors = [];
    t.mock.method(console, 'error', (msg) => errors.push(msg));

    try {
      assert.doesNotThrow(() => hb.beat());
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.ok(errors.some((m) => /\[auth\] heartbeat write failed/.test(m)));
  });
});

// Every bot on a host runs from the same DATA_DIR (polygram.js derives it from
// process.cwd(), and the fleet starts each --bot from one directory), so the
// heartbeat path must be per-bot. Sharing it lets a live bot's beat masquerade as
// a dead one's, which defeats the file's only purpose, and makes the two daemons
// race on one temp name — the losing rename ENOENTs every minute.
describe('createHeartbeat — one file per bot in a shared data dir', () => {
  test('two bots in one data dir keep separate heartbeats', () => {
    const dataDir = tmpDir();
    const a = createHeartbeat({
      dataDir, botName: 'shumabit', authDisabledGate: createAuthDisabledGate(), now: () => 111,
    });
    const b = createHeartbeat({
      dataDir, botName: 'umi-assistant', authDisabledGate: createAuthDisabledGate(), now: () => 222,
    });

    a.beat();
    b.beat();

    assert.notEqual(a.file, b.file, 'each bot must own its heartbeat path');
    assert.equal(JSON.parse(fs.readFileSync(a.file, 'utf8')).ts, 111);
    assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf8')).ts, 222,
      'the second bot must not have overwritten the first');
  });

  test('bots do not share a temp file (the rename that loses the race ENOENTs)', (t) => {
    const dataDir = tmpDir();
    const a = createHeartbeat({ dataDir, botName: 'shumabit', authDisabledGate: createAuthDisabledGate() });
    const b = createHeartbeat({ dataDir, botName: 'umi-assistant', authDisabledGate: createAuthDisabledGate() });

    const written = [];
    const realWrite = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (p, ...rest) => { written.push(p); return realWrite(p, ...rest); });

    a.beat();
    b.beat();

    assert.equal(written.length, 2);
    assert.notEqual(written[0], written[1], 'concurrent bots must not write the same temp path');
  });

  test('an unsafe bot name is rejected, not rewritten', () => {
    const dataDir = tmpDir();
    for (const bad of ['../escaped', 'a/b', '..', '.', 'has space', '']) {
      assert.throws(
        () => createHeartbeat({ dataDir, botName: bad, authDisabledGate: createAuthDisabledGate() }),
        /botName/,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });

  // Rewriting unsafe names would map distinct bots onto one file — the same
  // collision as sharing the filename outright, just reached a different way.
  test('names that would sanitise to the same file cannot both be created', () => {
    const dataDir = tmpDir();
    const ok = createHeartbeat({ dataDir, botName: 'a_b', authDisabledGate: createAuthDisabledGate() });
    assert.ok(ok.file.endsWith('heartbeat-a_b.json'));
    assert.throws(() => createHeartbeat({ dataDir, botName: 'a/b', authDisabledGate: createAuthDisabledGate() }), /botName/);
  });
});

describe('createHeartbeat — start()/stop() lifecycle', () => {
  test('start() beats immediately and on the interval; stop() halts it', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate();
    const hb = createHeartbeat({ dataDir, botName: 'shumabit', authDisabledGate: gate, intervalMs: 1000 });

    hb.start();
    assert.ok(fs.existsSync(hb.file), 'beats immediately on start()');

    const before = fs.readFileSync(hb.file, 'utf8');
    gate.noteFailure();
    t.mock.timers.tick(1000);
    const after = fs.readFileSync(hb.file, 'utf8');
    assert.notEqual(before, after, 'a subsequent interval tick beats again');

    hb.stop();
    const afterStop = fs.readFileSync(hb.file, 'utf8');
    gate.noteFailure();
    t.mock.timers.tick(5000);
    assert.equal(fs.readFileSync(hb.file, 'utf8'), afterStop, 'no further beats after stop()');
  });
});

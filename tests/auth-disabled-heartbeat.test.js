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
    const hb = createHeartbeat({ dataDir, authDisabledGate: gate, now: () => 99999 });

    hb.beat();

    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'heartbeat.json'), 'utf8'));
    assert.equal(written.ts, 99999);
    assert.equal(written.authDisabled, 2);
    assert.equal(written.authDisabledLastAt, 12345);
  });

  test('beat() returns the same snapshot it writes', () => {
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate();
    const hb = createHeartbeat({ dataDir, authDisabledGate: gate });
    const snap = hb.beat();
    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'heartbeat.json'), 'utf8'));
    assert.deepEqual(snap, written);
  });

  test('write is atomic (temp file does not linger after a successful beat)', () => {
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate();
    const hb = createHeartbeat({ dataDir, authDisabledGate: gate });
    hb.beat();
    const entries = fs.readdirSync(dataDir);
    assert.deepEqual(entries, ['heartbeat.json']);
  });

  test('a write failure is caught, logged, and does not throw out of beat()', (t) => {
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate();
    const hb = createHeartbeat({ dataDir, authDisabledGate: gate });

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

describe('createHeartbeat — start()/stop() lifecycle', () => {
  test('start() beats immediately and on the interval; stop() halts it', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const dataDir = tmpDir();
    const gate = createAuthDisabledGate();
    const hb = createHeartbeat({ dataDir, authDisabledGate: gate, intervalMs: 1000 });

    hb.start();
    assert.ok(fs.existsSync(path.join(dataDir, 'heartbeat.json')), 'beats immediately on start()');

    const before = fs.readFileSync(path.join(dataDir, 'heartbeat.json'), 'utf8');
    gate.noteFailure();
    t.mock.timers.tick(1000);
    const after = fs.readFileSync(path.join(dataDir, 'heartbeat.json'), 'utf8');
    assert.notEqual(before, after, 'a subsequent interval tick beats again');

    hb.stop();
    const afterStop = fs.readFileSync(path.join(dataDir, 'heartbeat.json'), 'utf8');
    gate.noteFailure();
    t.mock.timers.tick(5000);
    assert.equal(fs.readFileSync(path.join(dataDir, 'heartbeat.json'), 'utf8'), afterStop, 'no further beats after stop()');
  });
});

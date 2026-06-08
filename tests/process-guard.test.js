/**
 * Tests for lib/process-guard.js (rc.50).
 *
 * The rc.50 incident:
 *
 *   PID 6335 (rc.48) became orphaned when its tmux pane was killed
 *   during `launchctl kickstart -k`. polygram already handles SIGHUP
 *   (rc.28) — but during the SIGHUP shutdown drain, console.error
 *   inside the uncaughtException handler itself threw EIO (because
 *   stdout was wired to a now-destroyed pty). That re-fired the same
 *   handler, which logged again, which threw EIO again, in a tight
 *   re-entrant loop that hijacked the event loop and prevented
 *   shutdown from completing. The orphan ran for 3+ hours writing
 *   3.59M+ uncaught-exception events to the DB at ~12k/sec.
 *
 * Three primitives this module provides:
 *
 *   1. installSafetyHandlers — uncaughtException + unhandledRejection
 *      handlers that:
 *        a. wrap console.error in try/catch (no re-entry on EIO)
 *        b. circuit-breaker: if N consecutive same-message exceptions
 *           fire within Y ms, process.exit(2). Lets launchd restart
 *           cleanly instead of letting the process zombie.
 *
 *   2. claimPidFile — boot-time orphan detection. Writes own PID to
 *      <pidFilePath>. If the file exists with a different live PID,
 *      kill it (SIGTERM, then SIGKILL after 2s) BEFORE proceeding to
 *      bind the bot token. Two daemons sharing one bot token is the
 *      cascade that made this incident production-visible (3.5M
 *      events written to the same DB, polling races on the same
 *      Telegram bot).
 *
 *   3. releasePidFile — delete the file on clean shutdown.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');
const { EventEmitter } = require('events');

const {
  claimPidFile,
  releasePidFile,
  _makeUncaughtHandler,
  guardStdio,
} = require('../lib/process-guard');

describe('claimPidFile', () => {
  let tmp;
  let pidPath;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'process-guard-'));
    pidPath = path.join(tmp, 'shumabit.pid');
  });

  test('writes current PID when no prior file', () => {
    const result = claimPidFile(pidPath, { logger: { log: () => {} } });
    assert.equal(result.priorPid, null);
    assert.equal(result.priorAction, 'no-prior');
    assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), String(process.pid));
  });

  test('overwrites stale PID file (PID no longer alive)', () => {
    // Pick a PID that almost certainly doesn't exist on this system.
    fs.writeFileSync(pidPath, '99999\n');
    const logged = [];
    const result = claimPidFile(pidPath, { logger: { log: (m) => logged.push(m) } });
    assert.equal(result.priorPid, 99999);
    assert.equal(result.priorAction, 'stale-overwritten');
    assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), String(process.pid));
  });

  test('SIGKILLs prior live PID before claiming', () => {
    // Spawn a sleeping child we can detect + verify-killed.
    const child = child_process.spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    fs.writeFileSync(pidPath, String(child.pid) + '\n');

    const logged = [];
    const result = claimPidFile(pidPath, {
      logger: { log: (m) => logged.push(m) },
      sigtermWaitMs: 100, // shorter for tests
    });
    assert.equal(result.priorPid, child.pid);
    assert.ok(['sigterm-killed', 'sigkill-killed'].includes(result.priorAction),
      'should have killed prior — got ' + result.priorAction);
    assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), String(process.pid));
    // Note: we deliberately don't `kill -0` the dead child here.
    // Detached children whose parent (this test process) hasn't
    // reaped them stay as zombies for a tick, and `kill -0 <zombie>`
    // succeeds even though the process is dead. The contract this
    // function asserts is "we sent the kill signals" — verifying the
    // kernel actually finished tearing down the entry is testing the
    // kernel, not us. Reap so we don't leak.
    try { child.kill('SIGKILL'); } catch {}
  });

  test('does NOT kill self if pidPath already contains current PID', () => {
    // Idempotency: if we somehow re-call claimPidFile in the same
    // process, we must not SIGKILL ourselves.
    fs.writeFileSync(pidPath, String(process.pid) + '\n');
    const result = claimPidFile(pidPath, { logger: { log: () => {} } });
    assert.equal(result.priorPid, process.pid);
    assert.equal(result.priorAction, 'self-skip');
  });

  test('handles malformed PID file gracefully (treats as no-prior)', () => {
    fs.writeFileSync(pidPath, 'garbage\n');
    const result = claimPidFile(pidPath, { logger: { log: () => {} } });
    assert.equal(result.priorAction, 'malformed-overwritten');
    assert.equal(fs.readFileSync(pidPath, 'utf8').trim(), String(process.pid));
  });
});

describe('releasePidFile', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'process-guard-rel-'));
  });

  test('deletes the file when content matches our PID', () => {
    const p = path.join(tmp, 'b.pid');
    fs.writeFileSync(p, String(process.pid) + '\n');
    releasePidFile(p);
    assert.equal(fs.existsSync(p), false);
  });

  test('does NOT delete a PID file owned by a different process', () => {
    const p = path.join(tmp, 'b.pid');
    fs.writeFileSync(p, '99999\n');
    releasePidFile(p);
    assert.equal(fs.existsSync(p), true,
      'must not delete another process\'s claim — would let two daemons coexist');
  });

  test('silently no-ops when file is absent', () => {
    const p = path.join(tmp, 'absent.pid');
    assert.doesNotThrow(() => releasePidFile(p));
  });
});

describe('_makeUncaughtHandler — re-entry safety + circuit breaker', () => {
  // The handler must:
  //   1. NOT re-throw if the wrapped logger itself throws (the bug
  //      that caused the orphan storm).
  //   2. Circuit-break if the same message fires N times in a window:
  //      call the panic exit function so launchd restarts us.
  //   3. NOT exit on a single sporadic error.

  function setup(opts = {}) {
    const exitCalls = [];
    const dbWrites = [];
    const logCalls = [];
    const handler = _makeUncaughtHandler({
      logger: {
        error: (m) => {
          logCalls.push(m);
          if (opts.loggerThrows) throw new Error('write EIO');
        },
      },
      logEvent: (kind, detail) => {
        dbWrites.push({ kind, detail });
        if (opts.dbThrows) throw new Error('db gone');
      },
      botName: 'shumabit',
      eioThreshold: opts.eioThreshold ?? 5,
      eioWindowMs: opts.eioWindowMs ?? 1000,
      panicExit: (code) => exitCalls.push(code),
      now: opts.now,
    });
    return { handler, exitCalls, dbWrites, logCalls };
  }

  test('does not re-throw when logger throws EIO (the orphan-storm bug)', () => {
    const { handler } = setup({ loggerThrows: true });
    // Pre-rc.50 this would have thrown out of the handler, becoming
    // another uncaughtException, infinitely re-entering.
    assert.doesNotThrow(() => handler(new Error('write EIO')));
  });

  test('does not re-throw when db.logEvent throws', () => {
    const { handler } = setup({ dbThrows: true });
    assert.doesNotThrow(() => handler(new Error('something')));
  });

  test('persists each exception to DB', () => {
    const { handler, dbWrites } = setup();
    handler(new Error('boom'));
    assert.equal(dbWrites.length, 1);
    assert.equal(dbWrites[0].kind, 'uncaught-exception');
    assert.equal(dbWrites[0].detail.message, 'boom');
    assert.equal(dbWrites[0].detail.bot_name, 'shumabit');
  });

  test('does NOT panic-exit on a single error', () => {
    const { handler, exitCalls } = setup();
    handler(new Error('one-off'));
    assert.equal(exitCalls.length, 0);
  });

  test('does NOT panic-exit on N different messages within the window', () => {
    const { handler, exitCalls } = setup({ eioThreshold: 3, eioWindowMs: 1000 });
    handler(new Error('a'));
    handler(new Error('b'));
    handler(new Error('c'));
    handler(new Error('d'));
    // Diverse causes — could be unrelated bugs; do not exit. Only
    // same-message storms qualify.
    assert.equal(exitCalls.length, 0);
  });

  test('panic-exits when same message fires N times within the window', () => {
    let t = 1000;
    const { handler, exitCalls } = setup({
      eioThreshold: 5,
      eioWindowMs: 1000,
      now: () => t,
    });
    for (let i = 0; i < 5; i++) handler(new Error('write EIO'));
    assert.equal(exitCalls.length, 1, 'must call panicExit once');
    assert.equal(exitCalls[0], 2, 'exit code 2 = launchd-restartable abnormal');
  });

  test('resets the same-message counter when older than the window', () => {
    let t = 0;
    const { handler, exitCalls } = setup({
      eioThreshold: 5,
      eioWindowMs: 1000,
      now: () => t,
    });
    for (let i = 0; i < 4; i++) { handler(new Error('write EIO')); t += 100; }
    // 4 EIO in 400ms — under threshold.
    assert.equal(exitCalls.length, 0);
    // Now jump past the window.
    t += 5000;
    handler(new Error('write EIO')); // 1st in new window
    assert.equal(exitCalls.length, 0);
  });

  test('multiple distinct same-message storms each tracked independently', () => {
    let t = 0;
    const { handler, exitCalls } = setup({
      eioThreshold: 3,
      eioWindowMs: 1000,
      now: () => t,
    });
    handler(new Error('write EIO'));   // 1
    handler(new Error('out of memory')); // 1
    handler(new Error('write EIO'));   // 2
    handler(new Error('out of memory')); // 2
    handler(new Error('write EIO'));   // 3 — trips
    assert.equal(exitCalls.length, 1);
  });
});

// rc.30 follow-up: the uncaughtException handler above already prevents the
// re-entrant LOOP, but stdout/stderr EIO/EPIPE writes during shutdown still
// reach uncaughtException — 100 rows + a circuit-breaker panic-exit every
// deploy (observed live on the rc.29→rc.30 restart, 2026-06-08). guardStdio
// attaches an 'error' listener to the streams so those write errors emit on
// the stream (dropped) instead of being promoted to uncaughtException, letting
// the graceful drain finish. Genuine (non-EIO/EPIPE) stream errors still surface.
describe('guardStdio — swallow stdout/stderr EPIPE/EIO on shutdown', () => {
  function fakeStream() { return new EventEmitter(); }
  const eio = () => Object.assign(new Error('write EIO'), { code: 'EIO' });
  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

  test('baseline: an unguarded stream error throws (this is what reaches uncaughtException)', () => {
    const s = fakeStream();
    assert.throws(() => s.emit('error', eio()));
  });

  test('swallows EIO so it never becomes an uncaughtException', () => {
    const s = fakeStream();
    guardStdio({ streams: [s] });
    assert.doesNotThrow(() => s.emit('error', eio()));
  });

  test('swallows EPIPE (broken pipe on pane teardown)', () => {
    const s = fakeStream();
    guardStdio({ streams: [s] });
    assert.doesNotThrow(() => s.emit('error', epipe()));
  });

  test('does NOT mask a genuine stream error (non-EPIPE/EIO surfaces)', () => {
    const s = fakeStream();
    guardStdio({ streams: [s] });
    assert.throws(() => s.emit('error', Object.assign(new Error('disk full'), { code: 'ENOSPC' })), /disk full/);
  });

  test('uninstall removes the guard (error throws again)', () => {
    const s = fakeStream();
    const g = guardStdio({ streams: [s] });
    g.uninstall();
    assert.throws(() => s.emit('error', eio()));
  });

  // The ACTUAL shutdown mechanism (rc.50 incident): stdout is a TTY/pty, so
  // console.error → write() throws EIO SYNCHRONOUSLY. An 'error' listener does
  // not catch a synchronous throw — guardStdio must also wrap write().
  test('swallows a synchronous write() EIO throw → returns false, no throw', () => {
    const s = fakeStream();
    s.write = () => { throw eio(); };
    guardStdio({ streams: [s] });
    let ret;
    assert.doesNotThrow(() => { ret = s.write('draining...\n'); });
    assert.equal(ret, false, 'write dropped (pane gone) instead of throwing to uncaughtException');
  });

  test('a synchronous non-EIO write() error still throws (no masking)', () => {
    const s = fakeStream();
    s.write = () => { throw Object.assign(new Error('boom'), { code: 'ENOSPC' }); };
    guardStdio({ streams: [s] });
    assert.throws(() => s.write('x'), /boom/);
  });

  test('a successful write() is unaffected (normal logging passes through)', () => {
    const s = fakeStream();
    const seen = [];
    s.write = (chunk) => { seen.push(chunk); return true; };
    guardStdio({ streams: [s] });
    assert.equal(s.write('hello'), true);
    assert.deepEqual(seen, ['hello']);
  });

  test('uninstall restores the original write()', () => {
    const s = fakeStream();
    const orig = () => { throw eio(); };
    s.write = orig;
    const g = guardStdio({ streams: [s] });
    g.uninstall();
    assert.equal(s.write, orig, 'original write restored');
    assert.throws(() => s.write('x'));
  });
});

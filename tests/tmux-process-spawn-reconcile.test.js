/**
 * Spawn-time reconcile — TmuxProcess.start() must detect a pre-existing
 * tmux session with our target name and kill it before spawning.
 *
 * Production trigger (shumorobot 2026-05-20 18:51):
 *   1. 04:49 — Music topic spawns under tmux backend.
 *   2. <some time> — chat config drifts pm_backend tmux → sdk.
 *      Polygram drops the in-memory TmuxProcess handle but the live
 *      tmux session keeps running headless (tmux sessions outlive
 *      their parent process — owned by the tmux server).
 *   3. 18:51:28 — user types /new, then sends another message.
 *   4. 18:51:31 — config drifts back to pm_backend tmux. Polygram
 *      attempts a fresh spawn under the SAME `polygram-<bot>-<chatId>-<topic>`
 *      name; tmux refuses with "duplicate session" → handler-error.
 *
 * The fix detects the orphan at spawn time, kills it, settles for
 * ~50ms, and re-spawns. Always-kill is safer than try-to-reuse — we
 * have no living claim to the orphan and claude's JSONL session lives
 * in ~/.claude/projects/.../<sid>.jsonl independent of tmux, so
 * --resume into a clean pane recovers the conversation cleanly.
 *
 * @see lib/process/tmux-process.js spawn-reconcile block
 * @see lib/tmux/orphan-sweep.js (boot-time sweep — complementary)
 */

'use strict';

if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TmuxProcess } = require('../lib/process/tmux-process');

const SILENT = {
  warn: () => {}, error: () => {}, info: () => {},
  debug: () => {}, log: () => {},
};

/**
 * Runner factory parameterised by orphan state.
 *
 * `orphanFirstCall`: when true, the first sessionExists() call
 * returns true (an orphan is detected); subsequent calls return false
 * (the orphan was killed, the new spawn succeeded). When false, no
 * orphan exists (sessionExists always false until spawn happens).
 *
 * Records all runner calls so the test can assert order:
 * sessionExists → killSession → sessionExists → spawn.
 */
function makeRunner({
  defaultCapture = '? for shortcuts',
  orphanFirstCall = false,
  killFails = false,
} = {}) {
  const calls = [];
  let spawned = false;
  let killed = !orphanFirstCall;  // if no orphan to begin with, "already killed"
  let sessionExistsCallCount = 0;
  let killSessionCallCount = 0;
  let startReadyConsumed = false;
  let captureMode = 'ready';

  return {
    _calls: calls,
    _sessionExistsCallCount: () => sessionExistsCallCount,

    sessionExists: async (name) => {
      sessionExistsCallCount += 1;
      calls.push({ kind: 'sessionExists', name, returns: !killed && (orphanFirstCall || spawned) });
      // Orphan present until killSession lands; afterwards, true only
      // once spawn() has run successfully.
      return !killed || spawned;
    },

    killSession: async (name) => {
      killSessionCallCount += 1;
      calls.push({ kind: 'killSession', name });
      // `killFails` simulates an unkillable orphan on the RECONCILE
      // call only (the first killSession). The teardown kill at end
      // of test must still succeed — otherwise it masks the assertion
      // we actually want to make.
      if (killFails && killSessionCallCount === 1) {
        throw new Error('simulated tmux killSession failure');
      }
      killed = true;
    },

    spawn: async (opts) => {
      calls.push({ kind: 'spawn', ...opts });
      // Match real tmux: `new-session -s NAME` rejects when NAME is
      // already in use. This is what pins the production bug — without
      // the reconcile block, a spawn against an orphan tmux session
      // throws TMUX_SPAWN_FAILED ("duplicate session"), exactly as
      // recorded in shumorobot.db at 18:51:31 on 2026-05-20.
      if (!killed) {
        throw Object.assign(
          new Error('tmux spawn failed: Command failed: tmux new-session -d -s '
            + opts.name + ' (duplicate session: ' + opts.name + ')'),
          { code: 'TMUX_SPAWN_FAILED', name: opts.name },
        );
      }
      // Spawn succeeded; from now on sessionExists() returns true.
      spawned = true;
      killed = false;
    },

    sendControl: async (n, k) => {
      calls.push({ kind: 'sendControl', name: n, key: k });
      if (k === 'Enter') captureMode = 'streaming';
    },
    pasteText: async (n, t) => {
      calls.push({ kind: 'pasteText', name: n, text: t });
      return { sanitized: t, oneLine: t, stripped: 0 };
    },
    captureWide: async () => {
      if (!startReadyConsumed) {
        startReadyConsumed = true;
        return defaultCapture;
      }
      return captureMode === 'streaming'
        ? 'PRELUDE\n? for shortcuts\nesc to interrupt'
        : defaultCapture;
    },
    capturePane: async () => defaultCapture,
    listPolygramSessions: async () => [],
    setPaneReadOnly: async () => {},
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };
}

function makeProc(runner, opts = {}) {
  return new TmuxProcess({
    sessionKey: 'chat:100', chatId: '100', threadId: null, label: 'reconcile-test',
    runner, botName: 'shumabit', logger: SILENT,
    pollMs: 5, quiesceMs: 10, readyTimeoutMs: 500, turnTimeoutMs: 5000,
    pasteConfirmMs: 10,
  });
}

function setupTempCwd() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-reconcile-test-'));
  const homeBackup = process.env.HOME;
  process.env.HOME = tmp;
  fs.mkdirSync(path.join(tmp, '.claude', 'projects'), { recursive: true });
  return { cwd: tmp, cleanup: () => {
    process.env.HOME = homeBackup;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }};
}

describe('TmuxProcess.start() — spawn-time orphan reconcile', () => {

  test('no orphan: sessionExists called once, no killSession, spawn proceeds', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner({ orphanFirstCall: false });
      const p = makeProc(runner);

      await p.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd } });

      const order = runner._calls.map((c) => c.kind);
      const idxSession = order.indexOf('sessionExists');
      const idxKill = order.indexOf('killSession');
      const idxSpawn = order.indexOf('spawn');

      assert.ok(idxSession >= 0, 'sessionExists is the first check');
      assert.equal(idxKill, -1, 'no orphan → no killSession');
      assert.ok(idxSpawn > idxSession, 'spawn comes after sessionExists');

      await p.kill('test');
    } finally { env.cleanup(); }
  });

  test('orphan present: sessionExists → killSession → spawn (the C1 fix)', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner({ orphanFirstCall: true });
      const p = makeProc(runner);

      // Capture the reconcile event so we can assert observability.
      const events = [];
      p.on('spawn-reconcile', (ev) => events.push(ev));

      await p.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd } });

      const order = runner._calls.map((c) => c.kind);
      const idxSession = order.indexOf('sessionExists');
      const idxKill = order.indexOf('killSession');
      const idxSpawn = order.indexOf('spawn');

      assert.ok(idxSession >= 0, 'sessionExists is the first check');
      assert.ok(idxKill > idxSession, 'killSession follows sessionExists');
      assert.ok(idxSpawn > idxKill, 'spawn follows killSession');

      // Telemetry — the operator must see WHY we killed the orphan.
      assert.equal(events.length, 1);
      assert.equal(events[0].phase, 'kill-orphan');
      assert.equal(events[0].backend, 'tmux');
      assert.match(events[0].tmux_name, /^polygram-shumabit-100/);

      await p.kill('test');
    } finally { env.cleanup(); }
  });

  test('drift reproduction: orphan from prior backend; second spawn succeeds', async () => {
    const env = setupTempCwd();
    try {
      // Simulate the exact production trace:
      //   prior daemon spawned polygram-shumabit-100-main; pm_backend
      //   drifted; current daemon now spawns under the same name.
      const runner = makeRunner({ orphanFirstCall: true });
      const p = makeProc(runner);

      // Pre-fix this would throw TMUX_SPAWN_FAILED. Post-fix it must succeed.
      await assert.doesNotReject(
        p.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd } }),
        /TMUX_SPAWN_FAILED/,
      );

      // The orphan was killed; the new spawn ran.
      const spawns = runner._calls.filter((c) => c.kind === 'spawn');
      const kills = runner._calls.filter((c) => c.kind === 'killSession');
      assert.equal(spawns.length, 1, 'exactly one fresh spawn');
      assert.equal(kills.length, 1, 'exactly one orphan kill');

      await p.kill('test');
    } finally { env.cleanup(); }
  });

  test('killSession failure does not abort reconcile — spawn still attempted, real tmux error surfaces', async () => {
    const env = setupTempCwd();
    try {
      // When killSession throws (unkillable orphan, server gone,
      // races a concurrent kill), the reconcile block must NOT
      // propagate that error. It logs and proceeds to spawn, which
      // surfaces the real underlying tmux duplicate-session error to
      // the operator — better diagnostics than a silent collision.
      const runner = makeRunner({ orphanFirstCall: true, killFails: true });
      const p = makeProc(runner);

      // Unkillable orphan + spawn → TMUX_SPAWN_FAILED from spawn (not
      // the kill error). The reconcile chose to attempt the spawn
      // rather than abort early, which is what we want for diagnosis.
      await assert.rejects(
        p.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd } }),
        (err) => err.code === 'TMUX_SPAWN_FAILED',
      );

      const order = runner._calls.map((c) => c.kind);
      assert.ok(order.indexOf('killSession') < order.indexOf('spawn'),
        'kill is attempted before spawn even when kill throws');
      assert.ok(order.includes('spawn'),
        'spawn is attempted after kill failure (not aborted by the kill exception)');
    } finally { env.cleanup(); }
  });

  test('runner without sessionExists method: reconcile is silently skipped', async () => {
    // Defensive: an old runner shape (no sessionExists) must not crash.
    const env = setupTempCwd();
    try {
      const runner = makeRunner({ orphanFirstCall: false });
      delete runner.sessionExists;
      const p = makeProc(runner);

      await p.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd } });

      const order = runner._calls.map((c) => c.kind);
      assert.equal(order.indexOf('killSession'), -1, 'no kill without sessionExists');
      assert.ok(order.includes('spawn'));

      await p.kill('test');
    } finally { env.cleanup(); }
  });

});

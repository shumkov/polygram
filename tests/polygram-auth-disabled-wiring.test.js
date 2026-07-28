'use strict';

/**
 * Structural tests pinning polygram.js's AUTH_DISABLED wiring
 * (docs/AUTH_DISABLED_HANDLING_SPEC.md) — the re-arm call in handleMessage's
 * success branch, the authDisabledGate DI wiring into createDispatcher(...),
 * and authDisabledHeartbeat.start() being called on boot.
 *
 * Why a structural (source-text) test rather than a unit test: handleMessage
 * has too many closure-captured deps (bot, db, tg, reactor factories,
 * streamer, autosteeredRefs, ...) to mock, and main() has side effects on
 * require (starts the bot) — the same limitation documented in
 * tests/polygram-success-path-order.test.js (the rc.10 / Bug 2 tests this
 * file mirrors). If a future refactor moves noteSuccess() out of the
 * genuine-success branch, or drops the DI wiring, these tests fire with a
 * pointer to the regression instead of the gap going unnoticed (found in
 * code review — the original implementation had zero coverage here).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const POLYGRAM_PATH = path.join(__dirname, '..', 'polygram.js');
const src = fs.readFileSync(POLYGRAM_PATH, 'utf8');
const lines = src.split('\n');

function findLineOf(needle, occurrence = 1, fromLine = 1) {
  let count = 0;
  for (let i = fromLine - 1; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      count++;
      if (count === occurrence) return i + 1; // 1-indexed
    }
  }
  return -1;
}

describe('polygram.js — AUTH_DISABLED re-arm placement', () => {
  test('authDisabledGate.noteSuccess() is called only inside the genuine-success branch', () => {
    const resultErrorLine = findLineOf('if (result.error) {');
    assert.ok(resultErrorLine > 0, 'must find the `if (result.error) { ... } else { ... }` branch this feature hooks');

    const successBranchLine = findLineOf('} else {', 1, resultErrorLine);
    assert.ok(successBranchLine > resultErrorLine,
      'must find the `} else {` that closes the error branch and opens the success branch');

    const noteSuccessLine = findLineOf('authDisabledGate.noteSuccess()');
    assert.ok(noteSuccessLine > 0, 'authDisabledGate.noteSuccess() call must exist');
    assert.ok(noteSuccessLine > successBranchLine,
      `noteSuccess() (line ${noteSuccessLine}) must be inside the success branch (opens line ${successBranchLine}), `
      + 'not the error branch above it — slash commands / early-returns never reach the success branch, '
      + 'so placing it here is what prevents false re-arms during an ongoing outage');

    // Bound the other side: it must come before the deferred rc.10
    // reactor-clear site (the success branch's tail), proving it's early in
    // the branch rather than accidentally hoisted past markReplied() into
    // dead/unreachable code after a `return`.
    const rc10DeferredClearLine = findLineOf('rc.10: clear progress reactions AFTER', 1, successBranchLine);
    assert.ok(rc10DeferredClearLine > successBranchLine, 'rc.10 deferred-clear marker must exist (pinned by tests/polygram-success-path-order.test.js)');
    assert.ok(noteSuccessLine < rc10DeferredClearLine,
      `noteSuccess() (line ${noteSuccessLine}) must come before the deferred reactor-clear tail (line ${rc10DeferredClearLine}) — `
      + 'i.e. early enough in the success branch to actually run, not after a `return`');

    // It must be a plain, unconditional statement — not wrapped in a
    // condition that could skip it on some successful turns (e.g. the
    // contextHint `if` a few lines below it).
    assert.match(lines[noteSuccessLine - 1], /^\s*try \{ authDisabledGate\.noteSuccess\(\); \}/,
      'noteSuccess() must be an unconditional top-level statement in the success branch, not nested inside an `if`');
  });
});

describe('polygram.js — AUTH_DISABLED DI + boot wiring', () => {
  test('authDisabledGate is passed into the real createDispatcher(...) call', () => {
    const callLine = findLineOf('} = createDispatcher({');
    assert.ok(callLine > 0, 'must find the createDispatcher(...) call site');
    const closeLine = findLineOf('}));', 1, callLine);
    assert.ok(closeLine > callLine, 'must find the matching close of the createDispatcher(...) call');
    const block = lines.slice(callLine - 1, closeLine).join('\n');
    assert.match(block, /\bauthDisabledGate,/,
      'the real createDispatcher(...) invocation must wire authDisabledGate through — '
      + 'omitting it silently falls back to a fresh, never-shared gate per the DI default, '
      + 'which would defeat cross-chat dedupe in production even though tests would still pass');
  });

  // The heartbeat filename carries BOT_NAME (every bot shares DATA_DIR, which is
  // process.cwd()), and createHeartbeat throws without one. BOT_NAME is null until
  // main() parses argv, so constructing at module scope kills the daemon at boot.
  test('the heartbeat is constructed after BOT_NAME is parsed and before start()', () => {
    const botNameLine = findLineOf('BOT_NAME = parseBotArg(process.argv);');
    const constructLine = findLineOf('authDisabledHeartbeat = createHeartbeat(');
    const startLine = findLineOf('authDisabledHeartbeat.start();');

    assert.ok(botNameLine > 0, 'must find where BOT_NAME is assigned');
    assert.ok(constructLine > 0, 'authDisabledHeartbeat must be constructed somewhere');
    assert.ok(constructLine > botNameLine,
      'constructing before BOT_NAME is parsed passes null and throws on boot');
    assert.ok(startLine > constructLine, 'cannot start a heartbeat that has not been constructed');
  });

  // shutdown() optional-chains the heartbeat because it may not exist yet. That is
  // only safe while the signal handlers are registered after construction; if a
  // refactor registers them earlier, the guard becomes load-bearing and the
  // shutdown path needs re-checking rather than silently relying on line order.
  test('signal handlers are registered after the heartbeat is constructed', () => {
    const constructLine = findLineOf('authDisabledHeartbeat = createHeartbeat(');
    const sigtermLine = findLineOf("process.on('SIGTERM'");
    assert.ok(sigtermLine > 0, 'must find SIGTERM registration');
    assert.ok(sigtermLine > constructLine,
      'SIGTERM registered before construction would make shutdown\'s ?. guard load-bearing');
  });

  test('authDisabledHeartbeat.start() is called on boot', () => {
    const startLine = findLineOf('authDisabledHeartbeat.start();');
    assert.ok(startLine > 0, 'authDisabledHeartbeat.start() must be called somewhere in main()\'s boot sequence');
    assert.doesNotMatch(lines[startLine - 1], /^\s*\/\//, 'the start() call must not be commented out');
  });

  test('authDisabledHeartbeat.stop() is called during graceful shutdown, alongside approvalSweepTimer', () => {
    const sweepTimerLine = findLineOf('if (approvalSweepTimer) clearInterval(approvalSweepTimer);');
    assert.ok(sweepTimerLine > 0, 'must find the existing shutdown()-timer-cleanup anchor');
    // Optional-chained: shutdown can run before main() constructs the heartbeat.
    const stopLine = findLineOf('authDisabledHeartbeat?.stop();');
    assert.ok(stopLine > 0, 'authDisabledHeartbeat.stop() must be called in shutdown() — an unref()\'d interval '
      + 'can\'t hang the process, but leaving it running lets a heartbeat write race the DB-close/PID-release steps');
    assert.ok(Math.abs(stopLine - sweepTimerLine) <= 3,
      'stop() should sit right next to the other interval cleanup in shutdown(), not somewhere unrelated');
  });
});

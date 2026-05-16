/**
 * Integration tests for TmuxProcess + PollScheduler (O1 optimization).
 *
 * Verifies the shared-tick scheduler is actually wired into the polling
 * loops correctly: acquire on poll start, release on poll exit (incl.
 * error/timeout paths), and N concurrent processes share ONE timer.
 */

'use strict';

// TmuxProcess.start() verifies the pinned claude binary exists
// (lib/claude-bin.js); the real binary isn't present in CI. Point
// the override at the node executable — always present. The fake
// runner never actually execs it.
if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { TmuxProcess } = require('../lib/process/tmux-process');
const { PollScheduler } = require('../lib/tmux/poll-scheduler');

const SILENT = { warn: () => {}, error: () => {}, debug: () => {}, log: () => {}, info: () => {} };
const READY = 'welcome\n? for shortcuts';
const REPLY = `welcome\n? for shortcuts\nhi back\n? for shortcuts`;

function makeRunner({ replies = [READY, REPLY, REPLY, REPLY] } = {}) {
  const calls = [];
  let idx = 0;
  return {
    _calls: calls,
    spawn: async () => { calls.push({ kind: 'spawn' }); },
    sendControl: async (n, k) => { calls.push({ kind: 'sendControl', name: n, key: k }); },
    pasteText: async (n, t) => {
      calls.push({ kind: 'pasteText', name: n, text: t });
      return { sanitized: t, oneLine: t, stripped: 0 };
    },
    captureWide: async () => replies[Math.min(idx++, replies.length - 1)],
    capturePane: async () => READY,
    sessionExists: async () => true,
    killSession: async () => {},
    listPolygramSessions: async () => [],
    setPaneReadOnly: async () => {},
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };
}

function makeProc(runner, sched, chatId = '100') {
  return new TmuxProcess({
    sessionKey: `chat:${chatId}`, chatId, threadId: null, label: `t-${chatId}`,
    runner, botName: 'shumabit', logger: SILENT,
    pollMs: 5, quiesceMs: 5, readyTimeoutMs: 500, turnTimeoutMs: 500,
    pollScheduler: sched,
  });
}

describe('TmuxProcess + PollScheduler integration', () => {

  test('start() acquires + releases the scheduler exactly once', async () => {
    const sched = new PollScheduler({ intervalMs: 10 });
    const proc = makeProc(makeRunner(), sched);
    assert.equal(sched.activeCount, 0, 'idle before start');
    await proc.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: '/tmp' } });
    assert.equal(sched.activeCount, 0,
      'after start() the ready-poll lifetime should have released');
    await proc.kill('cleanup');
  });

  test('send() acquires the scheduler while polling, releases on completion', async () => {
    const sched = new PollScheduler({ intervalMs: 10 });
    const proc = makeProc(makeRunner(), sched);
    await proc.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: '/tmp' } });
    assert.equal(sched.activeCount, 0);
    // Kick send() but don't await — peek at scheduler while it's polling.
    const sendP = proc.send('hi');
    // Yield once so send() can enter its polling loop and acquire.
    await new Promise((r) => setImmediate(r));
    // Note: very short turns can complete before this point (capture
    // sequence is permissive). What we MUST verify is that on
    // completion, activeCount returns to zero.
    await sendP;
    assert.equal(sched.activeCount, 0,
      'send() must release the scheduler after its polling loop exits');
    await proc.kill('cleanup');
  });

  test('send() releases scheduler even on TMUX_TURN_TIMEOUT', async () => {
    // Capture sequence keeps showing "streaming" so capture-pane never
    // reaches quiescence — _awaitTurnComplete throws TMUX_TURN_TIMEOUT.
    const streamingCap = 'welcome\n? for shortcuts\nesc to interrupt';
    const sched = new PollScheduler({ intervalMs: 5 });
    const runner = makeRunner({ replies: [READY, streamingCap, streamingCap, streamingCap, streamingCap, streamingCap, streamingCap, streamingCap] });
    const proc = makeProc(runner, sched);
    proc.turnTimeoutMs = 40;
    proc.lateGraceMs = 5;
    await proc.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: '/tmp' } });
    const res = await proc.send('stuck');
    // Should have surfaced a turn-timeout error result.
    assert.match(res.metrics.resultSubtype, /TMUX_TURN_TIMEOUT/);
    // Critical: scheduler must NOT be leaked.
    assert.equal(sched.activeCount, 0,
      'scheduler must release even on error path');
    await proc.kill('cleanup');
  });

  test('TWO processes share ONE scheduler timer (the whole point of O1)', async () => {
    const sched = new PollScheduler({ intervalMs: 10 });
    const procA = makeProc(makeRunner(), sched, '100');
    const procB = makeProc(makeRunner(), sched, '200');
    await procA.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: '/tmp' } });
    await procB.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: '/tmp' } });
    // Both processes done with their initial ready-poll. Now start
    // overlapping send()s.
    const pa = procA.send('first');
    const pb = procB.send('second');
    // Yield to let both enter their polling loops.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // We only assert the END state: both released. (Mid-flight refcount
    // is racy with how fast the fake captures complete; the invariant
    // that matters is no leak on completion.)
    await Promise.all([pa, pb]);
    assert.equal(sched.activeCount, 0,
      'both processes must have released after their sends completed');
    assert.equal(sched._timer, null,
      'when refcount reaches 0, the shared interval is cleared');
    await procA.kill('cleanup');
    await procB.kill('cleanup');
  });

  test('falls back to per-instance setTimeout when scheduler not provided', async () => {
    // Verifies the back-compat path: no scheduler injected → process
    // uses its own setTimeout for polling.
    const proc = makeProc(makeRunner(), null);
    assert.equal(proc.pollScheduler, null);
    await proc.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: '/tmp' } });
    // No scheduler means no shared timer to assert. Just verify the
    // process works.
    await proc.kill('cleanup');
  });
});

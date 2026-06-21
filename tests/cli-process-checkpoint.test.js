'use strict';
/**
 * 0.16 busy-aware ceiling — _checkpointAbsolute decision logic.
 *
 * The absolute timer no longer guillotines a turn at 30 min; it runs a
 * checkpoint that EXTENDS a provably-working turn (bounded by a hard max) and
 * only gives up when the turn went quiet (TURN_TIMEOUT) or hit the hard cap
 * (TURN_MAX_EXCEEDED). These pin the decision: extend vs give-up-reason, the
 * MF-A progress-delta (a zombie shell must NOT extend), and the MF-C TOCTOU
 * (turn settled during the async probe → no re-arm, no throw).
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { CliProcess } = require('../lib/process/cli-process');

const fakeRunner = {
  spawn: async () => {}, killSession: async () => {}, sendControl: async () => {},
  captureWide: async () => '',
};
const quiet = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeProc() {
  const p = new CliProcess({
    sessionKey: 'c:1', chatId: 'c', threadId: '1',
    tmuxRunner: fakeRunner, botName: 'bot', claudeBin: '/usr/bin/echo',
    toolDispatcher: async () => ({ ok: true }), logger: quiet,
    turnAbsoluteMs: 1_000_000, turnHardMaxMs: 5_400_000,
  });
  p._logEvent = () => {};            // swallow telemetry
  return p;
}

// Install a fake pending; returns {fired} capturing _fireTimeout(reason, probe).
function addPending(p, turnId, over = {}) {
  const fired = [];
  const pending = {
    replies: [], seen: false, startedAt: Date.now() - (over.elapsed ?? 60_000),
    _turnHardMaxMs: over.hardMax ?? 5_400_000,
    _lastCheckpointActivityAt: over.lastCheckpointAt ?? (Date.now() - 120_000),
    _lastCheckpointPaneTail: over.lastPaneTail ?? null,
    _extended: false,
    absoluteTimer: null,
    _fireTimeout: (reason, probe) => fired.push({ reason, probe }),
    ...over.pending,
  };
  p.pendingTurns.set(turnId, pending);
  return { pending, fired };
}

describe('_checkpointAbsolute — extend vs give up', () => {
  let p;
  beforeEach(() => { p = makeProc(); });

  test('working (streaming) + under hard max → re-arms, no give-up, turn-extended emitted once', async () => {
    const { pending, fired } = addPending(p, 't1', { elapsed: 60_000 });
    p._lastActivityAt = Date.now();   // progress advanced since last checkpoint
    p.probeBusyState = async () => ({ streaming: true, backgroundShell: false, shellCount: 0, paneTail: 'live', captured: true });
    let emitted = 0;
    p.on('turn-extended', () => { emitted += 1; });

    await p._checkpointAbsolute('t1');

    assert.ok(p.pendingTurns.has('t1'), 'turn still pending (not abandoned)');
    assert.equal(fired.length, 0, 'did not give up');
    assert.ok(pending.absoluteTimer, 're-armed the absolute timer');
    assert.equal(pending._extended, true);
    assert.equal(emitted, 1, 'turn-extended emitted once for the progress ping');
    clearTimeout(pending.absoluteTimer);
  });

  test('idle (no streaming, no shell) → gives up as TURN_TIMEOUT (reason=idle)', async () => {
    const { fired } = addPending(p, 't2', { elapsed: 60_000 });
    p._lastActivityAt = 0; p._lastHookEventAt = 0;
    p.probeBusyState = async () => ({ streaming: false, backgroundShell: false, shellCount: 0, paneTail: '', captured: true });
    await p._checkpointAbsolute('t2');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].reason, 'idle');
  });

  test('working but elapsed >= hard max → gives up as hard-max (→ TURN_MAX_EXCEEDED)', async () => {
    const { fired } = addPending(p, 't3', { elapsed: 6_000_000, hardMax: 5_400_000 });
    p._lastActivityAt = Date.now();
    p.probeBusyState = async () => ({ streaming: true, backgroundShell: false, shellCount: 0, paneTail: 'x', captured: true });
    await p._checkpointAbsolute('t3');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].reason, 'hard-max');
  });

  test('MF-A: shell exists but NO progress since last checkpoint (zombie) → give up, do NOT extend', async () => {
    // shellCount>0 but neither activity advanced nor pane changed → not working.
    const stamp = Date.now() - 200_000;
    const { fired, pending } = addPending(p, 't4', { elapsed: 60_000, lastCheckpointAt: stamp, lastPaneTail: 'frozen' });
    p._lastActivityAt = stamp; p._lastHookEventAt = stamp;     // unchanged since last checkpoint
    p.probeBusyState = async () => ({ streaming: false, backgroundShell: true, shellCount: 1, paneTail: 'frozen', captured: true });
    await p._checkpointAbsolute('t4');
    assert.equal(fired.length, 1, 'zombie shell does NOT extend');
    assert.equal(fired[0].reason, 'idle');
    assert.equal(pending._extended, false);
  });

  test('MF-A: shell + pane CHANGED since last checkpoint → extends (real progress)', async () => {
    const stamp = Date.now() - 200_000;
    const { pending, fired } = addPending(p, 't5', { elapsed: 60_000, lastCheckpointAt: stamp, lastPaneTail: 'old' });
    p._lastActivityAt = stamp;
    p.probeBusyState = async () => ({ streaming: false, backgroundShell: true, shellCount: 2, paneTail: 'NEW-output', captured: true });
    await p._checkpointAbsolute('t5');
    assert.equal(fired.length, 0, 'real progress extends');
    assert.ok(pending.absoluteTimer);
    clearTimeout(pending.absoluteTimer);
  });

  test('probe throws → treated as not-working → give up (idle), never rejects the checkpoint', async () => {
    const { fired } = addPending(p, 't6', { elapsed: 60_000 });
    p._lastActivityAt = 0; p._lastHookEventAt = 0;
    p.probeBusyState = async () => { throw new Error('captureWide failed'); };
    await assert.doesNotReject(p._checkpointAbsolute('t6'));
    assert.equal(fired.length, 1);
    assert.equal(fired[0].reason, 'idle');
  });

  test('MF-C TOCTOU: turn settled during the async probe → no re-arm, no give-up, no throw', async () => {
    const { fired, pending } = addPending(p, 't7', { elapsed: 60_000 });
    p.probeBusyState = async () => { p.pendingTurns.delete('t7'); return { streaming: true, backgroundShell: false, shellCount: 0, paneTail: 'x', captured: true }; };
    await assert.doesNotReject(p._checkpointAbsolute('t7'));
    assert.equal(fired.length, 0, 'no give-up on a turn that already settled');
    assert.equal(pending.absoluteTimer, null, 'no timer re-armed on a deleted turn');
  });

  test('MF-C: turn entered stop-grace DURING the probe → no re-arm, no ping (review finding #2)', async () => {
    const { fired, pending } = addPending(p, 't7b', { elapsed: 60_000 });
    let emitted = 0;
    p.on('turn-extended', () => { emitted += 1; });
    // turn starts finalizing mid-probe (reply landed → stop-grace) but is still
    // in pendingTurns (not deleted until _finalizeTurn).
    p.probeBusyState = async () => {
      pending._stopGracePending = true;
      pending.replies.push('the real answer');
      return { streaming: true, backgroundShell: false, shellCount: 0, paneTail: 'live', captured: true };
    };
    await assert.doesNotReject(p._checkpointAbsolute('t7b'));
    assert.equal(fired.length, 0, 'does not give up on a settling turn');
    assert.equal(emitted, 0, 'no spurious "still working" ping on a settling turn');
    assert.equal(pending.absoluteTimer, null, 'did not re-arm a settling turn');
  });

  test('replied turn → resolves via fireTimeout(absolute), never extends', async () => {
    const { fired } = addPending(p, 't8', { pending: { replies: ['answer'] } });
    p.probeBusyState = async () => { throw new Error('should not be probed'); };
    await p._checkpointAbsolute('t8');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].reason, 'absolute');   // hits the ceiling-resolve branch
  });

  test('missing turn → no-op', async () => {
    await assert.doesNotReject(p._checkpointAbsolute('nope'));
  });
});

describe('hasExtendedTurn (LRU pin signal)', () => {
  test('true iff some pending turn is _extended', () => {
    const p = makeProc();
    assert.equal(p.hasExtendedTurn(), false);
    addPending(p, 'a', {});
    assert.equal(p.hasExtendedTurn(), false);
    p.pendingTurns.get('a')._extended = true;
    assert.equal(p.hasExtendedTurn(), true);
  });
});

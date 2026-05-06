/**
 * Tests for lib/approval-waiters.js — covers all 5 cleanup paths +
 * the WAITER_CAP and SUPERSEDED edge cases.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApprovalWaiters } = require('../lib/approvals/waiters');

describe('approval-waiters — happy path', () => {
  test('park then resolveByClick resolves the promise with decision', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const p = w.park({ toolUseId: 'tu-1', sessionKey: 'c1' });
    assert.equal(w.size, 1);
    setImmediate(() => {
      w.resolveByClick('tu-1', { behavior: 'allow' });
    });
    const r = await p;
    assert.deepEqual(r, { behavior: 'allow' });
    assert.equal(w.size, 0);
  });

  test('resolveByClick on unknown toolUseId returns false', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    assert.equal(w.resolveByClick('nonexistent', { behavior: 'allow' }), false);
  });
});

describe('approval-waiters — path 2 signal abort', () => {
  test('AbortSignal abort rejects the parked promise with code:ABORTED', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const ctrl = new AbortController();
    const p = w.park({ toolUseId: 'tu-2', sessionKey: 'c1', signal: ctrl.signal });
    ctrl.abort();
    const err = await p.catch((e) => e);
    assert.equal(err.code, 'ABORTED');
    assert.equal(w.size, 0);
  });

  test('signal that aborts AFTER resolve does not double-fire', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const ctrl = new AbortController();
    const p = w.park({ toolUseId: 'tu-3', sessionKey: 'c1', signal: ctrl.signal });
    w.resolveByClick('tu-3', { behavior: 'allow' });
    ctrl.abort();    // late — should be a no-op
    const r = await p;
    assert.deepEqual(r, { behavior: 'allow' });
    assert.equal(w.size, 0);
  });
});

describe('approval-waiters — path 3 timeout sweeper', () => {
  test('parked > timeoutMs rejects with code:TIMEOUT', async () => {
    const w = createApprovalWaiters({
      logger: { error: () => {} },
      timeoutMs: 30,
      sweepIntervalMs: 10,
    });
    w.startTimeoutSweeper();
    const p = w.park({ toolUseId: 'tu-4', sessionKey: 'c1' });
    const err = await p.catch((e) => e);
    assert.equal(err.code, 'TIMEOUT');
    w.stopTimeoutSweeper();
  });

  test('startTimeoutSweeper is idempotent (multiple calls = single timer)', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} }, sweepIntervalMs: 10000 });
    w.startTimeoutSweeper();
    w.startTimeoutSweeper();
    w.startTimeoutSweeper();
    w.stopTimeoutSweeper();   // should not throw
  });
});

describe('approval-waiters — path 4 rejectAllForSession', () => {
  test('rejects only waiters matching the sessionKey, returns count', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const p1 = w.park({ toolUseId: 't-a', sessionKey: 'c1' });
    const p2 = w.park({ toolUseId: 't-b', sessionKey: 'c1' });
    const p3 = w.park({ toolUseId: 't-c', sessionKey: 'c2' });
    assert.equal(w.size, 3);
    const n = w.rejectAllForSession('c1', 'RESET_SESSION');
    assert.equal(n, 2);
    const e1 = await p1.catch((e) => e);
    const e2 = await p2.catch((e) => e);
    assert.equal(e1.code, 'RESET_SESSION');
    assert.equal(e2.code, 'RESET_SESSION');
    assert.equal(w.size, 1);
    // p3 still unresolved
    w.resolveByClick('t-c', { behavior: 'deny', message: 'cleanup' });
    const r3 = await p3;
    assert.deepEqual(r3, { behavior: 'deny', message: 'cleanup' });
  });
});

describe('approval-waiters — path 5 rejectAll', () => {
  test('rejects every waiter with code:DAEMON_SHUTDOWN', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const p1 = w.park({ toolUseId: 'a', sessionKey: 'c1' });
    const p2 = w.park({ toolUseId: 'b', sessionKey: 'c2' });
    const n = w.rejectAll();
    assert.equal(n, 2);
    const e1 = await p1.catch((e) => e);
    const e2 = await p2.catch((e) => e);
    assert.equal(e1.code, 'DAEMON_SHUTDOWN');
    assert.equal(e2.code, 'DAEMON_SHUTDOWN');
    assert.equal(w.size, 0);
  });
});

describe('approval-waiters — capacity + dedup', () => {
  test('park beyond maxWaiters throws WAITER_CAP', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} }, maxWaiters: 2 });
    w.park({ toolUseId: '1', sessionKey: 'c' });
    w.park({ toolUseId: '2', sessionKey: 'c' });
    assert.throws(
      () => w.park({ toolUseId: '3', sessionKey: 'c' }),
      { code: 'WAITER_CAP' },
    );
  });

  test('duplicate toolUseId rejects prior waiter with SUPERSEDED', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const p1 = w.park({ toolUseId: 'dup', sessionKey: 'c' });
    const p2 = w.park({ toolUseId: 'dup', sessionKey: 'c' });
    const e1 = await p1.catch((e) => e);
    assert.equal(e1.code, 'SUPERSEDED');
    // p2 still parked
    w.resolveByClick('dup', { behavior: 'allow' });
    const r2 = await p2;
    assert.deepEqual(r2, { behavior: 'allow' });
  });

  test('park without toolUseId throws NO_TOOL_USE_ID', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    assert.throws(
      () => w.park({ sessionKey: 'c' }),
      { code: 'NO_TOOL_USE_ID' },
    );
  });
});

describe('approval-waiters — defensive edge cases', () => {
  test('rejectAllForSession with no matching sessionKey returns 0', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    w.park({ toolUseId: 'x', sessionKey: 'c1' });
    const n = w.rejectAllForSession('c2');
    assert.equal(n, 0);
    assert.equal(w.size, 1);                                // c1 untouched
    w.resolveByClick('x', { behavior: 'allow' });
  });

  test('rejectAll on empty waiter map returns 0', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    assert.equal(w.rejectAll(), 0);
  });

  test('rejectAllForSession with custom code propagates', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const p = w.park({ toolUseId: 'x', sessionKey: 'c1' });
    w.rejectAllForSession('c1', 'CUSTOM_CODE');
    const e = await p.catch((err) => err);
    assert.equal(e.code, 'CUSTOM_CODE');
  });

  test('rejectAll with custom code propagates', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const p = w.park({ toolUseId: 'x', sessionKey: 'c1' });
    w.rejectAll('OPERATOR_KILL');
    const e = await p.catch((err) => err);
    assert.equal(e.code, 'OPERATOR_KILL');
  });

  test('stopTimeoutSweeper without start is a no-op', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    assert.doesNotThrow(() => w.stopTimeoutSweeper());
  });

  test('signal aborted BEFORE resolveByClick — click on abandoned waiter returns false', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const ctrl = new AbortController();
    const p = w.park({ toolUseId: 'tu', sessionKey: 'c', signal: ctrl.signal });
    ctrl.abort();
    const err = await p.catch((e) => e);
    assert.equal(err.code, 'ABORTED');
    // Late click should be a no-op (waiter already gone).
    assert.equal(w.resolveByClick('tu', { behavior: 'allow' }), false);
  });

  test('signal already aborted at park time — promise rejects without crash', async () => {
    // AbortSignal.aborted=true at construction time. The `once` listener
    // should still fire (or rejection should otherwise propagate).
    const ctrl = new AbortController();
    ctrl.abort();
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    const p = w.park({ toolUseId: 'tu', sessionKey: 'c', signal: ctrl.signal });
    // Implementations vary — some signals fire synchronously when
    // already-aborted, some wait until next tick. Either way, the
    // promise must settle (reject) — never hang.
    const err = await Promise.race([
      p.catch((e) => e),
      new Promise((res) => setTimeout(() => res({ code: 'TIMEOUT_GUARD' }), 200)),
    ]);
    assert.notEqual(err.code, 'TIMEOUT_GUARD',
      'signal abort must propagate even when aborted at park time');
  });

  test('size goes back to 0 after every cleanup path', async () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    // Path 1: click
    const p1 = w.park({ toolUseId: 'a', sessionKey: 'c1' });
    w.resolveByClick('a', { behavior: 'allow' });
    await p1;
    assert.equal(w.size, 0);
    // Path 2: signal
    const ctrl = new AbortController();
    const p2 = w.park({ toolUseId: 'b', sessionKey: 'c1', signal: ctrl.signal });
    ctrl.abort();
    await p2.catch(() => {});
    assert.equal(w.size, 0);
    // Path 4: rejectAllForSession
    const p4 = w.park({ toolUseId: 'd', sessionKey: 'c1' });
    w.rejectAllForSession('c1');
    await p4.catch(() => {});
    assert.equal(w.size, 0);
    // Path 5: rejectAll
    const p5 = w.park({ toolUseId: 'e', sessionKey: 'c1' });
    w.rejectAll();
    await p5.catch(() => {});
    assert.equal(w.size, 0);
  });

  test('cap-rejected park does not occupy a slot', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} }, maxWaiters: 1 });
    w.park({ toolUseId: 'a', sessionKey: 'c' });
    assert.throws(() => w.park({ toolUseId: 'b', sessionKey: 'c' }), { code: 'WAITER_CAP' });
    // Only the first park lives.
    assert.equal(w.size, 1);
    // Original waiter still resolvable.
    w.resolveByClick('a', { behavior: 'deny' });
    assert.equal(w.size, 0);
  });

  test('introspection getter exposes live size, not stale', () => {
    const w = createApprovalWaiters({ logger: { error: () => {} } });
    assert.equal(w.size, 0);
    w.park({ toolUseId: '1', sessionKey: 'c' });
    assert.equal(w.size, 1);
    w.park({ toolUseId: '2', sessionKey: 'c' });
    assert.equal(w.size, 2);
    w.resolveByClick('1', { behavior: 'allow' });
    assert.equal(w.size, 1);
  });
});

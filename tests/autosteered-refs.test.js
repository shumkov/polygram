/**
 * Tests for lib/autosteered-refs.js — the per-session tracker for
 * messages that received the ✍ AUTOSTEERED reaction. Pins the rc.14
 * invariant: turn-end clears every ✍ ack we issued during that turn,
 * so users don't see ✍ stuck on follow-up messages forever.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createAutosteeredRefs } = require('../lib/autosteered-refs');

describe('autosteered-refs — input validation', () => {
  test('throws when applyClear is missing', () => {
    assert.throws(() => createAutosteeredRefs({}), /applyClear/);
  });

  test('throws when applyClear is not a function', () => {
    assert.throws(() => createAutosteeredRefs({ applyClear: 'nope' }), /applyClear/);
  });
});

describe('autosteered-refs — add + get', () => {
  let refs;
  let calls;
  beforeEach(() => {
    calls = [];
    refs = createAutosteeredRefs({ applyClear: async (r) => { calls.push(r); } });
  });

  test('add + get round-trips a single ref', () => {
    refs.add('s1', { chatId: 100, msgId: 42 });
    assert.deepEqual(refs.get('s1'), [{ chatId: 100, msgId: 42 }]);
  });

  test('add accumulates refs in arrival order', () => {
    refs.add('s1', { chatId: 100, msgId: 1 });
    refs.add('s1', { chatId: 100, msgId: 2 });
    refs.add('s1', { chatId: 100, msgId: 3 });
    assert.deepEqual(refs.get('s1').map((r) => r.msgId), [1, 2, 3]);
  });

  test('multi-session isolation', () => {
    refs.add('s1', { chatId: 100, msgId: 1 });
    refs.add('s2', { chatId: 200, msgId: 2 });
    assert.equal(refs.size('s1'), 1);
    assert.equal(refs.size('s2'), 1);
    assert.equal(refs.get('s1')[0].msgId, 1);
    assert.equal(refs.get('s2')[0].msgId, 2);
  });

  test('get for unknown session returns empty array', () => {
    assert.deepEqual(refs.get('never'), []);
  });

  test('size for unknown session returns 0', () => {
    assert.equal(refs.size('never'), 0);
  });

  test('add ignores null/empty sessionKey', () => {
    refs.add(null, { chatId: 1, msgId: 1 });
    refs.add('', { chatId: 1, msgId: 1 });
    assert.equal(refs.size(''), 0);
  });

  test('add ignores ref with missing msgId', () => {
    refs.add('s1', { chatId: 1 });
    assert.equal(refs.size('s1'), 0);
  });

  test('add ignores ref with missing chatId', () => {
    refs.add('s1', { msgId: 1 });
    assert.equal(refs.size('s1'), 0);
  });

  test('add ignores null/undefined ref', () => {
    refs.add('s1', null);
    refs.add('s1', undefined);
    assert.equal(refs.size('s1'), 0);
  });

  test('get returns a defensive copy of the array (push does not corrupt state)', () => {
    refs.add('s1', { chatId: 1, msgId: 1 });
    const snapshot = refs.get('s1');
    snapshot.push({ chatId: 999, msgId: 999 });
    // Array-level: outer length unchanged.
    assert.equal(refs.size('s1'), 1);
    assert.equal(refs.get('s1').length, 1);
  });
});

describe('autosteered-refs — clear', () => {
  let refs;
  let calls;
  beforeEach(() => {
    calls = [];
    refs = createAutosteeredRefs({ applyClear: async (r) => { calls.push(r); } });
  });

  test('clear invokes applyClear once per ref', async () => {
    refs.add('s1', { chatId: 100, msgId: 1 });
    refs.add('s1', { chatId: 100, msgId: 2 });
    refs.add('s1', { chatId: 100, msgId: 3 });
    const cleared = await refs.clear('s1');
    assert.equal(cleared, 3);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.msgId), [1, 2, 3]);
  });

  test('clear empties the session', async () => {
    refs.add('s1', { chatId: 1, msgId: 1 });
    await refs.clear('s1');
    assert.equal(refs.size('s1'), 0);
    assert.deepEqual(refs.get('s1'), []);
  });

  test('clear is per-session', async () => {
    refs.add('s1', { chatId: 1, msgId: 1 });
    refs.add('s2', { chatId: 2, msgId: 2 });
    await refs.clear('s1');
    assert.equal(refs.size('s1'), 0);
    assert.equal(refs.size('s2'), 1);                       // s2 untouched
  });

  test('clear of unknown session returns 0 (no-op)', async () => {
    const cleared = await refs.clear('never');
    assert.equal(cleared, 0);
    assert.equal(calls.length, 0);
  });

  test('subsequent clear is no-op (refs already drained)', async () => {
    refs.add('s1', { chatId: 1, msgId: 1 });
    await refs.clear('s1');
    const cleared2 = await refs.clear('s1');
    assert.equal(cleared2, 0);
    assert.equal(calls.length, 1);
  });

  test('add after clear starts a fresh list', async () => {
    refs.add('s1', { chatId: 1, msgId: 1 });
    await refs.clear('s1');
    refs.add('s1', { chatId: 1, msgId: 99 });
    assert.equal(refs.size('s1'), 1);
    assert.equal(refs.get('s1')[0].msgId, 99);
  });
});

describe('autosteered-refs — clear rate-limiting (L7 fix)', () => {
  // L7 production-trace finding 2026-05-16: clear(sessionKey) ran
  // setMessageReaction([]) calls back-to-back (await loop, no
  // inter-call delay). Under N≥6 autosteers per turn that exceeds
  // Telegram's ~5/sec setMessageReaction limit, producing
  // telegram-rate-limit events and delaying ✍ clearing.
  //
  // Fix: clear() accepts a minIntervalMs option; with N>1 refs it
  // spaces calls by at least that interval. Default 250ms = 4/sec
  // (safe headroom below Telegram's cap). Tests pin both the
  // default behavior AND the opt-out (minIntervalMs=0 for tests
  // that don't care about timing).

  test('default clear paces N>1 calls by ≥250ms (rate-limit safety)', async () => {
    const ts = [];
    const refs = createAutosteeredRefs({
      applyClear: async () => { ts.push(Date.now()); },
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    refs.add('s1', { chatId: 1, msgId: 2 });
    refs.add('s1', { chatId: 1, msgId: 3 });
    const start = Date.now();
    await refs.clear('s1');
    const elapsed = Date.now() - start;
    // Three calls = two intervals, each ≥250ms → ≥500ms total.
    // Subtract 20ms tolerance for the very first call landing fast.
    assert.ok(elapsed >= 480,
      `clearing 3 refs should take ≥480ms (got ${elapsed}ms)`);
    // Inter-call gaps must all be ≥240ms (250ms minus tolerance).
    for (let i = 1; i < ts.length; i += 1) {
      const gap = ts[i] - ts[i - 1];
      assert.ok(gap >= 240,
        `gap ${i} should be ≥240ms (got ${gap}ms)`);
    }
  });

  test('minIntervalMs:0 disables pacing (back-compat / test-mode)', async () => {
    const refs = createAutosteeredRefs({
      applyClear: async () => {},
      minIntervalMs: 0,
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    refs.add('s1', { chatId: 1, msgId: 2 });
    refs.add('s1', { chatId: 1, msgId: 3 });
    const start = Date.now();
    await refs.clear('s1');
    // Without pacing 3 in-process awaits complete near-instantly.
    assert.ok(Date.now() - start < 50,
      `unpaced clear should be <50ms (got ${Date.now() - start}ms)`);
  });

  test('single-ref clear: no pacing delay applied (only N>1 paces)', async () => {
    const refs = createAutosteeredRefs({
      applyClear: async () => {},
      minIntervalMs: 250,
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    const start = Date.now();
    await refs.clear('s1');
    // One ref = no inter-call gap to apply.
    assert.ok(Date.now() - start < 50,
      `single-ref clear should be <50ms (got ${Date.now() - start}ms)`);
  });
});

describe('autosteered-refs — error handling during clear', () => {
  test('continues clearing remaining refs after one applyClear throws', async () => {
    const cleared = [];
    const errors = [];
    const refs = createAutosteeredRefs({
      applyClear: async (r) => {
        if (r.msgId === 2) throw new Error('telegram-down');
        cleared.push(r.msgId);
      },
      logger: { error: (m) => errors.push(m) },
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    refs.add('s1', { chatId: 1, msgId: 2 });
    refs.add('s1', { chatId: 1, msgId: 3 });
    const count = await refs.clear('s1');
    // 2 cleared, 1 errored.
    assert.equal(count, 2);
    assert.deepEqual(cleared, [1, 3]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /msg=2/);
    assert.match(errors[0], /telegram-down/);
  });

  test('all applyClear throwing — count is 0, errors logged, no throw out', async () => {
    const errors = [];
    const refs = createAutosteeredRefs({
      applyClear: async () => { throw new Error('boom'); },
      logger: { error: (m) => errors.push(m) },
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    refs.add('s1', { chatId: 1, msgId: 2 });
    const count = await refs.clear('s1');
    assert.equal(count, 0);
    assert.equal(errors.length, 2);
  });

  test('clear empties session even when every applyClear throws', async () => {
    const refs = createAutosteeredRefs({
      applyClear: async () => { throw new Error('boom'); },
      logger: { error: () => {} },
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    await refs.clear('s1');
    // State is wiped regardless of clear outcome — otherwise next
    // turn's clear() would re-attempt the same broken Telegram calls.
    assert.equal(refs.size('s1'), 0);
  });

  test('missing logger does not crash on applyClear error', async () => {
    const refs = createAutosteeredRefs({
      applyClear: async () => { throw new Error('boom'); },
      logger: undefined,                                     // explicit
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    await assert.doesNotReject(refs.clear('s1'));
  });
});

describe('autosteered-refs — dropSession', () => {
  test('dropSession removes refs without calling applyClear', () => {
    const calls = [];
    const refs = createAutosteeredRefs({
      applyClear: async (r) => { calls.push(r); },
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    refs.add('s1', { chatId: 1, msgId: 2 });
    refs.dropSession('s1');
    assert.equal(refs.size('s1'), 0);
    // applyClear NOT invoked.
    assert.equal(calls.length, 0);
  });

  test('dropSession is per-session', () => {
    const refs = createAutosteeredRefs({ applyClear: async () => {} });
    refs.add('s1', { chatId: 1, msgId: 1 });
    refs.add('s2', { chatId: 2, msgId: 2 });
    refs.dropSession('s1');
    assert.equal(refs.size('s1'), 0);
    assert.equal(refs.size('s2'), 1);
  });

  test('dropSession of unknown session is a no-op', () => {
    const refs = createAutosteeredRefs({ applyClear: async () => {} });
    assert.doesNotThrow(() => refs.dropSession('never'));
  });
});

describe('autosteered-refs — clear order', () => {
  test('refs are cleared in arrival order (FIFO)', async () => {
    const order = [];
    const refs = createAutosteeredRefs({
      applyClear: async (r) => { order.push(r.msgId); },
    });
    refs.add('s1', { chatId: 1, msgId: 10 });
    refs.add('s1', { chatId: 1, msgId: 20 });
    refs.add('s1', { chatId: 1, msgId: 30 });
    await refs.clear('s1');
    assert.deepEqual(order, [10, 20, 30]);
  });

  test('clears are awaited sequentially (not parallel)', async () => {
    // applyClear with a delay; if clears are serial, total time
    // ≈ 3 × delay; if parallel, ≈ delay.
    let inFlight = 0;
    let maxInFlight = 0;
    const refs = createAutosteeredRefs({
      applyClear: async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
      },
    });
    refs.add('s1', { chatId: 1, msgId: 1 });
    refs.add('s1', { chatId: 1, msgId: 2 });
    refs.add('s1', { chatId: 1, msgId: 3 });
    await refs.clear('s1');
    // Serial → max in-flight is 1.
    assert.equal(maxInFlight, 1);
  });
});

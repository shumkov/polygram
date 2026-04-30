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

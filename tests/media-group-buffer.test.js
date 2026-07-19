const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createMediaGroupBuffer } = require('../lib/media-group-buffer');

function makeFakeTimer() {
  let now = 0;
  const pending = [];

  const timerFn = (cb, delay) => {
    const handle = { cb, fireAt: now + delay };
    pending.push(handle);
    // Provide unref stub so production code calling t.unref?.() is safe.
    handle.unref = () => {};
    return handle;
  };

  const clearTimerFn = (handle) => {
    const idx = pending.indexOf(handle);
    if (idx !== -1) pending.splice(idx, 1);
  };

  const advance = (ms) => {
    now += ms;
    const due = pending.filter(h => h.fireAt <= now);
    for (const h of due) {
      const idx = pending.indexOf(h);
      if (idx !== -1) pending.splice(idx, 1);
      h.cb();
    }
  };

  return { timerFn, clearTimerFn, advance, get pending() { return pending; } };
}

describe('media-group-buffer', () => {
  test('single message flushes after flushMs', () => {
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 500,
      onFlush: (msgs, key) => flushed.push({ msgs, key }),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
    });
    buf.add('chat:group1', { id: 1 });
    t.advance(499);
    assert.equal(flushed.length, 0);
    t.advance(1);
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].msgs.length, 1);
    assert.equal(flushed[0].key, 'chat:group1');
  });

  test('multiple messages under flushMs apart bundle into one flush', () => {
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 500,
      onFlush: (msgs) => flushed.push(msgs),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
    });
    buf.add('k', { id: 1 });
    t.advance(100);
    buf.add('k', { id: 2 });
    t.advance(100);
    buf.add('k', { id: 3 });
    t.advance(100);
    buf.add('k', { id: 4 });
    // Nothing flushed yet — timer keeps resetting.
    assert.equal(flushed.length, 0);
    // 500ms after the LAST add:
    t.advance(500);
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].length, 4);
    assert.deepEqual(flushed[0].map(m => m.id), [1, 2, 3, 4]);
  });

  test('gap > flushMs creates separate groups', () => {
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 500,
      onFlush: (msgs) => flushed.push(msgs),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
    });
    buf.add('k', { id: 1 });
    t.advance(600); // beyond flushMs — first group fires
    buf.add('k', { id: 2 });
    t.advance(600);
    assert.equal(flushed.length, 2);
    assert.deepEqual(flushed[0].map(m => m.id), [1]);
    assert.deepEqual(flushed[1].map(m => m.id), [2]);
  });

  test('different keys do not bleed into each other', () => {
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 500,
      onFlush: (msgs, key) => flushed.push({ ids: msgs.map(m => m.id), key }),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
    });
    buf.add('chat1:g1', { id: 1 });
    buf.add('chat2:g2', { id: 2 });
    buf.add('chat1:g1', { id: 3 });
    t.advance(500);
    assert.equal(flushed.length, 2);
    const g1 = flushed.find(f => f.key === 'chat1:g1');
    const g2 = flushed.find(f => f.key === 'chat2:g2');
    assert.deepEqual(g1.ids, [1, 3]);
    assert.deepEqual(g2.ids, [2]);
  });

  test('flushAll drains all pending groups immediately', () => {
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 10000,
      onFlush: (msgs) => flushed.push(msgs),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
    });
    buf.add('a', { id: 1 });
    buf.add('b', { id: 2 });
    assert.equal(buf.size, 2);
    buf.flushAll();
    assert.equal(flushed.length, 2);
    assert.equal(buf.size, 0);
  });

  test('peekAll returns buffered messages without flushing (shutdown replay-marking)', () => {
    // Shutdown marks still-buffered album siblings replay-pending in the DB;
    // it needs to SEE them without triggering onFlush (a flush at exit would
    // race the 100ms process.exit and lose the album anyway).
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 10000,
      onFlush: (msgs) => flushed.push(msgs),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
    });
    buf.add('a', { id: 1 });
    buf.add('a', { id: 2 });
    buf.add('b', { id: 3 });
    const peeked = buf.peekAll();
    assert.deepEqual(peeked.map((m) => m.id).sort(), [1, 2, 3]);
    assert.equal(flushed.length, 0, 'peek must not flush');
    assert.equal(buf.size, 2, 'peek must not drain the buffer');
  });

  test('takeAllForShutdown cancels every pending timer and drains the buffer without flushing (review: adversarial race)', () => {
    // peekAll() alone leaves each group's flush timer live: if it fires
    // during the shutdown drain window (after shutdown has already read and
    // DB-marked the group replay-pending), onFlush runs normally and the
    // group gets processed twice. takeAllForShutdown() must atomically
    // cancel the timer AND remove the group in the same pass, so nothing
    // can self-flush after shutdown has taken ownership of it.
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 500,
      onFlush: (msgs, key) => flushed.push({ msgs, key }),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
    });
    buf.add('a', { id: 1 });
    buf.add('a', { id: 2 });
    buf.add('b', { id: 3 });
    assert.equal(t.pending.length, 2, 'sanity: two groups, two live timers');

    const groups = buf.takeAllForShutdown();

    assert.equal(t.pending.length, 0, 'every group timer must be cancelled');
    assert.equal(buf.size, 0, 'buffer must be fully drained');
    assert.equal(flushed.length, 0, 'must not flush — shutdown owns the groups now, not a live dispatch');

    // Advance the clock well past flushMs — if any timer survived, it would
    // fire here and flush. It must not.
    t.advance(10000);
    assert.equal(flushed.length, 0, 'no group must self-flush after being taken for shutdown');

    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.messages.map((m) => m.id)]));
    assert.deepEqual(byKey, { a: [1, 2], b: [3] });
  });

  test('onFlush throwing does not break the buffer', () => {
    const t = makeFakeTimer();
    let calls = 0;
    const buf = createMediaGroupBuffer({
      flushMs: 500,
      onFlush: () => { calls += 1; throw new Error('boom'); },
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
    });
    buf.add('a', { id: 1 });
    t.advance(500);
    buf.add('b', { id: 2 });
    t.advance(500);
    assert.equal(calls, 2, 'second flush still fires after first threw');
  });

  test('per-group size cap forces immediate flush', () => {
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 10_000,
      maxMessagesPerGroup: 3,
      onFlush: (msgs) => flushed.push(msgs),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
      nowFn: () => 0,
    });
    buf.add('k', { id: 1 });
    buf.add('k', { id: 2 });
    assert.equal(flushed.length, 0);
    buf.add('k', { id: 3 }); // hits cap → flush now
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].length, 3);
    assert.equal(buf.size, 0);
  });

  test('total-entries cap force-flushes the oldest entry', () => {
    const t = makeFakeTimer();
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 10_000,
      maxEntries: 2,
      onFlush: (msgs, key) => flushed.push({ msgs, key }),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
      nowFn: () => 0,
    });
    buf.add('a', { id: 1 });
    buf.add('b', { id: 2 });
    assert.equal(buf.size, 2);
    buf.add('c', { id: 3 }); // exceeds maxEntries → oldest ('a') flushed
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].key, 'a');
    assert.equal(buf.size, 2);
  });

  test('per-group wall-clock cap flushes despite drip-feed timer reset', () => {
    const t = makeFakeTimer();
    let nowVal = 1_000_000;
    const flushed = [];
    const buf = createMediaGroupBuffer({
      flushMs: 500,
      maxAgeMs: 5_000,
      onFlush: (msgs) => flushed.push(msgs),
      timerFn: t.timerFn,
      clearTimerFn: t.clearTimerFn,
      nowFn: () => nowVal,
    });
    buf.add('k', { id: 1 });
    // Drip-feed siblings under flushMs to keep resetting the timer.
    for (let i = 2; i <= 6; i++) {
      nowVal += 400; // < flushMs (500)
      t.advance(400);
      buf.add('k', { id: i });
      if (flushed.length > 0) break;
    }
    // 5 increments × 400ms = 2000ms — still under maxAgeMs.
    assert.equal(flushed.length, 0);
    // Push past the wall-clock cap.
    nowVal += 4_000;
    t.advance(4_000);
    buf.add('k', { id: 99 });
    assert.equal(flushed.length, 1, 'wall-clock cap forces flush even though timer kept resetting');
  });
});

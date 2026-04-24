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
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PollScheduler } = require('@shumkov/orchestra').pollScheduler;

async function settle(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('PollScheduler', () => {

  test('starts interval on first acquire, stops on last release', async () => {
    const s = new PollScheduler({ intervalMs: 30 });
    assert.equal(s.activeCount, 0);
    s.acquire();
    assert.equal(s.activeCount, 1);
    assert.ok(s._timer, 'interval should be running');
    s.release();
    assert.equal(s.activeCount, 0);
    assert.equal(s._timer, null, 'interval should be cleared');
  });

  test('refcount supports multiple acquires', () => {
    const s = new PollScheduler({ intervalMs: 30 });
    s.acquire(); s.acquire(); s.acquire();
    assert.equal(s.activeCount, 3);
    s.release(); s.release();
    assert.equal(s.activeCount, 1);
    assert.ok(s._timer);
    s.release();
    assert.equal(s._timer, null);
  });

  test('tick resolves all waiters simultaneously', async () => {
    const s = new PollScheduler({ intervalMs: 20 });
    s.acquire();
    const order = [];
    const w1 = s.waitTick().then(() => order.push('a'));
    const w2 = s.waitTick().then(() => order.push('b'));
    const w3 = s.waitTick().then(() => order.push('c'));
    await Promise.all([w1, w2, w3]);
    // Order of resolution is registration order — Set preserves it.
    assert.deepEqual(order, ['a', 'b', 'c']);
    s.release();
  });

  test('release() while waiters parked wakes them so their loops can exit', async () => {
    const s = new PollScheduler({ intervalMs: 10_000 }); // far longer than test
    s.acquire();
    const w = s.waitTick();
    // Release immediately — without the wake-on-release, w would block
    // for 10 seconds.
    s.release();
    await Promise.race([
      w,
      new Promise((_, rej) => setTimeout(() => rej(new Error('waiter not woken')), 100)),
    ]);
  });

  test('waitTick after the previous tick is a new tick (not the same)', async () => {
    const s = new PollScheduler({ intervalMs: 15 });
    s.acquire();
    await s.waitTick();
    const before = Date.now();
    await s.waitTick();
    const elapsed = Date.now() - before;
    assert.ok(elapsed >= 10, `expected ≥10ms between ticks, got ${elapsed}ms`);
    s.release();
  });

  test('two acquire/release lifecycles share the same interval (no churn)', async () => {
    const s = new PollScheduler({ intervalMs: 20 });
    s.acquire();
    const t1 = s._timer;
    s.acquire();           // refCount=2; timer unchanged
    assert.strictEqual(s._timer, t1);
    s.release();           // refCount=1; timer still alive
    assert.strictEqual(s._timer, t1);
    s.release();           // refCount=0; timer cleared
    assert.equal(s._timer, null);
  });

  test('safe when release called more times than acquire (no underflow)', () => {
    const s = new PollScheduler({ intervalMs: 30 });
    s.release();           // no-op
    s.release();           // no-op
    assert.equal(s.activeCount, 0);
    s.acquire();
    assert.equal(s.activeCount, 1);
    s.release();
    s.release();           // extra; should be no-op
    assert.equal(s.activeCount, 0);
  });
});

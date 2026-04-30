const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createAsyncLock } = require('../lib/async-lock');

describe('createAsyncLock', () => {
  test('single acquire/release works', async () => {
    const lock = createAsyncLock();
    const release = await lock.acquire('a');
    release();
  });

  test('FIFO: second acquire awaits first release', async () => {
    const lock = createAsyncLock();
    const order = [];
    const r1 = await lock.acquire('k');
    const p2 = lock.acquire('k').then((r) => {
      order.push('2-acquired');
      r();
    });
    // Give microtasks a chance — second should still be blocked.
    await new Promise((r) => setImmediate(r));
    order.push('before-release-1');
    r1();
    await p2;
    assert.deepEqual(order, ['before-release-1', '2-acquired']);
  });

  test('different keys do not block each other', async () => {
    const lock = createAsyncLock();
    const ra = await lock.acquire('a');
    // 'b' should acquire immediately even though 'a' is held.
    const rb = await lock.acquire('b');
    rb();
    ra();
  });

  test('chain of many acquires resolves in order', async () => {
    const lock = createAsyncLock();
    const order = [];
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        lock.acquire('k').then((release) => {
          order.push(i);
          release();
        }),
      );
    }
    await Promise.all(promises);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  test('Map cleanup: size returns to 0 after a single drained cycle', async () => {
    // Pre-fix this leaked: prev.then(() => next) was re-allocated in
    // the cleanup branch, so === compare with the stored promise was
    // always false and the entry never dropped.
    const lock = createAsyncLock();
    const r = await lock.acquire('k');
    r();
    // Wait for the chain promise to settle so cleanup can fire.
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(lock.size, 0);
  });

  test('Map cleanup: many unique keys do not leak entries', async () => {
    const lock = createAsyncLock();
    for (let i = 0; i < 50; i++) {
      const r = await lock.acquire('k' + i);
      r();
    }
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(lock.size, 0);
  });

  test('Map cleanup: queued acquire takes ownership, prior cleanup does NOT delete', async () => {
    // r1 holds lock; p2 queues. When r1() fires cleanup, the entry
    // belongs to p2 now — must not delete (otherwise p2's release
    // would have nothing to clean).
    const lock = createAsyncLock();
    const r1 = await lock.acquire('k');
    const p2 = lock.acquire('k');
    r1();
    const r2 = await p2;
    // After r1 cleanup ran, size should still be 1 (p2 owns).
    assert.equal(lock.size, 1);
    r2();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(lock.size, 0);
  });

  test('Map cleanup: parallel keys clean up independently', async () => {
    const lock = createAsyncLock();
    const ra = await lock.acquire('a');
    const rb = await lock.acquire('b');
    assert.equal(lock.size, 2);
    ra();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(lock.size, 1);                              // 'a' gone, 'b' held
    rb();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(lock.size, 0);
  });

  test('release is idempotent: second call is harmless', async () => {
    // Calling release twice should not crash or corrupt state.
    const lock = createAsyncLock();
    const r = await lock.acquire('k');
    r();
    assert.doesNotThrow(() => r());
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(lock.size, 0);
  });

  test('FIFO across 3 with mid-chain reacquire of same key', async () => {
    // Confirms a stale "released" promise reference doesn't bleed
    // into a future acquire of the same key.
    const lock = createAsyncLock();
    const order = [];

    const r1 = await lock.acquire('k');
    order.push('1');
    r1();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(lock.size, 0);

    const r2 = await lock.acquire('k');
    order.push('2');
    r2();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(lock.size, 0);
    assert.deepEqual(order, ['1', '2']);
  });
});

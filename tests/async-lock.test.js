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
});

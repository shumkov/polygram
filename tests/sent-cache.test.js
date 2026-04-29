const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createSentCache } = require('../lib/sent-cache');

describe('createSentCache', () => {
  let cache;
  beforeEach(() => { cache = createSentCache(); });

  test('record + wasSent round-trip', () => {
    cache.record('1', 100);
    assert.equal(cache.wasSent('1', 100), true);
  });

  test('wasSent returns false for unrecorded ids', () => {
    cache.record('1', 100);
    assert.equal(cache.wasSent('1', 999), false);
    assert.equal(cache.wasSent('2', 100), false);
  });

  test('null/undefined args are no-ops', () => {
    cache.record(null, 100);
    cache.record('1', null);
    cache.record(undefined, undefined);
    assert.equal(cache.wasSent(null, 100), false);
    assert.equal(cache.wasSent('1', null), false);
  });

  test('multiple chats are isolated', () => {
    cache.record('1', 100);
    cache.record('2', 100);
    assert.equal(cache.wasSent('1', 100), true);
    assert.equal(cache.wasSent('2', 100), true);
    assert.equal(cache.wasSent('3', 100), false);
  });

  test('size counts all entries across chats', () => {
    cache.record('1', 100);
    cache.record('1', 101);
    cache.record('2', 200);
    assert.equal(cache.size(), 3);
  });

  test('clear empties the cache', () => {
    cache.record('1', 100);
    cache.record('2', 200);
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.equal(cache.wasSent('1', 100), false);
  });
});

describe('sent-cache TTL behaviour', () => {
  test('expired entries are not reported as wasSent', () => {
    const cache = createSentCache();
    cache.record('1', 100);
    // Manually fast-forward by mutating the cache's internal Map via
    // a clone — easiest path is to overwrite Date.now temporarily.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 25 * 60 * 60 * 1000;  // 25h later
      assert.equal(cache.wasSent('1', 100), false);
    } finally {
      Date.now = realNow;
    }
  });

  test('lazy cleanup runs when per-chat map exceeds threshold', () => {
    const cache = createSentCache();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      // Insert 100 fresh entries — under threshold, no cleanup yet.
      for (let i = 0; i < 100; i++) cache.record('1', i);
      assert.equal(cache.size(), 100);

      // Move time forward past TTL.
      now += 25 * 60 * 60 * 1000;

      // Insert one more — pushes per-chat past 100, triggers cleanup
      // of expired entries from this chat.
      cache.record('1', 101);
      // The 100 expired + 1 fresh, but cleanup ran during record()
      // and dropped expired, leaving only the fresh ones.
      assert.equal(cache.size(), 1);
      assert.equal(cache.wasSent('1', 101), true);
      assert.equal(cache.wasSent('1', 0), false);
    } finally {
      Date.now = realNow;
    }
  });
});

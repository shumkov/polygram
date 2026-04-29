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
    let now = 1000;
    const cache = createSentCache({ clock: () => now });
    cache.record('1', 100);
    now += 25 * 60 * 60 * 1000;  // 25h later
    assert.equal(cache.wasSent('1', 100), false);
  });

  test('lazy cleanup runs when per-chat map exceeds threshold', () => {
    let now = 1000;
    const cache = createSentCache({ clock: () => now });
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
  });
});

// 0.7.1: hard cap + outer sweep
describe('sent-cache (0.7.1): hard cap + outer sweep', () => {
  test('per-chat hard cap evicts oldest when no entries are expired', () => {
    let now = 1000;
    const cache = createSentCache({
      clock: () => now,
      cleanupThreshold: 5,
      maxPerChat: 3,
      ttlMs: 1_000_000,  // huge — nothing expires during the test
    });
    // Insert 6 fresh entries — past cleanupThreshold (5).
    // gcInner finds 0 expired → falls through to maxPerChat eviction.
    // dropCount = entry.size (6) - maxPerChat (3) = 3 oldest evicted.
    for (let i = 0; i < 6; i++) cache.record('1', i);
    assert.equal(cache.size(), 3);
    // Oldest (0, 1, 2) gone; newest (3, 4, 5) retained.
    assert.equal(cache.wasSent('1', 0), false);
    assert.equal(cache.wasSent('1', 1), false);
    assert.equal(cache.wasSent('1', 2), false);
    assert.equal(cache.wasSent('1', 3), true);
    assert.equal(cache.wasSent('1', 4), true);
    assert.equal(cache.wasSent('1', 5), true);
  });

  test('outer sweep drops empty chat Maps', () => {
    let now = 1000;
    const cache = createSentCache({
      clock: () => now,
      cleanupThreshold: 1,
      ttlMs: 100,
      outerSweepThreshold: 3,
    });
    cache.record('1', 1);
    cache.record('2', 1);
    cache.record('3', 1);
    cache.record('4', 1);  // outer sweep triggered (size > 3)
    assert.equal(cache.chatCount(), 4);
    // Advance past TTL so all entries are expired.
    now += 1000;
    // wasSent on each empties their inner Maps and drops the outer.
    cache.wasSent('1', 1);
    cache.wasSent('2', 1);
    assert.equal(cache.chatCount(), 2, 'wasSent should drop empty inners');
    // Trigger outer sweep again via a record on a 5th chat.
    cache.record('5', 1);
    cache.wasSent('3', 1);
    cache.wasSent('4', 1);
    cache.record('6', 1);
    cache.record('7', 1);  // size > 3 again, outer sweep
    // Empty chats 3 and 4 should be gone.
    assert.ok(cache.chatCount() <= 5);
  });

  test('wasSent on expired entry drops the inner Map when emptied', () => {
    let now = 1000;
    const cache = createSentCache({ clock: () => now, ttlMs: 100 });
    cache.record('1', 100);
    assert.equal(cache.chatCount(), 1);
    now += 1000;
    cache.wasSent('1', 100);  // expired, drops it
    assert.equal(cache.chatCount(), 0, 'empty inner should be dropped');
  });

  test('record-after-clear works', () => {
    const cache = createSentCache();
    cache.record('1', 1);
    cache.clear();
    cache.record('1', 1);
    assert.equal(cache.wasSent('1', 1), true);
  });

  test('options accept ttlMs, cleanupThreshold, maxPerChat, clock overrides', () => {
    let now = 0;
    const cache = createSentCache({
      ttlMs: 50, cleanupThreshold: 2, maxPerChat: 1, clock: () => now,
    });
    cache.record('1', 1);
    cache.record('1', 2);
    cache.record('1', 3);  // cleanupThreshold exceeded → gcInner
    assert.equal(cache.size(), 1);
  });
});

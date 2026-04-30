/**
 * Tests for lib/abort-grace.js — per-session abort window that
 * silences error replies caused by the user's own /stop.
 *
 * Closes v6 plan §7.1 G11 unit gate.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createAbortGrace, DEFAULT_ABORT_GRACE_MS } = require('../lib/abort-grace');

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

describe('createAbortGrace — basic behaviour', () => {
  test('isRecent returns false for never-marked session', () => {
    const g = createAbortGrace();
    assert.equal(g.isRecent('s1'), false);
  });

  test('isRecent returns true immediately after mark', () => {
    const g = createAbortGrace();
    g.mark('s1');
    assert.equal(g.isRecent('s1'), true);
  });

  test('isRecent returns false after the window expires', () => {
    const clk = fakeClock();
    const g = createAbortGrace({ windowMs: 1000, now: clk.now });
    g.mark('s1');
    clk.advance(999);
    assert.equal(g.isRecent('s1'), true, 'just before expiry');
    clk.advance(1);
    assert.equal(g.isRecent('s1'), false, 'exactly at expiry — strict <');
  });

  test('isRecent during the window matches each pending error in a flurry', () => {
    // Realistic: one /stop drains 5 pendings within ~30ms. All of
    // them should see "recent abort = true" and suppress their reply.
    const clk = fakeClock();
    const g = createAbortGrace({ windowMs: 15_000, now: clk.now });
    g.mark('s1');
    for (let i = 0; i < 5; i++) {
      clk.advance(6);
      assert.equal(g.isRecent('s1'), true, `pending ${i + 1}/5`);
    }
  });

  test('mark rejects null/undefined/empty sessionKey', () => {
    const g = createAbortGrace();
    g.mark(null);
    g.mark(undefined);
    g.mark('');
    assert.equal(g.size, 0);
  });

  test('multi-session isolation', () => {
    const clk = fakeClock();
    const g = createAbortGrace({ windowMs: 1000, now: clk.now });
    g.mark('s1');
    clk.advance(500);
    g.mark('s2');
    clk.advance(600);
    // s1 marked at t=0; now t=1100 → expired
    // s2 marked at t=500; now t=1100 → 600ms in, still in window
    assert.equal(g.isRecent('s1'), false, 's1 should have expired');
    assert.equal(g.isRecent('s2'), true, 's2 should still be in window');
  });

  test('re-marking refreshes the timestamp', () => {
    const clk = fakeClock();
    const g = createAbortGrace({ windowMs: 1000, now: clk.now });
    g.mark('s1');
    clk.advance(900);
    g.mark('s1');                                  // re-mark
    clk.advance(900);
    // Total elapsed 1800ms but only 900ms since latest mark.
    assert.equal(g.isRecent('s1'), true);
  });
});

describe('createAbortGrace — clear', () => {
  test('clear removes the abort flag', () => {
    const g = createAbortGrace();
    g.mark('s1');
    g.clear('s1');
    assert.equal(g.isRecent('s1'), false);
  });

  test('clear is per-session', () => {
    const g = createAbortGrace();
    g.mark('s1');
    g.mark('s2');
    g.clear('s1');
    assert.equal(g.isRecent('s1'), false);
    assert.equal(g.isRecent('s2'), true);
  });

  test('clear of unmarked session is a no-op', () => {
    const g = createAbortGrace();
    assert.doesNotThrow(() => g.clear('never'));
  });
});

describe('createAbortGrace — opportunistic sweep', () => {
  test('mark drops entries older than 2× window', () => {
    const clk = fakeClock();
    const g = createAbortGrace({ windowMs: 1000, now: clk.now });
    g.mark('old');                                 // t=0
    clk.advance(500);
    g.mark('mid');                                 // t=500
    clk.advance(2000);
    // t=2500. Sweep threshold is 2*windowMs=2000ms.
    // 'old' is 2500ms old → swept; 'mid' is 2000ms old → exactly at
    // threshold (`> windowMs*2` is strict).
    g.mark('new');                                 // triggers sweep
    assert.equal(g.size, 2, 'old swept; mid + new remain');
    assert.equal(g.isRecent('old'), false);
  });

  test('sweep runs even when the same key is being re-marked', () => {
    const clk = fakeClock();
    const g = createAbortGrace({ windowMs: 1000, now: clk.now });
    g.mark('keep-fresh');
    for (let i = 0; i < 5; i++) {
      clk.advance(500);
      g.mark('keep-fresh');                        // refresh
      g.mark(`stranger-${i}`);                     // distinct sessions
    }
    // stranger-0 marked at t=500; now t=2500. Age 2000ms — at threshold.
    // stranger-4 marked at t=2500. Fresh.
    // keep-fresh re-marked latest at t=2500. Fresh.
    assert.equal(g.isRecent('keep-fresh'), true);
    assert.equal(g.isRecent('stranger-4'), true);
  });
});

describe('createAbortGrace — defaults', () => {
  test('DEFAULT_ABORT_GRACE_MS is 15s', () => {
    assert.equal(DEFAULT_ABORT_GRACE_MS, 15_000);
  });

  test('default window is DEFAULT_ABORT_GRACE_MS', () => {
    // Use injected clock to avoid sleeping for 15s.
    const clk = fakeClock();
    const g = createAbortGrace({ now: clk.now });
    g.mark('s1');
    clk.advance(DEFAULT_ABORT_GRACE_MS - 1);
    assert.equal(g.isRecent('s1'), true);
    clk.advance(2);
    assert.equal(g.isRecent('s1'), false);
  });
});

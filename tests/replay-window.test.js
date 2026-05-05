/**
 * Tests for lib/replay-window.js (rc.57).
 *
 * Pre-rc.57 the boot-replay window default was a hard-coded 3 minutes.
 * Production data (Shumabit@UMI thread :24, 2026-05-05): a long agent
 * turn was interrupted at 22 minutes by a deploy; the 3-min cutoff
 * silently dropped it. The agent's 7-hour Xero work was lost.
 *
 * rc.57 auto-derives the window from max(maxTurn) × 1.2 across the
 * bot's chats so long-turn chats stay protected.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveReplayWindowMs,
  FLOOR_MS,
  CAP_MS,
} = require('../lib/replay-window');

describe('resolveReplayWindowMs — explicit override', () => {
  test('config.bot.replayWindowMs takes precedence', () => {
    const config = {
      bot: { replayWindowMs: 5 * 60 * 1000 },
      chats: { '1': { maxTurn: 3600 } },
      defaults: { maxTurn: 7200 },
    };
    assert.equal(resolveReplayWindowMs(config), 5 * 60 * 1000);
  });

  test('explicit override allows below-floor values (operator escape hatch)', () => {
    const config = { bot: { replayWindowMs: 30 * 1000 } }; // 30s
    assert.equal(resolveReplayWindowMs(config), 30 * 1000);
  });

  test('explicit non-integer is ignored', () => {
    const config = {
      bot: { replayWindowMs: 'not a number' },
      chats: { '1': { maxTurn: 600 } },
    };
    // Falls through to auto-derive: 600 × 1.2 × 1000 = 720000ms,
    // but floor(180000) is the limit → 720000 > 180000 → 720000.
    assert.equal(resolveReplayWindowMs(config), 720000);
  });

  test('explicit zero/negative ignored, falls through to auto-derive', () => {
    const config = { bot: { replayWindowMs: 0 }, chats: { '1': { maxTurn: 600 } } };
    assert.equal(resolveReplayWindowMs(config), 720000);
  });
});

describe('resolveReplayWindowMs — auto-derive from chat maxTurn', () => {
  test('single chat — 60min maxTurn → 72min window (Shumabit@UMI case)', () => {
    const config = { chats: { '-1003369922517': { maxTurn: 3600 } } };
    // 3600 × 1.2 × 1000 = 4_320_000 ms = 72 min
    assert.equal(resolveReplayWindowMs(config), 4_320_000);
  });

  test('multiple chats — picks the max', () => {
    const config = {
      chats: {
        '1': { maxTurn: 600 },   // 10 min
        '2': { maxTurn: 1800 },  // 30 min
        '3': { maxTurn: 3600 },  // 60 min — max
      },
    };
    assert.equal(resolveReplayWindowMs(config), 4_320_000);
  });

  test('falls back to defaults.maxTurn when no chat sets it', () => {
    const config = {
      chats: { '1': {}, '2': { name: 'no-maxTurn' } },
      defaults: { maxTurn: 1800 },
    };
    // 1800 × 1.2 × 1000 = 2_160_000 ms = 36 min
    assert.equal(resolveReplayWindowMs(config), 2_160_000);
  });

  test('chat-level maxTurn beats defaults.maxTurn when higher', () => {
    const config = {
      chats: { '1': { maxTurn: 7200 } }, // 2h
      defaults: { maxTurn: 600 },
    };
    // 7200 × 1.2 × 1000 = 8_640_000 ms — but 8_640_000 > CAP (7_200_000) → CAP
    assert.equal(resolveReplayWindowMs(config), CAP_MS);
  });
});

describe('resolveReplayWindowMs — floor and cap', () => {
  test('floor: short maxTurn (60s) → still at least 3-min floor', () => {
    const config = { chats: { '1': { maxTurn: 60 } } };
    // 60 × 1.2 × 1000 = 72_000 ms < FLOOR (180_000) → FLOOR
    assert.equal(resolveReplayWindowMs(config), FLOOR_MS);
  });

  test('cap: huge maxTurn (4h) clamped to 2h', () => {
    const config = { chats: { '1': { maxTurn: 4 * 3600 } } };
    // 14400 × 1.2 × 1000 = 17_280_000 ms > CAP (7_200_000) → CAP
    assert.equal(resolveReplayWindowMs(config), CAP_MS);
  });

  test('exactly at floor boundary', () => {
    // maxTurn × 1.2 × 1000 = 180000 → maxTurn = 150s
    const config = { chats: { '1': { maxTurn: 150 } } };
    assert.equal(resolveReplayWindowMs(config), FLOOR_MS);
  });
});

describe('resolveReplayWindowMs — no maxTurn anywhere → undefined', () => {
  test('empty config returns undefined (db.js uses its own default)', () => {
    assert.equal(resolveReplayWindowMs({}), undefined);
    assert.equal(resolveReplayWindowMs(null), undefined);
    assert.equal(resolveReplayWindowMs(undefined), undefined);
  });

  test('chats with no maxTurn anywhere → undefined', () => {
    const config = { chats: { '1': { name: 'x' } } };
    assert.equal(resolveReplayWindowMs(config), undefined);
  });

  test('chats with maxTurn=0 (falsy) → undefined', () => {
    const config = {
      chats: { '1': { maxTurn: 0 } },
      defaults: { maxTurn: 0 },
    };
    assert.equal(resolveReplayWindowMs(config), undefined);
  });
});

describe('resolveReplayWindowMs — production scenario', () => {
  test('actual production config shape (rc.57 deploy day): UMI Group + Shumabit@UMI + Ivan DM', () => {
    // Reflects the prod shumabit.config at the time rc.57 was authored.
    const config = {
      bot: { /* no replayWindowMs */ },
      chats: {
        '68861949': { name: 'Ivan DM', timeout: 600 },                // no maxTurn → 0
        '-1002400136088': { name: 'UMI Group' },                      // no maxTurn → 0
        '-1003251079665': { name: 'UMI Payments' },                   // no maxTurn → 0
        '-1003316571446': { name: 'TA Beauty Space' },                // no maxTurn → 0
        '-1003369922517': { name: 'Shumabit@UMI', maxTurn: 3600 },    // 60 min
        '45270985': { name: '@akulichalex' },
        '278037926': { name: '@marsha_k' },
        '451328391': { name: '@Dina_Shumkova' },
      },
      defaults: { timeout: 300 },
    };
    // Should pick up Shumabit@UMI's 3600s and derive 72-min window.
    assert.equal(resolveReplayWindowMs(config), 4_320_000);
  });
});

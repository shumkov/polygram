'use strict';

/**
 * Tests for lib/compaction-warn.js — per-chat config resolution + warn-once
 * state for the compaction warning (0.12.0-rc.13). Default OFF: the warning
 * only fires for chats that opt in via `compactionWarnings`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCompactionWarnConfig,
  createCompactionWarnTracker,
  DEFAULT_THRESHOLD_PCT,
} = require('../lib/compaction-warn');

test('resolveCompactionWarnConfig: default OFF when unset', () => {
  assert.deepEqual(resolveCompactionWarnConfig({}), { enabled: false, thresholdPct: DEFAULT_THRESHOLD_PCT });
  assert.deepEqual(resolveCompactionWarnConfig(undefined), { enabled: false, thresholdPct: DEFAULT_THRESHOLD_PCT });
  assert.deepEqual(resolveCompactionWarnConfig({ compactionWarnings: false }), { enabled: false, thresholdPct: DEFAULT_THRESHOLD_PCT });
});

test('resolveCompactionWarnConfig: boolean true → enabled at default threshold', () => {
  assert.deepEqual(
    resolveCompactionWarnConfig({ compactionWarnings: true }),
    { enabled: true, thresholdPct: DEFAULT_THRESHOLD_PCT },
  );
});

test('resolveCompactionWarnConfig: object form with explicit enable + custom threshold', () => {
  assert.deepEqual(
    resolveCompactionWarnConfig({ compactionWarnings: { enabled: true, thresholdPct: 80 } }),
    { enabled: true, thresholdPct: 80 },
  );
});

test('resolveCompactionWarnConfig: object without enabled:true → OFF (explicit opt-in required)', () => {
  assert.equal(resolveCompactionWarnConfig({ compactionWarnings: { thresholdPct: 80 } }).enabled, false);
});

test('resolveCompactionWarnConfig: out-of-range threshold falls back to default', () => {
  assert.equal(resolveCompactionWarnConfig({ compactionWarnings: { enabled: true, thresholdPct: 0 } }).thresholdPct, DEFAULT_THRESHOLD_PCT);
  assert.equal(resolveCompactionWarnConfig({ compactionWarnings: { enabled: true, thresholdPct: 150 } }).thresholdPct, DEFAULT_THRESHOLD_PCT);
  assert.equal(resolveCompactionWarnConfig({ compactionWarnings: { enabled: true, thresholdPct: 'x' } }).thresholdPct, DEFAULT_THRESHOLD_PCT);
});

test('createCompactionWarnTracker: warns once per session until reset', () => {
  const t = createCompactionWarnTracker();
  assert.equal(t.shouldWarn('sk'), true, 'first time → warn');
  t.markWarned('sk');
  assert.equal(t.shouldWarn('sk'), false, 'already warned → suppress (no spam every turn)');

  // PostCompact / context dropped → reset so we can warn again on the next climb.
  t.reset('sk');
  assert.equal(t.shouldWarn('sk'), true, 'after reset → warn again');

  // Independent sessions don't interfere.
  t.markWarned('sk');
  assert.equal(t.shouldWarn('other'), true);
});

/**
 * Tests for lib/context-format.js — the /context reply formatter and
 * the 85%-full hint. Both pure functions extracted from polygram.js
 * so the formatting can be unit-tested.
 *
 * Pins the rc.4 percentage-scale fix (SDK reports 0-100, not 0-1).
 * Pre-rc.4 the formatter multiplied by 100 → "7700%" for a 77%
 * context. The maybeContextFullHint test below exercises the
 * threshold to keep that bug from coming back.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatContextReply,
  maybeContextFullHint,
  HINT_THRESHOLD_PCT,
} = require('../lib/context-format');

describe('formatContextReply — basics', () => {
  test('renders percentage, totals, and max', () => {
    const out = formatContextReply({
      percentage: 42,
      totalTokens: 84_000,
      maxTokens: 200_000,
    });
    assert.match(out, /42%/);
    assert.match(out, /84,000/);
    assert.match(out, /200,000/);
  });

  test('rounds fractional percentage to whole number', () => {
    const out = formatContextReply({
      percentage: 76.93,
      totalTokens: 153_860,
      maxTokens: 200_000,
    });
    // 76.93 → "77"
    assert.match(out, /\(77%\)/);
    // Should NEVER show a decimal in the headline.
    assert.doesNotMatch(out, /76\.9/);
  });

  test('includes model line when present', () => {
    const out = formatContextReply({
      percentage: 10,
      totalTokens: 20_000,
      maxTokens: 200_000,
      model: 'claude-opus-4-7',
    });
    assert.match(out, /Model: claude-opus-4-7/);
  });

  test('omits model line when missing', () => {
    const out = formatContextReply({
      percentage: 10,
      totalTokens: 20_000,
      maxTokens: 200_000,
    });
    assert.doesNotMatch(out, /Model:/);
  });

  test('handles missing usage object gracefully', () => {
    const out = formatContextReply(null);
    assert.match(out, /0 \/ 0 tokens \(0%\)/);
  });

  test('handles undefined usage object gracefully', () => {
    const out = formatContextReply(undefined);
    assert.match(out, /0 \/ 0 tokens \(0%\)/);
  });

  test('handles empty usage object — all zeros, no extras', () => {
    const out = formatContextReply({});
    assert.equal(out, '📚 Context: 0 / 0 tokens (0%)');
  });
});

describe('formatContextReply — auto-compact line', () => {
  test('shows auto-compact threshold when enabled', () => {
    const out = formatContextReply({
      percentage: 50,
      totalTokens: 100_000,
      maxTokens: 200_000,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 80,
    });
    assert.match(out, /Auto-compact at 80%/);
  });

  test('omits auto-compact line when isAutoCompactEnabled is false', () => {
    const out = formatContextReply({
      percentage: 50,
      isAutoCompactEnabled: false,
      autoCompactThreshold: 80,
    });
    assert.doesNotMatch(out, /Auto-compact/);
  });

  test('omits auto-compact line when threshold missing', () => {
    const out = formatContextReply({
      percentage: 50,
      isAutoCompactEnabled: true,
    });
    assert.doesNotMatch(out, /Auto-compact/);
  });

  test('threshold of 0 is treated as missing/disabled (truthy guard)', () => {
    // Implementation requires a positive number — 0 is degenerate.
    const out = formatContextReply({
      percentage: 50,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 0,
    });
    // 0 is falsy in the JS truthy guard: omitted. Documents current
    // behaviour; if SDK starts reporting 0 for "not yet computed" we
    // dodge a misleading "Auto-compact at 0%" line.
    assert.doesNotMatch(out, /Auto-compact at 0%/);
  });
});

describe('formatContextReply — categories', () => {
  test('renders top-3 categories by tokens', () => {
    const out = formatContextReply({
      percentage: 50,
      categories: [
        { label: 'system', tokens: 5_000 },
        { label: 'tools', tokens: 50_000 },
        { label: 'history', tokens: 30_000 },
        { label: 'memory', tokens: 1_000 },
      ],
    });
    assert.match(out, /Top categories:/);
    // Order: tools (50k) → history (30k) → system (5k) — top 3
    const categoriesIdx = out.indexOf('Top categories:');
    const sliced = out.slice(categoriesIdx);
    assert.ok(sliced.indexOf('tools') < sliced.indexOf('history'));
    assert.ok(sliced.indexOf('history') < sliced.indexOf('system'));
    // memory (1k) drops off the bottom.
    assert.doesNotMatch(out, /memory/);
  });

  test('falls back to category.name when label missing', () => {
    const out = formatContextReply({
      percentage: 10,
      categories: [{ name: 'sys-prompt', tokens: 1_000 }],
    });
    assert.match(out, /sys-prompt/);
  });

  test('uses ? when both label and name missing', () => {
    const out = formatContextReply({
      percentage: 10,
      categories: [{ tokens: 1_000 }],
    });
    assert.match(out, /\?:/);
  });

  test('filters out zero-token categories', () => {
    const out = formatContextReply({
      percentage: 10,
      categories: [
        { label: 'real', tokens: 1_000 },
        { label: 'empty', tokens: 0 },
        { label: 'negative', tokens: -1 },
      ],
    });
    assert.match(out, /real/);
    assert.doesNotMatch(out, /empty/);
    assert.doesNotMatch(out, /negative/);
  });

  test('filters out NaN/non-finite category tokens', () => {
    const out = formatContextReply({
      percentage: 10,
      categories: [
        { label: 'ok', tokens: 100 },
        { label: 'broken', tokens: NaN },
        { label: 'inf', tokens: Infinity },
      ],
    });
    assert.match(out, /ok/);
    assert.doesNotMatch(out, /broken/);
    assert.doesNotMatch(out, /inf/);
  });

  test('omits Top categories: header when no positive-token rows', () => {
    const out = formatContextReply({
      percentage: 10,
      categories: [{ label: 'empty', tokens: 0 }],
    });
    assert.doesNotMatch(out, /Top categories/);
  });

  test('non-array categories are ignored', () => {
    const out = formatContextReply({
      percentage: 10,
      categories: 'not-an-array',
    });
    assert.doesNotMatch(out, /Top categories/);
  });

  test('formats large category numbers with commas', () => {
    const out = formatContextReply({
      percentage: 80,
      categories: [{ label: 'big', tokens: 1_234_567 }],
    });
    assert.match(out, /1,234,567/);
  });
});

describe('maybeContextFullHint — threshold behaviour', () => {
  test('returns null below threshold', () => {
    assert.equal(maybeContextFullHint({ percentage: 84 }), null);
    assert.equal(maybeContextFullHint({ percentage: 50 }), null);
    assert.equal(maybeContextFullHint({ percentage: 0 }), null);
  });

  test('returns hint exactly at threshold', () => {
    const hint = maybeContextFullHint({ percentage: HINT_THRESHOLD_PCT });
    assert.ok(hint);
    assert.match(hint, /85% full/);
  });

  test('returns hint above threshold', () => {
    const hint = maybeContextFullHint({ percentage: 92 });
    assert.ok(hint);
    assert.match(hint, /92% full/);
  });

  test('hint includes all three user options', () => {
    const hint = maybeContextFullHint({ percentage: 90 });
    assert.match(hint, /\/new/);
    assert.match(hint, /\/compact/);
    assert.match(hint, /Keep chatting/);
  });

  test('hint does NOT imply a "preserve" keyword (rc.23 fix)', () => {
    // Pre-rc.23 the hint said "/compact preserve <text>" — leaking a
    // non-existent keyword. Catch any regression.
    const hint = maybeContextFullHint({ percentage: 90 });
    assert.doesNotMatch(hint, /\/compact preserve\b/i);
    assert.doesNotMatch(hint, /preserve keyword/i);
  });

  test('null usage returns null (treated as 0%)', () => {
    assert.equal(maybeContextFullHint(null), null);
  });

  test('undefined usage returns null', () => {
    assert.equal(maybeContextFullHint(undefined), null);
  });

  test('missing percentage returns null', () => {
    assert.equal(maybeContextFullHint({ totalTokens: 100 }), null);
  });

  test('rc.4 anti-regression: percentage is 0-100 scale, not 0-1', () => {
    // If somebody re-introduces the bug where 0.85 is treated as 85%,
    // this test fails: 0.85 < 85 means below threshold.
    assert.equal(maybeContextFullHint({ percentage: 0.85 }), null);
    // And a value of 85 (the actual scale) does fire.
    assert.ok(maybeContextFullHint({ percentage: 85 }));
  });
});

describe('HINT_THRESHOLD_PCT', () => {
  test('exported constant is 85', () => {
    assert.equal(HINT_THRESHOLD_PCT, 85);
  });
});

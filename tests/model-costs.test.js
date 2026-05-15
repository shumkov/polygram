'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeCostUsd, MODEL_COSTS } = require('../lib/model-costs');

describe('computeCostUsd', () => {
  test('returns 0 for missing usage', () => {
    assert.equal(computeCostUsd(null, 'claude-sonnet-4-6'), 0);
    assert.equal(computeCostUsd(undefined, 'claude-sonnet-4-6'), 0);
  });

  test('haiku turn: 1M input + 1M output → input.rate + output.rate', () => {
    const cost = computeCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }, 'claude-haiku-4-5');
    // Haiku: input=$0.80/M, output=$4/M → $4.80
    assert.ok(Math.abs(cost - 4.80) < 0.001, `expected ~4.80, got ${cost}`);
  });

  test('sonnet turn: cache-heavy', () => {
    const cost = computeCostUsd({
      inputTokens: 10,
      outputTokens: 200,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 5_000,
    }, 'claude-sonnet-4-6');
    // Sonnet: input=$3/M, output=$15/M, cacheRead=$0.30/M, cacheCreation=$3.75/M
    // = 10*3/1e6 + 200*15/1e6 + 100000*0.30/1e6 + 5000*3.75/1e6
    // = 0.00003 + 0.003 + 0.03 + 0.01875 = 0.05178
    const expected = 0.00003 + 0.003 + 0.03 + 0.01875;
    assert.ok(Math.abs(cost - expected) < 1e-6, `expected ${expected}, got ${cost}`);
  });

  test('strips trailing -YYYYMMDD date suffix when matching model name', () => {
    const cost1 = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      'claude-haiku-4-5-20251001',
    );
    const cost2 = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      'claude-haiku-4-5',
    );
    assert.equal(cost1, cost2);
  });

  test('falls back to default rates for unknown model', () => {
    const cost = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      'claude-unknown-future-9',
    );
    assert.equal(cost, MODEL_COSTS.default.input);
  });

  test('opus is the most expensive', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const opus = computeCostUsd(usage, 'claude-opus-4-7');
    const sonnet = computeCostUsd(usage, 'claude-sonnet-4-6');
    const haiku = computeCostUsd(usage, 'claude-haiku-4-5');
    assert.ok(opus > sonnet, `opus ${opus} should be > sonnet ${sonnet}`);
    assert.ok(sonnet > haiku, `sonnet ${sonnet} should be > haiku ${haiku}`);
  });
});

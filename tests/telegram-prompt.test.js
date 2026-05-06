/**
 * Tests for lib/telegram-prompt.js — the polygram-side display hint
 * appended to every chat's system prompt so agents know Telegram's
 * <pre> render width.
 *
 * Keep this hint in the polygram layer, NOT inside agent prompts —
 * the test suite enforces that:
 *   - the hint is a single canonical string,
 *   - appending preserves the existing systemPrompt shape,
 *   - empty/null inputs route to the default-preset shape so agents
 *     without their own systemPrompt still get the hint.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  POLYGRAM_DISPLAY_HINT,
  TELEGRAM_TABLE_WIDTH_BUDGET,
  appendDisplayHint,
} = require('../lib/telegram-prompt');

describe('POLYGRAM_DISPLAY_HINT — content', () => {
  test('mentions the table width budget by number', () => {
    assert.match(POLYGRAM_DISPLAY_HINT, new RegExp(String(TELEGRAM_TABLE_WIDTH_BUDGET)));
  });

  test('mentions Telegram', () => {
    assert.match(POLYGRAM_DISPLAY_HINT, /Telegram/);
  });

  test('uses imperative MUST NOT for the table rule (rc.53)', () => {
    // rc.53: previous wording ("drop the table", "switch to row blocks")
    // was descriptive guidance. Sonnet ignored it on long agent prompts
    // (umi-assistant 7.7k tokens — display hint at the tail). The new
    // rule is imperative so the model treats it as binding, not advice.
    assert.match(POLYGRAM_DISPLAY_HINT, /MUST NOT/);
  });

  test('describes the row-block fallback with bold headline', () => {
    assert.match(POLYGRAM_DISPLAY_HINT, /row blocks/i);
    assert.match(POLYGRAM_DISPLAY_HINT, /\*\*[^*]+\*\*/);   // bold headline example
  });

  test('addresses the "user is on desktop" loophole', () => {
    // rc.53: explicitly close the rationalization vector — model can't
    // think "this user is on desktop today, table is fine" because
    // tables fail on phone regardless and surface affinity flips.
    assert.match(POLYGRAM_DISPLAY_HINT, /desktop/i);
  });

  test('TELEGRAM_TABLE_WIDTH_BUDGET is a positive integer', () => {
    assert.ok(Number.isInteger(TELEGRAM_TABLE_WIDTH_BUDGET));
    assert.ok(TELEGRAM_TABLE_WIDTH_BUDGET > 0);
  });

  test('budget is in a reasonable range for Telegram mobile', () => {
    // Anything below 24 is too aggressive; anything above 60 lets
    // mobile users see broken tables. Mid-range guards both ends.
    assert.ok(TELEGRAM_TABLE_WIDTH_BUDGET >= 24);
    assert.ok(TELEGRAM_TABLE_WIDTH_BUDGET <= 60);
  });
});

describe('appendDisplayHint — undefined/null systemPrompt', () => {
  test('null → preset object with hint as append', () => {
    const r = appendDisplayHint(null);
    assert.equal(r.type, 'preset');
    assert.equal(r.preset, 'claude_code');
    assert.equal(r.append, POLYGRAM_DISPLAY_HINT);
  });

  test('undefined → preset object with hint as append', () => {
    const r = appendDisplayHint(undefined);
    assert.equal(r.type, 'preset');
    assert.equal(r.preset, 'claude_code');
    assert.equal(r.append, POLYGRAM_DISPLAY_HINT);
  });
});

describe('appendDisplayHint — string systemPrompt', () => {
  test('string → string + double-newline + hint', () => {
    const r = appendDisplayHint('You are a finance bot.');
    assert.equal(typeof r, 'string');
    assert.equal(r, `You are a finance bot.\n\n${POLYGRAM_DISPLAY_HINT}`);
  });

  test('string ending with newline still gets blank-line separator', () => {
    const r = appendDisplayHint('Existing prompt.\n');
    // Adds \n\n regardless — model tolerates the extra blank line.
    assert.match(r, /Existing prompt\.\n\n\n## Telegram/);
  });

  test('empty string treated as a string, not as null', () => {
    const r = appendDisplayHint('');
    assert.equal(typeof r, 'string');
    assert.equal(r, `\n\n${POLYGRAM_DISPLAY_HINT}`);
  });

  test('does not mutate the input string (strings are immutable but verifies semantics)', () => {
    const input = 'Original.';
    const before = input;
    appendDisplayHint(input);
    assert.equal(input, before);
  });
});

describe('appendDisplayHint — preset object systemPrompt', () => {
  test('preset with no append → hint becomes append', () => {
    const r = appendDisplayHint({ type: 'preset', preset: 'claude_code' });
    assert.equal(r.type, 'preset');
    assert.equal(r.preset, 'claude_code');
    assert.equal(r.append, POLYGRAM_DISPLAY_HINT);
  });

  test('preset with existing append → hint concatenated', () => {
    const r = appendDisplayHint({
      type: 'preset',
      preset: 'claude_code',
      append: 'Always be brief.',
    });
    assert.equal(r.append, `Always be brief.\n\n${POLYGRAM_DISPLAY_HINT}`);
  });

  test('preset with extra fields is preserved (excludeDynamicSections)', () => {
    const r = appendDisplayHint({
      type: 'preset',
      preset: 'claude_code',
      excludeDynamicSections: true,
    });
    assert.equal(r.excludeDynamicSections, true);
    assert.equal(r.preset, 'claude_code');
    assert.equal(r.append, POLYGRAM_DISPLAY_HINT);
  });

  test('preset with empty-string append is treated as no append', () => {
    const r = appendDisplayHint({
      type: 'preset',
      preset: 'claude_code',
      append: '',
    });
    assert.equal(r.append, POLYGRAM_DISPLAY_HINT);
  });

  test('does NOT mutate the input object', () => {
    const input = { type: 'preset', preset: 'claude_code', append: 'X' };
    const snapshot = JSON.stringify(input);
    appendDisplayHint(input);
    assert.equal(JSON.stringify(input), snapshot);
  });

  test('non-preset objects with type are returned unchanged', () => {
    // Defensive: only `type: 'preset'` is supported. Anything else
    // is unrecognised, returned as-is to avoid corrupting it.
    const input = { type: 'something-else', foo: 'bar' };
    const r = appendDisplayHint(input);
    assert.equal(r, input);
  });
});

describe('appendDisplayHint — unknown shapes', () => {
  test('array systemPrompt is returned unchanged', () => {
    const input = ['part-one', 'part-two'];
    const r = appendDisplayHint(input);
    assert.equal(r, input);
  });

  test('numeric systemPrompt is returned unchanged', () => {
    const r = appendDisplayHint(42);
    assert.equal(r, 42);
  });
});

describe('appendDisplayHint — custom hint override', () => {
  test('uses the hint argument when provided', () => {
    const r = appendDisplayHint('Base.', 'CUSTOM');
    assert.equal(r, 'Base.\n\nCUSTOM');
  });

  test('empty-string hint short-circuits and returns input unchanged', () => {
    // Useful for tests that want to disable the hint without rewiring
    // the call site.
    const r = appendDisplayHint('Base.', '');
    assert.equal(r, 'Base.');
  });

  test('null hint returns input unchanged', () => {
    const r = appendDisplayHint('Base.', null);
    assert.equal(r, 'Base.');
  });
});


describe('integration with agent-loader composeSdkOptions', () => {
  // Smoke test: the hint format must survive through the actual
  // option-composer path. If composeSdkOptions starts re-shaping
  // systemPrompt, this catches it before deploy.
  const { composeSdkOptions } = require('../lib/agent-loader');

  test('appending after composeSdkOptions returns valid SdkOptions.systemPrompt', () => {
    const composed = composeSdkOptions(
      {},
      { systemPrompt: 'You are a finance bot.', skills: [], mcpServers: {}, raw: {} },
      {},
    );
    const final = appendDisplayHint(composed.systemPrompt);
    // String shape preserved → "X\n\n<hint>"
    assert.match(final, /^You are a finance bot\.\n\n## Telegram/);
  });

  test('chat with no agent → composed systemPrompt is undefined → preset object', () => {
    const composed = composeSdkOptions({}, null, {});
    const final = appendDisplayHint(composed.systemPrompt);
    assert.equal(final.type, 'preset');
    assert.equal(final.preset, 'claude_code');
    assert.equal(final.append, POLYGRAM_DISPLAY_HINT);
  });
});

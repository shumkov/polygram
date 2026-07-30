/**
 * Tests for lib/telegram/display-hint.js — the polygram-side display hint
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
  buildPolygramDisplayHint,
  INLINE_MEDIA_PARAGRAPHS,
  appendDisplayHint,
} = require('../lib/telegram/display-hint');

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

  // rc.37 hardening (2026-05-22): the model leaked the CLI-context
  // canned string `No response requested.` as an actual Telegram
  // reply on ambiguous short user messages ("okay", "ok") — seen
  // twice in the shumorobot Music topic. The rc.0 hint never named
  // it, so the model treated the phrase as legitimate output when its
  // reasoning short-circuited to "no response needed". Mirror the
  // table rule's discipline: explicit imperative + verbatim phrase
  // + a positive instruction for the trigger case.
  test('forbids `No response requested.` verbatim (rc.37 canned-string leak)', () => {
    assert.match(POLYGRAM_DISPLAY_HINT, /No response requested\./);
  });

  test('forbids `No response needed.` verbatim (close adjacent vector)', () => {
    assert.match(POLYGRAM_DISPLAY_HINT, /No response needed\./);
  });

  test('uses imperative NEVER (not descriptive guidance) for canned-strings rule', () => {
    // Same lesson as the table rule (rc.53) — descriptive wording got
    // ignored on long agent prompts. NEVER is binding to the model.
    assert.match(POLYGRAM_DISPLAY_HINT, /NEVER emit/);
  });

  test('gives the positive instruction for ambiguous short messages', () => {
    // The rule must say what to do INSTEAD — otherwise the model has
    // a forbidden output and no replacement, and may default to
    // something equally bad.
    assert.match(POLYGRAM_DISPLAY_HINT, /clarifying question/i);
    assert.match(POLYGRAM_DISPLAY_HINT, /okay|got it|ack/i);
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

describe('rich media display hint', () => {
  test('opting into inline media restores the full media guidance', () => {
    // The streamer resolves and uploads local media, so chats delivered that
    // way must keep learning the syntax — removing it fleet-wide would take
    // away a capability that still works there.
    const richHint = buildPolygramDisplayHint(true, { inlineMedia: true });
    assert.match(richHint, /!\[caption\]\(\/abs\/path/i);
    assert.match(richHint, /\.jpe?g/i);
    assert.match(richHint, /\.png/i);
    assert.match(richHint, /\.webp/i);
    assert.match(richHint, /\.mp4/i);
    assert.match(richHint, /\.gif/i);
    assert.match(richHint, /photo/i);
    assert.match(richHint, /video/i);
    assert.match(richHint, /animation/i);
    assert.match(richHint, /<tg-collage>/i);
    assert.match(richHint, /<tg-slideshow>/i);
    assert.match(richHint, /at least a sentence/i);
  });

  test('warns that media never survives a streamed message (own reply instead)', () => {
    const richHint = buildPolygramDisplayHint(true, { inlineMedia: true });
    assert.match(richHint, /media.{0,120}(stream|live preview)|(stream|live preview).{0,120}media/is,
      'ties media to the streaming limitation');
    assert.match(richHint, /own\s+(separate\s+)?reply|separate\s+(reply|message)/i,
      'tells the agent to deliver media as its own reply');
    assert.match(richHint, /caption/i,
      'names the degradation so the consequence is concrete');
  });

  test('the two variants differ ONLY by the media guidance', () => {
    // Guards against the gate accidentally taking structural guidance with
    // it: the reply path renders every non-media construct just as well.
    const withMedia = buildPolygramDisplayHint(true, { inlineMedia: true });
    const withoutMedia = buildPolygramDisplayHint(true);
    // Subtract the paragraphs the gate adds, rather than pattern-matching for
    // them: a newly added one would otherwise slip past the filter and this
    // guard would fail for the wrong reason.
    const added = INLINE_MEDIA_PARAGRAPHS.filter(l => l.trim());
    assert.ok(added.length >= 2, 'the gate adds real guidance');
    const stripped = withMedia
      .split('\n')
      .filter(l => !added.includes(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
    assert.equal(stripped, withoutMedia.replace(/\n{3,}/g, '\n\n'));
  });

  test('rich mode does not teach media the reply path cannot deliver', () => {
    // The hint is the exposure throttle. Most agent output now goes through
    // the reply tool, which renders rich blocks on media-stripped text — an
    // image reaches the user as its caption and nothing else. Teaching the
    // syntax while that is true makes the agent author constructs that
    // silently vanish, which is exactly the mismatch this hint exists to
    // prevent.
    // Asserted as a property, not as three strings from the paragraph that
    // was deleted: a reworded re-add ("![alt](/abs/path)", ".jpg only") has
    // to fail this too, or the guard only protects against a verbatim revert.
    const richHint = buildPolygramDisplayHint(true);
    assert.doesNotMatch(richHint, /!\[[^\]]*\]\(/, 'no image markdown of any form');
    assert.doesNotMatch(richHint, /<tg-(collage|slideshow)/i, 'no media wrapper tags');
    assert.doesNotMatch(richHint, /\.(jpe?g|png|webp|mp4|gif)\b/i, 'no media file extensions');
    assert.doesNotMatch(richHint, /\]\(\/(abs|Users|home|tmp)/, 'no absolute-path example');
  });

  test('rich mode still teaches every construct that does render', () => {
    const richHint = buildPolygramDisplayHint(true);
    assert.match(richHint, /## Ready to apply/, 'headings');
    assert.match(richHint, /- \[ \]/, 'task lists');
    assert.match(richHint, /<details><summary>/i, 'collapsible detail');
    assert.match(richHint, /blockquote/i);
    assert.match(richHint, /divider/i);
    assert.match(richHint, /markdown table/i);
  });

  test('plain mode remains media-free and equals the legacy default export', () => {
    const plainHint = buildPolygramDisplayHint(false);
    assert.equal(plainHint, POLYGRAM_DISPLAY_HINT);
    assert.doesNotMatch(plainHint, /!\[caption\]\(/i);
    assert.doesNotMatch(plainHint, /\.mp4|\.gif/i);
    assert.doesNotMatch(plainHint, /<tg-collage>|<tg-slideshow>/i);
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
  const { composeSdkOptions } = require('../lib/agents/loader');

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

test('the media guidance warns against sending the same file twice', () => {
  // Inline media and files: are independent delivery paths — a path in both
  // is uploaded by each, and the user sees the image twice. Before media
  // rendered here the inline copy was stripped, so the habit was harmless.
  const hint = buildPolygramDisplayHint(true, { inlineMedia: true });
  assert.match(hint, /not both/i);
  assert.match(hint, /already delivered/i);
  assert.doesNotMatch(buildPolygramDisplayHint(true), /not both/i,
    'it belongs to the media guidance, not the base rich section');
});

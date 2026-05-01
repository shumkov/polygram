/**
 * Tests for lib/parse-response.js — Claude's outbound response parser.
 *
 * Covers the three legitimate output shapes (sticker, reaction, text)
 * plus the 0.7.5 regression fix where Claude mimicked the literal
 * `[sticker:NAME]` placeholder it saw in transcript history.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseResponse, STICKER_TAG_RE, STICKER_TAG_INLINE_RE } = require('../lib/parse-response');

const stickerMap = {
  working: 'CAACAgIAAxkBAAEworking',
  thumbsup: 'CAACAgIAAxkBAAEthumbsup',
};
const emojiToSticker = {
  '😄': 'CAACAgIAAxkBAAEsmile',
  '⚡': 'CAACAgIAAxkBAAEzap',
};
const deps = { stickerMap, emojiToSticker };

describe('parseResponse — text path', () => {
  test('plain text returns text intact', () => {
    const r = parseResponse('Hello, this is a regular reply.', deps);
    assert.equal(r.text, 'Hello, this is a regular reply.');
    assert.equal(r.sticker, null);
    assert.equal(r.reaction, null);
  });

  test('multiline text is preserved (only trimmed at edges)', () => {
    const r = parseResponse('  line one\nline two  ', deps);
    assert.equal(r.text, 'line one\nline two');
  });

  test('empty / whitespace-only returns empty text', () => {
    const r = parseResponse('   ', deps);
    assert.equal(r.text, '');
    assert.equal(r.sticker, null);
    assert.equal(r.reaction, null);
  });

  test('null/undefined input does not crash', () => {
    assert.doesNotThrow(() => parseResponse(null, deps));
    assert.doesNotThrow(() => parseResponse(undefined, deps));
  });
});

describe('parseResponse — single-emoji shortcuts', () => {
  test('mapped emoji becomes a sticker', () => {
    const r = parseResponse('😄', deps);
    assert.equal(r.sticker, 'CAACAgIAAxkBAAEsmile');
    assert.equal(r.stickerLabel, '😄');
    assert.equal(r.text, '');
  });

  test('unmapped emoji becomes a reaction', () => {
    const r = parseResponse('🔥', deps);
    assert.equal(r.reaction, '🔥');
    assert.equal(r.sticker, null);
    assert.equal(r.text, '');
  });

  test('multi-emoji string is treated as text', () => {
    const r = parseResponse('🔥🔥', deps);
    assert.equal(r.text, '🔥🔥');
    assert.equal(r.sticker, null);
    assert.equal(r.reaction, null);
  });

  test('emoji with surrounding whitespace still triggers shortcut', () => {
    const r = parseResponse('  😄  ', deps);
    assert.equal(r.sticker, 'CAACAgIAAxkBAAEsmile');
  });
});

describe('parseResponse — [sticker:NAME] regression (0.7.5)', () => {
  // The bug: Claude saw `[sticker:working]` in past assistant rows
  // (synthesised by lib/telegram.js deriveOutboundText for sendSticker
  // calls) and started emitting the format literally. parseResponse used
  // to drop it into the chunked-text path and the placeholder showed up
  // verbatim in the chat.
  test('exact tag resolves to sticker via stickerMap', () => {
    const r = parseResponse('[sticker:working]', deps);
    assert.equal(r.sticker, 'CAACAgIAAxkBAAEworking');
    assert.equal(r.stickerLabel, 'working');
    assert.equal(r.text, '');
    assert.equal(r.reaction, null);
  });

  test('tag with leading/trailing whitespace still resolves', () => {
    const r = parseResponse('  [sticker:thumbsup]\n', deps);
    assert.equal(r.sticker, 'CAACAgIAAxkBAAEthumbsup');
    assert.equal(r.stickerLabel, 'thumbsup');
  });

  test('unknown sticker name falls through to text path', () => {
    // Don't silently swallow a genuine "[sticker:foo]" message when foo
    // isn't a real sticker — the user typed something that LOOKS like
    // a tag but might be a joke or stale name.
    const r = parseResponse('[sticker:does-not-exist]', deps);
    assert.equal(r.text, '[sticker:does-not-exist]');
    assert.equal(r.sticker, null);
    assert.equal(r.reaction, null);
  });

  test('case-sensitive: "Sticker" prefix does not match', () => {
    const r = parseResponse('[Sticker:working]', deps);
    assert.equal(r.text, '[Sticker:working]');
    assert.equal(r.sticker, null);
    assert.deepEqual(r.stickers, []);
  });

  test('NAME charset is restricted (no spaces, slashes, etc)', () => {
    const r = parseResponse('[sticker:hello world]', deps);
    assert.equal(r.text, '[sticker:hello world]');
    assert.equal(r.sticker, null);
    assert.deepEqual(r.stickers, []);
  });

  test('NAME allows hyphens and underscores', () => {
    const map = { 'multi-word_name': 'CAACAgIAAxkBmulti' };
    const r = parseResponse('[sticker:multi-word_name]', { stickerMap: map, emojiToSticker: {} });
    assert.equal(r.sticker, 'CAACAgIAAxkBmulti');
    assert.equal(r.stickerLabel, 'multi-word_name');
  });

  test('regex export is available for callers that need it', () => {
    assert.ok(STICKER_TAG_RE instanceof RegExp);
    assert.ok(STICKER_TAG_RE.test('[sticker:abc]'));
    assert.ok(!STICKER_TAG_RE.test('[sticker:]')); // empty NAME rejected
  });
});

describe('parseResponse — inline sticker extraction (rc.39)', () => {
  // The 0.7.5 fix only handled solo `[sticker:NAME]` (full text = tag).
  // rc.39 extends this: Claude evolved to use the marker INLINE within
  // longer replies (e.g. "Done! [sticker:pumped]\n\nStripe Mar 2026
  // created ✅\n…"). We extract every recognised inline tag, strip
  // it from the text, and surface them in `stickers[]` so polygram
  // can send them as separate sendSticker calls after the text.
  // Production trigger: Stripe-invoices-Mar-2026 turn 2026-05-01 16:21
  // — bot emitted "Done! [sticker:pumped]" prefix and the tag rendered
  // verbatim because the parser fell through to the text path.

  test('single inline tag is extracted, text cleaned, sticker pushed', () => {
    const r = parseResponse('Done! [sticker:thumbsup]\n\nStripe created ✅', deps);
    assert.equal(r.sticker, null, 'solo-sticker field stays null for inline case');
    assert.equal(r.reaction, null);
    assert.equal(r.text, 'Done!\n\nStripe created ✅');
    assert.deepEqual(r.stickers, [{ fileId: 'CAACAgIAAxkBAAEthumbsup', name: 'thumbsup' }]);
  });

  test('multiple inline tags extracted in order', () => {
    const r = parseResponse(
      'Done! [sticker:thumbsup]\n\nMid-text [sticker:working] continues.\n\nLast [sticker:thumbsup]',
      deps,
    );
    assert.equal(r.text, 'Done!\n\nMid-text  continues.\n\nLast');
    assert.equal(r.stickers.length, 3);
    assert.deepEqual(r.stickers.map((s) => s.name), ['thumbsup', 'working', 'thumbsup']);
  });

  test('unknown inline NAME stays verbatim, known one extracted', () => {
    // Mixed: one recognised, one not.
    const r = parseResponse(
      'Status [sticker:working]: deploy complete [sticker:nonexistent].',
      deps,
    );
    assert.equal(r.text, 'Status : deploy complete [sticker:nonexistent].');
    assert.deepEqual(r.stickers, [{ fileId: 'CAACAgIAAxkBAAEworking', name: 'working' }]);
  });

  test('whitespace tidy: trailing spaces on lines stripped, 3+ blank lines collapsed', () => {
    // Tag at end-of-line + alone-on-its-own-line stress test.
    const r = parseResponse(
      'Top line.\n[sticker:working]\n\n\nBottom line.',
      deps,
    );
    assert.equal(r.text, 'Top line.\n\n\nBottom line.'.replace(/\n{3,}/g, '\n\n'));
    // The expected text is 'Top line.\n\nBottom line.' after tidy.
    assert.equal(r.text, 'Top line.\n\nBottom line.');
    assert.deepEqual(r.stickers.map((s) => s.name), ['working']);
  });

  test('intra-line spacing and code blocks are preserved', () => {
    const r = parseResponse(
      'Run:\n```\n  ls /tmp\n  pwd\n```\n[sticker:working]',
      deps,
    );
    // Code-block content (with its leading spaces) untouched.
    assert.equal(r.text, 'Run:\n```\n  ls /tmp\n  pwd\n```');
    assert.deepEqual(r.stickers.map((s) => s.name), ['working']);
  });

  test('inline tag with quotes is still extracted (rc.39 — 0.7.5 said this falls through)', () => {
    // 0.7.5 documented "tag with extra characters falls through" because
    // the solo-form regex required `^\s*…\s*$`. rc.39's inline-form
    // regex is unanchored, so quotes around the tag don't block
    // extraction. The quotes themselves stay in the text.
    const r = parseResponse('"[sticker:working]"', deps);
    assert.equal(r.text, '""');
    assert.deepEqual(r.stickers, [{ fileId: 'CAACAgIAAxkBAAEworking', name: 'working' }]);
  });

  test('inline tag in middle of paragraph keeps the surrounding sentence intact', () => {
    const r = parseResponse('The deploy [sticker:working] succeeded.', deps);
    // Tag becomes empty string. Surrounding spaces stay.
    assert.equal(r.text, 'The deploy  succeeded.');
    assert.deepEqual(r.stickers.map((s) => s.name), ['working']);
  });

  test('solo-tag path STILL takes the sticker path (not stickers[])', () => {
    // Backward-compat with 0.7.5: when the entire reply is just a tag,
    // it goes through `parsed.sticker`, not `parsed.stickers[]`.
    // polygram has separate code paths for the two — don't break
    // either.
    const r = parseResponse('[sticker:working]', deps);
    assert.equal(r.sticker, 'CAACAgIAAxkBAAEworking');
    assert.equal(r.stickerLabel, 'working');
    assert.equal(r.text, '');
    assert.deepEqual(r.stickers, []);
  });

  test('repeated same-name inline tags emit one entry per occurrence', () => {
    // Each `[sticker:working]` produces a sendSticker call. The model
    // might intentionally repeat a sticker for emphasis.
    const r = parseResponse(
      '[sticker:working] [sticker:working] [sticker:working]',
      deps,
    );
    // After stripping all three, only spaces remain → trim → ''
    // (not the solo-tag path — that requires the entire trimmed text
    // be a single tag, which 3 isn't).
    assert.equal(r.text, '');
    assert.equal(r.stickers.length, 3);
    assert.equal(r.stickers.every((s) => s.name === 'working'), true);
  });

  test('pathological: tag at very start with no text strips cleanly', () => {
    const r = parseResponse('[sticker:thumbsup] Hello!', deps);
    assert.equal(r.text, 'Hello!');
    assert.deepEqual(r.stickers.map((s) => s.name), ['thumbsup']);
  });

  test('tag at very end strips cleanly with trailing-space tidy', () => {
    const r = parseResponse('Hello! [sticker:thumbsup]', deps);
    assert.equal(r.text, 'Hello!');
    assert.deepEqual(r.stickers.map((s) => s.name), ['thumbsup']);
  });

  test('STICKER_TAG_INLINE_RE is exported and global', () => {
    assert.ok(STICKER_TAG_INLINE_RE instanceof RegExp);
    assert.ok(STICKER_TAG_INLINE_RE.global);
    // Make sure it matches anywhere in the string, not just anchored.
    const text = 'foo [sticker:abc] bar [sticker:def] baz';
    const matches = [...text.matchAll(STICKER_TAG_INLINE_RE)].map((m) => m[1]);
    assert.deepEqual(matches, ['abc', 'def']);
  });

  test('production regression case: Stripe-Mar-2026 reproduction', () => {
    // Verbatim shape from the 2026-05-01 16:21:12 UMI Group / Ivan DM
    // reply that triggered the rc.39 fix. Bot wanted to show
    // [sticker:pumped] inline as enthusiastic ack before the bullet
    // list. Pre-rc.39 this rendered the tag as literal text in the
    // bubble.
    const r = parseResponse(
      'Done! [sticker:pumped]\n\n**Stripe Mar 2026 (19ZTNEYU-2026-03) created** ✅\n\n• ฿2,221.39 + VAT ฿155.50',
      { stickerMap: { pumped: 'CAACAgIAAxkBAAEpumped' }, emojiToSticker: {} },
    );
    assert.equal(
      r.text,
      'Done!\n\n**Stripe Mar 2026 (19ZTNEYU-2026-03) created** ✅\n\n• ฿2,221.39 + VAT ฿155.50',
    );
    assert.equal(r.sticker, null, 'inline path: sticker field stays null');
    assert.deepEqual(r.stickers, [{ fileId: 'CAACAgIAAxkBAAEpumped', name: 'pumped' }]);
  });
});

describe('parseResponse — defensive defaults', () => {
  test('works with no deps (no stickers, no emoji map)', () => {
    const r = parseResponse('hi', {});
    assert.equal(r.text, 'hi');
  });

  test('emoji-only with empty emojiToSticker still becomes a reaction', () => {
    const r = parseResponse('🔥', {});
    assert.equal(r.reaction, '🔥');
  });

  test('[sticker:foo] with empty stickerMap falls through to text', () => {
    const r = parseResponse('[sticker:foo]', {});
    assert.equal(r.text, '[sticker:foo]');
    assert.equal(r.sticker, null);
  });
});

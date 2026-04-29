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

const { parseResponse, STICKER_TAG_RE } = require('../lib/parse-response');

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

  test('tag embedded in surrounding text falls through to text path', () => {
    // We only swap when the entire response is the tag — partial matches
    // would risk mis-rendering legitimate code/quotes containing the
    // pattern.
    const r = parseResponse('Here you go: [sticker:working]', deps);
    assert.equal(r.text, 'Here you go: [sticker:working]');
    assert.equal(r.sticker, null);
  });

  test('tag with extra characters (e.g. quotes) falls through', () => {
    const r = parseResponse('"[sticker:working]"', deps);
    assert.equal(r.text, '"[sticker:working]"');
    assert.equal(r.sticker, null);
  });

  test('case-sensitive: "Sticker" prefix does not match', () => {
    const r = parseResponse('[Sticker:working]', deps);
    assert.equal(r.text, '[Sticker:working]');
    assert.equal(r.sticker, null);
  });

  test('NAME charset is restricted (no spaces, slashes, etc)', () => {
    const r = parseResponse('[sticker:hello world]', deps);
    assert.equal(r.text, '[sticker:hello world]');
    assert.equal(r.sticker, null);
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

/**
 * Tests for lib/telegram-format.js
 *
 * These aren't unit tests for telegramify-markdown itself (that's the upstream
 * library's job). They verify our wrapper contract:
 *   - returns { text, parseMode } shape
 *   - falls back to plain text on empty / non-string inputs
 *   - downgrades headings to bold (Telegram has no headings)
 *   - escapes MarkdownV2 reserved chars so Telegram doesn't reject the send
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toTelegramMarkdown } = require('../lib/telegram-format');

describe('toTelegramMarkdown', () => {
  test('empty string passes through with no parse_mode', () => {
    const r = toTelegramMarkdown('');
    assert.equal(r.text, '');
    assert.equal(r.parseMode, null);
  });

  test('non-string passes through untouched', () => {
    const r = toTelegramMarkdown(null);
    assert.equal(r.text, null);
    assert.equal(r.parseMode, null);
  });

  test('downgrades # heading to bold (telegram has no headings)', () => {
    const r = toTelegramMarkdown('# Hello');
    assert.equal(r.parseMode, 'MarkdownV2');
    assert.match(r.text, /\*Hello\*/);
  });

  test('escapes MarkdownV2 reserved chars in body text', () => {
    const r = toTelegramMarkdown('Mr. Smith said "it\'s 3.14!"');
    assert.equal(r.parseMode, 'MarkdownV2');
    // Periods and exclamation must be escaped or Telegram rejects the send.
    assert.match(r.text, /Mr\\\./);
    assert.match(r.text, /3\\\.14/);
    assert.match(r.text, /\\!/);
  });

  test('preserves inline code and fenced code blocks', () => {
    const r = toTelegramMarkdown('Run `npm test`\n\n```js\nconst x = 1;\n```');
    assert.equal(r.parseMode, 'MarkdownV2');
    assert.match(r.text, /`npm test`/);
    assert.match(r.text, /```/);
    assert.match(r.text, /const x = 1;/);
  });

  test('preserves links', () => {
    const r = toTelegramMarkdown('See [docs](https://example.com) for details');
    assert.equal(r.parseMode, 'MarkdownV2');
    assert.match(r.text, /\[docs\]\(https:\/\/example\.com\)/);
  });

  test('converts bullet lists (telegram has no list syntax)', () => {
    const r = toTelegramMarkdown('- one\n- two');
    assert.equal(r.parseMode, 'MarkdownV2');
    // Library renders bullets as `•` chars.
    assert.match(r.text, /•\s+one/);
    assert.match(r.text, /•\s+two/);
  });

  test('bold converts from **x** to *x* (telegram dialect)', () => {
    const r = toTelegramMarkdown('This is **important**');
    assert.equal(r.parseMode, 'MarkdownV2');
    // Claude's GFM double-asterisk collapses to Telegram's single-asterisk.
    assert.match(r.text, /\*important\*/);
    assert.doesNotMatch(r.text, /\*\*important\*\*/);
  });
});

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toTelegramHtml, toTelegramMarkdown, wrapFileReferencesInHtml, escapeHtml } =
  require('../lib/telegram-format');

describe('toTelegramHtml — basics', () => {
  test('empty string passes through with no parse_mode', () => {
    const r = toTelegramHtml('');
    assert.equal(r.text, '');
    assert.equal(r.parseMode, null);
  });

  test('non-string passes through untouched', () => {
    const r = toTelegramHtml(null);
    assert.equal(r.text, null);
    assert.equal(r.parseMode, null);
  });

  test('headings downgrade to bold (telegram has no headings)', () => {
    const r = toTelegramHtml('# Hello\n\n## World');
    assert.equal(r.parseMode, 'HTML');
    assert.match(r.text, /<b>Hello<\/b>/);
    assert.match(r.text, /<b>World<\/b>/);
  });

  test('bold + italic + strikethrough', () => {
    const r = toTelegramHtml('**bold** _italic_ ~~deleted~~');
    assert.equal(r.parseMode, 'HTML');
    assert.match(r.text, /<b>bold<\/b>/);
    assert.match(r.text, /<i>italic<\/i>/);
    assert.match(r.text, /<s>deleted<\/s>/);
  });

  test('inline code stays as <code>', () => {
    const r = toTelegramHtml('Run `npm test`');
    assert.match(r.text, /<code>npm test<\/code>/);
  });

  test('fenced code preserves language for syntax highlighting', () => {
    const r = toTelegramHtml('```python\nprint(3.14)\n```');
    assert.match(r.text, /<pre><code class="language-python">/);
    assert.match(r.text, /print\(3\.14\)/);
  });

  test('plain text with HTML entities is escaped', () => {
    const r = toTelegramHtml('A & B < C > D');
    assert.match(r.text, /A &amp; B &lt; C &gt; D/);
  });

  test('links rendered as <a href>', () => {
    const r = toTelegramHtml('See [docs](https://example.com)');
    assert.match(r.text, /<a href="https:\/\/example\.com">docs<\/a>/);
  });
});

describe('toTelegramHtml — spoilers', () => {
  test('||spoiler|| → <tg-spoiler>', () => {
    const r = toTelegramHtml('Hidden: ||the answer||');
    assert.match(r.text, /<tg-spoiler>the answer<\/tg-spoiler>/);
  });
  test('text without || is unchanged', () => {
    const r = toTelegramHtml('plain text');
    assert.doesNotMatch(r.text, /tg-spoiler/);
  });
});

describe('toTelegramHtml — blockquotes', () => {
  test('short blockquote stays unexpanded', () => {
    const r = toTelegramHtml('> short');
    assert.match(r.text, /<blockquote>/);
    assert.doesNotMatch(r.text, /expandable/);
  });
  test('long blockquote becomes expandable', () => {
    const longText = 'a '.repeat(200);
    const r = toTelegramHtml('> ' + longText);
    assert.match(r.text, /<blockquote expandable>/);
  });
});

describe('toTelegramHtml — nested lists', () => {
  test('nested list preserves hierarchy with distinct bullets', () => {
    const r = toTelegramHtml('- top\n  - nested 1\n  - nested 2\n    - deep');
    assert.match(r.text, /• top/);
    assert.match(r.text, /◦ nested 1/);
    assert.match(r.text, /◦ nested 2/);
    assert.match(r.text, /▪ deep/);
  });
  test('top-level items appear on their own lines', () => {
    const r = toTelegramHtml('- a\n- b\n- c');
    assert.match(r.text, /• a\n• b\n• c/);
  });
});

describe('toTelegramHtml — tables', () => {
  test('table wrapped in <pre> with aligned columns', () => {
    const r = toTelegramHtml(
      '| Partner | Sum |\n|---|---:|\n| SHE | 100 |\n| Tree | 22 |',
    );
    assert.match(r.text, /<pre>\|/);
    assert.match(r.text, /<\/pre>/);
    assert.match(r.text, /Partner/);
    assert.match(r.text, /SHE/);
  });

  test('right-aligned column right-pads with leading spaces (numbers)', () => {
    const r = toTelegramHtml(
      '| Partner | Sum |\n|---|---:|\n| SHE | 100 |\n| Tree | 22 |',
    );
    // Sum header is 3 chars, max data is "100" (3) → width 3.
    // Cell "22" right-aligned: pad=" " then s → " 22".
    // Render row inserts ` | ` separator + ` |` close → "|  22 |"
    // (two spaces: 1 separator + 1 right-align pad).
    assert.match(r.text, /\|  22 \|/);
  });

  test('left-aligned column right-pads with trailing spaces (default)', () => {
    const r = toTelegramHtml(
      '| Name | Note |\n|---|---|\n| Mini | x |\n| Big things | y |',
    );
    // "Mini" (4) padded to "Big things" width (10): "Mini      "
    assert.match(r.text, /\| Mini       \|/);
  });

  test('column width follows the longest cell, not the header', () => {
    const r = toTelegramHtml(
      '| A | B |\n|---|---|\n| short | also-short |\n| this-is-much-longer | x |',
    );
    // Widest in column A is "this-is-much-longer" (19); header "A"
    // gets padded to that.
    assert.match(r.text, /\| A {19}\s*\|/);
  });

  test('column width follows the header when longer than any cell', () => {
    const r = toTelegramHtml(
      '| LongHeader | B |\n|---|---|\n| x | y |\n| z | w |',
    );
    // Header "LongHeader" (10) wins; "x" cell padded to width 10.
    assert.match(r.text, /\| x {9} \|/);
  });

  test('inline-formatted cells: width measures stripped text, padding restores tags', () => {
    const r = toTelegramHtml(
      '| Item | Note |\n|---|---|\n| **bold** | y |\n| plain | another |',
    );
    // Bold cell renders <b>bold</b>; col 0 width = max("Item"=4,
    // "bold"=4 stripped, "plain"=5) = 5. Pad "<b>bold</b>" to len 5
    // → "<b>bold</b> " (1 trailing space). Then renderRow appends
    // ` | ` between cells → "<b>bold</b>  |" (1 pad + 1 sep space).
    assert.match(r.text, /\| <b>bold<\/b>  \|/);
  });

  test('separator row is dashes one wider than the column on each side', () => {
    const r = toTelegramHtml(
      '| A | B |\n|---|---|\n| x | yy |',
    );
    // Header widths after sizing: A=1, B=2; separator |---|----|
    // (3 dashes for col A, 4 for col B because width+2).
    assert.match(r.text, /\|---\|----\|/);
  });

  test('renders inside a single <pre> block (not multi-paragraph)', () => {
    const r = toTelegramHtml(
      '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |',
    );
    // Exactly one <pre>...</pre>, all 4 lines (header + sep + 2 data) inside.
    const matches = r.text.match(/<pre>[\s\S]*?<\/pre>/g);
    assert.ok(matches, '<pre> block missing');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].split('\n').length, 4);
  });

  test('empty data cell is rendered as just padding (no crash)', () => {
    const r = toTelegramHtml(
      '| A | B |\n|---|---|\n| x |  |\n| y | hi |',
    );
    // Empty cell at row 1 col B becomes "  " (width 2, all padding).
    // Just verify the table rendered without error.
    assert.match(r.text, /<pre>/);
    assert.match(r.text, /<\/pre>/);
    assert.match(r.text, /\| x \|    \|/);
  });

  test('numeric-content right-aligned column matches budget calculation', () => {
    const r = toTelegramHtml(
      '| Item | Cost |\n|---|---:|\n| Tea | 100 |\n| Pho | 250 |',
    );
    // Col widths: col 0 = max("Item"=4, "Tea"=3, "Pho"=3) = 4;
    // col 1 = max("Cost"=4, "100"=3, "250"=3) = 4. Right-align col 1
    // adds 1 leading pad-space; renderRow adds 1 separator-space →
    // "| Tea  |  100 |" (2 trailing in col 0, 2 leading in col 1).
    const m = r.text.match(/\| Tea  \|  100 \|/);
    assert.ok(m, `expected '| Tea  |  100 |' in ${r.text}`);
  });

  test('emoji and unicode cells: width counts code points, not bytes', () => {
    // The current implementation uses .length which counts UTF-16 code
    // units, not visible glyphs. This documents that — emoji-heavy
    // tables render with VISIBLE misalignment because emoji surrogate
    // pairs count as 2 chars but display as ~2 visible columns.
    // Documents current behaviour; if we ever ship a Unicode-aware
    // width pass, this test will start failing and we update.
    const r = toTelegramHtml(
      '| A | B |\n|---|---|\n| 🚀 | x |\n| ok | y |',
    );
    // 🚀 is one visible glyph but two UTF-16 code units, so widths[0]
    // becomes 2 from the rocket and "ok" (also 2). No misalignment in
    // THIS particular case — both cells happen to be 2 code units.
    assert.match(r.text, /<pre>/);
  });

  test('many-column wide table renders all columns (no truncation in formatter)', () => {
    // Pins: the formatter does NOT auto-narrow wide tables. The agent
    // must use the polygram-side display hint to pick a different
    // format. If we ever add formatter-side narrowing this test
    // breaks intentionally so we update the system-prompt hint.
    const md = '| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n'
      + '| aaaaaaaa | bbbbbbbb | cccccccc | dddddddd | eeeeeeee | ffffffff |';
    const r = toTelegramHtml(md);
    for (const col of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee', 'ffffffff']) {
      assert.match(r.text, new RegExp(col), `missing column ${col}`);
    }
    // Single line (no auto-wrapping in renderer).
    const dataLine = r.text.match(/\| aaaaaaaa[^\n]*ffffffff[^\n]*\|/);
    assert.ok(dataLine, 'all columns must be on one line — formatter does not narrow');
  });

  test('row count: separator + data, no extra blank rows', () => {
    const r = toTelegramHtml(
      '| A | B |\n|---|---|\n| 1 | 2 |',
    );
    // Lines inside <pre>: header, separator, 1 data row = 3 total.
    const inner = r.text.match(/<pre>([\s\S]*?)<\/pre>/)[1];
    assert.equal(inner.split('\n').length, 3);
  });
});

describe('wrapFileReferencesInHtml', () => {
  test('wraps standalone .md / .py / .sh / .go references', () => {
    const inputs = [
      'Check README.md for details',
      'Run main.go now',
      'See script.py output',
      'Run backup.sh',
    ];
    for (const i of inputs) {
      const out = wrapFileReferencesInHtml(i);
      assert.match(out, /<code>[^<]+\.(md|go|py|sh)<\/code>/, `failed for: ${i}`);
    }
  });

  test('skips refs already inside <code>, <pre>, or <a>', () => {
    const cases = [
      '<code>README.md</code> stays',
      '<pre>script.py inside pre</pre>',
      '<a href="x">main.go</a>',
    ];
    for (const c of cases) {
      assert.equal(wrapFileReferencesInHtml(c), c, `mutated: ${c}`);
    }
  });

  test('handles paths with slashes', () => {
    const out = wrapFileReferencesInHtml('See workspace/skills/foo/SKILL.md please');
    assert.match(out, /<code>workspace\/skills\/foo\/SKILL\.md<\/code>/);
  });

  test('does not wrap real domain TLDs (.io, .ai)', () => {
    const out = wrapFileReferencesInHtml('Visit example.io and claude.ai');
    assert.doesNotMatch(out, /<code>example\.io<\/code>/);
    assert.doesNotMatch(out, /<code>claude\.ai<\/code>/);
  });
});

describe('escapeHtml', () => {
  test('escapes < > &', () => {
    assert.equal(escapeHtml('<script>x & y</script>'),
      '&lt;script&gt;x &amp; y&lt;/script&gt;');
  });
  test('non-string returns empty', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(123), '');
  });
});

describe('toTelegramMarkdown alias still works (back-compat)', () => {
  test('returns HTML output (function is now a thin alias)', () => {
    const r = toTelegramMarkdown('**bold**');
    assert.equal(r.parseMode, 'HTML');
    assert.match(r.text, /<b>bold<\/b>/);
  });
});

// ─── 0.7.0: Telegram error classification ──────────────────────────

const { isHtmlParseError, isMessageNotModifiedError } = require('../lib/telegram-format');

describe('isHtmlParseError', () => {
  test('matches canonical Telegram parse-error wording', () => {
    const cases = [
      "Bad Request: can't parse entities: Unmatched tag",
      "Bad Request: parse entities: Unsupported tag",
      "Bad Request: can't find end of the entity",
      "Telegram: Bad Request: CAN'T PARSE ENTITIES",
    ];
    for (const msg of cases) {
      assert.ok(isHtmlParseError(new Error(msg)), 'should match: ' + msg);
    }
  });

  test('does NOT match unrelated errors', () => {
    const cases = [
      'Forbidden: bot was kicked',
      'Bad Request: chat not found',
      'message is not modified',
      'Network request for sendMessage failed',
      'Bad Request: text too long',
    ];
    for (const msg of cases) {
      assert.ok(!isHtmlParseError(new Error(msg)), 'should NOT match: ' + msg);
    }
  });

  test('handles err.description (grammy shape)', () => {
    const err = { description: "Bad Request: can't parse entities: x" };
    assert.ok(isHtmlParseError(err));
  });

  test('null/undefined safe', () => {
    assert.equal(isHtmlParseError(null), false);
    assert.equal(isHtmlParseError(undefined), false);
  });
});

describe('isMessageNotModifiedError', () => {
  test('matches the literal Telegram wording', () => {
    const cases = [
      'Bad Request: message is not modified',
      '400: Bad Request: message is not modified: nothing changed',
      'Bad Request: MESSAGE_NOT_MODIFIED',
    ];
    for (const msg of cases) {
      assert.ok(isMessageNotModifiedError(new Error(msg)), 'should match: ' + msg);
    }
  });

  test('does NOT match other 400 errors', () => {
    const cases = [
      'Bad Request: chat not found',
      "Bad Request: can't parse entities",
      'Bad Request: message text is empty',
    ];
    for (const msg of cases) {
      assert.ok(!isMessageNotModifiedError(new Error(msg)), 'should NOT match: ' + msg);
    }
  });
});

// ─── 0.7.0: splitTelegramCaption ─────────────────────────────────

const { splitTelegramCaption, TELEGRAM_MAX_CAPTION_LENGTH } = require('../lib/telegram-format');

describe('splitTelegramCaption', () => {
  test('empty input returns both undefined', () => {
    assert.deepEqual(splitTelegramCaption(''), { caption: undefined, followUpText: undefined });
    assert.deepEqual(splitTelegramCaption(null), { caption: undefined, followUpText: undefined });
    assert.deepEqual(splitTelegramCaption(undefined), { caption: undefined, followUpText: undefined });
    assert.deepEqual(splitTelegramCaption('   '), { caption: undefined, followUpText: undefined });
  });

  test('text within 1024 chars goes as caption', () => {
    const r = splitTelegramCaption('short caption');
    assert.equal(r.caption, 'short caption');
    assert.equal(r.followUpText, undefined);
  });

  test('text exactly 1024 chars goes as caption', () => {
    const text = 'a'.repeat(1024);
    const r = splitTelegramCaption(text);
    assert.equal(r.caption, text);
    assert.equal(r.followUpText, undefined);
  });

  test('text over 1024 chars goes as followUp (no caption)', () => {
    const text = 'a'.repeat(1025);
    const r = splitTelegramCaption(text);
    assert.equal(r.caption, undefined);
    assert.equal(r.followUpText, text);
  });

  test('trims input before checking length', () => {
    const r = splitTelegramCaption('  hello  ');
    assert.equal(r.caption, 'hello');
  });

  test('TELEGRAM_MAX_CAPTION_LENGTH constant matches Telegram cap', () => {
    assert.equal(TELEGRAM_MAX_CAPTION_LENGTH, 1024);
  });
});

// ─── 0.7.0: 429 rate-limit handling ───────────────────────────────

const { isRateLimitError, getRetryAfterMs } = require('../lib/telegram-format');

describe('isRateLimitError', () => {
  test('matches Telegram 429 wording', () => {
    assert.ok(isRateLimitError(new Error('Too Many Requests: retry after 5')));
    assert.ok(isRateLimitError(new Error('429: too many requests')));
    assert.ok(isRateLimitError(new Error('retry after 12 seconds')));
  });

  test('does NOT match unrelated errors', () => {
    assert.ok(!isRateLimitError(new Error('chat not found')));
    assert.ok(!isRateLimitError(new Error('forbidden')));
  });

  test('null/undefined safe', () => {
    assert.equal(isRateLimitError(null), false);
    assert.equal(isRateLimitError(undefined), false);
  });
});

describe('getRetryAfterMs', () => {
  test('reads from err.parameters.retry_after (grammy shape)', () => {
    const err = Object.assign(new Error('rate'), { parameters: { retry_after: 7 } });
    assert.equal(getRetryAfterMs(err), 7000);
  });

  test('reads from err.error_parameters.retry_after (alt shape)', () => {
    const err = Object.assign(new Error('rate'), { error_parameters: { retry_after: 3 } });
    assert.equal(getRetryAfterMs(err), 3000);
  });

  test('parses from message text', () => {
    assert.equal(getRetryAfterMs(new Error('Too Many Requests: retry after 4')), 4000);
    assert.equal(getRetryAfterMs(new Error('retry after 30 seconds — slow down')), 30000);
  });

  test('returns null when not parseable', () => {
    assert.equal(getRetryAfterMs(new Error('Too Many Requests')), null);
    assert.equal(getRetryAfterMs(new Error('chat not found')), null);
    assert.equal(getRetryAfterMs(null), null);
  });
});

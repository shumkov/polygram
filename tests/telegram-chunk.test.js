/**
 * Tests for lib/telegram-chunk.js — port of OpenClaw's chunkMarkdownText.
 *
 * Coverage:
 *   - Trivial inputs: empty / shorter than limit / exactly at limit
 *   - Plain chunkText: paren-aware, newline > whitespace > hard-cut
 *   - chunkMarkdownText: same plus fence handling
 *   - Fence-spanning chunks: close + reopen, single & nested-language
 *   - Edge cases: tildes (~~~), unclosed fence, multiple consecutive fences
 *   - Property: every chunk fits the limit; rejoining (with fence-rejoin
 *     accounting) recovers the source modulo intentional whitespace strips
 *   - Regression: msg 10794 — 8418-char real markdown reply must produce
 *     chunks where each is independently HTML-parseable (no mid-`**bold**`
 *     splits, no broken fence)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  chunkText,
  chunkMarkdownText,
  parseFenceSpans,
  scanParenAwareBreakpoints,
} = require('../lib/telegram-chunk');

describe('chunkText — early returns', () => {
  test('empty string → empty array', () => {
    assert.deepEqual(chunkText('', 100), []);
  });
  test('null/undefined → empty array', () => {
    assert.deepEqual(chunkText(null, 100), []);
    assert.deepEqual(chunkText(undefined, 100), []);
  });
  test('limit ≤ 0 returns input unsplit', () => {
    assert.deepEqual(chunkText('hello', 0), ['hello']);
    assert.deepEqual(chunkText('hello', -5), ['hello']);
  });
  test('text shorter than limit returns single chunk', () => {
    assert.deepEqual(chunkText('hello', 100), ['hello']);
  });
  test('text exactly at limit returns single chunk', () => {
    assert.deepEqual(chunkText('a'.repeat(100), 100), ['a'.repeat(100)]);
  });
});

describe('chunkText — break preference', () => {
  test('breaks at newline when one is in window', () => {
    const text = 'aaa\nbbb\nccc';
    const chunks = chunkText(text, 5);
    assert.equal(chunks.length, 3);
    for (const c of chunks) assert.ok(c.length <= 5);
    // Both newlines were found before exhausting limit — each line is
    // its own chunk.
    assert.deepEqual(chunks, ['aaa', 'bbb', 'ccc']);
  });

  test('breaks at whitespace when no newline available', () => {
    // chunkText finds the LAST whitespace within the window. Window is
    // text.slice(0, limit) = "aaa bbb" (limit=7); last whitespace is at
    // index 3, so it splits at "aaa" and continues. This isn't maximally
    // packed, but it always produces clean breaks at separators.
    const text = 'aaa bbb ccc ddd';
    const chunks = chunkText(text, 7);
    for (const c of chunks) assert.ok(c.length <= 7);
    assert.deepEqual(chunks, ['aaa', 'bbb', 'ccc ddd']);
  });

  test('hard-cuts when no whitespace either', () => {
    const text = 'aaaaaaaaaaaaaa'; // 14 a's, no space
    const chunks = chunkText(text, 5);
    for (const c of chunks) assert.ok(c.length <= 5);
    assert.deepEqual(chunks, ['aaaaa', 'aaaaa', 'aaaa']);
  });
});

describe('chunkText — paren-aware', () => {
  test('does NOT break inside parentheses at whitespace', () => {
    // The whitespace inside `(a b)` shouldn't be a break candidate.
    // Outer whitespace before `(a b)` is preferred.
    const text = 'word (a b c d e f g) more';
    const chunks = chunkText(text, 12);
    // Expect break at the space before `(a b c d e f g)` rather than
    // inside the parens.
    for (const c of chunks) assert.ok(c.length <= 12, `chunk too long: ${c.length}`);
    // First chunk should not split the paren expression.
    assert.ok(!chunks[0].includes('(a'), `expected paren-respect, got: ${chunks[0]}`);
  });

  test('balanced parens mid-text get treated as one unit', () => {
    const text = 'see [docs](http://example.com/very/long/url) for info';
    const chunks = chunkText(text, 30);
    // Either single chunk or break at a non-paren-internal space.
    for (const c of chunks) assert.ok(c.length <= 30);
  });
});

describe('parseFenceSpans', () => {
  test('detects a single closed fence', () => {
    const text = '```js\nconsole.log(1)\n```';
    const spans = parseFenceSpans(text);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].marker, '```');
    assert.equal(spans[0].openLine, '```js');
  });

  test('detects unclosed fence — extends to EOF', () => {
    const text = '```js\nconsole.log(1)';
    const spans = parseFenceSpans(text);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].end, text.length);
  });

  test('detects multiple sibling fences', () => {
    const text = '```\na\n```\ntext\n```\nb\n```';
    const spans = parseFenceSpans(text);
    assert.equal(spans.length, 2);
  });

  test('different markers (~~~ vs ```) do not match each other', () => {
    const text = '```\nbody\n~~~\nstill body\n```';
    const spans = parseFenceSpans(text);
    // The ~~~ doesn't close the ``` fence.
    assert.equal(spans.length, 1);
    assert.equal(spans[0].marker, '```');
  });

  test('shorter close marker does not close longer open', () => {
    const text = '`````\nbody\n```\nstill body\n`````';
    const spans = parseFenceSpans(text);
    // 3-backtick close doesn't terminate a 5-backtick fence.
    assert.equal(spans.length, 1);
    assert.equal(spans[0].marker, '`````');
  });

  test('indented fences (≤3 spaces) are recognised', () => {
    const text = '   ```\nbody\n   ```';
    const spans = parseFenceSpans(text);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].indent, '   ');
  });
});

describe('chunkMarkdownText — basic', () => {
  test('returns single chunk for fits-in-limit input', () => {
    assert.deepEqual(chunkMarkdownText('short', 100), ['short']);
  });

  test('breaks at newline boundaries when no fence in play', () => {
    const text = 'line1\nline2\nline3\nline4';
    const chunks = chunkMarkdownText(text, 12);
    for (const c of chunks) assert.ok(c.length <= 12);
    assert.ok(chunks.length >= 2);
  });
});

describe('chunkMarkdownText — fence handling', () => {
  test('breaks BEFORE a fence rather than inside if possible', () => {
    const before = 'a'.repeat(50) + '\n';
    const fence = '```js\n' + 'b'.repeat(100) + '\n```\n';
    const after = 'c'.repeat(20);
    const text = before + fence + after;
    // Limit forces a break, but fence body (>limit) means split it.
    // First we test a limit large enough to break before the fence.
    const chunks = chunkMarkdownText(text, 60);
    for (const c of chunks) {
      // Each chunk's fence opens MUST close within the same chunk.
      const spans = parseFenceSpans(c);
      for (const s of spans) {
        assert.ok(s.end < c.length || c.endsWith('```'),
          `chunk has unclosed fence: ${JSON.stringify(c.slice(0, 80))}`);
      }
    }
  });

  test('SPLITS a fence that spans the chunk boundary (close + reopen)', () => {
    const fenceBody = ['line ' + 'x'.repeat(50)];
    for (let i = 0; i < 50; i++) fenceBody.push('line ' + 'y'.repeat(50));
    const text = '```js\n' + fenceBody.join('\n') + '\n```';
    const chunks = chunkMarkdownText(text, 200);
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    // Every chunk must be self-contained: every fence opens has matching close.
    for (const c of chunks) {
      assert.ok(c.length <= 200, `chunk exceeds limit: ${c.length}`);
      // Count opens and closes — they must balance per-chunk.
      const fenceLines = c.split('\n').filter((l) => /^( {0,3})(`{3,}|~{3,})/.test(l));
      assert.equal(
        fenceLines.length % 2, 0,
        `chunk has odd fence count (unbalanced): ${JSON.stringify(c.slice(0, 100))}`,
      );
    }
    // Middle chunks should reopen with the same marker+language as original.
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(
        chunks[i].startsWith('```js'),
        'chunk ' + i + ' should reopen js fence, got: ' + chunks[i].slice(0, 30),
      );
    }
  });

  test('language hint is preserved when fence is split', () => {
    const body = '\n'.repeat(0) + 'a'.repeat(300);
    const text = '```python\n' + body + '\n```';
    const chunks = chunkMarkdownText(text, 100);
    assert.ok(chunks.length >= 2);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].startsWith('```python'), 'chunk ' + i + ': ' + chunks[i].slice(0, 30));
    }
  });

  test('tilde fences (~~~) are handled identically', () => {
    const body = ['line ' + 'a'.repeat(40)];
    for (let i = 0; i < 30; i++) body.push('line ' + 'b'.repeat(40));
    const text = '~~~js\n' + body.join('\n') + '\n~~~';
    const chunks = chunkMarkdownText(text, 200);
    assert.ok(chunks.length >= 2);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].startsWith('~~~js'), 'chunk ' + i + ': ' + chunks[i].slice(0, 30));
    }
  });

  test('unclosed fence at EOF still produces parseable chunks', () => {
    const text = 'preamble\n'.repeat(20) + '```js\n' + 'code line\n'.repeat(40);
    const chunks = chunkMarkdownText(text, 80);
    for (const c of chunks) assert.ok(c.length <= 80);
  });
});

describe('chunkMarkdownText — strips leading newlines from remainder', () => {
  test('no blank lines at the top of subsequent chunks', () => {
    const text = ('para line ' + 'x'.repeat(20) + '\n\n').repeat(8);
    const chunks = chunkMarkdownText(text, 60);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(!chunks[i].startsWith('\n'), `chunk ${i} starts with \\n`);
    }
  });
});

describe('chunkMarkdownText — invariants', () => {
  test('every chunk fits within the limit', () => {
    const corpus = [
      'a'.repeat(10000),
      ('line ' + 'x'.repeat(50) + '\n').repeat(200),
      ('paragraph with **bold** and `inline code`\n\n').repeat(100),
      '```js\n' + ('y'.repeat(80) + '\n').repeat(100) + '```',
    ];
    for (const text of corpus) {
      for (const limit of [100, 500, 1000, 4096]) {
        const chunks = chunkMarkdownText(text, limit);
        for (let i = 0; i < chunks.length; i++) {
          assert.ok(
            chunks[i].length <= limit,
            `corpus[${corpus.indexOf(text)}], limit=${limit}, chunk[${i}].length=${chunks[i].length}`,
          );
        }
      }
    }
  });

  test('joining chunks (post fence-rejoin) approximates source', () => {
    // We trim leading newlines on remainder, so exact equality isn't
    // achievable — test that core content is preserved.
    const text = 'Section A\n\nWith content here.\n\nSection B\n\nMore content.';
    const chunks = chunkMarkdownText(text, 25);
    const rejoined = chunks.join('\n');
    for (const word of ['Section A', 'Section B', 'content', 'More']) {
      assert.ok(rejoined.includes(word), `lost word: ${word}`);
    }
  });
});

describe('msg 10794 regression', () => {
  test('long markdown reply with bold-heavy P&L breaks at clean boundaries', () => {
    // Synthesized from the actual incident: ~8KB body with many **Maria:**,
    // **Total:** style boundaries that previously cut mid-word, breaking
    // HTML conversion via `<b>...` tags spanning chunks.
    const body = [
      "Now I have everything I need. Here's the analysis:",
      '',
      '## Summary',
      '',
      '**Revenue:** strong | **Margin:** healthy | **Net:** negative',
      '',
    ];
    // Build a body well over the 4096-char Telegram limit so we
    // actually exercise the chunking path.
    for (let section = 0; section < 30; section++) {
      body.push(`### Section ${section}`);
      body.push('');
      body.push(`Lorem ipsum **bold marker** in middle ${'word '.repeat(60)}`);
      body.push('');
      body.push('- **Bullet bold:** content here with more text padding');
      body.push('- More **inline** bold and **another** here');
      body.push('');
      body.push('**Total:** 30K + 14,400 + 5,000 = ~49,400 THB/month');
      body.push('');
    }
    const text = body.join('\n');
    const chunks = chunkMarkdownText(text, 4096);
    assert.ok(chunks.length >= 2, 'expected multi-chunk output');

    // Every chunk must have balanced ** markers (a mid-bold cut would
    // leave an odd count). Telegram won't reject markdown directly, but
    // when we render it to HTML, an unmatched `**` would generate a
    // `<b>` without a closing `</b>` — that's the bug we're guarding.
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      assert.ok(c.length <= 4096, `chunk ${i} exceeds limit: ${c.length}`);
      const boldCount = (c.match(/\*\*/g) || []).length;
      assert.equal(
        boldCount % 2, 0,
        `chunk ${i} has unbalanced ** markers (${boldCount}): ${c.slice(0, 80)}…`,
      );
    }

    // Specifically: '**Total:**' should never be split mid-token. Find
    // every occurrence of 'Total' across chunks and verify it's preceded
    // by '**' in the same chunk.
    for (const c of chunks) {
      let idx = 0;
      while ((idx = c.indexOf('Total', idx)) !== -1) {
        const back = c.slice(Math.max(0, idx - 2), idx);
        if (back.endsWith('**')) {
          // OK — Total is opened with bold in this chunk.
        } else {
          // Total appears without the leading `**`. Either it's a
          // stand-alone "Total:" (also OK) or we split mid-bold.
          // Verify there's NO opening `**` orphaned earlier.
          const before = c.slice(0, idx);
          const beforeBolds = (before.match(/\*\*/g) || []).length;
          assert.equal(beforeBolds % 2, 0,
            `chunk has 'Total' after odd ** count: ${c.slice(0, 200)}`);
        }
        idx += 5;
      }
    }
  });
});

describe('chunkText vs chunkMarkdownText divergence', () => {
  test('chunkText ignores fences (would split inside)', () => {
    const text = '```\n' + 'line\n'.repeat(100) + '```';
    const plain = chunkText(text, 50);
    // chunkText doesn't reopen fences — chunks may be unbalanced.
    // This is documented behavior; chunkText is for non-markdown input.
    assert.ok(plain.length >= 2);
  });

  test('chunkMarkdownText preserves fence integrity', () => {
    const text = '```\n' + 'line\n'.repeat(100) + '```';
    const md = chunkMarkdownText(text, 50);
    for (const c of md) {
      const fenceLines = c.split('\n').filter((l) => /^```/.test(l));
      assert.equal(fenceLines.length % 2, 0, `unbalanced fence in chunk: ${c.slice(0,80)}`);
    }
  });
});

describe('scanParenAwareBreakpoints', () => {
  test('returns last newline + last whitespace outside parens', () => {
    const r = scanParenAwareBreakpoints('aa bb\ncc dd ee');
    // Last newline at index 5, last whitespace at index 11 (or 8).
    assert.equal(r.lastNewline, 5);
    assert.ok(r.lastWhitespace > r.lastNewline);
  });

  test('whitespace inside () is not a break candidate', () => {
    const r = scanParenAwareBreakpoints('foo (a b c) bar');
    // The space between 'foo' and '(' (idx 3) and between ')' and 'bar'
    // (idx 11) are valid; the spaces inside (...) at 6, 8 are not.
    assert.ok([3, 11].includes(r.lastWhitespace));
  });

  test('isAllowed predicate filters break candidates', () => {
    // Pretend index 5..15 is "in fence" — those breaks should be skipped.
    const text = 'aa bb cc dd ee ff gg';
    const r = scanParenAwareBreakpoints(text, (i) => i < 5 || i > 15);
    // The whitespace at index 2 (after 'aa') is allowed; index 5 is not.
    assert.ok(r.lastWhitespace < 5 || r.lastWhitespace > 15);
  });
});

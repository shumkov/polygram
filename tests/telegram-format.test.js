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

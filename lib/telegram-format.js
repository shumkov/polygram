/**
 * Markdown → Telegram HTML.
 *
 * Replaces the 0.4.x telegramify-markdown / MarkdownV2 pipeline with HTML
 * output. Reasons for the switch:
 *   - Native syntax highlighting via `<pre><code class="language-X">`
 *   - `<blockquote expandable>` for collapsible long output
 *   - Only 3 chars need escaping (`<`, `>`, `&`) vs MarkdownV2's 18
 *   - Cleaner nesting (HTML tag pairs vs MarkdownV2's brittle ordering)
 *   - Tables become `<pre>` blocks with column alignment, no regex hacks
 *
 * Implementation: `marked` parses CommonMark into tokens, our custom
 * renderer emits Telegram-compatible HTML for each token type. The
 * `wrapFileReferencesInHtml` post-processor (adapted from OpenClaw,
 * MIT) wraps `README.md`-style references in `<code>` so Telegram
 * doesn't auto-linkify them as bogus domains.
 */

const { Marked } = require('marked');

// File extensions that are ALSO TLDs and commonly appear in chat (where
// auto-linking them as `http://README.md` would generate spam preview
// cards). Adapted from openclaw/openclaw (MIT) src/shared/text/
// auto-linked-file-ref.ts. Excludes `.ai`, `.io`, `.tv`, `.fm` which
// are popular real-domain TLDs.
const FILE_REF_EXTENSIONS = ['md', 'go', 'py', 'pl', 'sh', 'am', 'at', 'be', 'cc'];

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

// Trigger expandable blockquote when content exceeds either threshold.
// `<blockquote expandable>` renders as a 3-line preview with "Show more"
// — useful for long quoted reasoning the user usually skips.
const EXPANDABLE_BLOCKQUOTE_CHARS = 240;
const EXPANDABLE_BLOCKQUOTE_LINES = 4;

function shouldExpandQuote(innerHtml) {
  const plain = innerHtml.replace(/<[^>]+>/g, '');
  return plain.length > EXPANDABLE_BLOCKQUOTE_CHARS
      || plain.split('\n').length > EXPANDABLE_BLOCKQUOTE_LINES;
}

// Split a list item's tokens into the leading inline run and any
// block-level tokens that follow (nested list, code block, etc.). Without
// this split, `parser.parse(item.tokens)` glues inline text directly
// against the nested list's first marker — "top• nested 1" with no
// separator — because text() does not emit a trailing newline.
const BLOCK_TYPES = new Set(['list', 'blockquote', 'code', 'table', 'paragraph', 'space', 'html', 'hr']);

function splitItemTokens(tokens) {
  const inline = [];
  const blocks = [];
  let crossedToBlock = false;
  for (const tok of tokens) {
    if (BLOCK_TYPES.has(tok.type)) {
      crossedToBlock = true;
      blocks.push(tok);
    } else if (crossedToBlock) {
      blocks.push({ type: 'paragraph', tokens: [tok] });
    } else {
      inline.push(tok);
    }
  }
  return { inline, blocks };
}

function buildRenderer() {
  // Different bullet glyphs per nesting depth: visual hierarchy without
  // relying on Telegram preserving leading spaces (it does for HTML
  // mode but the cue is clearer with distinct bullets).
  const NESTED_BULLETS = ['•', '◦', '▪', '▫'];
  let listDepth = 0;
  function bulletFor(d) { return NESTED_BULLETS[Math.min(d, NESTED_BULLETS.length - 1)]; }

  return {
    heading({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b>\n\n`;
    },
    paragraph({ tokens }) {
      return this.parser.parseInline(tokens) + '\n\n';
    },
    text({ tokens, text }) {
      if (Array.isArray(tokens) && tokens.length) return this.parser.parseInline(tokens);
      return escapeHtml(text);
    },
    strong({ tokens }) { return `<b>${this.parser.parseInline(tokens)}</b>`; },
    em({ tokens })     { return `<i>${this.parser.parseInline(tokens)}</i>`; },
    del({ tokens })    { return `<s>${this.parser.parseInline(tokens)}</s>`; },
    codespan({ text }) { return `<code>${escapeHtml(text)}</code>`; },
    code({ text, lang }) {
      const langClass = lang ? ` class="language-${escapeHtmlAttr(lang)}"` : '';
      return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>\n\n`;
    },
    blockquote({ tokens }) {
      const inner = this.parser.parse(tokens).trim();
      const expandable = shouldExpandQuote(inner) ? ' expandable' : '';
      return `<blockquote${expandable}>${inner}</blockquote>\n\n`;
    },
    link({ href, tokens }) {
      return `<a href="${escapeHtmlAttr(href)}">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, text }) {
      return `<a href="${escapeHtmlAttr(href)}">${escapeHtml(text || href)}</a>`;
    },
    list({ items, ordered, start }) {
      const depth = listDepth;
      listDepth += 1;
      const indent = '  '.repeat(depth);
      const bullet = bulletFor(depth);
      try {
        const lines = items.map((item, i) => {
          const marker = ordered ? `${(start || 1) + i}. ` : `${bullet} `;
          const { inline, blocks } = splitItemTokens(item.tokens);
          const leader = this.parser.parseInline(inline).trim();
          let line = `${indent}${marker}${leader}`;
          for (const block of blocks) {
            const rendered = this.parser.parse([block]).replace(/\n+$/, '');
            if (rendered) line += '\n' + rendered;
          }
          return line;
        });
        return lines.join('\n') + (depth === 0 ? '\n\n' : '');
      } finally {
        listDepth -= 1;
      }
    },
    listitem({ tokens }) { return this.parser.parse(tokens); },
    hr() { return '\n──────\n\n'; },
    br() { return '\n'; },
    table({ header, rows, align }) {
      const headerCells = header.map((cell) => this.parser.parseInline(cell.tokens));
      const rowCells = rows.map((row) => row.map((cell) => this.parser.parseInline(cell.tokens)));
      const stripTags = (s) => s.replace(/<[^>]+>/g, '');
      const widths = headerCells.map((h, col) => {
        let maxLen = stripTags(h).length;
        for (const r of rowCells) {
          const cellLen = stripTags(r[col] || '').length;
          if (cellLen > maxLen) maxLen = cellLen;
        }
        return maxLen;
      });
      const padCell = (s, col) => {
        const len = stripTags(s).length;
        const padding = ' '.repeat(Math.max(0, widths[col] - len));
        if (align[col] === 'right') return padding + s;
        return s + padding;
      };
      const renderRow = (cells) => '| ' + cells.map((c, i) => padCell(c, i)).join(' | ') + ' |';
      const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
      const lines = [renderRow(headerCells), sep, ...rowCells.map(renderRow)];
      return `<pre>${lines.join('\n')}</pre>\n\n`;
    },
    html({ text }) { return escapeHtml(text); },
  };
}

// Spoiler extension for marked. Recognises `||hidden||` inline. Telegram-
// specific (matches OpenClaw's enableSpoilers behaviour).
const spoilerExtension = {
  name: 'spoiler',
  level: 'inline',
  start(src) { return src.indexOf('||'); },
  tokenizer(src) {
    const m = /^\|\|([\s\S]+?)\|\|/.exec(src);
    if (!m) return undefined;
    return {
      type: 'spoiler',
      raw: m[0],
      text: m[1],
      tokens: this.lexer.inlineTokens(m[1]),
    };
  },
  renderer({ tokens }) {
    return `<tg-spoiler>${this.parser.parseInline(tokens)}</tg-spoiler>`;
  },
};

const HTML_TAG_RE = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;
const AUTO_LINKED_ANCHOR_RE = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const _extPattern = FILE_REF_EXTENSIONS.map(escapeRegex).join('|');
const FILE_REF_PATTERN = new RegExp(
  `(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${_extPattern}))(?=$|[^a-zA-Z0-9_\\-/])`,
  'gi',
);
const ORPHANED_TLD_PATTERN = new RegExp(
  `([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${_extPattern}))(?=[^a-zA-Z0-9/]|$)`,
  'g',
);

function isAutoLinkedFileRef(label) {
  const dotIdx = label.lastIndexOf('.');
  if (dotIdx < 1) return false;
  const ext = label.slice(dotIdx + 1).toLowerCase();
  if (!FILE_REF_EXTENSIONS.includes(ext)) return false;
  const segments = label.split('/');
  if (segments.length > 1) {
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (segments[i].includes('.')) return false;
    }
  }
  return true;
}

function wrapStandaloneFileRef(_match, prefix, filename) {
  if (filename.startsWith('//')) return _match;
  if (/https?:\/\/$/i.test(prefix)) return _match;
  return `${prefix}<code>${escapeHtml(filename)}</code>`;
}

function wrapSegment(text, codeDepth, preDepth, anchorDepth) {
  if (!text || codeDepth > 0 || preDepth > 0 || anchorDepth > 0) return text;
  const w = text.replace(FILE_REF_PATTERN, wrapStandaloneFileRef);
  return w.replace(ORPHANED_TLD_PATTERN, (m, prefix, tld) => {
    if (prefix === '>') return m;
    return `${prefix}<code>${escapeHtml(tld)}</code>`;
  });
}

function wrapFileReferencesInHtml(html) {
  AUTO_LINKED_ANCHOR_RE.lastIndex = 0;
  const deLinkified = html.replace(AUTO_LINKED_ANCHOR_RE, (m, label) => {
    if (!isAutoLinkedFileRef(label)) return m;
    return `<code>${escapeHtml(label)}</code>`;
  });
  let codeDepth = 0, preDepth = 0, anchorDepth = 0;
  let result = '';
  let lastIndex = 0;
  HTML_TAG_RE.lastIndex = 0;
  let match;
  while ((match = HTML_TAG_RE.exec(deLinkified)) !== null) {
    const tagStart = match.index;
    const tagEnd = HTML_TAG_RE.lastIndex;
    const isClosing = match[1] === '</';
    const tagName = match[2].toLowerCase();
    result += wrapSegment(deLinkified.slice(lastIndex, tagStart), codeDepth, preDepth, anchorDepth);
    if (tagName === 'code') codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    else if (tagName === 'pre') preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    else if (tagName === 'a') anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;
    result += deLinkified.slice(tagStart, tagEnd);
    lastIndex = tagEnd;
  }
  result += wrapSegment(deLinkified.slice(lastIndex), codeDepth, preDepth, anchorDepth);
  return result;
}

const _markedInstance = new Marked(
  { gfm: true, breaks: false, renderer: buildRenderer() },
  { extensions: [spoilerExtension] },
);

function toTelegramHtml(text) {
  if (typeof text !== 'string' || text.length === 0) return { text, parseMode: null };
  try {
    const html = _markedInstance.parse(text).trimEnd();
    const wrapped = wrapFileReferencesInHtml(html);
    return { text: wrapped, parseMode: 'HTML' };
  } catch {
    return { text, parseMode: null };
  }
}

function toTelegramMarkdown(text) { return toTelegramHtml(text); }

module.exports = { toTelegramMarkdown, toTelegramHtml, wrapFileReferencesInHtml, escapeHtml };

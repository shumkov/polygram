/**
 * Markdown → Telegram Bot API Rich Message blocks.
 *
 * Companion to format.js's markdown→HTML pipeline, not a replacement:
 * this only runs when needsRichRendering() finds a construct (task list,
 * table, <details>, heading, blockquote, divider, image, or a
 * <tg-collage>/<tg-slideshow> media wrapper) that the plain HTML
 * pipeline can't express natively, AND the chat has opted in
 * (config.richText). Everything else stays on the existing
 * toTelegramHtml() path.
 *
 * Block text fields carry plain strings only. Inline bold, italic, and
 * links are flattened rather than mapped to an unverified nested schema.
 * This keeps formatting safe while still supporting headings, tables,
 * checklists, and collapsible details.
 *
 * Bot API limits are enforced by Telegram itself:
 * ≤32,768 chars, ≤500 blocks, ≤16 nesting levels, ≤50 media, ≤20 table
 * columns.
 */

'use strict';

const { Marked } = require('marked');
const { getTopicConfig } = require('../session-key');

// ─── Per-chat opt-in resolution ──────────────────────────────────────
//
// Match the standard per-chat override precedence: topic, chat, active
// bot, then defaults. `config.bot` is already filtered to the active bot
// during startup.
function resolveRichTextEnabled(config, chatId, threadId = null) {
  if (!config) return false;
  const chat = config.chats?.[String(chatId)] || null;
  const topicCfg = (chat && threadId != null) ? getTopicConfig(chat, String(threadId)) : null;
  const pick = (v) => (typeof v === 'boolean' ? v : undefined);
  const resolved = pick(topicCfg?.richText)
    ?? pick(chat?.richText)
    ?? pick(config.bot?.richText)
    ?? pick(config.defaults?.richText);
  return resolved === true;
}

// ─── Content-adaptive gate ───────────────────────────────────────────
//
// Rich rendering uses different typography than plain prose (Telegram's
// own client renders it as a document, not a chat bubble) — sending
// ordinary prose through it makes it look oversized with no Bot API knob
// to correct it. So rich is
// reserved for content that actually contains a structural construct the
// plain pipeline can't express: task lists, tables, <details>, headings.
// False negatives are always safe (falls through to the existing,
// well-tested toTelegramHtml path); false positives risk the oversized-
// prose problem, so keep these patterns specific, not broad.
//
// Regexes below are deliberately simple/anchored (single quantified
// groups, no nested-quantifier ambiguity) to avoid catastrophic
// backtracking on adversarial input — the content they scan is agent
// output that can be influenced by a user asking the agent to echo a
// crafted string. See tests/rich.test.js for the ReDoS regression guard.

const TASK_ITEM_RE = /^[ \t]{0,3}[-*+][ \t]+\[[ xX]\][ \t]+/m;
const TABLE_ROW_RE = /^[ \t]{0,3}\|?[ \t]*:?-{2,}:?[ \t]*\|/m;
const DETAILS_RE = /<details[ \t>]/i;
const HEADING_RE = /^#{1,6}[ \t]+\S/m;
const BLOCKQUOTE_RE = /^[ \t]{0,3}>[ \t]?\S/m;
const DIVIDER_RE = /^[ \t]{0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/m;
// Markdown image syntax and Telegram's own collage/slideshow wrapper
// tags trigger rich so photos can render inline as media blocks.
const IMAGE_RE = /!\[[^\]\n]*\]\([^)\n]+\)/;
const MEDIA_WRAP_RE = /<tg-(?:collage|slideshow)[ \t>]/i;
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

// Code-fence content renders literally, so heading, checklist, and table
// syntax inside a fence must not influence the rich-rendering decision.
// Track fences with a line scan to keep the gate easy to reason about on
// adversarial input.
function stripFencedCodeBlocks(markdown) {
  if (markdown.indexOf('`') === -1 && markdown.indexOf('~') === -1) return markdown;
  const lines = markdown.split('\n');
  const out = [];
  // A CommonMark closing fence uses the opener's character, is at least
  // as long, and has only trailing whitespace. Preserve the opener so a
  // marker with trailing content cannot expose fenced syntax to the gate.
  let fence = null; // { char, len } while inside a fence, else null
  for (const line of lines) {
    const m = FENCE_LINE_RE.exec(line);
    if (m) {
      const marker = m[1];
      const char = marker[0];
      const len = marker.length;
      const trailing = line.slice(m[0].length);
      if (!fence) {
        fence = { char, len };
        out.push('');
        continue;
      }
      if (char === fence.char && len >= fence.len && trailing.trim() === '') {
        fence = null;
        out.push('');
        continue;
      }
      // Same-or-different marker mid-fence with trailing content (or a
      // shorter/mismatched marker) — still inside the block; scope it
      // out like any other fenced line, don't treat as a toggle.
      out.push(fence ? '' : line);
      continue;
    }
    out.push(fence ? '' : line);
  }
  return out.join('\n');
}

// Non-media triggers, kept separate so the media-drop demotion in
// toTelegramRichBlocks can ask "would this content be rich WITHOUT its
// images?" — if not, and no image resolved, the reply goes plain rather
// than rendering prose-only rich blocks (the oversized-prose problem).
function hasNonMediaTrigger(scoped) {
  return TASK_ITEM_RE.test(scoped)
      || TABLE_ROW_RE.test(scoped)
      || DETAILS_RE.test(scoped)
      || HEADING_RE.test(scoped)
      || BLOCKQUOTE_RE.test(scoped)
      || DIVIDER_RE.test(scoped);
}

function needsRichRendering(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return false;
  const scoped = stripFencedCodeBlocks(markdown);
  return hasNonMediaTrigger(scoped)
      || IMAGE_RE.test(scoped)
      || MEDIA_WRAP_RE.test(scoped);
}

// ─── marked instance for block-level tokenization ────────────────────
//
// Use a dedicated lexer because format.js's instance has an HTML-string
// renderer and does not expose a reusable token tree. GFM is required for
// task-list items and tables.
const _lexer = new Marked({ gfm: true, breaks: false });

function plainTextOf(tokens) {
  // Flatten inline tokens (bold/italic/link/code-span/text) to their
  // plain text content — see module doc for why. marked's Tokens carry
  // `.text` on leaf nodes; walk recursively for nested inline tokens
  // (e.g. bold-wrapping-a-link) so nothing is silently dropped.
  if (!Array.isArray(tokens)) return '';
  let out = '';
  for (const t of tokens) {
    if (t.type === 'text' || t.type === 'codespan' || t.type === 'escape') {
      out += t.text ?? '';
    } else if (t.type === 'link' || t.type === 'image') {
      out += plainTextOf(t.tokens) || t.text || t.href || '';
    } else if (t.type === 'br') {
      out += '\n';
    } else if (Array.isArray(t.tokens)) {
      out += plainTextOf(t.tokens);
    } else if (typeof t.text === 'string') {
      out += t.text;
    } else if (typeof t.raw === 'string') {
      out += t.raw;
    }
  }
  return out;
}

const DETAILS_BLOCK_RE = /<details[^>]*>(?:\s*<summary[^>]*>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>/i;
const DETAILS_OPEN_RE = /<details[^>]*>/i;
const DETAILS_CLOSE_RE = /<\/details>/i;
const SUMMARY_TAG_RE = /<summary[^>]*>([\s\S]*?)<\/summary>/i;
const HTML_TAG_STRIP_RE = /<[^>]+>/g;
const DEFAULT_DETAILS_SUMMARY = 'Details';

// ─── Media (photo / video / animation / wrappers) ────────────────────
//
// Image markdown maps to typed Telegram media blocks after resolution;
// <tg-collage>/<tg-slideshow> wrapper tags (Telegram's own rich-markdown
// dialect) group supported media into collage/slideshow blocks. The renderer emits internal DESCRIPTOR
// blocks (_media/_mediaGroup) carrying only { src, caption } strings;
// toTelegramRichBlocks substitutes them via the injected resolveMedia
// (final mode) or with placeholder paragraphs (streaming/partial mode,
// or when no resolver is wired). Emitted block trees therefore never
// contain a raw agent-authored path, and never contain anything that
// can't survive JSON.stringify (the streamer dedups payloads that way;
// grammy InputFile instances would throw — they're materialized later,
// in rich-edit.js).
//
// Wrapper-span extraction deliberately scans the token stream (like the
// <details> handling below) instead of using a lazy [\s\S]*? block
// regex — an unclosed wrapper over a large body would make such a regex
// backtrack, and this text is agent output a user can influence.
const MEDIA_WRAP_OPEN_RE = /<tg-(collage|slideshow)(?:[ \t][^>]*)?>/i;
const MEDIA_WRAP_CLOSE_RE = /<\/tg-(?:collage|slideshow)>/i;
// Extraction form of IMAGE_RE: alt, src, optional quoted title. Single
// negated character classes only — linear on adversarial input.
const IMAGE_MD_G_RE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:[ \t]+"([^"\n]*)")?\)/g;

function mediaDescriptor(src, caption) {
  return { type: '_media', src: src || '', caption: (caption || '').trim() };
}

// Pull image markdown out of a raw text span (used for wrapper bodies
// that arrive as one opaque html token).
function extractMediaItems(text) {
  const items = [];
  IMAGE_MD_G_RE.lastIndex = 0;
  let m;
  while ((m = IMAGE_MD_G_RE.exec(text)) !== null) {
    items.push(mediaDescriptor(m[2], m[1] || m[3]));
  }
  return items;
}

// True if any inline token in the subtree is an image or a media
// wrapper tag — the cheap pre-check that lets media-free paragraphs
// keep the existing single-plainTextOf path untouched.
function inlineHasMedia(tokens) {
  for (const t of tokens || []) {
    if (t.type === 'image') return true;
    if (t.type === 'html' && MEDIA_WRAP_RE.test(t.raw || t.text || '')) return true;
    if (Array.isArray(t.tokens) && inlineHasMedia(t.tokens)) return true;
  }
  return false;
}

// Split a paragraph's inline tokens into paragraph text runs, _media
// descriptors, and _mediaGroup spans (inline <tg-collage>…</tg-collage>
// on one line). Recurses only into bare 'text' containers (marked nests
// list-item content that way); images inside links/bold stay flattened
// to their alt text by plainTextOf — splitting mid-link would produce
// stranger output than the flattening does.
function blocksFromInlineTokens(inlineTokens) {
  const out = [];
  let textRun = [];
  let group = null;
  const flushText = () => {
    if (!textRun.length) return;
    const text = plainTextOf(textRun);
    textRun = [];
    if (text.trim()) out.push({ type: 'paragraph', text });
  };
  const walk = (tokens) => {
    for (const t of tokens || []) {
      if (t.type === 'image') {
        const d = mediaDescriptor(t.href, plainTextOf(t.tokens) || t.text || t.title);
        if (group) group.items.push(d);
        else { flushText(); out.push(d); }
      } else if (t.type === 'html') {
        const raw = t.raw || t.text || '';
        const open = MEDIA_WRAP_OPEN_RE.exec(raw);
        if (!group && open && !MEDIA_WRAP_CLOSE_RE.test(raw)) {
          flushText();
          group = { type: '_mediaGroup', kind: open[1].toLowerCase(), items: [] };
        } else if (group && MEDIA_WRAP_CLOSE_RE.test(raw)) {
          if (group.items.length) out.push(group);
          group = null;
        } else {
          textRun.push(t);
        }
      } else if (t.type === 'text' && Array.isArray(t.tokens) && inlineHasMedia(t.tokens)) {
        walk(t.tokens);
      } else {
        textRun.push(t);
      }
    }
  };
  walk(inlineTokens);
  // Unclosed inline wrapper: keep whatever images it collected rather
  // than dropping content.
  if (group && group.items.length) out.push(group);
  flushText();
  return out;
}

// Convert one marked block-level token into zero or more RichBlock
// objects. Returns an array (a single markdown token can occasionally
// need zero blocks — e.g. a bare 'space' token — or, in principle,
// more than one).
function blockFromToken(token) {
  switch (token.type) {
    case 'paragraph': {
      if (inlineHasMedia(token.tokens)) {
        return blocksFromInlineTokens(token.tokens);
      }
      const text = plainTextOf(token.tokens);
      if (!text.trim()) return [];
      return [{ type: 'paragraph', text }];
    }
    case 'heading': {
      const size = Math.min(6, Math.max(1, token.depth || 1));
      return [{ type: 'heading', text: plainTextOf(token.tokens), size }];
    }
    case 'code': {
      return [{ type: 'pre', text: token.text || '' }];
    }
    case 'blockquote': {
      const blocks = blocksFromTokens(token.tokens);
      if (!blocks.length) return [];
      return [{ type: 'blockquote', blocks }];
    }
    case 'list': {
      const items = (token.items || []).map((item, i) => listItemFromToken(item, token, i)).filter(Boolean);
      if (!items.length) return [];
      return [{ type: 'list', items }];
    }
    case 'table': {
      const cellAlignment = (column) => {
        const align = token.align?.[column];
        return align === 'center' || align === 'right' ? align : 'left';
      };
      const headerRow = (token.header || []).map((cell, column) => ({
        text: plainTextOf(cell.tokens),
        is_header: true,
        align: cellAlignment(column),
        valign: 'top',
      }));
      const rows = (token.rows || []).map((row) =>
        row.map((cell, column) => ({
          text: plainTextOf(cell.tokens),
          align: cellAlignment(column),
          valign: 'top',
        })));
      const cells = [headerRow, ...rows];
      return [{ type: 'table', cells }];
    }
    case 'hr': {
      return [{ type: 'divider' }];
    }
    case 'html': {
      // Only <details> is handled specially (it's an explicit gate
      // trigger, DETAILS_RE above); any other raw HTML block is NOT
      // passed through verbatim (that would reopen exactly the
      // injection surface escapeHtml closes in format.js) — it's
      // rendered as a plain paragraph with tags stripped, matching
      // the plain-text-only invariant this module holds throughout.
      const src = token.raw || token.text || '';
      const m = DETAILS_BLOCK_RE.exec(src);
      if (m) {
        // An html token can carry content around the <details> span (an
        // HTML block runs until a blank line, so trailing prose or even a
        // second <details> lands in the same token). Emit that content
        // too rather than dropping it with the matched span.
        const out = [];
        const prefix = src.slice(0, m.index).replace(HTML_TAG_STRIP_RE, '').trim();
        if (prefix) out.push({ type: 'paragraph', text: prefix });
        const summary = (m[1] || '').replace(HTML_TAG_STRIP_RE, '').trim();
        const innerMarkdown = (m[2] || '').trim();
        const blocks = innerMarkdown ? blocksFromTokens(_lexer.lexer(innerMarkdown)) : [];
        out.push({
          type: 'details',
          summary: summary || DEFAULT_DETAILS_SUMMARY,
          blocks: blocks.length ? blocks : [{ type: 'paragraph', text: '' }],
          is_open: false,
        });
        const suffix = src.slice(m.index + m[0].length);
        if (suffix.trim()) out.push(...blocksFromTokens(_lexer.lexer(suffix)));
        return out;
      }
      // A whole <tg-collage>/<tg-slideshow> span in one token (GFM
      // produces this when the wrapper body has no blank lines).
      const wrap = MEDIA_WRAP_OPEN_RE.exec(token.raw || token.text || '');
      if (wrap && MEDIA_WRAP_CLOSE_RE.test(token.raw || token.text || '')) {
        const items = extractMediaItems(token.raw || token.text || '');
        if (!items.length) return [];
        return [{ type: '_mediaGroup', kind: wrap[1].toLowerCase(), items }];
      }
      const stripped = (token.text || token.raw || '').replace(HTML_TAG_STRIP_RE, '').trim();
      if (!stripped) return [];
      return [{ type: 'paragraph', text: stripped }];
    }
    case 'space':
      return [];
    default: {
      // Unknown token type — fall back to its flattened text rather
      // than dropping content silently.
      const text = plainTextOf(token.tokens) || token.text || '';
      if (!text.trim()) return [];
      return [{ type: 'paragraph', text }];
    }
  }
}

function listItemFromToken(item, listToken, index) {
  const { inline, blockTokens } = splitListItemTokens(item.tokens);
  const nestedBlocks = blocksFromTokens(blockTokens);
  const blocks = [];
  if (inlineHasMedia(inline)) {
    blocks.push(...blocksFromInlineTokens(inline));
    if (!blocks.length && !nestedBlocks.length) blocks.push({ type: 'paragraph', text: '' });
  } else {
    const leaderText = plainTextOf(inline);
    if (leaderText.trim() || !nestedBlocks.length) blocks.push({ type: 'paragraph', text: leaderText });
  }
  blocks.push(...nestedBlocks);

  const out = { blocks };
  if (item.task) {
    out.has_checkbox = true;
    if (item.checked) out.is_checked = true;
  } else if (listToken.ordered) {
    out.value = (typeof listToken.start === 'number' ? listToken.start : 1) + index;
  }
  return out;
}

// Mirrors format.js's splitItemTokens (BLOCK_TYPES boundary) — a list
// item's tokens are a leading inline run followed by any block-level
// tokens (nested list, code block, etc). Kept separate from format.js's
// copy because rich blocks need nested block arrays rather than HTML.
const LIST_ITEM_BLOCK_TYPES = new Set(['list', 'blockquote', 'code', 'table', 'paragraph', 'space', 'html', 'hr']);

function splitListItemTokens(tokens) {
  const inline = [];
  const blockTokens = [];
  let crossed = false;
  for (const tok of tokens || []) {
    if (LIST_ITEM_BLOCK_TYPES.has(tok.type)) {
      crossed = true;
      blockTokens.push(tok);
    } else if (crossed) {
      blockTokens.push({ type: 'paragraph', tokens: [tok] });
    } else {
      inline.push(tok);
    }
  }
  return { inline, blockTokens };
}

// GFM tokenizes <details>...</details> as a SINGLE 'html' token only when
// there's no blank line inside it; a blank line (very common in
// agent-authored content — a summary line, then a blank line, then the
// body) splits it into separate sibling tokens: an 'html' open token, the
// nested content as normal block tokens, and an 'html' close token. This
// scans the token STREAM (not a single token) for that open/close span so
// details blocks with real paragraph content inside render correctly
// rather than getting silently split into a stray open-tag paragraph +
// unrelated nested blocks + a stray close-tag paragraph.
function blocksFromTokens(tokens) {
  const out = [];
  const list = tokens || [];
  let i = 0;
  while (i < list.length) {
    const t = list[i];
    const raw = t.raw || t.text || '';
    if (t.type === 'html' && DETAILS_OPEN_RE.test(raw) && !DETAILS_CLOSE_RE.test(raw)) {
      const summaryMatch = SUMMARY_TAG_RE.exec(raw);
      const summary = summaryMatch ? summaryMatch[1].replace(HTML_TAG_STRIP_RE, '').trim() : '';
      const inner = [];
      let closeRaw = null;
      let j = i + 1;
      for (; j < list.length; j++) {
        const tj = list[j];
        const rawj = tj.raw || tj.text || '';
        if (tj.type === 'html' && DETAILS_CLOSE_RE.test(rawj)) { closeRaw = rawj; break; }
        inner.push(tj);
      }
      const nestedBlocks = blocksFromTokens(inner);
      // The close tag's html token can carry content on adjacent lines
      // (an HTML block runs until a blank line): text before </details>
      // belongs inside the collapsible body, text after it is ordinary
      // top-level content following the details block.
      let after = '';
      if (closeRaw != null) {
        const cm = DETAILS_CLOSE_RE.exec(closeRaw);
        const before = closeRaw.slice(0, cm.index).replace(HTML_TAG_STRIP_RE, '').trim();
        if (before) nestedBlocks.push({ type: 'paragraph', text: before });
        after = closeRaw.slice(cm.index + cm[0].length);
      }
      out.push({
        type: 'details',
        summary: summary || DEFAULT_DETAILS_SUMMARY,
        blocks: nestedBlocks.length ? nestedBlocks : [{ type: 'paragraph', text: '' }],
        is_open: false,
      });
      if (after.trim()) out.push(...blocksFromTokens(_lexer.lexer(after)));
      i = j + 1; // skip past the close token (or to the end if never closed)
      continue;
    }
    // <tg-collage>/<tg-slideshow> split across tokens by blank lines —
    // same open/close span scan as <details> above. Images among the
    // inner tokens become the group's items; any non-media inner
    // content is emitted after the group rather than dropped.
    if (t.type === 'html' && MEDIA_WRAP_OPEN_RE.test(raw) && !MEDIA_WRAP_CLOSE_RE.test(raw)) {
      const kind = MEDIA_WRAP_OPEN_RE.exec(raw)[1].toLowerCase();
      // An UNCLOSED wrapper with no blank lines arrives as one html
      // token whose raw already contains the image lines — they are
      // not sibling tokens, so the span scan below can't see them.
      // Extract them from the open token itself or they'd be silently
      // dropped when the close tag never arrives (truncated stream,
      // malformed agent output).
      const items = extractMediaItems(raw);
      const inner = [];
      let j = i + 1;
      for (; j < list.length; j++) {
        const tj = list[j];
        const rawj = tj.raw || tj.text || '';
        if (tj.type === 'html' && MEDIA_WRAP_CLOSE_RE.test(rawj)) break;
        inner.push(tj);
      }
      const innerBlocks = blocksFromTokens(inner);
      const rest = [];
      for (const b of innerBlocks) {
        if (b.type === '_media') items.push({ type: '_media', src: b.src, caption: b.caption });
        else if (b.type === '_mediaGroup') items.push(...b.items);
        else rest.push(b);
      }
      if (items.length) out.push({ type: '_mediaGroup', kind, items });
      out.push(...rest);
      i = j + 1;
      continue;
    }
    out.push(...blockFromToken(t));
    i++;
  }
  return out;
}

// ─── Media descriptor substitution ───────────────────────────────────

// Placeholder paragraph text for a media descriptor that isn't (or
// can't be) materialized. Uses the agent's own caption when present —
// never a filesystem-derived basename, which for a rejected path would
// echo the target filename into the visible chat.
function mediaPlaceholderText(d, { unavailable = false } = {}) {
  if (unavailable) return d.caption ? `${d.caption} (media unavailable)` : '(media unavailable)';
  return d.caption ? `📎 ${d.caption}` : '📎 media';
}

// Depth-first, document-order collection of media descriptors across
// the block tree (wrapper children flattened) — the single array
// resolveMedia sees, which is what keeps the message-scoped media cap
// honest.
function collectMediaDescriptors(blocks, list = []) {
  for (const b of blocks || []) {
    if (b.type === '_media') {
      list.push({ src: b.src, caption: b.caption });
    } else if (b.type === '_mediaGroup') {
      for (const it of b.items) list.push({ src: it.src, caption: it.caption });
    } else {
      if (Array.isArray(b.blocks)) collectMediaDescriptors(b.blocks, list);
      if (Array.isArray(b.items)) {
        for (const it of b.items) if (Array.isArray(it.blocks)) collectMediaDescriptors(it.blocks, list);
      }
    }
  }
  return list;
}

const MEDIA_BLOCK_KINDS = new Set(['photo', 'video', 'animation']);

function mediaBlockFrom(result, caption) {
  const kind = MEDIA_BLOCK_KINDS.has(result?.kind) ? result.kind : 'photo';
  const block = { type: kind, [kind]: { type: kind, media: result.media } };
  if (caption) block.caption = { text: caption };
  return block;
}

// Replace descriptor blocks with real media/wrapper blocks
// (when `results` — index-aligned with collectMediaDescriptors order —
// is provided) or with placeholder paragraphs (streaming / no resolver).
// `cursor` threads the shared descriptor index through the recursion.
function substituteMediaBlocks(blocks, results, cursor = { i: 0 }) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === '_media') {
      const r = results ? results[cursor.i] : null;
      cursor.i += 1;
      if (r && r.media) out.push(mediaBlockFrom(r, b.caption));
      else if (results) out.push({ type: 'paragraph', text: mediaPlaceholderText(b, { unavailable: true }) });
      else out.push({ type: 'paragraph', text: mediaPlaceholderText(b) });
    } else if (b.type === '_mediaGroup') {
      if (!results) {
        cursor.i += b.items.length;
        out.push({ type: 'paragraph', text: `📎 ${b.kind} (${b.items.length} media items)` });
        continue;
      }
      const mediaBlocks = [];
      let unavailable = 0;
      for (const it of b.items) {
        const r = results[cursor.i];
        cursor.i += 1;
        if (r && r.media) mediaBlocks.push(mediaBlockFrom(r, it.caption));
        else unavailable += 1;
      }
      if (mediaBlocks.length === 1) out.push(mediaBlocks[0]);
      else if (mediaBlocks.length > 1) out.push({ type: b.kind, blocks: mediaBlocks });
      if (unavailable > 0) {
        out.push({
          type: 'paragraph',
          text: `(${unavailable} media item${unavailable === 1 ? '' : 's'} unavailable)`,
        });
      }
    } else if (Array.isArray(b.blocks) || Array.isArray(b.items)) {
      const clone = { ...b };
      if (Array.isArray(b.blocks)) clone.blocks = substituteMediaBlocks(b.blocks, results, cursor);
      if (Array.isArray(b.items)) {
        clone.items = b.items.map((it) => (Array.isArray(it.blocks)
          ? { ...it, blocks: substituteMediaBlocks(it.blocks, results, cursor) }
          : it));
      }
      out.push(clone);
    } else {
      out.push(b);
    }
  }
  return out;
}

// Count media attachments in an emitted block tree, including wrapper
// and container children — the media_count instrumentation field.
function countMediaBlocks(blocks) {
  let n = 0;
  for (const b of blocks || []) {
    if (MEDIA_BLOCK_KINDS.has(b.type)) n += 1;
    else if (b.type === 'collage' || b.type === 'slideshow') n += countMediaBlocks(b.blocks);
    else {
      if (Array.isArray(b.blocks)) n += countMediaBlocks(b.blocks);
      if (Array.isArray(b.items)) {
        for (const it of b.items) if (Array.isArray(it.blocks)) n += countMediaBlocks(it.blocks);
      }
    }
  }
  return n;
}

// Project media markdown out of plain fallback text: image syntax
// degrades to its caption text, wrapper tags disappear, and a dangling
// UNTERMINATED trailing image fragment ("![shot](/User…" still being
// streamed, or malformed output missing its ")") is cut — the fragment
// is exactly the shape that carries a raw absolute path, and it's what
// live plain previews would otherwise render before the rich upgrade
// kicks in. Fenced code is left untouched (image syntax inside a fence
// is literal content). Used on every plain-text surface a rich-enabled
// chat's reply can reach: live preview edits, fallback edits, and
// chunked redelivery.
const MEDIA_WRAP_TAG_G_RE = /<\/?tg-(?:collage|slideshow)(?:[ \t][^>]*)?>/gi;
// An image opener at end-of-line that never completed: "![", "![alt",
// "![alt]", "![alt](", "![alt](/partial/pa…". Single negated classes,
// optional groups anchored at $ — linear.
const TRAILING_IMAGE_FRAGMENT_RE = /!\[[^\]\n]*(?:\][ \t]*(?:\([^)\n]*)?)?$/;

function stripMediaMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return markdown;
  if (markdown.indexOf('![') === -1 && markdown.indexOf('<tg-') === -1) return markdown;
  const lines = markdown.split('\n');
  const out = [];
  // Fence tracking mirrors stripFencedCodeBlocks (same open/close
  // semantics) but keeps every line — only non-fenced lines are
  // rewritten.
  let fence = null;
  for (const line of lines) {
    const m = FENCE_LINE_RE.exec(line);
    if (m) {
      const marker = m[1];
      const trailing = line.slice(m[0].length);
      if (!fence) fence = { char: marker[0], len: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.len && trailing.trim() === '') fence = null;
      out.push(line);
      continue;
    }
    if (fence) { out.push(line); continue; }
    IMAGE_MD_G_RE.lastIndex = 0;
    let clean = line
      .replace(IMAGE_MD_G_RE, (_all, alt, _src, title) => (alt || title || '').trim())
      .replace(MEDIA_WRAP_TAG_G_RE, '');
    // Only a fragment on the FINAL line can still be completed by
    // text that hasn't streamed in yet; earlier lines can't (image
    // syntax never spans lines), so a fragment there is plain
    // malformed output — cut it the same way.
    clean = clean.replace(TRAILING_IMAGE_FRAGMENT_RE, '');
    out.push(clean);
  }
  const projected = out.join('\n');
  return projected.trim() ? projected : '';
}

/**
 * toTelegramRichBlocks(markdown, opts) -> { blocks: RichBlock[], usedRich: boolean }
 *
 * opts.partial (boolean, default false) — streaming mode: when true, the
 * last top-level block is held back rather than emitted. Growing text
 * may have cut it off mid-structure (an unclosed table,
 * a dangling list item). The caller re-calls this on every chunk, so the
 * held-back tail simply appears (complete) on a later call once the
 * source text has moved past it. Only applies when there's more than one
 * top-level block — a single in-progress block is emitted as-is rather
 * than producing an empty array (better to show a resizing paragraph
 * than nothing).
 *
 * opts.resolveMedia (descriptors: [{src, caption}]) -> results[] —
 * index-aligned with the descriptors; each accepted result is
 * `{ kind, media }`, where media is an https URL string or a JSON-safe
 * `{ source, fingerprint, fileId? }` envelope that rich-edit.js validates
 * before using a cached ID or materializing a grammy InputFile. Rejections
 * carry `{ rejected }`. NEVER called in partial mode — streaming ticks
 * must not touch the filesystem; media renders as placeholder
 * paragraphs until finalize. Absent resolver → placeholders too.
 * When media was the ONLY gate trigger and none of it resolved, the
 * whole render demotes to `usedRich: false` so prose doesn't ship as
 * oversized rich paragraphs.
 */
function toTelegramRichBlocks(markdown, opts = {}) {
  const usedRich = needsRichRendering(markdown);
  if (!usedRich) return { blocks: [], usedRich: false };

  const tokens = _lexer.lexer(markdown);
  let blocks = blocksFromTokens(tokens);

  const descriptors = collectMediaDescriptors(blocks);
  let results = null;
  let resolvedCount = 0;
  if (descriptors.length && !opts.partial && typeof opts.resolveMedia === 'function') {
    try {
      const r = opts.resolveMedia(descriptors);
      if (Array.isArray(r)) {
        results = r;
        resolvedCount = r.filter((x) => x && x.media).length;
      }
    } catch {
      results = null; // resolver failure degrades to placeholders, never crashes the reply
    }
  }
  if (descriptors.length) {
    blocks = substituteMediaBlocks(blocks, results);
  }

  if (opts.partial && blocks.length > 1) {
    blocks = blocks.slice(0, -1);
  }

  if (descriptors.length && !opts.partial && resolvedCount === 0
      && !hasNonMediaTrigger(stripFencedCodeBlocks(markdown))) {
    return { blocks: [], usedRich: false };
  }

  // An empty rich payload is never sendable (Telegram rejects
  // rich_message with no blocks; api.js refuses it before the call) —
  // whatever produced it, plain is the honest degrade.
  if (!blocks.length) return { blocks: [], usedRich: false };

  return { blocks, usedRich: true };
}

// ─── Error classification ────────────────────────────────────────────
//
// Capability errors (endpoint missing) latch
// rich off permanently for this process; content errors (this payload
// specifically) fall back once, never latch. An error matching NEITHER
// must be treated as transient and fall through to the existing retry
// path in api.js.

// Unsupported new endpoints normally return 404. The existing
// editMessageText endpoint can instead reject its `rich_message`
// parameter with an unknown/unsupported-field response, so both shapes
// identify a missing rich-message capability.
//
// "rich message must be non-empty" is a capability shape too, observed
// live on a Bot API 10.1 self-hosted server: it accepts sendRichMessage
// but predates the 10.2 `blocks` field, silently ignores it, and sees
// an "empty" InputRichMessage. api.js refuses genuinely empty payloads
// before any network call, so this response to a payload we sent can
// only mean the server cannot read typed blocks — latch, don't retry.
const RICH_CAPABILITY_ERR_RE = /method\s*["']?(?:sendRichMessage|sendRichMessageDraft|editMessageText)["']?\s*not found|no such method|unknown method|method not found|(?:unknown|unsupported|unrecognized)\s+(?:parameter|field)s?\s*["']?rich_message["']?|rich_message\s*["']?\s*(?:is\s+)?(?:unknown|unsupported|unrecognized|not\s+supported)|rich message must be non-empty/i;

function errorMessage(err) {
  if (!err) return '';
  return String(err.description || err.message || err.error_message || err);
}

function isRichCapabilityError(err) {
  if (!err) return false;
  const msg = errorMessage(err);
  if (RICH_CAPABILITY_ERR_RE.test(msg)) return true;
  // A 404 is sufficient because these checks only wrap rich-message calls.
  const status = err.error_code ?? err.status ?? err.statusCode;
  return status === 404;
}

const RICH_CONTENT_ERR_RE = /RICH_MESSAGE_[A-Z_]+|can'?t parse (?:input)?rich\s*block|rich message.*(?:too (?:many|long)|invalid)|wrong remote file identifier specified/i;

function isRichContentError(err) {
  if (!err) return false;
  return RICH_CONTENT_ERR_RE.test(errorMessage(err));
}

module.exports = {
  needsRichRendering,
  toTelegramRichBlocks,
  resolveRichTextEnabled,
  isRichCapabilityError,
  isRichContentError,
  errorMessage,
  stripMediaMarkdown,
  countMediaBlocks,
  // exported for tests / introspection, not part of the public contract
  _plainTextOf: plainTextOf,
  _blocksFromTokens: blocksFromTokens,
  _stripFencedCodeBlocks: stripFencedCodeBlocks,
  _collectMediaDescriptors: collectMediaDescriptors,
};

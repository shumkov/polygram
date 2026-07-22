/**
 * Markdown → Telegram Bot API Rich Message blocks.
 *
 * Companion to format.js's markdown→HTML pipeline, not a replacement:
 * this only runs when needsRichRendering() finds a construct (task list,
 * table, <details>, heading, blockquote, divider) that the plain HTML
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

function needsRichRendering(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return false;
  const scoped = stripFencedCodeBlocks(markdown);
  return TASK_ITEM_RE.test(scoped)
      || TABLE_ROW_RE.test(scoped)
      || DETAILS_RE.test(scoped)
      || HEADING_RE.test(scoped)
      || BLOCKQUOTE_RE.test(scoped)
      || DIVIDER_RE.test(scoped);
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

// Convert one marked block-level token into zero or more RichBlock
// objects. Returns an array (a single markdown token can occasionally
// need zero blocks — e.g. a bare 'space' token — or, in principle,
// more than one).
function blockFromToken(token) {
  switch (token.type) {
    case 'paragraph': {
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
      const m = DETAILS_BLOCK_RE.exec(token.raw || token.text || '');
      if (m) {
        const summary = (m[1] || '').replace(HTML_TAG_STRIP_RE, '').trim();
        const innerMarkdown = (m[2] || '').trim();
        const blocks = innerMarkdown ? blocksFromTokens(_lexer.lexer(innerMarkdown)) : [];
        return [{
          type: 'details',
          summary: summary || DEFAULT_DETAILS_SUMMARY,
          blocks: blocks.length ? blocks : [{ type: 'paragraph', text: '' }],
          is_open: false,
        }];
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
  const leaderText = plainTextOf(inline);
  const nestedBlocks = blocksFromTokens(blockTokens);
  const blocks = [];
  if (leaderText.trim() || !nestedBlocks.length) blocks.push({ type: 'paragraph', text: leaderText });
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
      let j = i + 1;
      for (; j < list.length; j++) {
        const tj = list[j];
        const rawj = tj.raw || tj.text || '';
        if (tj.type === 'html' && DETAILS_CLOSE_RE.test(rawj)) break;
        inner.push(tj);
      }
      const nestedBlocks = blocksFromTokens(inner);
      out.push({
        type: 'details',
        summary: summary || DEFAULT_DETAILS_SUMMARY,
        blocks: nestedBlocks.length ? nestedBlocks : [{ type: 'paragraph', text: '' }],
        is_open: false,
      });
      i = j + 1; // skip past the close token (or to the end if never closed)
      continue;
    }
    out.push(...blockFromToken(t));
    i++;
  }
  return out;
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
 */
function toTelegramRichBlocks(markdown, opts = {}) {
  const usedRich = needsRichRendering(markdown);
  if (!usedRich) return { blocks: [], usedRich: false };

  const tokens = _lexer.lexer(markdown);
  let blocks = blocksFromTokens(tokens);

  if (opts.partial && blocks.length > 1) {
    blocks = blocks.slice(0, -1);
  }

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
const RICH_CAPABILITY_ERR_RE = /method\s*["']?(?:sendRichMessage|sendRichMessageDraft|editMessageText)["']?\s*not found|no such method|unknown method|method not found|(?:unknown|unsupported|unrecognized)\s+(?:parameter|field)s?\s*["']?rich_message["']?|rich_message\s*["']?\s*(?:is\s+)?(?:unknown|unsupported|unrecognized|not\s+supported)/i;

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

const RICH_CONTENT_ERR_RE = /RICH_MESSAGE_[A-Z_]+|can'?t parse (?:input)?rich\s*block|rich message.*(?:too (?:many|long)|invalid)/i;

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
  // exported for tests / introspection, not part of the public contract
  _plainTextOf: plainTextOf,
  _blocksFromTokens: blocksFromTokens,
  _stripFencedCodeBlocks: stripFencedCodeBlocks,
};

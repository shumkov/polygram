'use strict';

/**
 * Inbound rich messages → plain text.
 *
 * Telegram delivers a rich message as `Message.rich_message`
 * ({ blocks: RichBlock[] }) with no `text` and no `caption`. Everything
 * after intake (the stored row, the gate, the prompt, replay, history) reads
 * `msg.text`, so intake renders the block tree into it once.
 *
 * The output is plain text with just enough markdown structure (headings,
 * list markers, quotes, code fences, table rows, link targets) for the agent
 * to read the message the way the user saw it. Media inside blocks is not
 * downloaded; a placeholder says it was there and was not attached.
 *
 * The outbound direction (markdown → blocks) lives in ./rich.js. Its
 * flattenRichText keeps only the visible text, which is right for a styling
 * retry but loses what the agent needs here: link targets, custom-emoji alt
 * text and math expressions.
 */

const { surrogateSafeCut } = require('./chunk');

// Telegram allows 16 levels of nested formatting and blocks. Blocks, inline
// nodes and the arrays wrapping them each count one level here, so legal
// input can reach about 33; past 64 the tree is malformed and that branch
// stops rendering instead of recursing further.
const MAX_DEPTH = 64;

// Quote prefixes and list indents repeat per nesting level, so a message
// within Telegram's own 32,768-character limit can render many times larger.
// Hold the rendered text to that same budget.
const MAX_RENDERED_CHARS = 32_768;
const TRUNCATED_MARKER = '\n[rich message truncated]';

// Every rendered message starts with this line. Command, abort and pairing
// matchers all anchor at the start of the text, so content the sender may
// not even have seen (a collapsed details block, say) can never be read as
// "/new" or "stop". It also tells the agent the text was derived from blocks.
const RICH_TEXT_HEADER = '[rich message]';

function str(v) {
  return typeof v === 'string' ? v : '';
}

function inlineText(node, depth = 0) {
  if (node == null || depth > MAX_DEPTH) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => inlineText(n, depth + 1)).join('');
  if (typeof node !== 'object') return '';
  switch (node.type) {
    case 'custom_emoji': return str(node.alternative_text);
    case 'mathematical_expression': return node.expression ? `$${str(node.expression)}$` : '';
    case 'button': return buttonText(node.button, depth + 1);
    case 'anchor': return '';
    case 'url': {
      const label = inlineText(node.text, depth + 1);
      const url = str(node.url);
      // Keep the link target: the agent can't click the visible label.
      if (!url || url === label) return label;
      return label ? `[${label}](${url})` : url;
    }
    default: return inlineText(node.text, depth + 1);
  }
}

function buttonText(button, depth = 0) {
  const label = `[button: ${inlineText(button?.text, depth)}]`;
  return str(button?.url) ? `${label}(${button.url})` : label;
}

// RichBlockCaption is { text, credit? }; a table caption is bare RichText.
function captionText(caption, depth) {
  if (caption && typeof caption === 'object' && !Array.isArray(caption) && caption.type == null) {
    const text = inlineText(caption.text, depth);
    const credit = inlineText(caption.credit, depth);
    return credit ? `${text} — ${credit}` : text;
  }
  return inlineText(caption, depth);
}

// Every line gets a marker, blank ones included, so a multi-paragraph quote
// stays one quote.
function quote(body, credit, depth) {
  const by = inlineText(credit, depth);
  return [body, by && `— ${by}`].filter(Boolean).join('\n')
    .split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
}

function renderList(items, depth) {
  if (!Array.isArray(items)) return '';
  return items.map((item) => {
    if (!item || typeof item !== 'object') return '';
    const box = item.has_checkbox ? (item.is_checked ? '[x] ' : '[ ] ') : '';
    const head = `${str(item.label) || '-'} ${box}`;
    const body = renderBlocks(item.blocks, depth, '\n');
    const [first = '', ...rest] = body.split('\n');
    return [(head + first).trimEnd(), ...rest.map((line) => (line ? `  ${line}` : line))].join('\n');
  }).filter(Boolean).join('\n');
}

function renderTable(block, depth) {
  const rows = Array.isArray(block.cells) ? block.cells : [];
  const lines = rows.map((row) => (Array.isArray(row) ? row : []).flatMap((cell) => {
    const text = inlineText(cell?.text, depth).replace(/\n+/g, ' ');
    // Pad a column-spanning cell so the cells after it in the row stay under
    // their headers. Row spans are not reconstructed.
    const span = Math.min(Math.max(Math.trunc(Number(cell?.colspan)) || 1, 1), 20);
    return [text, ...Array(span - 1).fill('')];
  }).join(' | '));
  return [captionText(block.caption, depth), ...lines].filter(Boolean).join('\n');
}

// A fence longer than any backtick run in the code, so the code can't close it.
function fence(code, language) {
  const longest = (code.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${code}\n${ticks}`;
}

function mediaLabel(block) {
  const media = block[block.type];
  const named = (kind, name) => (name ? `${kind}: ${name}` : kind);
  let label;
  switch (block.type) {
    case 'photo': label = 'photo'; break;
    case 'animation': label = 'animation'; break;
    case 'voice_note': label = 'voice'; break;
    case 'video': label = named('video', str(media?.file_name)); break;
    case 'audio': label = named('audio', str(media?.title) || str(media?.file_name)); break;
    case 'document': label = named('document', str(media?.file_name)); break;
    default: return null;
  }
  return `[${label} — not attached]`;
}

function renderBlock(block, depth) {
  if (!block || typeof block !== 'object' || depth > MAX_DEPTH) return '';
  const media = mediaLabel(block);
  if (media) {
    const caption = captionText(block.caption, depth);
    return caption ? `${media} ${caption}` : media;
  }
  switch (block.type) {
    case 'paragraph':
    case 'footer':
      return inlineText(block.text, depth);
    case 'heading': {
      const text = inlineText(block.text, depth);
      const level = Math.min(6, Math.max(1, Math.trunc(Number(block.size)) || 1));
      return text && `${'#'.repeat(level)} ${text}`;
    }
    case 'pre':
      return fence(inlineText(block.text, depth), str(block.language).replace(/[\s`]/g, ''));
    case 'divider':
      return '---';
    case 'mathematical_expression':
      return block.expression ? `$$${str(block.expression)}$$` : '';
    case 'anchor':
      return '';
    case 'list':
      return renderList(block.items, depth);
    case 'blockquote':
      return quote(renderBlocks(block.blocks, depth), block.credit, depth);
    case 'expandable_blockquote':
    case 'pullquote':
      return quote(inlineText(block.text, depth), block.credit, depth);
    case 'collage':
    case 'slideshow':
      return [renderBlocks(block.blocks, depth), captionText(block.caption, depth)].filter(Boolean).join('\n');
    case 'table':
      return renderTable(block, depth);
    case 'details':
      return [inlineText(block.summary, depth), renderBlocks(block.blocks, depth)].filter(Boolean).join('\n');
    case 'map': {
      const loc = block.location;
      const where = loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)
        ? `[map: ${loc.latitude},${loc.longitude}]`
        : '[map]';
      const caption = captionText(block.caption, depth);
      return caption ? `${where} ${caption}` : where;
    }
    case 'buttons':
      return (Array.isArray(block.buttons) ? block.buttons : [])
        .map((button) => buttonText(button, depth))
        .join(' ');
    default: {
      // A block type newer than this renderer: keep whatever readable content
      // it carries rather than dropping the message's text on the floor.
      const parts = [
        inlineText(block.text, depth),
        renderBlocks(block.blocks, depth),
        renderList(block.items, depth),
        captionText(block.caption, depth),
      ].filter(Boolean);
      if (parts.length) return parts.join('\n');
      return typeof block.type === 'string' ? `[${block.type}]` : '';
    }
  }
}

function renderBlocks(blocks, depth, separator = '\n\n') {
  if (!Array.isArray(blocks) || depth > MAX_DEPTH) return '';
  return blocks.map((b) => renderBlock(b, depth + 1)).filter(Boolean).join(separator);
}

/**
 * Render a RichMessage ({ blocks, is_rtl? }) to plain text. Never throws on
 * malformed input; returns '' when there is nothing readable.
 */
function richMessageToText(richMessage) {
  if (!richMessage || typeof richMessage !== 'object') return '';
  const text = renderBlocks(richMessage.blocks, 0).trim();
  if (text.length <= MAX_RENDERED_CHARS) return text;
  return text.slice(0, surrogateSafeCut(text, MAX_RENDERED_CHARS)) + TRUNCATED_MARKER;
}

function renderInto(msg) {
  if (!msg || typeof msg !== 'object' || msg.text || msg.caption || !msg.rich_message) return;
  const text = richMessageToText(msg.rich_message);
  if (text) msg.text = `${RICH_TEXT_HEADER}\n${text}`;
}

/**
 * Give a rich message (and the rich message it replies to) a `text`, so
 * every reader after intake sees its content. Mutates and returns `msg`.
 * A message that already has `text` or `caption` is left alone.
 *
 * A rich message sent by another bot stays without text, as before: AI bots
 * reply in rich messages, and dispatching them would let two bots in a group
 * answer each other turn after turn. A user forwarding a bot's message is
 * the sender here, so forwards still render. So do anonymous admins and
 * channel posts: Telegram sends those from a placeholder bot account with
 * `sender_chat` set, but a person wrote them.
 */
function normalizeRichInbound(msg, { logger = console } = {}) {
  const fromOtherBot = msg?.from?.is_bot === true && !msg?.sender_chat;
  const targets = [fromOtherBot ? null : msg, msg?.reply_to_message];
  for (const target of targets) {
    try {
      renderInto(target);
    } catch (err) {
      logger.error?.(`rich message ${target?.message_id ?? '?'} could not be rendered: ${err?.message || err}`);
    }
  }
  return msg;
}

module.exports = {
  richMessageToText,
  normalizeRichInbound,
  RICH_TEXT_HEADER,
  MAX_RENDERED_CHARS,
};

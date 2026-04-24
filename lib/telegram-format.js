/**
 * Convert Claude's CommonMark output into Telegram-safe MarkdownV2.
 *
 * Why: Claude emits standard GitHub-flavoured markdown (headings, bullets,
 * `**bold**`, fenced code). Telegram does NOT support headings or bullet
 * lists natively; `**bold**` is `*bold*` in its dialect; and MarkdownV2
 * requires escaping `_*[]()~\`>#+-=|{}.!` in non-formatted text. Sending
 * Claude's raw markdown with no parse_mode shows literal `**` and `#`
 * in chat; sending it with parse_mode: MarkdownV2 crashes with "can't
 * parse entities" the moment Claude writes a period or exclamation mark.
 *
 * telegramify-markdown handles both concerns: downgrades unsupported
 * constructs (headings → bold, bullets → `•`) and escapes reserved chars.
 *
 * We wrap it here rather than calling it inline so:
 *   - Swapping libraries later is a one-file change.
 *   - Fallback-on-throw is centralised (if conversion explodes, we send
 *     the original text with no parse_mode — worse formatting, but the
 *     message still arrives).
 */

const telegramify = require('telegramify-markdown');

function toTelegramMarkdown(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, parseMode: null };
  }
  try {
    const converted = telegramify(text, 'escape');
    return { text: converted, parseMode: 'MarkdownV2' };
  } catch {
    return { text, parseMode: null };
  }
}

module.exports = { toTelegramMarkdown };

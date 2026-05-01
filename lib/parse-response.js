/**
 * Parse Claude's final-turn text into one of three outbound shapes:
 *   - sticker (single emoji that maps to a sticker, OR literal
 *     `[sticker:NAME]` mimic — see below)
 *   - reaction (single emoji not mapped to a sticker)
 *   - text (everything else, with inline `[sticker:NAME]` markers
 *     extracted into a parallel `stickers[]` array)
 *
 * Why this lives in lib/: polygram.js is a top-level script (calls main()
 * at bottom) and can't be require()'d from a test without starting a bot.
 * Pulling parseResponse out lets tests cover the regex edge cases.
 *
 * 0.7.5 (item: sticker regression):
 * deriveOutboundText (lib/telegram.js) synthesises `[sticker:<name>]` for
 * sendSticker calls so the messages.text column has *something* legible.
 * On session resume Claude reads its own past assistant rows and sees
 * `[sticker:working]` as the assistant message text — and starts mimicking
 * the format LITERALLY, emitting the string `[sticker:working]` as plain
 * text. parseResponse used to fall through to the chunked-text path, so
 * the placeholder ended up rendered in the user's chat instead of an
 * actual sticker.
 *
 * 0.8.0-rc.39 (item: inline sticker regression):
 * Claude evolved to use `[sticker:NAME]` INLINE within longer replies
 * (e.g. "Done! [sticker:pumped]\n\nStripe Mar 2026 created ✅\n…") —
 * not as a solo response. The 0.7.5 fix only handled the solo case
 * (full text = tag), so inline tags leaked through the text path
 * verbatim. Now we extract every recognised inline tag, strip it
 * from the text, and surface them in a `stickers[]` array on the
 * result. polygram.js sends the cleaned text first, then each
 * sticker in order. Unknown sticker names still pass through as
 * literal text (someone may genuinely write that string).
 *
 * Match shape: `[sticker:` NAME `]` where NAME is `[A-Za-z0-9_-]+`.
 * The solo-form regex anchors with `^\s*…\s*$`; the inline-form
 * regex is unanchored and global. Both share the same NAME charset.
 */

'use strict';

const STICKER_TAG_RE = /^\s*\[sticker:([A-Za-z0-9_-]+)\]\s*$/;
const STICKER_TAG_INLINE_RE = /\[sticker:([A-Za-z0-9_-]+)\]/g;

function parseResponse(text, { stickerMap = {}, emojiToSticker = {} } = {}) {
  const trimmed = (text || '').trim();

  // Solo-sticker path: entire response is just the tag.
  const tagMatch = trimmed.match(STICKER_TAG_RE);
  if (tagMatch) {
    const name = tagMatch[1];
    const fileId = stickerMap[name];
    if (fileId) {
      return {
        text: '',
        sticker: fileId,
        stickerLabel: name,
        reaction: null,
        stickers: [],
      };
    }
  }

  // Solo-emoji shortcuts (single emoji → sticker if mapped, else reaction).
  const emojiOnly = /^\p{Emoji_Presentation}$/u.test(trimmed)
    || /^\p{Emoji}️?$/u.test(trimmed);

  if (emojiOnly && trimmed) {
    if (emojiToSticker[trimmed]) {
      return {
        text: '',
        sticker: emojiToSticker[trimmed],
        stickerLabel: trimmed,
        reaction: null,
        stickers: [],
      };
    }
    return {
      text: '',
      sticker: null,
      stickerLabel: null,
      reaction: trimmed,
      stickers: [],
    };
  }

  // Inline sticker extraction. Walk every `[sticker:NAME]` in the text;
  // for each NAME present in stickerMap, push to `stickers[]` and remove
  // it from the cleaned text. Unknown NAMEs stay verbatim (someone may
  // genuinely write that string in a message).
  //
  // Whitespace handling: replacing a tag with the empty string can leave
  // a trailing space on its line ("Done! [sticker:x]" → "Done! ") or
  // stack newlines if the tag stood alone on a line. We strip trailing
  // whitespace per-line and collapse runs of 3+ blank lines to 2. We do
  // NOT touch intra-line spacing or code-block indentation.
  const stickers = [];
  const cleaned = trimmed.replace(STICKER_TAG_INLINE_RE, (match, name) => {
    const fileId = stickerMap[name];
    if (fileId) {
      stickers.push({ fileId, name });
      return '';
    }
    return match;
  });
  const tidied = cleaned
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text: tidied,
    sticker: null,
    stickerLabel: null,
    reaction: null,
    stickers,
  };
}

module.exports = { parseResponse, STICKER_TAG_RE, STICKER_TAG_INLINE_RE };

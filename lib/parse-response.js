/**
 * Parse Claude's final-turn text into one of three outbound shapes:
 *   - sticker (single emoji that maps to a sticker, OR literal
 *     `[sticker:NAME]` mimic — see below)
 *   - reaction (single emoji not mapped to a sticker)
 *   - text (everything else)
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
 * Match shape: optional whitespace, `[sticker:`, NAME (alnum/_/-), `]`,
 * optional whitespace. NAME must resolve in the supplied stickerMap;
 * unknown NAMEs fall through to the text path so a genuine
 * "[sticker:foo]" message (e.g. someone joking, or a stale name from an
 * older deploy) still reaches the user verbatim.
 */

const STICKER_TAG_RE = /^\s*\[sticker:([A-Za-z0-9_-]+)\]\s*$/;

function parseResponse(text, { stickerMap = {}, emojiToSticker = {} } = {}) {
  const trimmed = (text || '').trim();

  const tagMatch = trimmed.match(STICKER_TAG_RE);
  if (tagMatch) {
    const name = tagMatch[1];
    const fileId = stickerMap[name];
    if (fileId) {
      return { text: '', sticker: fileId, stickerLabel: name, reaction: null };
    }
  }

  const emojiOnly = /^\p{Emoji_Presentation}$/u.test(trimmed)
    || /^\p{Emoji}️?$/u.test(trimmed);

  if (emojiOnly && trimmed) {
    if (emojiToSticker[trimmed]) {
      return { text: '', sticker: emojiToSticker[trimmed], stickerLabel: trimmed, reaction: null };
    }
    return { text: '', sticker: null, stickerLabel: null, reaction: trimmed };
  }

  return { text: trimmed, sticker: null, stickerLabel: null, reaction: null };
}

module.exports = { parseResponse, STICKER_TAG_RE };

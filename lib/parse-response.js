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

// rc.63: agents started using `[react:EMOJI]` to add a Telegram
// reaction on the user's message inline with their text reply (e.g.
// "Да, вижу! [react:👍]"). The single-emoji-only-reply path documented
// in polygram-info system prompt was the only supported way to send
// a reaction; agents inventively extended the sticker tag pattern
// to reactions and polygram leaked the literal text. Mirror the
// sticker handling: solo + inline forms, extract the emoji, return
// in `reactions[]` for polygram to apply via setMessageReaction.
//
// Match shape: `[react:` EMOJI `]` where EMOJI is any single-glyph
// content that's not `]`. We deliberately don't restrict the emoji
// charset here — Telegram's API does the validation, and a broad
// match keeps regional/skin-tone modifiers working without
// maintaining a Telegram-supported emoji whitelist that would drift.
const REACT_TAG_RE = /^\s*\[react:([^\]]+)\]\s*$/;
const REACT_TAG_INLINE_RE = /\[react:([^\]]+)\]/g;

function parseResponse(text, { stickerMap = {}, emojiToSticker = {} } = {}) {
  const trimmed = (text || '').trim();

  // Solo react-tag: entire response is just `[react:EMOJI]`.
  // Same shape as the existing solo-emoji shortcut, just with the
  // explicit tag form the agent invented.
  const reactSolo = trimmed.match(REACT_TAG_RE);
  if (reactSolo) {
    return {
      text: '',
      sticker: null,
      stickerLabel: null,
      reaction: reactSolo[1].trim(),
      stickers: [],
      reactions: [],
    };
  }

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
        reactions: [],
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
        reactions: [],
      };
    }
    return {
      text: '',
      sticker: null,
      stickerLabel: null,
      reaction: trimmed,
      stickers: [],
      reactions: [],
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
  const reactions = [];
  let cleaned = trimmed.replace(STICKER_TAG_INLINE_RE, (match, name) => {
    const fileId = stickerMap[name];
    if (fileId) {
      stickers.push({ fileId, name });
      return '';
    }
    return match;
  });
  // rc.63: also extract inline `[react:EMOJI]` tags. Telegram bots
  // can place at most one emoji reaction per message (Premium bots
  // can place more, but we don't assume that capability), so we
  // collect all matches into `reactions[]` and let polygram pick
  // (typically the first one). Tags are always stripped from the
  // visible text regardless.
  cleaned = cleaned.replace(REACT_TAG_INLINE_RE, (_match, emoji) => {
    reactions.push(emoji.trim());
    return '';
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
    reactions,
  };
}

module.exports = { parseResponse, STICKER_TAG_RE, STICKER_TAG_INLINE_RE, REACT_TAG_RE, REACT_TAG_INLINE_RE };

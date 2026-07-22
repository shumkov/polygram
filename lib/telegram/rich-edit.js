/**
 * Rich-message edit-with-fallback. Capability and content errors preserve
 * the reply through a plain edit; transient errors remain visible to the
 * streamer's retry/finalization logic.
 *
 * Media handling: blocks arrive JSON-safe — local files as
 * `{ source: '<realpath>' }` envelopes at photo.media (rich.js emits
 * them that way because the streamer dedups payloads via JSON.stringify,
 * which a grammy InputFile would break: its toJSON throws by design).
 * The envelope→InputFile materialization happens HERE, on a cloned
 * tree, immediately before each send attempt — so the caller's blocks
 * stay serializable and every retry gets a fresh path-backed InputFile.
 * Fallback edits go through sanitizeFallbackText so a media-bearing
 * reply degrades without rendering absolute local paths into the chat.
 */

'use strict';

const { countMediaBlocks } = require('./rich');

// Clone the block tree, replacing { source } envelopes at photo.media
// with uploadable files. Only the photo-block envelope shape is
// materialized — everything else passes through untouched.
function materializeMediaBlocks(blocks, makeInputFile) {
  return (blocks || []).map((b) => {
    if (b && b.type === 'photo'
        && b.photo && typeof b.photo === 'object'
        && b.photo.media && typeof b.photo.media === 'object'
        && typeof b.photo.media.source === 'string') {
      return { ...b, photo: { ...b.photo, media: makeInputFile(b.photo.media.source) } };
    }
    if (b && Array.isArray(b.blocks)) {
      return { ...b, blocks: materializeMediaBlocks(b.blocks, makeInputFile) };
    }
    if (b && Array.isArray(b.items)) {
      return {
        ...b,
        items: b.items.map((it) => (it && Array.isArray(it.blocks)
          ? { ...it, blocks: materializeMediaBlocks(it.blocks, makeInputFile) }
          : it)),
      };
    }
    return b;
  });
}

function defaultMakeInputFile(source) {
  // Lazy require keeps unit tests free of the grammy dependency; the
  // InputFile MUST be path-backed (never a stream/supplier) so api.js's
  // 429/pre-connect retries can re-read it.
  const { InputFile } = require('grammy');
  return new InputFile(source);
}

/**
 * @param {object} deps
 * @param {(bot, method, params, meta) => Promise<*>} deps.tg
 * @param {string} deps.botName
 * @param {(kind: string, detail: object) => void} deps.logEvent
 * @param {(s: string) => string} deps.redactBotToken
 * @param {(err) => boolean} deps.isRichCapabilityError
 * @param {(err) => boolean} deps.isRichContentError
 * @param {() => boolean} deps.getRichKnownUnsupported
 * @param {() => void} deps.setRichKnownUnsupported — marks the latch tripped
 * @param {() => (string|null)} [deps.getApiRoot] — for the latch-trip log line only
 * @param {(url: string) => string} [deps.stripUrlCreds] — strips basic-auth
 *   userinfo from apiRoot before logging
 * @param {(source: string) => *} [deps.makeInputFile] — { source } envelope →
 *   uploadable file for grammy (test seam)
 * @param {(text: string) => string} [deps.sanitizeFallbackText] — applied to
 *   sourceText on every plain-fallback edit (polygram wires
 *   stripMediaMarkdown; default identity preserves legacy callers)
 * @returns {(args: {bot, chatId: string, threadId: (string|null), messageId: number, blocks: Array, sourceText: string}) => Promise<{result: *, wentRich: boolean}>}
 */
function createRichEditor({
  tg,
  botName,
  logEvent,
  redactBotToken,
  isRichCapabilityError,
  isRichContentError,
  getRichKnownUnsupported = () => false,
  setRichKnownUnsupported = () => {},
  getApiRoot = () => null,
  stripUrlCreds = (s) => s,
  makeInputFile = defaultMakeInputFile,
  sanitizeFallbackText = (s) => s,
} = {}) {
  return async function richEditMessageText({ bot, chatId, threadId = null, messageId, blocks, sourceText }) {
    if (getRichKnownUnsupported()) {
      const res = await tg(bot, 'editMessageText', {
        chat_id: chatId, message_id: messageId, text: sanitizeFallbackText(sourceText),
      }, { source: 'bot-reply-stream-edit-rich-fallback', botName });
      return { result: res, wentRich: false };
    }

    try {
      const res = await tg(bot, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        rich_message: { blocks: materializeMediaBlocks(blocks, makeInputFile) },
      }, { source: 'bot-reply-stream-edit-rich', botName, richSourceText: sourceText });
      // Record successful rich deliveries without storing message content.
      logEvent('rich-message-sent', {
        chat_id: chatId, thread_id: threadId, bot: botName,
        streaming: true, block_count: blocks.length,
        media_count: countMediaBlocks(blocks),
        char_count: sourceText?.length ?? null,
      });
      // The streamer commits rich state only when this marker is true.
      return { result: res, wentRich: true };
    } catch (err) {
      if (isRichCapabilityError(err)) {
        setRichKnownUnsupported();
        logEvent('rich-capability-latched', {
          chat_id: chatId, bot: botName,
          api_root: stripUrlCreds(getApiRoot() || 'cloud'),
          error: redactBotToken(err.message)?.slice(0, 200),
        });
      } else if (isRichContentError(err)) {
        logEvent('rich-content-fallback', {
          chat_id: chatId, bot: botName,
          error: redactBotToken(err.message)?.slice(0, 200),
        });
      } else {
        // Transient (5xx/timeout/etc) — not ours to reclassify as a
        // fallback; rethrow so the caller's existing retry/error
        // handling deals with it exactly as a plain-path edit failure
        // would (streamer.js's flush()/finalize() catch + log + move on).
        logEvent('telegram-edit-failed', {
          chat_id: chatId, msg_id: messageId,
          // Network errors can include the request URL and bot token.
          api_error: redactBotToken(err.message)?.slice(0, 200),
          bot: botName,
        });
        throw err;
      }
      // Preserve the same authored content and tell the streamer that the
      // accepted payload is plain, so its delivery trackers stay accurate.
      const fallbackRes = await tg(bot, 'editMessageText', {
        chat_id: chatId, message_id: messageId, text: sanitizeFallbackText(sourceText),
      }, { source: 'bot-reply-stream-edit-rich-fallback', botName });
      return { result: fallbackRes, wentRich: false };
    }
  };
}

module.exports = { createRichEditor, materializeMediaBlocks };

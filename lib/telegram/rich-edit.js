/**
 * Rich-message edit-with-fallback. Capability and content errors preserve
 * the reply through a plain edit; transient errors remain visible to the
 * streamer's retry/finalization logic.
 */

'use strict';

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
} = {}) {
  return async function richEditMessageText({ bot, chatId, threadId = null, messageId, blocks, sourceText }) {
    if (getRichKnownUnsupported()) {
      const res = await tg(bot, 'editMessageText', {
        chat_id: chatId, message_id: messageId, text: sourceText,
      }, { source: 'bot-reply-stream-edit-rich-fallback', botName });
      return { result: res, wentRich: false };
    }

    try {
      const res = await tg(bot, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        rich_message: { blocks },
      }, { source: 'bot-reply-stream-edit-rich', botName, richSourceText: sourceText });
      // Record successful rich deliveries without storing message content.
      logEvent('rich-message-sent', {
        chat_id: chatId, thread_id: threadId, bot: botName,
        streaming: true, block_count: blocks.length,
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
        chat_id: chatId, message_id: messageId, text: sourceText,
      }, { source: 'bot-reply-stream-edit-rich-fallback', botName });
      return { result: fallbackRes, wentRich: false };
    }
  };
}

module.exports = { createRichEditor };

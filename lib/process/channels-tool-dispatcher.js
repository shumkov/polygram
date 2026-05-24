/**
 * channels-tool-dispatcher — adapter between ChannelsProcess's reply tool
 * callback and polygram's existing Telegram delivery primitives.
 *
 * ChannelsProcess calls `toolDispatcher({sessionKey, chatId, threadId,
 * toolName, text, files})` whenever Claude invokes the reply tool over
 * the Channels protocol. This module wires that into:
 *   - lib/telegram/chunk.js     for size-aware splitting
 *   - lib/telegram/deliver.js   for the actual sendMessage loop
 *   - bot.api.sendPhoto/Document for file attachments
 *
 * The dispatcher returns `{ok: boolean, error?: string}` — ChannelsProcess
 * relays this to the bridge as tool_ack, which surfaces to Claude as the
 * tool's return value (`'sent'` on ok, error message on failure).
 *
 * Decoupled from polygram.js: factory takes {bot, send, chunkText, logger}
 * — same shape SDK callbacks already use — so it can be tested with fakes
 * and constructed in any caller.
 */

'use strict';

const path = require('node:path');

/**
 * @param {object} deps
 * @param {object} deps.bot                        — grammy Bot instance
 * @param {Function} deps.send                     — tg(bot, method, params, meta) sender wrapper
 * @param {Function} deps.chunkText                — (text, maxLen?) → string[] chunks
 * @param {object} [deps.deliverReplies]           — optional pre-bound deliverReplies; defaults to lib/telegram/deliver.deliverReplies
 * @param {object} [deps.logger=console]
 * @param {number} [deps.maxChunkLen=4000]         — TG hard cap is 4096; leave headroom for HTML wrapping
 * @returns {Function} dispatcher
 */
function createChannelsToolDispatcher({
  bot,
  send,
  chunkText,
  deliverReplies = null,
  logger = console,
  maxChunkLen = 4000,
} = {}) {
  if (!bot) throw new TypeError('channels-tool-dispatcher: bot required');
  if (typeof send !== 'function') throw new TypeError('channels-tool-dispatcher: send required');
  if (typeof chunkText !== 'function') throw new TypeError('channels-tool-dispatcher: chunkText required');

  const deliver = deliverReplies || require('../telegram/deliver').deliverReplies;

  return async function channelsToolDispatcher(call) {
    const { sessionKey, chatId, threadId, toolName, text, files } = call;

    if (toolName !== 'reply') {
      // 0.11.0 Phase 1 ships `reply` only — react and edit_message are
      // deferred (Decision #10). Future tools route through here too.
      return { ok: false, error: `unsupported tool: ${toolName}` };
    }

    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, error: 'reply.text missing or empty' };
    }
    if (!chatId) {
      return { ok: false, error: 'reply.chat_id missing' };
    }

    try {
      const chunks = chunkText(text, maxChunkLen);
      const result = await deliver({
        bot,
        send,
        chatId,
        threadId,
        chunks,
        replyToMessageId: null,   // ChannelsProcess doesn't track source-msg per-reply yet
        meta: { source: 'channels-tool-dispatcher', sessionKey, toolName },
        logger,
      });

      if (result.failed?.length > 0) {
        const failedDetail = result.failed.map(f => f.error?.message || 'unknown').join(', ');
        return { ok: false, error: `delivered ${result.sent.length} of ${chunks.length} chunks; failed: ${failedDetail}` };
      }

      // File attachments — sent as separate messages AFTER the text.
      // Photos for image MIMEs, Documents for everything else (matches
      // the official Telegram channels plugin behavior).
      if (Array.isArray(files) && files.length > 0) {
        for (const filePath of files) {
          try {
            const ext = path.extname(filePath).toLowerCase();
            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
            const method = isImage ? 'sendPhoto' : 'sendDocument';
            const fieldName = isImage ? 'photo' : 'document';
            const params = {
              chat_id: chatId,
              [fieldName]: { source: filePath },
            };
            if (threadId) params.message_thread_id = threadId;
            await send(bot, method, params, { source: 'channels-tool-dispatcher', sessionKey });
          } catch (err) {
            logger.warn?.(`[channels-tool-dispatcher] file attach failed for ${filePath}: ${err.message}`);
            // Continue with other files — partial delivery beats whole-call failure.
          }
        }
      }

      return { ok: true };
    } catch (err) {
      logger.error?.(`[channels-tool-dispatcher] ${sessionKey} dispatch failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  };
}

module.exports = { createChannelsToolDispatcher };

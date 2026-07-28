/**
 * Delivery strategy for the reply tool: render one reply as rich blocks, or
 * decline and let the caller's chunked path deliver it.
 *
 * This is the piece the channels dispatcher injects into the shared reply
 * pipeline. It lives here rather than in the dispatcher because rich-media.js
 * requires the dispatcher module — importing the rich modules from there
 * would close a require cycle — and because the decision logic is worth
 * testing without a dispatcher around it.
 *
 * Text only. Rendering runs on media-stripped text, so `![caption](/abs/path)`
 * degrades to its caption and image syntax cannot be the reason a reply goes
 * rich. That keeps local paths out of the chat on every branch and keeps the
 * media trust surface (path validation, size caps, TOCTOU) off this path
 * entirely.
 *
 * Declining is always safe: the pipeline falls back to the chunked path that
 * has always worked. Nothing here may throw its way out.
 */

'use strict';

const {
  toTelegramRichBlocks,
  stripMediaMarkdown,
  RICH_MAX_LEN,
} = require('./rich');

/**
 * @param {object} deps
 * @param {object} deps.bot                            — grammy Bot instance
 * @param {Function} deps.sendRich                     — createRichSender()'s sender
 * @param {(chatId, threadId) => boolean} deps.isRichTextEnabled — resolved per call
 *   against live config, so a config change mid-session takes effect immediately
 * @param {() => boolean} deps.getRichKnownUnsupported — process-wide capability latch
 * @param {Function} [deps.toRichBlocks]               — markdown → { blocks, usedRich }
 * @param {(s: string) => string} [deps.redactError]    — strips bot tokens from logged
 *   error text; network error shapes can embed the request URL
 * @param {number} [deps.richMaxLen]
 * @param {object} [deps.logger]
 * @returns {(ctx: {sessionKey, sessionCwd, chatId, threadId}) => Function} strategy factory
 */
function createRichDeliveryFactory({
  bot,
  sendRich,
  isRichTextEnabled,
  getRichKnownUnsupported = () => false,
  toRichBlocks = toTelegramRichBlocks,
  richMaxLen = RICH_MAX_LEN,
  redactError = (s) => s,
  logger = console,
} = {}) {
  if (typeof sendRich !== 'function') {
    throw new TypeError('rich-dispatch: sendRich required');
  }
  if (typeof isRichTextEnabled !== 'function') {
    throw new TypeError('rich-dispatch: isRichTextEnabled required');
  }

  // Per-call factory: the chat/topic identity is fixed for a reply, but the
  // gate is re-resolved on every delivery so live config edits apply without
  // a respawn.
  return function makeDeliverText({ chatId, threadId } = {}) {
    return async function deliverText({ text, replyToMessageId = null, meta = {} } = {}) {
      // Flag off → this chat has not opted into rich at all. Behave exactly
      // as before, raw markdown included: rewriting text here would change
      // delivery for chats that asked for nothing.
      if (!isRichTextEnabled(chatId, threadId)) return { handled: false };

      // From here the chat IS rich-enabled, so no branch may render a local
      // path — including the branches that end up delivering plain.
      const body = stripMediaMarkdown(text) ?? '';

      if (getRichKnownUnsupported()) return { handled: false, text: body };
      // Measured on the fallback body, which is what a decline delivers.
      if (body.length > richMaxLen) return { handled: false, text: body };

      let blocks;
      try {
        const rendered = toRichBlocks(body);
        if (!rendered?.usedRich) return { handled: false, text: body };
        blocks = rendered.blocks;
      } catch (err) {
        logger?.error?.(`[rich-dispatch] render failed: ${redactError(err.message)}`);
        return { handled: false, text: body };
      }

      let out;
      try {
        // Direct send is the only mechanism here; the plain-send-then-rich-edit
        // contingency is deliberately unimplemented, gated on the live gate that
        // establishes whether this verb honors message_thread_id and reply_parameters.
        out = await sendRich({
          bot,
          chatId,
          threadId,
          blocks,
          // The transcript keeps what the agent actually wrote; the operator's
          // own DB is the accepted resting place for local paths, and the
          // background secret sweep covers the row.
          sourceText: text,
          // Mirrors the chunked path's anchor. allow_sending_without_reply
          // matters more here, not less: a long turn gives the user time to
          // delete the message being answered, and without the flag Telegram
          // rejects the whole send with MESSAGE_NOT_FOUND — which this path
          // would misread as a generic rich failure and quietly downgrade.
          replyParams: replyToMessageId != null
            ? { message_id: replyToMessageId, allow_sending_without_reply: true }
            : null,
          meta,
        });
      } catch (err) {
        // sendRich is contracted not to throw. Not depending on that is the
        // difference between a flat reply and a lost one.
        // The branch exists because the no-throw contract might be broken;
        // it must not then assume the error is free of request URLs.
        logger?.error?.(`[rich-dispatch] send threw unexpectedly: ${redactError(err.message)}`);
        return { handled: false, text: body };
      }

      if (!out?.wentRich) return { handled: false, text: body };

      const messageId = out.result?.message_id;
      return {
        handled: true,
        sent: messageId != null ? [{ message_id: messageId }] : [],
        failed: [],
        results: [out.result],
      };
    };
  };
}

module.exports = { createRichDeliveryFactory };

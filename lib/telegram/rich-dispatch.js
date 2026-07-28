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
 * Media renders only when the caller injects a media wiring for THIS call —
 * a resolver bound to the roots the dispatcher already validates `files:`
 * against, plus the preflight the send re-checks each local source with.
 * Then rendering runs on the RAW text and `![caption](/abs/path)` becomes a
 * photo/video/animation block. Without that wiring, rendering runs on
 * media-stripped text instead: nothing could upload, so image syntax must not
 * reach the renderer at all — it would emit placeholder bubbles and could
 * even be the only reason a reply went rich.
 *
 * Either way no branch renders an absolute local path into the chat: the
 * fallback body every decline hands back is the stripped one.
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

// A resolver that accepts nothing, index-aligned with the descriptors it was
// given. Rendering through it (rather than through no resolver at all) is what
// turns each item into an honest "(media unavailable)" line instead of a
// silent removal.
const REJECT_ALL_MEDIA = (descriptors) => (descriptors || []).map(() => ({
  rejected: 'source-changed',
}));

/**
 * @param {object} deps
 * @param {object} deps.bot                            — grammy Bot instance
 * @param {Function} deps.sendRich                     — createRichSender()'s sender
 * @param {(chatId, threadId) => boolean} deps.isRichTextEnabled — resolved per call
 *   against live config, so a config change mid-session takes effect immediately
 * @param {() => boolean} deps.getRichKnownUnsupported — process-wide capability latch
 * @param {Function} [deps.toRichBlocks]               — markdown → { blocks, usedRich }
 * @param {Function} [deps.makeMediaWiring]            — ({allowedRoots, chatId, threadId})
 *   → {resolveMedia, mediaContext}. Omitted (or given no roots), the reply is
 *   delivered text-only. One function returns both halves because they MUST be
 *   built from the same roots and the same stat: a resolver and a preflight
 *   that disagree reject every file with nothing in the logs to say why.
 * @param {(s: string) => string} [deps.redactError]    — strips bot tokens from logged
 *   error text; network error shapes can embed the request URL
 * @param {number} [deps.richMaxLen]
 * @param {object} [deps.logger]
 * @returns {(ctx: {sessionKey, sessionCwd, allowedRoots, chatId, threadId}) => Function} strategy factory
 */
function createRichDeliveryFactory({
  bot,
  sendRich,
  isRichTextEnabled,
  getRichKnownUnsupported = () => false,
  toRichBlocks = toTelegramRichBlocks,
  makeMediaWiring = null,
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
  return function makeDeliverText({ chatId, threadId, allowedRoots = null } = {}) {
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

      // Built per call, from the roots the dispatcher validated this reply's
      // `files:` against. A wiring that fails to build costs media, never the
      // reply: the render below simply falls back to the stripped body.
      let media = null;
      if (typeof makeMediaWiring === 'function'
          && Array.isArray(allowedRoots) && allowedRoots.length > 0) {
        try {
          const built = makeMediaWiring({ allowedRoots, chatId, threadId });
          // BOTH halves or neither. A resolver without a preflight would send
          // local sources and cached ids to Telegram unchecked — the TOCTOU
          // this path exists to close — so a half-built wiring is no wiring.
          if (typeof built?.resolveMedia === 'function'
              && typeof built?.mediaContext?.preflightMedia === 'function') {
            media = built;
          }
        } catch (err) {
          logger?.error?.(`[rich-dispatch] media wiring unavailable: ${redactError(err.message)}`);
        }
      }

      // `partial` is deliberately never set: final mode is the only one that
      // both resolves media and emits the complete tree.
      const render = (resolveMedia) => {
        try {
          const rendered = resolveMedia
            ? toRichBlocks(text, { resolveMedia })
            : toRichBlocks(body);
          return rendered?.usedRich ? rendered.blocks : null;
        } catch (err) {
          logger?.error?.(`[rich-dispatch] render failed: ${redactError(err.message)}`);
          return null;
        }
      };

      // Mirrors the chunked path's anchor. allow_sending_without_reply
      // matters more here, not less: a long turn gives the user time to
      // delete the message being answered, and without the flag Telegram
      // rejects the whole send with MESSAGE_NOT_FOUND — which this path
      // would misread as a generic rich failure and quietly downgrade.
      const replyParams = replyToMessageId != null
        ? { message_id: replyToMessageId, allow_sending_without_reply: true }
        : null;

      const attempt = async (blocks) => {
        try {
          // Direct send is the only mechanism here; the plain-send-then-rich-edit
          // contingency is deliberately unimplemented — the live gate established
          // that this verb honors message_thread_id, reply_parameters, and
          // multipart media uploads.
          return await sendRich({
            bot,
            chatId,
            threadId,
            blocks,
            // The transcript keeps what the agent actually wrote; the operator's
            // own DB is the accepted resting place for local paths, and the
            // background secret sweep covers the row.
            sourceText: text,
            replyParams,
            mediaContext: media?.mediaContext ?? null,
            meta,
          });
        } catch (err) {
          // sendRich is contracted not to throw. Not depending on that is the
          // difference between a flat reply and a lost one.
          // The branch exists because the no-throw contract might be broken;
          // it must not then assume the error is free of request URLs.
          logger?.error?.(`[rich-dispatch] send threw unexpectedly: ${redactError(err.message)}`);
          return null;
        }
      };

      const blocks = render(media?.resolveMedia ?? null);
      if (!blocks) return { handled: false, text: body };

      let out = await attempt(blocks);

      // A file changed between resolve and send. The structure is still worth
      // keeping — losing a whole table because one screenshot was rewritten is
      // the worse trade — so re-render once with a resolver that rejects
      // everything. That yields honest "(media unavailable)" lines, and a
      // reply whose only rich trigger WAS the media demotes to plain by
      // itself, collapsing this ladder to two steps.
      if (out && !out.wentRich && out.fallback === 'media-source-changed' && media) {
        const retry = render(REJECT_ALL_MEDIA);
        if (retry) out = await attempt(retry);
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

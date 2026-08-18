/**
 * Rich-message edit-with-fallback. Capability and content errors preserve
 * the reply through a plain edit; transient errors remain visible to the
 * streamer's retry/finalization logic.
 *
 * Media handling: blocks arrive JSON-safe — local files as
 * `{ source: '<realpath>', fingerprint: '…' }` envelopes at the typed
 * media field (rich.js emits them that way because the streamer dedups payloads via JSON.stringify,
 * which a grammy InputFile would break: its toJSON throws by design).
 * Cached file IDs or envelope→InputFile materialization happen HERE, on a
 * cloned tree, immediately before each send attempt — so the caller's
 * blocks stay serializable while local sources are revalidated at delivery.
 * Fallback edits go through sanitizeFallbackText so a media-bearing
 * reply degrades without rendering absolute local paths into the chat.
 */

'use strict';

const path = require('node:path');
const { countMediaBlocks, flattenStyledBlocks, blocksAreStyled } = require('./rich');

const MEDIA_SOURCE_CHANGED = 'RICH_MEDIA_SOURCE_CHANGED';
const MEDIA_BLOCK_KINDS = new Set(['photo', 'video', 'animation']);

// Clone the block tree, replacing local source envelopes with uploadable
// files while preserving each block's concrete media kind.
function materializeMediaBlocks(blocks, makeInputFile, preflightMedia = null) {
  return (blocks || []).map((b) => {
    const kind = b?.type;
    const inputMedia = MEDIA_BLOCK_KINDS.has(kind) ? b[kind] : null;
    if (inputMedia && typeof inputMedia === 'object'
        && inputMedia.media && typeof inputMedia.media === 'object'
        && typeof inputMedia.media.source === 'string') {
      const checked = typeof preflightMedia === 'function'
        // withBytes: the upload carries the bytes the check read through its
        // own descriptor, so nothing re-opens the path afterwards — not at
        // request-build time, not on a 429 retry.
        ? preflightMedia(inputMedia.media, kind, { withBytes: true })
        : {
          ok: true,
          value: typeof inputMedia.media.fileId === 'string' && inputMedia.media.fileId
            ? inputMedia.media.fileId
            : inputMedia.media,
        };
      if (!checked?.ok) {
        const err = new Error('Rich media source changed before upload');
        err.code = MEDIA_SOURCE_CHANGED;
        throw err;
      }
      const media = checked.value || inputMedia.media;
      return {
        ...b,
        [kind]: {
          ...inputMedia,
          // Signature unchanged — the source stays the first argument, so a
          // caller (or a test seam) that only cares about which file is being
          // uploaded reads exactly what it always did.
          media: typeof media === 'string' ? media : makeInputFile(media.source, media.bytes),
        },
      };
    }
    if (b && Array.isArray(b.blocks)) {
      return { ...b, blocks: materializeMediaBlocks(b.blocks, makeInputFile, preflightMedia) };
    }
    if (b && Array.isArray(b.items)) {
      return {
        ...b,
        items: b.items.map((it) => (it && Array.isArray(it.blocks)
          ? { ...it, blocks: materializeMediaBlocks(it.blocks, makeInputFile, preflightMedia) }
          : it)),
      };
    }
    return b;
  });
}

function defaultMakeInputFile(source, bytes = null) {
  // Lazy require keeps unit tests free of the grammy dependency.
  const { InputFile } = require('grammy');
  // Bytes the preflight read through its own descriptor: upload those, so a
  // file swapped after the check cannot be substituted at request-build time
  // or on any retry. A buffer is re-usable, which is what api.js's 429 and
  // pre-connect retries need (a stream or a supplier would not be).
  if (Buffer.isBuffer(bytes)) return new InputFile(bytes, path.basename(source || ''));
  // No preflight in play (a caller that opted out): a path-backed file, which
  // is at least re-readable across those retries.
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
 * @param {(source: string, bytes?: Buffer) => *} [deps.makeInputFile] — source
 *   (plus the preflighted bytes, when the check read them) → uploadable file
 *   for grammy (test seam)
 * @param {object} [deps.capabilityLatch] — shared latch decision (see
 *   rich-capability-latch.js). Pass the SAME instance the send path uses so a
 *   bare 404 on either counts toward one run of strikes. Omitted, every
 *   capability error latches immediately, which is this module's legacy
 *   behavior.
 * @param {(text: string) => string} [deps.sanitizeFallbackText] — applied to
 *   sourceText on every plain-fallback edit (polygram wires
 *   stripMediaMarkdown; default identity preserves legacy callers)
 * @param {() => void} [deps.onStylingRejected] — a styled payload was refused
 *   and the SAME tree, flattened, was accepted. The two differ in exactly one
 *   respect, which is what makes it evidence about styling.
 * @param {() => void} [deps.onStylingAccepted] — a styled payload landed
 * @returns {(args: {bot, chatId: string, threadId: (string|null), messageId: number, blocks: Array, sourceText: string, phase?: string, mediaContext?: object, hadReplyAnchor?: boolean, meta?: object}) => Promise<{result: *, wentRich: boolean, bubbleRemoved?: boolean}>}
 */
function createRichEditor({
  tg,
  botName,
  logEvent,
  redactBotToken,
  isRichCapabilityError,
  isRichContentError,
  isRichLimitError = () => false,
  getRichKnownUnsupported = () => false,
  setRichKnownUnsupported = () => {},
  getApiRoot = () => null,
  stripUrlCreds = (s) => s,
  makeInputFile = defaultMakeInputFile,
  sanitizeFallbackText = (s) => s,
  capabilityLatch = null,
  onStylingRejected = () => {},
  onStylingAccepted = () => {},
} = {}) {
  const latch = capabilityLatch || {
    recordCapabilityError: () => { setRichKnownUnsupported(); return true; },
    recordHealthyOutcome: () => {},
  };
  async function rescueBestEffort({
    mediaContext,
    blocks,
    options,
    chatId,
    threadId,
  }) {
    try {
      await mediaContext.rescueBlocks(blocks, options);
    } catch (err) {
      // Text may already have landed, so a rescue failure must not escape
      // into finalization and cause that text to be delivered again.
      mediaContext.recordUnexpectedMediaFailure?.();
      logEvent('rich-media-rescue-failed', {
        chat_id: chatId, thread_id: threadId, bot: botName,
        error_class: err?.name || 'Error',
      });
    }
  }

  return async function richEditMessageText({
    bot,
    chatId,
    threadId = null,
    messageId,
    blocks,
    sourceText,
    phase = 'preview',
    mediaContext = null,
    hadReplyAnchor = false,
    meta = {},
  }) {
    if (getRichKnownUnsupported()) {
      const res = await tg(bot, 'editMessageText', {
        chat_id: chatId, message_id: messageId, text: sanitizeFallbackText(sourceText),
      }, { ...meta, source: 'bot-reply-stream-edit-rich-fallback', botName });
      return { result: res, wentRich: false };
    }

    let fallbackKind = null;
    let limitRefusal = false;
    try {
      const res = await tg(bot, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        rich_message: {
          blocks: materializeMediaBlocks(
            blocks,
            makeInputFile,
            mediaContext?.preflightMedia,
          ),
        },
      }, {
        ...meta,
        source: 'bot-reply-stream-edit-rich',
        botName,
        richSourceText: sourceText,
      });
      latch.recordHealthyOutcome();
      if (blocksAreStyled(blocks)) {
        try { onStylingAccepted(); } catch { /* a verdict must not cost a delivered edit */ }
      }
      mediaContext?.learnRichResult?.(blocks, res);
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
      if (err?.code === MEDIA_SOURCE_CHANGED) {
        fallbackKind = 'content-error';
        logEvent('rich-content-fallback', {
          chat_id: chatId, bot: botName,
          error_code: 'media-source-changed',
        });
      } else if (isRichCapabilityError(err)) {
        // This edit degrades either way; the latch decides whether every
        // LATER rich message on every path degrades too. A bare 404 is also
        // what a restarting bot-api server returns, so it takes two in a row.
        fallbackKind = 'capability';
        if (latch.recordCapabilityError(err, 'edit')) {
          logEvent('rich-capability-latched', {
            chat_id: chatId, bot: botName,
            api_root: stripUrlCreds(getApiRoot() || 'cloud'),
            error_code: err.code || err.name || 'error',
          error_len: err.message?.length ?? 0,
          });
        } else {
          logEvent('rich-capability-strike', {
            chat_id: chatId, thread_id: threadId, bot: botName,
            transport: 'edit',
            error_code: err.code || err.name || 'error',
          error_len: err.message?.length ?? 0,
          });
        }
      } else if (isRichContentError(err)) {
        fallbackKind = 'content-error';
        // A refusal that named a limit is explained by the retry being
        // smaller, not by it being unstyled — retry, but do not count it.
        limitRefusal = (() => { try { return isRichLimitError(err) === true; } catch { return false; } })();
        // The server read and rejected this payload, so the endpoint is
        // demonstrably there — that breaks any run of ambiguous 404s.
        latch.recordHealthyOutcome();
        mediaContext?.evictCachedBlocks?.(blocks);
        logEvent('rich-content-fallback', {
          chat_id: chatId, bot: botName,
          error_code: err.code || err.name || 'error',
          error_len: err.message?.length ?? 0,
        });
      } else {
        // Transient (5xx/timeout/etc) — not ours to reclassify as a
        // fallback; rethrow so the caller's existing retry/error
        // handling deals with it exactly as a plain-path edit failure
        // would (streamer.js's flush()/finalize() catch + log + move on).
        logEvent('telegram-edit-failed', {
          chat_id: chatId, msg_id: messageId,
          // Network errors can include the request URL and bot token.
          api_error_code: err.code || err.name || 'error',
          error_len: err.message?.length ?? 0,
          bot: botName,
        });
        throw err;
      }
    }

    // A refused styled payload gets one more rich attempt without the
    // styling, before the bubble degrades to plain text. The streamer is the
    // path where that matters most: its bubbles are edited repeatedly, so a
    // server that dislikes typed nodes would otherwise flatten every one of
    // them to plain for the process lifetime — losing headings and tables
    // that have nothing to do with the refusal.
    //
    // Flattens the REFUSED tree rather than asking for a re-render: no media
    // is resolved twice, and the two payloads differ in exactly one respect,
    // so an acceptance here says something about styling and nothing else.
    if (fallbackKind === 'content-error' && blocksAreStyled(blocks)) {
      try {
        const res = await tg(bot, 'editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          rich_message: {
            blocks: materializeMediaBlocks(
              flattenStyledBlocks(blocks),
              makeInputFile,
              mediaContext?.preflightMedia,
            ),
          },
        }, {
          ...meta,
          source: 'bot-reply-stream-edit-rich-unstyled',
          botName,
          richSourceText: sourceText,
        });
        if (!limitRefusal) {
          try { onStylingRejected(); } catch { /* the edit landed either way */ }
        }
        logEvent('rich-styling-fallback', {
          chat_id: chatId, thread_id: threadId, bot: botName,
          transport: 'edit',
        });
        return { result: res, wentRich: true };
      } catch {
        // Both shapes refused, so the blocks were the problem and this says
        // nothing about styling. Fall through to the plain edit below.
      }
    }

    const fallbackText = sanitizeFallbackText(sourceText);
    const canRescue = fallbackKind === 'content-error'
      && (phase === 'final' || phase === 'seal')
      && mediaContext
      && typeof mediaContext.rescueBlocks === 'function';

    if (canRescue && !fallbackText.trim()) {
      const bubbleRemoved = typeof mediaContext.deletePlaceholder === 'function'
        ? await mediaContext.deletePlaceholder(messageId)
        : false;
      await rescueBestEffort({
        mediaContext,
        blocks,
        options: {
          trigger: 'content-error',
          anchorFirst: bubbleRemoved && hadReplyAnchor,
        },
        chatId,
        threadId,
      });
      return { result: null, wentRich: false, bubbleRemoved };
    }

    // Preserve the same authored content and tell the streamer that the
    // accepted payload is plain, so its delivery trackers stay accurate.
    // If this edit fails, no rescue has started and finalize remains the
    // single owner of discard/redelivery.
    const fallbackRes = await tg(bot, 'editMessageText', {
      chat_id: chatId, message_id: messageId, text: fallbackText,
    }, { ...meta, source: 'bot-reply-stream-edit-rich-fallback', botName });

    if (canRescue) {
      await rescueBestEffort({
        mediaContext,
        blocks,
        options: { trigger: 'content-error' },
        chatId,
        threadId,
      });
    }
    return { result: fallbackRes, wentRich: false };
  };
}

module.exports = {
  createRichEditor,
  materializeMediaBlocks,
  defaultMakeInputFile,
  // The send path classifies this code before anything else; sharing the
  // constant is what keeps the two catch blocks talking about the same thing.
  MEDIA_SOURCE_CHANGED,
};

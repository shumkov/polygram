/**
 * Shared agent-reply pipeline for polygram's non-streaming Telegram
 * send paths. Wraps parseResponse + sanitizeReply + chunkMarkdownText
 * + deliverReplies + inline sticker/reaction handling so callers that
 * deliver agent-authored text (autonomous wakeup, tmux autosteered
 * extra-turn reply, auto-resume continuation reply) get identical
 * protection from:
 *
 *   - `[sticker:NAME]` tags rendering as literal text instead of
 *     a real sticker bubble (parseResponse strips + surfaces).
 *   - `[react:EMOJI]` tags rendering as literal text instead of a
 *     real Telegram reaction (parseResponse strips + surfaces).
 *   - CLI-context canned strings like `No response requested.`
 *     leaking through (sanitizeAssistantReply intercepts; rc.45).
 *
 * Why a shared helper instead of inlining per caller:
 *   - Pre-rc.51 polygram had THREE places sending agent text outside
 *     the bot-reply-stream path. Two of them (autosteered extra-turn,
 *     auto-resume reply) silently inherited NONE of the protections
 *     wired into the streamed path. rc.50 fixed `onAutonomousAssistantMessage`
 *     by inlining the pipeline; the audit during rc.50 surfaced the
 *     other two as latent. Extracting a helper here covers all three
 *     AND any future code path that sends agent-authored text to
 *     Telegram — the next reviewer adding such a path will either
 *     find this helper and use it, or write a new bug that already
 *     has a regression test pinning the gap.
 *
 * Why NOT cover bot-reply-stream too (handleMessage in polygram.js):
 *   - That path layers in streamer.finalize, autosteered-refs cleanup,
 *     reactor lifecycle, archived-bubble cleanup, and a preview-becomes-
 *     final decision tree that don't apply to autonomous/extra-turn/
 *     auto-resume. Refactoring it into the helper would either bloat
 *     the helper (every caller carrying optional streamer/reactor deps)
 *     or duplicate the streamer-specific logic. The simpler-paths
 *     extraction here is the right scope.
 */

'use strict';

/**
 * Process and deliver one chunk of agent-authored text via Telegram.
 * Runs the full reply pipeline: parse → sanitize → chunk → deliver
 * → send inline stickers/sticker → apply or log-and-drop reactions.
 *
 * The behavior matches polygram.js handleMessage's bot-reply-stream
 * delivery branch (lines ~1311-1503), minus the streamer-finalize
 * preview path that's irrelevant for non-streaming senders.
 *
 * @param {object} opts
 * @param {string} opts.text                 — raw agent-authored text
 * @param {object} opts.bot                  — grammy bot instance
 * @param {Function} opts.tg                 — (bot, method, params, meta) → Promise<res>
 * @param {string|number} opts.chatId
 * @param {?(number|string)} opts.threadId   — Telegram message_thread_id (or null).
 *   Treated as opaque, deliver.js-style: the cli backend passes a STRING, so an
 *   integer-only guard would drop the id and send stickers to the General topic.
 * @param {?number} opts.replyToMessageId    — inbound msg_id this reply targets; null for unsolicited
 * @param {boolean} [opts.applyReactions]    — apply [react:EMOJI] tags to replyToMessageId. False for
 *                                              unsolicited (autonomous-wakeup) where there IS no target;
 *                                              reactions in that case are logged + dropped. Defaults to
 *                                              `replyToMessageId != null`.
 * @param {string} opts.source               — source tag for outbound rows + events (e.g. 'autonomous-wakeup')
 * @param {object} [opts.meta]               — extra meta fields merged into deliverReplies + tg calls
 * @param {Function} opts.parseResponse      — text → { text, sticker, stickers[], reaction, reactions[], ... }
 * @param {Function} opts.sanitizeAssistantReply — text → { text, replaced, original? }
 * @param {Function} opts.chunkMarkdownText  — (text, budget) → string[]
 * @param {Function} opts.deliverReplies     — async ({ bot, send, chatId, threadId, chunks, replyToMessageId, meta, logger }) → { sent, failed }
 * @param {number} [opts.chunkBudget=3500]
 * @param {Function} [opts.logEvent]         — (kind, detail) → void
 * @param {?string|number} [opts.sessionKey] — for event payloads
 * @param {object} [opts.logger]             — { log, error }
 * @returns {Promise<{ deliverResult: ?object, stickersSent: number, reactionsApplied: number, reactionsDropped: number, sanitizerReplaced: boolean }>}
 */
async function processAndDeliverAgentText({
  text,
  bot,
  tg,
  chatId,
  threadId = null,
  replyToMessageId = null,
  applyReactions,
  source,
  meta = {},
  parseResponse,
  sanitizeAssistantReply,
  chunkMarkdownText,
  deliverReplies,
  chunkBudget = 3500,
  logEvent = null,
  sessionKey = null,
  logger = console,
  redactInbound = null,
}) {
  const summary = {
    deliverResult: null,
    stickersSent: 0,
    reactionsApplied: 0,
    reactionsDropped: 0,
    sanitizerReplaced: false,
    secretsRedacted: 0,
  };

  if (typeof text !== 'string' || text.length === 0) return summary;

  // Default reactions on iff we have a target message. Caller can
  // override (e.g. force-drop even when target exists).
  const shouldApplyReactions = (typeof applyReactions === 'boolean')
    ? applyReactions
    : (replyToMessageId != null);

  // 1. Parse — strips inline tags, surfaces stickers + reactions
  //    as structured fields. Solo-sticker / solo-react / solo-emoji
  //    shortcuts return `text: ''` plus a single sticker/reaction.
  const parsed = parseResponse(text);

  // 1b. 0.15: redact any agent-reported secrets ([redact:<secret>]) from the
  //     stored inbound BEFORE delivering. The markers are already stripped from
  //     parsed.text by parseResponse (and from the streamed bubble by
  //     stripInlineTags), so nothing leaks to the user.
  if (typeof redactInbound === 'function' && parsed.redactions && parsed.redactions.length) {
    let wiped = 0;
    for (const secret of parsed.redactions) {
      try { wiped += (redactInbound(secret, { chat_id: chatId, thread_id: threadId })?.redacted || 0); }
      catch (e) { logger?.error?.(`[redact] agent-reported redaction failed: ${e.message}`); }
    }
    summary.secretsRedacted = wiped;
    if (wiped > 0) {
      logEvent?.('secret-redacted-by-agent', { chat_id: chatId, thread_id: threadId, count: wiped, source, session_key: sessionKey });
    } else {
      // Fail-loud: flagged but matched no stored inbound row (see polygram.js).
      logger?.error?.(`[${source}] [redact] flagged ${parsed.redactions.length} secret(s) but matched 0 stored rows`);
      logEvent?.('secret-redact-requested-no-match', { chat_id: chatId, thread_id: threadId, requested: parsed.redactions.length, source, session_key: sessionKey });
    }
  }

  // 2. Sanitize parsed.text. The rc.45 sanitizer intercepts CLI
  //    canned strings (`No response requested.` etc.). Only fires
  //    when parsed.text is non-empty (solo sticker/reaction paths
  //    have no text to sanitize).
  if (parsed.text) {
    const sanitized = sanitizeAssistantReply(parsed.text);
    if (sanitized.replaced) {
      summary.sanitizerReplaced = true;
      logEvent?.('canned-reply-suppressed', {
        chat_id: chatId,
        msg_id: replyToMessageId,
        original: sanitized.original,
        source,
        session_key: sessionKey,
      });
      parsed.text = sanitized.text;
    }
  }

  // 3. Deliver text via chunked deliverReplies. Mirrors handleMessage's
  //    chunked-redelivery branch (line ~1424 in polygram.js).
  if (parsed.text) {
    const chunks = chunkMarkdownText(parsed.text, chunkBudget);
    summary.deliverResult = await deliverReplies({
      bot,
      send: (b, method, params, m) => tg(b, method, params, m),
      chatId,
      threadId,
      chunks,
      replyToMessageId,
      meta: { ...meta, source, botName: meta.botName },
      logger,
    });
  }

  // 4. Solo sticker (parseResponse path when whole text was just
  //    `[sticker:NAME]`).
  if (parsed.sticker) {
    try {
      await tg(bot, 'sendSticker', {
        chat_id: chatId,
        sticker: parsed.sticker,
        ...(threadId != null && { message_thread_id: threadId }),
      }, {
        ...meta,
        source: `${source}-sticker`,
        stickerName: parsed.stickerLabel || null,
      });
      summary.stickersSent += 1;
    } catch (err) {
      logger.error?.(`[${source}] sendSticker(${parsed.stickerLabel}) failed: ${err.message}`);
    }
  }

  // 5. Inline stickers from `[sticker:NAME]` tags within text.
  //    Order matches text order so the visual sequence holds.
  for (const s of (parsed.stickers || [])) {
    try {
      await tg(bot, 'sendSticker', {
        chat_id: chatId,
        sticker: s.fileId,
        ...(threadId != null && { message_thread_id: threadId }),
      }, {
        ...meta,
        source: `${source}-inline-sticker`,
        stickerName: s.name,
      });
      summary.stickersSent += 1;
    } catch (err) {
      logger.error?.(`[${source}] inline sendSticker(${s.name}) failed: ${err.message}`);
    }
  }

  // 6. Reactions: parsed.reaction (solo) + parsed.reactions[] (inline).
  //    Telegram bots can only set ONE reaction per message; if the
  //    agent surfaced multiple, apply the first and log the rest as
  //    dropped (matches handleMessage's behavior at line ~1374).
  const allReactions = [
    ...(parsed.reaction ? [parsed.reaction] : []),
    ...(parsed.reactions || []),
  ];

  if (allReactions.length === 0) return summary;

  if (!shouldApplyReactions || replyToMessageId == null) {
    // No target msg to react against — log + drop. Surfaces in
    // forensics if an agent starts using react-tags in code paths
    // that don't have a target msg.
    logEvent?.(`${source}-reactions-dropped`, {
      chat_id: chatId,
      session_key: sessionKey,
      dropped: allReactions,
    });
    summary.reactionsDropped += allReactions.length;
    return summary;
  }

  const emoji = allReactions[0];
  try {
    await tg(bot, 'setMessageReaction', {
      chat_id: chatId,
      message_id: replyToMessageId,
      reaction: [{ type: 'emoji', emoji }],
    }, { ...meta, source: `${source}-reaction`, reaction: emoji });
    summary.reactionsApplied += 1;
  } catch (err) {
    logger.error?.(`[${source}] setMessageReaction(${emoji}) failed: ${err.message}`);
  }
  if (allReactions.length > 1) {
    logEvent?.('inline-reactions-dropped', {
      chat_id: chatId,
      msg_id: replyToMessageId,
      applied: emoji,
      dropped_count: allReactions.length - 1,
      source,
    });
    summary.reactionsDropped += (allReactions.length - 1);
  }
  return summary;
}

module.exports = { processAndDeliverAgentText };

/**
 * Rich-message send-with-fallback — the send-side counterpart to
 * rich-edit.js.
 *
 * The asymmetry with rich-edit is deliberate. An edit acts on a bubble that
 * already exists, so a transient failure can be rethrown for the streamer's
 * retry logic to handle. A send has no bubble yet: its caller holds the only
 * copy of the reply and owns a plain chunked path that always works. So this
 * function NEVER throws and never rethrows. Every failure returns
 * `wentRich: false` and the caller delivers plain — error classification
 * decides only whether to latch the capability off, never whether the user
 * gets the message.
 *
 * Transcript rows are inserted HERE, on success only. api.js deliberately
 * leaves sendRichMessage untracked: a tracked pending row would persist the
 * failed attempt, the plain fallback would then insert its own rows, and the
 * agent's preloaded history would show the same answer twice.
 */

'use strict';

const { createRichCapabilityLatch } = require('./rich-capability-latch');

/**
 * @param {object} deps
 * @param {(bot, method, params, meta) => Promise<*>} deps.tg
 * @param {string} deps.botName
 * @param {(kind: string, detail: object) => void} deps.logEvent
 * @param {(s: string) => string} deps.redactBotToken
 * @param {(err) => boolean} deps.isRichCapabilityError
 * @param {(err) => boolean} deps.isRichCapabilityErrorExplicit — capability error
 *   that NAMES the missing capability, as opposed to a bare 404
 * @param {(err) => boolean} deps.isRichContentError
 * @param {() => boolean} deps.getRichKnownUnsupported
 * @param {() => void} deps.setRichKnownUnsupported — marks the latch tripped
 * @param {() => (string|null)} [deps.getApiRoot] — for the latch-trip log line only
 * @param {(url: string) => string} [deps.stripUrlCreds] — strips basic-auth
 *   userinfo from apiRoot before logging
 * @param {(row: object) => void} [deps.insertSentRow] — persists the outbound
 *   transcript row; best-effort, never blocks delivery
 * @param {object} [deps.capabilityLatch] — shared latch decision; pass the SAME
 *   instance the edit path uses so a bare 404 on either counts toward one run
 * @param {object} [deps.logger]
 * @returns {(args: {bot, chatId: string, threadId?: (string|number|null), blocks: Array,
 *   sourceText: string, replyParams?: object, meta?: object})
 *   => Promise<{wentRich: boolean, result?: *}>}
 */
function createRichSender({
  tg,
  botName,
  logEvent = () => {},
  redactBotToken = (s) => s,
  isRichCapabilityError,
  isRichCapabilityErrorExplicit,
  isRichContentError,
  getRichKnownUnsupported = () => false,
  setRichKnownUnsupported = () => {},
  getApiRoot = () => null,
  stripUrlCreds = (s) => s,
  insertSentRow = null,
  capabilityLatch = null,
  logger = console,
} = {}) {
  // Shared with the edit path when the caller passes one in: both trip the
  // same process-wide flag, so a per-module counter would let either path
  // latch on its first bare 404 while the other believed it was protected.
  const latch = capabilityLatch || createRichCapabilityLatch({
    isExplicit: isRichCapabilityErrorExplicit,
    setUnsupported: setRichKnownUnsupported,
  });

  return async function sendRich({
    bot,
    chatId,
    threadId = null,
    blocks,
    sourceText,
    replyParams = null,
    meta = {},
  }) {
    if (getRichKnownUnsupported()) return { wentRich: false };
    if (!Array.isArray(blocks) || blocks.length === 0) return { wentRich: false };

    const params = {
      chat_id: chatId,
      rich_message: { blocks },
    };
    if (threadId != null) params.message_thread_id = threadId;
    if (replyParams) params.reply_parameters = replyParams;

    let result;
    try {
      result = await tg(bot, 'sendRichMessage', params, {
        ...meta,
        source: meta.source || 'bot-reply-rich-send',
        botName,
        richSourceText: sourceText,
      });
    } catch (err) {
      classifyFailure(err, chatId, threadId);
      return { wentRich: false };
    }

    latch.recordHealthyOutcome();

    // A resolved response with no message_id cannot be honored: the reply tool
    // promises the agent an id it can edit, and without one there is no
    // ownership claim and no transcript row either. Treat it as a content-class
    // failure so the caller delivers plain rather than reporting a success the
    // agent cannot act on. Trade-off, stated plainly: if the server DID create
    // a bubble, the user sees the reply twice. That is the louder failure of
    // the two, and the response shape is unverified until the live gate runs.
    const messageId = result?.message_id;
    if (messageId == null) {
      logEvent('rich-content-fallback', {
        chat_id: chatId, thread_id: threadId, bot: botName,
        transport: 'send',
        error: 'response carried no message_id',
      });
      return { wentRich: false };
    }

    // The message has landed. Nothing below may change that verdict: a throw
    // escaping from here would be caught upstream as "rich did not happen",
    // and the caller would deliver the very same reply again as plain text.
    // The bookkeeping is best-effort; the send is not.
    try {
      if (typeof insertSentRow === 'function') {
        insertSentRow({
          chat_id: chatId,
          thread_id: threadId != null ? String(threadId) : null,
          msg_id: messageId,
          text: sourceText || '',
          direction: 'out',
          status: 'sent',
          source: meta.source || 'bot-reply-rich-send',
          bot_name: botName,
          turn_id: meta.turnId || null,
          session_id: meta.sessionId || null,
          reply_to_id: replyParams?.message_id ?? null,
          ts: result?.date ? result.date * 1000 : Date.now(),
        });
      }

      logEvent('rich-message-sent', {
        chat_id: chatId,
        thread_id: threadId,
        bot: botName,
        transport: 'send',
        block_count: blocks.length,
        char_count: sourceText?.length ?? null,
        message_id: messageId,
      });

      // A dropped topic does not error — the message simply lands in the
      // group's General topic instead, mis-delivering every rich reply in a
      // forum chat with nothing in the logs to say so. Compare what came back
      // against what was asked for, on every send rather than only at the
      // one-off gate that first established the behavior.
      if (threadId != null) {
        const echoed = result?.message_thread_id;
        if (echoed == null || String(echoed) !== String(threadId)) {
          logEvent('rich-send-thread-mismatch', {
            chat_id: chatId, bot: botName,
            requested_thread_id: String(threadId),
            echoed_thread_id: echoed == null ? null : String(echoed),
          });
        }
      }
    } catch (e) {
      logger?.error?.(`[telegram] rich-send bookkeeping failed after delivery: ${e.message}`);
    }

    return { wentRich: true, result };
  };

  function classifyFailure(err, chatId, threadId) {
    if (safeTest(isRichCapabilityError, err)) {
      if (latch.recordCapabilityError(err, 'send')) {
        logCapabilityLatched(err, chatId);
      } else {
        logEvent('rich-capability-strike', {
          chat_id: chatId, thread_id: threadId, bot: botName,
          transport: 'send',
          error: redactBotToken(errText(err))?.slice(0, 200),
        });
      }
      return;
    }

    // A rejection of this payload proves the endpoint is present and
    // answering, so it breaks any run of ambiguous 404s.
    latch.recordHealthyOutcome();

    if (safeTest(isRichContentError, err)) {
      logEvent('rich-content-fallback', {
        chat_id: chatId, thread_id: threadId, bot: botName,
        transport: 'send',
        error: redactBotToken(errText(err))?.slice(0, 200),
      });
      return;
    }

    // Soak note: api.js already logs telegram-api-error for the same failure,
    // exactly as it does for rich edits. Count one or the other, not both.
    logEvent('rich-send-error', {
      chat_id: chatId, thread_id: threadId, bot: botName,
      error_class: err?.name || 'Error',
      error: redactBotToken(errText(err))?.slice(0, 200),
    });
  }

  function logCapabilityLatched(err, chatId) {
    logEvent('rich-capability-latched', {
      chat_id: chatId, bot: botName,
      transport: 'send',
      api_root: stripUrlCreds(getApiRoot() || 'cloud'),
      error: redactBotToken(errText(err))?.slice(0, 200),
    });
  }
}

// Classification runs on whatever was thrown, including non-Error values.
// A predicate that chokes on an odd shape must not become the reason a
// reply is lost.
function safeTest(fn, err) {
  if (typeof fn !== 'function') return false;
  try { return fn(err) === true; }
  catch { return false; }
}

function errText(err) {
  if (!err) return '';
  return String(err.description || err.message || err);
}

module.exports = { createRichSender };

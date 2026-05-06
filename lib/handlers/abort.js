/**
 * Stop / abort handler.
 *
 * Detects natural-language stop cues ("stop" / "стоп" / "cancel" /
 * "отмена") and explicit slash commands (/stop, /abort, /cancel) via
 * the injected isAbortRequest predicate. On match:
 *
 *   1. Mark the session aborted BEFORE the SDK interrupt fires —
 *      pm-sdk's close handler races; if we marked after, the
 *      generic error-reply could slip through.
 *   2. pm.interrupt() — non-destructive cancel of the in-flight
 *      turn (preserves Query for the next user message).
 *   3. pm.drainQueue() — rejects queued pendings with
 *      err.code='INTERRUPTED' so the abort-grace classifier
 *      suppresses error replies on the way out.
 *   4. Clear ✍ reactions on already-autosteered messages from
 *      this turn (now dead context).
 *   5. Acknowledge in the language the user aborted in (en/ru).
 *
 * Returns true when the message was handled as an abort, false
 * otherwise. Caller short-circuits on true.
 */

'use strict';

function createHandleAbort({
  pm,
  bot,
  tg,
  logEvent,
  isAbortRequest,
  markSessionAborted,
  clearAutosteeredReactions,
  getSessionKey,
  botName,
  logger = console,
} = {}) {
  if (!pm) throw new TypeError('pm required');
  if (typeof tg !== 'function') throw new TypeError('tg required');
  if (typeof logEvent !== 'function') throw new TypeError('logEvent required');
  if (typeof isAbortRequest !== 'function') throw new TypeError('isAbortRequest required');
  if (typeof markSessionAborted !== 'function') throw new TypeError('markSessionAborted required');
  if (typeof clearAutosteeredReactions !== 'function') throw new TypeError('clearAutosteeredReactions required');
  if (typeof getSessionKey !== 'function') throw new TypeError('getSessionKey required');
  if (!botName) throw new TypeError('botName required');

  return async function handleAbortIfRequested(msg, chatId, chatConfig, cleanText) {
    if (!isAbortRequest(cleanText)) return false;

    const threadId = msg.message_thread_id?.toString();
    const sessionKey = getSessionKey(chatId, threadId, chatConfig);
    const hadActive = pm.has(sessionKey) && !!pm.get(sessionKey)?.inFlight;

    // Mark BEFORE killing: the 'close' event fires almost immediately
    // after interrupt, and the surrounding handleMessage's catch
    // needs to see the flag to skip the generic error-reply.
    if (hadActive) markSessionAborted(sessionKey);

    // SDK abort: interrupt() + drainQueue(). interrupt() cancels
    // the in-flight turn at SDK level WITHOUT tearing down the
    // Query (cheap to reuse for the user's next message);
    // drainQueue() rejects every queued pending with
    // err.code='INTERRUPTED' so the abort-grace classifier
    // suppresses error replies.
    await pm.interrupt(sessionKey).catch((err) =>
      logger.error?.(`[${botName}] interrupt failed: ${err.message}`));
    pm.drainQueue(sessionKey, 'INTERRUPTED');

    clearAutosteeredReactions(sessionKey).catch(() => {});
    logEvent('abort-requested', {
      chat_id: chatId, user_id: msg.from?.id || null,
      had_active: hadActive,
      trigger: cleanText.slice(0, 40),
    });

    // Reply in the same language the user aborted in. Cyrillic-
    // detection is crude but reliable for ru/en.
    const lang = /[а-яё]/i.test(cleanText) ? 'ru' : 'en';
    const strs = {
      en: { stopped: 'Stopped.',     nothing: 'Nothing to stop.' },
      ru: { stopped: 'Остановлено.', nothing: 'Нечего останавливать.' },
    }[lang];
    const reply = hadActive ? strs.stopped : strs.nothing;
    try {
      await tg(bot, 'sendMessage', {
        chat_id: chatId, text: reply,
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
        ...(threadId && { message_thread_id: threadId }),
      }, { source: 'abort-ack', botName });
    } catch (err) {
      logger.error?.(`[${botName}] abort-ack send failed: ${err.message}`);
    }
    return true;
  };
}

module.exports = { createHandleAbort };

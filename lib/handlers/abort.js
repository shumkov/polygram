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

  return async function handleAbortIfRequested(msg, chatId, chatConfig, cleanText) {
    if (!isAbortRequest(cleanText)) return false;

    const threadId = msg.message_thread_id?.toString();
    const sessionKey = getSessionKey(chatId, threadId, chatConfig);
    const proc = pm.has(sessionKey) ? pm.get(sessionKey) : null;
    const hadActive = !!proc?.inFlight;

    // Mark BEFORE killing: the 'close' event fires almost immediately
    // after interrupt, and the surrounding handleMessage's catch
    // needs to see the flag to skip the generic error-reply.
    if (hadActive) markSessionAborted(sessionKey);

    // Bug 1 (incident 2026-05-18): "Stop" was turn-scoped — it only
    // looked at an in-flight TURN. But the agent can leave a DETACHED
    // background shell running (a `run_in_background:true` Bash) that
    // outlives the turn; the tmux TUI shows an `N shell` indicator.
    // When there is no live turn, check for such a shell and stop it
    // so "Stop" acts truthfully instead of replying "Nothing to stop"
    // while work is still churning. tmux-only — the SDK Process has no
    // hasBackgroundShell()/killBackgroundShells(); the typeof guards
    // make this a no-op there.
    let killedBackgroundShell = false;
    if (!hadActive && proc
      && typeof proc.hasBackgroundShell === 'function'
      && typeof proc.killBackgroundShells === 'function') {
      try {
        if (await proc.hasBackgroundShell()) {
          markSessionAborted(sessionKey);
          killedBackgroundShell = await proc.killBackgroundShells();
        }
      } catch (err) {
        logger.error?.(`[${botName}] background-shell stop failed: ${err.message}`);
      }
    }

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
      killed_background_shell: killedBackgroundShell,
      trigger: cleanText.slice(0, 40),
    });

    // Reply in the same language the user aborted in. Cyrillic-
    // detection is crude but reliable for ru/en.
    const lang = /[а-яё]/i.test(cleanText) ? 'ru' : 'en';
    const strs = {
      en: {
        stopped: 'Stopped.',
        bgStopped: 'Stopped the background task.',
        nothing: 'Nothing to stop.',
      },
      ru: {
        stopped: 'Остановлено.',
        bgStopped: 'Фоновая задача остановлена.',
        nothing: 'Нечего останавливать.',
      },
    }[lang];
    // Truthful ack: a stopped in-flight turn → "Stopped"; a stopped
    // background shell → "Stopped the background task"; neither →
    // "Nothing to stop".
    const reply = hadActive ? strs.stopped
      : killedBackgroundShell ? strs.bgStopped
      : strs.nothing;
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

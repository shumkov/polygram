/**
 * Per-message handler dispatcher.
 *
 * `dispatchHandleMessage(sessionKey, chatId, msg, bot)` is what
 * grammy's `bot.on('message')` calls per inbound — it runs
 * handleMessage in a fire-and-forget manner with centralised
 * error handling, in-flight-counter telemetry, and auto-resume
 * recovery on no-activity timeouts.
 *
 * Owned state:
 *   - inFlightHandlers (Map<sessionKey, count>) — per-session
 *     concurrent handler count. queue-depth-warning fires when
 *     this crosses queueWarnThreshold.
 *   - autoResumeTracker — per-session cooldown to prevent
 *     infinite resume-loop on permanently wedged tools.
 *
 * Auto-resume contract: on a 300s no-activity timeout (Claude
 * never emits a chunk), spawn a fresh Query resuming the same
 * claude_session_id and inject a continuation nudge. Falls back
 * to the standard error reply if the resume itself fails.
 */

'use strict';

const CONCURRENT_WARN_THRESHOLD_DEFAULT = 20;

function createDispatcher({
  config,
  db,
  dbWrite,
  tg,
  botName,
  logEvent,
  // Closures that polygram.js owns; passed in:
  handleMessage,                  // async (sessionKey, chatId, msg, bot)
  sendToProcess,                  // async (sessionKey, prompt, ctx)
  // Cross-cutting helpers:
  classifyError,                  // (err) → { kind, userMessage, isTransient, autoRecover }
  isAutoResumable,                // ({ error, aborted, replay, shuttingDown }) → boolean
  abortGrace,                     // lib/abort-grace.js instance
  autoResumeTracker,              // lib/db/auto-resume.js instance
  chunkMarkdownText,              // lib/telegram/chunk.js
  deliverReplies,                 // lib/telegram/deliver.js
  TG_MAX_LEN = 4096,
  // State accessors (need late binding because polygram.js mutates):
  getIsShuttingDown,              // () → boolean
  logger = console,
} = {}) {
  // Per-session in-flight handler count.
  const inFlightHandlers = new Map();

  function queueWarnThreshold() {
    const v = Number(config.bot?.queueWarnThreshold);
    return (Number.isInteger(v) && v > 0) ? v : CONCURRENT_WARN_THRESHOLD_DEFAULT;
  }

  function errorReplyText(err) {
    const { userMessage } = classifyError(err);
    return userMessage;  // may be null — "suppress reply" signal
  }

  // rc.54: spawn a fresh Query resuming the same session_id and ask
  // Claude to continue the timed-out work. The killed pm Query has
  // already torn down the wedged subprocess; getOrSpawnForChat creates
  // a new entry that picks up the saved session_id and sets
  // `--resume <id>` on the SDK Options.
  async function attemptAutoResume(sessionKey, chatId, originalMsg, bot) {
    const threadId = originalMsg.message_thread_id || null;

    // 1. Tell the user we're auto-resuming so they don't think
    //    nothing happened. Threaded under their original message.
    await tg(bot, 'sendMessage', {
      chat_id: chatId,
      text: '🔁 Auto-resuming after timeout — continuing where the previous turn left off.',
      reply_parameters: { message_id: originalMsg.message_id },
      ...(threadId && { message_thread_id: threadId }),
    }, { source: 'auto-resume-indicator', botName }).catch((sendErr) => {
      logger.error?.(`[${sessionKey}] auto-resume indicator send failed: ${sendErr.message}`);
    });

    // 2. Continuation prompt. Plain text — the SDK Query resumes
    //    the saved session_id, so Claude has full prior transcript
    //    context including its own partially-streamed text and
    //    tool calls. We just need to tell it WHAT happened.
    const continuation = '[polygram] Your previous turn timed out at 300s with no Claude activity (likely a wedged tool call — long Bash, hanging MCP, or stuck subagent). Continue from where you left off; do not restart from scratch. If the same operation would just hang again, abort it and tell me.';

    // 3. No-op streamer + reactor. We don't stream the resume
    //    turn's response (we'll send it as one message at the
    //    end). pm invokes streamer/reactor methods only when
    //    present; minimal stubs keep pm happy.
    const noopStreamer = {
      onChunk: async () => {},
      forceNewMessage: () => {},
      finalize: async () => ({ streamed: false }),
      flushDraft: async () => {},
      discard: async () => {},
    };
    const noopReactor = {
      setState: () => {},
      heartbeat: () => {},
      clear: async () => {},
      stop: () => {},
    };

    const result = await sendToProcess(sessionKey, continuation, {
      streamer: noopStreamer,
      reactor: noopReactor,
      sourceMsgId: originalMsg.message_id,
      threadId,
      onFirstStream: () => {},
    });

    if (result?.error) {
      throw new Error(`auto-resume turn errored: ${String(result.error).slice(0, 200)}`);
    }
    if (!result?.text) {
      throw new Error('auto-resume turn produced no text');
    }

    // 4. Send the continuation reply as regular Telegram messages,
    //    threaded under the original user message.
    const chunks = chunkMarkdownText(result.text, TG_MAX_LEN);
    await deliverReplies({
      bot,
      send: (b, method, params, m) => tg(b, method, params, m),
      chatId,
      threadId,
      chunks,
      replyToMessageId: originalMsg.message_id,
      meta: { source: 'auto-resume-reply', botName },
      logger: { error: (m) => logger.error?.(`[${sessionKey}] auto-resume deliver: ${m}`) },
    });

    return result.text;
  }

  function dispatchHandleMessage(sessionKey, chatId, msg, bot) {
    const count = (inFlightHandlers.get(sessionKey) || 0) + 1;
    inFlightHandlers.set(sessionKey, count);
    const warnAt = queueWarnThreshold();
    if (count === warnAt) {
      logEvent('queue-depth-warning', {
        chat_id: chatId, session_key: sessionKey,
        in_flight: count, threshold: warnAt,
      });
    }
    handleMessage(sessionKey, chatId, msg, bot).catch((err) => {
      const wasAborted = abortGrace.isRecent(sessionKey);
      const isReplay = msg._isReplay === true;
      const isShuttingDown = getIsShuttingDown();
      logger.error?.(`[${sessionKey}] Error: ${err.message}`);
      // Mark the row terminal so the right thing happens on next
      // boot:
      //   aborted        — user explicitly stopped → not replayable
      //   shutdown + new — 'replay-pending' so next boot re-dispatches
      //   shutdown + replay — keep 'replay-attempted' (one-shot guard
      //                       prevents infinite replay-on-replay)
      //   else           — 'failed' (genuine claude crash / timeout)
      const status = wasAborted
        ? 'aborted'
        : isShuttingDown
          ? (isReplay ? 'replay-attempted' : 'replay-pending')
          : 'failed';
      dbWrite(() => db.setInboundHandlerStatus({
        chat_id: chatId, msg_id: msg.message_id, status,
      }), `set handler_status=${status}`);
      logEvent('handler-error', {
        chat_id: chatId, session_key: sessionKey,
        msg_id: msg?.message_id,
        error: err.message?.slice(0, 500),
        stack: err.stack?.split('\n').slice(0, 5).join('\n'),
        aborted: wasAborted || undefined,
        replay: isReplay || undefined,
      });
      // rc.55: surface replay failures with a meaningful message.
      // Pre-rc.55 any boot-replay turn that failed for ANY reason
      // was silently dropped. The rc.51-onward boot-replay path is
      // a recovery primitive, not stale-message handling — when it
      // fails, the user IS still waiting.
      if (isReplay && !wasAborted && !isShuttingDown) {
        tg(bot, 'sendMessage', {
          chat_id: chatId,
          text: '⚠️ This turn was interrupted and didn\'t complete on retry — please rephrase or simplify, or split into smaller steps.',
          reply_parameters: { message_id: msg.message_id },
        }, { source: 'error-reply', botName }).catch((replyErr) => {
          logger.error?.(`[${sessionKey}] failed to send replay-failure reply: ${replyErr.message}`);
        });
      }
      // Suppress the user-facing error reply when:
      //   - boot replay (handled above),
      //   - shutting down ("Process killed" isn't a real error),
      //   - user just /stop'd (already saw their abort ack).
      if (!wasAborted && !isReplay && !isShuttingDown) {
        // rc.54: auto-resume on 300s no-activity timeout.
        const isResumeTurn = msg._isAutoResume === true;
        const resumable = !isResumeTurn && isAutoResumable({
          error: err, aborted: wasAborted, replay: isReplay, shuttingDown: isShuttingDown,
        });
        if (resumable && !autoResumeTracker.isInCooldown(sessionKey)) {
          autoResumeTracker.markAttempt(sessionKey);
          logEvent('auto-resume-attempted', {
            chat_id: chatId, session_key: sessionKey, msg_id: msg.message_id,
            original_error: err.message?.slice(0, 200),
          });
          attemptAutoResume(sessionKey, chatId, msg, bot)
            .then(() => {
              logEvent('auto-resume-success', {
                chat_id: chatId, session_key: sessionKey, msg_id: msg.message_id,
              });
              autoResumeTracker.clear(sessionKey);
            })
            .catch((resumeErr) => {
              logger.error?.(`[${sessionKey}] auto-resume failed: ${resumeErr?.message}`);
              logEvent('auto-resume-failed', {
                chat_id: chatId, session_key: sessionKey, msg_id: msg.message_id,
                error: resumeErr?.message?.slice(0, 200),
              });
              const fallbackText = errorReplyText(err);
              if (fallbackText) {
                tg(bot, 'sendMessage', {
                  chat_id: chatId, text: fallbackText,
                  reply_parameters: { message_id: msg.message_id },
                }, { source: 'error-reply', botName }).catch(() => {});
              }
            });
          return;
        }
        // 0.7.7: errorReplyText may return null (suppress reply
        // signal — INTERRUPTED inside abort grace).
        const replyText = errorReplyText(err);
        if (replyText) {
          tg(bot, 'sendMessage', {
            chat_id: chatId,
            text: replyText,
            reply_parameters: { message_id: msg.message_id },
          }, { source: 'error-reply', botName }).catch((replyErr) => {
            logger.error?.(`[${sessionKey}] failed to send error reply: ${replyErr.message}`);
          });
        }
      }
    }).finally(() => {
      const n = (inFlightHandlers.get(sessionKey) || 1) - 1;
      if (n <= 0) inFlightHandlers.delete(sessionKey);
      else inFlightHandlers.set(sessionKey, n);
    });
  }

  return {
    dispatchHandleMessage,
    attemptAutoResume,
    errorReplyText,
    queueWarnThreshold,
    inFlightHandlers,  // exposed so polygram.js can introspect for shutdown drain
  };
}

module.exports = {
  createDispatcher,
  CONCURRENT_WARN_THRESHOLD_DEFAULT,
};

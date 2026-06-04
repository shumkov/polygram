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

// Startup auto-retry (option a, 2026-06-04): a short breath before silently
// re-dispatching a message whose first attempt died in the dev-channels startup
// gate (TMUX_SESSION_GONE). Long enough that a host under momentary load isn't
// hammered with a back-to-back respawn, short enough that a transient flake
// still recovers fast enough to feel instant to the user.
const STARTUP_RETRY_DELAY_MS = 1500;

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
  // Raw-markdown size budget for chunkMarkdownText. Set BELOW Telegram's
  // 4096 hard limit to leave headroom for HTML inflation (toTelegramHtml
  // adds <b>/<i>/<code> tags + entity escapes; ~10-15% in practice).
  // Polygram passes TG_CHUNK_BUDGET (default 3500). Test default keeps
  // the historic 4096 for back-compat in synthetic test runs that pass
  // pre-formatted text.
  chunkBudget = 4096,
  // Delay before a silent startup auto-retry re-dispatches (TMUX_SESSION_GONE).
  // Injected so tests can drive it to 0; production uses STARTUP_RETRY_DELAY_MS.
  startupRetryDelayMs = STARTUP_RETRY_DELAY_MS,
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
    const chunks = chunkMarkdownText(result.text, chunkBudget);
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
      // Startup-gate death (claude exited during spawn / the dialog gate timed
      // out) of a likely-aged RESUMED session — the persisted claude_session_id
      // can't be resumed cleanly (shumorobot general chat 2026-06-01→03: a
      // week-old session renders claude's "Resume from summary?" dialog whose
      // /compact resume exits code 0 → TMUX_SESSION_GONE → the chat re-resumes
      // the same dead id on every message, stuck for days). Poison-clear so the
      // NEXT message spawns a FRESH session — same recovery the auto-resume path
      // does for BRIDGE_DISCONNECTED below. clearSessionId is a no-op DELETE when
      // there's no row (a genuine fresh-spawn failure), so this is safe; and
      // unlike an in-process recursive retry it never reuses a closed instance.
      if ((err.code === 'TMUX_SESSION_GONE' || err.code === 'CHANNELS_DIALOG_TIMEOUT')
          && typeof db.clearSessionId === 'function') {
        dbWrite(
          () => db.clearSessionId(sessionKey),
          `clearSessionId: poisoned by ${err.code} on startup`,
        );
        logEvent('session-reset-after-startup-gate', {
          chat_id: chatId, session_key: sessionKey, msg_id: msg?.message_id, code: err.code,
        });
      }
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
        // Startup auto-retry (option a, 2026-06-04). TMUX_SESSION_GONE = claude
        // exited INSIDE the startup gate, before the dev-channels channel went
        // live — so the user's message was NEVER delivered to claude. That makes
        // a re-send idempotent BY CONSTRUCTION (unlike a mid-turn drop, where
        // claude might still be slowly processing). The session_id was just
        // poison-cleared above, so re-dispatching the SAME message spawns a FRESH
        // session and delivers it. Silent: a transient startup flake (recurs
        // ~once/9h on the channels backend) never reaches the user — instead of
        // the "🔄 reset it, resend" papercut, polygram just retries. One-shot
        // (_startupRetried) so a host that genuinely can't start claude surfaces
        // the friendly reset reply (below) after EXACTLY one retry, never a loop.
        // Scoped to TMUX_SESSION_GONE only: CHANNELS_DIALOG_TIMEOUT is a real
        // blocking dialog (usage-limit / permission) a retry would just re-hit,
        // so it keeps its "please resend" copy.
        if (err.code === 'TMUX_SESSION_GONE' && !msg._startupRetried) {
          logEvent('startup-auto-retry', {
            chat_id: chatId, session_key: sessionKey, msg_id: msg?.message_id,
          });
          // Re-dispatch a COPY carrying the one-shot marker — never mutate the
          // caller's msg (the boot-replay path shares/re-reads it). unref the
          // best-effort timer so a pending retry can't pin the daemon alive
          // (the Telegram long-poll already keeps the loop running).
          const retryMsg = { ...msg, _startupRetried: true };
          setTimeout(
            () => dispatchHandleMessage(sessionKey, chatId, retryMsg, bot),
            startupRetryDelayMs,
          ).unref?.();
          return;
        }
        // rc.54: auto-resume on 300s no-activity timeout. The
        // resume turn itself runs through sendToProcess directly
        // (not handleMessage), so its errors don't re-enter this
        // catch block — autoResumeTracker.isInCooldown() is the
        // only guard needed against runaway loops.
        const resumable = isAutoResumable({
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
              // Music topic incident (2026-06-01): a channels session whose
              // context grew large enough to auto-/compact on resume loses its
              // MCP bridge binding on EVERY resume ("no MCP server configured"),
              // so the resumed turn re-detaches (BRIDGE_DISCONNECTED) and lands
              // here. The persisted claude_session_id is then poisoned — every
              // future message (manual resend OR post-cooldown auto-resume)
              // re-resumes it and re-detaches, an endless "🔌 please resend"
              // loop. Break it: drop the session row so the NEXT message spawns
              // a FRESH session (no --resume). Gated on the ORIGINAL error being
              // a bridge-detach AND auto-resume having failed — a one-off bridge
              // crash that resumes cleanly takes the .then() path above and
              // keeps its context; only a session that re-detaches on resume is
              // treated as poison. We lose the poisoned conversation's history,
              // but that session can't complete a turn anyway.
              if (err.code === 'BRIDGE_DISCONNECTED' && typeof db.clearSessionId === 'function') {
                dbWrite(
                  () => db.clearSessionId(sessionKey),
                  'clearSessionId: poisoned by bridge-detach on resume',
                );
                logEvent('session-reset-after-bridge-detach', {
                  chat_id: chatId, session_key: sessionKey, msg_id: msg.message_id,
                });
              }
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
  STARTUP_RETRY_DELAY_MS,
};

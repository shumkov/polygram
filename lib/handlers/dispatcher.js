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

const { createAuthDisabledGate } = require('../ops/auth-disabled-gate');
const { normalizeFinalText } = require('../codex/event-normalizer');

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
  recoverCodex,                   // async ({ sessionKey, chatId, msg, bot, providerRecovery })
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
  // Delay before a silent startup auto-retry re-dispatches a pre-delivery failure.
  // Injected so tests can drive it to 0; production uses STARTUP_RETRY_DELAY_MS.
  startupRetryDelayMs = STARTUP_RETRY_DELAY_MS,
  // AUTH_DISABLED dedupe/re-arm gate (docs/AUTH_DISABLED_HANDLING_SPEC.md).
  // Defaulted (rather than required) so a missing DI param at some future
  // call site degrades to "always notify, never dedupe" instead of throwing
  // — AUTH_DISABLED is account-wide, so an unguarded throw here would hit
  // every concurrent chat within seconds and risk tripping the storm circuit
  // breaker (polygram.js uncaughtException handler) on a wiring bug alone.
  authDisabledGate = createAuthDisabledGate(),
  // State accessors (need late binding because polygram.js mutates):
  getIsShuttingDown,              // () → boolean
  getOomObservation = () => null, // () → cgroup OOM observation
  logger = console,
} = {}) {
  // Per-session in-flight handler count.
  const inFlightHandlers = new Map();
  const activeHandlers = new Set();
  const activeHandlerTargets = new Set();

  function trackTask(task) {
    activeHandlers.add(task);
    task.then(
      () => activeHandlers.delete(task),
      () => activeHandlers.delete(task),
    );
    return task;
  }

  async function awaitSettlement({ timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (activeHandlers.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const error = new Error(
          `handler settlement timed out with ${activeHandlers.size} task(s) still active`,
        );
        error.code = 'HANDLER_SETTLEMENT_TIMEOUT';
        throw error;
      }
      let timeout;
      const timedOut = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(
            `handler settlement timed out with ${activeHandlers.size} task(s) still active`,
          );
          error.code = 'HANDLER_SETTLEMENT_TIMEOUT';
          reject(error);
        }, remainingMs);
        timeout.unref?.();
      });
      try {
        await Promise.race([
          Promise.allSettled([...activeHandlers]),
          timedOut,
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

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
  async function attemptAutoResume(
    sessionKey,
    chatId,
    originalMsg,
    bot,
    { provider = 'claude', providerRecovery = null } = {},
  ) {
    const threadId = originalMsg.message_thread_id || null;
    const isCodex = provider === 'codex';

    // 1. Tell the user we're auto-resuming so they don't think
    //    nothing happened. Threaded under their original message.
    await tg(bot, 'sendMessage', {
      chat_id: chatId,
      text: isCodex
        ? '🔁 Retrying because the Codex request was proven not sent.'
        : '🔁 Auto-resuming after timeout — continuing where the previous turn left off.',
      reply_parameters: { message_id: originalMsg.message_id },
      ...(threadId && { message_thread_id: threadId }),
    }, {
      source: 'auto-resume-indicator',
      botName,
      sessionKey,
      sourceMsgId: originalMsg.message_id,
    }).catch((sendErr) => {
      logger.error?.(`[${sessionKey}] auto-resume indicator send failed: ${sendErr.message}`);
    });

    if (isCodex) {
      if (typeof recoverCodex !== 'function') {
        const error = new Error('Exact Codex recovery path is unavailable');
        error.code = 'CODEX_RECOVERY_UNAVAILABLE';
        throw error;
      }
      const recovered = await recoverCodex({
        sessionKey,
        chatId,
        msg: originalMsg,
        bot,
        providerRecovery,
      });
      if (recovered?.ok === false) {
        const error = new Error(
          recovered.reason || 'Exact Codex recovery was not dispatched',
        );
        error.code = 'CODEX_RECOVERY_NOT_DISPATCHED';
        throw error;
      }
      return recovered;
    }

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
    const resultText = normalizeFinalText(result);
    if (!resultText) {
      throw new Error('auto-resume turn produced no text');
    }

    // 4. Deliver the continuation reply — UNLESS the resumed turn already
    //    delivered it itself. On the channels/cli backend Claude responds via the
    //    reply tool DURING the turn, so result.alreadyDelivered is set and the main
    //    dispatch path short-circuits its own deliver (cli-process.js ~2116). The
    //    resume path must honor it too, or the reply-tool send + this re-send
    //    double-post the SAME answer (field: shumabit@umi WhatsApp topic 2026-06-27,
    //    a bridge-disconnect resume sent "Fixed. ✅…" twice). SDK / genuine no-reply
    //    turns leave it falsy → deliver as before.
    if (result.alreadyDelivered) {
      logEvent('auto-resume-already-delivered', {
        chat_id: chatId, session_key: sessionKey, msg_id: originalMsg.message_id,
        text_len: resultText.length,
      });
      return resultText;
    }

    // Send the continuation reply as regular Telegram messages, threaded under
    // the original user message.
    const chunks = chunkMarkdownText(resultText, chunkBudget);
    await deliverReplies({
      bot,
      send: (b, method, params, m) => tg(b, method, params, m),
      chatId,
      threadId,
      chunks,
      replyToMessageId: originalMsg.message_id,
      meta: {
        source: 'auto-resume-reply',
        botName,
        sessionKey,
        sourceMsgId: originalMsg.message_id,
      },
      logger: { error: (m) => logger.error?.(`[${sessionKey}] auto-resume deliver: ${m}`) },
    });

    return resultText;
  }

  function dispatchHandleMessage(sessionKey, chatId, msg, bot) {
    const activeHandlerTarget = Object.freeze({
      sessionKey: String(sessionKey),
      chatId: String(chatId),
      threadId: msg?.message_thread_id == null
        ? null
        : String(msg.message_thread_id),
      telegramMessageId: String(msg?.message_id),
    });
    activeHandlerTargets.add(activeHandlerTarget);
    const count = (inFlightHandlers.get(sessionKey) || 0) + 1;
    inFlightHandlers.set(sessionKey, count);
    const warnAt = queueWarnThreshold();
    if (count === warnAt) {
      logEvent('queue-depth-warning', {
        chat_id: chatId, session_key: sessionKey,
        in_flight: count, threshold: warnAt,
      });
    }
    const task = handleMessage(sessionKey, chatId, msg, bot).catch(async (err) => {
      const wasAborted = abortGrace.isRecent(sessionKey);
      const isReplay = msg._isReplay === true;
      let oomShutdown = false;
      try {
        oomShutdown = getOomObservation()?.detected === true;
      } catch {}
      const isShuttingDown = getIsShuttingDown() || oomShutdown;
      let processLossResetFailed = false;
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
      dbWrite(() => (
        db.setInboundHandlerStatusUnlessCodexTerminal
        ?? db.setInboundHandlerStatus
      ).call(db, {
        chat_id: chatId, msg_id: msg.message_id, status,
      }), `set handler_status=${status}`);
      logEvent('handler-error', {
        chat_id: chatId, session_key: sessionKey,
        msg_id: msg?.message_id,
        error: err.message?.slice(0, 500),
        code: err.code || undefined,
        cause_code: err.cause?.code || undefined,
        stderr_tail: err.code === 'TMUX_SPAWN_FAILED' && typeof err.stderr === 'string'
          ? err.stderr.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-500)
          : undefined,
        stack: err.stack?.split('\n').slice(0, 5).join('\n'),
        aborted: wasAborted || undefined,
        replay: isReplay || undefined,
        oom_shutdown: oomShutdown || undefined,
      });
      // A lost contained process cannot service a resume. Only promise a fresh
      // session after the durable mapping has actually been removed.
      if (err.code === 'SESSION_PROCESS_LOST') {
        try {
          if (typeof db.clearSessionId !== 'function') {
            throw new Error('clearSessionId unavailable');
          }
          db.clearSessionId(sessionKey);
          logEvent('session-reset-after-process-loss', {
            chat_id: chatId, session_key: sessionKey, msg_id: msg?.message_id,
          });
        } catch (resetErr) {
          processLossResetFailed = true;
          logger.error?.(`[${sessionKey}] failed to clear lost session: ${resetErr.message}`);
          logEvent('session-reset-after-process-loss-failed', {
            chat_id: chatId, session_key: sessionKey, msg_id: msg?.message_id,
            error: resetErr.message?.slice(0, 200),
          });
        }
      }
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
      // AUTH_DISABLED (docs/AUTH_DISABLED_HANDLING_SPEC.md): Anthropic has
      // disabled Claude Code access on this account (e.g. non-payment).
      // Runs unconditionally — independent of wasAborted/isReplay/
      // isShuttingDown — because the account-disabled condition is real
      // regardless of what else was happening to this particular message.
      // The chat itself is never told (classify.js maps this code to
      // userMessage: null, so errorReplyText(err) below naturally suppresses
      // it) — this only notifies the operator, once per outage window.
      if (err.code === 'AUTH_DISABLED') {
        logger.error?.(`[auth] (${botName}) Claude access DISABLED by Anthropic — turn rejected immediately instead of wedging; check the account/billing.`);
        logEvent('auth-disabled', {
          chat_id: chatId, session_key: sessionKey, msg_id: msg?.message_id,
          error: err.message?.slice(0, 500),
        });
        // Never let the gate itself become a new failure mode — AUTH_DISABLED
        // is account-wide, so a bad gate would throw on every concurrent
        // chat within seconds of each other (see the storm circuit breaker
        // this repo already has for exactly that shape of cascading failure).
        let shouldNotify = false;
        try {
          shouldNotify = authDisabledGate.noteFailure();
        } catch (gateErr) {
          logger.error?.(`[auth] authDisabledGate.noteFailure failed: ${gateErr.message}`);
        }
        if (shouldNotify) {
          const adminChatId = config.bot?.approvals?.adminChatId;
          if (adminChatId) {
            tg(bot, 'sendMessage', {
              chat_id: adminChatId,
              text: `🚫 Claude Code access appears DISABLED for this account (Anthropic-side, e.g. non-payment) — turns are failing instead of replying. Check the Anthropic account/billing. (bot: ${botName})`,
            }, { source: 'auth-disabled-notify', botName }).catch((notifyErr) => {
              logger.error?.(`[auth] operator notify failed: ${notifyErr.message}`);
            });
          } else {
            logger.error?.(`[auth] AUTH_DISABLED fired but no config.bot.approvals.adminChatId configured — operator was not notified`);
          }
        }
      }
      // rc.55: surface replay failures with a meaningful message.
      // Pre-rc.55 any boot-replay turn that failed for ANY reason
      // was silently dropped. The rc.51-onward boot-replay path is
      // a recovery primitive, not stale-message handling — when it
      // fails, the user IS still waiting.
      // AUTH_DISABLED is excluded: it's an unconditional block like this
      // one, gated on isReplay rather than err.code, so without this
      // exclusion a replayed message failing with AUTH_DISABLED would fall
      // through into this hardcoded reply — contradicting the "chat is
      // never told, only the operator is" contract classify.js establishes
      // via userMessage: null (found in code review).
      if (isReplay && !wasAborted && !isShuttingDown && err.code !== 'AUTH_DISABLED') {
        tg(bot, 'sendMessage', {
          chat_id: chatId,
          text: '⚠️ This turn was interrupted and didn\'t complete on retry — please rephrase or simplify, or split into smaller steps.',
          reply_parameters: { message_id: msg.message_id },
        }, {
          source: 'error-reply',
          botName,
          sessionKey,
          sourceMsgId: msg.message_id,
        }).catch((replyErr) => {
          logger.error?.(`[${sessionKey}] failed to send replay-failure reply: ${replyErr.message}`);
        });
      }
      // Suppress the user-facing error reply when:
      //   - boot replay (handled above),
      //   - shutting down ("Process killed" isn't a real error),
      //   - user just /stop'd (already saw their abort ack).
      if (!wasAborted && !isReplay && !isShuttingDown) {
        let providerRecovery = null;
        if (typeof db.getReplayProviderRecovery === 'function') {
          try {
            providerRecovery = db.getReplayProviderRecovery({
              sessionKey,
              botName,
              telegramChatId: String(chatId),
              telegramMessageId: String(msg.message_id),
            });
          } catch (recoveryError) {
            providerRecovery = {
              provider: 'unknown',
              reason: 'provider-recovery-unavailable',
            };
            logEvent('provider-recovery-unavailable', {
              chat_id: chatId,
              session_key: sessionKey,
              msg_id: msg.message_id,
              code: recoveryError?.code || recoveryError?.name || 'unknown',
            });
          }
        }
        const provider = providerRecovery?.provider;
        // Retry once when startup fails before the bridge can deliver the user's
        // message. TMUX_SESSION_GONE is poison-cleared above; TMUX_SPAWN_FAILED
        // is already torn down by CliProcess's start-failure cleanup. Mid-turn
        // failures and blocking dialogs are excluded because replay could
        // duplicate work or immediately re-hit the same user decision.
        const startupRetryable = err.code === 'TMUX_SESSION_GONE'
          || err.code === 'TMUX_SPAWN_FAILED';
        if (startupRetryable && !msg._startupRetried) {
          logEvent('startup-auto-retry', {
            chat_id: chatId, session_key: sessionKey, msg_id: msg?.message_id,
            code: err.code,
          });
          // Re-dispatch a COPY carrying the one-shot marker — never mutate the
          // caller's msg (the boot-replay path shares/re-reads it). unref the
          // best-effort timer so a pending retry can't pin the daemon alive
          // (the Telegram long-poll already keeps the loop running).
          const retryMsg = { ...msg, _startupRetried: true };
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, startupRetryDelayMs);
            timer.unref?.();
          });
          if (getIsShuttingDown()) return;
          return dispatchHandleMessage(sessionKey, chatId, retryMsg, bot);
        }
        // rc.54: auto-resume on 300s no-activity timeout. The
        // resume turn itself runs through sendToProcess directly
        // (not handleMessage), so its errors don't re-enter this
        // catch block — autoResumeTracker.isInCooldown() is the
        // only guard needed against runaway loops.
        const resumable = err.code !== 'SESSION_PROCESS_LOST'
          && isAutoResumable({
            error: err, aborted: wasAborted, replay: isReplay, shuttingDown: isShuttingDown,
            provider,
            providerRecovery,
          });
        if (resumable && !autoResumeTracker.isInCooldown(sessionKey)) {
          autoResumeTracker.markAttempt(sessionKey);
          logEvent('auto-resume-attempted', {
            chat_id: chatId, session_key: sessionKey, msg_id: msg.message_id,
            original_error: err.message?.slice(0, 200),
          });
          return attemptAutoResume(sessionKey, chatId, msg, bot, {
            provider,
            providerRecovery,
          })
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
                }, {
                  source: 'error-reply',
                  botName,
                  sessionKey,
                  sourceMsgId: msg.message_id,
                }).catch(() => {});
              }
            });
        }
        // 0.7.7: errorReplyText may return null (suppress reply
        // signal — INTERRUPTED inside abort grace).
        const replyText = err.code === 'SESSION_PROCESS_LOST' && processLossResetFailed
          ? '⚠️ That Claude session stopped, but I couldn\'t safely reset its saved state. Please try again later.'
          : errorReplyText(err);
        if (replyText) {
          tg(bot, 'sendMessage', {
            chat_id: chatId,
            text: replyText,
            reply_parameters: { message_id: msg.message_id },
          }, {
            source: 'error-reply',
            botName,
            sessionKey,
            sourceMsgId: msg.message_id,
          }).catch((replyErr) => {
            logger.error?.(`[${sessionKey}] failed to send error reply: ${replyErr.message}`);
          });
        }
      }
    }).finally(() => {
      activeHandlerTargets.delete(activeHandlerTarget);
      const n = (inFlightHandlers.get(sessionKey) || 1) - 1;
      if (n <= 0) inFlightHandlers.delete(sessionKey);
      else inFlightHandlers.set(sessionKey, n);
    });
    return trackTask(task);
  }

  return {
    dispatchHandleMessage,
    attemptAutoResume,
    errorReplyText,
    queueWarnThreshold,
    inFlightHandlers,  // exposed so polygram.js can introspect for shutdown drain
    getActiveHandlerCount: () => activeHandlers.size,
    getActiveHandlerTargets: () => [...activeHandlerTargets],
    awaitSettlement,
    trackTask,
  };
}

module.exports = {
  createDispatcher,
  CONCURRENT_WARN_THRESHOLD_DEFAULT,
  STARTUP_RETRY_DELAY_MS,
};

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
    let hadActive = !!proc?.inFlight;

    // Mark BEFORE killing: the 'close' event fires almost immediately
    // after interrupt, and the surrounding handleMessage's catch
    // needs to see the flag to skip the generic error-reply.
    if (hadActive) markSessionAborted(sessionKey);

    // "Stop" incident (shumorobot Music, 2026-05-31 13:08): on the
    // CliProcess/channels backend a turn resolves on the quiet-window
    // after claude's last reply tool call (inFlight → false), but claude
    // can still be working (subagent, long Bash). Keying the ack on
    // inFlight alone made "Stop" say "Nothing to stop" while a subagent
    // download churned. probeBusyState() reads the TUI "esc to interrupt"
    // hint — the truthful signal — so detection, the abort mark, and the
    // ack all agree. The probe result is logged below (forensics) so the
    // heuristic can be refined against real states later. Channels analog
    // of the (deleted) tmux hasBackgroundShell branch; typeof-guarded so
    // it's a no-op on backends without it.
    let busyProbe = null;
    if (!hadActive && proc && typeof proc.probeBusyState === 'function') {
      try {
        busyProbe = await proc.probeBusyState();
        if (busyProbe?.busy) {
          hadActive = true;
          markSessionAborted(sessionKey);
        }
      } catch (err) {
        logger.error?.(`[${botName}] busy-probe failed: ${err.message}`);
      }
    }

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

    // Reject queued pendings first (err.code='INTERRUPTED' → the abort-grace
    // classifier suppresses their error replies AND each turn's finally clears
    // its reactor + typing), THEN stop the live work.
    pm.drainQueue(sessionKey, 'INTERRUPTED');
    if (hadActive && proc && proc.backend === 'cli') {
      // Channels HARD stop (user decision 2026-06-04: "/stop should stop
      // everything including background, like the SDK backend"). A soft C-c
      // interrupt leaves detached background shells + subagents running and
      // can't clear a ghost (no-pending-turn) busy state — the symptom was
      // "Stopped." with the reaction + typing still going. Kill the session: the
      // whole process tree (claude + every subagent + all background shells)
      // dies at once, the close drains the in-flight turn (clearing its
      // reactor/typing), and the next message respawns fresh (--resume restores
      // the conversation). This is what makes channels /stop "stop everything".
      await pm.kill(sessionKey, 'abort').catch((err) =>
        logger.error?.(`[${botName}] abort kill failed: ${err.message}`));
    } else {
      // SDK (or nothing active): non-destructive interrupt cancels the in-flight
      // Query turn WITHOUT tearing down the Query (cheap to reuse next message).
      await pm.interrupt(sessionKey).catch((err) =>
        logger.error?.(`[${botName}] interrupt failed: ${err.message}`));
    }

    clearAutosteeredReactions(sessionKey).catch(() => {});
    logEvent('abort-requested', {
      chat_id: chatId, user_id: msg.from?.id || null,
      had_active: hadActive,
      killed_background_shell: killedBackgroundShell,
      // "Stop" incident forensics: the raw busy-probe signals at decision
      // time. Lets us query, across real aborts, where the esc-hint /
      // inFlight / pending-turn signals agreed vs diverged and refine the
      // heuristic later. null when no probe ran (turn was already inFlight,
      // or the backend has no probeBusyState).
      busy_probe: busyProbe ? {
        busy: busyProbe.busy,
        streaming: busyProbe.streaming,
        in_flight: busyProbe.inFlight,
        pending_turns: busyProbe.pendingTurns,
        captured: busyProbe.captured,
        pane_tail: busyProbe.paneTail,
      } : null,
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

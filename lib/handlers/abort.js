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
 *   2. Tiered cancel (cheap by default, 2026-06-12): in-place
 *      interrupt keeps the proc warm (no --resume); kill only for
 *      ghosts / detached background shells / unverifiable state.
 *   3. pm.drainQueue() — rejects queued pendings with
 *      err.code='INTERRUPTED' so the abort-grace classifier
 *      suppresses error replies on the way out.
 *   4. Clear ✍ reactions on already-autosteered messages from
 *      this turn (now dead context).
 *   5. Acknowledge with a 👍 reaction on the stop message when
 *      something was stopped; silence otherwise. Never text.
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
  // Cancel-cheap (spec Finding 5): delay before the second background-shell
  // probe — catches a shell whose TUI mode-line hadn't rendered at probe #1.
  dualProbeDelayMs = 1000,
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
    // Cancel-cheap tiered gate (docs/0.13-cancel-efficiency-and-delete-trigger-
    // spec.md, locked 2026-06-12; supersedes the 2026-06-04 always-kill
    // decision). kill→--resume is the resume-death-race path AND a full
    // re-prefill on aged sessions, so the cli backend now interrupts IN PLACE
    // (C-c; claude stays resident, next message reuses the warm proc — live-
    // verified on 2.1.173: subagents die with the turn) and kills ONLY when
    // an in-place interrupt genuinely can't reach the work:
    //   - a GHOST busy-state (no pending turn but still streaming — interrupt
    //     can't clear its feedback; the close-drain can),
    //   - detached run_in_background shells (they survive C-c — live-verified;
    //     the pane scrape false-negatives, so cross-check the bg-work watchdog
    //     and dual-probe, and FAIL TOWARD KILL when unverifiable).
    let cancelMode = 'none';
    let killReason = null;
    if (hadActive && proc && proc.backend === 'cli') {
      let mustKill = false;
      if (!proc.inFlight) {
        // hadActive came from the busy probe with no pending turn = ghost.
        mustKill = true; killReason = 'ghost';
      } else if (typeof proc.probeBusyState !== 'function') {
        mustKill = true; killReason = 'no-probe';
      } else {
        try {
          const p1 = busyProbe || await proc.probeBusyState();
          let bg = !!p1?.backgroundShell;
          if (!bg && typeof proc.hasActiveBackgroundWork === 'function'
              && await proc.hasActiveBackgroundWork()) {
            bg = true;
          }
          if (!bg) {
            await new Promise((r) => setTimeout(r, dualProbeDelayMs));
            const p2 = await proc.probeBusyState();
            bg = !!p2?.backgroundShell;
          }
          if (bg) { mustKill = true; killReason = 'background-shell'; }
        } catch (err) {
          logger.error?.(`[${botName}] cancel bg-probe failed: ${err.message}`);
          mustKill = true; killReason = 'probe-failed';
        }
      }
      if (mustKill) {
        cancelMode = 'kill';
        await pm.kill(sessionKey, 'abort').catch((err) =>
          logger.error?.(`[${botName}] abort kill failed: ${err.message}`));
      } else {
        cancelMode = 'interrupt';
        await pm.interrupt(sessionKey).catch((err) =>
          logger.error?.(`[${botName}] interrupt failed: ${err.message}`));
      }
    } else {
      // SDK (or nothing active): non-destructive interrupt cancels the in-flight
      // Query turn WITHOUT tearing down the Query (cheap to reuse next message).
      if (hadActive) cancelMode = 'interrupt';
      await pm.interrupt(sessionKey).catch((err) =>
        logger.error?.(`[${botName}] interrupt failed: ${err.message}`));
    }

    clearAutosteeredReactions(sessionKey).catch(() => {});
    logEvent('abort-requested', {
      chat_id: chatId, user_id: msg.from?.id || null,
      had_active: hadActive,
      // Cancel-cheap soak signals: which tier fired, and why a kill was chosen
      // (ghost / background-shell / no-probe / probe-failed / null).
      cancel_mode: cancelMode,
      kill_reason: killReason,
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

    // Ack (locked design 2026-06-12, Ivan): a 👍 reaction on the user's stop
    // message when something was actually stopped — NEVER a text reply. The
    // old "Stopped." text was eventually-true at best (the interrupt settles
    // up to graceMs later) and chat noise at worst; the reaction is just
    // "got it, stopping" and is language-neutral. Nothing-to-stop → complete
    // silence (a 👍 there would lie).
    if (hadActive || killedBackgroundShell) {
      try {
        await tg(bot, 'setMessageReaction', {
          chat_id: chatId,
          message_id: msg.message_id,
          reaction: [{ type: 'emoji', emoji: '👍' }],
        }, { source: 'abort-ack', botName });
      } catch (err) {
        logger.error?.(`[${botName}] abort-ack reaction failed: ${err.message}`);
      }
    }
    return true;
  };
}

module.exports = { createHandleAbort };

/**
 * Factory for the SDK pm's lifecycle callbacks.
 *
 * polygram.js wires this at boot via createSdkCallbacks(deps); the
 * returned object is spread into ProcessManagerSdk's constructor as
 * `{ onInit, onClose, onStreamChunk, onToolUse,
 *    onAssistantMessageStart, onAutonomousAssistantMessage,
 *    onCompactBoundary }`.
 *
 * Each callback is a thin glue layer: pm-sdk emits a typed event,
 * polygram's callback decides what to persist (db / events) and
 * what to surface to the user (telegram).
 *
 * Why factory: callbacks need polygram-runtime context (db, config,
 * bot, BOT_NAME, tg, logEvent, dbWrite, classifyToolName, announce,
 * shouldAnnounce, contextHintShown, extractAssistantText, getChatIdFromKey,
 * getThreadIdFromKey). Closing over them at boot keeps each callback's
 * runtime signature compatible with pm-sdk's contract.
 */

'use strict';

const { getTopicConfig } = require('../session-key');
const { pickBackend } = require('../process/factory');

function createSdkCallbacks({
  db,
  dbWrite,
  config,
  bot,
  botName,
  tg,
  logEvent,
  classifyToolName,
  announce,
  shouldAnnounce,
  contextHintShown,
  extractAssistantText,
  getChatIdFromKey,
  getThreadIdFromKey,
  logger = console,
} = {}) {
  // rc.9: typing-indicator state for autosteer NEW-TURN extraction.
  // Keyed by sessionKey. extra-turn-started installs a 4-second
  // sendChatAction loop + tracks the autosteered msgId; extra-turn-
  // reply tears it down and clears ✍. SDK backend never installs
  // entries (it doesn't emit either event). Per-session, not per-msg,
  // because the TUI's queue is FIFO and we only watch one extra turn
  // at a time per session.
  const extraTurnTracker = new Map(); // sessionKey → { msgId, intervalHandle, chatId }

  function startExtraTurnVisuals(sessionKey, msgId) {
    if (!bot) return;
    const chatId = getChatIdFromKey(sessionKey);
    // Re-apply ✍ on the autosteered msg — clearAutosteeredReactions
    // fired when primary turn 1 succeeded, so the reaction is gone.
    // Best-effort; failures don't block.
    tg(bot, 'setMessageReaction', {
      chat_id: chatId,
      message_id: msgId,
      reaction: [{ type: 'emoji', emoji: '✍' }],
    }, { source: 'extra-turn-started', botName }).catch((err) => {
      logger.error?.(`[${botName}] extra-turn ✍ re-apply failed: ${err.message}`);
    });
    // Typing indicator loop — Telegram's typing action expires after
    // ~5s of inactivity, so we re-emit every 4s. Stops on extra-turn-
    // reply (or session close — see kill cleanup at the bottom of
    // this comment chain if needed).
    const tick = () => {
      tg(bot, 'sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      }, { source: 'extra-turn-typing', botName }).catch(() => {});
    };
    tick();
    const handle = setInterval(tick, 4_000);
    const prev = extraTurnTracker.get(sessionKey);
    if (prev?.intervalHandle) clearInterval(prev.intervalHandle);
    extraTurnTracker.set(sessionKey, { msgId, intervalHandle: handle, chatId });
  }

  function stopExtraTurnVisuals(sessionKey, msgId) {
    const entry = extraTurnTracker.get(sessionKey);
    if (!entry) return;
    if (entry.intervalHandle) clearInterval(entry.intervalHandle);
    extraTurnTracker.delete(sessionKey);
    // Clear ✍ on the autosteered msg — the reply itself is now the
    // "answered" signal. Use the tracker's chatId so we don't depend
    // on the caller passing it.
    if (bot && entry.chatId != null) {
      tg(bot, 'setMessageReaction', {
        chat_id: entry.chatId,
        message_id: msgId ?? entry.msgId,
        reaction: [],
      }, { source: 'extra-turn-reply-clear', botName }).catch((err) => {
        logger.error?.(`[${botName}] extra-turn ✍ clear failed: ${err.message}`);
      });
    }
  }

  return {
    onInit: (sessionKey, event, entry) => {
      // Resolve the spawn-time identity the SAME way the backends do
      // (topic override merged over chat-level + factory's
      // pickBackend) — must match what `buildSpawnContext` in
      // polygram.js compares against, otherwise every spawn re-poisons
      // the row with chat-level values and S2 drift fires forever.
      //
      // The shumorobot 2026-05-21 Music topic bug was this: chat-
      // level agent='shumabit' + cwd=$HOME got written into the row
      // every turn, but the topic-level resolved to
      // music-curation:music-curator + .../Music/rekordbox. Next turn
      // → drift → drop row → fresh sid → context lost. Forever.
      //
      // pm_backend MUST also be persisted explicitly; otherwise
      // db.upsertSession defaults it to 'sdk' for every spawn,
      // making historical telemetry meaningless.
      const chatConfig = config.chats[entry.chatId] || {};
      const topicConfig = getTopicConfig(chatConfig, entry.threadId || null);
      dbWrite(() => db.upsertSession({
        session_key: sessionKey,
        chat_id: entry.chatId,
        thread_id: entry.threadId,
        claude_session_id: event.session_id,
        agent: topicConfig.agent || chatConfig.agent || null,
        cwd: topicConfig.cwd || chatConfig.cwd || null,
        model: topicConfig.model || chatConfig.model || null,
        effort: topicConfig.effort || chatConfig.effort || null,
        pm_backend: pickBackend({
          config, chatId: entry.chatId, threadId: entry.threadId || null,
        }),
      }), `upsert session ${sessionKey}`);
    },

    onClose: (sessionKey, code, entry) => {
      logger.log?.(`[${entry.label}] Process exited (code ${code})`);
      logEvent('process-close', { chat_id: entry.chatId, session_key: sessionKey, code });
      // rc.9: if a session closes mid-extra-turn (turn 2 crashed,
      // user /stop, daemon kill), tear down typing-indicator + ✍
      // visuals so we don't leak the interval and aren't stuck
      // showing "writing…" on a dead session.
      stopExtraTurnVisuals(sessionKey, null);
    },

    onStreamChunk: (sessionKey, partial, entry) => {
      // Route to the head pending's per-turn streamer. In the
      // concurrent-pending model, only the HEAD is the turn Claude
      // is actively emitting events for.
      const head = entry.pendingQueue?.[0];
      const s = head?.context?.streamer;
      if (s) s.onChunk(partial).catch(() => {});
      // Heartbeat the reactor so long text generation doesn't trip
      // the 10s STALL → 🥱 / 30s TIMEOUT → 😨 promotion.
      const r = head?.context?.reactor;
      if (r && typeof r.heartbeat === 'function') r.heartbeat();
    },

    onToolUse: (sessionKey, toolName, entry) => {
      const head = entry.pendingQueue?.[0];
      const r = head?.context?.reactor;
      if (r) r.setState(classifyToolName(toolName));
      // Subagent announce: when Claude uses Task to spawn a subagent,
      // post a brief informational message. Per-chat 30s debounce
      // prevents announce-storms in tool-heavy turns.
      const chatCfg = config.chats[entry.chatId] || {};
      const optOut = chatCfg.announceSubagents != null
        ? chatCfg.announceSubagents === false
        : config.bot?.announceSubagents === false;
      if (toolName === 'Task' && !optOut) {
        if (shouldAnnounce(entry.chatId)) {
          announce({
            send: (b, method, params, m) => tg(b, method, params, m),
            bot, chatId: entry.chatId,
            threadId: head?.context?.threadId ?? null,
            text: '🤖 Spawning subagent…',
            meta: { botName, source: 'subagent-announce' },
            logger: { error: (m) => logger.error?.(`[${entry.label}] ${m}`) },
          });
        }
      }
    },

    // Each new top-level assistant message gets its own bubble.
    // When Claude emits text, then tool_use, then more text in a NEW
    // assistant message, the previous bubble's content stays visible
    // as a "thinking out loud" intermediate; the new message starts
    // fresh below.
    onAssistantMessageStart: (sessionKey, entry) => {
      const head = entry.pendingQueue?.[0];
      const s = head?.context?.streamer;
      if (s) s.forceNewMessage();
      // Heartbeat at every assistant-message boundary too. A long
      // thinking phase (effort=high, 30+s before first chunk) doesn't
      // fire onStreamChunk; without this, the freeze timer could
      // expire while the model is "still thinking but about to speak".
      const r = head?.context?.reactor;
      if (r && typeof r.heartbeat === 'function') r.heartbeat();
    },

    // rc.47: autonomous wakeup forwarding. Fires when an SDK
    // assistant message arrives with no head pending — typical
    // ScheduleWakeup case where the agent self-fires without an
    // inbound user message. Best-effort send: failures are logged
    // but don't propagate.
    onAutonomousAssistantMessage: (sessionKey, msg /* , entry */) => {
      try {
        // Backend-shape normalization: SDK emits the raw SDKMessage
        // (text is inside content[]); tmux emits a pre-extracted
        // {text, sessionId, backend}. Prefer the normalized field
        // when present; fall back to SDK extraction.
        const text = (msg && typeof msg.text === 'string' && msg.text)
          || extractAssistantText(msg);
        if (!text) return;
        const chatId = getChatIdFromKey(sessionKey);
        const threadIdRaw = getThreadIdFromKey(sessionKey);
        const threadId = threadIdRaw ? parseInt(threadIdRaw, 10) : null;
        // Review F#22: channels emits this event with alreadyDelivered=true
        // because its dispatcher already shipped the text to Telegram
        // (post-turn-resolve reply tool call). Skip the second send to avoid
        // identical-text double-delivery. Forensic log still fires so the
        // wakeup is visible in transcripts.
        if (msg?.alreadyDelivered) {
          logEvent('autonomous-wakeup-message', {
            chat_id: chatId,
            session_key: sessionKey,
            thread_id: threadIdRaw,
            text_len: text.length,
            already_delivered: true,
          });
          return;
        }
        if (!bot) {
          logger.error?.(`[${botName}] autonomous wakeup: bot not ready, dropping ${text.length} chars`);
          return;
        }
        const params = {
          chat_id: chatId,
          text,
          ...(Number.isInteger(threadId) && { message_thread_id: threadId }),
        };
        // Don't await — keep the pm-sdk event loop unblocked.
        tg(bot, 'sendMessage', params,
          { source: 'autonomous-wakeup', botName }).catch((err) => {
            logger.error?.(`[${botName}] autonomous wakeup send failed: ${err.message}`);
          });
        logEvent('autonomous-wakeup-message', {
          chat_id: chatId,
          session_key: sessionKey,
          thread_id: threadIdRaw,
          text_len: text.length,
        });
      } catch (err) {
        logger.error?.(`[${botName}] autonomous wakeup handler: ${err.message}`);
      }
    },

    // rc.9: pair-of with onExtraTurnReply. Fires the moment
    // TmuxProcess sees the dequeued user-message in JSONL → turn 2
    // is starting. Re-engages typing indicator + ✍ on the
    // autosteered msg so the user has a visible "still working on
    // this" signal during the gap between primary turn 1 ending and
    // the extra reply landing. Without this, Ivan saw a few seconds
    // of nothing (✍ cleared by clearAutosteeredReactions, no
    // typing).
    onExtraTurnStarted: (sessionKey, payload /* , entry */) => {
      try {
        const msgId = payload?.msgId;
        if (msgId == null) return;
        startExtraTurnVisuals(sessionKey, msgId);
        logEvent('extra-turn-started', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          msg_id: msgId,
          backend: payload?.backend || 'tmux',
        });
      } catch (err) {
        logger.error?.(`[${botName}] extra-turn-started handler: ${err.message}`);
      }
    },

    // rc.11.1: autosteer-resolution telemetry. Fires when the JSONL
    // tail confirms which path the autosteer resolved through:
    //   - via:'fold' — TUI absorbed the paste as queued_command
    //     attachment inside the current turn (one combined reply).
    //   - via:'new-turn' — TUI dequeued as a fresh user turn
    //     (extra-turn-reply pathway).
    // Querying `kind='autosteer-resolution'` in the events DB gives
    // a complete audit trail of every autosteer's fate.
    onAutosteerResolution: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('autosteer-resolution', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          msg_id: payload?.msgId,
          via: payload?.via,
          backend: payload?.backend || 'tmux',
        });
      } catch (err) {
        logger.error?.(`[${botName}] autosteer-resolution handler: ${err.message}`);
      }
    },

    // rc.11.1: autosteer-match-miss telemetry. Fires when JSONL has
    // a queue-folded or top-level user-message that LOOKS LIKE an
    // autosteer dequeue but no pending content matched. This is the
    // signature of a content-encoding mismatch (the exact rc.11.1
    // bug — oneLine ' / ' vs newline form). The payload includes
    // head-snippets of both sides for diff-by-eye in the events DB.
    onAutosteerMatchMiss: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('autosteer-match-miss', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          phase: payload?.phase,
          text_head: payload?.text_head ?? payload?.prompt_head,
          pending_head: payload?.pending_head,
          pending_count: payload?.pending_count,
          backend: payload?.backend || 'tmux',
        });
      } catch (err) {
        logger.error?.(`[${botName}] autosteer-match-miss handler: ${err.message}`);
      }
    },

    // R8: a failed autosteer paste. injectUserMessage fires
    // `inject-fail` when its fire-and-forget paste rejects (tmux
    // server gone, paste-buffer error, etc.). Before this handler was
    // wired the event had NO consumer — a failed autosteer was silent
    // until the stale-turn sweep caught it `turnTimeoutMs` later, so
    // the ✍ reaction sat on the message for up to 5 minutes with no
    // reply coming. This surfaces it immediately: log the failure for
    // diagnosis and clear the ✍ on the autosteered msgId so the user
    // is not left looking at a "noted, working on it" signal for a
    // message that never reached the agent. tmux-only — the SDK
    // backend's injectUserMessage never emits inject-fail.
    // 0.10.0 Commit 1 (observer-only): turn-phase predicate
    // transition. tmux backend only — see lib/process/turn-phase.js
    // and lib/process/tmux-process.js#_setPhase. Persisted as
    // `turn-phase-change` so the soak can verify the predicate
    // trajectory against real workloads before Commits 2-3 start
    // consuming turn.phase. Fires often (10-50 per turn typical, more
    // on heavy tool use); the payload is intentionally compact.
    onPhaseChange: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('turn-phase-change', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          turn_id: payload?.turnId ?? null,
          msg_id: payload?.msgId ?? null,
          kind: payload?.kind ?? null,        // primary | autosteer
          prev: payload?.prev,
          next: payload?.next,
          reason: payload?.reason,            // e.g. jsonl:tool-use:Agent
          ts: payload?.ts ?? null,
          backend: payload?.backend || 'tmux',
        });
      } catch (err) {
        logger.error?.(`[${botName}] phase-change handler: ${err.message}`);
      }
    },

    // 0.10.0 H1 (observer-only) + H2 (reactor wiring): tmux backend
    // hook-based turn observability + status.
    //
    // H1: TmuxProcess emits `hook-event` with normalized HookEvent
    // records for every claude-CLI hook firing (PreToolUse,
    // PostToolUse, UserPromptSubmit, Stop, SubagentStop, Notification,
    // plus `unknown` for any schema drift). Persisted compact for
    // forensic soak analysis.
    //
    // H2: routes hook events to the head pending's reactor so the
    // Telegram emoji reflects what claude is actually doing — incl.
    // subagent-inner tool fires (PreToolUse with `agent_id`) that
    // JSONL `tool-use` never surfaces. The win: long subagent turns
    // stop tripping the 🥱→😨→🤯 escalation because each inner
    // PostToolUse / SubagentStop / Notification heartbeats the
    // reactor, proving the agent is alive.
    //
    // Augments — does NOT replace — the existing JSONL-driven
    // `onToolUse` setState and stream-chunk heartbeats. Duplicate
    // setState for the same state is a no-op in the reactor; the
    // throttle/cascade timers are unchanged.
    //
    // Fields persisted are intentionally narrow: identity + tool/
    // subagent scoping + `duration_ms` (free per-tool latency from
    // PostToolUse) + a `received_at_ms` so we can measure Pre→Post
    // wall-clock independently of the CLI's own clock. Bulky payloads
    // (`tool_input`, full `tool_response`, `last_assistant_message`)
    // are NOT persisted to the events DB — they'd inflate row size
    // without informing the soak.
    onHookEvent: (sessionKey, payload, entry) => {
      try {
        // ── H1: DB persist ────────────────────────────────────────
        const detail = {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: 'tmux',
          hook_type:           payload?.type ?? null,
          claude_session_id:   payload?.sessionId ?? null,
          tool_name:           payload?.toolName ?? null,
          tool_use_id:         payload?.toolUseId ?? null,
          agent_id:            payload?.agentId ?? null,
          agent_type:          payload?.agentType ?? null,
          duration_ms:         payload?.durationMs ?? null,
          stop_hook_active:    payload?.stopHookActive ?? null,
          received_at_ms:      payload?.receivedAtMs ?? null,
        };
        // `parse-error` and `unknown` carry their raw body so soak
        // analysis can decide whether they indicate transport
        // corruption or schema drift. Truncate hard — these are
        // expected to be rare.
        if (payload?.type === 'parse-error' || payload?.type === 'unknown') {
          let rawStr;
          try { rawStr = JSON.stringify(payload.raw); }
          catch { rawStr = String(payload.raw); }
          detail.raw_truncated = (rawStr || '').slice(0, 512);
          detail.parse_error = payload?.error ?? null;
        }
        logEvent('hook-event', detail);

        // ── H2: route to reactor ──────────────────────────────────
        //
        // The reactor lives on the HEAD pending's per-turn context
        // (same shape as `onToolUse` and `onStreamChunk`). Hook
        // events from claude can land in three windows relative to
        // a polygram turn:
        //   1. Mid-turn (the normal case) — head exists, reactor
        //      lives, route the event.
        //   2. Between turns / before head is set — head is null,
        //      skip silently. The next setState from polygram-side
        //      turn lifecycle will recover.
        //   3. UserPromptSubmit fires BEFORE polygram's
        //      reactor.setState('THINKING') in some races; that's
        //      fine because UserPromptSubmit is intentionally a
        //      no-op here (the existing turn-start path owns it).
        const head = entry?.pendingQueue?.[0];
        const reactor = head?.context?.reactor;
        if (!reactor) return;

        switch (payload?.type) {
          case 'PreToolUse':
            // PreToolUse fires for main-agent AND subagent-inner
            // tools (the latter scoped by `agent_id`). The reactor
            // doesn't care WHO ran the tool, only WHAT — so
            // classifyToolName drives the state regardless of
            // agent context.
            if (payload.toolName) {
              reactor.setState(classifyToolName(payload.toolName));
            }
            break;

          case 'PostToolUse':
          case 'SubagentStop':
          case 'Notification':
            // Liveness signals — each one proves the agent is still
            // making progress. Heartbeat resets the STALL (🥱) and
            // TIMEOUT (😨) timers, killing the fear escalation on
            // long healthy turns that was the motivating msg-884
            // incident.
            if (typeof reactor.heartbeat === 'function') {
              reactor.heartbeat();
            }
            break;

          // UserPromptSubmit, Stop, unknown, parse-error: no
          // reactor routing. Turn lifecycle owns start/clear; the
          // observer-only H1 DB persist above still records them
          // for forensics.
          default:
            break;
        }
      } catch (err) {
        logger.error?.(`[${botName}] hook-event handler: ${err.message}`);
      }
    },

    // 0.10.0 rc.42 #1: tmux backend turn-timeout observability.
    // H3 introduced two timeout racers (idle-ceiling, hard-backstop)
    // but their `reason`/`idleMs` were silently dropped at the throw
    // site, so the events DB couldn't distinguish a wedged-silent
    // subagent (msg-884 shape) from a 4-hour runaway tool loop. The
    // handler persists the distinguisher.
    onTurnTimeout: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('turn-timeout', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: 'tmux',
          turn_id:             payload?.turnId ?? null,
          reason:              payload?.reason ?? null,
          idle_ms:             payload?.idleMs ?? null,
          turn_timeout_ms:     payload?.turnTimeoutMs ?? null,
          hard_backstop_ms:    payload?.hardBackstopMs ?? null,
          claude_session_id:   payload?.sessionId ?? null,
        });
      } catch (err) {
        logger.error?.(`[${botName}] turn-timeout handler: ${err.message}`);
      }
    },

    // 0.10.0 rc.42 #8: tmux backend hook-tail error observability.
    // Persistent failures of the hook ndjson tail degrade H3 idle-
    // ceiling accuracy and H4 Stop-synth coverage with no surface
    // signal. Record one event per error so post-mortem can correlate
    // unexpected idle-timeouts to a broken tail.
    onHookTailError: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('hook-tail-error', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: 'tmux',
          message:           (payload?.message || '').slice(0, 200),
          path:              payload?.path ?? null,
          claude_session_id: payload?.sessionId ?? null,
        });
      } catch (err) {
        logger.error?.(`[${botName}] hook-tail-error handler: ${err.message}`);
      }
    },

    // 0.10.0 rc.42 #15: H4 Stop-hook synth fired and won the race
    // against JSONL `result` (or JSONL never landed). Forensic count
    // of how often Stop actually rescues a stuck JSONL stream.
    onStopHookResolved: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('stop-hook-resolved', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: 'tmux',
          turn_id:           payload?.turnId ?? null,
          claude_session_id: payload?.sessionId ?? null,
        });
      } catch (err) {
        logger.error?.(`[${botName}] stop-hook-resolved handler: ${err.message}`);
      }
    },

    // 0.10.0 rc.43: claude TUI session-age resume prompt was
    // auto-dismissed by `_waitForReady`. Counting these helps decide
    // whether to push the "Don't ask me again" option globally vs
    // keep the auto-dismiss as a safety net.
    onSessionAgePromptDismissed: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('session-age-prompt-dismissed', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: 'tmux',
          claude_session_id: payload?.sessionId ?? null,
        });
      } catch (err) {
        logger.error?.(`[${botName}] session-age-prompt-dismissed handler: ${err.message}`);
      }
    },

    onInjectFail: (sessionKey, payload /* , entry */) => {
      try {
        const msgId = payload?.msgId;
        logEvent('inject-fail', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          msg_id: msgId ?? null,
          error: (payload?.err || '').slice(0, 200),
          backend: payload?.backend || 'tmux',
        });
        if (bot && msgId != null) {
          const chatId = getChatIdFromKey(sessionKey);
          tg(bot, 'setMessageReaction', {
            chat_id: chatId,
            message_id: msgId,
            reaction: [],
          }, { source: 'inject-fail-clear', botName }).catch((err) => {
            logger.error?.(`[${botName}] inject-fail ✍ clear failed: ${err.message}`);
          });
        }
      } catch (err) {
        logger.error?.(`[${botName}] inject-fail handler: ${err.message}`);
      }
    },

    // rc.7: tmux backend autosteer NEW-TURN extra reply. Fires when
    // the TUI's queue dequeued an autosteered paste as a fresh user
    // turn — typically when the primary turn was a short / cached
    // reply that finished before the paste could fold in. The
    // payload carries { msgId, text, sessionId, backend }; msgId is
    // the Telegram message_id of the autosteered user message
    // (so the reply lands as a Telegram reply to that message,
    // matching how Ivan visually expects autosteer to behave).
    //
    // SDK backend NEVER emits this — its PostToolBatch fold path
    // guarantees one combined reply via the primary pm.send().
    // This is purely a tmux-backend bridge.
    onExtraTurnReply: (sessionKey, payload /* , entry */) => {
      try {
        const text = payload?.text;
        const msgId = payload?.msgId;
        // rc.9: ALWAYS tear down extra-turn visuals first, even if
        // text/msgId are missing — otherwise the typing-indicator
        // loop would run forever for that session.
        stopExtraTurnVisuals(sessionKey, msgId);
        if (!text || msgId == null) return;
        const chatId = getChatIdFromKey(sessionKey);
        const threadIdRaw = getThreadIdFromKey(sessionKey);
        const threadId = threadIdRaw ? parseInt(threadIdRaw, 10) : null;
        if (!bot) {
          logger.error?.(`[${botName}] extra-turn-reply: bot not ready, dropping ${text.length} chars`);
          return;
        }
        const params = {
          chat_id: chatId,
          text,
          reply_to_message_id: msgId,
          ...(Number.isInteger(threadId) && { message_thread_id: threadId }),
        };
        // Don't await — keep the pm event loop unblocked.
        tg(bot, 'sendMessage', params,
          { source: 'extra-turn-reply', botName }).catch((err) => {
            logger.error?.(`[${botName}] extra-turn-reply send failed: ${err.message}`);
          });
        logEvent('extra-turn-reply', {
          chat_id: chatId,
          session_key: sessionKey,
          thread_id: threadIdRaw,
          msg_id: msgId,
          text_len: text.length,
          backend: payload?.backend || 'tmux',
        });
      } catch (err) {
        logger.error?.(`[${botName}] extra-turn-reply handler: ${err.message}`);
      }
    },

    // SDK auto-compaction observability. Fires when SDK emits
    // SDKCompactBoundaryMessage. Surfaces a quiet system status note
    // to the chat so the user knows the bot is busy reorganising
    // context. ON by default; set per-chat or per-bot
    // `announceCompact: false` to silence.
    onCompactBoundary: async (sessionKey, msg, entry) => {
      // Clear the contextHint once-per-cycle gate. After compaction,
      // context drops below threshold; if it climbs back up the next
      // cycle should fire a fresh hint.
      contextHintShown.delete(sessionKey);

      const chatCfg = config.chats[entry.chatId] || {};
      const optOut = chatCfg.announceCompact != null
        ? chatCfg.announceCompact === false
        : config.bot?.announceCompact === false;
      if (optOut) return;
      const threadId = entry.threadId || undefined;

      // Word the message based on what actually happened. Pre-rc.62
      // every event read as "💭 Catching up…" — but compact_boundary
      // fires AFTER compaction completes, leaving users confused
      // when nothing followed. Now: distinguish manual vs auto and
      // surface the compression ratio.
      // Backend-shape normalization: SDK emits the raw SDKMessage
      // with compact_metadata nested; tmux emits flat fields. Try
      // top-level first (tmux), then nested (SDK).
      const meta = msg?.compact_metadata || {};
      const trigger = msg?.trigger ?? meta.trigger;             // 'manual' | 'auto'
      const preTokens = msg?.pre_tokens ?? meta.pre_tokens;
      const postTokens = msg?.post_tokens ?? meta.post_tokens;
      const durationMs = msg?.duration_ms ?? meta.duration_ms;
      const fmtTok = (n) => {
        if (n == null) return null;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
        return String(n);
      };
      const ratio = (preTokens && postTokens)
        ? `${fmtTok(preTokens)} → ${fmtTok(postTokens)}` : null;
      const duration = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : null;
      const stats = [ratio, duration].filter(Boolean).join(', ');

      let text;
      if (trigger === 'manual') {
        text = stats
          ? `✅ Compacted (${stats}). Ready for your next message.`
          : `✅ Compacted. Ready for your next message.`;
      } else {
        text = stats
          ? `💭 Auto-compacted (${stats}). Continuing…`
          : `💭 Auto-compacted. Continuing…`;
      }

      try {
        await tg(bot, 'sendMessage', {
          chat_id: entry.chatId,
          text,
          ...(threadId ? { message_thread_id: threadId } : {}),
        }, { source: 'compact-boundary', botName });
      } catch (err) {
        logger.error?.(`[${entry.label}] compact-boundary post: ${err.message}`);
      }
    },
  };
}

module.exports = { createSdkCallbacks };

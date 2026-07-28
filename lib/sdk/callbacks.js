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
const { pickBackend } = require('@shumkov/orchestra');
const {
  isCodexProcess,
  normalizeStreamText,
} = require('../codex/event-normalizer');

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
  // Review F#23: pipeline deps for the autonomous-wakeup path. Optional —
  // when supplied, onAutonomousAssistantMessage routes text through
  // processAndDeliverAgentText (parseResponse + sanitizeAssistantReply +
  // chunkMarkdownText + deliverReplies + inline sticker/react). When
  // omitted (legacy callers, lightweight tests), the handler falls back
  // to the original raw tg(sendMessage) — sticker/canned-string tags
  // would leak as literal text on that path.
  parseResponse,
  sanitizeAssistantReply,
  chunkMarkdownText,
  deliverReplies,
  processAndDeliverAgentText,
  // 0.15: (secret, {chat_id, thread_id}) → { redacted } — wipes an agent-flagged
  // secret ([redact:<secret>]) from the stored inbound on the autonomous-wakeup
  // path. Optional; the helper no-ops when undefined.
  redactInbound = null,
  // 0.12 interactive questions: (payload) => renders the Telegram keyboard when
  // claude calls the `ask` tool. Optional — omitted in tests / SDK-only callers.
  renderQuestion,
  // 0.13 D3: session-scoped feedback controller (lib/feedback/session-feedback.js)
  // — visuals for cycles with NO pending turn (wakeups, fireUserMessage
  // self-checks, injected messages picked up as their own cycle). Optional.
  sessionFeedback = null,
  logger = console,
} = {}) {
  // 0.13 P4: the rc.9 extraTurnTracker (tmux NEW-TURN typing/✍ bridge) was
  // deleted — zero 'extra-turn-started'/'extra-turn-reply' emitters exist on
  // any backend since the 0.12 tmux deletion. Cycles with no pending turn
  // are owned by the session feedback controller (lib/feedback/) now.
  // 0.12.0 background-work visibility (Use 3): sessionKey → message_id of the live
  // "⏳ working in background" status message, so the cleared/close paths can edit
  // it to a final state instead of leaving it dangling as "working".
  const bgStatusMsgIds = new Map();

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
      if (isCodexProcess(entry)) {
        dbWrite(() => db.upsertProviderSession({
          session_key: sessionKey,
          namespace: 'codex:app-server',
          provider: 'codex',
          provider_session_id: event.providerSessionId ?? event.session_id,
          app_server_session_id: event.appServerSessionId ?? null,
          agent: null,
          cwd: entry.cwd,
          model: entry.model,
          effort: entry.effort,
          pm_backend: 'codex',
        }), `upsert Codex session ${sessionKey}`);
        return;
      }

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
          pmDefault: 'sdk',   // polygram's default backend (orchestra defaults to 'cli')
        }),
      }), `upsert session ${sessionKey}`);
    },

    onClose: (sessionKey, code, closeDetailOrEntry, appendedEntry) => {
      // ProcessManager appends the live Process after the event arguments.
      // Claude emits only `code`, while Codex emits `code, closeDetail`; keep
      // the detail from shifting the process entry out of this callback.
      const entry = appendedEntry ?? closeDetailOrEntry;
      const closeDetail = appendedEntry ? closeDetailOrEntry : null;
      logger.log?.(`[${entry.label}] Process exited (code ${code})`);
      logEvent('process-close', {
        chat_id: entry.chatId,
        session_key: sessionKey,
        code,
        ...(closeDetail?.generationId
          ? { generation_id: closeDetail.generationId }
          : {}),
        ...(closeDetail?.reason ? { reason: closeDetail.reason } : {}),
      });
      // 0.13 D3: a session closing mid-autonomous-cycle must tear down the
      // controller's visuals (typing loop + anchor reaction) — the safety net
      // against a forever-typing leak on a dead session.
      sessionFeedback?.endCycle(sessionKey);
      // 0.12.0 bg-work visibility: if a "⏳ working in background" status is still
      // up when the session closes, its shell died with the session — edit to a
      // final state so it doesn't dangle as "working" forever.
      const bgMid = bgStatusMsgIds.get(sessionKey);
      if (bgMid != null && bot) {
        bgStatusMsgIds.delete(sessionKey);
        tg(bot, 'editMessageText', {
          chat_id: entry.chatId, message_id: bgMid,
          text: '⏹ Background work ended (session restarted).',
        }, { source: 'bg-work-status', botName }).catch(() => {});
      }
    },

    onStreamChunk: (sessionKey, partial, entry) => {
      const normalized = normalizeStreamText(partial, entry);
      if (isCodexProcess(entry) && normalized == null) {
        logEvent('codex-stream-event-invalid', {
          chat_id: entry?.chatId ?? getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          generation_id: entry?.generationId ?? null,
          value_type: typeof partial,
        });
        return;
      }
      // Route to the head pending's per-turn streamer. In the
      // concurrent-pending model, only the HEAD is the turn Claude
      // is actively emitting events for.
      const head = entry.pendingQueue?.[0];
      const s = head?.context?.streamer;
      if (s) {
        // A finalized streamer silently swallows further chunks. That is the
        // right behavior — the bubble is settled — but from the outside it
        // looks like "streaming just stopped", so make it diagnosable. ONCE per
        // streamer: the events table has no retention, and a chatty turn that
        // keeps streaming past finalize would write a row per chunk to say the
        // same thing.
        if (s.state === 'finalized' && !head._streamAfterFinalizeLogged) {
          head._streamAfterFinalizeLogged = true;
          logEvent('stream-after-finalize', {
            chat_id: entry?.chatId ?? getChatIdFromKey(sessionKey),
            session_key: sessionKey,
            bot: botName,
          });
        }
        // Same canned-string safety net the delivered reply gets. A CLI-context
        // leak like "No response requested." must not render live in the
        // preview bubble either. (Inline [sticker:]/[react:]/[redact:] markers,
        // including a still-incomplete trailing one, are already stripped by
        // the streamer's own transformText.)
        const clean = (typeof normalized === 'string'
          && typeof sanitizeAssistantReply === 'function')
          ? sanitizeAssistantReply(normalized).text
          : normalized;
        s.onChunk(clean).catch(() => {});
      }
      // Heartbeat the reactor so long text generation doesn't trip
      // the 10s STALL → 🥱 / 30s TIMEOUT → 😨 promotion.
      const r = head?.context?.reactor;
      if (r && typeof r.heartbeat === 'function') r.heartbeat();
    },

    // 0.12 Phase 3.2 (Finding 0.1.A): rc.45 esc-to-interrupt liveness
    // heartbeat ported from tmux backend. CliProcess emits 'thinking'
    // when capture-pane sees claude's "esc to interrupt" indicator —
    // the only signal we get during pure-thinking turns when no hook
    // events fire. Without this, a 60s pure-thinking turn would trigger
    // STALL (🥱 at 45s) before claude finishes. Same heartbeat semantics
    // as onStreamChunk: just resets the cascade timer, doesn't change
    // state. Idempotent.
    onThinking: (sessionKey, entry) => {
      const head = entry.pendingQueue?.[0];
      const r = head?.context?.reactor;
      if (r && typeof r.heartbeat === 'function') r.heartbeat();
      // 0.13 D3 (the voice-ack gap): on cli, onFirstStream never fires, so a
      // turn whose reactor was never set (👂 voice-ack held, THINKING skipped)
      // stayed on the ear forever on tool-less turns. The pane heartbeat is
      // the first life sign — promote ONCE from never-set; later polls no-op.
      if (r && typeof r.setState === 'function' && r.currentState == null) {
        r.setState('THINKING');
      }
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
        // 0.13 D3 fix: the cycle delivered its answer → stop its "typing…" NOW. endCycle
        // (Process idle = SESSION idle) is delayed by any later turn, so typing otherwise
        // spins minutes past the delivered answer. docs/typing-tracks-activity-spec.md
        sessionFeedback?.stopCycleTyping?.(sessionKey);
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

        // Review F#23: when wired with the agent-reply pipeline deps, route
        // text through processAndDeliverAgentText so `[sticker:NAME]` /
        // `[react:EMOJI]` / canned-string protections apply on this path too.
        // Pre-F#23 the handler did raw tg(sendMessage), bypassing all three
        // protections. Falls back to the legacy raw send if the deps aren't
        // wired (older callers / tests).
        if (typeof processAndDeliverAgentText === 'function'
            && typeof parseResponse === 'function'
            && typeof sanitizeAssistantReply === 'function'
            && typeof chunkMarkdownText === 'function'
            && typeof deliverReplies === 'function') {
          // Don't await — keep the pm-sdk event loop unblocked.
          processAndDeliverAgentText({
            text,
            bot,
            tg,
            chatId,
            threadId: Number.isInteger(threadId) ? threadId : null,
            replyToMessageId: null,    // autonomous wakeup has no inbound msg to reply to
            applyReactions: false,     // no target msg → log+drop any [react:]
            source: 'autonomous-wakeup',
            meta: { botName },
            parseResponse,
            sanitizeAssistantReply,
            chunkMarkdownText,
            deliverReplies,
            logEvent,
            sessionKey,
            logger,
            redactInbound,
          }).catch((err) => {
            logger.error?.(`[${botName}] autonomous wakeup helper failed: ${err.message}`);
          });
          logEvent('autonomous-wakeup-message', {
            chat_id: chatId,
            session_key: sessionKey,
            thread_id: threadIdRaw,
            text_len: text.length,
            pipeline: 'helper',
          });
          return;
        }

        // Legacy fallback (helper deps not wired). Tests that don't supply the
        // pipeline deps still observe the original behavior.
        const params = {
          chat_id: chatId,
          text,
          ...(Number.isInteger(threadId) && { message_thread_id: threadId }),
        };
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

    // 0.12.0 background-work visibility (Use 3). CliProcess emits this when a
    // detached `run_in_background` shell is first observed running idle past its
    // turn ('running') and again when it clears ('cleared'). We post ONE bot
    // status message and edit it to done — so a long job reads as working, not
    // stuck. Direct tg send (NOT via claude — this is a bot status indicator),
    // keyed by sessionKey so the cleared/close paths can find it to edit.
    // 0.12 interactive questions: claude called the `ask` tool. Render the
    // Telegram inline keyboard via the question handler (late-bound from polygram).
    // payload: {chatId, threadId, turnId, toolCallId, questions}. The handler
    // itself is anti-hang (answers claude {cancelled} on any send failure).
    // 0.12 interactive questions: the blocking `ask` resolved → the turn is resuming work. The
    // per-turn reactor cleared when claude posted its reply + asked, and no hooks fired during
    // the wait, so it never came back — the post-answer work showed no progress ("why don't I
    // see it working after submit?"). Re-arm the head pending's reactor to THINKING. setState is
    // a safe no-op if the reactor was stopped; typing is unaffected (its per-turn loop runs to
    // turn-end). Guarded — never throws on a torn-down turn.
    // 0.13 D3: 'turn-start' (UPS) finally consumed. A pickup with NO pending
    // turn is an autonomous/injected cycle starting — pre-P4 nothing showed
    // until text landed. Engage the session feedback controller (typing +
    // optional anchor 🤔 on the picked-up message, which the ledger names).
    onTurnStart: (sessionKey, payload, entry) => {
      try {
        if (!sessionFeedback) return;
        const hasPending = payload?.hasPending ?? (entry?.pendingQueue?.length > 0);
        if (hasPending) return;   // normal turns own their per-turn visuals
        sessionFeedback.startAutonomousCycle(sessionKey, { anchorMsgId: payload?.anchorMsgId ?? null });
      } catch (err) {
        logger.error?.(`[${botName}] onTurnStart failed: ${err.message}`);
      }
    },

    // 0.13 D3: the cycle settled — end any autonomous visuals.
    onIdle: (sessionKey /* , entry */) => {
      try { sessionFeedback?.endCycle(sessionKey); }
      catch (err) { logger.error?.(`[${botName}] onIdle failed: ${err.message}`); }
    },

    onQuestionResumed: (sessionKey, entry) => {
      try {
        const ctx = entry?.pendingQueue?.[0]?.context;
        // 0.13 D1 (S8): the answer landed — claude is working again. Resume
        // the per-turn typing loop that onQuestionAsked paused. Fires before
        // the reactor re-arm and independently of it (typing must come back
        // even if this turn carries no reactor).
        ctx?.typing?.resume?.();
        const r = ctx?.reactor;
        if (r && typeof r.setState === 'function') {
          // 0.17.4: release the question-wait hold (a concurrent sub-agent hold, if
          // any, keeps its own — owner-scoped so they don't stomp each other).
          if (typeof r.setWorkInFlight === 'function') r.setWorkInFlight(false, 'question');
          r.setState('THINKING');
          logEvent('question-resumed', { chat_id: getChatIdFromKey(sessionKey), session_key: sessionKey });
        }
      } catch (err) {
        logger.error?.(`[${botName}] onQuestionResumed failed: ${err.message}`);
      }
    },

    onQuestionAsked: async (sessionKey, payload, entry) => {
      try {
        // 0.13 D1 (S8): waiting-on-user — pause the per-turn typing loop the
        // moment the keyboard goes up. "typing…" while the bot waits on the
        // USER is the inverted signal; D1 keeps the turn (and its typing
        // loop) alive through the whole wait, so without this pause every
        // ask-wait would show continuous typing. Guarded no-op on dead turns.
        try { entry?.pendingQueue?.[0]?.context?.typing?.pause?.(); } catch { /* guarded */ }
        // 0.17.4: hold the reaction through the question wait — it's waiting on the
        // USER, not stalled, so don't let it decay to the 🥱/😨 stall faces (reuses
        // the B3 work-in-flight hold). Released on the answer in onQuestionResumed.
        try {
          const r = entry?.pendingQueue?.[0]?.context?.reactor;
          if (r && typeof r.setWorkInFlight === 'function') r.setWorkInFlight(true, 'question');
        } catch { /* guarded */ }
        if (typeof renderQuestion !== 'function') return;
        await renderQuestion({ sessionKey, ...payload });
      } catch (err) {
        logger.error?.(`[${botName}] onQuestionAsked failed: ${err.message}`);
      }
    },

    onBgWorkStatus: async (sessionKey, payload) => {
      try {
        if (!bot) return;
        const chatId = getChatIdFromKey(sessionKey);
        const threadIdRaw = getThreadIdFromKey(sessionKey);
        const threadId = threadIdRaw ? parseInt(threadIdRaw, 10) : null;
        const state = payload?.state;
        if (state === 'running') {
          if (bgStatusMsgIds.has(sessionKey)) return; // already showing one
          const res = await tg(bot, 'sendMessage', {
            chat_id: chatId,
            text: '⏳ Working in the background — I\'ll keep an eye on it and report when it\'s done.',
            ...(Number.isInteger(threadId) && { message_thread_id: threadId }),
          }, { source: 'bg-work-status', botName });
          const mid = res?.message_id ?? res?.result?.message_id ?? null;
          if (mid != null) bgStatusMsgIds.set(sessionKey, mid);
          logEvent('bg-work-status', {
            chat_id: chatId, session_key: sessionKey, thread_id: threadIdRaw,
            state: 'running', message_id: mid,
          });
        } else if (state === 'cleared') {
          const mid = bgStatusMsgIds.get(sessionKey);
          bgStatusMsgIds.delete(sessionKey);
          if (mid == null) return;
          await tg(bot, 'editMessageText', {
            chat_id: chatId, message_id: mid, text: '✅ Background work finished.',
          }, { source: 'bg-work-status', botName }).catch(() => {});
          logEvent('bg-work-status', {
            chat_id: chatId, session_key: sessionKey, thread_id: threadIdRaw,
            state: 'cleared', message_id: mid,
          });
        }
      } catch (err) {
        logger.error?.(`[${botName}] bg-work-status handler: ${err.message}`);
      }
    },

    // 0.16 busy-aware ceiling: CliProcess emits 'turn-extended' the FIRST time a
    // turn passes the 30-min checkpoint while still provably working. Post ONE
    // honest "still working — /stop" message so a long turn reads as alive
    // instead of the old false "stream interrupted". The cli side flags
    // _extended once per turn, so this fires at most once per long turn.
    // Opt-out per chat via progressPings:false. NO "ask how it's going" — a
    // foreground-streaming turn can't answer (review F1).
    onTurnExtended: async (sessionKey, payload) => {
      try {
        if (!bot) return;
        const chatId = getChatIdFromKey(sessionKey);
        const chatCfg = (config && config.chats && config.chats[chatId]) || {};
        // Precedence: per-chat overrides default (a chat can re-enable pings even
        // if the global default disables them, and vice-versa). Default ON.
        const chatPings = chatCfg.progressPings;
        const enabled = chatPings !== undefined
          ? chatPings !== false
          : (config && config.defaults && config.defaults.progressPings) !== false;
        if (!enabled) return;
        const threadIdRaw = getThreadIdFromKey(sessionKey);
        const threadId = threadIdRaw ? parseInt(threadIdRaw, 10) : null;
        await tg(bot, 'sendMessage', {
          chat_id: chatId,
          text: '⏳ Still working on this — it\'s taking a while. Send /stop to cancel.',
          ...(Number.isInteger(threadId) && { message_thread_id: threadId }),
        }, { source: 'turn-extended', botName });
        logEvent('turn-extended-ping', {
          chat_id: chatId, session_key: sessionKey, thread_id: threadIdRaw,
          elapsed_ms: payload?.elapsedMs ?? null,
        });
      } catch (err) {
        logger.error?.(`[${botName}] turn-extended handler: ${err.message}`);
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
          // Finding 0.12-M3: tmux backend was deleted in 0.12; these hook
          // handlers only ever fire on the CLI driver now — default to 'cli'
          // (honor an explicit payload.backend if a caller ever sets one).
          backend: payload?.backend ?? 'cli',
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
          backend: payload?.backend ?? 'cli', // Finding 0.12-M3
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

    // 0.12.0-rc.13: per-chat compaction warning. CliProcess emits
    // 'compaction-warn' when context crosses the chat's threshold at turn-end
    // (proactive) or claude is auto-compacting now (reactive). Post a chat
    // message proposing /compact so the user can compact on their terms BEFORE
    // an auto-compaction interrupts a turn (and detaches the channels bridge).
    // Opt-in per chat (lib/compaction-warn.js) — CliProcess only emits when
    // enabled, so no extra config gate is needed here. Best-effort send.
    onCompactionWarn: (sessionKey, payload /* , entry */) => {
      try {
        const chatId = getChatIdFromKey(sessionKey);
        const threadIdRaw = getThreadIdFromKey(sessionKey);
        const threadId = threadIdRaw ? parseInt(threadIdRaw, 10) : null;
        const kind = payload?.kind === 'reactive' ? 'reactive' : 'proactive';
        logEvent('compaction-warn', {
          chat_id: chatId,
          session_key: sessionKey,
          kind,
          pct: payload?.pct ?? null,
          backend: payload?.backend ?? 'cli',
        });
        if (!bot) return;
        const text = kind === 'reactive'
          ? '🗜️ Auto-compacting now — context filled up. If this turn goes quiet, please resend. (Tip: running `/compact` at a natural break avoids mid-task compactions.)'
          : `📚 Heads up — this chat's context is ~${payload?.pct ?? '?'}% full. To avoid an auto-compaction that can interrupt a turn, run \`/compact\` (optionally with a hint, e.g. \`/compact keep the recent decisions\`) at a natural break — or \`/new\` for a fresh start.`;
        tg(bot, 'sendMessage', {
          chat_id: chatId,
          text,
          ...(threadId ? { message_thread_id: threadId } : {}),
        }, { source: 'compaction-warn', botName }).catch((err) => {
          logger.error?.(`[${botName}] compaction-warn send failed: ${err.message}`);
        });
      } catch (err) {
        logger.error?.(`[${botName}] compaction-warn handler: ${err.message}`);
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
          backend: payload?.backend ?? 'cli', // Finding 0.12-M3 (fires on the CLI hook tail)
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
          backend: payload?.backend ?? 'cli', // Finding 0.12-M3
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
          backend: payload?.backend ?? 'cli', // Finding 0.12-M3
          claude_session_id: payload?.sessionId ?? null,
        });
      } catch (err) {
        logger.error?.(`[${botName}] session-age-prompt-dismissed handler: ${err.message}`);
      }
    },

    // 0.12 Phase 1.8 — hook-lag persistence for the soak gate (median<2s,
    // p99<5s). Each row carries the hookEventName + lagMs so we can:
    //   SELECT json_extract(detail_json, '$.hook_event_name') AS evt,
    //          AVG(json_extract(detail_json, '$.lag_ms')) AS avg_lag,
    //          MAX(json_extract(detail_json, '$.lag_ms')) AS max_lag
    //   FROM events WHERE kind='hook-lag-sample' AND ts>...
    //   GROUP BY evt;
    onHookLagSample: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('hook-lag-sample', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: payload?.backend ?? 'cli',
          hook_event_name: payload?.hookEventName ?? null,
          lag_ms: payload?.lagMs ?? null,
          tool_name: payload?.toolName ?? null,
        });
      } catch (err) {
        logger.error?.(`[${botName}] hook-lag-sample handler: ${err.message}`);
      }
    },

    // 0.12 Phase 1.3 — tool-result with durationMs. Pairs with the
    // existing onToolUse row (which fires on PreToolUse) so the soak can
    // compute per-tool average + p99 durations:
    //   SELECT json_extract(detail_json, '$.tool_name') AS tool,
    //          AVG(json_extract(detail_json, '$.duration_ms')) AS avg_ms,
    //          MAX(json_extract(detail_json, '$.duration_ms')) AS max_ms
    //   FROM events WHERE kind='tool-result' GROUP BY tool;
    // isError captures the rare PostToolUse where the tool itself failed
    // (vs the tool succeeding but claude deciding to retry).
    onToolResult: (sessionKey, payload /* , entry */) => {
      try {
        logEvent('tool-result', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: payload?.backend ?? 'cli',
          tool_name: payload?.name ?? null,
          duration_ms: payload?.durationMs ?? null,
          agent_id: payload?.agentId ?? null,
          agent_type: payload?.agentType ?? null,
          tool_use_id: payload?.toolUseId ?? null,
          is_error: payload?.isError === true,
        });
      } catch (err) {
        logger.error?.(`[${botName}] tool-result handler: ${err.message}`);
      }
    },

    // 0.12 Phase 1.3 — subagent lifecycle. PreToolUse with name='Agent'
    // synthesizes 'subagent-start' (no agent_id yet — claude doesn't
    // hand one out until the inner SubagentStop). 'subagent-done' carries
    // the agent_id + duration_ms so a soak can correlate the pair:
    //   SELECT s.detail_json AS start, d.detail_json AS done
    //   FROM events s JOIN events d
    //     ON json_extract(s.detail_json, '$.tool_use_id') =
    //        json_extract(d.detail_json, '$.tool_use_id')
    //   WHERE s.kind='subagent-start' AND d.kind='subagent-done';
    onSubagentStart: (sessionKey, payload, entry) => {
      try {
        logEvent('subagent-start', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: payload?.backend ?? 'cli',
          agent_type: payload?.agentType ?? null,
          tool_use_id: payload?.toolUseId ?? null,
        });
        // Findings L9/L14: drive the head reactor into the distinct SUBAGENT
        // state so a running subagent shows 👾 rather than freezing on the
        // prior tool's emoji. The plan promised this; previously the handler
        // only persisted the DB row and never touched the reactor.
        const r = entry?.pendingQueue?.[0]?.context?.reactor;
        if (r) {
          r.setState('SUBAGENT');
          // B3: hold a "working" face for the whole sub-agent run — the quiet
          // stretch between its tool hooks is expected, not a stall, so suppress
          // the 🥱/😨 decay until it finishes. docs/progress-is-not-turn-end-spec.md
          if (typeof r.setWorkInFlight === 'function') r.setWorkInFlight(true, 'subagent');
        }
      } catch (err) {
        logger.error?.(`[${botName}] subagent-start handler: ${err.message}`);
      }
    },

    onSubagentDone: (sessionKey, payload, entry) => {
      try {
        // L9/L14: heartbeat at subagent end so the cascade/stall clock
        // resets; the next tool's PreToolUse sets the following state.
        const r = entry?.pendingQueue?.[0]?.context?.reactor;
        if (r) {
          // B3: release the working-hold only when the LAST sub-agent finishes
          // (inFlight === 0) — nested/parallel sub-agents keep it held.
          if (typeof r.setWorkInFlight === 'function') r.setWorkInFlight((payload?.inFlight ?? 0) > 0, 'subagent');
          if (typeof r.heartbeat === 'function') r.heartbeat();
        }
        logEvent('subagent-done', {
          chat_id: getChatIdFromKey(sessionKey),
          session_key: sessionKey,
          backend: payload?.backend ?? 'cli',
          agent_type: payload?.agentType ?? null,
          agent_id: payload?.agentId ?? null,
          duration_ms: payload?.durationMs ?? null,
          // Finding 0.12-M4: persist the originating Agent tool_use_id so the
          // documented subagent-start/subagent-done soak JOIN on
          // $.tool_use_id matches (subagent-done's tool_use_id is recovered
          // in cli-process.js from the paired Agent PreToolUse).
          tool_use_id: payload?.toolUseId ?? null,
        });
      } catch (err) {
        logger.error?.(`[${botName}] subagent-done handler: ${err.message}`);
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

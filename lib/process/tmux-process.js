/**
 * TmuxProcess — tmux backend for the Process abstraction.
 *
 * One claude TUI hosted inside a `tmux` session, with capture-pane based
 * lifecycle detection. Phase 2 MVP — covers required + easy-optional
 * methods. The §4.B `--debug-file` structured-event channel is wired in
 * Phase 3 (G7+G9 gates).
 *
 * Cost weight: 3 (per F-spike-2 — tmux RSS ≈10× SDK pm; weighted LRU
 * budget=10 means ~3 tmux chats OR 1 tmux + 7 SDK chats co-exist).
 *
 * Spike findings driving this code:
 *   F-spike-1 — `--permission-mode acceptEdits` mirrors SDK pm default;
 *               no in-chat approval UI in Phase 2
 *   F-spike-3 — `\n` inside paste-buffer splits into multiple Enters;
 *               TmuxRunner.pasteText() encodes as MULTILINE_SEPARATOR
 *   F-spike-4 — `bypassPermissions` mode needs `--dangerously-skip-permissions`
 *               companion (matches SDK's allowDangerouslySkipPermissions:true)
 *   G5b      — control-char sanitization (TmuxRunner does it; we also
 *               sanitize on inject path for the "no live turn" early-out)
 *   G6 / G6b — `? for shortcuts` / `accept edits on` = READY;
 *               `esc to interrupt` = STREAMING. Pair drives completion detect.
 *
 * R-audit findings applied:
 *   R1-F1   — drainQueue/injectUserMessage/steer NEVER throw
 *   R2-F1   — control chars stripped before any send
 *   R2-F7   — _spawning sentinel + _killing flag prevent races
 *   R2-F8   — start() vs attach() distinct; spawn errors fail loud
 *   R3-F4   — getContextUsage throws NotImplementedYetError, not silently ok
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §12.3
 * @see docs/0.10.0-phase0-spike-findings.md
 */

'use strict';

const crypto = require('crypto');
const { Process, UnsupportedOperationError } = require('./process');
const { LogTail } = require('../tmux/log-tail');
const { sessionLogPath, pipeToParser } = require('../tmux/session-log-parser');
const { computeCostUsd } = require('../model-costs');
const { getTopicConfig } = require('../session-key');
const { POLYGRAM_DISPLAY_HINT } = require('../telegram/display-hint');

// Context window per model. All Claude 4.x models are 200k. If
// Anthropic ships a model with a different window, promote this to
// a lookup table again. Single constant for now — no per-model
// branching needed.
const DEFAULT_CONTEXT_WINDOW = 200_000;

// ─── TUI lifecycle indicators (locked by spike G6/G6b) ───────────────

// READY hints: claude TUI shows "? for shortcuts" when idle and ready
// for the next prompt. Under `--permission-mode acceptEdits` (our
// default), the bottom-of-pane indicator can also read "accept edits
// on" instead; treat either as ready.
const READY_HINTS_RE    = /\?\s+for shortcuts|accept edits on/;
const STREAMING_HINT_RE = /esc to interrupt/;

// TUI approval-prompt indicators. When a chat is spawned WITHOUT
// --permission-mode acceptEdits, claude pauses on risky tools and
// draws a prompt like:
//
//   ⏺ Bash(rm foo.txt)
//     ⎿  Do you want to do this?
//        ❯ 1. Yes
//          2. Yes, allow always for similar commands
//          3. No, and tell Claude what to do differently
//
// The TUI renders a `❯` selection cursor inline before the
// highlighted option (always option 1 at first paint). Earlier
// rc.1-rc.4 regex assumed no inline cursor and silently failed to
// match every approval-gated tool call in production, hanging the
// session in the TUI until orphan-sweep killed it (see
// tests/tmux-process-approval.test.js inline-cursor regression).
//
// SECURITY (audit H1 fix): require BOTH the question text AND a
// following numbered menu line ("1. ...") so a malicious assistant
// message text like "Do you want to proceed?" can't trigger a fake
// approval card by itself. The menu is part of the TUI's pause
// state; the assistant can't render it without actually being paused.
// The optional `❯` cursor in [^\S\n]*(?:❯[^\S\n]+)?1\. is still
// bounded to the line containing `1.`, so the security property
// holds — only a real menu line satisfies it.
const APPROVAL_PROMPT_RE = /Do you want to (?:proceed|do this|continue)\??[\s\S]{0,400}?(?:^|\n)[^\S\n]*(?:❯[^\S\n]+)?1\.\s+/im;
// Pull the tool name + raw arg snippet from the line preceding the
// approval prompt. Capture-pane preserves the ⏺ marker.
const TOOL_INVOCATION_RE = /⏺\s+([A-Za-z_]\w*)\s*\((.*?)\)\s*$/m;

// ─── Defaults — overridable per construction for tests ───────────────

// Cold-spawn budget for claude TUI to reach "? for shortcuts" / "accept
// edits on" state. 30s was enough in dev (interactive shell, warm
// keychain) but consistently timed out under launchd in production:
// MCP server starts each have a 30s connection timeout, and the
// keychain/Aqua context warm-up is slower outside an attached terminal.
// 120s is generous; the only cost is waiting longer when something is
// genuinely stuck (we kill + retry in that case anyway).
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_TIMEOUT_MS  = 5 * 60_000;
const DEFAULT_POLL_MS          = 250;
const DEFAULT_QUIESCE_MS       = 500; // require READY for this long before declaring done

class TmuxProcess extends Process {
  /**
   * @param {object} opts
   * @param {string} opts.sessionKey
   * @param {string|null} opts.chatId
   * @param {string|null} opts.threadId
   * @param {string} [opts.label]
   * @param {object} opts.runner               — TmuxRunner instance
   * @param {string} opts.botName              — for session naming + log path
   * @param {object} [opts.logger=console]
   * @param {Function} [opts.sleepFn]          — test seam for polling
   * @param {Function} [opts.nowFn]            — test seam for timeouts
   * @param {number} [opts.readyTimeoutMs]
   * @param {number} [opts.turnTimeoutMs]
   * @param {number} [opts.pollMs]
   * @param {number} [opts.quiesceMs]
   */
  constructor({
    sessionKey, chatId, threadId, label,
    runner, botName, logger = console,
    sleepFn, nowFn,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    quiesceMs = DEFAULT_QUIESCE_MS,
    lateGraceMs = 1500,
    queueCap = 50,   // P0.1 parity: SDK enforces queueCap=50 too
    pollScheduler = null,   // O1 optimization: shared cross-process tick
  } = {}) {
    super({ sessionKey, chatId, threadId, label });
    if (!runner) throw new TypeError('TmuxProcess: runner required');
    if (!botName) throw new TypeError('TmuxProcess: botName required');
    this.backend = 'tmux';
    this.runner = runner;
    this.botName = botName;
    this.logger = logger;

    this.tmuxName = runner.sessionName(botName, this.chatId, this.threadId);
    this.debugLogPath = runner.debugLogPath(botName, this.chatId, this.threadId);

    // Race guards (R2-F7)
    this._spawning = null;
    this._killing = false;

    // Test seams
    this._sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._now = nowFn || (() => Date.now());

    // Tunables
    this.readyTimeoutMs = readyTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.pollMs = pollMs;
    this.quiesceMs = quiesceMs;
    this.lateGraceMs = lateGraceMs;
    this.queueCap = queueCap;
    // Optional shared poll scheduler. When provided, the polling
    // loops register/release lifetimes and use scheduler.waitTick()
    // instead of per-instance setTimeout — N processes share one
    // setInterval. When null, falls back to per-instance setTimeout.
    this.pollScheduler = pollScheduler;

    // Latest usage snapshot from JSONL assistant messages. Updated by
    // _handleSessionEvent on every 'usage' event; consumed by
    // getContextUsage() so polygram's post-turn auto-hint works on
    // the tmux backend just like SDK.
    this._lastUsage = null;

    // rc.7: autosteer fold-vs-queue tracking. When polygram autosteers
    // a user message via injectUserMessage({content, msgId}), we
    // record (content, msgId) here. The TUI's queue may consume that
    // paste in two ways (see SessionLogParser docs):
    //
    //   A) FOLD — JSONL emits `attachment.type="queued_command"`.
    //      We pop the matching entry. The primary turn's reply
    //      already covers both messages — no extra delivery needed.
    //
    //   B) NEW TURN — JSONL emits a top-level `user` message with
    //      matching content. We pop the matching entry and start an
    //      `_extraTurnState` accumulator. Subsequent assistant-chunks
    //      (while no _turnState is active — i.e. primary pm.send
    //      already returned) feed the accumulator; the next `result`
    //      event flushes it as an `'extra-turn-reply'` { msgId, text }
    //      event for polygram to route to Telegram.
    //
    // FIFO matching by content text — multiple pending autosteers are
    // resolved in submission order, which matches how Telegram
    // delivers messages anyway.
    this._pendingAutosteers = [];  // Array<{ content, msgId }>
    this._extraTurnState = null;   // null | { msgId, text }
  }

  get cost() { return 3; }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /**
   * Cold-spawn the claude TUI inside a new tmux session.
   *
   * Accepts the standard ProcessManager spawnContext shape (same as
   * SdkProcess.start), pulling model/effort/cwd from chatConfig.
   *
   * @param {object} ctx
   * @param {string|null} [ctx.existingSessionId] — for --resume
   * @param {object} [ctx.chatConfig={}]          — supplies model, effort, cwd, agent, permissionMode
   * @param {string} [ctx.model]                  — override (rare; e.g. tests)
   * @param {string} [ctx.effort]                 — override
   * @param {string} [ctx.cwd]                    — override
   * @param {object} [ctx.envExtras={}]
   */
  async start(ctx = {}) {
    if (this._killing) {
      throw Object.assign(new Error('TmuxProcess in killing state'), { code: 'TMUX_KILLING' });
    }
    if (this._spawning) {
      // Concurrent start() call — wait on the in-flight spawn.
      await this._spawning;
      return;
    }

    this._spawning = (async () => {
      const chatConfig = ctx.chatConfig || {};
      // Topic-level config overrides chat-level (mirrors SDK's
      // buildSdkOptions). Without this, a chat with per-topic
      // `agent`/`cwd`/`model`/`effort` overrides would silently spawn
      // claude with chat-level defaults — production bug surfaced in
      // 0.10.0-rc.1: Music topic's music-curation agent + rekordbox
      // cwd were ignored; TUI spawned with the chat-level shumabit
      // agent and didn't signal ready in 30s.
      const topicConfig = getTopicConfig(chatConfig, ctx.threadId);
      const model = ctx.model || topicConfig.model || chatConfig.model;
      const effort = ctx.effort || topicConfig.effort || chatConfig.effort;
      const cwd = ctx.cwd || topicConfig.cwd || chatConfig.cwd;
      const agent = topicConfig.agent || chatConfig.agent;
      const permissionMode = topicConfig.permissionMode || chatConfig.permissionMode || 'acceptEdits';

      // Pre-allocate the sessionId via --session-id flag (v9 finding).
      // claude accepts a valid UUID and uses it as THE session ID for the
      // run; on --resume we pass the existing one. Either way we KNOW
      // the sessionId at spawn time, no parsing required.
      this.claudeSessionId = ctx.existingSessionId || crypto.randomUUID();

      const args = [];
      if (ctx.existingSessionId) {
        args.push('--resume', ctx.existingSessionId);
      } else {
        args.push('--session-id', this.claudeSessionId);
      }
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      args.push('--permission-mode', permissionMode);
      if (permissionMode === 'bypassPermissions') {
        // F-spike-4: TUI rejects bypassPermissions without companion flag.
        args.push('--dangerously-skip-permissions');
      }
      args.push('--debug-file', this.debugLogPath);
      if (agent) args.push('--agent', agent);
      // Cross-backend parity: SDK appends polygram's Telegram display
      // hint to every agent's systemPrompt (lib/sdk/build-options.js).
      // Without this, the spawned claude session has no idea it's
      // replying through a Telegram bot — shumorobot 2026-05-15 caught
      // the model emitting shell-style canned strings ("No response
      // requested.") as actual Telegram replies for that reason.
      // `--append-system-prompt` is preserved by claude CLI in
      // addition to (not in place of) the agent's own prompt.
      args.push('--append-system-prompt', POLYGRAM_DISPLAY_HINT);

      // R2-F8: spawn errors must fail loud, not silent-catch.
      await this.runner.spawn({
        name: this.tmuxName,
        cwd,
        command: 'claude',
        args,
        envExtras: ctx.envExtras || {},
      });

      // v9: tail the per-session JSONL file (the REAL structured-event
      // channel — v9 probe showed --debug-file emits only infra noise).
      // Path is deterministic once we have cwd + sessionId. The file
      // may not exist for ~100ms after spawn; LogTail tolerates ENOENT.
      this._cwd = cwd;
      this._armSessionLogTail({ resuming: Boolean(ctx.existingSessionId) });

      // G6 — block until TUI is responsive.
      await this._waitForReady();
      this.emit('init', {
        session_id: this.claudeSessionId,
        label: this.label,
        backend: 'tmux',
        tmux_name: this.tmuxName,
      });
    })();

    try {
      await this._spawning;
    } finally {
      this._spawning = null;
    }
  }


  // ─── send ─────────────────────────────────────────────────────────

  /**
   * Submit a turn. Resolves with PmSendResult on completion.
   *
   * The MVP detects completion via capture-pane diffing:
   *   1. paste prompt + Enter
   *   2. wait for STREAMING indicator OR up to readyTimeout (some short
   *      turns finish before we even see the streaming hint — that's OK,
   *      step 3 catches them via quiescence)
   *   3. poll until READY persists for `quiesceMs`
   *   4. extract assistant text from final capture
   *
   * Errors normalize to PmSendResult.error rather than throwing — matches
   * SdkProcess contract.
   *
   * @param {string} prompt
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]   — overrides turnTimeoutMs
   * @param {string} [opts.context]     — ignored (SDK-only, future use)
   */
  async send(prompt, opts = {}) {
    if (this.closed) {
      // Match SdkProcess contract: send() on closed Process REJECTS
      // rather than returning an error result. Callers (polygram
      // dispatch) already wrap pm.send in try/catch for this case.
      // Runtime turn errors (paste fail, timeout) still surface as
      // an error-shaped PmSendResult — that's the other path below.
      throw Object.assign(new Error('No process for session'), { code: 'PROCESS_CLOSED' });
    }
    // P0.1 fix: enforce queueCap (parity with SDK). Without this a
    // misbehaving caller could grow pendingQueue unbounded.
    if (this.inFlight && this.pendingQueue.length >= this.queueCap) {
      throw Object.assign(
        new Error(`queue overflow: queueCap ${this.queueCap}`),
        { code: 'QUEUE_OVERFLOW' },
      );
    }
    if (this.inFlight) {
      // For Phase 2 MVP we serialize: queue the prompt locally and
      // await the in-flight turn. Include `context` so polygram's
      // streamer/reactor lookups via pendingQueue[N].context work
      // when this pending becomes the head.
      return new Promise((resolve, reject) => {
        this.pendingQueue.push({
          prompt, opts,
          context: opts.context || {},
          resolve, reject,
        });
      });
    }

    this.inFlight = true;
    const turnTimeoutMs = opts.timeoutMs || this.turnTimeoutMs;
    const startedAt = this._now();

    // P0.1 fix: push a HEAD pending with the caller's `context` so
    // polygram's onStreamChunk / onToolUse / onAssistantMessageStart
    // callbacks (which read entry.pendingQueue[0].context.streamer
    // and entry.pendingQueue[0].context.reactor) work for tmux too.
    // Without this, live bubble updates and reactor heartbeats
    // silently no-op on tmux. Shape mirrors SdkProcess pendings.
    const headPending = {
      prompt, opts,
      context: opts.context || {},
      streamText: '',
    };
    this.pendingQueue.unshift(headPending);

    // v9: prime turn-scoped event collection. Assistant chunks and
    // tool-uses arriving via the JSONL tail accumulate into _turnState;
    // the 'result' event resolves the turn.
    this._turnState = {
      text: '',
      toolUses: 0,
      resolveResult: null,
      resultEvent: null,
      pendingSteerCausesNewBubble: false,
    };
    const turnResultP = new Promise((resolve) => {
      this._turnState.resolveResult = resolve;
    });

    try {
      // R2-F1: sanitization happens inside runner.pasteText; we also
      // log when chars get stripped.
      const result = await this.runner.pasteText(this.tmuxName, prompt);
      if (result.stripped > 0) {
        this.logger.warn?.(
          `[${this.label}] stripped ${result.stripped} control chars from prompt`,
        );
        this.emit('prompt-sanitized', { stripped: result.stripped, source: 'send' });
      }
      await this.runner.sendControl(this.tmuxName, 'Enter');

      // Race: JSONL result event vs capture-pane quiescence fallback
      // vs hard timeout. JSONL is the primary signal (carries structured
      // text); capture-pane wins for old claude versions or if JSONL
      // file write lags behind UI quiescence.
      const captureAtStart = await this.runner.captureWide(this.tmuxName);
      const captureCompleteP = this._awaitTurnComplete({
        captureAtStart, timeoutMs: turnTimeoutMs,
      });

      // Whichever resolves first wins.
      let resolvedVia = 'jsonl';
      const winner = await Promise.race([
        turnResultP.then((ev) => ({ kind: 'jsonl', ev })),
        captureCompleteP.then((cap) => ({ kind: 'capture', cap })),
      ]);

      let text;
      let resultSubtype = 'success';
      let stopReason = null;
      if (winner.kind === 'jsonl') {
        text = this._turnState.text || winner.ev.text || '';
        resultSubtype = winner.ev.subtype || 'success';
        stopReason = winner.ev.stopReason || null;
        // Update sessionId from the result if claude assigned a fresh one
        if (winner.ev.sessionId) this.claudeSessionId = winner.ev.sessionId;
      } else {
        // Capture-pane won, but for short turns claude may flush JSONL
        // AFTER the TUI shows ready. Wait briefly for the structured
        // event so we can use its (clean) text over capture-pane diff.
        //
        // OPTIMIZATION: if JSONL has ALREADY delivered assistant text
        // by the time capture-pane resolves, we already have the
        // structured text — skip the late-grace wait entirely. Saves
        // ~1.5s on every short reply where the JSONL streamed in
        // during the turn.
        if (this._turnState.text) {
          resolvedVia = 'jsonl-streamed';
          text = this._turnState.text;
        } else {
          const lateGraceMs = this.lateGraceMs ?? 1500;
          const late = await Promise.race([
            turnResultP.then((ev) => ({ kind: 'jsonl-late', ev })),
            new Promise((r) => setTimeout(() => r({ kind: 'no-jsonl' }), lateGraceMs)),
          ]);
          if (late.kind === 'jsonl-late') {
            resolvedVia = 'jsonl-late';
            text = this._turnState.text || late.ev.text || '';
            resultSubtype = late.ev.subtype || 'success';
            stopReason = late.ev.stopReason || null;
            if (late.ev.sessionId) this.claudeSessionId = late.ev.sessionId;
          } else {
            resolvedVia = 'capture-pane';
            text = this._turnState.text || this._extractTurnReply(captureAtStart, winner.cap);
          }
        }
      }

      const duration = this._now() - startedAt;
      this.emit('result', { subtype: resultSubtype, resolvedVia }, { streamText: text, stopReason });

      // Token + cost telemetry from the latest JSONL usage snapshot.
      // claude doesn't write cost into JSONL; we compute from token
      // counts × `lib/model-costs.js` rate table. The result populates
      // turn_metrics so cost dashboards work the same as SDK.
      const u = this._lastUsage;
      const cost = u ? computeCostUsd(u, u.model) : null;

      const pmResult = {
        text,
        sessionId: this.claudeSessionId,
        cost,
        duration,
        error: null,
        metrics: {
          inputTokens: u?.inputTokens ?? null,
          outputTokens: u?.outputTokens ?? null,
          cacheCreationTokens: u?.cacheCreationTokens ?? null,
          cacheReadTokens: u?.cacheReadTokens ?? null,
          numAssistantMessages: 1,
          numToolUses: this._turnState.toolUses,
          resultSubtype,
          stopReason,
          resolvedVia,
        },
      };
      this._completeTurn();
      return pmResult;
    } catch (err) {
      this._completeTurn();
      return this._errorResult(err.code || 'tmux_send_error', err.message || String(err));
    }
  }

  _completeTurn() {
    this.inFlight = false;
    // rc.7: clear _turnState so JSONL events arriving BETWEEN turns
    // (autonomous assistant messages, queue-dequeued user prompts
    // becoming fresh turns) don't incorrectly route to the just-
    // completed turn. Without this, the rc.7 autosteer extra-turn
    // path can't distinguish "primary turn done, watch for queue
    // dequeue" from "still in primary turn". The next send() call
    // freshly sets _turnState so existing callers are unaffected.
    this._turnState = null;
    // Shift the HEAD pending (just-completed turn). After this, the
    // queue contains only items queued while inFlight (each carrying
    // their own resolve/reject pair). If any, re-enter send() on the
    // next one — send() will push its own fresh head pending.
    this.pendingQueue.shift();
    const next = this.pendingQueue.shift();
    if (next && next.resolve) {
      this.send(next.prompt, next.opts).then(next.resolve, next.reject);
    } else {
      this.emit('idle');
    }
  }

  _errorResult(code, message) {
    return {
      text: '',
      sessionId: this.claudeSessionId,
      cost: null,
      duration: 0,
      error: message,
      metrics: {
        inputTokens: null, outputTokens: null,
        cacheCreationTokens: null, cacheReadTokens: null,
        numAssistantMessages: 0, numToolUses: 0,
        resultSubtype: code,
      },
    };
  }

  // ─── session-log tail (§4.B JSONL path — primary event channel) ──

  /**
   * Open a tail on `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl`
   * and forward parsed events to Process listeners.
   *
   * Events forwarded:
   *   - assistant-chunk → emit 'stream-chunk' (matches SdkProcess shape)
   *   - tool-use        → emit 'tool-use'
   *   - result          → resolve current turn's _turnState.resolveResult
   *   - last-prompt     → fallback turn-complete signal
   */
  _armSessionLogTail({ resuming = false } = {}) {
    if (this._sessionLogTail) return; // idempotent
    if (!this._cwd) {
      this.logger.warn?.(`[${this.label}] _armSessionLogTail: no cwd available, skipping`);
      return;
    }
    const logPath = sessionLogPath(this._cwd, this.claudeSessionId);
    // skipExisting: on --resume the JSONL already has historic turns;
    // we must NOT replay them or the first new send() would prematurely
    // resolve on a historic 'result' event.
    // OPTIMIZATION O2: prefer fs.watch over 50ms polling — drops the
    // steady-state IO from 20 stat+open/sec per chat to ~zero. Falls
    // back to polling automatically if fs.watch fails (sandboxed env,
    // unsupported FS). The slow safety-net poll inside LogTail catches
    // any missed watch events.
    const tail = new LogTail({
      path: logPath, intervalMs: 50, skipExisting: resuming,
      useWatch: 'auto',
      logger: this.logger,
    });
    pipeToParser(tail);
    tail.on('event', (ev) => this._handleSessionEvent(ev));
    tail.on('error', (err) => {
      this.logger.warn?.(`[${this.label}] session-log-tail error: ${err.message}`);
    });
    tail.start();
    this._sessionLogTail = tail;
    this._sessionLogPath = logPath;
  }

  _handleSessionEvent(ev) {
    if (ev.type === 'assistant-chunk') {
      if (this._turnState) {
        // If a mid-turn steer just happened, the NEXT assistant message
        // should start a fresh Telegram bubble — otherwise the post-steer
        // reply visually appends to the pre-steer text bubble, making the
        // user's follow-up look unanswered. Mirror SdkProcess's logic:
        // emit 'assistant-message-start', reset the accumulator, clear
        // the flag. Subsequent chunks within THIS new assistant message
        // continue to accumulate in the fresh bubble.
        if (this._turnState.pendingSteerCausesNewBubble) {
          this._turnState.pendingSteerCausesNewBubble = false;
          this._turnState.text = '';
          this.emit('assistant-message-start');
        }
        // In-flight turn: accumulate text + forward as stream-chunk so
        // pm consumers can render incremental output.
        this._turnState.text = this._turnState.text
          ? `${this._turnState.text}\n\n${ev.text}`
          : ev.text;
        this.emit('stream-chunk', this._turnState.text);
      } else if (this._extraTurnState) {
        // rc.7: autosteer NEW-TURN extraction in progress. Accumulate
        // this chunk into the extra-turn buffer. It will be flushed
        // when the next 'result' event fires (see below).
        this._extraTurnState.text = this._extraTurnState.text
          ? `${this._extraTurnState.text}\n\n${ev.text}`
          : ev.text;
      } else {
        // No turn in flight — this is an autonomous assistant message
        // (claude self-initiated; typically ScheduleWakeup firing).
        // Mirror SdkProcess.onAutonomousAssistantMessage routing so
        // pm consumers receive these the same way regardless of backend.
        this.emit('autonomous-assistant-message', {
          text: ev.text,
          sessionId: this.claudeSessionId,
          backend: 'tmux',
        });
      }
    } else if (ev.type === 'tool-use') {
      if (this._turnState) this._turnState.toolUses++;
      this.emit('tool-use', ev.name);
    } else if (ev.type === 'usage') {
      // Token-usage snapshot from JSONL. Cache for getContextUsage().
      // Each assistant message carries the cumulative usage; latest
      // wins. Model name comes from the assistant message itself
      // (e.g. "claude-haiku-4-5-20251001") so we don't need a
      // chatConfig.model lookup.
      //
      // Compact-boundary detection: if cumulative tokens DROP between
      // consecutive usage snapshots, claude auto-compacted. Emit a
      // compact-boundary event mirroring SdkProcess's so polygram can
      // mark the boundary in the chat exactly the same way for both
      // backends.
      // Use the same "full context size" formula as getContextUsage —
      // input (incl. cache reads/writes) + output. Apples-to-apples
      // comparison across turns; compaction shows up as a clear drop.
      const prevTotal = this._lastUsage
        ? ((this._lastUsage.inputTokens || 0)
          + (this._lastUsage.cacheReadTokens || 0)
          + (this._lastUsage.cacheCreationTokens || 0)
          + (this._lastUsage.outputTokens || 0))
        : 0;
      const newTotal = (ev.inputTokens || 0)
        + (ev.cacheReadTokens || 0)
        + (ev.cacheCreationTokens || 0)
        + (ev.outputTokens || 0);
      if (prevTotal > 0 && newTotal < prevTotal * 0.7) {
        // Tokens dropped by more than 30% — strong compaction signal.
        // (Cache eviction without compaction never drops this much.)
        this.emit('compact-boundary', {
          trigger: 'auto',
          pre_tokens: prevTotal,
          post_tokens: newTotal,
          backend: 'tmux',
        });
      }
      this._lastUsage = ev;
    } else if (ev.type === 'result') {
      if (this._turnState && this._turnState.resolveResult) {
        this._turnState.resultEvent = ev;
        this._turnState.resolveResult(ev);
      } else if (this._extraTurnState) {
        // rc.7: extra-turn (autosteer NEW-TURN) just completed. Flush
        // the accumulated text as 'extra-turn-reply' so polygram can
        // send it to Telegram as a reply to the autosteered msgId.
        // Only flush on the 'success' subtype (end_turn) — non-terminal
        // result subtypes like 'tool_use' shouldn't close the
        // extra-turn (the model may still emit more chunks).
        if (ev.subtype === 'success') {
          const flushed = this._extraTurnState;
          this._extraTurnState = null;
          this.emit('extra-turn-reply', {
            msgId: flushed.msgId,
            text: flushed.text,
            sessionId: this.claudeSessionId,
            backend: 'tmux',
          });
        }
      }
      // If no turn in flight and no extra-turn, result event just
      // marks the end of an autonomous message segment — already
      // handled by the assistant-chunk branch above.
    } else if (ev.type === 'queue-folded') {
      // rc.7: TUI consumed an autosteered paste inside the current
      // turn (FOLD). Pop the matching pending autosteer so a later
      // 'user-message' with the same content doesn't spuriously
      // trigger extra-turn extraction. The primary turn's reply
      // already covers both messages — no extra delivery needed.
      const idx = this._pendingAutosteers.findIndex((a) => a.content === ev.prompt);
      if (idx >= 0) {
        this._pendingAutosteers.splice(idx, 1);
      }
    } else if (ev.type === 'user-message') {
      // rc.7: top-level user message in JSONL — may be the TUI
      // dequeuing an autosteered paste as a fresh user turn
      // (NEW-TURN path). Match by content. If found AND no primary
      // turn is currently in flight (the autosteered second turn
      // runs AFTER the first turn returned), start an extra-turn
      // accumulator. Subsequent assistant-chunks + the next 'result'
      // event will flush it as 'extra-turn-reply'.
      const idx = this._pendingAutosteers.findIndex((a) => a.content === ev.text);
      if (idx >= 0 && !this._turnState && !this._extraTurnState) {
        const { msgId } = this._pendingAutosteers[idx];
        this._pendingAutosteers.splice(idx, 1);
        this._extraTurnState = { msgId, text: '' };
      }
    } else if (ev.type === 'last-prompt') {
      // Fallback complete signal. If 'result' didn't fire (rare; some
      // claude versions may write last-prompt instead of stop_reason),
      // synthesize a success result.
      if (this._turnState && this._turnState.resolveResult && !this._turnState.resultEvent) {
        const synthetic = {
          type: 'result',
          subtype: 'success',
          text: this._turnState.text,
          stopReason: 'last-prompt',
          sessionId: this.claudeSessionId,
        };
        this._turnState.resultEvent = synthetic;
        this._turnState.resolveResult(synthetic);
      }
    }
  }

  // ─── completion detection (§4.A capture-pane diff path — fallback) ──

  /**
   * Wait for the next poll tick. When a shared PollScheduler is wired,
   * N concurrent TmuxProcess instances share ONE setInterval rather
   * than spawning N independent setTimeout chains. Falls back to a
   * per-instance setTimeout when no scheduler is provided (test path).
   */
  _waitForNextTick() {
    if (this.pollScheduler) return this.pollScheduler.waitTick();
    return this._sleep(this.pollMs);
  }

  async _waitForReady() {
    const deadline = this._now() + this.readyTimeoutMs;
    let lastBuf = '';
    if (this.pollScheduler) this.pollScheduler.acquire();
    try {
      while (this._now() < deadline) {
        // OPTIMIZATION: ready hint lives in the bottom ~5 lines of the
        // pane. Polling 1000 lines each tick is wasteful — cap at 80
        // for a ~12× cheaper tmux subprocess.
        lastBuf = await this.runner.captureWide(this.tmuxName, { lines: 80 });
        if (READY_HINTS_RE.test(lastBuf)) return;
        await this._waitForNextTick();
      }
    } finally {
      if (this.pollScheduler) this.pollScheduler.release();
    }
    // On timeout, surface what the TUI was actually showing so the
    // operator can diagnose whether it was hung, on a setup prompt,
    // or just slow to render the ready hint. capture the last ~40
    // lines for the error event payload + log.
    const tail = lastBuf.split('\n').slice(-40).join('\n');
    this.logger.warn?.(
      `[${this.label}] TUI did not signal ready in ${this.readyTimeoutMs}ms; last pane tail:\n${tail}`,
    );
    throw Object.assign(new Error('TmuxProcess: TUI did not signal ready'), {
      code: 'TMUX_READY_TIMEOUT',
      tmuxName: this.tmuxName,
      paneTail: tail,
    });
  }

  /**
   * Poll capture-pane until READY hint has been visible for at least
   * `quiesceMs` continuously. Returns the final capture.
   *
   * OPTIMIZATION: polling uses a smaller `lines: 200` window (enough
   * to cover the approval-prompt's tool-invocation line + menu + ready
   * hint at the bottom). For the FINAL capture used to extract reply
   * text, we fall back to the default 1000-line wide capture.
   */
  async _awaitTurnComplete({ timeoutMs }) {
    const deadline = this._now() + timeoutMs;
    let firstReadyAt = null;
    let lastBuf = '';
    let prevBufLen = -1;
    let cachedReady = false;
    let cachedStreaming = false;
    if (this.pollScheduler) this.pollScheduler.acquire();
    try {
    while (this._now() < deadline) {
      lastBuf = await this.runner.captureWide(this.tmuxName, { lines: 200 });

      // OPTIMIZATION: skip the three regex tests when the capture
      // buffer is identical (by length) to the previous tick. claude
      // TUI is usually quiescent between events, so most polls see no
      // change — running 3 regexes over a 200-line buffer each tick
      // is wasted CPU. Length-compare is a probabilistic check
      // (collisions theoretically possible) but in practice the
      // bottom of the pane shifts even a few bytes whenever claude
      // emits anything observable.
      const bufLenChanged = lastBuf.length !== prevBufLen;
      if (bufLenChanged) {
        prevBufLen = lastBuf.length;
        cachedReady = READY_HINTS_RE.test(lastBuf);
        cachedStreaming = STREAMING_HINT_RE.test(lastBuf);
        // Approval-prompt detection ONLY runs on changed captures.
        // It's the heaviest regex (`[\s\S]{0,400}?` non-greedy) so
        // worth skipping on quiescent ticks.
        if (APPROVAL_PROMPT_RE.test(lastBuf)) {
          await this._handleApprovalPrompt(lastBuf);
          firstReadyAt = null;     // approval pause resets ready clock
          await this._waitForNextTick();
          continue;
        }
      }

      const isReady = cachedReady;
      const isStreaming = cachedStreaming;
      if (isReady && !isStreaming) {
        if (firstReadyAt == null) firstReadyAt = this._now();
        if (this._now() - firstReadyAt >= this.quiesceMs) return lastBuf;
      } else {
        firstReadyAt = null;
      }
      await this._waitForNextTick();
    }
    throw Object.assign(new Error('TmuxProcess: turn did not complete in time'), {
      code: 'TMUX_TURN_TIMEOUT',
      tmuxName: this.tmuxName,
    });
    } finally {
      if (this.pollScheduler) this.pollScheduler.release();
    }
  }

  /**
   * Surface an in-pane approval prompt to consumers. Emits a single
   * `approval-required` event per prompt instance — dedup tracked via
   * `_pendingApprovalId`. The event payload includes a `respond()`
   * callback the consumer invokes with 'allow' | 'deny' | string
   * (free-form feedback for the "no, tell claude what to do" path).
   *
   * Until respond() is called, subsequent captures showing the same
   * prompt are no-ops — the TUI stays paused, we stay parked.
   */
  async _handleApprovalPrompt(captureBuf) {
    if (this._pendingApprovalId) return; // already surfaced
    // Parse tool name + input from the line preceding the prompt.
    // capture-pane joins wrapped lines (-J) so the regex sees the
    // single ⏺ line.
    const match = captureBuf.match(TOOL_INVOCATION_RE);
    const toolName = match ? match[1] : 'unknown';
    const toolInput = match ? match[2] : '';
    const id = `approval-${this.tmuxName}-${this._now()}`;
    this._pendingApprovalId = id;

    this.emit('approval-required', {
      id,
      toolName,
      toolInput,
      sessionId: this.claudeSessionId,
      backend: 'tmux',
      respond: (decision, message) => this.respondToApproval(id, decision, message),
    });
  }

  /**
   * Send the approval decision back to the TUI.
   *
   * @param {string} id          — must match the most recent approval
   * @param {string} decision    — 'allow' | 'deny' (or 'always-allow')
   * @param {string} [message]   — used when decision === 'deny' for the
   *   "no, and tell Claude what to do differently" path
   */
  async respondToApproval(id, decision, message) {
    if (this._pendingApprovalId !== id) {
      // Stale or duplicate — ignore. Real TUI has moved past this prompt.
      return false;
    }
    const choice = decision === 'allow' ? '1'
      : decision === 'always-allow' ? '2'
      : '3';
    try {
      // SECURITY (audit H2 fix): always paste the menu choice ALONE
      // first + Enter, then paste the feedback message as a separate
      // step. Pre-P0.6 we did `3 ${message}` on one line — if the
      // feedback string happened to start with a digit, claude's
      // menu parser could misinterpret. Splitting eliminates the
      // ambiguity entirely.
      await this.runner.pasteText(this.tmuxName, choice);
      await this.runner.sendControl(this.tmuxName, 'Enter');
      if (choice === '3' && message) {
        // claude TUI prompts for the "tell Claude what to do
        // differently" follow-up; paste the message + Enter.
        await this.runner.pasteText(this.tmuxName, message);
        await this.runner.sendControl(this.tmuxName, 'Enter');
      }
      this._pendingApprovalId = null;
      return true;
    } catch (err) {
      this.emit('approval-fail', { id, err: err.message });
      return false;
    }
  }

  /**
   * Best-effort: text between the start-of-turn snapshot and the
   * post-completion snapshot. The capture-pane diff strategy is
   * intentionally crude in MVP — Phase 3 will switch to --debug-file
   * for structured assistant-message extraction.
   */
  _extractTurnReply(captureAtStart, captureAtEnd) {
    if (!captureAtEnd) return '';
    if (captureAtStart && captureAtEnd.startsWith(captureAtStart)) {
      return captureAtEnd.slice(captureAtStart.length).trim();
    }
    // Fallback: return whatever's after the user's last prompt marker.
    return captureAtEnd.trim();
  }

  // ─── interrupts / control ────────────────────────────────────────

  // Return-value parity with SdkProcess: these return boolean
  // (true on success, false on closed/no-op/error) so pm.* wrappers
  // and callers can branch uniformly across backends.

  async interrupt() {
    if (this.closed) return false;
    try { await this.runner.sendControl(this.tmuxName, 'C-c'); }
    catch (err) {
      this.logger.error?.(`[${this.label}] interrupt: ${err.message}`);
      return false;
    }
    this.emit('interrupt-applied', { backend: 'tmux' });
    return true;
  }

  async setModel(model) {
    if (this.closed || !model) return false;
    try {
      // Slash commands go through pasteText so embedded multibyte
      // chars in arg are safe. (Model names are ASCII, but uniform.)
      await this.runner.pasteText(this.tmuxName, `/model ${model}`);
      await this.runner.sendControl(this.tmuxName, 'Enter');
      return true;
    } catch (err) {
      this.logger.error?.(`[${this.label}] setModel: ${err.message}`);
      return false;
    }
  }

  async applyFlagSettings(settings = {}) {
    if (this.closed) return false;
    if (!settings.effortLevel) return false;
    try {
      await this.runner.pasteText(this.tmuxName, `/effort ${settings.effortLevel}`);
      await this.runner.sendControl(this.tmuxName, 'Enter');
      return true;
    } catch (err) {
      this.logger.error?.(`[${this.label}] applyFlagSettings: ${err.message}`);
      return false;
    }
  }

  async setPermissionMode(mode) {
    if (this.closed || !mode) return false;
    try {
      await this.runner.pasteText(this.tmuxName, `/permission-mode ${mode}`);
      await this.runner.sendControl(this.tmuxName, 'Enter');
      return true;
    } catch (err) {
      this.logger.error?.(`[${this.label}] setPermissionMode: ${err.message}`);
      return false;
    }
  }

  /**
   * Fire-and-forget user-message paste. Used by polygram's slash-command
   * paths (/compact). Unlike injectUserMessage (mid-turn fold only),
   * this works regardless of inFlight state — the TUI either folds
   * (if mid-stream) or starts a new turn (if idle). Fire-and-forget.
   */
  fireUserMessage(text) {
    if (this.closed) return false;
    if (typeof text !== 'string' || !text) return false;
    const safe = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!safe) return false;
    Promise.resolve()
      .then(() => this.runner.pasteText(this.tmuxName, safe))
      .then(() => this.runner.sendControl(this.tmuxName, 'Enter'))
      .catch((err) => {
        this.logger.error?.(`[${this.label}] fireUserMessage: ${err.message}`);
      });
    return true;
  }

  async resetSession() {
    // Drain locally-queued pendings before /new fires.
    const drained = this.drainQueue('RESET_SESSION');
    await this.runner.pasteText(this.tmuxName, '/new');
    await this.runner.sendControl(this.tmuxName, 'Enter');
    this.claudeSessionId = null;
    return { closed: false, drainedPendings: drained };
  }

  async getContextUsage() {
    // Compute from the latest assistant-message usage snapshot in the
    // session JSONL. Returns the same shape SdkProcess does so polygram's
    // formatContextReply + maybeContextFullHint helpers work identically
    // for both backends.
    //
    // Notes:
    //   - totalTokens = input + cache_read + cache_creation
    //     (SDK reports this same sum as "context window in use")
    //   - maxTokens defaults to 200k (all Claude 4.x models). If a
    //     future model has a different window, add the lookup here.
    //   - claude TUI auto-compacts around 85% of the window; surface
    //     that so the chat hint "I'll auto-compact when needed" stays
    //     accurate.
    if (this.closed) {
      // Parity with SdkProcess: after the Process is killed, treat
      // the snapshot as unavailable rather than returning stale cached
      // data. Polygram's /context handler maps this to "send a message
      // first" on both backends.
      throw new UnsupportedOperationError('getContextUsage', this.backend);
    }
    if (!this._lastUsage) {
      // No turn has completed yet — no usage snapshot available.
      throw new UnsupportedOperationError('getContextUsage', this.backend);
    }
    const u = this._lastUsage;
    // Each assistant message's `usage` block is cumulative for THIS
    // turn — claude's API always receives the full conversation
    // history every turn (cache just affects pricing, not context
    // size). So input + cache_read + cache_creation = full prompt
    // size that just landed at claude.
    //
    // PLUS output_tokens: claude's just-emitted reply IS now part of
    // the conversation. Next turn will see (this turn's input) +
    // (this turn's output) as its input. The "70% full" warning is
    // about predicting the next compaction trigger, so include the
    // output to be accurate forward-looking.
    const totalTokens = (u.inputTokens || 0)
      + (u.cacheReadTokens || 0)
      + (u.cacheCreationTokens || 0)
      + (u.outputTokens || 0);
    const maxTokens = DEFAULT_CONTEXT_WINDOW;
    const percentage = maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0;
    return {
      percentage,
      totalTokens,
      maxTokens,
      model: u.model,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 85,
    };
  }

  // ─── HOT-PATH sync — must NOT throw (R1-F1) ──────────────────────

  /**
   * Reject all local pendings with the supplied code. Returns count.
   * No-throw contract — autosteer's call site has no try/catch.
   */
  drainQueue(code = 'INTERRUPTED') {
    const drained = this.pendingQueue.length;
    if (drained === 0) return 0;
    const err = Object.assign(new Error(`drained:${code}`), { code });
    while (this.pendingQueue.length > 0) {
      const p = this.pendingQueue.shift();
      // Head pending (currently-running turn) has no resolve/reject —
      // it returns directly via send()'s promise chain. Skip rejection
      // for those; the send() flow handles errors via _errorResult.
      if (p && typeof p.reject === 'function') {
        try { p.reject(err); } catch (e) {
          this.logger.error?.(`[${this.label}] drainQueue reject: ${e.message}`);
        }
      }
    }
    this.emit('queue-drop', drained);
    return drained;
  }

  /**
   * Inject text into the in-flight turn. Fire-and-forget paste; errors
   * surface via 'inject-fail' event, never as a thrown exception.
   *
   * @param {object} [opts.msgId]  — rc.7: when provided, registers
   *   the (content, msgId) for autosteer fold-vs-queue tracking so
   *   the NEW-TURN case (queue dequeued as a fresh user turn) can
   *   route its reply back to Telegram via 'extra-turn-reply'.
   *
   * @returns {boolean} false if no live turn (caller falls through to
   *   pm.send queue path) OR if content sanitized to empty.
   */
  injectUserMessage({ content, priority = 'next', shouldQuery, msgId } = {}) {
    if (!this.inFlight || this.closed) return false;
    // Mirror R2-F1: sanitize even though pasteText also sanitizes.
    // We need to detect empty-after-sanitize here so caller can fall
    // through (pasteText would happily send the empty string).
    const safe = String(content || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!safe) return false;

    Promise.resolve()
      .then(() => this.runner.pasteText(this.tmuxName, safe))
      .then(() => this.runner.sendControl(this.tmuxName, 'Enter'))
      .catch((err) => this.emit('inject-fail', { err: err.message }));

    // Tell the next assistant-chunk to open a fresh Telegram bubble
    // so the post-steer reply visually follows the user's mid-turn
    // message instead of appending to the pre-steer bubble. Mirrors
    // SdkProcess's pendingSteerCausesNewBubble flag.
    if (this._turnState) {
      this._turnState.pendingSteerCausesNewBubble = true;
    }

    // rc.7: register the autosteer for fold-vs-queue tracking. The
    // JSONL parser will later emit either 'queue-folded' (FOLD) or
    // 'user-message' (NEW TURN) with the same content, and
    // _handleSessionEvent matches by content to resolve which path
    // ran. msgId is optional — when omitted, the inject is still
    // delivered but no extra-turn extraction is attempted.
    if (msgId != null) {
      this._pendingAutosteers.push({ content: safe, msgId });
    }

    this.emit('inject-user-message', { text_len: safe.length, priority, shouldQuery, msgId });
    return true;
  }

  /**
   * Steer — semantically same as inject for tmux backend (TUI has no
   * priority='now' channel; the bracketed-paste-aware buffer folds at
   * the next pause regardless). Returns boolean.
   */
  steer(text, opts = {}) {
    return this.injectUserMessage({ content: text, priority: 'now', ...opts });
  }

  // ─── teardown ────────────────────────────────────────────────────

  async kill(reason = 'kill') {
    if (this._killing) return;
    this._killing = true;
    this.closed = true;
    this.drainQueue('KILLED');
    if (this._sessionLogTail) {
      try { this._sessionLogTail.close(); } catch { /* swallow */ }
      this._sessionLogTail = null;
    }
    await this.runner.killSession(this.tmuxName);
    // P1.3 close-event parity: emit integer code first (matches SDK
    // shape `0`/`1`). Optional second arg carries tmux-specific
    // metadata for consumers that want it. Polygram's onClose only
    // reads the code today; the second arg is informational.
    this.emit('close', 0, { reason, backend: 'tmux' });
    this.emit('idle'); // pm signals LRU waiter
  }
}

module.exports = {
  TmuxProcess,
};

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
const { verifyPinnedClaudeBin } = require('../claude-bin');
const { createAsyncLock } = require('../async-lock');

// ─── Pinned claude CLI version ───────────────────────────────────────
//
// The tmux backend reads claude CLI INTERNAL artefacts (JSONL events,
// queue-operation semantics, TUI banner ASCII art, READY hint
// strings, MULTILINE_SEPARATOR convention, stop_reason values). None
// of these are a stable public contract — they can change in any
// new CLI version. The rc.7→rc.15 saga (May 2026) is direct
// evidence: every rc shipped fixes for behaviour that drifted in the
// CLI without polygram logic changing.
//
// So polygram pins ONE specific CLI version. Production daemon must
// run that exact version. Upgrading the pin is a SEPARATE, deliberate
// process — see AGENTS.md "Pinned claude CLI version" for the full
// procedure (read release notes → bump → run all spikes → diff
// JSONL → 24h staging on shumorobot → roll to umi-assistant).
//
// Bumping this constant WITHOUT following that procedure is how the
// rc.7→rc.15 saga got triggered. Don't.
const CLAUDE_CLI_PINNED_VERSION = '2.1.142';

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
// claude TUI shows a different ready hint depending on permission
// mode:
//   - default:           "? for shortcuts"
//   - acceptEdits:       "accept edits on"
//   - bypassPermissions: "bypass permissions on (shift+tab to cycle)"
// All three are valid ready states. Polygram production uses
// 'default', but the spike harness + tests exercising
// bypassPermissions need the third matcher (caught by the rc.14
// autosteer-tui-real.mjs spike).
const READY_HINTS_RE    = /\?\s+for shortcuts|accept edits on|bypass permissions on/;
const STREAMING_HINT_RE = /esc to interrupt/;

// L1 fix (spike leftover): the claude TUI shows its welcome banner
// WITH a ready hint at the bottom during startup — before the user's
// prompt has been processed:
//
//    ▐▛███▜▌   Claude Code v2.1.142
//   ▝▜█████▛▘  Sonnet 4.6 with low effort · Claude Max
//     ▘▘ ▝▝    ~/Projects/shumkov/polygram
//   ...
//   ? for shortcuts                  ← ready hint already present
//
// _awaitTurnComplete's poll sees the ready hint and resolves
// captureCompleteP. If the agent hasn't emitted any text yet,
// _extractTurnReply returns the banner text → pm.send returns the
// banner as result.text → polygram delivers the banner as a Telegram
// reply. Caught in the 50-scenario spike's baseline-tool-call.
//
// Distinctive banner marker — the box-drawing characters in the
// claude logo. Polygram's prompts / agents never legitimately
// contain these. While these characters appear in the pane,
// treat the TUI as NOT YET ready regardless of READY_HINTS_RE.
const TUI_BANNER_RE = /▐▛███▜▌|▝▜█████▛▘/;

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
    pasteConfirmMs = 2500,  // Phase 3 §5: paste-gating JSONL-confirm timeout
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

    // ─── 0.10.0 Phase 2: correlation token + turn ledger ──────────
    //
    // The four legacy accumulators (_turnState / pendingQueue /
    // _pendingAutosteers / _extraTurnState) were four partial
    // projections of ONE missing object: an ordered ledger of turns,
    // each with a stable id, an owning msgId set, and a state.
    // Attribution used to be RECONSTRUCTED by content-matching JSONL
    // — lossy under paste concatenation, substring collisions, and
    // event reorder. It is now RECORDED: every paste embeds a unique
    // correlation token in its <polygram-info> block; the JSONL
    // user-message reproduces the token verbatim; routing is an exact
    // token→Turn lookup.
    //
    // `_ledger` — every Turn, append-ordered. A Turn:
    //   { turnId, token, msgIds:[], kind:'primary'|'autosteer',
    //     state:'queued'|'pasted'|'streaming'|'done'|'failed',
    //     text, toolUses, toolUsedThisTurn, stopReason, resultEvent,
    //     context, opts, prompt, startedAt, via,
    //     resolve/reject (primary send() promise),
    //     settleResult/resultPromise (internal turn-done signal) }
    //
    // `pendingQueue` (from the base Process) is kept as the external
    // contract surface — lib/sdk/callbacks.js reads
    // pendingQueue[0].context.{streamer,reactor}. It holds the SAME
    // primary Turn objects as `_ledger`, head-first; `_ledger` is the
    // authority, `pendingQueue` its primary-only projection.
    this._ledger = [];
    this._turnSeq = 0;
    // The turns currently receiving assistant events. Driven purely
    // by `user-message` token matches — never by "which accumulator
    // is non-null". A group with >1 turn is an explicit fold.
    this._activeGroup = { turns: [], text: '', pendingSteerCausesNewBubble: false };
    // Turns whose paste the TUI has parked in its input queue
    // (`queue-operation enqueue`), oldest first — a FIFO mirror of the
    // TUI's own queue. `remove`/`dequeue` are bare (no token), so they
    // are resolved positionally; the list must therefore mirror EVERY
    // queued paste, primary OR autosteer (R2 — a primary paste that
    // gets queued must be tracked too, or the FIFO desyncs). A `remove`
    // folds the head autosteer into the running turn; a `dequeue`
    // releases the head to run as a fresh turn (its user-message
    // follows and _routeUserMessage handles it).
    this._enqueuedTurns = [];

    // ─── 0.10.0 Phase 3 §5: paste gating ──────────────────────────
    // A paste does not release the next paste until the JSONL tail
    // confirms it landed (its token surfaced in a user-message /
    // queue-operation), bounded by `pasteConfirmMs`. Converts the
    // 50ms post-Enter drain guess into a real barrier — two pastes
    // can no longer concatenate into one TUI input.
    this._pasteLock = createAsyncLock();
    this._pasteConfirms = new Map();   // token → resolve fn
    this.pasteConfirmMs = pasteConfirmMs;
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

      // Pin: spawn the ABSOLUTE pinned-version binary, never the
      // bare `claude` on $PATH. The claude CLI auto-updater
      // re-points the ~/.local/bin/claude symlink whenever a new
      // version lands, so a $PATH spawn silently drifts off the
      // pinned version the tmux backend was validated against
      // (shumorobot 2026-05-16: CLI drifted 2.1.142 → 2.1.143
      // between deploys). The versioned binary at
      // ~/.local/share/claude/versions/<v> is immutable — the
      // updater only adds new files, never overwrites.
      const binCheck = verifyPinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION);
      if (!binCheck.ok) {
        throw Object.assign(new Error(binCheck.reason), { code: 'CLAUDE_BIN_MISSING' });
      }

      // R2-F8: spawn errors must fail loud, not silent-catch.
      await this.runner.spawn({
        name: this.tmuxName,
        cwd,
        command: binCheck.path,
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
      throw Object.assign(new Error('No process for session'), { code: 'PROCESS_CLOSED' });
    }
    // queueCap parity with SDK — bound the ledger's queued primaries.
    if (this.inFlight && this.pendingQueue.length >= this.queueCap) {
      throw Object.assign(
        new Error(`queue overflow: queueCap ${this.queueCap}`),
        { code: 'QUEUE_OVERFLOW' },
      );
    }

    // Register a primary Turn. Its correlation token is embedded into
    // the paste; the JSONL `user-message` reproduces it verbatim; the
    // event router then attributes by exact token lookup.
    const turn = this._makeTurn({
      kind: 'primary',
      prompt: String(prompt ?? ''),
      opts,
      context: opts.context || {},
      msgIds: opts.context && opts.context.sourceMsgId != null
        ? [opts.context.sourceMsgId] : [],
    });
    turn.callerPromise = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    this._ledger.push(turn);
    // pendingQueue holds primary Turn objects head-first — it is the
    // external contract surface (lib/sdk/callbacks.js reads
    // pendingQueue[0].context.{streamer,reactor}). The running turn
    // is always pendingQueue[0].
    this.pendingQueue.push(turn);
    if (this.pendingQueue[0] === turn) {
      // Nothing ahead — run immediately. (Not awaited; _runTurn
      // settles turn.callerPromise and drains the next queued turn.)
      this._runTurn(turn);
    }
    // else: queued. _finishTurn() runs it when the head completes.
    return turn.callerPromise;
  }

  /**
   * Run one primary Turn end-to-end: embed its token, paste, race the
   * JSONL terminal `result` against capture-pane quiescence, build the
   * PmSendResult, settle the caller, and drain the next queued turn.
   */
  async _runTurn(turn) {
    this.inFlight = true;
    turn.state = 'pasted';
    turn.startedAt = this._now();
    const turnTimeoutMs = turn.opts.timeoutMs || this.turnTimeoutMs;
    // Internal turn-done signal — settled by _flushActiveGroup when
    // this turn's group is flushed on a terminal `result`.
    turn.resultPromise = new Promise((resolve) => { turn.settleResult = resolve; });

    try {
      // rc.13.1: pasteAndEnter holds a per-session async lock around
      // paste + Enter so a concurrent injectUserMessage paste cannot
      // interleave keystrokes with this primary prompt.
      const result = await this._pasteAndEnter(this._embedToken(turn.prompt, turn.token));
      if (result.stripped > 0) {
        this.logger.warn?.(
          `[${this.label}] stripped ${result.stripped} control chars from prompt`,
        );
        this.emit('prompt-sanitized', { stripped: result.stripped, source: 'send' });
      }

      // Race: JSONL terminal result vs capture-pane quiescence vs the
      // hard turn timeout. 0.10.0 Phase 4 §6: JSONL is the SOLE source
      // of reply text. capture-pane is a LIVENESS signal only — it
      // detects "the turn is done" so we never wait forever for a
      // `result` that never arrives, but it NEVER delivers text.
      const captureCompleteP = this._awaitTurnComplete({ timeoutMs: turnTimeoutMs });

      let resolvedVia = 'jsonl';
      let winner = await Promise.race([
        turn.resultPromise.then((ev) => ({ kind: 'jsonl', ev })),
        captureCompleteP.then(() => ({ kind: 'capture' })),
      ]);

      // If capture-pane won but the turn used a tool, the agent is
      // still working — the "ready" hint was a transient idle between
      // tool calls. Wait for the real terminal result from JSONL.
      if (winner.kind === 'capture' && turn.toolUsedThisTurn) {
        winner = { kind: 'jsonl', ev: await turn.resultPromise };
      }

      let text;
      let resultSubtype = 'success';
      let stopReason = null;
      if (winner.kind === 'jsonl') {
        text = turn.text || winner.ev.text || '';
        resultSubtype = winner.ev.subtype || 'success';
        stopReason = winner.ev.stopReason || null;
        if (winner.ev.sessionId) this.claudeSessionId = winner.ev.sessionId;
      } else {
        // Capture-pane quiescence judged the turn complete. Force the
        // JSONL aggregator to finalize any buffered message so the
        // structured `result` settles turn.resultPromise now.
        this._sessionLogTail?.flushParser?.();
        if (turn.text) {
          resolvedVia = 'jsonl-streamed';
          text = turn.text;
        } else {
          const lateGraceMs = this.lateGraceMs ?? 1500;
          const late = await Promise.race([
            turn.resultPromise.then((ev) => ({ kind: 'jsonl-late', ev })),
            new Promise((r) => setTimeout(() => r({ kind: 'no-jsonl' }), lateGraceMs)),
          ]);
          if (late.kind === 'jsonl-late') {
            resolvedVia = 'jsonl-late';
            text = turn.text || late.ev.text || '';
            resultSubtype = late.ev.subtype || 'success';
            stopReason = late.ev.stopReason || null;
            if (late.ev.sessionId) this.claudeSessionId = late.ev.sessionId;
          } else {
            // §6: capture-pane judged the turn done, but JSONL
            // produced NO reply text within the grace window. FAIL
            // LOUD — never fall back to capture-pane diff text. That
            // fallback WAS the echoed-input failure (the pane diff
            // returned the user's own echoed prompt) and the
            // banner-as-reply failure (L1). The error result clears
            // the reactor explicitly instead of delivering garbage.
            throw Object.assign(
              new Error('turn produced no JSONL reply text within grace window'),
              { code: 'TMUX_NO_JSONL_TEXT' },
            );
          }
        }
      }

      const duration = this._now() - turn.startedAt;
      this.emit('result', { subtype: resultSubtype, resolvedVia }, { streamText: text, stopReason });

      const u = this._lastUsage;
      const cost = u ? computeCostUsd(u, u.model) : null;
      turn.state = 'done';
      turn.resolve({
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
          numToolUses: turn.toolUses,
          resultSubtype,
          stopReason,
          resolvedVia,
        },
      });
    } catch (err) {
      turn.state = 'failed';
      turn.resolve(this._errorResult(err.code || 'tmux_send_error', err.message || String(err)));
    } finally {
      this._finishTurn(turn);
    }
  }

  /**
   * Retire a finished primary turn and drain the next queued one.
   */
  _finishTurn(turn) {
    // Finalize any assistant message still buffered in the JSONL
    // aggregator BEFORE the next turn starts, so a turn that ended
    // without a terminal `result` (e.g. turnTimeoutMs) cannot leak
    // its buffered message into turn N+1.
    this._sessionLogTail?.flushParser?.();
    const qi = this.pendingQueue.indexOf(turn);
    if (qi >= 0) this.pendingQueue.splice(qi, 1);
    this._dropFromActiveGroup(turn);
    // R1: if this primary turn ended WITHOUT its active group being
    // flushed by a terminal `result` (it timed out or errored), the
    // autosteer turns folded into that group would otherwise strand
    // as `streaming` forever — leaking in the ledger AND keeping
    // `_activeGroup` non-empty, which silently swallows the next
    // autonomous assistant message. Retire the leftovers + reset the
    // group. (On a successful turn `_flushActiveGroup` already reset
    // the group, so `turns` is empty here and this is a no-op.)
    if (this._activeGroup.turns.length > 0) {
      for (const t of this._activeGroup.turns) {
        if (t.state !== 'done' && t.state !== 'failed') t.state = 'failed';
      }
      this._activeGroup = { turns: [], text: '', pendingSteerCausesNewBubble: false };
    }
    this._sweepStaleTurns();
    const next = this.pendingQueue[0];
    if (next && next.state === 'queued') {
      this._runTurn(next);
    } else {
      this.inFlight = false;
      this.emit('idle');
    }
  }

  // ─── token + ledger helpers (0.10.0 Phase 2) ─────────────────────

  /** Mint a unique correlation token. `[a-z0-9-]` only — newline-free,
   *  no XML metacharacters — so it survives paste -> MULTILINE_SEPARATOR
   *  -> JSONL verbatim (validated by scripts/spikes/correlation-token-tui). */
  _mintToken() {
    return `pgm-corr-${crypto.randomBytes(12).toString('hex')}`;
  }

  /** Build a fresh Turn record. */
  _makeTurn({ kind, prompt = '', opts = {}, context = {}, msgIds = [] }) {
    this._turnSeq += 1;
    return {
      turnId: this._turnSeq,
      token: this._mintToken(),
      msgIds: [...msgIds],
      kind,                      // 'primary' | 'autosteer'
      state: 'queued',           // queued | pasted | streaming | done | failed
      text: '',
      toolUses: 0,
      toolUsedThisTurn: false,
      stopReason: null,
      resultEvent: null,
      via: null,                 // autosteer: 'fold' | 'new-turn'
      context, opts, prompt,
      startedAt: 0,
      resolve: null, reject: null, callerPromise: null,
      settleResult: null, resultPromise: null,
    };
  }

  /**
   * Embed a correlation token into a prompt's <polygram-info> block as
   * a `corr-id` attribute. The agent is already instructed to ignore
   * that block, so the token is invisible to the conversation. If the
   * prompt has no <polygram-info> block (non-standard paste), prepend
   * a minimal carrier — the agent ignores empty <polygram-info> too.
   */
  _embedToken(prompt, token) {
    const p = String(prompt ?? '');
    if (/<polygram-info[\s>]/.test(p)) {
      return p.replace(/<polygram-info([\s>])/, `<polygram-info corr-id="${token}"$1`);
    }
    return `<polygram-info corr-id="${token}"></polygram-info>\n\n${p}`;
  }

  /** Extract every correlation token present in a JSONL line.
   *  Matches the EXACT minted shape (`pgm-corr-` + 24 hex from
   *  randomBytes(12)) — `{24}` instead of `+` so a token followed by
   *  adjacent hex still extracts exactly the 24-char token (R6). */
  _extractTokens(text) {
    if (typeof text !== 'string') return [];
    const m = text.match(/pgm-corr-[0-9a-f]{24}/g);
    return m ? [...new Set(m)] : [];
  }

  /** Drop done/failed turns — token uniqueness means a stale match is
   *  impossible, so retired turns are pure memory overhead. */
  _pruneLedger() {
    this._ledger = this._ledger.filter(
      (t) => t.state !== 'done' && t.state !== 'failed',
    );
  }

  /**
   * 0.10.0 Phase 4 §7: stale-turn sweep. An autosteer turn whose
   * paste the TUI never correlated (no enqueue / remove / dequeue /
   * user-message) within a grace window is dead — fail it loud so it
   * cannot leak in the ledger. A primary turn that produces no JSONL
   * text already fails loud via §6 in `_runTurn`, so the sweep only
   * targets stuck autosteers. Runs at every turn completion.
   */
  _sweepStaleTurns() {
    const now = this._now();
    const graceMs = this.turnTimeoutMs;
    for (const turn of this._ledger) {
      if (turn.kind !== 'autosteer' || turn.state !== 'pasted') continue;
      if (!turn.startedAt || (now - turn.startedAt) < graceMs) continue;
      turn.state = 'failed';
      this._enqueuedTurns = this._enqueuedTurns.filter((t) => t !== turn);
      this.emit('autosteer-match-miss', {
        phase: 'stale-sweep',
        msgId: turn.msgIds[0] ?? null,
        turnId: turn.turnId,
        ageMs: now - turn.startedAt,
        sessionId: this.claudeSessionId,
        backend: 'tmux',
      });
    }
    this._pruneLedger();
  }

  _dropFromActiveGroup(turn) {
    this._activeGroup.turns = this._activeGroup.turns.filter((t) => t !== turn);
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
   * Events are routed by `_handleSessionEvent` through the Phase 2
   * turn ledger — `user-message` tokens attribute each event to its
   * Turn; `result` flushes the active group.
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
      // Assistant text belongs to whatever turn(s) the latest
      // `user-message` token routed into the active group. The
      // handler never guesses from "which accumulator is non-null".
      const group = this._activeGroup;
      if (group.turns.length > 0) {
        // A mid-turn steer asks the NEXT assistant message to open a
        // fresh Telegram bubble so the post-steer reply doesn't
        // visually append to the pre-steer text.
        if (group.pendingSteerCausesNewBubble) {
          group.pendingSteerCausesNewBubble = false;
          group.text = '';
          this.emit('assistant-message-start');
        }
        group.text = group.text ? `${group.text}\n\n${ev.text}` : ev.text;
        // Keep every turn in the group current — a fold shares one
        // reply across its members.
        for (const t of group.turns) t.text = group.text;
        // stream-chunk drives the live Telegram bubble via
        // pendingQueue[0].context.streamer — only the primary turn
        // owns that surface. Autosteer NEW-TURN replies are delivered
        // whole via extra-turn-reply, never streamed.
        if (group.turns.some((t) => t.kind === 'primary')) {
          this.emit('stream-chunk', group.text);
        }
      } else {
        // No active turn — autonomous assistant message (claude
        // self-initiated; typically ScheduleWakeup firing).
        this.emit('autonomous-assistant-message', {
          text: ev.text,
          sessionId: this.claudeSessionId,
          backend: 'tmux',
        });
      }
    } else if (ev.type === 'tool-use') {
      for (const t of this._activeGroup.turns) {
        t.toolUses++;
        // The `tool-use` event is the earliest proof a tool ran — set
        // the flag here so a transient capture-pane "ready" between
        // tool calls cannot resolve a still-working turn.
        t.toolUsedThisTurn = true;
      }
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
      // Only a TERMINAL stop_reason ends a turn. The JSONL aggregator
      // emits a `result` per assistant message — `tool_use` is
      // NON-terminal (the agent paused for a tool; more messages
      // follow). Terminal: 'success' (end_turn), 'max_tokens',
      // 'stop_sequence', 'refusal'.
      if (ev.subtype === 'tool_use') return;
      this._flushActiveGroup(ev);
    } else if (ev.type === 'user-message') {
      this._routeUserMessage(ev);
    } else if (ev.type === 'queue-operation') {
      // The live queue-activity signal — the real fold mechanism
      // (verified against claude 2.1.142 JSONL):
      //   enqueue {content} — a paste was parked in the TUI's input
      //     queue; content carries the correlation token.
      //   remove           — the oldest queued paste was FOLDED into
      //     the running turn. NO user-message follows — the autosteer
      //     MUST be resolved here or it leaks forever.
      //   dequeue          — the oldest queued paste was released to
      //     run as a fresh turn; its user-message follows and
      //     _routeUserMessage resolves it (NEW-TURN).
      if (ev.operation === 'enqueue' && ev.content) {
        const tokens = this._extractTokens(ev.content);
        this._confirmPaste(tokens);   // §5: enqueue proves the paste landed
        for (const tok of tokens) {
          // R2: track ANY queued turn — primary OR autosteer. A
          // primary paste that lands while the TUI is busy is also
          // queued; if it is not mirrored here, the later positional
          // `remove`/`dequeue` shift pops the wrong turn and the FIFO
          // desyncs.
          const turn = this._ledger.find(
            (t) => t.token === tok
              && t.state !== 'done' && t.state !== 'failed',
          );
          if (turn && !this._enqueuedTurns.includes(turn)) {
            this._enqueuedTurns.push(turn);
          }
        }
      } else if (ev.operation === 'remove') {
        // The head queued turn was FOLDED into the running turn. Only
        // an autosteer folds — a primary never does; if a primary is
        // somehow at the head it is just dropped from tracking.
        const turn = this._enqueuedTurns.shift();
        if (turn && turn.kind === 'autosteer'
          && turn.state !== 'done' && turn.state !== 'failed') {
          this._foldAutosteer(turn);
        }
      } else if (ev.operation === 'dequeue') {
        // The head queued turn was released to run as a fresh turn —
        // drop tracking; its user-message follows and _routeUserMessage
        // resolves it (primary → its own turn; autosteer → NEW-TURN).
        this._enqueuedTurns.shift();
      }
    } else if (ev.type === 'queue-folded') {
      // Dead path: `attachment.queued_command` does not appear in
      // real claude 2.1.142 JSONL. Kept inert for parser parity.
    } else if (ev.type === 'last-prompt') {
      // `last-prompt` fires when a prompt is REGISTERED, not when a
      // turn ends. The JSONL aggregator already fires a proper
      // `result` on the message's terminal stop_reason; this is only
      // a safety net for a turn whose terminal stop_reason never
      // wrote. Fire it ONLY when the active group has a primary turn
      // with accumulated text — never hijack a turn that has not
      // started replying.
      const group = this._activeGroup;
      if (group.turns.some((t) => t.kind === 'primary')
        && group.text && group.text.length > 0) {
        this._flushActiveGroup({
          type: 'result',
          subtype: 'success',
          text: group.text,
          stopReason: 'last-prompt',
          sessionId: this.claudeSessionId,
        });
      }
    }
  }

  /**
   * Route a JSONL `user-message` to the turn(s) its correlation
   * token(s) identify. This is the heart of recorded (not
   * reconstructed) attribution: each token is an exact id lookup.
   *
   * A user-message's matched turns join the active group:
   *   - if the group will contain a primary turn, an autosteer turn
   *     is a FOLD — the primary's reply covers it (autosteer-
   *     resolution via:fold; no separate delivery);
   *   - otherwise the autosteer is a NEW-TURN — it gets its own
   *     reply via extra-turn-reply on the group's terminal result.
   * N tokens in ONE user-message (a concatenated paste) is an
   * explicit, unambiguous fold of N turns.
   */
  _routeUserMessage(ev) {
    const tokens = this._extractTokens(ev.text);
    // Phase 3 §5: a user-message proves its pastes landed — release
    // the paste gate for those tokens.
    this._confirmPaste(tokens);
    let matched = [];
    for (const tok of tokens) {
      const t = this._ledger.find(
        (x) => x.token === tok && x.state !== 'done' && x.state !== 'failed',
      );
      if (t && !matched.includes(t)) matched.push(t);
    }
    if (matched.length === 0) {
      // No token matched. A token-less user-message can still be a
      // primary turn we pasted whose token failed to round-trip —
      // claim the oldest such 'pasted' primary as a fallback.
      if (tokens.length === 0) {
        const orphan = this._ledger.find(
          (x) => x.kind === 'primary' && x.state === 'pasted',
        );
        if (orphan) matched = [orphan];
      }
      if (matched.length === 0) {
        // Genuinely unrecognised — diagnostic, then ignore. (A
        // resumed-session historic user-message lands here; harmless.)
        this.emit('autosteer-match-miss', {
          phase: 'user-message',
          text_head: (ev.text || '').slice(0, 80),
          token_count: tokens.length,
          ledger_size: this._ledger.length,
          sessionId: this.claudeSessionId,
          backend: 'tmux',
        });
        return;
      }
    }
    const group = this._activeGroup;
    const willHavePrimary = group.turns.some((t) => t.kind === 'primary')
      || matched.some((t) => t.kind === 'primary');
    for (const t of matched) {
      if (group.turns.includes(t)) continue;
      // R4: idempotency guard — a turn that already has a `via` was
      // already classified (e.g. folded via `queue-operation remove`).
      // Never route or resolve it twice.
      if (t.via) continue;
      t.state = 'streaming';
      group.turns.push(t);
      if (t.kind !== 'autosteer') continue;
      t.via = willHavePrimary ? 'fold' : 'new-turn';
      if (t.via === 'new-turn') {
        for (const msgId of t.msgIds) {
          this.emit('extra-turn-started', {
            msgId, sessionId: this.claudeSessionId, backend: 'tmux',
          });
        }
      }
      for (const msgId of t.msgIds) {
        this.emit('autosteer-resolution', {
          msgId, via: t.via, sessionId: this.claudeSessionId, backend: 'tmux',
        });
      }
    }
  }

  /**
   * Resolve an autosteer turn the TUI folded into the running turn
   * (a `queue-operation remove`). A fold shares the primary turn's
   * reply — autosteer-resolution(via:fold) tells polygram the message
   * is covered; no separate extra-turn-reply is delivered. The turn
   * joins the active group so the terminal-result flush retires it.
   */
  _foldAutosteer(turn) {
    turn.via = 'fold';
    turn.state = 'streaming';
    if (!this._activeGroup.turns.includes(turn)) {
      this._activeGroup.turns.push(turn);
    }
    for (const msgId of turn.msgIds) {
      this.emit('autosteer-resolution', {
        msgId, via: 'fold', sessionId: this.claudeSessionId, backend: 'tmux',
      });
    }
  }

  /**
   * Flush the active turn group on a terminal `result`: settle the
   * primary turn's send() race, deliver each NEW-TURN autosteer's
   * reply, and clear the group.
   */
  _flushActiveGroup(ev) {
    const group = this._activeGroup;
    if (group.turns.length === 0) return; // autonomous segment end
    const turns = group.turns;
    const text = group.text;
    this._activeGroup = { turns: [], text: '', pendingSteerCausesNewBubble: false };
    if (ev.sessionId) this.claudeSessionId = ev.sessionId;
    for (const t of turns) {
      t.state = 'done';
      t.text = text;
      t.stopReason = ev.stopReason || null;
      t.resultEvent = ev;
    }
    // Primary turn — settle its _runTurn race so send() resolves.
    const primary = turns.find((t) => t.kind === 'primary');
    if (primary && typeof primary.settleResult === 'function') {
      primary.settleResult(ev);
    }
    // Autosteer NEW-TURN turns — deliver the shared reply once per
    // owning msgId. FOLD autosteers already emitted autosteer-
    // resolution(via:fold); the primary's reply covers them.
    for (const t of turns) {
      if (t.kind !== 'autosteer' || t.via !== 'new-turn') continue;
      for (const msgId of t.msgIds) {
        this.emit('extra-turn-reply', {
          msgId, text, sessionId: this.claudeSessionId, backend: 'tmux',
        });
      }
    }
  }

  /**
   * Paste a prompt body + press Enter, then GATE the next paste on
   * JSONL confirmation (0.10.0 Phase 3 §5).
   *
   * rc.13.1: the runner's `pasteAndEnter` holds a per-session lock so
   * the paste+Enter pair is atomic (no interleaved keystrokes).
   *
   * Phase 3 §5 adds the outer barrier: `_pasteLock` is held until the
   * JSONL tail confirms THIS paste landed — its correlation token
   * surfaced in a `user-message` or `queue-operation` event — bounded
   * by `pasteConfirmMs`. The next `_pasteAndEnter` therefore cannot
   * start until the previous paste is a distinct TUI input, so two
   * pastes can no longer concatenate. The lock is released
   * asynchronously (on confirm/timeout) so it gates only the NEXT
   * paste, never delays this caller.
   */
  async _pasteAndEnter(text) {
    const token = this._extractTokens(text)[0] || null;
    const release = await this._pasteLock.acquire(this.tmuxName);
    let result;
    try {
      if (typeof this.runner.pasteAndEnter === 'function') {
        result = await this.runner.pasteAndEnter(this.tmuxName, text);
      } else {
        result = await this.runner.pasteText(this.tmuxName, text);
        await this.runner.sendControl(this.tmuxName, 'Enter');
      }
    } catch (err) {
      release();
      throw err;
    }
    // Hold the paste lock until JSONL confirms this paste — gating
    // the NEXT paste, not this caller (which gets `result` now).
    if (token) {
      this._awaitPasteConfirm(token).then(release, release);
    } else {
      release();
    }
    return result;
  }

  /**
   * Resolve once `token` surfaces in a JSONL user-message /
   * queue-operation, or after `pasteConfirmMs` (bounded barrier).
   */
  _awaitPasteConfirm(token) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._pasteConfirms.delete(token);
        resolve();
      };
      this._pasteConfirms.set(token, finish);
      setTimeout(finish, this.pasteConfirmMs).unref?.();
    });
  }

  /** Mark the given correlation tokens as JSONL-confirmed (Phase 3 §5). */
  _confirmPaste(tokens) {
    for (const t of tokens) {
      const finish = this._pasteConfirms.get(t);
      if (finish) finish();
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
        // L1 fix: ignore READY hint while the startup banner is
        // still the LATEST thing on the pane. After the agent has
        // emitted content, the banner ends up in scrollback far
        // above the bottom — at that point we DO want READY to
        // count. Check only the last ~10 lines for the banner:
        // if the bottom of the pane is still banner+ready, the
        // agent hasn't produced output yet, so the ready hint is
        // a startup artifact, not the end of a real turn.
        const bottomTail = lastBuf.slice(-2000);  // ~10-20 lines of pane bottom
        cachedReady = READY_HINTS_RE.test(lastBuf) && !TUI_BANNER_RE.test(bottomTail);
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

  // 0.10.0 Phase 4 §6: `_extractTurnReply` (capture-pane diff text
  // extraction) is GONE. Reply text comes exclusively from JSONL
  // keyed to a turn. capture-pane is liveness-only — see `_runTurn`.

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
   * Reject every QUEUED primary turn with the supplied code. The
   * running head turn (pendingQueue[0], state 'pasted'/'streaming')
   * is left alone — it settles normally via its own _runTurn flow.
   * Returns the count drained. No-throw contract — autosteer's call
   * site has no try/catch.
   */
  drainQueue(code = 'INTERRUPTED') {
    // Drain every pendingQueue entry EXCEPT the running head (a Turn
    // in state 'pasted'/'streaming' — it settles via its own _runTurn
    // flow). Queued turns ('queued') are drained; so are stateless
    // entries (test fakes), which are never the running head.
    const toDrain = this.pendingQueue.filter(
      (t) => t.state !== 'pasted' && t.state !== 'streaming',
    );
    if (toDrain.length === 0) return 0;
    const err = Object.assign(new Error(`drained:${code}`), { code });
    for (const t of toDrain) {
      const qi = this.pendingQueue.indexOf(t);
      if (qi >= 0) this.pendingQueue.splice(qi, 1);
      if (t.state) t.state = 'failed';
      if (typeof t.reject === 'function') {
        try { t.reject(err); } catch (e) {
          this.logger.error?.(`[${this.label}] drainQueue reject: ${e.message}`);
        }
      }
    }
    this._pruneLedger();
    this.emit('queue-drop', toDrain.length);
    return toDrain.length;
  }

  /**
   * Inject text into the in-flight turn (autosteer). Fire-and-forget
   * paste; errors surface via 'inject-fail', never as a throw.
   *
   * Registers an autosteer Turn in the ledger with a fresh
   * correlation token embedded in the paste. When the TUI surfaces
   * the paste as a JSONL `user-message`, the token routes it — FOLD
   * (a primary turn shares the group) or NEW-TURN (it does not).
   *
   * @param {object} [opts.msgId]  — Telegram msgId; when present, a
   *   NEW-TURN autosteer's reply is routed back via 'extra-turn-reply'.
   * @returns {boolean} false if no live turn (caller falls through to
   *   the pm.send queue path) OR if content sanitized to empty.
   */
  injectUserMessage({ content, priority = 'next', shouldQuery, msgId } = {}) {
    if (!this.inFlight || this.closed) return false;
    // Detect empty-after-sanitize here so the caller can fall through.
    const safe = String(content || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!safe) return false;

    const turn = this._makeTurn({
      kind: 'autosteer',
      prompt: safe,
      msgIds: msgId != null ? [msgId] : [],
    });
    turn.state = 'pasted';
    turn.startedAt = this._now();   // Phase 4 §7: staleness clock
    this._ledger.push(turn);

    // The next assistant message after a mid-turn steer opens a fresh
    // Telegram bubble so the post-steer reply doesn't append to the
    // pre-steer text.
    this._activeGroup.pendingSteerCausesNewBubble = true;

    // pasteAndEnter holds the per-session lock so this autosteer's
    // paste+Enter cannot interleave keystrokes with an in-flight
    // primary paste.
    this._pasteAndEnter(this._embedToken(safe, turn.token))
      .catch((err) => this.emit('inject-fail', { err: err.message }));

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
    // R5: release any pending paste-confirm waiters so a `_pasteAndEnter`
    // blocked on JSONL confirmation settles instead of waiting out
    // pasteConfirmMs against a dead session. Each `finish` resolves
    // its promise and deletes its own Map entry.
    for (const finish of [...this._pasteConfirms.values()]) {
      try { finish(); } catch { /* swallow */ }
    }
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
  CLAUDE_CLI_PINNED_VERSION,
};

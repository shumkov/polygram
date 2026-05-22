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
const { TurnPhase, isLegalTransition } = require('./turn-phase');
const { writeHookFiles, removeHookFiles } = require('./hook-settings');
const { createHookTail } = require('./hook-event-tail');

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

// Bug 1 (incident 2026-05-18): when the agent leaves a detached
// background shell running (a `run_in_background:true` Bash), the
// claude TUI shows a background-shell count in the pane. Verified
// against claude 2.1.142 — two forms:
//   - the bottom hint line:  "… · 1 shell · ↓ to manage"
//   - the status line:       "✻ Baked for 5s · 1 shell still running"
// Both carry "<N> shell(s)". polygram's turn-scoped Stop is blind to
// these; this regex lets the abort handler see them.
const BG_SHELL_RE = /\b\d+\s+shells?\b/;

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
//
// 2026-05-18 incident fix: the verb after "Do you want to" varies by
// tool — Bash → "do this", Write → "create CLAUDE.md", Edit → "make
// this edit", etc. A `proceed|do this|continue` whitelist missed
// "create" and hung the Music topic for 7+ min with no approval card.
// Match the STRUCTURE, not a verb whitelist: a "Do you want to …?"
// question (verb is a bounded wildcard, single-line — no newline so
// it can't swallow past the question) followed within the bounded
// window by the numbered menu. The verb was never the security
// control — the required `1.` menu line is, and it is unchanged.
const APPROVAL_PROMPT_RE = /Do you want to [^\n?]{1,80}\??[\s\S]{0,400}?(?:^|\n)[^\S\n]*(?:❯[^\S\n]+)?1\.\s+/im;
// Pull the tool name + raw arg snippet from the line preceding the
// approval prompt. Capture-pane preserves the ⏺ marker.
const TOOL_INVOCATION_RE = /⏺\s+([A-Za-z_]\w*)\s*\((.*?)\)\s*$/m;

// 0.10.0 predicate H1 fallback (paste-parked via capture-pane). The
// claude TUI shows this indicator when a paste was rejected to the
// queue because the previous turn was busy. The JSONL
// `queue-operation enqueue` is the primary signal for `paste-parked`
// (correlation-token bound); this regex is the fallback path when
// JSONL hasn't tailed in yet (typical 50-200ms gap between TUI
// rendering and JSONL flush) so the predicate doesn't briefly stall
// on `pasted-unconfirmed`.
const QUEUED_PASTE_RE = /Press up to edit queued messages/;

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
// 0.10.0 H3 — hook-fed idle ceiling + hard backstop.
//   `turnTimeoutMs`         — IDLE ceiling (default 5 min). A turn is
//                              wedged only if there's no activity
//                              (JSONL events, capture-pane signals,
//                              OR hook events) for this long. A
//                              healthy long subagent firing hooks
//                              every few seconds never trips this.
//   `hardBackstopMs`        — absolute backstop against pathological
//                              infinite tool loops. Default 4h.
//   `IDLE_POLL_INTERVAL_MS` — how often the idle poller in
//                              _awaitSettle wakes to check the
//                              accumulated idle. Coarse enough to be
//                              cheap, fine enough that the perceived
//                              wedge-detection delay is bounded.
const DEFAULT_HARD_BACKSTOP_MS = 4 * 60 * 60_000;     // 4 hours
const IDLE_POLL_INTERVAL_MS    = 30_000;              // 30 s
// 0.10.0 H4 — `Stop` hook as authoritative turn-done.
//   The Stop hook fires when claude finishes responding — same
//   semantic as the JSONL `result` event. Both should land within
//   ms of each other; this grace gives JSONL a chance to win (full
//   result data: subtype, stopReason, all the metadata) before the
//   Stop hook synthesizes a fallback settle. If the JSONL stream is
//   broken or stuck, Stop carries the turn to completion alone.
const DEFAULT_STOP_GRACE_MS    = 2_000;               // 2 s

// B8 (slow-MCP readiness): how long the claude `--debug-file` log must
// have had NO new bytes appended before the startup is considered
// quiescent. During MCP cold-start the debug log is DENSELY written —
// the production log shows ~33 s of `MCP server "X": connecting/…
// connected` lines, then total silence once the TUI is idle. A genuine
// idle TUI's debug log is quiet for minutes. 1 s is comfortably longer
// than the gap between two consecutive MCP-startup log writes (verified
// against the production debug log) yet short enough to add only ~1 s
// to a clean startup. Used ONLY by `_waitForReady`, scoped to the
// startup wait — never reused mid-turn (the debug log keeps being
// written during a turn; quiescence-of-the-whole-log would wrongly
// block, but `_waitForReady` runs only at startup before any turn).
const DEFAULT_READY_DEBUG_QUIET_MS = 1000;

// R7: sentinel returned by _awaitTurnComplete when its poll loop is
// stopped by the caller's absolute-deadline abort (rather than by a
// real READY quiescence or its own internal timeout). _runTurn maps
// this to "the capture race did not win" — the absolute turnDeadlineP
// reject is what fails the turn.
const ABORT_SENTINEL = Symbol('tmux-await-turn-aborted');

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
   * @param {number} [opts.readyDebugQuietMs] — B8: `_waitForReady`
   *   requires the claude `--debug-file` log to have had no new bytes
   *   for this long (in addition to pane stability + ready hint).
   */
  constructor({
    sessionKey, chatId, threadId, label,
    runner, botName, logger = console,
    sleepFn, nowFn,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    hardBackstopMs = DEFAULT_HARD_BACKSTOP_MS,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    pollMs = DEFAULT_POLL_MS,
    quiesceMs = DEFAULT_QUIESCE_MS,
    lateGraceMs = 1500,
    queueCap = 50,   // P0.1 parity: SDK enforces queueCap=50 too
    pollScheduler = null,   // O1 optimization: shared cross-process tick
    pasteConfirmMs = 2500,  // Phase 3 §5: paste-gating JSONL-confirm timeout
    // B7: a primary paste's submit is confirmed by its correlation
    // token surfacing in a JSONL `user-message`. submitConfirmMs is the
    // per-attempt wait for that line; submitConfirmRetries extra Enter
    // presses before giving up loud.
    submitConfirmMs = 1500,
    submitConfirmRetries = 4,
    // B8: `_waitForReady` gates startup on the claude `--debug-file`
    // log going quiet (no new bytes for this long) — the signal that
    // is NOT fooled by a byte-stable-but-still-loading TUI pane.
    readyDebugQuietMs = DEFAULT_READY_DEBUG_QUIET_MS,
    // Test seam: a fake `fs` forwarded to the readiness debug-log tail
    // so a unit test can drive debug-log writes deterministically
    // without touching the real filesystem.
    fs: fsOverride = null,
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
    this.hardBackstopMs = hardBackstopMs;
    this.stopGraceMs = stopGraceMs;
    this.pollMs = pollMs;
    this.quiesceMs = quiesceMs;
    this.readyDebugQuietMs = readyDebugQuietMs;
    this._fsOverride = fsOverride;
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
    // `primaryTurnId` records the turnId of the primary turn that owns
    // this group (null for a NEW-TURN autosteer group, which has no
    // primary). R11: `_finishTurn` uses it to retire ONLY the group
    // its finishing primary owns — never a fresh NEW-TURN autosteer
    // group that started after that primary already flushed.
    this._activeGroup = {
      turns: [], text: '', pendingSteerCausesNewBubble: false,
      primaryTurnId: null,
    };
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

    // ─── B7: JSONL-token submit confirmation ──────────────────────
    // shumorobot msgs 789 / 791 / 803: a large primary prompt collapses
    // in the claude TUI into a `[Pasted text #N]` placeholder; the
    // single post-paste Enter is absorbed mid-ingest and the prompt
    // sits UNSUBMITTED — the turn never starts. B5 tried to confirm the
    // submit by capture-pane, but the TUI renders the collapsed paste
    // asynchronously, so capture-pane false-positives ("box looks
    // clear → submitted ✓") on a transient frame. The ONLY reliable
    // "the prompt reached claude" signal is the JSONL `user-message`
    // line that reproduces THIS paste's correlation token verbatim.
    // `_submitConfirms` maps token → resolve fn, fired ONLY by a
    // `user-message` (NOT by `queue-operation enqueue` — an enqueue
    // means the paste was parked in the TUI queue, not registered as a
    // turn).
    this._submitConfirms = new Map();   // token → resolve fn
    this.submitConfirmMs = submitConfirmMs;
    this.submitConfirmRetries = submitConfirmRetries;
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
   * @param {object} [ctx.chatConfig={}]          — supplies model, effort, cwd, agent, permissionMode, isolateUserConfig
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
      // `isolateUserConfig` (topic- or chat-level, topic wins — same
      // merge path as agent/cwd/permissionMode). When true, the spawned
      // claude TUI is cut off from the user-level `~/.claude` config:
      // no user-level MCP servers, plugins, or settings load. Decided
      // fix for the Music topic incident — the music-curation agent was
      // pulling in user-global MCP servers (serena ~27.5 s, peekaboo
      // ~9 s, context7) and the ~45 s MCP cold-start left the TUI
      // accepting a pasted prompt but dropping the submitted Enter, so
      // polygram's paste never submitted and the turn failed (broke the
      // Music topic 5+ times). Default OFF — every other topic is
      // unaffected unless it explicitly opts in.
      const isolateUserConfig =
        topicConfig.isolateUserConfig != null
          ? topicConfig.isolateUserConfig === true
          : chatConfig.isolateUserConfig === true;

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
      // isolateUserConfig: cut the spawned TUI off from `~/.claude`.
      //   --strict-mcp-config    — claude CLI v2.1.142: "Only use MCP
      //     servers from --mcp-config, ignoring all other MCP
      //     configurations." Passed ALONE (no --mcp-config) → zero MCP
      //     servers load. Hard guarantee that no plugin-provided OR
      //     directly-registered MCP server (serena/peekaboo/context7)
      //     starts, so there is no ~45 s cold-start window.
      //   --setting-sources project,local — load only project + local
      //     settings, NOT `user`. Drops `~/.claude/settings.json`
      //     (user-level plugins/skills/settings) while the spawn cwd's
      //     own `.claude/settings.json` still loads — so the rekordbox
      //     project's WebFetch allowlist + dontAsk mode still apply.
      // No --mcp-config needed: the music-curation plugin ships NO MCP
      // server (its .claude-plugin/plugin.json declares no `mcpServers`;
      // it is all-Bash), so --strict-mcp-config alone is clean.
      if (isolateUserConfig) {
        args.push('--strict-mcp-config');
        args.push('--setting-sources', 'project,local');
      }
      // 0.10.0 H1 — hook-based turn observability. Inject a per-spawn
      // settings file that registers command-type hooks for every
      // event we want to observe. Hooks fire INSIDE subagents and
      // are non-blocking on 2.1.142 (spike 2026-05-21 confirmed).
      // The hook command appends each event as a compacted JSON line
      // to a per-session ndjson; polygram tails it via `_armHookTail`
      // below. See docs/0.10.0-tmux-hook-observability.md.
      //
      // OBSERVER-ONLY in H1: events are persisted to the events DB
      // (`hook-event` rows) but no control flow consumes them.
      // Mirrors the patience-model Commit 1 discipline — soak proves
      // stream reliability before H2 wires the reactor.
      //
      // Survives `--setting-sources project,local` (spike confirmed
      // the `--settings <file>` layer is honored even when user-level
      // settings are excluded).
      try {
        const { settingsPath, ndjsonPath } = writeHookFiles({
          botName: this.botName,
          sessionId: this.claudeSessionId,
        });
        this._hookSettingsPath = settingsPath;
        this._hookNdjsonPath = ndjsonPath;
        args.push('--settings', settingsPath);
      } catch (err) {
        // Refuse to spawn without hooks would be too aggressive in
        // H1 (observer-only); log and continue without injection so
        // a transient FS error never blocks a real turn.
        this.logger.warn?.(
          `[${this.label}] hook-settings write failed (continuing without hooks): ${err.message}`,
        );
        this._hookSettingsPath = null;
        this._hookNdjsonPath = null;
      }
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

      // Spawn-time reconcile (shumorobot 2026-05-20 18:51 incident).
      // A tmux session with our name may already exist on the host
      // BEFORE we spawn — sources:
      //   - pm_backend flip: chat config flipped tmux → sdk → tmux;
      //     polygram dropped its in-memory handle on the flip away
      //     from tmux but the previous daemon's tmux session is still
      //     running headless. (rc.32 makes the flip context-preserving
      //     on the session-id side; this reconcile keeps the
      //     tmux-pane side safe.)
      //   - Boot-sweep raced a concurrent operator (already noted in
      //     lib/tmux/orphan-sweep.js header).
      //   - Crash mid-spawn: the spawn() call landed but the sessionCreated
      //     teardown below was bypassed (SIGKILL).
      // The orphan TUI inside is headless — its parent daemon (or any
      // previous attach) is dead, its --debug-file isn't being tailed,
      // and any JSONL it writes is unrouted. The live claude session
      // ID inside is NOT recoverable from outside without probing the
      // pane (flaky) — and we don't need to: claude's per-session JSONL
      // lives in ~/.claude/projects/.../<sid>.jsonl independent of
      // tmux, so a fresh --resume into a clean pane recovers the
      // conversation cleanly.
      //
      // Strategy: detect → kill → re-check → spawn. Always-kill is
      // safer than try-to-reuse — we have no living claim to the orphan.
      // If kill fails (server gone, races a concurrent kill), the
      // subsequent spawn will surface a clear TMUX_SPAWN_FAILED with
      // the underlying tmux error for the operator.
      if (typeof this.runner.sessionExists === 'function'
        && await this.runner.sessionExists(this.tmuxName)) {
        this.logger.warn?.(
          `[${this.label}] orphan tmux session ${this.tmuxName} present at spawn — killing`,
        );
        this.emit('spawn-reconcile', {
          tmux_name: this.tmuxName,
          phase: 'kill-orphan',
          backend: 'tmux',
        });
        try {
          await this.runner.killSession(this.tmuxName);
        } catch (killErr) {
          this.logger.warn?.(
            `[${this.label}] spawn-reconcile killSession failed (continuing): ${killErr.message}`,
          );
        }
        // Brief settle window so the tmux server releases the name
        // before we re-spawn. tmux's kill-session is synchronous in
        // the client but the server's session-name release can race
        // a tight kill→new-session pair (observed on busy hosts).
        await new Promise((r) => setTimeout(r, 50));
      }

      // R2-F8: spawn errors must fail loud, not silent-catch.
      await this.runner.spawn({
        name: this.tmuxName,
        cwd,
        command: binCheck.path,
        args,
        envExtras: ctx.envExtras || {},
      });

      // SPAWN-LIFECYCLE FIX (shumorobot 2026-05-17 22:03, topic :3):
      // `spawn()` resolving means the tmux session NAME now exists on
      // the host. From here on, ANY failure — readiness timeout, a
      // wedged capture-pane, an `init` listener throwing — must tear
      // that session down before propagating, or the orphan lingers
      // and every retry's `tmux new-session -s <same-name>` fails
      // "duplicate session". A transient first-spawn failure would
      // otherwise become a PERMANENT wedge for the chat/topic until a
      // human kills the orphan. `_sessionCreated` is the seam that
      // distinguishes "spawn() itself failed (no session — nothing to
      // kill)" from "session created, a later step failed (must
      // kill)". This is a spawn-lifecycle bug, independent of the
      // turn-ledger concurrency rewrite.
      const sessionCreated = true;

      try {
        // v9: tail the per-session JSONL file (the REAL structured-
        // event channel — v9 probe showed --debug-file emits only
        // infra noise). Path is deterministic once we have cwd +
        // sessionId. The file may not exist for ~100ms after spawn;
        // LogTail tolerates ENOENT.
        this._cwd = cwd;
        this._armSessionLogTail({ resuming: Boolean(ctx.existingSessionId) });
        // H1 — same-pattern hook tail. Only arm when the settings
        // write succeeded above (otherwise there's nothing to tail).
        if (this._hookNdjsonPath) {
          this._armHookTail();
        }

        // G6 — block until TUI is responsive.
        await this._waitForReady();
        this.emit('init', {
          session_id: this.claudeSessionId,
          label: this.label,
          backend: 'tmux',
          tmux_name: this.tmuxName,
        });
      } catch (err) {
        // Post-spawn failure — the session exists but is unusable.
        // Kill it so a retry gets a clean name. Best-effort: the
        // runner's killSession already swallows its own errors, but
        // guard anyway so a kill failure can never mask the real
        // spawn error. Also tear down the just-armed JSONL tail so it
        // doesn't leak a watcher against a dead session.
        if (sessionCreated) {
          if (this._sessionLogTail) {
            try { this._sessionLogTail.close(); } catch { /* swallow */ }
            this._sessionLogTail = null;
          }
          if (this._hookTail) {
            try { this._hookTail.close(); } catch { /* swallow */ }
            this._hookTail = null;
          }
          // Remove the per-spawn settings + ndjson so a retry gets a
          // clean pair. Best-effort (ENOENT is fine).
          if (this._hookSettingsPath || this._hookNdjsonPath) {
            try {
              removeHookFiles({ botName: this.botName, sessionId: this.claudeSessionId });
            } catch { /* swallow */ }
            this._hookSettingsPath = null;
            this._hookNdjsonPath = null;
          }
          try {
            await this.runner.killSession(this.tmuxName);
          } catch (killErr) {
            this.logger.warn?.(
              `[${this.label}] start() cleanup killSession failed: ${killErr.message}`,
            );
          }
        }
        throw err;
      }
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
    // Bug 3: interrupt signal. `interrupt()` settles `signalInterrupt`
    // to end this turn's race promptly — without it, an interrupted
    // turn whose tool was killed by C-c writes no JSONL `result` and
    // shows no capture-pane completion the race recognises, so
    // `_runTurn` would hang until the absolute `turnTimeoutMs`.
    turn.interruptP = new Promise((resolve) => { turn.signalInterrupt = resolve; });

    try {
      // rc.13.1: pasteAndEnter holds a per-session async lock around
      // paste + Enter so a concurrent injectUserMessage paste cannot
      // interleave keystrokes with this primary prompt.
      const result = await this._pasteAndEnter(
        this._embedToken(turn.prompt, turn.token));
      // Predicate (observer-only): paste returned, no JSONL signal yet.
      this._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'paste:returned');
      if (result.stripped > 0) {
        this.logger.warn?.(
          `[${this.label}] stripped ${result.stripped} control chars from prompt`,
        );
        this.emit('prompt-sanitized', { stripped: result.stripped, source: 'send' });
      }

      // B7 (shumorobot msgs 789/791/803): a PRIMARY turn pasting into
      // an idle TUI MUST start a turn. A production polygram prompt is
      // ~1-2KB → the claude TUI collapses it into a `[Pasted text #N]`
      // placeholder whose single post-paste Enter can be absorbed
      // mid-ingest, leaving the prompt UNSUBMITTED — the turn never
      // starts. `_scheduleSubmitRetries` confirms the submit landed by
      // waiting for this paste's correlation token to surface in a
      // JSONL `user-message` (the ONLY reliable signal — capture-pane
      // false-positives on the collapsed placeholder); it re-sends
      // Enter on a miss and, after bounded retries, REJECTS with
      // TMUX_SUBMIT_FAILED.
      //
      // 0.10.0 Commit 2: `_scheduleSubmitRetries` is `paste-parked`-
      // aware. If the predicate observed our paste queued by a busy
      // TUI (the C1 trace), it waits for the eventual user-message
      // instead of re-sending Enter / failing loud. See the method
      // doc.
      //
      // 0.10.0 Commit 3: the submit-confirm watchdog. On success the
      // turn proceeds; on TMUX_SUBMIT_FAILED `_awaitSettle` fails the
      // turn fast. The pre-Commit-3 `submitConfirmP`/`submitOkP`
      // never-settling-promise gymnastics are gone — `_awaitSettle`
      // reads `turn.submitConfirmed` (a predicate field) directly to
      // gate capture-pane quiescence, which is clearer and is the
      // milestone where control flow starts consuming the predicate.
      const confirmP = turn.token
        ? this._scheduleSubmitRetries(turn.token, turn)
        : Promise.resolve();             // no token — nothing to confirm

      // Commit 3: ONE settle subscription replaces the 5-way
      // `Promise.race` (+ its nested capture-then-rewait). See
      // `_awaitSettle`. The hardened behaviours are preserved as
      // *dispositions* rather than race branches:
      //   - jsonl       : terminal JSONL `result` (the happy path)
      //   - interrupt   : `/stop` (Bug 3)
      //   - submit-fail : TMUX_SUBMIT_FAILED (B7)
      //   - quiesced    : capture-pane idle, GATED on the predicate —
      //                   only fires when submitConfirmed (subsumes the
      //                   old submitOkP gate / B7) AND no tool/subagent
      //                   outstanding (subsumes B10 — capture can no
      //                   longer settle a turn mid-subagent, so the old
      //                   nested re-wait is unnecessary)
      //   - timeout     : W1 absolute deadline (one setTimeout, not a
      //                   racer)
      const outcome = await this._awaitSettle(turn, { turnTimeoutMs, confirmP });

      if (outcome.kind === 'submit-fail') throw outcome.err;
      if (outcome.kind === 'timeout') {
        throw Object.assign(
          new Error('TmuxProcess: turn did not complete in time'),
          { code: 'TMUX_TURN_TIMEOUT', tmuxName: this.tmuxName },
        );
      }

      let resolvedVia = 'jsonl';
      let text;
      let resultSubtype = 'success';
      let stopReason = null;
      if (outcome.kind === 'interrupt') {
        // Bug 3: `interrupt()` ended the turn. C-c was sent to the
        // TUI; the turn stops here instead of hanging until the
        // absolute `turnTimeoutMs`. Deliver whatever partial text the
        // agent streamed before the interrupt (may be empty) with an
        // explicit `interrupted` subtype so polygram's caller can tell
        // a stopped turn apart from a clean completion.
        turn.interrupted = true;
        text = turn.text || '';
        resultSubtype = 'interrupted';
        stopReason = 'interrupted';
      } else if (outcome.kind === 'jsonl') {
        text = turn.text || outcome.ev.text || '';
        resultSubtype = outcome.ev.subtype || 'success';
        stopReason = outcome.ev.stopReason || null;
        if (outcome.ev.sessionId) this.claudeSessionId = outcome.ev.sessionId;
        // R10: a genuinely-empty terminal `result` — end_turn, no
        // reply text, AND no tool ran this turn — is the agent
        // producing literally nothing (a thinking-only terminal
        // message). Pre-fix this resolved as { error:null, text:'' },
        // a silent empty SUCCESS, and polygram delivered the canned
        // "No response generated." apology classified as a successful
        // turn. Match the §6 fail-loud contract (capture-won/no-JSONL
        // also fails loud): surface a real error with an explicit
        // subtype. NOT triggered for a tool-only completion (a tool
        // ran → side effects the user saw → polygram's
        // numToolUses>0 branch handles it) nor for a non-success
        // terminal stop (max_tokens / stop_sequence / refusal carry
        // their own already-surfaced subtype).
        if (text.trim() === ''
          && turn.toolUses === 0
          && resultSubtype === 'success') {
          throw Object.assign(
            new Error('turn produced an empty JSONL result (end_turn, no text, no tools)'),
            { code: 'TMUX_EMPTY_JSONL_RESULT' },
          );
        }
      } else {
        // outcome.kind === 'quiesced': capture-pane went idle AND the
        // predicate confirmed it is SAFE to conclude (submitConfirmed
        // + no outstanding tool/subagent — see `_awaitSettle`). JSONL
        // is the SOLE source of reply text; capture-pane never delivers
        // text.
        //
        // B10 is structurally gone here: `_awaitSettle` cannot emit a
        // `quiesced` outcome while `outstandingSubagents` (or
        // `outstandingTools`) is non-empty, so a subagent turn can NO
        // LONGER reach this branch mid-flight — it settles via the
        // JSONL `result` (or the W1 deadline) instead. The old nested
        // re-wait + `subagent-wait` emit are therefore removed.
        this._sessionLogTail?.flushParser?.();
        if (turn.text) {
          resolvedVia = 'jsonl-streamed';
          text = turn.text;
        } else {
          // No streamed text yet — the terminal JSONL `result` may be
          // milliseconds behind the pane going idle. Wait a short grace
          // for it (interrupt still wins, Bug 3).
          const lateGraceMs = this.lateGraceMs ?? 1500;
          let late = await Promise.race([
            turn.resultPromise.then((ev) => ({ kind: 'jsonl-late', ev })),
            turn.interruptP.then(() => ({ kind: 'interrupt' })),
            new Promise((r) => setTimeout(() => r({ kind: 'no-jsonl' }), lateGraceMs)),
          ]);
          // B10 production race (shumorobot Music topic): the pane went
          // idle BEFORE the `Agent` tool_use line was tailed, so the
          // `_awaitSettle` B10 gate saw an empty outstanding set and let
          // `quiesced` through. The `Agent` line then lands DURING this
          // late grace, populating `outstandingSubagents`. The main
          // pane stays quiescent for MINUTES while the subagent runs in
          // its sidechain — that quiescence must NOT be read as "done."
          // Wait for the real terminal JSONL `result`, bounded by the
          // turn's remaining absolute budget (the `_awaitSettle` W1
          // timer was cleared when `quiesced` won, so we re-arm a
          // fresh remaining-budget timeout to the SAME wall-clock
          // ceiling). Generalised to `outstandingTools` too — a long
          // foreground tool (dl-batch) is the same shape.
          if (late.kind === 'no-jsonl'
            && (turn.outstandingSubagents.size > 0
              || turn.outstandingTools.size > 0)) {
            this.emit('subagent-wait', {
              outstanding: turn.outstandingSubagents.size,
              outstandingTools: turn.outstandingTools.size,
              turnId: turn.turnId,
            });
            const remainingMs = Math.max(
              0, (turn.startedAt + turnTimeoutMs) - this._now());
            late = await Promise.race([
              turn.resultPromise.then((ev) => ({ kind: 'jsonl-late', ev })),
              turn.interruptP.then(() => ({ kind: 'interrupt' })),
              new Promise((_resolve, reject) => {
                const t = setTimeout(() => reject(Object.assign(
                  new Error('TmuxProcess: turn did not complete in time'),
                  { code: 'TMUX_TURN_TIMEOUT', tmuxName: this.tmuxName },
                )), remainingMs);
                t.unref?.();
              }),
            ]);
          }
          if (late.kind === 'interrupt') {
            turn.interrupted = true;
            text = turn.text || '';
            resultSubtype = 'interrupted';
            stopReason = 'interrupted';
          } else if (late.kind === 'jsonl-late') {
            resolvedVia = 'jsonl-late';
            text = turn.text || late.ev.text || '';
            resultSubtype = late.ev.subtype || 'success';
            stopReason = late.ev.stopReason || null;
            if (late.ev.sessionId) this.claudeSessionId = late.ev.sessionId;
          } else {
            // §6: capture-pane judged the turn done, but JSONL produced
            // NO reply text within the grace window. FAIL LOUD — never
            // fall back to capture-pane diff text (that WAS the
            // echoed-input failure and the banner-as-reply L1 failure).
            // The error result clears the reactor explicitly instead of
            // delivering garbage.
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
      // Terminal phase. The JSONL `result` event also drives DONE via
      // `_evaluatePhaseFromSessionEvent`, but the quiesced / interrupt
      // outcomes do not; this ensures every successful exit lands the
      // turn in `done` regardless of which settle outcome won.
      this._setPhase(
        turn,
        TurnPhase.DONE,
        `runTurn:resolve:${resultSubtype}:${resolvedVia}`,
      );
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
      // Predicate (observer-only): terminal phase on the error path.
      // Includes the err.code in `reason` so phase-change observers
      // can distinguish TMUX_SUBMIT_FAILED / TMUX_NO_JSONL_TEXT /
      // TMUX_EMPTY_JSONL_RESULT / TMUX_TURN_TIMEOUT / etc.
      this._setPhase(
        turn,
        TurnPhase.FAILED,
        `runTurn:reject:${err.code || 'tmux_send_error'}`,
      );
      turn.resolve(this._errorResult(err.code || 'tmux_send_error', err.message || String(err)));
    } finally {
      this._finishTurn(turn);
    }
  }

  /**
   * 0.10.0 Commit 3: settle a turn via a single subscription instead
   * of the old 5-way `Promise.race` (+ its nested capture-then-rewait).
   *
   * Returns an `outcome` the caller maps to text/subtype/stopReason:
   *   { kind: 'jsonl', ev }      — terminal JSONL `result` arrived
   *                                (the authoritative happy path)
   *   { kind: 'interrupt' }      — `interrupt()` fired (Bug 3)
   *   { kind: 'submit-fail', err }—`_scheduleSubmitRetries` rejected
   *                                TMUX_SUBMIT_FAILED (B7)
   *   { kind: 'quiesced' }       — capture-pane idle AND the predicate
   *                                says it is SAFE to conclude
   *   { kind: 'timeout' }        — W1 absolute deadline
   *
   * The structural win over the old race:
   *   - B7 gate: capture quiescence is ignored until
   *     `turn.submitConfirmed` (a predicate field) — no more
   *     `submitOkP = confirmP.then(() => new Promise(() => {}))`.
   *   - B10 gate: capture quiescence is ignored while any tool OR
   *     subagent is outstanding (`outstandingTools` /
   *     `outstandingSubagents`) — a subagent turn can no longer reach
   *     the `quiesced` outcome mid-flight, so the old nested re-wait +
   *     `subagent-wait` emit are unnecessary. The turn settles via the
   *     JSONL `result` (or W1) instead, which is exactly B10's intent.
   *   - W1 is ONE `setTimeout`, not a racer.
   *
   * Capture-pane is still polled (heartbeat + approval-prompt
   * detection live in `_awaitTurnComplete`); `signalAbort` releases
   * the poll loop + PollScheduler refcount the instant the turn
   * settles, exactly as the old `finally { signalAbort() }` did.
   */
  _awaitSettle(turn, { turnTimeoutMs, confirmP }) {
    let signalAbort = null;
    const abortP = new Promise((resolve) => { signalAbort = resolve; });
    return new Promise((resolve) => {
      let done = false;
      let idlePoller = null;
      let hardBackstopTimer = null;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        if (idlePoller) clearInterval(idlePoller);
        if (hardBackstopTimer) clearTimeout(hardBackstopTimer);
        // Release the capture-pane poll loop (and, with a shared
        // PollScheduler, its refcount) even when a non-capture outcome
        // won — mirrors the old `finally { signalAbort() }`.
        signalAbort();
        resolve(outcome);
      };

      // 1. Terminal JSONL `result` — settled by `_flushActiveGroup`
      //    via `turn.settleResult`. The happy path.
      turn.resultPromise.then((ev) => finish({ kind: 'jsonl', ev }));

      // 2. Interrupt (`/stop` → C-c). Bug 3.
      turn.interruptP.then(() => finish({ kind: 'interrupt' }));

      // 3. Submit-confirm. On success the turn proceeds (no settle);
      //    on TMUX_SUBMIT_FAILED fail the turn fast (B7).
      confirmP.then(
        () => { /* submitted ok — turn proceeds */ },
        (err) => finish({ kind: 'submit-fail', err }),
      );

      // 4. Capture-pane quiescence, GATED by the predicate.
      (async () => {
        let buf;
        try {
          buf = await this._awaitTurnComplete({ timeoutMs: turnTimeoutMs, abortP });
        } catch {
          return;   // capture's own timeout — the idle poller (#5a) settles
        }
        if (buf === ABORT_SENTINEL) return;   // released by another outcome
        // B7 gate: a paste that never submitted leaves the pane idle
        // because the prompt still sits in the input box — not because
        // a turn finished. Ignore capture until the submit is
        // confirmed. (A token-less turn — no confirm to wait on — is
        // exempt: submitConfirmed stays false but there's nothing to
        // gate.)
        if (turn.token && !turn.submitConfirmed) return;
        // B10 gate: a tool or subagent is in flight — the main pane is
        // quiescent because the agent is WORKING, not done. Ignore
        // capture; settle via JSONL `result` (or the idle/backstop
        // racers below) when the work returns.
        if (turn.outstandingTools.size > 0
          || turn.outstandingSubagents.size > 0) return;
        finish({ kind: 'quiesced' });
      })();

      // 5a. Idle-ceiling poller (H3, rc.40). The old W1 was an
      //     ABSOLUTE setTimeout — it killed any turn that ran longer
      //     than turnTimeoutMs, regardless of whether the turn was
      //     making progress (msg 884: 49-min SoundCloud subagent
      //     killed at 30 min while demonstrably alive). H3 inverts:
      //     `turnTimeoutMs` is now the IDLE ceiling. A turn is
      //     wedged only if NO activity (JSONL events, capture-pane
      //     stream signals, OR hook events — see _handleHookEvent)
      //     for `turnTimeoutMs`. Every active signal heartbeats
      //     `turn.lastActivityAt`, resetting the clock implicitly.
      //
      //     Poll cadence (30 s) is the worst-case detection delay
      //     past the configured ceiling. Cheap.
      //
      //     Poll cadence is ADAPTIVE: 30 s in production (where
      //     `turnTimeoutMs` is minutes), but capped at
      //     ~`turnTimeoutMs / 4` with a 50 ms floor so test configs
      //     with small `turnTimeoutMs` (e.g. R7's 60 ms wedge test)
      //     still detect idle inside the test's own assertion budget.
      const pollIntervalMs = Math.max(
        50,
        Math.min(IDLE_POLL_INTERVAL_MS, Math.floor(turnTimeoutMs / 4)),
      );
      idlePoller = setInterval(() => {
        const idleMs = this._now() - turn.lastActivityAt;
        if (idleMs >= turnTimeoutMs) {
          finish({ kind: 'timeout', reason: 'idle-ceiling', idleMs });
        }
      }, pollIntervalMs);
      idlePoller.unref?.();

      // 5b. Hard backstop (H3, rc.40). Absolute deadline against a
      //     pathological infinite tool loop that DOES fire hooks
      //     continuously and so never trips the idle ceiling. Default
      //     4h is far beyond any legitimate single-turn runtime,
      //     even a multi-hour rate-limited SoundCloud crawl. Counted
      //     from turn start.
      const backstopRemaining = Math.max(
        0, (turn.startedAt + this.hardBackstopMs) - this._now());
      hardBackstopTimer = setTimeout(
        () => finish({ kind: 'timeout', reason: 'hard-backstop' }),
        backstopRemaining,
      );
      hardBackstopTimer.unref?.();
    });
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
    // Commit 2: clear any lingering submit-confirm waiter for this
    // turn's token. The parked branch of `_scheduleSubmitRetries`
    // races the turn's own settle promises so it normally self-cleans,
    // but a turn that ends via the hard W1 deadline (turnDeadlineP
    // rejects in `_runTurn`, never resolving `resultPromise`) would
    // otherwise leave a dangling Map entry. Defensive + cheap.
    if (turn?.token) this._submitConfirms.delete(turn.token);
    const qi = this.pendingQueue.indexOf(turn);
    if (qi >= 0) this.pendingQueue.splice(qi, 1);
    this._dropFromActiveGroup(turn);
    // R1: if this primary turn ended WITHOUT its active group being
    // flushed by a terminal `result` (it timed out or errored), the
    // autosteer turns folded into that group would otherwise strand
    // as `streaming` forever — leaking in the ledger AND keeping
    // `_activeGroup` non-empty, which silently swallows the next
    // autonomous assistant message. Retire the leftovers + reset the
    // group.
    //
    // R11: retire the group ONLY when it is the group THIS finishing
    // primary owns (`primaryTurnId === turn.turnId`). The old code
    // retired whatever was in `_activeGroup` unconditionally — but in
    // the window between the primary's `result` (which
    // `_flushActiveGroup` used to reset the group) and `_runTurn`
    // reaching `_finishTurn`, a NEW-TURN autosteer's dequeued
    // `user-message` can route a FRESH group into place. That group
    // belongs to the autosteer, not this primary; retiring it marked
    // the autosteer `failed` and its chunks then leaked as an
    // `autonomous-assistant-message` instead of an `extra-turn-reply`.
    // A NEW-TURN autosteer group has `primaryTurnId: null`, so the
    // guard leaves it untouched. (On a successful primary turn
    // `_flushActiveGroup` already reset the group, so `turns` is empty
    // and this is a no-op either way.)
    if (this._activeGroup.turns.length > 0
      && this._activeGroup.primaryTurnId === turn.turnId) {
      for (const t of this._activeGroup.turns) {
        if (t.state !== 'done' && t.state !== 'failed') t.state = 'failed';
      }
      this._activeGroup = {
        turns: [], text: '', pendingSteerCausesNewBubble: false,
        primaryTurnId: null,
      };
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
    const now = this._now();
    return {
      turnId: this._turnSeq,
      token: this._mintToken(),
      msgIds: [...msgIds],
      kind,                      // 'primary' | 'autosteer'
      state: 'queued',           // queued | pasted | streaming | done | failed
      text: '',
      toolUses: 0,
      toolUsedThisTurn: false,
      // B10: outstanding `Agent` (subagent/Task) tool_use ids — a
      // tool_use with no matching tool_result yet. A non-empty set
      // means a subagent is running in its own sidechain context: the
      // main pane goes quiescent for MINUTES while it works, and that
      // quiescence must NOT be read as turn completion. Cleared when
      // the matching `tool-result` arrives.
      outstandingSubagents: new Set(),
      stopReason: null,
      resultEvent: null,
      via: null,                 // autosteer: 'fold' | 'new-turn'
      context, opts, prompt,
      startedAt: 0,
      resolve: null, reject: null, callerPromise: null,
      settleResult: null, resultPromise: null,
      // Bug 3: settled by `interrupt()` to make a live turn's
      // `_runTurn` race end promptly instead of hanging until
      // `turnTimeoutMs`. Armed at the top of `_runTurn`.
      signalInterrupt: null, interruptP: null, interrupted: false,
      // 0.10.0 predicate (Commit 1, observer-only): unified turn
      // phase. See lib/process/turn-phase.js. Mutated only via
      // `_setPhase`; consumed by no existing control flow in this
      // commit. Subsequent commits replace the patience timers that
      // currently race on a turn's behalf (`_runTurn`'s 5-way race,
      // §6 fail-loud, B10 outstanding-Agent suppression).
      phase: TurnPhase.QUEUED,
      phaseSince: now,
      lastActivityAt: now,
      submitConfirmed: false,
      parked: false,
      // Generalisation of `outstandingSubagents` — every non-Agent
      // tool_use's id while it is in flight. Today only Agent is
      // tracked (B10); the predicate uses both sets to keep `quiet`
      // unreachable while any tool is genuinely outstanding.
      outstandingTools: new Set(),
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

  // ─── 0.10.0 turn-phase predicate (Commit 1: observer-only) ────────
  //
  // The five-agent investigation (docs/0.10.0-tmux-patience-model-
  // solution.md) found 14+ uncoordinated patience timers, several
  // mutually inconsistent under the music-curation workload. The fix
  // is one state machine fed by all signals continuously; timers only
  // demote phases on silence, never advance them.
  //
  // This commit lands the predicate as an OBSERVER. Every signal that
  // reaches `_handleSessionEvent`, the capture-pane poll, and the
  // debug-log poll feeds `_setPhase` / `_heartbeat`. `phase-change`
  // events fire for observability. **No existing control flow reads
  // `turn.phase` yet** — `_runTurn`'s 5-way race, §6 fail-loud, B10
  // outstanding-Agent suppression, and `_sweepStaleTurns` remain
  // exactly as they are. Commits 2-3 replace them one at a time.

  /**
   * Transition `turn` to `next` phase if and only if it is different
   * from the current phase. Emits a `phase-change` event for
   * observability. Soft-asserts the transition is legal — logs at
   * warn level and proceeds (observer-only must never block).
   *
   * @param {object} turn      - the turn whose phase changes
   * @param {string} next      - the next TurnPhase value
   * @param {string} reason    - short tag for the trigger (e.g. 'jsonl:user-message')
   * @returns {boolean}         true iff phase actually changed
   */
  _setPhase(turn, next, reason) {
    if (!turn) return false;
    const prev = turn.phase;
    if (prev === next) return false;
    if (!isLegalTransition(prev, next)) {
      // Observer-only: log and proceed. A real illegal transition is
      // either a bug in the wiring or a signal pattern the design
      // didn't anticipate — both worth surfacing without breaking the
      // turn. Tests assert the legal graph; production prefers honesty
      // over rigidity.
      this.logger.warn?.(
        `[${this.label}] phase illegal transition: ${prev} → ${next}`
        + ` (turn ${turn.turnId}, reason ${reason})`,
      );
    }
    const now = this._now();
    turn.phase = next;
    turn.phaseSince = now;
    turn.lastActivityAt = now;
    this.emit('phase-change', {
      turnId: turn.turnId,
      msgId: turn.msgIds[0] ?? null,
      kind: turn.kind,
      prev,
      next,
      reason,
      ts: now,
      sessionId: this.claudeSessionId,
      backend: 'tmux',
    });
    return true;
  }

  /**
   * Mark a turn as having received a liveness signal at this instant.
   * Bumps `lastActivityAt`; does NOT change phase by itself. The
   * demote-on-silence path (future commit) compares `lastActivityAt`
   * to `quietToleranceMs` to decide when to demote to `quiet`.
   *
   * Sources that should call this on every event:
   *   - assistant-chunk / tool-use / tool-result / usage (JSONL)
   *   - capture-pane sees `esc to interrupt`
   *   - debug-log size grew
   *
   * Phase-advancing signals call `_setPhase` instead (which also
   * bumps `lastActivityAt` internally).
   */
  _heartbeat(turn, source) {
    if (!turn) return;
    turn.lastActivityAt = this._now();
    // No event emission — heartbeats are high-frequency; the
    // phase-change event is the consumer-visible surface. Source tag
    // is reserved for future debug telemetry.
    void source;
  }

  /**
   * Drive the predicate for an active group from a JSONL session
   * event. Pure routing — each event maps to a phase transition (or
   * a heartbeat for in-phase signals).
   *
   * Called from `_handleSessionEvent` AFTER the existing branches do
   * their work, so today's behaviour is untouched.
   *
   * @param {object} ev - the parsed session-log event
   * @param {Array<object>} turns - the active group turns (may be empty)
   */
  _evaluatePhaseFromSessionEvent(ev, turns) {
    if (!Array.isArray(turns) || turns.length === 0) return;
    for (const t of turns) {
      // Don't move terminal phases — `done`/`failed` are absorbing.
      if (t.phase === TurnPhase.DONE || t.phase === TurnPhase.FAILED) continue;

      if (ev.type === 'user-message') {
        // Submit landed. Set both the flag and the phase.
        if (!t.submitConfirmed) t.submitConfirmed = true;
        this._setPhase(t, TurnPhase.SUBMITTED, 'jsonl:user-message');
      } else if (ev.type === 'assistant-chunk') {
        this._setPhase(t, TurnPhase.STREAMING, 'jsonl:assistant-chunk');
      } else if (ev.type === 'tool-use') {
        if (typeof ev.id === 'string' && ev.name !== 'Agent') {
          t.outstandingTools.add(ev.id);
        }
        // Phase choice: subagent > tool > streaming. A Bash tool-use
        // arriving while an Agent is outstanding must NOT demote
        // SUBAGENT_RUNNING — both are "in flight," but the predicate's
        // public contract is "the most-restrictive active phase wins."
        // Agent absence + outstanding Agent set is impossible (the
        // existing branch added before us), so we read both sets.
        if (t.outstandingSubagents.size > 0) {
          this._setPhase(t, TurnPhase.SUBAGENT_RUNNING, `jsonl:tool-use:${ev.name || 'unknown'}`);
        } else if (t.outstandingTools.size > 0) {
          this._setPhase(t, TurnPhase.TOOL_RUNNING, `jsonl:tool-use:${ev.name || 'unknown'}`);
        } else {
          // No id (rare — older event shapes) — heartbeat only.
          this._heartbeat(t, 'jsonl:tool-use:no-id');
        }
      } else if (ev.type === 'tool-result') {
        if (typeof ev.toolUseId === 'string') {
          t.outstandingTools.delete(ev.toolUseId);
        }
        // Phase choice: prefer the most-active outstanding state.
        // Subagent > tool > streaming.
        if (t.outstandingSubagents.size > 0) {
          // Still waiting on a subagent; phase stays.
          this._heartbeat(t, 'jsonl:tool-result:subagent-still-out');
        } else if (t.outstandingTools.size > 0) {
          this._setPhase(t, TurnPhase.TOOL_RUNNING, 'jsonl:tool-result:tool-still-out');
        } else {
          this._setPhase(t, TurnPhase.STREAMING, 'jsonl:tool-result:drained');
        }
      } else if (ev.type === 'usage') {
        this._heartbeat(t, 'jsonl:usage');
      } else if (ev.type === 'result') {
        if (ev.subtype === 'tool_use') {
          // Non-terminal — agent paused for a tool. The matching
          // tool-use line will have moved the phase already.
          this._heartbeat(t, 'jsonl:result:tool_use-nonterm');
        } else {
          // Terminal stop_reason — turn ended.
          this._setPhase(t, TurnPhase.DONE, `jsonl:result:${ev.subtype || 'success'}`);
        }
      } else if (ev.type === 'queue-operation') {
        if (ev.operation === 'enqueue' && ev.content) {
          const tokens = this._extractTokens(ev.content);
          if (tokens.includes(t.token)) {
            // Our paste landed in the TUI queue (proof of arrival AND
            // proof of parking). The W11/W25 C1 resolution: the
            // future B7 successor will read `turn.parked === true`
            // and stop re-sending Enter.
            t.parked = true;
            this._setPhase(t, TurnPhase.PASTE_PARKED, 'jsonl:queue-operation:enqueue');
          }
        }
        // remove/dequeue do not change phase by themselves — the
        // follow-up user-message moves the turn to `submitted` if it
        // is the head being released.
      }
      // Other event types (last-prompt, queue-folded) — observer-only
      // no-ops in this commit.
    }
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

  /**
   * H1 hook tail — open a typed-event tail on the per-session ndjson
   * that `polygram-hook-append.js` appends to, and forward normalized
   * HookEvent objects to `_handleHookEvent`.
   *
   * Mirrors `_armSessionLogTail`: same LogTail watch/poll-fallback
   * pattern, idempotent, swallows ENOENT (the file is touched at spawn
   * time but a tail-before-write race is still possible). OBSERVER-
   * ONLY — `_handleHookEvent` only persists events; no control flow
   * consumes them in H1.
   *
   * See docs/0.10.0-tmux-hook-observability.md.
   */
  _armHookTail() {
    if (this._hookTail) return; // idempotent
    if (!this._hookNdjsonPath) {
      this.logger.warn?.(`[${this.label}] _armHookTail: no ndjson path, skipping`);
      return;
    }
    const tail = createHookTail({ path: this._hookNdjsonPath, logger: this.logger });
    tail.on('event', (ev) => this._handleHookEvent(ev));
    tail.on('error', (err) => {
      this.logger.warn?.(`[${this.label}] hook-tail error: ${err.message}`);
    });
    tail.start();
    this._hookTail = tail;
  }

  /**
   * Hook-event handler. Four roles, layered over time:
   *
   *   H1 (rc.36) — emit `hook-event` so polygram persists each event
   *     to the events DB; observer-only.
   *   H2 (rc.38) — sdk/callbacks.js extends onHookEvent to route to
   *     the reactor (PreToolUse → setState, PostToolUse / SubagentStop
   *     / Notification → heartbeat). Kills the fear escalation.
   *   H3 (rc.40) — hook events count as PREDICATE-side liveness too:
   *     every hook event heartbeats the active group's turns so the
   *     idle-ceiling poller in `_awaitSettle` doesn't fire on a long
   *     healthy subagent that is communicating via hooks. THIS is
   *     the structural fix for the msg-884 incident (49-min
   *     SoundCloud subagent killed at the 30-min wall-clock while
   *     demonstrably alive).
   *   H4 (rc.41) — `Stop` hook is an authoritative turn-done signal.
   *     If JSONL `result` doesn't fire within `stopGraceMs`,
   *     synthesize a settle from the Stop payload so a broken or
   *     stuck JSONL stream can't strand a finished turn. Promise-
   *     resolve idempotency means JSONL still wins when both fire.
   *
   * Parse errors and unknown event shapes are intentionally still
   * forwarded — observer-only metrics for stream-reliability soak.
   */
  _handleHookEvent(ev) {
    // H3: every hook event (except the diagnostic types) is liveness
    // evidence. Heartbeat every turn we can identify as in-flight so
    // the idle-ceiling poller resets. We don't differentiate by event
    // type — even Notification or UserPromptSubmit prove claude is
    // active in this session.
    //
    // Two scopes are searched (deduped via Set): active group turns
    // (the steady state once `user-message` has landed) AND the
    // pendingQueue head (the PRE-active window between turn start
    // and the first `user-message`). Hook events can fire in either
    // window — e.g. `UserPromptSubmit` arrives just after claude
    // receives the paste but BEFORE the `user-message` is echoed
    // back into the JSONL. Without the pendingQueue fallback, that
    // window leaves the turn un-heartbeated and the idle poller
    // could fire on a turn that's actively starting up.
    if (ev?.type && ev.type !== 'parse-error' && ev.type !== 'unknown') {
      const turns = new Set(this._activeGroup?.turns || []);
      const head = this.pendingQueue[0];
      if (head) turns.add(head);
      for (const t of turns) {
        this._heartbeat(t, `hook:${ev.type}`);
      }
    }
    // H4: Stop hook → synthesize a settle for the primary turn after
    // a grace, so JSONL `result` (which carries richer metadata)
    // wins when both fire. If JSONL never arrives — broken stream,
    // stuck parser — the Stop synth settles the turn instead of
    // stranding it. Idempotent: a later JSONL settleResult call is
    // a no-op once the promise has resolved.
    if (ev?.type === 'Stop') {
      const primary = (this._activeGroup?.turns || [])
        .find((t) => t.kind === 'primary');
      if (primary && typeof primary.settleResult === 'function') {
        const synth = {
          text: primary.text || ev.lastAssistantMessage || '',
          subtype: 'success',
          stopReason: 'stop_hook',
          sessionId: this.claudeSessionId,
          via: 'stop-hook',
        };
        const timer = setTimeout(
          () => primary.settleResult(synth),
          this.stopGraceMs,
        );
        timer.unref?.();
      }
    }
    this.emit('hook-event', ev);
  }

  _handleSessionEvent(ev) {
    // Predicate (observer-only): snapshot the active group's turns
    // BEFORE the existing branches run. The `result` and `last-prompt`
    // branches flush the group (clearing `_activeGroup.turns`) — if
    // the predicate evaluates against `this._activeGroup.turns` at the
    // bottom of this method, it sees an empty array for those events.
    // The snapshot is by-reference (same turn objects), so any
    // mutations the existing branches make (e.g. outstandingSubagents
    // updates) ARE visible to the predicate.
    const activeTurnsSnapshot = (this._activeGroup?.turns || []).slice();

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
        // B10: an `Agent` (subagent/Task) tool_use spawns a subagent
        // that runs for MINUTES in its own sidechain context while the
        // main pane sits quiescent. Track its id as outstanding until
        // the matching `tool-result` returns — `_runTurn` treats an
        // outstanding subagent as "turn still in flight" so the main
        // pane's quiescence cannot trip the §6 fail-loud.
        if (ev.name === 'Agent' && typeof ev.id === 'string') {
          t.outstandingSubagents.add(ev.id);
        }
      }
      this.emit('tool-use', ev.name);
    } else if (ev.type === 'tool-result') {
      // B10: a subagent returned. Clear the outstanding `Agent` call
      // it answers across every turn in the active group. A
      // tool-result for a non-Agent tool (or an id we never tracked)
      // is a harmless no-op — the set only ever held `Agent` ids.
      for (const t of this._activeGroup.turns) {
        t.outstandingSubagents.delete(ev.toolUseId);
      }
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

    // 0.10.0 predicate (Commit 1, observer-only): every event also
    // drives the phase machine. Runs LAST so today's existing
    // branches above have already executed and the predicate sees
    // post-mutation state (e.g. `outstandingSubagents` already
    // updated for `tool-use`/`tool-result`). Emits `phase-change`
    // events only — no consumer reads `turn.phase` in this commit.
    //
    // `queue-operation enqueue` and `user-message` may route to
    // turns OUTSIDE the active group (an autosteer in the ledger
    // that has not yet folded). For those we evaluate the ledger
    // turn directly.
    try {
      this._evaluatePhaseFromSessionEvent(ev, activeTurnsSnapshot);
      if (ev.type === 'queue-operation'
        && ev.operation === 'enqueue'
        && ev.content) {
        const tokens = this._extractTokens(ev.content);
        const extra = [];
        for (const tok of tokens) {
          const t = this._ledger.find(
            (x) => x.token === tok
              && x.state !== 'done' && x.state !== 'failed'
              && !activeTurnsSnapshot.includes(x),
          );
          if (t) extra.push(t);
        }
        if (extra.length > 0) {
          this._evaluatePhaseFromSessionEvent(ev, extra);
        }
      }
      if (ev.type === 'user-message') {
        const tokens = this._extractTokens(ev.text);
        const extra = [];
        for (const tok of tokens) {
          const t = this._ledger.find(
            (x) => x.token === tok
              && x.state !== 'done' && x.state !== 'failed'
              && !activeTurnsSnapshot.includes(x),
          );
          if (t) extra.push(t);
        }
        if (extra.length > 0) {
          this._evaluatePhaseFromSessionEvent(ev, extra);
        }
      }
    } catch (err) {
      // Observer-only: a bug in the predicate must not break the
      // existing turn flow. Log and swallow.
      this.logger.warn?.(
        `[${this.label}] predicate error: ${err.message || err}`,
      );
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
    // B7: a user-message is the proof that a primary paste actually
    // STARTED a turn (claude registered the prompt). Release any
    // _scheduleSubmitRetries waiter for these tokens.
    this._confirmSubmit(tokens);
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
        if (orphan) {
          matched = [orphan];
          // B7: a token-less user-message claimed by the orphan
          // fallback still PROVES that primary's prompt started — so
          // release its submit-confirm waiter under the orphan's own
          // token (the `_confirmSubmit(tokens)` above could not, the
          // user-message carried no token to match).
          this._confirmSubmit([orphan.token]);
        }
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
      // R11: a primary turn joining the group makes it that primary's
      // group — record the owner so `_finishTurn` retires only the
      // group its finishing primary owns. A NEW-TURN autosteer never
      // sets this, so its fresh group keeps `primaryTurnId: null` and
      // survives an unrelated primary's `_finishTurn`.
      if (t.kind === 'primary') group.primaryTurnId = t.turnId;
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
    this._activeGroup = {
      turns: [], text: '', pendingSteerCausesNewBubble: false,
      primaryTurnId: null,
    };
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
   *
   * B7 (shumorobot msgs 789/791/803): `_pasteAndEnter` does NOT itself
   * confirm the paste SUBMITTED. A large prompt collapses in the claude
   * TUI into a `[Pasted text #N]` placeholder whose single post-paste
   * Enter can be absorbed mid-ingest, leaving the prompt unsubmitted —
   * but that submit-confirmation runs as a concurrent racer in
   * `_runTurn` (`_scheduleSubmitRetries`), NOT here. Blocking
   * `_pasteAndEnter` on the confirm would hold `_pasteLock` across the
   * whole confirm window and stall every following paste — an autosteer
   * that should fold into the primary turn could never paste.
   */
  async _pasteAndEnter(text) {
    const token = this._extractTokens(text)[0] || null;
    const release = await this._pasteLock.acquire(this.tmuxName);
    let result;
    try {
      // B7: the runner no longer does capture-pane submit-confirmation
      // (it false-positived on `[Pasted text #N]`). The runner just
      // pastes + Enter. Submit confirmation for a PRIMARY turn is
      // JSONL-token-based and runs as a CONCURRENT racer in `_runTurn`
      // (`_scheduleSubmitRetries`) — NOT here. Blocking `_pasteAndEnter`
      // on the confirm would hold `_pasteLock` across the whole confirm
      // window and stall every following paste (an autosteer that
      // SHOULD fold into the primary turn could never paste). The
      // confirm is a watchdog, not a paste-pipeline gate.
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
   * Confirm a primary paste actually submitted by waiting for its
   * correlation `token` to surface in a JSONL `user-message`. On each
   * miss, re-send Enter (the prior Enter was absorbed by the TUI's
   * bracketed-paste ingest of a `[Pasted text #N]` block). After
   * `submitConfirmRetries` exhausted misses, throw `TMUX_SUBMIT_FAILED`.
   *
   * 0.10.0 Commit 2 — `paste-parked`-aware (the C1 fix). The B7
   * predecessor (`_confirmSubmitViaJsonl`) re-sent Enter on every miss
   * and failed loud after 5, with NO way to tell "the Enter was
   * absorbed, the prompt is stuck" (genuine submit failure) apart from
   * "the TUI was busy and legitimately PARKED the paste in its queue"
   * (a paste that WILL submit when the prior turn finishes). The
   * 2026-05-20 C1 trace was the latter failing loud: a paste the TUI
   * queued got 5 spurious Enter re-sends then `TMUX_SUBMIT_FAILED`.
   *
   * The turn-phase predicate now distinguishes them: a
   * `queue-operation enqueue` carrying THIS turn's `corr-id` (or the
   * `Press up to edit queued messages` capture-pane fallback) sets
   * `turn.parked = true`. Once parked:
   *   - STOP re-sending Enter — the paste is in the TUI queue; another
   *     Enter could submit a DIFFERENT queued item or double-submit.
   *   - Do NOT fail loud — the turn is legitimately in flight.
   *   - Wait (unbounded here) for the eventual `user-message`. The
   *     `_runTurn` turn deadline (W1) is the only floor; a paste that
   *     is truly never released fails as `TMUX_TURN_TIMEOUT` (correct
   *     attribution — the wedged thing is the prior turn, not our
   *     submission), not `TMUX_SUBMIT_FAILED`.
   *
   * Runs as a concurrent racer in `_runTurn` (NOT a blocking gate in
   * `_pasteAndEnter` — that would hold `_pasteLock` across the confirm
   * window and stall a folding autosteer's paste). `turn` is the owning
   * Turn: if it reaches a terminal state (the real result/capture
   * racer already won, or the turn was killed) the retry loop bails so
   * a stray retry Enter cannot land in an unrelated turn.
   */
  async _scheduleSubmitRetries(token, turn = null) {
    for (let attempt = 0; attempt <= this.submitConfirmRetries; attempt += 1) {
      // C1: parked → the paste is safely queued in the TUI. Wait for
      // the eventual user-message; never re-send Enter, never fail
      // loud. Checked at the TOP so a paste parked before the first
      // confirm-wait skips the wait entirely.
      if (turn && turn.parked) {
        this.emit('submit-parked', {
          token,
          turnId: turn.turnId,
          attempt,
          sessionId: this.claudeSessionId,
          backend: 'tmux',
        });
        await this._awaitSubmitOrTerminal(token, turn);
        return;
      }
      const confirmed = await this._awaitSubmitConfirm(token);
      if (confirmed) return;                            // submitted ✓
      // The turn already settled some other way (result/capture/kill)
      // — the submit clearly is no longer the open question. Stop:
      // re-sending Enter or throwing now would be wrong.
      if (turn && (turn.state === 'done' || turn.state === 'failed')) return;
      // The enqueue may have landed DURING the submitConfirmMs wait —
      // re-check before deciding to re-send Enter. The loop top then
      // handles the parked branch.
      if (turn && turn.parked) continue;
      if (attempt === this.submitConfirmRetries) break; // out of retries
      // The tokened user-message never arrived AND the paste was not
      // parked — the prompt is still sitting in the input box as
      // `[Pasted text #N]`. Re-send Enter.
      this.logger.debug?.(
        `[${this.label}] paste not submitted (no user-message for ${token}), `
        + `re-sending Enter (attempt ${attempt + 1})`,
      );
      try {
        await this.runner.sendControl(this.tmuxName, 'Enter');
      } catch (err) {
        // A dead session — the turn will fail loud via another racer.
        this.logger.debug?.(`[${this.label}] retry Enter failed: ${err.message}`);
        return;
      }
    }
    throw Object.assign(
      new Error(
        `TmuxProcess: prompt never submitted — no JSONL user-message for `
        + `${token} after ${this.submitConfirmRetries + 1} Enter attempts`,
      ),
      { code: 'TMUX_SUBMIT_FAILED', tmuxName: this.tmuxName, token },
    );
  }

  /**
   * Parked-branch wait (Commit 2): resolve when `token` surfaces in a
   * JSONL `user-message` (submit landed), or when the owning turn goes
   * terminal another way (result flushed / interrupted / killed). NO
   * timeout — the caller's `_runTurn` turn deadline (W1) is the floor.
   *
   * Racing the turn's own settle promises prevents a leaked
   * `_submitConfirms` entry on a turn that ends without ever
   * producing our user-message (e.g. the prior turn wedges and W1
   * fires).
   */
  _awaitSubmitOrTerminal(token, turn) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._submitConfirms.delete(token);
        resolve();
      };
      this._submitConfirms.set(token, finish);   // user-message → finish
      // Bail if the turn settles via result / interrupt before the
      // user-message lands.
      turn?.resultPromise?.then(finish, finish);
      turn?.interruptP?.then(finish, finish);
    });
  }

  /**
   * Resolve `true` once `token` surfaces in a JSONL `user-message`
   * (via `_confirmSubmit`), or `false` after `submitConfirmMs`.
   * Distinct from `_awaitPasteConfirm`: that releases the next-paste
   * barrier on user-message OR queue-operation; this confirms a turn
   * actually STARTED, so it accepts the `user-message` signal only.
   */
  _awaitSubmitConfirm(token) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this._submitConfirms.delete(token);
        resolve(ok);
      };
      this._submitConfirms.set(token, () => finish(true));
      timer = setTimeout(() => finish(false), this.submitConfirmMs);
      timer.unref?.();
    });
  }

  /** B7: mark tokens as submit-confirmed — fired from a JSONL
   *  `user-message` (NOT queue-operation). */
  _confirmSubmit(tokens) {
    for (const t of tokens) {
      const finish = this._submitConfirms.get(t);
      if (finish) finish();
    }
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

  /**
   * Synchronously probe the byte-size of the claude `--debug-file` log.
   * Returns the size in bytes, or `null` if the log does not exist yet
   * (claude takes ~100 ms to create it after spawn) or cannot be
   * stat'd. Never throws — a readiness gate must not hard-fail on a
   * missing debug-log signal.
   *
   * B8: this is the size-delta channel `_waitForReady` uses to detect
   * debug-log quiescence — the signal a byte-stable-but-still-loading
   * TUI pane cannot fool. During MCP cold-start claude DENSELY appends
   * to this log (`MCP server "X": connecting…` / `…connected in
   * NNNNms`); once the TUI is genuinely idle the log goes silent. This
   * mirrors `LogTail`'s approach (stat-based size-delta detection,
   * ENOENT-tolerant) without arming a second async tailer: the
   * readiness loop already polls on a timer, so a synchronous
   * `statSync` per poll is the simplest, fully-deterministic fit and
   * needs no fs.watch.
   *
   * `this._fsOverride` is a test seam — a fake `fs` lets a unit test
   * drive debug-log growth by hand.
   */
  _probeDebugLogSize() {
    const fsImpl = this._fsOverride || require('fs');
    try {
      return fsImpl.statSync(this.debugLogPath).size;
    } catch {
      return null;   // ENOENT (not created yet) / any stat error
    }
  }

  async _waitForReady() {
    const deadline = this._now() + this.readyTimeoutMs;
    let lastBuf = '';
    // B6 (shumorobot 2026-05-18, Music topic, twice): a slow
    // custom-agent spawn (`music-curation:music-curator` loading
    // several MCP servers) leaves the claude TUI mid-startup for
    // SECONDS. Throughout that window the TUI ALREADY renders its
    // ready hint (`? for shortcuts` / `bypass permissions on`) at the
    // bottom of its startup banner. The old `_waitForReady` returned
    // the INSTANT `READY_HINTS_RE` matched — on the first poll, while
    // MCP servers were still loading — so the first `send()` pasted
    // into a not-yet-ready TUI and the submitted Enter was dropped.
    //
    // B6's fix gated on pane QUIESCENCE: ready ⇔ the hint is present
    // AND the `capture-pane` is byte-stable across consecutive polls.
    //
    // B8 (slow-MCP-startup, 2026-05-19): pane quiescence is NOT
    // enough. The production debug log for the Music topic shows MCP
    // cold-start spanning ~33 s (`plugin:serena:serena` 27.5 s,
    // peekaboo 9.3 s, …) — yet across that whole window the claude
    // pane is BYTE-STABLE: the REPL mounts and paints its ready hint
    // immediately, then MCP servers load entirely off-screen with the
    // pane unchanged. B6 reads "stable = ready", `start()` resolves
    // mid-MCP-load, the paste lands in a TUI that is not yet
    // interactive, and the Enter is dropped (the Music-topic break,
    // 5+ times). `isolateUserConfig` (rc.26) removes MCP servers for
    // the Music topic specifically, but the gate is still wrong for
    // any non-isolated topic that legitimately loads MCP servers.
    //
    // The pane is fooled; the claude `--debug-file` log is NOT. During
    // MCP startup that log is ACTIVELY written; a genuinely-ready idle
    // TUI's debug log is quiet (verified against the production log —
    // dense writes for ~33 s, then silence for over an hour). So
    // `_waitForReady` now ALSO gates on debug-log quiescence:
    //   ready ⇔ (ready hint present)
    //        AND (pane byte-stable across consecutive polls)
    //        AND (the --debug-file log has had no new bytes for
    //             `readyDebugQuietMs`).
    // During MCP load the debug log is active → not ready. After load
    // → quiet → ready. Still bounded by `readyTimeoutMs`, so a
    // genuinely wedged spawn still throws TMUX_READY_TIMEOUT.
    //
    // Scope: the debug log keeps being written DURING normal turns, so
    // whole-log quiescence would wrongly block mid-turn — but
    // `_waitForReady` runs ONLY at startup, before any turn, so
    // startup-phase quiescence is exactly the right window. The
    // `readyDebugQuietMs` clock lives entirely inside this method and
    // is never consulted by `_awaitTurnComplete`.
    let readySinceAt = null;   // when the (hint + stable-pane) state began
    let prevBuf = null;        // last poll's capture, for the stability compare
    // B8 debug-log quiescence tracking. `prevDebugSize` is the
    // `--debug-file` byte-size seen on the PREVIOUS poll; `lastGrowthAt`
    // is when the size last increased. The debug log is "quiet" once it
    // has not grown for `readyDebugQuietMs`. The FIRST non-null size is
    // a baseline (no growth recorded for it) — claude actively writing
    // its MCP-startup burst makes the size keep climbing across the
    // next polls, which is what resets the clock.
    let prevDebugSize = null;
    let lastGrowthAt = null;
    if (this.pollScheduler) this.pollScheduler.acquire();
    try {
      while (this._now() < deadline) {
        // OPTIMIZATION: ready hint lives in the bottom ~5 lines of the
        // pane. Polling 1000 lines each tick is wasteful — cap at 80
        // for a ~12× cheaper tmux subprocess.
        lastBuf = await this.runner.captureWide(this.tmuxName, { lines: 80 });
        // Ready ⇔ the hint is on the pane AND the pane is identical to
        // the previous poll (the MCP-loading repaint storm has
        // stopped). The first poll has no previous buffer to compare,
        // so it can never satisfy stability — readiness needs at
        // least two matching captures, which is the point.
        const hintPresent = READY_HINTS_RE.test(lastBuf);
        const paneStable = prevBuf !== null && lastBuf === prevBuf;
        // B8: the --debug-file log must have stopped growing for
        // `readyDebugQuietMs`. A debug-log size increase since the last
        // poll = claude is still writing (MCP servers connecting) → not
        // quiet. The log never appearing at all (null size for the whole
        // wait — no MCP startup observed) reads as quiet, so the B6 pane
        // check still gates a no-agent / fast spawn.
        const debugSize = this._probeDebugLogSize();
        if (debugSize !== null && prevDebugSize !== null
            && debugSize > prevDebugSize) {
          lastGrowthAt = this._now();   // log grew → claude still writing
        }
        if (debugSize !== null) prevDebugSize = debugSize;
        const debugQuiet = lastGrowthAt === null
          || (this._now() - lastGrowthAt) >= this.readyDebugQuietMs;
        if (hintPresent && paneStable && debugQuiet) {
          if (readySinceAt == null) readySinceAt = this._now();
          if (this._now() - readySinceAt >= this.quiesceMs) return;
        } else {
          // pane moved / hint gone / debug log still being written →
          // reset the clock. A debug-log write during the quiesce
          // window means MCP startup is not finished.
          readySinceAt = null;
        }
        prevBuf = lastBuf;
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
  async _awaitTurnComplete({ timeoutMs, abortP = null }) {
    const deadline = this._now() + timeoutMs;
    let firstReadyAt = null;
    let lastBuf = '';
    let prevBufLen = -1;
    let cachedReady = false;
    let cachedStreaming = false;
    // R7: when the caller supplies `abortP`, every blocking await in
    // the loop (the `captureWide` subprocess AND the inter-tick wait)
    // is raced against it. A wedged `tmux capture-pane` would
    // otherwise park the loop forever — neither completing the turn
    // nor releasing the PollScheduler refcount. `abortP` resolves
    // with ABORT_SENTINEL; any await that loses the race to it yields
    // the sentinel, and the loop exits via the `finally` (releasing
    // the scheduler) so _runTurn's absolute deadline fails the turn.
    const raceAbort = abortP
      ? (p) => Promise.race([p, abortP.then(() => ABORT_SENTINEL)])
      : (p) => p;
    if (this.pollScheduler) this.pollScheduler.acquire();
    try {
    while (this._now() < deadline) {
      lastBuf = await raceAbort(this.runner.captureWide(this.tmuxName, { lines: 200 }));
      if (lastBuf === ABORT_SENTINEL) return ABORT_SENTINEL;

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
        // Predicate (observer-only): capture-pane signals heartbeat
        // the active turns. `esc to interrupt` is the single most-
        // useful TUI signal (Agent C) — always present mid-turn,
        // including during subagent runs. The H1 indicator is the
        // fallback for `paste-parked` when JSONL hasn't tailed yet.
        const activeTurns = this._activeGroup?.turns || [];
        if (cachedStreaming) {
          for (const t of activeTurns) this._heartbeat(t, 'capture:streaming');
        }
        if (QUEUED_PASTE_RE.test(lastBuf)) {
          for (const t of activeTurns) {
            if (t.phase === TurnPhase.PASTED_UNCONFIRMED && !t.parked) {
              t.parked = true;
              this._setPhase(t, TurnPhase.PASTE_PARKED, 'capture:queued-fallback');
            }
          }
        }
        // Approval-prompt detection ONLY runs on changed captures.
        // It's the heaviest regex (`[\s\S]{0,400}?` non-greedy) so
        // worth skipping on quiescent ticks.
        if (APPROVAL_PROMPT_RE.test(lastBuf)) {
          // Predicate (observer-only): approval-pending blocks turn
          // progress until respondToApproval lands. Mark BEFORE the
          // existing handler runs so observers see the transition
          // before any side-effects.
          for (const t of activeTurns) {
            this._setPhase(t, TurnPhase.APPROVAL_PENDING, 'capture:approval-prompt');
          }
          await this._handleApprovalPrompt(lastBuf);
          firstReadyAt = null;     // approval pause resets ready clock
          if (await raceAbort(this._waitForNextTick()) === ABORT_SENTINEL) {
            return ABORT_SENTINEL;
          }
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
      if (await raceAbort(this._waitForNextTick()) === ABORT_SENTINEL) {
        return ABORT_SENTINEL;
      }
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
      // Predicate (observer-only): the approval was decided. The
      // assistant will resume — demote `approval-pending` back to
      // `streaming` on every active-group turn that is still in
      // that phase. The next assistant-chunk / tool-use will move
      // them again from there.
      for (const t of this._activeGroup?.turns || []) {
        if (t.phase === TurnPhase.APPROVAL_PENDING) {
          this._setPhase(t, TurnPhase.STREAMING, `approval:${decision}`);
        }
      }
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
    // Bug 3: C-c stops the agent's work in the TUI, but an interrupted
    // turn (especially a tool turn) writes no terminal JSONL `result`
    // and shows no capture-pane completion `_runTurn`'s race
    // recognises — so `_runTurn` would hang until the absolute
    // `turnTimeoutMs`. Settle the running turn's interrupt signal so
    // its race ends NOW. The running primary turn is `pendingQueue[0]`
    // in state 'pasted'/'streaming'.
    const running = this.pendingQueue.find(
      (t) => t.state === 'pasted' || t.state === 'streaming',
    );
    if (running && typeof running.signalInterrupt === 'function') {
      running.signalInterrupt();
    }
    this.emit('interrupt-applied', { backend: 'tmux' });
    return true;
  }

  /**
   * Bug 1: report whether the TUI currently shows a running
   * background shell (a detached `run_in_background:true` Bash). This
   * is work that outlives the turn — polygram's turn-scoped Stop is
   * blind to it. Reads the pane bottom for the `N shell` indicator.
   * @returns {Promise<boolean>}
   */
  async hasBackgroundShell() {
    if (this.closed) return false;
    try {
      const buf = await this.runner.captureWide(this.tmuxName, { lines: 80 });
      // The indicator lives in the bottom few lines of the pane.
      return BG_SHELL_RE.test(String(buf || '').slice(-2000));
    } catch (err) {
      this.logger.error?.(`[${this.label}] hasBackgroundShell: ${err.message}`);
      return false;
    }
  }

  /**
   * Bug 1: stop every running background shell via the TUI's
   * background-task panel. Sequence verified against claude 2.1.142:
   * `/bashes` + Enter opens the "Shell details" panel (legend
   * "Esc/Enter/Space to close · x to stop"); `x` stops the shell;
   * Esc closes the panel. Repeats while a shell remains, bounded so a
   * stuck panel can't loop forever.
   *
   * @returns {Promise<boolean>} true if no background shell remains
   *   after the attempt (all stopped, or none was running).
   */
  async killBackgroundShells() {
    if (this.closed) return false;
    const maxRounds = 8;   // bound — one round per shell, plus slack
    for (let round = 0; round < maxRounds; round += 1) {
      if (!(await this.hasBackgroundShell())) return true;
      try {
        // Open the background-task panel.
        await this.runner.pasteText(this.tmuxName, '/bashes');
        await this.runner.sendControl(this.tmuxName, 'Enter');
        await this._sleep(this.pollMs * 4 + 200);
        // Stop the shell shown in the Shell-details panel.
        await this.runner.sendControl(this.tmuxName, 'x');
        await this._sleep(this.pollMs * 4 + 200);
        // Close the panel.
        await this.runner.sendControl(this.tmuxName, 'Escape');
        await this._sleep(this.pollMs * 2 + 100);
      } catch (err) {
        this.logger.error?.(`[${this.label}] killBackgroundShells: ${err.message}`);
        return false;
      }
    }
    // Bounded out — report the residual state honestly.
    return !(await this.hasBackgroundShell());
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
    //
    // R8: if the paste rejects the autosteer never reached the TUI —
    // it will never correlate to a JSONL user-message, so the
    // stale-turn sweep would otherwise be the ONLY thing that catches
    // it, `turnTimeoutMs` later. Fail the ledger turn immediately and
    // emit `inject-fail` WITH the msgId so the wired onInjectFail
    // handler can clear the ✍ reaction promptly instead of leaving it
    // stuck for minutes.
    this._pasteAndEnter(this._embedToken(safe, turn.token))
      .catch((err) => {
        if (turn.state !== 'done' && turn.state !== 'failed') {
          turn.state = 'failed';
        }
        this._enqueuedTurns = this._enqueuedTurns.filter((t) => t !== turn);
        this.emit('inject-fail', {
          err: err.message,
          msgId: msgId ?? null,
          turnId: turn.turnId,
          backend: 'tmux',
        });
      });

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
    // B7: release any pending submit-confirm waiters too — a
    // `_scheduleSubmitRetries` blocked on a tokened user-message from a
    // now-dead session would otherwise burn its whole retry budget.
    // Each waiter's stored fn resolves it as confirmed, so the confirm
    // loop returns at once instead of retrying; the in-flight turn is
    // already rejected by `drainQueue` above, so the turn settles loud
    // regardless. (`_scheduleSubmitRetries` also bails on its own when
    // the owning turn reaches a terminal state — this is belt-and-
    // braces for a confirm whose turn ref it never received.)
    for (const finish of [...this._submitConfirms.values()]) {
      try { finish(); } catch { /* swallow */ }
    }
    if (this._sessionLogTail) {
      try { this._sessionLogTail.close(); } catch { /* swallow */ }
      this._sessionLogTail = null;
    }
    // H1 — close hook tail + remove the per-session settings + ndjson.
    // Files are best-effort unlinked (ENOENT fine if a sweeper or a
    // crashed cleanup got there first).
    if (this._hookTail) {
      try { this._hookTail.close(); } catch { /* swallow */ }
      this._hookTail = null;
    }
    if (this._hookSettingsPath || this._hookNdjsonPath) {
      try {
        removeHookFiles({ botName: this.botName, sessionId: this.claudeSessionId });
      } catch { /* swallow */ }
      this._hookSettingsPath = null;
      this._hookNdjsonPath = null;
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

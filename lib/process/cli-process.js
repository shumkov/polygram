/**
 * CliProcess — Claude session backed by `claude` CLI in tmux,
 * with IO over the official Channels MCP protocol via a stdio bridge
 * AND observability via hook ndjson (--settings injection, Phase 1.4).
 *
 * Cost profile: subscription-priced (claude CLI uses Pro/Max) AND structured
 * IO (no JSONL tailing, no pane scraping). The post-0.12 successor to
 * the 0.11 CliProcess + TmuxProcess pair — three layers, one mechanism
 * per concern: tmux=lifecycle, channels-bridge=IO, hooks=observability.
 *
 * Architecture:
 *   CliProcess.start() creates a per-session unix socket (mode 0600
 *   + per-socket secret), spawns claude in tmux with --channels pointing
 *   at lib/process/channels-bridge.mjs registered via inline --mcp-config.
 *   The bridge connects back over the socket, authenticates via the
 *   shared secret, and proxies MCP traffic in both directions.
 *
 *   Inbound user msgs:   daemon → CliProcess.send() → bridge socket →
 *                        bridge → mcp.notification(claude/channel)
 *   Outbound replies:    Claude calls mcp__polygram-bridge__reply →
 *                        bridge → socket → CliProcess.onBridgeMsg →
 *                        toolDispatcher(chatId, text, files) → daemon
 *
 *   Permission relay:    Claude needs Bash → Claude Code emits
 *                        permission_request → bridge → socket →
 *                        CliProcess emits 'approval-required' → polygram
 *                        renders inline-keyboard buttons → user taps →
 *                        CliProcess.respondToPermission(id, verdict)
 *
 * Phase 0 (2026-05-24) findings baked in:
 *   - In dev mode use --dangerously-load-development-channels server:NAME
 *     by itself; mixing with --channels makes claude reject the next arg.
 *   - --no-session-persistence is --print-mode only — do NOT pass.
 *   - --mcp-config is variadic; must come last.
 *   - Trust + dev-channel confirmation dialogs both need Enter at startup.
 *
 * See docs/0.11.0-channels-driver-plan.md for the full design.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Process, UnsupportedOperationError } = require('./process');
const { ChannelsBridgeServer } = require('./channels-bridge-server');
const { writeHookFiles, removeHookFiles } = require('./hook-settings');
const { createHookTail } = require('./hook-event-tail');
// File-send staging: reuse the dispatcher's allowlist root so the dir we
// create exactly matches the realpath the validator accepts (no /tmp vs
// /private/tmp drift — one of the original Music-topic failures).
const { DEFAULT_ATTACHMENT_BASE } = require('./channels-tool-dispatcher');
const { resolveFileCaps } = require('../attachments');
const { resolveCompactionWarnConfig } = require('../compaction-warn');
const { readContextTokens, contextPct } = require('../context-usage');
const { runStartupGate } = require('../tmux/startup-gate');
const { POLYGRAM_DISPLAY_HINT } = require('../telegram/display-hint');

const BRIDGE_PATH = path.resolve(__dirname, 'channels-bridge.mjs');
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
// 0.12 Phase 1.6: claude-side MCP-init can lag behind daemon-side bridge
// handshake by 100ms in normal conditions, up to a few seconds on cold
// machines or fresh git worktrees. 5s default tolerates that without
// being so long that a genuinely-stuck bridge wedges the chat unnoticed.
const DEFAULT_MCP_READY_TIMEOUT_MS = 5_000;
// 0.12 Phase 1.7 (Finding 0.1.A): Stop hook fires AFTER the channel result
// event. We wait this long after a channel result before finalizing the
// turn, so the Stop hook can land and we can use its last_assistant_message
// as a text fallback when the channel result delivered empty replies.
// Mirrors rc.41 H4 stopGraceMs from tmux backend. 2s default = same as tmux.
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_TURN_QUIET_MS = 2_000;     // after first reply, wait this long for more before resolving turn
const DEFAULT_TURN_TIMEOUT_MS = 600_000; // 10 min idle cap (resets on each reply — Review F#13)
const DEFAULT_TURN_ABSOLUTE_MS = 1_800_000; // 30 min absolute wall-clock ceiling (no reset)
const DEFAULT_INTERRUPT_GRACE_MS = 5_000; // after Ctrl-C, wait this long for Claude to ack before synthesizing 'interrupted'
const DEFAULT_MAX_REPLIES_PER_TURN = 20; // P1 #12: cap on quiet-window resets to prevent chatty-Claude hang
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;          // P1 #6: declare bridge dead if no pong in 30s
const PONG_CHECK_INTERVAL_MS = 5_000;
const RECENT_TOOL_CALL_LIMIT = 256;      // P1 #7: cap on idempotency cache
const DEFAULT_TOOL_RATE_LIMIT_PER_SEC = 5;   // P2 ADV-6: cap on reply tool calls per second
const DEFAULT_TOOL_RATE_BURST = 20;          // ADV-6: token bucket capacity
const DEFAULT_QUEUE_CAP = 50;                // Parity P2: match SDK/tmux pendingQueue cap

// Review F#17: mid-turn dialog watchdog. Even though channels uses MCP for IO,
// the underlying claude TUI can still pop interactive prompts mid-turn that
// don't surface as MCP notifications (session-age, future "approaching usage
// limit" menus, etc.). Without polling the pane we'd only catch them when the
// idle-ceiling fires (F#13, ~10 min). Reusing the pong watchdog's 5s tick:
// every check, if any pending turns exist AND the tmux session is live, we
// capture-pane and match against this catalog. Action 'enter' dismisses with
// sendControl(Enter); 'emit-only' surfaces telemetry without auto-action.
//
// Pattern matching is intentionally conservative — distinctive substrings
// only — to avoid false positives during normal turn output. Extend the
// catalog when new dialogs are observed in production.
const SESSION_AGE_PROMPT_RE = /Resuming the full session[\s\S]*Resume from summary/i;
const MID_TURN_PROMPTS = [
  { name: 'session-age', regex: SESSION_AGE_PROMPT_RE, action: 'enter' },
];

// 0.12 Phase 3.2 (Finding 0.1.A): rc.45 esc-to-interrupt liveness heartbeat.
// During pure-thinking turns (no tool calls), NO hook events fire between
// UserPromptSubmit (start) and Stop (end). Production thinking turns regularly
// exceed 45s on heavy prompts, which would trip STALL (🥱) before claude
// finishes. Claude's TUI prints "esc to interrupt" continuously throughout
// any busy phase — capture-pane sees it, we emit 'thinking', the reactor
// heartbeats, the cascade stays at THINKING_DEEPEST (🤓) instead of STALL.
// TODO(0.13): polish heartbeat strategy. Future replacement candidates:
// a richer hook event from Anthropic, or a periodic ping from a long-lived
// hook process.
const STREAMING_HINT_RE = /esc to interrupt/i;

// 0.12.0 background-work lifecycle: claude's TUI mode line shows a live
// background-shell COUNT while a `run_in_background:true` Bash outlives its turn,
// e.g. `⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage`.
// Confirmed on claude 2.1.158 (P0 spike — docs/0.12.0-background-work-lifecycle-
// plan.md): the count is always-present in the viewport mode line while shells run
// and clears IN-PLACE within ~3s when they exit (no stale scrollback).
//
// MODE-INDEPENDENT (prod regression fix, 2026-06-04): the original regex anchored
// on "auto mode on", but EVERY shumorobot session runs "⏵⏵ bypass permissions on"
// — the spike happened to be captured in auto mode. So the detector never matched
// in prod and bg-work-status fired zero times. Anchor instead on the `⏵⏵` mode-
// line glyph (present in auto / bypass / accept-edits modes alike); only the mode
// label between it and `· N shell` varies. Still matched only against the captured
// TAIL so a scrolled-off history line never trips it. R1: re-validate on each
// pinned-claude bump (glyph + `N shell` wording).
const BACKGROUND_SHELL_RE = /⏵⏵[^\n]*·\s*(\d+)\s+shells?\b/i;
// How long a detached background shell may run AFTER its turn resolved (claude
// idle) before the stall-watchdog fires one read-only self-check. Override via
// the constructor (tests use a small value).
const DEFAULT_BG_WORK_STALL_MS = 600_000; // 10 min

// 0.12 Phase 3.3 (Q1 resolution): heuristic for "looks like an unknown
// interactive prompt." Match common prompt shapes that don't appear in
// MID_TURN_PROMPTS — operator gets a telemetry event so they can decide
// whether to add the prompt to the catalog or respond manually. Conservative
// — false positives surface as no-op telemetry, false negatives surface
// as the idle-ceiling timeout (~10min).
const UNKNOWN_PROMPT_HEURISTIC_RE = /(\?\s*$|\(y\/N\)|Yes\/No|❯\s|^\s*[12345]\.\s)/im;
// rc.14: a previous rc (rc.11) had a BRIDGE_DEAD_RE here that matched the pane
// line "server:polygram-bridge  no MCP server configured with that name" and
// treated it as a dead bridge to recover from. That was a MISDIAGNOSIS: this
// line is a BENIGN, persistent banner that `--dangerously-load-development-
// channels` + `--strict-mcp-config` prints on EVERY healthy session — the
// channel still delivers messages and the reply tool still works (reproduced
// 2026-06-01 with a test MCP server that demonstrably functions). The pane
// matcher therefore false-fired ~5s into every channels turn and KILLED
// healthy sessions (the Music-topic "mid-turn detach" regression). Real bridge
// loss is caught by the socket-close path (bridgeServer 'bridge-disconnected'
// → _handleBridgeDisconnected). There is no reliable pane signal — removed.
// Per-pattern rate limit so a dialog that lingers across multiple polls
// doesn't spam sendControl/event emissions. Aligned with the 5s poll cadence.
const MID_TURN_DEDUP_WINDOW_MS = 30_000;

// Parity with TmuxProcess (R2-F1 / G5b) and SdkProcess: strip C0 control
// chars + DEL before injecting. Allows \t (0x09) and \n (0x0a) through.
// Same regex as `lib/tmux/tmux-runner.js` CONTROL_CHAR_RE — keep in sync.
const INJECT_CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
function sanitizeInjectControlChars(text) {
  return typeof text === 'string' ? text.replace(INJECT_CONTROL_CHAR_RE, '') : text;
}

class CliProcess extends Process {
  /**
   * @param {object} opts
   * @param {string} opts.sessionKey
   * @param {string|null} [opts.chatId]
   * @param {string|null} [opts.threadId]
   * @param {string} [opts.label]
   * @param {object} opts.tmuxRunner       — polygram's existing tmuxRunner (for spawn/kill/send-keys)
   * @param {string} opts.botName          — for tmux session naming
   * @param {string} [opts.claudeBin]      — absolute path to pinned claude binary; defaults to env-resolved
   * @param {Function} opts.toolDispatcher — async ({sessionKey, chatId, text, files, toolName}) => {ok, error?}
   *                                         Called when Claude's reply (or react/edit_message) tool fires.
   * @param {object} [opts.logger]
   * @param {number} [opts.handshakeTimeoutMs]
   * @param {number} [opts.turnQuietMs]
   * @param {number} [opts.turnTimeoutMs]
   */
  constructor({
    sessionKey, chatId, threadId, label,
    tmuxRunner, botName,
    claudeBin = null,
    toolDispatcher,
    logger = console,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    mcpReadyTimeoutMs = DEFAULT_MCP_READY_TIMEOUT_MS,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    turnQuietMs = DEFAULT_TURN_QUIET_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    turnAbsoluteMs = DEFAULT_TURN_ABSOLUTE_MS,
    bgWorkStallMs = DEFAULT_BG_WORK_STALL_MS,
    interruptGraceMs = DEFAULT_INTERRUPT_GRACE_MS,
    maxRepliesPerTurn = DEFAULT_MAX_REPLIES_PER_TURN,
    queueCap = DEFAULT_QUEUE_CAP,        // Parity P2
    db = null,                            // Parity P1: db for _logEvent
  } = {}) {
    super({ sessionKey, chatId, threadId, label });
    this.backend = 'cli';

    if (!tmuxRunner) throw new TypeError('CliProcess: tmuxRunner required');
    if (!botName) throw new TypeError('CliProcess: botName required');
    if (typeof toolDispatcher !== 'function') {
      throw new TypeError('CliProcess: toolDispatcher (function) required');
    }

    this.runner = tmuxRunner;
    this.botName = botName;
    // claudeBin MUST be supplied — factory enforces this. We don't lazy-resolve
    // because there's no sensible default and silent null would surface as a
    // far-from-cause tmuxRunner.spawn failure.
    if (!claudeBin && !process.env.POLYGRAM_CLAUDE_BIN) {
      throw new TypeError('CliProcess: claudeBin required (or POLYGRAM_CLAUDE_BIN env)');
    }
    this.claudeBin = claudeBin || process.env.POLYGRAM_CLAUDE_BIN;
    this.toolDispatcher = toolDispatcher;
    this.logger = logger;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.mcpReadyTimeoutMs = mcpReadyTimeoutMs;
    this.stopGraceMs = stopGraceMs;
    this.turnQuietMs = turnQuietMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.turnAbsoluteMs = turnAbsoluteMs;
    this.bgWorkStallMs = bgWorkStallMs;
    this.interruptGraceMs = interruptGraceMs;
    this.maxRepliesPerTurn = maxRepliesPerTurn;
    this.queueCap = queueCap;
    this.db = db;

    // populated by start()
    this.sockPath = null;
    this.sockSecret = null;
    this.bridgeServer = null;        // M1: ChannelsBridgeServer instance (socket + auth + protocol validation)
    this.mcpConfigPath = null;       // P0 #1: 0o600 tmp file holding bridge env (no argv leak)
    this.tmuxSession = null;         // tmux session name
    this.bridgeReady = false;
    // 0.12 Phase 1.6: claude-side MCP-server registration completion flag.
    // Set true when bridge writes {kind:'mcp-ready'} after claude's first
    // ListToolsRequest (Finding 0.3.A — cold-spawn race fix).
    this.mcpReady = false;
    this.pingTimer = null;
    // Review P1 #6: daemon-side pong tracking. Without it, a half-open socket
    // (bridge frozen but TCP alive) is invisible to the daemon. We record the
    // last pong timestamp on each 'pong' bridge message and a separate watchdog
    // interval fires bridge-disconnected if too much time elapses.
    this.lastPongAt = 0;
    this.pongWatchdog = null;
    // 0.12.0 background-work stall-watchdog state. `_bgWorkSince` = when a live
    // background shell was first observed while idle (null = none); reset only
    // when the shell count returns to 0. `_bgWorkEscalations` caps the watchdog
    // at one read-only self-check per continuous background-work window.
    this._bgWorkSince = null;
    this._bgWorkEscalations = 0;
    // Visibility (Use 3): whether a "⏳ working in background" status message is
    // currently shown, so we emit exactly one running→cleared pair per window.
    this._bgWorkStatusShown = false;
    // Review P2 ADV-6: token-bucket rate limit on Claude's reply tool calls.
    // Without this, a prompt-injected or runaway Claude can fire reply() 1000×
    // in a tight loop, flooding TG + saturating the daemon event loop.
    this.toolRateTokens = DEFAULT_TOOL_RATE_BURST;
    this.toolRateLastRefillAt = Date.now();
    this.toolRatePerSec = DEFAULT_TOOL_RATE_LIMIT_PER_SEC;
    this.toolRateBurst = DEFAULT_TOOL_RATE_BURST;
    // Review P3 ADV-11: rate-limit the chat_id-mismatch log so a 1000×
    // mismatch storm doesn't fill stderr/logs at warn level.
    this._lastChatIdMismatchLogAt = 0;
    // Review P3 C8: track the most recent interrupt so the grace window can
    // resolve pending turns with subtype 'interrupted' if Claude doesn't
    // reply after Ctrl-C.
    this._interruptedAt = 0;
    this._interruptGraceTimer = null;
    // Review P3 C5/HeartbeatReactor stop race: monotonic token for
    // setReaction calls. Stale completions discarded by token mismatch.
    this._reactionToken = 0;
    // Review P1 #7: idempotency for tool_ack — track tool_call_ids we've
    // already ACK'd so a duplicate 'tool' message (Claude retry on isError)
    // doesn't re-invoke the dispatcher → duplicate TG send. Set is bounded
    // to RECENT_TOOL_CALL_LIMIT entries via FIFO eviction.
    this.recentToolCallIds = new Set();
    this.recentToolCallResults = new Map();   // tool_call_id → message_id (0.13: replay on re-ACK)
    this.recentToolCallOrder = [];   // FIFO bound
    // Review F#17: per-pattern last-fired timestamp for the mid-turn dialog
    // watchdog. Dedups within MID_TURN_DEDUP_WINDOW_MS so a lingering dialog
    // doesn't trigger sendControl/emit on every 5s poll.
    this.midTurnDialogLastFiredAt = new Map();   // patternName → ts
    // Review F#16: secondary content-hash dedup. The tool_call_id cache above
    // catches retries that reuse the same id, but Claude's bridge generates a
    // NEW tool_call_id per retry (channels-bridge.mjs:230). If the daemon's
    // first dispatch took longer than TOOL_ACK_TIMEOUT_MS (30s — slow TG, big
    // attachment), the bridge times out → isError → Claude retries with new
    // id → daemon dispatches the same (chat_id, text) again → duplicate user
    // message. Track (chat_id, sha256(text)) for 60s to catch this even when
    // the tool_call_id changes. TTL is tight enough that legitimate repeated
    // sends ("ok" twice in a row) eventually pass.
    this.recentContentHashes = new Map();   // key → expiryTs
    this.contentDedupWindowMs = 60_000;

    // pending turn(s): turn_id → { resolve, reject, replies: [], quietTimer, hardTimer, startedAt }
    this.pendingTurns = new Map();
    // 0.12 interactive questions: tool_call_ids of `ask` calls awaiting an answer.
    // While non-empty, the keep-alive interval resets the turn's idle ceiling (an
    // idle `ask` fires no tool hooks, so _extendQuietOnToolActivity wouldn't run).
    this._openQuestions = new Set();
    this._questionKeepAliveTimer = null;

    // File-send outbound cap (bot → user). Safe cloud default; overwritten in
    // _spawnTmuxClaude with the backend/chat-resolved value before any turn.
    this.maxOutboundFileBytes = resolveFileCaps({ localApi: false }).outBytes;

    // P1 security (review #8): track resolved permission request_ids so a
    // double-fire of respond() can't write a second perm_verdict for the same
    // request. TmuxProcess gates on _pendingApprovalId; this is the channels
    // analog.
    this.respondedPermissions = new Set();
  }

  /**
   * TmuxProcess uses cost=3 because each pane holds the full claude binary.
   * CliProcess does the same (it's a tmux'd claude + a thin bridge subprocess).
   */
  get cost() {
    return 3;
  }

  /**
   * Parity P1: telemetry helper. Mirrors SdkProcess._logEvent so channels
   * chats produce the same cross-backend ops rows. No-ops when db is unset
   * (e.g. test fixtures). Defensive try/catch — telemetry must NEVER fail
   * a turn.
   */
  _logEvent(kind, detail = {}) {
    if (!this.db) return;
    try {
      this.db.logEvent?.(kind, {
        chat_id: this.chatId,
        thread_id: this.threadId,
        session_key: this.sessionKey,
        backend: this.backend,
        ...detail,
      });
    } catch (err) {
      this.logger.warn?.(`[${this.label}] channels: logEvent ${kind} failed: ${err.message}`);
    }
  }

  // ─── start ─────────────────────────────────────────────────────────

  async start(opts = {}) {
    if (this.closed) throw new Error('CliProcess: cannot start a closed instance');

    this.claudeSessionId = opts.existingSessionId || crypto.randomUUID();
    // Save cwd so the tool dispatcher's file-attachment allowlist (P0 #2) can
    // permit files under the agent's workspace.
    this.sessionCwd = opts.cwd || null;

    // File-send staging dir (2026-06 file-send feature). The dispatcher
    // allowlist always permits <DEFAULT_ATTACHMENT_BASE>/<sessionKey>/, but
    // nothing ever CREATED it — so claude's reply(files) attempts at
    // /tmp/polygram-attachments failed (dir absent / realpath mismatch) and
    // it flailed across other paths. Create it here and surface it to the
    // prompt so claude has one blessed, always-allowed place to stage a file
    // before sending. realpathSync so the stored path matches what the
    // validator resolves (the /tmp ↔ /private/tmp fix).
    try {
      const dir = path.join(DEFAULT_ATTACHMENT_BASE, String(this.sessionKey));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.attachmentStagingDir = fs.realpathSync(dir);
    } catch (err) {
      this.attachmentStagingDir = null;
      this.logger.warn?.(`[${this.label}] channels: staging dir create failed: ${err.message}`);
    }

    // Opaque random token for socket filename — do NOT leak sessionKey to /tmp.
    const socketToken = crypto.randomBytes(16).toString('hex');
    this.sockPath = path.join(os.tmpdir(), `polygram-${socketToken}.sock`);
    this.sockSecret = crypto.randomBytes(32).toString('hex');

    // Review #11: tmux session name MUST share the `polygram-${botName}-` prefix
    // used by lib/tmux/orphan-sweep.js + listPolygramSessions, otherwise daemon-
    // boot orphan-sweep won't see channels sessions and leaks claude+bridge
    // pairs on every restart.
    const tmuxName = `polygram-${this.botName}-channels-${socketToken.slice(0, 8)}`;
    this.tmuxSession = tmuxName;

    // Review R6+R7+R10: any throw after _createSocketServer leaks the socket
    // file + listener + (after _spawnTmuxClaude) the tmux session. Wrap in
    // try/catch that runs the same teardown kill() does.
    try {
      await this._createSocketServer();
      await this._spawnTmuxClaude({ tmuxName, opts });
      await this._waitForBridgeHandshake();
      // Phase 1.3: arm hook tail AFTER spawn so this._hookNdjsonPath is
      // populated (set inside _spawnTmuxClaude when writeHookFiles runs).
      // Mirrors tmux-process.js:_armHookTail timing.
      this._armHookTail();
      this._startPingLoop();
    } catch (err) {
      await this._teardownOnStartFailure();
      throw err;
    }

    // Parity P17: init payload matches TmuxProcess shape (snake_case key for
    // session_id) so polygram's onInit consumer doesn't need three-shape branching.
    this.emit('init', {
      session_id: this.claudeSessionId,
      label: this.label,
      backend: this.backend,
      tmux_name: this.tmuxSession,
    });
  }

  /**
   * Best-effort cleanup when start() fails partway through. Mirrors kill()
   * but doesn't mark the instance closed (caller may retry with a new
   * instance).
   *
   * Review F#4: pre-fix this referenced `this.sockClient` / `this.sockServer`,
   * neither of which is assigned anywhere post-M1 refactor (socket lifecycle
   * moved into ChannelsBridgeServer = `this.bridgeServer`). The dead checks
   * meant the net.Server listener was NEVER closed on start-failure → FD
   * leak compounding across every spawn retry. Now closes `this.bridgeServer`
   * the way `_doKill` already does (line ~1105). Defensive try/catch
   * preserves the calling pattern (teardown must not mask the start() error).
   */
  async _teardownOnStartFailure() {
    if (this.bridgeServer) {
      try { await this.bridgeServer.close(); } catch {}
      this.bridgeServer = null;
    }
    if (this.sockPath) {
      try { fs.unlinkSync(this.sockPath); } catch {}
    }
    // P0 #1: unlink the secret-bearing mcp-config file on every teardown path
    if (this.mcpConfigPath) {
      try { fs.unlinkSync(this.mcpConfigPath); } catch {}
    }
    if (this.tmuxSession) {
      try { await this.runner.killSession(this.tmuxSession); } catch {}
    }
    // Phase 1.3: tear down hook tail + clean per-session hook files on
    // start-failure path. Tail may not be armed yet (start ordering puts
    // _armHookTail after _spawnTmuxClaude); guard with the field check.
    if (this._hookTail) {
      try { this._hookTail.close(); } catch {}
      this._hookTail = null;
    }
    if (this.botName && this.claudeSessionId) {
      try { removeHookFiles({ botName: this.botName, sessionId: this.claudeSessionId }); } catch {}
    }
  }

  /**
   * M1 refactor: socket-server lifecycle delegated to ChannelsBridgeServer.
   * This class wires the event surface (bridge-ready, bridge-message,
   * bridge-disconnected) and keeps protocol semantics in _handleBridgeMessage.
   */
  async _createSocketServer() {
    this.bridgeServer = new ChannelsBridgeServer({
      sockPath: this.sockPath,
      sessionKey: this.sessionKey,
      sockSecret: this.sockSecret,
      logger: this.logger,
      label: `${this.label}:bridge-server`,
    });

    this.bridgeServer.on('session-init', msg => {
      // Adopt the canonical claude session_id the bridge reports (claude may
      // have ignored our --session-id; the bridge tells us what claude is
      // actually running).
      if (msg.claude_session_id && msg.claude_session_id !== this.claudeSessionId) {
        this.claudeSessionId = msg.claude_session_id;
        this.emit('session-id-refreshed', this.claudeSessionId);
      }
    });

    this.bridgeServer.on('bridge-ready', () => {
      this.bridgeReady = true;
      this.emit('bridge-ready');
    });

    // 0.12 Phase 1.6: claude has finished registering polygram-bridge as
    // an MCP server (first ListToolsRequest landed at the bridge).
    // _waitForBridgeHandshake gates send() on this in addition to
    // bridge-ready — the cold-spawn race fix.
    this.bridgeServer.on('mcp-ready', () => {
      this.mcpReady = true;
      this.emit('mcp-ready');
    });

    this.bridgeServer.on('bridge-message', msg => this._handleBridgeMessage(msg));

    this.bridgeServer.on('bridge-disconnected', () => this._handleBridgeDisconnected());

    await this.bridgeServer.listen();
  }

  async _spawnTmuxClaude({ tmuxName, opts }) {
    const bridgeEnv = {
      POLYGRAM_SESSION_KEY:       this.sessionKey,
      POLYGRAM_SOCK:              this.sockPath,
      POLYGRAM_SOCK_SECRET:       this.sockSecret,
      POLYGRAM_CLAUDE_SESSION_ID: this.claudeSessionId,
    };
    const mcpConfig = {
      mcpServers: {
        'polygram-bridge': {
          command: 'node',
          args: [BRIDGE_PATH],
          env: bridgeEnv,
        },
      },
    };

    // Review P0 #1: write mcp-config to a 0o600 tmp file and pass the FILE
    // PATH in argv. Inline JSON in argv would expose POLYGRAM_SOCK_SECRET +
    // POLYGRAM_SESSION_KEY in /proc/<pid>/cmdline + `ps -ef` to any local
    // process (defeats the 0o600 socket). The file path itself reveals
    // nothing. claude's `--mcp-config <configs...>` accepts JSON files or
    // strings (per `--help`).
    //
    // The path stays alongside the socket so cleanup is symmetric.
    const socketToken = path.basename(this.sockPath, '.sock').replace(/^polygram-/, '');
    this.mcpConfigPath = path.join(os.tmpdir(), `polygram-${socketToken}-mcp.json`);
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
    // Defensive re-chmod in case umask interfered with the open-mode flag.
    try { fs.chmodSync(this.mcpConfigPath, 0o600); } catch {}

    // ARG ORDER MATTERS (Phase 0 finding):
    //   --mcp-config is variadic <configs...> — must come LAST.
    //   In dev mode use --dangerously-load-development-channels server:NAME
    //   by itself; do NOT also pass --channels (it makes claude reject the
    //   next arg as a malformed channel entry).
    //   --no-session-persistence is --print-mode only.
    const claudeArgs = [
      '--strict-mcp-config',
      '--dangerously-load-development-channels', 'server:polygram-bridge',
    ];

    // Resolve config FIRST so the --resume file-check below has the correct
    // cwd (it picks up topic precedence). Other flags get pushed in order
    // after this.
    const topicConfig = opts.threadId && opts.chatConfig?.topics?.[opts.threadId];
    const agent  = topicConfig?.agent  || opts.chatConfig?.agent  || opts.agent;
    const model  = topicConfig?.model  || opts.chatConfig?.model  || opts.model;
    const effort = topicConfig?.effort || opts.chatConfig?.effort || opts.effort;
    const resolvedCwd = topicConfig?.cwd || opts.chatConfig?.cwd || opts.cwd;

    // File-send outbound cap (bot → user). Backend-derived (cloud 50MB vs
    // local Bot API server 2GB via opts.localApi) with per-topic/chat
    // maxFileBytes override, clamped to the backend ceiling. Stored for the
    // dispatcher (live size-check) and the system prompt (so claude states
    // the right limit). Resolved here so it follows the same topic→chat
    // precedence as cwd/agent above.
    const _capOverride = topicConfig?.maxFileBytes ?? opts.chatConfig?.maxFileBytes ?? null;
    this.maxOutboundFileBytes = resolveFileCaps({
      localApi: !!opts.localApi,
      override: _capOverride,
    }).outBytes;

    // 0.12.0-rc.13: per-chat/topic compaction warning (default OFF). Same
    // topic→chat precedence as the file cap above. When enabled, the channels
    // backend warns the chat as context fills (propose /compact at a break)
    // and on auto-compaction (the event that detaches the bridge mid-turn).
    const _compactionWarnRaw = topicConfig?.compactionWarnings ?? opts.chatConfig?.compactionWarnings;
    this.compactionWarn = resolveCompactionWarnConfig({ compactionWarnings: _compactionWarnRaw });
    this._compactionWarned = false;  // proactive warn-once per climb; reset on PostCompact

    // Parity audit P8 + rc.8 fs-guard (2026-05-26 shumorobot Music topic):
    // `--session-id <id>` creates a NEW claude session with that id;
    // `--resume <id>` resumes the EXISTING conversation. Lazy-respawn after
    // bridge-disconnect must use --resume so conversation history is
    // preserved. Mirrors tmux-process.js:514-518.
    //
    // rc.8 ghost-session guard: polygram persists claude_session_id to its
    // DB as soon as the bridge handshakes (onInit), but claude only writes
    // the JSONL after a successful turn. If an early channels attempt fails
    // before claude completes any turn, polygram's DB ends up with a
    // claude_session_id that has NO corresponding file under claude's
    // projects dir. Subsequent `--resume <ghost-id>` makes claude exit
    // clean with "No conversation found" — exactly the Music topic stall
    // observed at 04:04:29 (session_id=567c72db never persisted; rc.4
    // pane snapshot proved it).
    //
    // Fix: before passing --resume, verify the session JSONL actually
    // exists under the launch cwd. If not, drop the ghost id and use
    // --session-id with the freshly-generated uuid — claude creates a
    // fresh session and onInit re-upserts the DB row.
    //
    // Resume cases preserved:
    //   - in-daemon lazy respawn (file written after first successful turn)
    //   - daemon restart on a chat that completed at least one turn
    // Resume cases correctly dropped:
    //   - cross-backend stale ids (different cwd → different projects dir)
    //   - ghost ids from failed-before-first-turn attempts
    let canResume = false;
    let resumePath = null;
    if (opts.existingSessionId && resolvedCwd) {
      // claude's projects dir naming: cwd with '/' → '-'.
      // Verified live at ~/.claude/projects/-Users-ivanshumkov-Music-rekordbox/
      const cwdMangled = resolvedCwd.replace(/\//g, '-');
      resumePath = path.join(os.homedir(), '.claude', 'projects', cwdMangled, `${opts.existingSessionId}.jsonl`);
      try { canResume = fs.statSync(resumePath).isFile(); } catch { canResume = false; }
    }
    if (canResume) {
      claudeArgs.push('--resume', opts.existingSessionId);
    } else {
      claudeArgs.push('--session-id', this.claudeSessionId);
      if (opts.existingSessionId) {
        this.logger.warn?.(
          `[${this.label}] channels: dropping DB session ${opts.existingSessionId} — ` +
          `no local file at ${resumePath || '<unknown cwd>'}. Starting fresh with ${this.claudeSessionId}.`,
        );
      }
    }
    // Finding 0.12-M2: record the resume decision so _armHookTail (run
    // after spawn) skips the prior session's still-on-disk hook ndjson.
    this._resumedSession = canResume;
    if (agent)  claudeArgs.push('--agent', agent);
    if (model)  claudeArgs.unshift('--model', model);
    if (effort) claudeArgs.push('--effort', effort);

    // rc.9 (2026-05-26 shumorobot first-turn-dead-zone diagnosis): channels
    // backend defaults to permissionMode='bypassPermissions'. Without it,
    // claude TUI shows the canonical interactive permission prompt for
    // every `mcp__polygram-bridge__reply` call:
    //
    //   polygram-bridge - reply(...) (MCP)
    //   Do you want to proceed?
    //   ❯ 1. Yes  2. Yes, and don't ask again  3. No
    //
    // Channels mode has no interactive surface — there's no human at the
    // tmux pane to press a number — so every first-turn hangs until the
    // 30-min turn timeout fires. Reproduced + fixed live via
    // `scripts/spikes/channels-first-turn.mjs`: without bypassPermissions
    // the spike times out at 60s with claude "Marinating" forever; with
    // bypassPermissions it replies in ~5s.
    //
    // The bridge DOES relay `notifications/claude/channel/permission_request`
    // (channels-bridge.mjs:258) for the EXPERIMENTAL channel-permission
    // API, but claude TUI doesn't route ordinary MCP tool calls through
    // that channel — it shows the regular TUI prompt. So the relay path
    // isn't reachable from a fresh-spawn channels turn.
    //
    // Config can still override (e.g., chats that genuinely want a
    // different mode set `permissionMode` in chat/topic config); the
    // default ensures bots actually reply out of the box.
    const permissionMode = topicConfig?.permissionMode
      || opts.chatConfig?.permissionMode
      || opts.permissionMode
      || 'bypassPermissions';
    // 0.12 Phase 4.5: stash for the hook Notification handler — it gates
    // approval-card emit on permissionMode !== 'bypassPermissions'. Under
    // bypass, claude doesn't fire Notification for permission requests
    // anyway (no UI prompt), so the gate is belt-and-braces.
    this.permissionMode = permissionMode;
    claudeArgs.push('--permission-mode', permissionMode);
    if (permissionMode === 'bypassPermissions') {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    // Parity audit P3 + rc.7 (2026-05-26 shumorobot diagnosis): combined
    // system-prompt suffix carrying BOTH the Telegram display rules AND the
    // channels-mode reply-tool contract. Merged into a single
    // --append-system-prompt block — passing two separate
    // --append-system-prompt flags caused MCP server registration to fail
    // (live shumorobot tmux banner: "server:polygram-bridge · no MCP server
    // configured with that name"; claude received no channel messages).
    // Suspected: --append-system-prompt is variadic in claude's CLI and the
    // second flag was eating the subsequent --setting-sources / --mcp-config
    // arguments. Single combined block sidesteps the issue.
    claudeArgs.push('--append-system-prompt', [
      POLYGRAM_DISPLAY_HINT,
      '',
      '## polygram channels mode — HARD CONTRACT',
      '',
      'You are running inside polygram with the channels backend. Your stdout/TUI',
      'output is NOT seen by the user. The user is on Telegram.',
      '',
      'To deliver ANY message to the user, you MUST call the MCP tool',
      '`mcp__polygram-bridge__reply` with `chat_id` and `text` arguments.',
      'Pass the chat_id verbatim from the channel message you received.',
      '',
      'Do NOT respond conversationally in-line. Do NOT assume any inline',
      'text will reach the user. If you have ANYTHING to say to the user —',
      'an answer, a question, a status update, an acknowledgement — it goes',
      'through `mcp__polygram-bridge__reply`. Period.',
      '',
      'This applies to every turn, including the first message after',
      '`/new` or `/reset`. Even a single-line "Hi" must be sent via the tool.',
      '',
      'Internal tool calls (Bash, Edit, Write, Read, etc.) are fine to use',
      'as normal — only the FINAL user-visible message needs to go through',
      'the reply tool.',
      '',
      '### Staying responsive on a long task',
      '',
      'The user cannot see you working — no live typing reaches them. For any task',
      'that takes more than a few seconds, send a SHORT status first via `reply`',
      '(it returns a `message_id`), then call `mcp__polygram-bridge__edit_message`',
      'with that `message_id` to update the SAME bubble as you make progress,',
      'finishing with the result. One evolving message beats silence or a flood of',
      'new ones.',
      '',
      'Write status in PLAIN, friendly language about what you are doing FOR THE',
      'USER — never tool names or mechanics. Say "Checking your config now…", not',
      '"Running Bash" or "Calling Read". If the final answer is long, send it as a',
      'fresh `reply` rather than an edit (an edit is one single message bubble).',
      '',
      // TEMPORARY mitigation (2026-06-08 Shumabit@UMI wedge): AskUserQuestion opens
      // a blocking TUI selection widget the channel can't answer → the session
      // parks until manually Esc'd. REMOVE this whole rule when the rich
      // question→Telegram-keyboard feature ships (see docs design); claude should
      // then use the native question tool again. Tracked so it isn't forgotten.
      '### Asking the user a question / offering choices — HARD RULE',
      '',
      'NEVER use the AskUserQuestion tool or any interactive menu / selection',
      'widget. They open a blocking terminal prompt the user on Telegram CANNOT',
      'see or navigate — it silently wedges the entire session until it is manually',
      'cleared. (Rich tap-to-answer choices are coming; until then this is a hard rule.)',
      '',
      'To ask a multiple-choice question, a confirmation, or yes/no, call the',
      '`mcp__polygram-bridge__ask` tool — it renders tap-to-answer inline buttons',
      '(supports multiSelect via `multiSelect:true` and a free-text answer via',
      '`allowOther:true`) and returns the user\'s selection(s) as the tool result.',
      'Prefer `ask` over a typed numbered list whenever you are offering choices.',
      '',
      '### Sending FILES (tracks, images, docs) to the user',
      '',
      'The `mcp__polygram-bridge__reply` tool takes an optional `files` array of',
      'absolute paths. This is the ONLY way to send a file. Do NOT use Bash,',
      'curl, the Telegram Bot API, or polygram-ipc to send files — those fail.',
      '',
      ...(this.attachmentStagingDir ? [
        `To send a file: COPY it into the staging dir \`${this.attachmentStagingDir}\`,`,
        'then call reply with its absolute path, e.g.:',
        `  reply(chat_id="<id>", text="Here's the track", files=["${this.attachmentStagingDir}/track.flac"])`,
        'polygram auto-deletes staged files after the turn — you do not need to clean up.',
        'You may also send directly from the agent workspace (cwd); other paths are rejected.',
      ] : [
        'Copy the file somewhere under your workspace (cwd) and pass its absolute',
        'path in `files`. Paths outside the workspace are rejected for safety.',
      ]),
      '',
      `Max file size for sending: ${Math.round(this.maxOutboundFileBytes / (1024 * 1024))} MB. ` +
        'For larger lossless audio, convert to FLAC/MP3 under the limit first, ' +
        'or tell the user it exceeds the limit. Images go as photos; everything ' +
        'else as documents.',
    ].join('\n'));

    // Parity audit P6: honor isolateUserConfig — mirrors tmux pattern at
    // lib/process/tmux-process.js:502-505,543-546. Channels ALWAYS uses
    // --strict-mcp-config (the bridge requires it), so the MCP half is
    // already isolated. The settings half (--setting-sources project,local)
    // drops ~/.claude/settings.json — only useful when explicitly requested.
    const isolateUserConfig = topicConfig?.isolateUserConfig
      || opts.chatConfig?.isolateUserConfig
      || opts.isolateUserConfig;
    if (isolateUserConfig) {
      claudeArgs.push('--setting-sources', 'project,local');
    }

    // 0.12 Phase 1.2: hook ndjson injection via --settings. writeHookFiles
    // returns paths under ~/.polygram/<bot>/hooks/<sessionId>.{settings.json,ndjson}.
    // Both files created with mode 0o600 (SEC-04). The command string in
    // settings.json shell-quotes both paths (SEC-03 — handles HOME with spaces).
    // _hookNdjsonPath stored for _armHookTail (Phase 1.3) and removeHookFiles
    // on kill.
    const { settingsPath: hookSettingsPath, ndjsonPath: hookNdjsonPath } = writeHookFiles({
      botName: this.botName,
      sessionId: this.claudeSessionId,
    });
    this._hookNdjsonPath = hookNdjsonPath;
    this._hookSettingsPath = hookSettingsPath;
    claudeArgs.push('--settings', hookSettingsPath);

    // --mcp-config MUST be last (variadic flag)
    claudeArgs.push('--mcp-config', this.mcpConfigPath);   // P0 #1: file path, not inline JSON

    // resolvedCwd was computed above (line ~375) for the --resume file-check.
    if (resolvedCwd) claudeArgs.unshift('--add-dir', resolvedCwd);

    // rc.5 (2026-05-25 shumorobot diagnosis): the launch cwd MUST be the
    // resolved topic/chat cwd, not just opts.cwd. claude's TUI indexes
    // session storage by current working directory — its session files
    // live under ~/.claude/projects/<cwd-with-dashes>/<session-id>.jsonl.
    // When polygram launched claude with cwd=process.cwd() (the daemon's
    // own working dir, e.g. ~/.polygram), `--resume <id>` looked in the
    // wrong projects dir and printed "No conversation found with session
    // ID: <id>" then exited clean — surfacing as "Process exited (code 0)"
    // immediately after the bridge briefly connected.
    //
    // Mirrors lib/process/tmux-process.js:488 + :659 — same resolution,
    // same fallback chain. The `--add-dir` flag is independent: it
    // declares an additional trusted-roots entry, NOT the launch dir.
    //
    // Real tmuxRunner.spawn signature: {name, cwd, command, args, envExtras, paneWidth}
    await this.runner.spawn({
      name: tmuxName,
      cwd: resolvedCwd || opts.cwd || process.cwd(),
      command: this.claudeBin,
      args: claudeArgs,
    });

    // Dialog handling (Phase 0 finding) — poll capture-pane and Enter through:
    //   1. workspace trust prompt (first-time cwd)
    //   2. dev-channel confirmation ("WARNING: Loading development channels")
    // Both fire before the channel is actually listening. We loop with a
    // bounded timeout, send Enter when we see the trigger string.
    await this._handleStartupDialogs(tmuxName);
  }

  /**
   * Dialog-handling extracted to lib/tmux/startup-gate.js (M1 follow-on).
   * Channels-specific triggers + ready signal are declared here; the loop
   * lives in the shared helper.
   */
  async _handleStartupDialogs(tmuxName) {
    await runStartupGate({
      runner: this.runner,
      tmuxName,
      triggers: [
        // Dev-channels confirmation — always fires under
        // --dangerously-load-development-channels.
        { name: 'dev-channels', regex: /WARNING: Loading development channels/i, key: 'Enter' },
        // Workspace trust prompt — fires on first-time cwd or untrusted. claude
        // 2.1.158 renders "Quick safety check: Is this a project you created or
        // one you trust? … ❯ 1. Yes, I trust this folder" (Enter confirms the
        // pre-selected "trust" option). The older "trust the files in this folder"
        // wording is kept for back-compat; both anchor on "trust … this folder".
        { name: 'trust',        regex: /trust (?:the files in )?this folder/i,    key: 'Enter' },
        // Review F#12: session-age "Resume from summary?" prompt — fires on
        // aged sessions (claude treats older session JSONLs differently).
        // Tmux backend dismisses with Enter at tmux-process.js:2637 onward;
        // mirror that here so an aged channels session doesn't hang the
        // handshake until CHANNELS_HANDSHAKE_TIMEOUT (15s) → dead chat
        // requiring manual /reset.
        { name: 'session-age',  regex: SESSION_AGE_PROMPT_RE, key: 'Enter' },
      ],
      readySignal: /Listening for channel messages from: server:polygram-bridge/i,
      timeoutCode: 'CHANNELS_DIALOG_TIMEOUT',
      // Progress-aware gate (shumorobot General incident 2026-05-30): a
      // cold spawn that's mid-download (runtime fetch, "24%" progress bar)
      // is genuinely working and must NOT be killed by the blind 30s
      // wall-clock. stallMs fails fast only when the pane is FROZEN; an
      // actively-changing pane (download bar, dialog nav) keeps resetting
      // the stall clock and rides out to the ready signal. deadlineMs stays
      // the absolute backstop. 30s of zero pane activity = genuinely wedged.
      // Stall = pane rendered then went static (genuinely wedged). 60s, not
      // 30s: some topics' TUIs cold-render slowly (Music ~45s, slow MCP
      // startup) — 30s was too tight and false-aborted them. Blank panes
      // don't arm the stall timer at all now (see runStartupGate), so this
      // only bounds a TUI that rendered and then truly hung.
      stallMs: this.startupGateStallMs ?? 60_000,
      deadlineMs: this.startupGateDeadlineMs ?? 180_000,
      logger: this.logger,
      label: `${this.label}:startup-gate`,
    });
  }

  // 0.12 Phase 1.6: TWO-handshake gate. The original implementation only
  // waited for `bridge-ready` (daemon-side: bridge subprocess connected to
  // daemon unix socket + sent hello + session_init). That left a ~50ms
  // window where the bridge was ready but claude hadn't finished
  // registering it as an MCP server, so push notifications (user_msg)
  // could be silently dropped by claude. Phase 0 cold-spawn probe measured
  // a 33% first-turn flake. Fix: also wait for `mcp-ready`, which the
  // bridge emits when claude sends its first ListToolsRequest — the
  // first signal claude has fully registered the bridge as an MCP server.
  //
  // Both waits resolve race-safe via state flags set in _createSocketServer
  // listeners (bridgeReady, mcpReady).
  _waitForBridgeHandshake() {
    const waitBridge = this.bridgeReady ? Promise.resolve() : new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`bridge handshake timeout (${this.handshakeTimeoutMs}ms)`);
        err.code = 'CHANNELS_HANDSHAKE_TIMEOUT';
        reject(err);
      }, this.handshakeTimeoutMs);
      this.once('bridge-ready', () => { clearTimeout(timer); resolve(); });
    });
    const waitMcp = this.mcpReady ? Promise.resolve() : new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`mcp-ready timeout (${this.mcpReadyTimeoutMs}ms) — bridge connected but claude never sent first ListToolsRequest`);
        err.code = 'CHANNELS_MCP_READY_TIMEOUT';
        reject(err);
      }, this.mcpReadyTimeoutMs);
      this.once('mcp-ready', () => { clearTimeout(timer); resolve(); });
    });
    return Promise.all([waitBridge, waitMcp]).then(() => undefined);
  }

  // ─── bridge protocol semantics ─────────────────────────────────────
  // Socket lifecycle + auth + schema validation are owned by ChannelsBridgeServer
  // (M1 refactor). This method handles ONLY the validated, post-auth messages
  // that the server emits as 'bridge-message'. session_init + bridge-ready are
  // handled by the server-event subscribers wired in _createSocketServer().

  _handleBridgeMessage(msg) {
    switch (msg.kind) {
      case 'tool':
        // Phase 1.5: hook PreToolUse is now the canonical 'tool-use' event
        // source (covers ALL tools, not just bridge-exposed ones). Previously
        // this emit fired for bridge tools (reply / react / edit_message)
        // ONLY, leaving internal tools (Bash / Read / Edit / Agent) invisible
        // to the reactor on the channels path — that's why HeartbeatReactor
        // existed. With hooks in place, drop this emit; the reactor sees
        // the bridge reply tool via PreToolUse(mcp__polygram-bridge__reply)
        // and treats it uniformly with other tool calls. The dispatch path
        // below still runs — it's how the reply actually reaches Telegram.
        this._dispatchToolCall(msg).catch(err => {
          this.logger.error?.(`[${this.label}] channels: tool dispatch failed: ${err.message}`);
        });
        break;

      case 'perm_req':
        // Canonical 'approval-required' shape — matches TmuxProcess emit signature
        // (lib/process/tmux-process.js:2877). polygram.js's existing onApprovalRequired
        // handler (lib/sdk/callbacks.js wired in polygram.js:2217) consumes this
        // shape unchanged and gets canUseTool + admin-card flow for free.
        //
        // Review P1 #13: toolInput MUST be a string for compatibility with
        // lib/tmux/tui-tool-input.js#normalizeTuiToolInput — that function coerces
        // non-string input to '' which produces a silently empty approval card.
        // We pass input_preview (the tool args as JSON truncated to 200 chars by
        // Claude Code) since it's the most useful single-line representation.
        // The `description` from the perm_req notification is folded into the
        // toolInput when distinct from the preview, so operators see both.
        this.emit('approval-required', {
          id: msg.request_id,
          toolName: msg.tool_name,
          toolInput: this._formatToolInputForApproval(msg.description, msg.input_preview),
          sessionId: this.claudeSessionId,
          backend: this.backend,
          // respond closure adapts the canonical 'allow'/'deny' verdict back to
          // the Channels protocol's permission notification. The `message` arg
          // (used by tmux's "deny with feedback") is dropped — Channels protocol
          // verdicts carry no feedback string.
          respond: (decision, _message) => {
            const behavior = decision === 'allow' ? 'allow' : 'deny';
            return this.respondToPermission(msg.request_id, behavior);
          },
        });
        break;

      case 'pong':
        // Review P1 #6: record pong timestamp; the watchdog (started in
        // _startPingLoop) checks this every 5s and declares the bridge dead
        // if 30s have passed without one.
        this.lastPongAt = Date.now();
        break;

      default:
        this.logger.warn?.(`[${this.label}] channels: unknown bridge msg.kind=${msg.kind}`);
    }
  }

  /**
   * Produce a STRING toolInput for the canonical 'approval-required' payload.
   * normalizeTuiToolInput (consumed by polygram.js's canUseTool plumbing)
   * expects a string and coerces objects to '' — which makes the admin-card
   * empty. We prefer `input_preview` (Claude's truncated tool-args JSON), and
   * if `description` adds information not already in the preview, append it
   * after a separator for the operator's benefit.
   *
   * @param {string} description
   * @param {string} inputPreview
   * @returns {string}
   */
  _formatToolInputForApproval(description, inputPreview) {
    const desc = typeof description === 'string' ? description.trim() : '';
    const prev = typeof inputPreview === 'string' ? inputPreview.trim() : '';
    if (desc && prev && desc !== prev && !prev.includes(desc) && !desc.includes(prev)) {
      return `${prev}\n— ${desc}`;
    }
    return prev || desc || '';
  }

  /**
   * Review F#16: stable dedup key for content-based deduplication of reply
   * tool calls. We hash (chat_id || text) so identical text to different chats
   * never collides. SHA-256 truncated to 32 hex chars is plenty for collision
   * resistance within the 60s window.
   */
  _buildContentDedupKey(chatId, text) {
    return `${chatId}::${crypto
      .createHash('sha256')
      .update(text, 'utf8')
      .digest('hex')
      .slice(0, 32)}`;
  }

  async _dispatchToolCall(msg) {
    const args = msg.args || {};

    // rc.10 diagnostic: surface every inbound tool call BEFORE any dedup /
    // rate-limit / chat-id-mismatch path. Live shumorobot 2026-05-26 23:44
    // observed 3+ "Called polygram-bridge" entries in the TUI pane with
    // ZERO OUT messages delivered to TG and zero warn-level diagnostics —
    // need to see args.chat_id / args.turn_id to know whether claude is
    // calling reply with empty text, wrong chat_id, or something else.
    // L13: root-caused — demoted to debug and DROPPED text_head. Logging
    // the first 80 chars of every reply at warn level leaked private chat
    // content / file excerpts / secrets into the default log sink,
    // unconditionally. name/chat_id/turn_id/text_len diagnose dispatch
    // without exposing message content.
    this.logger.debug?.(
      `[${this.label}] channels: tool-call name=${msg.name} ` +
      `chat_id=${JSON.stringify(args.chat_id)} ` +
      `turn_id=${JSON.stringify(args.turn_id)} ` +
      `text_len=${typeof args.text === 'string' ? args.text.length : 'non-string'}`,
    );

    // Review P1 #7: idempotency. If we've already ACK'd this tool_call_id,
    // re-ACK with the cached result rather than re-dispatching to Telegram.
    // Without this, Claude's reply-retry on isError (which can fire after a
    // slow ack timeout) → double-send of the same TG message.
    if (msg.tool_call_id && this.recentToolCallIds.has(msg.tool_call_id)) {
      this.logger.warn?.(
        `[${this.label}] channels: duplicate tool_call_id=${msg.tool_call_id} — re-ACKing without dispatch`,
      );
      // 0.13: replay the cached message_id so a retried reply keeps its edit handle
      // (re-ACKing without it would null the handle → progressive status silently breaks).
      this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: true, message_id: this.recentToolCallResults.get(msg.tool_call_id) ?? null });
      return;
    }

    // 0.12 interactive questions: `ask` is a BLOCKING tool whose answer rides back
    // on a `question_answer` message (NOT tool_ack). Skip the reply-only paths
    // (content-dedup, rate-limit, the reply dispatcher) — just guard chat_id and
    // emit so polygram renders the keyboard; the answer is written later via
    // writeQuestionAnswer(). claude is now idle waiting on the result, so start a
    // keep-alive that resets the turn's idle ceiling (no tool hooks fire meanwhile).
    if (msg.name === 'ask') {
      if (this.chatId != null && args.chat_id != null && String(args.chat_id) !== String(this.chatId)) {
        this._writeToBridge({ kind: 'question_answer', tool_call_id: msg.tool_call_id, result: { cancelled: true, error: 'chat_id mismatch' } });
        return;
      }
      this._openQuestions.add(msg.tool_call_id);
      this._startQuestionKeepAlive();
      this.emit('question-asked', {
        sessionKey: this.sessionKey,
        chatId: this.chatId,
        threadId: this.threadId,
        turnId: args.turn_id || null,
        toolCallId: msg.tool_call_id,
        questions: Array.isArray(args.questions) ? args.questions : [],
        backend: this.backend,
      });
      return;
    }

    // Review F#16: secondary content-hash dedup catches retries that come in
    // with a NEW tool_call_id (Claude regenerates the id on each retry after
    // an isError ack). Window-based so legit repeat sends eventually pass.
    if (msg.name === 'reply' && typeof args.text === 'string' && args.chat_id != null) {
      const dedupKey = this._buildContentDedupKey(args.chat_id, args.text);
      const entry = this.recentContentHashes.get(dedupKey);   // { expiry, message_id }
      const nowDedup = Date.now();
      // Evict stale entries opportunistically (avoids unbounded growth).
      if (this.recentContentHashes.size > 64) {
        for (const [k, e] of this.recentContentHashes) {
          if (e.expiry < nowDedup) this.recentContentHashes.delete(k);
        }
      }
      if (entry && entry.expiry > nowDedup) {
        this.logger.warn?.(
          `[${this.label}] channels: duplicate content within ${this.contentDedupWindowMs}ms ` +
          `(new tool_call_id=${msg.tool_call_id}, hash=${dedupKey.slice(-12)}) — re-ACKing without dispatch`,
        );
        this._logEvent('channels-content-dedup-hit', {
          tool_call_id: msg.tool_call_id,
          chat_id: args.chat_id,
          window_ms: this.contentDedupWindowMs,
        });
        // 0.13: replay the ORIGINAL bubble's message_id so a retried identical reply
        // keeps its edit handle (the slow-ack-retry case progressive status targets).
        this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: true, message_id: entry.message_id ?? null });
        return;
      }
    }

    // Review P2 ADV-6: token-bucket rate limit. Refill tokens based on time
    // since last refill (1 token per (1000/rate) ms, capped at burst size).
    // If no token available, NACK the tool call so Claude sees the failure
    // and (hopefully) backs off.
    const now = Date.now();
    const refill = ((now - this.toolRateLastRefillAt) / 1000) * this.toolRatePerSec;
    if (refill >= 1) {
      this.toolRateTokens = Math.min(this.toolRateBurst, this.toolRateTokens + Math.floor(refill));
      this.toolRateLastRefillAt = now;
    }
    if (this.toolRateTokens < 1) {
      this.logger.warn?.(
        `[${this.label}] channels: tool rate limit exceeded (${this.toolRatePerSec}/s burst=${this.toolRateBurst}) — NACKing`,
      );
      this._writeToBridge({
        kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: false,
        error: `rate limit exceeded (${this.toolRatePerSec}/s)`,
      });
      return;
    }
    this.toolRateTokens -= 1;

    // P1 security: chat_id MUST match the session's registered chatId.
    if (this.chatId != null && String(args.chat_id) !== String(this.chatId)) {
      // Review P3 ADV-11: rate-limit the log (1 line per second per session)
      // so a 1000× mismatch storm doesn't fill warn logs. The NACK still fires
      // on every mismatched call — only the log is throttled.
      const now = Date.now();
      if (now - this._lastChatIdMismatchLogAt > 1000) {
        this._lastChatIdMismatchLogAt = now;
        this.logger.warn?.(
          `[${this.label}] channels: tool chat_id mismatch (got ${args.chat_id}, expected ${this.chatId}) — dropping`,
        );
      }
      this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: false, error: 'chat_id mismatch' });
      return;
    }

    let result;
    try {
      result = await this.toolDispatcher({
        sessionKey: this.sessionKey,
        chatId: this.chatId,
        threadId: this.threadId,
        toolName: msg.name,
        text: args.text,
        files: args.files,
        messageId: args.message_id,         // 0.13: edit_message target bubble
        sessionCwd: this.sessionCwd,        // P0 #2: dispatcher uses this to allowlist file roots
        maxOutboundFileBytes: this.maxOutboundFileBytes, // backend/chat-derived upload cap
      });
    } catch (err) {
      this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: false, error: err.message });
      return;
    }

    // 0.13: carry the delivered message_id back so the bridge hands it to claude
    // (reply → edit_message progressive status).
    this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: !!result?.ok, error: result?.error, message_id: result?.message_id });

    // P1 #7: remember the tool_call_id so duplicates re-ACK without dispatch.
    // Only cache on SUCCESS — failed calls should be retryable (transient TG
    // outage etc).
    if (result?.ok && msg.tool_call_id) {
      this.recentToolCallIds.add(msg.tool_call_id);
      this.recentToolCallResults.set(msg.tool_call_id, result.message_id ?? null);   // 0.13: for re-ACK replay
      this.recentToolCallOrder.push(msg.tool_call_id);
      // FIFO eviction at cap
      while (this.recentToolCallOrder.length > RECENT_TOOL_CALL_LIMIT) {
        const evicted = this.recentToolCallOrder.shift();
        this.recentToolCallIds.delete(evicted);
        this.recentToolCallResults.delete(evicted);
      }
    }

    // Review F#16: also record the (chat_id, content-hash) so a retry with a
    // NEW tool_call_id still dedups. TTL-based via expiry timestamp.
    if (result?.ok && msg.name === 'reply' && typeof args.text === 'string' && args.chat_id != null) {
      const dedupKey = this._buildContentDedupKey(args.chat_id, args.text);
      // 0.13: store the delivered message_id alongside the expiry so a deduped retry
      // can replay it (keeps claude's edit handle for progressive status).
      this.recentContentHashes.set(dedupKey, { expiry: Date.now() + this.contentDedupWindowMs, message_id: result.message_id ?? null });
    }

    // Review #16 + C9: only record the reply for pending-turn resolution when
    // the dispatcher actually delivered AND the text is a non-empty string.
    // Review P1 #4: route by turn_id (echoed from inbound <channel> meta) so
    // concurrent turns don't cross-attribute their replies. If Claude echoed a
    // turn_id, target that turn specifically; if not (older Claude / forgot),
    // fall back to the SINGLE pending turn if exactly one exists, else the
    // oldest pending — log a warning either way so we can audit drift.
    if (msg.name === 'reply' && result?.ok && typeof args.text === 'string' && args.text.length > 0) {
      this._recordReplyForPendingTurn(args.text, args.turn_id);
    }
  }

  /**
   * Route a reply text to the pending turn it belongs to.
   *
   * @param {string} text
   * @param {string|undefined} replyTurnId — echoed from Claude's reply tool args
   */
  _recordReplyForPendingTurn(text, replyTurnId) {
    let target = null;
    if (replyTurnId && this.pendingTurns.has(replyTurnId)) {
      // Canonical path: Claude echoed the turn_id we sent.
      target = this.pendingTurns.get(replyTurnId);
      target._turnId = replyTurnId;
    } else if (this.pendingTurns.size === 1) {
      // Single in-flight turn — unambiguous fallback.
      const [[onlyId, only]] = this.pendingTurns;
      target = only;
      target._turnId = onlyId;
      if (replyTurnId) {
        this.logger.warn?.(
          `[${this.label}] channels: reply turn_id=${replyTurnId} unknown but exactly 1 pending turn; routing to ${onlyId}`,
        );
      }
    } else if (this.pendingTurns.size > 1) {
      // Review F#3: multi-turn misattribution. Pre-fix this fell back to the
      // OLDEST pending turn, which cross-attributes Q2's answer to Q1's
      // source-msg whenever Claude omits turn_id (legitimate per the
      // inputSchema — `turn_id` is NOT in `required: [...]`). Q2 then hangs
      // until hardTimer (10 min) with no reply ever bound to it.
      //
      // Post-fix: DROP the orphan reply at the binding layer. The dispatcher
      // has ALREADY delivered the text to Telegram (the user sees it), so
      // dropping just means neither pending turn absorbs it spuriously.
      // Both pending turns then time out at their own quiet/hard timers with
      // no cross-attribution. Log + event so the orphan is visible in
      // forensics (we want to know if Claude is reliably echoing turn_id).
      const pendingIds = Array.from(this.pendingTurns.keys());
      this.logger.warn?.(
        `[${this.label}] channels: orphan reply has no/unknown turn_id ` +
        `(got ${JSON.stringify(replyTurnId)}); ${pendingIds.length} pending turns ` +
        `[${pendingIds.join(',')}]; dropping rather than misattributing (was: route to oldest)`,
      );
      this._logEvent('channels-orphan-reply-dropped', {
        reply_turn_id: replyTurnId || null,
        pending_count: pendingIds.length,
        pending_turn_ids: pendingIds,
        reply_len: text.length,
      });
      return;
    }
    // No pending turns at all → emit canonical 'autonomous-assistant-message'
    // event so polygram's autonomous-msg path (sdk/callbacks.js
    // onAutonomousAssistantMessage handler) routes it correctly. This is what
    // ScheduleWakeup / unsolicited replies look like on channels. Matches
    // SdkProcess emit shape (lib/process/sdk-process.js:304).
    //
    // Review F#22: the dispatcher has ALREADY delivered this text to Telegram
    // (the reply tool call ran in _dispatchToolCall before this fired).
    // polygram's onAutonomousAssistantMessage handler is backend-agnostic and
    // would re-deliver via tg(sendMessage). Flag it so the handler skips the
    // second send. Mirrors F#2's in-turn `result.alreadyDelivered` pattern;
    // missing the autonomous path was a regression caught in production
    // (OUT 1148 + 1149 identical-text double-delivery, same timestamp).
    if (!target) {
      this.emit('autonomous-assistant-message', {
        text,
        sessionId: this.claudeSessionId,
        backend: this.backend,
        alreadyDelivered: true,
      });
      return;
    }

    target.replies.push(text);
    // Review F#13: each reply is "activity" — reset the idle ceiling so a
    // 15-min legit turn (PDF analysis, multi-file refactor) replying every
    // minute doesn't get killed at the 10-min wall-clock. The absoluteTimer
    // still bounds runaways at 30 min.
    if (target.hardTimer) {
      clearTimeout(target.hardTimer);
      target.hardTimer = setTimeout(
        () => target._fireTimeout?.('idle'),
        this.turnTimeoutMs,
      );
    }
    // Review P1 #12: quiet-window resets forever when Claude streams chatty
    // progress replies (`reading…`, `analyzing…`) every ~1s → user sees 10min
    // hang. After N reply tool calls in a single turn, resolve immediately on
    // the NEXT reply without waiting for the quiet window. N defaults to 20
    // which is plenty for normal multi-message replies but caps runaway chains.
    target.replyCount = (target.replyCount || 0) + 1;
    if (target.quietTimer) clearTimeout(target.quietTimer);
    if (target.replyCount >= this.maxRepliesPerTurn) {
      // Skip the quiet-window — resolve right away with whatever we've got.
      this.logger.warn?.(
        `[${this.label}] channels: ${target.replyCount} replies in single turn — resolving immediately (cap=${this.maxRepliesPerTurn})`,
      );
      this._resolveTurn(target._turnId);
    } else {
      target.quietTimer = setTimeout(() => this._resolveTurn(target._turnId), this.turnQuietMs);
    }
  }

  /**
   * Keep a turn alive while claude is still TOOL-working (2026-06-08 Shumabit@UMI
   * WA-topic incident). The per-turn reply-quiet window (`quietTimer`, armed in
   * _recordReplyForPendingTurn) is reset ONLY by reply tool calls. So a turn that
   * replied and then kept working with NON-reply tools — claude read a follow-up
   * screenshot, ran a Bash API check, then replied again 90s later, all inside ONE
   * claude turn (no Stop hook until the very end) — resolved on the reply-quiet
   * window WHILE claude was still active. Its reactor + typing tore down at the
   * premature resolve, and the late reply fell through to the orphan
   * autonomous-assistant-message path (no pending turn).
   *
   * claude's Stop hook is the AUTHORITATIVE turn-end; until it lands, a PreToolUse/
   * PostToolUse hook means claude is still working — so push the reply-quiet window
   * (and the idle ceiling) out. The absoluteTimer (30-min runaway cap) is left
   * untouched as the hard backstop, and Stop still resolves normally. Turns that
   * reply then truly stop (no intervening tool hooks) are unaffected — there's no
   * tool activity to extend on.
   */
  _extendQuietOnToolActivity() {
    for (const [turnId, pending] of this.pendingTurns) {
      if (pending._stopGracePending) continue;   // already finalizing — don't revive
      // Idle ceiling: tool activity IS activity (mirrors the per-reply reset at
      // _recordReplyForPendingTurn so a long tool-heavy turn isn't idle-killed).
      if (pending.hardTimer) {
        clearTimeout(pending.hardTimer);
        pending.hardTimer = setTimeout(() => pending._fireTimeout?.('idle'), this.turnTimeoutMs);
      }
      // Reply-quiet window: only armed AFTER the first reply — that's exactly the
      // post-reply-still-tooling case this fixes.
      if (pending.quietTimer) {
        clearTimeout(pending.quietTimer);
        pending.quietTimer = setTimeout(() => this._resolveTurn(turnId), this.turnQuietMs);
      }
    }
  }

  // 0.12 Phase 1.7 (Finding 0.1.A): two-step turn resolution.
  //   _resolveTurn — entry point called by channel-result OR quiet-window
  //                  expiry. Schedules a stopGraceMs window during which
  //                  we wait for the Stop hook to land, then calls
  //                  _finalizeTurn. If Stop's last_assistant_message is
  //                  non-empty AND the turn has no reply-tool text, we
  //                  use it as fallback (rc.41 H4 pattern from tmux).
  //   _finalizeTurn — synchronous finalize. Same body the old
  //                   _resolveTurn had; no behavior change.
  _resolveTurn(turnId) {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) return;
    // Re-entrancy guard: a quiet-window expiry can fire alongside a Stop
    // hook; both call _resolveTurn. The second call no-ops.
    if (pending._stopGracePending) return;
    pending._stopGracePending = true;

    // 0.12 Phase 1.7: the turn is conceptually DONE — we're just waiting
    // for Stop hook to land for the text-fallback rescue. Cancel the
    // turn-timeout / quiet / absolute timers so they can't reject the
    // pending while we're in grace. The grace timer itself caps the
    // wait at stopGraceMs.
    if (pending.quietTimer)    { clearTimeout(pending.quietTimer);    pending.quietTimer = null; }
    if (pending.hardTimer)     { clearTimeout(pending.hardTimer);     pending.hardTimer = null; }
    if (pending.absoluteTimer) { clearTimeout(pending.absoluteTimer); pending.absoluteTimer = null; }

    const finalize = () => {
      this.off('stop-hook', onStop);
      pending._stopGracePending = false;
      this._finalizeTurn(turnId);
    };
    const onStop = (info) => {
      // Finding 0.12-M1: the Stop hook carries NO turn_id, and a single
      // global 'stop-hook' emission fires EVERY per-turn onStop listener.
      // When more than one turn is in stop-grace we cannot attribute this
      // Stop (or its last_assistant_message) to a specific turn — the
      // pre-fix code let one Stop finalize all grace-pending turns and
      // cross-attribute one turn's text to another (the exact class the
      // F#3 reply routing prevents). Mirror that drop-rather-than-
      // misattribute discipline: only consume the Stop when exactly ONE
      // turn is in grace; otherwise ignore it and let each turn finalize
      // on its own grace timer (each keeps its own reply text).
      let graceCount = 0;
      for (const p of this.pendingTurns.values()) if (p._stopGracePending) graceCount++;
      if (graceCount !== 1) return;
      pending._stopHookData = info;
      clearTimeout(pending._stopGraceTimer);
      pending._stopGraceTimer = null;
      finalize();
    };
    // L5: stash the closure so teardown paths that bypass Process.kill()'s
    // removeAllListeners (bridge-disconnect drain, resetSession) can off it.
    pending._onStop = onStop;
    pending._stopGraceTimer = setTimeout(finalize, this.stopGraceMs);
    // unref so a never-fired grace doesn't pin the event loop. In tests
    // where a CliProcess is created, send() is called, then the test
    // exits without explicitly killing the proc, the grace timer's
    // 2s wait would otherwise keep the node:test runner alive and
    // surface as "Promise resolution is still pending but the event
    // loop has already resolved" at the file-suite level. Production
    // never reaches this code path without a corresponding kill or
    // turn completion, so unref is safe.
    pending._stopGraceTimer.unref?.();
    this.on('stop-hook', onStop);
  }

  _finalizeTurn(turnId) {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) return;
    this.pendingTurns.delete(turnId);
    // Review P1 #14: pop the matching pendingQueue entry too so downstream
    // pm callbacks (sdk/callbacks.js context lookup) see a clean queue.
    const qIdx = this.pendingQueue.findIndex(e => e.turnId === turnId);
    if (qIdx >= 0) this.pendingQueue.splice(qIdx, 1);
    if (pending.quietTimer) clearTimeout(pending.quietTimer);
    if (pending.hardTimer) clearTimeout(pending.hardTimer);
    if (pending.absoluteTimer) clearTimeout(pending.absoluteTimer);
    if (pending._stopGraceTimer) clearTimeout(pending._stopGraceTimer);
    const hadReplyToolCalls = pending.replies.length > 0;
    let text = pending.replies.join('\n\n');
    // 0.12 Phase 1.7 fallback: if no reply tool calls landed (claude ended
    // the turn without calling mcp__polygram-bridge__reply), use the Stop
    // hook's last_assistant_message as the text. Same rescue pattern rc.41
    // H4 uses on tmux backend when JSONL stream is broken.
    if (!text && pending._stopHookData?.lastAssistantMessage) {
      text = pending._stopHookData.lastAssistantMessage;
      this.logger.warn?.(`[${this.label}] cli: turn finalized via stop-hook fallback (no reply tool call); text_len=${text.length}`);
    }
    const duration = Date.now() - pending.startedAt;
    // Review AC4: cost=null + metrics-tokens=null signal "unmeasured-subscription"
    // (channels protocol doesn't expose per-turn cost or token breakdowns).
    // Downstream billing aggregations should SKIP null entries rather than
    // averaging them as $0. The plain 0 we used before caused channels traffic
    // to appear free in dashboards.
    const result = {
      text,
      // Review F#2: when claude used reply tool calls, the dispatcher ALREADY
      // delivered that text to Telegram incrementally — polygram.js must
      // short-circuit its deliverReplies branch or every turn delivers twice.
      // BUT a turn finalized via the Stop fallback (no reply tool calls — the
      // stuck-turn case) has delivered NOTHING; marking it alreadyDelivered
      // would resolve the turn silently and the user still sees nothing. So
      // only claim already-delivered when reply tool calls actually fired.
      alreadyDelivered: hadReplyToolCalls,
      sessionId: this.claudeSessionId,
      cost: null,             // Channels protocol doesn't expose per-turn cost
      duration,
      error: null,
      metrics: {
        inputTokens: null,
        outputTokens: null,
        cacheCreationTokens: null,
        cacheReadTokens: null,
        numAssistantMessages: pending.replies.length,
        numToolUses: null,
        resultSubtype: 'success',
      },
    };
    this.inFlight = this.pendingTurns.size > 0;
    pending.resolve(result);
    this.emit('result', { subtype: 'success' }, { streamText: text });
    this.emit('idle');
    // File-send staging auto-purge (your choice — no "claude must delete").
    // Once the LAST turn settles, wipe the staging dir's contents so files
    // claude copied in to send don't accumulate on disk across turns. Only
    // when fully idle, so a file staged for a still-pending concurrent turn
    // isn't yanked mid-send.
    if (this.pendingTurns.size === 0) this._purgeStagingDir();
  }

  /**
   * Empty the per-session file-send staging dir (keep the dir itself).
   * Best-effort; never throws. Called when the session goes idle and on kill.
   */
  _purgeStagingDir() {
    if (!this.attachmentStagingDir) return;
    let entries;
    try { entries = fs.readdirSync(this.attachmentStagingDir); }
    catch { return; }
    for (const name of entries) {
      try { fs.rmSync(path.join(this.attachmentStagingDir, name), { recursive: true, force: true }); }
      catch { /* best-effort */ }
    }
  }

  // ─── public Process API ──────────────────────────────────────────

  async send(prompt, opts = {}) {
    if (this.closed) {
      // Parity P21: PROCESS_CLOSED code for cross-backend symmetry.
      const err = new Error('CliProcess: send on closed instance');
      err.code = 'PROCESS_CLOSED';
      throw err;
    }
    if (!this.bridgeReady) throw new Error('CliProcess: bridge not ready');
    if (typeof prompt !== 'string') throw new TypeError('CliProcess.send: prompt must be string');

    // Parity P2 + P14: queueCap enforcement. Same cap as SDK/tmux (50).
    // Drop oldest pending and emit 'queue-drop' so observers see overflow,
    // mirroring sdk-process.js:594 + tmux-process.js:3176.
    if (this.pendingTurns.size >= this.queueCap) {
      const [oldestId, oldest] = this.pendingTurns.entries().next().value;
      this.pendingTurns.delete(oldestId);
      const qIdx = this.pendingQueue.findIndex(e => e.turnId === oldestId);
      if (qIdx >= 0) this.pendingQueue.splice(qIdx, 1);
      if (oldest.quietTimer) clearTimeout(oldest.quietTimer);
      if (oldest.hardTimer) clearTimeout(oldest.hardTimer);
      if (oldest.absoluteTimer) clearTimeout(oldest.absoluteTimer);
      const dropErr = new Error('queue overflow — oldest pending evicted');
      dropErr.code = 'QUEUE_OVERFLOW';
      try { oldest.reject(dropErr); } catch {}
      this.emit('queue-drop', { reason: 'overflow', queueCap: this.queueCap, sessionId: this.claudeSessionId, backend: this.backend });
      this._logEvent('queue-overflow-drop', { queueCap: this.queueCap });
    }

    const turnId = crypto.randomUUID();
    this.inFlight = true;

    // Review P1 #14: populate pendingQueue with the per-turn context so
    // polygram's SDK callback path (lib/sdk/callbacks.js:145+) can find the
    // streamer/reactor/sourceMsgId via `entry.pendingQueue[0].context`. Without
    // this, channels chats have no Telegram live-edit, no per-msg reactor
    // chains, no subagent announce — silent UX regression vs SDK/tmux.
    //
    // pendingQueue is the Process base-class array (lib/process/process.js:70).
    // SdkProcess reads context.{streamer,reactor,sourceMsgId} per-turn from
    // this array, then shifts it on turn-end. We mirror that lifecycle.
    const queueEntry = {
      turnId,                 // ours — for matching on _resolveTurn
      context: opts.context || {},
      // pm-interface PmSpawnContext shape — defensive defaults; the only
      // consumers (sdk/callbacks.js) read .context.* so the rest is fine.
    };
    this.pendingQueue.push(queueEntry);

    this.emit('thinking');

    return new Promise((resolve, reject) => {
      // Review F#13: hardTimer is now idle-resetting (resets on each reply
      // in _recordReplyForPendingTurn — was: fixed 10-min wall-clock).
      // Added absoluteTimer as the true wall-clock ceiling at 30 min so a
      // legitimate 15-min "replies every 60s" turn isn't killed mid-stream
      // while still bounding runaways.
      const fireTimeout = (reason) => {
        if (!this.pendingTurns.has(turnId)) return;
        const pending = this.pendingTurns.get(turnId);
        this.pendingTurns.delete(turnId);
        const idx = this.pendingQueue.findIndex(e => e.turnId === turnId);
        if (idx >= 0) this.pendingQueue.splice(idx, 1);
        if (pending.quietTimer) clearTimeout(pending.quietTimer);
        if (pending.hardTimer) clearTimeout(pending.hardTimer);
        if (pending.absoluteTimer) clearTimeout(pending.absoluteTimer);
        if (pending._stopGraceTimer) clearTimeout(pending._stopGraceTimer);
        this.inFlight = this.pendingTurns.size > 0;
        const turnTimeoutMs = reason === 'absolute' ? this.turnAbsoluteMs : (opts.maxTurnMs || this.turnTimeoutMs);
        this.emit('turn-timeout', {
          reason,
          turnTimeoutMs,
          sessionId: this.claudeSessionId,
          backend: this.backend,
        });
        this._logEvent('turn-timeout', { turnTimeoutMs, reason });
        this.emit('idle');
        const err = new Error(`turn timeout (${turnTimeoutMs}ms, reason=${reason})`);
        err.code = 'TURN_TIMEOUT';
        reject(err);
      };
      const pending = {
        resolve, reject,
        replies: [],
        quietTimer: null,
        // hardTimer = idle ceiling. Resets on each reply in
        // _recordReplyForPendingTurn so a chatty turn (replies every 60s)
        // doesn't get killed at 10 min wall-clock.
        hardTimer: setTimeout(() => fireTimeout('idle'), opts.maxTurnMs || this.turnTimeoutMs),
        // absoluteTimer = wall-clock ceiling. Does NOT reset. Bounds true
        // runaways. 30 min default — high enough that legitimate
        // multi-step refactors complete, low enough to catch infinite
        // chatter.
        absoluteTimer: setTimeout(() => fireTimeout('absolute'), this.turnAbsoluteMs),
        // Review F#13: attach fireTimeout so _recordReplyForPendingTurn can
        // reset the idle timer (creates a fresh setTimeout with the same
        // reject closure).
        _fireTimeout: fireTimeout,
        startedAt: Date.now(),
      };
      this.pendingTurns.set(turnId, pending);

      // Review F#18: bridge-disconnect TOCTOU. The bridgeReady check at
      // top of send() can race the bridge socket close. If the bridge
      // dies between check and write, _writeToBridge silently no-ops (it
      // returns early on !this.bridgeServer). Without this guard, the
      // pending entry sits with no live bridge until hardTimer (10 min).
      // Pass the actual write result back and reject immediately on
      // failure so the caller sees a fast, code-tagged error.
      const wrote = this._writeToBridge({
        kind: 'user_msg',
        turn_id: turnId,
        text: prompt,
        chat_id: this.chatId,
        user: opts.context?.user || '',
        msg_id: opts.context?.sourceMsgId || '',
      });
      if (!wrote) {
        this.pendingTurns.delete(turnId);
        const qIdx = this.pendingQueue.findIndex(e => e.turnId === turnId);
        if (qIdx >= 0) this.pendingQueue.splice(qIdx, 1);
        if (pending.hardTimer) clearTimeout(pending.hardTimer);
      if (pending.absoluteTimer) clearTimeout(pending.absoluteTimer);
        this.inFlight = this.pendingTurns.size > 0;
        const err = new Error('bridge disconnected during send');
        err.code = 'BRIDGE_DISCONNECTED';
        this._logEvent('channels-send-toctou-disconnect', { turnId });
        reject(err);
      }
    });
  }

  async interrupt() {
    if (this.closed) return;
    if (!this.tmuxSession) return;
    // tmux SIGINT — hard interrupt for the running turn.
    try {
      await this.runner.sendControl(this.tmuxSession, 'C-c');
    } catch (err) {
      this.logger.warn?.(`[${this.label}] channels: interrupt sendControl failed: ${err.message}`);
    }
    this._interruptedAt = Date.now();
    this.emit('interrupt-applied', { backend: this.backend });
    this._logEvent('interrupt-applied', {});

    // Review P3 C8: after Ctrl-C, Claude may or may not call reply with an
    // "I was interrupted" message. If it doesn't (5s grace), resolve pending
    // turns with subtype 'interrupted' instead of letting them wait the full
    // 10-min hardTimer. The grace window is reset if a new interrupt fires.
    if (this._interruptGraceTimer) clearTimeout(this._interruptGraceTimer);
    this._interruptGraceTimer = setTimeout(() => {
      let resolvedAny = false;
      for (const [turnId, pending] of this.pendingTurns) {
        // Synthesize an interrupted resolution: empty text, 'interrupted' subtype.
        if (pending.quietTimer) clearTimeout(pending.quietTimer);
        if (pending.hardTimer) clearTimeout(pending.hardTimer);
      if (pending.absoluteTimer) clearTimeout(pending.absoluteTimer);
        this.pendingTurns.delete(turnId);
        const qIdx = this.pendingQueue.findIndex(e => e.turnId === turnId);
        if (qIdx >= 0) this.pendingQueue.splice(qIdx, 1);
        try {
          pending.resolve({
            text: pending.replies.join('\n\n'),
            sessionId: this.claudeSessionId,
            cost: null,
            duration: Date.now() - pending.startedAt,
            error: null,
            metrics: {
              inputTokens: null, outputTokens: null,
              cacheCreationTokens: null, cacheReadTokens: null,
              numAssistantMessages: pending.replies.length,
              numToolUses: null,
              resultSubtype: 'interrupted',
            },
          });
          resolvedAny = true;
        } catch {}
      }
      this.inFlight = this.pendingTurns.size > 0;
      this._interruptGraceTimer = null;
      // Step E: emit 'idle' so reaction-cyclers stop. The synthetic resolve
      // above doesn't take the _resolveTurn path, so without this emit a
      // HeartbeatReactor would keep cycling after the interrupt completed.
      if (resolvedAny) this.emit('idle');
    }, this.interruptGraceMs);
    this._interruptGraceTimer.unref?.();
  }

  /**
   * Is claude actually still working, regardless of the resolved-turn flag?
   *
   * "Stop" incident (shumorobot Music, 2026-05-31 13:08): the channels
   * backend resolves a turn on the quiet-window after claude's last reply
   * tool call (inFlight → false), but claude can keep working afterwards
   * (a subagent, a long Bash). The abort handler keyed its ack on inFlight
   * alone, so "Stop" said "Nothing to stop" one second after the bot said
   * "On it — downloading…" while a subagent churned.
   *
   * The TUI prints "esc to interrupt" (STREAMING_HINT_RE) continuously
   * whenever claude is busy — capture-pane is the truthful signal, the
   * channels analog of the (deleted) tmux hasBackgroundShell() probe.
   *
   * Returns a STRUCTURED probe (not just a boolean) so the abort path can
   * log the raw signals — pane tail + flags — to the events DB. That lets
   * us later characterize which states the heuristic gets right/wrong and
   * refine it (e.g. add signals beyond the esc-hint) without guessing.
   *
   * Never throws — a failed capture returns captured:false, busy:false.
   *
   * @returns {Promise<{busy:boolean, streaming:boolean, inFlight:boolean,
   *   pendingTurns:number, captured:boolean, paneTail:(string|null)}>}
   */
  async probeBusyState() {
    const base = {
      busy: false, streaming: false, backgroundShell: false, shellCount: 0,
      inFlight: this.inFlight, pendingTurns: this.pendingTurns.size,
      captured: false, paneTail: null,
    };
    if (this.closed || !this.tmuxSession || typeof this.runner?.captureWide !== 'function') {
      return base;
    }
    let pane;
    try {
      pane = await this.runner.captureWide(this.tmuxSession);
    } catch (err) {
      this.logger.warn?.(`[${this.label}] channels: probeBusyState captureWide failed: ${err.message}`);
      return base;
    }
    if (!pane) return base;
    const streaming = STREAMING_HINT_RE.test(pane);
    // Background-shell count from the TUI mode line. Match only the captured
    // TAIL (the mode line lives at the bottom of the viewport) so a `· N shell ·`
    // string scrolled off into history can't trip a stale false-positive — see
    // BACKGROUND_SHELL_RE. A detached `run_in_background` Bash that outlived its
    // turn shows here even while claude is idle and not streaming.
    const m = pane.slice(-400).match(BACKGROUND_SHELL_RE);
    const shellCount = m ? parseInt(m[1], 10) : 0;
    const backgroundShell = shellCount > 0;
    return {
      ...base,
      // `busy` stays streaming-only — it is the abort path's "is claude working a
      // turn" signal and must not change behaviour. Background-shell liveness is a
      // separate axis the stall-watchdog reads via `backgroundShell`/`shellCount`.
      busy: streaming,
      streaming,
      backgroundShell,
      shellCount,
      captured: true,
      paneTail: pane.slice(-200),
    };
  }

  /** Boolean shorthand for probeBusyState().busy (abort-path convenience). */
  async isBusy() {
    const { busy } = await this.probeBusyState();
    return busy;
  }

  /**
   * Does this session have a detached background shell running RIGHT NOW — a
   * `run_in_background` Bash that may have outlived its turn? Thin probe over
   * probeBusyState's background-shell signal; the stall-watchdog's input.
   * @returns {Promise<{live:boolean, count:number}>}
   */
  async hasLiveBackgroundWork() {
    const { backgroundShell, shellCount } = await this.probeBusyState();
    return { live: backgroundShell, count: shellCount };
  }

  /**
   * LRU eviction pin (0.12.0 spec). Cached read of `_bgWorkSince` — the idle bg-work
   * watchdog state maintained by `_pollBackgroundWork` on the ≤5s pong tick. Non-null ⟺ a
   * detached background shell has been observed while idle. No time cap: a job that runs for
   * hours stays pinned (elapsed time can't tell "slow-but-progressing" from "stuck"). Cheap,
   * sync — safe to call from `_evictLRU`.
   * @returns {boolean}
   */
  hasActiveBackgroundWork() {
    return this._bgWorkSince !== null;
  }

  /**
   * Stall-watchdog for detached background work (0.12.0 background-work
   * lifecycle, shumorobot Music 7h frozen-Chrome download). Runs on the
   * pongWatchdog 5s tick but ONLY while the session is IDLE (pendingTurns===0) —
   * the mirror of _pollMidTurnDialogs, which only runs DURING turns. When a
   * `run_in_background` Bash outlives its turn and keeps running while claude is
   * idle for > bgWorkStallMs, nothing tells the agent or user whether it's
   * progressing or stuck. One read-only self-check re-invokes the agent to
   * diagnose — via `fireUserMessage`, NOT `injectUserMessage` (which no-ops when
   * !inFlight, the exact idle state here). Read-only framing matters: the agent
   * runs bypassPermissions, so an open-ended "fix it" could background another
   * hung shell unattended.
   *
   * Exactly one self-check per continuous background-work window (capped by
   * `_bgWorkEscalations`); the window resets only when the shell count returns to
   * 0. Never throws — swallows its own errors so the pong watchdog stays clean.
   */
  async _pollBackgroundWork() {
    if (this.closed || !this.bridgeReady) return;
    // Only watch while idle. An active turn means the agent is engaged
    // (_pollMidTurnDialogs owns that path). Crucially we do NOT reset the clock
    // here — the same shell is still running, so the window persists across a
    // brief self-check turn rather than restarting and re-pinging every window.
    if (this.pendingTurns.size > 0) return;
    let live = false;
    let count = 0;
    try {
      ({ live, count } = await this.hasLiveBackgroundWork());
    } catch (err) {
      this.logger.warn?.(`[${this.label}] channels: bg-work probe failed: ${err.message}`);
      return;
    }
    if (!live) {
      if (this._bgWorkSince !== null) {
        this._logEvent('cli-bg-work-cleared', { idle_ms: Date.now() - this._bgWorkSince });
        // Visibility: tear down the status indicator once work clears.
        if (this._bgWorkStatusShown) {
          this.emit('bg-work-status', { state: 'cleared' });
          this._bgWorkStatusShown = false;
        }
      }
      this._bgWorkSince = null;
      this._bgWorkEscalations = 0;
      return;
    }
    if (this._bgWorkSince === null) {
      // First idle observation of a live background shell — start the clock AND
      // raise the visibility indicator so a long job reads as working, not stuck.
      this._bgWorkSince = Date.now();
      this._bgWorkEscalations = 0;
      this._logEvent('cli-bg-work-detected', { shell_count: count });
      this.emit('bg-work-status', { state: 'running', count });
      this._bgWorkStatusShown = true;
      return;
    }
    const idleMs = Date.now() - this._bgWorkSince;
    if (idleMs < this.bgWorkStallMs || this._bgWorkEscalations >= 1) return;
    const mins = Math.max(1, Math.round(idleMs / 60000));
    const prompt =
      `⏳ A background job has been running ~${mins} min with no update. `
      + `Check its status and report whether it's progressing or stuck. `
      + `Do NOT start new work, re-run it, or kill anything — report only.`;
    const fired = this.fireUserMessage(prompt);
    this._bgWorkEscalations = 1;
    this._logEvent('cli-bg-work-stall-selfcheck', { idle_ms: idleMs, shell_count: count, fired });
  }

  async kill(reason = 'kill') {
    if (this.closed) return;
    // Parity P19: re-entry guard for concurrent kill() calls. Mirrors
    // tmux-process.js `_killing` Promise — second caller awaits the first's
    // teardown instead of early-returning into a half-cleaned state.
    if (this._killing) return this._killing;
    this._killing = this._doKill(reason);
    return this._killing;
  }

  // ─── Phase 1.3: hook ndjson tail wiring ────────────────────────────
  //
  // Hook events fire from claude (per --settings injection from Phase 1.2)
  // into ~/.polygram/<bot>/hooks/<sessionId>.ndjson via the
  // polygram-hook-append helper. We tail that file with LogTail's 50ms
  // poll + fs.watch hybrid (see lib/tmux/log-tail.js), parse each line via
  // hook-event-tail's normalizeHookEvent, and route to _handleHookEvent
  // which translates hook events into the Process EventEmitter surface
  // (tool-use / tool-result / subagent-start / subagent-done / result).
  //
  // Hook-tail is the canonical source of tool observability in CliProcess.
  // The bridge's tool-call message path (Phase 1.5) NO LONGER emits
  // 'tool-use' — hook PreToolUse is the sole source.

  _armHookTail() {
    if (!this._hookNdjsonPath) {
      this.logger.warn?.(`[${this.label}] _armHookTail: _hookNdjsonPath unset; hooks disabled. Phase 1.2 may have failed.`);
      return;
    }
    // Finding 0.12-M2: writeHookFiles opens the ndjson in APPEND mode
    // ('a') and never truncates, so on a --resume respawn the prior
    // session's hook lines are still on disk under the same path. Replaying
    // them re-drives the turn state machine from stale Stop/PreToolUse
    // events (a stale Stop can finalize the fresh turn). So skip existing
    // content when (and only when) this is a resumed session — the same
    // discipline the JSONL tail uses on --resume. A fresh spawn's ndjson is
    // empty, so skipExisting:false is correct there.
    this._hookTail = createHookTail({
      path: this._hookNdjsonPath,
      logger: this.logger,
      skipExisting: this._resumedSession === true,
    });
    this._hookTail.on('event', (ev) => {
      try {
        this._handleHookEvent(ev);
      } catch (err) {
        // rc.42 #2 mirror: never let a hook-event throw cascade into the
        // LogTail's line dispatcher and drop the rest of the batch.
        this.logger.error?.(`[${this.label}] _handleHookEvent threw: ${err.message}`);
      }
    });
    this._hookTail.on('error', (err) => {
      this.logger.warn?.(`[${this.label}] hook tail error: ${err.message}`);
      this.emit('hook-tail-error', { err: err.message });
    });
    this._hookTail.start();
  }

  /**
   * Hook event → Process event translation. See the plan's Reaction model
   * section for the canonical mapping.
   *
   * Subagent identity: PreToolUse with name='Agent' is synthesized into a
   * 'subagent-start' event carrying agent_type from tool_input. Paired
   * with SubagentStop → 'subagent-done' for full lifecycle.
   *
   * Unknown hook types pass through unchanged — reactor wiring (Phase 2)
   * decides what to do with them. Anchor 50 finding from 0.12 design
   * review: never silent-drop on schema drift.
   */
  _handleHookEvent(ev) {
    if (!ev || typeof ev !== 'object') return;

    // rc.16 observability: emit once when the FIRST hook event arrives for
    // this session, confirming the claude→ndjson→tail pipeline is actually
    // flowing. The 2026-06-02 stuck turn had a session whose hook ndjson was
    // 0 bytes — claude emitted no hooks polygram could see, so no Stop ever
    // arrived to finalize the turn. Without this signal that's invisible: a
    // turn that hangs with NO `cli-hook-stream-live` for its session means the
    // hook pipeline is dead for it (distinct from "Stop fired but wasn't
    // acted on", which `cli-turn-resolved-by-stop` now covers).
    if (!this._sawHookStream) {
      this._sawHookStream = true;
      this._logEvent('cli-hook-stream-live', {
        session_id: this.claudeSessionId,
        first_event: ev.type,
      });
    }

    // 0.12 Phase 1.8 (Finding 0.4.A): per-event lag measurement.
    // polygram_received_at_ms is stamped by the helper subprocess at write
    // time; subtracting from Date.now() gives the helper-write → tail-emit
    // round-trip we couldn't isolate from a single spike. Soak Phase 5
    // gates tag-out on median < 2s and p99 < 5s across the events DB.
    if (Number.isFinite(ev.receivedAtMs)) {
      const lagMs = Date.now() - ev.receivedAtMs;
      // L10: emit ONLY — the onHookLagSample callback owns the DB write
      // (CALLBACK_TO_EVENT → callbacks.js). Previously this ALSO wrote
      // directly via this.db.logEvent, double-persisting every sample and
      // inflating the Phase 1.8 soak-gate row count. Consistent with how
      // tool-result / subagent-start / subagent-done are handled (emit,
      // don't double-write).
      this.emit('hook-lag-sample', {
        hookEventName: ev.type,
        lagMs,
        toolName: ev.toolName || null,
        backend: this.backend,
      });
    }

    // 2026-06-08 (WA-topic incident): a tool hook means claude is STILL working,
    // so keep its turn(s) alive — the reply-quiet window must not resolve a turn
    // mid-work just because the last *reply* was a few seconds ago. See
    // _extendQuietOnToolActivity. Reply tool calls are handled separately (their
    // own reset in _recordReplyForPendingTurn); covering them here too is a no-op.
    if (ev.type === 'PreToolUse' || ev.type === 'PostToolUse') {
      this._extendQuietOnToolActivity();
    }

    switch (ev.type) {
      case 'UserPromptSubmit':
        this.emit('turn-start', {
          backend: this.backend,
          sessionId: this.claudeSessionId,
        });
        return;

      case 'PreToolUse': {
        // Phase 1.3: synthesize subagent-start from Agent PreToolUse so the
        // reactor can show a distinct subagent-specific reaction during long
        // subagent runs. agent_type lives in tool_input.subagent_type per
        // claude's Task-tool schema.
        if (ev.toolName === 'Agent') {
          const subagentType = ev.toolInput?.subagent_type
            || ev.toolInput?.agent_type
            || 'general-purpose';
          // Finding 0.12-M4: SubagentStop carries agent_id/agent_type but
          // NOT the originating Agent tool_use_id, so without help the
          // subagent-start/subagent-done rows share no JOIN key (the
          // documented soak query on $.tool_use_id returns zero rows).
          // Track the in-flight Agent tool_use_id keyed by subagent type so
          // the paired SubagentStop below can stamp it onto subagent-done.
          (this._pendingSubagentStarts ||= []).push({
            agentType: subagentType,
            toolUseId: ev.toolUseId,
          });
          this.emit('subagent-start', {
            agentType: subagentType,
            // PreToolUse for Agent carries no agent_id (set later on
            // SubagentStop). We still emit the start event so the reactor
            // can transition into SUBAGENT state immediately.
            toolUseId: ev.toolUseId,
            backend: this.backend,
          });
          return;
        }
        // Process-contract emit shape: (toolName) only — matches TmuxProcess
        // and the SDK callback signature (sessionKey, toolName, entry). A
        // separate 'tool-use-detail' event carries the richer payload for
        // downstream consumers that want input/agentId/etc.
        this.emit('tool-use', ev.toolName);
        this.emit('tool-use-detail', {
          name: ev.toolName,
          input: ev.toolInput,
          agentId: ev.agentId,
          agentType: ev.agentType,
          toolUseId: ev.toolUseId,
          backend: this.backend,
        });
        return;
      }

      case 'PostToolUse':
        this.emit('tool-result', {
          name: ev.toolName,
          durationMs: ev.durationMs,
          agentId: ev.agentId,
          agentType: ev.agentType,
          toolUseId: ev.toolUseId,
          isError: ev.toolResponse?.isError === true,
          backend: this.backend,
        });
        return;

      case 'SubagentStop': {
        // Finding 0.12-M4: recover the originating Agent tool_use_id so the
        // subagent-start/subagent-done pair is JOINable. Prefer a match on
        // agent type (correct for parallel subagents of different types);
        // fall back to the oldest pending start when types don't line up.
        let subagentToolUseId = null;
        const pendingStarts = this._pendingSubagentStarts;
        if (pendingStarts && pendingStarts.length) {
          let idx = pendingStarts.findIndex(s => s.agentType === ev.agentType);
          if (idx < 0) idx = 0;
          subagentToolUseId = pendingStarts.splice(idx, 1)[0]?.toolUseId ?? null;
        }
        this.emit('subagent-done', {
          agentType: ev.agentType,
          agentId: ev.agentId,
          durationMs: ev.durationMs,
          toolUseId: subagentToolUseId,
          backend: this.backend,
        });
        return;
      }

      case 'Stop': {
        // 0.12.0 Phase 1.7 (rc.16): Stop is the AUTHORITATIVE turn-end signal.
        const info = {
          stopHookActive: ev.stopHookActive,
          lastAssistantMessage: ev.lastAssistantMessage,
          backend: this.backend,
        };
        // Turns already resolving via a reply quiet-window consume this via
        // their per-turn onStop listener (the text-fallback rescue inside
        // _resolveTurn). Emit first so that path runs synchronously and any
        // grace-pending turn is finalized + removed before the check below.
        this.emit('stop-hook', info);

        // THE FIX (2026-06-02 stuck-turn): a turn that ended WITHOUT a reply
        // tool call has no quiet-window to fire _resolveTurn — pre-fix it hung
        // until the 30-min wall-clock backstop while the unknown-prompt
        // watchdog spun. Stop IS the turn-end; resolve the single in-flight
        // turn now (reply text if any, else last_assistant_message). After the
        // emit above, a grace-pending turn is already gone, so this only fires
        // for the no-reply case. Gated on exactly one in-flight turn — Stop
        // carries no turn_id, so we cannot attribute it when turns are
        // concurrent (the M1 cross-attribution hazard).
        if (this.pendingTurns.size === 1) {
          const [turnId, p] = [...this.pendingTurns.entries()][0];
          if (!p._stopGracePending) {
            p._stopHookData = info;
            this._logEvent('cli-turn-resolved-by-stop', {
              turn_id: turnId,
              reply_count: p.replies?.length || 0,
              via_text_fallback: (p.replies?.length || 0) === 0,
              session_id: this.claudeSessionId,
            });
            this._finalizeTurn(turnId);
          }
        } else if (this.pendingTurns.size > 1) {
          // Can't attribute Stop to one of several concurrent turns — surface
          // it so a turn that waited for its grace timer (instead of resolving
          // on Stop) is explained in the events DB.
          this._logEvent('cli-stop-unattributed', { pending_count: this.pendingTurns.size });
        }

        // 0.12.0-rc.13 proactive compaction warning: on turn-end, if enabled
        // for this chat and not already warned this climb, sample context
        // occupancy from the transcript and warn (propose /compact) BEFORE
        // claude auto-compacts mid-turn and detaches the bridge. Fire-and-
        // forget — transcript IO must never block the stop path.
        if (this.compactionWarn?.enabled && !this._compactionWarned && ev.transcriptPath) {
          this._maybeProactiveCompactionWarn(ev.transcriptPath);
        }
        return;
      }

      case 'PreCompact':
        // 0.12.0-rc.13: auto-compaction is the event that detaches the
        // channels MCP bridge mid-turn. Record it; and on the dangerous AUTO
        // case (manual /compact is the user's own deliberate action — never
        // nag), emit a reactive warning the chat layer posts. The proactive
        // warning (on Stop) tries to PREVENT this; this is the backstop.
        this._logEvent('cli-compaction-imminent', { trigger: ev.trigger });
        if (this.compactionWarn?.enabled && ev.trigger === 'auto') {
          this.emit('compaction-warn', {
            kind: 'reactive',
            trigger: 'auto',
            sessionId: this.claudeSessionId,
            backend: this.backend,
          });
        }
        return;

      case 'PostCompact':
        // Context just dropped — re-arm the proactive warn-once so the next
        // climb can warn again.
        this._compactionWarned = false;
        this._logEvent('cli-compaction-done', { trigger: ev.trigger });
        return;

      case 'Notification':
        // 0.12 Phase 4.5: hook Notification → admin approval card on
        // chats with non-bypass permissionMode. Anthropic documents
        // Notification as firing for two cases:
        //   (a) a tool needs operator permission, OR
        //   (b) claude has been idle long enough that the user has
        //       stopped paying attention.
        // We can only respond to (a). The Notification hook payload
        // carries `tool_name`/`tool_input` when it's a permission
        // request; both are null for (b). Gate on toolName presence.
        //
        // Under bypassPermissions (the default), claude doesn't fire
        // Notification for tool permissions at all — so this branch
        // is effectively unreachable for default chats. We add the
        // permissionMode guard belt-and-braces in case claude ever
        // changes that behavior. R11 (the send-keys response race
        // window) is documented in the risk register; soak metric
        // `permission-response-mismatch` tracks it.
        if (this.permissionMode === 'bypassPermissions') {
          this.emit('notification', { raw: ev.raw, backend: this.backend });
          return;
        }
        if (!ev.toolName) {
          // Idle-attention Notification; nothing for polygram to do.
          this.emit('notification', { raw: ev.raw, backend: this.backend });
          return;
        }
        // Hook Notification for permission has no native request_id — use
        // tool_use_id when present, else synthesize. The respond callback
        // sends "1" then Enter (approve) or "2" then Enter (deny) into
        // the tmux pane. tmux-runner's input lock guarantees atomicity
        // per session, but the race between hook fire and operator click
        // is documented R11 — best-effort.
        {
          const requestId = ev.toolUseId || `hook-notification-${Date.now()}`;
          const toolName = ev.toolName;
          // Finding #11 fix: pass the STRUCTURED tool_input through. makeCanUseTool
          // matches gated patterns via matchesAnyPattern, which reads
          // input.command (Bash) / input.url (WebFetch) — a formatted STRING
          // makes those undefined so a gated `Bash(rm *)` never matches and the
          // tool is allowed with NO approval card (silent gating bypass). The
          // hook Notification payload carries structured tool_input, so forward
          // it as-is; the approval card (approvalCardText) renders a structured
          // object fine — same shape the SDK canUseTool path already uses. Fall
          // back to the formatted-string preview only if claude sent no
          // structured tool_input (degenerate — tool needs perm but no input).
          const toolInput = (ev.toolInput && typeof ev.toolInput === 'object')
            ? ev.toolInput
            : this._formatToolInputForApproval(
                ev.prompt || null,
                typeof ev.toolInput === 'string' ? ev.toolInput : JSON.stringify(ev.toolInput || {}),
              );
          this.emit('approval-required', {
            id: requestId,
            toolName,
            toolInput,
            sessionId: this.claudeSessionId,
            backend: this.backend,
            // respond closure pipes the verdict back to claude via
            // tmux send-keys. claude's TUI permission prompt uses
            // "1" for accept, "2" for accept-always, "3" for deny.
            // We map verdicts: 'allow' → "1", 'deny' → "3".
            // Skipping "2" (always-allow) is deliberate — polygram
            // never wants per-session always-approve since that would
            // bypass future approval cards within the same session.
            respond: async (decision, _message) => {
              const key = decision === 'allow' ? '1' : '3';
              if (!this.tmuxSession || !this.runner?.sendControl) {
                this.logger.warn?.(
                  `[${this.label}] cli: respond cannot send-keys — tmuxSession=${!!this.tmuxSession} sendControl=${!!this.runner?.sendControl}`,
                );
                return;
              }
              try {
                await this.runner.sendControl(this.tmuxSession, key);
                await this.runner.sendControl(this.tmuxSession, 'Enter');
              } catch (err) {
                this.logger.warn?.(
                  `[${this.label}] cli: respond send-keys failed (${key}+Enter): ${err.message}`,
                );
                this._logEvent('cli-permission-respond-failed', {
                  request_id: requestId,
                  decision,
                  error: err.message,
                });
              }
            },
          });
        }
        return;

      case 'parse-error':
        // rc.42 #8 mirror: surface persistent hook-stream parse failures
        // so the soak can count them. Channel-protocol equivalent of the
        // tmux backend's hook-tail-error.
        this.emit('hook-parse-error', { error: ev.error, raw: ev.raw });
        return;

      case 'unknown':
        // 2.1.143-style schema drift would land here. Log + continue.
        this.logger.warn?.(`[${this.label}] unknown hook event: ${ev.raw?.hook_event_name}`);
        return;

      default:
        // Future event types added to KNOWN_EVENT_NAMES but not yet wired
        // here. Forward generically so callers can subscribe.
        this.emit('hook-event', ev);
        return;
    }
  }

  /**
   * Drain on unexpected bridge socket loss (claude crash, bridge crash,
   * EOF). Extracted from the inline 'bridge-disconnected' handler so the
   * teardown is testable and consistent with _doKill.
   *
   * Findings 0.12-L5 + L6: in addition to clearing the per-turn timers
   * and rejecting pendings (the original P1 #5 behavior), this now also
   * (L5) removes each turn's stop-hook listener — this drain does NOT go
   * through Process.kill()'s blanket removeAllListeners, so a turn torn
   * down mid-stop-grace would otherwise leak its onStop closure — and
   * (L6) clears _interruptGraceTimer, matching _doKill (a /stop verdict
   * landing just before the disconnect would otherwise leave a stray
   * timer on the dead instance).
   */
  _handleBridgeDisconnected(reason = 'socket-close') {
    this.bridgeReady = false;
    this.mcpReady = false;
    if (this.closed) return;
    this.logger.warn?.(`[${this.label}] channels: bridge disconnected unexpectedly (${reason})`);
    // L6: clear the interrupt grace timer alongside the rest of the lifecycle.
    if (this._interruptGraceTimer) {
      clearTimeout(this._interruptGraceTimer);
      this._interruptGraceTimer = null;
    }
    // P1 #5: drain pendingTurns immediately so hardTimers don't run 10min.
    for (const [, pending] of this.pendingTurns) {
      if (pending.quietTimer) clearTimeout(pending.quietTimer);
      if (pending.hardTimer) clearTimeout(pending.hardTimer);
      if (pending.absoluteTimer) clearTimeout(pending.absoluteTimer);
      if (pending._stopGraceTimer) clearTimeout(pending._stopGraceTimer);
      // L5: remove the per-turn stop-hook listener (this path bypasses
      // Process.kill()'s removeAllListeners).
      if (pending._onStop) this.off('stop-hook', pending._onStop);
      const err = new Error('bridge disconnected');
      err.code = 'BRIDGE_DISCONNECTED';
      try { pending.reject(err); } catch {}
    }
    this.pendingTurns.clear();
    this.pendingQueue.length = 0;
    this.inFlight = false;
    // 0.12: drop the interactive-question keep-alive here too, for parity with
    // _doKill — pm reacts to 'bridge-disconnected' by killing us anyway, but don't
    // depend on that ordering to stop the 60s interval / clear the open set.
    this._stopQuestionKeepAlive();
    this._openQuestions.clear();
    this.emit('bridge-disconnected');
    this._logEvent('bridge-disconnected', { reason });
  }

  async _doKill(reason) {
    this.closed = true;
    this.inFlight = false;

    this._stopQuestionKeepAlive();   // 0.12: drop the interactive-question keep-alive
    this._openQuestions.clear();

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongWatchdog) {
      clearInterval(this.pongWatchdog);
      this.pongWatchdog = null;
    }
    if (this._interruptGraceTimer) {
      clearTimeout(this._interruptGraceTimer);
      this._interruptGraceTimer = null;
    }

    // Drain pending turns — error code 'KILLED' matches the SDK/tmux contract
    for (const [, pending] of this.pendingTurns) {
      if (pending.quietTimer) clearTimeout(pending.quietTimer);
      if (pending.hardTimer) clearTimeout(pending.hardTimer);
      if (pending.absoluteTimer) clearTimeout(pending.absoluteTimer);
      if (pending._stopGraceTimer) clearTimeout(pending._stopGraceTimer);
      if (pending._onStop) this.off('stop-hook', pending._onStop); // L5
      const err = new Error(`session killed: ${reason}`);
      err.code = 'KILLED';
      pending.reject(err);
    }
    this.pendingTurns.clear();

    // Also drain anything sitting in the inherited pendingQueue (Process base class
    // surface — Process contract C5 requires this even though channels normally
    // routes through pendingTurns).
    while (this.pendingQueue.length) {
      const item = this.pendingQueue.shift();
      try { item.clearTimers?.(); } catch {}
      try {
        const err = new Error(`session killed: ${reason}`);
        err.code = 'KILLED';
        item.reject?.(err);
      } catch {}
    }

    // Tear down tmux (graceful via runner).
    if (this.tmuxSession) {
      try {
        await this.runner.killSession(this.tmuxSession);
      } catch (err) {
        this.logger.warn?.(`[${this.label}] channels: tmux kill failed: ${err.message}`);
      }
    }

    // M1: bridge server owns socket + bridge connection teardown
    if (this.bridgeServer) {
      try { await this.bridgeServer.close(); } catch {}
      this.bridgeServer = null;
    }
    // P0 #1: unlink the secret-bearing mcp-config file too
    if (this.mcpConfigPath) {
      try { fs.unlinkSync(this.mcpConfigPath); } catch {}
    }

    // Phase 1.3: tear down hook tail + clean per-session hook files.
    if (this._hookTail) {
      try { this._hookTail.close(); } catch {}
      this._hookTail = null;
    }
    if (this.botName && this.claudeSessionId) {
      try { removeHookFiles({ botName: this.botName, sessionId: this.claudeSessionId }); } catch {}
    }
    // File-send staging: remove the whole per-session dir on kill (purge only
    // empties it between turns; kill is end-of-life so drop it entirely).
    if (this.attachmentStagingDir) {
      try { fs.rmSync(this.attachmentStagingDir, { recursive: true, force: true }); } catch {}
      this.attachmentStagingDir = null;
    }

    this.emit('close', 0);
  }

  /**
   * F#24: implement injectUserMessage for the autosteer / mid-turn fold UX.
   * Polygram's autosteer flow (lib/handlers/autosteer.js) calls
   * pm.injectUserMessage when a follow-up message arrives while a turn is
   * in flight. Pre-fix the channels backend inherited the base-class
   * default (returns false) → caller's tryAutosteer reported false → no
   * AUTOSTEERED (✍) reaction was set → the follow-up msg sat with no
   * visible reactor state until the stdin-lock released. Now: write the
   * follow-up as a fresh user_msg to the bridge. claude receives it as
   * the next channel notification, typically absorbing it into the
   * current turn's context (OpenClaw-style "merge into active" UX
   * preserved on channels).
   *
   * Note on the channels semantic vs SDK/tmux:
   *  - SDK pushes onto an inputController stream that claude reads
   *    interleaved with model output (true mid-stream merge).
   *  - Tmux pastes into the TUI prompt buffer (TUI fold mechanic).
   *  - Channels: each user_msg notification queues in claude's input
   *    list. With a turn in flight, the second notification queues
   *    behind the active one. claude usually processes it in the same
   *    response cycle (the canonical "fold") but may treat it as a
   *    distinct next turn — the bridge protocol doesn't expose a
   *    true mid-stream merge primitive. Best available with current
   *    Channels protocol; UX-equivalent for most cases.
   *
   * Contract (matches SDK/tmux):
   *  - Returns false when: !inFlight, closed, !bridgeReady, empty
   *    content, sanitizes-to-empty.
   *  - Returns true on successful queue.
   *  - Emits 'inject-user-message' on success, 'inject-fail' on
   *    transport failure.
   *  - Sanitizes C0 control chars + DEL (parity with SDK/tmux); emits
   *    'prompt-sanitized' if any stripped.
   *  - NEVER throws (hot path; matches the cross-backend contract).
   *
   * @param {object} opts
   * @param {string} opts.content        — follow-up user text
   * @param {string} [opts.priority]     — 'next' | 'later' (advisory; channels can't enforce per-message scheduling)
   * @param {boolean} [opts.shouldQuery] — advisory; channels ignores (no inputController)
   * @param {string|number} [opts.msgId] — inbound Telegram msg_id, passed through to the bridge so claude's next reply can echo it via turn_id
   * @returns {boolean}
   */
  injectUserMessage({ content, priority = 'next', shouldQuery, msgId } = {}) {
    if (this.closed) return false;
    if (!this.inFlight) return false;                // base contract: no live turn → caller falls through
    if (!this.bridgeReady) return false;
    if (typeof content !== 'string' || !content) return false;

    const safeContent = sanitizeInjectControlChars(content);
    if (!safeContent) return false;
    if (safeContent.length !== content.length) {
      this.emit('prompt-sanitized', {
        stripped: content.length - safeContent.length,
        source: 'inject',
      });
    }

    const turnId = crypto.randomUUID();
    const wrote = this._writeToBridge({
      kind: 'user_msg',
      turn_id: turnId,
      text: safeContent,
      chat_id: this.chatId,
      user: '',
      msg_id: msgId != null ? String(msgId) : '',
    });
    if (!wrote) {
      // Mirrors the tmux event shape (TmuxProcess.emit('inject-fail',
      // {err, source}) when pasteText rejects). C23 contract test depends
      // on err being a non-empty string.
      this.emit('inject-fail', { err: 'bridge write failed', source: 'inject' });
      return false;
    }
    this._logEvent('inject-user-message', {
      session_key: this.sessionKey,
      chat_id: this.chatId,
      priority: priority ?? null,
      should_query: shouldQuery ?? null,
      text_len: safeContent.length,
      msg_id: msgId != null ? String(msgId) : null,
    });
    this.emit('inject-user-message', {
      text_len: safeContent.length,
      priority: priority ?? null,
      shouldQuery: shouldQuery ?? null,
      msgId: msgId != null ? String(msgId) : null,
    });
    return true;
  }

  /**
   * Review AC7: fire-and-forget user-message into the bridge. Polygram's
   * slash-command paths (/compact, /reload) use this to push a user-shaped
   * prompt without registering a pending turn. SDK/tmux implement this
   * differently per backend; channels just writes a user_msg to the bridge
   * with a fresh turn_id (which has no listener — so any reply Claude sends
   * falls into the autonomous-assistant-message path via
   * _recordReplyForPendingTurn's no-pending fallback).
   *
   * @param {string} text
   * @returns {boolean} true if queued, false on invalid input / no bridge
   */
  fireUserMessage(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    if (this.closed || !this.bridgeReady) return false;
    const turnId = crypto.randomUUID();
    this._writeToBridge({
      kind: 'user_msg',
      turn_id: turnId,
      text,
      chat_id: this.chatId,
      user: '',
      msg_id: '',
    });
    return true;
  }

  /**
   * Review AC8: clear session state so the NEXT send() starts fresh. Used
   * by /new and /reset slash commands. Does NOT kill the underlying claude
   * (would require a heavier teardown + respawn); only drops pending turns
   * + clears the claudeSessionId so the next send() starts a new claude
   * conversation (via the bridge's session_init flow on next user_msg).
   *
   * @returns {Promise<{closed: boolean, drainedPendings: number}>}
   */
  async resetSession({ reason = 'reset' } = {}) {
    let drained = 0;
    // First drain pendingTurns (channels-native bookkeeping). Each entry
    // ALSO has a matching pendingQueue row pushed at send(); we remove the
    // matched queue rows here so the queue drain below doesn't double-count.
    const channelsTurnIds = new Set();
    for (const [turnId, pending] of this.pendingTurns) {
      channelsTurnIds.add(turnId);
      drained++;
      if (pending.quietTimer) clearTimeout(pending.quietTimer);
      if (pending.hardTimer) clearTimeout(pending.hardTimer);
      if (pending.absoluteTimer) clearTimeout(pending.absoluteTimer);
      if (pending._stopGraceTimer) clearTimeout(pending._stopGraceTimer); // L5
      if (pending._onStop) this.off('stop-hook', pending._onStop);        // L5
      const err = new Error(`session reset: ${reason}`);
      err.code = 'RESET';
      try { pending.reject(err); } catch {}
    }
    this.pendingTurns.clear();
    // Now drain pendingQueue. Skip matching turnIds (already counted), reject
    // the rest (entries pushed by callers other than this.send — contract
    // test, tmux/sdk pm callback path).
    const remaining = [];
    for (const item of this.pendingQueue) {
      if (item.turnId && channelsTurnIds.has(item.turnId)) continue;
      remaining.push(item);
    }
    this.pendingQueue.length = 0;
    for (const item of remaining) {
      drained++;
      try { item.clearTimers?.(); } catch {}
      try {
        const err = new Error(`session reset: ${reason}`);
        err.code = 'RESET';
        item.reject?.(err);
      } catch {}
    }
    this.inFlight = false;
    // Clear claudeSessionId so getClaudeSessionId() in polygram doesn't
    // resume the same conversation on next send. The bridge will surface a
    // fresh id via session_init when claude re-initializes.
    this.claudeSessionId = null;
    // Step E: emit 'idle' BEFORE 'session-reset' so reaction-cyclers stop.
    // resetSession rejects pending turns with code=RESET without taking the
    // _resolveTurn path; without this emit, a HeartbeatReactor wired to this
    // CliProcess would keep cycling until the next 'thinking' (next send)
    // overwrote the state. Subscribers that care about the distinction can
    // still listen to 'session-reset' for the reason payload.
    if (drained > 0) this.emit('idle');
    this.emit('session-reset', { reason });
    this._logEvent('session-reset', { reason, drainedPendings: drained });

    // Review F#9: pm.resetSession removes this proc from procs map regardless
    // of the returned `closed` field, so leaving the underlying tmux session,
    // bridge socket server, and secret-bearing mcp-config tmp file alive is a
    // straight resource leak that compounds over /new /reset usage. Tear
    // those down here and return closed:true so the contract is honest.
    // (SDK/tmux backends can keep the underlying process alive across
    // resetSession; channels cannot because there's no in-place re-init
    // path — claude needs a fresh spawn to reset its conversation state.)
    this.closed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongWatchdog) {
      clearInterval(this.pongWatchdog);
      this.pongWatchdog = null;
    }
    if (this._interruptGraceTimer) {
      clearTimeout(this._interruptGraceTimer);
      this._interruptGraceTimer = null;
    }
    if (this.tmuxSession) {
      try { await this.runner.killSession(this.tmuxSession); }
      catch (err) { this.logger.warn?.(`[${this.label}] channels: tmux kill on reset failed: ${err.message}`); }
      this.tmuxSession = null;
    }
    if (this.bridgeServer) {
      try { await this.bridgeServer.close(); } catch {}
      this.bridgeServer = null;
    }
    if (this.mcpConfigPath) {
      try { fs.unlinkSync(this.mcpConfigPath); } catch {}
      this.mcpConfigPath = null;
    }
    this.emit('close', 0);
    return { closed: true, drainedPendings: drained };
  }

  /**
   * Drain pendingQueue (Process base class surface — C6 contract).
   * Channels normally routes through pendingTurns; pendingQueue exists
   * for cross-backend symmetry on /stop, daemon shutdown, /new.
   */
  drainQueue(_code = 'INTERRUPTED') {
    let n = 0;
    while (this.pendingQueue.length) {
      const item = this.pendingQueue.shift();
      n++;
      try { item.clearTimers?.(); } catch {}
      try {
        // Review C6: error must carry the supplied code for parity with kill()'s
        // err.code='KILLED' (see kill() above). Callers branch on err.code.
        const err = new Error('drained');
        err.code = _code;
        item.reject?.(err);
      } catch {}
    }
    return n;
  }

  // ─── permission relay ─────────────────────────────────────────────

  /**
   * Called by polygram after the user taps an approve/deny button.
   * Sender allowlist + per-session binding MUST be enforced UPSTREAM
   * (in the daemon's TG button handler) — CliProcess assumes
   * any verdict reaching here is already authorized.
   */
  async respondToPermission(requestId, behavior) {
    if (behavior !== 'allow' && behavior !== 'deny') {
      throw new TypeError(`respondToPermission: behavior must be 'allow' or 'deny' (got ${behavior})`);
    }
    // Review F#8: stale-instance guard. The respond() closure captured at
    // 'approval-required' emit time is bound to THIS CliProcess. If the
    // user taps Approve/Deny 11+ min later, the original turn may have timed
    // out, the proc killed, and a new CliProcess spawned for the same
    // sessionKey. The closure still points to the dead instance; _writeToBridge
    // would silently no-op because bridgeServer is null post-kill. Without
    // this guard, the user sees nothing. Now we log + emit forensics + return
    // false so the caller (polygram's onApprovalRequired) can surface "your
    // approval came too late" to the operator if desired.
    if (this.closed) {
      this.logger.warn?.(
        `[${this.label}] channels: late perm verdict for request_id=${requestId} ` +
        `behavior=${behavior} — instance closed, dropping (was: silent no-op)`,
      );
      this._logEvent('channels-late-perm-verdict-dropped', {
        request_id: requestId,
        behavior,
      });
      return false;
    }
    // Review #8 (P1 security): idempotency. Double-fire writes two perm_verdict
    // messages for the same request_id, undefined Claude behavior. Tracking
    // resolved ids in a Set prevents the second write. Mirrors TmuxProcess's
    // _pendingApprovalId single-shot gate.
    if (this.respondedPermissions.has(requestId)) {
      this.logger.warn?.(
        `[${this.label}] channels: respondToPermission duplicate for request_id=${requestId} — dropped`,
      );
      return;
    }
    this.respondedPermissions.add(requestId);
    this._writeToBridge({ kind: 'perm_verdict', request_id: requestId, behavior });
  }

  // ─── interactive questions (0.12 ask) ─────────────────────────────

  /**
   * Hand a question's answer back to the blocking `ask` tool call. `result` is
   * {answers:[...]} | {cancelled:true} | {timedout:true}. Stops the keep-alive
   * once no questions remain open. Called by pm.answerQuestion (from the handler).
   */
  writeQuestionAnswer(toolCallId, result) {
    this._openQuestions.delete(toolCallId);
    const noneLeft = this._openQuestions.size === 0;
    if (noneLeft) this._stopQuestionKeepAlive();
    const wrote = this._writeToBridge({ kind: 'question_answer', tool_call_id: toolCallId, result: result ?? {} });
    // Re-light progress: claude is about to resume working on the answer. The per-turn reactor
    // cleared when claude posted its reply + asked, and no tool hooks fired during the wait, so
    // it stayed cleared — the post-answer work was invisible ("why don't I see it working after
    // submit?", hire topic 2026-06-09). On a REAL answer (cancelled/timeout END the turn → let
    // the normal teardown clear), signal polygram to re-arm the turn's working reaction.
    if (noneLeft && result && !result.cancelled && !result.timedout) {
      this.emit('question-resumed');
    }
    return wrote;
  }

  _startQuestionKeepAlive() {
    if (this._questionKeepAliveTimer) return;
    this._questionKeepAliveTimer = setInterval(() => {
      if (this._openQuestions.size === 0) { this._stopQuestionKeepAlive(); return; }
      // claude is idle waiting on the answer → no tool hooks → reset the idle
      // ceiling (and reply-quiet window) so the turn isn't killed mid-question.
      this._extendQuietOnToolActivity();
    }, 60_000);
    this._questionKeepAliveTimer.unref?.();
  }

  _stopQuestionKeepAlive() {
    if (this._questionKeepAliveTimer) { clearInterval(this._questionKeepAliveTimer); this._questionKeepAliveTimer = null; }
  }

  // ─── socket plumbing ──────────────────────────────────────────────

  _writeToBridge(obj) {
    // M1: delegate to ChannelsBridgeServer.writeMessage which handles
    // "no live connection" warn + write try/catch uniformly.
    // Review F#18: return boolean so callers (notably send()) can detect
    // a no-bridge condition and reject the pending immediately instead
    // of waiting for hardTimer.
    if (!this.bridgeServer) return false;
    try {
      this.bridgeServer.writeMessage(obj);
      return true;
    } catch (err) {
      this.logger.warn?.(`[${this.label}] channels: _writeToBridge failed: ${err.message}`);
      return false;
    }
  }

  _startPingLoop() {
    // P1 #6: seed lastPongAt so the watchdog has a fresh baseline.
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      this._writeToBridge({ kind: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    this.pongWatchdog = setInterval(() => {
      if (this.closed || !this.bridgeReady) return;
      const elapsed = Date.now() - this.lastPongAt;
      if (elapsed > PONG_TIMEOUT_MS) {
        this.logger.warn?.(
          `[${this.label}] channels: pong watchdog tripped after ${elapsed}ms — declaring bridge dead`,
        );
        // Trigger the same recovery path as a socket-close: forcibly destroy
        // the bridge connection so 'bridge-disconnected' fires (drains
        // pendingTurns, ProcessManager kills dead instance for lazy respawn).
        if (this.bridgeServer) this.bridgeServer.destroyConnection();
      }
      // Review F#17: piggyback mid-turn dialog detection on the same 5s tick.
      // Fire-and-forget — _pollMidTurnDialogs swallows its own errors so the
      // pong watchdog stays clean.
      this._pollMidTurnDialogs().catch((err) => {
        this.logger.warn?.(`[${this.label}] channels: mid-turn poll failed: ${err.message}`);
      });
      // 0.12.0 background-work lifecycle: idle-side stall-watchdog, the mirror of
      // _pollMidTurnDialogs (which only runs during turns). Fire-and-forget.
      this._pollBackgroundWork().catch((err) => {
        this.logger.warn?.(`[${this.label}] channels: bg-work poll failed: ${err.message}`);
      });
    }, PONG_CHECK_INTERVAL_MS);
    this.pongWatchdog.unref?.();
  }

  /**
   * Review F#17: capture-pane scan for known interactive prompts that can
   * fire mid-turn without surfacing as MCP notifications. Examples:
   *   - Session-age "Resume from summary?" menu (if claude renders it
   *     after the turn started, post-startup-gate)
   *   - Future usage-limit / context-overflow menus that Anthropic might
   *     add to the TUI
   *
   * Action per pattern is declared in MID_TURN_PROMPTS. Defaults to 'enter'
   * (dismiss with sendControl(Enter)); 'emit-only' surfaces telemetry
   * without auto-action — use when the right response depends on operator
   * judgment.
   *
   * Gated on `pendingTurns.size > 0` so we don't poll during idle —
   * matches the rationale "only check during turns, not all the time."
   * Rate-limited per-pattern so a dialog lingering across polls doesn't
   * spam telemetry / Enter keystrokes.
   *
   * Extracted as a separate async method so unit tests can drive it
   * directly without waiting for the setInterval tick.
   */
  /**
   * 0.12.0-rc.13: proactive compaction warning. Read the transcript's current
   * context occupancy and, if past the per-chat threshold, emit a
   * 'compaction-warn' the chat layer turns into "you're ~N% full, run
   * /compact" — giving the user a window to compact on their terms BEFORE
   * claude auto-compacts mid-turn (which detaches the channels bridge). Warns
   * once per climb (this._compactionWarned), re-armed on PostCompact.
   * Fire-and-forget: swallows its own errors so transcript IO never breaks
   * the turn-end path.
   */
  async _maybeProactiveCompactionWarn(transcriptPath) {
    try {
      if (!this.compactionWarn?.enabled || this._compactionWarned) return;
      const usage = await readContextTokens(transcriptPath);
      if (!usage) return;
      const pct = contextPct(usage.total) * 100;
      if (pct < this.compactionWarn.thresholdPct) return;
      if (this._compactionWarned) return;   // re-check after the async gap
      this._compactionWarned = true;
      this.emit('compaction-warn', {
        kind: 'proactive',
        pct: Math.round(pct),
        totalTokens: usage.total,
        sessionId: this.claudeSessionId,
        backend: this.backend,
      });
    } catch (err) {
      this.logger.warn?.(`[${this.label}] compaction-warn sample failed: ${err.message}`);
    }
  }

  async _pollMidTurnDialogs() {
    if (this.closed) return;
    if (this.pendingTurns.size === 0) return;        // no work to do when idle
    // 0.12 interactive questions: while an `ask` is open claude sits idle at the
    // prompt waiting on the tool result — so the pane shows no "esc to interrupt"
    // and the question's own echoed text (a "?"/numbered list/"Yes/No") would
    // false-trip the unknown-prompt heuristic + starve the STALL heartbeat. The
    // keyboard lives on Telegram; suppress the pane watchdog while a question is open.
    if (this._openQuestions.size > 0) return;
    if (!this.tmuxSession) return;                   // pre-spawn / post-kill
    if (typeof this.runner?.captureWide !== 'function') return;

    let pane;
    try {
      pane = await this.runner.captureWide(this.tmuxSession);
    } catch (err) {
      // captureWide can fail if tmux died, session got renamed, etc. Log
      // once at warn (rate-limited by the outer pong loop's cadence) and
      // return — pong watchdog will eventually trip on the real symptom.
      this.logger.warn?.(`[${this.label}] channels: mid-turn captureWide failed: ${err.message}`);
      return;
    }
    if (!pane) return;

    // rc.14: removed the rc.11 pane-based "dead bridge" detection here. It
    // matched the BENIGN banner "server:polygram-bridge  no MCP server
    // configured with that name" — a cosmetic line that
    // `--dangerously-load-development-channels` + `--strict-mcp-config` prints
    // on EVERY healthy session (channel still delivers; reply tool still
    // works). The matcher false-fired ~5s into every channels turn and killed
    // healthy sessions. Real bridge loss is the socket-close path
    // (_handleBridgeDisconnected), not anything observable in the pane.

    const now = Date.now();

    // 0.12 Phase 3.2: liveness heartbeat. The TUI prints "esc to interrupt"
    // throughout any busy phase, including pure-thinking turns where no
    // hook events fire. Emit 'thinking' so sdkCallbacks.onThinking calls
    // reactor.heartbeat() — keeps the cascade at THINKING_DEEPEST (🤓)
    // instead of escalating to STALL (🥱). Idempotent — heartbeat just
    // resets a timer; safe to fire on every poll while claude is busy.
    if (STREAMING_HINT_RE.test(pane)) {
      this.emit('thinking');
    }

    let matchedKnownPrompt = false;
    for (const prompt of MID_TURN_PROMPTS) {
      if (!prompt.regex.test(pane)) continue;
      matchedKnownPrompt = true;
      const lastFiredAt = this.midTurnDialogLastFiredAt.get(prompt.name) || 0;
      if ((now - lastFiredAt) < MID_TURN_DEDUP_WINDOW_MS) continue;   // dedup
      this.midTurnDialogLastFiredAt.set(prompt.name, now);

      this.logger.warn?.(
        `[${this.label}] cli: mid-turn dialog detected name=${prompt.name} ` +
        `action=${prompt.action} pendingTurns=${this.pendingTurns.size}`,
      );
      this.emit('mid-turn-dialog-detected', {
        name: prompt.name,
        action: prompt.action,
        sessionId: this.claudeSessionId,
        backend: this.backend,
      });
      this._logEvent('cli-mid-turn-dialog-detected', {
        name: prompt.name,
        action: prompt.action,
        pending_count: this.pendingTurns.size,
      });

      if (prompt.action === 'enter') {
        try {
          await this.runner.sendControl(this.tmuxSession, 'Enter');
        } catch (err) {
          this.logger.warn?.(
            `[${this.label}] cli: mid-turn dismiss-Enter failed for ${prompt.name}: ${err.message}`,
          );
        }
      }
      // 'emit-only': telemetry-only; operator decides next step.
    }

    // 0.12 Phase 3.3 (Q1 resolution): unknown-prompt heuristic. If the pane
    // doesn't match any known catalog entry but DOES look like a prompt
    // ("?" trailing, "(y/N)", "Yes/No", numeric option markers, "❯" cursor),
    // emit a telemetry event with the pane excerpt so polygram.js can surface
    // an admin card. We don't auto-dismiss — operator decides. Dedup window
    // applies the same as for known prompts to avoid spamming during a
    // lingering unknown dialog.
    if (!matchedKnownPrompt
        && !STREAMING_HINT_RE.test(pane)
        && UNKNOWN_PROMPT_HEURISTIC_RE.test(pane)) {
      const lastFiredAt = this.midTurnDialogLastFiredAt.get('__unknown__') || 0;
      if ((now - lastFiredAt) >= MID_TURN_DEDUP_WINDOW_MS) {
        this.midTurnDialogLastFiredAt.set('__unknown__', now);
        // Last ~10 lines as the excerpt — enough context for the operator.
        const excerpt = pane.split('\n').slice(-12).join('\n');
        this.emit('mid-turn-unknown-prompt', {
          excerpt,
          sessionId: this.claudeSessionId,
          backend: this.backend,
        });
        this._logEvent('cli-mid-turn-unknown-prompt', {
          pending_count: this.pendingTurns.size,
          excerpt_head: excerpt.slice(0, 200),
        });
      }
    }
  }
}

module.exports = { CliProcess };

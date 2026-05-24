/**
 * ChannelsProcess — Claude session backed by `claude` CLI in tmux,
 * with IO over the official Channels MCP protocol via a stdio bridge.
 *
 * Cost profile: subscription-priced (claude CLI uses Pro/Max) AND structured
 * IO (no JSONL tailing, no pane scraping). The third leg of the
 * SdkProcess / TmuxProcess / ChannelsProcess matrix.
 *
 * Architecture:
 *   ChannelsProcess.start() creates a per-session unix socket (mode 0600
 *   + per-socket secret), spawns claude in tmux with --channels pointing
 *   at lib/process/channels-bridge.mjs registered via inline --mcp-config.
 *   The bridge connects back over the socket, authenticates via the
 *   shared secret, and proxies MCP traffic in both directions.
 *
 *   Inbound user msgs:   daemon → ChannelsProcess.send() → bridge socket →
 *                        bridge → mcp.notification(claude/channel)
 *   Outbound replies:    Claude calls mcp__polygram-bridge__reply →
 *                        bridge → socket → ChannelsProcess.onBridgeMsg →
 *                        toolDispatcher(chatId, text, files) → daemon
 *
 *   Permission relay:    Claude needs Bash → Claude Code emits
 *                        permission_request → bridge → socket →
 *                        ChannelsProcess emits 'approval-required' → polygram
 *                        renders inline-keyboard buttons → user taps →
 *                        ChannelsProcess.respondToPermission(id, verdict)
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
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { Process, UnsupportedOperationError } = require('./process');

const BRIDGE_PATH = path.resolve(__dirname, 'channels-bridge.mjs');
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_QUIET_MS = 2_000;     // after first reply, wait this long for more before resolving turn
const DEFAULT_TURN_TIMEOUT_MS = 600_000; // 10 min hard cap
const DEFAULT_MAX_REPLIES_PER_TURN = 20; // P1 #12: cap on quiet-window resets to prevent chatty-Claude hang
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;          // P1 #6: declare bridge dead if no pong in 30s
const PONG_CHECK_INTERVAL_MS = 5_000;
const RECENT_TOOL_CALL_LIMIT = 256;      // P1 #7: cap on idempotency cache
const DEFAULT_TOOL_RATE_LIMIT_PER_SEC = 5;   // P2 ADV-6: cap on reply tool calls per second
const DEFAULT_TOOL_RATE_BURST = 20;          // ADV-6: token bucket capacity

class ChannelsProcess extends Process {
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
    turnQuietMs = DEFAULT_TURN_QUIET_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    maxRepliesPerTurn = DEFAULT_MAX_REPLIES_PER_TURN,
  } = {}) {
    super({ sessionKey, chatId, threadId, label });
    this.backend = 'channels';

    if (!tmuxRunner) throw new TypeError('ChannelsProcess: tmuxRunner required');
    if (!botName) throw new TypeError('ChannelsProcess: botName required');
    if (typeof toolDispatcher !== 'function') {
      throw new TypeError('ChannelsProcess: toolDispatcher (function) required');
    }

    this.runner = tmuxRunner;
    this.botName = botName;
    // claudeBin MUST be supplied — factory enforces this. We don't lazy-resolve
    // because there's no sensible default and silent null would surface as a
    // far-from-cause tmuxRunner.spawn failure.
    if (!claudeBin && !process.env.POLYGRAM_CLAUDE_BIN) {
      throw new TypeError('ChannelsProcess: claudeBin required (or POLYGRAM_CLAUDE_BIN env)');
    }
    this.claudeBin = claudeBin || process.env.POLYGRAM_CLAUDE_BIN;
    this.toolDispatcher = toolDispatcher;
    this.logger = logger;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.turnQuietMs = turnQuietMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.maxRepliesPerTurn = maxRepliesPerTurn;

    // populated by start()
    this.sockPath = null;
    this.sockSecret = null;
    this.sockServer = null;
    this.sockClient = null;          // bridge connection (one per session)
    this.mcpConfigPath = null;       // P0 #1: 0o600 tmp file holding bridge env (no argv leak)
    this.tmuxSession = null;         // tmux session name
    this.bridgeReady = false;
    this.pingTimer = null;
    // Review P1 #6: daemon-side pong tracking. Without it, a half-open socket
    // (bridge frozen but TCP alive) is invisible to the daemon. We record the
    // last pong timestamp on each 'pong' bridge message and a separate watchdog
    // interval fires bridge-disconnected if too much time elapses.
    this.lastPongAt = 0;
    this.pongWatchdog = null;
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
    this.recentToolCallOrder = [];   // FIFO bound

    // pending turn(s): turn_id → { resolve, reject, replies: [], quietTimer, hardTimer, startedAt }
    this.pendingTurns = new Map();

    // P1 security (review #8): track resolved permission request_ids so a
    // double-fire of respond() can't write a second perm_verdict for the same
    // request. TmuxProcess gates on _pendingApprovalId; this is the channels
    // analog.
    this.respondedPermissions = new Set();
  }

  /**
   * TmuxProcess uses cost=3 because each pane holds the full claude binary.
   * ChannelsProcess does the same (it's a tmux'd claude + a thin bridge subprocess).
   */
  get cost() {
    return 3;
  }

  // ─── start ─────────────────────────────────────────────────────────

  async start(opts = {}) {
    if (this.closed) throw new Error('ChannelsProcess: cannot start a closed instance');

    this.claudeSessionId = opts.existingSessionId || crypto.randomUUID();
    // Save cwd so the tool dispatcher's file-attachment allowlist (P0 #2) can
    // permit files under the agent's workspace.
    this.sessionCwd = opts.cwd || null;

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
      this._startPingLoop();
    } catch (err) {
      await this._teardownOnStartFailure();
      throw err;
    }

    this.emit('init', { sessionId: this.claudeSessionId, backend: this.backend });
  }

  /**
   * Best-effort cleanup when start() fails partway through. Mirrors kill()
   * but doesn't mark the instance closed (caller may retry with a new
   * instance).
   */
  async _teardownOnStartFailure() {
    if (this.sockClient) {
      try { this.sockClient.end(); } catch {}
      this.sockClient = null;
    }
    if (this.sockServer) {
      try { await new Promise(resolve => this.sockServer.close(() => resolve())); } catch {}
      this.sockServer = null;
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
  }

  async _createSocketServer() {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(this.sockPath); } catch {}

      this.sockServer = net.createServer({ allowHalfOpen: false }, conn => this._onBridgeConnect(conn));
      this.sockServer.on('error', err => {
        this.logger.error?.(`[${this.label}] channels socket error: ${err.message}`);
      });

      // Review P1 #9: TOCTOU mitigation. listen() publishes the socket with
      // umask-derived mode (typically 0o755) BEFORE the explicit chmodSync(0o600)
      // lands. In the window between, a local process could connect. We wrap
      // listen() in a temporary umask 0o077 so the socket is born with mode
      // 0o600 (= 0o777 & ~0o077) from the very first inode creation.
      // The explicit chmodSync stays as a defensive belt-and-suspenders for
      // platforms where the umask doesn't bind socket mode (rare but cheap).
      const prevUmask = process.umask(0o077);
      this.sockServer.listen(this.sockPath, err => {
        // Restore umask immediately — the listen callback runs after inode
        // creation. Other code in this event loop tick (concurrent file writes)
        // must NOT inherit our restrictive umask.
        process.umask(prevUmask);
        if (err) return reject(err);
        try {
          fs.chmodSync(this.sockPath, 0o600);
        } catch (chmodErr) {
          return reject(new Error(`failed to chmod 0600 ${this.sockPath}: ${chmodErr.message}`));
        }
        resolve();
      });
    });
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
      '--session-id', this.claudeSessionId,
      '--mcp-config', this.mcpConfigPath,   // P0 #1: file path, not inline JSON
    ];

    if (opts.model) claudeArgs.unshift('--model', opts.model);
    if (opts.cwd)   claudeArgs.unshift('--add-dir', opts.cwd);

    // Real tmuxRunner.spawn signature: {name, cwd, command, args, envExtras, paneWidth}
    await this.runner.spawn({
      name: tmuxName,
      cwd: opts.cwd || process.cwd(),
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

  async _handleStartupDialogs(tmuxName) {
    const deadline = Date.now() + 30_000;        // 30s cap for full dialog flow
    const seen = new Set();                       // don't re-Enter the same dialog
    while (Date.now() < deadline) {
      let pane;
      try {
        pane = await this.runner.captureWide(tmuxName);
      } catch (err) {
        this.logger.warn?.(`[${this.label}] channels: captureWide failed: ${err.message}`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // dev-channel confirmation (always fires when --dangerously-load-development-channels used)
      if (!seen.has('dev-channels') && /WARNING: Loading development channels/i.test(pane)) {
        await this.runner.sendControl(tmuxName, 'Enter');
        seen.add('dev-channels');
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // workspace trust prompt (first-time cwd or untrusted)
      if (!seen.has('trust') && /trust the files in this folder/i.test(pane)) {
        await this.runner.sendControl(tmuxName, 'Enter');
        seen.add('trust');
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // Ready signal: "Listening for channel messages from: server:polygram-bridge"
      if (/Listening for channel messages from: server:polygram-bridge/i.test(pane)) {
        return;
      }

      await new Promise(r => setTimeout(r, 300));
    }

    throw new Error(`channels: claude startup dialogs did not resolve within 30s for ${tmuxName}`);
  }

  _waitForBridgeHandshake() {
    // Race-safe: if bridge already handshook (e.g. dialog phase took longer
    // than the bridge took to spawn + connect + send session_init), the event
    // has already fired by the time we attach our listener. Check the state
    // flag set by _onBridgeMsg first.
    if (this.bridgeReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`bridge handshake timeout (${this.handshakeTimeoutMs}ms)`));
      }, this.handshakeTimeoutMs);
      this.once('bridge-ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ─── socket / bridge connection ──────────────────────────────────

  _onBridgeConnect(conn) {
    // Reject second connections — one bridge per session.
    if (this.sockClient && !this.sockClient.destroyed) {
      this.logger.warn?.(`[${this.label}] channels: extra bridge connection rejected`);
      conn.write(JSON.stringify({ kind: 'hello_reject', reason: 'already-connected' }) + '\n');
      conn.end();
      return;
    }
    this.sockClient = conn;
    let authenticated = false;
    let buf = '';

    conn.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch { this.logger.warn?.(`[${this.label}] channels: bad json from bridge: ${line.slice(0, 100)}`); continue; }

        if (!authenticated) {
          if (msg.kind === 'hello' &&
              msg.session_key === this.sessionKey &&
              msg.secret === this.sockSecret) {
            authenticated = true;
            conn.write(JSON.stringify({ kind: 'hello_ack' }) + '\n');
            continue;
          }
          // Reject and disconnect — wrong secret or wrong session
          conn.write(JSON.stringify({ kind: 'hello_reject', reason: 'auth' }) + '\n');
          conn.end();
          this.sockClient = null;
          return;
        }
        this._onBridgeMsg(msg);
      }
    });

    conn.on('close', () => {
      if (this.sockClient === conn) {
        this.sockClient = null;
        this.bridgeReady = false;
        if (!this.closed) {
          this.logger.warn?.(`[${this.label}] channels: bridge disconnected unexpectedly`);
          // Review #5: drain pendingTurns immediately. Without this, hardTimers
          // run for turnTimeoutMs (default 600_000ms = 10 min); send()'s Promise
          // never resolves, blocking the chat queue for that long.
          for (const [, pending] of this.pendingTurns) {
            if (pending.quietTimer) clearTimeout(pending.quietTimer);
            if (pending.hardTimer) clearTimeout(pending.hardTimer);
            const err = new Error('bridge disconnected');
            err.code = 'BRIDGE_DISCONNECTED';
            try { pending.reject(err); } catch {}
          }
          this.pendingTurns.clear();
          // Also clear the pendingQueue entries we pushed at send() (P1 #14).
          this.pendingQueue.length = 0;
          this.inFlight = false;
          this.emit('bridge-disconnected');
        }
      }
    });

    conn.on('error', err => {
      this.logger.warn?.(`[${this.label}] channels: bridge conn error: ${err.message}`);
    });
  }

  _onBridgeMsg(msg) {
    switch (msg.kind) {
      case 'session_init':
        // Bridge confirms which session_id claude is actually running.
        // If it differs from our generated one (claude ignored --session-id?), adopt theirs.
        if (msg.claude_session_id && msg.claude_session_id !== this.claudeSessionId) {
          this.claudeSessionId = msg.claude_session_id;
          this.emit('session-id-refreshed', this.claudeSessionId);
        }
        this.bridgeReady = true;
        this.emit('bridge-ready');
        break;

      case 'tool':
        // Review P1 #15: emit canonical 'tool-use' event so polygram's
        // reactor chain (CALLBACK_TO_EVENT.onToolUse) can apply a per-tool
        // icon. Channels protocol only exposes the reply/react/edit_message
        // tools; SDK/tmux callers branch on toolName the same way.
        this.emit('tool-use', msg.name);
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

  async _dispatchToolCall(msg) {
    const args = msg.args || {};

    // Review P1 #7: idempotency. If we've already ACK'd this tool_call_id,
    // re-ACK with the cached result rather than re-dispatching to Telegram.
    // Without this, Claude's reply-retry on isError (which can fire after a
    // slow ack timeout) → double-send of the same TG message.
    if (msg.tool_call_id && this.recentToolCallIds.has(msg.tool_call_id)) {
      this.logger.warn?.(
        `[${this.label}] channels: duplicate tool_call_id=${msg.tool_call_id} — re-ACKing without dispatch`,
      );
      this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: true });
      return;
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
        sessionCwd: this.sessionCwd,        // P0 #2: dispatcher uses this to allowlist file roots
      });
    } catch (err) {
      this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: false, error: err.message });
      return;
    }

    this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: !!result?.ok, error: result?.error });

    // P1 #7: remember the tool_call_id so duplicates re-ACK without dispatch.
    // Only cache on SUCCESS — failed calls should be retryable (transient TG
    // outage etc).
    if (result?.ok && msg.tool_call_id) {
      this.recentToolCallIds.add(msg.tool_call_id);
      this.recentToolCallOrder.push(msg.tool_call_id);
      // FIFO eviction at cap
      while (this.recentToolCallOrder.length > RECENT_TOOL_CALL_LIMIT) {
        const evicted = this.recentToolCallOrder.shift();
        this.recentToolCallIds.delete(evicted);
      }
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
      // Multiple in-flight, no turn_id match → degraded mode. Pick the OLDEST
      // (first inserted) so behavior is at least deterministic, log loudly so
      // it's visible in audits.
      const [oldestId, oldest] = this.pendingTurns.entries().next().value;
      target = oldest;
      target._turnId = oldestId;
      this.logger.warn?.(
        `[${this.label}] channels: reply has no/unknown turn_id (got ${JSON.stringify(replyTurnId)}); ` +
        `${this.pendingTurns.size} turns pending; routing to oldest=${oldestId}`,
      );
    }
    // No pending turns at all → emit canonical 'autonomous-assistant-message'
    // event so polygram's autonomous-msg path (sdk/callbacks.js
    // onAutonomousAssistantMessage handler) routes it correctly. This is what
    // ScheduleWakeup / unsolicited replies look like on channels. Matches
    // SdkProcess emit shape (lib/process/sdk-process.js:304).
    if (!target) {
      this.emit('autonomous-assistant-message', {
        text,
        sessionId: this.claudeSessionId,
        backend: this.backend,
      });
      return;
    }

    target.replies.push(text);
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

  _resolveTurn(turnId) {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) return;
    this.pendingTurns.delete(turnId);
    // Review P1 #14: pop the matching pendingQueue entry too so downstream
    // pm callbacks (sdk/callbacks.js context lookup) see a clean queue.
    const qIdx = this.pendingQueue.findIndex(e => e.turnId === turnId);
    if (qIdx >= 0) this.pendingQueue.splice(qIdx, 1);
    if (pending.quietTimer) clearTimeout(pending.quietTimer);
    if (pending.hardTimer) clearTimeout(pending.hardTimer);
    const text = pending.replies.join('\n\n');
    const duration = Date.now() - pending.startedAt;
    // Review AC4: cost=null + metrics-tokens=null signal "unmeasured-subscription"
    // (channels protocol doesn't expose per-turn cost or token breakdowns).
    // Downstream billing aggregations should SKIP null entries rather than
    // averaging them as $0. The plain 0 we used before caused channels traffic
    // to appear free in dashboards.
    const result = {
      text,
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
  }

  // ─── public Process API ──────────────────────────────────────────

  async send(prompt, opts = {}) {
    if (this.closed) throw new Error('ChannelsProcess: send on closed instance');
    if (!this.bridgeReady) throw new Error('ChannelsProcess: bridge not ready');
    if (typeof prompt !== 'string') throw new TypeError('ChannelsProcess.send: prompt must be string');

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
      const pending = {
        resolve, reject,
        replies: [],
        quietTimer: null,
        hardTimer: setTimeout(() => {
          this.pendingTurns.delete(turnId);
          // Remove the queue entry too — turn no longer exists
          const idx = this.pendingQueue.findIndex(e => e.turnId === turnId);
          if (idx >= 0) this.pendingQueue.splice(idx, 1);
          this.inFlight = this.pendingTurns.size > 0;
          reject(new Error(`turn timeout (${opts.maxTurnMs || this.turnTimeoutMs}ms)`));
        }, opts.maxTurnMs || this.turnTimeoutMs),
        startedAt: Date.now(),
      };
      this.pendingTurns.set(turnId, pending);

      this._writeToBridge({
        kind: 'user_msg',
        turn_id: turnId,
        text: prompt,
        chat_id: this.chatId,
        user: opts.context?.user || '',
        msg_id: opts.context?.sourceMsgId || '',
      });
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

    // Review P3 C8: after Ctrl-C, Claude may or may not call reply with an
    // "I was interrupted" message. If it doesn't (5s grace), resolve pending
    // turns with subtype 'interrupted' instead of letting them wait the full
    // 10-min hardTimer. The grace window is reset if a new interrupt fires.
    if (this._interruptGraceTimer) clearTimeout(this._interruptGraceTimer);
    this._interruptGraceTimer = setTimeout(() => {
      for (const [turnId, pending] of this.pendingTurns) {
        // Synthesize an interrupted resolution: empty text, 'interrupted' subtype.
        if (pending.quietTimer) clearTimeout(pending.quietTimer);
        if (pending.hardTimer) clearTimeout(pending.hardTimer);
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
        } catch {}
      }
      this.inFlight = this.pendingTurns.size > 0;
      this._interruptGraceTimer = null;
    }, 5_000);
    this._interruptGraceTimer.unref?.();
  }

  async kill(reason = 'kill') {
    if (this.closed) return;
    this.closed = true;
    this.inFlight = false;

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

    // Close socket — disconnects bridge if still connected
    if (this.sockClient) {
      try { this.sockClient.end(); } catch {}
      this.sockClient = null;
    }
    if (this.sockServer) {
      await new Promise(resolve => this.sockServer.close(() => resolve()));
      this.sockServer = null;
    }
    try { fs.unlinkSync(this.sockPath); } catch {}
    // P0 #1: unlink the secret-bearing mcp-config file too
    if (this.mcpConfigPath) {
      try { fs.unlinkSync(this.mcpConfigPath); } catch {}
    }

    this.emit('close', 0);
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
    this.emit('session-reset', { reason });
    return { closed: false, drainedPendings: drained };
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
   * (in the daemon's TG button handler) — ChannelsProcess assumes
   * any verdict reaching here is already authorized.
   */
  async respondToPermission(requestId, behavior) {
    if (behavior !== 'allow' && behavior !== 'deny') {
      throw new TypeError(`respondToPermission: behavior must be 'allow' or 'deny' (got ${behavior})`);
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

  // ─── socket plumbing ──────────────────────────────────────────────

  _writeToBridge(obj) {
    if (!this.sockClient || this.sockClient.destroyed) {
      this.logger.warn?.(`[${this.label}] channels: writeToBridge — no live connection (kind=${obj.kind})`);
      return;
    }
    try {
      this.sockClient.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      this.logger.warn?.(`[${this.label}] channels: socket write failed: ${err.message}`);
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
        // Trigger the same recovery path as a socket-close: close our client end
        // so 'close' handler fires (drains pendingTurns, emits bridge-disconnected,
        // ProcessManager subscribes and kills the dead instance for lazy respawn).
        if (this.sockClient) {
          try { this.sockClient.destroy(); } catch {}
        }
      }
    }, PONG_CHECK_INTERVAL_MS);
    this.pongWatchdog.unref?.();
  }
}

module.exports = { ChannelsProcess };

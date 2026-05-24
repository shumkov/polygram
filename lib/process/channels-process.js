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
const PING_INTERVAL_MS = 10_000;

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
    this.claudeBin = claudeBin || resolveClaudeBin();
    this.toolDispatcher = toolDispatcher;
    this.logger = logger;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.turnQuietMs = turnQuietMs;
    this.turnTimeoutMs = turnTimeoutMs;

    // populated by start()
    this.sockPath = null;
    this.sockSecret = null;
    this.sockServer = null;
    this.sockClient = null;          // bridge connection (one per session)
    this.tmuxSession = null;         // tmux session name
    this.bridgeReady = false;
    this.pingTimer = null;

    // pending turn(s): turn_id → { resolve, reject, replies: [], quietTimer, hardTimer, startedAt }
    this.pendingTurns = new Map();
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

    // Opaque random token for socket filename — do NOT leak sessionKey to /tmp.
    const socketToken = crypto.randomBytes(16).toString('hex');
    this.sockPath = path.join(os.tmpdir(), `polygram-${socketToken}.sock`);
    this.sockSecret = crypto.randomBytes(32).toString('hex');

    await this._createSocketServer();

    const tmuxName = `${this.botName}-channels-${socketToken.slice(0, 8)}`;
    this.tmuxSession = tmuxName;

    await this._spawnTmuxClaude({ tmuxName, opts });
    await this._waitForBridgeHandshake();
    this._startPingLoop();

    this.emit('init', { sessionId: this.claudeSessionId, backend: this.backend });
  }

  async _createSocketServer() {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(this.sockPath); } catch {}

      this.sockServer = net.createServer({ allowHalfOpen: false }, conn => this._onBridgeConnect(conn));
      this.sockServer.on('error', err => {
        this.logger.error?.(`[${this.label}] channels socket error: ${err.message}`);
      });
      this.sockServer.listen(this.sockPath, err => {
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
    // Inline MCP-config — claude spawns the bridge as a child of itself.
    // env: {...} on mcpServers gets passed to the spawned bridge.
    const mcpConfig = JSON.stringify({
      mcpServers: {
        'polygram-bridge': {
          command: 'node',
          args: [BRIDGE_PATH],
          env: bridgeEnv,
        },
      },
    });

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
      '--mcp-config', mcpConfig,
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
        this._dispatchToolCall(msg).catch(err => {
          this.logger.error?.(`[${this.label}] channels: tool dispatch failed: ${err.message}`);
        });
        break;

      case 'perm_req':
        // Canonical 'approval-required' shape — matches TmuxProcess emit signature
        // (lib/process/tmux-process.js:2877). polygram.js's existing onApprovalRequired
        // handler (lib/sdk/callbacks.js wired in polygram.js:2217) consumes this
        // shape unchanged and gets canUseTool + admin-card flow for free.
        this.emit('approval-required', {
          id: msg.request_id,
          toolName: msg.tool_name,
          toolInput: {
            description: msg.description,
            input_preview: msg.input_preview,
          },
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
        // liveness signal — no action needed
        break;

      default:
        this.logger.warn?.(`[${this.label}] channels: unknown bridge msg.kind=${msg.kind}`);
    }
  }

  async _dispatchToolCall(msg) {
    const args = msg.args || {};
    // P1 security: chat_id MUST match the session's registered chatId.
    if (this.chatId != null && String(args.chat_id) !== String(this.chatId)) {
      this.logger.warn?.(
        `[${this.label}] channels: tool chat_id mismatch (got ${args.chat_id}, expected ${this.chatId}) — dropping`,
      );
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
      });
    } catch (err) {
      this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: false, error: err.message });
      return;
    }

    this._writeToBridge({ kind: 'tool_ack', tool_call_id: msg.tool_call_id, ok: !!result?.ok, error: result?.error });

    // Pending-turn bookkeeping: every reply tool call is a candidate turn-end.
    if (msg.name === 'reply' && args.text != null) {
      this._recordReplyForPendingTurn(args.text);
    }
  }

  _recordReplyForPendingTurn(text) {
    for (const [turnId, pending] of this.pendingTurns) {
      pending.replies.push(text);
      // (Re)start the quiet timer — turn resolves quietMs after the latest reply.
      if (pending.quietTimer) clearTimeout(pending.quietTimer);
      pending.quietTimer = setTimeout(() => this._resolveTurn(turnId), this.turnQuietMs);
    }
  }

  _resolveTurn(turnId) {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) return;
    this.pendingTurns.delete(turnId);
    if (pending.quietTimer) clearTimeout(pending.quietTimer);
    if (pending.hardTimer) clearTimeout(pending.hardTimer);
    const text = pending.replies.join('\n\n');
    const duration = Date.now() - pending.startedAt;
    const result = {
      text,
      sessionId: this.claudeSessionId,
      cost: 0,                // Channels protocol doesn't expose per-turn cost
      duration,
      error: null,
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        numAssistantMessages: pending.replies.length,
        numToolUses: 0,
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
    this.emit('thinking');

    return new Promise((resolve, reject) => {
      const pending = {
        resolve, reject,
        replies: [],
        quietTimer: null,
        hardTimer: setTimeout(() => {
          this.pendingTurns.delete(turnId);
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
    this.emit('interrupt-applied', { backend: this.backend });
  }

  async kill(reason = 'kill') {
    if (this.closed) return;
    this.closed = true;
    this.inFlight = false;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
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

    this.emit('close', 0);
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
      try { item.reject?.(new Error('drained')); } catch {}
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
    this.pingTimer = setInterval(() => {
      this._writeToBridge({ kind: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }
}

/**
 * Resolve the pinned claude binary. Uses lib/claude-bin.js's convention
 * (~/.local/share/claude/versions/<version>) with POLYGRAM_CLAUDE_BIN override.
 */
function resolveClaudeBin() {
  if (process.env.POLYGRAM_CLAUDE_BIN) return process.env.POLYGRAM_CLAUDE_BIN;
  // Caller can pass claudeBin explicitly; this is just a fallback.
  // Pinned version is decided by lib/process/tmux-process.js (CLAUDE_CLI_PINNED_VERSION).
  // We don't want a circular require — leave this null and let the factory inject.
  return null;
}

module.exports = { ChannelsProcess };

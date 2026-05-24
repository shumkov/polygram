/**
 * ChannelsBridgeServer — per-session unix-socket server for the bridge
 * subprocess to connect back to.
 *
 * Extracted from ChannelsProcess (M1 refactor) so the socket lifecycle —
 * listen with restrictive umask, accept ONE bridge, hello-handshake auth,
 * line-delimited JSON I/O, schema validation, single-bridge-per-session
 * enforcement, clean teardown — lives in one focused class instead of
 * sprawling across ChannelsProcess.
 *
 * Owns:
 *   - net.Server lifecycle (listen / close)
 *   - socket file mode (0o600 via umask wrap + defensive chmod)
 *   - bridge connection state (single connection accepted)
 *   - hello-handshake secret verification
 *   - line-buffer + JSON parse + zod schema validation (channels-bridge-protocol)
 *
 * Does NOT own:
 *   - protocol semantics (tool routing, perm relay, turn lifecycle) — those
 *     stay in ChannelsProcess, which subscribes to the events this class emits
 *   - claude/bridge process lifecycle
 *
 * Event surface (EventEmitter):
 *   'bridge-ready'        — handshake complete; safe to send daemon→bridge msgs
 *   'bridge-message', msg — every validated bridge→daemon message (post-auth)
 *   'bridge-disconnected' — single-bridge connection closed
 *   'error', err          — socket-level errors (rare; non-fatal)
 */

'use strict';

const EventEmitter = require('node:events');
const fs = require('node:fs');
const net = require('node:net');

const { parseBridgeToDaemonMessage } = require('./channels-bridge-protocol');

class ChannelsBridgeServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.sockPath
   * @param {string} opts.sessionKey   — bridge must echo this in hello
   * @param {string} opts.sockSecret   — bridge must present this in hello
   * @param {object} [opts.logger=console]
   * @param {string} [opts.label='channels-bridge-server']
   */
  constructor({ sockPath, sessionKey, sockSecret, logger = console, label = 'channels-bridge-server' } = {}) {
    super();
    if (!sockPath) throw new TypeError('ChannelsBridgeServer: sockPath required');
    if (!sessionKey) throw new TypeError('ChannelsBridgeServer: sessionKey required');
    if (!sockSecret) throw new TypeError('ChannelsBridgeServer: sockSecret required');
    this.sockPath = sockPath;
    this.sessionKey = sessionKey;
    this.sockSecret = sockSecret;
    this.logger = logger;
    this.label = label;

    this.server = null;
    this.conn = null;            // current bridge connection (one per session)
    this.authenticated = false;
  }

  /**
   * Bind + listen on the unix socket with restrictive umask so the inode is
   * created with mode 0o600 from birth (P1 #9 TOCTOU mitigation). Defensive
   * chmod runs in the listen callback as belt-and-suspenders.
   *
   * @returns {Promise<void>}
   */
  async listen() {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(this.sockPath); } catch {}

      this.server = net.createServer({ allowHalfOpen: false }, conn => this._onConnect(conn));
      this.server.on('error', err => {
        this.logger.error?.(`[${this.label}] socket error: ${err.message}`);
        this.emit('error', err);
      });

      const prevUmask = process.umask(0o077);
      this.server.listen(this.sockPath, err => {
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

  /**
   * Write a daemon→bridge message. Drops silently (with warn) if no live
   * connection. Returns true if write was attempted, false if dropped.
   */
  writeMessage(obj) {
    if (!this.conn || this.conn.destroyed) {
      this.logger.warn?.(`[${this.label}] writeMessage — no live connection (kind=${obj?.kind})`);
      return false;
    }
    try {
      this.conn.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (err) {
      this.logger.warn?.(`[${this.label}] socket write failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Forcibly destroy the bridge connection (used by the pong watchdog to
   * trigger the normal close→drain→respawn chain).
   */
  destroyConnection() {
    if (this.conn) try { this.conn.destroy(); } catch {}
  }

  /**
   * Tear down the server + close the connection + unlink the socket file.
   * Idempotent.
   */
  async close() {
    if (this.conn) {
      try { this.conn.end(); } catch {}
      this.conn = null;
    }
    if (this.server) {
      await new Promise(resolve => this.server.close(() => resolve()));
      this.server = null;
    }
    try { fs.unlinkSync(this.sockPath); } catch {}
  }

  // ─── private ──────────────────────────────────────────────────────

  _onConnect(conn) {
    // Single bridge per session — reject second connections.
    if (this.conn && !this.conn.destroyed) {
      this.logger.warn?.(`[${this.label}] extra bridge connection rejected`);
      try { conn.write(JSON.stringify({ kind: 'hello_reject', reason: 'already-connected' }) + '\n'); } catch {}
      conn.end();
      return;
    }
    this.conn = conn;
    let buf = '';
    let authenticated = false;

    conn.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let raw;
        try { raw = JSON.parse(line); }
        catch {
          this.logger.warn?.(`[${this.label}] bad json from bridge: ${line.slice(0, 100)}`);
          continue;
        }

        if (!authenticated) {
          if (raw.kind === 'hello'
              && raw.session_key === this.sessionKey
              && raw.secret === this.sockSecret) {
            authenticated = true;
            this.authenticated = true;
            try { conn.write(JSON.stringify({ kind: 'hello_ack' }) + '\n'); } catch {}
            continue;
          }
          try { conn.write(JSON.stringify({ kind: 'hello_reject', reason: 'auth' }) + '\n'); } catch {}
          conn.end();
          this.conn = null;
          this.authenticated = false;
          return;
        }

        // Post-auth: validate against schema, emit on success, drop+warn on fail.
        const parsed = parseBridgeToDaemonMessage(raw);
        if (!parsed.ok) {
          this.logger.warn?.(
            `[${this.label}] bridge msg schema invalid — ${parsed.error} — dropping`,
          );
          continue;
        }
        if (parsed.msg.kind === 'session_init') {
          // session_init also signals the bridge is fully ready. Emit
          // bridge-ready BEFORE the bridge-message so listeners that gate on
          // bridge-ready can subscribe to the message stream.
          this.emit('session-init', parsed.msg);
          this.emit('bridge-ready');
          continue;
        }
        this.emit('bridge-message', parsed.msg);
      }
    });

    conn.on('close', () => {
      if (this.conn === conn) {
        this.conn = null;
        this.authenticated = false;
        this.emit('bridge-disconnected');
      }
    });

    conn.on('error', err => {
      this.logger.warn?.(`[${this.label}] bridge conn error: ${err.message}`);
    });
  }
}

module.exports = { ChannelsBridgeServer };

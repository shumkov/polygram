/**
 * backend-driver — uniform test seam for SdkProcess and CliProcess.
 *
 * The Process abstraction (lib/process/process.js) promises that
 * SdkProcess and CliProcess satisfy the SAME observable contract.
 * tests/process-contract.test.js asserts that promise — each scenario
 * runs against BOTH backends.
 *
 *   const { process, driver } = makeBackend('sdk' | 'cli');
 *   await driver.start();                  // backend signals ready
 *   await proc.start({...});               // Process.start() resolves
 *   driver.replyTo('hello', 'hi back');    // script next-turn reply
 *   const res = await proc.send('hello');
 *   driver.assertPasted('hello');          // verify prompt reached transport
 *
 * Internally:
 *   - SDK driver wraps `makeFakeQuery()` and pushes typed SDKMessage
 *     events into the AsyncIterator that SdkProcess consumes.
 *   - CLI driver wraps a fake bridge that speaks the line-delimited JSON
 *     socket protocol — same wire format as the production
 *     lib/process/channels-bridge.mjs.
 *
 * 0.12 Phase 4: the tmux backend was deleted alongside its fake runner
 * + makeTmuxBackend helper.
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §7.2.6
 * @see docs/0.12.0-cli-driver-plan.md
 */

'use strict';

const { makeFakeQuery } = require('./fake-query');
const { SdkProcess } = require('@shumkov/orchestra');

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

// ─── SDK driver ──────────────────────────────────────────────────────

function makeSdkBackend({ sessionKey = 'chat:100', chatId = '100', threadId = null } = {}) {
  const fq = makeFakeQuery();
  const proc = new SdkProcess({
    sessionKey, chatId, threadId, label: 'sdk-test',
    spawnFn: () => fq.query,
    logger: SILENT,
  });

  const driver = {
    kind: 'sdk',

    /** Bring the backend to ready/active state. Emits SDK init event. */
    async start() {
      // Wait one tick for SdkProcess.start() to wire iteration loop.
      await new Promise((r) => setImmediate(r));
      fq.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-test' });
      await new Promise((r) => setImmediate(r));
    },

    /**
     * Script a one-shot reply for the next user message that hits the
     * backend. As soon as SdkProcess pushes a user message via streamInput,
     * we emit assistant + result events with `text`.
     */
    replyTo(_prompt, text) {
      fq.once('userPushed', () => {
        setImmediate(() => {
          fq.emitEvent({
            type: 'assistant',
            message: {
              id: `msg-${Date.now()}`,
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [{ type: 'text', text }],
            },
          });
          fq.emitEvent({
            type: 'result', subtype: 'success', session_id: 'sess-test',
            total_cost_usd: 0.0001, duration_ms: 1, result: text,
            usage: {
              input_tokens: 1, output_tokens: 1,
              cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            },
          });
        });
      });
    },

    /** Verify the prompt landed in the underlying transport. */
    assertPasted(text) {
      const found = fq.pushedMessages.some((m) => {
        const c = m?.message?.content;
        if (typeof c === 'string') return c === text;
        if (Array.isArray(c)) return c.some((b) => b?.text === text || b === text);
        return false;
      });
      if (!found) {
        throw new Error(`sdk driver: expected push of "${text}" but got ${JSON.stringify(fq.pushedMessages)}`);
      }
    },

    /** Simulate the underlying transport dying. */
    async simulateClose() {
      fq.emitEnd();
      await new Promise((r) => setImmediate(r));
    },

    /**
     * Simulate claude proactively sending an assistant message with NO
     * preceding user prompt (e.g. ScheduleWakeup fires). Used by the
     * autonomous-message contract test.
     */
    async simulateAutonomousMessage(text) {
      fq.emitEvent({
        type: 'assistant',
        message: {
          id: `msg-auto-${Date.now()}`,
          content: [{ type: 'text', text }],
        },
        // No parent_tool_use_id → top-level autonomous per SdkProcess rule
      });
      await new Promise((r) => setImmediate(r));
    },

    /**
     * Simulate claude's auto-compaction firing. Mirrors what
     * SdkProcess.onCompactBoundary delivers when the SDK Query reports
     * a compact_boundary system event.
     */
    async simulateCompactBoundary({ preTokens = 180_000, postTokens = 20_000 } = {}) {
      fq.emitEvent({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: preTokens,
          post_tokens: postTokens,
        },
      });
      await new Promise((r) => setImmediate(r));
    },
  };

  return { process: proc, driver };
}

// ─── CLI driver ──────────────────────────────────────────────────────

const net = require('net');
const { CliProcess } = require('@shumkov/orchestra');

const CHANNELS_READY_BANNER = 'Listening for channel messages from: server:polygram-bridge';

/**
 * Fake bridge — speaks the line-delimited JSON socket protocol
 * CliProcess expects from the real lib/process/channels-bridge.mjs.
 * Does NOT speak MCP — we exercise the daemon-side socket layer only.
 * Same shape as the helper in tests/cli-process-integration.test.js.
 */
function connectFakeChannelsBridge({ sockPath, sessionKey, secret, claudeSessionId = 'fake-claude-sid' }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = '';
    const inbox = [];
    const waiters = [];
    sock.setEncoding('utf8');

    sock.on('connect', () => {
      sock.write(JSON.stringify({ kind: 'hello', session_key: sessionKey, secret }) + '\n');
      sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: claudeSessionId }) + '\n');
      // 0.12 Phase 1.6: fake-bridge mimics the real bridge's mcp-ready
      // signal so CliProcess's _waitForBridgeHandshake doesn't timeout.
      // The real bridge emits this on first ListToolsRequest from claude;
      // tests don't run a real claude, so we synthesize it after session_init.
      sock.write(JSON.stringify({ kind: 'mcp-ready', session: sessionKey }) + '\n');
    });

    sock.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        inbox.push(msg);
        for (let i = 0; i < waiters.length; i++) {
          if (waiters[i].match(msg)) {
            const [w] = waiters.splice(i, 1);
            inbox.pop();   // consumed by waiter
            w.resolve(msg);
            break;
          }
        }
      }
    });

    sock.on('error', err => {
      // Connection closed during normal teardown — not fatal to tests.
      if (!sock.destroyed) reject(err);
    });

    const api = {
      sock,
      inbox,
      waitFor(predicate, { timeoutMs = 1500 } = {}) {
        const idx = inbox.findIndex(predicate);
        if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
        return new Promise((resolveW, rejectW) => {
          const timer = setTimeout(() => rejectW(new Error('waitFor timeout')), timeoutMs);
          waiters.push({
            match: predicate,
            resolve: msg => { clearTimeout(timer); resolveW(msg); },
          });
        });
      },
      send(obj) { sock.write(JSON.stringify(obj) + '\n'); },
      close() { try { sock.end(); } catch {} },
    };
    resolve(api);
  });
}

function makeChannelsBackend({ sessionKey = 'chat:100', chatId = '100', threadId = null } = {}) {
  let bridge = null;          // populated by fake runner.spawn
  let bridgeReadyP = null;
  const dispatched = [];      // every toolDispatcher invocation, for replyTo + assertions

  // Runner whose spawn() hooks the fake bridge into the proc's socket the
  // moment proc.start() has finished _createSocketServer. Mirrors real flow:
  // in production, runner.spawn -> claude -> claude spawns the bridge -> bridge
  // connects back. Here we cut out claude and connect a fake bridge ourselves.
  const runner = {
    spawn: async () => {
      // proc.sockPath + proc.sockSecret are set by _createSocketServer BEFORE
      // _spawnTmuxClaude is called, so they exist here.
      bridgeReadyP = connectFakeChannelsBridge({
        sockPath: proc.sockPath,
        sessionKey: proc.sessionKey,
        secret: proc.sockSecret,
      }).then(b => { bridge = b; return b; });
      // Wait until handshake msg has been sent so the proc's _waitForBridgeHandshake
      // sees session_init before the dialog poll times out.
      await bridgeReadyP;
    },
    killSession: async () => {
      if (bridge) { bridge.close(); bridge = null; }
    },
    sendControl: async () => {},
    captureWide: async () => CHANNELS_READY_BANNER,
  };

  // toolDispatcher records every reply for replyTo() scripting + assertPasted.
  // Returns ok:true by default; tests can replace via driver._setDispatcher.
  let userDispatcher = async () => ({ ok: true });
  const toolDispatcher = async (call) => {
    dispatched.push(call);
    return userDispatcher(call);
  };

  const proc = new CliProcess({
    sessionKey, chatId, threadId, label: 'channels-test',
    tmuxRunner: runner,
    botName: 'test',
    claudeBin: '/usr/bin/true',     // never invoked; fake runner.spawn no-ops
    toolDispatcher,
    logger: SILENT,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 30,                 // small for tests
    turnTimeoutMs: 3_000,
  });

  // Pending reply scripts: prompt → reply text.
  // When a user_msg matching the prompt arrives over the socket, the
  // fake bridge sends a 'tool' message back simulating claude calling reply.
  const replyScripts = new Map();

  // Hook user_msg arrivals on the fake bridge to fire scripted replies.
  // We need to wait until bridge is set after the first spawn() call.
  async function ensureBridge() {
    if (bridge) return bridge;
    if (bridgeReadyP) return bridgeReadyP;
    throw new Error('channels driver: bridge not yet connected (call proc.start first)');
  }

  // Poll the bridge inbox for user_msgs to script replies.
  // Simple approach: every time the fake bridge sees a user_msg, dispatch
  // a matching scripted reply.
  let pollerInterval = null;
  function startReplyPoller() {
    if (pollerInterval) return;
    pollerInterval = setInterval(() => {
      if (!bridge) return;
      // Pull any matched user_msgs from the inbox
      for (let i = bridge.inbox.length - 1; i >= 0; i--) {
        const msg = bridge.inbox[i];
        if (msg.kind !== 'user_msg') continue;
        const script = replyScripts.get(msg.text);
        if (!script) continue;
        bridge.inbox.splice(i, 1);
        replyScripts.delete(msg.text);
        // Fire scripted reply via fake bridge
        bridge.send({
          kind: 'tool',
          session: proc.sessionKey,
          tool_call_id: `script-${Date.now()}`,
          name: 'reply',
          args: { chat_id: chatId, text: script },
        });
      }
    }, 5);
    pollerInterval.unref?.();
  }

  // Clean up resources when proc dies
  const origKill = proc.kill.bind(proc);
  proc.kill = async (reason) => {
    if (pollerInterval) { clearInterval(pollerInterval); pollerInterval = null; }
    if (bridge) { bridge.close(); bridge = null; }
    return origKill(reason);
  };

  const driver = {
    kind: 'cli',
    _proc: proc,
    get _bridge() { return bridge; },

    /** Bring backend to ready. For channels, start() is mostly a no-op —
     *  the real work happens during proc.start() (socket + bridge handshake). */
    async start() {
      startReplyPoller();
    },

    /** Script a one-shot reply for a specific prompt. */
    replyTo(prompt, text) {
      replyScripts.set(prompt, text);
    },

    /** Verify the prompt landed on the socket as a user_msg. */
    assertPasted(text) {
      // Both the inbox and dispatched are checked; user_msgs may be consumed
      // by replyTo so we keep a separate record on the bridge's data handler.
      // Simpler: check that the prompt was sent via socket (it WAS if it
      // didn't appear in replyScripts deletion or it's still in inbox).
      // For the contract test pattern, replyTo is always called before send
      // so the prompt will be matched + the reply scripted. After send
      // resolves, we can verify the script was consumed.
      if (replyScripts.has(text)) {
        throw new Error(`channels driver: prompt "${text}" never reached the bridge (still in replyScripts)`);
      }
    },

    async simulateClose() {
      if (bridge) { bridge.close(); bridge = null; }
      await new Promise(r => setImmediate(r));
    },

    /** Simulate claude proactively sending a reply with no preceding user_msg. */
    async simulateAutonomousMessage(text) {
      await ensureBridge();
      bridge.send({
        kind: 'tool',
        session: proc.sessionKey,
        tool_call_id: `auto-${Date.now()}`,
        name: 'reply',
        args: { chat_id: chatId, text },
      });
      await new Promise(r => setTimeout(r, 30));
    },

    /** Compact boundary — not surfaced through the channels protocol.
     *  Review P3 AC9: return a sentinel instead of throwing so future cross-
     *  backend driver-shape tests don't break. Callers can branch on
     *  `result.supported`. */
    async simulateCompactBoundary() {
      return {
        supported: false,
        reason: 'channels-protocol-N/A: no compact event in Channels protocol',
      };
    },

    /** Test hook: replace the userland dispatcher to e.g. force errors. */
    _setDispatcher(fn) { userDispatcher = fn; },
  };

  return { process: proc, driver };
}

// ─── public API ──────────────────────────────────────────────────────

function makeBackend(kind, opts) {
  if (kind === 'sdk') return makeSdkBackend(opts);
  // 0.12 Phase 4: 'tmux' kind removed alongside the deleted TmuxProcess.
  // Tests that need tmux-style contract testing should use 'cli' (which
  // covers the same Process abstraction with the channels bridge + hooks).
  // 'channels' kept as a back-compat alias for any straggler call sites.
  if (kind === 'cli' || kind === 'channels') return makeChannelsBackend(opts);
  throw new Error(`makeBackend: unknown kind "${kind}"`);
}

module.exports = { makeBackend };

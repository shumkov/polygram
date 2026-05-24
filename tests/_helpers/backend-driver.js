/**
 * backend-driver — uniform test seam for SdkProcess and TmuxProcess.
 *
 * The Process abstraction (lib/process/process.js) promises that
 * SdkProcess and TmuxProcess satisfy the SAME observable contract.
 * tests/process-contract.test.js asserts that promise — each scenario
 * runs against BOTH backends. To run one test body against two very
 * different underlying transports (SDK AsyncIterator vs tmux pty),
 * each backend needs a `driver` that exposes the same scripting
 * surface.
 *
 *   const { process, driver } = makeBackend('sdk' | 'tmux');
 *   await driver.start();                  // backend signals ready
 *   await proc.start({...});               // Process.start() resolves
 *   driver.replyTo('hello', 'hi back');    // script next-turn reply
 *   const res = await proc.send('hello');
 *   driver.assertPasted('hello');          // verify prompt reached pty/stream
 *
 * Internally:
 *   - SDK driver wraps `makeFakeQuery()` and pushes typed SDKMessage
 *     events into the AsyncIterator that SdkProcess consumes.
 *   - tmux driver wraps a fake TmuxRunner whose `captureWide` returns
 *     scripted strings matching the TUI lifecycle (ready → streaming
 *     → ready-with-reply).
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §7.2.6
 */

'use strict';

const { makeFakeQuery } = require('./fake-query');
const { SdkProcess } = require('../../lib/process/sdk-process');
const { TmuxProcess } = require('../../lib/process/tmux-process');

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

// ─── tmux fake runner ────────────────────────────────────────────────

function makeFakeTmuxRunner({ onPasteMatchedReply = null } = {}) {
  const calls = [];
  // Replies queued by prompt. Each entry: { prompt, text }.
  // When the runner sees a paste matching `prompt`, it primes its
  // capture queue with: [readyAtStart, streaming, readyWithReply]
  // AND invokes onPasteMatchedReply(reply) — used by the tmux driver
  // to write a synthetic JSONL line carrying the usage block.
  const queuedReplies = [];
  let activeCapture = null;     // sequence currently being yielded
  let activeIndex = 0;
  let defaultCapture = '? for shortcuts';
  let killedSession = false;

  function primeCaptureForReply(replyText) {
    activeCapture = [
      'welcome\n? for shortcuts',
      '__streaming__',
      `welcome\n? for shortcuts\n${replyText}\n? for shortcuts`,
    ];
    activeIndex = 0;
    defaultCapture = `welcome\n? for shortcuts\n${replyText}\n? for shortcuts`;
  }

  const runner = {
    _calls: calls,
    _setDefaultCapture: (s) => { defaultCapture = s; },
    _enqueueReply: (prompt, text) => { queuedReplies.push({ prompt, text }); },

    spawn: async (opts) => { calls.push({ kind: 'spawn', ...opts }); },
    sendControl: async (name, key) => {
      calls.push({ kind: 'sendControl', name, key });
    },
    pasteText: async (name, text) => {
      calls.push({ kind: 'pasteText', name, text });
      // Mirror real runner: strip C0/DEL like lib/tmux/tmux-runner.js
      // does. Tests that don't include control chars get back the
      // input unchanged; tests that do need the stripped count to
      // exercise the prompt-sanitized event path.
      const sanitized = String(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      const stripped = text.length - sanitized.length;
      // Prime captures based on the sanitized prompt. 0.10.0 Phase 2:
      // the pasted text now carries an embedded <polygram-info>
      // correlation token, so the scripted prompt is a SUBSTRING of
      // what was pasted — match by containment.
      const idx = queuedReplies.findIndex((r) => sanitized.includes(r.prompt));
      if (idx !== -1) {
        const [reply] = queuedReplies.splice(idx, 1);
        primeCaptureForReply(reply.text);
        if (typeof onPasteMatchedReply === 'function') {
          try { onPasteMatchedReply(reply, sanitized); } catch { /* swallow */ }
        }
      }
      return { sanitized, oneLine: sanitized, stripped };
    },
    captureWide: async () => {
      if (activeCapture && activeIndex < activeCapture.length) {
        const v = activeCapture[activeIndex++];
        if (v === '__streaming__') return '? for shortcuts\nesc to interrupt';
        return v;
      }
      return defaultCapture;
    },
    capturePane: async () => defaultCapture,
    sessionExists: async () => !killedSession,
    killSession: async (name) => {
      calls.push({ kind: 'killSession', name });
      killedSession = true;
    },
    listPolygramSessions: async () => [],
    setPaneReadOnly: async () => {},
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };

  return runner;
}

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

// ─── tmux driver ─────────────────────────────────────────────────────

// Lifted to module-scope so the runner factory (which captures `proc`
// via closure) can call into fs/path without re-requiring per-call.
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTmuxBackend({ sessionKey = 'chat:100', chatId = '100', threadId = null } = {}) {
  // Isolated HOME so the per-session JSONL file lives in a temp dir we
  // can write to and clean up. We override HOME for the lifetime of
  // this backend instance.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-driver-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  // When a queued reply is pasted, write a synthetic JSONL line that
  // carries the assistant text + usage + stop_reason. The TmuxProcess
  // JSONL tail picks it up; this is what gives the contract suite
  // backend-realistic input (cost computation, stop_reason, usage
  // metrics all populate exactly like a real claude turn).
  const runner = makeFakeTmuxRunner({
    onPasteMatchedReply: (reply, pastedText) => {
      // 0.10.0 Phase 2: extract the correlation token embedded in the
      // pasted prompt so the synthetic JSONL reproduces the real
      // round-trip — a `user-message` carrying the token, then the
      // assistant reply. The turn ledger routes by that token.
      const token = (String(pastedText || '').match(/pgm-corr-[0-9a-f]+/) || [])[0] || null;
      // proc may not yet have _sessionLogPath if start() hasn't run.
      // Defer to next tick so start()'s _armSessionLogTail runs first.
      setImmediate(() => {
        if (!proc._sessionLogPath) return;
        try {
          fs.mkdirSync(path.dirname(proc._sessionLogPath), { recursive: true });
          // The turn's user-message — carries the token so the ledger
          // attributes the reply that follows.
          fs.appendFileSync(proc._sessionLogPath, JSON.stringify({
            type: 'user',
            sessionId: proc.claudeSessionId,
            message: {
              role: 'user',
              content: token
                ? `<polygram-info corr-id="${token}"></polygram-info>\n\nprompt`
                : 'prompt',
            },
          }) + '\n');
          fs.appendFileSync(proc._sessionLogPath, JSON.stringify({
            type: 'assistant',
            sessionId: proc.claudeSessionId,
            message: {
              model: 'claude-haiku-4-5-20251001',
              content: [{ type: 'text', text: reply.text }],
              stop_reason: 'end_turn',
              usage: {
                input_tokens: 10,
                output_tokens: 50,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 0,
              },
            },
          }) + '\n');
        } catch { /* swallow — tests may have cleaned up early */ }
      });
    },
  });
  const proc = new TmuxProcess({
    sessionKey, chatId, threadId, label: 'tmux-test',
    runner,
    botName: 'test',
    logger: SILENT,
    pollMs: 1,
    quiesceMs: 3,
    readyTimeoutMs: 500,
    turnTimeoutMs: 1000,
    pasteConfirmMs: 10,
  });

  // Restore HOME when the process is killed.
  const origKill = proc.kill.bind(proc);
  proc.kill = async (reason) => {
    try { await origKill(reason); }
    finally {
      process.env.HOME = prevHome;
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  };

  const driver = {
    kind: 'tmux',
    _tmpHome: tmpHome,

    /** Make captureWide return ready hint so waitForReady resolves. */
    async start() {
      runner._setDefaultCapture('welcome\n? for shortcuts');
    },

    /**
     * Script a one-shot reply for a specific prompt. When the runner
     * sees `pasteText(_, prompt)`, it primes its capture sequence so
     * the subsequent poll loop yields: ready → streaming → ready+reply.
     * This is prompt-aware so concurrent send() calls get the right
     * reply per-prompt.
     */
    replyTo(prompt, text) {
      runner._enqueueReply(prompt, text);
    },

    assertPasted(text) {
      // Phase 2: the pasted text carries an embedded correlation
      // token, so the prompt is a substring of what was pasted.
      const found = runner._calls.some((c) => c.kind === 'pasteText' && c.text.includes(text));
      if (!found) {
        const pastes = runner._calls.filter((c) => c.kind === 'pasteText').map((c) => c.text);
        throw new Error(`tmux driver: expected paste of "${text}" but got ${JSON.stringify(pastes)}`);
      }
    },

    async simulateClose() {
      // After this, captureWide / pasteText behave as the runner does
      // post-kill (sessionExists returns false). The Process itself
      // notices via send() failures, not an event — that's fine.
      await runner.killSession(proc.tmuxName);
    },

    /**
     * Simulate claude proactively sending an assistant message with NO
     * preceding user prompt (e.g. ScheduleWakeup fires). Writes to the
     * JSONL file that TmuxProcess._armSessionLogTail is watching.
     */
    async simulateAutonomousMessage(text) {
      const dir = path.dirname(proc._sessionLogPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(proc._sessionLogPath, JSON.stringify({
        type: 'assistant',
        sessionId: proc.claudeSessionId,
        message: { content: [{ type: 'text', text }] },
      }) + '\n');
      // Give the tail polling loop time to read.
      await new Promise((r) => setTimeout(r, 100));
    },

    /**
     * Simulate auto-compaction by writing two assistant messages to
     * the JSONL with a usage-token DROP between them. TmuxProcess
     * detects the drop and emits compact-boundary — same observable
     * outcome as SDK's native compact_boundary system event.
     */
    async simulateCompactBoundary({ preTokens = 180_000, postTokens = 20_000 } = {}) {
      const dir = path.dirname(proc._sessionLogPath);
      fs.mkdirSync(dir, { recursive: true });
      const writeUsageLine = (cacheRead) => {
        fs.appendFileSync(proc._sessionLogPath, JSON.stringify({
          type: 'assistant',
          sessionId: proc.claudeSessionId,
          message: {
            model: 'claude-haiku-4-5-20251001',
            content: [{ type: 'text', text: 't' }],
            usage: {
              input_tokens: 10,
              output_tokens: 50,
              cache_read_input_tokens: cacheRead - 10,
              cache_creation_input_tokens: 0,
            },
          },
        }) + '\n');
      };
      writeUsageLine(preTokens);
      await new Promise((r) => setTimeout(r, 80));
      writeUsageLine(postTokens);
      await new Promise((r) => setTimeout(r, 120));
    },
  };

  return { process: proc, driver };
}

// ─── channels driver ─────────────────────────────────────────────────

const net = require('net');
const { ChannelsProcess } = require('../../lib/process/channels-process');

const CHANNELS_READY_BANNER = 'Listening for channel messages from: server:polygram-bridge';

/**
 * Fake bridge — speaks the line-delimited JSON socket protocol
 * ChannelsProcess expects from the real lib/process/channels-bridge.mjs.
 * Does NOT speak MCP — we exercise the daemon-side socket layer only.
 * Same shape as the helper in tests/channels-process-integration.test.js.
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

  const proc = new ChannelsProcess({
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
    kind: 'channels',
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
  if (kind === 'tmux') return makeTmuxBackend(opts);
  if (kind === 'channels') return makeChannelsBackend(opts);
  throw new Error(`makeBackend: unknown kind "${kind}"`);
}

module.exports = { makeBackend };

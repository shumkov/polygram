'use strict';

/**
 * ChannelsProcess integration tests — exercise the daemon-side socket
 * protocol end-to-end with a fake bridge subprocess (just speaks the
 * line-delimited JSON socket protocol, no MCP). Covers:
 *
 *   - hello-handshake auth (correct + wrong secret)
 *   - bridge-ready signaling
 *   - tool dispatch → toolDispatcher invocation → tool_ack roundtrip
 *   - chat_id mismatch security guard
 *   - permission_request → approval-required event → verdict roundtrip
 *   - kill() teardown
 *   - concurrent sessions don't cross-talk
 *
 * Bypasses the real claude spawn by using a fake runner whose
 * captureWide() reports the "ready banner" immediately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');

const { ChannelsProcess } = require('../lib/process/channels-process');

const READY_BANNER = 'Listening for channel messages from: server:polygram-bridge';
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeFakeRunner({ paneText = READY_BANNER } = {}) {
  const calls = { spawn: [], killSession: [], sendControl: [], captureWide: [] };
  return {
    calls,
    spawn: async (opts) => { calls.spawn.push(opts); },
    killSession: async (name) => { calls.killSession.push(name); },
    sendControl: async (name, key) => { calls.sendControl.push({ name, key }); },
    captureWide: async (name) => { calls.captureWide.push(name); return paneText; },
  };
}

// Fake bridge — speaks the same line-delimited JSON the real
// bridge does, but no MCP layer.
function connectFakeBridge({ sockPath, sessionKey, secret, claudeSessionId = 'test-claude-sid' }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = '';
    const inbox = [];          // messages received from daemon
    const inboxWaiters = [];
    sock.setEncoding('utf8');

    sock.on('connect', () => {
      // hello + session_init
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
        while (inboxWaiters.length) {
          const w = inboxWaiters.shift();
          if (w.match(msg)) { w.resolve(msg); break; }
          else { inboxWaiters.unshift(w); break; }
        }
      }
    });

    sock.on('error', reject);

    resolve({
      sock,
      inbox,
      waitFor: predicate => {
        const idx = inbox.findIndex(predicate);
        if (idx >= 0) {
          const [msg] = inbox.splice(idx, 1);
          return Promise.resolve(msg);
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('waitFor timeout')), 3000);
          inboxWaiters.push({
            match: predicate,
            resolve: msg => { clearTimeout(timer); resolve(msg); },
          });
        });
      },
      send: obj => sock.write(JSON.stringify(obj) + '\n'),
      close: () => sock.end(),
    });
  });
}

function makeChannelsProcess({
  chatId = 'chat-1',
  toolDispatcher = async () => ({ ok: true }),
  paneText,
} = {}) {
  return new ChannelsProcess({
    sessionKey: `sess-${chatId}`,
    chatId,
    threadId: null,
    label: `test-${chatId}`,
    tmuxRunner: makeFakeRunner({ paneText }),
    botName: 'testbot',
    claudeBin: '/usr/bin/true',         // never actually invoked because runner is fake
    toolDispatcher,
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
  });
}

// Many tests need start() to complete. start() awaits the bridge handshake.
// Start it in the background then connect the fake bridge.
async function startWithFakeBridge(cp) {
  const startPromise = cp.start();
  // Wait for the socket file to exist (ChannelsProcess creates it before awaiting handshake)
  for (let i = 0; i < 50; i++) {
    if (cp.sockPath && fs.existsSync(cp.sockPath)) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const bridge = await connectFakeBridge({
    sockPath: cp.sockPath,
    sessionKey: cp.sessionKey,
    secret: cp.sockSecret,
  });
  await startPromise;
  return bridge;
}

// ─── tests ──────────────────────────────────────────────────────────

test('start() completes after fake bridge handshakes', async () => {
  const cp = makeChannelsProcess();
  const bridge = await startWithFakeBridge(cp);
  assert.equal(cp.bridgeReady, true);
  assert.ok(cp.sockPath);
  assert.ok(fs.existsSync(cp.sockPath), 'socket file exists');
  // mode-bit check — must be 0600
  const mode = fs.statSync(cp.sockPath).mode & 0o777;
  assert.equal(mode, 0o600, `socket mode: got ${mode.toString(8)}`);
  bridge.close();
  await cp.kill('test');
});

test('hello with wrong secret is rejected', async () => {
  const cp = makeChannelsProcess();
  const startPromise = cp.start();
  for (let i = 0; i < 50; i++) {
    if (cp.sockPath && fs.existsSync(cp.sockPath)) break;
    await new Promise(r => setTimeout(r, 20));
  }
  // Connect with wrong secret
  const bridge = await connectFakeBridge({
    sockPath: cp.sockPath,
    sessionKey: cp.sessionKey,
    secret: 'wrong-secret',
  });
  const reject = await bridge.waitFor(m => m.kind === 'hello_reject');
  assert.equal(reject.reason, 'auth');
  bridge.close();

  // start() should still be waiting (handshake never completed). Let it
  // timeout to keep the test fast — it'll throw, which is expected here.
  await assert.rejects(startPromise, /handshake timeout/);
  await cp.kill('test-cleanup');
});

test('tool call dispatches via toolDispatcher and ACKs', async () => {
  const dispatched = [];
  const cp = makeChannelsProcess({
    toolDispatcher: async (call) => {
      dispatched.push(call);
      return { ok: true };
    },
  });
  const bridge = await startWithFakeBridge(cp);

  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'call-1',
    name: 'reply',
    args: { chat_id: 'chat-1', text: 'hello world' },
  });

  const ack = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack.tool_call_id, 'call-1');
  assert.equal(ack.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].text, 'hello world');
  assert.equal(dispatched[0].toolName, 'reply');
  assert.equal(dispatched[0].chatId, 'chat-1');

  bridge.close();
  await cp.kill('test');
});

test('tool call with wrong chat_id is dropped (security guard)', async () => {
  const dispatched = [];
  const cp = makeChannelsProcess({
    chatId: 'chat-A',
    toolDispatcher: async (call) => { dispatched.push(call); return { ok: true }; },
  });
  const bridge = await startWithFakeBridge(cp);

  bridge.send({
    kind: 'tool',
    session: cp.sessionKey,
    tool_call_id: 'call-evil',
    name: 'reply',
    args: { chat_id: 'chat-B-EVIL', text: 'cross-user attempt' },
  });

  const ack = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack.ok, false);
  assert.match(ack.error, /chat_id mismatch/);
  assert.equal(dispatched.length, 0, 'toolDispatcher NOT invoked for mismatched chat_id');

  bridge.close();
  await cp.kill('test');
});

test('tool dispatcher failure surfaces as tool_ack ok:false', async () => {
  const cp = makeChannelsProcess({
    toolDispatcher: async () => ({ ok: false, error: 'telegram api down' }),
  });
  const bridge = await startWithFakeBridge(cp);

  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'c1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'hi' },
  });

  const ack = await bridge.waitFor(m => m.kind === 'tool_ack');
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'telegram api down');

  bridge.close();
  await cp.kill('test');
});

test('perm_req emits approval-required and respondToPermission round-trips', async () => {
  const cp = makeChannelsProcess();
  const bridge = await startWithFakeBridge(cp);

  const approvalP = new Promise(resolve => cp.once('approval-required', resolve));
  bridge.send({
    kind: 'perm_req',
    session: cp.sessionKey,
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'list dir',
    input_preview: 'ls -la',
  });
  const ap = await approvalP;
  // Canonical shape — matches TmuxProcess's emit signature so polygram's
  // existing onApprovalRequired handler works without changes.
  assert.equal(ap.id, 'abcde');
  assert.equal(ap.toolName, 'Bash');
  assert.equal(ap.toolInput.description, 'list dir');
  assert.equal(ap.toolInput.input_preview, 'ls -la');
  assert.equal(ap.backend, 'channels');
  assert.equal(typeof ap.respond, 'function');

  // Verdict via the canonical respond() closure
  await ap.respond('allow', 'optional-message-ignored-for-channels');
  const verdict = await bridge.waitFor(m => m.kind === 'perm_verdict');
  assert.equal(verdict.request_id, 'abcde');
  assert.equal(verdict.behavior, 'allow');

  bridge.close();
  await cp.kill('test');
});

test('send() resolves after reply tool call + quiet window', async () => {
  const cp = new ChannelsProcess({
    sessionKey: 'sess-quiet', chatId: 'chat-1', threadId: null, label: 'test-quiet',
    tmuxRunner: makeFakeRunner(), botName: 'testbot', claudeBin: '/usr/bin/true',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    handshakeTimeoutMs: 2000,
    turnQuietMs: 100,           // small for test
    turnTimeoutMs: 5_000,
  });

  const bridge = await startWithFakeBridge(cp);

  const sendP = cp.send('do the thing');
  // Wait for the user_msg to propagate
  const userMsg = await bridge.waitFor(m => m.kind === 'user_msg');
  assert.equal(userMsg.text, 'do the thing');

  // Simulate claude calling reply tool
  bridge.send({
    kind: 'tool', session: cp.sessionKey, tool_call_id: 'r1',
    name: 'reply', args: { chat_id: 'chat-1', text: 'done' },
  });
  await bridge.waitFor(m => m.kind === 'tool_ack');

  // After the quiet window (100ms), send() should resolve
  const result = await sendP;
  assert.equal(result.text, 'done');
  assert.equal(result.error, null);
  assert.equal(result.metrics.numAssistantMessages, 1);

  bridge.close();
  await cp.kill('test');
});

test('kill() tears down socket file and rejects pending turns', async () => {
  const cp = makeChannelsProcess();
  const bridge = await startWithFakeBridge(cp);

  // Pre-attach rejection assertion BEFORE triggering kill, otherwise
  // the synchronous rejection in kill() races with node:test's
  // unhandled-rejection trap.
  const sendP = cp.send('hello');
  const rejectAssertion = assert.rejects(sendP, /killed/);
  await bridge.waitFor(m => m.kind === 'user_msg');

  await cp.kill('test-shutdown');
  assert.equal(cp.closed, true);
  assert.ok(!fs.existsSync(cp.sockPath), 'socket file unlinked');

  await rejectAssertion;
  bridge.close();
});

test('two concurrent sessions have isolated sockets and routing', async () => {
  const cpA = makeChannelsProcess({ chatId: 'chat-A' });
  const cpB = makeChannelsProcess({ chatId: 'chat-B' });

  const bridgeA = await startWithFakeBridge(cpA);
  const bridgeB = await startWithFakeBridge(cpB);

  assert.notEqual(cpA.sockPath, cpB.sockPath, 'distinct socket paths');
  assert.notEqual(cpA.sockSecret, cpB.sockSecret, 'distinct secrets');

  // Send a tool call on bridge A; verify only A's process sees it
  let sawOnA = 0;
  let sawOnB = 0;
  cpA.toolDispatcher = async () => { sawOnA++; return { ok: true }; };
  cpB.toolDispatcher = async () => { sawOnB++; return { ok: true }; };

  bridgeA.send({
    kind: 'tool', session: cpA.sessionKey, tool_call_id: 'a1',
    name: 'reply', args: { chat_id: 'chat-A', text: 'A-only' },
  });
  await bridgeA.waitFor(m => m.kind === 'tool_ack');
  assert.equal(sawOnA, 1);
  assert.equal(sawOnB, 0, 'no cross-talk to B');

  bridgeA.close();
  bridgeB.close();
  await cpA.kill('test'); await cpB.kill('test');
});

'use strict';

/**
 * Integration test: pm:'tmux' chat routes through ProcessManager →
 * factory → TmuxProcess end-to-end against a stubbed TmuxRunner that
 * simulates a claude TUI lifecycle (READY → STREAMING → READY-with-reply).
 *
 * Covers:
 *   - factory routes pm:'tmux' to TmuxProcess
 *   - pm.getOrSpawn fully wires Process callbacks (init/result/idle)
 *   - pm.send returns text + duration through the abstract API
 *   - pm.kill closes the underlying tmux session
 *   - Weighted LRU: a tmux process (cost=3) co-existing with SDK (cost=1)
 *     stays within the budget without evicting itself.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ProcessManager } = require('../lib/process-manager');
const { createProcessFactory } = require('../lib/process/factory');

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

// Simulated TUI lifecycle: ready → user pastes → streaming → ready w/ reply.
function makeFakeTmuxRunner({ replyText = 'hello back!' } = {}) {
  const calls = [];
  // capture sequence per spawn lifecycle:
  //   1. start.waitForReady → ready hint
  //   2. send.captureAtStart → ready (prelude)
  //   3+ send.poll → first streaming, then ready with reply text
  let inTurn = false;
  let turnCaptureN = 0;
  return {
    _calls: calls,
    spawn: async (opts) => { calls.push({ kind: 'spawn', ...opts }); },
    sendControl: async (name, key) => {
      calls.push({ kind: 'sendControl', name, key });
      if (key === 'Enter') {
        inTurn = true;
        turnCaptureN = 0;
      }
    },
    pasteText: async (name, text) => {
      calls.push({ kind: 'pasteText', name, text });
      return { sanitized: text, oneLine: text, stripped: 0 };
    },
    captureWide: async () => {
      if (!inTurn) return 'welcome\n? for shortcuts';
      turnCaptureN++;
      // 1st: captureAtStart — ready (no reply yet)
      // 2nd: streaming
      // 3rd+: ready with reply
      if (turnCaptureN === 1) return 'welcome\n? for shortcuts';
      if (turnCaptureN === 2) return 'welcome\n? for shortcuts\nesc to interrupt';
      return `welcome\n? for shortcuts\n${replyText}\n? for shortcuts`;
    },
    capturePane: async () => '',
    sessionExists: async () => true,
    killSession: async (name) => { calls.push({ kind: 'killSession', name }); },
    listPolygramSessions: async () => [],
    setPaneReadOnly: async () => {},
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };
}

// Capturing sdkCallbacks for assertion
function makeCallbacks() {
  const log = [];
  const noop = () => {};
  return {
    log,
    onInit: (key, msg) => log.push({ k: 'init', key, msg }),
    onClose: (key, code) => log.push({ k: 'close', key, code }),
    onResult: (key, msg, head) => log.push({ k: 'result', key, msg, head }),
    onStreamChunk: noop,
    onToolUse: noop,
    onAssistantMessageStart: noop,
    onAutonomousAssistantMessage: noop,
    onCompactBoundary: noop,
    onQueueDrop: noop,
    onThinking: noop,
    onIdle: (key) => log.push({ k: 'idle', key }),
  };
}

describe('pm:tmux integration', () => {
  test('end-to-end: factory→TmuxProcess→send→kill', async () => {
    const config = { chats: { 100: { pm: 'tmux', model: 'sonnet', effort: 'high', cwd: '/work' } } };
    const runner = makeFakeTmuxRunner();
    const callbacks = makeCallbacks();
    const factory = createProcessFactory({
      config,
      spawnFn: () => ({}), // SDK not used on this path
      tmuxRunner: runner,
      botName: 'shumabit',
      logger: SILENT,
    });
    const pm = new ProcessManager({
      processFactory: factory,
      callbacks,
      logger: SILENT,
      budget: 10,
    });

    // Override TmuxProcess polling tunables to test-fast.
    const origFactory = factory;
    const fastFactory = (key, ctx) => {
      const p = origFactory(key, ctx);
      // Patch TmuxProcess tunables via post-construct mutation (tests only)
      if (p.backend === 'tmux') {
        p.pollMs = 1;
        p.quiesceMs = 3;
        p.readyTimeoutMs = 500;
        p.turnTimeoutMs = 500;
      }
      return p;
    };
    pm.processFactory = fastFactory;

    const proc = await pm.getOrSpawn('chat:100', {
      chatId: '100',
      threadId: null,
      label: 'test',
      chatConfig: config.chats[100],
      existingSessionId: null,
    });
    assert.equal(proc.backend, 'tmux');
    assert.equal(proc.cost, 3);
    assert.ok(runner._calls.some((c) => c.kind === 'spawn'));

    const result = await proc.send('what time is it?');
    assert.equal(result.error, null);
    assert.ok(result.text.includes('hello back!'));
    assert.equal(result.metrics.resultSubtype, 'success');

    // Callbacks fired
    assert.ok(callbacks.log.some((e) => e.k === 'init'));
    assert.ok(callbacks.log.some((e) => e.k === 'result'));

    await pm.shutdown();
    // Underlying tmux session killed
    assert.ok(runner._calls.some((c) => c.kind === 'killSession'));
  });

  test('weighted LRU: tmux (cost=3) co-exists with budget=10', async () => {
    const config = {
      chats: {
        100: { pm: 'tmux', model: 'sonnet', effort: 'high', cwd: '/w1' },
        200: { pm: 'tmux', model: 'sonnet', effort: 'high', cwd: '/w2' },
      },
    };
    const runner = makeFakeTmuxRunner();
    const factory = createProcessFactory({
      config,
      spawnFn: () => ({}),
      tmuxRunner: runner,
      botName: 'shumabit',
      logger: SILENT,
    });
    const pm = new ProcessManager({
      processFactory: (k, ctx) => {
        const p = factory(k, ctx);
        if (p.backend === 'tmux') { p.pollMs = 1; p.quiesceMs = 3; p.readyTimeoutMs = 500; p.turnTimeoutMs = 500; }
        return p;
      },
      callbacks: makeCallbacks(),
      logger: SILENT,
      budget: 10,
    });

    const p1 = await pm.getOrSpawn('chat:100', {
      chatId: '100', threadId: null, label: 'c1',
      chatConfig: config.chats[100], existingSessionId: null,
    });
    const p2 = await pm.getOrSpawn('chat:200', {
      chatId: '200', threadId: null, label: 'c2',
      chatConfig: config.chats[200], existingSessionId: null,
    });
    // Two tmux procs at cost=3 each = 6 ≤ budget 10; both alive.
    assert.equal(pm.size, 2);
    assert.equal(p1.closed, false);
    assert.equal(p2.closed, false);

    await pm.shutdown();
  });
});

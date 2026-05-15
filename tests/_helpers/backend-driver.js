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
      // Prime captures based on sanitized prompt match.
      const idx = queuedReplies.findIndex((r) => r.prompt === sanitized);
      if (idx !== -1) {
        const [reply] = queuedReplies.splice(idx, 1);
        primeCaptureForReply(reply.text);
        if (typeof onPasteMatchedReply === 'function') {
          try { onPasteMatchedReply(reply); } catch { /* swallow */ }
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
    onPasteMatchedReply: (reply) => {
      // proc may not yet have _sessionLogPath if start() hasn't run.
      // Defer to next tick so start()'s _armSessionLogTail runs first.
      setImmediate(() => {
        if (!proc._sessionLogPath) return;
        try {
          fs.mkdirSync(path.dirname(proc._sessionLogPath), { recursive: true });
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
      const found = runner._calls.some((c) => c.kind === 'pasteText' && c.text === text);
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

// ─── public API ──────────────────────────────────────────────────────

function makeBackend(kind, opts) {
  if (kind === 'sdk') return makeSdkBackend(opts);
  if (kind === 'tmux') return makeTmuxBackend(opts);
  throw new Error(`makeBackend: unknown kind "${kind}"`);
}

module.exports = { makeBackend };

/**
 * Tests the JSONL-tail event path added in v9 (Phase 3).
 *
 *   1. start() pre-allocates a UUID for --session-id when no existingSessionId
 *   2. start() passes --resume when existingSessionId provided (no --session-id)
 *   3. JSONL writes during a turn surface as stream-chunk / tool-use events
 *   4. result event in JSONL resolves the turn promise (faster than capture-pane)
 *   5. metric resolvedVia field reports which path won the race
 *   6. last-prompt fallback completion when no result event fires
 *   7. kill() closes the tail
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TmuxProcess } = require('../lib/process/tmux-process');

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

/**
 * Runner that returns READY for the start() ready-check, then switches
 * to STREAMING for the rest of the test so the capture-pane quiescence
 * fallback never resolves — JSONL is the only race winner. Tests can
 * call `runner._markIdle()` to flip back to READY if they need to
 * exercise the capture-pane fallback path.
 */
function makeRunner({ defaultCapture = '? for shortcuts' } = {}) {
  const calls = [];
  let killed = false;
  let captureMode = 'ready';   // 'ready' | 'streaming'
  let startReadyConsumed = false;
  return {
    _calls: calls,
    _markIdle: () => { captureMode = 'ready'; },
    _markStreaming: () => { captureMode = 'streaming'; },
    spawn: async (opts) => { calls.push({ kind: 'spawn', ...opts }); },
    sendControl: async (n, k) => {
      calls.push({ kind: 'sendControl', name: n, key: k });
      // Pressing Enter transitions the TUI to "streaming" — block
      // capture-pane quiescence until JSONL drives completion.
      if (k === 'Enter') captureMode = 'streaming';
    },
    pasteText: async (n, t) => {
      calls.push({ kind: 'pasteText', name: n, text: t });
      return { sanitized: t, oneLine: t, stripped: 0 };
    },
    captureWide: async () => {
      // First ready-check during start() must return READY so
      // waitForReady resolves.
      if (!startReadyConsumed) {
        startReadyConsumed = true;
        return defaultCapture;
      }
      return captureMode === 'streaming'
        ? 'PRELUDE\n? for shortcuts\nesc to interrupt'
        : defaultCapture;
    },
    capturePane: async () => defaultCapture,
    sessionExists: async () => !killed,
    killSession: async (n) => { calls.push({ kind: 'killSession', name: n }); killed = true; },
    listPolygramSessions: async () => [],
    setPaneReadOnly: async () => {},
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };
}

function makeProc(runner, opts = {}) {
  return new TmuxProcess({
    sessionKey: 'chat:100', chatId: '100', threadId: null, label: 'test',
    runner, botName: 'shumabit', logger: SILENT,
    pollMs: 5, quiesceMs: 10, readyTimeoutMs: 500, turnTimeoutMs: 5000,
    ...opts,
  });
}

// Use a real temp cwd + write JSONL there so the path computation works.
function setupTempCwd() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-proc-test-'));
  // Set HOME so sessionLogPath resolves to our tmp.
  const homeBackup = process.env.HOME;
  process.env.HOME = tmp;
  fs.mkdirSync(path.join(tmp, '.claude', 'projects'), { recursive: true });
  return { cwd: tmp, cleanup: () => {
    process.env.HOME = homeBackup;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }};
}

function jsonlPath(homeDir, cwd, sessionId) {
  const enc = cwd.replace(/\//g, '-');
  const dir = path.join(homeDir, '.claude', 'projects', enc);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('TmuxProcess — JSONL session-log path', () => {

  test('start() with no existingSessionId pre-allocates UUID + passes --session-id', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner);
      await p.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd } });
      assert.ok(p.claudeSessionId, 'sessionId should be set');
      assert.match(p.claudeSessionId, /^[0-9a-f-]{36}$/, 'sessionId should be a UUID');
      const spawn = runner._calls.find((c) => c.kind === 'spawn');
      assert.ok(spawn.args.includes('--session-id'));
      assert.ok(spawn.args.includes(p.claudeSessionId));
      assert.ok(!spawn.args.includes('--resume'));
      await p.kill('test');
    } finally { env.cleanup(); }
  });

  test('start() with existingSessionId passes --resume, no --session-id', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner);
      await p.start({
        existingSessionId: 'abcd1234-1111-2222-3333-444444444444',
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });
      const spawn = runner._calls.find((c) => c.kind === 'spawn');
      assert.ok(spawn.args.includes('--resume'));
      assert.ok(spawn.args.includes('abcd1234-1111-2222-3333-444444444444'));
      assert.ok(!spawn.args.includes('--session-id'));
      await p.kill('test');
    } finally { env.cleanup(); }
  });

  test('JSONL assistant chunk → stream-chunk event; result → send() resolves', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });

      const chunks = [];
      p.on('stream-chunk', (txt) => chunks.push(txt));

      const sendP = p.send('what is 2+2?');
      // Let send() install its turnResultP listener
      await sleep(20);

      // Write JSONL lines: assistant chunk then result.
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: '4' }] },
      }) + '\n');
      await sleep(80);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: '4' }], stop_reason: 'end_turn' },
      }) + '\n');

      const res = await sendP;
      assert.equal(res.error, null);
      assert.ok(res.text.includes('4'));
      assert.equal(res.metrics.resolvedVia, 'jsonl');
      assert.equal(res.metrics.resultSubtype, 'success');
      assert.equal(res.metrics.stopReason, 'end_turn');
      assert.ok(chunks.length >= 1);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('JSONL tool_use → tool-use event + numToolUses count', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'bbbbbbbb-1111-2222-3333-cccccccccccc';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });

      const tools = [];
      p.on('tool-use', (name) => tools.push(name));

      const sendP = p.send('list files');
      await sleep(20);

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          content: [
            { type: 'text', text: 'OK' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
          stop_reason: 'tool_use',
        },
      }) + '\n');
      await sleep(40);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' },
      }) + '\n');

      const res = await sendP;
      // Note: first stop_reason was tool_use; result event for it resolves the
      // race. text may be partial. Verify tools captured + numToolUses tracked.
      assert.ok(tools.includes('Bash'));
      assert.ok(res.metrics.numToolUses >= 1);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('last-prompt acts as fallback turn-complete when no stop_reason fires', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'cccccccc-1111-2222-3333-dddddddddddd';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });

      const sendP = p.send('hi');
      await sleep(20);
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // assistant text, no stop_reason
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'hello!' }] },
      }) + '\n');
      await sleep(40);
      // last-prompt as the close signal
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'last-prompt',
        lastPrompt: 'hi',
      }) + '\n');

      const res = await sendP;
      assert.equal(res.error, null);
      assert.ok(res.text.includes('hello!'));
      assert.equal(res.metrics.stopReason, 'last-prompt');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('JSONL assistant event WITHOUT in-flight turn fires autonomous-assistant-message', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner);
      const sessionId = 'eeeeeeee-aaaa-bbbb-cccc-dddddddddddd';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });
      // NO send() — we never set _turnState. Now simulate claude
      // emitting an autonomous assistant message (the ScheduleWakeup
      // fire pattern: no user prompt preceded it).
      const fired = new Promise((resolve) => p.once('autonomous-assistant-message', resolve));
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: '⏰ Lunch reminder fired!' }] },
      }) + '\n');
      const ev = await Promise.race([
        fired,
        new Promise((_, rej) => setTimeout(() => rej(new Error('autonomous-assistant-message not emitted')), 500)),
      ]);
      assert.ok(ev.text.includes('Lunch reminder'));
      assert.equal(ev.sessionId, sessionId);
      assert.equal(ev.backend, 'tmux');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('JSONL usage events drive getContextUsage() (compaction visibility)', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'aaaa1111-2222-3333-4444-cccccccccccc';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });

      // Before any turn → unsupported.
      await assert.rejects(() => p.getContextUsage(),
        (err) => err.code === 'UNSUPPORTED_OPERATION');

      // Simulate an assistant message with usage in the JSONL.
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'context check' }],
          usage: {
            input_tokens: 10,
            output_tokens: 100,
            cache_read_input_tokens: 140_000,  // ~70% of 200k → triggers hint threshold
            cache_creation_input_tokens: 0,
          },
        },
      }) + '\n');
      // Wait for the tail to pick it up.
      await sleep(100);

      const usage = await p.getContextUsage();
      // 10 (input) + 100 (output) + 140_000 (cache_read) + 0 (cache_creation)
      assert.equal(usage.totalTokens, 140_110);
      assert.equal(usage.maxTokens, 200_000);
      assert.ok(usage.percentage >= 70 && usage.percentage <= 71);
      assert.equal(usage.isAutoCompactEnabled, true);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('mid-turn steer fires assistant-message-start on next chunk + resets accumulator', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 5000 });
      const sessionId = 'bbbb2222-aaaa-bbbb-cccc-eeeeeeeeeeee';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });
      const startedEvents = [];
      const chunks = [];
      p.on('assistant-message-start', () => startedEvents.push(Date.now()));
      p.on('stream-chunk', (txt) => chunks.push(txt));

      const sendP = p.send('count to 10 slowly');
      await sleep(20);

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Pre-steer assistant text lands.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: { content: [{ type: 'text', text: '1\n2\n3' }] },
      }) + '\n');
      await sleep(80);

      // User steers mid-turn. inFlight is true → inject returns true.
      const injected = p.injectUserMessage({ content: 'also include letters' });
      assert.equal(injected, true);

      // Post-steer assistant chunk arrives.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: {
          content: [{ type: 'text', text: 'A 1\nB 2\nC 3' }],
          stop_reason: 'end_turn',
        },
      }) + '\n');

      const res = await sendP;

      // Exactly one assistant-message-start fired (when post-steer chunk landed).
      assert.equal(startedEvents.length, 1,
        `expected 1 assistant-message-start, got ${startedEvents.length}`);
      // The accumulator was reset before the post-steer chunk: the
      // final pmResult.text contains ONLY the post-steer content, not
      // the pre-steer "1\n2\n3" prefix.
      assert.ok(res.text.includes('A 1'), `expected post-steer text, got ${JSON.stringify(res.text)}`);
      assert.ok(!res.text.startsWith('1\n2\n3'),
        `bubble should have been reset; got ${JSON.stringify(res.text)}`);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('token drop between turns fires compact-boundary event', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'cccc3333-aaaa-bbbb-cccc-ffffffffffff';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });
      const compactEvents = [];
      p.on('compact-boundary', (ev) => compactEvents.push(ev));

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);

      // Turn 1: 150k tokens accumulated (near compaction threshold).
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: {
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'first turn' }],
          usage: {
            input_tokens: 10,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 150_000,
          },
        },
      }) + '\n');
      await sleep(100);
      assert.equal(compactEvents.length, 0, 'no compaction yet, just a high-token turn');

      // Turn 2: claude auto-compacted; tokens drop to ~25k.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: {
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'post-compact turn' }],
          usage: {
            input_tokens: 10,
            output_tokens: 50,
            cache_read_input_tokens: 25_000,
            cache_creation_input_tokens: 0,
          },
        },
      }) + '\n');
      await sleep(100);

      assert.equal(compactEvents.length, 1, 'expected exactly one compact-boundary event');
      const ev = compactEvents[0];
      assert.equal(ev.trigger, 'auto');
      // pre: 10 (input) + 100 (output) + 0 (cache_read) + 150_000 (cache_creation)
      assert.equal(ev.pre_tokens, 150_110);
      // post: 10 (input) + 50 (output) + 25_000 (cache_read) + 0 (cache_creation)
      assert.equal(ev.post_tokens, 25_060);
      assert.equal(ev.backend, 'tmux');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('small fluctuations in token count do NOT fire compact-boundary', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'dddd4444-aaaa-bbbb-cccc-aaaaaaaaaaaa';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });
      const compactEvents = [];
      p.on('compact-boundary', (ev) => compactEvents.push(ev));

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Two turns with a small natural cache-eviction drop (~10%).
      for (const total of [50_000, 47_500]) {
        fs.appendFileSync(logPath, JSON.stringify({
          type: 'assistant', sessionId,
          message: {
            model: 'claude-haiku-4-5-20251001',
            content: [{ type: 'text', text: 'turn' }],
            usage: {
              input_tokens: 10,
              output_tokens: 50,
              cache_read_input_tokens: total - 10,
              cache_creation_input_tokens: 0,
            },
          },
        }) + '\n');
        await sleep(80);
      }
      assert.equal(compactEvents.length, 0, '10% drop is not compaction, should be ignored');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('kill() closes the JSONL tail', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner);
      await p.start({ chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd } });
      assert.ok(p._sessionLogTail, 'tail should exist after start');
      await p.kill('test');
      assert.equal(p._sessionLogTail, null);
    } finally { env.cleanup(); }
  });

  test('result event updates claudeSessionId if claude assigned different one', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const requestedSessionId = 'dddddddd-1111-2222-3333-eeeeeeeeeeee';
      await p.start({
        existingSessionId: requestedSessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });
      assert.equal(p.claudeSessionId, requestedSessionId);

      const sendP = p.send('hi');
      await sleep(20);

      const logPath = jsonlPath(env.cwd, env.cwd, requestedSessionId);
      // claude reports a different sessionId in the result event (e.g. fork)
      const reassignedSessionId = 'eeeeeeee-1111-2222-3333-ffffffffffff';
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId: reassignedSessionId,
        message: { content: [{ type: 'text', text: 'hi back' }], stop_reason: 'end_turn' },
      }) + '\n');

      const res = await sendP;
      // Process should adopt the reassigned id from the result event.
      assert.equal(p.claudeSessionId, reassignedSessionId);
      assert.equal(res.sessionId, reassignedSessionId);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  // ─── autosteer fold-vs-queue extra-turn extraction (rc.7) ───────────
  //
  // Empirically validated 2026-05-15 against a real claude TUI session:
  //   - Pasting mid-turn triggers a {type:queue-operation,operation:enqueue,
  //     content:...} JSONL entry.
  //   - The TUI consumes that queued paste in ONE of TWO ways:
  //
  //     A) FOLD — when the agent is still actively generating
  //        (typically a pending tool result is about to land), the
  //        queued prompt is consumed as {type:attachment,
  //        attachment:{type:queued_command, prompt:...}} INSIDE the
  //        current turn. The agent's reply now addresses both messages
  //        — one Telegram reply suffices.
  //
  //     B) NEW TURN — when the agent already emitted its final text
  //        (short turn, no in-flight tool), the queued prompt is
  //        dequeued as a top-level {type:user, message:{content:"..."}}
  //        JSONL entry and the model runs a fresh turn for it. The
  //        primary turn's reply addresses only the first message;
  //        polygram MUST extract the second turn's reply or it's lost.
  //
  // The bug Ivan reported on shumorobot 2026-05-15: turn 2 reply went
  // to /dev/null because TmuxProcess.send() returns after turn 1's
  // result and stops watching. These tests pin the rc.7 fix: track
  // pending autosteers, detect fold-vs-new-turn, emit
  // 'extra-turn-reply' { msgId, text } for the NEW TURN case.

  test('autosteer FOLD path: queue-folded event clears the pending autosteer; no extra-turn-reply emitted', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'fffffff1-1111-2222-3333-fffffffffff1';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const autosteeredContent = 'and this https://discogs/release/abc';
      const autosteeredMsgId = 658;
      let extraReplyEvents = 0;
      p.on('extra-turn-reply', () => { extraReplyEvents++; });

      // Mirror production order: send() starts (turn becomes inFlight),
      // THEN the autosteer arrives while turn is processing. Calling
      // injectUserMessage before send() would early-return because the
      // process isn't inFlight yet — and no autosteer would register.
      const sendP = p.send('download https://youtube/foo');
      await sleep(20);
      const okInject = p.injectUserMessage({ content: autosteeredContent, msgId: autosteeredMsgId });
      assert.equal(okInject, true, 'injectUserMessage must succeed when turn is in flight');

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Turn 1: agent uses a tool, then the queue gets folded as an
      // attachment.queued_command (FOLD signal).
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
          stop_reason: 'tool_use',
        },
      }) + '\n');
      await sleep(20);
      // FOLD signal — the autosteered prompt is absorbed.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: autosteeredContent, commandMode: 'prompt' },
      }) + '\n');
      await sleep(20);
      // Final assistant text addresses both
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          content: [{ type: 'text', text: 'Both done.' }],
          stop_reason: 'end_turn',
        },
      }) + '\n');

      const res = await sendP;
      assert.equal(res.error, null);
      // Note: the tool_use stop_reason in the first JSONL line resolves
      // the turn race early; we don't assert on the final text since
      // it's not the test's goal. (Existing "tool_use" test in this
      // file documents the same partial-text behavior.) The point of
      // THIS test is that the queue-folded event cleared the pending
      // autosteer so no spurious extra-turn-reply fires.

      // Give a beat in case any spurious extra-turn-reply tries to fire
      await sleep(80);
      assert.equal(extraReplyEvents, 0,
        'FOLD path must NOT emit extra-turn-reply — the primary reply already covers both messages');
      // Sanity: the pending autosteer is also cleared (defends against
      // a later top-level user message with the same content
      // incorrectly triggering extra-turn extraction).
      assert.equal(p._pendingAutosteers.length, 0,
        'queue-folded should remove the matching pending autosteer');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('autosteer NEW TURN path: dequeued user-message triggers second-turn extraction; emits extra-turn-reply with correct msgId', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'fffffff2-1111-2222-3333-fffffffffff2';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const autosteeredContent = 'and this https://discogs/release/abc';
      const autosteeredMsgId = 658;
      const extraReplies = [];
      p.on('extra-turn-reply', (ev) => extraReplies.push(ev));

      const sendP = p.send('download https://youtube/foo');
      await sleep(20);
      // Now (turn 1 inFlight) the autosteer arrives — production flow
      assert.equal(
        p.injectUserMessage({ content: autosteeredContent, msgId: autosteeredMsgId }),
        true, 'injectUserMessage must succeed when turn is in flight',
      );

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Turn 1: short — model emits final text immediately, no tool.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          content: [{ type: 'text', text: 'Already done — Midnight Picnic.mp3' }],
          stop_reason: 'end_turn',
        },
      }) + '\n');

      const res = await sendP;
      assert.equal(res.error, null);
      assert.ok(res.text.includes('Midnight Picnic'),
        'primary turn reply should be turn 1 text alone');

      // Now turn 2 happens: TUI dequeues the autosteered paste as a
      // fresh top-level user message, then the model replies.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'user',
        sessionId,
        message: { role: 'user', content: autosteeredContent },
      }) + '\n');
      await sleep(20);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          content: [{ type: 'text', text: 'Also already done — Neon Affair 4 tracks.' }],
          stop_reason: 'end_turn',
        },
      }) + '\n');

      // Give the tail + handler time to process
      await sleep(80);

      assert.equal(extraReplies.length, 1,
        'NEW TURN path must emit exactly one extra-turn-reply');
      assert.equal(extraReplies[0].msgId, autosteeredMsgId,
        'extra-turn-reply must carry the autosteered msgId so polygram routes the reply correctly');
      assert.ok(extraReplies[0].text.includes('Neon Affair'),
        'extra-turn-reply text must be the second turn\'s assistant reply');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('user-message that does NOT match a pending autosteer is ignored (no spurious extra-turn-reply)', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'fffffff3-1111-2222-3333-fffffffffff3';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      // No injectUserMessage call → no pending autosteers.
      let extras = 0;
      p.on('extra-turn-reply', () => { extras++; });

      const sendP = p.send('first');
      await sleep(20);
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'one' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sendP;

      // Spurious top-level user message — must NOT trigger extra-turn-reply
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'user',
        sessionId,
        message: { role: 'user', content: 'a totally unrelated message' },
      }) + '\n');
      await sleep(40);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'two' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sleep(50);

      assert.equal(extras, 0,
        'top-level user message without a matching pending autosteer must not emit extra-turn-reply');
      await p.kill('done');
    } finally { env.cleanup(); }
  });
});

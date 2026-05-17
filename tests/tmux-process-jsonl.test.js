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

// TmuxProcess.start() verifies the pinned claude binary exists
// (lib/claude-bin.js); the real binary isn't present in CI. Point
// the override at the node executable — always present. The fake
// runner never actually execs it.
if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

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
    pasteConfirmMs: 10,   // Phase 3 §5: short paste-gate for deterministic tests
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

// ─── 0.10.0 Phase 2 helpers — correlation token + turn ledger ────────
//
// Every TmuxProcess paste now embeds a pgm-corr-<hex> token in its
// <polygram-info> block; the JSONL `user-message` reproduces it; the
// turn ledger routes by exact token lookup. Hand-written JSONL
// fixtures must therefore include a `user-message` line per turn.

/** Correlation tokens embedded in the prompts pasted so far, in order.
 *  Read AFTER `await sleep(...)` so the fire-and-forget paste landed. */
function pastedTokens(runner) {
  return runner._calls
    .filter((c) => c.kind === 'pasteText')
    .map((c) => (String(c.text).match(/pgm-corr-[0-9a-f]+/) || [])[0])
    .filter(Boolean);
}

/** A top-level JSONL `user` line. With `token`, it carries that token
 *  in a <polygram-info> block (the real round-trip shape). With
 *  token=null it is token-less — exercising the orphan-primary
 *  fallback in _routeUserMessage. */
function userLine(sessionId, token, label = 'prompt') {
  const content = token
    ? `<polygram-info corr-id="${token}"></polygram-info>\n\n${label}`
    : label;
  return `${JSON.stringify({
    type: 'user', sessionId, message: { role: 'user', content },
  })}\n`;
}

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

      // Write JSONL lines: the turn's user-message (so the ledger
      // attributes it), then an assistant chunk, then the result.
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, userLine(sessionId, null));
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
      fs.appendFileSync(logPath, userLine(sessionId, null));
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
      // rc.11 update: the first stop_reason='tool_use' is NON-TERMINAL
      // and no longer resolves the turn — pm.send waits for
      // 'end_turn'. So res.text reflects the FULL accumulated text
      // ("OK\n\nDone.") rather than the partial "OK" we'd see if the
      // turn had resolved early.
      assert.ok(tools.includes('Bash'));
      assert.ok(res.metrics.numToolUses >= 1);
      assert.match(res.text, /Done\./, 'rc.11: pm.send waits past intermediate tool_use stop_reason and includes the post-tool text');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('rc.11 REGRESSION: pm.send does NOT resolve on stop_reason=tool_use (intermediate); waits for end_turn', async () => {
    // Ivan caught this on shumorobot 2026-05-15 (msg 681 "how many
    // folders" → 18:23:44 tool_use → reactor cleared → 14s of silent
    // gap → reply landed via autonomous-wakeup at 18:23:58). Pre-rc.11
    // the parser's synthesized 'result' event for stop_reason='tool_use'
    // resolved _turnState and pm.send returned with empty text + 1
    // numToolUses, so polygram's tool-only-completion branch fired
    // and cleared reactions while the agent was STILL processing.
    // This test pins the fix: intermediate tool_use does NOT end
    // the turn; only end_turn (or another terminal stop_reason) does.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'aabbccdd-1111-2222-3333-eeeeeeeeeeee';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });

      let sendResolved = false;
      const sendP = p.send('list folders').then((r) => { sendResolved = true; return r; });
      await sleep(20);

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, userLine(sessionId, null));
      // Step 1: intermediate tool_use — must NOT resolve pm.send.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
          stop_reason: 'tool_use',
        },
      }) + '\n');
      await sleep(80);
      assert.equal(sendResolved, false,
        'pm.send MUST NOT resolve on intermediate tool_use — pre-rc.11 it did, causing the 14s reaction-gap regression');

      // Step 2: terminal end_turn — must resolve pm.send.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: '2 folders.' }], stop_reason: 'end_turn' },
      }) + '\n');
      const res = await sendP;
      assert.equal(sendResolved, true);
      assert.match(res.text, /2 folders/,
        'pm.send returns the FINAL terminal-turn text, not the empty intermediate state');
      assert.equal(res.metrics.numToolUses, 1);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('rc.11: max_tokens and stop_sequence ARE terminal — pm.send resolves', async () => {
    // Defensive: only 'tool_use' is non-terminal; other stop_reasons
    // (max_tokens, stop_sequence, refusal) end the turn cleanly.
    for (const stop of ['max_tokens', 'stop_sequence']) {
      const env = setupTempCwd();
      try {
        const runner = makeRunner();
        const p = makeProc(runner, { turnTimeoutMs: 3000 });
        const sessionId = 'aabbccdd-1111-2222-3333-eeeeeeeeeee' + (stop === 'max_tokens' ? '1' : '2');
        await p.start({
          existingSessionId: sessionId,
          chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
        });
        const sendP = p.send('terse');
        await sleep(20);
        const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
        fs.appendFileSync(logPath, userLine(sessionId, null));
        fs.appendFileSync(logPath, JSON.stringify({
          type: 'assistant',
          sessionId,
          message: {
            content: [{ type: 'text', text: 'truncated' }],
            stop_reason: stop,
          },
        }) + '\n');
        const res = await sendP;
        assert.match(res.text, /truncated/,
          `${stop} is terminal — pm.send must resolve and return the text`);
        await p.kill('done');
      } finally { env.cleanup(); }
    }
  });

  test('Phase 1 — zero-concurrency empty-turn: thinking line then text line, SAME message.id, both end_turn → turn delivers the real text', async () => {
    // Verified against real claude 2.1.142 JSONL: one logical assistant
    // message is written across MULTIPLE JSONL lines that all share the
    // same `message.id` and all repeat the message-level `stop_reason`.
    // A terminal message commonly arrives as a `thinking` line followed
    // by a `text` line — both carrying stop_reason=end_turn, same id.
    //
    // Pre-Phase-1, the per-line parser fired a `result` on the FIRST
    // (thinking) line: it has stop_reason=end_turn but no text block,
    // so the turn resolved with text='' BEFORE the real-text line was
    // read. That is the zero-concurrency empty-turn bug — no autosteer,
    // no burst, just a turn whose final message thinks before it speaks.
    //
    // Post-Phase-1, the SessionEventAggregator coalesces lines by
    // message.id and fires `result` ONCE, on finalize, with the full
    // text. RED before the aggregator, GREEN after.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'eeee0001-1111-2222-3333-eeeeeeeeeee0';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const sendP = p.send('think, then answer');
      await sleep(20);
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, userLine(sessionId, null));

      // Line 1 — the thinking segment of the FINAL message. Carries
      // stop_reason=end_turn but NO text block.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          id: 'msg_PHASE1A',
          content: [{ type: 'thinking', thinking: 'Let me work this out…' }],
          stop_reason: 'end_turn',
        },
      }) + '\n');
      await sleep(60);
      // Line 2 — the text segment of the SAME message. Same id, same
      // stop_reason, the real answer.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          id: 'msg_PHASE1A',
          content: [{ type: 'text', text: 'REAL ANSWER 42' }],
          stop_reason: 'end_turn',
        },
      }) + '\n');
      await sleep(40);
      // A trailing non-assistant line — claude always writes `system`
      // lines right after a turn's final assistant message. This is
      // what finalizes the coalesced message in steady state.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'system', sessionId, subtype: 'turn_complete',
      }) + '\n');

      const res = await sendP;
      assert.equal(res.error, null);
      assert.ok(res.text && res.text.length > 0,
        `turn MUST deliver non-empty text — pre-Phase-1 the thinking line resolved it empty (got ${JSON.stringify(res.text)})`);
      assert.match(res.text, /REAL ANSWER 42/,
        'the delivered reply is the text segment, not the empty thinking segment');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('L2 REGRESSION: last-prompt WITHOUT prior text does NOT resolve the turn (it\'s a "prompt registered" marker, not "turn done")', async () => {
    // claude v2.1.142 writes last-prompt JSONL events when a user
    // prompt is REGISTERED (before the agent replies). Pre-L2 the
    // parser treated any last-prompt as a turn-complete fallback,
    // which resolved pm.send with empty text in sequential
    // scenarios (caught in spike's three-sequential-sends turn 3:
    // 4/5 runs returned empty before the agent emitted ANY text).
    // Post-L2, last-prompt only resolves the turn if accumulated
    // text is non-empty (treating last-prompt as a safety net for
    // missing end_turn, NOT as a primary turn-end signal).
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 500 });
      const sessionId = 'cccccccc-2222-3333-4444-eeeeeeeeeeee';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'haiku', effort: 'low', cwd: env.cwd },
      });
      const sendP = p.send('hi');
      await sleep(20);
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Write JUST a last-prompt — no assistant text before it. The
      // OLD behaviour would have synthesised a success result with
      // text='' and resolved pm.send immediately. Post-L2, this
      // event is IGNORED (no text accumulated yet).
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'last-prompt',
        lastPrompt: 'hi',
      }) + '\n');
      // sendP should NOT resolve from the last-prompt alone. It
      // should run to turnTimeoutMs (500ms) and return a timeout
      // result (text=''). That's correct — a turn with NO text
      // emission should time out, not pretend to succeed.
      const res = await sendP;
      // Should have timed out, NOT come back with stopReason='last-prompt'
      // (which was the old wrong behaviour).
      assert.notEqual(res.metrics.stopReason, 'last-prompt',
        'last-prompt without text must NOT short-circuit the turn');
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
      fs.appendFileSync(logPath, userLine(sessionId, null));
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
      fs.appendFileSync(logPath, userLine(sessionId, null));
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
      fs.appendFileSync(logPath, userLine(requestedSessionId, null));
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

  test('autosteer FOLD: autosteer user-message arrives while the primary streams → folds, no extra-turn-reply', async () => {
    // Phase 2: a fold is recorded, not reconstructed. The autosteer's
    // own user-message carries its correlation token; when it lands
    // while the primary turn is still in the active group, the two
    // turns share one reply — autosteer-resolution(via:fold) fires,
    // and NO separate extra-turn-reply: the primary's reply covers it.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'fffffff1-1111-2222-3333-fffffffffff1';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const autosteeredMsgId = 658;
      const resolutions = [];
      let extraReplyEvents = 0;
      p.on('autosteer-resolution', (ev) => resolutions.push(ev));
      p.on('extra-turn-reply', () => { extraReplyEvents++; });

      const sendP = p.send('download https://youtube/foo');
      await sleep(20);
      const okInject = p.injectUserMessage({
        content: 'and this https://discogs/release/abc', msgId: autosteeredMsgId,
      });
      assert.equal(okInject, true, 'injectUserMessage must succeed when turn is in flight');
      await sleep(20);
      const [primTok, autoTok] = pastedTokens(runner);

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Primary's user-message — the primary turn joins the active group.
      fs.appendFileSync(logPath, userLine(sessionId, primTok));
      await sleep(20);
      // Autosteer's user-message lands WHILE the primary is still in
      // the group → it FOLDS into the primary's turn.
      fs.appendFileSync(logPath, userLine(sessionId, autoTok, 'autosteer'));
      await sleep(20);
      // One combined reply addresses both messages.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'Both done.' }], stop_reason: 'end_turn' },
      }) + '\n');

      const res = await sendP;
      assert.equal(res.error, null);
      assert.match(res.text, /Both done/);
      await sleep(60);
      assert.equal(extraReplyEvents, 0,
        'FOLD path must NOT emit extra-turn-reply — the primary reply already covers both');
      const foldRes = resolutions.find((r) => r.msgId === autosteeredMsgId);
      assert.ok(foldRes && foldRes.via === 'fold',
        `autosteer ${autosteeredMsgId} must resolve via fold (got ${JSON.stringify(foldRes)})`);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('autosteer NEW-TURN: multi-line autosteer content routes by token (not by content matching)', async () => {
    // Pre-Phase-2 this path matched the autosteer by CONTENT — and the
    // pasteText \n → ' / ' transform broke the match for every
    // multi-line prompt (which every polygram inbound is). Phase 2
    // routes by the embedded correlation token, so the autosteer's
    // content shape is irrelevant: a multi-line autosteer is matched
    // exactly like any other.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'aabbccdd-aaaa-bbbb-cccc-dddddddddddd';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const autosteeredMsgId = 686;
      const extraReplies = [];
      p.on('extra-turn-reply', (ev) => extraReplies.push(ev));

      const sendP = p.send('primary turn');
      await sleep(20);
      // Multi-line autosteer content — what real polygram prompts look
      // like. The \n → ' / ' transform no longer matters: routing is
      // by token, not content.
      assert.equal(
        p.injectUserMessage({
          content: '<polygram-info>line1\nline2</polygram-info>\n\n<channel>foo</channel>',
          msgId: autosteeredMsgId,
        }),
        true,
      );
      await sleep(20);
      const [primTok, autoTok] = pastedTokens(runner);

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Primary turn 1 completes (short, no tools).
      fs.appendFileSync(logPath, userLine(sessionId, primTok));
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: '👍' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sendP;

      // TUI dequeues the autosteer as a NEW user turn — primary done.
      fs.appendFileSync(logPath, userLine(sessionId, autoTok, 'autosteer'));
      await sleep(20);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'extra-reply content' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sleep(80);

      assert.equal(extraReplies.length, 1,
        'extra-turn-reply MUST fire for the NEW-TURN autosteer');
      assert.equal(extraReplies[0].msgId, autosteeredMsgId);
      assert.match(extraReplies[0].text, /extra-reply content/);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('autosteer NEW-TURN: dequeued autosteer user-message → extra-turn-started + extra-turn-reply with correct msgId', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'fffffff2-1111-2222-3333-fffffffffff2';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const autosteeredMsgId = 658;
      const extraReplies = [];
      const extraStarts = [];
      p.on('extra-turn-reply', (ev) => extraReplies.push(ev));
      p.on('extra-turn-started', (ev) => extraStarts.push(ev));

      const sendP = p.send('download https://youtube/foo');
      await sleep(20);
      assert.equal(
        p.injectUserMessage({ content: 'and this https://discogs/release/abc', msgId: autosteeredMsgId }),
        true, 'injectUserMessage must succeed when turn is in flight',
      );
      await sleep(20);
      const [primTok, autoTok] = pastedTokens(runner);

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Turn 1: short — model emits final text immediately, no tool.
      fs.appendFileSync(logPath, userLine(sessionId, primTok));
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

      // Turn 2: the TUI dequeues the autosteer as a fresh user turn
      // (primary already done → NEW-TURN, not fold).
      fs.appendFileSync(logPath, userLine(sessionId, autoTok, 'autosteer'));
      await sleep(20);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          content: [{ type: 'text', text: 'Also already done — Neon Affair 4 tracks.' }],
          stop_reason: 'end_turn',
        },
      }) + '\n');
      await sleep(80);

      assert.equal(extraReplies.length, 1,
        'NEW-TURN path must emit exactly one extra-turn-reply');
      assert.equal(extraReplies[0].msgId, autosteeredMsgId,
        'extra-turn-reply must carry the autosteered msgId');
      assert.ok(extraReplies[0].text.includes('Neon Affair'),
        'extra-turn-reply text must be the second turn\'s assistant reply');
      assert.equal(extraStarts.length, 1,
        'NEW-TURN path must emit exactly one extra-turn-started');
      assert.equal(extraStarts[0].msgId, autosteeredMsgId,
        'extra-turn-started must carry the autosteered msgId');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('concurrent extra-turn + new primary: token routing keeps msg 692 and msg 694 replies separate', async () => {
    // Captured live on shumorobot 2026-05-15 (the rc.12.1 trace):
    //   1) msg 691 → primary turn 1
    //   2) msg 692 (during turn 1) → autosteered
    //   3) turn 1 ends short → TUI dequeues msg 692 as a NEW turn
    //   4) msg 694 → a fresh primary pm.send
    //   5) msg 692's turn-2 reply AND msg 694's turn-3 reply both
    //      stream in — and must not cross-attribute.
    // Pre-Phase-2 this depended on a fragile accumulator-priority
    // swap. Now each turn's user-message carries its own token, so
    // routing is unambiguous regardless of interleaving.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 5000 });
      const sessionId = 'aabbccdd-1212-1212-1212-aaaaaaaaaaaa';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const autoMsgId = 692;
      const extraReplies = [];
      p.on('extra-turn-reply', (ev) => extraReplies.push(ev));

      // Primary turn 1 + a mid-turn autosteer for msg 692.
      const turn1P = p.send('primary turn 1');
      await sleep(20);
      assert.equal(
        p.injectUserMessage({ content: 'autosteered turn 2 content', msgId: autoMsgId }),
        true,
      );
      await sleep(20);
      const [tok1, tokAuto] = pastedTokens(runner);

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // Turn 1 completes.
      fs.appendFileSync(logPath, userLine(sessionId, tok1));
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'turn1-reply' }], stop_reason: 'end_turn' },
      }) + '\n');
      await turn1P;

      // TUI dequeues msg 692 as a NEW turn (primary done → new-turn).
      fs.appendFileSync(logPath, userLine(sessionId, tokAuto, 'auto692'));
      await sleep(30);

      // msg 694's fresh primary pm.send starts.
      const turn3P = p.send('primary turn 3 (msg 694)');
      await sleep(20);
      const tok3 = pastedTokens(runner)[2];

      // msg 692's turn-2 reply lands FIRST (flushes the auto692 group).
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'turn2-extra-reply' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sleep(40);
      // Then msg 694's own user-message + reply.
      fs.appendFileSync(logPath, userLine(sessionId, tok3));
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'turn3-reply' }], stop_reason: 'end_turn' },
      }) + '\n');

      const turn3Result = await turn3P;

      assert.equal(extraReplies.length, 1,
        'exactly one extra-turn-reply, for msg 692');
      assert.equal(extraReplies[0].msgId, autoMsgId,
        'the extra-turn-reply must carry msgId=692, never msg 694');
      assert.match(extraReplies[0].text, /turn2-extra-reply/,
        'msg 692 reply must NOT be cross-attributed to msg 694');
      assert.match(turn3Result.text, /turn3-reply/,
        'msg 694 primary turn receives its own reply, never msg 692\'s');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('user-message with no recognised token is ignored (no spurious extra-turn-reply)', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'fffffff3-1111-2222-3333-fffffffffff3';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      let extras = 0;
      p.on('extra-turn-reply', () => { extras++; });

      const sendP = p.send('first');
      await sleep(20);
      const [tok1] = pastedTokens(runner);
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, userLine(sessionId, tok1));
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'one' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sendP;

      // A token-less user-message with no pasted primary awaiting it
      // → no match → ignored. (Primary done & pruned from the ledger.)
      fs.appendFileSync(logPath, userLine(sessionId, null, 'a totally unrelated message'));
      await sleep(40);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'two' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sleep(50);

      assert.equal(extras, 0,
        'an unrecognised user-message must not emit extra-turn-reply');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  // ─── Phase 2 B1 — concatenation immunity ───────────────────────────

  test('Phase 2 B1 — concatenated user-message carrying TWO tokens folds N turns cleanly (no duplicate, no cross-attribution)', async () => {
    // The TUI can concatenate two pastes landing close together into
    // ONE user-message. Pre-Phase-2 the substring matcher then popped
    // the wrong pending and fanned the shared text out per msgId —
    // duplicate + cross-attributed replies. With tokens, a
    // user-message containing N tokens is an EXPLICIT, unambiguous
    // fold of N turns: the primary's reply covers them all, once.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'b1b1b1b1-1111-2222-3333-b1b1b1b1b1b1';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const resolutions = [];
      let extraReplyEvents = 0;
      p.on('autosteer-resolution', (ev) => resolutions.push(ev));
      p.on('extra-turn-reply', () => { extraReplyEvents++; });

      const sendP = p.send('primary message');
      await sleep(20);
      assert.equal(p.injectUserMessage({ content: 'autosteer message', msgId: 777 }), true);
      await sleep(20);
      const [primTok, autoTok] = pastedTokens(runner);

      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      // ONE user-message line carrying BOTH tokens — the concatenated
      // paste. The boundary between the two messages is GONE, but the
      // two tokens still say exactly which two turns the TUI merged.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'user',
        sessionId,
        message: {
          role: 'user',
          content: `<polygram-info corr-id="${primTok}"></polygram-info> / `
            + `<polygram-info corr-id="${autoTok}"></polygram-info> / merged`,
        },
      }) + '\n');
      await sleep(20);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { content: [{ type: 'text', text: 'one shared reply' }], stop_reason: 'end_turn' },
      }) + '\n');

      const res = await sendP;
      assert.match(res.text, /one shared reply/,
        'the primary turn receives the shared reply');
      await sleep(60);
      assert.equal(extraReplyEvents, 0,
        'a fold delivers NO extra-turn-reply — the primary reply covers the folded autosteer');
      const r777 = resolutions.find((r) => r.msgId === 777);
      assert.ok(r777 && r777.via === 'fold',
        `the concatenated autosteer resolves via fold (got ${JSON.stringify(r777)})`);
      assert.equal(resolutions.filter((r) => r.msgId === 777).length, 1,
        'autosteer 777 resolves EXACTLY once — no duplicate');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('Phase 3 §5 — paste gating: the autosteer paste waits until the primary paste is JSONL-confirmed', async () => {
    // §5 converts the 50ms post-Enter drain GUESS into a real barrier:
    // a paste does not release the next paste until the JSONL tail
    // confirms it landed (its token surfaced in a user-message). Two
    // pastes therefore cannot concatenate into one TUI input.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      // High pasteConfirmMs so the gate opens ONLY via JSONL confirm,
      // never via timeout — the test asserts the confirm path.
      const p = makeProc(runner, { turnTimeoutMs: 4000, pasteConfirmMs: 5000 });
      const sessionId = 'aaaa5555-1111-2222-3333-aaaaaaaaaaaa';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const sendP = p.send('primary');
      await sleep(40);
      const pasted1 = pastedTokens(runner);
      assert.equal(pasted1.length, 1, 'the primary prompt was pasted');

      // Autosteer while the primary paste is unconfirmed.
      assert.equal(p.injectUserMessage({ content: 'autosteer', msgId: 1 }), true);
      await sleep(80);
      assert.equal(pastedTokens(runner).length, 1,
        'the autosteer paste is GATED — the primary paste is not yet JSONL-confirmed');

      // Write the primary's user-message → confirms paste 1 → the
      // paste gate opens for the autosteer.
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, userLine(sessionId, pasted1[0]));
      await sleep(120);
      assert.equal(pastedTokens(runner).length, 2,
        'the autosteer paste proceeds once the primary paste is JSONL-confirmed');

      // Finish the turn cleanly.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sendP;
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('queue-operation remove folds a queued autosteer into the running turn (no user-message follows)', async () => {
    // Verified JSONL (claude 2.1.142): an autosteer pasted during a
    // turn is `queue-operation enqueue`d, then — when the TUI folds it
    // into the running turn — `queue-operation remove`d. NO
    // user-message follows. The fold must be resolved from the
    // remove, or the autosteer leaks forever (caught by the
    // multi-3-rapid real-TUI spike).
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'fffd0001-1111-2222-3333-fffd0001fffd';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });

      const resolutions = [];
      let extraReplyEvents = 0;
      p.on('autosteer-resolution', (ev) => resolutions.push(ev));
      p.on('extra-turn-reply', () => { extraReplyEvents++; });

      const sendP = p.send('primary');
      await sleep(20);
      const primTok = pastedTokens(runner)[0];
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, userLine(sessionId, primTok));
      await sleep(20);
      assert.equal(p.injectUserMessage({ content: 'autosteer', msgId: 501 }), true);
      await sleep(20);
      const autoTok = pastedTokens(runner)[1];

      // The TUI parks the autosteer, then FOLDS it into the running
      // turn — enqueue (carries the token), then remove.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'queue-operation', sessionId, operation: 'enqueue',
        content: `<polygram-info corr-id="${autoTok}"></polygram-info> autosteer`,
      }) + '\n');
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'queue-operation', sessionId, operation: 'remove',
      }) + '\n');
      await sleep(40);
      // The primary's single reply covers both messages.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: { content: [{ type: 'text', text: 'covered both' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sendP;
      await sleep(40);

      const r501 = resolutions.find((r) => r.msgId === 501);
      assert.ok(r501 && r501.via === 'fold',
        `the removed (folded) autosteer resolves via fold (got ${JSON.stringify(r501)})`);
      assert.equal(extraReplyEvents, 0,
        'a folded autosteer gets NO extra-turn-reply — the primary reply covers it');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('Phase 4 §7 — a stale autosteer (never correlated) is swept at turn completion', async () => {
    // An autosteer paste the TUI never correlated — no enqueue,
    // remove, dequeue, or user-message — is dead. The stale-turn
    // sweep fails it loud at the next turn completion so it cannot
    // leak in the ledger (and its reaction state cannot dangle).
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = '5eee7777-1111-2222-3333-5eee77775eee';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });
      const matchMisses = [];
      p.on('autosteer-match-miss', (ev) => matchMisses.push(ev));

      const sendP = p.send('primary');
      await sleep(20);
      const primTok = pastedTokens(runner)[0];
      // An autosteer the TUI never acts on.
      assert.equal(p.injectUserMessage({ content: 'lost', msgId: 999 }), true);
      const autoTurn = p._ledger.find((t) => t.kind === 'autosteer');
      assert.ok(autoTurn && autoTurn.state === 'pasted', 'autosteer turn parked in the ledger');
      // Backdate it well past the staleness grace window.
      autoTurn.startedAt -= 10 * 60_000;

      // Complete the primary turn → _finishTurn → stale-turn sweep.
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, userLine(sessionId, primTok));
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sendP;
      await sleep(40);

      const stale = matchMisses.find((m) => m.phase === 'stale-sweep' && m.msgId === 999);
      assert.ok(stale, 'the stale autosteer emitted a stale-sweep diagnostic');
      assert.ok(!p._ledger.some((t) => t === autoTurn),
        'the stale autosteer was pruned from the ledger');
      assert.equal(autoTurn.state, 'failed', 'the stale autosteer is marked failed');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('R1 — a primary turn timeout retires its folded autosteers (no active-group leak)', async () => {
    // Review finding R1: when a primary turn ends WITHOUT a terminal
    // result (timeout/error), autosteers folded into its active group
    // were left `streaming` forever — leaking, and keeping
    // `_activeGroup` non-empty so the next autonomous assistant
    // message was swallowed instead of emitted. RED before the
    // _finishTurn group-retire; GREEN after.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 400 });
      const sessionId = 'aaaa0001-1111-2222-3333-aaaa0001aaaa';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });
      const autonomous = [];
      p.on('autonomous-assistant-message', (ev) => autonomous.push(ev));

      const sendP = p.send('primary');
      await sleep(20);
      const primTok = pastedTokens(runner)[0];
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      fs.appendFileSync(logPath, userLine(sessionId, primTok));
      await sleep(20);
      assert.equal(p.injectUserMessage({ content: 'autosteer', msgId: 5 }), true);
      await sleep(30);
      const autoTok = pastedTokens(runner)[1];
      // The TUI folds the autosteer into the running turn.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'queue-operation', sessionId, operation: 'enqueue',
        content: `<polygram-info corr-id="${autoTok}"></polygram-info> a`,
      }) + '\n');
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'queue-operation', sessionId, operation: 'remove',
      }) + '\n');
      await sleep(20);
      // NO terminal result is ever written → the primary turn times out.
      const res = await sendP;
      assert.equal(res.metrics.resultSubtype, 'TMUX_TURN_TIMEOUT');
      assert.equal(p._activeGroup.turns.length, 0,
        'the active group is retired after a primary turn ends unflushed');

      // A subsequent autonomous assistant message must surface — not
      // be swallowed into a stranded group.
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: { content: [{ type: 'text', text: 'autonomous ping' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sleep(60);
      assert.ok(autonomous.some((e) => /autonomous ping/.test(e.text || '')),
        'an autonomous assistant message after the timeout is emitted, not swallowed');
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('R2 — a primary paste routed through the TUI queue does not desync the enqueue FIFO', async () => {
    // Review finding R2: a primary turn's paste that the TUI queues
    // (queue-operation enqueue→dequeue) was not tracked in
    // `_enqueuedTurns` (an autosteer-only filter), so the positional
    // `dequeue` shift popped the autosteer instead — and the later
    // `remove` then folded nothing. RED before tracking all queued
    // turns; GREEN after.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'aaaa0002-1111-2222-3333-aaaa0002aaaa';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });
      const resolutions = [];
      p.on('autosteer-resolution', (ev) => resolutions.push(ev));

      const sendP = p.send('primary');
      await sleep(20);
      const primTok = pastedTokens(runner)[0];
      assert.equal(p.injectUserMessage({ content: 'autosteer', msgId: 42 }), true);
      await sleep(30);
      const autoTok = pastedTokens(runner)[1];
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);
      const qop = (operation, token) => JSON.stringify({
        type: 'queue-operation', sessionId, operation,
        ...(token ? { content: `<polygram-info corr-id="${token}"></polygram-info> x` } : {}),
      }) + '\n';
      // The primary paste itself was queued, then the autosteer.
      fs.appendFileSync(logPath, qop('enqueue', primTok));
      fs.appendFileSync(logPath, qop('enqueue', autoTok));
      // The primary is released to run...
      fs.appendFileSync(logPath, qop('dequeue', null));
      fs.appendFileSync(logPath, userLine(sessionId, primTok));
      // ...then the autosteer is folded into it.
      fs.appendFileSync(logPath, qop('remove', null));
      await sleep(30);
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      }) + '\n');
      await sendP;
      await sleep(40);

      const r42 = resolutions.find((r) => r.msgId === 42);
      assert.ok(r42 && r42.via === 'fold',
        `autosteer 42 must still fold despite the primary paste being queued (got ${JSON.stringify(r42)})`);
      await p.kill('done');
    } finally { env.cleanup(); }
  });

  test('R5 — kill() releases pending paste-confirm waiters', async () => {
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000, pasteConfirmMs: 60_000 });
      const sessionId = 'aaaa0005-1111-2222-3333-aaaa0005aaaa';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });
      p.send('primary').catch(() => {});
      await sleep(30);
      // The primary paste registered a confirm waiter (no JSONL
      // user-message written → it would otherwise wait pasteConfirmMs).
      assert.ok(p._pasteConfirms.size >= 1, 'a paste-confirm waiter is pending');
      await p.kill('done');
      assert.equal(p._pasteConfirms.size, 0, 'kill() drained the paste-confirm waiters');
    } finally { env.cleanup(); }
  });

  test('R6 — _extractTokens matches the exact 24-hex token shape', () => {
    const env = setupTempCwd();
    try {
      const p = makeProc(makeRunner());
      const tok = `pgm-corr-${'a1b2c3d4e5f6'.repeat(2)}`; // pgm-corr- + 24 hex
      // A token immediately followed by adjacent hex still extracts
      // EXACTLY the 24-char token, not an over-match.
      assert.deepEqual(p._extractTokens(`${tok}deadbeef`), [tok]);
      assert.deepEqual(p._extractTokens(`<polygram-info corr-id="${tok}">`), [tok]);
      assert.deepEqual(p._extractTokens('no token here'), []);
    } finally { env.cleanup(); }
  });

  test('Phase 2 B1b — two primary turns route by token; replies never cross-attribute', async () => {
    // Tokens are injective: turn A and turn B each get their own
    // reply even when delivered back-to-back. No substring collision,
    // no accumulator desync.
    const env = setupTempCwd();
    try {
      const runner = makeRunner();
      const p = makeProc(runner, { turnTimeoutMs: 3000 });
      const sessionId = 'b1b2b1b2-1111-2222-3333-b1b2b1b2b1b2';
      await p.start({
        existingSessionId: sessionId,
        chatConfig: { model: 'sonnet', effort: 'low', cwd: env.cwd },
      });
      const logPath = jsonlPath(env.cwd, env.cwd, sessionId);

      const r1P = p.send('turn A');
      await sleep(20);
      const tokA = pastedTokens(runner)[0];
      fs.appendFileSync(logPath, userLine(sessionId, tokA));
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: { content: [{ type: 'text', text: 'reply-A' }], stop_reason: 'end_turn' },
      }) + '\n');
      const r1 = await r1P;

      const r2P = p.send('turn B');
      await sleep(20);
      const tokB = pastedTokens(runner)[1];
      assert.notEqual(tokA, tokB, 'each turn mints a unique token');
      fs.appendFileSync(logPath, userLine(sessionId, tokB));
      fs.appendFileSync(logPath, JSON.stringify({
        type: 'assistant', sessionId,
        message: { content: [{ type: 'text', text: 'reply-B' }], stop_reason: 'end_turn' },
      }) + '\n');
      const r2 = await r2P;

      assert.match(r1.text, /reply-A/, 'turn A receives reply-A');
      assert.match(r2.text, /reply-B/, 'turn B receives reply-B');
      assert.ok(!r1.text.includes('reply-B'), 'turn A reply must not contain turn B text');
      assert.ok(!r2.text.includes('reply-A'), 'turn B reply must not contain turn A text');
      await p.kill('done');
    } finally { env.cleanup(); }
  });
});

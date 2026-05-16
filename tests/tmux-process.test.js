'use strict';

// TmuxProcess.start() verifies the pinned claude binary exists
// (lib/claude-bin.js). The real binary isn't present in CI, so
// point the override at the node executable — always present and
// executable. The fake runner never actually execs it.
if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { TmuxProcess } = require('../lib/process/tmux-process');

// ─── Fake TmuxRunner ───────────────────────────────────────────────

function makeFakeRunner(overrides = {}) {
  const calls = [];
  const stubs = {
    spawn: async (opts) => { calls.push({ kind: 'spawn', ...opts }); },
    sendControl: async (name, key) => { calls.push({ kind: 'sendControl', name, key }); },
    pasteText: async (name, text) => {
      calls.push({ kind: 'pasteText', name, text });
      return { sanitized: text, oneLine: text, stripped: 0 };
    },
    capturePane: async (name) => '',
    captureWide: async (name) => '',
    sessionExists: async () => true,
    killSession: async (name) => { calls.push({ kind: 'killSession', name }); },
    listPolygramSessions: async () => [],
    setPaneReadOnly: async (name) => { calls.push({ kind: 'setPaneReadOnly', name }); },
    sessionName: (bot, chat, thread) => `polygram-${bot}-${chat}-${thread || 'main'}`,
    debugLogPath: (bot, chat, thread) => `/tmp/test/${bot}-${chat}-${thread || 'main'}.log`,
    ...overrides,
  };
  stubs._calls = calls;
  return stubs;
}

function makeTmuxProcess(runner, opts = {}) {
  return new TmuxProcess({
    sessionKey: 'chat:100',
    chatId: '100',
    threadId: null,
    label: 'test',
    runner,
    botName: 'shumabit',
    logger: { warn: () => {}, error: () => {}, debug: () => {} },
    pollMs: 1,
    quiesceMs: 5,
    readyTimeoutMs: 500,
    turnTimeoutMs: 500,
    pasteConfirmMs: 10,
    ...opts,
  });
}

// ─── construction ───────────────────────────────────────────────────

describe('TmuxProcess construction', () => {
  test('exposes backend=tmux and cost=3', () => {
    const p = makeTmuxProcess(makeFakeRunner());
    assert.equal(p.backend, 'tmux');
    assert.equal(p.cost, 3);
  });

  test('throws without runner', () => {
    assert.throws(
      () => new TmuxProcess({ sessionKey: 'k', botName: 'b' }),
      /runner required/,
    );
  });

  test('throws without botName', () => {
    assert.throws(
      () => new TmuxProcess({ sessionKey: 'k', runner: makeFakeRunner() }),
      /botName required/,
    );
  });

  test('computes tmuxName + debugLogPath from runner helpers', () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    assert.equal(p.tmuxName, 'polygram-shumabit-100-main');
    assert.equal(p.debugLogPath, '/tmp/test/shumabit-100-main.log');
  });
});

// ─── start() ────────────────────────────────────────────────────────

describe('TmuxProcess.start', () => {
  test('spawns with locked args (model, effort, --permission-mode acceptEdits, --debug-file)', async () => {
    const runner = makeFakeRunner({
      captureWide: async () => '? for shortcuts',
    });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high', cwd: '/work' });

    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.equal(spawn.name, 'polygram-shumabit-100-main');
    assert.equal(spawn.cwd, '/work');
    // Pin: spawn uses the absolute pinned-binary path, not bare 'claude'.
    assert.equal(spawn.command, process.env.POLYGRAM_CLAUDE_BIN);
    assert.ok(spawn.args.includes('--model'));
    assert.ok(spawn.args.includes('sonnet'));
    assert.ok(spawn.args.includes('--effort'));
    assert.ok(spawn.args.includes('high'));
    assert.ok(spawn.args.includes('--permission-mode'));
    assert.ok(spawn.args.includes('acceptEdits'));
    assert.ok(spawn.args.includes('--debug-file'));
  });

  test('spawns with --append-system-prompt carrying the polygram Telegram display hint (parity with SDK)', async () => {
    // REGRESSION: SDK backend appends POLYGRAM_DISPLAY_HINT to every
    // agent's systemPrompt (lib/sdk/build-options.js:165). The tmux
    // backend previously passed only --agent/--model/--effort/cwd and
    // never told the spawned claude session it was talking to
    // Telegram. Production symptom (shumorobot 2026-05-15): the agent
    // emitted shell-style canned strings like "No response requested."
    // as actual Telegram replies. Cross-backend parity gap.
    const { POLYGRAM_DISPLAY_HINT } = require('../lib/telegram/display-hint');
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high', cwd: '/work' });

    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    const flagIdx = spawn.args.indexOf('--append-system-prompt');
    assert.ok(flagIdx >= 0, '--append-system-prompt flag must be present');
    const hint = spawn.args[flagIdx + 1];
    assert.equal(hint, POLYGRAM_DISPLAY_HINT,
      'flag value must be exactly the polygram display hint, byte-faithful');
    assert.match(hint, /Telegram/,
      'sanity: hint must mention Telegram so the model frames replies for the right surface');
  });

  test('--resume <id> when existingSessionId provided', async () => {
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({ existingSessionId: 'sess-abc', model: 'sonnet', effort: 'high' });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.ok(spawn.args.includes('--resume'));
    assert.ok(spawn.args.includes('sess-abc'));
  });

  test('bypassPermissions adds --dangerously-skip-permissions (F-spike-4)', async () => {
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({
      model: 'sonnet', effort: 'high',
      chatConfig: { permissionMode: 'bypassPermissions' },
    });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.ok(spawn.args.includes('--permission-mode'));
    assert.ok(spawn.args.includes('bypassPermissions'));
    assert.ok(spawn.args.includes('--dangerously-skip-permissions'));
  });

  test('NO --dangerously-skip-permissions when acceptEdits', async () => {
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high' });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.ok(!spawn.args.includes('--dangerously-skip-permissions'));
  });

  test('REGRESSION (rc.1 incident): topic config overrides chat config (agent/cwd/model/effort)', async () => {
    // Music topic in shumorobot has agent=music-curation:music-curator
    // + cwd=/Users/ivanshumkov/Music/rekordbox while chat-level is
    // agent=shumabit + cwd=/Users/ivanshumkov. Pre-fix, TmuxProcess
    // used chat-level only → TUI spawned with wrong agent and didn't
    // signal ready in 30s. Mirror SDK's getTopicConfig merge.
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({
      threadId: '3',
      chatConfig: {
        model: 'haiku',         // chat-level (should be overridden)
        effort: 'low',
        cwd: '/Users/ivanshumkov',
        agent: 'shumabit',
        topics: {
          3: {
            name: 'Music',
            model: 'sonnet',       // topic override
            effort: 'high',
            cwd: '/Users/ivanshumkov/Music/rekordbox',
            agent: 'music-curation:music-curator',
          },
        },
      },
    });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.equal(spawn.cwd, '/Users/ivanshumkov/Music/rekordbox',
      'topic cwd must override chat cwd');
    assert.ok(spawn.args.includes('sonnet'), 'topic model must override');
    assert.ok(spawn.args.includes('high'), 'topic effort must override');
    assert.ok(spawn.args.includes('--agent'));
    assert.ok(spawn.args.includes('music-curation:music-curator'),
      'topic agent must override chat agent');
    assert.ok(!spawn.args.includes('shumabit'),
      'chat-level shumabit agent must NOT leak through when topic overrides');
  });

  test('pulls model/effort/cwd from chatConfig when not on ctx', async () => {
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({
      chatConfig: { model: 'haiku', effort: 'low', cwd: '/home/x' },
    });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.equal(spawn.cwd, '/home/x');
    assert.ok(spawn.args.includes('haiku'));
    assert.ok(spawn.args.includes('low'));
  });

  test('chatConfig.agent appends --agent', async () => {
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high', chatConfig: { agent: 'shumabit-finance' } });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.ok(spawn.args.includes('--agent'));
    assert.ok(spawn.args.includes('shumabit-finance'));
  });

  test('waitForReady recognises "? for shortcuts"', async () => {
    let calls = 0;
    const runner = makeFakeRunner({
      captureWide: async () => {
        calls++;
        if (calls < 3) return 'starting up...';
        return 'welcome\n? for shortcuts';
      },
    });
    const p = makeTmuxProcess(runner);
    const initFired = new Promise((resolve) => p.once('init', resolve));
    await p.start({ model: 'sonnet', effort: 'high' });
    await initFired;
    assert.ok(calls >= 3);
  });

  test('waitForReady recognises "accept edits on" (READY_ALT_RE)', async () => {
    const runner = makeFakeRunner({
      captureWide: async () => '... accept edits on ...',
    });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high' });
    // No throw = ready detected via alt regex
  });

  test('throws TMUX_READY_TIMEOUT if TUI never signals ready', async () => {
    const runner = makeFakeRunner({ captureWide: async () => 'no hint here' });
    const p = makeTmuxProcess(runner, { readyTimeoutMs: 30 });
    try {
      await p.start({ model: 'sonnet', effort: 'high' });
      assert.fail('should throw');
    } catch (err) {
      assert.equal(err.code, 'TMUX_READY_TIMEOUT');
    }
  });

  test('spawn failure surfaces TMUX_SPAWN_FAILED-shaped error', async () => {
    const runner = makeFakeRunner({
      spawn: async () => { throw Object.assign(new Error('duplicate session: foo'), { code: 'TMUX_SPAWN_FAILED', name: 'x' }); },
      captureWide: async () => '? for shortcuts',
    });
    const p = makeTmuxProcess(runner);
    try {
      await p.start({ model: 'sonnet', effort: 'high' });
      assert.fail('should throw');
    } catch (err) {
      assert.match(err.message, /duplicate session/);
    }
  });

  test('concurrent start() awaits the same spawn (R2-F7)', async () => {
    let spawnCount = 0;
    const runner = makeFakeRunner({
      spawn: async () => { spawnCount++; await new Promise((r) => setTimeout(r, 10)); },
      captureWide: async () => '? for shortcuts',
    });
    const p = makeTmuxProcess(runner);
    await Promise.all([
      p.start({ model: 'sonnet', effort: 'high' }),
      p.start({ model: 'sonnet', effort: 'high' }),
    ]);
    assert.equal(spawnCount, 1);
  });
});

// ─── send() ─────────────────────────────────────────────────────────

describe('TmuxProcess.send', () => {
  test('Phase 4 §6 — capture-pane completion with no JSONL fails loud, never returns pane text', async () => {
    // 0.10.0 Phase 4 §6: capture-pane is a LIVENESS signal only — it
    // never delivers reply text. A turn the capture-pane race judged
    // complete but for which no JSONL text exists fails loud with an
    // explicit error, NEVER with the pane diff (which was the
    // echoed-input and banner-as-reply failure class). The genuine
    // JSONL-driven success path is covered by tmux-process-jsonl.
    let captureCount = 0;
    const runner = makeFakeRunner({
      captureWide: async () => {
        captureCount++;
        if (captureCount === 1) return '? for shortcuts'; // ready check for start
        // The pane shows what LOOKS like a reply. Pre-§6 the
        // capture-pane diff returned this as result.text.
        return 'PRELUDE\n? for shortcuts\nhi there!\n? for shortcuts';
      },
    });
    const p = makeTmuxProcess(runner);
    await p.start({
      model: 'sonnet', effort: 'high',
      existingSessionId: 'sess-final',
    });
    const res = await p.send('hello');
    // No JSONL was written → the turn fails loud.
    assert.equal(res.metrics.resultSubtype, 'TMUX_NO_JSONL_TEXT');
    assert.equal(res.text, '');
    assert.ok(!String(res.text).includes('hi there!'),
      'pane text must NEVER leak into the reply');
    // The prompt was still pasted, with an embedded correlation token.
    const paste = runner._calls.find((c) => c.kind === 'pasteText' && c.text.includes('hello'));
    assert.ok(paste);
    assert.match(paste.text, /<polygram-info corr-id="pgm-corr-[0-9a-f]+"/,
      'paste embeds a correlation token');
    const enter = runner._calls.find((c) => c.kind === 'sendControl' && c.key === 'Enter');
    assert.ok(enter);
  });

  test('returns error result when send-side throws (no rethrow to caller)', async () => {
    const runner = makeFakeRunner({
      captureWide: async () => '? for shortcuts',
      pasteText: async () => { throw new Error('boom'); },
    });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high' });
    const res = await p.send('hi');
    assert.equal(res.error, 'boom');
    assert.equal(res.text, '');
  });

  test('emits prompt-sanitized when runner strips control chars', async () => {
    const runner = makeFakeRunner({
      captureWide: async () => '? for shortcuts',
      pasteText: async (n, t) => ({ sanitized: t.replace(/\x03/g, ''), oneLine: t, stripped: 1 }),
    });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high' });
    const evt = new Promise((resolve) => p.once('prompt-sanitized', resolve));
    p.send('a\x03b').catch(() => {});
    const ev = await evt;
    assert.equal(ev.stripped, 1);
    assert.equal(ev.source, 'send');
  });

  test('returns error result on TMUX_TURN_TIMEOUT', async () => {
    const runner = makeFakeRunner({
      captureWide: async () => '? for shortcuts\nesc to interrupt', // always streaming
    });
    const p = makeTmuxProcess(runner, { turnTimeoutMs: 30 });
    await p.start({ model: 'sonnet', effort: 'high' });
    // first captureWide is ready-check during start; subsequent are streaming
    const res = await p.send('hello');
    assert.match(res.error, /turn did not complete/);
    assert.equal(res.metrics.resultSubtype, 'TMUX_TURN_TIMEOUT');
  });

  test('serializes concurrent send() — second call queues until first resolves', async () => {
    // capture sequence: start ready, then send#1 → start cap → ready cap; then send#2 same.
    let caps = 0;
    const runner = makeFakeRunner({
      captureWide: async () => {
        caps++;
        if (caps === 1) return '? for shortcuts';                          // start ready
        if (caps === 2) return 'PRE1\n? for shortcuts';                    // send#1 captureAtStart
        return 'PRE1\n? for shortcuts\nreply1\n? for shortcuts';           // send#1 quiesced + send#2 quiesced
      },
    });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high' });
    const r1 = p.send('first');
    const r2 = p.send('second');
    const [res1, res2] = await Promise.all([r1, r2]);
    // §6: both turns are capture-only (no JSONL) so both fail loud —
    // but the SERIALIZATION invariant still holds: turn 2 ran only
    // after turn 1, and both pastes happened in arrival order.
    assert.equal(res1.metrics.resultSubtype, 'TMUX_NO_JSONL_TEXT');
    assert.equal(res2.metrics.resultSubtype, 'TMUX_NO_JSONL_TEXT');
    const pastes = runner._calls.filter((c) => c.kind === 'pasteText');
    assert.equal(pastes.length, 2);
    assert.ok(pastes[0].text.includes('first'));
    assert.ok(pastes[1].text.includes('second'));
  });
});

// ─── interrupts / slash commands ────────────────────────────────────

describe('TmuxProcess control', () => {
  test('interrupt sends C-c', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'polygram-x'; // bypass start
    await p.interrupt();
    const c = runner._calls.find((cc) => cc.kind === 'sendControl' && cc.key === 'C-c');
    assert.ok(c);
  });

  test('setModel pastes /model <name>', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    await p.setModel('sonnet');
    const paste = runner._calls.find((c) => c.kind === 'pasteText');
    assert.equal(paste.text, '/model sonnet');
  });

  test('applyFlagSettings({effortLevel:"high"}) pastes /effort high', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    await p.applyFlagSettings({ effortLevel: 'high' });
    const paste = runner._calls.find((c) => c.kind === 'pasteText');
    assert.equal(paste.text, '/effort high');
  });

  test('setPermissionMode pastes /permission-mode <mode>', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    await p.setPermissionMode('default');
    const paste = runner._calls.find((c) => c.kind === 'pasteText');
    assert.equal(paste.text, '/permission-mode default');
  });

  test('resetSession pastes /new, clears claudeSessionId, returns {closed:false}', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    p.claudeSessionId = 'before';
    const res = await p.resetSession();
    assert.equal(res.closed, false);
    assert.equal(p.claudeSessionId, null);
    const paste = runner._calls.find((c) => c.kind === 'pasteText');
    assert.equal(paste.text, '/new');
  });

  test('getContextUsage throws UnsupportedOperationError when no usage snapshot yet', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    try {
      await p.getContextUsage();
      assert.fail('should throw');
    } catch (err) {
      // No turn has completed → no usage data → throw the SDK-shaped
      // sentinel so polygram's pm.getContextUsage handler treats both
      // backends identically.
      assert.equal(err.code, 'UNSUPPORTED_OPERATION');
    }
  });

  test('getContextUsage returns SDK-shaped result after a turn populates usage', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    // Inject a usage snapshot as if the JSONL tail had seen it.
    p._lastUsage = {
      type: 'usage',
      inputTokens: 10,
      outputTokens: 200,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 30_000,
      model: 'claude-haiku-4-5-20251001',
    };
    const usage = await p.getContextUsage();
    assert.equal(typeof usage.percentage, 'number');
    // 10 (input) + 200 (output) + 100_000 (cache_read) + 30_000 (cache_creation)
    // Output IS included — claude's just-emitted reply joins the
    // conversation for next-turn context.
    assert.equal(usage.totalTokens, 130_210);
    assert.equal(usage.maxTokens, 200_000);
    // 130210 / 200000 = 65.1 %
    assert.ok(usage.percentage > 64 && usage.percentage < 66,
      `expected ~65%, got ${usage.percentage}`);
    assert.equal(usage.model, 'claude-haiku-4-5-20251001');
    assert.equal(usage.isAutoCompactEnabled, true);
    assert.equal(usage.autoCompactThreshold, 85);
  });
});

// ─── HOT-PATH sync — no-throw contract ─────────────────────────────

describe('TmuxProcess HOT-PATH (R1-F1: no-throw)', () => {
  test('drainQueue returns count, never throws, fires queue-drop', () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    // 0.10.0 Phase 2: drainQueue rejects QUEUED primary turns — Turn
    // records carry a `state`. Only 'queued' turns are drained (the
    // running head settles via its own _runTurn flow).
    p.pendingQueue.push(
      { state: 'queued', reject: () => {} },
      { state: 'queued', reject: () => {} },
    );
    const fired = [];
    p.on('queue-drop', (c) => fired.push(c));
    const count = p.drainQueue('FOO');
    assert.equal(count, 2);
    assert.equal(p.pendingQueue.length, 0);
    assert.deepEqual(fired, [2]);
  });

  test('drainQueue with throwing reject does not bubble', () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.pendingQueue.push({ state: 'queued', reject: () => { throw new Error('reject boom'); } });
    // No throw expected
    const n = p.drainQueue();
    assert.equal(n, 1);
  });

  test('injectUserMessage returns false when not in flight', () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.inFlight = false;
    assert.equal(p.injectUserMessage({ content: 'hi' }), false);
  });

  test('injectUserMessage returns false when closed', () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.inFlight = true;
    p.closed = true;
    assert.equal(p.injectUserMessage({ content: 'hi' }), false);
  });

  test('injectUserMessage returns false when content sanitizes to empty', () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.inFlight = true;
    assert.equal(p.injectUserMessage({ content: '\x03\x04\x01' }), false);
  });

  test('injectUserMessage returns true + fires paste async when live turn', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    p.inFlight = true;
    const fired = new Promise((resolve) => p.once('inject-user-message', resolve));
    const ok = p.injectUserMessage({ content: 'autosteer text', priority: 'now' });
    assert.equal(ok, true);
    const ev = await fired;
    assert.equal(ev.text_len, 'autosteer text'.length);
    assert.equal(ev.priority, 'now');
    // Allow microtask drain — paste call must land
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Phase 2: the autosteer paste carries an embedded correlation token.
    assert.ok(runner._calls.find((c) => c.kind === 'pasteText' && c.text.includes('autosteer text')));
  });

  test('injectUserMessage paste error surfaces via inject-fail event, not throw', async () => {
    const runner = makeFakeRunner({
      pasteText: async () => { throw new Error('paste boom'); },
    });
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    p.inFlight = true;
    const fired = new Promise((resolve) => p.once('inject-fail', resolve));
    const ok = p.injectUserMessage({ content: 'hi' });
    assert.equal(ok, true);
    const ev = await fired;
    assert.match(ev.err, /paste boom/);
  });

  test('steer delegates to injectUserMessage with priority:now', () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    p.inFlight = true;
    const fired = new Promise((resolve) => p.once('inject-user-message', resolve));
    const ok = p.steer('steer text');
    assert.equal(ok, true);
    return fired.then((ev) => {
      assert.equal(ev.priority, 'now');
    });
  });
});

// ─── kill ───────────────────────────────────────────────────────────

describe('TmuxProcess.kill', () => {
  test('idempotent: second kill is a no-op', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    await p.kill('first');
    const before = runner._calls.length;
    await p.kill('second');
    assert.equal(runner._calls.length, before);
  });

  test('drains pending queue with KILLED + closes runner session', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    let drained = null;
    p.pendingQueue.push({ state: 'queued', reject: (e) => { drained = e; } });
    // close event parity: first arg is integer code (matches SDK);
    // second arg is optional metadata.
    const closed = new Promise((resolve) => {
      p.once('close', (code, meta) => resolve({ code, meta }));
    });
    await p.kill('done');
    const ev = await closed;
    assert.equal(ev.code, 0);
    assert.equal(ev.meta?.reason, 'done');
    assert.equal(drained.code, 'KILLED');
    assert.ok(runner._calls.find((c) => c.kind === 'killSession'));
    assert.equal(p.closed, true);
  });

  test('fires idle so pm can signal LRU waiter', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    const idle = new Promise((resolve) => p.once('idle', resolve));
    await p.kill();
    await idle; // no timeout → fired
  });
});

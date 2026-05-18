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

  // ─── R-spawn-leak: start() must kill the session it created when a
  // post-spawn step (readiness, init) fails ─────────────────────────
  //
  // Production incident (shumorobot 2026-05-17 22:03, topic :3): the
  // first spawn's TUI never signalled ready → start() threw
  // TMUX_READY_TIMEOUT but left the tmux session alive. Every retry
  // then ran `tmux new-session -s <same-name>` → "duplicate session"
  // → permanent wedge until a human killed the orphan. A transient
  // first-spawn failure became a PERMANENT wedge for that topic.
  test('R-spawn-leak: readiness failure after spawn kills the orphan tmux session', async () => {
    const runner = makeFakeRunner({
      // spawn succeeds → the tmux session NAME now exists.
      captureWide: async () => 'no ready hint — TUI never signalled ready',
    });
    const p = makeTmuxProcess(runner, { readyTimeoutMs: 30 });
    await assert.rejects(
      p.start({ model: 'sonnet', effort: 'high' }),
      /TUI did not signal ready/,
    );
    // The session start() created must be torn down so a retry gets a
    // clean name — otherwise `tmux new-session` fails "duplicate
    // session" forever.
    const killed = runner._calls.find(
      (c) => c.kind === 'killSession' && c.name === p.tmuxName,
    );
    assert.ok(killed, 'start() must killSession the orphan after a post-spawn failure');
  });

  test('R-spawn-leak: any post-spawn throw (not just readiness) kills the orphan', async () => {
    // A non-readiness failure after spawn (here: _waitForReady itself
    // throwing a non-timeout error) must still tear the session down.
    const runner = makeFakeRunner({
      captureWide: async () => { throw new Error('capture-pane wedged'); },
    });
    const p = makeTmuxProcess(runner, { readyTimeoutMs: 30 });
    await assert.rejects(p.start({ model: 'sonnet', effort: 'high' }));
    const killed = runner._calls.find(
      (c) => c.kind === 'killSession' && c.name === p.tmuxName,
    );
    assert.ok(killed, 'start() must killSession after ANY post-spawn failure');
  });

  test('R-spawn-leak: a retry after a failed start spawns cleanly (no duplicate-session wedge)', async () => {
    let attempt = 0;
    const runner = makeFakeRunner({
      // First spawn's TUI hangs; after the failed start kills the
      // orphan, the second spawn's TUI signals ready normally.
      captureWide: async () => (attempt === 0 ? 'still starting' : '? for shortcuts'),
    });
    const p = makeTmuxProcess(runner, { readyTimeoutMs: 30 });
    await assert.rejects(p.start({ model: 'sonnet', effort: 'high' }));
    attempt = 1;
    // The retry must succeed — start() reuses tmuxName, so if the
    // orphan from attempt 0 were still alive a real `tmux new-session`
    // would reject "duplicate session". The fake runner's spawn never
    // rejects, but the killSession from attempt 0 is the contract that
    // makes a real retry clean.
    await p.start({ model: 'sonnet', effort: 'high' });
  });

  test('R-spawn-leak: when `tmux new-session` itself fails, NO spurious killSession is attempted', async () => {
    // The session was never created — there is nothing to kill, and a
    // spurious `tmux kill-session` on a non-existent name is noise.
    // Distinguish "spawn() itself failed" from "spawn ok, later step
    // failed".
    const runner = makeFakeRunner({
      spawn: async () => {
        throw Object.assign(new Error('tmux spawn failed: duplicate session: foo'), {
          code: 'TMUX_SPAWN_FAILED', name: 'x',
        });
      },
      captureWide: async () => '? for shortcuts',
    });
    const p = makeTmuxProcess(runner);
    await assert.rejects(
      p.start({ model: 'sonnet', effort: 'high' }),
      /tmux spawn failed/,
    );
    const killed = runner._calls.find((c) => c.kind === 'killSession');
    assert.equal(killed, undefined, 'no killSession when the session was never created');
  });

  // ─── B6: _waitForReady must banner-gate a slow custom-agent spawn ──
  //
  // Production incident (shumorobot 2026-05-18, Music topic, TWICE):
  // the Music topic spawns a TUI with a custom agent
  // (`music-curation:music-curator`) that loads several MCP servers
  // and is SLOW to settle. The claude TUI renders `? for shortcuts`
  // at the BOTTOM of its still-visible startup banner immediately,
  // before the agent/MCP servers have finished initialising.
  //
  // `_waitForReady` matched `READY_HINTS_RE` and returned at once —
  // so `start()` resolved, `send()` pasted the prompt into a TUI that
  // was still starting up, and the submitted Enter was dropped. The
  // prompt sat unsubmitted; the turn never began.
  //
  // `_awaitTurnComplete` already applies `TUI_BANNER_RE` as an "L1"
  // gate (a ready hint under a visible banner is a startup artifact,
  // not turn completion). `_waitForReady` did NOT — that asymmetry is
  // the bug. The fix makes `_waitForReady` ignore the ready hint
  // while the banner box-drawing chars are still on the pane bottom.
  //
  // B5 added a submit-confirm retry to `pasteAndEnter`, but its probe
  // spawned a no-agent (fast) TUI and never reproduced a paste into a
  // mid-startup slow-agent TUI. B5 fixed the wrong layer.
  describe('B6 — _waitForReady banner-gate (slow custom-agent startup)', () => {
    // The startup banner exactly as the claude TUI renders it: the
    // box-drawing logo, then a few startup lines, then the ready hint
    // ALREADY present at the bottom — the production trace shape.
    const STARTUP_BANNER = [
      ' ▐▛███▜▌   Claude Code v2.1.142',
      '▝▜█████▛▘  Sonnet 4.6 · Claude Max',
      '  ▘▘ ▝▝    @music-curation:music-curator · ~/Music/rekordbox',
      '',
      ' Debug mode enabled',
      ' Logging to: …/tmux-claude--1003807211164-3.log',
      '',
      '────────────────────────────────────────',
      '❯                                       ',
      '────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n');

    // The same pane AFTER the banner has scrolled out of view — a
    // genuinely settled, ready TUI: no box-drawing chars near the
    // bottom, ready hint present.
    const SETTLED_PANE = [
      'Some earlier agent output that pushed the banner into',
      'scrollback far above the visible pane bottom.',
      '',
      '────────────────────────────────────────',
      '❯                                       ',
      '────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n');

    test('does NOT resolve while the startup banner is still on the pane', async () => {
      // capture-pane returns banner+ready for the first 4 polls (the
      // slow custom-agent still starting up), then the settled pane.
      // The bug: _waitForReady resolves on poll 1 because the ready
      // hint is present. The fix: it must keep polling until the
      // banner is gone, i.e. resolve only once SETTLED_PANE appears.
      let poll = 0;
      const captures = [];
      const runner = makeFakeRunner({
        captureWide: async () => {
          poll += 1;
          const buf = poll <= 4 ? STARTUP_BANNER : SETTLED_PANE;
          captures.push(buf);
          return buf;
        },
      });
      const p = makeTmuxProcess(runner, { readyTimeoutMs: 2000 });
      await p.start({ model: 'sonnet', effort: 'low' });

      // start() resolved → _waitForReady returned. It must have only
      // returned AFTER the banner left the pane: the LAST capture it
      // observed must be the settled (banner-free) pane, never a
      // banner-laden one. If _waitForReady resolved on poll 1 (the
      // bug), poll === 1 and it never reached SETTLED_PANE.
      assert.ok(poll >= 5,
        `_waitForReady must keep polling past the banner; resolved after ${poll} poll(s)`);
      assert.equal(captures[captures.length - 1], SETTLED_PANE,
        '_waitForReady must only return once the banner has left the pane');
    });

    test('still resolves promptly for a banner-free ready pane (no regression)', async () => {
      // A fast (no-agent) spawn: the banner is already gone by the
      // first poll. The banner gate must not delay this case — a
      // banner-free ready hint resolves `_waitForReady` immediately,
      // exactly as the pre-B6 code did. The gate only ever WITHHOLDS
      // readiness while the banner is present; it never adds latency
      // to an already-settled pane.
      let poll = 0;
      const runner = makeFakeRunner({
        captureWide: async () => { poll += 1; return SETTLED_PANE; },
      });
      const p = makeTmuxProcess(runner, { readyTimeoutMs: 2000 });
      await p.start({ model: 'sonnet', effort: 'low' });
      assert.equal(poll, 1,
        `a banner-free ready pane must resolve on the first poll; took ${poll}`);
    });

    test('TMUX_READY_TIMEOUT still fires if the banner never clears', async () => {
      // A genuinely wedged slow spawn — the banner never leaves. The
      // gate must not mask a real hang: _waitForReady must still time
      // out rather than wait forever for a banner that never goes.
      const runner = makeFakeRunner({
        captureWide: async () => STARTUP_BANNER,
      });
      const p = makeTmuxProcess(runner, { readyTimeoutMs: 60 });
      await assert.rejects(
        p.start({ model: 'sonnet', effort: 'low' }),
        (err) => err.code === 'TMUX_READY_TIMEOUT',
      );
    });
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

  test('R7 — a wedged captureWide does not hang the turn forever', async () => {
    // _awaitTurnComplete's poll loop re-checks its deadline only
    // BETWEEN captureWide calls. If a single `tmux capture-pane`
    // subprocess wedges (its promise never resolves), the loop is
    // parked on the await — the deadline check never runs again, the
    // JSONL race never settles either, and send() hangs forever,
    // starving the whole turn queue.
    //
    // The fix: an absolute setTimeout-based reject wrapping the
    // _runTurn race, so a turn ALWAYS settles within its timeout no
    // matter what the capture subprocess does.
    let captures = 0;
    const runner = makeFakeRunner({
      captureWide: async () => {
        captures += 1;
        if (captures === 1) return '? for shortcuts'; // start ready-check
        // Every subsequent capture-pane subprocess wedges — the
        // promise never resolves and never rejects.
        return new Promise(() => {});
      },
    });
    const p = makeTmuxProcess(runner, { turnTimeoutMs: 60, pollMs: 5 });
    await p.start({ model: 'sonnet', effort: 'high' });

    // send() MUST settle well within an assertion deadline generous
    // relative to turnTimeoutMs. Pre-fix this race never settles and
    // the test hangs until the node:test runner kills it.
    const settled = await Promise.race([
      p.send('hello').then((r) => ({ kind: 'settled', r })),
      new Promise((resolve) => setTimeout(
        () => resolve({ kind: 'hung' }), 2000)),
    ]);

    assert.equal(settled.kind, 'settled',
      'send() must settle within the timeout even when capture-pane wedges — '
      + 'pre-fix the poll loop parks on the await and the turn hangs forever');
    assert.ok(settled.r.error,
      'a wedged-capture turn settles as an error result, not a silent success');
    assert.equal(settled.r.text, '',
      'no reply text is fabricated for a turn that never completed');
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

  test('Bug 1 — hasBackgroundShell detects the TUI "N shell" indicator', async () => {
    // Production incident 2026-05-18: the agent left a detached
    // background shell running; the TUI bottom shows the indicator
    // (`N shell · ↓ to manage` / `N shell still running`). polygram's
    // Stop was blind to it. hasBackgroundShell() reads the pane and
    // reports whether a background shell is running.
    //
    // Idle pane — no background shell.
    const idle = makeTmuxProcess(makeFakeRunner({
      captureWide: async () => 'PRELUDE\n  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    }));
    idle.tmuxName = 'x';
    assert.equal(await idle.hasBackgroundShell(), false,
      'an idle pane has no background shell');

    // Pane with the manage-hint form of the indicator.
    const manage = makeTmuxProcess(makeFakeRunner({
      captureWide: async () => '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
    }));
    manage.tmuxName = 'x';
    assert.equal(await manage.hasBackgroundShell(), true,
      'the "N shell · ↓ to manage" indicator is detected');

    // Pane with the status-line form ("N shell still running").
    const running = makeTmuxProcess(makeFakeRunner({
      captureWide: async () => '✻ Baked for 5s · 2 shells still running',
    }));
    running.tmuxName = 'x';
    assert.equal(await running.hasBackgroundShell(), true,
      'the "N shell still running" status indicator is detected');
  });

  test('Bug 1 — killBackgroundShells opens /bashes, stops the shell, closes the panel', async () => {
    // The kill sequence verified against the real claude TUI 2.1.142
    // background-task panel: /bashes + Enter opens "Shell details"
    // (legend "Esc/Enter/Space to close · x to stop"); `x` stops the
    // shell; Esc closes the panel.
    let captures = 0;
    const runner = makeFakeRunner({
      captureWide: async () => {
        captures += 1;
        // First capture: shell running. After the kill: cleared.
        return captures === 1
          ? '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage'
          : '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
      },
    });
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    const killed = await p.killBackgroundShells();
    assert.equal(killed, true, 'killBackgroundShells reports the shell was stopped');

    // /bashes was pasted to open the background-task panel.
    const bashes = runner._calls.find(
      (c) => c.kind === 'pasteText' && c.text === '/bashes');
    assert.ok(bashes, '/bashes is pasted to open the panel');
    // Enter (open panel), x (stop shell), Escape (close panel).
    const keys = runner._calls
      .filter((c) => c.kind === 'sendControl').map((c) => c.key);
    assert.ok(keys.includes('Enter'), 'Enter opens the panel');
    assert.ok(keys.includes('x'), 'x stops the running shell');
    assert.ok(keys.includes('Escape'), 'Escape closes the panel');
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

  test('R8 — inject-fail carries the msgId + fails the ledger turn promptly', async () => {
    // The inject-fail event must carry the autosteered msgId so the
    // wired onInjectFail handler can clear the ✍ on the exact message.
    // The ledger turn must also be marked failed immediately — not
    // left `pasted` for the stale-sweep to catch turnTimeoutMs later.
    const runner = makeFakeRunner({
      pasteText: async () => { throw new Error('tmux: no server running'); },
    });
    const p = makeTmuxProcess(runner);
    p.tmuxName = 'x';
    p.inFlight = true;
    const fired = new Promise((resolve) => p.once('inject-fail', resolve));
    const ok = p.injectUserMessage({ content: 'follow-up', msgId: 658 });
    assert.equal(ok, true);
    const ev = await fired;
    assert.equal(ev.msgId, 658,
      'inject-fail must carry the autosteered msgId for prompt ✍ clearing');
    assert.equal(ev.backend, 'tmux');
    assert.ok(ev.turnId, 'inject-fail carries the ledger turnId');
    // The autosteer turn is marked failed at once, not stranded as
    // `pasted` until the stale-sweep.
    const turn = p._ledger.find((t) => t.turnId === ev.turnId);
    assert.ok(turn, 'the failed autosteer turn is still resolvable in the ledger');
    assert.equal(turn.state, 'failed',
      'a failed paste fails the ledger turn immediately, not turnTimeoutMs later');
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

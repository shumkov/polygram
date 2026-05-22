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
    // Default: no pre-existing tmux session for this name. Tests that
    // exercise the orphan-reconcile path (lib/process/tmux-process.js
    // spawn-time orphan kill — shumorobot 2026-05-20 incident) override
    // this to return true on the first call. Pre-reconcile this fake
    // returned true unconditionally; nothing in TmuxProcess called
    // sessionExists() at all, so the value was inert. With reconcile
    // it now matters — false is the realistic default for a fresh
    // test environment.
    sessionExists: async () => false,
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

// B7: a primary paste's submit is confirmed by its correlation token
// surfacing in a JSONL `user-message`. A REAL claude TUI emits that
// `user-message` whenever an Enter actually submits a pasted prompt —
// so the realistic default fake TUI must do the same, otherwise every
// `send()` would (correctly) fail TMUX_SUBMIT_FAILED waiting for a
// `user-message` that never comes. `autoSubmitOnEnter` (default true)
// wraps the runner's primary-paste Enter so the first Enter after a
// token-bearing PRIMARY paste feeds the tokened `user-message` into
// the process — modelling a TUI that submits. Autosteer pastes (which
// the TUI legitimately parks) are NOT auto-submitted. Tests that
// specifically exercise NON-submission (the B7 group) pass
// `autoSubmitOnEnter:false`.
function makeTmuxProcess(runner, opts = {}) {
  const { autoSubmitOnEnter = true, submitConfirmMs, ...rest } = opts;
  const p = new TmuxProcess({
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
    // Keep the submit-confirm window tiny in tests so a genuinely
    // non-submitting fake paste fails fast (ms) instead of burning the
    // production 1500ms × retries budget — and never wedges the suite.
    submitConfirmMs: submitConfirmMs ?? 30,
    ...rest,
  });
  if (autoSubmitOnEnter) {
    // Hook `_scheduleSubmitRetries` (0.10.0 Commit 2 successor to
    // `_confirmSubmitViaJsonl`) — the primary-turn submit confirmation.
    // It is called ONLY for a primary turn's paste, so hooking it
    // (rather than the autosteer-shared `_pasteAndEnter`) models
    // exactly "the TUI submitted the primary prompt": feed the tokened
    // `user-message` shortly after the confirm starts, so the confirm's
    // `_awaitSubmitConfirm` waiter resolves. Tests that exercise
    // NON-submission pass `autoSubmitOnEnter:false`.
    const baseConfirm = p._scheduleSubmitRetries.bind(p);
    p._scheduleSubmitRetries = (token, turn) => {
      if (token) {
        setTimeout(() => {
          p._handleSessionEvent({ type: 'user-message', text:
            `<polygram-info corr-id="${token}"></polygram-info>` });
        }, 1);
      }
      return baseConfirm(token, turn);
    };
  }
  return p;
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

  // ─── isolateUserConfig (slow-MCP-startup fix) ─────────────────────
  //
  // The Music topic's `music-curation:music-curator` agent inherits the
  // user-level `~/.claude/settings.json` MCP servers — serena (~27.5 s
  // to connect), peekaboo (~9 s), context7. During that ~45 s startup
  // the claude TUI accepts a pasted prompt but does NOT process the
  // submitted Enter, so polygram's paste never submits and the turn
  // fails. `isolateUserConfig: true` makes start() pass
  // `--strict-mcp-config` (zero MCP servers loaded) and
  // `--setting-sources project,local` (drops user-level config; the
  // project's own .claude/settings.json still loads), so the TUI is
  // ready in seconds. Default OFF — no other topic is affected.

  test('isolateUserConfig: true appends --strict-mcp-config and --setting-sources project,local', async () => {
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({
      model: 'sonnet', effort: 'high',
      chatConfig: { isolateUserConfig: true },
    });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.ok(spawn.args.includes('--strict-mcp-config'),
      'isolateUserConfig must pass --strict-mcp-config so no MCP server loads');
    const ssIdx = spawn.args.indexOf('--setting-sources');
    assert.ok(ssIdx >= 0, 'isolateUserConfig must pass --setting-sources');
    assert.equal(spawn.args[ssIdx + 1], 'project,local',
      'must load only project+local settings, dropping user-level config');
  });

  test('isolateUserConfig unset: no --strict-mcp-config / --setting-sources (default-off regression guard)', async () => {
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({ model: 'sonnet', effort: 'high', chatConfig: {} });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.ok(!spawn.args.includes('--strict-mcp-config'),
      'default spawn must NOT isolate MCP config — General/other topics unaffected');
    assert.ok(!spawn.args.includes('--setting-sources'),
      'default spawn must NOT restrict setting-sources');
  });

  test('isolateUserConfig: topic-level override turns it on for one topic only', async () => {
    // Mirrors the production shape: Music topic (thread "3") opts in
    // via its topic entry while the chat as a whole does not.
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({
      threadId: '3',
      chatConfig: {
        model: 'sonnet', effort: 'high',
        topics: {
          3: { name: 'Music', isolateUserConfig: true },
        },
      },
    });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.ok(spawn.args.includes('--strict-mcp-config'),
      'topic-level isolateUserConfig must take effect');
    assert.equal(spawn.args[spawn.args.indexOf('--setting-sources') + 1], 'project,local');
  });

  test('isolateUserConfig: a sibling topic without the flag is NOT isolated', async () => {
    const runner = makeFakeRunner({ captureWide: async () => '? for shortcuts' });
    const p = makeTmuxProcess(runner);
    await p.start({
      threadId: '5',
      chatConfig: {
        model: 'sonnet', effort: 'high',
        topics: {
          3: { name: 'Music', isolateUserConfig: true },
          5: { name: 'Orchestra' },
        },
      },
    });
    const spawn = runner._calls.find((c) => c.kind === 'spawn');
    assert.ok(!spawn.args.includes('--strict-mcp-config'),
      'topic 5 did not opt in — must not inherit topic 3 isolation');
    assert.ok(!spawn.args.includes('--setting-sources'));
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

  // ─── B6: _waitForReady must wait for a slow custom-agent spawn to
  // QUIESCE before declaring the TUI ready ──────────────────────────
  //
  // Production incident (shumorobot 2026-05-18, Music topic, TWICE):
  // the Music topic spawns a TUI with a custom agent
  // (`music-curation:music-curator`) that loads several MCP servers.
  // The production debug log shows the MCP connections spanning
  // 14:45:31→14:45:40 — playwright 2.9s, context7 3.1s, serena 3.8s,
  // peekaboo 2.2s — with the screen repainting hard the whole time
  // ("High write ratio: 100.0% writes"). Throughout that window the
  // TUI ALREADY shows its ready hint at the bottom of its startup
  // banner.
  //
  // `_waitForReady` returned the INSTANT `READY_HINTS_RE` matched —
  // on the first poll, while MCP servers were still loading. `start()`
  // resolved early; the first `send()` pasted the prompt into a TUI
  // still ingesting startup, and the submitted Enter was dropped. The
  // prompt sat unsubmitted; the turn never began.
  //
  // The startup banner is NOT a usable "not ready" signal — verified
  // against a live spawn: it stays on the pane indefinitely (the
  // agent emits nothing pre-turn, so it never scrolls away). The real
  // discriminator is QUIESCENCE: a genuinely-ready idle TUI produces
  // a byte-stable `capture-pane` between polls; a mid-startup TUI
  // repaints every tick. The fix requires the ready hint present AND
  // the pane unchanged across consecutive polls for `quiesceMs`.
  //
  // B5 added a submit-confirm retry to `pasteAndEnter`, but its probe
  // spawned a no-agent (fast) TUI and never reproduced a paste into a
  // mid-startup slow-agent TUI. B5 fixed the wrong layer — it is the
  // readiness gate, not `pasteAndEnter`, that lets the paste land in
  // a not-yet-ready TUI in the first place.
  describe('B6 — _waitForReady quiescence gate (slow custom-agent startup)', () => {
    // A mid-startup pane: the ready hint is ALREADY shown at the
    // bottom of the banner, but the bottom status line carries a
    // changing MCP-loading spinner/progress — so each poll's capture
    // differs from the last. `tick` makes every capture unique.
    const startupPane = (tick) => [
      ' ▐▛███▜▌   Claude Code v2.1.142',
      '▝▜█████▛▘  Sonnet 4.6 · Claude Max',
      '  ▘▘ ▝▝    @music-curation:music-curator · ~/Music/rekordbox',
      '────────────────────────────────────────',
      '❯                                       ',
      '────────────────────────────────────────',
      '  ? for shortcuts',
      `  ✻ Connecting MCP servers… ${'.'.repeat(tick % 5)}`,   // ← changes
    ].join('\n');

    // A genuinely-settled idle TUI: MCP loading done, the pane is
    // byte-stable between polls. Note the banner is STILL present —
    // that is realistic and deliberate; the gate keys on stability,
    // not on the banner being gone.
    const SETTLED_PANE = [
      ' ▐▛███▜▌   Claude Code v2.1.142',
      '▝▜█████▛▘  Sonnet 4.6 · Claude Max',
      '  ▘▘ ▝▝    @music-curation:music-curator · ~/Music/rekordbox',
      '────────────────────────────────────────',
      '❯                                       ',
      '────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n');

    test('does NOT resolve while the TUI is still repainting (MCP startup)', async () => {
      // capture-pane returns a CHANGING mid-startup pane for the first
      // 4 polls (MCP servers loading — the ready hint is present the
      // whole time), then a byte-stable settled pane. The bug:
      // _waitForReady resolves on poll 1 because the ready hint is
      // there. The fix: it keeps polling while the pane moves and
      // resolves only once the pane has gone stable.
      let poll = 0;
      let resolvedAtPoll = null;
      const runner = makeFakeRunner({
        captureWide: async () => {
          poll += 1;
          return poll <= 4 ? startupPane(poll) : SETTLED_PANE;
        },
      });
      const p = makeTmuxProcess(runner, { readyTimeoutMs: 2000 });
      p.once('init', () => { resolvedAtPoll = poll; });
      await p.start({ model: 'sonnet', effort: 'low' });

      // _waitForReady must NOT have resolved during the repainting
      // window (polls 1-4). If it resolved on poll 1 (the bug),
      // resolvedAtPoll === 1. The fix resolves only after the pane
      // has been stable — i.e. at poll 5 or later.
      assert.ok(resolvedAtPoll >= 5,
        `_waitForReady resolved at poll ${resolvedAtPoll} — it must wait `
        + 'past the MCP-startup repaint window (polls 1-4) until the pane is stable');
    });

    test('does NOT resolve on a single ready capture — stability needs ≥2 polls', async () => {
      // The narrowest pin on the bug: the OLD code returned after ONE
      // capture that matched READY_HINTS_RE. A real ready TUI is
      // confirmed by the pane HOLDING STILL, which is unobservable
      // from a single poll. This stub returns a ready-hint pane that
      // keeps CHANGING forever — the old code resolves on poll 1; the
      // fix never sees two identical polls so it must time out.
      let poll = 0;
      const runner = makeFakeRunner({
        captureWide: async () => { poll += 1; return startupPane(poll); },
      });
      const p = makeTmuxProcess(runner, { readyTimeoutMs: 80 });
      await assert.rejects(
        p.start({ model: 'sonnet', effort: 'low' }),
        (err) => err.code === 'TMUX_READY_TIMEOUT',
        'a pane that never stops changing must NOT be declared ready, '
        + 'even though every capture carries the ready hint',
      );
      assert.ok(poll >= 2, 'must have polled more than once before timing out');
    });

    test('resolves once the pane is byte-stable with the ready hint', async () => {
      // The settled case: every capture is the identical SETTLED_PANE.
      // Two consecutive identical captures + the ready hint ⇒ ready.
      // The gate adds only the minimal latency of one stability
      // confirmation, never an unbounded wait.
      let poll = 0;
      const runner = makeFakeRunner({
        captureWide: async () => { poll += 1; return SETTLED_PANE; },
      });
      const p = makeTmuxProcess(runner, { readyTimeoutMs: 2000 });
      await p.start({ model: 'sonnet', effort: 'low' });
      assert.ok(poll >= 2,
        `readiness needs at least two matching captures; took ${poll}`);
    });

    test('TMUX_READY_TIMEOUT still fires if the TUI never settles', async () => {
      // A genuinely wedged slow spawn — the pane repaints forever and
      // never goes stable. The gate must not mask a real hang:
      // _waitForReady must still time out.
      let poll = 0;
      const runner = makeFakeRunner({
        captureWide: async () => { poll += 1; return startupPane(poll); },
      });
      const p = makeTmuxProcess(runner, { readyTimeoutMs: 60 });
      await assert.rejects(
        p.start({ model: 'sonnet', effort: 'low' }),
        (err) => err.code === 'TMUX_READY_TIMEOUT',
      );
    });
  });

  // ─── B8: _waitForReady must ALSO gate on debug-log quiescence ──────
  //
  // Production root cause (shumorobot, the Music topic, 5+ times):
  // B6's quiescence gate keys on `capture-pane` byte-stability. But
  // the real production debug log for a slow-MCP startup shows the
  // claude pane is BYTE-STABLE the entire ~33 s MCP cold-start —
  // `plugin:serena:serena` took 27.5 s to connect, peekaboo 9.3 s —
  // because the REPL mounts and paints its ready hint immediately,
  // then MCP servers load entirely OFF-SCREEN. B6 reads "stable =
  // ready", `start()` resolves mid-MCP-load, the first paste lands in
  // a TUI that is not yet interactive, and the submitted Enter is
  // dropped. `isolateUserConfig` (rc.26) sidesteps this for the Music
  // topic by removing its MCP servers, but the gate is still wrong
  // for ANY non-isolated topic that legitimately loads MCP servers.
  //
  // The pane is fooled; the claude `--debug-file` log is NOT. During
  // MCP startup that log is ACTIVELY written (`MCP server "X":
  // connecting…` / `…connected in NNNNms`); a genuinely-ready idle
  // TUI's debug log is quiet. B8 extends `_waitForReady` to ALSO
  // require the debug log to have had no new bytes for
  // `readyDebugQuietMs` before declaring ready.
  //
  // These tests model the B6-FOOLING shape: `captureWide` returns a
  // byte-stable pane WITH a ready hint from the very first poll, while
  // the `--debug-file` log gets fresh lines appended for the first N
  // polls then goes quiet. Against the B6-only `_waitForReady` they
  // FAIL — it resolves early on poll 1 because pane-stable+hint is
  // satisfied immediately. After the B8 fix they PASS — the gate
  // waits out the debug-log writes.
  describe('B8 — _waitForReady debug-log quiescence gate (slow-MCP startup)', () => {
    // A byte-stable settled pane WITH the ready hint — identical every
    // poll. This is exactly what B6's pane-stability check sees as
    // "ready" the instant it has two polls, even mid-MCP-load.
    const STABLE_READY_PANE = [
      ' ▐▛███▜▌   Claude Code v2.1.142',
      '▝▜█████▛▘  Sonnet 4.6 · Claude Max',
      '  ▘▘ ▝▝    @music-curation:music-curator · ~/Music/rekordbox',
      '────────────────────────────────────────',
      '❯                                       ',
      '────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n');

    // A minimal in-memory append-only file. `_waitForReady` probes the
    // debug log via a synchronous `fs.statSync(...).size` (the test
    // seam is `opts.fs`), so the fake only needs `statSync`. An empty
    // file ENOENTs — modelling claude not having created the log yet.
    // `append()` lets the test drive debug-log writes by hand.
    function makeFakeDebugFile() {
      let content = '';
      const fakeFs = {
        statSync() {
          if (content === '') {
            const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
          }
          return { size: Buffer.byteLength(content) };
        },
      };
      return {
        fs: fakeFs,
        append(line) { content += `${line}\n`; },
      };
    }

    // The number of consecutive polls during which the fake debug log
    // is still being written (MCP servers connecting). Chosen well
    // above what the B6-only gate would tolerate: B6-only resolves
    // `quiesceMs` after the SECOND poll (the first byte-stable poll) —
    // here that is poll ~7 — so a writing window of 20 polls cleanly
    // separates "resolved early (B6 bug)" from "waited it out (B8)".
    const WRITING_POLLS = 20;

    test('does NOT resolve while the --debug-file log is still being written', async () => {
      // The B6-FOOLING shape: `captureWide` returns a byte-stable pane
      // WITH the ready hint from the very first poll — so B6's
      // pane-stability gate is satisfied on poll 2 and (pre-B8) would
      // resolve `quiesceMs` later. But the `--debug-file` log gets a
      // fresh MCP-startup line appended on every poll for the first
      // WRITING_POLLS polls. B8 must keep waiting through all of them.
      let poll = 0;
      let resolvedAtPoll = null;
      const debug = makeFakeDebugFile();
      const runner = makeFakeRunner({
        captureWide: async () => {
          poll += 1;
          if (poll <= WRITING_POLLS) {
            debug.append(
              `2026-05-19T12:10:${poll}.000Z [DEBUG] MCP server `
              + `"plugin:serena:serena": connecting (poll ${poll})`);
          }
          return STABLE_READY_PANE;
        },
      });
      const p = makeTmuxProcess(runner, {
        readyTimeoutMs: 8000,
        readyDebugQuietMs: 30,   // tiny quiet window for a fast test
        fs: debug.fs,
      });
      p.once('init', () => { resolvedAtPoll = poll; });
      await p.start({ model: 'sonnet', effort: 'low' });

      // The bug (B6-only): _waitForReady resolves on poll ~7 — the
      // pane is stable + hinted, the debug log is ignored entirely.
      // The fix: it must keep polling until the debug log has been
      // quiet for `readyDebugQuietMs`, which cannot happen before the
      // WRITING_POLLS writing polls are done.
      assert.ok(resolvedAtPoll > WRITING_POLLS,
        `_waitForReady resolved at poll ${resolvedAtPoll} — it must wait `
        + `past the ${WRITING_POLLS} polls where the --debug-file log is `
        + 'still being written (the MCP cold-start), not resolve on the '
        + 'byte-stable pane alone (B6-only resolves on poll ~7)');
    });

    test('DOES resolve once the --debug-file log goes quiet', async () => {
      // Same byte-stable ready pane; the debug log is written for the
      // first 3 polls then silent. _waitForReady must resolve — proves
      // the gate is not an unbounded wait, it releases on quiescence.
      let poll = 0;
      const debug = makeFakeDebugFile();
      const runner = makeFakeRunner({
        captureWide: async () => {
          poll += 1;
          if (poll <= 3) {
            debug.append(
              `2026-05-19T12:10:${40 + poll}.000Z [DEBUG] MCP server `
              + `"peekaboo": connecting (poll ${poll})`);
          }
          return STABLE_READY_PANE;
        },
      });
      const p = makeTmuxProcess(runner, {
        readyTimeoutMs: 4000,
        readyDebugQuietMs: 30,
        fs: debug.fs,
      });
      // start() resolving without throwing is the assertion: the gate
      // released once the debug log fell quiet after poll 3.
      await p.start({ model: 'sonnet', effort: 'low' });
      assert.ok(poll > 3,
        `must have polled past the 3 debug-writing polls; polled ${poll}`);
    });

    test('a debug log that NEVER goes quiet still hits TMUX_READY_TIMEOUT', async () => {
      // A genuinely wedged slow spawn — the debug log is written on
      // EVERY poll forever (MCP startup never completing / a crash
      // loop). The gate must not mask a real hang: _waitForReady must
      // still time out, never resolve.
      let poll = 0;
      const debug = makeFakeDebugFile();
      const runner = makeFakeRunner({
        captureWide: async () => {
          poll += 1;
          debug.append(
            `2026-05-19T12:10:${poll}.000Z [DEBUG] MCP server still connecting`);
          return STABLE_READY_PANE;
        },
      });
      const p = makeTmuxProcess(runner, {
        readyTimeoutMs: 120,
        readyDebugQuietMs: 1000,   // longer than the whole timeout
        fs: debug.fs,
      });
      await assert.rejects(
        p.start({ model: 'sonnet', effort: 'low' }),
        (err) => err.code === 'TMUX_READY_TIMEOUT',
        'a debug log written on every poll means MCP startup never '
        + 'finished — _waitForReady must time out, not resolve',
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
  test('Phase 4 §6 — capture-pane completion with no JSONL reply text fails loud, never returns pane text', async () => {
    // 0.10.0 Phase 4 §6: capture-pane is a LIVENESS signal only — it
    // never delivers reply text. A turn the capture-pane race judged
    // complete but for which no JSONL text exists fails loud with an
    // explicit error, NEVER with the pane diff (which was the
    // echoed-input and banner-as-reply failure class). The genuine
    // JSONL-driven success path is covered by tmux-process-jsonl.
    //
    // B7 fixture note: this test exercises §6's "a turn that RAN but
    // produced no reply TEXT" case. With B7's JSONL-token submit
    // confirmation, the proof a turn *started* is its `user-message`
    // line — `makeTmuxProcess`'s default `autoSubmitOnEnter` feeds
    // that `user-message` (modelling a TUI that submits), so B7's
    // confirm passes; then the turn proceeds and fails §6-loud because
    // NO assistant `result` text ever follows.
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
    // The turn started (user-message) but no JSONL reply text → fails loud.
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
        // B6: _waitForReady now confirms readiness by pane STABILITY
        // — it needs two identical consecutive captures carrying the
        // ready hint, then `quiesceMs` of holding (quiesceMs=5 in the
        // test config). Return a stable ready buffer for the first
        // few captures so the spawn's ready-check completes; only
        // AFTER that do the turn's capture-pane subprocesses wedge.
        if (captures <= 3) return '? for shortcuts';
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

// ─── H3: idle ceiling + hard backstop replace W1 absolute deadline ──
//
// rc.40: the old W1 was an absolute setTimeout that killed any turn
// running longer than turnTimeoutMs, regardless of whether the turn
// was making progress. The msg-884 incident (49-min SoundCloud
// subagent killed at 30 min while demonstrably alive) was the
// motivating fail. H3 inverts: `turnTimeoutMs` is now the IDLE
// ceiling — a turn is wedged only if NO activity (JSONL events,
// capture-pane stream signals, OR hook events) for that long. A
// healthy long subagent firing hooks every few seconds never trips.
// A separate `hardBackstopMs` (default 4h) is the absolute backstop
// against pathological infinite tool loops.

describe('TmuxProcess — H3 idle ceiling + hard backstop', () => {
  // Helper: wedge captures so only the timeout racer can fire.
  function makeWedgedRunner() {
    let captures = 0;
    return makeFakeRunner({
      captureWide: async () => {
        captures += 1;
        // First 3 captures complete the ready-check; subsequent ones
        // wedge so capture-pane quiescence can never settle the turn.
        if (captures <= 3) return '? for shortcuts';
        return new Promise(() => {});
      },
    });
  }

  test('hook events heartbeat the active group turns (predicate liveness)', () => {
    // Direct unit-level invocation — no start() needed. Tests just
    // the _handleHookEvent → _heartbeat link.
    const p = makeTmuxProcess(makeFakeRunner());
    const fakeTurn = { lastActivityAt: 0, phase: 'streaming', turnId: 1 };
    p._activeGroup = { turns: [fakeTurn], text: '', primaryTurnId: 1 };
    const before = fakeTurn.lastActivityAt;
    p._handleHookEvent({ type: 'PreToolUse', toolName: 'Bash' });
    assert.ok(fakeTurn.lastActivityAt > before,
      'hook event must heartbeat the active turn');
    // parse-error and unknown explicitly do NOT heartbeat — they're
    // diagnostic-only and shouldn't keep a wedged turn alive.
    fakeTurn.lastActivityAt = 0;
    p._handleHookEvent({ type: 'parse-error', error: 'x', raw: '...' });
    assert.equal(fakeTurn.lastActivityAt, 0,
      'parse-error must NOT heartbeat — it is diagnostic noise, not liveness');
    p._handleHookEvent({ type: 'unknown', raw: {} });
    assert.equal(fakeTurn.lastActivityAt, 0,
      'unknown event must NOT heartbeat either');
  });

  test('idle-ceiling timeout fires when nothing heartbeats the turn', async () => {
    // turnTimeoutMs=80 ms idle ceiling, hardBackstopMs=10 s so only
    // the idle path can win. Capture wedged so quiesced can never
    // settle. With the adaptive poll, detection should land inside
    // ~250 ms.
    const p = makeTmuxProcess(makeWedgedRunner(),
      { turnTimeoutMs: 80, hardBackstopMs: 10_000, pollMs: 5 });
    await p.start({ model: 'sonnet', effort: 'high' });
    const settled = await Promise.race([
      p.send('hello').then((r) => ({ kind: 'settled', r })),
      new Promise((r) => setTimeout(() => r({ kind: 'hung' }), 2000)),
    ]);
    assert.equal(settled.kind, 'settled',
      'idle-ceiling poller must fire even though capture-pane is wedged');
    assert.ok(settled.r.error,
      'idle-timed-out turn settles as an error');
  });

  test('continuous heartbeats keep the turn alive past turnTimeoutMs', async () => {
    // turnTimeoutMs=300 ms. Inject a hook event every 25 ms — well
    // inside the idle ceiling. Turn must NOT idle-timeout while
    // heartbeats arrive. Stop heartbeating after 800 ms; turn THEN
    // idle-times-out at ~800+300 = ~1100 ms. Hard backstop is 10 s.
    const turnTimeoutMs = 300;
    const heartbeatWindowMs = 800;
    const p = makeTmuxProcess(makeWedgedRunner(),
      { turnTimeoutMs, hardBackstopMs: 10_000, pollMs: 5 });
    await p.start({ model: 'sonnet', effort: 'high' });
    const startedAt = Date.now();
    const sendP = p.send('hello');
    const heartbeatInterval = setInterval(() => {
      p._handleHookEvent({ type: 'PostToolUse', toolName: 'Bash', toolUseId: 'x' });
    }, 25);
    setTimeout(() => clearInterval(heartbeatInterval), heartbeatWindowMs);
    const result = await Promise.race([
      sendP.then((r) => ({ kind: 'settled', r })),
      new Promise((r) => setTimeout(() => r({ kind: 'hung' }), 3000)),
    ]);
    clearInterval(heartbeatInterval);
    const durationMs = Date.now() - startedAt;
    assert.equal(result.kind, 'settled',
      'turn must eventually settle once heartbeats stop');
    // The load-bearing assertion: the turn outlived turnTimeoutMs
    // because heartbeats kept resetting the idle clock. Without
    // heartbeats it would idle-timeout in ~300 ms; with continuous
    // heartbeats for `heartbeatWindowMs` it survives at least that
    // long. Generous floor (heartbeatWindowMs - 50ms slack) to
    // tolerate event-loop jitter on the heartbeat setInterval.
    assert.ok(
      durationMs >= heartbeatWindowMs - 50,
      `turn settled at ${durationMs} ms but heartbeats ran for ${heartbeatWindowMs} ms — `
      + 'the idle poller fired DESPITE active heartbeats (H3 broken)',
    );
  });

  test('hard-backstop fires even with continuous heartbeats', async () => {
    // The pathological-infinite-tool-loop guard. turnTimeoutMs huge
    // (10 s) so idle never fires; hardBackstopMs=150 ms; heartbeats
    // every 25 ms. Turn MUST settle within ~500 ms via the backstop.
    const p = makeTmuxProcess(makeWedgedRunner(),
      { turnTimeoutMs: 10_000, hardBackstopMs: 150, pollMs: 5 });
    await p.start({ model: 'sonnet', effort: 'high' });
    const sendP = p.send('hello');
    const heartbeatInterval = setInterval(() => {
      p._handleHookEvent({ type: 'PostToolUse', toolName: 'Bash', toolUseId: 'y' });
    }, 25);
    const result = await Promise.race([
      sendP.then((r) => ({ kind: 'settled', r })),
      new Promise((r) => setTimeout(() => r({ kind: 'hung' }), 2000)),
    ]);
    clearInterval(heartbeatInterval);
    assert.equal(result.kind, 'settled',
      'hard-backstop must fire regardless of heartbeats');
    assert.ok(result.r.error,
      'backstop-timed-out turn settles as an error');
  });

  test('hardBackstopMs defaults to 4h (sanity — no production regression)', () => {
    const p = makeTmuxProcess(makeFakeRunner());
    assert.equal(p.hardBackstopMs, 4 * 60 * 60 * 1000,
      'default hardBackstopMs must be 4h — generous beyond any single-turn legit runtime');
  });
});

// ─── H4: Stop hook as authoritative turn-done signal ────────────────
//
// rc.41: Stop hook fires when claude finishes responding — same
// semantic as the JSONL `result` event. H4 synthesizes a settle
// from Stop after a small grace, so if JSONL `result` never arrives
// (broken stream, stuck parser) the turn isn't stranded. JSONL wins
// when both fire because Promise resolve is idempotent.

describe('TmuxProcess — H4 Stop hook as authoritative completion', () => {
  test('Stop hook fires settleResult after the grace if JSONL never arrives', async () => {
    const p = makeTmuxProcess(makeFakeRunner(), { stopGraceMs: 50 });
    // Build a primary turn with the same shape _runTurn would:
    // resultPromise + settleResult bound, kind='primary', text=''.
    let settledWith = null;
    const turn = {
      kind: 'primary', turnId: 1, text: '',
      lastActivityAt: 0,
      resultPromise: null, settleResult: null,
    };
    turn.resultPromise = new Promise((resolve) => {
      turn.settleResult = (ev) => { settledWith = ev; resolve(ev); };
    });
    p._activeGroup = { turns: [turn], text: '', primaryTurnId: 1 };

    p._handleHookEvent({
      type: 'Stop',
      stopHookActive: false,
      lastAssistantMessage: 'done from stop hook',
    });

    // JSONL never fires. After the grace, the synth settle lands.
    const result = await Promise.race([
      turn.resultPromise,
      new Promise((r) => setTimeout(() => r('hung'), 500)),
    ]);
    assert.notEqual(result, 'hung', 'Stop hook synth settle must fire after grace');
    assert.equal(settledWith.text, 'done from stop hook');
    assert.equal(settledWith.subtype, 'success');
    assert.equal(settledWith.stopReason, 'stop_hook');
    assert.equal(settledWith.via, 'stop-hook');
  });

  test('JSONL settles first → Stop synth becomes a no-op (idempotent)', async () => {
    const p = makeTmuxProcess(makeFakeRunner(), { stopGraceMs: 100 });
    let settledWith = null;
    const turn = {
      kind: 'primary', turnId: 1, text: 'streamed text',
      lastActivityAt: 0,
      resultPromise: null, settleResult: null,
    };
    turn.resultPromise = new Promise((resolve) => {
      turn.settleResult = (ev) => {
        // Only the FIRST settle wins. Subsequent calls must no-op.
        if (settledWith) return;
        settledWith = ev;
        resolve(ev);
      };
    });
    p._activeGroup = { turns: [turn], text: '', primaryTurnId: 1 };

    p._handleHookEvent({
      type: 'Stop',
      lastAssistantMessage: 'hook-text',
    });
    // JSONL fires BEFORE the Stop grace expires — full result event.
    setTimeout(() => {
      turn.settleResult({
        text: 'streamed text', subtype: 'success', stopReason: 'end_turn',
        // No `via` field — that's the marker that this came from JSONL.
      });
    }, 30);

    await turn.resultPromise;
    // Wait past the Stop grace so the synth timer has a chance to fire.
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(settledWith.stopReason, 'end_turn',
      'JSONL result must win; Stop synth (`stop_hook`) must not overwrite');
    assert.equal(settledWith.via, undefined,
      'no `via:stop-hook` marker — JSONL settled first');
  });

  test('Stop hook with no primary turn in the active group is a no-op', () => {
    // Stop firing between turns (between settled primary and next
    // pending) must not throw / not try to settle a non-existent
    // turn.
    const p = makeTmuxProcess(makeFakeRunner());
    p._activeGroup = { turns: [], text: '', primaryTurnId: null };
    assert.doesNotThrow(() => {
      p._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'done' });
    });
  });

  test('Stop hook prefers turn.text over lastAssistantMessage when present', async () => {
    // Streaming-fed `turn.text` should win in the synth — it carries
    // polygram-side accumulation that may differ from claude's
    // snapshot (formatting, partial-chunk handling). Stop's
    // lastAssistantMessage is the fallback.
    const p = makeTmuxProcess(makeFakeRunner(), { stopGraceMs: 30 });
    const turn = {
      kind: 'primary', turnId: 1, text: 'from streaming',
      lastActivityAt: 0,
      resultPromise: null, settleResult: null,
    };
    turn.resultPromise = new Promise((resolve) => {
      turn.settleResult = (ev) => resolve(ev);
    });
    p._activeGroup = { turns: [turn], text: '', primaryTurnId: 1 };
    p._handleHookEvent({
      type: 'Stop', lastAssistantMessage: 'from hook snapshot',
    });
    const settled = await turn.resultPromise;
    assert.equal(settled.text, 'from streaming',
      'turn.text wins when present');
  });

  test('Stop hook falls back to lastAssistantMessage when turn.text is empty', async () => {
    // Production case: a broken JSONL stream means no
    // `assistant-chunk` events landed, so turn.text is empty. Stop's
    // `last_assistant_message` is the only text available.
    const p = makeTmuxProcess(makeFakeRunner(), { stopGraceMs: 30 });
    const turn = {
      kind: 'primary', turnId: 1, text: '',
      lastActivityAt: 0,
      resultPromise: null, settleResult: null,
    };
    turn.resultPromise = new Promise((resolve) => {
      turn.settleResult = (ev) => resolve(ev);
    });
    p._activeGroup = { turns: [turn], text: '', primaryTurnId: 1 };
    p._handleHookEvent({
      type: 'Stop', lastAssistantMessage: 'rescued by stop hook',
    });
    const settled = await turn.resultPromise;
    assert.equal(settled.text, 'rescued by stop hook',
      'lastAssistantMessage fallback when turn.text is empty');
  });

  test('stopGraceMs defaults to 2000 ms (sanity)', () => {
    const p = makeTmuxProcess(makeFakeRunner());
    assert.equal(p.stopGraceMs, 2000);
  });
});

// ─── rc.42 review-driven additions ──────────────────────────────────
//
// Closing gaps the multi-agent code review surfaced:
//  - #10 idle-ceiling vs hard-backstop is now distinguishable
//  - #11 hard-backstop test pins the reason
//  - #12 turnTimeoutMs boundary validation
//  - #13 pendingQueue[0] heartbeat path has its own test

describe('TmuxProcess — rc.42 review-driven coverage', () => {
  function makeWedgedRunner() {
    let captures = 0;
    return makeFakeRunner({
      captureWide: async () => {
        captures += 1;
        if (captures <= 3) return '? for shortcuts';
        return new Promise(() => {});
      },
    });
  }

  // #10 — outcome.reason is observable on the thrown error
  test('idle-ceiling timeout sets error.reason="idle-ceiling" + error.idleMs', async () => {
    const p = makeTmuxProcess(makeWedgedRunner(),
      { turnTimeoutMs: 80, hardBackstopMs: 10_000, pollMs: 5 });
    await p.start({ model: 'sonnet', effort: 'high' });
    const r = await Promise.race([
      p.send('hi').then((res) => ({ kind: 'settled', res })),
      new Promise((res) => setTimeout(() => res({ kind: 'hung' }), 2000)),
    ]);
    assert.equal(r.kind, 'settled');
    // The error returned in result.error carries the message; the
    // underlying Error code/reason are surfaced via the result shape.
    assert.match(r.res.error || '', /did not complete in time/);
    // The turn-timeout event is the observable channel.
  });

  // #10 — turn-timeout event carries reason + idleMs
  test('idle-ceiling timeout emits turn-timeout event with reason=idle-ceiling', async () => {
    const p = makeTmuxProcess(makeWedgedRunner(),
      { turnTimeoutMs: 80, hardBackstopMs: 10_000, pollMs: 5 });
    const events = [];
    p.on('turn-timeout', (ev) => events.push(ev));
    await p.start({ model: 'sonnet', effort: 'high' });
    await Promise.race([
      p.send('hi'),
      new Promise((res) => setTimeout(res, 2000)),
    ]);
    assert.equal(events.length, 1, 'turn-timeout must fire exactly once');
    assert.equal(events[0].reason, 'idle-ceiling');
    assert.equal(typeof events[0].idleMs, 'number');
    assert.ok(events[0].idleMs >= 80,
      `idleMs should be >= turnTimeoutMs (80), got ${events[0].idleMs}`);
    assert.equal(events[0].backend, 'tmux');
  });

  // #11 — hard-backstop timeout emits turn-timeout event with reason=hard-backstop
  test('hard-backstop timeout emits turn-timeout event with reason=hard-backstop', async () => {
    const p = makeTmuxProcess(makeWedgedRunner(),
      { turnTimeoutMs: 10_000, hardBackstopMs: 100, pollMs: 5 });
    const events = [];
    p.on('turn-timeout', (ev) => events.push(ev));
    await p.start({ model: 'sonnet', effort: 'high' });
    const sendP = p.send('hi');
    // Heartbeat continuously so idle-ceiling cannot fire — only the
    // hard-backstop racer can.
    const heartbeat = setInterval(() => {
      p._handleHookEvent({ type: 'PostToolUse', toolName: 'Bash', toolUseId: 'x' });
    }, 25);
    await Promise.race([sendP, new Promise((res) => setTimeout(res, 2000))]);
    clearInterval(heartbeat);
    assert.equal(events.length, 1, 'turn-timeout must fire exactly once');
    assert.equal(events[0].reason, 'hard-backstop',
      'reason must be hard-backstop when continuous heartbeats prevent idle-ceiling from firing');
  });

  // #12 — constructor rejects invalid turnTimeoutMs
  test('constructor rejects NaN turnTimeoutMs', () => {
    assert.throws(
      () => makeTmuxProcess(makeFakeRunner(), { turnTimeoutMs: NaN }),
      /must be a finite non-negative number/,
    );
  });

  test('constructor rejects negative turnTimeoutMs', () => {
    assert.throws(
      () => makeTmuxProcess(makeFakeRunner(), { turnTimeoutMs: -1 }),
      /must be a finite non-negative number/,
    );
  });

  test('constructor rejects Infinity turnTimeoutMs', () => {
    assert.throws(
      () => makeTmuxProcess(makeFakeRunner(), { turnTimeoutMs: Infinity }),
      /must be a finite non-negative number/,
    );
  });

  test('constructor rejects NaN hardBackstopMs', () => {
    assert.throws(
      () => makeTmuxProcess(makeFakeRunner(), { hardBackstopMs: NaN }),
      /must be a finite non-negative number/,
    );
  });

  test('constructor rejects NaN stopGraceMs', () => {
    assert.throws(
      () => makeTmuxProcess(makeFakeRunner(), { stopGraceMs: NaN }),
      /must be a finite non-negative number/,
    );
  });

  // #13 — pendingQueue[0] heartbeat fallback (pre-active window)
  test('hook event heartbeats pendingQueue[0] turn when _activeGroup is empty', () => {
    // The H4 rc.41 change extended the heartbeat fan-out to cover
    // the window between turn start and the first `user-message`
    // (when the turn lives in pendingQueue but not yet in
    // _activeGroup). Without this branch, hook events during cold-
    // start are useless for the idle poller.
    const p = makeTmuxProcess(makeFakeRunner());
    const fakeTurn = {
      lastActivityAt: 0, phase: 'queued', turnId: 1,
      kind: 'primary', state: 'pasted',
    };
    p._activeGroup = { turns: [], text: '', primaryTurnId: null };
    p.pendingQueue.push(fakeTurn);
    p._handleHookEvent({ type: 'UserPromptSubmit', prompt: 'hi' });
    assert.ok(fakeTurn.lastActivityAt > 0,
      'pre-active-window heartbeat must reach the pendingQueue head');
  });

  // #6 (review-driven) — Stop-synth timer cleared on _finishTurn
  test('_finishTurn clears any pending Stop-synth timer on the retiring turn', () => {
    const p = makeTmuxProcess(makeFakeRunner(), { stopGraceMs: 60_000 });
    const turn = {
      turnId: 1, kind: 'primary', token: 't',
      text: '', resultPromise: null, settleResult: null,
      _stopSynthScheduled: false, _stopSynthTimer: null,
    };
    turn.resultPromise = new Promise((r) => { turn.settleResult = r; });
    p._activeGroup = { turns: [turn], text: '', primaryTurnId: 1 };
    p.pendingQueue.push(turn);

    p._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'done' });
    assert.ok(turn._stopSynthTimer, 'Stop synth timer should be scheduled');
    assert.equal(turn._stopSynthScheduled, true);

    p._finishTurn(turn);
    assert.equal(turn._stopSynthTimer, null,
      '_finishTurn must clear the Stop synth timer');
  });

  // rc.43 — session-age prompt detection regex
  test('SESSION_AGE_PROMPT_RE matches the real claude TUI session-age menu', () => {
    const { SESSION_AGE_PROMPT_RE } = require('../lib/process/tmux-process');
    // Real production capture (shumorobot Music topic, 2026-05-22 21:11).
    const realMenu = `\
✻ Brewed for 1m 19s

────────────────────────────────────────────────────────────────────
  This session is 8h 38m old and 117.6k tokens.

  Resuming the full session will consume a substantial portion of your usage limits.
  We recommend resuming from a summary.

  ❯ 1. Resume from summary (recommended)
    2. Resume full session as-is
    3. Don't ask me again

  Enter to confirm · Esc to cancel
`;
    assert.ok(SESSION_AGE_PROMPT_RE.test(realMenu),
      'must match the real production session-age menu');
  });

  test('SESSION_AGE_PROMPT_RE does NOT match the normal ready hint', () => {
    const { SESSION_AGE_PROMPT_RE } = require('../lib/process/tmux-process');
    const normalReady = `
Type a message…

? for shortcuts
bypass permissions on (shift+tab to cycle)
`;
    assert.ok(!SESSION_AGE_PROMPT_RE.test(normalReady),
      'must NOT match a normal ready pane (would cause false dismissal)');
  });

  test('SESSION_AGE_PROMPT_RE does NOT match prose mentioning the phrases', () => {
    const { SESSION_AGE_PROMPT_RE } = require('../lib/process/tmux-process');
    // A turn whose ASSISTANT TEXT discussed the prompt itself
    // must not be misread as the menu. The regex requires both
    // distinctive substrings — "Resuming the full session" AND
    // "Resume from summary" — in that order, so prose that uses
    // just one is safe. Prose that mentions both is rare but the
    // false-positive risk is low; if it ever fires, polygram
    // sends Enter into the chat input which the TUI handles as a
    // submit-empty no-op, not catastrophic.
    const justOne = 'Yes, "Resume from summary" is the default option in the menu.';
    assert.ok(!SESSION_AGE_PROMPT_RE.test(justOne),
      'mentioning only one phrase must not match');
  });

  // #6 (review-driven) — repeated Stop events don't schedule N timers
  test('repeated Stop events only schedule ONE Stop-synth timer per turn', () => {
    const p = makeTmuxProcess(makeFakeRunner(), { stopGraceMs: 60_000 });
    const turn = {
      turnId: 1, kind: 'primary', text: '',
      resultPromise: null, settleResult: null,
      _stopSynthScheduled: false, _stopSynthTimer: null,
    };
    turn.resultPromise = new Promise((r) => { turn.settleResult = r; });
    p._activeGroup = { turns: [turn], text: '', primaryTurnId: 1 };

    p._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'a' });
    const firstTimer = turn._stopSynthTimer;
    p._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'b' });
    p._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'c' });

    assert.strictEqual(turn._stopSynthTimer, firstTimer,
      'subsequent Stop events must not arm new timers — `_stopSynthScheduled` guard');
    try { clearTimeout(firstTimer); } catch { /* swallow */ }
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

// ─── B7: JSONL-token submit confirmation ────────────────────────────

describe('TmuxProcess B7 — JSONL-token submit confirmation', () => {
  // 2026-05-19 incident (shumorobot msg 803, 3rd recurrence): a WARM,
  // already-idle session (a previous turn had just completed) is sent
  // a ~1-2KB prompt. The claude TUI collapses it into a `[Pasted text
  // #N]` placeholder. The single post-paste Enter is absorbed while
  // the TUI is still ingesting the bracketed-paste block — the prompt
  // sits unsubmitted in the input box, the turn never starts.
  //
  // B5 tried to confirm the submit by capture-pane (does the input box
  // still hold the paste?). That FALSE-POSITIVES: the TUI hides the
  // pasted text behind the `[Pasted text #N]` placeholder, so B5's
  // "is the text still in the box?" check cannot find it and wrongly
  // concludes "submitted ✓", leaving the prompt stuck.
  //
  // B7 fix: the ONLY reliable "the prompt reached claude" signal is the
  // JSONL `user-message` line carrying THIS paste's correlation token.
  // `_scheduleSubmitRetries(token, turn)` waits (bounded) for that
  // tokened user-message; on a miss it re-sends Enter (bounded
  // retries); if it never surfaces it throws TMUX_SUBMIT_FAILED. It
  // runs as a CONCURRENT racer in `_runTurn` — NOT a blocking gate in
  // `_pasteAndEnter` (which would hold `_pasteLock` across the confirm
  // window and stall a folding autosteer's paste).

  function enterCount(runner) {
    return runner._calls.filter((c) => c.kind === 'sendControl' && c.key === 'Enter').length;
  }

  test('confirmed: tokened user-message arrives → resolves, no retry Enter, no capture-pane', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner, { submitConfirmMs: 200, autoSubmitOnEnter: false });
    p.tmuxName = 'warm-sess';
    const token = p._mintToken();

    const confirmP = p._scheduleSubmitRetries(token);
    // Simulate the JSONL tail: claude registered the prompt and wrote
    // a `user-message` line carrying the token verbatim.
    setTimeout(() => {
      p._handleSessionEvent({ type: 'user-message', text:
        `<polygram-info corr-id="${token}"></polygram-info>\n\nprompt` });
    }, 10);

    await confirmP; // resolves — confirmed by the token, not capture-pane
    assert.equal(enterCount(runner), 0, 'confirm alone sends no Enter (the paste already did)');
    assert.ok(!runner._calls.some((c) => c.kind === 'capturePane' || c.kind === 'captureWide'),
      'B7 confirmation must NOT capture-pane — capture-pane false-positives on [Pasted text #N]');
  });

  test('warm-session [Pasted text #2] stuck: no user-message → re-sends Enter → confirmed on retry', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner, {
      submitConfirmMs: 40, submitConfirmRetries: 4, autoSubmitOnEnter: false,
    });
    p.tmuxName = 'warm-sess';
    const token = p._mintToken();

    const confirmP = p._scheduleSubmitRetries(token);
    // First confirm window elapses with no user-message — the prompt
    // sits as `[Pasted text #2]`. The retry Enter lands; claude then
    // registers the prompt and writes the tokened user-message.
    setTimeout(() => {
      assert.ok(enterCount(runner) >= 1,
        'a non-submitting paste must trigger a retry Enter');
      p._handleSessionEvent({ type: 'user-message', text:
        `<polygram-info corr-id="${token}"></polygram-info>\n\nprompt` });
    }, 60);

    await confirmP;
    assert.ok(enterCount(runner) >= 1,
      'the retry Enter was sent — submission keys on the JSONL token, not the pane');
  });

  test('never submits: no user-message ever → retries exhausted → throws TMUX_SUBMIT_FAILED', async () => {
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner, {
      submitConfirmMs: 20, submitConfirmRetries: 3, autoSubmitOnEnter: false,
    });
    p.tmuxName = 'wedged-sess';
    const token = p._mintToken();

    // No JSONL user-message is ever fed — the prompt never submits.
    await assert.rejects(
      () => p._scheduleSubmitRetries(token),
      (err) => {
        assert.equal(err.code, 'TMUX_SUBMIT_FAILED',
          'a never-submitting paste must throw TMUX_SUBMIT_FAILED, NOT false-positive success');
        return true;
      },
    );
    // submitConfirmRetries=3 → 3 retry Enters before the loud throw.
    assert.equal(enterCount(runner), 3, 'all retry Enters were attempted before the loud throw');
  });

  test('turn already settled (result/capture won, or killed) → confirm bails, no retry Enter, no throw', async () => {
    // The confirm runs as a concurrent racer; if the real result/
    // capture racer settled the turn first, the submit clearly landed
    // — the confirm must NOT then re-send Enter or throw.
    const runner = makeFakeRunner();
    const p = makeTmuxProcess(runner, {
      submitConfirmMs: 20, submitConfirmRetries: 3, autoSubmitOnEnter: false,
    });
    p.tmuxName = 'sess';
    const token = p._mintToken();
    const turn = { state: 'streaming' };
    const confirmP = p._scheduleSubmitRetries(token, turn);
    // Before the first confirm window elapses, the turn settles.
    setTimeout(() => { turn.state = 'done'; }, 5);
    await confirmP; // resolves quietly — no throw
    assert.equal(enterCount(runner), 0, 'a settled turn gets no retry Enter from the confirm');
  });

  test('warm-session send(): a primary paste that does not submit fails the turn loud (TMUX_SUBMIT_FAILED)', async () => {
    // End-to-end: a WARM session (one turn already done) gets a large
    // prompt; the fake TUI never emits the `user-message` (the paste
    // collapsed to `[Pasted text #N]` and the Enter was absorbed).
    // The B7 submit-confirm racer fails the turn loud — fast — instead
    // of the turn hanging to the grace window. autoSubmitOnEnter:false
    // models the non-submitting TUI.
    let captureCount = 0;
    const runner = makeFakeRunner({
      captureWide: async () => {
        captureCount += 1;
        if (captureCount === 1) return '? for shortcuts'; // start ready-check
        return 'PRELUDE\n? for shortcuts'; // idle pane, no reply
      },
    });
    const p = makeTmuxProcess(runner, {
      submitConfirmMs: 20, submitConfirmRetries: 2, turnTimeoutMs: 10_000,
      autoSubmitOnEnter: false,
    });
    await p.start({ model: 'sonnet', effort: 'high', existingSessionId: 'warm' });
    const res = await p.send('a large prompt that collapses to [Pasted text #2]');
    assert.equal(res.metrics.resultSubtype, 'TMUX_SUBMIT_FAILED',
      'a primary paste that never produced a user-message fails the turn loud — '
      + 'pre-B7 the capture-pane confirm false-positived "submitted ✓"');
    assert.equal(res.text, '', 'no text is fabricated for an unsubmitted prompt');
    assert.ok(enterCount(runner) >= 2,
      'the submit-confirm re-sent Enter on the non-submitting paste before failing loud');
  });

  // ─── C1: paste-parked (0.10.0 Commit 2) ──────────────────────────
  //
  // The 2026-05-20 C1 trace: a primary paste lands while the TUI is
  // busy with a prior turn. The TUI PARKS it in its input queue and
  // writes a `queue-operation enqueue` carrying the paste's
  // correlation token. NO `user-message` follows until the prior turn
  // finishes and the TUI dequeues ours.
  //
  // Pre-Commit-2 (`_confirmSubmitViaJsonl`): the confirm couldn't tell
  // a parked paste from an absorbed-Enter paste — it re-sent Enter 5×
  // (each could submit a DIFFERENT queued item or double-submit) then
  // failed loud `TMUX_SUBMIT_FAILED` on a turn that was legitimately
  // in flight.
  //
  // Commit 2 (`_scheduleSubmitRetries`): the turn-phase predicate sets
  // `turn.parked = true` on the enqueue. Once parked, the confirm
  // stops re-sending Enter and waits (unbounded — W1 is the floor) for
  // the eventual `user-message`.
  describe('C1: paste-parked submit confirmation', () => {
    test('parked-from-the-start: enqueue with our token → NO retry Enter, settles on user-message', async () => {
      const runner = makeFakeRunner();
      const p = makeTmuxProcess(runner, {
        submitConfirmMs: 30, submitConfirmRetries: 4, autoSubmitOnEnter: false,
      });
      p.tmuxName = 'busy-sess';
      // A live primary turn whose paste the busy TUI will park. It must
      // be in the ledger so the predicate (driven via _handleSessionEvent)
      // can find it by token and set `parked`.
      const turn = p._makeTurn({ kind: 'primary', prompt: 'do X', msgIds: [1] });
      p._ledger.push(turn);

      const submitParked = [];
      p.on('submit-parked', (ev) => submitParked.push(ev));

      const confirmP = p._scheduleSubmitRetries(turn.token, turn);

      // The TUI parks our paste: queue-operation enqueue carrying our
      // token. The predicate sets turn.parked = true.
      p._handleSessionEvent({
        type: 'queue-operation', operation: 'enqueue',
        content: `<polygram-info corr-id="${turn.token}"></polygram-info>\n\ndo X`,
      });
      assert.equal(turn.parked, true, 'enqueue with our token sets parked');

      // Prior turn finishes; TUI dequeues ours and writes the user-message.
      setTimeout(() => {
        p._handleSessionEvent({ type: 'user-message', text:
          `<polygram-info corr-id="${turn.token}"></polygram-info>\n\ndo X` });
      }, 60);

      await confirmP; // resolves on the user-message, not via retry/throw
      assert.equal(enterCount(runner), 0,
        'a PARKED paste must NOT re-send Enter — the TUI already holds it');
      assert.ok(submitParked.length >= 1, 'submit-parked event fired for observability');
      assert.equal(submitParked[0].token, turn.token);
    });

    test('parked-after-first-miss: one confirm window misses, THEN enqueue → stop retrying, settle on user-message', async () => {
      const runner = makeFakeRunner();
      const p = makeTmuxProcess(runner, {
        submitConfirmMs: 30, submitConfirmRetries: 4, autoSubmitOnEnter: false,
      });
      p.tmuxName = 'busy-sess';
      const turn = p._makeTurn({ kind: 'primary', prompt: 'do Y', msgIds: [2] });
      p._ledger.push(turn);

      const confirmP = p._scheduleSubmitRetries(turn.token, turn);

      // First confirm window elapses with neither user-message nor
      // enqueue → one retry Enter fires. THEN the enqueue lands.
      setTimeout(() => {
        const entersBeforePark = enterCount(runner);
        assert.ok(entersBeforePark >= 1,
          'the first miss (not yet parked) re-sends Enter — same as a stuck paste');
        p._handleSessionEvent({
          type: 'queue-operation', operation: 'enqueue',
          content: `<polygram-info corr-id="${turn.token}"></polygram-info>\n\ndo Y`,
        });
        assert.equal(turn.parked, true);
        // Capture the Enter count at park time; assert no MORE fire after.
        p._parkEnterBaseline = enterCount(runner);
        // Then the TUI dequeues + user-message arrives.
        setTimeout(() => {
          p._handleSessionEvent({ type: 'user-message', text:
            `<polygram-info corr-id="${turn.token}"></polygram-info>\n\ndo Y` });
        }, 50);
      }, 45);

      await confirmP;
      assert.equal(enterCount(runner), p._parkEnterBaseline,
        'no further retry Enter after the paste is observed parked');
    });

    test('NOT parked (different token enqueued) → still fails loud TMUX_SUBMIT_FAILED', async () => {
      // An enqueue for a DIFFERENT turn must not mark OUR turn parked —
      // a genuinely stuck paste must still fail loud.
      const runner = makeFakeRunner();
      const p = makeTmuxProcess(runner, {
        submitConfirmMs: 15, submitConfirmRetries: 2, autoSubmitOnEnter: false,
      });
      p.tmuxName = 'wedged-sess';
      const turn = p._makeTurn({ kind: 'primary', prompt: 'mine', msgIds: [3] });
      p._ledger.push(turn);

      // Some OTHER turn's paste gets parked — not ours.
      p._handleSessionEvent({
        type: 'queue-operation', operation: 'enqueue',
        content: '<polygram-info corr-id="pgm-corr-aaaaaaaaaaaaaaaaaaaaaaaa"></polygram-info>',
      });
      assert.equal(turn.parked, false, 'an enqueue for another token must NOT park us');

      await assert.rejects(
        () => p._scheduleSubmitRetries(turn.token, turn),
        (err) => err.code === 'TMUX_SUBMIT_FAILED',
      );
      assert.equal(enterCount(runner), 2,
        'a genuinely stuck (non-parked) paste still exhausts retries and fails loud');
    });

    test('parked then turn killed before user-message → confirm resolves quietly (no leak, no throw)', async () => {
      const runner = makeFakeRunner();
      const p = makeTmuxProcess(runner, {
        submitConfirmMs: 30, submitConfirmRetries: 4, autoSubmitOnEnter: false,
      });
      p.tmuxName = 'busy-sess';
      const turn = p._makeTurn({ kind: 'primary', prompt: 'do Z', msgIds: [4] });
      // Arm the interrupt promise the way _runTurn does, so the parked
      // wait can bail when the turn is interrupted.
      turn.interruptP = new Promise((resolve) => { turn.signalInterrupt = resolve; });
      p._ledger.push(turn);

      const confirmP = p._scheduleSubmitRetries(turn.token, turn);
      p._handleSessionEvent({
        type: 'queue-operation', operation: 'enqueue',
        content: `<polygram-info corr-id="${turn.token}"></polygram-info>\n\ndo Z`,
      });
      assert.equal(turn.parked, true);

      // The turn is interrupted before the user-message ever lands.
      setTimeout(() => { turn.state = 'failed'; turn.signalInterrupt(); }, 40);

      await confirmP; // resolves via interruptP — no hang, no throw
      assert.equal(enterCount(runner), 0, 'parked + killed sends no Enter');
      assert.ok(!p._submitConfirms.has(turn.token),
        'the submit-confirm waiter is cleaned up — no leaked Map entry');
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('../lib/process/cli-process');
const factory = require('../lib/process/factory');
const { createProcessFactory, pickBackend } = factory;

// Minimal fakes so we can construct without touching tmux / claude.
// Method shape matches lib/tmux/tmux-runner.js exports.
const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => 'Listening for channel messages from: server:polygram-bridge',
};
const fakeDispatcher = async () => ({ ok: true });

test('CliProcess construction — required params', () => {
  assert.throws(
    () => new CliProcess({}),
    /sessionKey/,
    'sessionKey required',
  );

  assert.throws(
    () => new CliProcess({ sessionKey: 'k', botName: 'b', toolDispatcher: fakeDispatcher }),
    /tmuxRunner required/,
  );

  assert.throws(
    () => new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, toolDispatcher: fakeDispatcher }),
    /botName required/,
  );

  assert.throws(
    () => new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b' }),
    /toolDispatcher.*required/,
  );
});

test('CliProcess construction — valid params', () => {
  const p = new CliProcess({
    sessionKey: 'session-1',
    chatId: '12345',
    threadId: null,
    label: 'test-chat',
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    claudeBin: '/usr/bin/echo',
    toolDispatcher: fakeDispatcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  assert.equal(p.sessionKey, 'session-1');
  assert.equal(p.chatId, '12345');
  assert.equal(p.threadId, null);
  assert.equal(p.label, 'test-chat');
  assert.equal(p.backend, 'cli');
  assert.equal(p.cost, 3);
  assert.equal(p.closed, false);
  assert.equal(p.inFlight, false);
  assert.equal(p.bridgeReady, false);
});

test('CliProcess.respondToPermission validates behavior arg', async () => {
  const p = new CliProcess({
    sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => p.respondToPermission('abcde', 'maybe'),
    /'allow' or 'deny'/,
  );
});

test('CliProcess.send rejects on unstarted instance', async () => {
  const p = new CliProcess({
    sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => p.send('hello'),
    /bridge not ready/,
  );
});

// 0.12: pm:'channels' is now an alias for pm:'cli' (the canonical post-0.12
// backend name). pickBackend resolves the alias and emits a once-per-process
// deprecation warn. These tests assert the alias resolves to 'cli'.

test('pickBackend resolves channels alias → cli via chatConfig.pm', () => {
  factory._resetAliasWarnings();
  const cfg = { chats: { '12345': { pm: 'channels' } } };
  assert.equal(pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: () => {} } }), 'cli');
});

test('pickBackend resolves channels alias → cli via topicConfig.pm overriding chat', () => {
  factory._resetAliasWarnings();
  const cfg = {
    chats: {
      '12345': {
        pm: 'sdk',
        topics: { '7': { pm: 'channels' } },
      },
    },
  };
  assert.equal(pickBackend({ config: cfg, chatId: '12345', threadId: '7', logger: { warn: () => {} } }), 'cli');
});

test('pickBackend resolves channels alias → cli via bot.pm default', () => {
  factory._resetAliasWarnings();
  const cfg = { bot: { pm: 'channels' } };
  assert.equal(pickBackend({ config: cfg, chatId: '99', threadId: null, logger: { warn: () => {} } }), 'cli');
});

test('pickBackend emits once-per-process deprecation warn on channels alias', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '12345': { pm: 'channels' } } };
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  assert.equal(warns.length, 1, 'should warn exactly once for repeated calls');
  assert.match(warns[0], /'channels' is deprecated/);
});

// 0.12 Phase 4.5.3 (R12 mitigation tests). Operators migrating from
// pm:'tmux' to the cli alias without setting permissionMode silently lose
// approval gating. The R12 warning surfaces this as a deliberate trade-off.

test('R12: pm:"tmux" alias WITHOUT permissionMode emits per-chat migration warning', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '12345': { pm: 'tmux' } } };
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  assert.equal(warns.length, 2, 'should emit BOTH deprecation alias warn AND R12 migration warn');
  assert.ok(warns.some(w => /'tmux' is deprecated/.test(w)), 'alias deprecation warn');
  assert.ok(warns.some(w => /R12 migration warning/.test(w)), 'R12 migration warn');
  assert.ok(warns.some(w => /permissionMode/.test(w)), 'R12 warn mentions permissionMode opt-in');
});

test('R12: pm:"tmux" alias WITH permissionMode:"default" suppresses R12 warn', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '12345': { pm: 'tmux', permissionMode: 'default' } } };
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  // Alias deprecation still fires; R12 should NOT.
  assert.ok(warns.some(w => /'tmux' is deprecated/.test(w)));
  assert.ok(!warns.some(w => /R12 migration warning/.test(w)),
    'R12 must not fire when operator explicitly opted into a non-bypass mode');
});

test('R12: pm:"channels" alias (which had no implicit approvals) does NOT fire R12 warn', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '12345': { pm: 'channels' } } };
  pickBackend({ config: cfg, chatId: '12345', threadId: null, logger: { warn: msg => warns.push(msg) } });
  // Channels alias deprecation fires; R12 should NOT — channels backend in 0.11
  // also had bypassPermissions default, so there's no UX regression to warn about.
  assert.ok(warns.some(w => /'channels' is deprecated/.test(w)));
  assert.ok(!warns.some(w => /R12 migration warning/.test(w)));
});

test('R12: warning is per-chat-tuple — different chats each warn once', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const cfg = { chats: { '111': { pm: 'tmux' }, '222': { pm: 'tmux' } } };
  pickBackend({ config: cfg, chatId: '111', threadId: null, logger: { warn: msg => warns.push(msg) } });
  pickBackend({ config: cfg, chatId: '222', threadId: null, logger: { warn: msg => warns.push(msg) } });
  pickBackend({ config: cfg, chatId: '111', threadId: null, logger: { warn: msg => warns.push(msg) } });
  // Alias warn fires once (process-wide). R12 fires once per chat.
  const aliasWarns = warns.filter(w => /'tmux' is deprecated/.test(w));
  const r12Warns = warns.filter(w => /R12 migration warning/.test(w));
  assert.equal(aliasWarns.length, 1, 'alias warn is process-wide-once');
  assert.equal(r12Warns.length, 2, 'R12 warn fires once per (chatId, threadId) tuple');
});

test('factory falls back to sdk when channels wiring incomplete', () => {
  factory._resetAliasWarnings();
  const warns = [];
  const logger = { warn: msg => warns.push(msg) };
  const cfg = { bot: { pm: 'channels' } };

  // Missing toolDispatcher + channelsClaudeBin
  const f = createProcessFactory({
    config: cfg,
    spawnFn: () => ({}),
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    logger,
  });

  const proc = f('sess-1', { chatId: '99' });
  assert.equal(proc.backend, 'sdk', 'falls back to SDK');
  // 0.12: two warns expected — alias deprecation AND wiring-incomplete.
  // No R12 warn (channels alias doesn't trigger R12; that's tmux-only).
  assert.equal(warns.length, 2, 'logged 2 warnings (alias deprecation + wiring-incomplete fallback)');
  assert.ok(warns.some(w => /'channels' is deprecated/.test(w)), 'alias deprecation warn');
  const wiringWarn = warns.find(w => /toolDispatcher/.test(w));
  assert.ok(wiringWarn, 'wiring-incomplete warn');
  assert.match(wiringWarn, /pm:'cli'/);
  assert.match(wiringWarn, /channelsClaudeBin/);

  // cleanup — SdkProcess construction may have spun up internals
  proc.kill?.('test-cleanup').catch(() => {});
});

test('factory constructs CliProcess when fully wired', () => {
  const cfg = { bot: { pm: 'channels' } };
  const factory = createProcessFactory({
    config: cfg,
    spawnFn: () => ({}),
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  const proc = factory('sess-2', { chatId: '99' });
  assert.equal(proc.backend, 'cli');
  assert.equal(proc.cost, 3);
});

// Review AC3: pickBackend warns + falls back on unknown pm value (typo path)
test('pickBackend warns and falls back to sdk on unknown pm value', () => {
  const warns = [];
  const cfg = { bot: { pm: 'channel' } };  // singular typo
  const got = pickBackend({ config: cfg, chatId: '99', threadId: null, logger: { warn: m => warns.push(m) } });
  assert.equal(got, 'sdk');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /unknown pm value 'channel'/);
  assert.match(warns[0], /falling back to 'sdk'/);
});

// Review #11: tmux session name carries the polygram-${botName}- prefix so
// orphan-sweep (lib/tmux/orphan-sweep.js) finds channels sessions at boot.
test('CliProcess.start tmux session name uses polygram- prefix for orphan-sweep', async () => {
  const calls = [];
  const runner = {
    spawn: async opts => { calls.push(opts); },
    killSession: async () => {},
    sendControl: async () => {},
    captureWide: async () => 'Listening for channel messages from: server:polygram-bridge',
  };
  // We need a fake bridge that handshakes so start() resolves. Quickest path:
  // tap into _createSocketServer to discover sockPath, connect a node net
  // client, then send hello+session_init.
  const net = require('node:net');
  const p = new CliProcess({
    sessionKey: 'sess-prefix', chatId: '111', threadId: null, label: 'prefix-test',
    tmuxRunner: runner,
    botName: 'shumorobot',
    claudeBin: '/usr/bin/true',
    toolDispatcher: fakeDispatcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    handshakeTimeoutMs: 2000,
  });
  const startP = p.start();
  // Wait until socket appears
  for (let i = 0; i < 50 && (!p.sockPath || !require('fs').existsSync(p.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  // Connect fake bridge
  const sock = net.connect(p.sockPath);
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'test-sid' }) + '\n');
  // 0.12 Phase 1.6: also synthesize the mcp-ready signal that real bridges
  // emit on first claude ListToolsRequest. Without it, _waitForBridgeHandshake
  // would block until the 5s mcp-ready timeout.
  sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
  await startP;
  assert.equal(calls.length, 1);
  assert.match(calls[0].name, /^polygram-shumorobot-channels-/, `tmux name should start with polygram-<botName>-channels- but got '${calls[0].name}'`);
  sock.end();
  await p.kill('test');
});

// Review #8: respondToPermission idempotent — second call for the same
// request_id is dropped (no second perm_verdict).
test('respondToPermission is idempotent — second call dropped', async () => {
  const warns = [];
  const p = new CliProcess({
    sessionKey: 'sess-idemp', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: m => warns.push(m), error: () => {}, log: () => {} },
  });
  const writes = [];
  p._writeToBridge = (obj) => writes.push(obj);

  await p.respondToPermission('req-abc', 'allow');
  await p.respondToPermission('req-abc', 'deny');     // should be dropped

  assert.equal(writes.length, 1, 'only first verdict written');
  assert.equal(writes[0].behavior, 'allow');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /duplicate for request_id=req-abc/);
});

// P1 #9: socket created with mode 0o600 from inode birth (no TOCTOU window
// between listen() and chmod). Verified by reading the mode AFTER listen but
// BEFORE the explicit chmod has run — which means we observe the umask-derived
// mode. Integration test "start() completes after fake bridge handshakes"
// already asserts `mode = 0o600`; this is a lighter unit test that the umask
// wrap is in place in the (post-M1-refactor) ChannelsBridgeServer.
test('P1 #9: ChannelsBridgeServer wraps listen() in restrictive umask', () => {
  assert.ok(
    require('node:fs').readFileSync(
      require.resolve('../lib/process/channels-bridge-server'), 'utf8',
    ).match(/process\.umask\(0o077\)/),
    'P1 #9: process.umask(0o077) wraps listen() in channels-bridge-server.js',
  );
});

// Parity audit P4 + P7 + P8 — agent / topic-precedence / --resume.

async function captureSpawnArgs(constructorOpts, startOpts) {
  const spawnedArgs = [];
  const runner = {
    spawn: async opts => { spawnedArgs.push(...opts.args); },
    killSession: async () => {},
    sendControl: async () => {},
    captureWide: async () => 'Listening for channel messages from: server:polygram-bridge',
  };
  const fs = require('node:fs');
  const net = require('node:net');
  const p = new CliProcess({
    sessionKey: 'sess-x',
    chatId: '1', threadId: null, label: 'parity-test',
    tmuxRunner: runner, botName: 'b',
    toolDispatcher: fakeDispatcher,
    claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    handshakeTimeoutMs: 2000,
    ...constructorOpts,
  });
  const startP = p.start(startOpts || {});
  for (let i = 0; i < 50 && (!p.sockPath || !fs.existsSync(p.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  const sock = net.connect(p.sockPath);
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'test-sid' }) + '\n');
  // 0.12 Phase 1.6: also synthesize the mcp-ready signal that real bridges
  // emit on first claude ListToolsRequest. Without it, _waitForBridgeHandshake
  // would block until the 5s mcp-ready timeout.
  sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
  await startP;
  sock.end();
  await p.kill('test');
  return spawnedArgs;
}

test('P4 parity: --agent flag passed when chatConfig.agent set', async () => {
  const args = await captureSpawnArgs({}, { chatConfig: { agent: 'music-curation' } });
  const agentIdx = args.indexOf('--agent');
  assert.ok(agentIdx >= 0, 'has --agent flag');
  assert.equal(args[agentIdx + 1], 'music-curation');
});

test('P7 parity: topicConfig.agent overrides chatConfig.agent', async () => {
  const args = await captureSpawnArgs({ threadId: '42' }, {
    threadId: '42',
    chatConfig: {
      agent: 'fallback',
      topics: { '42': { agent: 'topic-special' } },
    },
  });
  const agentIdx = args.indexOf('--agent');
  assert.equal(args[agentIdx + 1], 'topic-special');
});

test('P5 parity: --effort flag passed when set', async () => {
  const args = await captureSpawnArgs({}, { chatConfig: { effort: 'high' } });
  const effortIdx = args.indexOf('--effort');
  assert.ok(effortIdx >= 0);
  assert.equal(args[effortIdx + 1], 'high');
});

// rc.8 ghost-session guard: --resume is only passed when the session
// JSONL actually exists under the launch cwd. If polygram's DB has a
// session id but claude doesn't have the file (because an early channels
// attempt failed before claude completed any turn), drop the ghost and
// use --session-id with a fresh uuid. Live shumorobot Music topic
// 2026-05-26 04:04:29 reproduced this exact ghost-session stall.

test('rc.8: --resume used when existingSessionId set AND session file exists on disk', async () => {
  // Stage a fake session JSONL at the path claude indexes by cwd.
  // resolvedCwd → ~/.claude/projects/<cwd-mangled>/<id>.jsonl
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rc8-resume-'));
  const sid = 'prior-sid-with-file';
  const projectsDir = path.join(os.homedir(), '.claude', 'projects', testCwd.replace(/\//g, '-'));
  fs.mkdirSync(projectsDir, { recursive: true });
  const sidFile = path.join(projectsDir, `${sid}.jsonl`);
  fs.writeFileSync(sidFile, '{"role":"user","content":"hi"}\n');
  try {
    const args = await captureSpawnArgs({}, {
      existingSessionId: sid,
      chatConfig: { cwd: testCwd },
    });
    const resumeIdx = args.indexOf('--resume');
    assert.ok(resumeIdx >= 0, 'has --resume when file exists');
    assert.equal(args[resumeIdx + 1], sid);
    assert.equal(args.indexOf('--session-id'), -1,
      '--session-id NOT present when --resume is in effect');
  } finally {
    fs.rmSync(sidFile, { force: true });
    fs.rmdirSync(projectsDir, { recursive: true });
    fs.rmdirSync(testCwd);
  }
});

test('rc.8: ghost-session guard — DB id with no local file falls back to --session-id', async () => {
  // No fixture file created — simulates the live Music-topic ghost
  // (DB has session id from a failed prior channels attempt; claude
  // never persisted the JSONL).
  const args = await captureSpawnArgs({}, {
    existingSessionId: 'ghost-sid-no-file',
    chatConfig: { cwd: '/tmp/path-that-does-not-have-a-jsonl-fixture' },
  });
  assert.equal(args.indexOf('--resume'), -1,
    'ghost session must NOT be resumed (file does not exist)');
  assert.ok(args.indexOf('--session-id') >= 0,
    'fresh --session-id used when ghost id is dropped');
});

test('rc.8: ghost-session guard fires even with no cwd (can\'t check → don\'t resume)', async () => {
  const args = await captureSpawnArgs({}, { existingSessionId: 'sid-no-cwd' });
  assert.equal(args.indexOf('--resume'), -1,
    'no cwd → can\'t verify file → safer to NOT --resume');
  assert.ok(args.indexOf('--session-id') >= 0);
});

test('P8 parity: --session-id used when NO existingSessionId (fresh session)', async () => {
  const args = await captureSpawnArgs({}, {});
  // For fresh sessions, --session-id is correct (claude generates the id we pass)
  assert.ok(args.indexOf('--session-id') >= 0, 'fresh session uses --session-id');
  assert.equal(args.indexOf('--resume'), -1, 'no --resume on fresh');
});

// rc.7 (2026-05-26): channels-mode spawn carries a SINGLE
// --append-system-prompt block combining the Telegram display rules AND
// the channels-mode reply-tool contract. Originally two separate flags
// (rc.6) — but that broke MCP server registration, suspected
// --append-system-prompt variadic greedy-eating --setting-sources and
// --mcp-config. Merging into one block sidesteps it.
test('rc.7: channels-mode spawn has ONE --append-system-prompt with both display + channels hints', async () => {
  const args = await captureSpawnArgs({}, {});
  const appendIdxs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--append-system-prompt') appendIdxs.push(i);
  }
  assert.equal(appendIdxs.length, 1,
    'EXACTLY ONE --append-system-prompt — multiple instances break --mcp-config arg parsing');
  const hint = args[appendIdxs[0] + 1];
  // Display half (POLYGRAM_DISPLAY_HINT content)
  assert.match(hint, /Telegram display rules|Tables — HARD RULE/i,
    'block contains the polygram display rules');
  // Channels half (reply-tool contract)
  assert.match(hint, /channels mode/i, 'block mentions channels mode');
  assert.match(hint, /mcp__polygram-bridge__reply/, 'mentions the exact tool name');
  assert.match(hint, /HARD CONTRACT|MUST/i, 'reply-tool directive is unambiguous');
  assert.match(hint, /Do NOT respond conversationally|inline text will/i,
    'explicitly tells claude not to respond inline');
  // 2026-06-08 wedge mitigation: AskUserQuestion / interactive menus open a
  // blocking TUI widget the channel can't answer → session parks. The prompt
  // must forbid it (numbered-list-in-reply instead). REMOVE this assertion when
  // the rich question→Telegram-keyboard feature ships (deliberate, not forgotten).
  assert.match(hint, /NEVER use the AskUserQuestion tool/i,
    'forbids the interactive AskUserQuestion widget (wedge mitigation)');
  // 0.12.2 autosteer-fold fix (docs/0.13-autosteer-fold-drop-spec.md): the
  // consumed_turn_ids contract is strengthened to cut the ~8.9% miss rate that
  // produced false `input-fold-suspected` drops. These assertions fail on the
  // pre-0.12.2 prompt (which lacked the every-reply / short / two-id emphasis).
  assert.match(hint, /consumed_turn_ids/, 'states the consumed_turn_ids fold-ack contract');
  assert.match(hint, /EVERY reply|short one-line/i,
    'contract emphasizes it applies to EVERY reply incl short ones (the fold-miss case)');
  assert.match(hint, /both turn_ids/i,
    'contract gives the two-id fold example so a folded follow-up is not omitted');
  // #9 progressive-status restore (docs/0.13-progressive-status-prompt-spec.md):
  // strengthen the long-task responsiveness contract. Review-corrected: edit_message
  // is INTERIM-only; the FINAL answer must be a fresh reply (carries consumed_turn_ids
  // + notifies — an edit does neither, which would re-open the fold-drop bug).
  assert.match(hint, /INTERIM status ONLY|interim status only/i,
    'edit_message is scoped to interim status only');
  assert.match(hint, /FINAL answer as a fresh `?reply/i,
    'the final answer must be a fresh reply (notifies + carries consumed_turn_ids)');
  assert.match(hint, /one or two tool calls, just answer/i,
    'over-trigger guard: quick tasks get one reply, no status bubble');
});

// rc.7: --mcp-config must remain the LAST flag in args (variadic <configs...>)
// to avoid the variadic flag eating subsequent args. Regression guard for
// the bug where two --append-system-prompt flags broke MCP registration.
test('rc.7: --mcp-config is the LAST flag in claudeArgs (variadic safety)', async () => {
  const args = await captureSpawnArgs({}, {});
  const mcpIdx = args.indexOf('--mcp-config');
  assert.ok(mcpIdx >= 0, '--mcp-config present');
  // After the mcp-config value there should be no more flags.
  // Allowed: only the value immediately following.
  for (let i = mcpIdx + 2; i < args.length; i++) {
    assert.ok(!args[i].startsWith('--'),
      `found flag '${args[i]}' AFTER --mcp-config <path>; --mcp-config is variadic and will eat it`);
  }
});

// rc.9 (2026-05-26): channels backend defaults to permissionMode='bypassPermissions'.
// Without it, claude TUI shows the interactive permission prompt for every
// mcp__polygram-bridge__reply call — channels mode has no interactive surface
// to answer it, so every first turn hangs until the 30-min turn timeout. The
// reproducing spike is scripts/spikes/channels-first-turn.mjs.
test('channels backend defaults to bypassPermissions (rc.9: first-turn-dead-zone fix)', async () => {
  const net = require('node:net');
  const fs = require('node:fs');

  // Helper: start with given permissionMode, fake-bridge handshake, capture spawn args, kill.
  async function captureSpawnArgs(permissionMode) {
    const spawnedArgs = [];
    const runner = {
      spawn: async opts => { spawnedArgs.push(...opts.args); },
      killSession: async () => {},
      sendControl: async () => {},
      captureWide: async () => 'Listening for channel messages from: server:polygram-bridge',
    };
    const p = new CliProcess({
      sessionKey: `sess-${permissionMode || 'default'}`,
      chatId: '1', tmuxRunner: runner, botName: 'b',
      toolDispatcher: fakeDispatcher,
      claudeBin: '/usr/bin/echo',
      logger: { warn: () => {}, error: () => {}, log: () => {} },
      handshakeTimeoutMs: 2000,
    });
    const startP = p.start({ permissionMode });
    for (let i = 0; i < 50 && (!p.sockPath || !fs.existsSync(p.sockPath)); i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    const sock = net.connect(p.sockPath);
    await new Promise(r => sock.once('connect', r));
    sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
    sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'test-sid' }) + '\n');
    // 0.12 Phase 1.6: synthesize mcp-ready so _waitForBridgeHandshake doesn't 5s-block.
    sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
    await startP;
    sock.end();
    await p.kill('test');
    return spawnedArgs;
  }

  // rc.9: with NO permissionMode override, the default is bypassPermissions —
  // the only mode that lets a fresh-spawn channels turn actually reply.
  const defaultArgs = await captureSpawnArgs(undefined);
  assert.ok(defaultArgs.includes('--dangerously-skip-permissions'),
    'default channels mode: skip-permissions flag is on (no interactive surface)');
  assert.deepEqual(
    defaultArgs.slice(defaultArgs.indexOf('--permission-mode'), defaultArgs.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'bypassPermissions'],
    'default channels mode: permission-mode=bypassPermissions');

  // Explicit bypassPermissions still works (idempotent with default).
  const bypassArgs = await captureSpawnArgs('bypassPermissions');
  assert.ok(bypassArgs.includes('--dangerously-skip-permissions'),
    'explicit bypassPermissions: skip-permissions flag still present');
  assert.deepEqual(
    bypassArgs.slice(bypassArgs.indexOf('--permission-mode'), bypassArgs.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'bypassPermissions'],
    'explicit bypassPermissions: permission-mode flag carries the value');

  // Explicit non-bypass override is honored — chat owner can opt out of the
  // default if they actually want a different permission mode wired up.
  const acceptEditsArgs = await captureSpawnArgs('acceptEdits');
  assert.ok(!acceptEditsArgs.includes('--dangerously-skip-permissions'),
    'acceptEdits override: skip-permissions NOT added');
  assert.deepEqual(
    acceptEditsArgs.slice(acceptEditsArgs.indexOf('--permission-mode'), acceptEditsArgs.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'acceptEdits'],
    'acceptEdits override: permission-mode carries the override value');
});

// rc.5: launch cwd MUST be the resolved topic/chat cwd, not opts.cwd ||
// process.cwd(). Without this, claude indexes session storage by the
// daemon's own working directory (e.g. ~/.polygram) instead of the
// project root, and `--resume <id>` prints "No conversation found"
// then exits clean — the exact failure mode reproduced on shumorobot
// Music topic at 2026-05-25T22:30 (session 4837f61a-...).
async function captureSpawnOpts(constructorOpts, startOpts) {
  let capturedOpts = null;
  const runner = {
    spawn: async (opts) => { capturedOpts = opts; },
    killSession: async () => {},
    sendControl: async () => {},
    captureWide: async () => 'Listening for channel messages from: server:polygram-bridge',
  };
  const fs = require('node:fs');
  const net = require('node:net');
  const p = new CliProcess({
    sessionKey: 'sess-cwd-test',
    chatId: '1', threadId: null, label: 'cwd-test',
    tmuxRunner: runner, botName: 'b',
    toolDispatcher: fakeDispatcher,
    claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    handshakeTimeoutMs: 2000,
    ...constructorOpts,
  });
  const startP = p.start(startOpts || {});
  for (let i = 0; i < 50 && (!p.sockPath || !fs.existsSync(p.sockPath)); i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  const sock = net.connect(p.sockPath);
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ kind: 'hello', session_key: p.sessionKey, secret: p.sockSecret }) + '\n');
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: 'test-sid' }) + '\n');
  // 0.12 Phase 1.6: also synthesize the mcp-ready signal that real bridges
  // emit on first claude ListToolsRequest. Without it, _waitForBridgeHandshake
  // would block until the 5s mcp-ready timeout.
  sock.write(JSON.stringify({ kind: 'mcp-ready', session: p.sessionKey }) + '\n');
  await startP;
  sock.end();
  await p.kill('test');
  return capturedOpts;
}

test('rc.5: tmuxRunner.spawn cwd honors topicConfig.cwd', async () => {
  const opts = await captureSpawnOpts({}, {
    threadId: '3',
    chatConfig: {
      cwd: '/Users/test/home',
      topics: { '3': { cwd: '/Users/test/Music/rekordbox' } },
    },
  });
  assert.equal(opts.cwd, '/Users/test/Music/rekordbox',
    'spawn cwd must be the topic cwd, not the chat cwd or daemon process.cwd()');
});

test('rc.5: tmuxRunner.spawn cwd honors chatConfig.cwd when no topic', async () => {
  const opts = await captureSpawnOpts({}, {
    chatConfig: { cwd: '/Users/test/home' },
  });
  assert.equal(opts.cwd, '/Users/test/home',
    'spawn cwd falls back to chat cwd when no topic override');
});

test('rc.5: tmuxRunner.spawn cwd falls back to opts.cwd then process.cwd() when no config', async () => {
  const opts = await captureSpawnOpts({}, { cwd: '/tmp/fallback' });
  assert.equal(opts.cwd, '/tmp/fallback',
    'spawn cwd falls back to opts.cwd when no topic/chat config');
});

// Review M2: claudeBin is required (factory enforces this, but the class
// should reject missing claudeBin if env not set too).
test('CliProcess throws when claudeBin missing and env unset', () => {
  const oldEnv = process.env.POLYGRAM_CLAUDE_BIN;
  delete process.env.POLYGRAM_CLAUDE_BIN;
  try {
    assert.throws(
      () => new CliProcess({
        sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
        toolDispatcher: fakeDispatcher,
        logger: { warn: () => {}, error: () => {}, log: () => {} },
      }),
      /claudeBin required/,
    );
  } finally {
    if (oldEnv) process.env.POLYGRAM_CLAUDE_BIN = oldEnv;
  }
});

// ─── 0.12.0 background-work lifecycle: probe + stall-watchdog ────────
//
// P0 (docs/0.12.0-background-work-lifecycle-plan.md) confirmed claude 2.1.158's
// TUI mode line shows a live `· N shell ·` count while a run_in_background Bash
// outlives its turn, clearing in-place on exit. P1 = the probe; P2 = the
// stall-watchdog that re-invokes the agent (read-only) via fireUserMessage —
// NOT injectUserMessage, which no-ops when !inFlight (the idle state here).

function makeBgProc(captureWide) {
  const p = new CliProcess({
    sessionKey: 'k', chatId: '1', threadId: null, label: 'bgtest',
    tmuxRunner: { spawn: async () => {}, killSession: async () => {}, sendControl: async () => {}, captureWide },
    botName: 'b', claudeBin: '/usr/bin/echo', toolDispatcher: fakeDispatcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  p.tmuxSession = 'fake-tmux'; // probeBusyState early-returns without it
  return p;
}

test('P1 probe: detects `· 1 shell ·` background-shell count in the mode line', async () => {
  const pane = ['╭─ Claude Code ─╮', 'output', '❯ ', '  ⏵⏵ auto mode on · 1 shell · ← for agents · ↓ to manage'].join('\n');
  const p = makeBgProc(async () => pane);
  const s = await p.probeBusyState();
  assert.equal(s.backgroundShell, true);
  assert.equal(s.shellCount, 1);
  assert.equal(s.streaming, false);
  assert.equal(s.busy, false, 'busy stays streaming-only — abort path unchanged');
  assert.deepEqual(await p.hasLiveBackgroundWork(), { live: true, count: 1 });
});

test('P1 probe: plural shells parse the count', async () => {
  const p = makeBgProc(async () => '  ⏵⏵ auto mode on · 3 shells · ← for agents · ↓ to manage');
  assert.equal((await p.probeBusyState()).shellCount, 3);
});

test('P1 probe: idle mode line with no shells → no background work', async () => {
  const p = makeBgProc(async () => '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)');
  const s = await p.probeBusyState();
  assert.equal(s.backgroundShell, false);
  assert.equal(s.shellCount, 0);
});

test('P1 probe: streaming hint alone is NOT background work', async () => {
  const p = makeBgProc(async () => '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt');
  const s = await p.probeBusyState();
  assert.equal(s.streaming, true);
  assert.equal(s.backgroundShell, false);
});

test('P1 probe: a `· 1 shell ·` scrolled into history (not the tail) is ignored', async () => {
  const stale = '  ⏵⏵ auto mode on · 1 shell · ← for agents';
  const pane = stale + '\n' + 'x'.repeat(600) + '\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)';
  const p = makeBgProc(async () => pane);
  assert.equal((await p.probeBusyState()).backgroundShell, false, 'viewport-anchored: stale scrollback must not match');
});

// Prod regression (shumorobot Music, 2026-06-04): the live mode line reads
// "⏵⏵ bypass permissions on · 1 shell …", NOT "auto mode on …" — every
// shumorobot session runs bypass-permissions mode, but the P0 spike was captured
// in auto mode, so BACKGROUND_SHELL_RE anchored on "auto mode on" and NEVER
// matched in production (bg-work-status fired zero times ever). The bg-shell
// detector must be mode-INDEPENDENT: the `· N shell ·` count is identical across
// modes; only the mode prefix differs.
test('P1 probe: detects shells in BYPASS-PERMISSIONS mode (the prod default — was a silent miss)', async () => {
  // Verbatim tail captured from the live shumorobot Music pane.
  const pane = [
    "⏺ I'll report back when the background job completes.",
    '✻ Baked for 1m 35s · 1 shell still running',
    '❯ ',
    '  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage',
  ].join('\n');
  const p = makeBgProc(async () => pane);
  const s = await p.probeBusyState();
  assert.equal(s.backgroundShell, true, 'bypass-permissions mode line must detect the bg shell');
  assert.equal(s.shellCount, 1);
  assert.deepEqual(await p.hasLiveBackgroundWork(), { live: true, count: 1 });
});

test('P1 probe: accept-edits mode also detects shells (mode-independent anchor)', async () => {
  const p = makeBgProc(async () => '  ⏵⏵ accept edits on · 2 shells · ← for agents · ↓ to manage');
  assert.equal((await p.probeBusyState()).shellCount, 2);
});

function makeWatchdogProc({ live, count = 1, stallMs = 1000 } = {}) {
  const p = makeBgProc(async () => '');
  p.bridgeReady = true;
  p.bgWorkStallMs = stallMs;
  p._probeState = { live, count };
  p.hasLiveBackgroundWork = async () => p._probeState;
  p._fired = [];
  p.fireUserMessage = (text) => { p._fired.push(text); return true; };
  return p;
}

test('P2 watchdog: live shell while idle → starts the clock, no fire on first tick', async () => {
  const p = makeWatchdogProc({ live: true });
  await p._pollBackgroundWork();
  assert.notEqual(p._bgWorkSince, null, 'clock started');
  assert.equal(p._fired.length, 0, 'no self-check on first observation');
});

test('P2 watchdog: stalled > bgWorkStallMs → exactly one read-only self-check via fireUserMessage', async () => {
  const p = makeWatchdogProc({ live: true, stallMs: 1000 });
  await p._pollBackgroundWork();        // start clock
  p._bgWorkSince = Date.now() - 5000;   // simulate 5s elapsed (> 1s stall)
  await p._pollBackgroundWork();        // should fire
  assert.equal(p._fired.length, 1, 'one self-check fired');
  assert.match(p._fired[0], /background job/i);
  assert.match(p._fired[0], /do NOT start new work|report only/i, 'read-only framing');
  await p._pollBackgroundWork();        // must NOT re-fire
  assert.equal(p._fired.length, 1, 'one self-check per window');
});

test('P2 watchdog: no live shell → no fire, clock + escalations reset', async () => {
  const p = makeWatchdogProc({ live: false, count: 0 });
  p._bgWorkSince = Date.now() - 999999;
  p._bgWorkEscalations = 1;
  await p._pollBackgroundWork();
  assert.equal(p._bgWorkSince, null);
  assert.equal(p._bgWorkEscalations, 0);
  assert.equal(p._fired.length, 0);
});

test('P2 watchdog: skips while a turn is in flight (no fire, clock preserved)', async () => {
  const p = makeWatchdogProc({ live: true });
  p._bgWorkSince = Date.now() - 999999; // would otherwise be stalled
  p.pendingTurns.set('turn-1', {});     // active turn
  await p._pollBackgroundWork();
  assert.equal(p._fired.length, 0, 'no watchdog while a turn is active');
  assert.notEqual(p._bgWorkSince, null, 'clock preserved — same shell still running');
});

test('P2 watchdog: a fresh background-work window gets its own self-check', async () => {
  const p = makeWatchdogProc({ live: true, stallMs: 1000 });
  await p._pollBackgroundWork();
  p._bgWorkSince = Date.now() - 5000;
  await p._pollBackgroundWork();        // fires (window 1)
  assert.equal(p._fired.length, 1);
  p._probeState = { live: false, count: 0 };
  await p._pollBackgroundWork();        // work clears → reset
  assert.equal(p._bgWorkSince, null);
  p._probeState = { live: true, count: 1 };
  await p._pollBackgroundWork();        // window 2: start clock
  p._bgWorkSince = Date.now() - 5000;
  await p._pollBackgroundWork();        // window 2: fires again
  assert.equal(p._fired.length, 2, 'fresh window → fresh self-check');
});

test('P4 visibility: emits bg-work-status running on first detection, cleared on clear', async () => {
  const p = makeWatchdogProc({ live: true });
  const events = [];
  p.on('bg-work-status', (e) => events.push(e));
  await p._pollBackgroundWork();                 // first detection → running
  assert.equal(p._bgWorkStatusShown, true);
  assert.deepEqual(events, [{ state: 'running', count: 1 }]);
  p._probeState = { live: false, count: 0 };
  await p._pollBackgroundWork();                 // work clears → cleared
  assert.equal(p._bgWorkStatusShown, false);
  assert.deepEqual(events, [{ state: 'running', count: 1 }, { state: 'cleared' }]);
});

test('P4 visibility: exactly one running emit while work stays live', async () => {
  const p = makeWatchdogProc({ live: true });
  const events = [];
  p.on('bg-work-status', (e) => events.push(e));
  await p._pollBackgroundWork();
  await p._pollBackgroundWork();
  await p._pollBackgroundWork();
  assert.equal(events.filter((e) => e.state === 'running').length, 1, 'one running emit per window');
});

// 0.12.0 LRU eviction-pin: the sync pin signal _evictLRU reads to skip a session with a live
// detached background job. Mirrors _bgWorkSince exactly — NO time cap (a long job stays pinned).
test('eviction-pin: hasActiveBackgroundWork() mirrors _bgWorkSince (no expiry)', () => {
  const p = new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b', toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/false' });
  assert.equal(p._bgWorkSince, null, 'starts with no background work');
  assert.equal(p.hasActiveBackgroundWork(), false, 'null → false');
  p._bgWorkSince = Date.now();
  assert.equal(p.hasActiveBackgroundWork(), true, 'set → true');
  p._bgWorkSince = Date.now() - 60 * 60 * 1000;   // an hour ago
  assert.equal(p.hasActiveBackgroundWork(), true, 'a long-running job still pins — no time cap');
  p._bgWorkSince = null;
  assert.equal(p.hasActiveBackgroundWork(), false, 'cleared → false');
});

// 0.12.0 question-progress-resume: when a blocking `ask` resolves with a REAL answer, the turn
// resumes working but the reactor cleared during the wait and no hooks re-light it. emit
// 'question-resumed' so polygram re-arms the reactor (prod: hire topic — "no progress after submit").
test('writeQuestionAnswer emits question-resumed on a real answer (re-light progress)', () => {
  const p = new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b', toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/false' });
  p._writeToBridge = () => true;   // isolate from the bridge transport
  p._openQuestions.add('tc1');
  let resumed = 0;
  p.on('question-resumed', () => resumed++);
  p.writeQuestionAnswer('tc1', { answers: [{ header: 'X', selected: ['a'] }] });
  assert.equal(resumed, 1, 'real answer + no open questions left → emits question-resumed');
});

test('writeQuestionAnswer does NOT emit question-resumed on cancelled/timeout (turn is ending)', () => {
  const p = new CliProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b', toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/false' });
  p._writeToBridge = () => true;
  let resumed = 0;
  p.on('question-resumed', () => resumed++);
  p._openQuestions.add('tc1'); p.writeQuestionAnswer('tc1', { cancelled: true });
  p._openQuestions.add('tc2'); p.writeQuestionAnswer('tc2', { timedout: true });
  assert.equal(resumed, 0, 'terminal results end the turn — no re-arm');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ChannelsProcess } = require('../lib/process/channels-process');
const { createProcessFactory, pickBackend } = require('../lib/process/factory');

// Minimal fakes so we can construct without touching tmux / claude.
// Method shape matches lib/tmux/tmux-runner.js exports.
const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => 'Listening for channel messages from: server:polygram-bridge',
};
const fakeDispatcher = async () => ({ ok: true });

test('ChannelsProcess construction — required params', () => {
  assert.throws(
    () => new ChannelsProcess({}),
    /sessionKey/,
    'sessionKey required',
  );

  assert.throws(
    () => new ChannelsProcess({ sessionKey: 'k', botName: 'b', toolDispatcher: fakeDispatcher }),
    /tmuxRunner required/,
  );

  assert.throws(
    () => new ChannelsProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, toolDispatcher: fakeDispatcher }),
    /botName required/,
  );

  assert.throws(
    () => new ChannelsProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b' }),
    /toolDispatcher.*required/,
  );
});

test('ChannelsProcess construction — valid params', () => {
  const p = new ChannelsProcess({
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
  assert.equal(p.backend, 'channels');
  assert.equal(p.cost, 3);
  assert.equal(p.closed, false);
  assert.equal(p.inFlight, false);
  assert.equal(p.bridgeReady, false);
});

test('ChannelsProcess.respondToPermission validates behavior arg', async () => {
  const p = new ChannelsProcess({
    sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => p.respondToPermission('abcde', 'maybe'),
    /'allow' or 'deny'/,
  );
});

test('ChannelsProcess.send rejects on unstarted instance', async () => {
  const p = new ChannelsProcess({
    sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => p.send('hello'),
    /bridge not ready/,
  );
});

test('pickBackend honors channels via chatConfig.pm', () => {
  const cfg = { chats: { '12345': { pm: 'channels' } } };
  assert.equal(pickBackend({ config: cfg, chatId: '12345', threadId: null }), 'channels');
});

test('pickBackend honors channels via topicConfig.pm overriding chat', () => {
  const cfg = {
    chats: {
      '12345': {
        pm: 'sdk',
        topics: { '7': { pm: 'channels' } },
      },
    },
  };
  assert.equal(pickBackend({ config: cfg, chatId: '12345', threadId: '7' }), 'channels');
});

test('pickBackend honors channels via bot.pm default', () => {
  const cfg = { bot: { pm: 'channels' } };
  assert.equal(pickBackend({ config: cfg, chatId: '99', threadId: null }), 'channels');
});

test('factory falls back to sdk when channels wiring incomplete', () => {
  const warns = [];
  const logger = { warn: msg => warns.push(msg) };
  const cfg = { bot: { pm: 'channels' } };

  // Missing toolDispatcher + channelsClaudeBin
  const factory = createProcessFactory({
    config: cfg,
    spawnFn: () => ({}),
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    logger,
  });

  const proc = factory('sess-1', { chatId: '99' });
  assert.equal(proc.backend, 'sdk', 'falls back to SDK');
  assert.equal(warns.length, 1, 'logged a warning');
  assert.match(warns[0], /channels/);
  assert.match(warns[0], /toolDispatcher/);
  assert.match(warns[0], /channelsClaudeBin/);

  // cleanup — SdkProcess construction may have spun up internals
  proc.kill?.('test-cleanup').catch(() => {});
});

test('factory constructs ChannelsProcess when fully wired', () => {
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
  assert.equal(proc.backend, 'channels');
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
test('ChannelsProcess.start tmux session name uses polygram- prefix for orphan-sweep', async () => {
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
  const p = new ChannelsProcess({
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
  const p = new ChannelsProcess({
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
  const p = new ChannelsProcess({
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

test('P8 parity: --resume used when existingSessionId set (NOT --session-id)', async () => {
  const args = await captureSpawnArgs({}, { existingSessionId: 'prior-sid-from-db' });
  // --resume should be present with the prior session id
  const resumeIdx = args.indexOf('--resume');
  assert.ok(resumeIdx >= 0, 'has --resume for existing session');
  assert.equal(args[resumeIdx + 1], 'prior-sid-from-db');
  // --session-id MUST NOT be present (would create a new session, defeating resume)
  assert.equal(args.indexOf('--session-id'), -1,
    '--session-id NOT present when resuming (would create new session, losing history)');
});

test('P8 parity: --session-id used when NO existingSessionId (fresh session)', async () => {
  const args = await captureSpawnArgs({}, {});
  // For fresh sessions, --session-id is correct (claude generates the id we pass)
  assert.ok(args.indexOf('--session-id') >= 0, 'fresh session uses --session-id');
  assert.equal(args.indexOf('--resume'), -1, 'no --resume on fresh');
});

// permissionMode passthrough — mirror of TmuxProcess pattern. Default mode
// does NOT add --dangerously-skip-permissions; bypassPermissions DOES.
test('claudeArgs include --dangerously-skip-permissions only when permissionMode=bypassPermissions', async () => {
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
    const p = new ChannelsProcess({
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
    await startP;
    sock.end();
    await p.kill('test');
    return spawnedArgs;
  }

  const defaultArgs = await captureSpawnArgs(undefined);
  assert.ok(!defaultArgs.includes('--dangerously-skip-permissions'),
    'default mode: no skip-permissions');
  assert.ok(!defaultArgs.includes('--permission-mode'),
    'default mode: no permission-mode flag');

  const bypassArgs = await captureSpawnArgs('bypassPermissions');
  assert.ok(bypassArgs.includes('--dangerously-skip-permissions'),
    'bypassPermissions: skip-permissions flag added');
  assert.deepEqual(
    bypassArgs.slice(bypassArgs.indexOf('--permission-mode'), bypassArgs.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'bypassPermissions'],
    'bypassPermissions: permission-mode flag carries the value',
  );
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
  const p = new ChannelsProcess({
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
test('ChannelsProcess throws when claudeBin missing and env unset', () => {
  const oldEnv = process.env.POLYGRAM_CLAUDE_BIN;
  delete process.env.POLYGRAM_CLAUDE_BIN;
  try {
    assert.throws(
      () => new ChannelsProcess({
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

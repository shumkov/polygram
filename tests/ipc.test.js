/**
 * Tests for lib/ipc-server.js + lib/ipc-client.js
 * Run: node --test tests/ipc.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ipcServer = require('../lib/ipc/server');
const ipcClient = require('../lib/ipc/client');
const { createIpcHandlers } = require('../lib/ipc/handlers');
const {
  requireRestartRequestId,
} = require('../lib/ipc/restart-request-id');

const silentLogger = { log: () => {}, error: () => {} };

let server;
let sockPath;

function uniquePath() {
  return path.join(os.tmpdir(), `ipc-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

function workspaceFixture() {
  return fs.mkdtempSync(path.join(process.cwd(), '.ipc-runtime-test-'));
}

function removeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function startServer(handlers) {
  sockPath = uniquePath();
  server = await ipcServer.start({ path: sockPath, handlers, logger: silentLogger });
}

async function startServerWithSecret(handlers, secret) {
  sockPath = uniquePath();
  server = await ipcServer.start({
    path: sockPath,
    handlers,
    secret,
    logger: silentLogger,
  });
}

async function stopServer() {
  if (server) await server.close();
  server = null;
}

describe('ipc round-trip', () => {
  afterEach(stopServer);

  test('echo op returns echoed payload', async () => {
    await startServer({
      echo: async (req) => ({ seen: req.payload }),
    });
    const res = await ipcClient.call({
      path: sockPath, op: 'echo', payload: { payload: 'hi' },
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.seen, 'hi');
  });

  // The deploy pre-flight asks a running daemon what it would interrupt. These
  // drive the PRODUCTION handler set, not a hand-built map — otherwise they
  // prove the transport works and nothing about which ops a daemon answers, and
  // would keep passing if `busy` were dropped from the wiring.
  test('busy op reports in-flight work over the wire', async () => {
    const inFlight = new Map([['-1003369922517:37', 2], ['451328391', 0]]);
    await startServer(createIpcHandlers({
      botName: 'shumabit',
      getInFlightHandlers: () => inFlight,
      handleSendOverIpc: async () => ({}),
    }));
    const res = await ipcClient.call({ path: sockPath, op: 'busy' });
    assert.equal(res.ok, true);
    assert.equal(res.bot, 'shumabit');
    assert.equal(res.in_flight, 2);
    assert.deepEqual(res.sessions, [{ session_key: '-1003369922517:37', in_flight: 2 }]);
  });

  test('busy op on an idle daemon is a clear go-ahead', async () => {
    await startServer(createIpcHandlers({
      botName: 'umi-assistant',
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
    }));
    const res = await ipcClient.call({ path: sockPath, op: 'busy' });
    assert.equal(res.ok, true);
    assert.equal(res.in_flight, 0);
    assert.deepEqual(res.sessions, []);
  });

  // The dispatcher's map is assigned during boot and replaced on reload. Binding
  // it at wiring time would freeze the answer at whatever it was when the IPC
  // server started — reporting an idle daemon forever, which is the worst
  // possible lie for a pre-flight check.
  test('busy op reads in-flight state at call time, not at wiring time', async () => {
    let inFlight = null;
    await startServer(createIpcHandlers({
      botName: 'shumabit',
      getInFlightHandlers: () => inFlight,
      handleSendOverIpc: async () => ({}),
    }));
    const before = await ipcClient.call({ path: sockPath, op: 'busy' });
    assert.equal(before.in_flight, 0);

    inFlight = new Map([['-100:5', 3]]);
    const after = await ipcClient.call({ path: sockPath, op: 'busy' });
    assert.equal(after.in_flight, 3);
  });

  test('the production handler set still answers ping', async () => {
    await startServer(createIpcHandlers({
      botName: 'shumabit',
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
    }));
    const res = await ipcClient.call({ path: sockPath, op: 'ping' });
    assert.equal(res.ok, true);
    assert.equal(res.pong, true);
    assert.equal(res.bot, 'shumabit');
  });

  test('identity op returns only content-free daemon readiness fields', async () => {
    const daemonIdentity = Object.freeze({
      pid: 4242,
      daemon_instance_id: 'e565dbae-44cf-4fc0-b7df-91ee3305e588',
      package_version: '0.38.1',
      main_realpath_sha256: 'a'.repeat(64),
    });
    await startServer(createIpcHandlers({
      botName: 'shumabit',
      daemonIdentity,
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
    }));

    const res = await ipcClient.call({ path: sockPath, op: 'identity' });

    assert.deepEqual(res, {
      id: null,
      ok: true,
      bot: 'shumabit',
      ...daemonIdentity,
    });
    assert.deepEqual(
      Object.keys(res).sort(),
      [
        'bot',
        'daemon_instance_id',
        'id',
        'main_realpath_sha256',
        'ok',
        'package_version',
        'pid',
      ],
    );
  });

  test('deploy restart op directly invokes the daemon restart request', async () => {
    const calls = [];
    await startServer(createIpcHandlers({
      botName: 'shumabit',
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
      requestDeployRestart: (req) => {
        calls.push({ op: req.op, id: req.id });
        return { accepted: true, old_pid: 4242 };
      },
    }));

    const res = await ipcClient.call({
      path: sockPath,
      op: 'deploy_restart',
      id: 'restart-request-42',
    });

    assert.deepEqual(calls, [{
      op: 'deploy_restart',
      id: 'restart-request-42',
    }]);
    assert.deepEqual(res, {
      id: 'restart-request-42',
      ok: true,
      accepted: true,
      old_pid: 4242,
    });
  });

  test('foreground canary target op directly invokes the daemon target authorizer', async () => {
    const calls = [];
    await startServerWithSecret(createIpcHandlers({
      botName: 'shumorobot',
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
      requestForegroundCanaryTarget: (req) => {
        calls.push(req);
        return {
          outcome: 'rejected',
          rejection_code: 'daemon-busy',
        };
      },
    }), 'secret');

    const request = {
      path: sockPath,
      op: 'foreground_canary_target',
      id: 'restart-request-42',
      secret: 'secret',
      payload: {
        provider: 'claude',
        configured_scope_sha256: 'a'.repeat(64),
      },
    };
    const response = await ipcClient.call(request);

    assert.deepEqual(calls, [{
      op: request.op,
      id: request.id,
      secret: request.secret,
      provider: request.payload.provider,
      configured_scope_sha256: request.payload.configured_scope_sha256,
    }]);
    assert.deepEqual(response, {
      id: 'restart-request-42',
      ok: true,
      outcome: 'rejected',
      rejection_code: 'daemon-busy',
    });
  });

  test('clean restart qualification is authenticated, selector-free, and content-free', async () => {
    const calls = [];
    const daemonIdentity = Object.freeze({
      pid: 4242,
      daemon_instance_id: 'instance-qualification-42',
      package_version: '0.38.1',
      main_realpath_sha256: 'a'.repeat(64),
    });
    await startServerWithSecret(createIpcHandlers({
      botName: 'shumorobot',
      daemonIdentity,
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
      inspectCleanRestartQualification: async (...args) => {
        calls.push(args);
        return {
          outcome: 'qualified',
          reason: 'eligible',
          generationDigest: 'b'.repeat(64),
          activityEpoch: 7,
          processState: 'Idle',
          activeTurnCount: 0,
          pendingDeliveryCount: 0,
          backgroundOwnerCount: 0,
          backgroundTerminalCount: 0,
          backgroundTerminalRegistryComplete: true,
          observedAtMs: 1_786_000_000_000,
        };
      },
    }), 's3cret');

    const unauthenticated = await ipcClient.call({
      path: sockPath,
      op: 'clean_restart_qualification',
    });
    assert.deepEqual(
      { ok: unauthenticated.ok, error: unauthenticated.error },
      { ok: false, error: 'auth' },
    );

    const response = await ipcClient.call({
      path: sockPath,
      op: 'clean_restart_qualification',
      secret: 's3cret',
    });
    assert.deepEqual(calls, [[]]);
    assert.deepEqual(response, {
      id: null,
      ok: true,
      bot: 'shumorobot',
      daemon_instance_id: 'instance-qualification-42',
      package_version: '0.38.1',
      observed_at_ms: 1_786_000_000_000,
      generation_digest: 'b'.repeat(64),
      activity_epoch: 7,
      process_state: 'Idle',
      active_turn_count: 0,
      pending_delivery_count: 0,
      background_owner_count: 0,
      background_terminal_count: 0,
      background_terminal_registry_complete: true,
      outcome_code: 'eligible',
    });
    assert.doesNotMatch(JSON.stringify(response), /session|thread|provider|body|message/i);
  });

  test('clean restart qualification rejects every selector or unknown payload field', async () => {
    let calls = 0;
    await startServer(createIpcHandlers({
      botName: 'shumorobot',
      daemonIdentity: {
        daemon_instance_id: 'instance-qualification-42',
        package_version: '0.38.1',
      },
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
      inspectCleanRestartQualification: async () => {
        calls += 1;
        return {};
      },
    }));

    for (const payload of [
      { session_key: '100:3' },
      { provider_session_id: 'thread-secret' },
      { selector: {} },
      { unexpected: true },
    ]) {
      const response = await ipcClient.call({
        path: sockPath,
        op: 'clean_restart_qualification',
        payload,
      });
      assert.equal(response.ok, false);
      assert.match(response.error, /unknown fields/);
    }
    assert.equal(calls, 0);
  });

  test('clean restart qualification bounds inspector failure without leaking its error', async () => {
    await startServer(createIpcHandlers({
      botName: 'shumorobot',
      daemonIdentity: {
        daemon_instance_id: 'instance-qualification-42',
        package_version: '0.38.1',
      },
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
      inspectCleanRestartQualification: async () => {
        throw new Error('provider thread secret must not cross IPC');
      },
    }));

    const response = await ipcClient.call({
      path: sockPath,
      op: 'clean_restart_qualification',
    });
    assert.deepEqual(Object.keys(response), [
      'id',
      'ok',
      'bot',
      'daemon_instance_id',
      'package_version',
      'observed_at_ms',
      'generation_digest',
      'activity_epoch',
      'process_state',
      'active_turn_count',
      'pending_delivery_count',
      'background_owner_count',
      'background_terminal_count',
      'background_terminal_registry_complete',
      'outcome_code',
    ]);
    assert.deepEqual(
      { ...response, observed_at_ms: 0 },
      {
        id: null,
        ok: true,
        bot: 'shumorobot',
        daemon_instance_id: 'instance-qualification-42',
        package_version: '0.38.1',
        observed_at_ms: 0,
        generation_digest: null,
        activity_epoch: null,
        process_state: 'unknown',
        active_turn_count: 0,
        pending_delivery_count: 0,
        background_owner_count: 0,
        background_terminal_count: 0,
        background_terminal_registry_complete: false,
        outcome_code: 'inspection-failed',
      },
    );
    assert.equal(Number.isSafeInteger(response.observed_at_ms), true);
    assert.doesNotMatch(JSON.stringify(response), /provider|thread|secret|error/i);
  });

  test('id is echoed back in reply', async () => {
    await startServer({ noop: async () => ({}) });
    const res = await ipcClient.call({
      path: sockPath, op: 'noop', id: 'call-42',
    });
    assert.equal(res.id, 'call-42');
  });

  test('unknown op yields ok=false with error', async () => {
    await startServer({ known: async () => ({}) });
    const res = await ipcClient.call({ path: sockPath, op: 'mystery' });
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown op/);
  });

  test('handler throw surfaces as ok=false', async () => {
    await startServer({
      kaboom: async () => { throw new Error('bang'); },
    });
    const res = await ipcClient.call({ path: sockPath, op: 'kaboom' });
    assert.equal(res.ok, false);
    assert.match(res.error, /bang/);
  });

  test('multiple concurrent calls are handled independently', async () => {
    await startServer({
      echo: async (req) => ({ n: req.n }),
    });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        ipcClient.call({ path: sockPath, op: 'echo', payload: { n } }),
      ),
    );
    assert.deepEqual(results.map(r => r.n).sort(), [1, 2, 3, 4, 5]);
  });

  test('connect timeout on missing socket', async () => {
    await assert.rejects(
      () => ipcClient.call({
        path: '/tmp/definitely-not-a-socket-' + Date.now() + '.sock',
        op: 'x',
        connectTimeoutMs: 200,
        callTimeoutMs: 500,
      }),
      /ENOENT|connect|timeout/i,
    );
  });

  test('call timeout when handler never replies', async () => {
    await startServer({
      stall: () => new Promise(() => {}),  // never resolves
    });
    await assert.rejects(
      () => ipcClient.call({
        path: sockPath, op: 'stall',
        connectTimeoutMs: 500,
        callTimeoutMs: 200,
      }),
      /call timeout/,
    );
  });
});

describe('deploy restart request IDs', () => {
  test('accepts a bounded opaque correlation ID', () => {
    const value = 'r'.repeat(128);
    assert.equal(requireRestartRequestId(value), value);
  });

  test('rejects missing, oversized, control-bearing, and non-string IDs', () => {
    for (const value of [undefined, '', 'r'.repeat(129), 'bad\nvalue', 42]) {
      assert.throws(
        () => requireRestartRequestId(value),
        (error) => error?.code === 'INVALID_DEPLOY_RESTART_REQUEST_ID',
      );
    }
  });
});

describe('IPC runtime directory', () => {
  test('client and server derive matching non-temporary default paths', () => {
    const expectedDir = path.join(process.cwd(), '.ipc');
    assert.equal(ipcServer.runtimeDirectory(), expectedDir);
    assert.equal(ipcClient.runtimeDirectory(), expectedDir);
    assert.equal(
      ipcServer.socketPathFor('shumabit'),
      path.join(expectedDir, 'polygram-shumabit.sock'),
    );
    assert.equal(
      ipcClient.socketPathFor('shumabit'),
      path.join(expectedDir, 'polygram-shumabit.sock'),
    );
    assert.equal(
      ipcServer.secretPathFor('shumabit'),
      path.join(expectedDir, 'polygram-shumabit.secret'),
    );
    assert.equal(
      ipcClient.secretPathFor('shumabit'),
      path.join(expectedDir, 'polygram-shumabit.secret'),
    );
  });

  test('creates the runtime directory owner-only and writes secrets 0600', () => {
    const cwd = workspaceFixture();
    try {
      const options = { cwd, env: {} };
      const runtimeDir = ipcServer.ensureRuntimeDirectory(options);
      assert.equal(runtimeDir, path.join(cwd, '.ipc'));
      assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700);
      if (typeof process.getuid === 'function') {
        assert.equal(fs.statSync(runtimeDir).uid, process.getuid());
      }

      const secret = ipcServer.writeSecret('test-bot', options);
      assert.ok(secret.length >= 32);
      const secretPath = ipcServer.secretPathFor('test-bot', options);
      assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);

      fs.chmodSync(secretPath, 0o644);
      ipcServer.writeSecret('test-bot', options);
      assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
    } finally {
      removeFixture(cwd);
    }
  });

  test('accepts one canonical absolute owner-only override in both modules', () => {
    const cwd = workspaceFixture();
    const runtimeDir = path.join(cwd, 'ipc');
    fs.mkdirSync(runtimeDir, { mode: 0o700 });
    try {
      const options = { cwd, env: { POLYGRAM_IPC_DIR: runtimeDir } };
      assert.equal(ipcServer.runtimeDirectory(options), runtimeDir);
      assert.equal(ipcClient.runtimeDirectory(options), runtimeDir);
      assert.equal(
        ipcServer.secretPathFor('bot', options),
        ipcClient.secretPathFor('bot', options),
      );
    } finally {
      removeFixture(cwd);
    }
  });

  test('rejects relative and non-canonical IPC directory overrides', () => {
    const cwd = workspaceFixture();
    try {
      assert.throws(
        () => ipcServer.runtimeDirectory({
          cwd,
          env: { POLYGRAM_IPC_DIR: 'relative/ipc' },
        }),
        /IPC directory.*absolute/i,
      );
      assert.throws(
        () => ipcServer.runtimeDirectory({
          cwd,
          env: { POLYGRAM_IPC_DIR: `${cwd}${path.sep}child${path.sep}..` },
        }),
        /IPC directory.*canonical/i,
      );
    } finally {
      removeFixture(cwd);
    }
  });

  test('rejects temporary locations for defaults and overrides', () => {
    assert.throws(
      () => ipcServer.runtimeDirectory({ cwd: os.tmpdir(), env: {} }),
      /IPC directory.*temporary/i,
    );
    assert.throws(
      () => ipcClient.runtimeDirectory({
        cwd: process.cwd(),
        env: { POLYGRAM_IPC_DIR: path.join(os.tmpdir(), 'polygram-ipc') },
      }),
      /IPC directory.*temporary/i,
    );
  });

  test('rejects symlink runtime directories and non-0700 directories', () => {
    const cwd = workspaceFixture();
    const target = path.join(cwd, 'target');
    const link = path.join(cwd, 'link');
    const broad = path.join(cwd, 'broad');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link);
    fs.mkdirSync(broad, { mode: 0o755 });
    try {
      assert.throws(
        () => ipcServer.runtimeDirectory({
          cwd,
          env: { POLYGRAM_IPC_DIR: link },
        }),
        /IPC directory.*symlink|IPC directory.*canonical/i,
      );
      assert.throws(
        () => ipcServer.runtimeDirectory({
          cwd,
          env: { POLYGRAM_IPC_DIR: broad },
        }),
        /IPC directory.*0700/i,
      );
    } finally {
      removeFixture(cwd);
    }
  });

  test('rejects a runtime directory inside a writable untrusted parent', () => {
    const cwd = workspaceFixture();
    const unsafeParent = path.join(cwd, 'unsafe-parent');
    const runtimeDir = path.join(unsafeParent, 'ipc');
    fs.mkdirSync(unsafeParent, { mode: 0o777 });
    fs.chmodSync(unsafeParent, 0o777);
    fs.mkdirSync(runtimeDir, { mode: 0o700 });
    try {
      assert.throws(
        () => ipcServer.runtimeDirectory({
          cwd,
          env: { POLYGRAM_IPC_DIR: runtimeDir },
        }),
        /IPC directory parent.*writable/i,
      );
    } finally {
      removeFixture(cwd);
    }
  });

  test('rejects bot names that could escape or reshape the runtime path', () => {
    for (const botName of [
      '',
      '.',
      '..',
      '../other',
      'nested/bot',
      'nested\\bot',
      'x'.repeat(65),
    ]) {
      assert.throws(
        () => ipcServer.socketPathFor(botName),
        /bot name/i,
      );
      assert.throws(
        () => ipcClient.secretPathFor(botName),
        /bot name/i,
      );
    }
  });

  test('rejects socket paths above the portable Unix-domain limit', () => {
    const cwd = workspaceFixture();
    const longParent = path.join(cwd, 'x'.repeat(80));
    const runtimeDir = path.join(longParent, 'ipc');
    fs.mkdirSync(longParent, { mode: 0o700 });
    fs.mkdirSync(runtimeDir, { mode: 0o700 });
    try {
      assert.throws(
        () => ipcServer.socketPathFor('bot', {
          cwd,
          env: { POLYGRAM_IPC_DIR: runtimeDir },
        }),
        /socket path.*limit/i,
      );
    } finally {
      removeFixture(cwd);
    }
  });
});

describe('tell()', () => {
  afterEach(stopServer);

  test('wraps raw call: payload becomes { method, params, source }', async () => {
    let received;
    await startServer({
      send: async (req) => {
        received = req;
        return { result: { message_id: 999 } };
      },
    });
    const out = await ipcClient.tell('dummy', 'sendMessage', { chat_id: '1', text: 'hi' }, {
      path: sockPath, source: 'cron:test',
    });
    assert.deepEqual(received.method, 'sendMessage');
    assert.deepEqual(received.params, { chat_id: '1', text: 'hi' });
    assert.equal(received.source, 'cron:test');
    assert.equal(out.message_id, 999);
  });

  test('throws on server-side failure', async () => {
    await startServer({
      send: async () => { throw new Error('not allowed'); },
    });
    await assert.rejects(
      () => ipcClient.tell('dummy', 'sendMessage', {}, { path: sockPath }),
      /not allowed/,
    );
  });

  test('auto-derives source from argv', async () => {
    let received;
    await startServer({
      send: async (req) => { received = req; return { result: {} }; },
    });
    await ipcClient.tell('dummy', 'sendMessage', {}, { path: sockPath });
    assert.match(received.source, /^cron:/);
  });
});

// 0.9.0-cleanup commit 12: pin the IPC auth path. Pre-cleanup,
// tests/approvals-integration.test.js was the only test that
// exercised `ipcServer.start({secret})` end-to-end. Deleting it
// (commit 7) left the timingSafeEqual branch in lib/ipc-server.js
// uncovered — a future refactor could disable auth without breaking
// any test. These three tests close that gap.
describe('ipc auth (rc.69)', () => {
  afterEach(stopServer);

  async function startWithSecret(handlers, secret) {
    sockPath = uniquePath();
    server = await ipcServer.start({
      path: sockPath, secret, handlers, logger: silentLogger,
    });
  }

  test('rejects requests with no secret when server requires one', async () => {
    await startWithSecret({
      send: async () => ({ result: {} }),
    }, 's3cret');
    const res = await ipcClient.call({ path: sockPath, op: 'send', payload: {} });
    assert.equal(res.ok, false, 'no-secret request should NOT succeed');
    assert.equal(res.error, 'auth');
  });

  test('rejects requests with wrong secret', async () => {
    await startWithSecret({
      send: async () => ({ result: {} }),
    }, 's3cret');
    const res = await ipcClient.call({
      path: sockPath, op: 'send', payload: {}, secret: 'wrong',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'auth');
  });

  test('ping is exempt from auth (so health checks work without the secret)', async () => {
    await startWithSecret({
      ping: async () => ({ pong: true }),
    }, 's3cret');
    const res = await ipcClient.call({ path: sockPath, op: 'ping' });
    assert.equal(res.ok, true,
      'ping should bypass auth — used for liveness checks by polygram-doctor');
    assert.equal(res.pong, true);
  });

  test('correct secret authenticates', async () => {
    await startWithSecret({
      send: async () => ({ result: { ok: 1 } }),
    }, 's3cret');
    const res = await ipcClient.call({
      path: sockPath, op: 'send', payload: {}, secret: 's3cret',
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.result, { ok: 1 });
  });

  test('daemon identity requires the current secret while ping stays public', async () => {
    const daemonIdentity = Object.freeze({
      pid: 4242,
      daemon_instance_id: 'e565dbae-44cf-4fc0-b7df-91ee3305e588',
      package_version: '0.38.1',
      main_realpath_sha256: 'a'.repeat(64),
    });
    await startWithSecret(createIpcHandlers({
      botName: 'shumabit',
      daemonIdentity,
      getInFlightHandlers: () => new Map(),
      handleSendOverIpc: async () => ({}),
    }), 's3cret');

    const missing = await ipcClient.call({ path: sockPath, op: 'identity' });
    const bad = await ipcClient.call({
      path: sockPath,
      op: 'identity',
      secret: 'wrong',
    });
    const ping = await ipcClient.call({ path: sockPath, op: 'ping' });
    const identity = await ipcClient.call({
      path: sockPath,
      op: 'identity',
      secret: 's3cret',
    });

    assert.deepEqual({ ok: missing.ok, error: missing.error }, { ok: false, error: 'auth' });
    assert.deepEqual({ ok: bad.ok, error: bad.error }, { ok: false, error: 'auth' });
    assert.deepEqual(
      { ok: ping.ok, pong: ping.pong, bot: ping.bot },
      { ok: true, pong: true, bot: 'shumabit' },
    );
    assert.deepEqual(identity, {
      id: null,
      ok: true,
      bot: 'shumabit',
      ...daemonIdentity,
    });
  });
});

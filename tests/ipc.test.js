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
});

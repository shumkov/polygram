/**
 * Tests for lib/ipc-server.js + lib/ipc-client.js
 * Run: node --test tests/ipc.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const ipcServer = require('../lib/ipc-server');
const ipcClient = require('../lib/ipc-client');

const silentLogger = { log: () => {}, error: () => {} };

let server;
let sockPath;

function uniquePath() {
  return path.join(os.tmpdir(), `ipc-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`);
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

describe('socketPathFor', () => {
  test('matches between client and server', () => {
    assert.equal(ipcServer.socketPathFor('shumabit'), '/tmp/polygram-shumabit.sock');
    assert.equal(ipcClient.socketPathFor('shumabit'), '/tmp/polygram-shumabit.sock');
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

'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const ipcServer = require('../lib/ipc/server');
const { createIpcHandlers } = require('../lib/ipc/handlers');

const execFileAsync = promisify(execFile);
const scriptPath = path.join(__dirname, '..', 'scripts', 'ipc-smoke.js');
const silentLogger = { log: () => {}, error: () => {} };

let server;
let fixture;

function createFixture() {
  const suffix = Math.random().toString(36).slice(2, 5);
  fixture = path.join(__dirname, '..', `.i${suffix}`);
  fs.mkdirSync(fixture, { mode: 0o700 });
  const elsewhere = path.join(fixture, 'elsewhere');
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  const runtimeDir = ipcServer.ensureRuntimeDirectory({
    cwd: fixture,
    env: {},
  });
  return { elsewhere, runtimeDir };
}

async function startProductionServer({ bot, runtimeDir, inFlightHandlers }) {
  const options = {
    cwd: path.dirname(runtimeDir),
    env: { POLYGRAM_IPC_DIR: runtimeDir },
  };
  const secret = ipcServer.writeSecret(bot, options);
  server = await ipcServer.start({
    path: ipcServer.socketPathFor(bot, options),
    handlers: createIpcHandlers({
      botName: bot,
      getInFlightHandlers: () => inFlightHandlers,
      handleSendOverIpc: async () => ({}),
    }),
    logger: silentLogger,
    secret,
  });
}

async function runCli(args, { cwd, runtimeDir }) {
  const env = { ...process.env, POLYGRAM_IPC_DIR: runtimeDir };
  delete env.POLYGRAM_IPC_SECRET;
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
  });
}

describe('polygram-ipc operator CLI', () => {
  afterEach(async () => {
    if (server) await server.close();
    server = null;
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
    fixture = null;
  });

  test('busy prints only the aggregate when invoked outside the daemon working directory', async () => {
    const bot = 'ops';
    const { elsewhere, runtimeDir } = createFixture();
    const sensitiveSessionKey = '-1003369922517:37';
    await startProductionServer({
      bot,
      runtimeDir,
      inFlightHandlers: new Map([[sensitiveSessionKey, 2]]),
    });

    const { stdout, stderr } = await runCli([bot, 'busy'], {
      cwd: elsewhere,
      runtimeDir,
    });

    assert.equal(stderr, '');
    assert.equal(stdout, `${JSON.stringify({ bot, in_flight: 2 })}\n`);
    assert.doesNotMatch(stdout, /session|socket|path/i);
    assert.doesNotMatch(stdout, new RegExp(sensitiveSessionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(stdout, /3369922517|451328391/);
  });

  test('no subcommand retains the existing path, ping, DONE output', async () => {
    const bot = 'ops';
    const { elsewhere, runtimeDir } = createFixture();
    await startProductionServer({
      bot,
      runtimeDir,
      inFlightHandlers: new Map(),
    });

    const { stdout, stderr } = await runCli([bot], {
      cwd: elsewhere,
      runtimeDir,
    });

    assert.equal(stderr, '');
    assert.equal(
      stdout,
      [
        `path: ${path.join(runtimeDir, `polygram-${bot}.sock`)}`,
        `ping: ${JSON.stringify({ id: null, ok: true, pong: true, bot })}`,
        'DONE',
        '',
      ].join('\n'),
    );
  });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'polygram.js'),
  'utf8',
);

test('daemon protects and exports one IPC runtime directory before Codex setup', () => {
  const ensureIndex = source.indexOf(
    'ipcRuntimeDir = ipcServer.ensureRuntimeDirectory();',
  );
  const exportIndex = source.indexOf(
    'process.env.POLYGRAM_IPC_DIR = ipcRuntimeDir;',
  );
  const socketIndex = source.indexOf('ipcServer.socketPathFor(BOT_NAME);');
  const controllerIndex = source.indexOf(
    'codexRuntimeController = createCodexRuntimeController({',
  );
  const managerIndex = source.indexOf('pm = new ProcessManager({');

  assert.ok(ensureIndex >= 0, 'startup must validate or create the IPC root');
  assert.ok(exportIndex > ensureIndex, 'all IPC clients must inherit that root');
  assert.ok(
    socketIndex > exportIndex,
    'startup must reject overlong bot socket paths before claiming resources',
  );
  assert.ok(
    controllerIndex > socketIndex,
    'Codex setup must happen only after the protected root is resolved',
  );
  assert.ok(managerIndex > controllerIndex);

  const controllerSetup = source.slice(controllerIndex, managerIndex);
  assert.match(
    controllerSetup,
    /defaultDaemonSecretRoots:\s*\[[\s\S]*?\bipcRuntimeDir,/,
    'the exact IPC runtime root must be denied by the Codex profile',
  );
});

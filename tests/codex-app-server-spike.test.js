'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const wrapperPath = path.resolve(__dirname, '../scripts/spikes/codex-app-server.mjs');

test('Polygram preserves the Orchestra U1a STOP exit status', (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'polygram-codex-u1a-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const binaryPath = path.join(scratch, 'codex');
  const orchestraSpikePath = path.join(scratch, 'codex-app-server-real.mjs');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(binaryPath, 0o700);
  writeFileSync(
    orchestraSpikePath,
    [
      'process.stdout.write(JSON.stringify({ gate: "STOP" }) + "\\n");',
      'process.exitCode = 2;',
      '',
    ].join('\n'),
  );

  const result = spawnSync(
    process.execPath,
    [
      wrapperPath,
      '--orchestra-spike',
      orchestraSpikePath,
      '--binary',
      binaryPath,
    ],
    {
      cwd: scratch,
      encoding: 'utf8',
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
      },
    },
  );

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { gate: 'STOP' });
  assert.equal(result.stderr, '');
});

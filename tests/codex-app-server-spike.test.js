'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const wrapperPath = path.resolve(__dirname, '../scripts/spikes/codex-app-server.mjs');

function createFixture(t) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'polygram-codex-u1a-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const binaryPath = path.join(scratch, 'codex');
  const orchestraSpikePath = path.join(scratch, 'codex-app-server-real.mjs');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(binaryPath, 0o700);

  return { binaryPath, orchestraSpikePath, scratch };
}

function runWrapper(scratch, args, extraEnv = {}) {
  return spawnSync(process.execPath, [wrapperPath, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ...extraEnv,
    },
  });
}

function waitForOutput(stream, marker, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${marker}`));
    }, timeoutMs);
    stream.on('data', (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      resolve(output);
    });
  });
}

test('Polygram preserves opaque Orchestra CONTINUE output and forwards gate paths', (t) => {
  const {
    binaryPath,
    orchestraSpikePath,
    scratch,
  } = createFixture(t);
  const launcherPath = path.join(scratch, 'session-launcher');
  const codexHome = path.join(scratch, 'codex-home');
  const workspace = path.join(scratch, 'workspace');
  const daemonSecretRoots = [
    path.join(scratch, 'daemon-secrets-a'),
    path.join(scratch, 'daemon-secrets-b'),
  ];
  const output = '{"gate":"CONTINUE","opaque":"continue-bytes"}\n';
  writeFileSync(launcherPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(launcherPath, 0o700);
  writeFileSync(
    orchestraSpikePath,
    [
      `const expected = ${JSON.stringify([
        '--binary',
        binaryPath,
        '--launcher',
        launcherPath,
        '--codex-home',
        codexHome,
        '--workspace',
        workspace,
        '--daemon-secret-root',
        daemonSecretRoots[0],
        '--daemon-secret-root',
        daemonSecretRoots[1],
      ])};`,
      'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {',
      '  process.stderr.write(`unexpected args: ${JSON.stringify(process.argv.slice(2))}\\n`);',
      '  process.exitCode = 9;',
      '} else {',
      `  process.stdout.write(${JSON.stringify(output)});`,
      '}',
      '',
    ].join('\n'),
  );

  const cliResult = runWrapper(
    scratch,
    [
      '--orchestra-spike',
      orchestraSpikePath,
      '--binary',
      binaryPath,
      '--launcher',
      launcherPath,
      '--codex-home',
      codexHome,
      '--workspace',
      workspace,
      '--daemon-secret-root',
      daemonSecretRoots[0],
      '--daemon-secret-root',
      daemonSecretRoots[1],
    ],
    {
      POLYGRAM_CODEX_BIN: path.join(scratch, 'ignored-env-binary'),
      ORCHESTRA_SESSION_LAUNCHER: path.join(scratch, 'ignored-env-launcher'),
      ORCHESTRA_CODEX_HOME: path.join(scratch, 'ignored-env-codex-home'),
      ORCHESTRA_CODEX_WORKSPACE: path.join(scratch, 'ignored-env-workspace'),
      ORCHESTRA_CODEX_DAEMON_SECRET_ROOTS: path.join(
        scratch,
        'ignored-env-secrets',
      ),
    },
  );

  assert.equal(cliResult.status, 0);
  assert.equal(cliResult.stdout, output);
  assert.equal(cliResult.stderr, '');

  const envResult = runWrapper(
    scratch,
    [
      '--orchestra-spike',
      orchestraSpikePath,
    ],
    {
      POLYGRAM_CODEX_BIN: binaryPath,
      ORCHESTRA_SESSION_LAUNCHER: launcherPath,
      ORCHESTRA_CODEX_HOME: codexHome,
      ORCHESTRA_CODEX_WORKSPACE: workspace,
      ORCHESTRA_CODEX_DAEMON_SECRET_ROOTS: [
        '',
        daemonSecretRoots[0],
        '',
        daemonSecretRoots[1],
        '',
      ].join(path.delimiter),
    },
  );

  assert.equal(envResult.status, 0);
  assert.equal(envResult.stdout, output);
  assert.equal(envResult.stderr, '');
});

test('Polygram preserves the Orchestra U1a STOP output, diagnostic, and exit status', (t) => {
  const { binaryPath, orchestraSpikePath, scratch } = createFixture(t);
  const codexHome = path.join(scratch, 'codex-home');
  const workspace = path.join(scratch, 'workspace');
  const daemonSecretRoot = path.join(scratch, 'daemon-secrets');
  const output = '{"gate":"STOP","opaque":"stop-bytes"}\n';
  const diagnostic = 'named-profile containment failed\n';
  writeFileSync(
    orchestraSpikePath,
    [
      `process.stdout.write(${JSON.stringify(output)});`,
      `process.stderr.write(${JSON.stringify(diagnostic)});`,
      'process.exitCode = 2;',
      '',
    ].join('\n'),
  );

  const result = runWrapper(scratch, [
    '--orchestra-spike',
    orchestraSpikePath,
    '--binary',
    binaryPath,
    '--codex-home',
    codexHome,
    '--workspace',
    workspace,
    '--daemon-secret-root',
    daemonSecretRoot,
  ]);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, output);
  assert.equal(result.stderr, diagnostic);
});

test('Polygram requires an absolute daemon secret root without reading it', (t) => {
  const { binaryPath, orchestraSpikePath, scratch } = createFixture(t);
  const commonArgs = [
    '--orchestra-spike',
    orchestraSpikePath,
    '--binary',
    binaryPath,
    '--codex-home',
    path.join(scratch, 'codex-home'),
    '--workspace',
    path.join(scratch, 'workspace'),
  ];
  writeFileSync(orchestraSpikePath, 'process.exitCode = 0;\n');

  const missingResult = runWrapper(scratch, commonArgs);
  assert.equal(missingResult.status, 1);
  assert.equal(missingResult.stdout, '');
  assert.equal(
    missingResult.stderr,
    'Polygram Codex U1a launcher failed: pass at least one daemon secret root\n',
  );

  const relativeResult = runWrapper(scratch, [
    ...commonArgs,
    '--daemon-secret-root',
    'relative-secrets',
  ]);
  assert.equal(relativeResult.status, 1);
  assert.equal(relativeResult.stdout, '');
  assert.equal(
    relativeResult.stderr,
    'Polygram Codex U1a launcher failed: daemon secret root must be an absolute path\n',
  );
});

test('Polygram preserves POSIX child termination signals and output', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX signal contract');
    return;
  }

  const { binaryPath, orchestraSpikePath, scratch } = createFixture(t);
  const args = [
    '--orchestra-spike',
    orchestraSpikePath,
    '--binary',
    binaryPath,
    '--codex-home',
    path.join(scratch, 'codex-home'),
    '--workspace',
    path.join(scratch, 'workspace'),
    '--daemon-secret-root',
    path.join(scratch, 'daemon-secrets'),
  ];

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const stdout = `${signal} stdout\n`;
    const stderr = `${signal} stderr\n`;
    writeFileSync(
      orchestraSpikePath,
      [
        "import { writeSync } from 'node:fs';",
        `writeSync(1, ${JSON.stringify(stdout)});`,
        `writeSync(2, ${JSON.stringify(stderr)});`,
        `process.kill(process.pid, ${JSON.stringify(signal)});`,
        '',
      ].join('\n'),
    );

    const result = runWrapper(scratch, args);
    assert.deepEqual(
      {
        signal: result.signal,
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      {
        signal,
        status: null,
        stderr,
        stdout,
      },
    );
  }
});

test('Polygram forwards POSIX shutdown signals to the Orchestra child', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX signal contract');
    return;
  }

  const { binaryPath, orchestraSpikePath, scratch } = createFixture(t);
  writeFileSync(
    orchestraSpikePath,
    [
      "import { writeSync } from 'node:fs';",
      "for (const signal of ['SIGINT', 'SIGTERM']) {",
      '  process.on(signal, () => {',
      '    process.removeAllListeners(signal);',
      '    writeSync(1, `OBSERVED ${signal}\\n`);',
      '    process.kill(process.pid, signal);',
      '  });',
      '}',
      "writeSync(1, 'READY\\n');",
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
  );
  const args = [
    wrapperPath,
    '--orchestra-spike',
    orchestraSpikePath,
    '--binary',
    binaryPath,
    '--codex-home',
    path.join(scratch, 'codex-home'),
    '--workspace',
    path.join(scratch, 'workspace'),
    '--daemon-secret-root',
    path.join(scratch, 'daemon-secrets'),
  ];

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const wrapper = spawn(process.execPath, args, {
      cwd: scratch,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill('SIGKILL');
      }
    });
    let stdout = '';
    let stderr = '';
    wrapper.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    wrapper.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    await waitForOutput(wrapper.stdout, 'READY\n');
    wrapper.kill(signal);
    const [code, observedSignal] = await once(wrapper, 'close');

    assert.equal(code, null);
    assert.equal(observedSignal, signal);
    assert.match(stdout, new RegExp(`OBSERVED ${signal}`));
    assert.equal(stderr, '');
  }
});

test('Polygram reports its own argument validation errors without synthetic JSON', (t) => {
  const { orchestraSpikePath, scratch } = createFixture(t);

  const result = runWrapper(scratch, [
    '--orchestra-spike',
    orchestraSpikePath,
    '--binary',
    'relative-codex',
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'Polygram Codex U1a launcher failed: Codex binary must be an absolute path\n',
  );
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const helperUrl = pathToFileURL(
  path.join(__dirname, '..', 'scripts', 'spikes', 'claude-executable.mjs'),
).href;
const wrapperPath = path.join(
  __dirname,
  '..',
  'scripts',
  'spikes',
  'claude-process-wrapper.mjs',
);

test('real-Claude gate failures retain a content-free phase label', () => {
  for (const driverName of [
    'cli-contract-matrix.mjs',
    'workflow-autonomous-completion.mjs',
  ]) {
    const driver = fs.readFileSync(path.join(
      __dirname,
      '..',
      'scripts',
      'spikes',
      driverName,
    ), 'utf8');
    assert.match(driver, /let failureStage = 'initializing';/);
    assert.match(driver, /failureStage: status === 'PASS' \? null : failureStage,/);
    assert.match(driver, /failureStage = 'complete';/);
  }
});

function makeFakeClaude(dir, version = '2.1.220', runtimeMs = 0) {
  const script = path.join(dir, `claude-${version}.mjs`);
  fs.writeFileSync(script, [
    '#!/usr/bin/env node',
    "if (process.argv[2] === '--version') {",
    `  console.log('${version} (Claude Code)');`,
    '  process.exit(0);',
    '}',
    "console.log(JSON.stringify({ wrapper: process.env.CLAUDE_CODE_PROCESS_WRAPPER || null, runId: process.env.CLAUDE_CODE_GATE_RUN_ID || null }));",
    ...(runtimeMs > 0 ? [`setTimeout(() => {}, ${runtimeMs});`] : []),
  ].join('\n'), { mode: 0o700 });
  return script;
}

test('Claude gate selector rejects a missing executable path', async () => {
  const { createClaudeGateSelection } = await import(helperUrl);
  await assert.rejects(
    createClaudeGateSelection({ executablePath: '', expectedVersion: '2.1.220' }),
    /absolute executable path/i,
  );
});

test('Claude gate selector rejects a reported version mismatch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir, '2.1.219');

  const { createClaudeGateSelection } = await import(helperUrl);
  await assert.rejects(
    createClaudeGateSelection({
      executablePath,
      expectedVersion: '2.1.220',
      artifactBaseDir: path.join(dir, 'artifacts'),
    }),
    /expected Claude Code 2\.1\.220.*reported 2\.1\.219/i,
  );
});

test('candidate selection attests the executable and propagates selectors to CLI and SDK', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-select-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir);

  const {
    buildClaudeGateSdkOptions,
    createClaudeGateSelection,
    sha256File,
    withClaudeGateTmuxEnv,
  } = await import(helperUrl);
  const selection = await createClaudeGateSelection({
    executablePath,
    expectedVersion: '2.1.220',
    artifactBaseDir: path.join(dir, 'artifacts'),
    runId: 'candidate-test-run',
    processEnv: { HOME: dir, PATH: process.env.PATH, KEEP_ME: 'yes' },
  });

  assert.equal(selection.version, '2.1.220');
  assert.equal(selection.sha256, await sha256File(executablePath));
  assert.equal(selection.cliEnv.ORCHESTRA_CLAUDE_BIN, executablePath);
  assert.equal(selection.cliEnv.POLYGRAM_CLAUDE_BIN, executablePath);
  assert.equal(selection.sessionLauncher, wrapperPath);
  assert.equal(selection.sdkOptions.pathToClaudeCodeExecutable, executablePath);
  assert.equal(selection.sdkOptions.cwd, path.join(selection.artifactDir, 'sdk-workspace'));
  assert.equal(fs.statSync(selection.sdkOptions.cwd).mode & 0o777, 0o700);
  assert.equal(typeof selection.sdkOptions.spawnClaudeCodeProcess, 'function');
  assert.deepEqual(selection.sdkProcessEvidence.rootPids, []);
  assert.deepEqual(selection.sdkProcessEvidence.selectedBinaryPids, []);
  assert.equal(selection.sdkOptions.env.KEEP_ME, 'yes');
  assert.equal(selection.sdkOptions.env.CLAUDE_CODE_PROCESS_WRAPPER, wrapperPath);
  assert.equal(selection.sdkOptions.env.CLAUDE_CODE_GATE_RUN_ID, 'candidate-test-run');
  assert.equal(selection.sdkOptions.env.ORCHESTRA_CLAUDE_BIN, executablePath);
  assert.equal(selection.sdkOptions.env.POLYGRAM_CLAUDE_BIN, executablePath);

  const sdkOptions = buildClaudeGateSdkOptions(selection, {
    hooks: { Stop: [] },
    env: { SCENARIO_MARKER: 'kept' },
  });
  assert.equal(sdkOptions.model, 'claude-sonnet-4-6');
  assert.equal(sdkOptions.effort, 'medium');
  assert.deepEqual(sdkOptions.hooks, { Stop: [] });
  assert.equal(sdkOptions.env.KEEP_ME, 'yes');
  assert.equal(sdkOptions.env.SCENARIO_MARKER, 'kept');
  assert.equal(sdkOptions.env.CLAUDE_CODE_PROCESS_WRAPPER, wrapperPath);
  for (const protectedOverrides of [
    { pathToClaudeCodeExecutable: '/private/other-claude' },
    { cwd: '/private/other-cwd' },
    { spawnClaudeCodeProcess: () => {} },
    { model: 'claude-opus-5' },
    { effort: 'high' },
    { env: { CLAUDE_GATE_BIN: '/private/other-claude' } },
    { env: { CLAUDE_CODE_GATE_RUN_ID: 'other-run' } },
  ]) {
    assert.throws(
      () => buildClaudeGateSdkOptions(selection, protectedOverrides),
      /protected SDK gate option/i,
    );
  }

  assert.equal(fs.statSync(selection.artifactDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(selection.privateMetadataPath).mode & 0o777, 0o600);
  const sessionProjectsPath = path.join(
    selection.artifactDir,
    'session-projects.json',
  );
  assert.equal(fs.statSync(sessionProjectsPath).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(sessionProjectsPath, 'utf8')),
    {
      schemaVersion: 2,
      projects: [{
        cwd: selection.sdkCwd,
        sessionIds: [],
      }],
    },
  );
  const privateMetadata = JSON.parse(fs.readFileSync(selection.privateMetadataPath, 'utf8'));
  assert.equal(privateMetadata.executablePath, fs.realpathSync(executablePath));
  assert.equal(privateMetadata.sha256, selection.sha256);
  assert.equal(selection.sanitizedAttestation.executablePath, undefined);
  assert.match(selection.sanitizedAttestation.executablePathHash, /^[a-f0-9]{64}$/);

  const spawnCalls = [];
  const runner = withClaudeGateTmuxEnv({
    spawn: async (options) => spawnCalls.push(options),
    capture: async () => 'unchanged',
  }, selection);
  await runner.spawn({ name: 'gate', envExtras: { KEEP_EXTRA: 'yes' } });
  assert.equal(spawnCalls[0].envExtras.KEEP_EXTRA, 'yes');
  assert.equal(spawnCalls[0].envExtras.CLAUDE_CODE_GATE_RUN_ID, 'candidate-test-run');
  assert.equal(spawnCalls[0].envExtras.CLAUDE_CODE_PROCESS_WRAPPER, wrapperPath);
  for (const envExtras of [
    { CLAUDE_GATE_BIN: '/private/other-claude' },
    { ORCHESTRA_CLAUDE_BIN: '/private/other-claude' },
    { CLAUDE_CODE_GATE_RUN_ID: 'other-run' },
  ]) {
    assert.throws(
      () => runner.spawn({ name: 'gate', envExtras }),
      /protected CLI gate environment/i,
    );
  }
  assert.equal(await runner.capture(), 'unchanged');
});

test('legacy selection does not claim unsupported self-spawn wrapper evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir, '2.1.173');

  const { createClaudeGateSelection } = await import(helperUrl);
  const selection = await createClaudeGateSelection({
    executablePath,
    expectedVersion: '2.1.173',
    artifactBaseDir: path.join(dir, 'artifacts'),
    runId: 'legacy-test-run',
    processEnv: { PATH: process.env.PATH },
  });

  assert.equal(selection.sessionLauncher, null);
  assert.equal(selection.sdkOptions.env.CLAUDE_CODE_PROCESS_WRAPPER, undefined);
  assert.equal(selection.sdkOptions.env.CLAUDE_CODE_GATE_RUN_ID, undefined);
});

test('SDK process evidence records a process sampling failure after launch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-sampling-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir);
  let snapshotCalls = 0;

  const { createClaudeGateSelection } = await import(helperUrl);
  const selection = await createClaudeGateSelection({
    executablePath,
    expectedVersion: '2.1.220',
    artifactBaseDir: path.join(dir, 'artifacts'),
    runId: 'sampling-failure-run',
    processEnv: { PATH: process.env.PATH },
    processSnapshotFn: () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return [];
      throw new Error('synthetic process snapshot failure');
    },
  });
  const child = selection.sdkOptions.spawnClaudeCodeProcess({
    command: executablePath,
    args: [],
    cwd: selection.sdkCwd,
    env: selection.sdkOptions.env,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  selection.stopSdkProcessSampling();

  assert.equal(selection.sdkProcessEvidence.samplingFailed, true);
  assert.equal(selection.sdkProcessEvidence.sampleCount, 1);
  assert.ok(selection.sdkProcessEvidence.samplingFailureCount >= 1);
  assert.match(selection.sdkProcessEvidence.samplingErrorHash, /^[a-f0-9]{64}$/);
});

test('SDK process evidence retains tracking after an initial sampling failure', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-initial-sampling-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir);

  const { createClaudeGateSelection } = await import(helperUrl);
  const selection = await createClaudeGateSelection({
    executablePath,
    expectedVersion: '2.1.220',
    artifactBaseDir: path.join(dir, 'artifacts'),
    runId: 'initial-sampling-failure-run',
    processEnv: { PATH: process.env.PATH },
    processSnapshotFn: () => {
      throw new Error('synthetic initial process snapshot failure');
    },
  });
  let child;
  assert.doesNotThrow(() => {
    child = selection.sdkOptions.spawnClaudeCodeProcess({
      command: executablePath,
      args: [],
      cwd: selection.sdkCwd,
      env: selection.sdkOptions.env,
    });
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.equal(selection.sdkProcessEvidence.samplingFailed, true);
  assert.ok(selection.sdkProcessEvidence.samplingFailureCount >= 1);
  assert.match(selection.sdkProcessEvidence.samplingErrorHash, /^[a-f0-9]{64}$/);
  const failureCountAfterExit = selection.sdkProcessEvidence.samplingFailureCount;
  selection.stopSdkProcessSampling();
  assert.equal(selection.sdkProcessEvidence.samplingFailureCount, failureCountAfterExit);
});

test('SDK process evidence retains selected binary parent pids', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-process-parent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir);
  let childPid;

  const { createClaudeGateSelection } = await import(helperUrl);
  const selection = await createClaudeGateSelection({
    executablePath,
    expectedVersion: '2.1.220',
    artifactBaseDir: path.join(dir, 'artifacts'),
    runId: 'process-parent-run',
    processEnv: { PATH: process.env.PATH },
    processPlatform: 'darwin',
    processSnapshotFn: () => childPid
      ? [{ pid: childPid, ppid: 4242, command: executablePath }]
      : [],
  });
  const child = selection.sdkOptions.spawnClaudeCodeProcess({
    command: executablePath,
    args: [],
    cwd: selection.sdkCwd,
    env: selection.sdkOptions.env,
  });
  childPid = child.pid;
  selection.stopSdkProcessSampling();

  assert.deepEqual(selection.sdkProcessEvidence.selectedBinaryProcesses, [{
    pid: childPid,
    ppid: 4242,
  }]);
  assert.deepEqual(selection.sdkProcessEvidence.selectedBinaryPids, [childPid]);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
});

test('SDK sampling ignores a clearly unrelated macOS basename descendant', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-process-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir);
  let childPid;

  const { createClaudeGateSelection } = await import(helperUrl);
  const selection = await createClaudeGateSelection({
    executablePath,
    expectedVersion: '2.1.220',
    artifactBaseDir: path.join(dir, 'artifacts'),
    runId: 'process-node-run',
    processEnv: { PATH: process.env.PATH },
    processSnapshotFn: () => childPid
      ? [
          { pid: childPid, ppid: 4242, command: executablePath },
          { pid: childPid + 1, ppid: childPid, command: 'node' },
        ]
      : [],
    processPlatform: 'darwin',
  });
  const child = selection.sdkOptions.spawnClaudeCodeProcess({
    command: executablePath,
    args: [],
    cwd: selection.sdkCwd,
    env: selection.sdkOptions.env,
  });
  childPid = child.pid;
  selection.stopSdkProcessSampling();

  assert.equal(selection.sdkProcessEvidence.samplingFailed, false);
  assert.deepEqual(selection.sdkProcessEvidence.selectedBinaryProcesses, [{
    pid: childPid,
    ppid: 4242,
  }]);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
});

test('SDK sampling fails when a target-basename descendant cannot be resolved', async (t) => {
  for (const processPlatform of ['darwin', 'linux']) {
    const dir = fs.mkdtempSync(path.join(
      os.tmpdir(),
      `polygram-gate-process-target-${processPlatform}-`,
    ));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const executablePath = makeFakeClaude(dir);
    let childPid;

    const { createClaudeGateSelection } = await import(helperUrl);
    const selection = await createClaudeGateSelection({
      executablePath,
      expectedVersion: '2.1.220',
      artifactBaseDir: path.join(dir, 'artifacts'),
      runId: `process-target-${processPlatform}`,
      processEnv: { PATH: process.env.PATH },
      processPlatform,
      processSnapshotFn: () => childPid
        ? [
            { pid: childPid, ppid: 4242, command: executablePath },
            {
              pid: childPid + 1,
              ppid: childPid,
              command: path.basename(executablePath),
            },
          ]
        : [],
      processExecutableResolver: ({ pid }) => {
        if (pid === childPid) return fs.realpathSync(executablePath);
        throw new Error('target vanished');
      },
    });
    const child = selection.sdkOptions.spawnClaudeCodeProcess({
      command: executablePath,
      args: [],
      cwd: selection.sdkCwd,
      env: selection.sdkOptions.env,
    });
    childPid = child.pid;
    selection.stopSdkProcessSampling();

    assert.equal(
      selection.sdkProcessEvidence.samplingFailed,
      true,
      processPlatform,
    );
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  }
});

test('SDK sampling ignores a verified selected process that exits during resolution', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-process-exit-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir, '2.1.220', 1_000);
  let childPid;
  let disappearing = false;
  let returnedRacySnapshot = false;

  const { createClaudeGateSelection } = await import(helperUrl);
  const selection = await createClaudeGateSelection({
    executablePath,
    expectedVersion: '2.1.220',
    artifactBaseDir: path.join(dir, 'artifacts'),
    runId: 'process-exit-race',
    processEnv: { PATH: process.env.PATH },
    processPlatform: 'darwin',
    processSnapshotFn: () => {
      if (!childPid) return [];
      if (disappearing && returnedRacySnapshot) {
        return [{
          pid: childPid,
          ppid: 4242,
          state: 'Z',
          command: path.basename(executablePath),
        }];
      }
      if (disappearing) returnedRacySnapshot = true;
      return [{
        pid: childPid,
        ppid: 4242,
        command: path.basename(executablePath),
      }];
    },
    processExecutableResolver: () => {
      if (disappearing) throw new Error('selected process exited');
      return fs.realpathSync(executablePath);
    },
  });
  const child = selection.sdkOptions.spawnClaudeCodeProcess({
    command: executablePath,
    args: [],
    cwd: selection.sdkCwd,
    env: selection.sdkOptions.env,
  });
  childPid = child.pid;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(selection.sdkProcessEvidence.selectedBinaryPids, [childPid]);

  disappearing = true;
  selection.stopSdkProcessSampling();

  assert.equal(selection.sdkProcessEvidence.samplingFailed, false);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
});

test('a synthetically recorded SDK root is not selected-process evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-process-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir);

  const { createClaudeGateSelection } = await import(helperUrl);
  const selection = await createClaudeGateSelection({
    executablePath,
    expectedVersion: '2.1.220',
    artifactBaseDir: path.join(dir, 'artifacts'),
    runId: 'process-empty-run',
    processEnv: { PATH: process.env.PATH },
    processSnapshotFn: () => [],
  });
  const child = selection.sdkOptions.spawnClaudeCodeProcess({
    command: executablePath,
    args: [],
    cwd: selection.sdkCwd,
    env: selection.sdkOptions.env,
  });
  selection.stopSdkProcessSampling();

  assert.deepEqual(selection.sdkProcessEvidence.rootPids, [child.pid]);
  assert.ok(selection.sdkProcessEvidence.sampleCount > 0);
  assert.deepEqual(selection.sdkProcessEvidence.selectedBinaryProcesses, []);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
});

test('artifact base validation never chmods an existing broad directory', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-base-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o755);

  const { ensurePrivateArtifactBase } = await import(helperUrl);
  assert.throws(
    () => ensurePrivateArtifactBase(dir),
    /mode 0700/i,
  );
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
});

test('process wrapper records privacy-safe provenance and preserves wrapper env for descendants', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-wrapper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = makeFakeClaude(dir);
  const secretArg = 'private-prompt-must-not-appear';

  const result = spawnSync(wrapperPath, [executablePath, secretArg], {
    cwd: dir,
    env: {
      ...process.env,
      CLAUDE_CODE_GATE_RUN_ID: 'wrapper-test-run',
      CLAUDE_CODE_GATE_ARTIFACT_DIR: dir,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout.trim());
  assert.equal(child.wrapper, wrapperPath);
  assert.equal(child.runId, 'wrapper-test-run');

  const recordsPath = path.join(dir, 'process-wrapper.ndjson');
  assert.equal(fs.statSync(recordsPath).mode & 0o777, 0o600);
  const recordText = fs.readFileSync(recordsPath, 'utf8');
  const record = JSON.parse(recordText.trim());
  assert.equal(record.runId, 'wrapper-test-run');
  assert.ok(Number.isInteger(record.pid) && record.pid > 0);
  assert.ok(Number.isInteger(record.ppid) && record.ppid > 0);
  assert.equal(record.version, '2.1.220');
  assert.ok(Number.isInteger(record.versionProbePid) && record.versionProbePid > 0);
  assert.notEqual(record.versionProbePid, record.pid);
  assert.match(record.executablePathHash, /^[a-f0-9]{64}$/);
  assert.match(record.executableSha256, /^[a-f0-9]{64}$/);
  assert.match(record.argvHash, /^[a-f0-9]{64}$/);
  assert.equal(record.argvCount, 1);
  assert.doesNotMatch(recordText, new RegExp(secretArg));
  assert.doesNotMatch(recordText, new RegExp(executablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

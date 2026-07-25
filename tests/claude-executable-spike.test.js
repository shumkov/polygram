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

function makeFakeClaude(dir, version = '2.1.220') {
  const script = path.join(dir, `claude-${version}.mjs`);
  fs.writeFileSync(script, [
    '#!/usr/bin/env node',
    "if (process.argv[2] === '--version') {",
    `  console.log('${version} (Claude Code)');`,
    '  process.exit(0);',
    '}',
    "console.log(JSON.stringify({ wrapper: process.env.CLAUDE_CODE_PROCESS_WRAPPER || null, runId: process.env.CLAUDE_CODE_GATE_RUN_ID || null }));",
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
      schemaVersion: 1,
      cwds: [selection.sdkCwd],
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
  assert.equal(record.version, '2.1.220');
  assert.match(record.executablePathHash, /^[a-f0-9]{64}$/);
  assert.match(record.executableSha256, /^[a-f0-9]{64}$/);
  assert.match(record.argvHash, /^[a-f0-9]{64}$/);
  assert.equal(record.argvCount, 1);
  assert.doesNotMatch(recordText, new RegExp(secretArg));
  assert.doesNotMatch(recordText, new RegExp(executablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

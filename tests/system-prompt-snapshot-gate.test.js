const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'scripts/spikes/claude-2.1.283-matrix.json'),
  'utf8',
));
const SCENARIO = 'candidate-system-prompt-snapshot';
const CANDIDATE_VERSION = manifest.versions.candidate;
const CANDIDATE_EXPECTATIONS = manifest.expectations[CANDIDATE_VERSION];
const launcherPath = path.join(
  repoRoot,
  'scripts/spikes/system-prompt-snapshot-launcher.mjs',
);

async function matrixModule() {
  return import('../scripts/spikes/claude-gate-matrix.mjs');
}

function snapshotResult(overrides = {}) {
  return {
    evidenceSchemaVersion: 1,
    matrixScenario: SCENARIO,
    scenario: SCENARIO,
    status: 'PASS',
    failureHash: null,
    failureStage: null,
    attestation: {
      runId: 'snapshot-run',
      version: CANDIDATE_VERSION,
      sha256: 'a'.repeat(64),
      executablePathHash: 'b'.repeat(64),
      wrapperRequired: true,
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    resolvedModel: 'claude-sonnet-4-6',
    spawnCount: 4,
    controlSnapshotOnSpawnCount: 2,
    snapshotFlagAdvertised: true,
    controlObservedHint: 'first',
    testObservedHint: 'second',
    processTree: [{ pid: 2200, ppid: 2199, executablePathHash: 'b'.repeat(64) }],
    wrapperRecords: [],
    lifecycle: {
      session: [{ type: 'queue-operation', operation: 'enqueue' }],
    },
    lifecycleSources: {
      session: {
        stream: 'session',
        file: 'session.jsonl',
        sha256: 'c'.repeat(64),
        rawRecordCount: 1,
        normalizedRecordCount: 1,
      },
    },
    lifecycleProofs: [],
    ...overrides,
  };
}

test('snapshot cell is a candidate-only CliProcess cell over the snapshot-off session', () => {
  const scenario = manifest.scenarios.find(({ id }) => id === SCENARIO);
  assert.equal(scenario.candidateOnly, true);
  assert.deepEqual(scenario.evidenceSources, { session: 'session.jsonl' });
  assert.equal(fs.existsSync(path.join(repoRoot, scenario.driver)), true);
  assert.deepEqual(scenario.args, { candidate: [] });
  assert.match(scenario.oracle.candidate, /NOT-APPLICABLE/);
  const driver = fs.readFileSync(path.join(repoRoot, scenario.driver), 'utf8');
  assert.match(driver, /new CliProcess\(/);
  assert.match(driver, /resumePolicy: 'require-existing-session'/);
  assert.match(driver, /system-prompt-snapshot-launcher\.mjs/);
});

test('snapshot oracle passes only when the control proves recording is active', async () => {
  const { matrixScenarioOracleMatches } = await matrixModule();
  const judge = (overrides) => matrixScenarioOracleMatches(
    SCENARIO,
    snapshotResult(overrides),
    CANDIDATE_EXPECTATIONS,
  ).pass;

  // Control replays the recorded first hint; snapshot-off sees the new one.
  assert.equal(judge({}), true);
  assert.equal(judge({ status: 'NOT-APPLICABLE' }), false);

  // Both legs see the new hint: recording is inactive for the account, so
  // the off flag was not what produced the new hint.
  assert.equal(judge({
    status: 'NOT-APPLICABLE',
    controlObservedHint: 'second',
  }), true);
  assert.equal(judge({ controlObservedHint: 'second' }), false);

  for (const overrides of [
    { testObservedHint: 'first' },
    { testObservedHint: 'both' },
    { testObservedHint: 'none' },
    { controlObservedHint: 'both' },
    { controlObservedHint: 'none' },
    { snapshotFlagAdvertised: false },
    { spawnCount: 3 },
    { controlSnapshotOnSpawnCount: 1 },
    { failureStage: 'evaluating-snapshot', failureHash: 'd'.repeat(64) },
  ]) {
    for (const status of ['PASS', 'NOT-APPLICABLE']) {
      assert.equal(
        judge({ ...overrides, status }),
        false,
        JSON.stringify({ ...overrides, status }),
      );
    }
  }
});

test('NOT-APPLICABLE is a recognized sanitized status only for the snapshot cell', async () => {
  const { sanitizedGateResultSchemaMatches } = await import(
    '../scripts/spikes/claude-gate-evidence.mjs'
  );
  const { evaluateMatrixRunResult } = await matrixModule();
  const notApplicable = snapshotResult({
    status: 'NOT-APPLICABLE',
    controlObservedHint: 'second',
  });
  assert.equal(sanitizedGateResultSchemaMatches(snapshotResult(), SCENARIO), true);
  assert.equal(sanitizedGateResultSchemaMatches(notApplicable, SCENARIO), true);
  assert.equal(sanitizedGateResultSchemaMatches(
    { ...notApplicable, matrixScenario: 'cli-contract' },
    'cli-contract',
  ), false);

  const run = {
    scenarioId: SCENARIO,
    versionKey: 'candidate',
    version: CANDIDATE_VERSION,
    expectations: CANDIDATE_EXPECTATIONS,
    model: 'claude-sonnet-4-6',
    effort: 'medium',
  };
  // Without a private artifact directory the unit run carries no sources.
  const unitResult = { ...notApplicable };
  delete unitResult.lifecycleSources;
  delete unitResult.lifecycleProofs;
  assert.deepEqual(evaluateMatrixRunResult({ run, result: unitResult }).reasons, []);
  assert.equal(evaluateMatrixRunResult({
    run: { ...run, scenarioId: 'sdk-resume' },
    result: {
      ...unitResult,
      matrixScenario: 'sdk-resume',
      lifecycle: [{ type: 'result', subtype: 'success' }],
    },
  }).reasons.includes('sanitized result did not report PASS'), true);
});

function runLauncher(t, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-snapshot-launcher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argvPath = path.join(dir, 'argv.json');
  const wrapperPath = path.join(dir, 'fake-wrapper');
  fs.writeFileSync(
    wrapperPath,
    `#!${process.execPath}\n`
      + `require('node:fs').writeFileSync(${JSON.stringify(argvPath)}, `
      + 'JSON.stringify(process.argv.slice(2)));\n',
    { mode: 0o700 },
  );
  const child = spawnSync(process.execPath, [launcherPath, '/abs/claude', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CODE_PROCESS_WRAPPER: wrapperPath,
      CLAUDE_CODE_GATE_ARTIFACT_DIR: dir,
    },
  });
  const recordsPath = path.join(dir, 'snapshot-launcher.ndjson');
  return {
    status: child.status,
    argv: fs.existsSync(argvPath)
      ? JSON.parse(fs.readFileSync(argvPath, 'utf8'))
      : null,
    records: fs.existsSync(recordsPath)
      ? fs.readFileSync(recordsPath, 'utf8').split('\n').filter(Boolean)
      : [],
    recordsMode: fs.existsSync(recordsPath)
      ? fs.statSync(recordsPath).mode & 0o777
      : null,
  };
}

test('control launcher forces exactly the Orchestra snapshot flag on and keeps the wrapper', (t) => {
  const forced = runLauncher(t, [
    '--append-system-prompt', 'hint',
    '--system-prompt-snapshot', 'off',
    '--mcp-config', '/abs/mcp.json',
  ]);
  assert.equal(forced.status, 0);
  assert.deepEqual(forced.argv, [
    '/abs/claude',
    '--append-system-prompt', 'hint',
    '--system-prompt-snapshot', 'on',
    '--mcp-config', '/abs/mcp.json',
  ]);
  assert.equal(forced.records.length, 1);
  assert.equal(JSON.parse(forced.records[0]).snapshot, 'on');
  assert.equal(forced.recordsMode, 0o600);

  // Without Orchestra's flag the control would silently match the test leg.
  for (const args of [
    ['--append-system-prompt', 'hint'],
    ['--system-prompt-snapshot', 'on'],
    [
      '--system-prompt-snapshot', 'off',
      '--system-prompt-snapshot', 'off',
    ],
  ]) {
    const rejected = runLauncher(t, args);
    assert.equal(rejected.status, 70, JSON.stringify(args));
    assert.equal(rejected.argv, null);
    assert.deepEqual(rejected.records, []);
  }
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(
  repoRoot,
  'scripts/spikes/claude-2.1.220-matrix.json',
);

test('Claude 2.1.220 matrix declares every mandatory old/new gate', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const oldNewIds = manifest.scenarios
    .filter((scenario) => !scenario.candidateOnly)
    .map((scenario) => scenario.id)
    .sort();

  assert.deepEqual(oldNewIds, [
    'cli-contract',
    'delayed-mcp',
    'sdk-compact',
    'sdk-post-tool-batch',
    'sdk-resume',
    'sdk-subagent',
    'sdk-tool-less-drain',
    'workflow-direct',
    'workflow-fallback',
  ]);
  assert.equal(manifest.versions.old, '2.1.173');
  assert.equal(manifest.versions.candidate, '2.1.220');
  assert.equal(manifest.comparator.model, 'claude-sonnet-4-6');
  assert.equal(manifest.comparator.effort, 'medium');
});

test('every matrix cell has a real driver, oracle, cost, and artifact collector', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const scenario of manifest.scenarios) {
    assert.match(scenario.id, /^[a-z0-9-]+$/);
    assert.equal(
      fs.existsSync(path.join(repoRoot, scenario.driver)),
      true,
      `${scenario.id} driver must exist`,
    );
    assert.equal(typeof scenario.cost.usdEstimate, 'number');
    assert.equal(typeof scenario.cost.destructive, 'boolean');
    assert.ok(scenario.artifactCollector);
    assert.ok(scenario.oracle.candidate);
    if (!scenario.candidateOnly) {
      assert.ok(scenario.oracle.old);
      assert.ok(Array.isArray(scenario.comparison?.equalFields));
      assert.ok(scenario.comparison.equalFields.includes('resolvedModel'));
      assert.equal(scenario.comparison.lifecycle, 'shape-equal');
    }
  }
});

test('delayed MCP uses the same threshold and version-specific modes', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const scenario = manifest.scenarios.find(({ id }) => id === 'delayed-mcp');

  assert.equal(
    scenario.environment.common.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS,
    '1000',
  );
  assert.deepEqual(scenario.args.old, ['--expected-mode', 'foreground']);
  assert.deepEqual(scenario.args.candidate, ['--expected-mode', 'background']);
});

test('candidate-only production projection proves the Opus 5 resolution', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const scenario = manifest.scenarios.find(
    ({ id }) => id === 'candidate-opus-projection',
  );

  assert.equal(scenario.candidateOnly, true);
  assert.equal(scenario.environment.candidate.CLAUDE_GATE_MODEL, 'opus');
  assert.equal(scenario.expectedResolvedModel, 'claude-opus-5');
  assert.equal(scenario.documentedWorkflowSizeGuideline, 'medium');
});

test('matrix runner schedules every old gate before candidate gates with exact selectors', async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { buildClaudeMatrixRuns } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const runs = buildClaudeMatrixRuns({
    manifest,
    binaries: {
      old: '/private/bin/claude-2.1.173',
      candidate: '/private/bin/claude-2.1.220',
    },
    artifactBaseDir: '/private/artifacts',
    runPrefix: 'matrix-test',
  });

  assert.equal(runs.length, 19);
  assert.ok(runs.slice(0, 9).every((run) => run.versionKey === 'old'));
  assert.ok(runs.slice(9).every((run) => run.versionKey === 'candidate'));
  assert.equal(
    runs.find((run) => run.id === 'old:delayed-mcp').env.CLAUDE_GATE_BIN,
    '/private/bin/claude-2.1.173',
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:delayed-mcp')
      .env.CLAUDE_GATE_EXPECTED_VERSION,
    '2.1.220',
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:candidate-opus-projection')
      .env.CLAUDE_GATE_MODEL,
    'opus',
  );
  assert.equal(
    runs.some((run) => run.id === 'old:candidate-opus-projection'),
    false,
  );
  assert.equal(
    new Set(runs.map((run) => run.env.CLAUDE_GATE_RUN_ID)).size,
    runs.length,
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:candidate-opus-projection')
      .env.CLAUDE_GATE_DOCUMENTED_WORKFLOW_SIZE_GUIDELINE,
    'medium',
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:candidate-opus-projection')
      .expectedResolvedModel,
    'claude-opus-5',
  );
  assert.equal(
    runs.find((run) => run.id === 'candidate:workflow-direct')
      .env.CLAUDE_GATE_SCENARIO_ID,
    'workflow-direct',
  );
});

test('matrix evidence rejects a green exit with missing or mismatched artifacts', async () => {
  const {
    evaluateMatrixRunResult,
    evaluateMatrixEvidencePair,
  } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const run = {
    scenarioId: 'sdk-resume',
    version: '2.1.173',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
  };

  assert.equal(evaluateMatrixRunResult({ run, result: null }).pass, false);
  const validResult = {
    evidenceSchemaVersion: 1,
    matrixScenario: 'sdk-resume',
    status: 'PASS',
    resolvedModel: 'claude-sonnet-4-6',
    attestation: {
      version: '2.1.173',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    lifecycle: [{ type: 'result', subtype: 'success' }],
  };
  assert.equal(evaluateMatrixRunResult({ run, result: validResult }).pass, true);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: { ...validResult, lifecycle: [{ type: 'malformed' }] },
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: { ...validResult, lifecycle: null },
  }).pass, false);
  assert.equal(evaluateMatrixRunResult({
    run,
    result: {
      evidenceSchemaVersion: 1,
      matrixScenario: 'sdk-resume',
      status: 'PASS',
      resolvedModel: 'claude-opus-5',
      attestation: {
        version: '2.1.173',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
      },
    },
  }).pass, false);

  const scenario = {
    id: 'sdk-resume',
    comparison: {
      equalFields: ['resolvedModel', 'resultSubtype'],
    },
  };
  const oldResult = {
    resolvedModel: 'claude-sonnet-4-6',
    resultSubtype: 'success',
  };
  assert.deepEqual(evaluateMatrixEvidencePair({
    scenario,
    oldResult,
    candidateResult: { ...oldResult },
  }), { pass: true, differences: [] });
  assert.equal(evaluateMatrixEvidencePair({
    scenario,
    oldResult,
    candidateResult: { ...oldResult, resolvedModel: 'claude-opus-5' },
  }).pass, false);
  assert.equal(evaluateMatrixEvidencePair({
    scenario,
    oldResult: { resolvedModel: 'claude-sonnet-4-6' },
    candidateResult: { resolvedModel: 'claude-sonnet-4-6' },
  }).pass, false);
});

test('matrix evidence compares normalized lifecycle shapes fail closed', async () => {
  const { evaluateMatrixEvidencePair } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  const scenario = {
    comparison: {
      equalFields: ['resolvedModel'],
      lifecycle: 'shape-equal',
    },
  };
  const common = {
    resolvedModel: 'claude-sonnet-4-6',
    lifecycle: [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      {
        type: 'assistant',
        hasParent: false,
        contentTypes: ['tool_use'],
        toolNames: ['Bash'],
      },
      { type: 'result', subtype: 'success' },
    ],
  };

  assert.deepEqual(evaluateMatrixEvidencePair({
    scenario,
    oldResult: common,
    candidateResult: { ...common, lifecycle: [...common.lifecycle] },
  }), { pass: true, differences: [] });
  assert.equal(evaluateMatrixEvidencePair({
    scenario,
    oldResult: common,
    candidateResult: {
      ...common,
      lifecycle: [
        ...common.lifecycle,
        { type: 'system', subtype: 'task_notification' },
      ],
    },
  }).pass, false);
  assert.equal(evaluateMatrixEvidencePair({
    scenario,
    oldResult: common,
    candidateResult: {
      ...common,
      lifecycle: [
        ...common.lifecycle,
        common.lifecycle[1],
      ],
    },
  }).pass, false);
  assert.equal(evaluateMatrixEvidencePair({
    scenario,
    oldResult: common,
    candidateResult: { resolvedModel: common.resolvedModel },
  }).pass, false);
});

test('accepted matrix cleanup removes private evidence and preserves sanitized results', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-accept-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const runId = 'matrix-old-sdk-resume';
  const runDir = path.join(dir, runId);
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.mkdirSync(path.join(runDir, 'raw-private'), { mode: 0o700 });
  fs.writeFileSync(path.join(runDir, 'run-metadata.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(
    path.join(runDir, 'sanitized-result.json'),
    '{"status":"PASS"}',
    { mode: 0o600 },
  );
  const sdkCwd = path.join(runDir, 'sdk-workspace');
  fs.mkdirSync(sdkCwd, { mode: 0o700 });
  fs.writeFileSync(
    path.join(runDir, 'session-projects.json'),
    `${JSON.stringify({ schemaVersion: 1, cwds: [sdkCwd] })}\n`,
    { mode: 0o600 },
  );
  const claudeProjectsDir = path.join(dir, 'fake-claude-projects');
  fs.mkdirSync(claudeProjectsDir, { mode: 0o700 });
  const sourceProjectDir = path.join(
    claudeProjectsDir,
    fs.realpathSync(sdkCwd).replace(/\//g, '-'),
  );
  fs.mkdirSync(sourceProjectDir, { mode: 0o700 });
  fs.writeFileSync(path.join(sourceProjectDir, 'private.jsonl'), 'raw', {
    mode: 0o600,
  });
  fs.mkdirSync(path.join(dir, 'matrix-runner-private'), { mode: 0o700 });

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    claudeProjectsDir,
    summary: {
      authoritative: true,
      status: 'PASS',
      runPrefix: 'matrix',
      selectedRunCount: 1,
      passCount: 1,
      results: [{ status: 'PASS', runId }],
    },
  });

  assert.equal(fs.existsSync(path.join(runDir, 'sanitized-result.json')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'raw-private')), false);
  assert.equal(fs.existsSync(path.join(runDir, 'run-metadata.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'matrix-runner-private')), false);
  assert.equal(fs.existsSync(sourceProjectDir), false);
});

test('accepted matrix cleanup rejects an unsafe prefix before deleting evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-unsafe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const runId = 'matrix-old-sdk-resume';
  const runDir = path.join(dir, runId);
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.writeFileSync(path.join(runDir, 'run-metadata.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(runDir, 'sanitized-result.json'), '{}', { mode: 0o600 });

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: '../escape',
    summary: {
      authoritative: true,
      status: 'PASS',
      runPrefix: '../escape',
      selectedRunCount: 1,
      passCount: 1,
      results: [{ status: 'PASS', runId }],
    },
  }), /unsafe run prefix/);

  assert.equal(fs.existsSync(path.join(runDir, 'run-metadata.json')), true);
});

test('accepted matrix cleanup preflights every run before deleting evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const validRunId = 'matrix-old-sdk-resume';
  const validRunDir = path.join(dir, validRunId);
  fs.mkdirSync(validRunDir, { mode: 0o700 });
  fs.writeFileSync(path.join(validRunDir, 'run-metadata.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(
    path.join(validRunDir, 'sanitized-result.json'),
    '{"status":"PASS"}',
    { mode: 0o600 },
  );

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    summary: {
      authoritative: true,
      status: 'PASS',
      runPrefix: 'matrix',
      selectedRunCount: 2,
      passCount: 2,
      results: [
        { status: 'PASS', runId: validRunId },
        { status: 'PASS', runId: 'matrix-candidate-missing' },
      ],
    },
  }), /run artifact directory/);

  assert.equal(fs.existsSync(path.join(validRunDir, 'run-metadata.json')), true);
});

test('accepted matrix cleanup rejects a session project outside its run', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-project-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const runId = 'matrix-old-sdk-resume';
  const runDir = path.join(dir, runId);
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.writeFileSync(path.join(runDir, 'run-metadata.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(
    path.join(runDir, 'sanitized-result.json'),
    '{"status":"PASS"}',
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(runDir, 'session-projects.json'),
    `${JSON.stringify({ schemaVersion: 1, cwds: [dir] })}\n`,
    { mode: 0o600 },
  );

  const { purgeAcceptedGateArtifacts } = await import(
    '../scripts/spikes/claude-gate-matrix.mjs'
  );
  assert.throws(() => purgeAcceptedGateArtifacts({
    artifactBaseDir: dir,
    runPrefix: 'matrix',
    summary: {
      authoritative: true,
      status: 'PASS',
      runPrefix: 'matrix',
      selectedRunCount: 1,
      passCount: 1,
      results: [{ status: 'PASS', runId }],
    },
  }), /escapes the dedicated artifact base/);

  assert.equal(fs.existsSync(path.join(runDir, 'run-metadata.json')), true);
});

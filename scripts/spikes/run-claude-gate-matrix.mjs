#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ensurePrivateArtifactBase,
  hashSensitiveString,
} from './claude-executable.mjs';
import {
  assertSafeRunPrefix,
  buildClaudeMatrixChildEnv,
  buildClaudeMatrixRuns,
  evaluateMatrixCrossVersionEvidence,
  evaluateMatrixRunResult,
  evaluateMatrixVersionEvidence,
  MATRIX_MANIFEST_PATH,
  MATRIX_NOT_APPLICABLE_EXIT_CODE,
  purgeAcceptedGateArtifacts,
} from './claude-gate-matrix.mjs';

process.umask(0o077);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const oldBin = argument('--old-bin');
const candidateBin = argument('--candidate-bin');
const artifactBaseDir = argument('--artifact-base');
const acceptedRunPrefix = argument('--accept-run');
const onlyScenario = argument('--scenario');
const onlyVersion = argument('--version');
const runPrefix = argument('--run-prefix') || (
  new Date().toISOString().replace(/[:.]/g, '-')
);
if (!artifactBaseDir || !oldBin || !candidateBin) {
  console.error(
    'usage: run-claude-gate-matrix.mjs --old-bin <abs> '
      + '--candidate-bin <abs> --artifact-base <abs> '
      + '[--run-prefix <id>] [--version old|candidate] [--scenario <id>]\n'
      + '   or: run-claude-gate-matrix.mjs --artifact-base <abs> '
      + '--old-bin <abs> --candidate-bin <abs> --accept-run <run-prefix>',
  );
  process.exit(64);
}
const manifestText = fs.readFileSync(MATRIX_MANIFEST_PATH, 'utf8');
const manifest = JSON.parse(manifestText);
const manifestSha256 = hashSensitiveString(manifestText);
if (acceptedRunPrefix) {
  assertSafeRunPrefix(acceptedRunPrefix);
  const resolvedArtifactBaseDir = path.resolve(artifactBaseDir);
  const expectedRuns = buildClaudeMatrixRuns({
    manifest,
    binaries: {
      old: path.resolve(oldBin),
      candidate: path.resolve(candidateBin),
    },
    artifactBaseDir: resolvedArtifactBaseDir,
    runPrefix: acceptedRunPrefix,
  });
  const summaryPath = path.join(
    resolvedArtifactBaseDir,
    `${acceptedRunPrefix}-matrix-summary.json`,
  );
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  purgeAcceptedGateArtifacts({
    artifactBaseDir: resolvedArtifactBaseDir,
    runPrefix: acceptedRunPrefix,
    summary,
    expectedRuns,
    expectedScenarios: manifest.scenarios,
    expectedManifestSha256: manifestSha256,
  });
  console.log(`accepted sanitized matrix ${acceptedRunPrefix}; private evidence removed`);
  process.exit(0);
}
if (onlyVersion && !['old', 'candidate'].includes(onlyVersion)) {
  throw new TypeError('--version must be old or candidate');
}

const resolvedArtifactBaseDir = path.resolve(artifactBaseDir);
let runs = buildClaudeMatrixRuns({
  manifest,
  binaries: {
    old: path.resolve(oldBin),
    candidate: path.resolve(candidateBin),
  },
  artifactBaseDir: resolvedArtifactBaseDir,
  runPrefix,
});
const expectedAuthoritativeRunCount = runs.length;
if (onlyVersion) runs = runs.filter((run) => run.versionKey === onlyVersion);
if (onlyScenario) runs = runs.filter((run) => run.scenarioId === onlyScenario);
if (runs.length === 0) throw new Error('matrix selection produced no runs');
ensurePrivateArtifactBase(resolvedArtifactBaseDir);
const runnerPrivateDir = path.join(
  resolvedArtifactBaseDir,
  `${runPrefix}-runner-private`,
);
fs.mkdirSync(runnerPrivateDir, { mode: 0o700 });

const summary = {
  schemaVersion: 1,
  runPrefix,
  authoritative: !onlyVersion && !onlyScenario,
  selectedRunCount: runs.length,
  expectedAuthoritativeRunCount,
  manifestSha256,
  results: [],
};
const scenarios = new Map(
  manifest.scenarios.map((scenario) => [scenario.id, scenario]),
);
const evidenceByScenario = new Map();

for (const [index, run] of runs.entries()) {
  console.log(`[${index + 1}/${runs.length}] ${run.id} START`);
  const startedAt = Date.now();
  const child = spawnSync(
    process.execPath,
    [path.join(repoRoot, run.driver), ...run.args],
    {
      cwd: repoRoot,
      env: buildClaudeMatrixChildEnv(process.env, run.env),
      encoding: 'utf8',
      timeout: 15 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  const logPath = path.join(
    runnerPrivateDir,
    `${run.versionKey}-${run.scenarioId}-${run.repeatIndex}.log`,
  );
  fs.writeFileSync(
    logPath,
    `${child.stdout || ''}${child.stderr || ''}`,
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.chmodSync(logPath, 0o600);

  let status = child.error
    ? 'BLOCKED'
    : child.status === 0
      ? 'PASS'
      : child.status === MATRIX_NOT_APPLICABLE_EXIT_CODE
        ? 'NOT-APPLICABLE'
        : 'FAIL';
  const sanitizedResultPath = path.join(
    resolvedArtifactBaseDir,
    run.env.CLAUDE_GATE_RUN_ID,
    'sanitized-result.json',
  );
  const privateArtifactDir = path.join(
    resolvedArtifactBaseDir,
    run.env.CLAUDE_GATE_RUN_ID,
    'raw-private',
  );
  let sanitizedResult = null;
  let artifactValidation = {
    pass: false,
    reasons: ['child did not exit successfully'],
  };
  if (!child.error && fs.existsSync(sanitizedResultPath)) {
    try {
      sanitizedResult = JSON.parse(fs.readFileSync(sanitizedResultPath, 'utf8'));
      artifactValidation = evaluateMatrixRunResult({
        run,
        result: sanitizedResult,
        privateArtifactDir,
      });
    } catch {
      artifactValidation = {
        pass: false,
        reasons: ['sanitized result is malformed'],
      };
    }
  } else if (!child.error && ['PASS', 'NOT-APPLICABLE'].includes(status)) {
    artifactValidation = {
      pass: false,
      reasons: ['sanitized result is missing'],
    };
  }
  if (
    ['PASS', 'NOT-APPLICABLE'].includes(status)
    && (!artifactValidation.pass || sanitizedResult?.status !== status)
  ) {
    status = 'BLOCKED';
  }

  let pairComparison = null;
  const scenario = scenarios.get(run.scenarioId);
  if (status === 'PASS') {
    if (!evidenceByScenario.has(run.scenarioId)) {
      evidenceByScenario.set(run.scenarioId, {
        old: [],
        candidate: [],
        sameVersion: {
          old: null,
          candidate: null,
        },
        expectations: {
          old: null,
          candidate: null,
        },
      });
    }
    const evidence = evidenceByScenario.get(run.scenarioId);
    evidence[run.versionKey].push(sanitizedResult);
    evidence.expectations[run.versionKey] = run.expectations;
  }
  const evidence = evidenceByScenario.get(run.scenarioId);
  if (
    status === 'PASS'
    && !scenario.candidateOnly
    && evidence[run.versionKey].length === run.repeatCount
  ) {
    const versionComparison = evaluateMatrixVersionEvidence({
      scenario,
      versionKey: run.versionKey,
      results: evidence[run.versionKey],
      expectations: run.expectations,
    });
    evidence.sameVersion[run.versionKey] = versionComparison;
    if (versionComparison.comparisons.length > 0) {
      pairComparison = versionComparison;
    }
    if (!versionComparison.pass) status = 'FAIL';
  }
  if (
    status === 'PASS'
    && run.versionKey === 'candidate'
    && !scenario.candidateOnly
    && !onlyVersion
    && evidence.candidate.length === run.repeatCount
  ) {
    if (
      evidence.old.length !== run.repeatCount
      || evidence.sameVersion.old?.pass !== true
    ) {
      status = 'BLOCKED';
      pairComparison = {
        pass: false,
        comparisons: [{
          id: 'matching-old-evidence',
          pass: false,
          differences: ['matching old evidence is missing'],
        }],
      };
    } else {
      const crossVersionComparison = evaluateMatrixCrossVersionEvidence({
        scenario,
        oldResults: evidence.old,
        candidateResults: evidence.candidate,
        oldExpectations: evidence.expectations.old,
        candidateExpectations: evidence.expectations.candidate,
      });
      pairComparison = {
        pass: crossVersionComparison.pass,
        comparisons: [
          ...(pairComparison?.comparisons || []),
          ...crossVersionComparison.comparisons,
        ],
      };
      if (!pairComparison.pass) status = 'FAIL';
    }
  }
  summary.results.push({
    id: run.id,
    runId: run.env.CLAUDE_GATE_RUN_ID,
    status,
    exitCode: child.status,
    elapsedMs,
    driver: run.driver,
    args: run.args,
    cost: run.cost,
    oracle: run.oracle,
    artifactCollector: run.artifactCollector,
    artifactValidation,
    pairComparison,
    ...(run.maxBridgeReadyToMcpReadyMs !== undefined && {
      startupHandshake: sanitizedResult?.startupHandshake || null,
    }),
  });
  console.log(`[${index + 1}/${runs.length}] ${run.id} ${status} (${elapsedMs} ms)`);
  if (!['PASS', 'NOT-APPLICABLE'].includes(status)) break;
}

summary.completedRunCount = summary.results.length;
summary.passCount = summary.results.filter(({ status }) => status === 'PASS').length;
summary.notApplicableCount = summary.results.filter(
  ({ status }) => status === 'NOT-APPLICABLE',
).length;
summary.failCount = summary.results.filter(({ status }) => status === 'FAIL').length;
summary.blockedCount = summary.results.filter(({ status }) => status === 'BLOCKED').length;
summary.maxBridgeReadyToMcpReadyMs = summary.results.reduce(
  (maximum, result) => Math.max(
    maximum,
    result.startupHandshake?.bridgeReadyToMcpReadyMs ?? 0,
  ),
  0,
);
summary.status = (
  summary.completedRunCount === summary.selectedRunCount
  && summary.passCount + summary.notApplicableCount === summary.selectedRunCount
) ? 'PASS' : 'FAIL';
const summaryPath = path.join(
  resolvedArtifactBaseDir,
  `${runPrefix}-matrix-summary.json`,
);
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
fs.chmodSync(summaryPath, 0o600);

console.log(
  `matrix ${summary.status}: ${summary.passCount}/${summary.selectedRunCount} PASS`
    + (summary.notApplicableCount > 0
      ? `, ${summary.notApplicableCount} NOT-APPLICABLE`
      : ''),
);
process.exit(summary.status === 'PASS' ? 0 : 1);

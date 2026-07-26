import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { encodeCwd } = require('../../lib/util/claude-session-jsonl');

const RUN_PREFIX_RE = /^[A-Za-z0-9._-]{1,96}$/;

export function assertSafeRunPrefix(runPrefix) {
  if (!RUN_PREFIX_RE.test(runPrefix || '') || /^\.+$/.test(runPrefix)) {
    throw new TypeError('unsafe run prefix');
  }
  return runPrefix;
}

export function buildClaudeMatrixRuns({
  manifest,
  binaries,
  artifactBaseDir,
  runPrefix,
}) {
  if (!manifest?.versions || !Array.isArray(manifest?.scenarios)) {
    throw new TypeError('manifest must contain versions and scenarios');
  }
  if (!path.isAbsolute(artifactBaseDir || '')) {
    throw new TypeError('artifactBaseDir must be absolute');
  }
  assertSafeRunPrefix(runPrefix);
  for (const versionKey of ['old', 'candidate']) {
    if (!path.isAbsolute(binaries?.[versionKey] || '')) {
      throw new TypeError(`${versionKey} binary must be absolute`);
    }
  }

  const runs = [];
  for (const versionKey of ['old', 'candidate']) {
    for (const scenario of manifest.scenarios) {
      if (versionKey === 'old' && scenario.candidateOnly) continue;
      const runId = `${runPrefix}-${versionKey}-${scenario.id}`;
      runs.push({
        id: `${versionKey}:${scenario.id}`,
        versionKey,
        scenarioId: scenario.id,
        version: manifest.versions[versionKey],
        model: versionKey === 'candidate' && scenario.candidateOnly
          ? scenario.environment?.candidate?.CLAUDE_GATE_MODEL
            || manifest.comparator.model
          : manifest.comparator.model,
        expectedResolvedModel: scenario.expectedResolvedModel
          || manifest.comparator.model,
        effort: manifest.comparator.effort,
        driver: scenario.driver,
        args: [...(scenario.args?.[versionKey] || [])],
        env: {
          CLAUDE_GATE_BIN: binaries[versionKey],
          CLAUDE_GATE_EXPECTED_VERSION: manifest.versions[versionKey],
          CLAUDE_GATE_ARTIFACT_BASE: artifactBaseDir,
          CLAUDE_GATE_RUN_ID: runId,
          CLAUDE_GATE_MODEL: manifest.comparator.model,
          CLAUDE_GATE_EFFORT: manifest.comparator.effort,
          CLAUDE_GATE_SCENARIO_ID: scenario.id,
          ...(scenario.environment?.common || {}),
          ...(scenario.environment?.[versionKey] || {}),
          ...(versionKey === 'candidate' && scenario.expectedResolvedModel && {
            CLAUDE_GATE_EXPECTED_RESOLVED_MODEL: scenario.expectedResolvedModel,
          }),
          ...(versionKey === 'candidate' && scenario.documentedWorkflowSizeGuideline && {
            CLAUDE_GATE_DOCUMENTED_WORKFLOW_SIZE_GUIDELINE:
              scenario.documentedWorkflowSizeGuideline,
          }),
        },
        cost: scenario.cost,
        oracle: scenario.oracle[versionKey],
        artifactCollector: scenario.artifactCollector,
      });
    }
  }
  return runs;
}

function fieldAt(value, dottedPath) {
  return dottedPath.split('.').reduce(
    (current, part) => current?.[part],
    value,
  );
}

function hasFieldAt(value, dottedPath) {
  let current = value;
  for (const part of dottedPath.split('.')) {
    if (
      !current
      || typeof current !== 'object'
      || !Object.hasOwn(current, part)
    ) {
      return false;
    }
    current = current[part];
  }
  return true;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function summarizeLifecycleShape(lifecycle) {
  const streams = Array.isArray(lifecycle)
    ? [['default', lifecycle]]
    : lifecycle && typeof lifecycle === 'object'
      ? Object.entries(lifecycle)
        .filter(([, records]) => Array.isArray(records))
        .sort(([left], [right]) => left.localeCompare(right))
      : [];
  if (streams.length === 0) return null;

  return Object.fromEntries(streams.map(([name, records]) => {
    const canonicalRecords = records.map(canonicalValue);
    const shapeCounts = new Map();
    for (const record of canonicalRecords) {
      const encoded = JSON.stringify(record);
      shapeCounts.set(encoded, (shapeCounts.get(encoded) || 0) + 1);
    }
    const recordShapeCounts = [...shapeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([record, count]) => ({
        record: JSON.parse(record),
        count,
      }));
    const pivotalSequence = canonicalRecords.filter((record) => (
      record?.type === 'hook'
      || record?.type === 'queue-operation'
      || record?.type === 'attachment'
      || (record?.type === 'system' && record.subtype !== 'init')
      || (
        record?.type === 'user'
        && (
          record.hasTaskNotification
          || record.originKind
          || record.promptSource
        )
      )
    ));
    return [name, { recordShapeCounts, pivotalSequence }];
  }));
}

function lifecycleRecords(lifecycle) {
  if (Array.isArray(lifecycle)) return lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object') return [];
  return Object.values(lifecycle).flatMap((records) => (
    Array.isArray(records) ? records : []
  ));
}

export function evaluateMatrixRunResult({ run, result }) {
  const reasons = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    reasons.push('sanitized result is missing or malformed');
  } else {
    if (result.evidenceSchemaVersion !== 1) {
      reasons.push('sanitized result schema version is not recognized');
    }
    if (result.matrixScenario !== run.scenarioId) {
      reasons.push('sanitized result scenario does not match the matrix cell');
    }
    if (result.status !== 'PASS') {
      reasons.push('sanitized result did not report PASS');
    }
    if (result.attestation?.version !== run.version) {
      reasons.push('sanitized result version does not match the matrix cell');
    }
    if (result.attestation?.model !== run.model) {
      reasons.push('sanitized result configured model does not match the matrix cell');
    }
    if (result.attestation?.effort !== run.effort) {
      reasons.push('sanitized result effort does not match the matrix cell');
    }
    if (result.resolvedModel !== (run.expectedResolvedModel || run.model)) {
      reasons.push('sanitized result observed model does not match the matrix cell');
    }
    const records = lifecycleRecords(result.lifecycle);
    if (records.length === 0) {
      reasons.push('sanitized lifecycle evidence is missing');
    } else if (records.some((record) => (
      !record
      || typeof record !== 'object'
      || record.type === 'unknown'
      || record.type === 'malformed'
    ))) {
      reasons.push('sanitized lifecycle evidence contains an unknown schema');
    }
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}

export function evaluateMatrixEvidencePair({
  scenario,
  oldResult,
  candidateResult,
}) {
  const differences = [];
  for (const field of scenario?.comparison?.equalFields || []) {
    const oldValue = fieldAt(oldResult, field);
    const candidateValue = fieldAt(candidateResult, field);
    if (
      !hasFieldAt(oldResult, field)
      || !hasFieldAt(candidateResult, field)
      || JSON.stringify(oldValue) !== JSON.stringify(candidateValue)
    ) {
      differences.push(field);
    }
  }
  if (scenario?.comparison?.lifecycle === 'shape-equal') {
    const oldLifecycle = summarizeLifecycleShape(oldResult?.lifecycle);
    const candidateLifecycle = summarizeLifecycleShape(candidateResult?.lifecycle);
    if (
      oldLifecycle === null
      || candidateLifecycle === null
      || JSON.stringify(oldLifecycle) !== JSON.stringify(candidateLifecycle)
    ) {
      differences.push('lifecycle');
    }
  }
  return {
    pass: differences.length === 0,
    differences,
  };
}

function resolveThroughExistingAncestor(targetPath) {
  let current = path.resolve(targetPath);
  const missingParts = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingParts.unshift(path.basename(current));
    current = parent;
  }
  const existingBase = fs.existsSync(current)
    ? fs.realpathSync(current)
    : current;
  return path.join(existingBase, ...missingParts);
}

function assertContained(baseDir, targetPath) {
  const resolvedBase = resolveThroughExistingAncestor(baseDir);
  const resolvedTarget = resolveThroughExistingAncestor(targetPath);
  if (
    resolvedTarget === resolvedBase
    || !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)
  ) {
    throw new Error('gate artifact target escapes the dedicated artifact base');
  }
  return resolvedTarget;
}

function collectSessionProjectCwds(runDir) {
  const cwds = [];
  const pending = [runDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current)) {
      const target = path.join(current, entry);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw new Error('refusing to inspect a symlinked gate artifact');
      }
      if (stat.isDirectory()) {
        pending.push(target);
      } else if (stat.isFile() && entry === 'session-projects.json') {
        const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (
          manifest?.schemaVersion !== 1
          || !Array.isArray(manifest.cwds)
          || manifest.cwds.some((cwd) => typeof cwd !== 'string')
        ) {
          throw new Error('session project manifest is malformed');
        }
        cwds.push(...manifest.cwds);
      }
    }
  }
  return cwds;
}

export function purgeAcceptedGateArtifacts({
  artifactBaseDir,
  runPrefix,
  summary,
  claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects'),
}) {
  assertSafeRunPrefix(runPrefix);
  if (!path.isAbsolute(claudeProjectsDir || '')) {
    throw new TypeError('Claude projects directory must be absolute');
  }
  if (
    summary?.authoritative !== true
    || summary?.status !== 'PASS'
    || summary?.runPrefix !== runPrefix
    || summary?.passCount !== summary?.selectedRunCount
    || !Array.isArray(summary?.results)
    || summary.results.length !== summary.selectedRunCount
    || summary.results.some((result) => result.status !== 'PASS')
  ) {
    throw new Error('only a complete authoritative PASS may purge private artifacts');
  }

  const baseStat = fs.lstatSync(artifactBaseDir);
  if (
    baseStat.isSymbolicLink()
    || !baseStat.isDirectory()
    || (baseStat.mode & 0o777) !== 0o700
  ) {
    throw new Error('artifact base must be a private real directory');
  }
  if (fs.existsSync(claudeProjectsDir)) {
    const projectsStat = fs.lstatSync(claudeProjectsDir);
    if (projectsStat.isSymbolicLink() || !projectsStat.isDirectory()) {
      throw new Error('Claude projects directory must be a real directory');
    }
  }
  const realClaudeProjectsDir = fs.existsSync(claudeProjectsDir)
    ? fs.realpathSync(claudeProjectsDir)
    : path.resolve(claudeProjectsDir);

  const cleanupPlans = [];
  const sourceProjectDirs = new Set();
  for (const result of summary.results) {
    if (
      !RUN_PREFIX_RE.test(result.runId || '')
      || !result.runId.startsWith(`${runPrefix}-`)
    ) {
      throw new Error('summary contains an unsafe run id');
    }
    const runDir = assertContained(artifactBaseDir, path.join(
      artifactBaseDir,
      result.runId,
    ));
    if (!fs.existsSync(runDir)) {
      throw new Error('run artifact directory must be a real directory');
    }
    const runStat = fs.lstatSync(runDir);
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
      throw new Error('run artifact directory must be a real directory');
    }
    const sanitizedResultPath = assertContained(
      artifactBaseDir,
      path.join(runDir, 'sanitized-result.json'),
    );
    if (!fs.existsSync(sanitizedResultPath)) {
      throw new Error('sanitized result must exist before private evidence is purged');
    }
    const sanitizedStat = fs.lstatSync(sanitizedResultPath);
    if (sanitizedStat.isSymbolicLink() || !sanitizedStat.isFile()) {
      throw new Error('sanitized result must be a regular file');
    }
    const sanitizedResult = JSON.parse(
      fs.readFileSync(sanitizedResultPath, 'utf8'),
    );
    if (sanitizedResult?.status !== 'PASS') {
      throw new Error('sanitized result must report PASS before private evidence is purged');
    }
    for (const cwd of collectSessionProjectCwds(runDir)) {
      const gateCwd = assertContained(runDir, cwd);
      const projectDir = assertContained(
        realClaudeProjectsDir,
        path.join(realClaudeProjectsDir, encodeCwd(gateCwd)),
      );
      if (!fs.existsSync(projectDir)) continue;
      const projectStat = fs.lstatSync(projectDir);
      if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
        throw new Error('Claude session project must be a real directory');
      }
      sourceProjectDirs.add(projectDir);
    }
    const targets = [];
    for (const entry of fs.readdirSync(runDir)) {
      if (entry === 'sanitized-result.json') continue;
      const target = assertContained(artifactBaseDir, path.join(runDir, entry));
      if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error('refusing to purge a symlinked private artifact');
      }
      targets.push(target);
    }
    cleanupPlans.push(targets);
  }

  const runnerPrivateDir = assertContained(
    artifactBaseDir,
    path.join(artifactBaseDir, `${runPrefix}-runner-private`),
  );
  if (fs.existsSync(runnerPrivateDir)) {
    if (fs.lstatSync(runnerPrivateDir).isSymbolicLink()) {
      throw new Error('refusing to purge a symlinked runner artifact');
    }
  }

  for (const projectDir of sourceProjectDirs) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  for (const targets of cleanupPlans) {
    for (const target of targets) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  if (fs.existsSync(runnerPrivateDir)) {
    fs.rmSync(runnerPrivateDir, { recursive: true, force: true });
  }
}

'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const defaultManifest = require('../scripts/spikes/claude-2.1.283-matrix.json');

test('candidate discovery preserves the old baseline without inheriting its opt-in waiver', async () => {
  const { buildClaudeMatrixRuns, matrixWaivedCells } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const manifest = require('../scripts/spikes/claude-2.1.322-discovery.json');
  assert.equal(manifest.validationStage, 'discovery');
  assert.equal(manifest.sdkVersion, defaultManifest.sdkVersion);
  assert.deepEqual(manifest.expectations['2.1.283'], defaultManifest.expectations['2.1.283']);
  assert.equal(manifest.expectations['2.1.220'], undefined);
  assert.equal(manifest.expectations['2.1.322'].delayedMcpModes.autoBackground, 'background');
  const runs = buildClaudeMatrixRuns({ manifest, binaries: { old: '/old', candidate: '/candidate' }, artifactBaseDir: '/artifacts', runPrefix: 'discovery-count' });
  assert.equal(runs.filter((run) => run.versionKey === 'candidate').length, 13);
  assert.equal(runs.length, 23);
  assert.equal(matrixWaivedCells(manifest).length, 1);
});

test('selected manifest expectations are read from the exact selected bytes', async (t) => {
  const { readGateExpectations } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'selected.json');
  const manifest = structuredClone(defaultManifest);
  manifest.expectations['2.1.322'] = structuredClone(manifest.expectations['2.1.283']);
  const text = JSON.stringify(manifest);
  fs.writeFileSync(manifestPath, text);
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  assert.deepEqual(readGateExpectations('2.1.322', { manifestPath, expectedManifestSha256: sha }), manifest.expectations['2.1.322']);
  assert.throws(() => readGateExpectations('2.1.322', { manifestPath, expectedManifestSha256: 'f'.repeat(64) }), /manifest changed/);
  assert.throws(() => readGateExpectations('2.1.322', { manifestPath: 'relative.json' }), /absolute/);
});

test('discovery cannot authorize acceptance or unfiltered execution', async () => {
  const { assertClaudeMatrixMode } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  assert.equal(assertClaudeMatrixMode(defaultManifest, {}), 'acceptance');
  assert.equal(assertClaudeMatrixMode({ validationStage: 'acceptance' }, {}), 'acceptance');
  assert.equal(assertClaudeMatrixMode({ validationStage: 'discovery' }, { onlyVersion: 'candidate' }), 'discovery');
  for (const options of [{}, { onlyVersion: 'old' }, { onlyVersion: 'candidate', accepting: true }]) {
    assert.throws(() => assertClaudeMatrixMode({ validationStage: 'discovery' }, options), /discovery/);
  }
  assert.throws(() => assertClaudeMatrixMode({ validationStage: 'unknown' }, {}), /validationStage/);
  assert.throws(() => assertClaudeMatrixMode({ validationStage: null }, {}), /validationStage/);
});

test('manifest selection is runner-owned and cannot be changed by a scenario', async () => {
  const { buildClaudeMatrixRuns } = await import('../scripts/spikes/claude-gate-matrix.mjs');
  const manifest = structuredClone(defaultManifest);
  manifest.scenarios[0].environment.common.CLAUDE_GATE_MANIFEST_PATH = '/other.json';
  assert.throws(() => buildClaudeMatrixRuns({ manifest, binaries: { old: '/old', candidate: '/candidate' }, artifactBaseDir: '/artifacts', runPrefix: 'protected-manifest' }), /CLAUDE_GATE_MANIFEST_PATH.*runner-owned/);
});

test('runner refuses discovery acceptance and unfiltered runs before artifact creation or binary execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'discovery.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...defaultManifest, validationStage: 'discovery' }));
  const artifacts = path.join(root, 'not-created');
  const runner = path.resolve(__dirname, '../scripts/spikes/run-claude-gate-matrix.mjs');
  for (const extra of [[], ['--accept-run', 'never'], ['--version', 'old'], ['--version', 'candidate', '--accept-run']]) {
    const child = spawnSync(process.execPath, [runner, '--manifest', manifestPath, '--old-bin', '/does-not-exist', '--candidate-bin', '/does-not-exist', '--artifact-base', artifacts, ...extra], { encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /discovery/);
    assert.equal(fs.existsSync(artifacts), false);
  }
});

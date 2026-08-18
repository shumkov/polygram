'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HOOK_RUNTIME_RELATIVE_PATH,
  installHookArtifactVersion,
} = require('../lib/codex/hook-artifacts');
const {
  CAPTURE_DIRECTORY,
  HOOK_EVENTS,
  prepareHookRuntime,
  reattestHookRuntime,
  renderTrustTables,
} = require('../lib/codex/hook-runtime');

const BASE_CONFIG = Object.freeze({ marker: 'base' });
const BASE_RAW = 'marker = "base"\n';
const HOOK_TEST_ROOT = process.env.POLYGRAM_HOOK_TEST_ROOT ?? os.homedir();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(
    path.join(HOOK_TEST_ROOT, '.polygram-hook-runtime-'),
  ));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o755);
  const artifactRoot = path.join(root, 'artifacts');
  const runtimeRoot = path.join(root, 'runtimes');
  const runtimeId = 'node-24.4.0';
  const runtimeDirectory = path.join(runtimeRoot, runtimeId, 'bin');
  const codexHome = path.join(root, 'codex-home');
  const workspace = path.join(root, 'workspace');
  for (const directory of [artifactRoot, runtimeRoot, codexHome, workspace]) {
    mkdirSync(directory, { recursive: true });
    chmodSync(directory, directory === codexHome || directory === workspace
      ? 0o700
      : 0o755);
  }
  mkdirSync(runtimeDirectory, { recursive: true });
  for (const directory of [
    path.join(runtimeRoot, runtimeId),
    runtimeDirectory,
  ]) chmodSync(directory, 0o755);
  const runtimePath = path.join(
    runtimeRoot,
    runtimeId,
    HOOK_RUNTIME_RELATIVE_PATH,
  );
  writeFileSync(runtimePath, '#!/bin/sh\nexit 0\n');
  chmodSync(runtimePath, 0o755);
  const runtimeSha256 = sha256(readFileSync(runtimePath));
  const operatorUid = process.getuid();
  const serviceUid = operatorUid + 1;
  const version = '1.0.0';
  installHookArtifactVersion({
    artifactRoot,
    version,
    runtimeRoot,
    runtimeId,
    operatorUid,
    serviceUid,
    expectedRuntimeSha256: runtimeSha256,
  });
  const hookOptions = {
    artifactRoot,
    enabled: true,
    operatorUid,
    runtimeId,
    runtimeRoot,
    runtimeSha256,
    serviceUid,
    version,
  };
  const renderOwnedConfig = (config) => (
    `${BASE_RAW}${renderTrustTables(config)}`
  );
  return {
    codexHome,
    hookOptions,
    renderOwnedConfig,
    workspace,
  };
}

function discovery(manifest) {
  return manifest.entries.map((entry) => ({
    ordinal: entry.ordinal,
    currentHash: `sha256:${String(entry.ordinal + 1).repeat(64)}`,
    trustStatus: 'untrusted',
    enabled: true,
  }));
}

test('hooks-enabled prepare discovers once, installs trust, and reattests', async (t) => {
  const f = fixture(t);
  const calls = [];
  const result = await prepareHookRuntime({
    hookOptions: f.hookOptions,
    codexHome: f.codexHome,
    workspace: f.workspace,
    baseOwnedConfig: BASE_CONFIG,
    baseRawConfig: BASE_RAW,
    renderOwnedConfig: f.renderOwnedConfig,
    async verifyDiscovery(manifest, expectedConfigSha256) {
      calls.push({ manifest, expectedConfigSha256 });
      return discovery(manifest);
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedConfigSha256, sha256(BASE_RAW));
  assert.deepEqual(
    result.hookManifest.entries.map(({ event }) => event),
    HOOK_EVENTS.map(({ event }) => event),
  );
  assert.match(result.rawConfig, /^\[hooks\.state\./m);
  assert.equal(
    readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'),
    result.rawConfig,
  );
  const hooksJson = JSON.parse(
    readFileSync(path.join(f.codexHome, 'hooks.json'), 'utf8'),
  );
  for (const { configName } of HOOK_EVENTS) {
    assert.match(
      hooksJson.hooks[configName][0].hooks[0].command,
      new RegExp(`'${configName}' '${CAPTURE_DIRECTORY}'$`),
    );
  }
  assert.equal(existsSync(path.join(f.codexHome, '.polygram-hooks.lock')), false);
  assert.doesNotThrow(() => reattestHookRuntime({
    hookOptions: f.hookOptions,
    codexHome: f.codexHome,
    workspace: f.workspace,
    expected: result,
  }));

  const second = await prepareHookRuntime({
    hookOptions: f.hookOptions,
    codexHome: f.codexHome,
    workspace: f.workspace,
    baseOwnedConfig: BASE_CONFIG,
    baseRawConfig: BASE_RAW,
    renderOwnedConfig: f.renderOwnedConfig,
    async verifyDiscovery() {
      throw new Error('trusted state must not rediscover');
    },
  });
  assert.equal(second.rawConfig, result.rawConfig);
  assert.equal(second.hookArtifactsSha256, result.hookArtifactsSha256);
});

test('disabled desired state completes a partial or trusted rollback', async (t) => {
  const f = fixture(t);
  await prepareHookRuntime({
    hookOptions: f.hookOptions,
    codexHome: f.codexHome,
    workspace: f.workspace,
    baseOwnedConfig: BASE_CONFIG,
    baseRawConfig: BASE_RAW,
    renderOwnedConfig: f.renderOwnedConfig,
    verifyDiscovery: async (manifest) => discovery(manifest),
  });

  const disabled = await prepareHookRuntime({
    hookOptions: { ...f.hookOptions, enabled: false },
    codexHome: f.codexHome,
    workspace: f.workspace,
    baseOwnedConfig: BASE_CONFIG,
    baseRawConfig: BASE_RAW,
    renderOwnedConfig: f.renderOwnedConfig,
    async verifyDiscovery() {
      throw new Error('rollback must not discover');
    },
  });

  assert.equal(disabled.hookManifest, null);
  assert.equal(readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), BASE_RAW);
  assert.equal(existsSync(path.join(f.codexHome, 'hooks.json')), false);
});

test('unknown on-disk hook state fails without overwriting it', async (t) => {
  const f = fixture(t);
  const configPath = path.join(f.codexHome, 'config.toml');
  writeFileSync(configPath, 'foreign = true\n', { mode: 0o600 });

  await assert.rejects(
    prepareHookRuntime({
      hookOptions: f.hookOptions,
      codexHome: f.codexHome,
      workspace: f.workspace,
      baseOwnedConfig: BASE_CONFIG,
      baseRawConfig: BASE_RAW,
      renderOwnedConfig: f.renderOwnedConfig,
      verifyDiscovery: async () => [],
    }),
    { code: 'CODEX_OWNED_HOOKS_DRIFT' },
  );
  assert.equal(readFileSync(configPath, 'utf8'), 'foreign = true\n');
});

test('an existing home lock stops a second provisioner', async (t) => {
  const f = fixture(t);
  writeFileSync(
    path.join(f.codexHome, '.polygram-hooks.lock'),
    'another-provisioner\n',
    { mode: 0o600 },
  );
  await assert.rejects(
    prepareHookRuntime({
      hookOptions: f.hookOptions,
      codexHome: f.codexHome,
      workspace: f.workspace,
      baseOwnedConfig: BASE_CONFIG,
      baseRawConfig: BASE_RAW,
      renderOwnedConfig: f.renderOwnedConfig,
      verifyDiscovery: async () => [],
    }),
    { code: 'CODEX_HOOK_PROVISION_LOCKED' },
  );
});

'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  collectCodexDoctorChecks,
} = require('../lib/codex/diagnostics');

const PINNED_VERSION = 'codex-cli 0.145.0';
const PINNED_SHA256 =
  '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590';
const SCHEMA_SHA256 =
  '1bc09dedc506075562d4d49b702ecab6d947dd5a8c2a9014a5cde592a0938efb';
const PINNED_TARGET = 'aarch64-apple-darwin';

function createDeployment(t, lease = null) {
  const root = realpathSync(
    mkdtempSync(path.join(os.homedir(), '.polygram-doctor-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const codexHome = path.join(root, 'codex-home');
  const codexTmp = path.join(root, 'codex-tmp');
  const ipcRuntimeDir = path.join(root, 'polygram-ipc');
  const workspace = path.join(root, 'workspace');
  const binary = path.join(root, 'codex');
  for (const directory of [codexHome, codexTmp, ipcRuntimeDir, workspace]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'default_permissions = "polygram-session"',
      'approval_policy = "never"',
      'web_search = "disabled"',
      '',
      '[permissions."polygram-session".filesystem]',
      `${JSON.stringify(codexTmp)} = "deny"`,
      '',
      '[permissions."polygram-session".network]',
      'enabled = false',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(codexHome, 'auth.json'),
    '{"credential":"must-never-appear"}\n',
    { mode: 0o600 },
  );

  const db = {
    prepare(sql) {
      assert.match(sql, /codex_daemon_lease/);
      return { get: () => lease };
    },
  };
  const config = {
    codex: { home: codexHome, binary },
    chats: {
      100: {
        bot: 'test-bot',
        pm: 'codex',
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'xhigh',
        cwd: workspace,
      },
    },
  };
  const dependencies = {
    resolveBinary: async ({ binaryPath }) => {
      assert.equal(binaryPath, binary);
      return {
        path: binary,
        target: PINNED_TARGET,
        version: PINNED_VERSION,
        sha256: PINNED_SHA256,
      };
    },
    resolveHostIdentity: () => ({
      stableHostId: `host:${'a'.repeat(64)}`,
      bootSessionId: `boot:${'b'.repeat(64)}`,
    }),
    protocolSchema: {
      cliVersion: PINNED_VERSION,
      binarySha256: PINNED_SHA256,
      binarySha256ByTarget: {
        [PINNED_TARGET]: PINNED_SHA256,
      },
      generatedProtocolV2CanonicalSha256: SCHEMA_SHA256,
    },
    resolveTargetPin: () => Object.freeze({
      target: PINNED_TARGET,
      cliVersion: PINNED_VERSION,
      binarySha256: PINNED_SHA256,
    }),
    temporaryRoots: [],
    ipcTemporaryRoots: [],
    resolveIpcRuntimeDirectory: () => ipcRuntimeDir,
    genericCodexHome: path.join(root, 'interactive-codex-home'),
  };
  return {
    binary,
    codexHome,
    codexTmp,
    ipcRuntimeDir,
    workspace,
    config,
    db,
    dependencies,
    processEnv: {
      HOME: root,
      TMPDIR: path.join(root, 'inherited-tmp'),
      POLYGRAM_CODEX_TMPDIR: codexTmp,
    },
  };
}

test('offline Codex doctor verifies the local pin, home, profile, identity, and clear lease', async (t) => {
  const deployment = createDeployment(t);
  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });
  const statuses = Object.fromEntries(
    checks.map(({ name, status }) => [name, status]),
  );

  assert.deepEqual(statuses, {
    'codex-binary': 'ok',
    'codex-home': 'ok',
    'codex-protocol': 'ok',
    'codex-profile': 'ok',
    'codex-ipc-root': 'ok',
    'codex-tmpdir': 'ok',
    'codex-model-catalog': 'warn',
    'codex-identity': 'ok',
    'codex-lease': 'ok',
    'codex-native-background': 'warn',
  });

  const rendered = JSON.stringify(checks);
  assert.doesNotMatch(rendered, new RegExp(deployment.binary));
  assert.doesNotMatch(rendered, new RegExp(deployment.codexHome));
  assert.doesNotMatch(rendered, /must-never-appear/);
  assert.doesNotMatch(rendered, /host:a+|boot:b+/);
  assert.ok(
    checks.every(({ detail }) => Buffer.byteLength(detail, 'utf8') <= 256),
    'every diagnostic detail is bounded',
  );
  assert.equal(
    checks.find(({ name }) => name === 'codex-binary').extra.target,
    PINNED_TARGET,
  );
});

test('doctor rejects an opposite-target binary receipt', async (t) => {
  const deployment = createDeployment(t);
  deployment.dependencies.resolveBinary = async () => ({
    path: deployment.binary,
    target: 'x86_64-unknown-linux-musl',
    version: PINNED_VERSION,
    sha256: PINNED_SHA256,
  });

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });

  assert.equal(
    checks.find(({ name }) => name === 'codex-binary').status,
    'fail',
  );
});

test('doctor rejects a protocol map that drifts from the selected target', async (t) => {
  const deployment = createDeployment(t);
  deployment.dependencies.protocolSchema.binarySha256ByTarget[PINNED_TARGET] =
    '0'.repeat(64);

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });

  assert.equal(
    checks.find(({ name }) => name === 'codex-protocol').status,
    'fail',
  );
});

test('unsafe Codex temp roots fail closed without exposing their path', async (t) => {
  const deployment = createDeployment(t);
  chmodSync(deployment.codexTmp, 0o755);

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });
  const temp = checks.find(({ name }) => name === 'codex-tmpdir');

  assert.equal(temp.status, 'fail');
  assert.doesNotMatch(
    JSON.stringify(temp),
    new RegExp(deployment.codexTmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('Codex temp is not reported protected when its profile deny is missing', async (t) => {
  const deployment = createDeployment(t);
  writeFileSync(
    path.join(deployment.codexHome, 'config.toml'),
    [
      'default_permissions = "polygram-session"',
      'approval_policy = "never"',
      'web_search = "disabled"',
      '',
      '[permissions."polygram-session".network]',
      'enabled = false',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });
  const temp = checks.find(({ name }) => name === 'codex-tmpdir');

  assert.equal(temp.status, 'fail');
  assert.equal(temp.extra.protected, false);
});

test('Codex temp overlap is found through bot selection and default cwd inheritance', async (t) => {
  const deployment = createDeployment(t);
  delete deployment.config.chats[100].pm;
  delete deployment.config.chats[100].cwd;
  deployment.config.bots = {
    'test-bot': { pm: 'codex' },
  };
  deployment.config.defaults = {
    cwd: deployment.codexTmp,
  };

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });
  const temp = checks.find(({ name }) => name === 'codex-tmpdir');

  assert.equal(temp.status, 'fail');
  assert.equal(temp.extra.protected, false);
});

test('Codex temp overlap is found in a topic-specific cwd', async (t) => {
  const deployment = createDeployment(t);
  deployment.config.chats[100].topics = {
    7: {
      pm: 'codex',
      cwd: deployment.codexTmp,
    },
  };

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });
  const temp = checks.find(({ name }) => name === 'codex-tmpdir');

  assert.equal(temp.status, 'fail');
  assert.equal(temp.extra.protected, false);
});

test('Codex temp accepts an owned-profile parent deny that covers it', async (t) => {
  const deployment = createDeployment(t);
  const childTmp = path.join(deployment.codexTmp, 'app-server');
  mkdirSync(childTmp, { mode: 0o700 });
  chmodSync(childTmp, 0o700);
  deployment.processEnv.POLYGRAM_CODEX_TMPDIR = childTmp;

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });
  const temp = checks.find(({ name }) => name === 'codex-tmpdir');

  assert.equal(temp.status, 'ok');
  assert.equal(temp.extra.protected, true);
});

test('Codex temp inspection honors the configured permission profile', async (t) => {
  const deployment = createDeployment(t);
  deployment.dependencies.profileId = 'custom-session';
  writeFileSync(
    path.join(deployment.codexHome, 'config.toml'),
    [
      'default_permissions = "custom-session"',
      'approval_policy = "never"',
      'web_search = "disabled"',
      '',
      '[permissions."custom-session".filesystem]',
      `${JSON.stringify(deployment.codexTmp)} = "deny"`,
      '',
      '[permissions."custom-session".network]',
      'enabled = false',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });

  assert.equal(
    checks.find(({ name }) => name === 'codex-profile').status,
    'ok',
  );
  assert.equal(
    checks.find(({ name }) => name === 'codex-tmpdir').status,
    'ok',
  );
});

test('Codex temp rejects a deny forged under an indented unrelated TOML table', async (t) => {
  const deployment = createDeployment(t);
  writeFileSync(
    path.join(deployment.codexHome, 'config.toml'),
    [
      'default_permissions = "polygram-session"',
      'approval_policy = "never"',
      'web_search = "disabled"',
      '',
      '[permissions."polygram-session".network]',
      'enabled = false',
      '',
      '[permissions."polygram-session".filesystem]',
      '  [permissions."unrelated".filesystem]',
      `${JSON.stringify(deployment.codexTmp)} = "deny"`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
    processEnv: deployment.processEnv,
  });
  const temp = checks.find(({ name }) => name === 'codex-tmpdir');

  assert.equal(temp.status, 'fail');
  assert.equal(temp.extra.protected, false);
});

test('unsafe IPC runtime roots fail without exposing paths or raw errors', async (t) => {
  const deployment = createDeployment(t);
  const secretPath = '/private/tmp/polygram-secret-location';
  deployment.dependencies.resolveIpcRuntimeDirectory = () => {
    const error = new Error(`unsafe secret at ${secretPath}`);
    error.code = 'IPC_DIR_TEMPORARY';
    throw error;
  };

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
  });
  const ipc = checks.find(({ name }) => name === 'codex-ipc-root');

  assert.equal(ipc.status, 'fail');
  assert.equal(ipc.extra.code, 'IPC_DIR_TEMPORARY');
  assert.doesNotMatch(JSON.stringify(ipc), /private\/tmp|polygram-secret/);
});

test('quarantine is explicit, content-free, and requires a same-host reboot', async (t) => {
  const deployment = createDeployment(t, {
    generation_id: 'generation-secret-value',
    stable_host_id: `host:${'c'.repeat(64)}`,
    boot_session_id: `boot:${'d'.repeat(64)}`,
    status: 'quarantined',
    quarantine_reason: 'secret workspace path /Users/private/project',
  });
  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
  });
  const lease = checks.find(({ name }) => name === 'codex-lease');

  assert.equal(lease.status, 'fail');
  assert.match(lease.detail, /quarantine/i);
  assert.match(lease.detail, /same-host reboot required/i);
  assert.deepEqual(lease.extra, {
    runtime: 'codex',
    scope: 'daemon',
    status: 'quarantined',
    ownerPresent: true,
    rebootRequired: true,
    reasonCode: null,
  });
  assert.doesNotMatch(
    JSON.stringify(checks),
    /generation-secret-value|host:c+|boot:d+|Users\/private|workspace path/,
  );
});

test('an active lease reports one daemon-scoped owner without disclosing its identity', async (t) => {
  const deployment = createDeployment(t, {
    generation_id: 'generation-private',
    status: 'active',
    quarantine_reason: null,
  });
  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
  });
  const lease = checks.find(({ name }) => name === 'codex-lease');

  assert.equal(lease.status, 'warn');
  assert.deepEqual(lease.extra, {
    runtime: 'codex',
    scope: 'daemon',
    status: 'active',
    ownerPresent: true,
    rebootRequired: false,
  });
  assert.doesNotMatch(JSON.stringify(lease), /generation-private/);
});

test('unsafe CODEX_HOME and profile drift fail without leaking paths or file content', async (t) => {
  const deployment = createDeployment(t);
  chmodSync(deployment.codexHome, 0o755);
  writeFileSync(
    path.join(deployment.codexHome, 'config.toml'),
    'default_permissions = "dangerous-profile"\nsecret = "do-not-leak"\n',
    { mode: 0o600 },
  );

  const checks = await collectCodexDoctorChecks({
    config: deployment.config,
    db: deployment.db,
    dependencies: deployment.dependencies,
  });
  const home = checks.find(({ name }) => name === 'codex-home');
  const profile = checks.find(({ name }) => name === 'codex-profile');

  assert.equal(home.status, 'fail');
  assert.equal(profile.status, 'fail');
  assert.doesNotMatch(
    JSON.stringify(checks),
    /dangerous-profile|do-not-leak|polygram-doctor-/,
  );
});

test('an unconfigured Codex runtime produces one quiet disabled check', async () => {
  const checks = await collectCodexDoctorChecks({
    config: { bots: { test: {} } },
    db: null,
  });
  assert.deepEqual(checks, [{
    name: 'codex-runtime',
    status: 'ok',
    detail: 'not configured',
    extra: { runtime: 'codex', configured: false },
  }]);
});

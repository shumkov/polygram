'use strict';

const deployment = require('./helpers/codex-deployment');

const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  unlinkSync,
  symlinkSync,
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
  writeFileSync(path.join(workspace, 'AGENTS.md'), 'Synthetic root instructions', { mode: 0o600 });
  symlinkSync(path.join(workspace, 'AGENTS.md'), path.join(codexHome, 'AGENTS.md'));
  writeFileSync(path.join(codexHome, 'config.toml'), [
    'default_permissions = "polygram-trusted"',
    'model_provider = "cliproxyapi"',
    'approval_policy = "never"',
    'web_search = "live"',
    '[features]', 'goals = false',
    '[permissions."polygram-trusted".filesystem]', '":root" = "write"',
    '[permissions."polygram-trusted".network]', 'enabled = true',
    '[memories]', 'generate_memories = false', 'use_memories = false',
    '[model_providers.cliproxyapi]',
    ...Object.entries(deployment.provider).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), '',
  ].join('\n'), { mode: 0o600 });
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
    codex: { access: deployment.access, proxy: deployment.proxy, home: codexHome, binary },
    defaults: { codexEnabled: true },
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

test('CLIProxy trusted doctor accepts a home without native authentication or command denies', async (t) => {
  const deployment = createDeployment(t);
  const keyFile = path.join(deployment.codexHome, 'proxy.key');
  writeFileSync(keyFile, 'synthetic-doctor-key', { mode: 0o600 });
  deployment.config.codex.access = { mode: 'trusted', commandPath: '/usr/bin:/bin' };
  deployment.config.codex.proxy = { baseUrl: 'http://127.0.0.1:8318/v1', clientKeyFile: keyFile };
  unlinkSync(path.join(deployment.codexHome, 'auth.json'));
  writeFileSync(path.join(deployment.codexHome, 'config.toml'), [
    'default_permissions = "polygram-trusted"',
    'model_provider = "cliproxyapi"',
    'approval_policy = "never"',
    'web_search = "live"',
    '[features]', 'goals = false',
    '[permissions."polygram-trusted".filesystem]', '":root" = "write"',
    '[permissions."polygram-trusted".network]', 'enabled = true',
    '[memories]', 'generate_memories = false', 'use_memories = false',
    '[model_providers.cliproxyapi]',
    'name = "CLIProxyAPI"', 'base_url = "http://127.0.0.1:8318/v1"',
    'wire_api = "responses"', 'requires_openai_auth = false',
    'experimental_bearer_token = "synthetic-doctor-key"', 'supports_websockets = true', '',
  ].join('\n'), { mode: 0o600 });
  const checks = await collectCodexDoctorChecks({ config: deployment.config, db: deployment.db,
    dependencies: deployment.dependencies, processEnv: deployment.processEnv });
  for (const name of ['codex-home', 'codex-profile', 'codex-tmpdir']) {
    assert.equal(checks.find((check) => check.name === name).status, 'ok', name);
  }
  assert.doesNotMatch(JSON.stringify(checks), /synthetic-doctor-key|protected from commands/);
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

test('doctor rejects a managed Codex profile that exposes native goals', async (t) => {
  const deployment = createDeployment(t);
  writeFileSync(
    path.join(deployment.codexHome, 'config.toml'),
    [
      'default_permissions = "polygram-session"',
      'approval_policy = "never"',
      'web_search = "disabled"',
      '',
      '[permissions."polygram-session".filesystem]',
      `${JSON.stringify(deployment.codexTmp)} = "deny"`,
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

  assert.equal(
    checks.find(({ name }) => name === 'codex-profile').status,
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

test('doctor does not confuse private temp metadata with command sandbox isolation', async (t) => {
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

  assert.equal(temp.status, 'ok');
  assert.equal(temp.extra.ownerOnly, true);
  assert.equal(checks.find(({ name }) => name === 'codex-profile').status, 'fail');
  assert.doesNotMatch(temp.detail, /protected|isolation/);
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
  assert.equal(temp.extra.ownerOnly, false);
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
  assert.equal(temp.extra.ownerOnly, false);
});

test('Codex temp accepts an owner-only child directory without a command deny', async (t) => {
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
  assert.equal(temp.extra.ownerOnly, true);
});

test('Codex temp inspection honors the configured permission profile', async (t) => {
  const deployment = createDeployment(t);
  deployment.dependencies.profileId = 'custom-session';
  const configPath = path.join(deployment.codexHome, 'config.toml');
  const raw = require('node:fs').readFileSync(configPath, 'utf8');
  writeFileSync(configPath, raw.replaceAll('polygram-trusted', 'custom-session'), { mode: 0o600 });

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

test('doctor rejects a restricted profile even when an unrelated table has a temp deny', async (t) => {
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

  assert.equal(temp.status, 'ok');
  assert.equal(checks.find(({ name }) => name === 'codex-profile').status, 'fail');
  assert.equal(temp.extra.ownerOnly, true);
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

test('unverified cleanup is explicit, content-free, and reboot-independent', async (t) => {
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
  assert.match(lease.detail, /cleanup is unverified/i);
  assert.doesNotMatch(lease.detail, /reboot/i);
  assert.deepEqual(lease.extra, {
    runtime: 'codex',
    scope: 'daemon',
    status: 'quarantined',
    ownerPresent: true,
    rebootRequired: false,
    serviceRestartRequired: true,
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

test('doctor refuses derived foreign instructions and overrides instead of reporting profile ready', async (t) => {
  for (const kind of ['foreign', 'override', 'home-alias']) {
    const f = createDeployment(t);
    const other = path.join(path.dirname(f.workspace), 'other-workspace');
    mkdirSync(other, { mode: 0o700 });
    writeFileSync(path.join(other, 'AGENTS.md'), 'Other canonical root', { mode: 0o600 });
    const { selectCodexWorkspaceHome } = require('../lib/codex/runtime-profile');
    const selected = selectCodexWorkspaceHome({ codexHome: f.codexHome, workspace: other }, { create: true }).codexHome;
    mkdirSync(selected, { mode: 0o700 });
    const raw = require('node:fs').readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
    writeFileSync(path.join(selected, 'config.toml'), raw, { mode: 0o600 });
    if (kind === 'foreign') symlinkSync(path.join(f.workspace, 'AGENTS.md'), path.join(selected, 'AGENTS.md'));
    if (kind === 'override') writeFileSync(path.join(selected, 'AGENTS.override.md'), 'Unexpected authority', { mode: 0o600 });
    if (kind === 'home-alias') {
      rmSync(selected, { recursive: true });
      symlinkSync(f.codexHome, selected);
    }
    f.config.chats[100].cwd = other;
    const checks = await collectCodexDoctorChecks({ config: f.config, db: f.db,
      dependencies: f.dependencies, processEnv: f.processEnv });
    assert.equal(checks.find(({ name }) => name === 'codex-home').status, 'fail', kind);
    assert.equal(checks.find(({ name }) => name === 'codex-profile').status, 'fail', kind);
  }
});

test('doctor uses environment anchor and rejects temp inside an actual selected workspace home', async (t) => {
  const f = createDeployment(t);
  f.processEnv.POLYGRAM_CODEX_HOME = f.config.codex.home;
  delete f.config.codex.home;
  let checks = await collectCodexDoctorChecks({ config: f.config, db: f.db,
    dependencies: f.dependencies, processEnv: f.processEnv });
  assert.equal(checks.find(({ name }) => name === 'codex-tmpdir').status, 'ok');
  const other = path.join(path.dirname(f.workspace), 'other-workspace');
  mkdirSync(other, { mode: 0o700 });
  writeFileSync(path.join(other, 'AGENTS.md'), 'Other canonical root', { mode: 0o600 });
  const selected = require('../lib/codex/runtime-profile').selectCodexWorkspaceHome({
    codexHome: f.codexHome, workspace: other }, { create: true }).codexHome;
  mkdirSync(selected, { mode: 0o700 });
  const tmp = path.join(selected, 'child-tmp');
  mkdirSync(tmp, { mode: 0o700 });
  f.config.chats[100].cwd = other;
  f.processEnv.POLYGRAM_CODEX_TMPDIR = tmp;
  checks = await collectCodexDoctorChecks({ config: f.config, db: f.db,
    dependencies: f.dependencies, processEnv: f.processEnv });
  assert.equal(checks.find(({ name }) => name === 'codex-tmpdir').status, 'fail');
});

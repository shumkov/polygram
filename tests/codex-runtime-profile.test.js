'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const {
  CODEX_PERMISSION_PROFILE_ID,
  CodexRuntimeProfileError,
  createCodexRuntimeProfileBuilder,
} = require('../lib/codex/runtime-profile');
const {
  CODEX_BINARY_SHA256,
  CODEX_CLI_PINNED_VERSION,
} = require('../lib/codex/binary');
const {
  assertCodexSpawnProfile,
  codexProtocolSchema,
  createCodexSpawnProfile,
  preflightCodexRuntime,
} = require('@shumkov/orchestra');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(canonical(value)))
    .digest('hex');
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.homedir(), '.polygram-profile-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const daemonSecretRoot = path.join(root, 'daemon-secrets');
  const ipcRuntimeRoot = path.join(root, 'polygram-ipc');
  const serviceHome = path.join(root, 'service-home');
  const serviceTmp = path.join(root, 'service-tmp');
  const codexHome = path.join(root, 'codex-home');
  for (const directory of [
    workspace,
    daemonSecretRoot,
    ipcRuntimeRoot,
    serviceHome,
    serviceTmp,
  ]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  return {
    root,
    workspace,
    daemonSecretRoot,
    ipcRuntimeRoot,
    serviceHome,
    serviceTmp,
    codexHome,
    processEnv: {
      HOME: serviceHome,
      TMPDIR: serviceTmp,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TELEGRAM_BOT_TOKEN: 'must-not-reach-codex',
    },
  };
}

function ownedConfig(f) {
  return {
    cli_auth_credentials_store: 'file',
    model_provider: 'openai',
    default_permissions: CODEX_PERMISSION_PROFILE_ID,
    approval_policy: 'never',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    shell_environment_policy: {
      inherit: 'none',
      ignore_default_excludes: false,
      set: {
        HOME: path.join(f.workspace, '.codex-command-home'),
        TMPDIR: path.join(f.workspace, '.codex-command-tmp'),
        PATH: '/usr/bin:/bin',
      },
    },
    permissions: {
      [CODEX_PERMISSION_PROFILE_ID]: {
        filesystem: {
          ':minimal': 'read',
          [f.codexHome]: 'deny',
          [f.daemonSecretRoot]: 'deny',
          [f.ipcRuntimeRoot]: 'deny',
          ':workspace_roots': { '.': 'write' },
        },
        network: { enabled: false },
      },
    },
    projects: {
      [f.workspace]: { trust_level: 'untrusted' },
    },
  };
}

function projectedConfig(f, overrides = {}) {
  const config = ownedConfig(f);
  const filesystem = {
    glob_scan_max_depth: null,
    ...config.permissions[CODEX_PERMISSION_PROFILE_ID].filesystem,
  };
  const stringRules = Object.entries(filesystem)
    .filter(([, access]) => typeof access === 'string')
    .map(([root, access]) => ({ rootSha256: digest(root), access }))
    .sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  return {
    sha256: 'e'.repeat(64),
    model: null,
    modelProvider: 'openai',
    defaultPermissions: CODEX_PERMISSION_PROFILE_ID,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    webSearch: 'disabled',
    allowLoginShell: false,
    shellEnvironmentInherit: 'none',
    permissionProfiles: [{
      id: CODEX_PERMISSION_PROFILE_ID,
      extends: null,
      networkEnabled: false,
      filesystemSha256: digest(filesystem),
      filesystem: stringRules,
    }],
    mcpServers: { count: 0, keySha256: [] },
    plugins: { count: 0, keySha256: [] },
    modelProviders: { count: 0, keySha256: [] },
    ...overrides,
  };
}

function projectedResults(f, overrides = {}) {
  const config = projectedConfig(f, overrides.config);
  return {
    'config/read': {
      config,
      layers: overrides.layers ?? [{
        type: 'system',
        version: 'system-v1',
        disabled: false,
        configSha256: digest({}),
      }, {
        type: 'user',
        version: 'user-v1',
        disabled: false,
        configSha256: digest(ownedConfig(f)),
      }],
      originsSha256: Object.hasOwn(overrides, 'originsSha256')
        ? overrides.originsSha256
        : 'f'.repeat(64),
    },
    'configRequirements/read': overrides.requirements ?? {
      requirements: null,
    },
    'permissionProfile/list': overrides.permissionPages ?? [{
      data: [{
        id: 'read-only',
        allowed: true,
        descriptionSha256: null,
      }],
      nextCursor: 'page-2',
    }, {
      data: [{
        id: CODEX_PERMISSION_PROFILE_ID,
        allowed: true,
        descriptionSha256: digest('owned profile'),
      }],
      nextCursor: null,
    }],
  };
}

class FakeClient {
  constructor(options, results, { start = null, fault = null } = {}) {
    this.options = options;
    this.results = results;
    this.startBehavior = start;
    this.fault = fault;
    this.calls = [];
    this.closed = 0;
    this.permissionPage = 0;
  }

  async start() {
    if (this.startBehavior) await this.startBehavior(this.options);
    return this;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'permissionProfile/list') {
      return this.results[method][this.permissionPage++];
    }
    return this.results[method];
  }

  async close() {
    this.closed += 1;
  }

  async waitForFault() {
    return this.fault;
  }
}

function binaryReceipt() {
  return Object.freeze({
    path: '/Applications/Codex.app/Contents/Resources/codex',
    version: CODEX_CLI_PINNED_VERSION,
    sha256: CODEX_BINARY_SHA256,
    fingerprint: Object.freeze({
      dev: '1',
      ino: '2',
      size: '3',
      mtimeNs: '4',
      ctimeNs: '5',
      mode: 0o100700,
      uid: process.getuid?.() ?? 0,
      nlink: 1,
    }),
  });
}

function createBuilder(f, results = projectedResults(f), clientOptions = {}) {
  const clients = [];
  const builder = createCodexRuntimeProfileBuilder({
    temporaryRoots: [],
    clientFactory: (options) => {
      const client = new FakeClient(options, results, clientOptions);
      clients.push(client);
      return client;
    },
  });
  return { builder, clients };
}

function prepareOptions(f, overrides = {}) {
  return {
    binaryReceipt: binaryReceipt(),
    codexHome: f.codexHome,
    workspace: f.workspace,
    daemonSecretRoots: [f.daemonSecretRoot, f.ipcRuntimeRoot],
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    processEnv: f.processEnv,
    ...overrides,
  };
}

describe('owned Codex native-beta runtime profile', () => {
  test('provisions exact private files, characterizes projected policy, and builds a frozen static profile', async (t) => {
    const f = fixture(t);
    const { builder, clients } = createBuilder(f);

    const profile = await builder.prepare(prepareOptions(f));

    assert.equal(statSync(f.codexHome).mode & 0o777, 0o700);
    assert.equal(
      statSync(path.join(f.codexHome, 'config.toml')).mode & 0o777,
      0o600,
    );
    assert.equal(
      statSync(path.join(f.workspace, '.codex-command-home')).mode & 0o777,
      0o700,
    );
    assert.equal(
      statSync(path.join(f.workspace, '.codex-command-tmp')).mode & 0o777,
      0o700,
    );

    const raw = readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
    assert.match(raw, /model_provider = "openai"/);
    assert.match(raw, /default_permissions = "polygram-session"/);
    assert.match(raw, /approval_policy = "never"/);
    assert.match(raw, /allow_login_shell = false/);
    assert.match(raw, /network = \\{ enabled = false \\}|enabled = false/);
    assert.match(raw, new RegExp(
      `${f.ipcRuntimeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*deny`,
    ));
    assert.doesNotMatch(raw, /sandbox|mcp|plugin|TELEGRAM_BOT_TOKEN/);

    assert.equal(profile.runtime, 'codex');
    assert.equal(profile.binary, binaryReceipt().path);
    assert.equal(profile.binarySha256, CODEX_BINARY_SHA256);
    assert.equal(profile.cliVersion, CODEX_CLI_PINNED_VERSION);
    assert.equal(
      profile.protocolSchemaSha256,
      codexProtocolSchema.generatedProtocolV2CanonicalSha256,
    );
    assert.equal(profile.codexHome, f.codexHome);
    assert.equal(profile.cwd, f.workspace);
    assert.equal(profile.model, 'gpt-5.6-sol');
    assert.equal(profile.effort, 'xhigh');
    assert.equal(profile.expectedConfig.modelProvider, 'openai');
    assert.deepEqual(profile.expectedConfig.modelProviders, {
      count: 0,
      keySha256: [],
    });
    assert.equal(profile.expectedConfig.mcpServers.count, 0);
    assert.equal(profile.expectedRequirements, null);
    assert.equal(profile.permissionProfileId, CODEX_PERMISSION_PROFILE_ID);
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.expectedConfig), true);

    assert.equal(clients.length, 1);
    assert.equal(clients[0].options.binary, profile.binary);
    assert.equal(clients[0].options.cwd, f.workspace);
    assert.equal(clients[0].options.codexHome, f.codexHome);
    assert.equal(
      clients[0].options.expectedConfigSha256,
      profile.ownedConfigSha256,
    );
    assert.deepEqual(clients[0].options.env, profile.env);
    assert.deepEqual(
      clients[0].calls,
      [{
        method: 'config/read',
        params: { cwd: f.workspace, includeLayers: true },
      }, {
        method: 'configRequirements/read',
        params: undefined,
      }, {
        method: 'permissionProfile/list',
        params: { cwd: f.workspace },
      }, {
        method: 'permissionProfile/list',
        params: { cwd: f.workspace, cursor: 'page-2' },
      }],
    );
    assert.equal(clients[0].closed, 1);
  });

  test('does not read, copy, rewrite, or expose credential contents', async (t) => {
    const f = fixture(t);
    mkdirSync(f.codexHome, { mode: 0o700 });
    chmodSync(f.codexHome, 0o700);
    const authPath = path.join(f.codexHome, 'auth.json');
    const secret = 'CHATGPT-REFRESH-SECRET';
    writeFileSync(authPath, secret, { mode: 0o600 });
    chmodSync(authPath, 0o600);
    const { builder } = createBuilder(f);

    const profile = await builder.prepare(prepareOptions(f));

    assert.equal(readFileSync(authPath, 'utf8'), secret);
    assert.doesNotMatch(JSON.stringify(profile), new RegExp(secret));
    assert.equal(Object.hasOwn(profile, 'auth'), false);
  });

  test('built profile is accepted by public Orchestra preflight and yields a branded receipt', async (t) => {
    const f = fixture(t);
    const results = projectedResults(f);
    const { builder } = createBuilder(f, results);
    const profile = await builder.prepare(prepareOptions(f));
    const preflightClient = new FakeClient({
      binary: profile.binary,
    }, {
      ...results,
      'account/read': {
        account: { type: 'chatgpt' },
        requiresOpenaiAuth: true,
      },
      'model/list': {
        data: [{
          id: 'gpt-5.6-sol',
          model: 'gpt-5.6-sol',
          description: 'Test model',
          displayName: 'GPT-5.6 Sol',
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
          hidden: false,
          isDefault: true,
        }],
        nextCursor: null,
      },
    });
    preflightClient.request = async function request(method, params) {
      this.calls.push({ method, params });
      if (method === 'permissionProfile/list') {
        return results[method][this.permissionPage++];
      }
      return this.results[method];
    };

    const preflight = await preflightCodexRuntime(profile, {
      clientFactory: () => preflightClient,
    });
    const receipt = createCodexSpawnProfile(profile, preflight);

    assert.equal(preflight.selected.model, 'gpt-5.6-sol');
    assert.equal(preflight.selected.effort, 'xhigh');
    assert.equal(assertCodexSpawnProfile(receipt), receipt);
    assert.equal(receipt.expectedStaticProfile.cwd, f.workspace);
  });

  test('rerun accepts only byte-exact owned config and never overwrites drift', async (t) => {
    const f = fixture(t);
    const first = createBuilder(f);
    await first.builder.prepare(prepareOptions(f));
    const configPath = path.join(f.codexHome, 'config.toml');
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}# drift\n`, {
      mode: 0o600,
    });
    const drifted = readFileSync(configPath, 'utf8');
    const second = createBuilder(f);

    await assert.rejects(
      second.builder.prepare(prepareOptions(f)),
      { code: 'CODEX_OWNED_CONFIG_DRIFT' },
    );
    assert.equal(readFileSync(configPath, 'utf8'), drifted);
    assert.equal(second.clients.length, 0);
  });

  test('rejects temporary homes, unsafe modes, symlinked command dirs, and overlapping roots before client start', async (t) => {
    const cases = [{
      name: 'temporary home',
      setup: (f) => ({
        builderOptions: { temporaryRoots: [f.root] },
        prepare: {},
      }),
      code: 'CODEX_HOME_UNSAFE',
    }, {
      name: 'unsafe home mode',
      setup: (f) => {
        mkdirSync(f.codexHome, { mode: 0o700 });
        chmodSync(f.codexHome, 0o770);
        return { prepare: {} };
      },
      code: 'CODEX_HOME_UNSAFE',
    }, {
      name: 'symlinked command home',
      setup: (f) => {
        const target = path.join(f.workspace, 'command-home-target');
        mkdirSync(target, { mode: 0o700 });
        symlinkSync(target, path.join(f.workspace, '.codex-command-home'));
        return { prepare: {} };
      },
      code: 'CODEX_COMMAND_DIR_UNSAFE',
    }, {
      name: 'overlapping secret root',
      setup: (f) => ({
        prepare: { daemonSecretRoots: [f.workspace] },
      }),
      code: 'CODEX_RUNTIME_ROOT_OVERLAP',
    }];

    for (const entry of cases) {
      await test(entry.name, async (t) => {
        const f = fixture(t);
        const setup = entry.setup(f);
        const clients = [];
        const builder = createCodexRuntimeProfileBuilder({
          temporaryRoots: setup.builderOptions?.temporaryRoots ?? [],
          clientFactory: (options) => {
            clients.push(options);
            return new FakeClient(options, projectedResults(f));
          },
        });
        await assert.rejects(
          builder.prepare(prepareOptions(f, setup.prepare)),
          { code: entry.code },
        );
        assert.equal(clients.length, 0);
      });
    }
  });

  test('fails closed on unsafe projected config, filesystem, layer, requirements, origins, or profile drift', async () => {
    const mutations = [{
      name: 'MCP enabled',
      mutate: (f) => projectedResults(f, {
        config: { mcpServers: { count: 1, keySha256: [digest('bad')] } },
      }),
    }, {
      name: 'non-OpenAI provider',
      mutate: (f) => projectedResults(f, {
        config: {
          modelProvider: 'other',
          modelProviders: { count: 1, keySha256: [digest('other')] },
        },
      }),
    }, {
      name: 'custom OpenAI provider',
      mutate: (f) => projectedResults(f, {
        config: {
          modelProviders: { count: 1, keySha256: [digest('openai')] },
        },
      }),
    }, {
      name: 'inconsistent custom-provider projection',
      mutate: (f) => projectedResults(f, {
        config: {
          modelProviders: { count: 0, keySha256: [digest('openai')] },
        },
      }),
    }, {
      name: 'approval drift',
      mutate: (f) => projectedResults(f, {
        config: { approvalPolicy: 'on-request' },
      }),
    }, {
      name: 'network enabled',
      mutate: (f) => {
        const config = projectedConfig(f);
        config.permissionProfiles[0].networkEnabled = true;
        return projectedResults(f, { config });
      },
    }, {
      name: 'filesystem hash drift',
      mutate: (f) => {
        const config = projectedConfig(f);
        config.permissionProfiles[0].filesystemSha256 = '0'.repeat(64);
        return projectedResults(f, { config });
      },
    }, {
      name: 'user layer hash drift',
      mutate: (f) => projectedResults(f, {
        layers: [{
          type: 'user',
          version: 'user-v1',
          disabled: false,
          configSha256: '0'.repeat(64),
        }],
      }),
    }, {
      name: 'unexpected project layer',
      mutate: (f) => projectedResults(f, {
        layers: [{
          type: 'user',
          version: 'user-v1',
          disabled: false,
          configSha256: digest(ownedConfig(f)),
        }, {
          type: 'project',
          version: 'project-v1',
          disabled: false,
          configSha256: digest({}),
        }],
      }),
    }, {
      name: 'managed requirements',
      mutate: (f) => projectedResults(f, {
        requirements: {
          requirements: {
            sha256: digest({ allowedApprovalPolicies: ['never'] }),
            keys: ['allowedApprovalPolicies'],
          },
        },
      }),
    }, {
      name: 'origins missing',
      mutate: (f) => projectedResults(f, { originsSha256: null }),
    }, {
      name: 'owned profile denied',
      mutate: (f) => projectedResults(f, {
        permissionPages: [{
          data: [{
            id: CODEX_PERMISSION_PROFILE_ID,
            allowed: false,
            descriptionSha256: null,
          }],
          nextCursor: null,
        }],
      }),
    }];

    for (const entry of mutations) {
      await test(entry.name, async (t) => {
        const f = fixture(t);
        const { builder, clients } = createBuilder(f, entry.mutate(f));
        await assert.rejects(
          builder.prepare(prepareOptions(f)),
          (error) => (
            error instanceof CodexRuntimeProfileError
            && error.code === 'CODEX_RUNTIME_POLICY_DRIFT'
          ),
        );
        assert.equal(clients[0].closed, 1);
      });
    }
  });

  test('unexpected delivered notifications and terminal client faults cannot yield a profile', async (t) => {
    const f = fixture(t);
    const notification = createBuilder(f, projectedResults(f), {
      start: async (options) => {
        await options.onNotification({ method: 'turn/started' });
      },
    });
    await assert.rejects(
      notification.builder.prepare(prepareOptions(f)),
      { code: 'CODEX_RUNTIME_POLICY_DRIFT' },
    );

    const f2 = fixture(t);
    const fault = createBuilder(f2, projectedResults(f2), {
      fault: { kind: 'codex-app-server-fault' },
    });
    await assert.rejects(
      fault.builder.prepare(prepareOptions(f2)),
      { code: 'CODEX_RUNTIME_CLIENT_FAULT' },
    );
  });
});

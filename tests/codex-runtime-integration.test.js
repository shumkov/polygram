'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const orchestra = require('@shumkov/orchestra');
const dbClient = require('../lib/db');
const {
  resolveProviderSessionForSpawn,
} = require('../lib/db/sessions');
const {
  createCodexRuntimeController,
} = require('../lib/codex/runtime-controller');
const {
  buildCodexSpawnContext,
} = require('../lib/codex/spawn-context');
const {
  createCodexRuntimeProfileBuilder,
} = require('../lib/codex/runtime-profile');
const {
  CodexModelCatalog,
} = require('../lib/codex/model-catalog');
const {
  createAutosteerHandlers,
} = require('../lib/handlers/autosteer');
const {
  classifyReplay,
} = require('../lib/handlers/replay-disposition');
const { createSdkCallbacks } = require('../lib/sdk/callbacks');
const {
  insertInbound,
} = require('./helpers/db-fixture');

const FAKE_APP_SERVER = path.resolve(
  __dirname,
  'fixtures/fake-codex-app-server.mjs',
);
const QUIET = {
  debug() {},
  error() {},
  info() {},
  log() {},
  warn() {},
};

function binaryFingerprint(binary) {
  const stat = statSync(binary, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    nlink: Number(stat.nlink),
  };
}

function digest(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function ownedConfig({
  codexHome,
  codexTmp,
  daemonSecretRoot,
  workspace,
}) {
  return {
    cli_auth_credentials_store: 'file',
    model_provider: 'openai',
    default_permissions: 'polygram-session',
    approval_policy: 'never',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    features: {
      goals: false,
    },
    shell_environment_policy: {
      inherit: 'none',
      ignore_default_excludes: false,
      set: {
        HOME: path.join(workspace, '.codex-command-home'),
        TMPDIR: path.join(workspace, '.codex-command-tmp'),
        PATH: '/usr/bin:/bin',
      },
    },
    permissions: {
      'polygram-session': {
        filesystem: {
          ':minimal': 'read',
          [codexHome]: 'deny',
          [codexTmp]: 'deny',
          [daemonSecretRoot]: 'deny',
          ':workspace_roots': { '.': 'write' },
        },
        network: { enabled: false },
      },
    },
    projects: {
      [workspace]: { trust_level: 'untrusted' },
    },
  };
}

function threadResult(workspace, threadId = 'codex-thread-1') {
  return {
    thread: {
      cliVersion: orchestra.codexProtocolSchema.cliVersion,
      createdAt: 1,
      cwd: workspace,
      ephemeral: false,
      id: threadId,
      modelProvider: 'openai',
      preview: '',
      sessionId: threadId,
      source: 'appServer',
      status: { type: 'idle' },
      turns: [],
      updatedAt: 1,
    },
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    cwd: workspace,
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    reasoningEffort: 'medium',
    runtimeWorkspaceRoots: [workspace],
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    },
    activePermissionProfile: {
      id: 'polygram-session',
      extends: null,
    },
  };
}

function turnStarted(turnId, threadId = 'codex-thread-1') {
  return {
    method: 'turn/started',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'inProgress',
        items: [],
        error: null,
      },
    },
  };
}

function completedTurnMessages(
  turnId,
  text,
  threadId = 'codex-thread-1',
) {
  const itemId = `answer-${turnId}`;
  return [{
    method: 'item/started',
    params: {
      threadId,
      turnId,
      startedAtMs: 1,
      item: { id: itemId, type: 'agentMessage' },
    },
  }, {
    method: 'item/agentMessage/delta',
    params: {
      threadId,
      turnId,
      itemId,
      delta: text,
    },
  }, {
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      completedAtMs: 2,
      item: {
        id: itemId,
        type: 'agentMessage',
        text,
      },
    },
  }, {
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'completed',
        items: [],
        error: null,
      },
    },
  }];
}

function interruptedTurnMessage(
  turnId,
  threadId = 'codex-thread-1',
) {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId,
        status: 'interrupted',
        items: [],
        error: null,
      },
    },
  };
}

function writeScenario(fixture, overrides = {}) {
  const securityConfig = ownedConfig(fixture);
  const effectiveConfig = {
    ...securityConfig,
    permissions: {
      'polygram-session': {
        ...securityConfig.permissions['polygram-session'],
        filesystem: {
          glob_scan_max_depth: null,
          ...securityConfig.permissions['polygram-session'].filesystem,
        },
      },
    },
    model_provider: 'openai',
    model_providers: {},
  };
  const turnId = 'turn-text-1';
  writeFileSync(
    path.join(fixture.workspace, '.fake-codex-app-server.json'),
    `${JSON.stringify({
      ...overrides,
      methods: {
        'config/read': {
          result: {
            config: effectiveConfig,
            layers: [{
              name: 'system',
              version: 'system-v1',
              config: {},
            }, {
              name: 'user',
              version: 'user-v1',
              config: securityConfig,
            }],
            origins: {},
          },
        },
        'permissionProfile/list': {
          result: {
            data: [{
              id: 'polygram-session',
              allowed: true,
              description: 'Polygram native beta profile',
            }],
            nextCursor: null,
          },
        },
        'account/read': {
          result: {
            account: {
              type: 'chatgpt',
              email: null,
              planType: 'pro',
            },
            requiresOpenaiAuth: true,
          },
        },
        'model/list': {
          result: {
            data: [{
              id: 'gpt-5.6-sol',
              model: 'gpt-5.6-sol',
              description: 'Pinned subscription coding model',
              displayName: 'GPT-5.6 Sol',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [{
                reasoningEffort: 'medium',
                description: 'Balanced',
              }, {
                reasoningEffort: 'xhigh',
                description: 'Deep',
              }],
              hidden: false,
              isDefault: true,
            }],
            nextCursor: null,
          },
        },
        'thread/start': {
          result: threadResult(fixture.workspace),
        },
        'thread/resume': {
          result: threadResult(fixture.workspace),
        },
        'turn/start': {
          result: {
            turn: {
              id: turnId,
              status: 'inProgress',
              items: [],
            },
          },
          lateDelayMs: 1,
          lateMessages: [{
            method: 'turn/started',
            params: {
              threadId: 'codex-thread-1',
              turn: {
                id: turnId,
                status: 'inProgress',
                items: [],
                error: null,
              },
            },
          }, {
            method: 'item/started',
            params: {
              threadId: 'codex-thread-1',
              turnId,
              startedAtMs: 1,
              item: { id: 'answer-1', type: 'agentMessage' },
            },
          }, {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'codex-thread-1',
              turnId,
              itemId: 'answer-1',
              delta: 'Hello',
            },
          }, {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'codex-thread-1',
              turnId,
              itemId: 'answer-1',
              delta: ' world',
            },
          }, {
            method: 'item/completed',
            params: {
              threadId: 'codex-thread-1',
              turnId,
              completedAtMs: 2,
              item: {
                id: 'answer-1',
                type: 'agentMessage',
                text: 'Hello world',
              },
            },
          }, {
            method: 'turn/completed',
            params: {
              threadId: 'codex-thread-1',
              turn: {
                id: turnId,
                status: 'completed',
                items: [],
                error: null,
              },
            },
          }],
        },
        ...(overrides.methods ?? {}),
      },
    })}\n`,
    { mode: 0o600 },
  );
}

function makeFixture(t, scenario = {}) {
  const root = realpathSync(mkdtempSync(
    path.join(os.homedir(), '.polygram-codex-integration-'),
  ));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = {
    root,
    workspace: path.join(root, 'workspace'),
    daemonSecretRoot: path.join(root, 'daemon-secrets'),
    codexHome: path.join(root, 'codex-home'),
    codexTmp: path.join(root, 'codex-tmp'),
    serviceHome: path.join(root, 'service-home'),
    serviceTmp: path.join(root, 'service-tmp'),
    binary: path.join(root, 'codex'),
    dbPath: path.join(root, 'polygram.db'),
  };
  for (const directory of [
    fixture.workspace,
    fixture.daemonSecretRoot,
    fixture.codexHome,
    fixture.codexTmp,
    fixture.serviceHome,
    fixture.serviceTmp,
  ]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  writeFileSync(
    fixture.binary,
    [
      '#!/bin/sh',
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_APP_SERVER)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(fixture.binary, 0o700);
  writeFileSync(
    path.join(fixture.codexHome, 'auth.json'),
    '{"auth_mode":"chatgpt-test"}\n',
    { mode: 0o600 },
  );
  writeScenario(fixture, scenario);
  return fixture;
}

function createIntegrationOrchestra() {
  const observedFaults = [];
  const targetPin = orchestra.resolveCodexTargetPin();
  const attestCodexHomeFn = (codexHome, expectedConfigSha256) => (
    orchestra.attestPinnedCodexHome(
      codexHome,
      expectedConfigSha256,
      { temporaryRoots: [] },
    )
  );
  const attestBinaryFn = async (binary) => ({
    path: binary,
    target: targetPin.target,
    sha256: targetPin.binarySha256,
    version: targetPin.cliVersion,
    fingerprint: binaryFingerprint(binary),
  });
  class IntegrationClient extends orchestra.CodexAppServerClient {
    constructor(options) {
      const onFault = options.onFault;
      super({
        ...options,
        onFault: (outcome) => {
          observedFaults.push(outcome);
          return onFault(outcome);
        },
        attestBinaryFn,
        attestCodexHomeFn,
        requestTimeoutMs: 5_000,
        closeGraceMs: 5_000,
        closeKillMs: 5_000,
      });
    }
  }
  return {
    ...orchestra,
    _observedFaults: observedFaults,
    _attestCodexHome: attestCodexHomeFn,
    CodexAppServerClient: IntegrationClient,
    preflightCodexRuntime: (profile) => (
      orchestra.preflightCodexRuntime(profile, {
        clientFactory: (options) => new IntegrationClient(options),
      })
    ),
  };
}

function createCallbacks(db, config) {
  return createSdkCallbacks({
    db,
    dbWrite: (operation) => operation(),
    config,
    bot: null,
    botName: 'testbot',
    tg: async () => ({}),
    logEvent() {},
    classifyToolName: () => 'THINKING',
    announce() {},
    shouldAnnounce: () => false,
    contextHintShown: new Set(),
    extractAssistantText: () => '',
    getChatIdFromKey: (sessionKey) => sessionKey.split(':')[0],
    getThreadIdFromKey: () => null,
    logger: QUIET,
  });
}

function createRuntime({
  db,
  config,
  fixture,
  integrationOrchestra,
  controllerOptions = {},
}) {
  const processEnv = {
    HOME: fixture.serviceHome,
    TMPDIR: fixture.serviceTmp,
    POLYGRAM_CODEX_TMPDIR: fixture.codexTmp,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };
  const targetPin = orchestra.resolveCodexTargetPin();
  const binaryReceipt = Object.freeze({
    path: fixture.binary,
    target: targetPin.target,
    version: targetPin.cliVersion,
    sha256: targetPin.binarySha256,
    fingerprint: Object.freeze(binaryFingerprint(fixture.binary)),
  });
  const runtimeProfileBuilder = createCodexRuntimeProfileBuilder({
    temporaryRoots: [],
    clientFactory: (options) => (
      new integrationOrchestra.CodexAppServerClient(options)
    ),
  });
  const modelCatalog = new CodexModelCatalog({
    orchestra: integrationOrchestra,
  });
  const controller = createCodexRuntimeController({
    config,
    db,
    processEnv,
    defaultDaemonSecretRoots: [fixture.daemonSecretRoot],
    resolveHostIdentity: () => Object.freeze({
      stableHostId: 'host:integration',
      bootSessionId: 'boot:integration',
    }),
    resolveBinary: async () => binaryReceipt,
    runtimeProfileBuilder,
    modelCatalog,
    attestCodexHome: integrationOrchestra._attestCodexHome,
    orchestra: integrationOrchestra,
    logger: QUIET,
    ...controllerOptions,
  });
  const boot = controller.initialize();
  const baseFactory = orchestra.createProcessFactory({
    config,
    logger: QUIET,
    pmDefault: 'sdk',
    codexClientFactory: controller.clientFactory,
    codexCheckpointSink: controller.checkpointSink,
    codexExpectedStaticProfile: controller.resolveReceipt,
    codexHostIdentity: boot.managerOptions.codexHostIdentity,
    codexBootSessionIdentity:
      boot.managerOptions.codexBootSessionIdentity,
  });
  const processFactory = (sessionKey, spawnContext) => {
    const proc = baseFactory(sessionKey, spawnContext);
    if (proc.runtime === 'codex') controller.registerProcess(proc);
    return proc;
  };
  const manager = new orchestra.ProcessManager({
    processFactory,
    db,
    logger: QUIET,
    callbacks: createCallbacks(db, config),
    budget: 1,
    ...boot.managerOptions,
  });
  return { controller, manager };
}

async function spawnCodex(runtime, db, config, {
  sessionKey = '1',
  chatId = '1',
} = {}) {
  const prepared = await runtime.controller.prepareSession({
    sessionKey,
    chatId,
    threadId: null,
  });
  const resolved = resolveProviderSessionForSpawn(db, sessionKey, {
    runtime: 'codex',
    backend: 'codex',
    agent: null,
    cwd: config.chats[chatId].cwd,
    model: prepared.runtimeConfig.model,
    effort: prepared.runtimeConfig.effort,
  });
  const proc = await runtime.manager.getOrSpawn(sessionKey, {
    runtime: 'codex',
    spawnProfileId: prepared.runtimeConfig.spawnProfileId,
    modelSettings: {
      model: prepared.runtimeConfig.model,
      effort: prepared.runtimeConfig.effort,
    },
    chatId,
    threadId: null,
    label: 'Codex integration',
    existingSessionId: resolved.existingSessionId,
  });
  return { proc, resumed: resolved.existingSessionId };
}

test('warm model settings reuse preflight, generation, and thread for the next turn', {
  timeout: 30_000,
}, async (t) => {
  const fixture = makeFixture(t);
  const db = dbClient.open(fixture.dbPath);
  const config = integrationConfig(fixture);
  const integrationOrchestra = createIntegrationOrchestra();
  const runtime = createRuntime({
    db,
    config,
    fixture,
    integrationOrchestra,
  });
  t.after(async () => {
    try { await runtime.manager.kill('1', 'test-cleanup'); } catch {}
    try { db.raw.close(); } catch {}
  });
  const first = await spawnCodex(runtime, db, config);
  const spawned = JSON.parse(readFileSync(
    path.join(fixture.workspace, 'fake-codex-spawn.json'),
    'utf8',
  ));
  assert.equal(spawned.env.TMPDIR, fixture.codexTmp);
  assert.equal(spawned.env.CODEX_HOME, fixture.codexHome);
  const generationId = first.proc.generationId;
  const threadId = first.proc.providerSessionId;
  const requestLog = path.join(
    fixture.workspace,
    'fake-codex-requests.jsonl',
  );
  const before = readFileSync(requestLog, 'utf8');

  config.chats[1].codexEffort = 'xhigh';
  const prepared = await runtime.controller.prepareSession({
    sessionKey: '1',
    chatId: '1',
    threadId: null,
  });
  const same = await runtime.manager.getOrSpawn('1', {
    runtime: 'codex',
    spawnProfileId: prepared.runtimeConfig.spawnProfileId,
    modelSettings: {
      model: prepared.runtimeConfig.model,
      effort: prepared.runtimeConfig.effort,
    },
    chatId: '1',
    threadId: null,
    label: 'Codex integration',
    existingSessionId: threadId,
  });

  assert.equal(same, first.proc);
  assert.equal(same.generationId, generationId);
  assert.equal(same.providerSessionId, threadId);
  assert.deepEqual(
    (await runtime.manager.getModelSettingsStatus('1')).nextTurn,
    {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    },
  );
  assert.equal(readFileSync(requestLog, 'utf8'), before);

  const result = await runtime.manager.send('1', 'Use the new effort');
  await runtime.controller.settleTelegramDelivery('1', result);
  const requests = readFileSync(requestLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const starts = requests.filter(
    (message) => message.method === 'turn/start',
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.model, 'gpt-5.6-sol');
  assert.equal(starts[0].params.effort, 'xhigh');
  assert.equal(
    requests.filter((message) => message.method === 'thread/resume').length,
    0,
  );
  assert.equal(await runtime.manager.kill('1', 'integration-done'), true);
});

test('catalog drift retires once and resumes the persisted thread before the next turn', {
  timeout: 30_000,
}, async (t) => {
  let currentTime = 1_000;
  const fixture = makeFixture(t);
  const db = dbClient.open(fixture.dbPath);
  const config = integrationConfig(fixture);
  const integrationOrchestra = createIntegrationOrchestra();
  const runtime = createRuntime({
    db,
    config,
    fixture,
    integrationOrchestra,
    controllerOptions: {
      catalogMaxAgeMs: 10,
      now: () => currentTime,
    },
  });
  t.after(async () => {
    try { await runtime.manager.kill('1', 'test-cleanup'); } catch {}
    try { db.raw.close(); } catch {}
  });
  const buildContext = () => buildCodexSpawnContext({
    sessionKey: '1',
    chatId: '1',
    threadId: null,
    chatConfig: config.chats['1'],
    db,
    pm: runtime.manager,
    runtimeController: runtime.controller,
    getSessionLabel: () => 'Codex integration',
    logEvent() {},
  });

  const first = await runtime.manager.getOrSpawn('1', await buildContext());
  const threadId = first.providerSessionId;
  const generationId = first.generationId;
  writeScenario(fixture, {
    methods: {
      'model/list': {
        result: {
          data: [{
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            description: 'Pinned subscription coding model',
            displayName: 'GPT-5.6 Sol',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{
              reasoningEffort: 'medium',
              description: 'Balanced',
            }, {
              reasoningEffort: 'xhigh',
              description: 'Deep',
            }],
            hidden: false,
            isDefault: true,
          }, {
            id: 'gpt-5.6-terra',
            model: 'gpt-5.6-terra',
            description: 'Alternate subscription coding model',
            displayName: 'GPT-5.6 Terra',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{
              reasoningEffort: 'medium',
              description: 'Balanced',
            }],
            hidden: false,
            isDefault: false,
          }],
          nextCursor: null,
        },
      },
    },
  });
  currentTime += 11;

  const replacementContext = await buildContext();
  assert.equal(first.closed, true);
  assert.equal(runtime.manager.get('1'), null);
  assert.equal(replacementContext.existingSessionId, threadId);

  const replacement = await runtime.manager.getOrSpawn(
    '1',
    replacementContext,
  );
  assert.notEqual(replacement, first);
  assert.notEqual(replacement.generationId, generationId);
  assert.equal(replacement.providerSessionId, threadId);
  assert.equal(runtime.manager.get('1'), replacement);

  const result = await runtime.manager.send('1', 'after catalog refresh');
  await runtime.controller.settleTelegramDelivery('1', result);
  assert.equal(result.generationId, replacement.generationId);
  assert.equal(await runtime.manager.kill('1', 'integration-done'), true);
});

function integrationConfig(fixture) {
  return {
    bot: { pm: 'sdk' },
    defaults: { pm: 'sdk' },
    codex: {
      home: fixture.codexHome,
      binary: fixture.binary,
      daemonSecretRoots: [],
    },
    chats: {
      1: {
        name: 'Codex integration',
        pm: 'codex',
        codexEnabled: true,
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'medium',
        cwd: fixture.workspace,
        model: 'sonnet',
        effort: 'high',
        agent: 'claude-agent',
      },
    },
  };
}

test('warm Claude source resolves the dormant Codex thread for a runtime switch', {
  timeout: 30_000,
}, async (t) => {
  const fixture = makeFixture(t);
  const db = dbClient.open(fixture.dbPath);
  t.after(() => {
    try { db.raw.close(); } catch {}
  });
  const config = integrationConfig(fixture);
  const integrationOrchestra = createIntegrationOrchestra();
  const runtime = createRuntime({
    db,
    config,
    fixture,
    integrationOrchestra,
  });
  db.upsertProviderSession({
    session_key: '1',
    namespace: 'codex:app-server',
    provider: 'codex',
    provider_session_id: 'dormant-codex-thread',
    cwd: fixture.workspace,
    model: 'gpt-5.6-sol',
    effort: 'medium',
    pm_backend: 'codex',
  });
  const liveClaude = {
    runtime: 'claude',
    backend: 'sdk',
    providerSessionId: 'claude-session-must-not-cross-resume',
    closed: false,
  };

  const spawnContext = await buildCodexSpawnContext({
    sessionKey: '1',
    chatId: '1',
    threadId: null,
    chatConfig: config.chats['1'],
    db,
    pm: { get: () => liveClaude },
    runtimeController: runtime.controller,
    getSessionLabel: () => 'Codex integration',
    logEvent() {},
  });

  assert.equal(spawnContext.existingSessionId, 'dormant-codex-thread');
});

async function createHarness(t, scenario) {
  const fixture = makeFixture(t, scenario);
  const db = dbClient.open(fixture.dbPath);
  t.after(() => {
    try { db.raw.close(); } catch {}
  });
  const config = integrationConfig(fixture);
  const integrationOrchestra = createIntegrationOrchestra();
  const runtime = createRuntime({
    db,
    config,
    fixture,
    integrationOrchestra,
  });
  const spawned = await spawnCodex(runtime, db, config);
  t.after(async () => {
    const proc = runtime.manager.get('1');
    if (!proc || proc.closed || proc.state === 'ContainmentFailed') return;
    try {
      await runtime.manager.kill('1', 'integration-cleanup');
    } catch {}
  });
  return {
    config,
    db,
    fixture,
    integrationOrchestra,
    proc: spawned.proc,
    runtime,
  };
}

function activeTurnDescriptor(turnId) {
  return {
    result: {
      turn: {
        id: turnId,
        status: 'inProgress',
        items: [],
      },
    },
    beforeResponseMessages: [turnStarted(turnId)],
  };
}

function completingTurnDescriptor(turnId, text) {
  return {
    ...activeTurnDescriptor(turnId),
    // Keep activation observable even when coverage instrumentation delays the test.
    lateDelayMs: 100,
    lateMessages: completedTurnMessages(turnId, text),
  };
}

async function exerciseCleanRetirementDeliveryRace(t, {
  notificationFirst,
}) {
  const turnId = notificationFirst
    ? 'turn-deploy-notification-first'
    : 'turn-deploy-response-first';
  const releaseFile = notificationFirst
    ? 'release-interrupt-response'
    : 'release-stop-clean';
  const harness = await createHarness(t, {
    methods: {
      'turn/start': activeTurnDescriptor(turnId),
      'turn/interrupt': notificationFirst
        ? {
            result: {},
            beforeResponseMessages: [interruptedTurnMessage(turnId)],
            waitForResponseFile: releaseFile,
          }
        : {
            result: {},
            lateDelayMs: 5,
            lateMessages: [interruptedTurnMessage(turnId)],
          },
      ...(!notificationFirst ? {
        'thread/backgroundTerminals/clean': {
          result: {},
          waitForResponseFile: releaseFile,
        },
      } : {}),
    },
  });
  const {
    db,
    fixture,
    proc,
    runtime,
  } = harness;
  const active = runtime.manager.send('1', 'Interrupted by authorized deploy', {
    context: { sourceMsgId: '41' },
  });
  await waitFor(
    () => proc.activeTurnId === turnId && proc.state === 'Active',
    'the active deploy target',
  );

  let retirementResolved = false;
  const retirement = runtime.manager.retireForCleanRestart({
    continuationAuthorized: true,
    getDeliveryEvidence: () => ({
      outputAttempted: false,
      pending: 0,
      fenced: true,
    }),
  }).then((snapshots) => {
    retirementResolved = true;
    return snapshots;
  });
  let result;
  let markerCount;
  let stateBeforeRelease;
  let preReleaseError = null;
  try {
    result = await active;
    assert.equal(result.error, 'interrupted');
    await waitFor(
      () => readRequests(fixture).some(
        (message) => message.method === 'turn/interrupt',
      ),
      'the authorized deploy interrupt write',
    );
    if (!notificationFirst) {
      await waitFor(
        () => db.raw.prepare(`
          SELECT 1 FROM codex_attempt_checkpoints
           WHERE generation_id = ?
             AND kind = 'stop-terminal-reconciled'
        `).get(proc.generationId) != null,
        'stop-terminal reconciliation before delivery',
      );
    }
    markerCount = db.listCodexAttemptCheckpoints(result.attemptId)
      .filter((row) => row.kind === 'clean-retirement-requested').length;

    await runtime.controller.settleTelegramDelivery(
      '1',
      result,
      { disposition: 'failed' },
    );
    stateBeforeRelease = db.getCodexAttempt(result.attemptId).recovery_state;
    assert.equal(retirementResolved, false);
  } catch (error) {
    preReleaseError = error;
  } finally {
    writeFileSync(path.join(fixture.workspace, releaseFile), '', { mode: 0o600 });
  }
  const retirementResult = await Promise.allSettled([retirement]);
  if (preReleaseError) throw preReleaseError;
  if (retirementResult[0].status === 'rejected') {
    throw retirementResult[0].reason;
  }
  const snapshots = retirementResult[0].value;

  assert.equal(markerCount, 1, 'deploy ownership must remain durable');
  assert.equal(
    stateBeforeRelease,
    notificationFirst ? 'terminal-pending' : 'clean-pending',
  );
  assert.equal(snapshots.length, 1);
  assert.deepEqual(
    {
      eligible: snapshots[0].eligible,
      sessionKey: snapshots[0].sessionKey,
      providerSessionId: snapshots[0].providerSessionId,
      providerTurnId: snapshots[0].providerTurnId,
      sourceMsgId: snapshots[0].sourceMsgId,
    },
    {
      eligible: true,
      sessionKey: '1',
      providerSessionId: result.providerSessionId,
      providerTurnId: result.providerTurnId,
      sourceMsgId: '41',
    },
  );
  assert.equal(db.getCodexAttempt(result.attemptId).recovery_state, 'cancelled');
  assert.equal(db.getCodexLease().status, 'clear');
  assert.equal(
    db.listCodexAttemptCheckpoints(result.attemptId)
      .filter((row) => row.kind === 'telegram-delivery-failed').length,
    1,
  );
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${label}`);
}

function readRequests(fixture) {
  return readFileSync(
    path.join(fixture.workspace, 'fake-codex-requests.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function claimFollowup({
  db,
  runtime,
  proc,
  messageId,
  text,
}) {
  insertInbound(db, {
    chat_id: '1',
    msg_id: messageId,
    bot_name: 'testbot',
    text,
    handler_status: 'dispatched',
  });
  db.recordInboundRuntimeSelection({
    session_key: '1',
    bot_name: 'testbot',
    telegram_chat_id: '1',
    telegram_message_id: String(messageId),
    provider: 'codex',
    ts: Date.now(),
  });
  return runtime.controller.claimDispatchReservation({
    sessionKey: '1',
    generationId: proc.generationId,
    botName: 'testbot',
    telegramChatId: '1',
    telegramMessageId: String(messageId),
  });
}

function createIntegrationAutosteer(config, manager, acknowledged) {
  return createAutosteerHandlers({
    config,
    pm: manager,
    autosteeredRefs: {
      add(sessionKey, ref) {
        acknowledged.push({ sessionKey, ...ref });
      },
    },
    logEvent() {},
  });
}

test('fake app-server runs Polygram text start, stream, final, persistence, and resume', {
  timeout: 30_000,
}, async (t) => {
  const fixture = makeFixture(t);
  const db = dbClient.open(fixture.dbPath);
  t.after(() => {
    try { db.raw.close(); } catch {}
  });
  const config = {
    bot: { pm: 'sdk' },
    defaults: { pm: 'sdk' },
    codex: {
      home: fixture.codexHome,
      binary: fixture.binary,
      daemonSecretRoots: [],
    },
    chats: {
      1: {
        name: 'Codex integration',
        pm: 'codex',
        codexEnabled: true,
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'medium',
        cwd: fixture.workspace,
        model: 'sonnet',
        effort: 'high',
        agent: 'claude-agent',
      },
    },
  };
  db.upsertSession({
    session_key: '1',
    chat_id: '1',
    thread_id: null,
    claude_session_id: 'claude-session-must-survive',
    agent: 'claude-agent',
    cwd: fixture.workspace,
    model: 'sonnet',
    effort: 'high',
    pm_backend: 'sdk',
  });
  const integrationOrchestra = createIntegrationOrchestra();
  const firstRuntime = createRuntime({
    db,
    config,
    fixture,
    integrationOrchestra,
  });
  let first;
  try {
    first = await spawnCodex(firstRuntime, db, config);
  } catch (error) {
    error.message += `; faults=${JSON.stringify(
      integrationOrchestra._observedFaults,
    )}`;
    throw error;
  }
  assert.equal(first.resumed, null);
  assert.equal(first.proc.providerSessionId, 'codex-thread-1');

  const firstChunks = [];
  const firstResult = await firstRuntime.manager.send('1', 'First prompt', {
    context: {
      sourceMsgId: 'telegram-1',
      streamer: {
        async onChunk(text) {
          firstChunks.push(text);
        },
      },
    },
  });
  assert.equal(firstResult.text, 'Hello world');
  assert.equal(firstResult.runtime, 'codex');
  assert.equal(firstResult.backend, 'codex');
  assert.equal(firstResult.providerSessionId, 'codex-thread-1');
  assert.equal(typeof firstResult.attemptId, 'string');
  assert.deepEqual(firstChunks, ['Hello', 'Hello world']);
  assert.equal(
    db.getProviderSession('1', 'codex:app-server').provider_session_id,
    'codex-thread-1',
  );
  assert.equal(
    db.getSession('1').claude_session_id,
    'claude-session-must-survive',
  );
  await firstRuntime.controller.settleTelegramDelivery('1', firstResult);
  assert.equal(
    db.getCodexAttempt(firstResult.attemptId).recovery_state,
    'settled',
  );
  assert.equal(await firstRuntime.manager.kill('1', 'integration-restart'), true);

  const secondRuntime = createRuntime({
    db,
    config,
    fixture,
    integrationOrchestra,
  });
  const second = await spawnCodex(secondRuntime, db, config);
  assert.equal(second.resumed, 'codex-thread-1');
  const secondChunks = [];
  const secondResult = await secondRuntime.manager.send('1', 'Resume prompt', {
    context: {
      sourceMsgId: 'telegram-2',
      streamer: {
        async onChunk(text) {
          secondChunks.push(text);
        },
      },
    },
  });
  assert.equal(secondResult.text, 'Hello world');
  assert.equal(secondResult.runtime, 'codex');
  assert.equal(secondResult.backend, 'codex');
  assert.deepEqual(secondChunks, ['Hello', 'Hello world']);
  await secondRuntime.controller.settleTelegramDelivery('1', secondResult);
  assert.equal(
    db.getCodexAttempt(secondResult.attemptId).recovery_state,
    'settled',
  );
  assert.equal(await secondRuntime.manager.kill('1', 'integration-done'), true);

  const methods = readFileSync(
    path.join(fixture.workspace, 'fake-codex-requests.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((message) => typeof message.method === 'string')
    .map((message) => message.method);
  assert.ok(methods.includes('thread/start'));
  assert.ok(methods.includes('thread/resume'));
  assert.equal(methods.filter((method) => method === 'turn/start').length, 2);
});

test('fake app-server accepts a steer and target delivery settles its linked inbound', {
  timeout: 30_000,
}, async (t) => {
  const turnId = 'turn-linked-steer';
  const harness = await createHarness(t, {
    methods: {
      'turn/start': activeTurnDescriptor(turnId),
      'turn/steer': {
        result: { turnId },
        lateDelayMs: 10,
        lateMessages: completedTurnMessages(
          turnId,
          'Primary plus follow-up',
        ),
      },
    },
  });
  const {
    config,
    db,
    fixture,
    proc,
    runtime,
  } = harness;
  const primary = runtime.manager.send('1', 'Primary prompt', {
    context: { sourceMsgId: '41' },
  });
  await waitFor(
    () => proc.activeTurnId === turnId && proc.state === 'Active',
    'the primary Codex turn to become steerable',
  );

  const claim = claimFollowup({
    db,
    runtime,
    proc,
    messageId: 42,
    text: 'Merge this follow-up',
  });
  const acknowledged = [];
  const autosteer = createIntegrationAutosteer(
    config,
    runtime.manager,
    acknowledged,
  );
  const steered = await autosteer.tryCodexAutosteer({
    sessionKey: '1',
    chatConfig: config.chats[1],
    chatId: '1',
    msg: { message_id: 42 },
    prompt: 'Merge this follow-up',
  });
  assert.equal(steered.outcome, 'accepted');
  assert.equal(steered.turnId, turnId);
  assert.equal(steered.generationId, proc.generationId);
  assert.equal(typeof steered.attemptId, 'string');
  assert.equal(typeof steered.targetAttemptId, 'string');
  assert.deepEqual(acknowledged, [{
    sessionKey: '1',
    chatId: '1',
    msgId: 42,
  }]);

  runtime.controller.finalizeAcceptedSteer({
    sessionKey: '1',
    generationId: proc.generationId,
    reservationId: claim.reservationId,
    steerAttemptId: steered.attemptId,
    targetAttemptId: steered.targetAttemptId,
  });
  assert.equal(
    db.getCodexDispatchReservation(claim.reservationId).state,
    'steer-accepted',
  );
  assert.equal(
    db.raw.prepare(`
      SELECT state FROM codex_linked_inputs
       WHERE linked_input_id = ?
    `).get(claim.reservationId).state,
    'linked',
  );

  const result = await primary;
  assert.equal(result.text, 'Primary plus follow-up');
  assert.equal(result.attemptId, steered.targetAttemptId);
  await runtime.controller.settleTelegramDelivery('1', result);

  assert.equal(
    db.getCodexDispatchReservation(claim.reservationId).state,
    'settled',
  );
  assert.equal(
    db.getCodexAttempt(steered.attemptId).recovery_state,
    'settled',
  );
  assert.equal(
    db.raw.prepare(`
      SELECT state FROM codex_linked_inputs
       WHERE linked_input_id = ?
    `).get(claim.reservationId).state,
    'settled',
  );
  assert.equal(
    db.raw.prepare(`
      SELECT handler_status FROM messages
       WHERE chat_id = '1' AND msg_id = 42
    `).get().handler_status,
    'replied',
  );

  const steerRequest = readRequests(fixture)
    .find((message) => message.method === 'turn/steer');
  assert.equal(steerRequest.params.expectedTurnId, turnId);
  assert.equal(steerRequest.params.input[0].text, 'Merge this follow-up');
  await runtime.manager.kill('1', 'accepted-steer-complete');
});

test('fake app-server local not-active outcome queues one later turn', {
  timeout: 30_000,
}, async (t) => {
  const harness = await createHarness(t, {
    methods: {
      'turn/start': [
        completingTurnDescriptor('turn-before-fallback', 'First result'),
        completingTurnDescriptor('turn-queued-fallback', 'Queued result'),
      ],
    },
  });
  const {
    config,
    db,
    fixture,
    proc,
    runtime,
  } = harness;
  const first = await runtime.manager.send('1', 'Primary prompt', {
    context: { sourceMsgId: '41' },
  });
  await runtime.controller.settleTelegramDelivery('1', first);
  assert.equal(proc.state, 'Idle');

  const claim = claimFollowup({
    db,
    runtime,
    proc,
    messageId: 42,
    text: 'Run after the completed turn',
  });
  const fallback = await runtime.manager.steerTurn(
    '1',
    'Run after the completed turn',
    { context: { sourceMsgId: '42' } },
  );
  assert.equal(fallback.outcome, 'queueable-not-active');
  runtime.controller.markDispatchDisposition({
    sessionKey: '1',
    generationId: proc.generationId,
    reservationId: claim.reservationId,
    disposition: 'queue-authorized',
  });

  const queued = await runtime.manager.send(
    '1',
    'Run after the completed turn',
    { context: { sourceMsgId: '42' } },
  );
  await runtime.controller.settleTelegramDelivery('1', queued);
  runtime.controller.settleQueuedDispatch({
    sessionKey: '1',
    generationId: proc.generationId,
    reservationId: claim.reservationId,
    attemptId: queued.attemptId,
    botName: 'testbot',
    telegramChatId: '1',
    telegramMessageId: '42',
  });

  assert.equal(queued.text, 'Queued result');
  assert.equal(
    db.getCodexDispatchReservation(claim.reservationId).state,
    'settled',
  );
  const turnRequests = readRequests(fixture)
    .filter((message) => message.method === 'turn/start');
  assert.deepEqual(
    turnRequests.map((request) => request.params.input[0].text),
    ['Primary prompt', 'Run after the completed turn'],
  );
  assert.equal(
    readRequests(fixture)
      .filter((message) => message.method === 'turn/steer')
      .length,
    0,
    'the local not-active result must not write a stale steer RPC',
  );
  await runtime.manager.kill('1', 'queued-fallback-complete');
});

test('fake app-server ambiguous steer is never queued or crash-replayed', {
  timeout: 30_000,
}, async (t) => {
  const turnId = 'turn-ambiguous-steer';
  const harness = await createHarness(t, {
    methods: {
      'turn/start': activeTurnDescriptor(turnId),
      'turn/steer': {
        closeAfterRead: true,
        exitCode: 71,
      },
    },
  });
  const {
    config,
    db,
    fixture,
    proc,
    runtime,
  } = harness;
  const primary = runtime.manager.send('1', 'Primary prompt', {
    context: { sourceMsgId: '41' },
  });
  await waitFor(
    () => proc.activeTurnId === turnId && proc.state === 'Active',
    'the primary Codex turn to become steerable',
  );

  const claim = claimFollowup({
    db,
    runtime,
    proc,
    messageId: 42,
    text: 'Possibly accepted follow-up',
  });
  const autosteer = createIntegrationAutosteer(
    config,
    runtime.manager,
    [],
  );
  const steered = await autosteer.tryCodexAutosteer({
    sessionKey: '1',
    chatConfig: config.chats[1],
    chatId: '1',
    msg: { message_id: 42 },
    prompt: 'Possibly accepted follow-up',
  });
  assert.equal(steered.outcome, 'ambiguous');
  runtime.controller.markDispatchDisposition({
    sessionKey: '1',
    generationId: proc.generationId,
    reservationId: claim.reservationId,
    disposition: 'ambiguous',
  });
  await assert.rejects(
    primary,
    (error) => [
      'CODEX_CONTAINMENT_FAILED',
      'CODEX_RPC_OUTCOME_UNKNOWN',
    ].includes(error.code),
  );

  assert.equal(
    db.getCodexDispatchReservation(claim.reservationId).state,
    'ambiguous',
  );
  assert.equal(
    db.raw.prepare(`
      SELECT handler_status FROM messages
       WHERE chat_id = '1' AND msg_id = 42
    `).get().handler_status,
    'codex-ambiguous',
  );
  const candidate = { chat_id: '1', thread_id: null, msg_id: 42 };
  const replay = classifyReplay({
    candidates: [candidate],
    cleanShutdown: false,
    getProviderRecovery: () => db.getReplayProviderRecovery({
      sessionKey: '1',
      botName: 'testbot',
      telegramChatId: '1',
      telegramMessageId: '42',
    }),
  });
  assert.deepEqual(replay.recover, []);
  assert.equal(replay.recoverCodex, undefined);
  assert.deepEqual(replay.defer, [candidate]);
  assert.equal(
    readRequests(fixture)
      .filter((message) => message.method === 'turn/start')
      .length,
    1,
    'ambiguous steering must not create a fallback turn',
  );
});

test('authorized deploy keeps Codex continuation ownership when interrupt response arrives first', {
  timeout: 30_000,
}, async (t) => {
  await exerciseCleanRetirementDeliveryRace(t, {
    notificationFirst: false,
  });
});

test('authorized deploy keeps Codex continuation ownership when terminal notification arrives first', {
  timeout: 30_000,
}, async (t) => {
  await exerciseCleanRetirementDeliveryRace(t, {
    notificationFirst: true,
  });
});

test('fake app-server stop orders exact terminal, clean, fresh-empty and cancels queued work', {
  timeout: 30_000,
}, async (t) => {
  const turnId = 'turn-stop-active';
  const harness = await createHarness(t, {
    methods: {
      'turn/start': activeTurnDescriptor(turnId),
      'turn/interrupt': {
        result: {},
        lateDelayMs: 5,
        lateMessages: [interruptedTurnMessage(turnId)],
      },
    },
  });
  const {
    config,
    db,
    fixture,
    proc,
    runtime,
  } = harness;
  const active = runtime.manager.send('1', 'Long-running prompt', {
    context: { sourceMsgId: '41' },
  });
  await waitFor(
    () => proc.activeTurnId === turnId && proc.state === 'Active',
    'the turn that will be interrupted',
  );
  const queued = runtime.manager.send('1', 'Must be cancelled', {
    context: { sourceMsgId: '42' },
  });
  const queuedOutcome = queued.then(
    () => null,
    (error) => error,
  );
  await waitFor(
    () => proc.pendingQueue.length === 2,
    'the second turn to enter the owned queue',
  );

  const interrupted = await runtime.manager.interrupt('1');
  assert.equal(interrupted, true);
  const activeResult = await active;
  assert.equal(activeResult.error, 'interrupted');
  assert.equal((await queuedOutcome)?.code, 'INTERRUPTED');
  assert.equal(proc.state, 'Closed');
  assert.equal(runtime.manager.has('1'), false);

  const requests = readRequests(fixture);
  const activeStartIndex = requests.findLastIndex(
    (message) => message.method === 'turn/start',
  );
  const stopMethods = requests
    .slice(activeStartIndex)
    .filter((message) => typeof message.method === 'string')
    .map((message) => message.method);
  assert.deepEqual(stopMethods, [
    'turn/start',
    'turn/interrupt',
    'thread/backgroundTerminals/clean',
    'thread/backgroundTerminals/list',
  ]);
  const freshList = requests.findLast(
    (message) => message.method === 'thread/backgroundTerminals/list',
  );
  assert.equal(Object.hasOwn(freshList.params, 'cursor'), false);

  const checkpointKinds = db.raw.prepare(`
    SELECT kind FROM codex_attempt_checkpoints
     WHERE generation_id = ?
     ORDER BY id
  `).all(proc.generationId).map((row) => row.kind);
  const terminal = checkpointKinds.indexOf('turn-terminal');
  const reconciled = checkpointKinds.indexOf('stop-terminal-reconciled');
  const clean = checkpointKinds.indexOf('stop-clean-accepted');
  const empty = checkpointKinds.indexOf('stop-empty-registry-observed');
  assert.ok(
    terminal >= 0
      && terminal < reconciled
      && reconciled < clean
      && clean < empty,
  );
  assert.deepEqual(
    db.raw.prepare(`
      SELECT method, delivery_state, recovery_state,
             telegram_source_message_id
        FROM codex_turn_attempts
       WHERE generation_id = ? AND method = 'queued/send'
    `).get(proc.generationId),
    {
      method: 'queued/send',
      delivery_state: 'prepared',
      recovery_state: 'cancelled',
      telegram_source_message_id: '42',
    },
  );
  assert.equal(
    requests.filter((message) => message.method === 'turn/start').length,
    1,
    'the cancelled queued handler must never reach app-server',
  );
  assert.equal(
    db.getCodexAttempt(activeResult.attemptId).recovery_state,
    'cancelled',
    'an exact stopped turn is disposed without claiming Telegram delivery',
  );
  assert.equal(db.getCodexLease().status, 'clear');
  assert.deepEqual(
    await runtime.controller.settleTelegramDelivery(
      '1',
      activeResult,
      { disposition: 'failed' },
    ),
    {
      committed: true,
      disposition: 'stop-cancelled',
      generationId: proc.generationId,
      attemptId: activeResult.attemptId,
    },
    'the exact late handler outcome is idempotent after stop cancellation',
  );

  const replacement = await spawnCodex(runtime, db, config);
  assert.notEqual(replacement.proc.generationId, proc.generationId);
  assert.equal(runtime.manager.has('1'), true);
});

test('natural completion during stop holds retirement until exact Telegram settlement', {
  timeout: 30_000,
}, async (t) => {
  const turnId = 'turn-stop-natural-completion';
  const harness = await createHarness(t, {
    methods: {
      'turn/start': completingTurnDescriptor(
        turnId,
        'Naturally completed while stop was in flight.',
      ),
      'turn/interrupt': {
        error: {
          code: -32602,
          message: 'no active turn to interrupt',
        },
      },
    },
  });
  const {
    db,
    proc,
    runtime,
  } = harness;
  const active = runtime.manager.send('1', 'Complete during stop', {
    context: { sourceMsgId: '41' },
  });
  await waitFor(
    () => proc.activeTurnId === turnId && proc.state === 'Active',
    'the naturally completing turn',
  );

  let stopResolved = false;
  const stop = runtime.manager.interrupt('1').then((value) => {
    stopResolved = true;
    return value;
  });
  const result = await active;
  assert.equal(result.error, null);
  await waitFor(() => proc.closed, 'the closed natural-race transport');
  assert.equal(stopResolved, false);
  assert.equal(db.getCodexLease().status, 'active');

  assert.deepEqual(
    await runtime.controller.settleTelegramDelivery('1', result),
    {
      committed: true,
      disposition: 'delivered',
      generationId: proc.generationId,
      attemptId: result.attemptId,
    },
  );
  assert.equal(await stop, true);
  assert.equal(db.getCodexLease().status, 'clear');
  assert.equal(runtime.manager.has('1'), false);

  const replacement = await spawnCodex(runtime, db, harness.config);
  assert.notEqual(replacement.proc.generationId, proc.generationId);
});

test('failed Telegram delivery releases a naturally completed stop race', {
  timeout: 30_000,
}, async (t) => {
  const turnId = 'turn-stop-delivery-failed';
  const harness = await createHarness(t, {
    methods: {
      'turn/start': completingTurnDescriptor(
        turnId,
        'Completed, but Telegram delivery failed.',
      ),
      'turn/interrupt': {
        error: {
          code: -32602,
          message: 'no active turn to interrupt',
        },
      },
    },
  });
  const {
    db,
    proc,
    runtime,
  } = harness;
  const active = runtime.manager.send('1', 'Fail Telegram delivery', {
    context: { sourceMsgId: '41' },
  });
  await waitFor(
    () => proc.activeTurnId === turnId && proc.state === 'Active',
    'the naturally completing failed-delivery turn',
  );

  let stopResolved = false;
  const stop = runtime.manager.interrupt('1').then((value) => {
    stopResolved = true;
    return value;
  });
  const result = await active;
  await waitFor(() => proc.closed, 'the failed-delivery closed transport');
  assert.equal(stopResolved, false);

  assert.deepEqual(
    await runtime.controller.settleTelegramDelivery(
      '1',
      result,
      { disposition: 'failed' },
    ),
    {
      committed: true,
      disposition: 'failed',
      generationId: proc.generationId,
      attemptId: result.attemptId,
    },
  );
  assert.equal(await stop, true);
  assert.equal(db.getCodexAttempt(result.attemptId).recovery_state, 'settled');
  assert.equal(db.getCodexLease().status, 'clear');
});

test('fake app-server serializes two rapid steers in Telegram order', {
  timeout: 30_000,
}, async (t) => {
  const turnId = 'turn-two-steers';
  const harness = await createHarness(t, {
    methods: {
      'turn/start': activeTurnDescriptor(turnId),
      'turn/steer': {
        result: { turnId },
      },
      'turn/interrupt': {
        result: {},
        lateDelayMs: 5,
        lateMessages: [interruptedTurnMessage(turnId)],
      },
    },
  });
  const {
    config,
    fixture,
    proc,
    runtime,
  } = harness;
  const primary = runtime.manager.send('1', 'Primary prompt', {
    context: { sourceMsgId: '40' },
  });
  await waitFor(
    () => proc.activeTurnId === turnId && proc.state === 'Active',
    'the primary turn for rapid steering',
  );

  const acknowledged = [];
  const autosteer = createIntegrationAutosteer(
    config,
    runtime.manager,
    acknowledged,
  );
  const invoke = (messageId, prompt) => autosteer.tryCodexAutosteer({
    sessionKey: '1',
    chatConfig: config.chats[1],
    chatId: '1',
    msg: { message_id: messageId },
    prompt,
  });
  const [first, second] = await Promise.all([
    invoke(41, 'First rapid steer'),
    invoke(42, 'Second rapid steer'),
  ]);
  assert.equal(first.outcome, 'accepted');
  assert.equal(second.outcome, 'accepted');
  assert.notEqual(first.attemptId, second.attemptId);
  assert.deepEqual(
    acknowledged.map(({ msgId }) => msgId),
    [41, 42],
  );
  assert.deepEqual(
    readRequests(fixture)
      .filter((message) => message.method === 'turn/steer')
      .map((message) => message.params.input[0].text),
    ['First rapid steer', 'Second rapid steer'],
  );

  assert.equal(await runtime.manager.interrupt('1'), true);
  assert.equal((await primary).error, 'interrupted');
});

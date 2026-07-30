/**
 * Runtime config resolution is deliberately pure. These tests pin the
 * compatibility boundary before handlers/process creation start using it.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createCodexRuntimeAvailability,
  RuntimeConfigError,
  requireCodexEnabled,
  requireCodexDispatchEnabled,
  resolveCodexRuntimeCandidate,
  resolveCodexRuntimeRequest,
  resolveCodexEnabled,
  processMatchesRuntime,
  resolveRuntimeConfig,
  resolveRuntimeDescriptor,
} = require('../lib/runtime-config');
const orchestra = require('@shumkov/orchestra');

const TEST_RECEIPTS = new WeakSet();

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

function codexAvailability({
  spawnProfileId = 'codex-profile-v1',
  model,
  effort,
  cwd,
  modelCatalog = [{
    model,
    supportedReasoningEfforts: [effort],
  }],
} = {}) {
  const receipt = deepFreeze({
    runtime: 'codex',
    spawnProfileId,
    modelCatalog,
    expectedStaticProfile: {
      model,
      effort,
      cwd,
      binaryPath: '/Applications/Codex.app/Contents/Resources/codex',
      binaryVersion: 'test',
      home: '/Users/test',
      policy: 'read-write',
    },
  });
  TEST_RECEIPTS.add(receipt);
  const previous = orchestra.assertCodexSpawnProfile;
  orchestra.assertCodexSpawnProfile = (candidate) => {
    if (!TEST_RECEIPTS.has(candidate)) {
      const error = new Error('invalid test receipt');
      error.code = 'CODEX_PREFLIGHT_RECEIPT_INVALID';
      throw error;
    }
    return candidate;
  };
  try {
    return createCodexRuntimeAvailability(receipt);
  } finally {
    if (previous === undefined) {
      delete orchestra.assertCodexSpawnProfile;
    } else {
      orchestra.assertCodexSpawnProfile = previous;
    }
  }
}

function resolve(config, overrides = {}) {
  return resolveRuntimeConfig({
    config,
    chatId: '100',
    threadId: '7',
    ...overrides,
  });
}

describe('resolveRuntimeConfig — precedence and attribution', () => {
  test('Codex enablement uses topic, chat, bot, then default boolean precedence', () => {
    const config = {
      defaults: { codexEnabled: false },
      bot: { codexEnabled: true },
      chats: {
        '100': {
          codexEnabled: false,
          topics: {
            '7': { codexEnabled: true },
            '8': { codexEnabled: 'yes' },
          },
        },
        '200': { codexEnabled: 'yes' },
      },
    };

    assert.equal(resolveCodexEnabled(config, '100', '7'), true);
    assert.equal(resolveCodexEnabled(config, '100', '8'), false);
    assert.equal(resolveCodexEnabled(config, '100', '9'), false);
    assert.equal(resolveCodexEnabled(config, '200', null), true);
    assert.equal(resolveCodexEnabled({ defaults: { codexEnabled: true } }, '300'), true);
    assert.equal(resolveCodexEnabled({}, '300'), false);
  });

  test('Codex authorization throws a stable scope error only when disabled', () => {
    assert.equal(
      requireCodexEnabled(
        { chats: { '100': { codexEnabled: true } } },
        '100',
      ),
      true,
    );
    assert.throws(
      () => requireCodexEnabled(
        { chats: { '100': {} } },
        '100',
      ),
      (error) => {
        assert.ok(error instanceof RuntimeConfigError);
        assert.equal(error.code, 'CODEX_SCOPE_DISABLED');
        assert.equal(error.runtime, 'codex');
        assert.match(error.message, /not enabled/i);
        return true;
      },
    );
  });

  test('disabled Claude-selected sibling topic cannot dispatch to a live shared Codex generation', () => {
    const config = {
      chats: {
        '100': {
          codexEnabled: true,
          topics: {
            '7': { codexEnabled: false },
            '8': { codexEnabled: true },
          },
        },
      },
    };

    assert.throws(
      () => requireCodexDispatchEnabled({
        config,
        chatId: '100',
        threadId: '7',
        selectedProvider: 'claude',
        liveCodexGeneration: true,
      }),
      (error) => {
        assert.ok(error instanceof RuntimeConfigError);
        assert.equal(error.code, 'CODEX_SCOPE_DISABLED');
        return true;
      },
    );
    assert.equal(
      requireCodexDispatchEnabled({
        config,
        chatId: '100',
        threadId: '8',
        selectedProvider: 'claude',
        liveCodexGeneration: true,
      }),
      true,
    );
    assert.equal(
      requireCodexDispatchEnabled({
        config,
        chatId: '100',
        threadId: '7',
        selectedProvider: 'claude',
        liveCodexGeneration: false,
      }),
      false,
    );
  });

  test('live-process matching is target-relative across all runtimes', () => {
    const sdk = { runtime: 'claude', backend: 'sdk', closed: false };
    const cli = { runtime: 'claude', backend: 'cli', closed: false };
    const codex = { runtime: 'codex', backend: 'codex', closed: false };

    assert.equal(processMatchesRuntime(sdk, 'claude', 'sdk'), true);
    assert.equal(processMatchesRuntime(sdk, 'claude', 'cli'), false);
    assert.equal(processMatchesRuntime(sdk, 'codex', 'codex'), false);
    assert.equal(processMatchesRuntime(cli, 'claude', 'cli'), true);
    assert.equal(processMatchesRuntime(cli, 'claude', 'sdk'), false);
    assert.equal(processMatchesRuntime(codex, 'codex', 'codex'), true);
    assert.equal(processMatchesRuntime(codex, 'claude', 'sdk'), false);
    assert.equal(
      processMatchesRuntime({ ...codex, closed: true }, 'codex', 'codex'),
      false,
    );
  });

  test('lightweight descriptor shares canonical precedence without Codex preflight', () => {
    const descriptor = resolveRuntimeDescriptor({
      config: {
        bot: { pm: 'cli' },
        chats: {
          '100': {
            pm: 'sdk',
            topics: { '7': { pm: 'codex' } },
          },
        },
      },
      chatId: '100',
      threadId: '7',
    });

    assert.equal(descriptor.configuredPm, 'codex');
    assert.equal(descriptor.source, 'topic');
    assert.equal(descriptor.runtime, 'codex');
    assert.equal(descriptor.backend, 'codex');
    assert.equal(descriptor.promptMode, 'codex');
    assert.equal(descriptor.codexEnabled, false);
    assert.ok(Object.isFrozen(descriptor));
  });

  test('disabled saved Codex remains observable but cannot cross runtime boundaries', () => {
    const config = {
      defaults: {
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'xhigh',
        cwd: '/work',
      },
      chats: { '100': { pm: 'codex' } },
    };

    const descriptor = resolveRuntimeDescriptor({
      config,
      chatId: '100',
      threadId: '7',
    });
    assert.equal(descriptor.runtime, 'codex');
    assert.equal(descriptor.backend, 'codex');
    assert.equal(descriptor.codexEnabled, false);

    for (const resolveDisabled of [
      () => resolveCodexRuntimeCandidate({
        config,
        chatId: '100',
        threadId: '7',
      }),
      () => resolveCodexRuntimeRequest({
        config,
        chatId: '100',
        threadId: '7',
      }),
      () => resolveRuntimeConfig({
        config,
        chatId: '100',
        threadId: '7',
        codexAvailability: {
          state: 'unavailable',
          reason: 'must not win over scope policy',
        },
      }),
    ]) {
      assert.throws(
        resolveDisabled,
        (error) => error.code === 'CODEX_SCOPE_DISABLED',
      );
    }
  });

  test('resolves the exact enabled Codex request before preflight', () => {
    const request = resolveCodexRuntimeRequest({
      config: {
        defaults: { cwd: '/default', codexEffort: 'high' },
        bot: { codexModel: 'gpt-5.6-sol' },
        chats: {
          '100': {
            pm: 'codex',
            codexEnabled: true,
            topics: { '7': { codexEffort: 'xhigh' } },
          },
        },
      },
      chatId: '100',
      threadId: '7',
    });

    assert.deepEqual(request, {
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      cwd: '/default',
      sources: {
        pm: 'chat',
        model: 'bot',
        effort: 'topic',
        cwd: 'default',
      },
    });
    assert.ok(Object.isFrozen(request));
    assert.equal(
      resolveCodexRuntimeRequest({
        config: { chats: { '100': { pm: 'sdk' } } },
        chatId: '100',
        threadId: '7',
      }),
      null,
    );
  });

  test('resolves a prospective Codex candidate while the current runtime remains Claude', () => {
    const config = {
      defaults: { cwd: '/default', codexEffort: 'high' },
      bot: { codexModel: 'gpt-5.6-sol' },
      chats: {
        '100': {
          pm: 'sdk',
          codexEnabled: true,
          topics: { '7': { codexEffort: 'xhigh' } },
        },
      },
    };

    const candidate = resolveCodexRuntimeCandidate({
      config,
      chatId: '100',
      threadId: '7',
    });

    assert.deepEqual(candidate, {
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      cwd: '/default',
      sources: {
        model: 'bot',
        effort: 'topic',
        cwd: 'default',
      },
    });
    assert.ok(Object.isFrozen(candidate));
    assert.equal(
      resolveCodexRuntimeRequest({
        config,
        chatId: '100',
        threadId: '7',
      }),
      null,
    );
  });

  test('topic overrides chat, bot, and default independently for runtime/model/effort', () => {
    const config = {
      defaults: {
        pm: 'sdk',
        codexModel: 'codex-default',
        codexEffort: 'low',
        cwd: '/default',
      },
      bot: {
        pm: 'cli',
        codexModel: 'codex-bot',
        codexEffort: 'medium',
      },
      chats: {
        '100': {
          pm: 'tmux',
          codexModel: 'codex-chat',
          codexEffort: 'high',
          topics: {
            '7': {
              pm: 'codex',
              codexEnabled: true,
              codexModel: 'codex-topic',
              codexEffort: 'xhigh',
            },
          },
        },
      },
    };

    const got = resolve(config, {
      codexAvailability: codexAvailability({
        model: 'codex-topic',
        effort: 'xhigh',
        cwd: '/default',
      }),
    });

    assert.equal(got.configuredPm, 'codex');
    assert.equal(got.runtime, 'codex');
    assert.equal(got.provider, 'codex');
    assert.equal(got.backend, 'codex');
    assert.equal(got.sessionNamespace, 'codex:app-server');
    assert.equal(got.promptMode, 'codex');
    assert.equal(got.modelFamily, 'codex');
    assert.equal(got.model, 'codex-topic');
    assert.equal(got.effort, 'xhigh');
    assert.deepEqual(got.sources, {
      pm: 'topic',
      model: 'topic',
      effort: 'topic',
      cwd: 'default',
      agent: null,
    });
  });

  test('each field falls through independently and reports its actual source', () => {
    const config = {
      defaults: {
        pm: 'sdk',
        codexModel: 'codex-default',
        codexEffort: 'low',
        cwd: '/default',
      },
      bot: { codexModel: 'codex-bot' },
      chats: {
        '100': {
          pm: 'codex',
          codexEnabled: true,
          topics: { '7': { codexEffort: 'xhigh' } },
        },
      },
    };

    const got = resolve(config, {
      codexAvailability: codexAvailability({
        model: 'codex-bot',
        effort: 'xhigh',
        cwd: '/default',
      }),
    });

    assert.equal(got.model, 'codex-bot');
    assert.equal(got.effort, 'xhigh');
    assert.deepEqual(got.sources, {
      pm: 'chat',
      model: 'bot',
      effort: 'topic',
      cwd: 'default',
      agent: null,
    });
  });

  test('built-in default remains Claude SDK and does not require Codex preflight', () => {
    const got = resolve({});

    assert.equal(got.configuredPm, 'sdk');
    assert.equal(got.runtime, 'claude');
    assert.equal(got.provider, 'claude');
    assert.equal(got.backend, 'sdk');
    assert.equal(got.sessionNamespace, 'claude:inline');
    assert.equal(got.promptMode, 'inline');
    assert.equal(got.modelFamily, 'claude');
    assert.equal(got.model, null);
    assert.equal(got.effort, null);
    assert.deepEqual(got.sources, {
      pm: 'default',
      model: null,
      effort: null,
      cwd: null,
      agent: null,
    });
  });

  test('config.defaults.pm is not a backend scope; function default preserves existing behavior', () => {
    const got = resolve(
      { defaults: { pm: 'codex' } },
      { defaultPm: 'cli' },
    );

    assert.equal(got.configuredPm, 'cli');
    assert.equal(got.runtime, 'claude');
    assert.equal(got.backend, 'cli');
    assert.equal(got.sources.pm, 'default');
  });
});

describe('resolveRuntimeConfig — backend/session compatibility', () => {
  const cases = [
    {
      pm: 'sdk',
      backend: 'sdk',
      namespace: 'claude:inline',
      promptMode: 'inline',
    },
    {
      pm: 'cli',
      backend: 'cli',
      namespace: 'claude:channels',
      promptMode: 'channels',
    },
    {
      pm: 'channels',
      backend: 'cli',
      namespace: 'claude:channels',
      promptMode: 'channels',
    },
    {
      pm: 'tmux',
      backend: 'cli',
      namespace: 'claude:channels',
      promptMode: 'channels',
    },
  ];

  for (const { pm, backend, namespace, promptMode } of cases) {
    test(`${pm} preserves its current canonical backend and session namespace`, () => {
      const got = resolve({ chats: { '100': { pm } } });

      assert.equal(got.configuredPm, pm);
      assert.equal(got.runtime, 'claude');
      assert.equal(got.provider, 'claude');
      assert.equal(got.backend, backend);
      assert.equal(got.sessionNamespace, namespace);
      assert.equal(got.promptMode, promptMode);
    });
  }

  test('configured tmux alias is Channels-class even though historical persisted tmux rows are inline', () => {
    const got = resolve({ chats: { '100': { pm: 'tmux' } } });

    assert.equal(got.configuredPm, 'tmux');
    assert.equal(got.backend, 'cli');
    assert.equal(got.sessionNamespace, 'claude:channels');
  });

  test('matches Orchestra truthy precedence, empty fallthrough, aliases, and no-chat default', () => {
    const cases = [
      {
        config: {
          bot: { pm: 'cli' },
          chats: {
            '100': {
              pm: 'sdk',
              topics: { '7': { pm: '' } },
            },
          },
        },
        chatId: '100',
        threadId: '7',
      },
      {
        config: {
          bot: { pm: 'sdk' },
          chats: { '100': { pm: 'channels' } },
        },
        chatId: '100',
        threadId: null,
      },
      {
        config: {
          bot: { pm: 'cli' },
          chats: { '100': { pm: 0 } },
        },
        chatId: '100',
        threadId: null,
      },
      {
        config: { bot: { pm: 'cli' } },
        chatId: null,
        threadId: null,
      },
    ];

    for (const row of cases) {
      const expected = orchestra.pickBackend({
        ...row,
        pmDefault: 'sdk',
        logger: { warn() {} },
      });
      const got = resolveRuntimeConfig({
        ...row,
        defaultPm: 'sdk',
        logger: { warn() {} },
      });
      assert.equal(got.backend, expected);
    }
  });

  test('no-chat invalid or Codex defaults preserve Orchestra factory SDK fallback', () => {
    for (const defaultPm of ['invalid-default', 'codex']) {
      const got = resolveRuntimeConfig({
        config: { bot: { pm: 'cli' } },
        chatId: null,
        defaultPm,
      });
      assert.equal(got.runtime, 'claude');
      assert.equal(got.backend, 'sdk');
      assert.equal(got.configuredPm, defaultPm);
    }
  });

  test('Codex is a separate runtime descriptor, not an Orchestra pickBackend value', () => {
    const got = resolve(
      {
        defaults: { codexModel: 'gpt-test', codexEffort: 'high', cwd: '/work' },
        chats: { '100': { pm: 'codex', codexEnabled: true } },
      },
      {
        codexAvailability: codexAvailability({
          model: 'gpt-test',
          effort: 'high',
          cwd: '/work',
        }),
      },
    );

    assert.equal(got.configuredPm, 'codex');
    assert.equal(got.runtime, 'codex');
    assert.equal(got.backend, 'codex');
    assert.equal(got.sessionNamespace, 'codex:app-server');
  });

  test('equivalent canonical config produces the same stable spawn identity', () => {
    const cli = resolve({ chats: { '100': { pm: 'cli', model: 'opus', effort: 'high' } } });
    const alias = resolve({ chats: { '100': { pm: 'channels', model: 'opus', effort: 'high' } } });
    const repeated = resolve({ chats: { '100': { pm: 'cli', model: 'opus', effort: 'high' } } });

    assert.equal(cli.runtimeConfigIdentity, alias.runtimeConfigIdentity);
    assert.equal(cli.runtimeConfigIdentity, repeated.runtimeConfigIdentity);
    assert.match(cli.runtimeConfigIdentity, /^runtime-config:v1:/);
    assert.equal('spawnContextIdentity' in cli, false);
  });

  test('Codex model changes preserve identity while preflight profile changes it', () => {
    const first = resolve(
      {
        defaults: { codexEffort: 'high', cwd: '/work' },
        chats: {
          '100': { pm: 'codex', codexEnabled: true, codexModel: 'gpt-a' },
        },
      },
      {
        codexAvailability: codexAvailability({
          model: 'gpt-a',
          effort: 'high',
          cwd: '/work',
        }),
      },
    );
    const changedModel = resolve(
      {
        defaults: { codexEffort: 'high', cwd: '/work' },
        chats: {
          '100': { pm: 'codex', codexEnabled: true, codexModel: 'gpt-b' },
        },
      },
      {
        codexAvailability: codexAvailability({
          model: 'gpt-b',
          effort: 'high',
          cwd: '/work',
        }),
      },
    );
    const changedProfile = resolve(
      {
        defaults: { codexEffort: 'high', cwd: '/work' },
        chats: {
          '100': { pm: 'codex', codexEnabled: true, codexModel: 'gpt-a' },
        },
      },
      {
        codexAvailability: codexAvailability({
          spawnProfileId: 'codex-profile-v2',
          model: 'gpt-a',
          effort: 'high',
          cwd: '/work',
        }),
      },
    );

    assert.equal(first.runtimeConfigIdentity, changedModel.runtimeConfigIdentity);
    assert.notEqual(first.runtimeConfigIdentity, changedProfile.runtimeConfigIdentity);
  });

  test('resolved cwd and Claude agent participate in spawn-context drift', () => {
    const baseline = resolve({
      defaults: { cwd: '/default', agent: 'default-agent' },
      chats: { '100': { pm: 'sdk', cwd: '/chat', agent: 'chat-agent' } },
    });
    const changedCwd = resolve({
      defaults: { cwd: '/default', agent: 'default-agent' },
      chats: { '100': { pm: 'sdk', cwd: '/other', agent: 'chat-agent' } },
    });
    const changedAgent = resolve({
      defaults: { cwd: '/default', agent: 'default-agent' },
      chats: { '100': { pm: 'sdk', cwd: '/chat', agent: 'other-agent' } },
    });

    assert.equal(baseline.cwd, '/chat');
    assert.equal(baseline.agent, 'chat-agent');
    assert.equal(baseline.sources.cwd, 'chat');
    assert.equal(baseline.sources.agent, 'chat');
    assert.notEqual(baseline.runtimeConfigIdentity, changedCwd.runtimeConfigIdentity);
    assert.notEqual(baseline.runtimeConfigIdentity, changedAgent.runtimeConfigIdentity);
  });

  test('topic cwd and Claude agent override chat without inventing default layers', () => {
    const got = resolve({
      defaults: { cwd: '/default', agent: 'default-agent' },
      chats: {
        '100': {
          cwd: '/chat',
          agent: 'chat-agent',
          topics: {
            '7': { cwd: '/topic', agent: 'topic-agent' },
          },
        },
      },
    });

    assert.equal(got.cwd, '/topic');
    assert.equal(got.agent, 'topic-agent');
    assert.equal(got.sources.cwd, 'topic');
    assert.equal(got.sources.agent, 'topic');

    const noChatValues = resolve({
      defaults: { cwd: '/invented-default', agent: 'invented-default-agent' },
      chats: { '100': {} },
    });
    assert.equal(noChatValues.cwd, null);
    assert.equal(noChatValues.agent, null);
  });

  test('Codex resolves cwd but never reuses Claude agent as instructions', () => {
    const availability = codexAvailability({
      model: 'gpt-test',
      effort: 'high',
      cwd: '/codex',
    });
    const first = resolve(
      {
        defaults: {
          cwd: '/default',
          agent: 'default-agent',
          codexModel: 'gpt-test',
          codexEffort: 'high',
        },
        chats: {
          '100': {
            pm: 'codex',
            codexEnabled: true,
            cwd: '/codex',
            agent: 'claude-agent-a',
          },
        },
      },
      { codexAvailability: availability },
    );
    const changedClaudeAgent = resolve(
      {
        defaults: {
          cwd: '/default',
          agent: 'default-agent',
          codexModel: 'gpt-test',
          codexEffort: 'high',
        },
        chats: {
          '100': {
            pm: 'codex',
            codexEnabled: true,
            cwd: '/codex',
            agent: 'claude-agent-b',
          },
        },
      },
      { codexAvailability: availability },
    );

    assert.equal(first.cwd, '/codex');
    assert.equal(first.agent, null);
    assert.equal(first.sources.cwd, 'chat');
    assert.equal(first.sources.agent, null);
    assert.equal(first.runtimeConfigIdentity, changedClaudeAgent.runtimeConfigIdentity);
  });
});

describe('resolveRuntimeConfig — provider model isolation', () => {
  const config = {
    chats: {
      '100': {
        model: 'claude-opus',
        effort: 'high',
        codexModel: 'gpt-5-codex',
        codexEffort: 'xhigh',
      },
    },
  };

  test('Claude does not claim final model/effort until composed SDK options are supplied', () => {
    const got = resolve(config);

    assert.equal(got.modelFamily, 'claude');
    assert.equal(got.model, null);
    assert.equal(got.effort, null);
    assert.equal(got.modelField, 'model');
    assert.equal(got.effortField, 'effort');

    const composed = resolve(config, {
      composedClaudeOptions: {
        model: 'agent-or-topic-final-model',
        effort: 'max',
      },
    });
    assert.equal(composed.model, 'agent-or-topic-final-model');
    assert.equal(composed.effort, 'max');
    assert.equal(composed.sources.model, 'composed-options');
    assert.equal(composed.sources.effort, 'composed-options');
  });

  test('Codex reads only codexModel/codexEffort fields', () => {
    const got = resolve(
      {
        ...config,
        defaults: { cwd: '/work' },
        chats: {
          '100': {
            ...config.chats['100'],
            pm: 'codex',
            codexEnabled: true,
          },
        },
      },
      {
        codexAvailability: codexAvailability({
          model: 'gpt-5-codex',
          effort: 'xhigh',
          cwd: '/work',
        }),
      },
    );

    assert.equal(got.modelFamily, 'codex');
    assert.equal(got.model, 'gpt-5-codex');
    assert.equal(got.effort, 'xhigh');
    assert.equal(got.modelField, 'codexModel');
    assert.equal(got.effortField, 'codexEffort');
  });

  test('missing Codex selection fails closed rather than using Claude fields', () => {
    assert.throws(
      () => resolve(
        {
          defaults: { cwd: '/work' },
          chats: {
            '100': {
              pm: 'codex',
              codexEnabled: true,
              model: 'claude-opus',
              effort: 'high',
            },
          },
        },
        {
          codexAvailability: codexAvailability({
            model: 'gpt-5-codex',
            effort: 'xhigh',
            cwd: '/work',
          }),
        },
      ),
      (error) => error.code === 'CODEX_RUNTIME_SELECTION_INCOMPLETE',
    );
  });
});

describe('resolveRuntimeConfig — fail-closed explicit Codex selection', () => {
  test('unknown pm values preserve Orchestra warning and SDK fallback semantics', () => {
    for (const value of ['codeex', 'constructor', 42]) {
      const warnings = [];
      const got = resolve(
        { chats: { '100': { pm: value } } },
        { logger: { warn: (message) => warnings.push(message) } },
      );
      assert.equal(got.runtime, 'claude');
      assert.equal(got.backend, 'sdk');
      assert.equal(got.configuredPm, value);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /unknown pm value/);
    }
  });

  for (const [state, code] of [
    ['loading', 'CODEX_PREFLIGHT_LOADING'],
    ['unavailable', 'CODEX_RUNTIME_UNAVAILABLE'],
    ['ineligible', 'CODEX_RUNTIME_INELIGIBLE'],
  ]) {
    test(`${state} Codex preflight rejects with an actionable typed error`, () => {
      assert.throws(
        () => resolve(
          { chats: { '100': { pm: 'codex', codexEnabled: true } } },
          {
            codexAvailability: {
              state,
              reason: `${state} reason`,
            },
          },
        ),
        (err) => {
          assert.ok(err instanceof RuntimeConfigError);
          assert.equal(err.code, code);
          assert.equal(err.runtime, 'codex');
          assert.equal(err.availabilityState, state);
          assert.equal(err.reason, `${state} reason`);
          assert.equal(typeof err.action, 'string');
          assert.ok(err.action.length > 0);
          assert.match(err.message, new RegExp(state, 'i'));
          return true;
        },
      );
    });
  }

  test('missing availability is unavailable, so unwired callers cannot enable Codex', () => {
    assert.throws(
      () => resolve({
        chats: { '100': { pm: 'codex', codexEnabled: true } },
      }),
      (err) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.equal(err.code, 'CODEX_RUNTIME_UNAVAILABLE');
        assert.equal(err.availabilityState, 'unavailable');
        assert.match(err.message, /not wired/i);
        return true;
      },
    );
  });

  test('fabricated or copied available objects cannot enable Codex', () => {
    const trusted = codexAvailability({
      model: 'gpt-test',
      effort: 'high',
      cwd: '/work',
    });
    for (const candidate of [
      { state: 'available', spawnProfileId: 'made-up' },
      { ...trusted },
    ]) {
      assert.throws(
        () => resolve(
          {
            defaults: {
              codexModel: 'gpt-test',
              codexEffort: 'high',
              cwd: '/work',
            },
            chats: { '100': { pm: 'codex', codexEnabled: true } },
          },
          { codexAvailability: candidate },
        ),
        (err) => {
          assert.ok(err instanceof RuntimeConfigError);
          assert.equal(err.code, 'CODEX_PREFLIGHT_INVALID');
          assert.equal(err.runtime, 'codex');
          assert.equal(err.availabilityState, 'available');
          return true;
        },
      );
    }
  });

  test('trusted receipt binds cwd while its authenticated catalog admits dynamic settings', () => {
    const trusted = codexAvailability({
      model: 'gpt-test',
      effort: 'high',
      cwd: '/work',
      modelCatalog: [
        {
          model: 'gpt-test',
          supportedReasoningEfforts: ['high'],
        },
        {
          model: 'other',
          supportedReasoningEfforts: ['low'],
        },
      ],
    });
    const changed = resolve(
      {
        defaults: {
          codexModel: 'other',
          codexEffort: 'low',
          cwd: '/work',
        },
        chats: { '100': { pm: 'codex', codexEnabled: true } },
      },
      { codexAvailability: trusted },
    );
    assert.equal(changed.model, 'other');
    assert.equal(changed.effort, 'low');

    for (const defaults of [
      { codexModel: 'other', codexEffort: 'high', cwd: '/work' },
      { codexModel: 'missing', codexEffort: 'low', cwd: '/work' },
      { codexModel: 'gpt-test', codexEffort: 'high', cwd: '/other' },
    ]) {
      assert.throws(
        () => resolve(
          {
            defaults,
            chats: { '100': { pm: 'codex', codexEnabled: true } },
          },
          { codexAvailability: trusted },
        ),
        (error) => error.code === 'CODEX_PREFLIGHT_PROFILE_MISMATCH',
      );
    }
  });

  test('availability construction is impossible until Orchestra exports its receipt assertion', () => {
    const previous = orchestra.assertCodexSpawnProfile;
    delete orchestra.assertCodexSpawnProfile;
    try {
      assert.throws(
        () => createCodexRuntimeAvailability(deepFreeze({
          runtime: 'codex',
          spawnProfileId: 'unasserted',
          expectedStaticProfile: {
            model: 'gpt-test',
            effort: 'high',
            cwd: '/work',
          },
        })),
        (error) => error.code === 'CODEX_PREFLIGHT_UNWIRED',
      );
    } finally {
      if (previous !== undefined) {
        orchestra.assertCodexSpawnProfile = previous;
      }
    }
  });

  test('unknown availability state is invalid config, never treated as available', () => {
    assert.throws(
      () => resolve(
        { chats: { '100': { pm: 'codex', codexEnabled: true } } },
        { codexAvailability: { state: 'maybe' } },
      ),
      (err) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.equal(err.code, 'RUNTIME_CONFIG_INVALID');
        assert.equal(err.value, 'maybe');
        return true;
      },
    );
  });

  test('malformed and cyclic selected values fail with a typed error', () => {
    const cyclic = {};
    cyclic.self = cyclic;

    assert.throws(
      () => resolve(
        { chats: { '100': { pm: 'sdk' } } },
        { composedClaudeOptions: { model: cyclic, effort: 'high' } },
      ),
      (error) => error.code === 'RUNTIME_CONFIG_VALUE_INVALID',
    );
    assert.throws(
      () => resolve(
        {
          defaults: {
            codexModel: cyclic,
            codexEffort: 'high',
            cwd: '/work',
          },
          chats: { '100': { pm: 'codex', codexEnabled: true } },
        },
        {
          codexAvailability: codexAvailability({
            model: 'gpt-test',
            effort: 'high',
            cwd: '/work',
          }),
        },
      ),
      (error) => error.code === 'RUNTIME_CONFIG_VALUE_INVALID',
    );
  });
});

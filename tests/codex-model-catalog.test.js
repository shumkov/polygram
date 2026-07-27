'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CodexCatalogError,
  CodexModelCatalog,
} = require('../lib/codex/model-catalog');

const SPAWN_A = 'a'.repeat(64);
const SPAWN_B = 'b'.repeat(64);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function model(overrides = {}) {
  return {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
    isDefault: true,
    ...overrides,
  };
}

function result(overrides = {}) {
  const models = overrides.models ?? [model()];
  const selected = overrides.selected ?? {
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  };
  return deepFreeze({
    runtime: 'codex',
    runtimeVersion: 'codex-cli 0.145.0',
    schemaVersion: 'schema-a',
    spawnProfileId: SPAWN_A,
    auth: {
      authenticated: true,
      accountType: 'chatgpt',
      requiresOpenaiAuth: true,
    },
    attestation: { configSha256: 'config-a' },
    models,
    efforts: ['medium', 'high', 'xhigh'],
    selected,
    ...overrides,
  });
}

function expectedProfile(overrides = {}) {
  return deepFreeze({
    runtime: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    cwd: '/workspace',
    ...overrides,
  });
}

function fakeOrchestra(results) {
  const successfulResults = new WeakSet();
  const receipts = new WeakSet();
  const queue = [...results];
  return {
    async preflightCodexRuntime() {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      successfulResults.add(next);
      return next;
    },
    createCodexSpawnProfile(profile, preflightResult) {
      assert.equal(successfulResults.has(preflightResult), true);
      const receipt = deepFreeze({
        runtime: 'codex',
        spawnProfileId: preflightResult.spawnProfileId,
        expectedStaticProfile: { ...profile },
      });
      receipts.add(receipt);
      return receipt;
    },
    assertCodexSpawnProfile(receipt) {
      if (!receipts.has(receipt)) {
        const error = new Error('invalid receipt');
        error.code = 'CODEX_PREFLIGHT_RECEIPT_INVALID';
        throw error;
      }
      return receipt;
    },
  };
}

describe('Codex authenticated model catalog', () => {
  test('exposes only models and efforts returned by branded successful preflight', async () => {
    const orchestra = fakeOrchestra([result({
      models: [
        model({ id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5' }),
        model(),
      ],
    })]);
    const catalog = new CodexModelCatalog({ orchestra });

    const available = await catalog.preflight(expectedProfile(), {
      deploymentIdentity: 'local-chatgpt-auth-v1',
    });

    assert.deepEqual(
      available.models.map(({ model: name }) => name),
      ['gpt-5.5', 'gpt-5.6-sol'],
    );
    assert.deepEqual(available.efforts, ['medium', 'high', 'xhigh']);
    assert.deepEqual(available.selected, {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    assert.equal(
      orchestra.assertCodexSpawnProfile(available.spawnProfile),
      available.spawnProfile,
    );
    assert.equal(Object.isFrozen(available), true);
    assert.equal(Object.isFrozen(available.models), true);
  });

  test('never invents gpt-5.6-sol when authenticated model/list omits it', async () => {
    const error = new Error('Requested Codex model is unavailable');
    error.code = 'CODEX_MODEL_UNAVAILABLE';
    const catalog = new CodexModelCatalog({
      orchestra: fakeOrchestra([error]),
    });

    await assert.rejects(
      catalog.preflight(expectedProfile(), {
        deploymentIdentity: 'auth-a',
      }),
      (catalogError) => (
        catalogError instanceof CodexCatalogError
        && catalogError.code === 'CODEX_MODEL_UNAVAILABLE'
        && /Choose a model/.test(catalogError.action)
        && catalogError.cause === error
      ),
    );
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_A,
    }), null);
  });

  test('caches only by exact branded spawn profile and authenticated deployment', async () => {
    const catalog = new CodexModelCatalog({
      orchestra: fakeOrchestra([result()]),
    });
    const available = await catalog.preflight(expectedProfile(), {
      deploymentIdentity: 'auth-a',
    });

    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_A,
    }), available);
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-b',
      spawnProfileId: SPAWN_A,
    }), null);
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_B,
    }), null);
    assert.doesNotMatch(
      available.cacheIdentity,
      /auth-a|a{64}/,
    );
  });

  test('catalog drift replaces the prior cache identity instead of merging names', async () => {
    const catalog = new CodexModelCatalog({
      orchestra: fakeOrchestra([
        result(),
        result({
          models: [model({
            supportedReasoningEfforts: ['high', 'xhigh'],
          })],
          efforts: ['high', 'xhigh'],
        }),
      ]),
    });
    const first = await catalog.preflight(expectedProfile(), {
      deploymentIdentity: 'auth-a',
    });
    const second = await catalog.preflight(expectedProfile(), {
      deploymentIdentity: 'auth-a',
    });

    assert.notEqual(second.cacheIdentity, first.cacheIdentity);
    assert.deepEqual(second.efforts, ['high', 'xhigh']);
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_A,
    }), second);
  });

  test('profile, schema, or authentication failure invalidates the deployment cache', async () => {
    const authError = new Error('Codex ChatGPT authentication is unavailable');
    authError.code = 'CODEX_AUTH_UNAVAILABLE';
    const catalog = new CodexModelCatalog({
      orchestra: fakeOrchestra([
        result(),
        result({
          schemaVersion: 'schema-b',
          spawnProfileId: SPAWN_B,
        }),
        authError,
      ]),
    });

    await catalog.preflight(expectedProfile(), {
      deploymentIdentity: 'auth-a',
    });
    const changed = await catalog.preflight(expectedProfile(), {
      deploymentIdentity: 'auth-a',
    });
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_A,
    }), null);
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_B,
    }), changed);

    await assert.rejects(
      catalog.preflight(expectedProfile(), {
        deploymentIdentity: 'auth-a',
      }),
      { code: 'CODEX_AUTH_UNAVAILABLE' },
    );
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_B,
    }), null);
  });

  test('a slower stale preflight cannot overwrite a newer result', async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const firstResult = result();
    const secondResult = result({
      schemaVersion: 'schema-b',
      spawnProfileId: SPAWN_B,
    });
    const branded = fakeOrchestra([firstResult, secondResult]);
    let call = 0;
    const original = branded.preflightCodexRuntime;
    branded.preflightCodexRuntime = async (...args) => {
      call += 1;
      const next = original(...args);
      if (call === 1) {
        await firstGate;
      }
      return next;
    };
    const catalog = new CodexModelCatalog({ orchestra: branded });

    const stale = catalog.preflight(expectedProfile(), {
      deploymentIdentity: 'auth-a',
    });
    const current = await catalog.preflight(expectedProfile(), {
      deploymentIdentity: 'auth-a',
    });
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_A,
    }), null);
    releaseFirst();

    await assert.rejects(stale, {
      code: 'CODEX_PREFLIGHT_SUPERSEDED',
    });
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_B,
    }), current);
    assert.equal(catalog.getCached({
      deploymentIdentity: 'auth-a',
      spawnProfileId: SPAWN_A,
    }), null);
  });

  test('missing or forged Orchestra receipt support fails closed', async () => {
    const catalog = new CodexModelCatalog({
      orchestra: {
        preflightCodexRuntime: async () => result(),
        createCodexSpawnProfile: () => Object.freeze({
          runtime: 'codex',
          spawnProfileId: 'forged',
          expectedStaticProfile: expectedProfile(),
        }),
      },
    });
    await assert.rejects(
      catalog.preflight(expectedProfile(), {
        deploymentIdentity: 'auth-a',
      }),
      (error) => (
        error instanceof CodexCatalogError
        && error.code === 'CODEX_PREFLIGHT_UNWIRED'
      ),
    );
  });

  test('deployment identity is bounded opaque data, not optional ambient state', async () => {
    const catalog = new CodexModelCatalog({
      orchestra: fakeOrchestra([result()]),
    });
    await assert.rejects(
      catalog.preflight(expectedProfile(), { deploymentIdentity: '' }),
      { code: 'CODEX_DEPLOYMENT_IDENTITY_INVALID' },
    );
    await assert.rejects(
      catalog.preflight(expectedProfile(), {
        deploymentIdentity: 'x'.repeat(513),
      }),
      { code: 'CODEX_DEPLOYMENT_IDENTITY_INVALID' },
    );
  });
});

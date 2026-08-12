'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  configuredScopeSha256,
  createForegroundCanaryAuthorizer,
  normalizeDeployForegroundExpectation,
} = require('../lib/ops/foreground-canary-target');
const { getSessionKey } = require('../lib/session-key');
const {
  freshDb,
  cleanupDb,
  insertInbound,
} = require('./helpers/db-fixture');

const REQUEST_ID = '8cd27e49-9a9f-462a-9b3b-0a03a31c0e90';
const INSTANCE_ID = 'cfcf6fb2-2640-4f91-819e-2975a2c38936';
const NOW = 1_786_000_000_000;

function fixture(overrides = {}) {
  const config = {
    chats: {
      '100': {
        name: 'Ivan DM',
        isolateTopics: false,
      },
      '-200': {
        name: 'Canaries',
        isolateTopics: true,
        topics: {
          5: { name: 'Codex canary' },
        },
      },
    },
  };
  const scope = {
    botName: 'shumorobot',
    chatId: '100',
    threadId: null,
    chatName: 'Ivan DM',
    topicName: null,
    isolateTopics: false,
  };
  const scopeDigest = configuredScopeSha256(scope);
  let activeHandlers = [{
    sessionKey: '100',
    chatId: '100',
    threadId: null,
    telegramMessageId: '77',
  }];
  let selected = {
    messageId: 19,
    chatId: '100',
    threadId: null,
    telegramMessageId: '77',
    sessionKey: '100',
    provider: 'claude',
    handlerStatus: 'processing',
  };
  let now = NOW;
  const authorizer = createForegroundCanaryAuthorizer({
    botName: 'shumorobot',
    daemonIdentity: {
      daemon_instance_id: INSTANCE_ID,
      pid: 4242,
      package_version: '0.38.2',
    },
    config,
    getSessionKey,
    tokenSecret: 'foreground-canary-test-secret',
    getActiveHandlerTargets: () => activeHandlers,
    getForegroundCanaryTarget: () => selected,
    now: () => now,
    tokenTtlMs: 300_000,
    ...overrides,
  });
  return {
    authorizer,
    scopeDigest,
    setActiveHandlers(value) { activeHandlers = value; },
    setSelected(value) { selected = value; },
    advance(ms) { now += ms; },
  };
}

function probeRequest(scopeDigest, overrides = {}) {
  return {
    op: 'foreground_canary_target',
    id: REQUEST_ID,
    secret: 'authenticated-by-ipc-server',
    provider: 'claude',
    configured_scope_sha256: scopeDigest,
    ...overrides,
  };
}

function foregroundExpectation(probe, overrides = {}) {
  return {
    schema_version: 1,
    daemon_instance_id: INSTANCE_ID,
    pid: 4242,
    provider: 'claude',
    configured_scope_sha256: probe.configured_scope_sha256,
    target_token: probe.target_token,
    ...overrides,
  };
}

function normalizedForegroundExpectation(probe, overrides = {}) {
  return normalizeDeployForegroundExpectation({
    op: 'deploy_restart',
    id: REQUEST_ID,
    secret: 'secret',
    foreground_expectation: foregroundExpectation(probe, overrides),
  });
}

describe('foreground canary target authorization', () => {
  test('binds one exact live dispatcher-owned source without exposing its IDs', () => {
    const fx = fixture();
    const response = fx.authorizer.probe(probeRequest(fx.scopeDigest));

    assert.deepEqual(Object.keys(response), [
      'outcome',
      'bot',
      'daemon_instance_id',
      'pid',
      'package_version',
      'provider',
      'configured_scope_sha256',
      'target_token',
    ]);
    assert.deepEqual(response, {
      outcome: 'live',
      bot: 'shumorobot',
      daemon_instance_id: INSTANCE_ID,
      pid: 4242,
      package_version: '0.38.2',
      provider: 'claude',
      configured_scope_sha256: fx.scopeDigest,
      target_token: response.target_token,
    });
    assert.match(response.target_token, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(response), /"(?:chat|thread|session|message)_?id"/i);
  });

  test('rechecks the token-bound source and produces one content-free authorization tuple', () => {
    const fx = fixture();
    const probe = fx.authorizer.probe(probeRequest(fx.scopeDigest));
    const result = fx.authorizer.authorizeRestart({
      requestId: REQUEST_ID,
      expectation: normalizedForegroundExpectation(probe),
    });

    assert.equal(result.accepted, true);
    assert.deepEqual(result.authorizationEvent, {
      bot: 'shumorobot',
      daemon_instance_id: INSTANCE_ID,
      pid: 4242,
      package_version: '0.38.2',
      provider: 'claude',
      configured_scope_sha256: fx.scopeDigest,
      session_key: '100',
      source_message_id: 19,
      restart_request_sha256: crypto
        .createHash('sha256')
        .update(REQUEST_ID)
        .digest('hex'),
    });
    assert.equal(JSON.stringify(result.authorizationEvent).includes(REQUEST_ID), false);

    const replay = fx.authorizer.authorizeRestart({
      requestId: REQUEST_ID,
      expectation: normalizedForegroundExpectation(probe),
    });
    assert.deepEqual(replay, {
      accepted: false,
      rejectionCode: 'target-token-invalid',
    });
  });

  test('rejects a wrong turn, provider, scope, busy count, terminal row, or expired token', () => {
    const cases = [
      {
        mutate(fx) {
          fx.setActiveHandlers([
            { sessionKey: '100', chatId: '100', threadId: null, telegramMessageId: '77' },
            { sessionKey: '-200:5', chatId: '-200', threadId: '5', telegramMessageId: '88' },
          ]);
        },
        code: 'daemon-busy',
      },
      {
        mutate(fx) {
          fx.setSelected({
            messageId: 19, chatId: '100', threadId: null,
            telegramMessageId: '77', sessionKey: '100', provider: 'codex',
            handlerStatus: 'processing',
          });
        },
        code: 'provider-mismatch',
      },
      {
        mutate(fx) {
          fx.setSelected({
            messageId: 19, chatId: '100', threadId: null,
            telegramMessageId: '77', sessionKey: '100', provider: 'claude',
            handlerStatus: 'replied',
          });
        },
        code: 'target-not-live',
      },
      {
        mutate(fx) {
          fx.setActiveHandlers([
            { sessionKey: '100', chatId: '100', threadId: null, telegramMessageId: '78' },
          ]);
        },
        code: 'source-mismatch',
      },
    ];

    for (const { mutate, code } of cases) {
      const fx = fixture();
      mutate(fx);
      assert.deepEqual(fx.authorizer.probe(probeRequest(fx.scopeDigest)), {
        outcome: 'rejected',
        rejection_code: code,
      });
    }

    const wrongScope = fixture();
    assert.deepEqual(wrongScope.authorizer.probe(probeRequest('f'.repeat(64))), {
      outcome: 'rejected',
      rejection_code: 'configured-scope-mismatch',
    });

    const drift = fixture();
    const probe = drift.authorizer.probe(probeRequest(drift.scopeDigest));
    drift.setActiveHandlers([
      { sessionKey: '100', chatId: '100', threadId: null, telegramMessageId: '78' },
    ]);
    assert.deepEqual(drift.authorizer.authorizeRestart({
      requestId: REQUEST_ID,
      expectation: normalizedForegroundExpectation(probe),
    }), {
      accepted: false,
      rejectionCode: 'source-mismatch',
    });

    const expired = fixture();
    const expiringProbe = expired.authorizer.probe(probeRequest(expired.scopeDigest));
    expired.advance(300_001);
    assert.deepEqual(expired.authorizer.authorizeRestart({
      requestId: REQUEST_ID,
      expectation: normalizedForegroundExpectation(expiringProbe),
    }), {
      accepted: false,
      rejectionCode: 'target-token-expired',
    });
  });

  test('uses closed request and expectation schemas while allowing aged-warm qualification', () => {
    const fx = fixture();
    assert.deepEqual(fx.authorizer.probe({
      ...probeRequest(fx.scopeDigest),
      chat_id: '100',
    }), {
      outcome: 'rejected',
      rejection_code: 'invalid-request',
    });
    assert.deepEqual(fx.authorizer.probe(probeRequest(fx.scopeDigest, {
      id: 'not-a-restart-uuid',
    })), {
      outcome: 'rejected',
      rejection_code: 'invalid-request',
    });

    const probe = fx.authorizer.probe(probeRequest(fx.scopeDigest));
    const expected = {
      daemonInstanceId: INSTANCE_ID,
      pid: 4242,
      provider: 'claude',
      configuredScopeSha256: fx.scopeDigest,
      targetToken: probe.target_token,
    };
    assert.deepEqual(normalizeDeployForegroundExpectation({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
      foreground_expectation: foregroundExpectation(probe),
      qualification_expectation: {
        generation_digest: 'a'.repeat(64),
        activity_epoch: 7,
      },
    }), expected);
    assert.equal(normalizeDeployForegroundExpectation({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
    }), undefined);
    assert.equal(normalizeDeployForegroundExpectation({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
      foreground_expectation: {
        ...foregroundExpectation(probe),
        session_key: 'must-not-select',
      },
    }), null);
    assert.equal(normalizeDeployForegroundExpectation({
      op: 'deploy_restart',
      id: 'not-a-restart-uuid',
      secret: 'secret',
      foreground_expectation: foregroundExpectation(probe),
    }), null);
  });

  test('bounds abandoned target tokens and admits a new probe after expiry', () => {
    const fx = fixture({ tokenTtlMs: 10, tokenLimit: 1 });
    assert.equal(fx.authorizer.probe(probeRequest(fx.scopeDigest)).outcome, 'live');
    assert.deepEqual(fx.authorizer.probe(probeRequest(fx.scopeDigest, {
      id: '5b92e0aa-c3b8-4f3f-8fd8-74fae3fbd013',
    })), {
      outcome: 'rejected',
      rejection_code: 'target-unavailable',
    });

    fx.advance(11);
    assert.equal(fx.authorizer.probe(probeRequest(fx.scopeDigest, {
      id: 'd4bb72bb-7388-4346-9eb5-b8a552c7bb15',
    })).outcome, 'live');
  });
});

describe('configured scope digest', () => {
  test('binds the bot, numeric scope, configured names, and isolation mode', () => {
    const shape = {
      botName: 'shumorobot',
      chatId: '-200',
      threadId: '5',
      chatName: 'Canaries',
      topicName: 'Codex canary',
      isolateTopics: true,
    };
    assert.equal(
      configuredScopeSha256(shape),
      crypto.createHash('sha256').update(JSON.stringify([
        'shumorobot', '-200', '5', 'Canaries', 'Codex canary', true,
      ])).digest('hex'),
    );
  });
});

describe('foreground target database projection', () => {
  let db;
  let dbPath;

  beforeEach(() => { ({ db, dbPath } = freshDb('foreground-target')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('joins one live inbound to its immutable runtime selection without projecting body text', () => {
    const messageId = insertInbound(db, {
      chat_id: '100',
      msg_id: 77,
      bot_name: 'shumorobot',
      text: 'must never be projected',
      handler_status: 'processing',
    });
    db.recordInboundRuntimeSelection({
      session_key: '100',
      bot_name: 'shumorobot',
      telegram_chat_id: '100',
      telegram_message_id: '77',
      provider: 'claude',
      ts: NOW,
    });

    assert.deepEqual(db.getForegroundCanaryTarget({
      botName: 'shumorobot',
      chatId: '100',
      telegramMessageId: '77',
    }), {
      messageId,
      chatId: '100',
      threadId: null,
      telegramMessageId: '77',
      sessionKey: '100',
      provider: 'claude',
      handlerStatus: 'processing',
    });
    assert.equal(db.getForegroundCanaryTarget({
      botName: 'shumorobot',
      chatId: '100',
      telegramMessageId: '77 OR 1=1',
    }), null);
  });
});

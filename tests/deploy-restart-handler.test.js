'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createDeployRestartHandler,
} = require('../lib/ops/deploy-restart-handler');

const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function foregroundExpectation() {
  return {
    schema_version: 1,
    daemon_instance_id: INSTANCE_ID,
    pid: 4242,
    provider: 'claude',
    configured_scope_sha256: 'a'.repeat(64),
    target_token: 'b'.repeat(64),
  };
}

function fixture(overrides = {}) {
  const sequence = [];
  const shutdownCalls = [];
  const handler = createDeployRestartHandler({
    getIsShuttingDown: () => false,
    getPid: () => 4242,
    foregroundCanaryAuthorizer: {
      authorizeRestart(input) {
        sequence.push('authorize');
        return {
          accepted: true,
          authorizationEvent: {
            bot: 'shumorobot',
            restart_request_sha256: 'c'.repeat(64),
          },
        };
      },
    },
    logEvent(kind, detail) {
      sequence.push(`event:${kind}`);
      assert.deepEqual(detail, {
        bot: 'shumorobot',
        restart_request_sha256: 'c'.repeat(64),
      });
    },
    shutdown(input) {
      sequence.push('shutdown');
      shutdownCalls.push(input);
      return Promise.resolve();
    },
    logger: { error() {} },
    ...overrides,
  });
  return { handler, sequence, shutdownCalls };
}

describe('deploy restart request handler', () => {
  test('rechecks and logs an exact foreground target before synchronously entering shutdown', () => {
    const fx = fixture();
    const response = fx.handler({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
      foreground_expectation: foregroundExpectation(),
    });

    assert.deepEqual(fx.sequence, [
      'authorize',
      'event:foreground-canary-target-authorized',
      'shutdown',
    ]);
    assert.deepEqual(fx.shutdownCalls, [{
      continuationAuthorized: true,
      trigger: 'deploy-ipc',
      restartRequestId: REQUEST_ID,
      qualificationExpectation: undefined,
    }]);
    assert.deepEqual(response, {
      accepted: true,
      old_pid: 4242,
      restart_request_id: REQUEST_ID,
    });
  });

  test('allows foreground and aged-warm expectations in the same one-shot request', () => {
    const fx = fixture();
    const response = fx.handler({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
      foreground_expectation: foregroundExpectation(),
      qualification_expectation: {
        generation_digest: 'd'.repeat(64),
        activity_epoch: 9,
      },
    });

    assert.equal(response.accepted, true);
    assert.deepEqual(fx.shutdownCalls[0].qualificationExpectation, {
      expectedGenerationDigest: 'd'.repeat(64),
      expectedActivityEpoch: 9,
    });
  });

  test('returns one authenticated bounded rejection without shutdown on drift', () => {
    const fx = fixture({
      foregroundCanaryAuthorizer: {
        authorizeRestart() {
          return { accepted: false, rejectionCode: 'source-mismatch' };
        },
      },
    });
    assert.deepEqual(fx.handler({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
      foreground_expectation: foregroundExpectation(),
    }), {
      accepted: false,
      old_pid: 4242,
      restart_request_id: REQUEST_ID,
      rejection_code: 'source-mismatch',
    });
    assert.deepEqual(fx.shutdownCalls, []);
  });

  test('rejects malformed/unknown wire fields and an in-progress shutdown without side effects', () => {
    const malformed = fixture();
    assert.deepEqual(malformed.handler({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
      foreground_expectation: foregroundExpectation(),
      session_key: 'must-not-select',
    }), {
      accepted: false,
      old_pid: 4242,
      restart_request_id: REQUEST_ID,
      rejection_code: 'invalid-request',
    });
    assert.deepEqual(malformed.sequence, []);

    const shuttingDown = fixture({ getIsShuttingDown: () => true });
    assert.deepEqual(shuttingDown.handler({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
    }), {
      accepted: false,
      old_pid: 4242,
      restart_request_id: REQUEST_ID,
      rejection_code: 'shutdown-in-progress',
    });
    assert.deepEqual(shuttingDown.sequence, []);
  });

  test('preserves ordinary daemon-owned deploy restart behavior', () => {
    const fx = fixture();
    const response = fx.handler({
      op: 'deploy_restart',
      id: 'routine-release-request',
      secret: 'secret',
    });
    assert.deepEqual(fx.sequence, ['shutdown']);
    assert.equal(response.accepted, true);
    assert.equal(response.restart_request_id, 'routine-release-request');
  });
});

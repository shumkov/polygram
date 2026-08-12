'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  normalizeDeployQualificationExpectation,
  projectQualificationResponse,
  buildQualificationEvent,
} = require('../lib/ops/clean-restart-qualification');

const DIGEST = 'a'.repeat(64);
const REQUEST_ID = 'deploy-qualification-42';

function eligibleObservation(overrides = {}) {
  return {
    outcome: 'qualified',
    reason: 'eligible',
    generationDigest: DIGEST,
    activityEpoch: 7,
    processState: 'Idle',
    activeTurnCount: 0,
    pendingDeliveryCount: 0,
    backgroundOwnerCount: 0,
    backgroundTerminalCount: 0,
    backgroundTerminalRegistryComplete: true,
    observedAtMs: 1_786_000_000_000,
    ...overrides,
  };
}

describe('deploy qualification expectation', () => {
  test('normal deploys remain unqualified while one exact closed expectation maps to Orchestra', () => {
    assert.equal(normalizeDeployQualificationExpectation({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
    }), undefined);

    assert.deepEqual(normalizeDeployQualificationExpectation({
      op: 'deploy_restart',
      id: REQUEST_ID,
      secret: 'secret',
      qualification_expectation: {
        generation_digest: DIGEST,
        activity_epoch: 7,
      },
      foreground_expectation: {
        schema_version: 1,
        daemon_instance_id: 'instance-42',
        pid: 4242,
        provider: 'claude',
        configured_scope_sha256: 'b'.repeat(64),
        target_token: 'c'.repeat(64),
      },
    }), {
      expectedGenerationDigest: DIGEST,
      expectedActivityEpoch: 7,
    });
  });

  test('malformed and unknown fields become a non-authorizing sentinel without throwing', () => {
    for (const request of [
      { op: 'deploy_restart', id: REQUEST_ID, qualification_expectation: null },
      { op: 'deploy_restart', id: REQUEST_ID, qualification_expectation: {} },
      {
        op: 'deploy_restart',
        id: REQUEST_ID,
        qualification_expectation: { generation_digest: DIGEST, activity_epoch: -1 },
      },
      {
        op: 'deploy_restart',
        id: REQUEST_ID,
        qualification_expectation: {
          generation_digest: DIGEST,
          activity_epoch: 7,
          session_key: 'must-not-select',
        },
      },
      {
        op: 'deploy_restart',
        id: REQUEST_ID,
        qualification_expectation: { generation_digest: DIGEST, activity_epoch: 7 },
        session_key: 'must-not-select',
      },
      { op: 'deploy_restart', id: REQUEST_ID, selector: {} },
    ]) {
      assert.equal(normalizeDeployQualificationExpectation(request), null);
    }
  });
});

describe('content-free qualification projections', () => {
  test('standalone response has one exact snake_case schema', () => {
    const response = projectQualificationResponse({
      botName: 'shumorobot',
      daemonIdentity: {
        daemon_instance_id: 'instance-42',
        package_version: '0.38.1',
      },
      observation: eligibleObservation(),
    });

    assert.deepEqual(response, {
      bot: 'shumorobot',
      daemon_instance_id: 'instance-42',
      package_version: '0.38.1',
      observed_at_ms: 1_786_000_000_000,
      generation_digest: DIGEST,
      activity_epoch: 7,
      process_state: 'Idle',
      active_turn_count: 0,
      pending_delivery_count: 0,
      background_owner_count: 0,
      background_terminal_count: 0,
      background_terminal_registry_complete: true,
      outcome_code: 'eligible',
    });
    assert.deepEqual(Object.keys(response), [
      'bot',
      'daemon_instance_id',
      'package_version',
      'observed_at_ms',
      'generation_digest',
      'activity_epoch',
      'process_state',
      'active_turn_count',
      'pending_delivery_count',
      'background_owner_count',
      'background_terminal_count',
      'background_terminal_registry_complete',
      'outcome_code',
    ]);
    assert.doesNotMatch(JSON.stringify(response), /session|thread|provider|error|body|message/i);
  });

  test('malformed or incoherent provider results fail closed to bounded telemetry', () => {
    const cases = [
      { ...eligibleObservation(), prompt: 'secret body' },
      eligibleObservation({ outcome: 'qualified', activeTurnCount: 1 }),
      eligibleObservation({
        outcome: 'mismatch',
        activeTurnCount: 1,
      }),
      eligibleObservation({ backgroundTerminalCount: 1_601 }),
      eligibleObservation({ observedAtMs: -1 }),
      null,
    ];
    for (const observation of cases) {
      const response = projectQualificationResponse({
        botName: 'shumorobot',
        daemonIdentity: {
          daemon_instance_id: 'instance-42',
          package_version: '0.38.1',
        },
        observation,
        now: () => 1_786_000_000_123,
      });
      assert.equal(response.outcome_code, 'inspection-failed');
      assert.equal(response.process_state, 'unknown');
      assert.equal(response.active_turn_count, 0);
      assert.equal(response.pending_delivery_count, 0);
      assert.equal(response.background_owner_count, 0);
      assert.equal(response.background_terminal_count, 0);
      assert.equal(response.background_terminal_registry_complete, false);
      assert.doesNotMatch(JSON.stringify(response), /secret body/);
    }
  });

  test('no-generation mismatch retains explicit nullable fence fields', () => {
    const response = projectQualificationResponse({
      botName: 'shumorobot',
      daemonIdentity: {
        daemon_instance_id: 'instance-42',
        package_version: '0.38.1',
      },
      observation: eligibleObservation({
        outcome: 'mismatch',
        reason: 'no-codex-generation',
        generationDigest: null,
        activityEpoch: null,
        processState: 'unknown',
        backgroundTerminalRegistryComplete: false,
      }),
    });
    assert.equal(response.generation_digest, null);
    assert.equal(response.activity_epoch, null);
    assert.equal(response.outcome_code, 'no-codex-generation');
  });

  test('restart event hashes the request and marks only an exact eligible fence', () => {
    const event = buildQualificationEvent({
      botName: 'shumorobot',
      daemonIdentity: {
        daemon_instance_id: 'instance-42',
        package_version: '0.38.1',
      },
      restartRequestId: REQUEST_ID,
      expectation: {
        expectedGenerationDigest: DIGEST,
        expectedActivityEpoch: 7,
      },
      observation: eligibleObservation(),
    });

    assert.deepEqual(event, {
      bot: 'shumorobot',
      restart_request_sha256: crypto.createHash('sha256').update(REQUEST_ID).digest('hex'),
      daemon_instance_id: 'instance-42',
      package_version: '0.38.1',
      observed_at_ms: 1_786_000_000_000,
      generation_digest: DIGEST,
      expected_activity_epoch: 7,
      observed_activity_epoch: 7,
      process_state: 'Idle',
      active_turn_count: 0,
      pending_delivery_count: 0,
      background_owner_count: 0,
      background_terminal_count: 0,
      background_terminal_registry_complete: true,
      exact_match: true,
      outcome_code: 'eligible',
    });
    assert.equal(JSON.stringify(event).includes(REQUEST_ID), false);

    for (const mismatch of [
      { observation: eligibleObservation({ activityEpoch: 8 }) },
      { observation: eligibleObservation({ generationDigest: 'b'.repeat(64) }) },
      { observation: eligibleObservation({ processState: 'Active' }) },
      { observation: eligibleObservation({ backgroundOwnerCount: 1 }) },
      { expectation: null },
    ]) {
      assert.equal(buildQualificationEvent({
        botName: 'shumorobot',
        daemonIdentity: {
          daemon_instance_id: 'instance-42',
          package_version: '0.38.1',
        },
        restartRequestId: REQUEST_ID,
        expectation: {
          expectedGenerationDigest: DIGEST,
          expectedActivityEpoch: 7,
        },
        observation: eligibleObservation(),
        ...mismatch,
      }).exact_match, false);
    }
  });
});

'use strict';

const { createHash } = require('node:crypto');

const SHA256_RE = /^[a-f0-9]{64}$/;
const PROCESS_STATES = new Set([
  'Spawning', 'Initializing', 'AttachingThread', 'Idle', 'StartingTurn',
  'Active', 'BackgroundWorking', 'BackgroundSettling', 'Settling',
  'Quiescing', 'Stopped', 'Closing', 'Closed', 'FailedAmbiguous',
  'RecoveryConflict', 'DurabilityBlocked', 'ContainmentFailed', 'unknown',
]);
const OUTCOME_CODES = new Set([
  'eligible', 'active-turn', 'pending-delivery', 'background-owner',
  'background-terminals', 'pagination-incomplete', 'process-not-idle',
  'process-not-ready', 'no-codex-generation', 'unsupported', 'lease-drift',
  'generation-drift', 'activity-epoch-drift', 'fence-drift',
  'inspection-failed', 'invalid-expectation', 'incoherent',
]);
const OBSERVATION_KEYS = [
  'outcome',
  'reason',
  'generationDigest',
  'activityEpoch',
  'processState',
  'activeTurnCount',
  'pendingDeliveryCount',
  'backgroundOwnerCount',
  'backgroundTerminalCount',
  'backgroundTerminalRegistryComplete',
  'observedAtMs',
];

function isPlainObject(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function validOptionalFence(value, validator) {
  return value === null || validator(value);
}

function fallbackObservation(now = Date.now) {
  return Object.freeze({
    outcome: 'mismatch',
    reason: 'inspection-failed',
    generationDigest: null,
    activityEpoch: null,
    processState: 'unknown',
    activeTurnCount: 0,
    pendingDeliveryCount: 0,
    backgroundOwnerCount: 0,
    backgroundTerminalCount: 0,
    backgroundTerminalRegistryComplete: false,
    observedAtMs: now(),
  });
}

function normalizeQualificationObservation(observation, { now = Date.now } = {}) {
  if (
    !hasExactKeys(observation, OBSERVATION_KEYS)
    || !['qualified', 'mismatch'].includes(observation.outcome)
    || !OUTCOME_CODES.has(observation.reason)
    || !validOptionalFence(
      observation.generationDigest,
      (value) => SHA256_RE.test(value),
    )
    || !validOptionalFence(
      observation.activityEpoch,
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
    || !PROCESS_STATES.has(observation.processState)
    || ![0, 1].includes(observation.activeTurnCount)
    || ![0, 1].includes(observation.pendingDeliveryCount)
    || ![0, 1].includes(observation.backgroundOwnerCount)
    || !Number.isSafeInteger(observation.backgroundTerminalCount)
    || observation.backgroundTerminalCount < 0
    || observation.backgroundTerminalCount > 1_600
    || typeof observation.backgroundTerminalRegistryComplete !== 'boolean'
    || !Number.isSafeInteger(observation.observedAtMs)
    || observation.observedAtMs < 0
  ) {
    return fallbackObservation(now);
  }

  const qualified = observation.outcome === 'qualified';
  const eligibleShape = (
    observation.reason === 'eligible'
    && SHA256_RE.test(observation.generationDigest)
    && Number.isSafeInteger(observation.activityEpoch)
    && observation.processState === 'Idle'
    && observation.activeTurnCount === 0
    && observation.pendingDeliveryCount === 0
    && observation.backgroundOwnerCount === 0
    && observation.backgroundTerminalCount === 0
    && observation.backgroundTerminalRegistryComplete === true
  );
  if (
    (qualified && !eligibleShape)
    || (!qualified && observation.reason === 'eligible')
  ) {
    return fallbackObservation(now);
  }

  return Object.freeze({
    outcome: observation.outcome,
    reason: observation.reason,
    generationDigest: observation.generationDigest,
    activityEpoch: observation.activityEpoch,
    processState: observation.processState,
    activeTurnCount: observation.activeTurnCount,
    pendingDeliveryCount: observation.pendingDeliveryCount,
    backgroundOwnerCount: observation.backgroundOwnerCount,
    backgroundTerminalCount: observation.backgroundTerminalCount,
    backgroundTerminalRegistryComplete: observation.backgroundTerminalRegistryComplete,
    observedAtMs: observation.observedAtMs,
  });
}

function normalizeDeployQualificationExpectation(request) {
  if (!isPlainObject(request)) return null;
  const requestKeys = Object.keys(request);
  const allowedRequestKeys = new Set([
    'op', 'id', 'secret', 'qualification_expectation',
  ]);
  const hasUnknownRequestField = requestKeys.some(
    (key) => !allowedRequestKeys.has(key),
  );
  const hasExpectation = Object.hasOwn(request, 'qualification_expectation');
  if (!hasExpectation && !hasUnknownRequestField) return undefined;
  if (hasUnknownRequestField) return null;

  const expectation = request.qualification_expectation;
  if (!hasExactKeys(expectation, ['generation_digest', 'activity_epoch'])) {
    return null;
  }
  if (
    !SHA256_RE.test(expectation.generation_digest)
    || !Number.isSafeInteger(expectation.activity_epoch)
    || expectation.activity_epoch < 0
  ) {
    return null;
  }
  return Object.freeze({
    expectedGenerationDigest: expectation.generation_digest,
    expectedActivityEpoch: expectation.activity_epoch,
  });
}

function projectQualificationResponse({
  botName,
  daemonIdentity,
  observation,
  now = Date.now,
} = {}) {
  const normalized = normalizeQualificationObservation(observation, { now });
  return Object.freeze({
    bot: botName,
    daemon_instance_id: daemonIdentity?.daemon_instance_id ?? null,
    package_version: daemonIdentity?.package_version ?? null,
    observed_at_ms: normalized.observedAtMs,
    generation_digest: normalized.generationDigest,
    activity_epoch: normalized.activityEpoch,
    process_state: normalized.processState,
    active_turn_count: normalized.activeTurnCount,
    pending_delivery_count: normalized.pendingDeliveryCount,
    background_owner_count: normalized.backgroundOwnerCount,
    background_terminal_count: normalized.backgroundTerminalCount,
    background_terminal_registry_complete: normalized.backgroundTerminalRegistryComplete,
    outcome_code: normalized.reason,
  });
}

function buildQualificationEvent({
  botName,
  daemonIdentity,
  restartRequestId,
  expectation,
  observation,
  now = Date.now,
} = {}) {
  const normalized = normalizeQualificationObservation(observation, { now });
  const expectationValid = (
    isPlainObject(expectation)
    && hasExactKeys(expectation, [
      'expectedGenerationDigest',
      'expectedActivityEpoch',
    ])
    && SHA256_RE.test(expectation.expectedGenerationDigest)
    && Number.isSafeInteger(expectation.expectedActivityEpoch)
    && expectation.expectedActivityEpoch >= 0
  );
  const exactMatch = Boolean(
    expectationValid
    && normalized.outcome === 'qualified'
    && normalized.reason === 'eligible'
    && normalized.generationDigest === expectation.expectedGenerationDigest
    && normalized.activityEpoch === expectation.expectedActivityEpoch
    && normalized.processState === 'Idle'
    && normalized.activeTurnCount === 0
    && normalized.pendingDeliveryCount === 0
    && normalized.backgroundOwnerCount === 0
    && normalized.backgroundTerminalCount === 0
    && normalized.backgroundTerminalRegistryComplete === true
  );
  return Object.freeze({
    bot: botName,
    restart_request_sha256: createHash('sha256')
      .update(restartRequestId)
      .digest('hex'),
    daemon_instance_id: daemonIdentity?.daemon_instance_id ?? null,
    package_version: daemonIdentity?.package_version ?? null,
    observed_at_ms: normalized.observedAtMs,
    generation_digest: normalized.generationDigest,
    expected_activity_epoch: expectationValid
      ? expectation.expectedActivityEpoch
      : null,
    observed_activity_epoch: normalized.activityEpoch,
    process_state: normalized.processState,
    active_turn_count: normalized.activeTurnCount,
    pending_delivery_count: normalized.pendingDeliveryCount,
    background_owner_count: normalized.backgroundOwnerCount,
    background_terminal_count: normalized.backgroundTerminalCount,
    background_terminal_registry_complete: normalized.backgroundTerminalRegistryComplete,
    exact_match: exactMatch,
    outcome_code: normalized.reason,
  });
}

function assertClosedQualificationRequest(request) {
  if (!isPlainObject(request)) {
    throw new TypeError('clean restart qualification request is invalid');
  }
  const allowed = new Set(['op', 'id', 'secret']);
  if (
    request.op !== 'clean_restart_qualification'
    || Object.keys(request).some((key) => !allowed.has(key))
  ) {
    const error = new Error('clean restart qualification request has unknown fields');
    error.code = 'INVALID_CLEAN_RESTART_QUALIFICATION_REQUEST';
    throw error;
  }
  return request;
}

module.exports = {
  assertClosedQualificationRequest,
  buildQualificationEvent,
  normalizeDeployQualificationExpectation,
  normalizeQualificationObservation,
  projectQualificationResponse,
};

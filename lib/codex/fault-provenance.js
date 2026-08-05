'use strict';

const ROOT_ERROR_CODES = new Set([
  'CODEX_PROTOCOL_ERROR',
  'CODEX_TRANSPORT_ERROR',
  'CODEX_PROCESS_EXITED',
  'CODEX_PROCESS_ERROR',
  'CODEX_RPC_TIMEOUT',
  'CODEX_SINK_TIMEOUT',
  'CODEX_PROCESS_CLOSE_TIMEOUT',
  'CODEX_PROCESS_CLEANUP_UNVERIFIED',
  'unknown',
]);

const FAULT_CLASSES = new Set([
  'stderr-limit',
  'transport',
  'protocol',
  'process-exit',
  'rpc-timeout',
  'sink',
  'cleanup',
  'unknown',
]);

const NOTIFICATION_METHODS = new Set([
  'error',
  'thread/status/changed',
  'thread/settings/updated',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
]);

const PROCESS_STATES = new Set([
  'Spawning',
  'Initializing',
  'AttachingThread',
  'Idle',
  'StartingTurn',
  'Active',
  'BackgroundWorking',
  'BackgroundSettling',
  'Settling',
  'Quiescing',
  'Stopped',
  'Closing',
  'Closed',
  'FailedAmbiguous',
  'RecoveryConflict',
  'DurabilityBlocked',
  'ContainmentFailed',
  'unknown',
]);

function sanitizeCodexFaultProvenance(input) {
  const safe = {};
  if (ROOT_ERROR_CODES.has(input?.clientRootErrorCode)) {
    safe.clientRootErrorCode = input.clientRootErrorCode;
  }
  if (FAULT_CLASSES.has(input?.clientFaultClass)) {
    safe.clientFaultClass = input.clientFaultClass;
  }
  if (NOTIFICATION_METHODS.has(input?.notificationMethod)) {
    safe.notificationMethod = input.notificationMethod;
  }
  if (PROCESS_STATES.has(input?.observedProcessState)) {
    safe.observedProcessState = input.observedProcessState;
  }
  return safe;
}

module.exports = { sanitizeCodexFaultProvenance };

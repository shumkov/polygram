import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

import { registerGateSessionProject } from './claude-executable.mjs';
import { delayedMcpEvidenceSchemaMatches } from './delayed-mcp-gate.mjs';
import {
  subagentLifecycleProofSchemaMatches,
} from './subagent-gate.mjs';

const require = createRequire(import.meta.url);
const {
  SessionEventAggregator,
} = require('../../lib/util/claude-session-jsonl');

const FORBIDDEN_REVIEW_KEYS = new Set([
  'argv',
  'command',
  'content',
  'cwd',
  'executablePath',
  'parentUuid',
  'prompt',
  'sessionId',
  'session_id',
  'text',
  'toolInput',
  'tool_input',
  'uuid',
]);
const WRAPPER_RECORD_KEYS = [
  'argvCount',
  'argvHash',
  'executablePathHash',
  'executableSha256',
  'pid',
  'ppid',
  'recordedAt',
  'runId',
  'version',
  'versionProbePid',
];
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const GATE_MODEL_SELECTORS = new Set(['claude-sonnet-4-6', 'opus']);
const RESOLVED_GATE_MODELS = new Set([
  'claude-opus-5',
  'claude-sonnet-4-6',
]);
const RESULT_SUBTYPES = new Set([
  'error_during_execution',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_max_turns',
  'success',
]);
const COMMON_SDK_RESULT_KEYS = [
  'attestation',
  'evidenceSchemaVersion',
  'lifecycle',
  'matrixScenario',
  'processEvidence',
  'resolvedModel',
  'scenario',
  'status',
  'wrapperRecords',
];
const SANITIZED_RESULT_KEYS = new Map([
  ['cli-contract', [
    'attestation',
    'eventKinds',
    'evidenceSchemaVersion',
    'failureHash',
    'failureStage',
    'fileObserved',
    'lifecycle',
    'lifecycleProofs',
    'lifecycleSources',
    'matrixScenario',
    'processTree',
    'replyCount',
    'resolvedModel',
    'scenario',
    'spawnCount',
    'startupHandshake',
    'status',
    'wrapperRecords',
  ]],
  ['workflow-direct', [
    'attestation',
    'completionTurnProof',
    'deliveryFailedCount',
    'deliveryPipeline',
    'deliveryReasonCount',
    'deliverySentCount',
    'directCompletionCount',
    'directRouteCounts',
    'eventKinds',
    'evidenceSchemaVersion',
    'failureHash',
    'failureStage',
    'fallbackCount',
    'fallbackRouteCounts',
    'fixtureHash',
    'launchDeliveryCount',
    'launchDeliveryProof',
    'launchDeliveryReasonCount',
    'launchTurnClosedBeforeCompletion',
    'lifecycle',
    'lifecycleProofs',
    'lifecycleSources',
    'matrixScenario',
    'outOfTurnTiming',
    'processTree',
    'resolvedModel',
    'scenario',
    'status',
    'workflowMetadata',
    'workflowPolicyOverridePresent',
    'wrapperRecords',
  ]],
  ['workflow-fallback', null],
  ['delayed-mcp', [
    ...COMMON_SDK_RESULT_KEYS,
    'evidence',
    'lifecycleProofs',
    'lifecycleSources',
    'markerCount',
    'markerHash',
    'reasonCount',
    'reasonHashes',
    'resultSubtype',
  ]],
  ['sdk-post-tool-batch', [
    ...COMMON_SDK_RESULT_KEYS,
    'hookFiredCount',
    'markerPresent',
    'reasonCount',
    'resultSubtype',
  ]],
  ['sdk-subagent', [
    ...COMMON_SDK_RESULT_KEYS,
    'distinctParentCount',
    'lifecycleProofs',
    'lifecycleSources',
    'reasonCount',
    'resultSubtype',
    'subagentLifecycleProof',
    'subagentMessages',
    'topLevelMessages',
  ]],
  ['sdk-resume', [
    ...COMMON_SDK_RESULT_KEYS,
    'firstResultSubtype',
    'firstSessionPresent',
    'markerRecalled',
    'reasonCount',
    'secondResultSubtype',
    'secondSessionPresent',
  ]],
  ['sdk-compact', [
    ...COMMON_SDK_RESULT_KEYS,
    'compactBoundaryCount',
    'compactShapes',
    'markerRecallCount',
    'ordered',
    'orderedEvidence',
    'preCompactCount',
    'reasonCount',
    'recallPromptMarkerFree',
    'resultCount',
    'resultSubtype',
    'runtimeErrorPresent',
    'sameSession',
  ]],
  ['sdk-tool-less-drain', [
    ...COMMON_SDK_RESULT_KEYS,
    'bufferedMarkerCount',
    'hookFiredCount',
    'reasonCount',
    'resultSubtypes',
  ]],
  ['candidate-opus-projection', [
    ...COMMON_SDK_RESULT_KEYS,
    'documentedWorkflowSizeGuideline',
    'expectedResolvedModel',
    'lifecycleProofs',
    'lifecycleSources',
    'markerCount',
    'reasonCount',
    'reasonHashes',
    'resultSubtype',
    'workflowMetadata',
    'workflowPolicyOverridePresent',
    'workflowSizeGuidelineEvidence',
    'workflowStatus',
  ]],
]);
SANITIZED_RESULT_KEYS.set(
  'workflow-fallback',
  SANITIZED_RESULT_KEYS.get('workflow-direct'),
);

function hasExactKeys(value, keys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...keys].sort())
  );
}

function attestationSchemaMatches(attestation) {
  return (
    hasExactKeys(attestation, [
      'effort',
      'executablePathHash',
      'model',
      'runId',
      'sha256',
      'version',
      'wrapperRequired',
    ])
    && SAFE_RUN_ID_RE.test(attestation.runId || '')
    && !/^\.+$/.test(attestation.runId)
    && /^\d+\.\d+\.\d+$/.test(attestation.version || '')
    && SHA256_RE.test(attestation.sha256)
    && SHA256_RE.test(attestation.executablePathHash)
    && typeof attestation.wrapperRequired === 'boolean'
    && GATE_MODEL_SELECTORS.has(attestation.model)
    && attestation.effort === 'medium'
  );
}

function wrapperRecordSchemaMatches(record) {
  return (
    hasExactKeys(record, WRAPPER_RECORD_KEYS)
    && SHA256_RE.test(record.argvHash)
    && SHA256_RE.test(record.executablePathHash)
    && SHA256_RE.test(record.executableSha256)
    && Number.isInteger(record.argvCount)
    && record.argvCount >= 0
    && isPositiveInteger(record.pid)
    && isPositiveInteger(record.ppid)
    && isPositiveInteger(record.versionProbePid)
    && SAFE_RUN_ID_RE.test(record.runId || '')
    && !/^\.+$/.test(record.runId)
    && /^\d+\.\d+\.\d+$/.test(record.version || '')
    && typeof record.recordedAt === 'string'
    && Number.isFinite(Date.parse(record.recordedAt))
  );
}

export function processEvidenceSchemaMatches(evidence) {
  if (
    !hasExactKeys(evidence, [
      'rootPids',
      'sampleCount',
      'samplingErrorHash',
      'samplingFailed',
      'samplingFailureCount',
      'selectedBinaryPids',
      'selectedBinaryProcesses',
    ])
    || !Array.isArray(evidence.rootPids)
    || !Array.isArray(evidence.selectedBinaryPids)
    || !Array.isArray(evidence.selectedBinaryProcesses)
    || !Number.isInteger(evidence.sampleCount)
    || evidence.sampleCount < 0
    || typeof evidence.samplingFailed !== 'boolean'
    || !Number.isInteger(evidence.samplingFailureCount)
    || evidence.samplingFailureCount < 0
    || (
      evidence.samplingErrorHash !== null
      && !SHA256_RE.test(evidence.samplingErrorHash)
    )
  ) {
    return false;
  }
  const roots = evidence.rootPids;
  const pids = evidence.selectedBinaryPids;
  const processes = evidence.selectedBinaryProcesses;
  return (
    roots.every(isPositiveInteger)
    && new Set(roots).size === roots.length
    && pids.every(isPositiveInteger)
    && new Set(pids).size === pids.length
    && processes.length === pids.length
    && processes.every((record) => (
      hasExactKeys(record, ['pid', 'ppid'])
      && isPositiveInteger(record.pid)
      && isPositiveInteger(record.ppid)
    ))
    && isDeepStrictEqual(
      processes.map(({ pid }) => pid),
      pids,
    )
    && roots.every((pid) => pids.includes(pid))
    && evidence.samplingFailed === (evidence.samplingFailureCount > 0)
    && (
      evidence.samplingFailed
        ? SHA256_RE.test(evidence.samplingErrorHash || '')
        : evidence.samplingErrorHash === null
    )
  );
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function stringArray(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string');
}

function onlyLifecycleKeys(record, required, optional = []) {
  const allowed = new Set(['type', ...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key))
  );
}

const NORMALIZED_GATE_LIFECYCLE_SCHEMAS = {
  hook: (record) => (
    onlyLifecycleKeys(record, ['hookEventName'], ['toolName'])
    && nonEmptyString(record.hookEventName)
    && (
      record.toolName === undefined
      || nonEmptyString(record.toolName)
    )
  ),
  system: (record) => (
    onlyLifecycleKeys(record, ['subtype'], ['model'])
    && nonEmptyString(record.subtype)
    && (record.model === undefined || nonEmptyString(record.model))
  ),
  'queue-operation': (record) => (
    onlyLifecycleKeys(record, ['operation'])
    && nonEmptyString(record.operation)
  ),
  assistant: (record) => (
    onlyLifecycleKeys(
      record,
      ['contentTypes', 'hasParent', 'toolNames'],
      ['model', 'stopReason'],
    )
    && typeof record.hasParent === 'boolean'
    && stringArray(record.contentTypes)
    && stringArray(record.toolNames)
    && (record.model === undefined || nonEmptyString(record.model))
    && (
      record.stopReason === undefined
      || nonEmptyString(record.stopReason)
    )
  ),
  user: (record) => (
    onlyLifecycleKeys(
      record,
      ['contentKind', 'contentTypes', 'hasParent'],
      ['hasTaskNotification', 'originKind', 'promptSource'],
    )
    && typeof record.hasParent === 'boolean'
    && nonEmptyString(record.contentKind)
    && stringArray(record.contentTypes)
    && (
      record.originKind === undefined
      || nonEmptyString(record.originKind)
    )
    && (
      record.promptSource === undefined
      || nonEmptyString(record.promptSource)
    )
    && (
      record.hasTaskNotification === undefined
      || record.hasTaskNotification === true
    )
  ),
  attachment: (record) => (
    onlyLifecycleKeys(record, ['attachmentType'])
    && nonEmptyString(record.attachmentType)
  ),
  result: (record) => (
    onlyLifecycleKeys(record, ['subtype'])
    && nonEmptyString(record.subtype)
  ),
  'last-prompt': (record) => Object.keys(record).length === 1,
  mode: (record) => Object.keys(record).length === 1,
  'permission-mode': (record) => Object.keys(record).length === 1,
  rate_limit_event: (record) => Object.keys(record).length === 1,
};

export function normalizedGateLifecycleRecordSchemaMatches(record) {
  return (
    record
    && typeof record === 'object'
    && !Array.isArray(record)
    && Object.hasOwn(
      NORMALIZED_GATE_LIFECYCLE_SCHEMAS,
      record.type,
    )
    && NORMALIZED_GATE_LIFECYCLE_SCHEMAS[record.type](record)
  );
}

function normalizedGateLifecycleSchemaMatches(lifecycle, { allowEmpty = false } = {}) {
  if (Array.isArray(lifecycle)) {
    return (
      (allowEmpty || lifecycle.length > 0)
      && lifecycle.every(normalizedGateLifecycleRecordSchemaMatches)
    );
  }
  if (
    !lifecycle
    || typeof lifecycle !== 'object'
    || Array.isArray(lifecycle)
  ) {
    return false;
  }
  const streams = Object.keys(lifecycle);
  return (
    (allowEmpty || streams.length > 0)
    && streams.every((stream) => ['hooks', 'session'].includes(stream))
    && streams.every((stream) => (
      Array.isArray(lifecycle[stream])
      && lifecycle[stream].every(
        normalizedGateLifecycleRecordSchemaMatches,
      )
    ))
  );
}

function nullableString(value) {
  return value === null || typeof value === 'string';
}

function nullableEnum(value, allowed) {
  return value === null || allowed.has(value);
}

function nullableNonNegativeInteger(value) {
  return value === null || (Number.isInteger(value) && value >= 0);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function sha256Array(value) {
  return Array.isArray(value) && value.every((item) => SHA256_RE.test(item));
}

function lifecycleSourceSchemaMatches(source, stream) {
  return (
    hasExactKeys(source, [
      'file',
      'normalizedRecordCount',
      'rawRecordCount',
      'sha256',
      'stream',
    ])
    && source.stream === stream
    && /^[A-Za-z0-9._-]+$/.test(source.file || '')
    && path.basename(source.file) === source.file
    && SHA256_RE.test(source.sha256)
    && nonNegativeInteger(source.rawRecordCount)
    && nonNegativeInteger(source.normalizedRecordCount)
  );
}

function lifecycleSourcesSchemaMatches(sources, scenario, status) {
  const expected = ['cli-contract', 'workflow-direct', 'workflow-fallback']
    .includes(scenario)
    ? ['hooks', 'session']
    : ['delayed-mcp', 'sdk-subagent', 'candidate-opus-projection']
      .includes(scenario)
      ? ['sdk']
      : [];
  if (!hasExactKeys(sources, status === 'PASS' ? expected : Object.keys(sources || {}))) {
    return false;
  }
  const streams = Object.keys(sources);
  return (
    streams.every((stream) => expected.includes(stream))
    && streams.every(
      (stream) => lifecycleSourceSchemaMatches(sources[stream], stream),
    )
  );
}

function removalTargetSchemaMatches(target) {
  if (
    !hasExactKeys(target, [
      'eligibility',
      'normalizedTargetCount',
      'rawTargetCount',
      'record',
    ])
    || !normalizedGateLifecycleRecordSchemaMatches(target.record)
    || !nonNegativeInteger(target.normalizedTargetCount)
    || !nonNegativeInteger(target.rawTargetCount)
  ) {
    return false;
  }
  if (target.eligibility?.type === 'task-reminder-v1') {
    return hasExactKeys(target.eligibility, ['type']);
  }
  return (
    target.eligibility?.type === 'interrupt-user-prompt-submit-v1'
    && hasExactKeys(target.eligibility, [
      'allHookNamesMatch',
      'allMainline',
      'allParentsMatchInterrupt',
      'type',
    ])
    && target.eligibility.allHookNamesMatch === true
    && target.eligibility.allMainline === true
    && target.eligibility.allParentsMatchInterrupt === true
  );
}

function removalProofSchemaMatches(proof) {
  return (
    hasExactKeys(proof, [
      'filteredEventCount',
      'flattenedEventsEqual',
      'flushBatchEqual',
      'originalEventCount',
      'retainedPushBatchesEqual',
      'sourceSha256',
      'stream',
      'targetBatchesEmpty',
      'targets',
      'totalTargetCount',
      'type',
    ])
    && proof.type === 'session-event-aggregator-removal'
    && proof.stream === 'session'
    && SHA256_RE.test(proof.sourceSha256)
    && Array.isArray(proof.targets)
    && proof.targets.every(removalTargetSchemaMatches)
    && nonNegativeInteger(proof.totalTargetCount)
    && nonNegativeInteger(proof.originalEventCount)
    && nonNegativeInteger(proof.filteredEventCount)
    && [
      'targetBatchesEmpty',
      'retainedPushBatchesEqual',
      'flushBatchEqual',
      'flattenedEventsEqual',
    ].every((key) => typeof proof[key] === 'boolean')
  );
}

function lifecycleProofsSchemaMatches(proofs, scenario) {
  return (
    Array.isArray(proofs)
    && (
      ['cli-contract', 'workflow-direct', 'workflow-fallback'].includes(scenario)
        ? proofs.every(removalProofSchemaMatches)
        : proofs.length === 0
    )
  );
}

function processTreeSchemaMatches(processTree) {
  return (
    Array.isArray(processTree)
    && processTree.every((record) => (
      hasExactKeys(record, ['executablePathHash', 'pid', 'ppid'])
      && isPositiveInteger(record.pid)
      && isPositiveInteger(record.ppid)
      && SHA256_RE.test(record.executablePathHash)
    ))
    && new Set(processTree.map(({ pid }) => pid)).size === processTree.length
  );
}

function startupHandshakeSchemaMatches(handshake) {
  return (
    hasExactKeys(handshake, [
      'bridgeReadyMs',
      'bridgeReadyToMcpReadyMs',
      'mcpReadyMs',
    ])
    && ['bridgeReadyMs', 'bridgeReadyToMcpReadyMs', 'mcpReadyMs'].every(
      (key) => nonNegativeInteger(handshake[key]),
    )
    && handshake.mcpReadyMs - handshake.bridgeReadyMs
      === handshake.bridgeReadyToMcpReadyMs
  );
}

function launchDeliveryProofSchemaMatches(proof) {
  return (
    hasExactKeys(proof, [
      'deliverySucceeded',
      'exactTextMatched',
      'exactlyOneCall',
      'launchDeliveryCount',
      'nonInterim',
      'originRouteMatched',
      'replyToolMatched',
      'zeroFiles',
    ])
    && nonNegativeInteger(proof.launchDeliveryCount)
    && Object.entries(proof).every(([key, value]) => (
      key === 'launchDeliveryCount' || typeof value === 'boolean'
    ))
  );
}

function completionTurnProofSchemaMatches(proof) {
  return (
    hasExactKeys(proof, [
      'receiptIsError',
      'receiptOk',
      'stopAfterToolUse',
      'terminalAdvanced',
      'toolResultEventMatched',
      'toolUseMatched',
      'transcriptToolResultCount',
      'transcriptToolUseCount',
      'turnDurationCount',
    ])
    && [
      'receiptIsError',
      'receiptOk',
      'stopAfterToolUse',
      'terminalAdvanced',
      'toolResultEventMatched',
      'toolUseMatched',
    ].every((key) => typeof proof[key] === 'boolean')
    && [
      'transcriptToolResultCount',
      'transcriptToolUseCount',
      'turnDurationCount',
    ].every((key) => nonNegativeInteger(proof[key]))
  );
}

function workflowTimingSchemaMatches(timing) {
  return (
    hasExactKeys(timing, [
      'completionAfterLaunchTurnMs',
      'completionAfterTaskNotificationMs',
      'pass',
      'reasonCount',
      'requiredCompletionAfterNotificationMs',
      'requiredTaskNotificationDelayMs',
      'taskNotificationAfterStopMs',
    ])
    && typeof timing.pass === 'boolean'
    && nonNegativeInteger(timing.reasonCount)
    && [
      'completionAfterLaunchTurnMs',
      'completionAfterTaskNotificationMs',
      'requiredCompletionAfterNotificationMs',
      'requiredTaskNotificationDelayMs',
      'taskNotificationAfterStopMs',
    ].every((key) => nullableNonNegativeInteger(timing[key]))
  );
}

function workflowMetadataSchemaMatches(records) {
  return (
    Array.isArray(records)
    && records.every((record) => {
      const required = [
        'agentCount',
        'defaultModel',
        'durationMs',
        'phaseCount',
        'progressCount',
        'progressTypes',
        'reportComplete',
        'status',
        'totalTokens',
        'totalToolCalls',
      ];
      const keys = Object.hasOwn(record || {}, 'reportMatchesExpected')
        ? [...required, 'reportMatchesExpected']
        : required;
      return (
        hasExactKeys(record, keys)
        && nullableEnum(
          record.status,
          new Set(['cancelled', 'completed', 'failed']),
        )
        && nullableEnum(record.defaultModel, RESOLVED_GATE_MODELS)
        && [
          'agentCount',
          'durationMs',
          'phaseCount',
          'progressCount',
          'totalTokens',
          'totalToolCalls',
        ].every((key) => nullableNonNegativeInteger(record[key]))
        && typeof record.reportComplete === 'boolean'
        && (
          record.reportMatchesExpected === undefined
          || typeof record.reportMatchesExpected === 'boolean'
        )
        && record.progressTypes
        && typeof record.progressTypes === 'object'
        && !Array.isArray(record.progressTypes)
        && Object.entries(record.progressTypes).every(([key, count]) => (
          ['workflow_agent', 'workflow_phase'].includes(key)
          && nonNegativeInteger(count)
        ))
      );
    })
  );
}

function hashCountMapSchemaMatches(value) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(
      ([key, count]) => SHA256_RE.test(key) && nonNegativeInteger(count),
    )
  );
}

function compactNestedSchemaMatches(result) {
  const allowedKinds = new Set([
    'compact-boundary',
    'compact-prompt',
    'compact-result',
    'establish-prompt',
    'establish-result',
    'pre-compact',
    'recall-prompt',
    'recall-result',
  ]);
  return (
    Array.isArray(result.compactShapes)
    && result.compactShapes.every((shape) => (
      hasExactKeys(shape, [
        'hasMetadata',
        'postTokens',
        'preTokens',
        'subtype',
        'trigger',
      ])
      && typeof shape.hasMetadata === 'boolean'
      && nullableEnum(shape.subtype, new Set(['compact_boundary']))
      && nullableEnum(shape.trigger, new Set(['manual']))
      && nullableNonNegativeInteger(shape.preTokens)
      && nullableNonNegativeInteger(shape.postTokens)
    ))
    && Array.isArray(result.orderedEvidence)
    && result.orderedEvidence.every((record) => {
      const keys = ['kind', 'order', 'sessionHash', 'valueHash'];
      if (Object.hasOwn(record || {}, 'subtype')) keys.push('subtype');
      if (Object.hasOwn(record || {}, 'trigger')) keys.push('trigger');
      return (
        hasExactKeys(record, keys)
        && allowedKinds.has(record.kind)
        && isPositiveInteger(record.order)
        && SHA256_RE.test(record.sessionHash)
        && SHA256_RE.test(record.valueHash)
        && (
          record.subtype === undefined
          || (
            ['compact-result', 'establish-result', 'recall-result']
              .includes(record.kind)
            && RESULT_SUBTYPES.has(record.subtype)
          )
        )
        && (
          record.trigger === undefined
          || (
            ['compact-boundary', 'pre-compact'].includes(record.kind)
            && record.trigger === 'manual'
          )
        )
      );
    })
  );
}

function workflowSizeGuidelineEvidenceSchemaMatches(evidence) {
  return (
    hasExactKeys(evidence, [
      'executableSha256',
      'fingerprintMatched',
      'source',
      'value',
    ])
    && SHA256_RE.test(evidence.executableSha256)
    && evidence.source === 'selected-binary-runtime-default'
    && evidence.value === 'medium'
    && typeof evidence.fingerprintMatched === 'boolean'
  );
}

function nestedScenarioSchemaMatches(result, scenario) {
  if (Object.hasOwn(result, 'lifecycleSources')) {
    if (!lifecycleSourcesSchemaMatches(
      result.lifecycleSources,
      scenario,
      result.status,
    )) return false;
  }
  if (Object.hasOwn(result, 'lifecycleProofs')) {
    if (!lifecycleProofsSchemaMatches(result.lifecycleProofs, scenario)) {
      return false;
    }
  }
  if (Object.hasOwn(result, 'processTree')) {
    if (!processTreeSchemaMatches(result.processTree)) return false;
  }
  if (Object.hasOwn(result, 'reasonHashes')) {
    if (!sha256Array(result.reasonHashes)) return false;
  }
  if (scenario === 'cli-contract') {
    return (
      (result.startupHandshake === null
        || startupHandshakeSchemaMatches(result.startupHandshake))
      && Array.isArray(result.eventKinds)
      && result.eventKinds.every((kind) => SHA256_RE.test(kind))
    );
  }
  if (['workflow-direct', 'workflow-fallback'].includes(scenario)) {
    return (
      workflowTimingSchemaMatches(result.outOfTurnTiming)
      && launchDeliveryProofSchemaMatches(result.launchDeliveryProof)
      && (
        result.completionTurnProof === null
        || completionTurnProofSchemaMatches(result.completionTurnProof)
      )
      && workflowMetadataSchemaMatches(result.workflowMetadata)
      && hashCountMapSchemaMatches(result.directRouteCounts)
      && hashCountMapSchemaMatches(result.fallbackRouteCounts)
      && Array.isArray(result.eventKinds)
      && result.eventKinds.every((kind) => SHA256_RE.test(kind))
    );
  }
  if (scenario === 'delayed-mcp') {
    return (
      delayedMcpEvidenceSchemaMatches(result.evidence)
      && result.evidence.resultSubtype === result.resultSubtype
    );
  }
  if (scenario === 'sdk-subagent') {
    return subagentLifecycleProofSchemaMatches(
      result.subagentLifecycleProof,
    );
  }
  if (scenario === 'sdk-compact') {
    return compactNestedSchemaMatches(result);
  }
  if (scenario === 'sdk-tool-less-drain') {
    return Array.isArray(result.resultSubtypes)
      && result.resultSubtypes.every(nullableString);
  }
  if (scenario === 'candidate-opus-projection') {
    return (
      workflowSizeGuidelineEvidenceSchemaMatches(
        result.workflowSizeGuidelineEvidence,
      )
      && workflowMetadataSchemaMatches(result.workflowMetadata)
    );
  }
  return true;
}

function nullableResolvedModel(value) {
  return nullableEnum(value, RESOLVED_GATE_MODELS);
}

function failureScalarSchemaMatches(result, allowedStages) {
  return (
    (result.status === 'PASS'
      ? result.failureHash === null && result.failureStage === null
      : SHA256_RE.test(result.failureHash || '')
        && allowedStages.has(result.failureStage))
  );
}

function commonSdkScalarSchemaMatches(result, scenario) {
  return (
    result.scenario === scenario
    && nullableResolvedModel(result.resolvedModel)
    && nonNegativeInteger(result.reasonCount)
  );
}

function scenarioScalarSchemaMatches(result, scenario) {
  if (scenario === 'cli-contract') {
    return (
      result.scenario === 'cli-contract-matrix'
      && nullableResolvedModel(result.resolvedModel)
      && failureScalarSchemaMatches(result, new Set([
        'collecting-evidence',
        'file-reply',
        'follow-up-fold',
        'initializing',
        'interrupt',
        'multiline-reply',
        'readiness-reply',
        'starting-cli',
        'warm-reply',
      ]))
      && nonNegativeInteger(result.spawnCount)
      && nonNegativeInteger(result.replyCount)
      && typeof result.fileObserved === 'boolean'
    );
  }
  if (['workflow-direct', 'workflow-fallback'].includes(scenario)) {
    const direct = scenario === 'workflow-direct';
    return (
      result.scenario === `workflow-autonomous-completion-${direct ? 'direct' : 'fail'}`
      && nullableResolvedModel(result.resolvedModel)
      && failureScalarSchemaMatches(result, new Set([
        'awaiting-completion',
        'collecting-evidence',
        'evaluating-delivery',
        'evaluating-timing',
        'initializing',
        'launching-workflow',
        'starting-cli',
      ]))
      && SHA256_RE.test(result.fixtureHash)
      && typeof result.workflowPolicyOverridePresent === 'boolean'
      && typeof result.launchTurnClosedBeforeCompletion === 'boolean'
      && [
        'deliveryFailedCount',
        'deliveryReasonCount',
        'deliverySentCount',
        'directCompletionCount',
        'fallbackCount',
        'launchDeliveryCount',
        'launchDeliveryReasonCount',
      ].every((key) => nonNegativeInteger(result[key]))
      && (
        result.deliveryPipeline === null
        || result.deliveryPipeline === 'helper'
      )
    );
  }
  if (scenario === 'delayed-mcp') {
    return (
      commonSdkScalarSchemaMatches(result, scenario)
      && nullableEnum(result.resultSubtype, RESULT_SUBTYPES)
      && nonNegativeInteger(result.markerCount)
      && SHA256_RE.test(result.markerHash)
    );
  }
  if (scenario === 'sdk-post-tool-batch') {
    return (
      commonSdkScalarSchemaMatches(result, scenario)
      && nullableEnum(result.resultSubtype, RESULT_SUBTYPES)
      && nonNegativeInteger(result.hookFiredCount)
      && typeof result.markerPresent === 'boolean'
    );
  }
  if (scenario === 'sdk-subagent') {
    return (
      commonSdkScalarSchemaMatches(result, scenario)
      && nullableEnum(result.resultSubtype, RESULT_SUBTYPES)
      && [
        'distinctParentCount',
        'subagentMessages',
        'topLevelMessages',
      ].every((key) => nonNegativeInteger(result[key]))
    );
  }
  if (scenario === 'sdk-resume') {
    return (
      commonSdkScalarSchemaMatches(result, scenario)
      && typeof result.firstSessionPresent === 'boolean'
      && typeof result.secondSessionPresent === 'boolean'
      && typeof result.markerRecalled === 'boolean'
      && nullableEnum(result.firstResultSubtype, RESULT_SUBTYPES)
      && nullableEnum(result.secondResultSubtype, RESULT_SUBTYPES)
    );
  }
  if (scenario === 'sdk-compact') {
    return (
      commonSdkScalarSchemaMatches(result, scenario)
      && [
        'ordered',
        'recallPromptMarkerFree',
        'runtimeErrorPresent',
        'sameSession',
      ].every((key) => typeof result[key] === 'boolean')
      && [
        'compactBoundaryCount',
        'markerRecallCount',
        'preCompactCount',
        'resultCount',
      ].every((key) => nonNegativeInteger(result[key]))
      && nullableEnum(result.resultSubtype, RESULT_SUBTYPES)
    );
  }
  if (scenario === 'sdk-tool-less-drain') {
    return (
      commonSdkScalarSchemaMatches(result, scenario)
      && nonNegativeInteger(result.bufferedMarkerCount)
      && nonNegativeInteger(result.hookFiredCount)
      && result.resultSubtypes.every(
        (subtype) => nullableEnum(subtype, RESULT_SUBTYPES),
      )
    );
  }
  if (scenario === 'candidate-opus-projection') {
    return (
      commonSdkScalarSchemaMatches(result, scenario)
      && result.expectedResolvedModel === 'claude-opus-5'
      && result.documentedWorkflowSizeGuideline === 'medium'
      && nullableEnum(result.resultSubtype, RESULT_SUBTYPES)
      && nonNegativeInteger(result.markerCount)
      && (
        result.workflowPolicyOverridePresent === null
        || typeof result.workflowPolicyOverridePresent === 'boolean'
      )
      && nullableEnum(result.workflowStatus, new Set(['FAIL', 'PASS']))
    );
  }
  return false;
}

export function sanitizedGateResultSchemaMatches(result, scenario) {
  const keys = SANITIZED_RESULT_KEYS.get(scenario);
  if (
    !keys
    || !hasExactKeys(result, keys)
    || result.matrixScenario !== scenario
    || result.evidenceSchemaVersion !== 1
    || !['PASS', 'FAIL'].includes(result.status)
    || !attestationSchemaMatches(result.attestation)
    || !Array.isArray(result.wrapperRecords)
    || result.wrapperRecords.some(
      (record) => !wrapperRecordSchemaMatches(record),
    )
    || !normalizedGateLifecycleSchemaMatches(result.lifecycle, {
      allowEmpty: result.status === 'FAIL',
    })
  ) {
    return false;
  }
  if (
    Object.hasOwn(result, 'processEvidence')
    && !processEvidenceSchemaMatches(result.processEvidence)
  ) {
    return false;
  }
  return (
    scenarioScalarSchemaMatches(result, scenario)
    && nestedScenarioSchemaMatches(result, scenario)
  );
}

function stringField(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function normalizeGateRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  if (obj.hook_event_name) {
    return {
      type: 'hook',
      hookEventName: stringField(obj.hook_event_name),
      ...(stringField(obj.tool_name) && { toolName: obj.tool_name }),
    };
  }

  if (obj.type === 'system') {
    return {
      type: 'system',
      ...(stringField(obj.subtype) && { subtype: obj.subtype }),
      ...(stringField(obj.model) && { model: obj.model }),
    };
  }

  if (obj.type === 'queue-operation') {
    return {
      type: 'queue-operation',
      ...(stringField(obj.operation) && { operation: obj.operation }),
    };
  }

  if (obj.type === 'assistant') {
    const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
    return {
      type: 'assistant',
      hasParent: Boolean(obj.parentUuid || obj.parent_uuid || obj.parent_tool_use_id),
      ...(stringField(obj.message?.model) && { model: obj.message.model }),
      ...(stringField(obj.message?.stop_reason) && { stopReason: obj.message.stop_reason }),
      contentTypes: blocks.map((block) => block?.type).filter(Boolean),
      toolNames: blocks
        .filter((block) => block?.type === 'tool_use' && stringField(block.name))
        .map((block) => block.name),
    };
  }

  if (obj.type === 'user') {
    const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
    const stringContent = typeof obj.message?.content === 'string'
      ? obj.message.content
      : '';
    return {
      type: 'user',
      hasParent: Boolean(obj.parentUuid || obj.parent_uuid || obj.parent_tool_use_id),
      contentKind: Array.isArray(obj.message?.content)
        ? 'blocks'
        : typeof obj.message?.content,
      contentTypes: blocks.map((block) => block?.type).filter(Boolean),
      ...(stringField(obj.origin?.kind) && { originKind: obj.origin.kind }),
      ...(stringField(obj.promptSource) && { promptSource: obj.promptSource }),
      ...(stringContent.includes('<task-notification>') && { hasTaskNotification: true }),
    };
  }

  if (obj.type === 'attachment') {
    return {
      type: 'attachment',
      ...(stringField(obj.attachment?.type) && { attachmentType: obj.attachment.type }),
    };
  }

  return {
    type: stringField(obj.type) || 'unknown',
    ...(stringField(obj.subtype) && { subtype: obj.subtype }),
  };
}

export function readGateJsonlRecords(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    });
}

export function collectGateLifecycleEvidence(filePath, { stream }) {
  if (!['hooks', 'sdk', 'session'].includes(stream)) {
    throw new TypeError('gate lifecycle stream is not recognized');
  }
  const file = path.basename(filePath);
  if (
    file !== filePath.split(path.sep).at(-1)
    || !/^[A-Za-z0-9._-]+$/.test(file)
    || file === '.'
    || file === '..'
  ) {
    throw new TypeError('gate lifecycle source must have a safe basename');
  }
  const bytes = fs.readFileSync(filePath);
  const records = [];
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const normalized = normalizeGateRecord(JSON.parse(line));
      records.push(normalized || { type: 'malformed' });
    } catch {
      records.push({ type: 'malformed' });
    }
  }
  return {
    records,
    source: {
      stream,
      file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      rawRecordCount: records.length,
      normalizedRecordCount: records.length,
    },
  };
}

export function normalizeGateJsonl(filePath) {
  return collectGateLifecycleEvidence(filePath, {
    stream: path.basename(filePath) === 'hooks.ndjson' ? 'hooks' : 'session',
  }).records;
}

export function waitForGateEventSequence({
  emitter,
  steps,
  timeoutMs,
  label = 'gate event sequence',
  state = {},
}) {
  if (
    !emitter
    || typeof emitter.on !== 'function'
    || typeof emitter.off !== 'function'
  ) {
    throw new TypeError('gate event sequence requires an event emitter');
  }
  if (
    !Array.isArray(steps)
    || steps.length === 0
    || steps.some((step) => (
      !step
      || typeof step.eventName !== 'string'
      || step.eventName.length === 0
      || typeof step.matches !== 'function'
      || (step.capture !== undefined && typeof step.capture !== 'function')
    ))
  ) {
    throw new TypeError('gate event sequence requires ordered event steps');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('gate event sequence timeout must be positive');
  }

  return new Promise((resolve, reject) => {
    let stepIndex = 0;
    let settled = false;
    const eventNames = [...new Set(steps.map((step) => step.eventName))];
    const cleanup = () => {
      clearTimeout(timer);
      for (const eventName of eventNames) {
        emitter.off(eventName, listeners.get(eventName));
      }
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const listeners = new Map(eventNames.map((eventName) => [
      eventName,
      (value) => {
        if (settled) return;
        const step = steps[stepIndex];
        if (step.eventName !== eventName) return;
        try {
          if (!step.matches(value, state)) return;
          step.capture?.(value, state);
        } catch (error) {
          settle(reject, error);
          return;
        }
        stepIndex += 1;
        if (stepIndex === steps.length) settle(resolve, state);
      },
    ]));
    const timer = setTimeout(() => {
      settle(
        reject,
        new Error(`${label} timed out after ${timeoutMs}ms at step ${stepIndex + 1}`),
      );
    }, timeoutMs);
    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }
  });
}

function isGateSessionPivotal(record) {
  return (
    record?.type === 'queue-operation'
    || record?.type === 'attachment'
    || (record?.type === 'system' && record.subtype !== 'init')
    || (
      record?.type === 'user'
      && (
        record.hasTaskNotification
        || record.originKind
        || record.promptSource
      )
    )
  );
}

export function readGateSessionTerminalState(filePath) {
  const records = normalizeGateJsonl(filePath);
  if (records.some((record) => record.type === 'malformed')) {
    throw new Error('gate session contains malformed lifecycle evidence');
  }
  const pivotal = records.filter(isGateSessionPivotal);
  return {
    turnDurationCount: records.filter((record) => (
      record.type === 'system' && record.subtype === 'turn_duration'
    )).length,
    pivotalSuffix: pivotal.slice(-2),
  };
}

export function waitForGateSessionTerminal({
  filePath,
  afterTurnDurationCount,
  timeoutMs,
  pollMs = 25,
}) {
  if (
    !Number.isInteger(afterTurnDurationCount)
    || afterTurnDurationCount < 0
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || !Number.isFinite(pollMs)
    || pollMs <= 0
  ) {
    throw new TypeError('gate terminal waiter requires bounded counts and timing');
  }
  const expectedSuffix = [
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'system', subtype: 'turn_duration' },
  ];
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let state;
      try {
        state = readGateSessionTerminalState(filePath);
      } catch (error) {
        reject(error);
        return;
      }
      if (
        state.turnDurationCount > afterTurnDurationCount
        && isDeepStrictEqual(state.pivotalSuffix, expectedSuffix)
      ) {
        resolve(state);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`gate session terminal suffix timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

function replaySessionLines(lines) {
  const aggregator = new SessionEventAggregator();
  const pushBatches = lines.map((line) => aggregator.push(line));
  const flushBatch = aggregator.flush();
  return {
    pushBatches,
    flushBatch,
    events: [...pushBatches.flat(), ...flushBatch],
  };
}

function isTaskReminderRecord(value) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.type === 'attachment'
    && value.attachment?.type === 'task_reminder'
  );
}

const TASK_REMINDER_TARGET = {
  record: {
    type: 'attachment',
    attachmentType: 'task_reminder',
  },
  eligibility: {
    type: 'task-reminder-v1',
  },
};
const HOOK_CANCELLED_TARGET = {
  record: {
    type: 'attachment',
    attachmentType: 'hook_cancelled',
  },
  eligibility: {
    type: 'interrupt-user-prompt-submit-v1',
    allMainline: true,
    allHookNamesMatch: true,
    allParentsMatchInterrupt: true,
  },
};

function isInterruptHookCancellation(
  value,
  parsed,
  { interruptSourceMsgId, channelServerName },
) {
  if (
    !Number.isInteger(interruptSourceMsgId)
    || interruptSourceMsgId <= 0
    || typeof channelServerName !== 'string'
    || channelServerName.length === 0
    || value?.type !== 'attachment'
    || value.isSidechain !== false
    || value.attachment?.type !== 'hook_cancelled'
    || value.attachment.hookName !== 'UserPromptSubmit'
    || value.attachment.hookEvent !== 'UserPromptSubmit'
    || typeof value.parentUuid !== 'string'
    || value.parentUuid.length === 0
  ) {
    return false;
  }
  const parents = parsed.filter(
    (record) => record?.uuid === value.parentUuid,
  );
  if (parents.length !== 1) return false;
  const [parent] = parents;
  if (
    parent.type !== 'user'
    || parent.isSidechain !== false
    || parent.origin?.kind !== 'channel'
    || parent.origin.server !== channelServerName
    || parent.promptSource !== 'system'
    || typeof parent.message?.content !== 'string'
  ) {
    return false;
  }
  const msgIds = [...parent.message.content.matchAll(
    /\bmsg_id="([^"]+)"/g,
  )].map((match) => match[1]);
  return (
    msgIds.length === 1
    && msgIds[0] === String(interruptSourceMsgId)
  );
}

function sameNormalizedRecord(left, right) {
  return isDeepStrictEqual(left, right);
}

export function collectGateSessionEvidence(
  filePath,
  {
    interruptSourceMsgId,
    channelServerName,
  } = {},
) {
  const collection = collectGateLifecycleEvidence(filePath, {
    stream: 'session',
  });
  const bytes = fs.readFileSync(filePath);
  const content = bytes.toString('utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  });
  const { records, source } = collection;
  const targetsByIndex = parsed.map((value) => {
    if (isTaskReminderRecord(value)) return TASK_REMINDER_TARGET;
    if (isInterruptHookCancellation(value, parsed, {
      interruptSourceMsgId,
      channelServerName,
    })) {
      return HOOK_CANCELLED_TARGET;
    }
    return null;
  });
  const targetIndices = targetsByIndex.flatMap(
    (target, index) => (target ? [index] : []),
  );
  if (targetIndices.length === 0) {
    return { records, source, proofs: [] };
  }

  const targetIndexSet = new Set(targetIndices);
  const original = replaySessionLines(lines);
  const filtered = replaySessionLines(
    lines.filter((_line, index) => !targetIndexSet.has(index)),
  );
  const targetBatches = targetIndices.map(
    (index) => original.pushBatches[index],
  );
  const retainedOriginalBatches = original.pushBatches.filter(
    (_batch, index) => !targetIndexSet.has(index),
  );
  const targetDefinitions = [];
  for (const target of [HOOK_CANCELLED_TARGET, TASK_REMINDER_TARGET]) {
    const rawTargetCount = targetsByIndex.filter(
      (candidate) => candidate === target,
    ).length;
    if (rawTargetCount === 0) continue;
    targetDefinitions.push({
      record: target.record,
      rawTargetCount,
      normalizedTargetCount: records.filter(
        (record) => sameNormalizedRecord(record, target.record),
      ).length,
      eligibility: target.eligibility,
    });
  }
  const proof = {
    type: 'session-event-aggregator-removal',
    stream: 'session',
    sourceSha256: source.sha256,
    targets: targetDefinitions,
    totalTargetCount: targetIndices.length,
    targetBatchesEmpty: targetBatches.every((batch) => batch.length === 0),
    retainedPushBatchesEqual: isDeepStrictEqual(
      retainedOriginalBatches,
      filtered.pushBatches,
    ),
    flushBatchEqual: isDeepStrictEqual(
      original.flushBatch,
      filtered.flushBatch,
    ),
    originalEventCount: original.events.length,
    filteredEventCount: filtered.events.length,
    flattenedEventsEqual: isDeepStrictEqual(
      original.events,
      filtered.events,
    ),
  };
  return { records, source, proofs: [proof] };
}

export function resolveGateLifecycleModel({
  records,
  expectedModel,
  label = 'session',
}) {
  const observedModels = (Array.isArray(records) ? records : [])
    .filter((record) => (
      (record.type === 'system' && record.subtype === 'init')
      || record.type === 'assistant'
    ))
    .map((record) => record.model)
    .filter((model) => model && model !== '<synthetic>');
  if (observedModels.length === 0) {
    throw new Error(`${label} must contain an observed model`);
  }
  if (observedModels.some((model) => model !== expectedModel)) {
    throw new Error(`${label} observed models must match the expected model`);
  }
  return observedModels.at(-1);
}

export function readWrapperRecords(selection) {
  const recordsPath = path.join(selection.artifactDir, 'process-wrapper.ndjson');
  if (!fs.existsSync(recordsPath)) return [];
  return fs.readFileSync(recordsPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function validateWrapperProvenance(
  selection,
  records,
  {
    observedClaudeProcesses = [],
    unwrappedRootPids = [],
    requireWrapperRecord = true,
  } = {},
) {
  if (selection.sessionLauncher) {
    if (records.some((record) => !wrapperRecordSchemaMatches(record))) {
      throw new Error('candidate wrapper provenance schema is not recognized');
    }
    if (records.some((record) => record.runId !== selection.runId)) {
      throw new Error('candidate wrapper provenance run id does not match the selected run');
    }
    if (records.some((record) => (
      record.version !== selection.version
      || record.executableSha256 !== selection.sha256
      || record.executablePathHash
        !== selection.sanitizedAttestation.executablePathHash
    ))) {
      throw new Error('candidate wrapper provenance does not match the selected executable');
    }
    if (records.some((record) => (
      !isPositiveInteger(record.pid)
      || !isPositiveInteger(record.ppid)
      || !isPositiveInteger(record.versionProbePid)
      || new Set([record.pid, record.ppid, record.versionProbePid]).size !== 3
    ))) {
      throw new Error('candidate wrapper provenance has invalid process identities');
    }
    const recordedPids = new Set(records.map((record) => record.pid));
    const versionProbePids = new Set(
      records.map((record) => record.versionProbePid),
    );
    if (
      recordedPids.size !== records.length
      || versionProbePids.size !== records.length
      || [...versionProbePids].some((pid) => recordedPids.has(pid))
    ) {
      throw new Error('candidate wrapper provenance has ambiguous wrapper identities');
    }
    if (observedClaudeProcesses.some((record) => (
      !isPositiveInteger(record?.pid) || !isPositiveInteger(record?.ppid)
    ))) {
      throw new Error('observed Claude process evidence has invalid process identities');
    }
    const probeOwners = new Map(
      records.map((record) => [record.versionProbePid, record.pid]),
    );
    const permittedRoots = new Set(unwrappedRootPids);
    const observedWrappedProcesses = observedClaudeProcesses
      .filter((record) => !permittedRoots.has(record.pid));
    if (
      records.length === 0
      && (requireWrapperRecord || observedWrappedProcesses.length > 0)
    ) {
      throw new Error('candidate wrapper provenance is required');
    }
    const missing = observedWrappedProcesses
      .filter((record) => (
        !recordedPids.has(record.pid)
        && probeOwners.get(record.pid) !== record.ppid
      ))
      .map((record) => record.pid);
    if (missing.length > 0) {
      throw new Error(`missing wrapper provenance for observed Claude pid ${missing.join(',')}`);
    }
  } else if (records.length !== 0) {
    throw new Error('legacy run must not claim wrapper provenance');
  }
}

export function evaluateSdkGateEvidence({
  selection,
  resolvedModel,
  expectedResolvedModel = selection?.model,
  wrapperRecords = [],
  observedClaudeProcesses = [],
  unwrappedRootPids = [],
  sampleCount = 0,
  processSamplingFailed = false,
}) {
  const reasons = [];
  if (typeof resolvedModel !== 'string' || resolvedModel !== expectedResolvedModel) {
    reasons.push('observed SDK init model does not match the expected model');
  }
  if (processSamplingFailed) {
    reasons.push('SDK process sampling failed while the Claude root was active');
  }
  const rootPids = Array.isArray(unwrappedRootPids)
    ? unwrappedRootPids
    : [];
  const processes = Array.isArray(observedClaudeProcesses)
    ? observedClaudeProcesses
    : [];
  const rootSet = new Set(rootPids);
  const processPids = processes.map((record) => record?.pid);
  if (
    !Number.isInteger(sampleCount)
    || sampleCount <= 0
    || rootPids.length === 0
    || rootSet.size !== rootPids.length
    || rootPids.some((pid) => !isPositiveInteger(pid))
    || processes.length === 0
    || new Set(processPids).size !== processPids.length
    || processes.some((record) => (
      !isPositiveInteger(record?.pid)
      || !isPositiveInteger(record?.ppid)
    ))
    || rootPids.some((pid) => !processPids.includes(pid))
  ) {
    reasons.push('SDK process evidence does not prove every selected root');
  }
  try {
    validateWrapperProvenance(selection, wrapperRecords, {
      observedClaudeProcesses,
      unwrappedRootPids,
      requireWrapperRecord: false,
    });
  } catch (error) {
    reasons.push(error.message);
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}

export function createSdkGateObserver(
  selection,
  {
    expectedResolvedModel = selection?.model,
  } = {},
) {
  let resolvedModel = null;
  let resultSubtype = null;
  const lifecycle = [];

  return {
    observe(message) {
      const normalized = normalizeGateRecord(message);
      if (normalized) lifecycle.push(normalized);
      if (
        message?.type === 'system'
        && message.subtype === 'init'
        && typeof message.model === 'string'
      ) {
        resolvedModel = message.model;
      }
      if (message?.type === 'result' && typeof message.subtype === 'string') {
        resultSubtype = message.subtype;
        if (
          typeof message.session_id === 'string'
          && selection?.sdkCwd
        ) {
          registerGateSessionProject(
            selection,
            selection.sdkCwd,
            message.session_id,
          );
        }
      }
    },
    finish() {
      selection?.stopSdkProcessSampling?.();
      let modelResolutionError = null;
      try {
        resolvedModel = resolveGateLifecycleModel({
          records: lifecycle,
          expectedModel: expectedResolvedModel,
          label: 'SDK lifecycle',
        });
      } catch (error) {
        resolvedModel = null;
        modelResolutionError = error.message;
      }
      const wrapperRecords = selection?.artifactDir
        ? readWrapperRecords(selection)
        : [];
      const observedClaudeProcesses = selection?.sdkProcessEvidence
        ?.selectedBinaryProcesses || [];
      const observedClaudePids = selection?.sdkProcessEvidence
        ?.selectedBinaryPids
        || observedClaudeProcesses.map((record) => record.pid);
      const unwrappedRootPids = selection?.sdkProcessEvidence?.rootPids || [];
      const processSamplingFailed = (
        selection?.sdkProcessEvidence?.samplingFailed === true
      );
      const evaluation = evaluateSdkGateEvidence({
        selection,
        resolvedModel,
        expectedResolvedModel,
        wrapperRecords,
        observedClaudeProcesses,
        unwrappedRootPids,
        sampleCount: selection?.sdkProcessEvidence?.sampleCount || 0,
        processSamplingFailed,
      });
      if (!lifecycle.some((record) => (
        record.type === 'system'
        && record.subtype === 'init'
        && typeof record.model === 'string'
      ))) {
        evaluation.reasons.push('SDK lifecycle must contain an observed init model');
      }
      if (modelResolutionError) {
        evaluation.reasons.push(modelResolutionError);
      }
      evaluation.pass = evaluation.reasons.length === 0;
      const processEvidence = {
        rootPids: [...unwrappedRootPids],
        selectedBinaryPids: [...observedClaudePids],
        selectedBinaryProcesses: observedClaudeProcesses.map((record) => ({
          pid: record.pid,
          ppid: record.ppid,
        })),
        sampleCount: selection?.sdkProcessEvidence?.sampleCount || 0,
        samplingFailed: processSamplingFailed,
        samplingFailureCount:
          selection?.sdkProcessEvidence?.samplingFailureCount || 0,
        samplingErrorHash:
          selection?.sdkProcessEvidence?.samplingErrorHash || null,
      };
      if (selection?.artifactDir) {
        const privateDir = path.join(selection.artifactDir, 'raw-private');
        fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
        const processPath = path.join(
          privateDir,
          'sdk-process-evidence.json',
        );
        fs.writeFileSync(
          processPath,
          `${JSON.stringify(processEvidence, null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
        fs.chmodSync(processPath, 0o600);
      }
      return {
        ...evaluation,
        resolvedModel,
        resultSubtype,
        wrapperRecords,
        processEvidence,
        lifecycle,
      };
    },
  };
}

function assertReviewSafe(value, keyPath = 'result') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertReviewSafe(item, `${keyPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_REVIEW_KEYS.has(key)) {
      throw new Error(`review evidence contains forbidden key ${keyPath}.${key}`);
    }
    assertReviewSafe(child, `${keyPath}.${key}`);
  }
}

export function writeSanitizedGateResult(artifactDir, result) {
  assertReviewSafe(result);
  if (!sanitizedGateResultSchemaMatches(result, result?.matrixScenario)) {
    throw new Error('sanitized result schema is not recognized');
  }
  const outputPath = path.join(artifactDir, 'sanitized-result.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(outputPath, 0o600);
  return outputPath;
}

export function writePrivateGateFailure(artifactDir, error) {
  const rawDir = path.join(artifactDir, 'raw-private');
  fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(rawDir, 0o700);
  const outputPath = path.join(rawDir, 'failure.txt');
  const detail = error?.stack || error?.message || String(error);
  fs.writeFileSync(outputPath, `${detail}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(outputPath, 0o600);
  return outputPath;
}

export function copyPrivateGateArtifact(sourcePath, artifactDir, fileName) {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    throw new TypeError('private artifact fileName must be a safe basename');
  }
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new TypeError('private artifact source must be a real file');
  }
  fs.chmodSync(sourcePath, 0o600);
  const rawDir = path.join(artifactDir, 'raw-private');
  fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(rawDir, 0o700);
  const destination = path.join(rawDir, fileName);
  fs.copyFileSync(sourcePath, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}

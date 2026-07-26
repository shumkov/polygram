import crypto from 'node:crypto';

const MODES = new Set(['foreground', 'background']);
const RESULT_SUBTYPES = new Set([
  'error_during_execution',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_max_turns',
  'success',
]);
const EARLY_TOLERANCE_MS = 250;
const LATE_TOLERANCE_MS = 2_000;
const MINIMUM_COMPLETION_LEAD_MS = 2_000;

const PROOF_KEYS = [
  'schemaVersion',
  'expectedMode',
  'counts',
  'ordinals',
  'membership',
  'correlations',
  'statuses',
  'timing',
];
const COUNT_KEYS = [
  'targetToolUse',
  'targetToolResult',
  'nonEmptyMembership',
  'emptyMembership',
  'taskStarted',
  'taskCompleted',
  'taskNotification',
  'marker',
];
const ORDINAL_KEYS = [
  'toolUse',
  'membershipListed',
  'taskStarted',
  'toolResult',
  'membershipCleared',
  'taskCompleted',
  'taskNotification',
  'marker',
];
const MEMBERSHIP_KEYS = ['listedTaskCount', 'clearedTaskCount'];
const CORRELATION_KEYS = [
  'listedTaskIsTargetMcp',
  'startedTaskIsTargetMcp',
  'listedTaskMatchesStarted',
  'startedToolUseMatchesTarget',
  'toolResultMatchesTarget',
  'completedTaskMatchesStarted',
  'notificationTaskMatchesStarted',
  'notificationToolUseMatchesTarget',
];
const STATUS_KEYS = [
  'asyncPlaceholder',
  'taskCompleted',
  'notificationCompleted',
];
const TIMING_KEYS = ['asyncResultDelayMs', 'asyncResultLeadMs'];
const EVIDENCE_KEYS = [
  'expectedMode',
  'thresholdMs',
  'handlerDurationMs',
  'toolUseCount',
  'markerCount',
  'resultSubtype',
  'toolResultBeforeHandlerCompletion',
  'nativeLifecycleProof',
];

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0')
      === [...expectedKeys].sort().join('\0')
  );
}

export function buildDelayedMcpGatePrompt() {
  return [
    'Call mcp__polygram-delayed-gate__delayed_marker exactly once.',
    'If it becomes a background task, wait for its native completion notification.',
    'After the tool completes, reply with exactly the marker returned by the tool and nothing else.',
  ].join(' ');
}

function positiveOrdinal(value) {
  return Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function nullableOrdinal(value) {
  return value === null || positiveOrdinal(value);
}

function nullableNonNegativeInteger(value) {
  return value === null || nonNegativeInteger(value);
}

function allEqual(value, keys, expected) {
  return keys.every((key) => value[key] === expected);
}

function contentBlocks(message) {
  return Array.isArray(message?.message?.content)
    ? message.message.content
    : [];
}

export function createDelayedMcpLifecycleProof(messages, {
  expectedMode,
  markerHash,
  asyncPlaceholder,
  timing,
}) {
  if (
    !MODES.has(expectedMode)
    || !/^[a-f0-9]{64}$/.test(markerHash || '')
    || typeof asyncPlaceholder !== 'boolean'
    || !hasExactKeys(timing, TIMING_KEYS)
  ) {
    throw new TypeError('delayed MCP proof inputs are not recognized');
  }
  const stream = Array.isArray(messages) ? messages : [];
  const targetToolName = 'mcp__polygram-delayed-gate__delayed_marker';
  const targetTaskDescription = 'polygram-delayed-gate/delayed_marker';
  const proof = {
    schemaVersion: 1,
    expectedMode,
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
    ordinals: Object.fromEntries(ORDINAL_KEYS.map((key) => [key, null])),
    membership: {
      listedTaskCount: null,
      clearedTaskCount: null,
    },
    correlations: Object.fromEntries(
      CORRELATION_KEYS.map((key) => [key, null]),
    ),
    statuses: {
      asyncPlaceholder,
      taskCompleted: false,
      notificationCompleted: false,
    },
    timing: { ...timing },
  };
  let targetToolUseId = null;
  let targetToolResultId = null;
  let listedTask = null;
  let startedTask = null;
  let completedTaskId = null;
  let notifiedTask = null;

  stream.forEach((message, index) => {
    const ordinal = index + 1;
    if (message?.type === 'system') {
      if (message.subtype === 'background_tasks_changed') {
        const tasks = Array.isArray(message.tasks) ? message.tasks : [];
        if (tasks.length === 0) {
          proof.counts.emptyMembership += 1;
          proof.ordinals.membershipCleared ??= ordinal;
          proof.membership.clearedTaskCount = 0;
        } else {
          proof.counts.nonEmptyMembership += 1;
          proof.ordinals.membershipListed ??= ordinal;
          proof.membership.listedTaskCount = tasks.length;
          if (tasks.length === 1 && listedTask === null) [listedTask] = tasks;
        }
      } else if (message.subtype === 'task_started') {
        proof.counts.taskStarted += 1;
        proof.ordinals.taskStarted ??= ordinal;
        startedTask ??= message;
      } else if (
        message.subtype === 'task_updated'
        && message.patch?.status === 'completed'
      ) {
        proof.counts.taskCompleted += 1;
        proof.ordinals.taskCompleted ??= ordinal;
        completedTaskId ??= message.task_id;
        proof.statuses.taskCompleted = true;
      } else if (message.subtype === 'task_notification') {
        proof.counts.taskNotification += 1;
        proof.ordinals.taskNotification ??= ordinal;
        notifiedTask ??= message;
        proof.statuses.notificationCompleted =
          message.status === 'completed';
      }
    }
    if (message?.type === 'assistant') {
      for (const block of contentBlocks(message)) {
        if (
          block?.type === 'tool_use'
          && block.name === targetToolName
        ) {
          proof.counts.targetToolUse += 1;
          proof.ordinals.toolUse ??= ordinal;
          targetToolUseId ??= block.id;
        }
        if (
          block?.type === 'text'
          && typeof block.text === 'string'
          && crypto.createHash('sha256').update(block.text).digest('hex')
            === markerHash
        ) {
          proof.counts.marker += 1;
          proof.ordinals.marker ??= ordinal;
        }
      }
    }
    if (message?.type === 'user') {
      for (const block of contentBlocks(message)) {
        if (!isTargetDelayedMcpToolResult(block, targetToolUseId)) continue;
        proof.counts.targetToolResult += 1;
        proof.ordinals.toolResult ??= ordinal;
        targetToolResultId ??= block.tool_use_id;
      }
    }
  });

  proof.correlations.listedTaskIsTargetMcp = listedTask === null
    ? null
    : (
        listedTask.task_type === 'mcp_task'
        && listedTask.description === targetTaskDescription
      );
  proof.correlations.startedTaskIsTargetMcp = startedTask === null
    ? null
    : (
        startedTask.task_type === 'mcp_task'
        && startedTask.description === targetTaskDescription
      );
  proof.correlations.listedTaskMatchesStarted = (
    listedTask === null || startedTask === null
  ) ? null : listedTask.task_id === startedTask.task_id;
  proof.correlations.startedToolUseMatchesTarget = startedTask === null
    ? null
    : startedTask.tool_use_id === targetToolUseId;
  proof.correlations.toolResultMatchesTarget =
    targetToolResultId === targetToolUseId;
  proof.correlations.completedTaskMatchesStarted = (
    completedTaskId === null || startedTask === null
  ) ? null : completedTaskId === startedTask.task_id;
  proof.correlations.notificationTaskMatchesStarted = (
    notifiedTask === null || startedTask === null
  ) ? null : notifiedTask.task_id === startedTask.task_id;
  proof.correlations.notificationToolUseMatchesTarget =
    notifiedTask === null
      ? null
      : notifiedTask.tool_use_id === targetToolUseId;
  return proof;
}

function proofHasExactSchema(proof) {
  return (
    hasExactKeys(proof, PROOF_KEYS)
    && hasExactKeys(proof.counts, COUNT_KEYS)
    && hasExactKeys(proof.ordinals, ORDINAL_KEYS)
    && hasExactKeys(proof.membership, MEMBERSHIP_KEYS)
    && hasExactKeys(proof.correlations, CORRELATION_KEYS)
    && hasExactKeys(proof.statuses, STATUS_KEYS)
    && hasExactKeys(proof.timing, TIMING_KEYS)
    && proof.schemaVersion === 1
    && MODES.has(proof.expectedMode)
    && COUNT_KEYS.every((key) => nonNegativeInteger(proof.counts[key]))
    && ORDINAL_KEYS.every((key) => nullableOrdinal(proof.ordinals[key]))
    && MEMBERSHIP_KEYS.every(
      (key) => nullableNonNegativeInteger(proof.membership[key]),
    )
    && CORRELATION_KEYS.every(
      (key) => (
        proof.correlations[key] === null
        || typeof proof.correlations[key] === 'boolean'
      ),
    )
    && STATUS_KEYS.every(
      (key) => typeof proof.statuses[key] === 'boolean',
    )
    && TIMING_KEYS.every(
      (key) => nullableNonNegativeInteger(proof.timing[key]),
    )
  );
}

export function delayedMcpEvidenceSchemaMatches(evidence) {
  return (
    hasExactKeys(evidence, EVIDENCE_KEYS)
    && MODES.has(evidence.expectedMode)
    && Number.isInteger(evidence.thresholdMs)
    && evidence.thresholdMs > 0
    && nonNegativeInteger(evidence.handlerDurationMs)
    && nonNegativeInteger(evidence.toolUseCount)
    && nonNegativeInteger(evidence.markerCount)
    && (
      evidence.resultSubtype === null
      || RESULT_SUBTYPES.has(evidence.resultSubtype)
    )
    && typeof evidence.toolResultBeforeHandlerCompletion === 'boolean'
    && proofHasExactSchema(evidence.nativeLifecycleProof)
    && evidence.nativeLifecycleProof.expectedMode === evidence.expectedMode
  );
}

function foregroundProofMatches(proof) {
  const { counts, ordinals, membership, correlations, statuses, timing } = proof;
  return (
    counts.targetToolUse === 1
    && counts.targetToolResult === 1
    && counts.marker === 1
    && allEqual(counts, [
      'nonEmptyMembership',
      'emptyMembership',
      'taskStarted',
      'taskCompleted',
      'taskNotification',
    ], 0)
    && positiveOrdinal(ordinals.toolUse)
    && positiveOrdinal(ordinals.toolResult)
    && positiveOrdinal(ordinals.marker)
    && ordinals.toolUse < ordinals.toolResult
    && ordinals.toolResult < ordinals.marker
    && allEqual(ordinals, [
      'membershipListed',
      'taskStarted',
      'membershipCleared',
      'taskCompleted',
      'taskNotification',
    ], null)
    && membership.listedTaskCount === null
    && membership.clearedTaskCount === null
    && correlations.toolResultMatchesTarget === true
    && allEqual(correlations, [
      'listedTaskIsTargetMcp',
      'startedTaskIsTargetMcp',
      'listedTaskMatchesStarted',
      'startedToolUseMatchesTarget',
      'completedTaskMatchesStarted',
      'notificationTaskMatchesStarted',
      'notificationToolUseMatchesTarget',
    ], null)
    && statuses.asyncPlaceholder === false
    && statuses.taskCompleted === false
    && statuses.notificationCompleted === false
    && timing.asyncResultDelayMs === null
    && timing.asyncResultLeadMs === null
  );
}

function backgroundProofMatches(proof, evidence) {
  const { counts, ordinals, membership, correlations, statuses, timing } = proof;
  const nativeOrdinals = [
    ordinals.membershipListed,
    ordinals.taskStarted,
    ordinals.membershipCleared,
    ordinals.taskCompleted,
    ordinals.taskNotification,
  ];
  const timingMatches = (
    Number.isInteger(timing.asyncResultDelayMs)
    && Number.isInteger(timing.asyncResultLeadMs)
    && timing.asyncResultDelayMs
      >= evidence.thresholdMs - EARLY_TOLERANCE_MS
    && timing.asyncResultDelayMs
      <= evidence.thresholdMs + LATE_TOLERANCE_MS
    && timing.asyncResultLeadMs >= MINIMUM_COMPLETION_LEAD_MS
    && timing.asyncResultDelayMs + timing.asyncResultLeadMs
      === evidence.handlerDurationMs
  );
  return (
    allEqual(counts, COUNT_KEYS, 1)
    && [
      ordinals.toolUse,
      ordinals.toolResult,
      ordinals.marker,
      ...nativeOrdinals,
    ].every(positiveOrdinal)
    && ordinals.toolUse < ordinals.membershipListed
    && ordinals.toolUse < ordinals.taskStarted
    && ordinals.membershipListed < ordinals.toolResult
    && ordinals.taskStarted < ordinals.toolResult
    && ordinals.toolResult < ordinals.membershipCleared
    && ordinals.toolResult < ordinals.taskCompleted
    && ordinals.membershipCleared < ordinals.taskNotification
    && ordinals.taskCompleted < ordinals.taskNotification
    && ordinals.taskNotification < ordinals.marker
    && membership.listedTaskCount === 1
    && membership.clearedTaskCount === 0
    && allEqual(correlations, CORRELATION_KEYS, true)
    && allEqual(statuses, STATUS_KEYS, true)
    && timingMatches
  );
}

function nativeLifecycleProofMatches(evidence) {
  const proof = evidence.nativeLifecycleProof;
  if (
    !proofHasExactSchema(proof)
    || proof.schemaVersion !== 1
    || proof.expectedMode !== evidence.expectedMode
  ) {
    return false;
  }
  return evidence.expectedMode === 'foreground'
    ? foregroundProofMatches(proof)
    : backgroundProofMatches(proof, evidence);
}

export function isTargetDelayedMcpToolResult(block, targetToolUseId) {
  return (
    block?.type === 'tool_result'
    && typeof targetToolUseId === 'string'
    && targetToolUseId.length > 0
    && block.tool_use_id === targetToolUseId
  );
}

export function evaluateDelayedMcpEvidence(evidence) {
  if (!delayedMcpEvidenceSchemaMatches(evidence)) {
    return {
      pass: false,
      reasons: ['delayed MCP evidence schema is not recognized'],
    };
  }

  const reasons = [];
  if (evidence.handlerDurationMs < evidence.thresholdMs) {
    reasons.push('handler did not remain active beyond the configured threshold');
  }
  if (evidence.toolUseCount !== 1) {
    reasons.push('expected exactly one delayed MCP tool use');
  }
  if (evidence.markerCount !== 1) {
    reasons.push('expected exactly one marker in assistant output');
  }
  if (evidence.resultSubtype !== 'success') {
    reasons.push('query did not end with a successful result');
  }

  if (evidence.expectedMode === 'foreground') {
    if (evidence.toolResultBeforeHandlerCompletion) {
      reasons.push('foreground tool result arrived before the handler completed');
    }
  } else if (!evidence.toolResultBeforeHandlerCompletion) {
    reasons.push('background tool result did not arrive before the handler completed');
  }

  if (!nativeLifecycleProofMatches(evidence)) {
    reasons.push(`native lifecycle proof does not match the ${evidence.expectedMode} contract`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
  };
}

const ALLOWED_RECORD_TYPES = new Set([
  'assistant',
  'rate_limit_event',
  'result',
  'system',
  'user',
]);
const ALLOWED_SYSTEM_SUBTYPES = new Set([
  'hook_response',
  'hook_started',
  'init',
  'task_notification',
  'task_progress',
  'task_started',
  'task_updated',
  'thinking_tokens',
]);
const ALLOWED_ASSISTANT_CONTENT_TYPES = new Set([
  'text',
  'thinking',
  'tool_use',
]);
const ALLOWED_CHILD_USER_CONTENT_TYPES = new Set([
  'text',
  'tool_result',
]);
const COUNT_KEYS = [
  'agentToolUse',
  'auxiliaryToolResult',
  'auxiliaryToolUse',
  'childAssistant',
  'childToolResult',
  'childToolUse',
  'childUser',
  'distinctChildParent',
  'queryResult',
  'targetToolResult',
  'taskNotification',
  'taskProgress',
  'taskStarted',
  'taskUpdated',
];
const CORRELATION_KEYS = [
  'ambientSystemHasNoTaskIdentity',
  'allChildParentsMatchAgent',
  'auxiliaryOperationsOutsideTask',
  'auxiliaryToolResultsFollowUses',
  'auxiliaryToolUseResultsMatchExactly',
  'childToolUseResultsMatchExactly',
  'childToolResultsFollowUses',
  'parentAttributionValid',
  'taskEventsShareTask',
  'taskEventToolUsesMatchAgent',
  'taskProgressWithinBoundary',
  'targetToolResultMatchesAgent',
  'toolUseIdsGloballyDisjoint',
  'topLevelTaskBoundaryClear',
];
const ORDINAL_KEYS = [
  'agentToolUse',
  'finalChildRecord',
  'firstChildRecord',
  'queryResult',
  'targetToolResult',
  'taskNotification',
  'taskStarted',
  'taskUpdated',
];
const STATUS_KEYS = [
  'auxiliaryToolResultsNonError',
  'childToolResultsNonError',
  'notificationCompleted',
  'querySucceeded',
  'targetToolResultNonError',
  'taskUpdateCompleted',
];

function exactKeys(value, keys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...keys].sort())
  );
}

function blocks(message) {
  return Array.isArray(message?.message?.content)
    ? message.message.content
    : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function eventOrdinal(events) {
  return events.length === 1 ? events[0].ordinal : null;
}

function uniqueStrings(values) {
  return new Set(values).size === values.length;
}

function sameStringSet(left, right) {
  return (
    left.length === right.length
    && uniqueStrings(left)
    && uniqueStrings(right)
    && left.every((value) => right.includes(value))
  );
}

function isTopLevel(message) {
  return (
    !Object.hasOwn(message || {}, 'parent_tool_use_id')
    || message.parent_tool_use_id === null
  );
}

function parentAttributionValid(message) {
  return (
    !['assistant', 'user'].includes(message?.type)
    || isTopLevel(message)
    || nonEmptyString(message.parent_tool_use_id)
  );
}

function toolResultsFollowUses(uses, results) {
  if (!sameStringSet(
    uses.map(({ id }) => id),
    results.map(({ block }) => block.tool_use_id),
  )) {
    return false;
  }
  const useOrdinals = new Map(
    uses.map(({ id, ordinal }) => [id, ordinal]),
  );
  return results.every(({ block, ordinal }) => (
    useOrdinals.get(block.tool_use_id) < ordinal
  ));
}

export function createSubagentLifecycleProof(messages) {
  const stream = Array.isArray(messages) ? messages : [];
  const indexed = stream.map((message, index) => ({
    message,
    ordinal: index + 1,
  }));
  const agentToolUses = indexed.flatMap(({ message, ordinal }) => (
    message?.type === 'assistant' && isTopLevel(message)
      ? blocks(message).flatMap((block) => (
        block?.type === 'tool_use' && block.name === 'Agent'
          ? [{ id: block.id, ordinal }]
          : []
      ))
      : []
  ));
  const agentId = agentToolUses.length === 1
    && nonEmptyString(agentToolUses[0].id)
    ? agentToolUses[0].id
    : null;
  const childRecords = indexed.filter(({ message }) => (
    ['assistant', 'user'].includes(message?.type)
    && nonEmptyString(message.parent_tool_use_id)
  ));
  const childParentIds = childRecords.map(
    ({ message }) => message.parent_tool_use_id,
  );
  const childAssistants = childRecords.filter(
    ({ message }) => message.type === 'assistant',
  );
  const childUsers = childRecords.filter(
    ({ message }) => message.type === 'user',
  );
  const childToolUses = childAssistants.flatMap(({ message, ordinal }) => (
    blocks(message).flatMap((block) => (
      block?.type === 'tool_use' && nonEmptyString(block.id)
        ? [{ id: block.id, ordinal }]
        : []
    ))
  ));
  const childToolResults = childUsers.flatMap(({ message, ordinal }) => (
    blocks(message).flatMap((block) => (
      block?.type === 'tool_result' && nonEmptyString(block.tool_use_id)
        ? [{ block, ordinal }]
        : []
    ))
  ));
  const systemEvents = (subtype) => indexed.filter(({ message }) => (
    message?.type === 'system' && message.subtype === subtype
  ));
  const taskStarted = systemEvents('task_started');
  const taskProgress = systemEvents('task_progress');
  const taskUpdated = systemEvents('task_updated');
  const taskNotification = systemEvents('task_notification');
  const taskId = taskStarted.length === 1
    && nonEmptyString(taskStarted[0].message.task_id)
    ? taskStarted[0].message.task_id
    : null;
  const taskEvents = [
    ...taskStarted,
    ...taskProgress,
    ...taskUpdated,
    ...taskNotification,
  ];
  const auxiliaryToolUses = indexed.flatMap(({ message, ordinal }) => (
    message?.type === 'assistant' && isTopLevel(message)
      ? blocks(message).flatMap((block) => (
        block?.type === 'tool_use'
        && block.name !== 'Agent'
        && nonEmptyString(block.id)
          ? [{ id: block.id, ordinal }]
          : []
      ))
      : []
  ));
  const targetToolResults = indexed.flatMap(({ message, ordinal }) => (
    message?.type === 'user' && isTopLevel(message) && agentId
      ? blocks(message).flatMap((block) => (
        block?.type === 'tool_result' && block.tool_use_id === agentId
          ? [{ block, ordinal }]
          : []
      ))
      : []
  ));
  const auxiliaryToolResults = indexed.flatMap(({ message, ordinal }) => (
    message?.type === 'user' && isTopLevel(message)
      ? blocks(message).flatMap((block) => (
        block?.type === 'tool_result'
        && block.tool_use_id !== agentId
        && nonEmptyString(block.tool_use_id)
          ? [{ block, ordinal }]
          : []
      ))
      : []
  ));
  const queryResults = indexed.filter(
    ({ message }) => message?.type === 'result',
  );
  const finalChildOrdinal = childRecords.length > 0
    ? Math.max(...childRecords.map(({ ordinal }) => ordinal))
    : null;
  const firstChildOrdinal = childRecords.length > 0
    ? Math.min(...childRecords.map(({ ordinal }) => ordinal))
    : null;
  const startedOrdinal = eventOrdinal(taskStarted);
  const notificationOrdinal = eventOrdinal(taskNotification);
  const targetResultOrdinal = eventOrdinal(targetToolResults);
  const allUseIds = [
    ...agentToolUses.map(({ id }) => id),
    ...auxiliaryToolUses.map(({ id }) => id),
    ...childToolUses.map(({ id }) => id),
  ];
  const auxiliaryOutsideTask = auxiliaryToolUses.every((use) => {
    const result = auxiliaryToolResults.find(
      ({ block }) => block.tool_use_id === use.id,
    );
    return result && (
      result.ordinal < eventOrdinal(agentToolUses)
      || use.ordinal > targetResultOrdinal
    );
  });
  const topLevelTaskBoundaryClear = (
    Number.isInteger(startedOrdinal)
    && Number.isInteger(notificationOrdinal)
    && indexed
      .filter(({ message }) => (
        ['assistant', 'user'].includes(message?.type)
        && isTopLevel(message)
      ))
      .every(({ ordinal }) => (
        ordinal <= startedOrdinal || ordinal >= notificationOrdinal
      ))
  );
  const taskSubtypes = new Set([
    'task_started',
    'task_progress',
    'task_updated',
    'task_notification',
  ]);
  const ambientSystemHasNoTaskIdentity = indexed
    .filter(({ message }) => (
      message?.type === 'system'
      && !taskSubtypes.has(message.subtype)
    ))
    .every(({ message }) => (
      message.task_id === undefined
      && message.tool_use_id === undefined
    ));

  return {
    schemaVersion: 1,
    counts: {
      agentToolUse: agentToolUses.length,
      auxiliaryToolResult: auxiliaryToolResults.length,
      auxiliaryToolUse: auxiliaryToolUses.length,
      childAssistant: childAssistants.length,
      childToolResult: childToolResults.length,
      childToolUse: childToolUses.length,
      childUser: childUsers.length,
      distinctChildParent: new Set(childParentIds).size,
      queryResult: queryResults.length,
      targetToolResult: targetToolResults.length,
      taskNotification: taskNotification.length,
      taskProgress: taskProgress.length,
      taskStarted: taskStarted.length,
      taskUpdated: taskUpdated.length,
    },
    ordinals: {
      agentToolUse: eventOrdinal(agentToolUses),
      finalChildRecord: finalChildOrdinal,
      firstChildRecord: firstChildOrdinal,
      queryResult: eventOrdinal(queryResults),
      targetToolResult: eventOrdinal(targetToolResults),
      taskNotification: notificationOrdinal,
      taskStarted: startedOrdinal,
      taskUpdated: eventOrdinal(taskUpdated),
    },
    correlations: {
      ambientSystemHasNoTaskIdentity,
      allChildParentsMatchAgent: (
        agentId !== null
        && childParentIds.length > 0
        && childParentIds.every((parentId) => parentId === agentId)
      ),
      auxiliaryOperationsOutsideTask: auxiliaryOutsideTask,
      auxiliaryToolResultsFollowUses: toolResultsFollowUses(
        auxiliaryToolUses,
        auxiliaryToolResults,
      ),
      auxiliaryToolUseResultsMatchExactly: sameStringSet(
        auxiliaryToolUses.map(({ id }) => id),
        auxiliaryToolResults.map(({ block }) => block.tool_use_id),
      ),
      childToolUseResultsMatchExactly: sameStringSet(
        childToolUses.map(({ id }) => id),
        childToolResults.map(({ block }) => block.tool_use_id),
      ),
      childToolResultsFollowUses: toolResultsFollowUses(
        childToolUses,
        childToolResults,
      ),
      parentAttributionValid: indexed.every(
        ({ message }) => parentAttributionValid(message),
      ),
      taskEventsShareTask: (
        taskId !== null
        && taskEvents.length > 0
        && taskEvents.every(
          ({ message }) => message.task_id === taskId,
        )
      ),
      taskEventToolUsesMatchAgent: (
        agentId !== null
        && taskStarted.length === 1
        && taskStarted[0].message.tool_use_id === agentId
        && taskNotification.length === 1
        && taskNotification[0].message.tool_use_id === agentId
        && taskEvents.every(({ message }) => (
          message.tool_use_id === undefined
          || message.tool_use_id === agentId
        ))
      ),
      taskProgressWithinBoundary: (
        Number.isInteger(startedOrdinal)
        && Number.isInteger(notificationOrdinal)
        && taskProgress.every(({ ordinal }) => (
          ordinal > startedOrdinal && ordinal < notificationOrdinal
        ))
      ),
      targetToolResultMatchesAgent: (
        agentId !== null
        && targetToolResults.length === 1
      ),
      toolUseIdsGloballyDisjoint: (
        allUseIds.every(nonEmptyString)
        && uniqueStrings(allUseIds)
      ),
      topLevelTaskBoundaryClear,
    },
    statuses: {
      auxiliaryToolResultsNonError: auxiliaryToolResults.every(
        ({ block }) => (
          block.is_error === undefined || block.is_error === false
        ),
      ),
      childToolResultsNonError: (
        childToolResults.length > 0
        && childToolResults.every(({ block }) => (
          block.is_error === undefined || block.is_error === false
        ))
      ),
      notificationCompleted: (
        taskNotification.length === 1
        && taskNotification[0].message.status === 'completed'
      ),
      querySucceeded: (
        queryResults.length === 1
        && queryResults[0].message.subtype === 'success'
      ),
      targetToolResultNonError: (
        targetToolResults.length === 1
        && (
          targetToolResults[0].block.is_error === undefined
          || targetToolResults[0].block.is_error === false
        )
      ),
      taskUpdateCompleted: taskUpdated.length === 0
        ? null
        : (
            taskUpdated.length === 1
            && taskUpdated[0].message.patch?.status === 'completed'
          ),
    },
  };
}

function normalizedLifecycleMatches(evidence, proof) {
  const lifecycle = evidence?.lifecycle;
  if (!Array.isArray(lifecycle) || lifecycle.length === 0) return false;
  if (lifecycle.some((record) => (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || !ALLOWED_RECORD_TYPES.has(record.type)
  ))) {
    return false;
  }
  const systemRecords = lifecycle.filter(
    (record) => record.type === 'system',
  );
  if (systemRecords.some(
    (record) => !ALLOWED_SYSTEM_SUBTYPES.has(record.subtype),
  )) {
    return false;
  }
  const assistantRecords = lifecycle.filter(
    (record) => record.type === 'assistant',
  );
  if (assistantRecords.some((record) => (
    typeof record.hasParent !== 'boolean'
    || !Array.isArray(record.contentTypes)
    || !Array.isArray(record.toolNames)
    || record.contentTypes.some(
      (contentType) => !ALLOWED_ASSISTANT_CONTENT_TYPES.has(contentType),
    )
  ))) {
    return false;
  }
  const userRecords = lifecycle.filter((record) => record.type === 'user');
  if (userRecords.some((record) => (
    typeof record.hasParent !== 'boolean'
    || record.contentKind !== 'blocks'
    || !Array.isArray(record.contentTypes)
    || record.contentTypes.some((contentType) => (
      record.hasParent
        ? !ALLOWED_CHILD_USER_CONTENT_TYPES.has(contentType)
        : contentType !== 'tool_result'
    ))
  ))) {
    return false;
  }
  const initRecords = systemRecords.filter(
    (record) => record.subtype === 'init',
  );
  const taskCount = (subtype) => systemRecords.filter(
    (record) => record.subtype === subtype,
  ).length;
  const agentRecords = assistantRecords.filter(
    (record) => record.toolNames.includes('Agent'),
  );
  const auxiliaryToolUseCount = assistantRecords
    .filter((record) => !record.hasParent)
    .reduce((count, record) => (
      count + record.toolNames.filter((name) => name !== 'Agent').length
    ), 0);
  const childAssistants = assistantRecords.filter(
    (record) => record.hasParent,
  );
  const childUsers = userRecords.filter((record) => record.hasParent);
  const childToolUseCount = childAssistants.reduce(
    (count, record) => count + record.toolNames.length,
    0,
  );
  const childToolResultCount = childUsers.reduce(
    (count, record) => (
      count
      + record.contentTypes.filter((type) => type === 'tool_result').length
    ),
    0,
  );
  const topLevelToolResultCount = userRecords
    .filter((record) => !record.hasParent)
    .reduce((count, record) => (
      count
      + record.contentTypes.filter((type) => type === 'tool_result').length
    ), 0);
  const resultRecords = lifecycle.filter(
    (record) => record.type === 'result',
  );
  return (
    initRecords.length === 1
    && initRecords[0].model === evidence.resolvedModel
    && agentRecords.length === 1
    && agentRecords[0].hasParent === false
    && auxiliaryToolUseCount === proof.counts.auxiliaryToolUse
    && topLevelToolResultCount === (
      proof.counts.auxiliaryToolResult + proof.counts.targetToolResult
    )
    && taskCount('task_started') === proof.counts.taskStarted
    && taskCount('task_progress') === proof.counts.taskProgress
    && taskCount('task_updated') === proof.counts.taskUpdated
    && taskCount('task_notification') === proof.counts.taskNotification
    && childAssistants.length === proof.counts.childAssistant
    && childUsers.length === proof.counts.childUser
    && childToolUseCount === proof.counts.childToolUse
    && childToolResultCount === proof.counts.childToolResult
    && resultRecords.length === proof.counts.queryResult
    && resultRecords.length === 1
    && resultRecords[0].subtype === 'success'
    && lifecycle.at(-1) === resultRecords[0]
  );
}

export function subagentLifecycleProofSchemaMatches(proof) {
  return (
    exactKeys(proof, [
      'correlations',
      'counts',
      'ordinals',
      'schemaVersion',
      'statuses',
    ])
    && proof.schemaVersion === 1
    && exactKeys(proof.counts, COUNT_KEYS)
    && COUNT_KEYS.every(
      (key) => Number.isInteger(proof.counts[key]) && proof.counts[key] >= 0,
    )
    && exactKeys(proof.correlations, CORRELATION_KEYS)
    && CORRELATION_KEYS.every(
      (key) => typeof proof.correlations[key] === 'boolean',
    )
    && exactKeys(proof.ordinals, ORDINAL_KEYS)
    && ORDINAL_KEYS.every((key) => (
      proof.ordinals[key] === null
      || (
        Number.isInteger(proof.ordinals[key])
        && proof.ordinals[key] > 0
      )
    ))
    && exactKeys(proof.statuses, STATUS_KEYS)
    && STATUS_KEYS.every((key) => (
      typeof proof.statuses[key] === 'boolean'
      || (
        key === 'taskUpdateCompleted'
        && proof.statuses[key] === null
      )
    ))
  );
}

export function evaluateSubagentEvidence(evidence, { isCandidate }) {
  if (typeof isCandidate !== 'boolean') {
    throw new TypeError('isCandidate must be a boolean');
  }
  const proof = evidence?.subagentLifecycleProof;
  const reasons = [];
  if (!subagentLifecycleProofSchemaMatches(proof)) {
    reasons.push('subagent lifecycle proof schema is not recognized');
    return { pass: false, reasons };
  }
  const expectedTaskUpdated = isCandidate ? 1 : 0;
  const expectedTaskUpdateCompleted = isCandidate ? true : null;
  if (
    !nonEmptyString(evidence.resolvedModel)
    || evidence.resultSubtype !== 'success'
    || evidence.reasonCount !== 0
    || !Number.isInteger(evidence.subagentMessages)
    || evidence.subagentMessages !== proof.counts.childAssistant
    || !Number.isInteger(evidence.distinctParentCount)
    || evidence.distinctParentCount !== proof.counts.distinctChildParent
  ) {
    reasons.push('subagent summary does not match a successful attributed run');
  }
  if (
    proof.counts.agentToolUse !== 1
    || proof.counts.auxiliaryToolResult
      !== proof.counts.auxiliaryToolUse
    || proof.counts.childAssistant < 1
    || proof.counts.childUser < 1
    || proof.counts.childToolUse < 1
    || proof.counts.childToolResult !== proof.counts.childToolUse
    || proof.counts.distinctChildParent !== 1
    || proof.counts.taskStarted !== 1
    || proof.counts.taskUpdated !== expectedTaskUpdated
    || proof.counts.taskNotification !== 1
    || proof.counts.targetToolResult !== 1
    || proof.counts.queryResult !== 1
  ) {
    reasons.push('subagent lifecycle counts do not match the bounded task');
  }
  if (
    CORRELATION_KEYS.some((key) => proof.correlations[key] !== true)
    || STATUS_KEYS.some((key) => (
      proof.statuses[key] !== (
        key === 'taskUpdateCompleted'
          ? expectedTaskUpdateCompleted
          : true
      )
    ))
  ) {
    reasons.push('subagent lifecycle identity or completion proof failed');
  }
  const {
    agentToolUse,
    finalChildRecord,
    firstChildRecord,
    queryResult,
    targetToolResult,
    taskNotification,
    taskStarted,
    taskUpdated,
  } = proof.ordinals;
  const ordered = (
    [agentToolUse, taskStarted, firstChildRecord, finalChildRecord,
      taskNotification,
      targetToolResult, queryResult]
      .every((ordinal) => Number.isInteger(ordinal) && ordinal > 0)
    && agentToolUse < taskStarted
    && taskStarted < firstChildRecord
    && firstChildRecord <= finalChildRecord
    && finalChildRecord < taskNotification
    && taskNotification < targetToolResult
    && targetToolResult < queryResult
    && (
      isCandidate
        ? (
            Number.isInteger(taskUpdated)
            && finalChildRecord < taskUpdated
            && taskUpdated < taskNotification
          )
        : taskUpdated === null
    )
  );
  if (!ordered) {
    reasons.push('subagent lifecycle order does not match the task contract');
  }
  if (!normalizedLifecycleMatches(evidence, proof)) {
    reasons.push('normalized subagent lifecycle is not recognized');
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}

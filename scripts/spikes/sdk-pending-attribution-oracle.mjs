export function evaluatePendingAttribution({ actualPermissionMode, failure, taskCount, notificationCount, followupsQueued, rawResults, completions, tasks = [], requireEmptyWitness = true }) {
  const directTasks = tasks.filter(task => typeof task.taskId === 'string' && task.taskId && task.notified);
  const reportTask = result => directTasks.find(task => (result.originKind === 'peer' ? result.senderTaskId === task.taskId
      : result.originKind === 'task-notification' && typeof task.runId === 'string' && task.runId && result.originRunId === task.runId));
  const report = result => result.subtype === 'success' && !result.isError && reportTask(result);
  const stableReport = result => report(result) && result.before.some(id => id === 2 || id === 3)
    && JSON.stringify(result.before) === JSON.stringify(result.after);
  const reportWitness = directTasks.length === 2 && new Set(directTasks.map(task => task.taskId)).size === 2
    && new Set(rawResults.filter(report).map(result => reportTask(result).taskId)).size === 2;
  const reportOverlapWitness = rawResults.some(stableReport);
  const emptyWitness = rawResults.some(result => result.originKind === 'task-notification' && stableReport(result) && result.numTurns === 0 && !result.textPresent && result.notificationCount >= 2);
  const correct = (completion) => !completion.error && !completion.resultIsError && !completion.rejected
    && [1, 2, 3].includes(completion.sourceMsgId) && completion.markerMatches.length === 3
    && completion.markerMatches.every((match, i) => match === (i === completion.sourceMsgId - 1));
  const attributionCorrect = completions.length === 3 && new Set(completions.map((completion) => completion.sourceMsgId)).size === 3 && completions.every(correct);
  const wrongCompletion = completions.some((completion) => !completion.rejected && !completion.error && !completion.resultIsError && !correct(completion));
  const providerError = rawResults.some((result) => result.isError || result.subtype !== 'success');
  const status = actualPermissionMode !== 'auto' ? 'INCONCLUSIVE' : wrongCompletion
    ? 'FAIL' : !providerError && !failure && followupsQueued && taskCount === 2 && notificationCount === 2 && reportWitness && reportOverlapWitness && (!requireEmptyWitness || emptyWitness) && attributionCorrect
      ? 'PASS' : 'INCONCLUSIVE';
  return { status, emptyWitness, reportWitness, reportOverlapWitness, attributionCorrect, providerError, wrongCompletion };
}


export function foregroundFixtureSleep(input) {
  if (input?.tool_name !== 'Bash' || !/^sleep (20|22|30)$/.test(input.tool_input?.command || '')) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: {
    ...input.tool_input, timeout: 60000, run_in_background: false,
  } } };
}


export function pendingAttributionFollowupReady({ message, actualPermissionMode, firstUserCompleted, pendingCount, taskCount }) {
  return actualPermissionMode === 'auto' && firstUserCompleted === true && pendingCount === 0 && taskCount === 2
    && message.type === 'assistant' && message.parent_tool_use_id == null;
}

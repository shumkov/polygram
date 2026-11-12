export function evaluatePendingAttribution({ actualPermissionMode, failure, taskCount, notificationCount, followupsQueued, rawResults, completions }) {
  const emptyWitness = rawResults.some((result) => result.subtype === 'success' && !result.isError && result.numTurns === 0 && !result.textPresent && result.before.some((id) => id === 2 || id === 3) && JSON.stringify(result.before) === JSON.stringify(result.after) && result.notificationCount >= 2);
  const correct = (completion) => !completion.error && !completion.resultIsError && !completion.rejected
    && [1, 2, 3].includes(completion.sourceMsgId) && completion.markerMatches.length === 3
    && completion.markerMatches.every((match, i) => match === (i === completion.sourceMsgId - 1));
  const attributionCorrect = completions.length === 3 && new Set(completions.map((completion) => completion.sourceMsgId)).size === 3 && completions.every(correct);
  const wrongCompletion = completions.some((completion) => !completion.rejected && !completion.error && !completion.resultIsError && !correct(completion));
  const providerError = rawResults.some((result) => result.isError || result.subtype !== 'success');
  const status = actualPermissionMode !== 'auto' ? 'INCONCLUSIVE' : wrongCompletion
    ? 'FAIL' : !providerError && !failure && followupsQueued && taskCount >= 2 && notificationCount >= 2 && emptyWitness && attributionCorrect
      ? 'PASS' : 'INCONCLUSIVE';
  return { status, emptyWitness, attributionCorrect, providerError, wrongCompletion };
}

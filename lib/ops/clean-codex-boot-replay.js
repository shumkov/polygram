'use strict';

function scheduleCleanCodexReplaySessions({
  candidates = [],
  getSessionKey,
  getContinuationTasks,
  coordinator,
  recover,
  trackTask,
  onOutcome = () => {},
} = {}) {
  if (
    !Array.isArray(candidates)
    || typeof getSessionKey !== 'function'
    || typeof getContinuationTasks !== 'function'
    || typeof coordinator?.schedule !== 'function'
    || typeof recover !== 'function'
    || typeof trackTask !== 'function'
    || typeof onOutcome !== 'function'
  ) {
    throw new TypeError('clean Codex boot replay dependencies are invalid');
  }

  const candidatesBySession = new Map();
  for (const candidate of candidates) {
    const sessionKey = getSessionKey(candidate);
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
      throw new TypeError('clean Codex boot replay candidate has no session');
    }
    const sessionCandidates = candidatesBySession.get(sessionKey) || [];
    sessionCandidates.push(candidate);
    candidatesBySession.set(sessionKey, sessionCandidates);
  }

  let scheduled = 0;
  for (const [sessionKey, followers] of candidatesBySession) {
    const task = coordinator.schedule({
      sessionKey,
      continuationTasks: getContinuationTasks(sessionKey),
      followers,
      recover,
    }).then((outcome) => {
      onOutcome({ sessionKey, outcome });
      return outcome;
    });
    scheduled += followers.length;
    trackTask(task);
  }

  return {
    scheduled,
    sessions: candidatesBySession.size,
  };
}

module.exports = { scheduleCleanCodexReplaySessions };

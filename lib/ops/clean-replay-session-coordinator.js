'use strict';

function createCleanReplaySessionCoordinator() {
  const sessions = new Map();

  function wait(sessionKey, receipt = null) {
    const state = sessions.get(sessionKey);
    if (!state || (receipt !== null && receipt === state.receipt)) {
      return Promise.resolve();
    }
    return state.barrier;
  }

  function schedule({
    sessionKey,
    continuationTasks = [],
    followers = [],
    recover,
  } = {}) {
    if (
      typeof sessionKey !== 'string'
      || sessionKey.length === 0
      || !Array.isArray(continuationTasks)
      || !Array.isArray(followers)
      || typeof recover !== 'function'
      || sessions.has(sessionKey)
    ) {
      throw new TypeError('clean replay session schedule is invalid');
    }

    let release;
    const state = {
      receipt: null,
      barrier: new Promise((resolve) => { release = resolve; }),
    };
    sessions.set(sessionKey, state);

    const task = Promise.resolve().then(async () => {
      let admitted = 0;
      let terminal = 0;
      try {
        const continuationResults = await Promise.allSettled(continuationTasks);
        if (continuationResults.some((result) => (
          result.status !== 'fulfilled'
          || result.value?.status !== 'replied'
        ))) {
          return {
            status: 'deferred',
            admitted,
            terminal,
            deferred: followers.length,
            reason: 'continuation-not-replied',
          };
        }

        for (let index = 0; index < followers.length; index += 1) {
          const receipt = Object.freeze({});
          state.receipt = receipt;
          let result;
          try {
            // eslint-disable-next-line no-await-in-loop
            result = await recover(followers[index], { receipt });
          } catch (error) {
            result = {
              status: 'failed',
              reason: error?.code || 'recovery-failed',
            };
          } finally {
            state.receipt = null;
          }
          if (result?.status === 'dispatched') {
            admitted += 1;
            continue;
          }
          if (result?.status === 'gate-terminal') {
            terminal += 1;
            continue;
          }
          return {
            status: 'deferred',
            admitted,
            terminal,
            deferred: followers.length - index,
            reason: result?.reason || 'recovery-not-dispatched',
          };
        }
        return {
          status: 'complete',
          admitted,
          terminal,
          deferred: 0,
          reason: null,
        };
      } finally {
        if (sessions.get(sessionKey) === state) sessions.delete(sessionKey);
        release();
      }
    });

    return task;
  }

  return Object.freeze({ wait, schedule });
}

module.exports = { createCleanReplaySessionCoordinator };

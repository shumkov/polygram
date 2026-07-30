'use strict';

const DELIVERY_CLASSES = new Set(['reply-bearing', 'operational-ui']);

function deliveryBarrierError() {
  const error = new Error('reply-bearing Telegram delivery is fenced');
  error.code = 'DELIVERY_FENCED';
  return error;
}

function createDeliveryBarrier() {
  let fenced = false;
  const outputSourcesBySession = new Map();
  const uncorrelatedOutput = new Set();
  const pending = new Set();
  const pendingBySession = new Map();
  const forgetWhenIdle = new Set();

  function forget(sessionKey) {
    outputSourcesBySession.delete(sessionKey);
    uncorrelatedOutput.delete(sessionKey);
    forgetWhenIdle.delete(sessionKey);
  }

  function inspect(sessionKey, sourceMsgId = null) {
    const outputSources = outputSourcesBySession.get(sessionKey);
    return {
      outputAttempted: uncorrelatedOutput.has(sessionKey)
        || (
          sourceMsgId == null
            ? (outputSources?.size ?? 0) > 0
            : outputSources?.has(sourceMsgId) === true
        ),
      pending: pendingBySession.get(sessionKey)?.size ?? 0,
      fenced,
    };
  }

  function run({
    sessionKey = null,
    sourceMsgId = null,
    deliveryClass,
  } = {}, operation) {
    if (!DELIVERY_CLASSES.has(deliveryClass)) {
      return Promise.reject(new TypeError('Telegram delivery class is invalid'));
    }
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('Telegram delivery operation is required'));
    }
    if (deliveryClass === 'operational-ui') {
      return Promise.resolve().then(operation);
    }
    if (fenced) return Promise.reject(deliveryBarrierError());

    if (sessionKey != null) {
      forgetWhenIdle.delete(sessionKey);
      if (sourceMsgId == null) uncorrelatedOutput.add(sessionKey);
      else {
        let outputSources = outputSourcesBySession.get(sessionKey);
        if (!outputSources) {
          outputSources = new Set();
          outputSourcesBySession.set(sessionKey, outputSources);
        }
        outputSources.add(sourceMsgId);
      }
    }
    const operationPromise = Promise.resolve().then(operation);
    pending.add(operationPromise);
    if (sessionKey != null) {
      let sessionPending = pendingBySession.get(sessionKey);
      if (!sessionPending) {
        sessionPending = new Set();
        pendingBySession.set(sessionKey, sessionPending);
      }
      sessionPending.add(operationPromise);
    }
    operationPromise.finally(() => {
      pending.delete(operationPromise);
      if (sessionKey == null) return;
      const sessionPending = pendingBySession.get(sessionKey);
      sessionPending?.delete(operationPromise);
      if (sessionPending?.size === 0) {
        pendingBySession.delete(sessionKey);
        if (forgetWhenIdle.has(sessionKey)) forget(sessionKey);
      }
    }).catch(() => {});
    return operationPromise;
  }

  async function fenceAndDrain() {
    fenced = true;
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
    return {
      pending: 0,
    };
  }

  function retireSession(sessionKey) {
    if ((pendingBySession.get(sessionKey)?.size ?? 0) > 0) {
      forgetWhenIdle.add(sessionKey);
      return;
    }
    forget(sessionKey);
  }

  return {
    run,
    inspect,
    fenceAndDrain,
    retireSession,
    isFenced: () => fenced,
  };
}

module.exports = { createDeliveryBarrier };

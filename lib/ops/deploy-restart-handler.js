'use strict';

const {
  requireRestartRequestId,
} = require('../ipc/restart-request-id');
const {
  normalizeDeployQualificationExpectation,
} = require('./clean-restart-qualification');
const {
  normalizeDeployForegroundExpectation,
} = require('./foreground-canary-target');

function createDeployRestartHandler({
  getIsShuttingDown,
  getPid,
  foregroundCanaryAuthorizer,
  logEvent,
  shutdown,
  logger = console,
} = {}) {
  if (typeof getIsShuttingDown !== 'function') {
    throw new TypeError('deploy restart shutdown-state reader is required');
  }
  if (typeof getPid !== 'function') {
    throw new TypeError('deploy restart PID reader is required');
  }
  if (typeof logEvent !== 'function') {
    throw new TypeError('deploy restart event logger is required');
  }
  if (typeof shutdown !== 'function') {
    throw new TypeError('deploy restart shutdown function is required');
  }

  function rejected(oldPid, restartRequestId, rejectionCode) {
    return {
      accepted: false,
      old_pid: oldPid,
      restart_request_id: restartRequestId,
      rejection_code: rejectionCode,
    };
  }

  return function requestDeployRestart(request) {
    const oldPid = getPid();
    let restartRequestId;
    try {
      restartRequestId = requireRestartRequestId(request?.id);
    } catch {
      return rejected(oldPid, null, 'invalid-request');
    }
    if (getIsShuttingDown()) {
      return rejected(oldPid, restartRequestId, 'shutdown-in-progress');
    }

    const qualificationExpectation = normalizeDeployQualificationExpectation(request);
    const foregroundExpectation = normalizeDeployForegroundExpectation(request);
    if (qualificationExpectation === null || foregroundExpectation === null) {
      return rejected(oldPid, restartRequestId, 'invalid-request');
    }

    if (foregroundExpectation !== undefined) {
      if (typeof foregroundCanaryAuthorizer?.authorizeRestart !== 'function') {
        return rejected(oldPid, restartRequestId, 'target-unavailable');
      }
      const authorization = foregroundCanaryAuthorizer.authorizeRestart({
        requestId: restartRequestId,
        expectation: foregroundExpectation,
      });
      if (!authorization?.accepted) {
        return rejected(
          oldPid,
          restartRequestId,
          authorization?.rejectionCode || 'target-unavailable',
        );
      }
      logEvent(
        'foreground-canary-target-authorized',
        authorization.authorizationEvent,
      );
    }

    shutdown({
      continuationAuthorized: true,
      trigger: 'deploy-ipc',
      restartRequestId,
      qualificationExpectation,
    }).catch((error) => {
      logger.error?.(`[shutdown] deploy restart failed: ${error.message}`);
    });
    return {
      accepted: true,
      old_pid: oldPid,
      restart_request_id: restartRequestId,
    };
  };
}

module.exports = { createDeployRestartHandler };

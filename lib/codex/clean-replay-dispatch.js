'use strict';

function changedProcessError() {
  const error = new Error(
    'Clean Codex replay no longer owns the process that rearmed its input',
  );
  error.code = 'CODEX_CLEAN_REPLAY_PROCESS_CHANGED';
  return error;
}

function authorizeCleanReplayDispatch({
  sessionKey,
  currentProcess,
  expectedProcess,
  reservation,
  controller,
} = {}) {
  const generationId = reservation?.generationId;
  const reservationId = reservation?.reservationId;
  if (
    typeof sessionKey !== 'string'
    || sessionKey.length === 0
    || currentProcess !== expectedProcess
    || !currentProcess
    || currentProcess.closed === true
    || (currentProcess.runtime ?? currentProcess.backend) !== 'codex'
    || !['Active', 'Idle', 'StartingTurn'].includes(currentProcess.state)
    || typeof generationId !== 'string'
    || generationId.length === 0
    || currentProcess.generationId !== generationId
    || typeof reservationId !== 'string'
    || reservationId.length === 0
    || typeof controller?.markDispatchDisposition !== 'function'
  ) {
    throw changedProcessError();
  }

  controller.markDispatchDisposition({
    sessionKey,
    generationId,
    reservationId,
    disposition: 'queue-authorized',
  });
  return Object.freeze({
    reservationId,
    generationId,
    state: 'queue-authorized',
  });
}

module.exports = { authorizeCleanReplayDispatch };

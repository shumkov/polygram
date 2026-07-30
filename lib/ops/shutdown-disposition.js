'use strict';

function shutdownReasonFor(observation) {
  if (observation?.detected === true) return 'cgroup-oom-kill';
  if (observation?.status === 'unchanged') return 'no-oom-delta';
  if (observation?.status === 'unsupported') return 'oom-observer-unsupported';
  return 'oom-observer-unavailable';
}

/**
 * Persist the replay state associated with a handled shutdown signal.
 *
 * Keeping this decision outside the signal handler makes the shutdown
 * classification independently testable while the caller retains ownership of
 * draining processes and emitting telemetry.
 */
function persistShutdownDisposition({
  db,
  botName,
  now = Date.now(),
  since,
  observation,
  resumeIntents = [],
  forceCrashReason = null,
} = {}) {
  const oomDetected = observation?.detected === true;
  const crashLike = oomDetected || forceCrashReason != null;
  const result = crashLike
    ? db.recordCrashShutdown({ botName, now, since })
    : db.recordCleanShutdown({
      botName,
      now,
      since,
      resumeIntents,
    });
  return {
    clean: !crashLike,
    shutdownReason: forceCrashReason || shutdownReasonFor(observation),
    replayMarked: result?.replayMarked ?? 0,
    ...(!crashLike ? { intentsRecorded: result?.intentsRecorded ?? 0 } : {}),
    ...(oomDetected ? { oomKillDelta: String(observation.delta) } : {}),
  };
}

module.exports = { persistShutdownDisposition };

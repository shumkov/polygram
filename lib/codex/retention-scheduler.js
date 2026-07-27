'use strict';

const DEFAULT_INTERVAL_MS = 24 * 3_600_000;

function scheduleCodexRetention({
  db,
  logEvent,
  logger = console,
  intervalMs = DEFAULT_INTERVAL_MS,
  scheduleImmediate = setImmediate,
  scheduleInterval = setInterval,
} = {}) {
  if (
    typeof db?.pruneCodexOperationalData !== 'function'
    || typeof logEvent !== 'function'
    || !Number.isSafeInteger(intervalMs)
    || intervalMs <= 0
    || typeof scheduleImmediate !== 'function'
    || typeof scheduleInterval !== 'function'
  ) {
    throw new TypeError('Codex retention scheduler dependencies are invalid');
  }

  const run = (trigger) => {
    try {
      const result = db.pruneCodexOperationalData();
      const deletedAttempts = result?.deletedAttempts ?? 0;
      const deletedGenerations = result?.deletedGenerations ?? 0;
      if (deletedAttempts > 0 || deletedGenerations > 0) {
        logger.log?.(
          `[codex-retention] pruned ${deletedAttempts} attempts and `
            + `${deletedGenerations} generations (${trigger})`,
        );
        logEvent('codex-operational-data-pruned', {
          trigger,
          deleted_attempts: deletedAttempts,
          deleted_generations: deletedGenerations,
        });
      }
      return result;
    } catch (error) {
      logger.error?.(
        `[codex-retention] prune failed (${trigger}): `
          + `${error?.code || error?.name || 'unknown'}`,
      );
      return null;
    }
  };

  scheduleImmediate(() => run('boot'));
  const interval = scheduleInterval(() => run('interval'), intervalMs);
  interval?.unref?.();
  return { run, interval };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  scheduleCodexRetention,
};

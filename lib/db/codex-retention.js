'use strict';

const DAY_MS = 86_400_000;
const SETTLED_RETENTION_MS = 30 * DAY_MS;
const AMBIGUOUS_RETENTION_MS = 90 * DAY_MS;

function pruneCodexOperationalData(rawDb, {
  now = Date.now(),
  settledRetentionMs = SETTLED_RETENTION_MS,
  ambiguousRetentionMs = AMBIGUOUS_RETENTION_MS,
} = {}) {
  for (const [value, label] of [
    [now, 'now'],
    [settledRetentionMs, 'settledRetentionMs'],
    [ambiguousRetentionMs, 'ambiguousRetentionMs'],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Codex retention ${label} must be a non-negative integer`);
    }
  }
  if (ambiguousRetentionMs < settledRetentionMs) {
    throw new TypeError(
      'Codex ambiguous retention cannot be shorter than settled retention',
    );
  }

  return rawDb.transaction(() => {
    const settledCutoff = now - settledRetentionMs;
    const ambiguousCutoff = now - ambiguousRetentionMs;
    const attempts = rawDb.prepare(`
      DELETE FROM codex_turn_attempts
       WHERE (
         (
           recovery_state = 'settled'
           AND settled_ts IS NOT NULL
           AND settled_ts < @settledCutoff
         )
         OR
         (
           recovery_state = 'ambiguous'
           AND ambiguous_ts IS NOT NULL
           AND ambiguous_ts < @ambiguousCutoff
           AND EXISTS (
             SELECT 1
               FROM codex_attempt_reconciliations r
              WHERE r.attempt_id = codex_turn_attempts.attempt_id
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM codex_daemon_lease lease
          WHERE lease.generation_id = codex_turn_attempts.generation_id
            AND lease.status IN ('active', 'quarantined')
       )
       AND NOT EXISTS (
         SELECT 1
           FROM codex_linked_inputs linked
          WHERE (
            linked.attempt_id = codex_turn_attempts.attempt_id
            OR linked.target_attempt_id = codex_turn_attempts.attempt_id
          )
            AND linked.state = 'linked'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM codex_retry_reservations retry
          WHERE (
            retry.original_attempt_id = codex_turn_attempts.attempt_id
            OR retry.retry_attempt_id = codex_turn_attempts.attempt_id
          )
            AND retry.state != 'retired'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM codex_generations generation
          WHERE generation.generation_id = codex_turn_attempts.generation_id
            AND generation.state = 'containment-failed'
            AND NOT EXISTS (
              SELECT 1
                FROM codex_reboot_releases release
               WHERE release.stable_host_id = generation.stable_host_id
                 AND release.incident_boot_session_id =
                     generation.boot_session_id
            )
       )
    `).run({ settledCutoff, ambiguousCutoff });

    const generations = rawDb.prepare(`
      DELETE FROM codex_generations
       WHERE (
           (
             state IN ('healthy-stopped', 'retired')
             AND settled_ts IS NOT NULL
             AND settled_ts < @settledCutoff
           )
           OR
           (
             state = 'created'
             AND updated_ts < @ambiguousCutoff
           )
           OR
           (
             state = 'containment-failed'
             AND updated_ts < @ambiguousCutoff
             AND EXISTS (
               SELECT 1
                 FROM codex_reboot_releases release
                WHERE release.stable_host_id = codex_generations.stable_host_id
                  AND release.incident_boot_session_id =
                      codex_generations.boot_session_id
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM codex_turn_attempts attempt
            WHERE attempt.generation_id = codex_generations.generation_id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM codex_daemon_lease lease
            WHERE lease.generation_id = codex_generations.generation_id
              AND lease.status IN ('active', 'quarantined')
         )
    `).run({ settledCutoff, ambiguousCutoff });
    return {
      deletedAttempts: attempts.changes,
      deletedGenerations: generations.changes,
    };
  })();
}

module.exports = {
  DAY_MS,
  SETTLED_RETENTION_MS,
  AMBIGUOUS_RETENTION_MS,
  pruneCodexOperationalData,
};

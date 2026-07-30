'use strict';

const {
  settleCodexFailedGeneration,
} = require('./codex-failed-generation');
const {
  codexError,
  requiredString,
} = require('./codex-input');
const {
  CODEX_APP_SERVER_NAMESPACE,
} = require('./sessions');

function listRecoveryAttempts(rawDb) {
  const replayableAttemptIds = rawDb.prepare(`
    SELECT attempt_id
      FROM codex_turn_attempts
     WHERE delivery_state = 'prepared'
       AND recovery_state = 'prepared'
     ORDER BY created_ts, attempt_id
  `).all().map((row) => row.attempt_id);
  const unresolvedAttemptIds = rawDb.prepare(`
    SELECT attempt.attempt_id
      FROM codex_turn_attempts attempt
     WHERE attempt.delivery_state != 'prepared'
       AND attempt.recovery_state NOT IN ('settled', 'cancelled')
     ORDER BY attempt.created_ts, attempt.attempt_id
  `).all().map((row) => row.attempt_id);
  return {
    replayableAttemptIds,
    unresolvedAttemptIds,
  };
}

function publicRecoveryAttempts(attempts) {
  return {
    replayableAttemptIds: attempts.replayableAttemptIds,
    unresolvedAttemptIds: attempts.unresolvedAttemptIds,
  };
}

const RETRY_SAFE_GENERATION_STATES = new Set([
  'healthy-stopped',
  'containment-failed',
  'durability-blocked',
  'retired',
]);

function listUnresolvedCodexAttempts(rawDb, input = {}) {
  const sessionKey = input?.session_key == null
    ? null
    : requiredString(input.session_key, 'session key');
  return rawDb.prepare(`
    WITH unresolved AS (
      SELECT attempt.attempt_id,
             attempt.generation_id,
             attempt.session_key,
             attempt.method,
             attempt.telegram_source_message_id,
             attempt.ambiguous_ts,
             generation.state AS generation_state
        FROM codex_turn_attempts attempt
        JOIN codex_generations generation
          ON generation.generation_id = attempt.generation_id
       WHERE attempt.recovery_state = 'ambiguous'
         AND NOT EXISTS (
           SELECT 1
             FROM codex_attempt_reconciliations reconciliation
            WHERE reconciliation.attempt_id = attempt.attempt_id
         )
         AND (? IS NULL OR attempt.session_key = ?)
    ),
    candidate_locations AS (
      SELECT unresolved.attempt_id,
             reservation.bot_name,
             reservation.telegram_chat_id,
             reservation.telegram_message_id,
             0 AS source_priority,
             reservation.created_ts AS located_ts
        FROM unresolved
        JOIN codex_dispatch_reservations reservation
          ON reservation.steer_attempt_id = unresolved.attempt_id
          OR (
            reservation.target_attempt_id = unresolved.attempt_id
            AND reservation.telegram_message_id
              = unresolved.telegram_source_message_id
          )
      UNION ALL
      SELECT unresolved.attempt_id,
             selection.bot_name,
             selection.telegram_chat_id,
             selection.telegram_message_id,
             1 AS source_priority,
             selection.selected_ts AS located_ts
        FROM unresolved
        JOIN inbound_runtime_selections selection
          ON selection.session_key = unresolved.session_key
         AND selection.provider = 'codex'
         AND selection.telegram_message_id
           = unresolved.telegram_source_message_id
    ),
    ranked_locations AS (
      SELECT candidate_locations.*,
             ROW_NUMBER() OVER (
               PARTITION BY candidate_locations.attempt_id
               ORDER BY candidate_locations.source_priority,
                        candidate_locations.located_ts,
                        candidate_locations.bot_name
             ) AS location_rank
        FROM candidate_locations
    )
    SELECT unresolved.attempt_id,
           unresolved.generation_id,
           unresolved.session_key,
           unresolved.method,
           unresolved.telegram_source_message_id,
           unresolved.ambiguous_ts,
           unresolved.generation_state,
           location.bot_name,
           location.telegram_chat_id,
           COALESCE(
             location.telegram_message_id,
             unresolved.telegram_source_message_id
           ) AS telegram_message_id,
           message.user_id AS owner_user_id,
           message.user AS owner_user,
           CASE
             WHEN unresolved.generation_state = 'containment-failed'
              AND EXISTS (
                SELECT 1
                  FROM codex_attempt_checkpoints checkpoint
                 WHERE checkpoint.generation_id = unresolved.generation_id
                   AND checkpoint.kind = 'containment-cleanup-completed'
              )
               THEN 'failed-settled'
             WHEN unresolved.generation_state = 'containment-failed'
               THEN 'cleanup-unverified'
             ELSE unresolved.generation_state
           END AS containment_status,
           generation.containment_reason AS quarantine_reason
      FROM unresolved
      JOIN codex_generations generation
        ON generation.generation_id = unresolved.generation_id
      LEFT JOIN ranked_locations location
        ON location.attempt_id = unresolved.attempt_id
       AND location.location_rank = 1
      LEFT JOIN messages message
        ON message.direction = 'in'
       AND message.bot_name = location.bot_name
       AND message.chat_id = location.telegram_chat_id
       AND CAST(message.msg_id AS TEXT) = COALESCE(
         location.telegram_message_id,
         unresolved.telegram_source_message_id
       )
     WHERE COALESCE(
       location.telegram_message_id,
       unresolved.telegram_source_message_id
     ) IS NOT NULL
     ORDER BY unresolved.ambiguous_ts,
              unresolved.attempt_id
  `).all(sessionKey, sessionKey);
}

function reconcileCodexAttempt(rawDb, input) {
  const attemptId = requiredString(input?.attempt_id, 'attempt ID');
  const disposition = input?.disposition;
  if (!['incorporated', 'retry-authorized', 'dismissed'].includes(disposition)) {
    throw codexError(
      'Codex reconciliation disposition is invalid',
      'CODEX_RECONCILIATION_INVALID',
    );
  }
  const actor = requiredString(input?.actor, 'reconciliation actor');
  const reason = requiredString(input?.reason, 'reconciliation reason');
  const decidedTs = input?.ts ?? Date.now();
  if (!Number.isSafeInteger(decidedTs) || decidedTs < 0) {
    throw codexError(
      'Codex reconciliation timestamp is invalid',
      'CODEX_RECONCILIATION_INVALID',
    );
  }
  let retryAttemptId = null;
  if (disposition === 'retry-authorized') {
    if (input?.duplicate_risk_acknowledged !== true) {
      throw codexError(
        'Codex retry requires an acknowledged duplicate-risk warning',
        'CODEX_DUPLICATE_RISK_NOT_ACKNOWLEDGED',
      );
    }
    retryAttemptId = requiredString(input?.retry_attempt_id, 'retry attempt ID');
    if (retryAttemptId === attemptId) {
      throw codexError(
        'Codex retry must reserve a distinct attempt ID',
        'CODEX_RECONCILIATION_INVALID',
      );
    }
  } else if (input?.retry_attempt_id != null) {
    throw codexError(
      'Codex retry attempt ID is valid only for retry authorization',
      'CODEX_RECONCILIATION_INVALID',
    );
  }

  return rawDb.transaction(() => {
    const attempt = rawDb.prepare(`
      SELECT attempt.attempt_id,
             attempt.recovery_state,
             generation.state AS generation_state
        FROM codex_turn_attempts attempt
        JOIN codex_generations generation
          ON generation.generation_id = attempt.generation_id
       WHERE attempt.attempt_id = ?
    `).get(attemptId);
    if (!attempt) {
      throw codexError(
        'Codex reconciliation attempt does not exist',
        'CODEX_ATTEMPT_NOT_FOUND',
      );
    }
    if (attempt.recovery_state !== 'ambiguous') {
      throw codexError(
        'Codex reconciliation requires an ambiguous original attempt',
        'CODEX_ATTEMPT_NOT_AMBIGUOUS',
      );
    }
    if (rawDb.prepare(`
      SELECT 1 FROM codex_attempt_reconciliations WHERE attempt_id = ?
    `).get(attemptId)) {
      throw codexError(
        'Codex attempt already has a terminal reconciliation',
        'CODEX_ATTEMPT_ALREADY_RECONCILED',
      );
    }
    if (
      retryAttemptId
      && !RETRY_SAFE_GENERATION_STATES.has(attempt.generation_state)
    ) {
      throw codexError(
        'Codex retry authorization requires the prior generation to be terminal or dead',
        'CODEX_RETRY_GENERATION_NOT_TERMINAL',
      );
    }

    rawDb.prepare(`
      INSERT INTO codex_attempt_reconciliations (
        attempt_id, disposition, actor, reason, decided_ts
      ) VALUES (?, ?, ?, ?, ?)
    `).run(attemptId, disposition, actor, reason, decidedTs);
    if (retryAttemptId) {
      rawDb.prepare(`
        INSERT INTO codex_retry_reservations (
          original_attempt_id, retry_attempt_id, state, reserved_ts
        ) VALUES (?, ?, 'reserved', ?)
      `).run(attemptId, retryAttemptId, decidedTs);
    }
    return {
      attemptId,
      disposition,
      retryAttemptId,
      decidedTs,
    };
  })();
}

function reconstructCodexRecoveryState(rawDb, input) {
  let stableHostId;
  let bootSessionId;
  try {
    stableHostId = requiredString(input?.stable_host_id, 'stable host identity');
    bootSessionId = requiredString(input?.boot_session_id, 'boot-session identity');
  } catch {
    return {
      status: 'integrity-blocked',
      reason: 'current-identity-invalid',
      containmentReleased: false,
      replayableAttemptIds: [],
      unresolvedAttemptIds: [],
    };
  }
  const now = input?.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw codexError(
      'Codex reconstruction timestamp is invalid',
      'CODEX_PERSISTENCE_INPUT_INVALID',
    );
  }

  const attempts = listRecoveryAttempts(rawDb);
  const identity = rawDb.prepare(`
      SELECT stable_host_id, last_boot_session_id
        FROM codex_runtime_identity
       WHERE singleton = 1
  `).get();
  const lease = rawDb.prepare(`
      SELECT * FROM codex_daemon_lease WHERE singleton = 1
  `).get();
  const generations = rawDb.prepare(`
      SELECT COUNT(*) AS count FROM codex_generations
  `).get().count;
  const hasOperationalState = Boolean(generations || lease);

  if (!identity) {
    if (!hasOperationalState) {
      rawDb.prepare(`
          INSERT INTO codex_runtime_identity (
            singleton, stable_host_id, last_boot_session_id,
            established_ts, updated_ts
          ) VALUES (1, ?, ?, ?, ?)
      `).run(stableHostId, bootSessionId, now, now);
      return {
        status: 'clear',
        reason: null,
        containmentReleased: false,
        ...publicRecoveryAttempts(attempts),
      };
    }
    return {
      status: 'integrity-blocked',
      reason: 'persisted-identity-missing',
      containmentReleased: false,
      ...publicRecoveryAttempts(attempts),
    };
  }

  if (
    typeof identity.stable_host_id !== 'string'
    || identity.stable_host_id.length === 0
    || typeof identity.last_boot_session_id !== 'string'
    || identity.last_boot_session_id.length === 0
  ) {
    return {
      status: 'integrity-blocked',
      reason: 'persisted-identity-corrupt',
      containmentReleased: false,
      ...publicRecoveryAttempts(attempts),
    };
  }
  if (identity.stable_host_id !== stableHostId) {
    return {
      status: 'integrity-blocked',
      reason: 'stable-host-mismatch',
      containmentReleased: false,
      ...publicRecoveryAttempts(attempts),
    };
  }

  if (!lease || lease.status === 'clear') {
    if (
      lease
      && (
        lease.generation_id != null
        || lease.stable_host_id !== stableHostId
      )
    ) {
      return {
        status: 'integrity-blocked',
        reason: 'persisted-lease-inconsistent',
        containmentReleased: false,
        ...publicRecoveryAttempts(attempts),
      };
    }
    if (identity.last_boot_session_id !== bootSessionId) {
      rawDb.prepare(`
        UPDATE codex_runtime_identity
           SET last_boot_session_id = ?, updated_ts = ?
         WHERE singleton = 1
           AND stable_host_id = ?
           AND last_boot_session_id = ?
      `).run(
        bootSessionId,
        now,
        stableHostId,
        identity.last_boot_session_id,
      );
      if (lease) {
        rawDb.prepare(`
          UPDATE codex_daemon_lease
             SET stable_host_id = ?,
                 boot_session_id = ?,
                 updated_ts = ?
           WHERE singleton = 1
             AND status = 'clear'
        `).run(stableHostId, bootSessionId, now);
      }
    }
    return {
      status: 'clear',
      reason: null,
      containmentReleased: false,
      ...publicRecoveryAttempts(attempts),
    };
  }

  if (!['active', 'quarantined'].includes(lease.status)) {
    return {
      status: 'integrity-blocked',
      reason: 'persisted-lease-inconsistent',
      containmentReleased: false,
      ...publicRecoveryAttempts(attempts),
    };
  }
  const generation = rawDb.prepare(`
    SELECT * FROM codex_generations WHERE generation_id = ?
  `).get(lease.generation_id);
  if (
    !generation
    || generation.stable_host_id !== stableHostId
    || generation.boot_session_id !== identity.last_boot_session_id
    || lease.stable_host_id !== generation.stable_host_id
    || lease.boot_session_id !== generation.boot_session_id
    || !['active', 'containment-failed'].includes(generation.state)
  ) {
    return {
      status: 'integrity-blocked',
      reason: 'persisted-generation-inconsistent',
      containmentReleased: false,
      ...publicRecoveryAttempts(attempts),
    };
  }
  if (
    input?.startup_recovery?.exclusive_daemon_ownership !== true
    || input?.startup_recovery?.supervisor_grace_elapsed !== true
  ) {
    return {
      status: 'recovery-blocked',
      reason: 'exclusive-startup-recovery-unproven',
      containmentReleased: false,
      ...publicRecoveryAttempts(attempts),
    };
  }

  const provider = rawDb.prepare(`
    SELECT provider, provider_session_id, app_server_session_id
      FROM agent_runtime_sessions
     WHERE session_key = ?
       AND namespace = ?
  `).get(generation.session_key, CODEX_APP_SERVER_NAMESPACE);
  const providerSessionId = generation.thread_id ?? null;
  const appServerSessionId = generation.app_server_session_id ?? null;
  if (
    provider
    && (
      provider.provider !== 'codex'
      || provider.provider_session_id !== providerSessionId
      || provider.app_server_session_id !== appServerSessionId
    )
  ) {
    return {
      status: 'integrity-blocked',
      reason: 'persisted-generation-inconsistent',
      containmentReleased: false,
      ...publicRecoveryAttempts(attempts),
    };
  }
  settleCodexFailedGeneration(rawDb, {
    generation_id: generation.generation_id,
    session_key: generation.session_key,
    stable_host_id: stableHostId,
    incident_boot_session_id: generation.boot_session_id,
    current_boot_session_id: bootSessionId,
    provider_session_id: providerSessionId,
    app_server_session_id: appServerSessionId,
    reason: generation.containment_reason
      ?? lease.quarantine_reason
      ?? 'startup-recovered-generation',
    source: 'exclusive-takeover-grace',
    allow_missing_generation: false,
    ts: now,
  });
  return {
    status: 'clear',
    reason: null,
    containmentReleased: true,
    ...publicRecoveryAttempts(listRecoveryAttempts(rawDb)),
  };
}

function reconstructCodexRecovery(rawDb, input) {
  return rawDb.transaction(
    () => reconstructCodexRecoveryState(rawDb, input),
  )();
}

module.exports = {
  listUnresolvedCodexAttempts,
  reconcileCodexAttempt,
  reconstructCodexRecovery,
};

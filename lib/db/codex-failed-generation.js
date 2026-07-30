'use strict';

const {
  codexError,
  requiredString,
} = require('./codex-input');
const {
  CODEX_APP_SERVER_NAMESPACE,
} = require('./sessions');
const SETTLEMENT_SOURCES = new Set([
  'managed-group-empty',
  'exclusive-takeover-grace',
]);

function optionalString(value, label) {
  if (value == null) return null;
  return requiredString(value, label);
}

function requiredTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw codexError(
      'Codex failed-generation settlement timestamp is invalid',
      'CODEX_PERSISTENCE_INPUT_INVALID',
    );
  }
  return value;
}

function conflict(message) {
  throw codexError(message, 'CODEX_FAILED_GENERATION_SETTLEMENT_CONFLICT');
}

function readCleanup(rawDb, generationId) {
  return rawDb.prepare(`
    SELECT 1
      FROM codex_attempt_checkpoints
     WHERE generation_id = ?
       AND kind = 'containment-cleanup-completed'
     LIMIT 1
  `).get(generationId);
}

function settleCodexFailedGeneration(rawDb, input) {
  const generationId = requiredString(input?.generation_id, 'generation ID');
  const sessionKey = requiredString(input?.session_key, 'session key');
  const stableHostId = requiredString(
    input?.stable_host_id,
    'stable host identity',
  );
  const incidentBootSessionId = requiredString(
    input?.incident_boot_session_id,
    'incident boot-session identity',
  );
  const currentBootSessionId = requiredString(
    input?.current_boot_session_id,
    'current boot-session identity',
  );
  const providerSessionId = optionalString(
    input?.provider_session_id,
    'provider session ID',
  );
  const appServerSessionId = optionalString(
    input?.app_server_session_id,
    'app-server session ID',
  );
  const reason = requiredString(input?.reason, 'containment reason');
  const source = input?.source;
  if (!SETTLEMENT_SOURCES.has(source)) {
    throw codexError(
      'Codex failed-generation settlement source is invalid',
      'CODEX_PERSISTENCE_INPUT_INVALID',
    );
  }
  const allowMissingGeneration = input?.allow_missing_generation === true;
  if (allowMissingGeneration && source !== 'managed-group-empty') {
    throw codexError(
      'Only managed cleanup can settle a non-durable generation',
      'CODEX_PERSISTENCE_INPUT_INVALID',
    );
  }
  const ts = requiredTimestamp(input?.ts ?? Date.now());

  return rawDb.transaction(() => {
    let generation = rawDb.prepare(`
      SELECT * FROM codex_generations WHERE generation_id = ?
    `).get(generationId);

    if (generation && readCleanup(rawDb, generationId)) {
      if (
        generation.session_key !== sessionKey
        || generation.stable_host_id !== stableHostId
        || generation.boot_session_id !== incidentBootSessionId
      ) {
        conflict('Codex cleanup marker belongs to another generation owner');
      }
      return {
        committed: true,
        disposition: 'failed-settled',
        generationId,
      };
    }

    const identity = rawDb.prepare(`
      SELECT stable_host_id, last_boot_session_id
        FROM codex_runtime_identity
       WHERE singleton = 1
    `).get();
    if (
      !identity
      || identity.stable_host_id !== stableHostId
      || identity.last_boot_session_id !== incidentBootSessionId
    ) {
      conflict('Codex runtime identity does not match the failed generation');
    }

    const lease = rawDb.prepare(`
      SELECT * FROM codex_daemon_lease WHERE singleton = 1
    `).get();

    if (!generation) {
      if (!allowMissingGeneration) {
        conflict('Codex failed generation is not durable');
      }
      if (lease && lease.status !== 'clear') {
        conflict('Another Codex generation owns the daemon lease');
      }
      const conflictingGeneration = rawDb.prepare(`
        SELECT generation_id
          FROM codex_generations
         WHERE session_key = ?
           AND settled_ts IS NULL
           AND state IN ('created', 'active', 'containment-failed',
                         'durability-blocked')
         LIMIT 1
      `).get(sessionKey);
      if (conflictingGeneration) {
        conflict('Another Codex generation owns the failed session');
      }
      rawDb.prepare(`
        INSERT INTO codex_generations (
          generation_id, session_key, thread_id, app_server_session_id,
          stable_host_id, boot_session_id, state, containment_reason,
          created_ts, updated_ts, settled_ts
        ) VALUES (?, ?, ?, ?, ?, ?, 'containment-failed', ?, ?, ?, ?)
      `).run(
        generationId,
        sessionKey,
        providerSessionId,
        appServerSessionId,
        stableHostId,
        incidentBootSessionId,
        reason,
        ts,
        ts,
        ts,
      );
      generation = rawDb.prepare(`
        SELECT * FROM codex_generations WHERE generation_id = ?
      `).get(generationId);
    } else {
      if (
        generation.session_key !== sessionKey
        || generation.stable_host_id !== stableHostId
        || generation.boot_session_id !== incidentBootSessionId
        || (
          generation.state !== 'containment-failed'
          && !(
            [
              'exclusive-takeover-grace',
              'managed-group-empty',
            ].includes(source)
            && generation.state === 'active'
          )
        )
        || (
          generation.thread_id != null
          && generation.thread_id !== providerSessionId
        )
        || (
          generation.app_server_session_id != null
          && generation.app_server_session_id !== appServerSessionId
        )
      ) {
        conflict('Codex failed generation identity is inconsistent');
      }
      if (
        !lease
        || !['active', 'quarantined'].includes(lease.status)
        || lease.generation_id !== generationId
        || lease.stable_host_id !== stableHostId
        || lease.boot_session_id !== incidentBootSessionId
      ) {
        conflict('Codex daemon lease does not belong to the failed generation');
      }
      rawDb.prepare(`
        UPDATE codex_generations
           SET state = 'containment-failed',
               thread_id = COALESCE(thread_id, ?),
               app_server_session_id = COALESCE(app_server_session_id, ?),
               containment_reason = COALESCE(containment_reason, ?),
               updated_ts = ?,
               settled_ts = COALESCE(settled_ts, ?)
         WHERE generation_id = ?
      `).run(
        providerSessionId,
        appServerSessionId,
        reason,
        ts,
        ts,
        generationId,
      );
    }

    const provider = rawDb.prepare(`
      SELECT provider, provider_session_id, app_server_session_id,
             generation_id
        FROM agent_runtime_sessions
       WHERE session_key = ?
         AND namespace = ?
    `).get(sessionKey, CODEX_APP_SERVER_NAMESPACE);
    if (provider) {
      if (
        provider.provider !== 'codex'
        || providerSessionId == null
        || provider.provider_session_id !== providerSessionId
        || provider.app_server_session_id !== appServerSessionId
      ) {
        conflict('Codex provider session does not match the failed generation');
      }
      const deleted = rawDb.prepare(`
        DELETE FROM agent_runtime_sessions
         WHERE session_key = ?
           AND namespace = ?
           AND provider = 'codex'
           AND provider_session_id = ?
           AND app_server_session_id IS ?
           AND generation_id IS ?
      `).run(
        sessionKey,
        CODEX_APP_SERVER_NAMESPACE,
        providerSessionId,
        appServerSessionId,
        provider.generation_id,
      );
      if (deleted.changes !== 1) {
        conflict('Codex provider session changed during settlement');
      }
    }

    rawDb.prepare(`
      UPDATE codex_turn_attempts
         SET recovery_state = 'cancelled',
             terminal_status = COALESCE(terminal_status, 'failed'),
             updated_ts = ?,
             settled_ts = COALESCE(settled_ts, ?)
       WHERE generation_id = ?
         AND delivery_state = 'prepared'
         AND recovery_state NOT IN ('settled', 'cancelled')
    `).run(ts, ts, generationId);
    rawDb.prepare(`
      UPDATE codex_turn_attempts
         SET recovery_state = 'ambiguous',
             updated_ts = ?,
             settled_ts = NULL,
             ambiguous_ts = COALESCE(ambiguous_ts, ?)
       WHERE generation_id = ?
         AND delivery_state != 'prepared'
         AND recovery_state NOT IN ('settled', 'cancelled')
    `).run(ts, ts, generationId);

    const selectedAttempts = rawDb.prepare(`
      SELECT session_key, telegram_source_message_id, recovery_state
        FROM codex_turn_attempts
       WHERE generation_id = ?
         AND telegram_source_message_id IS NOT NULL
         AND (
           recovery_state = 'ambiguous'
           OR (recovery_state = 'cancelled' AND settled_ts = ?)
         )
    `).all(generationId, ts);
    for (const attempt of selectedAttempts) {
      const locations = rawDb.prepare(`
        SELECT selection.bot_name,
               selection.telegram_chat_id,
               selection.telegram_message_id,
               message.handler_status
          FROM inbound_runtime_selections selection
          LEFT JOIN messages message
            ON message.direction = 'in'
           AND message.bot_name = selection.bot_name
           AND message.chat_id = selection.telegram_chat_id
           AND CAST(message.msg_id AS TEXT) =
               selection.telegram_message_id
         WHERE selection.session_key = ?
           AND selection.provider = 'codex'
           AND selection.telegram_message_id = ?
      `).all(
        attempt.session_key,
        attempt.telegram_source_message_id,
      );
      if (locations.length !== 1 || locations[0].handler_status == null) {
        conflict('Codex attempt has no unique inbound selection binding');
      }
      const location = locations[0];
      const handlerStatus = attempt.recovery_state === 'ambiguous'
        ? 'codex-ambiguous'
        : 'failed';
      if (location.handler_status === handlerStatus) continue;
      if (![
        'received',
        'dispatched',
        'processing',
        'replay-pending',
      ].includes(location.handler_status)) {
        conflict('Codex attempt inbound selection is already terminal');
      }
      const updated = rawDb.prepare(`
        UPDATE messages
           SET handler_status = ?
         WHERE direction = 'in'
           AND bot_name = ?
           AND chat_id = ?
           AND CAST(msg_id AS TEXT) = ?
           AND handler_status = ?
      `).run(
        handlerStatus,
        location.bot_name,
        location.telegram_chat_id,
        location.telegram_message_id,
        location.handler_status,
      );
      if (updated.changes !== 1) {
        conflict('Codex attempt inbound selection changed during settlement');
      }
    }

    rawDb.prepare(`
      UPDATE codex_dispatch_reservations
         SET state = CASE
               WHEN state = 'steer-accepted'
                 OR EXISTS (
                   SELECT 1
                     FROM codex_turn_attempts attempt
                    WHERE attempt.attempt_id IN (
                      codex_dispatch_reservations.steer_attempt_id,
                      codex_dispatch_reservations.target_attempt_id
                    )
                      AND attempt.recovery_state = 'ambiguous'
                 )
                 THEN 'ambiguous'
               ELSE 'cancelled'
             END,
             updated_ts = ?,
             settled_ts = CASE
               WHEN state = 'steer-accepted'
                 OR EXISTS (
                   SELECT 1
                     FROM codex_turn_attempts attempt
                    WHERE attempt.attempt_id IN (
                      codex_dispatch_reservations.steer_attempt_id,
                      codex_dispatch_reservations.target_attempt_id
                    )
                      AND attempt.recovery_state = 'ambiguous'
                 )
                 THEN NULL
               ELSE ?
             END
       WHERE generation_id = ?
         AND state IN ('reserved', 'steer-accepted', 'queue-authorized')
    `).run(ts, ts, generationId);

    rawDb.prepare(`
      UPDATE codex_linked_inputs
         SET state = CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM codex_turn_attempts attempt
                  WHERE attempt.attempt_id IN (
                    codex_linked_inputs.attempt_id,
                    codex_linked_inputs.target_attempt_id
                  )
                    AND attempt.recovery_state = 'ambiguous'
               )
                 THEN 'ambiguous'
               ELSE 'failed'
             END,
             settled_ts = ?
       WHERE generation_id = ?
         AND state = 'linked'
    `).run(ts, generationId);

    rawDb.prepare(`
      UPDATE messages
         SET handler_status = CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM codex_dispatch_reservations reservation
                  WHERE reservation.generation_id = ?
                    AND reservation.state = 'ambiguous'
                    AND reservation.bot_name = messages.bot_name
                    AND reservation.telegram_chat_id = messages.chat_id
                    AND reservation.telegram_message_id =
                        CAST(messages.msg_id AS TEXT)
               )
                 THEN 'codex-ambiguous'
               ELSE 'failed'
             END
       WHERE direction = 'in'
         AND handler_status IN (
           'received', 'dispatched', 'processing', 'replay-pending'
         )
         AND EXISTS (
           SELECT 1
             FROM codex_dispatch_reservations reservation
            WHERE reservation.generation_id = ?
              AND reservation.bot_name = messages.bot_name
              AND reservation.telegram_chat_id = messages.chat_id
              AND reservation.telegram_message_id =
                  CAST(messages.msg_id AS TEXT)
         )
    `).run(generationId, generationId);

    rawDb.prepare(`
      INSERT INTO codex_attempt_checkpoints (
        generation_id, kind, thread_id, detail_json, ts
      ) VALUES (?, 'containment-cleanup-completed', ?, ?, ?)
    `).run(
      generationId,
      providerSessionId,
      JSON.stringify({ source, reason }),
      ts,
    );

    if (lease && lease.status !== 'clear') {
      const released = rawDb.prepare(`
        UPDATE codex_daemon_lease
           SET generation_id = NULL,
               stable_host_id = ?,
               boot_session_id = ?,
               status = 'clear',
               quarantine_reason = NULL,
               updated_ts = ?,
               released_ts = ?
         WHERE singleton = 1
           AND generation_id = ?
           AND stable_host_id = ?
           AND boot_session_id = ?
           AND status IN ('active', 'quarantined')
      `).run(
        stableHostId,
        currentBootSessionId,
        ts,
        ts,
        generationId,
        stableHostId,
        incidentBootSessionId,
      );
      if (released.changes !== 1) {
        conflict('Codex daemon lease changed during settlement');
      }
    }

    const identityUpdated = rawDb.prepare(`
      UPDATE codex_runtime_identity
         SET last_boot_session_id = ?, updated_ts = ?
       WHERE singleton = 1
         AND stable_host_id = ?
         AND last_boot_session_id = ?
    `).run(
      currentBootSessionId,
      ts,
      stableHostId,
      incidentBootSessionId,
    );
    if (identityUpdated.changes !== 1) {
      conflict('Codex runtime identity changed during settlement');
    }

    return {
      committed: true,
      disposition: 'failed-settled',
      generationId,
    };
  })();
}

module.exports = {
  settleCodexFailedGeneration,
};

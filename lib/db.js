/**
 * Bridge DB client. Wraps better-sqlite3 with the ops polygram + skill need.
 * Synchronous (better-sqlite3). DB errors are caught by callers so polygram
 * never drops messages because of transcript failures.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  pruneCodexOperationalData,
} = require('./db/codex-retention');
const {
  listUnresolvedCodexAttempts,
  reconcileCodexAttempt,
  reconstructCodexRecovery,
} = require('./db/codex-reconciliation');
const {
  settleCodexFailedGeneration,
} = require('./db/codex-failed-generation');
const {
  codexError,
  requiredString: requiredCodexString,
} = require('./db/codex-input');
const {
  sanitizeCodexFaultProvenance,
} = require('./codex/fault-provenance');
const {
  sanitizeForDurableWrite,
  sanitizeDurableStructured,
  sanitizeDurableJsonText,
} = require('./secret-detect');
const {
  enforceEventDetailSchema,
} = require('./db/event-detail-schema');

// Pre-write secret boundary. Every durable text sink below routes its text
// through this so a recognized credential never reaches a row, the
// external-content FTS index that mirrors it, a persisted error, or telemetry.
// The caller's own value is untouched: the live provider turn always sees the
// original message. Detection is deterministic shape/keyword matching, so
// prose that never declares a credential is not covered here — the sweep and
// the agent-reported redaction remain the defense-in-depth behind it.
const durableText = (value) => (
  typeof value === 'string' ? sanitizeForDurableWrite(value).text : value
);

// Truncating a masked text can cut a placeholder in half, leaving a fragment
// like `‹redacted:kv-sec` that reads as ordinary text and no longer survives
// a second masking pass unchanged. Cut before the placeholder that straddles
// the limit instead.
const truncateAfterMask = (text, limit) => {
  if (typeof text !== 'string' || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const open = cut.lastIndexOf('‹');
  if (open !== -1 && cut.indexOf('›', open) === -1) return cut.slice(0, open);
  return cut;
};

// A JSON-valued column is sanitized as STRUCTURE, not as text: masking a
// serialized document can splice across its delimiters, and an escaped quote
// hides a declared value from the detector. Callers usually hand over an
// object; a string is parsed back so a caller that pre-serialized still gets
// the structural pass. Text that is not JSON falls back to string masking.
const durableJson = (value) => {
  if (value == null) return value;
  if (typeof value !== 'string') return JSON.stringify(sanitizeDurableStructured(value));
  return sanitizeDurableJsonText(value).text;
};

// 0.8.0 Phase 1: bumped from 9 → 10. Adds migration
// 010-tool-use-id.sql (pending_approvals.tool_use_id column for the
// SDK canUseTool stable per-call ID + chat_tool_decisions table for
// "always allow / always deny" persistence under the new in-process
// approval flow).
//
// 0.7.8 (history): bumped from 8 → 9 to fix a regression where 0.7.6
// added migration 009-turn-metrics.sql but forgot to bump
// SCHEMA_VERSION; the early-return on line ~42 then skipped the
// migration loop on any DB already at user_version=8 → turn_metrics
// table never created → INSERT prepare at startup crashed polygram.
//
// 0.14: bumped from 12 → 13. Adds migration 013-clean-shutdown-marker.sql
// (polling_state.clean_shutdown_at). Same footgun as the 8→9 note: forgetting
// the bump skips the migration on any DB already at user_version=12.
//
// 0.15: bumped 13 → 14. Adds migration 014-secret-redactions.sql
// (secret_redactions audit table + messages.secret_scanned_at).
const SCHEMA_VERSION = 20;

// Sentinel `error` value for outbound rows whose API call may or may not
// have reached Telegram. markStalePending writes it; hasOutboundReplyTo
// reads it to dedupe boot replay against possibly-delivered messages.
// Constant rather than inline literal so a typo can't silently break the
// invariant ("AND error = 'crashedmidsend'" → no rows match → duplicate
// reply on boot).
const CRASHED_MID_SEND = 'crashed-mid-send';

const CLAUDE_INLINE_NAMESPACE = 'claude:inline';
const CLAUDE_CHANNELS_NAMESPACE = 'claude:channels';
const CODEX_APP_SERVER_NAMESPACE = 'codex:app-server';
const PROVIDER_NAMESPACES = new Set([
  CLAUDE_INLINE_NAMESPACE,
  CLAUDE_CHANNELS_NAMESPACE,
  CODEX_APP_SERVER_NAMESPACE,
]);

function claudeNamespaceForStoredBackend(backend) {
  return backend === 'cli' || backend === 'channels'
    ? CLAUDE_CHANNELS_NAMESPACE
    : CLAUDE_INLINE_NAMESPACE;
}

function requiredTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw codexError(
      `Codex ${label} must be a non-negative safe integer`,
      'CODEX_PERSISTENCE_INPUT_INVALID',
    );
  }
  return value;
}

function optionalCodexString(value, label) {
  if (value == null) return null;
  return requiredCodexString(String(value), label);
}

function optionalCodexRequestId(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return `string:${requiredCodexString(value, 'request ID')}`;
  }
  if (Number.isSafeInteger(value)) {
    return `number:${value}`;
  }
  throw codexError(
    'Codex request ID must be a bounded string or safe integer',
    'CODEX_PERSISTENCE_INPUT_INVALID',
  );
}

function assertExactKeys(row, allowed, code, label) {
  for (const key of Object.keys(row ?? {})) {
    if (!allowed.has(key)) {
      throw codexError(
        `Codex ${label} rejected field ${key}`,
        code,
      );
    }
  }
}

function configChangeValue(value, { nullable, label }) {
  if (value == null) {
    if (nullable) return null;
    const error = new TypeError(`config change ${label} is required`);
    error.code = 'CONFIG_CHANGE_VALUE_INVALID';
    throw error;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const error = new TypeError(
    `config change ${label} must be a string, boolean, or finite number`,
  );
  error.code = 'CONFIG_CHANGE_VALUE_INVALID';
  throw error;
}

function open(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  runMigrations(db, path.join(__dirname, '..', 'migrations'));
  return wrap(db);
}

function runMigrations(db, migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const currentPre = db.pragma('user_version', { simple: true });
  if (currentPre >= SCHEMA_VERSION) return;

  for (const file of files) {
    const n = parseInt(file.slice(0, 3), 10);
    if (Number.isNaN(n)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Concurrent-boot safety: BEGIN IMMEDIATE acquires the write lock
    // up-front; the second migrator blocks on busy_timeout (5s) then
    // re-reads user_version inside the txn for check-and-set semantics.
    // The prepared-statement-against-old-schema hazard is mitigated by
    // polygram's per-bot DB layout (one process per DB file, see
    // scripts/split-db.js), so there is no other long-lived reader on
    // the same DB during a migration in normal operation.
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read inside the transaction so we skip anything another process
      // just committed (check-and-set semantics).
      const current = db.pragma('user_version', { simple: true });
      if (n <= current) {
        db.exec('COMMIT');
        continue;
      }
      console.log(`[db] applying migration ${file}`);
      db.exec(sql);
      db.pragma(`user_version = ${n}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
}

function wrap(db) {
  // 0.6.1: attachments_json column dropped (migration 008). All attachment
  // data lives in the per-attachment table now (see attachments stmts below).
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (
      chat_id, thread_id, msg_id, user, user_id, text, reply_to_id,
      direction, source, bot_name, session_id,
      model, effort, turn_id, status, error, cost_usd, ts
    ) VALUES (
      @chat_id, @thread_id, @msg_id, @user, @user_id, @text, @reply_to_id,
      @direction, @source, @bot_name, @session_id,
      @model, @effort, @turn_id, @status, @error, @cost_usd, @ts
    )
    ON CONFLICT(chat_id, msg_id) DO UPDATE SET
      text = excluded.text,
      edited_ts = excluded.ts
  `);

  const insertOutboundPendingStmt = db.prepare(`
    INSERT INTO messages (
      chat_id, thread_id, user, text, direction, source, bot_name,
      turn_id, session_id, status, ts, msg_id, reply_to_id
    ) VALUES (
      @chat_id, @thread_id, @user, @text, 'out', @source, @bot_name,
      @turn_id, @session_id, 'pending', @ts, @pending_id, @reply_to_id
    )
  `);

  const markOutboundSentStmt = db.prepare(`
    UPDATE messages SET msg_id = @msg_id, status = 'sent', ts = @ts
    WHERE id = @id
  `);

  const markOutboundFailedStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = @error
    WHERE id = @id
  `);

  // A streamed reply's row is written by the INITIAL send — the first ~30
  // characters of the answer. Every later edit goes straight to Telegram and
  // never revisits the row, so the transcript kept a torso where the chat shows
  // the whole answer. This brings the row up to the finalized body.
  const updateOutboundTextStmt = db.prepare(`
    UPDATE messages SET text = @text, edited_ts = @ts
    WHERE chat_id = @chat_id AND msg_id = @msg_id AND direction = 'out'
  `);

  const upsertSessionStmt = db.prepare(`
    INSERT INTO sessions (
      session_key, chat_id, thread_id, claude_session_id,
      agent, cwd, model, effort, pm_backend, created_ts, last_active_ts
    ) VALUES (
      @session_key, @chat_id, @thread_id, @claude_session_id,
      @agent, @cwd, @model, @effort, @pm_backend, @ts, @ts
    )
    ON CONFLICT(session_key) DO UPDATE SET
      chat_id = excluded.chat_id,
      thread_id = excluded.thread_id,
      claude_session_id = excluded.claude_session_id,
      agent = excluded.agent,
      cwd = excluded.cwd,
      model = excluded.model,
      effort = excluded.effort,
      pm_backend = excluded.pm_backend,
      last_active_ts = excluded.last_active_ts
  `);

  const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE session_key = ?`);
  const touchSessionStmt = db.prepare(`UPDATE sessions SET last_active_ts = ? WHERE session_key = ?`);
  const clearSessionIdStmt = db.prepare(`DELETE FROM sessions WHERE session_key = ?`);
  const setSessionBackendStmt = db.prepare(`UPDATE sessions SET pm_backend = ? WHERE session_key = ?`);

  const upsertProviderSessionStmt = db.prepare(`
    INSERT INTO agent_runtime_sessions (
      session_key, namespace, provider, provider_session_id,
      app_server_session_id, agent, cwd, model, effort, pm_backend,
      created_ts, last_active_ts, generation_id, spawn_profile_id
    ) VALUES (
      @session_key, @namespace, @provider, @provider_session_id,
      @app_server_session_id, @agent, @cwd, @model, @effort, @pm_backend,
      @ts, @ts, @generation_id, @spawn_profile_id
    )
    ON CONFLICT(session_key, namespace) DO UPDATE SET
      provider = excluded.provider,
      provider_session_id = excluded.provider_session_id,
      app_server_session_id = excluded.app_server_session_id,
      agent = excluded.agent,
      cwd = excluded.cwd,
      model = excluded.model,
      effort = excluded.effort,
      pm_backend = excluded.pm_backend,
      spawn_profile_id = excluded.spawn_profile_id,
      last_active_ts = excluded.last_active_ts,
      generation_id = CASE
        WHEN agent_runtime_sessions.provider_session_id = excluded.provider_session_id
             AND agent_runtime_sessions.provider = excluded.provider
             AND (
               excluded.provider = 'claude'
               OR (
                 agent_runtime_sessions.cwd IS excluded.cwd
                 AND agent_runtime_sessions.model IS excluded.model
                 AND agent_runtime_sessions.effort IS excluded.effort
                 AND agent_runtime_sessions.pm_backend IS excluded.pm_backend
                 AND agent_runtime_sessions.spawn_profile_id IS excluded.spawn_profile_id
               )
             )
             AND agent_runtime_sessions.generation_id IS NOT NULL
             AND agent_runtime_sessions.generation_id != ''
          THEN agent_runtime_sessions.generation_id
        ELSE excluded.generation_id
      END
  `);
  const getProviderSessionStmt = db.prepare(`
    SELECT *
      FROM agent_runtime_sessions
     WHERE session_key = ? AND namespace = ?
  `);
  const clearProviderSessionStmt = db.prepare(`
    DELETE FROM agent_runtime_sessions
     WHERE session_key = ? AND namespace = ?
  `);
  const touchProviderSessionStmt = db.prepare(`
    UPDATE agent_runtime_sessions
       SET last_active_ts = ?
     WHERE session_key = ? AND namespace = ?
  `);
  const setProviderBackendStmt = db.prepare(`
    UPDATE agent_runtime_sessions
       SET pm_backend = ?
     WHERE session_key = ? AND namespace = ?
  `);

  function providerSessionParams(row) {
    if (!row || !PROVIDER_NAMESPACES.has(row.namespace)) {
      throw new TypeError('provider session namespace is invalid');
    }
    const provider = row.provider;
    if (
      (provider === 'claude' && !row.namespace.startsWith('claude:'))
      || (provider === 'codex' && row.namespace !== CODEX_APP_SERVER_NAMESPACE)
      || !['claude', 'codex'].includes(provider)
    ) {
      throw new TypeError('provider session namespace/provider mismatch');
    }
    if (
      typeof row.provider_session_id !== 'string'
      || row.provider_session_id.length === 0
    ) {
      throw new TypeError('provider session ID must be a non-empty string');
    }
    return {
      session_key: String(row.session_key),
      namespace: row.namespace,
      provider,
      provider_session_id: row.provider_session_id,
      app_server_session_id: row.app_server_session_id || null,
      agent: row.agent || null,
      cwd: row.cwd || null,
      model: row.model || null,
      effort: row.effort || null,
      pm_backend: row.pm_backend || null,
      spawn_profile_id: row.spawn_profile_id || null,
      generation_id: crypto.randomUUID(),
      ts: row.ts || Date.now(),
    };
  }

  function legacySessionParams(row) {
    return {
      session_key: row.session_key,
      chat_id: String(row.chat_id),
      thread_id: row.thread_id ? String(row.thread_id) : null,
      claude_session_id: row.claude_session_id,
      agent: row.agent || null,
      cwd: row.cwd || null,
      model: row.model || null,
      effort: row.effort || null,
      pm_backend: row.pm_backend || 'sdk',
      ts: row.ts || Date.now(),
    };
  }

  const upsertLegacyAndProviderSession = db.transaction((row) => {
    const legacy = legacySessionParams(row);
    const result = upsertSessionStmt.run(legacy);
    upsertProviderSessionStmt.run(providerSessionParams({
      ...row,
      session_key: legacy.session_key,
      namespace: claudeNamespaceForStoredBackend(legacy.pm_backend),
      provider: 'claude',
      provider_session_id: legacy.claude_session_id,
      pm_backend: legacy.pm_backend,
      ts: legacy.ts,
    }));
    return result;
  });

  const upsertProviderAndLegacySession = db.transaction((row) => {
    const provider = providerSessionParams(row);
    const result = upsertProviderSessionStmt.run(provider);
    if (provider.provider === 'claude') {
      upsertSessionStmt.run(legacySessionParams({
        ...row,
        session_key: provider.session_key,
        chat_id: row.chat_id ?? provider.session_key.split(':')[0],
        claude_session_id: provider.provider_session_id,
        pm_backend: provider.pm_backend
          ?? (
            provider.namespace === CLAUDE_CHANNELS_NAMESPACE
              ? 'cli'
              : 'sdk'
          ),
        ts: provider.ts,
      }));
    }
    return result;
  });

  const clearLegacySession = db.transaction((sessionKey) => {
    const row = getSessionStmt.get(sessionKey);
    const result = clearSessionIdStmt.run(sessionKey);
    if (row) {
      clearProviderSessionStmt.run(
        sessionKey,
        claudeNamespaceForStoredBackend(row.pm_backend),
      );
    }
    return result;
  });

  const clearOneProviderSession = db.transaction((sessionKey, namespace) => {
    const row = getProviderSessionStmt.get(sessionKey, namespace);
    const result = clearProviderSessionStmt.run(sessionKey, namespace);
    if (row?.provider === 'claude') {
      const legacy = getSessionStmt.get(sessionKey);
      if (
        legacy
        && claudeNamespaceForStoredBackend(legacy.pm_backend) === namespace
      ) {
        clearSessionIdStmt.run(sessionKey);
      }
    }
    return result;
  });

  const readProviderSession = db.transaction((sessionKey, namespace) => {
    if (
      namespace === CLAUDE_INLINE_NAMESPACE
      || namespace === CLAUDE_CHANNELS_NAMESPACE
    ) {
      const legacy = getSessionStmt.get(sessionKey);
      if (
        legacy
        && claudeNamespaceForStoredBackend(legacy.pm_backend) === namespace
      ) {
        const namespaced = getProviderSessionStmt.get(sessionKey, namespace);
        if (
          !namespaced
          || legacy.last_active_ts > namespaced.last_active_ts
          || (
            legacy.last_active_ts === namespaced.last_active_ts
            && legacy.claude_session_id !== namespaced.provider_session_id
          )
        ) {
          upsertProviderSessionStmt.run(providerSessionParams({
            session_key: legacy.session_key,
            namespace,
            provider: 'claude',
            provider_session_id: legacy.claude_session_id,
            agent: legacy.agent,
            cwd: legacy.cwd,
            model: legacy.model,
            effort: legacy.effort,
            pm_backend: legacy.pm_backend,
            ts: legacy.last_active_ts,
          }));
        }
      }
    }
    return getProviderSessionStmt.get(sessionKey, namespace);
  });

  const getMessageStmt = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? AND msg_id = ?
    ORDER BY id DESC LIMIT 1
  `);

  const getForegroundCanaryTargetStmt = db.prepare(`
    SELECT message.id AS message_id,
           message.chat_id,
           message.thread_id,
           selection.telegram_message_id,
           message.handler_status,
           selection.session_key,
           selection.provider
      FROM messages AS message
      JOIN inbound_runtime_selections AS selection
        ON selection.bot_name = message.bot_name
       AND selection.telegram_chat_id = message.chat_id
       AND selection.telegram_message_id = ?
     WHERE message.direction = 'in'
       AND message.bot_name = ?
       AND message.chat_id = ?
       AND message.msg_id = ?
  `);

  const setMessageTextStmt = db.prepare(`
    UPDATE messages
       SET text = @text
     WHERE chat_id = @chat_id AND msg_id = @msg_id
  `);

  const logChatMigrationStmt = db.prepare(`
    INSERT OR REPLACE INTO chat_migrations (old_chat_id, new_chat_id, migrated_ts)
    VALUES (?, ?, ?)
  `);

  const resolveChatIdStmt = db.prepare(`
    SELECT new_chat_id FROM chat_migrations WHERE old_chat_id = ?
  `);

  const logEventStmt = db.prepare(`
    INSERT INTO events (ts, chat_id, kind, detail_json)
    VALUES (?, ?, ?, ?)
  `);

  // 0.7.6 (item F): per-turn cost / token / duration metrics. Persisted
  // at turn end (onResult callback). One row per dispatched user
  // message → final reply cycle, even if the cycle had multiple
  // assistant messages. See migrations/009-turn-metrics.sql.
  const insertTurnMetricStmt = db.prepare(`
    INSERT INTO turn_metrics (
      ts, chat_id, thread_id, msg_id, session_id, bot_name,
      model, effort,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, duration_ms, num_assistant_messages, num_tool_uses,
      result_subtype, error
    ) VALUES (
      @ts, @chat_id, @thread_id, @msg_id, @session_id, @bot_name,
      @model, @effort,
      @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens,
      @cost_usd, @duration_ms, @num_assistant_messages, @num_tool_uses,
      @result_subtype, @error
    )
  `);

  const logConfigChangeStmt = db.prepare(`
    INSERT INTO config_changes (
      chat_id, thread_id, field, old_value, new_value,
      user_id, user, source, ts
    ) VALUES (
      @chat_id, @thread_id, @field, @old_value, @new_value,
      @user_id, @user, @source, @ts
    )
  `);

  // 0.8.0 Phase 1 step 8 — chat_tool_decisions persistence for the
  // SDK canUseTool flow. Queried at the START of canUseTool to
  // short-circuit "always allow / always deny" decisions before
  // posting a Telegram inline-keyboard card. Migration 010 created
  // the table; queries here. See v4 plan §6.5.4.
  const lookupChatToolDecisionsStmt = db.prepare(`
    SELECT match_type, input_pattern, decision, expires_ts
      FROM chat_tool_decisions
     WHERE bot_name = @bot_name
       AND chat_id  = @chat_id
       AND tool_name = @tool_name
       AND (expires_ts IS NULL OR expires_ts > @now)
  `);
  const insertChatToolDecisionStmt = db.prepare(`
    INSERT INTO chat_tool_decisions (
      bot_name, chat_id, tool_name, match_type,
      input_pattern, decision,
      issued_ts, issued_by_user_id, expires_ts
    ) VALUES (
      @bot_name, @chat_id, @tool_name, @match_type,
      @input_pattern, @decision,
      @issued_ts, @issued_by_user_id, @expires_ts
    )
  `);
  const deleteChatToolDecisionStmt = db.prepare(`
    DELETE FROM chat_tool_decisions
     WHERE bot_name = ? AND chat_id = ? AND id = ?
  `);

  const markStalePendingStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = '${CRASHED_MID_SEND}'
    WHERE status = 'pending' AND ts < ?
  `);
  const markStalePendingForBotStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = '${CRASHED_MID_SEND}'
    WHERE status = 'pending' AND ts < ? AND bot_name = ?
  `);
  const markReplayPendingStmt = db.prepare(`
    UPDATE messages SET handler_status = 'replay-pending'
     WHERE direction = 'in'
       AND handler_status IN ('dispatched', 'processing')
       AND bot_name = ?
       AND ts > ?
  `);
  const completeAcceptedClaudeAutosteerStmt = db.prepare(`
    UPDATE messages SET handler_status = 'replied'
     WHERE chat_id = ?
       AND msg_id = ?
       AND direction = 'in'
       AND handler_status IN ('dispatched', 'replay-attempted')
  `);
  const clearCleanShutdownMarkerStmt = db.prepare(`
    UPDATE polling_state SET clean_shutdown_at = NULL
     WHERE bot_name = ?
  `);
  const deleteCleanRestartIntentsStmt = db.prepare(`
    DELETE FROM clean_restart_resume_intents
     WHERE bot_name = ?
  `);
  const insertCleanRestartIntentStmt = db.prepare(`
    INSERT INTO clean_restart_resume_intents (
      bot_name, session_key, session_generation_id,
      source_message_id, shutdown_at, policy_version,
      interrupted_provider_turn_id, interrupted_spawn_profile_id,
      continuation_authorized
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  function normalizeResumeIntent(intent) {
    if (!intent || typeof intent.sessionKey !== 'string' || intent.sessionKey.length === 0) {
      throw new TypeError('clean restart intent session key is required');
    }
    if (!Number.isSafeInteger(intent.sourceMessageId) || intent.sourceMessageId <= 0) {
      throw new TypeError('clean restart intent source message ID is invalid');
    }
    if (!Number.isSafeInteger(intent.policyVersion) || intent.policyVersion <= 0) {
      throw new TypeError('clean restart intent policy version is invalid');
    }
    const interruptedProviderTurnId =
      intent.interruptedProviderTurnId ?? null;
    const interruptedSpawnProfileId =
      intent.interruptedSpawnProfileId ?? null;
    if (
      (interruptedProviderTurnId === null)
        !== (interruptedSpawnProfileId === null)
      || (
        interruptedProviderTurnId !== null
        && (
          typeof interruptedProviderTurnId !== 'string'
          || interruptedProviderTurnId.length === 0
          || typeof interruptedSpawnProfileId !== 'string'
          || interruptedSpawnProfileId.length === 0
        )
      )
    ) {
      throw new TypeError(
        'clean restart Codex turn and spawn-profile IDs must be paired',
      );
    }
    if (interruptedProviderTurnId !== null && intent.policyVersion !== 2) {
      throw new TypeError('clean restart Codex intents require policy version 2');
    }
    const expectedCodexIdentity = interruptedProviderTurnId === null
      ? null
      : {
          providerSessionId: intent.expectedProviderSessionId,
          cwd: intent.expectedCwd,
          model: intent.expectedModel,
          effort: intent.expectedEffort,
        };
    if (
      expectedCodexIdentity !== null
      && Object.values(expectedCodexIdentity).some(
        (value) => typeof value !== 'string' || value.length === 0,
      )
    ) {
      throw new TypeError(
        'clean restart Codex intent requires exact retired runtime identity',
      );
    }
    return {
      ...intent,
      interruptedProviderTurnId,
      interruptedSpawnProfileId,
      expectedCodexIdentity,
    };
  }

  function recordShutdown({
    botName,
    now = Date.now(),
    since,
    clean,
    resumeIntents = [],
    continuationAuthorized = false,
  }) {
    if (resumeIntents.length > 0 && continuationAuthorized !== true) {
      throw new TypeError('clean restart intents require deploy authorization');
    }
    const cutoff = since ?? now - 30 * 60 * 1000;
    const txn = db.transaction(() => {
      const marked = markReplayPendingStmt.run(botName, cutoff);
      if (clean) {
        deleteCleanRestartIntentsStmt.run(botName);
        for (const rawIntent of resumeIntents) {
          const intent = normalizeResumeIntent(rawIntent);
          const source = db.prepare(`
            SELECT id
              FROM messages
             WHERE id = ?
               AND direction = 'in'
               AND bot_name = ?
               AND handler_status != 'resume-attempted'
          `).get(intent.sourceMessageId, botName);
          if (!source) {
            throw new Error(
              `clean restart intent source ${intent.sourceMessageId} is unavailable`,
            );
          }
          const session = getProviderSessionStmt.get(
            intent.sessionKey,
            intent.interruptedProviderTurnId === null
              ? CLAUDE_CHANNELS_NAMESPACE
              : CODEX_APP_SERVER_NAMESPACE,
          );
          if (
            !session
            || typeof session.generation_id !== 'string'
            || session.generation_id.length === 0
          ) {
            throw new Error(
              `clean restart intent session generation is unavailable for ${intent.sessionKey}`,
            );
          }
          if (
            intent.interruptedSpawnProfileId !== null
            && session.spawn_profile_id !== intent.interruptedSpawnProfileId
          ) {
            throw new Error(
              `clean restart intent spawn profile changed for ${intent.sessionKey}`,
            );
          }
          if (
            intent.expectedCodexIdentity !== null
            && (
              session.provider_session_id
                !== intent.expectedCodexIdentity.providerSessionId
              || session.cwd !== intent.expectedCodexIdentity.cwd
              || session.model !== intent.expectedCodexIdentity.model
              || session.effort !== intent.expectedCodexIdentity.effort
            )
          ) {
            throw new Error(
              `clean restart intent provider session changed for ${intent.sessionKey}`,
            );
          }
          insertCleanRestartIntentStmt.run(
            botName,
            intent.sessionKey,
            session.generation_id,
            intent.sourceMessageId,
            now,
            intent.policyVersion,
            intent.interruptedProviderTurnId,
            intent.interruptedSpawnProfileId,
          );
        }
        db.prepare(`
          INSERT INTO polling_state (bot_name, last_update_id, ts, clean_shutdown_at)
          VALUES (?,
                  COALESCE((SELECT last_update_id FROM polling_state WHERE bot_name = ?), 0),
                  COALESCE((SELECT ts             FROM polling_state WHERE bot_name = ?), ?),
                  ?)
          ON CONFLICT(bot_name) DO UPDATE SET clean_shutdown_at = excluded.clean_shutdown_at
        `).run(botName, botName, botName, now, now);
      } else {
        deleteCleanRestartIntentsStmt.run(botName);
        clearCleanShutdownMarkerStmt.run(botName);
      }
      return {
        replayMarked: marked.changes,
        intentsRecorded: clean ? resumeIntents.length : 0,
      };
    });
    return txn();
  }

  function assertCodexGenerationIdentity(generationId, stableHostId, bootSessionId) {
    const generation = db.prepare(`
      SELECT * FROM codex_generations WHERE generation_id = ?
    `).get(generationId);
    if (!generation) {
      throw codexError(
        'Codex generation does not exist',
        'CODEX_GENERATION_NOT_FOUND',
      );
    }
    if (
      generation.stable_host_id !== stableHostId
      || generation.boot_session_id !== bootSessionId
    ) {
      throw codexError(
        'Codex generation identity does not match the durable owner',
        'CODEX_GENERATION_IDENTITY_MISMATCH',
      );
    }
    return generation;
  }

  function createCodexGeneration(input) {
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const sessionKey = requiredCodexString(input?.session_key, 'session key');
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const ts = requiredTimestamp(input?.ts ?? Date.now(), 'generation timestamp');
    const threadId = optionalCodexString(input?.thread_id, 'thread ID');
    const appServerSessionId = optionalCodexString(
      input?.app_server_session_id,
      'app-server session ID',
    );

    return db.transaction(() => {
      const identity = db.prepare(`
        SELECT stable_host_id, last_boot_session_id
          FROM codex_runtime_identity
         WHERE singleton = 1
      `).get();
      if (!identity) {
        const hasState = db.prepare(`
          SELECT (
            (SELECT COUNT(*) FROM codex_generations)
            + (SELECT COUNT(*) FROM codex_daemon_lease)
          ) AS count
        `).get().count;
        if (hasState) {
          throw codexError(
            'Codex persisted identity is missing',
            'CODEX_PERSISTED_IDENTITY_MISSING',
          );
        }
        db.prepare(`
          INSERT INTO codex_runtime_identity (
            singleton, stable_host_id, last_boot_session_id,
            established_ts, updated_ts
          ) VALUES (1, ?, ?, ?, ?)
        `).run(stableHostId, bootSessionId, ts, ts);
      } else if (identity.stable_host_id !== stableHostId) {
        throw codexError(
          'Codex database belongs to another stable host',
          'CODEX_STABLE_HOST_MISMATCH',
        );
      } else if (identity.last_boot_session_id !== bootSessionId) {
        throw codexError(
          'Codex boot identity must be reconstructed before generation creation',
          'CODEX_BOOT_RECONSTRUCTION_REQUIRED',
        );
      }
      return db.prepare(`
        INSERT INTO codex_generations (
          generation_id, session_key, thread_id, app_server_session_id,
          stable_host_id, boot_session_id, state,
          created_ts, updated_ts
        ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)
      `).run(
        generationId,
        sessionKey,
        threadId,
        appServerSessionId,
        stableHostId,
        bootSessionId,
        ts,
        ts,
      );
    })();
  }

  const checkpointDetailKeys = [
    'method',
    'outcome',
    'reason',
    'errorCode',
    'source',
    'clientUserMessageId',
    'terminalStatus',
    'itemType',
    'deltaBytes',
    'resumed',
    'model',
    'effort',
    'willRetry',
    'deliveryState',
    'cancellationCode',
    'statusType',
  ];
  const codexCheckpointKinds = new Set([
    'request-prepared',
    'request-write-attempted',
    'request-response-observed',
    'thread-initialized',
    'thread-status-changed',
    'turn-accepted',
    'turn-steer-accepted',
    'turn-error-observed',
    'turn-started',
    'item-delta-observed',
    'item-started',
    'item-completed',
    'turn-terminal',
    'active-start-cancelled',
    'queued-send-cancelled',
    'stop-background-cleanup-reused',
    'stop-terminal-reconciled',
    'stop-clean-accepted',
    'stop-empty-registry-observed',
    'background-terminal-reconciled',
    'background-clean-accepted',
    'background-empty-registry-observed',
    'failed-ambiguous-entered',
    'containment-entered',
    'telegram-delivery-settled',
    'telegram-delivery-failed',
  ]);

  function checkpointDetail(input) {
    const detail = {};
    for (const key of checkpointDetailKeys) {
      const value = input[key];
      if (
        value == null
        || typeof value === 'string'
        || typeof value === 'boolean'
        || Number.isSafeInteger(value)
      ) {
        if (value != null) detail[key] = value;
      }
    }
    Object.assign(detail, sanitizeCodexFaultProvenance(input));
    return Object.keys(detail).length > 0 ? JSON.stringify(detail) : null;
  }

  function requireCodexAttempt(attemptId, generationId) {
    const attempt = db.prepare(`
      SELECT * FROM codex_turn_attempts WHERE attempt_id = ?
    `).get(attemptId);
    if (!attempt || attempt.generation_id !== generationId) {
      throw codexError(
        'Codex checkpoint attempt does not belong to the generation',
        'CODEX_ATTEMPT_NOT_FOUND',
      );
    }
    return attempt;
  }

  function markGenerationAttemptsAmbiguous(generationId, ts) {
    const result = db.prepare(`
      UPDATE codex_turn_attempts
         SET recovery_state = 'ambiguous',
             ambiguous_ts = COALESCE(ambiguous_ts, ?),
             updated_ts = ?
       WHERE generation_id = ?
         AND delivery_state != 'prepared'
         AND recovery_state NOT IN ('settled', 'cancelled')
    `).run(ts, ts, generationId);
    db.prepare(`
      UPDATE codex_linked_inputs
         SET state = 'ambiguous', settled_ts = ?
       WHERE generation_id = ?
         AND state = 'linked'
    `).run(ts, generationId);
    db.prepare(`
      UPDATE codex_dispatch_reservations
         SET state = 'ambiguous',
             updated_ts = ?,
             settled_ts = NULL
       WHERE generation_id = ?
         AND state IN ('reserved', 'steer-accepted', 'queue-authorized')
    `).run(ts, generationId);
    db.prepare(`
      UPDATE messages
         SET handler_status = 'codex-ambiguous'
       WHERE direction = 'in'
         AND handler_status IN (
           'received', 'dispatched', 'processing', 'replay-pending'
         )
         AND EXISTS (
           SELECT 1
             FROM codex_dispatch_reservations reservation
            WHERE reservation.generation_id = ?
              AND reservation.state = 'ambiguous'
              AND reservation.bot_name = messages.bot_name
              AND reservation.telegram_chat_id = messages.chat_id
              AND reservation.telegram_message_id = CAST(messages.msg_id AS TEXT)
         )
    `).run(generationId);
    return result;
  }

  function assertCodexCheckpointOwner(generation, kind) {
    if (['request-prepared', 'queued-send-cancelled'].includes(kind)) return;
    const lease = db.prepare(`
      SELECT generation_id, stable_host_id, boot_session_id, status
        FROM codex_daemon_lease
       WHERE singleton = 1
    `).get();
    if (
      generation.state !== 'active'
      || lease?.status !== 'active'
      || lease.generation_id !== generation.generation_id
      || lease.stable_host_id !== generation.stable_host_id
      || lease.boot_session_id !== generation.boot_session_id
    ) {
      throw codexError(
        'Codex checkpoint generation does not own the active daemon lease',
        'CODEX_CHECKPOINT_STALE_GENERATION',
      );
    }
  }

  function assertCodexAttemptIdentity(attempt, fields) {
    for (const [column, value] of Object.entries(fields)) {
      if (value != null && attempt[column] != null && attempt[column] !== value) {
        throw codexError(
          `Codex attempt ${column} is immutable`,
          'CODEX_ATTEMPT_IDENTITY_MISMATCH',
        );
      }
    }
  }

  const idempotentCheckpointKinds = new Set([
    'request-prepared',
    'request-write-attempted',
    'request-response-observed',
    'thread-initialized',
    'turn-accepted',
    'turn-steer-accepted',
    'turn-started',
    'item-started',
    'item-completed',
    'turn-terminal',
    'active-start-cancelled',
    'queued-send-cancelled',
    'telegram-delivery-settled',
    'telegram-delivery-failed',
  ]);

  function hasExactCodexCheckpoint({
    generationId,
    attemptId,
    kind,
    threadId,
    turnId,
    requestId,
    itemId,
    detailJson,
  }) {
    if (!idempotentCheckpointKinds.has(kind)) return false;
    return db.prepare(`
      SELECT 1
        FROM codex_attempt_checkpoints
       WHERE generation_id = ?
         AND attempt_id IS ?
         AND kind = ?
         AND thread_id IS ?
         AND turn_id IS ?
         AND request_id IS ?
         AND item_id IS ?
         AND detail_json IS ?
       LIMIT 1
    `).get(
      generationId,
      attemptId,
      kind,
      threadId,
      turnId,
      requestId,
      itemId,
      detailJson,
    ) != null;
  }

  function settleCodexInboundReservation(reservation, handlerStatus) {
    const inbound = db.prepare(`
      SELECT handler_status
        FROM messages
       WHERE direction = 'in'
         AND bot_name = ?
         AND chat_id = ?
         AND CAST(msg_id AS TEXT) = ?
    `).get(
      reservation.bot_name,
      reservation.telegram_chat_id,
      reservation.telegram_message_id,
    );
    if (!inbound) {
      throw codexError(
        'Codex disposition has no exact inbound message',
        'CODEX_LINKED_INPUT_MESSAGE_NOT_FOUND',
      );
    }
    if (inbound.handler_status === handlerStatus) return;
    if (![
      'received',
      'dispatched',
      'processing',
      'replay-pending',
    ].includes(inbound.handler_status)) {
      throw codexError(
        'Codex disposition conflicts with the inbound message state',
        'CODEX_LINKED_INPUT_MESSAGE_NOT_FOUND',
      );
    }
    db.prepare(`
      UPDATE messages
         SET handler_status = ?
       WHERE direction = 'in'
         AND bot_name = ?
         AND chat_id = ?
         AND CAST(msg_id AS TEXT) = ?
    `).run(
      handlerStatus,
      reservation.bot_name,
      reservation.telegram_chat_id,
      reservation.telegram_message_id,
    );
  }

  function settleCodexPrimaryInbound(attempt, handlerStatus) {
    if (attempt.telegram_source_message_id == null) return;
    const selections = db.prepare(`
      SELECT *
        FROM inbound_runtime_selections
       WHERE session_key = ?
         AND telegram_message_id = ?
         AND provider = 'codex'
       ORDER BY bot_name, telegram_chat_id
    `).all(
      attempt.session_key,
      attempt.telegram_source_message_id,
    );
    if (selections.length > 1) {
      throw codexError(
        'Codex attempt matches conflicting inbound runtime selections',
        'INBOUND_RUNTIME_SELECTION_CONFLICT',
      );
    }
    if (selections.length === 1) {
      settleCodexInboundReservation(selections[0], handlerStatus);
    }
  }

  function settleCodexAttemptConsumerOutcome({
    attempt,
    generationId,
    linkedState,
    attemptRecoveryState,
    settleQueuedReservation,
    ts,
  }) {
    db.prepare(`
      UPDATE codex_turn_attempts
         SET recovery_state = ?,
             settled_ts = ?,
             updated_ts = ?
       WHERE attempt_id = ?
    `).run(attemptRecoveryState, ts, ts, attempt.attempt_id);

    const handlerStatus = linkedState === 'settled' ? 'replied' : 'failed';
    settleCodexPrimaryInbound(attempt, handlerStatus);

    const acceptedSteers = attempt.turn_id == null
      ? []
      : db.prepare(`
        SELECT *
          FROM codex_turn_attempts
         WHERE generation_id = ?
           AND method = 'turn/steer'
           AND turn_id = ?
           AND delivery_state = 'response-observed'
           AND response_outcome = 'result'
           AND recovery_state = 'active'
         ORDER BY created_ts, attempt_id
      `).all(generationId, attempt.turn_id);
    for (const steer of acceptedSteers) {
      if (steer.telegram_source_message_id == null) continue;
      const reservations = db.prepare(`
        SELECT *
          FROM codex_dispatch_reservations
         WHERE generation_id = ?
           AND session_key = ?
           AND telegram_message_id = ?
           AND state = 'reserved'
         ORDER BY reservation_id
      `).all(
        generationId,
        steer.session_key,
        steer.telegram_source_message_id,
      );
      if (reservations.length > 1) {
        throw codexError(
          'Codex accepted steer matches conflicting reservations',
          'CODEX_DISPATCH_RESERVATION_CONFLICT',
        );
      }
      if (reservations.length === 0) continue;
      const reservation = reservations[0];
      settleCodexInboundReservation(reservation, handlerStatus);
      db.prepare(`
        INSERT INTO codex_linked_inputs (
          linked_input_id, generation_id, attempt_id, target_attempt_id,
          telegram_chat_id, telegram_message_id, state,
          created_ts, settled_ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reservation.reservation_id,
        generationId,
        steer.attempt_id,
        attempt.attempt_id,
        reservation.telegram_chat_id,
        reservation.telegram_message_id,
        linkedState,
        reservation.created_ts,
        ts,
      );
      db.prepare(`
        UPDATE codex_dispatch_reservations
           SET state = ?,
               steer_attempt_id = ?,
               target_attempt_id = ?,
               updated_ts = ?,
               settled_ts = ?
         WHERE reservation_id = ?
           AND state = 'reserved'
      `).run(
        linkedState,
        steer.attempt_id,
        attempt.attempt_id,
        ts,
        ts,
        reservation.reservation_id,
      );
    }

    const linkedReservations = db.prepare(`
      SELECT reservation.*
        FROM codex_dispatch_reservations reservation
        JOIN codex_linked_inputs linked
          ON linked.linked_input_id = reservation.reservation_id
       WHERE linked.target_attempt_id = ?
         AND reservation.state = 'steer-accepted'
    `).all(attempt.attempt_id);
    for (const reservation of linkedReservations) {
      settleCodexInboundReservation(reservation, handlerStatus);
    }
    const linkedAttempts = db.prepare(`
      SELECT attempt_id
        FROM codex_linked_inputs
       WHERE target_attempt_id = ? AND state = 'linked'
    `).all(attempt.attempt_id);
    db.prepare(`
      UPDATE codex_linked_inputs
         SET state = ?, settled_ts = ?
       WHERE target_attempt_id = ? AND state = 'linked'
    `).run(linkedState, ts, attempt.attempt_id);
    db.prepare(`
      UPDATE codex_dispatch_reservations
         SET state = ?, updated_ts = ?, settled_ts = ?
       WHERE reservation_id IN (
         SELECT linked_input_id
           FROM codex_linked_inputs
          WHERE target_attempt_id = ?
       )
         AND state = 'steer-accepted'
    `).run(linkedState, ts, ts, attempt.attempt_id);
    for (const linked of linkedAttempts) {
      db.prepare(`
        UPDATE codex_turn_attempts
           SET recovery_state = 'settled',
               settled_ts = ?,
               updated_ts = ?
         WHERE attempt_id = ?
           AND recovery_state NOT IN ('settled', 'cancelled')
      `).run(ts, ts, linked.attempt_id);
    }
    if (attempt.turn_id != null) {
      db.prepare(`
        UPDATE codex_turn_attempts
           SET recovery_state = 'settled',
               settled_ts = ?,
               updated_ts = ?
         WHERE generation_id = ?
           AND method = 'turn/steer'
           AND turn_id = ?
           AND delivery_state = 'response-observed'
           AND response_outcome = 'result'
           AND recovery_state = 'active'
      `).run(ts, ts, generationId, attempt.turn_id);
    }

    if (
      settleQueuedReservation
      && attempt.telegram_source_message_id != null
    ) {
      const queued = db.prepare(`
        SELECT *
          FROM codex_dispatch_reservations
         WHERE generation_id = ?
           AND session_key = ?
           AND telegram_message_id = ?
           AND state = 'queue-authorized'
         ORDER BY reservation_id
      `).all(
        generationId,
        attempt.session_key,
        attempt.telegram_source_message_id,
      );
      if (queued.length > 1) {
        throw codexError(
          'Codex terminal attempt matches conflicting queued reservations',
          'CODEX_QUEUE_SETTLEMENT_CONFLICT',
        );
      }
      if (queued.length === 1) {
        settleCodexInboundReservation(queued[0], handlerStatus);
        db.prepare(`
          UPDATE codex_dispatch_reservations
             SET state = ?,
                 target_attempt_id = ?,
                 updated_ts = ?,
                 settled_ts = ?
           WHERE reservation_id = ?
             AND state = 'queue-authorized'
        `).run(
          linkedState,
          attempt.attempt_id,
          ts,
          ts,
          queued[0].reservation_id,
        );
      }
    }

    db.prepare(`
      UPDATE codex_generations
         SET state = 'healthy-stopped',
             settled_ts = ?,
             updated_ts = ?
       WHERE generation_id = ?
         AND EXISTS (
           SELECT 1
             FROM codex_attempt_checkpoints
            WHERE generation_id = ?
              AND kind = 'stop-empty-registry-observed'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM codex_turn_attempts
            WHERE generation_id = ?
              AND recovery_state NOT IN ('settled', 'cancelled')
         )
    `).run(ts, ts, generationId, generationId, generationId);
  }

  function recordCodexCheckpoint(input) {
    const kind = requiredCodexString(input?.kind, 'checkpoint kind');
    if (!codexCheckpointKinds.has(kind)) {
      throw codexError(
        'Codex checkpoint kind is not allowlisted',
        'CODEX_CHECKPOINT_KIND_REJECTED',
      );
    }
    const generationId = requiredCodexString(
      input?.generationId ?? input?.generation_id,
      'generation ID',
    );
    const stableHostId = requiredCodexString(
      input?.stable_host_id ?? input?.hostIdentity,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id ?? input?.bootSessionIdentity,
      'boot-session identity',
    );
    const attemptId = optionalCodexString(
      input?.attemptId ?? input?.attempt_id,
      'attempt ID',
    );
    const threadId = optionalCodexString(
      input?.threadId ?? input?.thread_id,
      'thread ID',
    );
    const turnId = optionalCodexString(
      input?.turnId ?? input?.turn_id,
      'turn ID',
    );
    const requestId = optionalCodexRequestId(
      input?.requestId ?? input?.request_id,
    );
    const itemId = optionalCodexString(
      input?.itemId ?? input?.item_id,
      'item ID',
    );
    const method = optionalCodexString(input?.method, 'request method');
    const sourceId = optionalCodexString(input?.source, 'source message ID');
    const clientUserMessageId = optionalCodexString(
      input?.clientUserMessageId ?? input?.client_user_message_id,
      'client user message ID',
    );
    const ts = requiredTimestamp(input?.ts ?? Date.now(), 'checkpoint timestamp');
    const detailJson = checkpointDetail(input);

    return db.transaction(() => {
      const generation = assertCodexGenerationIdentity(
        generationId,
        stableHostId,
        bootSessionId,
      );
      let attempt = attemptId
        ? db.prepare(`
          SELECT * FROM codex_turn_attempts WHERE attempt_id = ?
        `).get(attemptId)
        : null;
      if (attempt) {
        assertCodexAttemptIdentity(attempt, {
          method,
          thread_id: threadId,
          turn_id: turnId,
          request_id: requestId,
          telegram_source_message_id: sourceId,
          client_user_message_id: clientUserMessageId,
        });
        if (hasExactCodexCheckpoint({
          generationId,
          attemptId,
          kind,
          threadId,
          turnId,
          requestId,
          itemId,
          detailJson,
        })) {
          return { changes: 0, attemptId, kind };
        }
      }
      assertCodexCheckpointOwner(generation, kind);

      if (kind === 'request-prepared') {
        requiredCodexString(method, 'request method');
        if (!attemptId) {
          throw codexError(
            'Codex prepared checkpoint requires an attempt ID',
            'CODEX_CHECKPOINT_INPUT_INVALID',
          );
        }
        if (attempt) {
          if (
            attempt.generation_id === generationId
            && attempt.method === method
            && attempt.delivery_state === 'prepared'
          ) {
            return { changes: 0, attemptId, kind };
          }
          throw codexError(
            'Codex attempt ID was reused with different metadata',
            'CODEX_ATTEMPT_ID_REUSED',
          );
        }
        db.prepare(`
          INSERT INTO codex_turn_attempts (
            attempt_id, generation_id, session_key, method,
            thread_id, turn_id, telegram_source_message_id,
            client_user_message_id, delivery_state, recovery_state,
            created_ts, updated_ts
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'prepared', ?, ?)
        `).run(
          attemptId,
          generationId,
          generation.session_key,
          method,
          threadId,
          turnId,
          sourceId,
          clientUserMessageId,
          ts,
          ts,
        );
        attempt = requireCodexAttempt(attemptId, generationId);
      } else if (kind === 'queued-send-cancelled' && attemptId && !attempt) {
        db.prepare(`
          INSERT INTO codex_turn_attempts (
            attempt_id, generation_id, session_key, method,
            thread_id, turn_id, telegram_source_message_id,
            client_user_message_id, delivery_state, recovery_state,
            created_ts, updated_ts, settled_ts
          ) VALUES (?, ?, ?, 'queued/send', ?, ?, ?, ?,
                    'prepared', 'cancelled', ?, ?, ?)
        `).run(
          attemptId,
          generationId,
          generation.session_key,
          threadId,
          turnId,
          sourceId,
          clientUserMessageId,
          ts,
          ts,
          ts,
        );
        attempt = requireCodexAttempt(attemptId, generationId);
      } else if (attemptId) {
        attempt = requireCodexAttempt(attemptId, generationId);
      }

      if (kind === 'request-write-attempted') {
        if (attempt.delivery_state !== 'prepared') {
          throw codexError(
            'Codex write-attempted checkpoint is out of order',
            'CODEX_CHECKPOINT_SEQUENCE_INVALID',
          );
        }
        db.prepare(`
          UPDATE codex_turn_attempts
             SET request_id = ?,
                 delivery_state = 'write-attempted',
                 recovery_state = 'ambiguous',
                 ambiguous_ts = COALESCE(ambiguous_ts, ?),
                 updated_ts = ?
           WHERE attempt_id = ?
        `).run(requestId, ts, ts, attemptId);
      } else if (kind === 'request-response-observed') {
        if (attempt.delivery_state !== 'write-attempted') {
          throw codexError(
            'Codex response-observed checkpoint is out of order',
            'CODEX_CHECKPOINT_SEQUENCE_INVALID',
          );
        }
        if (!['result', 'error'].includes(input?.outcome)) {
          throw codexError(
            'Codex response checkpoint outcome is invalid',
            'CODEX_CHECKPOINT_INPUT_INVALID',
          );
        }
        db.prepare(`
          UPDATE codex_turn_attempts
             SET request_id = COALESCE(request_id, ?),
                 delivery_state = 'response-observed',
                 response_outcome = ?,
                 updated_ts = ?
           WHERE attempt_id = ?
        `).run(requestId, input.outcome, ts, attemptId);
      } else if (
        ['turn-accepted', 'turn-steer-accepted'].includes(kind)
      ) {
        if (!attempt) {
          throw codexError(
            'Codex turn lifecycle checkpoint requires an attempt',
            'CODEX_CHECKPOINT_INPUT_INVALID',
          );
        }
        if (
          attempt.delivery_state !== 'response-observed'
          || attempt.response_outcome !== 'result'
        ) {
          throw codexError(
            'Codex accepted checkpoint has no successful response predecessor',
            'CODEX_CHECKPOINT_SEQUENCE_INVALID',
          );
        }
        db.prepare(`
          UPDATE codex_turn_attempts
             SET turn_id = COALESCE(?, turn_id),
                 recovery_state = CASE
                   WHEN terminal_status IS NULL THEN 'active'
                   ELSE 'terminal-pending'
                 END,
                 updated_ts = ?
           WHERE attempt_id = ?
        `).run(turnId, ts, attemptId);
        db.prepare(`
          UPDATE codex_generations
             SET thread_id = COALESCE(?, thread_id),
                 state = 'active',
                 updated_ts = ?
           WHERE generation_id = ?
        `).run(threadId, ts, generationId);
      } else if (kind === 'turn-started') {
        if (
          !attempt
          || attempt.terminal_status != null
          || !(
            attempt.recovery_state === 'active'
            || (
              attempt.recovery_state === 'ambiguous'
              && ['write-attempted', 'response-observed'].includes(
                attempt.delivery_state,
              )
            )
          )
        ) {
          throw codexError(
            'Codex turn-started checkpoint has no dispatched predecessor',
            'CODEX_CHECKPOINT_SEQUENCE_INVALID',
          );
        }
        db.prepare(`
          UPDATE codex_turn_attempts
             SET turn_id = COALESCE(?, turn_id), updated_ts = ?
           WHERE attempt_id = ?
        `).run(turnId, ts, attemptId);
      } else if (
        ['item-started', 'item-completed', 'item-delta-observed'].includes(kind)
      ) {
        const notificationBeforeResponse = (
          attempt?.recovery_state === 'ambiguous'
          && ['write-attempted', 'response-observed'].includes(
            attempt?.delivery_state,
          )
        );
        if (
          !attempt
          || attempt.turn_id == null
          || attempt.terminal_status != null
          || !(attempt.recovery_state === 'active' || notificationBeforeResponse)
        ) {
          throw codexError(
            'Codex item checkpoint requires a live dispatched turn',
            'CODEX_CHECKPOINT_SEQUENCE_INVALID',
          );
        }
        db.prepare(`
          UPDATE codex_turn_attempts
             SET updated_ts = ?
           WHERE attempt_id = ?
        `).run(ts, attemptId);
        if (kind !== 'item-delta-observed' && itemId) {
          recordCodexItemEffect({
            generation_id: generationId,
            attempt_id: attemptId,
            item_id: itemId,
            item_type: input?.itemType ?? 'unknown',
            state: kind === 'item-started' ? 'started' : 'completed',
            ts,
          });
        }
      } else if (kind === 'turn-terminal') {
        if (
          !attempt
          || attempt.turn_id == null
          || attempt.terminal_status != null
          || !(
            attempt.recovery_state === 'active'
            || (
              attempt.recovery_state === 'ambiguous'
              && ['write-attempted', 'response-observed'].includes(
                attempt.delivery_state,
              )
            )
          )
          || !['completed', 'interrupted', 'failed'].includes(
          input?.terminalStatus,
          )
        ) {
          throw codexError(
            'Codex turn terminal checkpoint is invalid',
            'CODEX_CHECKPOINT_INPUT_INVALID',
          );
        }
        db.prepare(`
          UPDATE codex_turn_attempts
             SET turn_id = COALESCE(?, turn_id),
                 terminal_status = ?,
                 recovery_state = CASE
                   WHEN recovery_state = 'active' THEN 'terminal-pending'
                   ELSE recovery_state
                 END,
                 updated_ts = ?
           WHERE attempt_id = ?
        `).run(turnId, input.terminalStatus, ts, attemptId);
      } else if (
        ['stop-terminal-reconciled', 'background-terminal-reconciled']
          .includes(kind)
      ) {
        db.prepare(`
          UPDATE codex_turn_attempts
             SET recovery_state = 'clean-pending', updated_ts = ?
           WHERE generation_id = ?
             AND method IN ('turn/start', 'turn/interrupt')
             AND recovery_state NOT IN ('settled', 'cancelled')
             AND (? IS NULL OR turn_id = ?)
        `).run(ts, generationId, turnId, turnId);
      } else if (
        ['stop-clean-accepted', 'background-clean-accepted'].includes(kind)
      ) {
        db.prepare(`
          UPDATE codex_turn_attempts
             SET recovery_state = 'empty-registry-pending', updated_ts = ?
           WHERE generation_id = ?
             AND method = 'thread/backgroundTerminals/clean'
             AND recovery_state NOT IN ('settled', 'cancelled')
        `).run(ts, generationId);
      } else if (
        ['stop-empty-registry-observed', 'background-empty-registry-observed']
          .includes(kind)
      ) {
        db.prepare(`
          UPDATE codex_turn_attempts
             SET recovery_state = 'settled',
                 settled_ts = ?,
                 updated_ts = ?
           WHERE generation_id = ?
             AND method IN (
               'turn/interrupt',
               'thread/backgroundTerminals/clean'
             )
             AND recovery_state NOT IN ('settled', 'cancelled')
        `).run(ts, ts, generationId);
        if (kind === 'stop-empty-registry-observed') {
          db.prepare(`
            UPDATE codex_generations
               SET state = 'healthy-stopped',
                   settled_ts = ?,
                   updated_ts = ?
             WHERE generation_id = ?
               AND NOT EXISTS (
                 SELECT 1
                   FROM codex_turn_attempts
                  WHERE generation_id = ?
                    AND recovery_state NOT IN ('settled', 'cancelled')
               )
          `).run(ts, ts, generationId, generationId);
        }
      } else if (
        ['telegram-delivery-settled', 'telegram-delivery-failed']
          .includes(kind)
      ) {
        if (!attempt || ![
          'terminal-pending',
          'clean-pending',
          'empty-registry-pending',
        ].includes(
          attempt.recovery_state,
        )) {
          throw codexError(
            'Codex delivery settlement requires a terminal attempt',
            'CODEX_CHECKPOINT_SEQUENCE_INVALID',
          );
        }
        const deliveryFailed = kind === 'telegram-delivery-failed';
        const linkedState = deliveryFailed
          ? 'failed'
          : attempt.terminal_status === 'interrupted'
            ? 'interrupted'
            : attempt.terminal_status === 'failed'
              ? 'failed'
              : 'settled';
        settleCodexAttemptConsumerOutcome({
          attempt,
          generationId,
          linkedState,
          attemptRecoveryState: 'settled',
          settleQueuedReservation: true,
          ts,
        });
      } else if (
        ['active-start-cancelled', 'queued-send-cancelled'].includes(kind)
      ) {
        if (attempt) {
          db.prepare(`
            UPDATE codex_turn_attempts
               SET recovery_state = 'cancelled',
                   settled_ts = ?,
                   updated_ts = ?
             WHERE attempt_id = ?
          `).run(ts, ts, attemptId);
        }
      } else if (kind === 'failed-ambiguous-entered') {
        if (attempt) {
          db.prepare(`
            UPDATE codex_turn_attempts
               SET recovery_state = 'ambiguous',
                   ambiguous_ts = COALESCE(ambiguous_ts, ?),
                   updated_ts = ?
             WHERE attempt_id = ?
          `).run(ts, ts, attemptId);
          db.prepare(`
            UPDATE codex_linked_inputs
               SET state = 'ambiguous', settled_ts = ?
             WHERE (
               attempt_id = ?
               OR target_attempt_id = ?
             )
               AND state = 'linked'
          `).run(ts, attemptId, attemptId);
          db.prepare(`
            UPDATE codex_dispatch_reservations
               SET state = 'ambiguous',
                   updated_ts = ?,
                   settled_ts = NULL
             WHERE (
               steer_attempt_id = ?
               OR target_attempt_id = ?
             )
               AND state IN (
                 'reserved', 'steer-accepted', 'queue-authorized'
               )
          `).run(ts, attemptId, attemptId);
          db.prepare(`
            UPDATE messages
               SET handler_status = 'codex-ambiguous'
             WHERE direction = 'in'
               AND handler_status IN (
                 'received', 'dispatched', 'processing', 'replay-pending'
               )
               AND EXISTS (
                 SELECT 1
                   FROM codex_dispatch_reservations reservation
                  WHERE (
                    reservation.steer_attempt_id = ?
                    OR reservation.target_attempt_id = ?
                  )
                    AND reservation.state = 'ambiguous'
                    AND reservation.bot_name = messages.bot_name
                    AND reservation.telegram_chat_id = messages.chat_id
                    AND reservation.telegram_message_id
                      = CAST(messages.msg_id AS TEXT)
               )
          `).run(attemptId, attemptId);
        } else {
          markGenerationAttemptsAmbiguous(generationId, ts);
        }
      } else if (kind === 'containment-entered') {
        const reason = optionalCodexString(
          input?.reason,
          'containment reason',
        );
        db.prepare(`
          UPDATE codex_generations
             SET state = 'containment-failed',
                 containment_reason = ?,
                 updated_ts = ?
           WHERE generation_id = ?
        `).run(reason, ts, generationId);
        markGenerationAttemptsAmbiguous(generationId, ts);
        const lease = db.prepare(`
          SELECT generation_id
            FROM codex_daemon_lease
           WHERE singleton = 1
        `).get();
        if (!lease || lease.generation_id !== generationId) {
          throw codexError(
            'Codex containment checkpoint requires the owned daemon lease',
            'CODEX_LEASE_MISMATCH',
          );
        }
        db.prepare(`
          UPDATE codex_daemon_lease
             SET status = 'quarantined',
                 quarantine_reason = ?,
                 updated_ts = ?
           WHERE singleton = 1
        `).run(reason, ts);
      } else if (kind === 'thread-initialized') {
        const initializing = db.prepare(`
          SELECT attempt_id, delivery_state, response_outcome
            FROM codex_turn_attempts
           WHERE generation_id = ?
             AND method IN ('thread/start', 'thread/resume')
             AND recovery_state NOT IN ('settled', 'cancelled')
           ORDER BY created_ts DESC
           LIMIT 1
        `).get(generationId);
        if (
          !initializing
          || initializing.delivery_state !== 'response-observed'
          || initializing.response_outcome !== 'result'
        ) {
          throw codexError(
            'Codex thread initialization has no successful response predecessor',
            'CODEX_CHECKPOINT_SEQUENCE_INVALID',
          );
        }
        db.prepare(`
          UPDATE codex_generations
             SET thread_id = COALESCE(?, thread_id), updated_ts = ?
           WHERE generation_id = ?
        `).run(threadId, ts, generationId);
        db.prepare(`
          UPDATE codex_turn_attempts
             SET thread_id = COALESCE(?, thread_id),
                 recovery_state = 'settled',
                 settled_ts = ?,
                 updated_ts = ?
           WHERE attempt_id = (
             SELECT attempt_id
               FROM codex_turn_attempts
              WHERE generation_id = ?
                AND method IN ('thread/start', 'thread/resume')
                AND recovery_state NOT IN ('settled', 'cancelled')
              ORDER BY created_ts DESC
              LIMIT 1
           )
        `).run(threadId, ts, ts, generationId);
      } else if (kind === 'thread-status-changed') {
        requiredCodexString(input?.statusType, 'thread status type');
      }

      db.prepare(`
        INSERT INTO codex_attempt_checkpoints (
          generation_id, attempt_id, kind, thread_id, turn_id,
          request_id, item_id, detail_json, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generationId,
        attemptId,
        kind,
        threadId,
        turnId,
        requestId,
        itemId,
        detailJson,
        ts,
      );
      return { changes: 1, attemptId, kind };
    })();
  }

  function recordCodexDeliveryCheckpoint(input) {
    const allowed = new Set(['checkpoint', 'retireGeneration']);
    assertExactKeys(
      input,
      allowed,
      'CODEX_DELIVERY_PAYLOAD_REJECTED',
      'delivery checkpoint',
    );
    const checkpoint = input?.checkpoint;
    if (
      !checkpoint
      || ![
        'telegram-delivery-settled',
        'telegram-delivery-failed',
      ].includes(checkpoint.kind)
      || typeof input.retireGeneration !== 'boolean'
    ) {
      throw codexError(
        'Codex delivery checkpoint payload is invalid',
        'CODEX_DELIVERY_PAYLOAD_REJECTED',
      );
    }
    return db.transaction(() => {
      const result = recordCodexCheckpoint(checkpoint);
      if (!input.retireGeneration) {
        return { ...result, retired: false };
      }
      const generationId = requiredCodexString(
        checkpoint.generationId ?? checkpoint.generation_id,
        'generation ID',
      );
      const ts = requiredTimestamp(
        checkpoint.ts ?? Date.now(),
        'delivery checkpoint timestamp',
      );
      const retirement = retireCodexGeneration(generationId, ts, {
        onlyIfHealthyStopped: true,
      });
      if (!retirement.retired) {
        throw codexError(
          'Codex delivery could not prove a healthy stopped generation',
          'CODEX_RETIREMENT_UNVERIFIED',
        );
      }
      return { ...result, retired: true };
    })();
  }

  function readCodexDispatchReservation(reservationId) {
    return db.prepare(`
      SELECT *
        FROM codex_dispatch_reservations
       WHERE reservation_id = ?
    `).get(reservationId);
  }

  function recordInboundRuntimeSelection(input) {
    const allowed = new Set([
      'session_key',
      'bot_name',
      'telegram_chat_id',
      'telegram_message_id',
      'provider',
      'ts',
    ]);
    assertExactKeys(
      input,
      allowed,
      'INBOUND_RUNTIME_SELECTION_PAYLOAD_REJECTED',
      'inbound runtime selection',
    );
    const sessionKey = requiredCodexString(input?.session_key, 'session key');
    const botName = requiredCodexString(input?.bot_name, 'bot name');
    const telegramChatId = requiredCodexString(
      input?.telegram_chat_id,
      'Telegram chat ID',
    );
    const telegramMessageId = requiredCodexString(
      input?.telegram_message_id,
      'Telegram message ID',
    );
    const provider = input?.provider;
    if (!['claude', 'codex'].includes(provider)) {
      throw codexError(
        'Inbound runtime provider is invalid',
        'INBOUND_RUNTIME_SELECTION_INVALID',
      );
    }
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'inbound runtime selection timestamp',
    );

    return db.transaction(() => {
      const existing = db.prepare(`
        SELECT *
          FROM inbound_runtime_selections
         WHERE bot_name = ?
           AND telegram_chat_id = ?
           AND telegram_message_id = ?
      `).get(botName, telegramChatId, telegramMessageId);
      if (existing) {
        if (
          existing.session_key === sessionKey
          && existing.provider === provider
        ) {
          return { changes: 0, selection: existing };
        }
        throw codexError(
          'Inbound runtime selection conflicts with durable identity',
          'INBOUND_RUNTIME_SELECTION_CONFLICT',
        );
      }
      const inbound = db.prepare(`
        SELECT direction, bot_name
          FROM messages
         WHERE chat_id = ?
           AND CAST(msg_id AS TEXT) = ?
      `).get(telegramChatId, telegramMessageId);
      if (inbound?.direction !== 'in' || inbound.bot_name !== botName) {
        throw codexError(
          'Inbound runtime selection has no exact inbound message',
          'INBOUND_RUNTIME_SELECTION_INBOUND_MISMATCH',
        );
      }
      db.prepare(`
        INSERT INTO inbound_runtime_selections (
          bot_name, telegram_chat_id, telegram_message_id,
          session_key, provider, selected_ts
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        botName,
        telegramChatId,
        telegramMessageId,
        sessionKey,
        provider,
        ts,
      );
      return {
        changes: 1,
        selection: db.prepare(`
          SELECT *
            FROM inbound_runtime_selections
           WHERE bot_name = ?
             AND telegram_chat_id = ?
             AND telegram_message_id = ?
        `).get(botName, telegramChatId, telegramMessageId),
      };
    })();
  }

  function publicCodexAttempt(attempt) {
    if (!attempt) return null;
    return {
      attemptId: attempt.attempt_id,
      generationId: attempt.generation_id,
      method: attempt.method,
      deliveryState: attempt.delivery_state,
      recoveryState: attempt.recovery_state,
      turnId: attempt.turn_id,
      terminalStatus: attempt.terminal_status,
    };
  }

  function publicRuntimeSelection(selection) {
    return {
      provider: selection.provider,
      sessionKey: selection.session_key,
      selectedTs: selection.selected_ts,
    };
  }

  function getReplayProviderRecovery(input) {
    const allowed = new Set([
      'sessionKey',
      'botName',
      'telegramChatId',
      'telegramMessageId',
    ]);
    assertExactKeys(
      input,
      allowed,
      'REPLAY_PROVIDER_RECOVERY_PAYLOAD_REJECTED',
      'replay provider recovery',
    );
    const sessionKey = requiredCodexString(input?.sessionKey, 'session key');
    const botName = requiredCodexString(input?.botName, 'bot name');
    const telegramChatId = requiredCodexString(
      input?.telegramChatId,
      'Telegram chat ID',
    );
    const telegramMessageId = requiredCodexString(
      input?.telegramMessageId,
      'Telegram message ID',
    );
    const unknown = (reason) => ({ provider: 'unknown', reason });
    const selection = db.prepare(`
      SELECT *
        FROM inbound_runtime_selections
       WHERE bot_name = ?
         AND telegram_chat_id = ?
         AND telegram_message_id = ?
    `).get(botName, telegramChatId, telegramMessageId);
    if (!selection) return unknown('selection-missing');
    if (selection.session_key !== sessionKey) {
      return unknown('selection-conflict');
    }

    const reservations = db.prepare(`
      SELECT *
        FROM codex_dispatch_reservations
       WHERE bot_name = ?
         AND telegram_chat_id = ?
         AND telegram_message_id = ?
    `).all(botName, telegramChatId, telegramMessageId);
    const attempts = db.prepare(`
      SELECT attempt.*
        FROM codex_turn_attempts attempt
        JOIN codex_generations generation
          ON generation.generation_id = attempt.generation_id
       WHERE generation.session_key = ?
         AND attempt.telegram_source_message_id = ?
       ORDER BY attempt.created_ts, attempt.attempt_id
    `).all(sessionKey, telegramMessageId);
    const linkedInputs = db.prepare(`
      SELECT linked.*
        FROM codex_linked_inputs linked
        JOIN codex_generations generation
          ON generation.generation_id = linked.generation_id
       WHERE generation.session_key = ?
         AND linked.telegram_chat_id = ?
         AND linked.telegram_message_id = ?
       ORDER BY linked.created_ts, linked.linked_input_id
    `).all(sessionKey, telegramChatId, telegramMessageId);
    const hasCodexEvidence = (
      reservations.length > 0
      || attempts.length > 0
      || linkedInputs.length > 0
    );
    if (selection.provider === 'claude') {
      return hasCodexEvidence
        ? unknown('provider-evidence-conflict')
        : {
          provider: 'claude',
          kind: 'selected',
          selection: publicRuntimeSelection(selection),
        };
    }
    if (
      reservations.length > 1
      || attempts.length > 1
      || linkedInputs.length > 1
    ) {
      return unknown('codex-evidence-conflict');
    }

    const reservation = reservations[0] ?? null;
    const attempt = attempts[0] ?? null;
    const linkedInput = linkedInputs[0] ?? null;
    if (
      reservation
      && (
        reservation.session_key !== sessionKey
        || (
          attempt
          && reservation.generation_id !== attempt.generation_id
        )
      )
    ) {
      return unknown('codex-evidence-conflict');
    }
    if (
      attempt
      && !['turn/start', 'turn/steer'].includes(attempt.method)
    ) {
      return unknown('codex-evidence-conflict');
    }

    let kind = 'selection-only';
    let targetAttempt = null;
    if (linkedInput) {
      if (
        !attempt
        || linkedInput.attempt_id !== attempt.attempt_id
        || linkedInput.generation_id !== attempt.generation_id
        || (
          reservation
          && (
            reservation.reservation_id !== linkedInput.linked_input_id
            || reservation.steer_attempt_id !== attempt.attempt_id
            || reservation.target_attempt_id !== linkedInput.target_attempt_id
          )
        )
      ) {
        return unknown('codex-evidence-conflict');
      }
      targetAttempt = db.prepare(`
        SELECT attempt.*
          FROM codex_turn_attempts attempt
          JOIN codex_generations generation
            ON generation.generation_id = attempt.generation_id
         WHERE attempt.attempt_id = ?
           AND attempt.generation_id = ?
           AND generation.session_key = ?
      `).get(
        linkedInput.target_attempt_id,
        linkedInput.generation_id,
        sessionKey,
      );
      if (
        !targetAttempt
        || targetAttempt.method !== 'turn/start'
        || targetAttempt.turn_id !== attempt.turn_id
      ) {
        return unknown('codex-evidence-conflict');
      }
      kind = 'linked-input';
    } else if (reservation) {
      if (reservation.steer_attempt_id != null) {
        return unknown('codex-evidence-conflict');
      }
      if (
        reservation.target_attempt_id != null
        && (
          !attempt
          || reservation.target_attempt_id !== attempt.attempt_id
          || attempt.method !== 'turn/start'
        )
      ) {
        return unknown('codex-evidence-conflict');
      }
      if (reservation.target_attempt_id != null) {
        targetAttempt = attempt;
      }
      if (attempt && attempt.method !== 'turn/start') {
        return unknown('codex-evidence-conflict');
      }
      kind = 'dispatch-reservation';
    } else if (attempt) {
      if (attempt.method !== 'turn/start') {
        return unknown('codex-evidence-conflict');
      }
      kind = 'primary-turn';
    }

    return {
      provider: 'codex',
      kind,
      selection: publicRuntimeSelection(selection),
      reservation: reservation
        ? {
          reservationId: reservation.reservation_id,
          generationId: reservation.generation_id,
          state: reservation.state,
          targetAttemptId: reservation.target_attempt_id,
        }
        : null,
      attempt: publicCodexAttempt(attempt),
      linkedInput: linkedInput
        ? {
          linkedInputId: linkedInput.linked_input_id,
          state: linkedInput.state,
          attemptId: linkedInput.attempt_id,
          targetAttemptId: linkedInput.target_attempt_id,
        }
        : null,
      targetAttempt: publicCodexAttempt(targetAttempt),
    };
  }

  function assertCodexDispatchReservationIdentity(
    reservation,
    generationId,
  ) {
    if (!reservation) {
      throw codexError(
        'Codex dispatch reservation does not exist',
        'CODEX_DISPATCH_RESERVATION_NOT_FOUND',
      );
    }
    if (reservation.generation_id !== generationId) {
      throw codexError(
        'Codex dispatch reservation belongs to another generation',
        'CODEX_DISPATCH_RESERVATION_CONFLICT',
      );
    }
    return reservation;
  }

  function claimCodexDispatchReservation(input) {
    const allowed = new Set([
      'reservation_id',
      'generation_id',
      'session_key',
      'bot_name',
      'telegram_chat_id',
      'telegram_message_id',
      'stable_host_id',
      'boot_session_id',
      'ts',
    ]);
    assertExactKeys(
      input,
      allowed,
      'CODEX_DISPATCH_RESERVATION_PAYLOAD_REJECTED',
      'dispatch reservation',
    );
    const reservationId = requiredCodexString(
      input?.reservation_id,
      'dispatch reservation ID',
    );
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const sessionKey = requiredCodexString(
      input?.session_key,
      'session key',
    );
    const botName = requiredCodexString(input?.bot_name, 'bot name');
    const telegramChatId = requiredCodexString(
      input?.telegram_chat_id,
      'Telegram chat ID',
    );
    const telegramMessageId = requiredCodexString(
      input?.telegram_message_id,
      'Telegram message ID',
    );
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'dispatch reservation timestamp',
    );

    return db.transaction(() => {
      const generation = assertCodexGenerationIdentity(
        generationId,
        stableHostId,
        bootSessionId,
      );
      if (generation.session_key !== sessionKey) {
        throw codexError(
          'Codex dispatch session does not own the generation',
          'CODEX_DISPATCH_SESSION_MISMATCH',
        );
      }
      const existingRows = db.prepare(`
        SELECT *
          FROM codex_dispatch_reservations
         WHERE reservation_id = ?
            OR (
              bot_name = ?
              AND
              telegram_chat_id = ?
              AND telegram_message_id = ?
            )
         ORDER BY reservation_id
      `).all(reservationId, botName, telegramChatId, telegramMessageId);
      if (existingRows.length > 0) {
        const existing = existingRows[0];
        if (
          existingRows.length === 1
          && existing.reservation_id === reservationId
          && existing.generation_id === generationId
          && existing.session_key === sessionKey
          && existing.bot_name === botName
          && existing.telegram_chat_id === telegramChatId
          && existing.telegram_message_id === telegramMessageId
        ) {
          const handlerStatus = existing.state === 'settled'
            ? 'replied'
            : ['failed', 'interrupted', 'cancelled'].includes(existing.state)
              ? 'failed'
              : existing.state === 'ambiguous'
                ? 'codex-ambiguous'
                : 'dispatched';
          const inbound = db.prepare(`
            UPDATE messages
               SET handler_status = ?
             WHERE direction = 'in'
               AND bot_name = ?
               AND chat_id = ?
               AND CAST(msg_id AS TEXT) = ?
          `).run(
            handlerStatus,
            existing.bot_name,
            existing.telegram_chat_id,
            existing.telegram_message_id,
          );
          if (inbound.changes !== 1) {
            throw codexError(
              'Codex duplicate reservation has no exact inbound message',
              'CODEX_DISPATCH_INBOUND_MISMATCH',
            );
          }
          return { claimed: false, reservation: existing };
        }
        throw codexError(
          'Codex dispatch reservation identity was reused',
          'CODEX_DISPATCH_RESERVATION_CONFLICT',
        );
      }

      assertCodexCheckpointOwner(generation, 'request-write-attempted');
      const inbound = db.prepare(`
        SELECT direction, bot_name
          FROM messages
         WHERE chat_id = ?
           AND CAST(msg_id AS TEXT) = ?
      `).get(telegramChatId, telegramMessageId);
      if (
        inbound?.direction !== 'in'
        || inbound.bot_name !== botName
      ) {
        throw codexError(
          'Codex dispatch reservation has no exact inbound message',
          'CODEX_DISPATCH_INBOUND_MISMATCH',
        );
      }
      db.prepare(`
        INSERT INTO codex_dispatch_reservations (
          reservation_id, generation_id, session_key,
          bot_name, telegram_chat_id, telegram_message_id, state,
          created_ts, updated_ts
        ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      `).run(
        reservationId,
        generationId,
        sessionKey,
        botName,
        telegramChatId,
        telegramMessageId,
        ts,
        ts,
      );
      return {
        claimed: true,
        reservation: readCodexDispatchReservation(reservationId),
      };
    })();
  }

  function hasCodexTurnCheckpoint(generationId, attemptId, kind, turnId) {
    return db.prepare(`
      SELECT 1
        FROM codex_attempt_checkpoints
       WHERE generation_id = ?
         AND attempt_id = ?
         AND kind = ?
         AND turn_id = ?
       LIMIT 1
    `).get(generationId, attemptId, kind, turnId) != null;
  }

  function finalizeCodexAcceptedSteer(input) {
    const allowed = new Set([
      'reservation_id',
      'generation_id',
      'steer_attempt_id',
      'target_attempt_id',
      'stable_host_id',
      'boot_session_id',
      'ts',
    ]);
    assertExactKeys(
      input,
      allowed,
      'CODEX_DISPATCH_RESERVATION_PAYLOAD_REJECTED',
      'accepted steer',
    );
    const reservationId = requiredCodexString(
      input?.reservation_id,
      'dispatch reservation ID',
    );
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const steerAttemptId = requiredCodexString(
      input?.steer_attempt_id,
      'steer attempt ID',
    );
    const targetAttemptId = requiredCodexString(
      input?.target_attempt_id,
      'target attempt ID',
    );
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'accepted steer timestamp',
    );

    return db.transaction(() => {
      const generation = assertCodexGenerationIdentity(
        generationId,
        stableHostId,
        bootSessionId,
      );
      let reservation = assertCodexDispatchReservationIdentity(
        readCodexDispatchReservation(reservationId),
        generationId,
      );
      if ([
        'steer-accepted',
        'settled',
        'failed',
        'interrupted',
      ].includes(reservation.state)) {
        const linked = db.prepare(`
          SELECT generation_id, attempt_id, target_attempt_id, state,
                 telegram_chat_id, telegram_message_id
            FROM codex_linked_inputs
           WHERE linked_input_id = ?
        `).get(reservationId);
        if (
          reservation.steer_attempt_id === steerAttemptId
          && reservation.target_attempt_id === targetAttemptId
          && linked?.generation_id === generationId
          && linked.attempt_id === steerAttemptId
          && linked.target_attempt_id === targetAttemptId
          && reservation.bot_name != null
          && linked.telegram_chat_id === reservation.telegram_chat_id
          && linked.telegram_message_id === reservation.telegram_message_id
          && (
            (
              reservation.state === 'steer-accepted'
              && linked.state === 'linked'
            )
            || linked.state === reservation.state
          )
        ) {
          return { changes: 0, reservation };
        }
        throw codexError(
          'Codex accepted steer reservation metadata conflicts',
          'CODEX_DISPATCH_RESERVATION_CONFLICT',
        );
      }
      if (reservation.state !== 'reserved') {
        throw codexError(
          'Codex dispatch reservation cannot accept a steer in this state',
          'CODEX_DISPATCH_TRANSITION_INVALID',
        );
      }
      assertCodexCheckpointOwner(generation, 'turn-steer-accepted');

      const steer = requireCodexAttempt(steerAttemptId, generationId);
      const target = requireCodexAttempt(targetAttemptId, generationId);
      const exactTurn = (
        steer.turn_id != null
        && target.turn_id === steer.turn_id
        && steer.thread_id != null
        && target.thread_id === steer.thread_id
      );
      const steerDurable = (
        steer.method === 'turn/steer'
        && steer.delivery_state === 'response-observed'
        && steer.response_outcome === 'result'
        && steer.recovery_state === 'active'
        && hasCodexTurnCheckpoint(
          generationId,
          steerAttemptId,
          'turn-steer-accepted',
          steer.turn_id,
        )
      );
      const targetDurable = (
        target.method === 'turn/start'
        && target.delivery_state === 'response-observed'
        && target.response_outcome === 'result'
        && [
          'active',
          'terminal-pending',
          'clean-pending',
          'empty-registry-pending',
          'settled',
        ].includes(target.recovery_state)
        && hasCodexTurnCheckpoint(
          generationId,
          targetAttemptId,
          'turn-accepted',
          target.turn_id,
        )
      );
      if (!exactTurn || !steerDurable || !targetDurable) {
        throw codexError(
          'Codex accepted steer is not durably bound to its target turn',
          'CODEX_DISPATCH_STEER_NOT_DURABLE',
        );
      }

      const targetAlreadyDelivered = (
        target.recovery_state === 'settled'
        && ['completed', 'interrupted', 'failed'].includes(
          target.terminal_status,
        )
        && hasCodexTurnCheckpoint(
          generationId,
          targetAttemptId,
          'telegram-delivery-settled',
          target.turn_id,
        )
      );
      if (target.recovery_state === 'settled' && !targetAlreadyDelivered) {
        throw codexError(
          'Codex settled target lacks exact Telegram delivery proof',
          'CODEX_DISPATCH_STEER_NOT_DURABLE',
        );
      }
      const linkedState = targetAlreadyDelivered
        ? target.terminal_status === 'completed'
          ? 'settled'
          : target.terminal_status
        : 'linked';
      const linkedSettledTs = targetAlreadyDelivered
        ? target.settled_ts ?? ts
        : null;
      db.prepare(`
        INSERT INTO codex_linked_inputs (
          linked_input_id, generation_id, attempt_id, target_attempt_id,
          telegram_chat_id, telegram_message_id, state, created_ts, settled_ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reservationId,
        generationId,
        steerAttemptId,
        targetAttemptId,
        reservation.telegram_chat_id,
        reservation.telegram_message_id,
        linkedState,
        ts,
        linkedSettledTs,
      );
      if (targetAlreadyDelivered) {
        const handlerStatus = linkedState === 'settled' ? 'replied' : 'failed';
        const inbound = db.prepare(`
          UPDATE messages
             SET handler_status = ?
           WHERE direction = 'in'
             AND bot_name = ?
             AND chat_id = ?
             AND CAST(msg_id AS TEXT) = ?
             AND handler_status IN (
               'received', 'dispatched', 'processing', 'replay-pending'
             )
        `).run(
          handlerStatus,
          reservation.bot_name,
          reservation.telegram_chat_id,
          reservation.telegram_message_id,
        );
        if (inbound.changes !== 1) {
          throw codexError(
            'Codex late accepted steer has no live exact inbound message',
            'CODEX_LINKED_INPUT_MESSAGE_NOT_FOUND',
          );
        }
        db.prepare(`
          UPDATE codex_turn_attempts
             SET recovery_state = 'settled',
                 settled_ts = ?,
                 updated_ts = ?
           WHERE attempt_id = ?
             AND recovery_state = 'active'
        `).run(linkedSettledTs, ts, steerAttemptId);
      }
      db.prepare(`
        UPDATE codex_dispatch_reservations
           SET state = ?,
               steer_attempt_id = ?,
               target_attempt_id = ?,
               updated_ts = ?,
               settled_ts = ?
         WHERE reservation_id = ?
           AND state = 'reserved'
      `).run(
        targetAlreadyDelivered ? linkedState : 'steer-accepted',
        steerAttemptId,
        targetAttemptId,
        ts,
        linkedSettledTs,
        reservationId,
      );
      reservation = readCodexDispatchReservation(reservationId);
      return { changes: 1, reservation };
    })();
  }

  function markCodexDispatchDisposition(input) {
    const allowed = new Set([
      'reservation_id',
      'generation_id',
      'disposition',
      'stable_host_id',
      'boot_session_id',
      'ts',
    ]);
    assertExactKeys(
      input,
      allowed,
      'CODEX_DISPATCH_RESERVATION_PAYLOAD_REJECTED',
      'dispatch disposition',
    );
    const reservationId = requiredCodexString(
      input?.reservation_id,
      'dispatch reservation ID',
    );
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const disposition = input?.disposition;
    if (!['queue-authorized', 'ambiguous', 'cancelled'].includes(disposition)) {
      throw codexError(
        'Codex dispatch disposition is invalid',
        'CODEX_DISPATCH_DISPOSITION_INVALID',
      );
    }
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'dispatch disposition timestamp',
    );

    return db.transaction(() => {
      const generation = assertCodexGenerationIdentity(
        generationId,
        stableHostId,
        bootSessionId,
      );
      let reservation = assertCodexDispatchReservationIdentity(
        readCodexDispatchReservation(reservationId),
        generationId,
      );
      if (reservation.state === disposition) {
        return { changes: 0, reservation };
      }
      const legal = (
        reservation.state === 'reserved'
        || (
          reservation.state === 'queue-authorized'
          && ['ambiguous', 'cancelled'].includes(disposition)
        )
      );
      if (!legal) {
        throw codexError(
          'Codex dispatch disposition transition is invalid',
          'CODEX_DISPATCH_TRANSITION_INVALID',
        );
      }
      assertCodexCheckpointOwner(generation, 'request-write-attempted');
      db.prepare(`
        UPDATE codex_dispatch_reservations
           SET state = ?,
               updated_ts = ?,
               settled_ts = CASE WHEN ? = 'cancelled' THEN ? ELSE NULL END
         WHERE reservation_id = ?
      `).run(disposition, ts, disposition, ts, reservationId);
      reservation = readCodexDispatchReservation(reservationId);
      if (['ambiguous', 'cancelled'].includes(disposition)) {
        const handlerStatus = disposition === 'ambiguous'
          ? 'codex-ambiguous'
          : 'failed';
        const inbound = db.prepare(`
          UPDATE messages
             SET handler_status = ?
           WHERE direction = 'in'
             AND bot_name = ?
             AND chat_id = ?
             AND CAST(msg_id AS TEXT) = ?
             AND handler_status IN (
               'received', 'dispatched', 'processing', 'replay-pending'
             )
        `).run(
          handlerStatus,
          reservation.bot_name,
          reservation.telegram_chat_id,
          reservation.telegram_message_id,
        );
        if (inbound.changes !== 1) {
          throw codexError(
            'Codex dispatch disposition has no live exact inbound message',
            'CODEX_DISPATCH_INBOUND_MISMATCH',
          );
        }
      }
      return { changes: 1, reservation };
    })();
  }

  function settleCodexQueuedDispatch(input) {
    const allowed = new Set([
      'attempt_id',
      'generation_id',
      'session_key',
      'bot_name',
      'telegram_chat_id',
      'telegram_message_id',
      'stable_host_id',
      'boot_session_id',
      'ts',
    ]);
    assertExactKeys(
      input,
      allowed,
      'CODEX_QUEUE_SETTLEMENT_PAYLOAD_REJECTED',
      'queued dispatch settlement',
    );
    const attemptId = requiredCodexString(
      input?.attempt_id,
      'queued turn attempt ID',
    );
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const sessionKey = requiredCodexString(input?.session_key, 'session key');
    const botName = requiredCodexString(input?.bot_name, 'bot name');
    const telegramChatId = requiredCodexString(
      input?.telegram_chat_id,
      'Telegram chat ID',
    );
    const telegramMessageId = requiredCodexString(
      input?.telegram_message_id,
      'Telegram message ID',
    );
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'queued dispatch settlement timestamp',
    );

    return db.transaction(() => {
      const generation = assertCodexGenerationIdentity(
        generationId,
        stableHostId,
        bootSessionId,
      );
      if (generation.session_key !== sessionKey) {
        throw codexError(
          'Codex queued turn session does not own its generation',
          'CODEX_QUEUE_SETTLEMENT_CONFLICT',
        );
      }
      const attempt = requireCodexAttempt(attemptId, generationId);
      const durableCompleted = (
        attempt.session_key === sessionKey
        && attempt.method === 'turn/start'
        && attempt.telegram_source_message_id === telegramMessageId
        && attempt.delivery_state === 'response-observed'
        && attempt.response_outcome === 'result'
        && attempt.recovery_state === 'settled'
        && attempt.terminal_status === 'completed'
        && attempt.turn_id != null
        && hasCodexTurnCheckpoint(
          generationId,
          attemptId,
          'turn-accepted',
          attempt.turn_id,
        )
        && hasCodexTurnCheckpoint(
          generationId,
          attemptId,
          'turn-terminal',
          attempt.turn_id,
        )
        && hasCodexTurnCheckpoint(
          generationId,
          attemptId,
          'telegram-delivery-settled',
          attempt.turn_id,
        )
      );
      if (!durableCompleted) {
        throw codexError(
          'Codex queued turn lacks exact completed delivery proof',
          'CODEX_QUEUE_SETTLEMENT_NOT_DURABLE',
        );
      }

      const candidates = db.prepare(`
        SELECT *
          FROM codex_dispatch_reservations
         WHERE (
           bot_name = ?
           AND telegram_chat_id = ?
           AND telegram_message_id = ?
         )
            OR (
              generation_id = ?
              AND session_key = ?
              AND telegram_message_id = ?
            )
         ORDER BY reservation_id
      `).all(
        botName,
        telegramChatId,
        telegramMessageId,
        generationId,
        sessionKey,
        telegramMessageId,
      );
      if (candidates.length === 0) {
        return {
          changes: 0,
          outcome: 'no-reservation',
          reservation: null,
        };
      }
      if (candidates.length !== 1) {
        throw codexError(
          'Codex queued turn matches conflicting dispatch reservations',
          'CODEX_QUEUE_SETTLEMENT_CONFLICT',
        );
      }
      let reservation = candidates[0];
      const exactReservation = (
        reservation.generation_id === generationId
        && reservation.session_key === sessionKey
        && reservation.bot_name === botName
        && reservation.telegram_chat_id === telegramChatId
        && reservation.telegram_message_id === telegramMessageId
      );
      if (!exactReservation) {
        throw codexError(
          'Codex queued turn reservation identity conflicts',
          'CODEX_QUEUE_SETTLEMENT_CONFLICT',
        );
      }
      if (
        reservation.state === 'settled'
        && reservation.target_attempt_id === attemptId
        && reservation.steer_attempt_id == null
      ) {
        return { changes: 0, outcome: 'settled', reservation };
      }
      if (
        reservation.state !== 'queue-authorized'
        || reservation.steer_attempt_id != null
        || reservation.target_attempt_id != null
      ) {
        throw codexError(
          'Codex dispatch reservation cannot settle this queued turn',
          'CODEX_QUEUE_SETTLEMENT_CONFLICT',
        );
      }
      db.prepare(`
        UPDATE codex_dispatch_reservations
           SET state = 'settled',
               target_attempt_id = ?,
               updated_ts = ?,
               settled_ts = ?
         WHERE reservation_id = ?
           AND state = 'queue-authorized'
      `).run(
        attemptId,
        ts,
        attempt.settled_ts ?? ts,
        reservation.reservation_id,
      );
      reservation = readCodexDispatchReservation(reservation.reservation_id);
      return { changes: 1, outcome: 'settled', reservation };
    })();
  }

  function settleCodexStoppedGeneration(input) {
    const allowed = new Set([
      'generation_id',
      'stable_host_id',
      'boot_session_id',
      'ts',
    ]);
    assertExactKeys(
      input,
      allowed,
      'CODEX_RETIREMENT_PAYLOAD_REJECTED',
      'stopped generation settlement',
    );
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'stopped generation settlement timestamp',
    );

    return db.transaction(() => {
      const generation = assertCodexGenerationIdentity(
        generationId,
        stableHostId,
        bootSessionId,
      );
      const lease = db.prepare(`
        SELECT generation_id, stable_host_id, boot_session_id, status
          FROM codex_daemon_lease
         WHERE singleton = 1
      `).get();
      if (
        !['active', 'healthy-stopped'].includes(generation.state)
        || lease?.status !== 'active'
        || lease.generation_id !== generationId
        || lease.stable_host_id !== stableHostId
        || lease.boot_session_id !== bootSessionId
      ) {
        throw codexError(
          'Codex stopped generation does not own the active daemon lease',
          'CODEX_CHECKPOINT_STALE_GENERATION',
        );
      }
      const stop = db.prepare(`
        SELECT turn_id
          FROM codex_attempt_checkpoints
         WHERE generation_id = ?
           AND kind = 'stop-empty-registry-observed'
         ORDER BY id DESC
         LIMIT 1
      `).get(generationId);
      if (!stop) {
        throw codexError(
          'Codex stopped generation lacks exact empty-registry proof',
          'CODEX_RETIREMENT_UNVERIFIED',
        );
      }
      const unresolved = db.prepare(`
        SELECT *
          FROM codex_turn_attempts
         WHERE generation_id = ?
           AND delivery_state != 'prepared'
           AND recovery_state NOT IN ('settled', 'cancelled')
         ORDER BY created_ts, attempt_id
      `).all(generationId);
      if (unresolved.length === 0) {
        retireCodexGeneration(generationId, ts);
        return {
          changes: 0,
          disposition: 'already-disposed',
          attemptId: null,
          retired: true,
        };
      }
      const interrupted = unresolved.filter((attempt) => (
        attempt.method === 'turn/start'
        && attempt.turn_id === stop.turn_id
        && attempt.terminal_status === 'interrupted'
        && hasCodexTurnCheckpoint(
          generationId,
          attempt.attempt_id,
          'turn-terminal',
          attempt.turn_id,
        )
      ));
      if (interrupted.length === 0) {
        return {
          changes: 0,
          disposition: 'pending-delivery',
          attemptId: null,
        };
      }
      if (interrupted.length !== 1) {
        throw codexError(
          'Codex stopped generation has conflicting interrupted targets',
          'CODEX_RETIREMENT_UNVERIFIED',
        );
      }
      const attempt = interrupted[0];
      settleCodexAttemptConsumerOutcome({
        attempt,
        generationId,
        linkedState: 'interrupted',
        attemptRecoveryState: 'cancelled',
        settleQueuedReservation: true,
        ts,
      });
      retireCodexGeneration(generationId, ts);
      return {
        changes: 1,
        disposition: 'stop-cancelled',
        attemptId: attempt.attempt_id,
        retired: true,
      };
    })();
  }

  function linkCodexSteeringInput(input) {
    const allowed = new Set([
      'linked_input_id',
      'generation_id',
      'attempt_id',
      'target_attempt_id',
      'telegram_chat_id',
      'telegram_message_id',
      'ts',
    ]);
    assertExactKeys(
      input,
      allowed,
      'CODEX_LINKED_INPUT_PAYLOAD_REJECTED',
      'linked input',
    );
    const ts = requiredTimestamp(input?.ts ?? Date.now(), 'linked input timestamp');
    const linkedInputId = requiredCodexString(
      input?.linked_input_id,
      'linked input ID',
    );
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const attemptId = requiredCodexString(
      input?.attempt_id,
      'steer attempt ID',
    );
    const targetAttemptId = requiredCodexString(
      input?.target_attempt_id,
      'target attempt ID',
    );
    const telegramChatId = requiredCodexString(
      input?.telegram_chat_id,
      'Telegram chat ID',
    );
    const telegramMessageId = requiredCodexString(
      input?.telegram_message_id,
      'Telegram message ID',
    );
    return db.transaction(() => {
      const attempt = requireCodexAttempt(
        attemptId,
        generationId,
      );
      const target = requireCodexAttempt(
        targetAttemptId,
        generationId,
      );
      if (attempt.method !== 'turn/steer' || target.method !== 'turn/start') {
        throw codexError(
          'Codex linked input must connect steer work to a turn',
          'CODEX_LINKED_INPUT_INVALID',
        );
      }
      const existing = db.prepare(`
        SELECT generation_id, attempt_id, target_attempt_id,
               telegram_chat_id, telegram_message_id
          FROM codex_linked_inputs
         WHERE linked_input_id = ?
      `).get(linkedInputId);
      if (existing) {
        if (
          existing.generation_id === generationId
          && existing.attempt_id === attemptId
          && existing.target_attempt_id === targetAttemptId
          && existing.telegram_chat_id === telegramChatId
          && existing.telegram_message_id === telegramMessageId
        ) {
          return { changes: 0 };
        }
        throw codexError(
          'Codex linked input ID was reused with different metadata',
          'CODEX_LINKED_INPUT_ID_REUSED',
        );
      }
      return db.prepare(`
        INSERT INTO codex_linked_inputs (
          linked_input_id, generation_id, attempt_id, target_attempt_id,
          telegram_chat_id, telegram_message_id, state, created_ts
        ) VALUES (?, ?, ?, ?, ?, ?, 'linked', ?)
      `).run(
        linkedInputId,
        generationId,
        attemptId,
        targetAttemptId,
        telegramChatId,
        telegramMessageId,
        ts,
      );
    })();
  }

  function claimCodexRetryReservation(input) {
    const originalAttemptId = requiredCodexString(
      input?.original_attempt_id,
      'original attempt ID',
    );
    const retryAttemptId = requiredCodexString(
      input?.retry_attempt_id,
      'retry attempt ID',
    );
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const method = requiredCodexString(input?.method, 'retry method');
    const threadId = optionalCodexString(input?.thread_id, 'thread ID');
    const sourceMessageId = optionalCodexString(
      input?.telegram_source_message_id,
      'source message ID',
    );
    const clientUserMessageId = optionalCodexString(
      input?.client_user_message_id,
      'client user message ID',
    );
    const ts = requiredTimestamp(input?.ts ?? Date.now(), 'retry claim timestamp');
    return db.transaction(() => {
      const generation = assertCodexGenerationIdentity(
        generationId,
        stableHostId,
        bootSessionId,
      );
      assertCodexCheckpointOwner(generation, 'request-write-attempted');
      const reservation = db.prepare(`
        SELECT reservation.*,
               original.generation_id AS original_generation_id,
               original.session_key AS original_session_key,
               original_generation.stable_host_id AS original_stable_host_id,
               original_generation.boot_session_id AS original_boot_session_id,
               original_generation.state AS original_generation_state
          FROM codex_retry_reservations reservation
          JOIN codex_turn_attempts original
            ON original.attempt_id = reservation.original_attempt_id
          JOIN codex_generations original_generation
            ON original_generation.generation_id = original.generation_id
         WHERE reservation.original_attempt_id = ?
      `).get(originalAttemptId);
      if (
        !reservation
        || reservation.retry_attempt_id !== retryAttemptId
      ) {
        throw codexError(
          'Codex retry reservation does not match the claimed attempt',
          'CODEX_RETRY_RESERVATION_MISMATCH',
        );
      }
      if (reservation.original_generation_id === generationId) {
        throw codexError(
          'Codex retry requires a distinct replacement generation',
          'CODEX_RETRY_NEW_GENERATION_REQUIRED',
        );
      }
      if (
        reservation.original_session_key !== generation.session_key
        || reservation.original_stable_host_id !== generation.stable_host_id
      ) {
        throw codexError(
          'Codex retry generation does not match the original session',
          'CODEX_RETRY_RESERVATION_MISMATCH',
        );
      }
      const cleanupCommitted = db.prepare(`
        SELECT 1
          FROM codex_attempt_checkpoints
         WHERE generation_id = ?
           AND kind = 'containment-cleanup-completed'
         LIMIT 1
      `).get(reservation.original_generation_id);
      if (
        reservation.original_generation_state !== 'containment-failed'
        || !cleanupCommitted
      ) {
        throw codexError(
          'Codex retry requires committed failed-generation cleanup',
          'CODEX_RETRY_CLEANUP_REQUIRED',
        );
      }
      const existing = db.prepare(`
        SELECT * FROM codex_turn_attempts WHERE attempt_id = ?
      `).get(retryAttemptId);
      if (
        ['claimed', 'dispatched', 'retired'].includes(reservation.state)
        && existing
      ) {
        assertCodexAttemptIdentity(existing, {
          generation_id: generationId,
          session_key: generation.session_key,
          method,
          thread_id: threadId,
          telegram_source_message_id: sourceMessageId,
          client_user_message_id: clientUserMessageId,
        });
        return { changes: 0, retryAttemptId };
      }
      if (reservation.state !== 'reserved' || existing) {
        throw codexError(
          'Codex retry reservation has already been consumed',
          'CODEX_RETRY_ALREADY_CLAIMED',
        );
      }
      db.prepare(`
        INSERT INTO codex_turn_attempts (
          attempt_id, generation_id, session_key, method,
          thread_id, telegram_source_message_id, client_user_message_id,
          delivery_state, recovery_state, created_ts, updated_ts
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', 'prepared', ?, ?)
      `).run(
        retryAttemptId,
        generationId,
        generation.session_key,
        method,
        threadId,
        sourceMessageId,
        clientUserMessageId,
        ts,
        ts,
      );
      db.prepare(`
        INSERT INTO codex_attempt_checkpoints (
          generation_id, attempt_id, kind, thread_id,
          detail_json, ts
        ) VALUES (?, ?, 'request-prepared', ?, ?, ?)
      `).run(
        generationId,
        retryAttemptId,
        threadId,
        checkpointDetail({
          method,
          source: sourceMessageId,
          clientUserMessageId,
        }),
        ts,
      );
      db.prepare(`
        UPDATE codex_retry_reservations
           SET state = 'claimed', claimed_ts = ?
         WHERE original_attempt_id = ?
      `).run(ts, originalAttemptId);
      return { changes: 1, retryAttemptId };
    })();
  }

  function markCodexRetryDispatched(input) {
    const originalAttemptId = requiredCodexString(
      input?.original_attempt_id,
      'original attempt ID',
    );
    const retryAttemptId = requiredCodexString(
      input?.retry_attempt_id,
      'retry attempt ID',
    );
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'retry dispatch timestamp',
    );
    return db.transaction(() => {
      const reservation = db.prepare(`
        SELECT * FROM codex_retry_reservations
         WHERE original_attempt_id = ?
      `).get(originalAttemptId);
      const retry = db.prepare(`
        SELECT * FROM codex_turn_attempts WHERE attempt_id = ?
      `).get(retryAttemptId);
      if (
        !reservation
        || reservation.retry_attempt_id !== retryAttemptId
        || !retry
      ) {
        throw codexError(
          'Codex retry dispatch has no materialized reservation',
          'CODEX_RETRY_RESERVATION_MISMATCH',
        );
      }
      if (reservation.state === 'dispatched') {
        return { changes: 0, retryAttemptId };
      }
      if (
        reservation.state !== 'claimed'
        || retry.delivery_state === 'prepared'
      ) {
        throw codexError(
          'Codex retry was not durably write-attempted',
          'CODEX_RETRY_NOT_WRITE_ATTEMPTED',
        );
      }
      const result = db.prepare(`
        UPDATE codex_retry_reservations
           SET state = 'dispatched', dispatched_ts = ?
         WHERE original_attempt_id = ?
      `).run(ts, originalAttemptId);
      return { changes: result.changes, retryAttemptId };
    })();
  }

  function retireCodexRetryReservation(input) {
    const originalAttemptId = requiredCodexString(
      input?.original_attempt_id,
      'original attempt ID',
    );
    const retryAttemptId = requiredCodexString(
      input?.retry_attempt_id,
      'retry attempt ID',
    );
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'retry retirement timestamp',
    );
    return db.transaction(() => {
      const reservation = db.prepare(`
        SELECT * FROM codex_retry_reservations
         WHERE original_attempt_id = ?
      `).get(originalAttemptId);
      const retry = db.prepare(`
        SELECT recovery_state
          FROM codex_turn_attempts
         WHERE attempt_id = ?
      `).get(retryAttemptId);
      if (
        !reservation
        || reservation.retry_attempt_id !== retryAttemptId
        || !retry
      ) {
        throw codexError(
          'Codex retry retirement has no materialized reservation',
          'CODEX_RETRY_RESERVATION_MISMATCH',
        );
      }
      if (reservation.state === 'retired') {
        return { changes: 0, retryAttemptId };
      }
      if (!['settled', 'cancelled'].includes(retry.recovery_state)) {
        throw codexError(
          'Codex retry attempt is not durably settled',
          'CODEX_RETRY_NOT_SETTLED',
        );
      }
      const result = db.prepare(`
        UPDATE codex_retry_reservations
           SET state = 'retired', retired_ts = ?
         WHERE original_attempt_id = ?
      `).run(ts, originalAttemptId);
      return { changes: result.changes, retryAttemptId };
    })();
  }

  function recordCodexItemEffect(input) {
    const allowed = new Set([
      'generation_id',
      'attempt_id',
      'item_id',
      'item_type',
      'state',
      'ts',
    ]);
    assertExactKeys(
      input,
      allowed,
      'CODEX_EFFECT_PAYLOAD_REJECTED',
      'item effect',
    );
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const attemptId = requiredCodexString(input?.attempt_id, 'attempt ID');
    const itemId = requiredCodexString(input?.item_id, 'item ID');
    const itemType = requiredCodexString(input?.item_type, 'item type');
    const state = input?.state;
    if (!['started', 'completed', 'failed'].includes(state)) {
      throw codexError(
        'Codex item effect state is invalid',
        'CODEX_EFFECT_PAYLOAD_REJECTED',
      );
    }
    const ts = requiredTimestamp(input?.ts ?? Date.now(), 'item effect timestamp');
    return db.transaction(() => {
      const attempt = requireCodexAttempt(attemptId, generationId);
      const generation = db.prepare(`
        SELECT * FROM codex_generations WHERE generation_id = ?
      `).get(generationId);
      assertCodexCheckpointOwner(generation, 'item-started');
      const existing = db.prepare(`
        SELECT generation_id, item_type, state
          FROM codex_item_effects
         WHERE attempt_id = ? AND item_id = ?
      `).get(attemptId, itemId);
      if (existing) {
        if (
          existing.generation_id !== generationId
          || existing.item_type !== itemType
        ) {
          throw codexError(
            'Codex item effect identity is immutable',
            'CODEX_EFFECT_IDENTITY_MISMATCH',
          );
        }
        if (existing.state === state) return { changes: 0 };
      }
      const earlyNotification = (
        attempt.recovery_state === 'ambiguous'
        && ['write-attempted', 'response-observed'].includes(
          attempt.delivery_state,
        )
      );
      if (
        attempt.turn_id == null
        || attempt.terminal_status != null
        || !(attempt.recovery_state === 'active' || earlyNotification)
      ) {
        throw codexError(
          'Codex item effect requires a live dispatched turn',
          'CODEX_EFFECT_SEQUENCE_INVALID',
        );
      }
      if (existing) {
        if (existing.state !== 'started') {
          throw codexError(
            'Codex terminal item effect cannot regress or change',
            'CODEX_EFFECT_STATE_CONFLICT',
          );
        }
        return db.prepare(`
          UPDATE codex_item_effects
             SET state = ?, updated_ts = ?
           WHERE attempt_id = ? AND item_id = ?
        `).run(state, ts, attemptId, itemId);
      }
      return db.prepare(`
        INSERT INTO codex_item_effects (
          generation_id, attempt_id, item_id, item_type,
          state, created_ts, updated_ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        generationId,
        attemptId,
        itemId,
        itemType,
        state,
        ts,
        ts,
      );
    })();
  }

  function acquireCodexLease(input) {
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const ts = requiredTimestamp(input?.ts ?? Date.now(), 'lease timestamp');
    return db.transaction(() => {
      assertCodexGenerationIdentity(generationId, stableHostId, bootSessionId);
      const lease = db.prepare(`
        SELECT * FROM codex_daemon_lease WHERE singleton = 1
      `).get();
      if (
        lease?.status === 'quarantined'
        || (
          lease?.status === 'active'
          && lease.generation_id !== generationId
        )
      ) {
        throw codexError(
          'Codex daemon generation lease is unavailable',
          lease.status === 'quarantined'
            ? 'CODEX_CONTAINMENT_QUARANTINED'
            : 'CODEX_DAEMON_GENERATION_BUSY',
        );
      }
      db.prepare(`
        INSERT INTO codex_daemon_lease (
          singleton, generation_id, stable_host_id, boot_session_id,
          status, quarantine_reason, acquired_ts, updated_ts, released_ts
        ) VALUES (1, ?, ?, ?, 'active', NULL, ?, ?, NULL)
        ON CONFLICT(singleton) DO UPDATE SET
          generation_id = excluded.generation_id,
          stable_host_id = excluded.stable_host_id,
          boot_session_id = excluded.boot_session_id,
          status = 'active',
          quarantine_reason = NULL,
          acquired_ts = excluded.acquired_ts,
          updated_ts = excluded.updated_ts,
          released_ts = NULL
      `).run(generationId, stableHostId, bootSessionId, ts, ts);
      db.prepare(`
        UPDATE codex_generations
           SET state = 'active', updated_ts = ?
         WHERE generation_id = ?
      `).run(ts, generationId);
      return db.prepare(`
        SELECT * FROM codex_daemon_lease WHERE singleton = 1
      `).get();
    })();
  }

  function markCodexContainment(input) {
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const stableHostId = requiredCodexString(
      input?.stable_host_id,
      'stable host identity',
    );
    const bootSessionId = requiredCodexString(
      input?.boot_session_id,
      'boot-session identity',
    );
    const reason = requiredCodexString(input?.reason, 'containment reason');
    const ts = requiredTimestamp(
      input?.ts ?? Date.now(),
      'containment timestamp',
    );
    return db.transaction(() => {
      assertCodexGenerationIdentity(generationId, stableHostId, bootSessionId);
      const lease = db.prepare(`
        SELECT * FROM codex_daemon_lease WHERE singleton = 1
      `).get();
      if (!lease || lease.generation_id !== generationId) {
        throw codexError(
          'Codex containment requires the owned daemon lease',
          'CODEX_LEASE_MISMATCH',
        );
      }
      db.prepare(`
        UPDATE codex_generations
           SET state = 'containment-failed',
               containment_reason = ?,
               updated_ts = ?
         WHERE generation_id = ?
      `).run(reason, ts, generationId);
      markGenerationAttemptsAmbiguous(generationId, ts);
      return db.prepare(`
        UPDATE codex_daemon_lease
           SET status = 'quarantined',
               quarantine_reason = ?,
               updated_ts = ?
         WHERE singleton = 1
      `).run(reason, ts);
    })();
  }

  function retireCodexGeneration(
    generationId,
    ts,
    { onlyIfHealthyStopped = false } = {},
  ) {
    const generation = db.prepare(`
      SELECT * FROM codex_generations WHERE generation_id = ?
    `).get(generationId);
    if (!generation) {
      throw codexError(
        'Codex generation does not exist',
        'CODEX_GENERATION_NOT_FOUND',
      );
    }
    if (generation.state === 'retired') {
      return { changes: 0, retired: true };
    }
    if (onlyIfHealthyStopped && generation.state !== 'healthy-stopped') {
      return { changes: 0, retired: false };
    }
    const unresolved = db.prepare(`
      SELECT 1
        FROM codex_turn_attempts
       WHERE generation_id = ?
         AND delivery_state != 'prepared'
         AND recovery_state NOT IN ('settled', 'cancelled')
       LIMIT 1
    `).get(generationId);
    if (unresolved) {
      throw codexError(
        'Codex generation still owns unresolved delivery work',
        'CODEX_RETIREMENT_UNVERIFIED',
      );
    }
    const lease = db.prepare(`
      SELECT * FROM codex_daemon_lease WHERE singleton = 1
    `).get();
    if (
      lease?.status !== 'active'
      || lease.generation_id !== generationId
      || lease.stable_host_id !== generation.stable_host_id
      || lease.boot_session_id !== generation.boot_session_id
    ) {
      throw codexError(
        'Codex retirement requires the exact active daemon lease',
        'CODEX_CHECKPOINT_STALE_GENERATION',
      );
    }
    const result = db.prepare(`
      UPDATE codex_generations
         SET state = 'retired', settled_ts = ?, updated_ts = ?
       WHERE generation_id = ?
         AND state != 'retired'
    `).run(ts, ts, generationId);
    const released = db.prepare(`
      UPDATE codex_daemon_lease
         SET generation_id = NULL,
             status = 'clear',
             quarantine_reason = NULL,
             updated_ts = ?,
             released_ts = ?
       WHERE singleton = 1
         AND generation_id = ?
         AND stable_host_id = ?
         AND boot_session_id = ?
         AND status = 'active'
    `).run(
      ts,
      ts,
      generationId,
      generation.stable_host_id,
      generation.boot_session_id,
    );
    if (result.changes !== 1 || released.changes !== 1) {
      throw codexError(
        'Codex retirement lost the exact generation lease',
        'CODEX_CHECKPOINT_STALE_GENERATION',
      );
    }
    return { changes: 1, retired: true };
  }

  function markCodexGenerationRetired(input) {
    const generationId = requiredCodexString(
      input?.generation_id,
      'generation ID',
    );
    const ts = requiredTimestamp(input?.ts ?? Date.now(), 'retirement timestamp');
    return db.transaction(() => retireCodexGeneration(generationId, ts))();
  }

  return {
    raw: db,

    insertMessage(row) {
      return insertMessageStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        msg_id: row.msg_id,
        user: row.user || null,
        user_id: row.user_id || null,
        text: durableText(row.text || ''),
        reply_to_id: row.reply_to_id || null,
        direction: row.direction || 'in',
        source: row.source || 'polygram',
        bot_name: row.bot_name || null,
        session_id: row.session_id || null,
        model: row.model || null,
        effort: row.effort || null,
        turn_id: row.turn_id || null,
        status: row.status || 'received',
        error: durableText(row.error) || null,
        cost_usd: row.cost_usd ?? null,
        ts: row.ts || Date.now(),
      });
    },

    insertOutboundPending(row) {
      return insertOutboundPendingStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        user: row.user || null,
        text: durableText(row.text || ''),
        source: row.source || 'polygram',
        bot_name: row.bot_name || null,
        turn_id: row.turn_id || null,
        session_id: row.session_id || null,
        ts: row.ts || Date.now(),
        pending_id: row.pending_id,
        reply_to_id: row.reply_to_id ?? null,
      });
    },

    markOutboundSent(id, { msg_id, ts }) {
      return markOutboundSentStmt.run({ id, msg_id, ts: ts || Date.now() });
    },

    markOutboundFailed(id, err) {
      return markOutboundFailedStmt.run({
        id,
        error: truncateAfterMask(durableText(String(err)), 500),
      });
    },

    updateOutboundText({ chat_id, msg_id, text, ts }) {
      if (chat_id == null || msg_id == null || typeof text !== 'string') return { changes: 0 };
      return updateOutboundTextStmt.run({
        chat_id: String(chat_id),
        msg_id: Number(msg_id),
        text: durableText(text),
        ts: ts || Date.now(),
      });
    },

    upsertSession(row) {
      return upsertLegacyAndProviderSession(row);
    },

    getSession(sessionKey) {
      return getSessionStmt.get(sessionKey);
    },

    upsertProviderSession(row) {
      return upsertProviderAndLegacySession(row);
    },

    getProviderSession(sessionKey, namespace) {
      if (!PROVIDER_NAMESPACES.has(namespace)) {
        throw new TypeError('provider session namespace is invalid');
      }
      return readProviderSession(String(sessionKey), namespace);
    },

    clearProviderSession(sessionKey, namespace) {
      if (!PROVIDER_NAMESPACES.has(namespace)) {
        throw new TypeError('provider session namespace is invalid');
      }
      return clearOneProviderSession(String(sessionKey), namespace);
    },

    touchSession(sessionKey, ts = Date.now()) {
      const row = getSessionStmt.get(sessionKey);
      const result = touchSessionStmt.run(ts, sessionKey);
      if (row) {
        touchProviderSessionStmt.run(
          ts,
          sessionKey,
          claudeNamespaceForStoredBackend(row.pm_backend),
        );
      }
      return result;
    },

    clearSessionId(sessionKey) {
      return clearLegacySession(sessionKey);
    },

    // 0.10.0: backend reassignment without resetting other session fields.
    // Used when ProcessManager spawns a Process with a different backend
    // than the persisted row says (drift event fires too).
    setSessionBackend(sessionKey, backend) {
      const row = getSessionStmt.get(sessionKey);
      const result = setSessionBackendStmt.run(backend, sessionKey);
      if (row) {
        const beforeNamespace = claudeNamespaceForStoredBackend(row.pm_backend);
        const afterNamespace = claudeNamespaceForStoredBackend(backend);
        if (beforeNamespace === afterNamespace) {
          setProviderBackendStmt.run(backend, sessionKey, beforeNamespace);
        }
      }
      return result;
    },

    createCodexGeneration,
    recordCodexCheckpoint,
    recordCodexDeliveryCheckpoint,
    getCodexAttempt(attemptId) {
      return db.prepare(`
        SELECT * FROM codex_turn_attempts WHERE attempt_id = ?
      `).get(attemptId);
    },
    listCodexAttemptCheckpoints(attemptId) {
      return db.prepare(`
        SELECT *
          FROM codex_attempt_checkpoints
         WHERE attempt_id = ?
         ORDER BY id
      `).all(attemptId);
    },
    claimCodexDispatchReservation,
    recordInboundRuntimeSelection,
    getReplayProviderRecovery,
    getCodexDispatchReservation(reservationId) {
      return readCodexDispatchReservation(requiredCodexString(
        reservationId,
        'dispatch reservation ID',
      ));
    },
    finalizeCodexAcceptedSteer,
    markCodexDispatchDisposition,
    settleCodexQueuedDispatch,
    settleCodexStoppedGeneration,
    linkCodexSteeringInput,
    claimCodexRetryReservation,
    markCodexRetryDispatched,
    retireCodexRetryReservation,
    recordCodexItemEffect,
    acquireCodexLease,
    getCodexLease() {
      return db.prepare(`
        SELECT * FROM codex_daemon_lease WHERE singleton = 1
      `).get();
    },
    markCodexContainment,
    markCodexGenerationRetired,
    settleCodexFailedGeneration(input) {
      return settleCodexFailedGeneration(db, input);
    },
    reconstructCodexRecovery(input) {
      return reconstructCodexRecovery(db, input);
    },
    listUnresolvedCodexAttempts(input) {
      return listUnresolvedCodexAttempts(db, input);
    },
    reconcileCodexAttempt(input) {
      return reconcileCodexAttempt(db, input);
    },
    pruneCodexOperationalData(options) {
      return pruneCodexOperationalData(db, options);
    },

    getMessage(chatId, msgId) {
      return getMessageStmt.get(String(chatId), msgId);
    },

    setMessageText({ chat_id, msg_id, text }) {
      return setMessageTextStmt.run({
        chat_id: String(chat_id),
        msg_id,
        text: durableText(text ?? ''),
      });
    },

    logChatMigration(oldChatId, newChatId, ts = Date.now()) {
      return logChatMigrationStmt.run(String(oldChatId), String(newChatId), ts);
    },

    resolveChatId(chatId) {
      const row = resolveChatIdStmt.get(String(chatId));
      return row?.new_chat_id || String(chatId);
    },

    // Telemetry passes two gates before it is persisted: the content-free
    // field schema decides WHICH fields may exist at all, then the durable
    // secret boundary masks recognized credentials in what survived. The
    // schema is the primary guarantee — masking alone would only remove
    // content a detector recognizes.
    logEvent(kind, { chat_id = null, ...detail } = {}) {
      const { detail: allowed, dropped, droppedCount } = enforceEventDetailSchema(detail);
      // The count is always safe to record; the names only when they came
      // from the schema's own vocabulary (an unknown key can be content).
      if (droppedCount) allowed.dropped_field_count = droppedCount;
      if (dropped.length) allowed.dropped_fields = dropped;
      return logEventStmt.run(
        Date.now(),
        chat_id ? String(chat_id) : null,
        kind,
        Object.keys(allowed).length
          ? JSON.stringify(sanitizeDurableStructured(allowed))
          : null,
      );
    },

    // Find compact-command events from the recent window that
    // never produced a matching compact-boundary on the same
    // session_key. These are "interrupted by deploy" cases — polygram
    // pushed /compact into SDK input but the daemon restarted before
    // the SDK could finish. The interrupted compact is lost; we
    // surface it to the user so they can re-run.
    //
    // Match logic: for each compact-command (with session_key in
    // detail_json), look for a compact-boundary with matching
    // session_key AND ts > compact_command.ts. If none within
    // search-window, it's orphaned.
    //
    // The command text itself is message content, so telemetry carries only
    // the id of the inbound message that holds it. The text is joined back
    // from that row — already sanitized by the durable-write boundary — and
    // is null when the row is gone or the event predates the id, which the
    // caller treats as "surface a retry notice instead of replaying".
    //
    // Events written before the hint moved out of telemetry still carry it in
    // their detail. Those stay recoverable, from the row when one exists and
    // otherwise from the stored copy, sanitized on the way out so a legacy
    // row cannot hand a credential back.
    //
    // @param {object} opts
    // @param {number} opts.olderThanMs - cutoff (only events newer than this are scanned)
    // @returns {Array<{ts, chat_id, thread_id, session_key, user, user_id, text_len, text}>}
    findOrphanedCompactCommands({ olderThanMs = 30 * 60 * 1000 } = {}) {
      const cutoff = Date.now() - olderThanMs;
      const cmds = db.prepare(`
        SELECT event.id, event.ts, event.chat_id,
               json_extract(event.detail_json, '$.thread_id')   AS thread_id,
               json_extract(event.detail_json, '$.session_key') AS session_key,
               json_extract(event.detail_json, '$.user_id')     AS user_id,
               json_extract(event.detail_json, '$.text_len')    AS text_len,
               source.text                                      AS row_text,
               json_extract(event.detail_json, '$.text')        AS legacy_text
          FROM events AS event
          LEFT JOIN messages AS source
            ON source.chat_id = event.chat_id
           AND source.msg_id = json_extract(event.detail_json, '$.msg_id')
           AND source.direction = 'in'
         WHERE event.kind = 'compact-command'
           AND event.ts > ?
         ORDER BY event.ts ASC, event.id ASC
      `).all(cutoff);
      const orphans = [];
      for (const c of cmds) {
        if (!c.session_key) continue; // older events without session_key — skip
        // Use id ordering rather than ts (events logged in the same
        // millisecond have ts equality but distinct id; strict ts >
        // would falsely orphan a command paired with a same-ms
        // boundary).
        const boundary = db.prepare(`
          SELECT id FROM events
           WHERE kind = 'compact-boundary'
             AND id > ?
             AND json_extract(detail_json, '$.session_key') = ?
           LIMIT 1
        `).get(c.id, c.session_key);
        if (boundary) continue;
        // Also skip if a previous boot has already handled
        // this orphan (silent replay via compact-replay event, OR
        // surface-fallback via compact-failed-restart event). Both
        // of those record `original_ts` in their detail_json
        // matching the original compact-command's ts. Without this
        // dedupe, every subsequent deploy re-surfaces / re-replays
        // the same orphan (annoying noise).
        const handled = db.prepare(`
          SELECT id FROM events
           WHERE kind IN ('compact-replay', 'compact-failed-restart')
             AND json_extract(detail_json, '$.original_ts') = ?
           LIMIT 1
        `).get(c.ts);
        if (handled) continue;
        const { row_text, legacy_text, ...rest } = c;
        // Both sources are sanitized on the way out. The row is normally
        // masked at write, but rows written before this boundary existed are
        // not — and those are exactly the oldest, most likely to be replayed.
        const recovered = row_text ?? legacy_text;
        orphans.push({
          ...rest,
          text: recovered != null ? durableText(recovered) : null,
        });
      }
      return orphans;
    },

    insertTurnMetric(row) {
      return insertTurnMetricStmt.run({
        ts: row.ts || Date.now(),
        chat_id: String(row.chat_id),
        thread_id: row.thread_id != null ? String(row.thread_id) : null,
        msg_id: row.msg_id,
        session_id: row.session_id || null,
        bot_name: row.bot_name || null,
        model: row.model || null,
        effort: row.effort || null,
        input_tokens: row.input_tokens ?? null,
        output_tokens: row.output_tokens ?? null,
        cache_creation_tokens: row.cache_creation_tokens ?? null,
        cache_read_tokens: row.cache_read_tokens ?? null,
        cost_usd: row.cost_usd ?? null,
        duration_ms: row.duration_ms ?? null,
        num_assistant_messages: row.num_assistant_messages ?? null,
        num_tool_uses: row.num_tool_uses ?? null,
        result_subtype: row.result_subtype || null,
        // The turn's failure text can echo the provider's own output.
        error: durableText(row.error) || null,
      });
    },

    /**
     * 0.8.0 Phase 1 step 8 — chat_tool_decisions persistence.
     *
     * Look up "always allow / always deny" decisions for a tool
     * call. Returns the FIRST matching decision (by id ASC) whose
     * match_type accepts the canonical input. Pattern matching is
     * done in-process here so the SQL query stays simple.
     *
     * Canonical input: keys sorted alphabetically, no whitespace.
     * Done by the caller (canUseTool wrapper) — we accept the
     * pre-canonicalised string as `canonical_input`.
     */
    lookupChatToolDecision({ bot_name, chat_id, tool_name, canonical_input, now }) {
      const rows = lookupChatToolDecisionsStmt.all({
        bot_name: String(bot_name),
        chat_id: String(chat_id),
        tool_name: String(tool_name),
        now: now || Date.now(),
      });
      for (const r of rows) {
        if (r.match_type === 'exact') {
          if (r.input_pattern === canonical_input) return r;
        } else if (r.match_type === 'prefix') {
          if (canonical_input?.startsWith?.(r.input_pattern)) return r;
        } else if (r.match_type === 'regex') {
          try {
            if (new RegExp(r.input_pattern).test(canonical_input || '')) return r;
          } catch { /* malformed regex — ignore */ }
        }
      }
      return null;
    },

    insertChatToolDecision(row) {
      return insertChatToolDecisionStmt.run({
        bot_name: String(row.bot_name),
        chat_id: String(row.chat_id),
        tool_name: String(row.tool_name),
        match_type: row.match_type,
        // The pattern is derived from a tool input, so it can carry a
        // credential into durable storage. Masking it means a rule whose
        // pattern contained one no longer matches that live input: the call
        // falls through to a fresh approval prompt rather than silently
        // auto-allowing or auto-denying it.
        input_pattern: durableText(row.input_pattern),
        decision: row.decision,
        issued_ts: row.issued_ts || Date.now(),
        issued_by_user_id: row.issued_by_user_id != null
          ? String(row.issued_by_user_id) : null,
        expires_ts: row.expires_ts ?? null,
      });
    },

    deleteChatToolDecision({ bot_name, chat_id, id }) {
      return deleteChatToolDecisionStmt.run(String(bot_name), String(chat_id), id);
    },

    logConfigChanges(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new TypeError('config change rows are required');
      }
      return db.transaction(() => rows.map((row) => logConfigChangeStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        field: row.field,
        old_value: configChangeValue(row.old_value, {
          nullable: true,
          label: 'old_value',
        }),
        new_value: configChangeValue(row.new_value, {
          nullable: false,
          label: 'new_value',
        }),
        user_id: row.user_id || null,
        user: row.user || null,
        source: row.source || 'command',
        ts: row.ts || Date.now(),
      })))();
    },

    logConfigChange(row) {
      return logConfigChangeStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        field: row.field,
        old_value: configChangeValue(row.old_value, {
          nullable: true,
          label: 'old_value',
        }),
        new_value: configChangeValue(row.new_value, {
          nullable: false,
          label: 'new_value',
        }),
        user_id: row.user_id || null,
        user: row.user || null,
        source: row.source || 'command',
        ts: row.ts || Date.now(),
      });
    },

    markStalePending(olderThanMs = 60_000, botName = null) {
      const cutoff = Date.now() - olderThanMs;
      if (botName) return markStalePendingForBotStmt.run(cutoff, botName);
      return markStalePendingStmt.run(cutoff);
    },

    // Polling offset persistence — see migrations/005-polling-state.sql.
    // Exposed as its own pair of calls (not lazy-prepared) so tests can
    // round-trip them without going through the full polygram boot flow.
    getPollingOffset(botName) {
      const row = db.prepare('SELECT last_update_id FROM polling_state WHERE bot_name = ?').get(botName);
      return row?.last_update_id ?? 0;
    },
    savePollingOffset(botName, lastUpdateId) {
      db.prepare(`
        INSERT INTO polling_state (bot_name, last_update_id, ts)
        VALUES (?, ?, ?)
        ON CONFLICT(bot_name) DO UPDATE SET last_update_id = excluded.last_update_id, ts = excluded.ts
      `).run(botName, lastUpdateId, Date.now());
    },

    // Inbound handler lifecycle — see migrations/006-inbound-handler-status.sql.
    // Called by handleMessage as the turn progresses. Used by boot replay to
    // find work that was interrupted by a crash or restart.
    setInboundHandlerStatus({ chat_id, msg_id, status }) {
      return db.prepare(`
        UPDATE messages SET handler_status = ?
        WHERE chat_id = ? AND msg_id = ? AND direction = 'in'
      `).run(status, chat_id, msg_id);
    },
    setInboundHandlerStatusUnlessCodexTerminal({ chat_id, msg_id, status }) {
      return db.prepare(`
        UPDATE messages SET handler_status = ?
        WHERE chat_id = ? AND msg_id = ? AND direction = 'in'
          AND handler_status NOT IN ('codex-ambiguous', 'failed')
      `).run(status, chat_id, msg_id);
    },
    completeAcceptedClaudeAutosteer({ chat_id, msg_id }) {
      let result;
      try {
        result = completeAcceptedClaudeAutosteerStmt.run(chat_id, msg_id);
      } catch (cause) {
        const error = new Error(
          'accepted Claude follow-up handler status could not be persisted',
          { cause },
        );
        error.code = 'CLAUDE_AUTOSTEER_STATUS_PERSIST_FAILED';
        throw error;
      }
      if (result.changes !== 1) {
        const error = new Error(
          'accepted Claude follow-up did not own one live inbound row',
        );
        error.code = 'CLAUDE_AUTOSTEER_STATUS_CONFLICT';
        throw error;
      }
      return result;
    },

    // 0.9.0: True when a specific inbound msg is still being processed
    // by the SDK turn loop (handler_status in dispatched/processing).
    // Used by the edit-correction injector — only inject a typo-fix
    // note when the SDK actually still has the turn in flight.
    isInboundLive({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT 1 FROM messages
        WHERE chat_id = ? AND msg_id = ? AND direction = 'in'
          AND handler_status IN ('dispatched', 'processing')
        LIMIT 1
      `).get(chat_id, msg_id);
      return !!row;
    },

    // Find inbound messages that were being processed when polygram stopped.
    // Scoped by bot_name via the chat_id → config mapping, so each bot only
    // replays its own turns on boot. Scoped by olderThanMs (default 3 min)
    // so we never resurrect ancient messages — anything older than a few
    // minutes is from before the user moved on, replaying it just confuses
    // the conversation.
    getReplayCandidates({ chatIds, olderThanMs = 3 * 60 * 1000, limit = 100 } = {}) {
      if (!Array.isArray(chatIds) || chatIds.length === 0) return [];
      const cutoff = Date.now() - olderThanMs;
      const placeholders = chatIds.map(() => '?').join(',');
      return db.prepare(`
        SELECT id, chat_id, thread_id, msg_id, user, user_id, text, reply_to_id,
               ts, handler_status
          FROM messages
         WHERE direction = 'in'
           AND handler_status IN ('dispatched', 'processing', 'replay-pending')
           AND chat_id IN (${placeholders})
           AND ts > ?
         ORDER BY ts ASC
         LIMIT ?
      `).all(...chatIds, cutoff, limit);
    },

    // Dedupe check: did we already send an outbound reply to this inbound?
    // Prevents double-processing if a redelivered/replayed message has
    // already been answered.
    //
    // Three states count as "probably sent":
    //   - 'sent': the happy path.
    //   - 'failed' with error='crashed-mid-send': polygram crashed
    //     after inserting the pending row but before markOutboundSent.
    //     The boot-time markStalePending sweep flipped them to this.
    //   - 'pending' (0.6.14): markStalePending only flips rows older
    //     than 60s, so a fast restart (boot replay fires in &lt;60s) leaves
    //     fresh pending rows in 'pending' state. Without counting them
    //     here, the inbound looks unanswered and gets re-dispatched →
    //     Telegram already delivered the original reply → duplicate.
    //
    // Treating ambiguous states as "replied" costs us occasional missed
    // replies (recoverable: user resends) to prevent duplicates
    // (irrecoverable: user has to mentally dedupe two answers).
    // rc.51: stricter dedupe than hasOutboundReplyTo for boot-replay.
    // A `turn_metrics` row is only inserted when a turn definitively
    // completes (onResult callback). If no row exists for this inbound
    // msg_id, the turn never finished — even if intermediate ack-bubbles
    // were already sent. The rc.50 incident's lost msg 12158 had a
    // partial "I'll write a quick inline script..." outbound but no
    // turn_metrics, and was being silently skipped by replay-dedupe.
    //
    // Caveat: a row whose `error` is set (transient/aborted/timeout)
    // does NOT count as complete — the turn started but failed. Boot
    // replay should redispatch within window so the user gets a real
    // answer.
    hasCompletedTurnFor({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT 1 FROM turn_metrics
         WHERE chat_id = ? AND msg_id = ? AND error IS NULL
         LIMIT 1
      `).get(String(chat_id), msg_id);
      return !!row;
    },

    hasOutboundReplyTo({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT 1 FROM messages
         WHERE chat_id = ? AND direction = 'out' AND reply_to_id = ?
           AND (
             status = 'sent'
             OR status = 'pending'
             OR (status = 'failed' AND error = '${CRASHED_MID_SEND}')
           )
         LIMIT 1
      `).get(chat_id, msg_id);
      return !!row;
    },

    // On shutdown, mark any inbound rows still in-flight so the boot replay
    // knows to pick them up. `sessionKey`s narrow the update to the sessions
    // we're draining (useful if we ever do partial shutdown; otherwise leave
    // null to mark all dispatched/processing rows for a bot).
    markReplayPending({ botName, since }) {
      const cutoff = since ?? Date.now() - 30 * 60 * 1000;
      return markReplayPendingStmt.run(botName, cutoff);
    },

    // 0.14 boot-replay: record a DELIBERATE (clean) shutdown. Atomically, in ONE
    // transaction: (a) mark still-in-flight inbound rows replay-pending (so a
    // deliberate restart that interrupted a long turn still recovers it), and
    // (b) stamp polling_state.clean_shutdown_at so boot can tell clean from
    // crash. Written UNCONDITIONALLY on every clean shutdown — NOT gated on
    // in-flight count — because a stale replay-pending row from a prior life
    // must NOT be crash-recovered (re-answered) on a deliberate restart.
    //
    // The upsert satisfies polling_state's NOT NULL last_update_id/ts (migration
    // 005) for a fresh/quiet bot that has no row yet (a row is otherwise created
    // only on a non-empty getUpdates batch): COALESCE the existing values, else
    // seed (0, now).
    recordCleanShutdown({
      botName,
      now = Date.now(),
      since,
      resumeIntents = [],
      continuationAuthorized = false,
    } = {}) {
      return recordShutdown({
        botName,
        now,
        since,
        clean: true,
        resumeIntents,
        continuationAuthorized,
      });
    },

    // A handled stop can still be crash-like when the supervisor is stopping
    // the service after a child OOM. Mark current work replayable and clear any
    // clean marker in one transaction so the next boot fails toward recovery.
    recordCrashShutdown({ botName, now = Date.now(), since } = {}) {
      return recordShutdown({ botName, now, since, clean: false });
    },

    // Atomically consumes one clean-shutdown epoch and claims every matching
    // continuation intent before any process can spawn or polling can begin.
    // Unsupported policies and replaced sessions are still tombstoned so a
    // later boot cannot reinterpret them as original-message crash replay.
    claimCleanRestartRecovery({
      botName,
      now = Date.now(),
      maxAgeMs,
      supportedPolicyVersions = [],
      olderThanMs = 30 * 60 * 1000,
    } = {}) {
      const supported = new Set(supportedPolicyVersions);
      const cutoff = now - olderThanMs;
      const txn = db.transaction(() => {
        const stranded = db.prepare(`
          SELECT id, chat_id, thread_id, msg_id, user, user_id, text,
                 reply_to_id, ts, handler_status, bot_name
            FROM messages
           WHERE direction = 'in'
             AND bot_name = ?
             AND handler_status = 'resume-attempted'
             AND ts > ?
           ORDER BY ts, id
        `).all(botName, cutoff);

        const markerRow = db.prepare(`
          SELECT clean_shutdown_at
            FROM polling_state
           WHERE bot_name = ?
        `).get(botName);
        const markerAt = markerRow?.clean_shutdown_at ?? null;
        const age = typeof markerAt === 'number' ? now - markerAt : null;
        const clean = age != null
          && age >= 0
          && (maxAgeMs == null || age <= maxAgeMs);

        const rows = clean
          ? db.prepare(`
              SELECT intent.*,
                     source.id AS source_id,
                     source.chat_id,
                     source.thread_id,
                     source.msg_id,
                     source.bot_name AS source_bot_name,
                     source.direction AS source_direction,
                     runtime.generation_id AS current_generation_id,
                     runtime.provider_session_id,
                     runtime.namespace AS provider_namespace,
                     runtime.pm_backend,
                     runtime.spawn_profile_id AS current_spawn_profile_id
                FROM clean_restart_resume_intents AS intent
                LEFT JOIN messages AS source
                  ON source.id = intent.source_message_id
                LEFT JOIN agent_runtime_sessions AS runtime
                  ON runtime.session_key = intent.session_key
                 AND runtime.namespace = CASE
                   WHEN intent.interrupted_provider_turn_id IS NULL
                     THEN '${CLAUDE_CHANNELS_NAMESPACE}'
                   ELSE '${CODEX_APP_SERVER_NAMESPACE}'
                 END
               WHERE intent.bot_name = ?
                 AND intent.shutdown_at = ?
               ORDER BY intent.session_key
            `).all(botName, markerAt)
          : [];

        deleteCleanRestartIntentsStmt.run(botName);
        if (markerAt != null) clearCleanShutdownMarkerStmt.run(botName);

        const claims = rows.map((row) => {
          const sourceMatches = row.source_id != null
            && row.source_direction === 'in'
            && row.source_bot_name === botName;
          if (sourceMatches) {
            db.prepare(`
              UPDATE messages
                 SET handler_status = 'resume-attempted'
               WHERE id = ?
                 AND direction = 'in'
                 AND bot_name = ?
            `).run(row.source_message_id, botName);
          }

          let reason = null;
          const hasInterruptedTurn =
            typeof row.interrupted_provider_turn_id === 'string'
            && row.interrupted_provider_turn_id.length > 0;
          const hasInterruptedProfile =
            typeof row.interrupted_spawn_profile_id === 'string'
            && row.interrupted_spawn_profile_id.length > 0;
          const codexShaped = row.interrupted_provider_turn_id != null
            || row.interrupted_spawn_profile_id != null
            || row.provider_namespace === CODEX_APP_SERVER_NAMESPACE;
          if (!sourceMatches) {
            reason = 'source-message-missing';
          } else if (row.continuation_authorized !== 1) {
            reason = 'unauthorized-restart';
          } else if (
            codexShaped
            && (
              row.policy_version !== 2
              || !hasInterruptedTurn
              || !hasInterruptedProfile
            )
          ) {
            reason = 'unsupported-codex-policy';
          } else if (!supported.has(row.policy_version)) {
            reason = 'unsupported-policy-version';
          } else if (
            typeof row.current_generation_id !== 'string'
            || row.current_generation_id.length === 0
            || row.current_generation_id !== row.session_generation_id
          ) {
            reason = 'session-generation-replaced';
          } else if (
            row.interrupted_spawn_profile_id != null
            && row.current_spawn_profile_id
              !== row.interrupted_spawn_profile_id
          ) {
            reason = 'spawn-profile-replaced';
          }

          return {
            bot_name: row.bot_name,
            session_key: row.session_key,
            session_generation_id: row.session_generation_id,
            source_message_id: row.source_message_id,
            shutdown_at: row.shutdown_at,
            policy_version: row.policy_version,
            provider_namespace: reason == null ? row.provider_namespace : null,
            provider_session_id: reason == null ? row.provider_session_id : null,
            pm_backend: reason == null ? row.pm_backend : null,
            interrupted_provider_turn_id:
              row.interrupted_provider_turn_id,
            interrupted_spawn_profile_id:
              row.interrupted_spawn_profile_id,
            current_spawn_profile_id: reason == null
              ? row.current_spawn_profile_id
              : null,
            executable: reason == null,
            reason,
          };
        });

        return { clean, markerAt, claims, stranded };
      });
      return txn();
    },

    completeCleanRestartRecovery({ sourceMessageId, status }) {
      if (!['replied', 'replay-skipped'].includes(status)) {
        throw new TypeError('clean restart recovery terminal status is invalid');
      }
      return db.prepare(`
        UPDATE messages
           SET handler_status = ?
         WHERE id = ?
           AND direction = 'in'
           AND handler_status = 'resume-attempted'
      `).run(status, sourceMessageId);
    },

    // 0.14: read AND clear the clean-shutdown marker in one txn. "Clean" iff a
    // marker is present, not future-dated (clock skew → crash), and within
    // maxAgeMs (derived from the replay window). Clear-on-read so a marker from
    // a prior boot can never be inherited as "clean" after a later crash. Any
    // ambiguity ⇒ clean:false (the caller treats that as crash → recover).
    consumeCleanShutdownMarker({ botName, now = Date.now(), maxAgeMs }) {
      const txn = db.transaction(() => {
        const row = db.prepare('SELECT clean_shutdown_at FROM polling_state WHERE bot_name = ?').get(botName);
        const at = row ? row.clean_shutdown_at : null;
        if (row && at != null) {
          clearCleanShutdownMarkerStmt.run(botName);
        }
        return at;
      });
      const at = txn();
      const age = typeof at === 'number' ? now - at : null;
      const clean = age != null && age >= 0 && (maxAgeMs == null || age <= maxAgeMs);
      return { clean, markerAt: at };
    },

    // 0.15: redact an agent-REPORTED secret (via the [redact:<secret>] reply
    // marker) from recent inbound messages in a chat/thread. Literal substring
    // replace (no regex/LIKE wildcards), scanned over the last `limit` inbound
    // rows so we don't touch unrelated history, audited by fingerprint. FTS
    // re-indexes via the UPDATE trigger. Returns how many messages were changed.
    //
    // limit=200: the agent normally flags a secret in the same turn it arrives
    // (so the row is among the most-recent inbound), but a busy group chat can
    // interleave many messages before the flagging turn lands — 200 covers that
    // tail. The background sweep (lib/db/secret-sweep.js) is the unbounded
    // catch-all for known-shape secrets that fall outside this window. Callers
    // log when a redaction was requested but matched 0 rows (fail-loud signal).
    redactSecretInChat({ chat_id, thread_id = null, secret, now = Date.now(), limit = 200 }) {
      if (typeof secret !== 'string' || secret.length < 3) return { redacted: 0 };
      const PLACEHOLDER = '‹redacted:reported›';
      const rows = (thread_id != null
        ? db.prepare(`SELECT id, msg_id, text FROM messages WHERE chat_id=? AND thread_id=? AND direction='in' ORDER BY id DESC LIMIT ?`).all(String(chat_id), String(thread_id), limit)
        : db.prepare(`SELECT id, msg_id, text FROM messages WHERE chat_id=? AND direction='in' ORDER BY id DESC LIMIT ?`).all(String(chat_id), limit));
      let redacted = 0;
      const txn = db.transaction(() => {
        for (const r of rows) {
          if (!r.text || !r.text.includes(secret)) continue;
          const newText = r.text.split(secret).join(PLACEHOLDER);
          db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(newText, r.id);
          db.prepare(`INSERT INTO secret_redactions (chat_id, msg_id, rule, tier, length, action, ts)
                      VALUES (?,?,?,?,?,?,?)`).run(String(chat_id), r.msg_id, 'reported', 'reported', secret.length, 'redacted', now);
          redacted += 1;
        }
      });
      txn();
      return { redacted };
    },

    // ─── Attachments (migration 007, polygram 0.6.0) ──────────────────
    //
    // Replaces the messages.attachments_json blob. Each attachment is its
    // own row with lifecycle (`pending` → `downloaded` | `failed`),
    // searchable by chat / kind / time. recordInbound now inserts these
    // alongside the message in a transaction; downloadAttachments updates
    // status as it processes each file. See docs/attachments-table.md.

    insertAttachment({
      message_id, chat_id, msg_id, thread_id, bot_name,
      file_id, file_unique_id, kind, name, mime_type, size_bytes,
      ts,
    }) {
      return db.prepare(`
        INSERT INTO attachments (
          message_id, chat_id, msg_id, thread_id, bot_name,
          file_id, file_unique_id, kind, name, mime_type, size_bytes,
          download_status, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        message_id,
        String(chat_id),
        msg_id,
        thread_id ? String(thread_id) : null,
        bot_name || null,
        file_id,
        file_unique_id || null,
        kind,
        // A user-supplied filename can carry a declared credential.
        durableText(name) || null,
        mime_type || null,
        size_bytes ?? null,
        ts || Date.now(),
      );
    },

    markAttachmentDownloaded(id, { local_path, size_bytes }) {
      return db.prepare(`
        UPDATE attachments
           SET download_status = 'downloaded',
               local_path = ?,
               size_bytes = COALESCE(?, size_bytes),
               download_error = NULL
         WHERE id = ?
      `).run(local_path, size_bytes ?? null, id);
    },

    markAttachmentFailed(id, error) {
      return db.prepare(`
        UPDATE attachments
           SET download_status = 'failed',
               download_error = ?
         WHERE id = ?
      `).run(truncateAfterMask(durableText(String(error || 'unknown')), 500), id);
    },

    setAttachmentTranscription(id, text) {
      return db.prepare(`
        UPDATE attachments SET transcription = ? WHERE id = ?
      `).run(durableJson(text) || null, id);
    },

    getAttachmentsByMessage(message_id) {
      return db.prepare(`
        SELECT id, message_id, chat_id, msg_id, thread_id, bot_name,
               file_id, file_unique_id, kind, name, mime_type, size_bytes,
               local_path, download_status, download_error, transcription, ts
          FROM attachments
         WHERE message_id = ?
         ORDER BY id ASC
      `).all(message_id);
    },

    // Rich filter for ops queries. All filters are optional; with no filters
    // returns the most recent 100. Caller can paginate via since/until.
    searchAttachments({
      chat_id = null,
      kind = null,
      status = null,
      since = null,
      until = null,
      limit = 100,
    } = {}) {
      const where = [];
      const args = [];
      if (chat_id !== null) { where.push('chat_id = ?'); args.push(String(chat_id)); }
      if (kind !== null)    { where.push('kind = ?');    args.push(kind); }
      if (status !== null)  { where.push('download_status = ?'); args.push(status); }
      if (since !== null)   { where.push('ts >= ?');     args.push(Number(since)); }
      if (until !== null)   { where.push('ts <= ?');     args.push(Number(until)); }
      const sql = `
        SELECT id, message_id, chat_id, msg_id, thread_id, bot_name,
               file_id, file_unique_id, kind, name, mime_type, size_bytes,
               local_path, download_status, download_error, transcription, ts
          FROM attachments
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY ts DESC
         LIMIT ?
      `;
      args.push(Number(limit));
      return db.prepare(sql).all(...args);
    },

    // Re-FK every attachment whose (chat_id, msg_id) is in `msg_ids` over
    // to a single primary message row. Used when the media-group buffer
    // coalesces N Telegram messages (each carrying one photo of an album)
    // into one synthetic turn — siblings were recorded under their own
    // msg_ids by recordInbound, but Claude needs to see them all under
    // the primary message so handleMessage's per-message attachment
    // lookup returns the full album.
    reassignAttachmentsToMessage({ chat_id, msg_ids, target_message_id }) {
      if (!Array.isArray(msg_ids) || msg_ids.length === 0) return { changes: 0 };
      const placeholders = msg_ids.map(() => '?').join(',');
      return db.prepare(`
        UPDATE attachments
           SET message_id = ?, msg_id = (SELECT msg_id FROM messages WHERE id = ?)
         WHERE chat_id = ? AND msg_id IN (${placeholders})
           AND message_id != ?
      `).run(target_message_id, target_message_id, String(chat_id), ...msg_ids, target_message_id);
    },

    // Look up the messages.id auto-pk for an inbound message. Used by
    // recordInbound to FK attachments to the just-inserted message even
    // when an ON-CONFLICT update happened (lastInsertRowid is 0 in that
    // case, so we can't rely on the run-result alone).
    getInboundMessageId({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT id FROM messages WHERE chat_id = ? AND msg_id = ? AND direction = 'in'
      `).get(String(chat_id), msg_id);
      return row ? row.id : null;
    },

    getInboundMessageById(messageId) {
      return db.prepare(`
        SELECT *
          FROM messages
         WHERE id = ?
           AND direction = 'in'
      `).get(messageId);
    },

    getForegroundCanaryTarget({ botName, chatId, telegramMessageId }) {
      const messageIdText = String(telegramMessageId);
      const messageId = Number(messageIdText);
      if (
        !Number.isSafeInteger(messageId)
        || messageId <= 0
        || String(messageId) !== messageIdText
      ) return null;
      const row = getForegroundCanaryTargetStmt.get(
        messageIdText,
        String(botName),
        String(chatId),
        messageId,
      );
      if (!row) return null;
      return {
        messageId: row.message_id,
        chatId: String(row.chat_id),
        threadId: row.thread_id == null ? null : String(row.thread_id),
        telegramMessageId: row.telegram_message_id,
        sessionKey: row.session_key,
        provider: row.provider,
        handlerStatus: row.handler_status,
      };
    },

    listFailedAttachments({ since = null, limit = 100 } = {}) {
      const cutoff = since ?? Date.now() - 24 * 60 * 60 * 1000;
      return db.prepare(`
        SELECT id, message_id, chat_id, msg_id, kind, name, mime_type,
               download_error, ts
          FROM attachments
         WHERE download_status = 'failed' AND ts >= ?
         ORDER BY ts DESC
         LIMIT ?
      `).all(cutoff, limit);
    },
  };
}

module.exports = { open, CRASHED_MID_SEND };

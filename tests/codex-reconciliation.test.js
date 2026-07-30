'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  freshDb,
  cleanupDb,
  insertInbound,
} = require('./helpers/db-fixture');
const {
  CODEX_APP_SERVER_NAMESPACE,
} = require('../lib/db/sessions');

let db;
let dbPath;

const identity = {
  stable_host_id: 'host-a',
  boot_session_id: 'boot-a',
};

function seedAmbiguousAttempt() {
  db.createCodexGeneration({
    generation_id: 'generation-a',
    session_key: 'chat-a',
    thread_id: 'thread-a',
    ...identity,
    ts: 1000,
  });
  db.recordCodexCheckpoint({
    kind: 'request-prepared',
    generationId: 'generation-a',
    attemptId: 'attempt-a',
    method: 'turn/start',
    threadId: 'thread-a',
    ...identity,
    ts: 1100,
  });
  db.acquireCodexLease({
    generation_id: 'generation-a',
    ...identity,
    ts: 1150,
  });
  db.recordCodexCheckpoint({
    kind: 'request-write-attempted',
    generationId: 'generation-a',
    attemptId: 'attempt-a',
    method: 'turn/start',
    requestId: '1',
    threadId: 'thread-a',
    ...identity,
    ts: 1200,
  });
  db.recordCodexCheckpoint({
    kind: 'failed-ambiguous-entered',
    generationId: 'generation-a',
    attemptId: 'attempt-a',
    threadId: 'thread-a',
    reason: 'transport-lost',
    ...identity,
    ts: 1300,
  });
}

function markGenerationDead(ts = 1400) {
  db.markCodexContainment({
    generation_id: 'generation-a',
    reason: 'transport-lost',
    ...identity,
    ts,
  });
}

test('failed generation settlement is one exact non-replayable DB transaction', () => {
  ({ db, dbPath } = freshDb('polygram-codex-failed-settlement'));
  try {
    seedAmbiguousAttempt();
    db.acquireCodexLease({
      generation_id: 'generation-a',
      ...identity,
      ts: 1400,
    });
    db.markCodexContainment({
      generation_id: 'generation-a',
      reason: 'unexpected-turn-start',
      ...identity,
      ts: 1500,
    });
    db.upsertProviderSession({
      session_key: 'chat-a',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'thread-a',
      app_server_session_id: 'app-server-a',
      generation_id: 'provider-epoch-a',
      pm_backend: 'codex',
      ts: 1550,
    });
    db.upsertProviderSession({
      session_key: 'chat-a',
      namespace: 'claude:inline',
      provider: 'claude',
      provider_session_id: 'claude-session-a',
      app_server_session_id: null,
      generation_id: 'claude-provider-epoch-a',
      pm_backend: 'sdk',
      ts: 1550,
    });
    for (const msgId of [42, 43, 44, 45]) {
      insertInbound(db, {
        chat_id: 'chat-a',
        msg_id: msgId,
        bot_name: 'test-bot',
        text: `input-${msgId}`,
        handler_status: 'dispatched',
        ts: 1550,
      });
      if (msgId < 44) {
        db.recordInboundRuntimeSelection({
          session_key: 'chat-a',
          bot_name: 'test-bot',
          telegram_chat_id: 'chat-a',
          telegram_message_id: String(msgId),
          provider: 'codex',
          ts: 1550,
        });
      }
    }
    db.raw.prepare(`
      UPDATE codex_turn_attempts
         SET telegram_source_message_id = '42'
       WHERE attempt_id = 'attempt-a'
    `).run();
    db.createCodexGeneration({
      generation_id: 'generation-other',
      session_key: 'chat-other',
      thread_id: 'thread-other',
      ...identity,
      ts: 1560,
    });
    db.raw.prepare(`
      INSERT INTO codex_dispatch_reservations (
        reservation_id, generation_id, session_key, bot_name,
        telegram_chat_id, telegram_message_id, state, created_ts, updated_ts
      ) VALUES
        ('reservation-only', 'generation-a', 'chat-a', 'test-bot',
         'chat-a', '44', 'reserved', 1560, 1560),
        ('reservation-other', 'generation-other', 'chat-other', 'test-bot',
         'chat-a', '45', 'reserved', 1560, 1560)
    `).run();

    const settlement = {
      generation_id: 'generation-a',
      session_key: 'chat-a',
      stable_host_id: 'host-a',
      incident_boot_session_id: 'boot-a',
      current_boot_session_id: 'boot-a',
      provider_session_id: 'thread-a',
      app_server_session_id: 'app-server-a',
      reason: 'unexpected-turn-start',
      source: 'managed-group-empty',
      allow_missing_generation: false,
      ts: 1600,
    };
    assert.deepEqual(db.settleCodexFailedGeneration(settlement), {
      committed: true,
      disposition: 'failed-settled',
      generationId: 'generation-a',
    });
    assert.deepEqual(db.settleCodexFailedGeneration(settlement), {
      committed: true,
      disposition: 'failed-settled',
      generationId: 'generation-a',
    });

    assert.equal(db.getCodexAttempt('attempt-a').recovery_state, 'ambiguous');
    assert.equal(db.getCodexLease().status, 'clear');
    assert.equal(db.getMessage('chat-a', 42).handler_status, 'codex-ambiguous');
    assert.equal(
      db.getMessage('chat-a', 43).handler_status,
      'dispatched',
      'a later selected input waiting on the session lock remains untouched',
    );
    assert.equal(db.getMessage('chat-a', 44).handler_status, 'failed');
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_dispatch_reservations
         WHERE reservation_id = 'reservation-only'
      `).get().state,
      'cancelled',
    );
    assert.equal(db.getMessage('chat-a', 45).handler_status, 'dispatched');
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_dispatch_reservations
         WHERE reservation_id = 'reservation-other'
      `).get().state,
      'reserved',
    );
    assert.equal(
      db.getProviderSession('chat-a', CODEX_APP_SERVER_NAMESPACE),
      undefined,
    );
    assert.equal(
      db.getProviderSession('chat-a', 'claude:inline').provider_session_id,
      'claude-session-a',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-a'
           AND kind = 'containment-cleanup-completed'
      `).get().count,
      1,
    );
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM codex_reboot_releases')
        .get().count,
      0,
    );
  } finally {
    cleanupDb(dbPath, db);
  }
});

test('managed cleanup settles an exact durable active generation after containment checkpoint failure', () => {
  ({ db, dbPath } = freshDb('polygram-codex-active-managed-cleanup'));
  try {
    db.createCodexGeneration({
      generation_id: 'generation-active-cleanup',
      session_key: 'chat-active-cleanup',
      thread_id: 'thread-active-cleanup',
      app_server_session_id: 'app-server-active-cleanup',
      ...identity,
      ts: 1000,
    });
    db.recordCodexCheckpoint({
      kind: 'request-prepared',
      generationId: 'generation-active-cleanup',
      attemptId: 'attempt-active-cleanup',
      method: 'turn/start',
      threadId: 'thread-active-cleanup',
      ...identity,
      ts: 1050,
    });
    db.acquireCodexLease({
      generation_id: 'generation-active-cleanup',
      ...identity,
      ts: 1100,
    });
    insertInbound(db, {
      chat_id: 'chat-active-cleanup',
      msg_id: 601,
      bot_name: 'test-bot',
      text: 'input-601',
      handler_status: 'dispatched',
      ts: 1150,
    });
    db.recordInboundRuntimeSelection({
      session_key: 'chat-active-cleanup',
      bot_name: 'test-bot',
      telegram_chat_id: 'chat-active-cleanup',
      telegram_message_id: '601',
      provider: 'codex',
      ts: 1150,
    });
    db.raw.prepare(`
      UPDATE codex_turn_attempts
         SET telegram_source_message_id = '601'
       WHERE attempt_id = 'attempt-active-cleanup'
    `).run();
    db.upsertProviderSession({
      session_key: 'chat-active-cleanup',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'thread-active-cleanup',
      app_server_session_id: 'app-server-active-cleanup',
      generation_id: 'provider-epoch-active-cleanup',
      pm_backend: 'codex',
      ts: 1150,
    });
    assert.equal(
      db.raw.prepare(`
        SELECT state
          FROM codex_generations
         WHERE generation_id = 'generation-active-cleanup'
      `).get().state,
      'active',
    );
    assert.equal(db.getCodexLease().status, 'active');
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-active-cleanup'
           AND kind = 'containment-entered'
      `).get().count,
      0,
    );

    assert.deepEqual(db.settleCodexFailedGeneration({
      generation_id: 'generation-active-cleanup',
      session_key: 'chat-active-cleanup',
      stable_host_id: 'host-a',
      incident_boot_session_id: 'boot-a',
      current_boot_session_id: 'boot-a',
      provider_session_id: 'thread-active-cleanup',
      app_server_session_id: 'app-server-active-cleanup',
      reason: 'containment-entered-checkpoint-failed',
      source: 'managed-group-empty',
      allow_missing_generation: false,
      ts: 1200,
    }), {
      committed: true,
      disposition: 'failed-settled',
      generationId: 'generation-active-cleanup',
    });

    assert.deepEqual(
      db.raw.prepare(`
        SELECT state, containment_reason, settled_ts
          FROM codex_generations
         WHERE generation_id = 'generation-active-cleanup'
      `).get(),
      {
        state: 'containment-failed',
        containment_reason: 'containment-entered-checkpoint-failed',
        settled_ts: 1200,
      },
    );
    assert.deepEqual(
      {
        recovery_state:
          db.getCodexAttempt('attempt-active-cleanup').recovery_state,
        terminal_status:
          db.getCodexAttempt('attempt-active-cleanup').terminal_status,
        settled_ts: db.getCodexAttempt('attempt-active-cleanup').settled_ts,
      },
      {
        recovery_state: 'cancelled',
        terminal_status: 'failed',
        settled_ts: 1200,
      },
    );
    assert.equal(
      db.getMessage('chat-active-cleanup', 601).handler_status,
      'failed',
    );
    assert.deepEqual(
      {
        generation_id: db.getCodexLease().generation_id,
        status: db.getCodexLease().status,
      },
      {
        generation_id: null,
        status: 'clear',
      },
    );
    assert.equal(
      db.getProviderSession(
        'chat-active-cleanup',
        CODEX_APP_SERVER_NAMESPACE,
      ),
      undefined,
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-active-cleanup'
           AND kind = 'containment-cleanup-completed'
      `).get().count,
      1,
    );
  } finally {
    cleanupDb(dbPath, db);
  }
});

test('failed generation settlement rolls back every operational row on a late checkpoint failure', () => {
  ({ db, dbPath } = freshDb('polygram-codex-failed-settlement-rollback'));
  try {
    db.createCodexGeneration({
      generation_id: 'generation-rollback',
      session_key: 'chat-rollback',
      thread_id: 'thread-rollback',
      app_server_session_id: 'app-server-rollback',
      ...identity,
      ts: 1000,
    });
    db.acquireCodexLease({
      generation_id: 'generation-rollback',
      ...identity,
      ts: 1050,
    });
    db.raw.prepare(`
      INSERT INTO codex_turn_attempts (
        attempt_id, generation_id, session_key, method, thread_id,
        delivery_state, recovery_state, created_ts, updated_ts
      ) VALUES
        ('attempt-prepared', 'generation-rollback', 'chat-rollback',
         'turn/start', 'thread-rollback', 'prepared', 'prepared', 1100, 1100),
        ('attempt-target', 'generation-rollback', 'chat-rollback',
         'turn/start', 'thread-rollback', 'write-attempted', 'active',
         1110, 1110),
        ('attempt-steer', 'generation-rollback', 'chat-rollback',
         'turn/steer', 'thread-rollback', 'write-attempted', 'active',
         1120, 1120)
    `).run();
    db.markCodexContainment({
      generation_id: 'generation-rollback',
      reason: 'late-rollback-injection',
      ...identity,
      ts: 1200,
    });
    db.upsertProviderSession({
      session_key: 'chat-rollback',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'thread-rollback',
      app_server_session_id: 'app-server-rollback',
      generation_id: 'provider-epoch-rollback',
      pm_backend: 'codex',
      ts: 1250,
    });
    for (const msgId of [501, 502]) {
      insertInbound(db, {
        chat_id: 'chat-rollback',
        msg_id: msgId,
        bot_name: 'test-bot',
        text: `input-${msgId}`,
        handler_status: 'dispatched',
        ts: 1250,
      });
    }
    db.raw.prepare(`
      INSERT INTO codex_dispatch_reservations (
        reservation_id, generation_id, session_key, bot_name,
        telegram_chat_id, telegram_message_id, state,
        steer_attempt_id, target_attempt_id,
        created_ts, updated_ts, settled_ts
      ) VALUES
        ('reservation-queue', 'generation-rollback', 'chat-rollback',
         'test-bot', 'chat-rollback', '501', 'queue-authorized',
         NULL, 'attempt-prepared', 1260, 1260, NULL),
        ('reservation-steer', 'generation-rollback', 'chat-rollback',
         'test-bot', 'chat-rollback', '502', 'steer-accepted',
         'attempt-steer', 'attempt-target', 1270, 1270, NULL)
    `).run();
    db.raw.prepare(`
      INSERT INTO codex_linked_inputs (
        linked_input_id, generation_id, attempt_id, target_attempt_id,
        telegram_chat_id, telegram_message_id, state, created_ts, settled_ts
      ) VALUES (
        'linked-steer', 'generation-rollback',
        'attempt-steer', 'attempt-target',
        'chat-rollback', '502', 'linked', 1270, NULL
      )
    `).run();
    db.raw.exec(`
      CREATE TRIGGER reject_failed_generation_cleanup_checkpoint
      BEFORE INSERT ON codex_attempt_checkpoints
      WHEN NEW.kind = 'containment-cleanup-completed'
      BEGIN
        SELECT RAISE(ABORT, 'injected cleanup checkpoint failure');
      END
    `);

    const operationalSnapshot = () => ({
      identity: db.raw.prepare(`
        SELECT * FROM codex_runtime_identity ORDER BY singleton
      `).all(),
      generations: db.raw.prepare(`
        SELECT * FROM codex_generations ORDER BY generation_id
      `).all(),
      lease: db.raw.prepare(`
        SELECT * FROM codex_daemon_lease ORDER BY singleton
      `).all(),
      attempts: db.raw.prepare(`
        SELECT * FROM codex_turn_attempts ORDER BY attempt_id
      `).all(),
      reservations: db.raw.prepare(`
        SELECT * FROM codex_dispatch_reservations ORDER BY reservation_id
      `).all(),
      linkedInputs: db.raw.prepare(`
        SELECT * FROM codex_linked_inputs ORDER BY linked_input_id
      `).all(),
      messages: db.raw.prepare(`
        SELECT * FROM messages ORDER BY id
      `).all(),
      providerSessions: db.raw.prepare(`
        SELECT * FROM agent_runtime_sessions ORDER BY session_key, namespace
      `).all(),
      checkpoints: db.raw.prepare(`
        SELECT * FROM codex_attempt_checkpoints ORDER BY id
      `).all(),
    });
    const before = operationalSnapshot();

    assert.throws(
      () => db.settleCodexFailedGeneration({
        generation_id: 'generation-rollback',
        session_key: 'chat-rollback',
        stable_host_id: 'host-a',
        incident_boot_session_id: 'boot-a',
        current_boot_session_id: 'boot-a',
        provider_session_id: 'thread-rollback',
        app_server_session_id: 'app-server-rollback',
        reason: 'late-rollback-injection',
        source: 'managed-group-empty',
        allow_missing_generation: false,
        ts: 1300,
      }),
      /injected cleanup checkpoint failure/,
    );

    assert.deepEqual(operationalSnapshot(), before);
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-rollback'
           AND kind = 'containment-cleanup-completed'
      `).get().count,
      0,
    );
  } finally {
    cleanupDb(dbPath, db);
  }
});

test('pre-checkpoint settlement ignores an older completed incident', () => {
  ({ db, dbPath } = freshDb('polygram-codex-pre-checkpoint-history'));
  try {
    db.createCodexGeneration({
      generation_id: 'generation-old',
      session_key: 'chat-a',
      thread_id: 'thread-old',
      ...identity,
      ts: 1000,
    });
    db.raw.prepare(`
      UPDATE codex_generations
         SET state = 'containment-failed',
             containment_reason = 'old-incident',
             settled_ts = 1100,
             updated_ts = 1100
       WHERE generation_id = 'generation-old'
    `).run();

    assert.equal(db.settleCodexFailedGeneration({
      generation_id: 'generation-new',
      session_key: 'chat-a',
      stable_host_id: 'host-a',
      incident_boot_session_id: 'boot-a',
      current_boot_session_id: 'boot-a',
      provider_session_id: 'thread-new',
      app_server_session_id: null,
      reason: 'pre-checkpoint-failure',
      source: 'managed-group-empty',
      allow_missing_generation: true,
      ts: 1200,
    }).generationId, 'generation-new');
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_generations
         WHERE session_key = 'chat-a'
      `).get().count,
      2,
    );
  } finally {
    cleanupDb(dbPath, db);
  }
});

test('provider-session mismatch rolls failed settlement back', () => {
  ({ db, dbPath } = freshDb('polygram-codex-provider-conflict'));
  try {
    seedAmbiguousAttempt();
    db.acquireCodexLease({
      generation_id: 'generation-a',
      ...identity,
      ts: 1400,
    });
    db.markCodexContainment({
      generation_id: 'generation-a',
      reason: 'transport-lost',
      ...identity,
      ts: 1500,
    });
    db.upsertProviderSession({
      session_key: 'chat-a',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'replacement-thread',
      app_server_session_id: 'replacement-app-server',
      generation_id: 'replacement-provider-epoch',
      pm_backend: 'codex',
      ts: 1550,
    });

    assert.throws(
      () => db.settleCodexFailedGeneration({
        generation_id: 'generation-a',
        session_key: 'chat-a',
        stable_host_id: 'host-a',
        incident_boot_session_id: 'boot-a',
        current_boot_session_id: 'boot-a',
        provider_session_id: 'thread-a',
        app_server_session_id: null,
        reason: 'transport-lost',
        source: 'managed-group-empty',
        allow_missing_generation: false,
        ts: 1600,
      }),
      (error) => (
        error.code === 'CODEX_FAILED_GENERATION_SETTLEMENT_CONFLICT'
      ),
    );
    assert.equal(db.getCodexLease().status, 'quarantined');
    assert.equal(db.getCodexAttempt('attempt-a').recovery_state, 'ambiguous');
    assert.equal(
      db.getProviderSession(
        'chat-a',
        CODEX_APP_SERVER_NAMESPACE,
      ).provider_session_id,
      'replacement-thread',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-a'
           AND kind = 'containment-cleanup-completed'
      `).get().count,
      0,
    );
  } finally {
    cleanupDb(dbPath, db);
  }
});

describe('Codex ambiguity reconciliation', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-codex-reconcile'));
    seedAmbiguousAttempt();
  });
  afterEach(() => cleanupDb(dbPath, db));

  test('/config ignores an ambiguous internal thread/start attempt without a Telegram message', () => {
    db.raw.prepare(`
      UPDATE codex_turn_attempts
         SET method = 'thread/start',
             delivery_state = 'response-observed',
             response_outcome = 'error'
       WHERE attempt_id = 'attempt-a'
    `).run();
    markGenerationDead();

    assert.deepEqual(
      db.listUnresolvedCodexAttempts({ session_key: 'chat-a' }),
      [],
      'internal lifecycle attempts are durable recovery state, not Telegram reconciliation items',
    );
    assert.equal(
      db.getCodexAttempt('attempt-a').recovery_state,
      'ambiguous',
      'filtering the Telegram projection must not delete or settle recovery evidence',
    );
  });

  test('incorporated records one immutable owner decision', () => {
    db.reconcileCodexAttempt({
      attempt_id: 'attempt-a',
      disposition: 'incorporated',
      actor: 'telegram:42',
      reason: 'output and side effects were reviewed',
      ts: 2000,
    });

    const original = db.getCodexAttempt('attempt-a');
    assert.equal(original.delivery_state, 'write-attempted');
    assert.equal(original.recovery_state, 'ambiguous');
    assert.deepEqual(
      db.raw.prepare(`
        SELECT attempt_id, disposition, actor, reason, decided_ts
          FROM codex_attempt_reconciliations
      `).get(),
      {
        attempt_id: 'attempt-a',
        disposition: 'incorporated',
        actor: 'telegram:42',
        reason: 'output and side effects were reviewed',
        decided_ts: 2000,
      },
    );
    assert.throws(
      () => db.reconcileCodexAttempt({
        attempt_id: 'attempt-a',
        disposition: 'dismissed',
        actor: 'telegram:42',
        reason: 'changed mind',
        ts: 2100,
      }),
      (error) => error.code === 'CODEX_ATTEMPT_ALREADY_RECONCILED',
    );
  });

  test('retry authorization requires warning acknowledgement and reserves at most once', () => {
    assert.throws(
      () => db.reconcileCodexAttempt({
        attempt_id: 'attempt-a',
        disposition: 'retry-authorized',
        actor: 'telegram:42',
        reason: 'retry requested',
        retry_attempt_id: 'attempt-retry',
        duplicate_risk_acknowledged: false,
      }),
      (error) => error.code === 'CODEX_DUPLICATE_RISK_NOT_ACKNOWLEDGED',
    );

    markGenerationDead();
    db.reconcileCodexAttempt({
      attempt_id: 'attempt-a',
      disposition: 'retry-authorized',
      actor: 'telegram:42',
      reason: 'retry despite possible duplicate',
      retry_attempt_id: 'attempt-retry',
      duplicate_risk_acknowledged: true,
      ts: 2000,
    });

    assert.deepEqual(
      db.raw.prepare(`
        SELECT original_attempt_id, retry_attempt_id, state
          FROM codex_retry_reservations
      `).get(),
      {
        original_attempt_id: 'attempt-a',
        retry_attempt_id: 'attempt-retry',
        state: 'reserved',
      },
    );
    assert.equal(db.getCodexAttempt('attempt-a').delivery_state, 'write-attempted');
    assert.throws(
      () => db.reconcileCodexAttempt({
        attempt_id: 'attempt-a',
        disposition: 'retry-authorized',
        actor: 'telegram:42',
        reason: 'second retry',
        retry_attempt_id: 'attempt-retry-2',
        duplicate_risk_acknowledged: true,
      }),
      (error) => error.code === 'CODEX_ATTEMPT_ALREADY_RECONCILED',
    );
  });

  test('retry authorization waits until the ambiguous generation is terminal or dead', () => {
    db.raw.prepare(`
      UPDATE codex_generations
         SET state = 'active'
       WHERE generation_id = 'generation-a'
    `).run();

    assert.throws(
      () => db.reconcileCodexAttempt({
        attempt_id: 'attempt-a',
        disposition: 'retry-authorized',
        actor: 'telegram-user:42',
        reason: 'retry despite possible duplicate',
        retry_attempt_id: 'attempt-retry',
        duplicate_risk_acknowledged: true,
        ts: 2000,
      }),
      (error) => error.code === 'CODEX_RETRY_GENERATION_NOT_TERMINAL',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count FROM codex_attempt_reconciliations
      `).get().count,
      0,
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count FROM codex_retry_reservations
      `).get().count,
      0,
    );
  });

  test('lists only unresolved ambiguous attempts with original Telegram references', () => {
    insertInbound(db, {
      chat_id: 'chat-a',
      thread_id: null,
      msg_id: 42,
      user: 'Owner',
      user_id: 7,
      text: 'sensitive prompt',
      bot_name: 'test-bot',
      handler_status: 'codex-ambiguous',
      ts: 1050,
    });
    db.recordInboundRuntimeSelection({
      session_key: 'chat-a',
      bot_name: 'test-bot',
      telegram_chat_id: 'chat-a',
      telegram_message_id: '42',
      provider: 'codex',
      ts: 1060,
    });
    db.raw.prepare(`
      UPDATE codex_turn_attempts
         SET telegram_source_message_id = '42'
       WHERE attempt_id = 'attempt-a'
    `).run();
    markGenerationDead();

    assert.deepEqual(
      db.listUnresolvedCodexAttempts({ session_key: 'chat-a' }),
      [{
        attempt_id: 'attempt-a',
        generation_id: 'generation-a',
        session_key: 'chat-a',
        method: 'turn/start',
        telegram_source_message_id: '42',
        ambiguous_ts: 1200,
        generation_state: 'containment-failed',
        bot_name: 'test-bot',
        telegram_chat_id: 'chat-a',
        telegram_message_id: '42',
        owner_user_id: 7,
        owner_user: 'Owner',
        containment_status: 'cleanup-unverified',
        quarantine_reason: 'transport-lost',
      }],
    );

    db.reconcileCodexAttempt({
      attempt_id: 'attempt-a',
      disposition: 'dismissed',
      actor: 'telegram-user:7',
      reason: 'owner dismissed without retry',
      ts: 2000,
    });
    assert.deepEqual(
      db.listUnresolvedCodexAttempts({ session_key: 'chat-a' }),
      [],
    );
    assert.doesNotMatch(
      JSON.stringify(db.listUnresolvedCodexAttempts()),
      /sensitive prompt/,
      'the reconciliation listing never exposes stored prompt content',
    );
  });

  test('retry reservation moves to a fresh active generation after cleanup', () => {
    markGenerationDead();
    db.reconcileCodexAttempt({
      attempt_id: 'attempt-a',
      disposition: 'retry-authorized',
      actor: 'telegram:42',
      reason: 'retry after review',
      retry_attempt_id: 'attempt-retry',
      duplicate_risk_acknowledged: true,
      ts: 2000,
    });
    assert.throws(
      () => db.claimCodexRetryReservation({
        original_attempt_id: 'attempt-a',
        retry_attempt_id: 'attempt-retry',
        generation_id: 'generation-a',
        method: 'turn/start',
        thread_id: 'thread-a',
        ...identity,
        ts: 2060,
      }),
      (error) => error.code === 'CODEX_CHECKPOINT_STALE_GENERATION',
    );

    db.settleCodexFailedGeneration({
      generation_id: 'generation-a',
      session_key: 'chat-a',
      stable_host_id: 'host-a',
      incident_boot_session_id: 'boot-a',
      current_boot_session_id: 'boot-a',
      provider_session_id: 'thread-a',
      app_server_session_id: null,
      reason: 'transport-lost',
      source: 'managed-group-empty',
      allow_missing_generation: false,
      ts: 2070,
    });
    db.createCodexGeneration({
      generation_id: 'generation-b',
      session_key: 'chat-a',
      thread_id: 'thread-a',
      ...identity,
      ts: 2080,
    });
    db.acquireCodexLease({
      generation_id: 'generation-b',
      ...identity,
      ts: 2090,
    });
    db.claimCodexRetryReservation({
      original_attempt_id: 'attempt-a',
      retry_attempt_id: 'attempt-retry',
      generation_id: 'generation-b',
      method: 'turn/start',
      thread_id: 'thread-a',
      telegram_source_message_id: 'message-retry',
      client_user_message_id: 'client-retry',
      ...identity,
      ts: 2100,
    });
    assert.deepEqual(
      {
        generation_id: db.getCodexAttempt('attempt-retry').generation_id,
        delivery_state: db.getCodexAttempt('attempt-retry').delivery_state,
      },
      { generation_id: 'generation-b', delivery_state: 'prepared' },
    );
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_retry_reservations
         WHERE original_attempt_id = 'attempt-a'
      `).get().state,
      'claimed',
    );

    db.recordCodexCheckpoint({
      kind: 'request-write-attempted',
      generationId: 'generation-b',
      attemptId: 'attempt-retry',
      method: 'turn/start',
      threadId: 'thread-a',
      requestId: 1,
      ...identity,
      ts: 2200,
    });
    db.markCodexRetryDispatched({
      original_attempt_id: 'attempt-a',
      retry_attempt_id: 'attempt-retry',
      ts: 2300,
    });
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_retry_reservations
         WHERE original_attempt_id = 'attempt-a'
      `).get().state,
      'dispatched',
    );
    assert.throws(
      () => db.retireCodexRetryReservation({
        original_attempt_id: 'attempt-a',
        retry_attempt_id: 'attempt-retry',
        ts: 2400,
      }),
      (error) => error.code === 'CODEX_RETRY_NOT_SETTLED',
    );
    const restored = db.reconstructCodexRecovery({
      ...identity,
      now: 2500,
    });
    assert.equal(restored.status, 'recovery-blocked');
    assert.deepEqual(
      restored.unresolvedAttemptIds.sort(),
      ['attempt-a', 'attempt-retry'],
    );

    for (const checkpoint of [
      {
        kind: 'request-response-observed',
        requestId: 1,
        outcome: 'result',
        ts: 2600,
      },
      {
        kind: 'turn-accepted',
        turnId: 'turn-retry',
        ts: 2700,
      },
      {
        kind: 'turn-terminal',
        turnId: 'turn-retry',
        terminalStatus: 'completed',
        ts: 2800,
      },
      {
        kind: 'telegram-delivery-settled',
        turnId: 'turn-retry',
        ts: 2900,
      },
    ]) {
      db.recordCodexCheckpoint({
        generationId: 'generation-b',
        attemptId: 'attempt-retry',
        method: 'turn/start',
        threadId: 'thread-a',
        ...identity,
        ...checkpoint,
      });
    }
    assert.equal(db.retireCodexRetryReservation({
      original_attempt_id: 'attempt-a',
      retry_attempt_id: 'attempt-retry',
      ts: 3000,
    }).changes, 1);
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_retry_reservations
         WHERE original_attempt_id = 'attempt-a'
      `).get().state,
      'retired',
    );
  });

  test('input reconciliation never releases containment quarantine', () => {
    db.acquireCodexLease({
      generation_id: 'generation-a',
      ...identity,
      ts: 1400,
    });
    db.markCodexContainment({
      generation_id: 'generation-a',
      reason: 'transport-lost',
      ...identity,
      ts: 1500,
    });
    db.reconcileCodexAttempt({
      attempt_id: 'attempt-a',
      disposition: 'dismissed',
      actor: 'telegram:42',
      reason: 'do not retry',
      ts: 2000,
    });

    assert.equal(db.getCodexLease().status, 'quarantined');
    assert.equal(
      db.reconstructCodexRecovery({ ...identity, now: 2100 }).status,
      'recovery-blocked',
    );
  });
});

test('clear-lease boot reconstruction rolls back identity when lease update fails', () => {
  ({ db, dbPath } = freshDb('polygram-codex-clear-lease-rollback'));
  try {
    assert.equal(
      db.reconstructCodexRecovery({ ...identity, now: 1000 }).status,
      'clear',
    );
    db.raw.prepare(`
      INSERT INTO codex_daemon_lease (
        singleton, generation_id, stable_host_id, boot_session_id,
        status, quarantine_reason, acquired_ts, updated_ts, released_ts
      ) VALUES (1, NULL, 'host-a', 'boot-a', 'clear', NULL, NULL, 1000, 1000)
    `).run();
    db.raw.exec(`
      CREATE TRIGGER reject_clear_lease_boot_update
      BEFORE UPDATE OF boot_session_id ON codex_daemon_lease
      WHEN NEW.boot_session_id = 'boot-b'
      BEGIN
        SELECT RAISE(ABORT, 'injected clear lease boot update failure');
      END
    `);

    assert.throws(
      () => db.reconstructCodexRecovery({
        stable_host_id: 'host-a',
        boot_session_id: 'boot-b',
        now: 2000,
      }),
      /injected clear lease boot update failure/,
    );
    assert.equal(
      db.raw.prepare(`
        SELECT last_boot_session_id
          FROM codex_runtime_identity
         WHERE singleton = 1
      `).get().last_boot_session_id,
      'boot-a',
    );
    assert.equal(db.getCodexLease().boot_session_id, 'boot-a');
  } finally {
    cleanupDb(dbPath, db);
  }
});

test('startup reconstruction never infers provider ownership missing from the generation', () => {
  ({ db, dbPath } = freshDb('polygram-codex-provider-ownership'));
  try {
    db.createCodexGeneration({
      generation_id: 'generation-provider-ownership',
      session_key: 'chat-provider-ownership',
      thread_id: null,
      app_server_session_id: null,
      ...identity,
      ts: 1000,
    });
    db.acquireCodexLease({
      generation_id: 'generation-provider-ownership',
      ...identity,
      ts: 1100,
    });
    db.upsertProviderSession({
      session_key: 'chat-provider-ownership',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'thread-provider-ownership',
      app_server_session_id: 'app-server-provider-ownership',
      generation_id: 'runtime-session-generation-provider-ownership',
      pm_backend: 'codex',
      ts: 1200,
    });
    db.raw.prepare(`
      UPDATE agent_runtime_sessions
         SET generation_id = 'runtime-session-generation-provider-ownership'
       WHERE session_key = 'chat-provider-ownership'
         AND namespace = ?
    `).run(CODEX_APP_SERVER_NAMESPACE);

    const operationalSnapshot = () => ({
      identity: db.raw.prepare(`
        SELECT * FROM codex_runtime_identity ORDER BY singleton
      `).all(),
      generations: db.raw.prepare(`
        SELECT * FROM codex_generations ORDER BY generation_id
      `).all(),
      lease: db.raw.prepare(`
        SELECT * FROM codex_daemon_lease ORDER BY singleton
      `).all(),
      attempts: db.raw.prepare(`
        SELECT * FROM codex_turn_attempts ORDER BY attempt_id
      `).all(),
      reservations: db.raw.prepare(`
        SELECT * FROM codex_dispatch_reservations ORDER BY reservation_id
      `).all(),
      linkedInputs: db.raw.prepare(`
        SELECT * FROM codex_linked_inputs ORDER BY linked_input_id
      `).all(),
      messages: db.raw.prepare(`
        SELECT * FROM messages ORDER BY id
      `).all(),
      providerSessions: db.raw.prepare(`
        SELECT * FROM agent_runtime_sessions ORDER BY session_key, namespace
      `).all(),
      checkpoints: db.raw.prepare(`
        SELECT * FROM codex_attempt_checkpoints ORDER BY id
      `).all(),
    });
    const before = operationalSnapshot();

    const restored = db.reconstructCodexRecovery({
      ...identity,
      startup_recovery: {
        exclusive_daemon_ownership: true,
        supervisor_grace_elapsed: true,
      },
      now: 1300,
    });

    assert.equal(restored.status, 'integrity-blocked');
    assert.equal(restored.reason, 'persisted-generation-inconsistent');
    assert.equal(restored.containmentReleased, false);
    assert.deepEqual(operationalSnapshot(), before);
    assert.equal(
      db.getProviderSession(
        'chat-provider-ownership',
        CODEX_APP_SERVER_NAMESPACE,
      ).generation_id,
      'runtime-session-generation-provider-ownership',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-provider-ownership'
           AND kind = 'containment-cleanup-completed'
      `).get().count,
      0,
    );
  } finally {
    cleanupDb(dbPath, db);
  }
});

describe('Codex host and boot reconstruction', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-codex-reconstruct'));
    seedAmbiguousAttempt();
    db.acquireCodexLease({
      generation_id: 'generation-a',
      ...identity,
      ts: 1400,
    });
    db.markCodexContainment({
      generation_id: 'generation-a',
      reason: 'transport-lost',
      ...identity,
      ts: 1500,
    });
  });
  afterEach(() => cleanupDb(dbPath, db));

  test('VPS unexpected-turn-start quarantine recovers on the same boot without replay', () => {
    db.upsertProviderSession({
      session_key: 'chat-a',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'thread-a',
      app_server_session_id: null,
      generation_id: 'runtime-session-generation-a',
      pm_backend: 'codex',
      ts: 1600,
    });
    db.raw.prepare(`
      UPDATE agent_runtime_sessions
         SET generation_id = 'runtime-session-generation-a'
       WHERE session_key = 'chat-a'
         AND namespace = ?
    `).run(CODEX_APP_SERVER_NAMESPACE);
    const restored = db.reconstructCodexRecovery({
      ...identity,
      startup_recovery: {
        exclusive_daemon_ownership: true,
        supervisor_grace_elapsed: true,
      },
      now: 2000,
    });
    assert.equal(restored.status, 'clear');
    assert.equal(restored.reason, null);
    assert.equal(restored.containmentReleased, true);
    assert.deepEqual(restored.replayableAttemptIds, []);
    assert.deepEqual(restored.unresolvedAttemptIds, ['attempt-a']);
    assert.equal(db.getCodexAttempt('attempt-a').recovery_state, 'ambiguous');
    assert.equal(db.getCodexLease().status, 'clear');
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-a'
           AND kind = 'containment-cleanup-completed'
      `).get().count,
      1,
    );
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM codex_reboot_releases')
        .get().count,
      0,
    );
  });

  test('same host with a changed boot settles after exclusive startup recovery', () => {
    const nextBoot = {
      stable_host_id: 'host-a',
      boot_session_id: 'boot-b',
      startup_recovery: {
        exclusive_daemon_ownership: true,
        supervisor_grace_elapsed: true,
      },
      now: 2000,
    };
    const restored = db.reconstructCodexRecovery(nextBoot);
    assert.equal(restored.status, 'clear');
    assert.equal(restored.containmentReleased, true);
    assert.deepEqual(restored.unresolvedAttemptIds, ['attempt-a']);
    assert.equal(db.getCodexAttempt('attempt-a').recovery_state, 'ambiguous');
    assert.equal(db.getCodexLease().status, 'clear');

    const repeated = db.reconstructCodexRecovery({
      ...nextBoot,
      now: 2100,
    });
    assert.equal(repeated.status, 'clear');
    assert.equal(repeated.containmentReleased, false);
    assert.deepEqual(repeated.unresolvedAttemptIds, ['attempt-a']);
  });

  test('relocated database fails closed', () => {
    const restored = db.reconstructCodexRecovery({
      stable_host_id: 'host-b',
      boot_session_id: 'boot-b',
      now: 2000,
    });
    assert.equal(restored.status, 'integrity-blocked');
    assert.equal(restored.reason, 'stable-host-mismatch');
    assert.equal(db.getCodexLease().status, 'quarantined');
    assert.equal(db.getCodexLease().stable_host_id, 'host-a');
  });

  test('missing or corrupt persisted identity fails closed', () => {
    db.raw.prepare('DELETE FROM codex_runtime_identity').run();
    const restored = db.reconstructCodexRecovery({
      stable_host_id: 'host-a',
      boot_session_id: 'boot-b',
      now: 2000,
    });
    assert.equal(restored.status, 'integrity-blocked');
    assert.equal(restored.reason, 'persisted-identity-missing');
  });
});

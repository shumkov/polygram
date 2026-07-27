'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  freshDb,
  cleanupDb,
  insertInbound,
} = require('./helpers/db-fixture');

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

describe('Codex ambiguity reconciliation', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-codex-reconcile'));
    seedAmbiguousAttempt();
  });
  afterEach(() => cleanupDb(dbPath, db));

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
        containment_status: 'quarantined',
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

  test('retry reservation moves to a new generation after durable reboot release', () => {
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

    const nextIdentity = {
      stable_host_id: 'host-a',
      boot_session_id: 'boot-b',
    };
    assert.equal(
      db.reconstructCodexRecovery({ ...nextIdentity, now: 2070 }).status,
      'clear',
    );
    db.createCodexGeneration({
      generation_id: 'generation-b',
      session_key: 'chat-a',
      thread_id: 'thread-a',
      ...nextIdentity,
      ts: 2080,
    });
    db.acquireCodexLease({
      generation_id: 'generation-b',
      ...nextIdentity,
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
      ...nextIdentity,
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
      ...nextIdentity,
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
      ...nextIdentity,
      now: 2500,
    });
    assert.equal(restored.status, 'quarantined');
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
        ...nextIdentity,
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
      'quarantined',
    );
  });
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

  test('same host and boot stays quarantined', () => {
    const restored = db.reconstructCodexRecovery({ ...identity, now: 2000 });
    assert.equal(restored.status, 'quarantined');
    assert.equal(restored.reason, 'persisted-containment');
    assert.equal(restored.containmentReleased, false);
  });

  test('same host with a changed boot releases containment only', () => {
    const nextBoot = {
      stable_host_id: 'host-a',
      boot_session_id: 'boot-b',
      now: 2000,
    };
    const restored = db.reconstructCodexRecovery(nextBoot);
    assert.equal(restored.status, 'clear');
    assert.equal(restored.containmentReleased, true);
    assert.deepEqual(restored.unresolvedAttemptIds, ['attempt-a']);
    assert.deepEqual(restored.releasedAttemptIds, ['attempt-a']);
    assert.equal(db.getCodexAttempt('attempt-a').recovery_state, 'ambiguous');
    assert.equal(db.getCodexLease().status, 'clear');

    const repeated = db.reconstructCodexRecovery({
      ...nextBoot,
      now: 2100,
    });
    assert.equal(repeated.status, 'clear');
    assert.equal(repeated.containmentReleased, false);
    assert.deepEqual(repeated.unresolvedAttemptIds, ['attempt-a']);
    assert.deepEqual(repeated.releasedAttemptIds, ['attempt-a']);
  });

  test('relocated database fails closed', () => {
    const restored = db.reconstructCodexRecovery({
      stable_host_id: 'host-b',
      boot_session_id: 'boot-b',
      now: 2000,
    });
    assert.equal(restored.status, 'quarantined');
    assert.equal(restored.reason, 'stable-host-mismatch');
    assert.equal(db.getCodexLease().status, 'quarantined');
  });

  test('missing or corrupt persisted identity fails closed', () => {
    db.raw.prepare('DELETE FROM codex_runtime_identity').run();
    const restored = db.reconstructCodexRecovery({
      stable_host_id: 'host-a',
      boot_session_id: 'boot-b',
      now: 2000,
    });
    assert.equal(restored.status, 'quarantined');
    assert.equal(restored.reason, 'persisted-identity-missing');
  });
});

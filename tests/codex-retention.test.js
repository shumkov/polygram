'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');

const DAY_MS = 86_400_000;
const NOW = 200 * DAY_MS;
const identity = {
  stable_host_id: 'host-a',
  boot_session_id: 'boot-a',
};

let db;
let dbPath;

function seedAttempt({
  generationId,
  attemptId,
  createdTs,
  ambiguous = false,
  reconciled = false,
  liveLease = false,
  generationState,
}) {
  db.raw.prepare(`
    INSERT OR IGNORE INTO codex_runtime_identity (
      singleton, stable_host_id, last_boot_session_id,
      established_ts, updated_ts
    ) VALUES (1, @stable_host_id, @boot_session_id, @createdTs, @createdTs)
  `).run({ ...identity, createdTs });
  const state = generationState
    ?? (liveLease ? 'active' : ambiguous ? 'created' : 'retired');
  db.raw.prepare(`
    INSERT INTO codex_generations (
      generation_id, session_key, thread_id,
      stable_host_id, boot_session_id, state,
      containment_reason, created_ts, updated_ts, settled_ts
    ) VALUES (
      @generationId, @generationId, @threadId,
      @stable_host_id, @boot_session_id, @state,
      @containmentReason, @createdTs, @updatedTs, @settledTs
    )
  `).run({
    generationId,
    threadId: `thread-${generationId}`,
    ...identity,
    state,
    containmentReason: state === 'containment-failed'
      ? 'transport-lost'
      : null,
    createdTs,
    updatedTs: createdTs + 5,
    settledTs: ['healthy-stopped', 'retired'].includes(state)
      ? createdTs + 5
      : null,
  });
  db.raw.prepare(`
    INSERT INTO codex_turn_attempts (
      attempt_id, generation_id, session_key, method,
      thread_id, turn_id, request_id,
      delivery_state, response_outcome, recovery_state,
      terminal_status, created_ts, updated_ts, settled_ts, ambiguous_ts
    ) VALUES (
      @attemptId, @generationId, @generationId, 'turn/start',
      @threadId, @turnId, @requestId,
      @deliveryState, @responseOutcome, @recoveryState,
      @terminalStatus, @createdTs, @updatedTs, @settledTs, @ambiguousTs
    )
  `).run({
    attemptId,
    generationId,
    threadId: `thread-${generationId}`,
    turnId: ambiguous ? null : `turn-${attemptId}`,
    requestId: `request-${attemptId}`,
    deliveryState: ambiguous ? 'write-attempted' : 'response-observed',
    responseOutcome: ambiguous ? null : 'result',
    recoveryState: ambiguous ? 'ambiguous' : 'settled',
    terminalStatus: ambiguous ? null : 'completed',
    createdTs,
    updatedTs: createdTs + 4,
    settledTs: ambiguous ? null : createdTs + 4,
    ambiguousTs: ambiguous ? createdTs + 2 : null,
  });
  if (reconciled) {
    db.raw.prepare(`
      INSERT INTO codex_attempt_reconciliations (
        attempt_id, disposition, actor, reason, decided_ts
      ) VALUES (?, 'dismissed', 'telegram:42', 'reviewed', ?)
    `).run(attemptId, createdTs + 3);
  }
  if (liveLease) {
    db.raw.prepare(`
      INSERT INTO codex_daemon_lease (
        singleton, generation_id, stable_host_id, boot_session_id,
        status, acquired_ts, updated_ts
      ) VALUES (1, @generationId, @stable_host_id, @boot_session_id,
                'active', @ts, @ts)
    `).run({ generationId, ...identity, ts: createdTs + 5 });
  }
}

describe('Codex operational retention', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-codex-retention'));
  });
  afterEach(() => cleanupDb(dbPath, db));

  test('prunes settled data after 30 days but preserves live and recent rows', () => {
    seedAttempt({
      generationId: 'old-settled-generation',
      attemptId: 'old-settled',
      createdTs: NOW - 31 * DAY_MS,
    });
    seedAttempt({
      generationId: 'recent-generation',
      attemptId: 'recent-settled',
      createdTs: NOW - 29 * DAY_MS,
    });
    seedAttempt({
      generationId: 'live-generation',
      attemptId: 'live-settled',
      createdTs: NOW - 40 * DAY_MS,
      liveLease: true,
    });

    const result = db.pruneCodexOperationalData({ now: NOW });

    assert.equal(result.deletedAttempts, 1);
    assert.equal(db.getCodexAttempt('old-settled'), undefined);
    assert.ok(db.getCodexAttempt('recent-settled'));
    assert.ok(db.getCodexAttempt('live-settled'));
  });

  test('unreconciled ambiguity never prunes and reconciled ambiguity waits 90 days', () => {
    seedAttempt({
      generationId: 'unresolved-generation',
      attemptId: 'unresolved-ambiguous',
      createdTs: NOW - 120 * DAY_MS,
      ambiguous: true,
    });
    seedAttempt({
      generationId: 'young-ambiguous-generation',
      attemptId: 'young-reconciled',
      createdTs: NOW - 89 * DAY_MS,
      ambiguous: true,
      reconciled: true,
    });
    seedAttempt({
      generationId: 'old-ambiguous-generation',
      attemptId: 'old-reconciled',
      createdTs: NOW - 91 * DAY_MS,
      ambiguous: true,
      reconciled: true,
    });

    const result = db.pruneCodexOperationalData({ now: NOW });

    assert.equal(result.deletedAttempts, 1);
    assert.ok(db.getCodexAttempt('unresolved-ambiguous'));
    assert.ok(db.getCodexAttempt('young-reconciled'));
    assert.equal(db.getCodexAttempt('old-reconciled'), undefined);
    assert.equal(
      db.raw.prepare(`
        SELECT generation_id FROM codex_generations
         WHERE generation_id = 'old-ambiguous-generation'
      `).get(),
      undefined,
    );
  });

  test('a retry reservation protects both attempts until durable retirement', () => {
    seedAttempt({
      generationId: 'reserved-generation',
      attemptId: 'reserved-original',
      createdTs: NOW - 120 * DAY_MS,
      ambiguous: true,
      generationState: 'healthy-stopped',
    });
    db.reconcileCodexAttempt({
      attempt_id: 'reserved-original',
      disposition: 'retry-authorized',
      actor: 'telegram:42',
      reason: 'retry approved',
      retry_attempt_id: 'reserved-retry',
      duplicate_risk_acknowledged: true,
      ts: NOW - 119 * DAY_MS,
    });
    db.raw.prepare(`
      INSERT INTO codex_turn_attempts (
        attempt_id, generation_id, session_key, method,
        thread_id, request_id, delivery_state, recovery_state,
        created_ts, updated_ts, ambiguous_ts
      ) VALUES (
        'reserved-retry', 'reserved-generation', 'reserved-generation',
        'turn/start', 'thread-reserved-generation', 'retry-request',
        'write-attempted', 'ambiguous', @createdTs, @createdTs, @createdTs
      )
    `).run({ createdTs: NOW - 118 * DAY_MS });
    db.raw.prepare(`
      UPDATE codex_retry_reservations
         SET state = 'dispatched',
             claimed_ts = @claimedTs,
             dispatched_ts = @dispatchedTs
       WHERE original_attempt_id = 'reserved-original'
    `).run({
      claimedTs: NOW - 118 * DAY_MS,
      dispatchedTs: NOW - 117 * DAY_MS,
    });

    const protectedResult = db.pruneCodexOperationalData({ now: NOW });

    assert.equal(protectedResult.deletedAttempts, 0);
    assert.ok(db.getCodexAttempt('reserved-original'));
    assert.ok(db.getCodexAttempt('reserved-retry'));

    db.raw.prepare(`
      UPDATE codex_turn_attempts
         SET delivery_state = 'response-observed',
             response_outcome = 'result',
             recovery_state = 'settled',
             terminal_status = 'completed',
             settled_ts = @settledTs,
             updated_ts = @settledTs
       WHERE attempt_id = 'reserved-retry'
    `).run({ settledTs: NOW - 100 * DAY_MS });
    db.retireCodexRetryReservation({
      original_attempt_id: 'reserved-original',
      retry_attempt_id: 'reserved-retry',
      ts: NOW - 99 * DAY_MS,
    });

    const retiredResult = db.pruneCodexOperationalData({ now: NOW });
    assert.equal(retiredResult.deletedAttempts, 2);
    assert.equal(retiredResult.deletedGenerations, 1);
    assert.equal(db.getCodexAttempt('reserved-original'), undefined);
    assert.equal(db.getCodexAttempt('reserved-retry'), undefined);
  });

  test('failed generations retain until cleanup without a reboot predicate', () => {
    seedAttempt({
      generationId: 'contained-generation',
      attemptId: 'contained-attempt',
      createdTs: NOW - 120 * DAY_MS,
      ambiguous: true,
      reconciled: true,
      generationState: 'containment-failed',
    });

    const held = db.pruneCodexOperationalData({ now: NOW });
    assert.deepEqual(held, { deletedAttempts: 1, deletedGenerations: 0 });
    assert.equal(db.getCodexAttempt('contained-attempt'), undefined);

    db.raw.prepare(`
      INSERT INTO codex_attempt_checkpoints (
        generation_id, kind, detail_json, ts
      ) VALUES (
        'contained-generation', 'containment-cleanup-completed',
        '{"source":"exclusive-takeover-grace"}', @settledTs
      )
    `).run({ settledTs: NOW - DAY_MS });

    const released = db.pruneCodexOperationalData({ now: NOW });
    assert.deepEqual(released, { deletedAttempts: 0, deletedGenerations: 1 });
    assert.equal(db.getCodexAttempt('contained-attempt'), undefined);
  });
});

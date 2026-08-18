'use strict';

const { createHash } = require('node:crypto');
const { afterEach, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupDb,
  freshDb,
  insertInbound,
} = require('./helpers/db-fixture');
const { open } = require('../lib/db');
const {
  classifyCodexRecoveryEvidence,
  classifyReplay,
} = require('../lib/handlers/replay-disposition');

let db;
let dbPath;

const identity = {
  stable_host_id: 'host-a',
  boot_session_id: 'boot-a',
};

function seedGeneration(overrides = {}) {
  db.createCodexGeneration({
    generation_id: 'generation-a',
    session_key: 'chat:topic',
    thread_id: 'thread-a',
    app_server_session_id: 'diagnostic-a',
    ...identity,
    ts: 1000,
    ...overrides,
  });
  db.acquireCodexLease({
    generation_id: overrides.generation_id ?? 'generation-a',
    ...identity,
    ts: 1010,
  });
}

function reservation(overrides = {}) {
  return {
    reservation_id: 'dispatch-a',
    generation_id: 'generation-a',
    session_key: 'chat:topic',
    bot_name: 'bot-a',
    telegram_chat_id: 'chat',
    telegram_message_id: '42',
    ...identity,
    ts: 1100,
    ...overrides,
  };
}

function deterministicReservationId({
  botName = 'bot-a',
  telegramChatId = 'chat',
  telegramMessageId = '42',
} = {}) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ botName, telegramChatId, telegramMessageId }))
    .digest('hex');
  return `codex-dispatch:v1:${digest}`;
}

function checkpoint(row) {
  return db.recordCodexCheckpoint({
    generationId: 'generation-a',
    threadId: 'thread-a',
    ...(
      row.source != null
      && ['request-prepared', 'active-start-cancelled', 'queued-send-cancelled']
        .includes(row.kind)
      && row.clientUserMessageId === undefined
        ? { clientUserMessageId: `client-${row.source}` }
        : {}
    ),
    ...identity,
    ...row,
  });
}

function seedAcceptedTurnAndSteer({ targetSource = null } = {}) {
  for (const row of [
    {
      kind: 'request-prepared',
      attemptId: 'turn-attempt',
      method: 'turn/start',
      ...(targetSource == null ? {} : { source: targetSource }),
      ts: 1200,
    },
    {
      kind: 'request-write-attempted',
      attemptId: 'turn-attempt',
      method: 'turn/start',
      ...(targetSource == null ? {} : { source: targetSource }),
      requestId: 'turn-request',
      ts: 1210,
    },
    {
      kind: 'request-response-observed',
      attemptId: 'turn-attempt',
      method: 'turn/start',
      ...(targetSource == null ? {} : { source: targetSource }),
      requestId: 'turn-request',
      outcome: 'result',
      ts: 1220,
    },
    {
      kind: 'turn-accepted',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      ...(targetSource == null ? {} : { source: targetSource }),
      ts: 1230,
    },
    {
      kind: 'request-prepared',
      attemptId: 'steer-attempt',
      method: 'turn/steer',
      turnId: 'turn-a',
      source: '42',
      ts: 1240,
    },
    {
      kind: 'request-write-attempted',
      attemptId: 'steer-attempt',
      method: 'turn/steer',
      turnId: 'turn-a',
      requestId: 'steer-request',
      ts: 1250,
    },
    {
      kind: 'request-response-observed',
      attemptId: 'steer-attempt',
      method: 'turn/steer',
      turnId: 'turn-a',
      requestId: 'steer-request',
      outcome: 'result',
      ts: 1260,
    },
    {
      kind: 'turn-steer-accepted',
      attemptId: 'steer-attempt',
      turnId: 'turn-a',
      ts: 1270,
    },
  ]) {
    checkpoint(row);
  }
}

function prepareAcceptedTurnForCleanRetirement(overrides = {}) {
  return db.prepareCodexCleanRetirement({
    generation_id: 'generation-a',
    session_key: 'chat:topic',
    attempt_id: 'turn-attempt',
    provider_session_id: 'thread-a',
    provider_turn_id: 'turn-a',
    source_message_id: '41',
    ...identity,
    ts: 1280,
    ...overrides,
  });
}

function recordFailedTurnDelivery({ ts, retireGeneration = false }) {
  return db.recordCodexDeliveryCheckpoint({
    checkpoint: {
      kind: 'telegram-delivery-failed',
      generationId: 'generation-a',
      attemptId: 'turn-attempt',
      threadId: 'thread-a',
      turnId: 'turn-a',
      ...identity,
      ts,
    },
    retireGeneration,
  });
}

function seedDeployOwnedPrimaryInput() {
  insertInbound(db, {
    chat_id: 'chat',
    msg_id: 41,
    bot_name: 'bot-a',
    handler_status: 'processing',
  });
  db.recordInboundRuntimeSelection({
    session_key: 'chat:topic',
    bot_name: 'bot-a',
    telegram_chat_id: 'chat',
    telegram_message_id: '41',
    provider: 'codex',
    ts: 1100,
  });
}

function reopenAndClassifyDeployOwnedPrimary() {
  db.raw.close();
  db = open(dbPath);
  const candidate = { chat_id: 'chat', thread_id: null, msg_id: 41 };
  const replay = classifyReplay({
    candidates: [candidate],
    cleanShutdown: false,
    getProviderRecovery: () => db.getReplayProviderRecovery({
      sessionKey: 'chat:topic',
      botName: 'bot-a',
      telegramChatId: 'chat',
      telegramMessageId: '41',
    }),
  });
  return { candidate, replay };
}

function assertNoCleanRestartIntent() {
  assert.equal(
    db.raw.prepare('SELECT COUNT(*) AS count FROM clean_restart_resume_intents')
      .get().count,
    0,
  );
}

function seedCompletedStartAttempt({
  attemptId = 'queued-attempt',
  sourceMessageId = '42',
  turnId = 'queued-turn',
  startTs = 1200,
  settleDelivery = true,
} = {}) {
  const rows = [
    {
      kind: 'request-prepared',
      attemptId,
      method: 'turn/start',
      source: sourceMessageId,
      ts: startTs,
    },
    {
      kind: 'request-write-attempted',
      attemptId,
      method: 'turn/start',
      source: sourceMessageId,
      requestId: `${attemptId}-request`,
      ts: startTs + 10,
    },
    {
      kind: 'request-response-observed',
      attemptId,
      method: 'turn/start',
      source: sourceMessageId,
      requestId: `${attemptId}-request`,
      outcome: 'result',
      ts: startTs + 20,
    },
    {
      kind: 'turn-accepted',
      attemptId,
      turnId,
      source: sourceMessageId,
      ts: startTs + 30,
    },
    {
      kind: 'turn-terminal',
      attemptId,
      turnId,
      source: sourceMessageId,
      terminalStatus: 'completed',
      ts: startTs + 40,
    },
  ];
  if (settleDelivery) {
    rows.push({
      kind: 'telegram-delivery-settled',
      attemptId,
      turnId,
      source: sourceMessageId,
      ts: startTs + 50,
    });
  }
  for (const row of rows) {
    checkpoint(row);
  }
}

describe('Codex inbound dispatch reservations', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-codex-dispatch'));
  });
  afterEach(() => cleanupDb(dbPath, db));

  test('claims an exact Telegram input once under the active generation lease', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'dispatched',
    });

    const first = db.claimCodexDispatchReservation(reservation());
    assert.equal(first.claimed, true);
    assert.equal(first.reservation.state, 'reserved');

    const duplicate = db.claimCodexDispatchReservation(reservation({
      ts: 1150,
    }));
    assert.equal(duplicate.claimed, false);
    assert.deepEqual(duplicate.reservation, first.reservation);
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM codex_dispatch_reservations')
        .get().count,
      1,
    );
  });

  test('fails closed on stale ownership, conflicting reuse, or payload fields', () => {
    db.createCodexGeneration({
      generation_id: 'generation-a',
      session_key: 'chat:topic',
      thread_id: 'thread-a',
      ...identity,
      ts: 1000,
    });
    assert.throws(
      () => db.claimCodexDispatchReservation(reservation()),
      (error) => error.code === 'CODEX_CHECKPOINT_STALE_GENERATION',
    );

    db.acquireCodexLease({
      generation_id: 'generation-a',
      ...identity,
      ts: 1010,
    });
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'dispatched',
    });
    db.claimCodexDispatchReservation(reservation());

    for (const conflict of [
      { reservation_id: 'dispatch-b' },
      { session_key: 'different:topic' },
      { bot_name: 'different-bot' },
      { telegram_message_id: '43' },
    ]) {
      assert.throws(
        () => db.claimCodexDispatchReservation(reservation(conflict)),
        (error) => [
          'CODEX_DISPATCH_RESERVATION_CONFLICT',
          'CODEX_DISPATCH_SESSION_MISMATCH',
        ].includes(error.code),
      );
    }
    assert.throws(
      () => db.claimCodexDispatchReservation({
        ...reservation({ telegram_message_id: '44' }),
        prompt: 'must never be persisted',
      }),
      (error) => (
        error.code === 'CODEX_DISPATCH_RESERVATION_PAYLOAD_REJECTED'
      ),
    );
    const columns = db.raw.prepare(
      'PRAGMA table_info(codex_dispatch_reservations)',
    ).all().map((row) => row.name);
    assert.equal(columns.some((column) => /prompt|text|content/i.test(column)), false);
  });

  test('duplicate claims restore the reservation-derived non-replayable status', () => {
    seedGeneration();
    const cases = [
      ['reserved', 'dispatched'],
      ['steer-accepted', 'dispatched'],
      ['queue-authorized', 'dispatched'],
      ['settled', 'replied'],
      ['failed', 'failed'],
      ['interrupted', 'failed'],
      ['cancelled', 'failed'],
      ['ambiguous', 'codex-ambiguous'],
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const [state, expected] = cases[index];
      const messageId = String(100 + index);
      const reservationId = `dispatch-${state}`;
      insertInbound(db, {
        chat_id: 'chat',
        msg_id: Number(messageId),
        bot_name: 'bot-a',
        handler_status: 'dispatched',
      });
      const input = reservation({
        reservation_id: reservationId,
        telegram_message_id: messageId,
        ts: 1200 + index,
      });
      db.claimCodexDispatchReservation(input);
      db.raw.prepare(`
        UPDATE codex_dispatch_reservations
           SET state = ?
         WHERE reservation_id = ?
      `).run(state, reservationId);
      db.setInboundHandlerStatus({
        chat_id: 'chat',
        msg_id: Number(messageId),
        status: 'dispatched',
      });

      assert.equal(db.claimCodexDispatchReservation({
        ...input,
        ts: 1300 + index,
      }).claimed, false);
      assert.equal(
        db.raw.prepare(`
          SELECT handler_status
            FROM messages
           WHERE chat_id = 'chat' AND msg_id = ?
        `).get(Number(messageId)).handler_status,
        expected,
      );
    }
  });

  test('atomically links an accepted steer only to its exact accepted turn', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'dispatched',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer();

    const input = {
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      steer_attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      ...identity,
      ts: 1300,
    };
    const accepted = db.finalizeCodexAcceptedSteer(input);
    assert.equal(accepted.changes, 1);
    assert.equal(accepted.reservation.state, 'steer-accepted');
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status
          FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'dispatched',
    );
    assert.deepEqual(
      db.raw.prepare(`
        SELECT linked_input_id, generation_id, attempt_id, target_attempt_id,
               telegram_chat_id, telegram_message_id, state
          FROM codex_linked_inputs
         WHERE linked_input_id = 'dispatch-a'
      `).get(),
      {
        linked_input_id: 'dispatch-a',
        generation_id: 'generation-a',
        attempt_id: 'steer-attempt',
        target_attempt_id: 'turn-attempt',
        telegram_chat_id: 'chat',
        telegram_message_id: '42',
        state: 'linked',
      },
    );

    const duplicate = db.finalizeCodexAcceptedSteer({
      ...input,
      ts: 1350,
    });
    assert.equal(duplicate.changes, 0);
    assert.deepEqual(duplicate.reservation, accepted.reservation);
  });

  test('rejects accepted linkage without the exact durable response and checkpoints', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'dispatched',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer();
    db.raw.prepare(`
      DELETE FROM codex_attempt_checkpoints
       WHERE attempt_id = 'steer-attempt'
         AND kind = 'turn-steer-accepted'
    `).run();

    assert.throws(
      () => db.finalizeCodexAcceptedSteer({
        reservation_id: 'dispatch-a',
        generation_id: 'generation-a',
        steer_attempt_id: 'steer-attempt',
        target_attempt_id: 'turn-attempt',
        ...identity,
        ts: 1300,
      }),
      (error) => error.code === 'CODEX_DISPATCH_STEER_NOT_DURABLE',
    );
    assert.equal(
      db.getCodexDispatchReservation('dispatch-a').state,
      'reserved',
    );
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM codex_linked_inputs')
        .get().count,
      0,
    );
  });

  test('late accepted steer inherits an already delivered exact target', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'dispatched',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer();
    checkpoint({
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      terminalStatus: 'completed',
      ts: 1300,
    });
    checkpoint({
      kind: 'telegram-delivery-settled',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      ts: 1310,
    });

    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'replied',
    );
    const result = db.finalizeCodexAcceptedSteer({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      steer_attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      ...identity,
      ts: 1320,
    });

    assert.deepEqual(
      {
        changes: result.changes,
        state: result.reservation.state,
        settled_ts: result.reservation.settled_ts,
      },
      { changes: 0, state: 'settled', settled_ts: 1310 },
    );
    assert.equal(db.getCodexAttempt('steer-attempt').recovery_state, 'settled');
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_linked_inputs
         WHERE linked_input_id = 'dispatch-a'
      `).get().state,
      'settled',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'replied',
    );
    assert.equal(db.finalizeCodexAcceptedSteer({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      steer_attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      ...identity,
      ts: 1330,
    }).changes, 0);
  });

  test('marks conservative terminal dispositions idempotently with legal transitions', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'dispatched',
    });
    db.claimCodexDispatchReservation(reservation());

    const queue = db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      disposition: 'queue-authorized',
      ...identity,
      ts: 1200,
    });
    assert.equal(queue.changes, 1);
    assert.equal(queue.reservation.state, 'queue-authorized');
    assert.equal(db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      disposition: 'queue-authorized',
      ...identity,
      ts: 1210,
    }).changes, 0);

    const cancelled = db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      disposition: 'cancelled',
      ...identity,
      ts: 1220,
    });
    assert.equal(cancelled.reservation.state, 'cancelled');
    assert.equal(cancelled.reservation.settled_ts, 1220);
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'failed',
    );
    assert.throws(
      () => db.markCodexDispatchDisposition({
        reservation_id: 'dispatch-a',
        generation_id: 'generation-a',
        disposition: 'ambiguous',
        ...identity,
        ts: 1230,
      }),
      (error) => error.code === 'CODEX_DISPATCH_TRANSITION_INVALID',
    );

    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 43,
      bot_name: 'bot-a',
      handler_status: 'dispatched',
    });
    db.claimCodexDispatchReservation(reservation({
      reservation_id: 'dispatch-b',
      telegram_message_id: '43',
      ts: 1300,
    }));
    const ambiguous = db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-b',
      generation_id: 'generation-a',
      disposition: 'ambiguous',
      ...identity,
      ts: 1310,
    });
    assert.equal(ambiguous.reservation.state, 'ambiguous');
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 43
      `).get().handler_status,
      'codex-ambiguous',
    );
    assert.equal(db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-b',
      generation_id: 'generation-a',
      disposition: 'ambiguous',
      ...identity,
      ts: 1320,
    }).changes, 0);
    assert.throws(
      () => db.markCodexDispatchDisposition({
        reservation_id: 'dispatch-b',
        generation_id: 'generation-a',
        disposition: 'queue-authorized',
        ...identity,
        ts: 1330,
      }),
      (error) => error.code === 'CODEX_DISPATCH_TRANSITION_INVALID',
    );
  });

  for (const [terminalStatus, expectedHandler, expectedReservation] of [
    ['completed', 'replied', 'settled'],
    ['interrupted', 'failed', 'interrupted'],
    ['failed', 'failed', 'failed'],
  ]) {
    test(`target ${terminalStatus} settlement finalizes its exact linked inbound`, () => {
      seedGeneration();
      insertInbound(db, {
        chat_id: 'chat',
        msg_id: 42,
        bot_name: 'bot-a',
        handler_status: 'dispatched',
      });
      db.claimCodexDispatchReservation(reservation());
      seedAcceptedTurnAndSteer();
      db.finalizeCodexAcceptedSteer({
        reservation_id: 'dispatch-a',
        generation_id: 'generation-a',
        steer_attempt_id: 'steer-attempt',
        target_attempt_id: 'turn-attempt',
        ...identity,
        ts: 1300,
      });
      checkpoint({
        kind: 'turn-terminal',
        attemptId: 'turn-attempt',
        turnId: 'turn-a',
        terminalStatus,
        ts: 1400,
      });
      checkpoint({
        kind: 'telegram-delivery-settled',
        attemptId: 'turn-attempt',
        turnId: 'turn-a',
        ts: 1500,
      });

      assert.equal(
        db.raw.prepare(`
          SELECT handler_status FROM messages
           WHERE chat_id = 'chat' AND msg_id = 42 AND bot_name = 'bot-a'
        `).get().handler_status,
        expectedHandler,
      );
      assert.deepEqual(
        db.raw.prepare(`
          SELECT state, settled_ts
            FROM codex_dispatch_reservations
           WHERE reservation_id = 'dispatch-a'
        `).get(),
        { state: expectedReservation, settled_ts: 1500 },
      );
    });
  }

  test('failed Telegram delivery terminates the exact accepted-steer linkage', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'processing',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer();
    db.finalizeCodexAcceptedSteer({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      steer_attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      ...identity,
      ts: 1300,
    });
    checkpoint({
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      terminalStatus: 'completed',
      ts: 1400,
    });

    checkpoint({
      kind: 'telegram-delivery-failed',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      ts: 1500,
    });

    assert.equal(db.getCodexAttempt('turn-attempt').recovery_state, 'settled');
    assert.equal(db.getCodexAttempt('steer-attempt').recovery_state, 'settled');
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_linked_inputs
         WHERE linked_input_id = 'dispatch-a'
      `).get().state,
      'failed',
    );
    assert.equal(
      db.getCodexDispatchReservation('dispatch-a').state,
      'failed',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'failed',
    );
  });

  test('deploy-owned interrupted delivery stays stop-owned after reconciliation', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'processing',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer({ targetSource: '41' });
    db.finalizeCodexAcceptedSteer({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      steer_attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      ...identity,
      ts: 1300,
    });
    prepareAcceptedTurnForCleanRetirement();
    checkpoint({
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      source: '41',
      terminalStatus: 'interrupted',
      ts: 1400,
    });
    checkpoint({
      kind: 'stop-terminal-reconciled',
      turnId: 'turn-a',
      terminalStatus: 'interrupted',
      ts: 1410,
    });

    assert.deepEqual(recordFailedTurnDelivery({ ts: 1420 }), {
      changes: 1,
      attemptId: 'turn-attempt',
      kind: 'telegram-delivery-failed',
      deferred: true,
      retired: false,
    });
    assert.deepEqual(recordFailedTurnDelivery({ ts: 1420 }), {
      changes: 0,
      attemptId: 'turn-attempt',
      kind: 'telegram-delivery-failed',
      deferred: true,
      retired: false,
    });
    assert.equal(db.getCodexAttempt('turn-attempt').recovery_state, 'clean-pending');
    assert.equal(db.getCodexAttempt('steer-attempt').recovery_state, 'active');
    assert.equal(db.getCodexDispatchReservation('dispatch-a').state, 'steer-accepted');
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_linked_inputs
         WHERE linked_input_id = 'dispatch-a'
      `).get().state,
      'linked',
    );

    checkpoint({
      kind: 'stop-empty-registry-observed',
      turnId: 'turn-a',
      ts: 1430,
    });
    assert.deepEqual(db.settleCodexStoppedGeneration({
      generation_id: 'generation-a',
      ...identity,
      ts: 1440,
    }), {
      changes: 1,
      disposition: 'stop-cancelled',
      attemptId: 'turn-attempt',
      retired: true,
    });
    assert.equal(db.getCodexAttempt('turn-attempt').recovery_state, 'cancelled');
    assert.equal(db.getCodexDispatchReservation('dispatch-a').state, 'interrupted');
  });

  test('deploy-owned interrupted delivery stays stop-owned before reconciliation', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'processing',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer({ targetSource: '41' });
    db.finalizeCodexAcceptedSteer({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      steer_attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      ...identity,
      ts: 1300,
    });
    prepareAcceptedTurnForCleanRetirement();
    checkpoint({
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      source: '41',
      terminalStatus: 'interrupted',
      ts: 1400,
    });

    assert.equal(recordFailedTurnDelivery({ ts: 1410 }).deferred, true);
    assert.equal(db.getCodexAttempt('turn-attempt').recovery_state, 'terminal-pending');

    checkpoint({
      kind: 'stop-terminal-reconciled',
      turnId: 'turn-a',
      terminalStatus: 'interrupted',
      ts: 1420,
    });
    checkpoint({
      kind: 'stop-empty-registry-observed',
      turnId: 'turn-a',
      ts: 1430,
    });
    assert.equal(
      db.settleCodexStoppedGeneration({
        generation_id: 'generation-a',
        ...identity,
        ts: 1440,
      }).disposition,
      'stop-cancelled',
    );
  });

  test('background-only clean-pending interruption still settles failed delivery', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'processing',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer();
    checkpoint({
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      terminalStatus: 'interrupted',
      ts: 1400,
    });
    checkpoint({
      kind: 'background-terminal-reconciled',
      turnId: 'turn-a',
      terminalStatus: 'interrupted',
      ts: 1410,
    });
    checkpoint({
      kind: 'telegram-delivery-failed',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      ts: 1420,
    });

    assert.equal(db.getCodexAttempt('turn-attempt').recovery_state, 'settled');
    assert.equal(db.getCodexDispatchReservation('dispatch-a').state, 'failed');
  });

  test('late deploy-owned delivery waits for the stopped-generation verifier', () => {
    seedGeneration();
    seedAcceptedTurnAndSteer({ targetSource: '41' });
    prepareAcceptedTurnForCleanRetirement();
    checkpoint({
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      source: '41',
      terminalStatus: 'interrupted',
      ts: 1400,
    });
    checkpoint({
      kind: 'stop-terminal-reconciled',
      turnId: 'turn-a',
      terminalStatus: 'interrupted',
      ts: 1410,
    });
    checkpoint({
      kind: 'stop-empty-registry-observed',
      turnId: 'turn-a',
      ts: 1420,
    });

    const result = recordFailedTurnDelivery({
      ts: 1430,
      retireGeneration: true,
    });

    assert.equal(result.deferred, true);
    assert.equal(result.retired, false);
    assert.equal(db.getCodexAttempt('turn-attempt').recovery_state, 'clean-pending');
    assert.equal(db.getCodexLease().status, 'active');
  });

  test('crash after deploy ownership and deferred delivery never redispatches the original message', () => {
    seedGeneration();
    seedDeployOwnedPrimaryInput();
    seedAcceptedTurnAndSteer({ targetSource: '41' });
    prepareAcceptedTurnForCleanRetirement();
    checkpoint({
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      source: '41',
      terminalStatus: 'interrupted',
      ts: 1400,
    });
    assert.equal(recordFailedTurnDelivery({ ts: 1410 }).deferred, true);
    db.recordCrashShutdown({ botName: 'bot-a', now: 1420 });

    const { candidate, replay } = reopenAndClassifyDeployOwnedPrimary();

    assert.deepEqual(replay.recover, []);
    assert.equal(replay.recoverCodex, undefined);
    assert.deepEqual(replay.skip, []);
    assert.deepEqual(replay.defer, [candidate]);
    assertNoCleanRestartIntent();
  });

  test('crash after exact stop cancellation defers original redispatch without an intent', () => {
    seedGeneration();
    seedDeployOwnedPrimaryInput();
    seedAcceptedTurnAndSteer({ targetSource: '41' });
    prepareAcceptedTurnForCleanRetirement();
    checkpoint({
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      source: '41',
      terminalStatus: 'interrupted',
      ts: 1400,
    });
    checkpoint({
      kind: 'stop-terminal-reconciled',
      turnId: 'turn-a',
      terminalStatus: 'interrupted',
      ts: 1410,
    });
    checkpoint({
      kind: 'stop-empty-registry-observed',
      turnId: 'turn-a',
      ts: 1420,
    });
    assert.equal(db.settleCodexStoppedGeneration({
      generation_id: 'generation-a',
      ...identity,
      ts: 1430,
    }).disposition, 'stop-cancelled');
    db.recordCrashShutdown({ botName: 'bot-a', now: 1440 });

    const { candidate, replay } = reopenAndClassifyDeployOwnedPrimary();

    assert.deepEqual(replay.recover, []);
    assert.equal(replay.recoverCodex, undefined);
    assert.deepEqual(replay.defer, [candidate]);
    assert.deepEqual(replay.skip, []);
    assert.deepEqual(replay.notices, []);
    assertNoCleanRestartIntent();
  });

  test('exact healthy stop cancels an interrupted target without Telegram delivery', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'processing',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer();
    db.finalizeCodexAcceptedSteer({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      steer_attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      ...identity,
      ts: 1300,
    });
    for (const row of [
      {
        kind: 'turn-terminal',
        attemptId: 'turn-attempt',
        turnId: 'turn-a',
        terminalStatus: 'interrupted',
        ts: 1400,
      },
      {
        kind: 'stop-terminal-reconciled',
        turnId: 'turn-a',
        terminalStatus: 'interrupted',
        ts: 1410,
      },
      {
        kind: 'stop-clean-accepted',
        turnId: 'turn-a',
        ts: 1420,
      },
      {
        kind: 'stop-empty-registry-observed',
        turnId: 'turn-a',
        ts: 1430,
      },
    ]) {
      checkpoint(row);
    }

    assert.deepEqual(db.settleCodexStoppedGeneration({
      generation_id: 'generation-a',
      ...identity,
      ts: 1500,
    }), {
      changes: 1,
      disposition: 'stop-cancelled',
      attemptId: 'turn-attempt',
      retired: true,
    });
    assert.equal(db.getCodexAttempt('turn-attempt').recovery_state, 'cancelled');
    assert.equal(db.getCodexAttempt('steer-attempt').recovery_state, 'settled');
    assert.equal(db.getCodexDispatchReservation('dispatch-a').state, 'interrupted');
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'failed',
    );
    assert.equal(db.getCodexLease().status, 'clear');
  });

  test('stop cancellation closes the accepted-steer reservation before linkage finalization', () => {
    seedGeneration();
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'processing',
    });
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer();
    for (const row of [
      {
        kind: 'turn-terminal',
        attemptId: 'turn-attempt',
        turnId: 'turn-a',
        terminalStatus: 'interrupted',
        ts: 1400,
      },
      {
        kind: 'stop-terminal-reconciled',
        turnId: 'turn-a',
        terminalStatus: 'interrupted',
        ts: 1410,
      },
      {
        kind: 'stop-clean-accepted',
        turnId: 'turn-a',
        ts: 1420,
      },
      {
        kind: 'stop-empty-registry-observed',
        turnId: 'turn-a',
        ts: 1430,
      },
    ]) {
      checkpoint(row);
    }

    db.settleCodexStoppedGeneration({
      generation_id: 'generation-a',
      ...identity,
      ts: 1500,
    });

    assert.deepEqual(
      {
        state: db.getCodexDispatchReservation('dispatch-a').state,
        steerAttemptId:
          db.getCodexDispatchReservation('dispatch-a').steer_attempt_id,
        targetAttemptId:
          db.getCodexDispatchReservation('dispatch-a').target_attempt_id,
      },
      {
        state: 'interrupted',
        steerAttemptId: 'steer-attempt',
        targetAttemptId: 'turn-attempt',
      },
    );
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_linked_inputs
         WHERE linked_input_id = 'dispatch-a'
      `).get().state,
      'interrupted',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'failed',
    );
  });
});

describe('provider replay evidence', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-provider-replay'));
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'dispatched',
    });
  });
  afterEach(() => cleanupDb(dbPath, db));

  const replayKey = {
    sessionKey: 'chat:topic',
    botName: 'bot-a',
    telegramChatId: 'chat',
    telegramMessageId: '42',
  };

  function select(provider = 'codex', overrides = {}) {
    return db.recordInboundRuntimeSelection({
      session_key: 'chat:topic',
      bot_name: 'bot-a',
      telegram_chat_id: 'chat',
      telegram_message_id: '42',
      provider,
      ts: 1050,
      ...overrides,
    });
  }

  function addReplayInput(messageId, { provider = 'codex' } = {}) {
    const exactMessageId = String(messageId);
    if (exactMessageId !== '42') {
      insertInbound(db, {
        chat_id: 'chat',
        msg_id: Number(exactMessageId),
        bot_name: 'bot-a',
        handler_status: 'replay-pending',
      });
    }
    db.recordInboundRuntimeSelection({
      session_key: 'chat:topic',
      bot_name: 'bot-a',
      telegram_chat_id: 'chat',
      telegram_message_id: exactMessageId,
      provider,
      ts: 1050 + Number(exactMessageId),
    });
  }

  function replayEvidence(messageId) {
    return db.getReplayProviderRecovery({
      ...replayKey,
      telegramMessageId: String(messageId),
    });
  }

  function claimReplayReservation(messageId, state = 'reserved') {
    const exactMessageId = String(messageId);
    const reservationId = deterministicReservationId({
      telegramMessageId: exactMessageId,
    });
    db.claimCodexDispatchReservation(reservation({
      reservation_id: reservationId,
      telegram_message_id: exactMessageId,
      ts: 1100 + Number(exactMessageId),
    }));
    if (state !== 'reserved') {
      db.markCodexDispatchDisposition({
        reservation_id: reservationId,
        generation_id: 'generation-a',
        disposition: state,
        ...identity,
        ts: 1200 + Number(exactMessageId),
      });
    }
    return reservationId;
  }

  function prepareReplayAttempt(messageId, attemptId) {
    checkpoint({
      kind: 'request-prepared',
      attemptId,
      method: 'turn/start',
      source: String(messageId),
      ts: 1300 + Number(messageId),
    });
  }

  test('records exact provider selection idempotently and rejects conflicts', () => {
    assert.equal(select('codex').changes, 1);
    assert.equal(select('codex', { ts: 1060 }).changes, 0);
    assert.throws(
      () => select('claude', { ts: 1070 }),
      (error) => error.code === 'INBOUND_RUNTIME_SELECTION_CONFLICT',
    );
    assert.throws(
      () => db.recordInboundRuntimeSelection({
        session_key: 'chat:topic',
        bot_name: 'bot-a',
        telegram_chat_id: 'chat',
        telegram_message_id: '42',
        provider: 'codex',
        prompt: 'must not persist',
      }),
      (error) => error.code === 'INBOUND_RUNTIME_SELECTION_PAYLOAD_REJECTED',
    );
  });

  test('returns unknown without positive selection and Claude only when selected', () => {
    assert.deepEqual(db.getReplayProviderRecovery(replayKey), {
      provider: 'unknown',
      reason: 'selection-missing',
    });
    select('claude');
    assert.deepEqual(db.getReplayProviderRecovery(replayKey), {
      provider: 'claude',
      kind: 'selected',
      selection: {
        provider: 'claude',
        sessionKey: 'chat:topic',
        selectedTs: 1050,
      },
    });
  });

  test('returns prepared primary Codex attempt evidence', () => {
    seedGeneration();
    select('codex');
    checkpoint({
      kind: 'request-prepared',
      attemptId: 'primary-attempt',
      method: 'turn/start',
      source: '42',
      ts: 1100,
    });

    assert.deepEqual(db.getReplayProviderRecovery(replayKey), {
      provider: 'codex',
      kind: 'primary-turn',
      selection: {
        provider: 'codex',
        sessionKey: 'chat:topic',
        selectedTs: 1050,
      },
      reservation: null,
      attempt: {
        attemptId: 'primary-attempt',
        generationId: 'generation-a',
        method: 'turn/start',
        deliveryState: 'prepared',
        recoveryState: 'prepared',
        turnId: null,
        terminalStatus: null,
      },
      linkedInput: null,
      targetAttempt: null,
    });
  });

  test('returns reserved and queue-authorized Codex follow-up evidence', () => {
    seedGeneration();
    select('codex');
    db.claimCodexDispatchReservation(reservation());
    let evidence = db.getReplayProviderRecovery(replayKey);
    assert.equal(evidence.provider, 'codex');
    assert.equal(evidence.kind, 'dispatch-reservation');
    assert.equal(evidence.reservation.state, 'reserved');
    assert.equal(evidence.attempt, null);

    db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      disposition: 'queue-authorized',
      ...identity,
      ts: 1150,
    });
    evidence = db.getReplayProviderRecovery(replayKey);
    assert.equal(evidence.provider, 'codex');
    assert.equal(evidence.reservation.state, 'queue-authorized');
  });

  test('real SQLite exposes only exact definitely-not-sent Codex shapes as clean-restart safe', () => {
    seedGeneration();
    for (const messageId of [42, 43, 44, 45, 46, 47, 48, 49, 50]) {
      addReplayInput(messageId);
    }

    const reservedId = claimReplayReservation(43);
    claimReplayReservation(44, 'queue-authorized');
    prepareReplayAttempt(45, 'prepared-only');
    claimReplayReservation(46, 'queue-authorized');
    prepareReplayAttempt(46, 'prepared-with-queue');
    prepareReplayAttempt(47, 'cancelled-start');
    checkpoint({
      kind: 'active-start-cancelled',
      attemptId: 'cancelled-start',
      method: 'turn/start',
      source: '47',
      reason: 'clean-restart',
      ts: 1500,
    });
    checkpoint({
      kind: 'queued-send-cancelled',
      attemptId: 'cancelled-queued-send',
      method: 'queued/send',
      source: '48',
      clientUserMessageId: 'client-48',
      reason: 'clean-restart',
      ts: 1510,
    });
    claimReplayReservation(49, 'queue-authorized');
    prepareReplayAttempt(49, 'cancelled-start-with-queue');
    checkpoint({
      kind: 'active-start-cancelled',
      attemptId: 'cancelled-start-with-queue',
      method: 'turn/start',
      source: '49',
      reason: 'clean-restart',
      ts: 1520,
    });
    claimReplayReservation(50, 'queue-authorized');
    checkpoint({
      kind: 'queued-send-cancelled',
      attemptId: 'cancelled-queued-send-with-queue',
      method: 'queued/send',
      source: '50',
      clientUserMessageId: 'client-50',
      reason: 'clean-restart',
      ts: 1530,
    });

    const selectionOnly = replayEvidence(42);
    assert.deepEqual(selectionOnly, {
      provider: 'codex',
      kind: 'selection-only',
      selection: {
        provider: 'codex',
        sessionKey: 'chat:topic',
        selectedTs: 1092,
      },
      reservation: null,
      attempt: null,
      linkedInput: null,
      targetAttempt: null,
    });

    const reservedOnly = replayEvidence(43);
    assert.deepEqual(reservedOnly.reservation, {
      reservationId: reservedId,
      generationId: 'generation-a',
      state: 'reserved',
      steerAttemptId: null,
      targetAttemptId: null,
    });
    assert.equal(reservedOnly.attempt, null);

    const preparedOnly = replayEvidence(45);
    assert.equal(preparedOnly.attempt.deliveryState, 'prepared');
    assert.equal(preparedOnly.attempt.recoveryState, 'prepared');
    assert.equal(preparedOnly.attempt.turnId, null);
    assert.equal(preparedOnly.attempt.terminalStatus, null);

    const cancelledStart = replayEvidence(47);
    assert.deepEqual(cancelledStart.cancellationProof, {
      kind: 'active-start-cancelled',
      reason: 'clean-restart',
    });
    const cancelledQueued = replayEvidence(48);
    assert.equal(cancelledQueued.attempt.method, 'queued/send');
    assert.deepEqual(cancelledQueued.cancellationProof, {
      kind: 'queued-send-cancelled',
      reason: 'clean-restart',
    });
    const cancelledQueuedWithReservation = replayEvidence(50);
    assert.equal(cancelledQueuedWithReservation.kind, 'queued-send');
    assert.equal(
      cancelledQueuedWithReservation.reservation.state,
      'queue-authorized',
    );
    assert.deepEqual(cancelledQueuedWithReservation.cancellationProof, {
      kind: 'queued-send-cancelled',
      reason: 'clean-restart',
    });

    for (const messageId of [42, 43, 44, 45, 46, 47, 48, 49, 50]) {
      const disposition = classifyCodexRecoveryEvidence(
        replayEvidence(messageId),
      );
      assert.equal(disposition.action, 'recover', String(messageId));
      assert.equal(disposition.cleanRestartSafe, true, String(messageId));
    }
  });

  test('synthetic queued cancellation requires exact identity and active lease', () => {
    seedGeneration();

    for (const [attemptId, missing] of [
      ['missing-method', { method: undefined }],
      ['missing-source', { source: undefined }],
      ['missing-client', { clientUserMessageId: undefined }],
      ['non-null-turn', { turnId: 'turn-must-be-null' }],
    ]) {
      assert.throws(
        () => db.recordCodexCheckpoint({
          generationId: 'generation-a',
          threadId: 'thread-a',
          ...identity,
          kind: 'queued-send-cancelled',
          attemptId,
          method: 'queued/send',
          source: '42',
          clientUserMessageId: `client-${attemptId}`,
          reason: 'clean-restart',
          ts: 1600,
          ...missing,
        }),
        (error) => error?.code === 'CODEX_CHECKPOINT_INPUT_INVALID',
        attemptId,
      );
    }

    db.raw.prepare(`
      UPDATE codex_daemon_lease SET status = 'clear' WHERE singleton = 1
    `).run();
    assert.throws(
      () => db.recordCodexCheckpoint({
        generationId: 'generation-a',
        threadId: 'thread-a',
        ...identity,
        kind: 'queued-send-cancelled',
        attemptId: 'stale-owner',
        method: 'queued/send',
        source: '42',
        clientUserMessageId: 'client-stale-owner',
        reason: 'clean-restart',
        ts: 1610,
      }),
      (error) => error?.code === 'CODEX_CHECKPOINT_STALE_GENERATION',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_turn_attempts
         WHERE method = 'queued/send'
      `).get().count,
      0,
    );
  });

  test('real SQLite rejects wrong provenance, state, links, conflicts, and partial queued sends', () => {
    seedGeneration();
    for (const messageId of [42, 43, 44, 45, 46, 47, 48]) {
      addReplayInput(messageId);
    }

    prepareReplayAttempt(42, 'user-cancelled-start');
    checkpoint({
      kind: 'active-start-cancelled',
      attemptId: 'user-cancelled-start',
      method: 'turn/start',
      source: '42',
      reason: 'user-stop',
      ts: 1500,
    });

    prepareReplayAttempt(43, 'write-attempted-start');
    checkpoint({
      kind: 'request-write-attempted',
      attemptId: 'write-attempted-start',
      method: 'turn/start',
      source: '43',
      requestId: 'request-43',
      ts: 1510,
    });
    checkpoint({
      kind: 'active-start-cancelled',
      attemptId: 'write-attempted-start',
      method: 'turn/start',
      source: '43',
      reason: 'clean-restart',
      ts: 1520,
    });

    prepareReplayAttempt(44, 'non-null-terminal-start');
    checkpoint({
      kind: 'active-start-cancelled',
      attemptId: 'non-null-terminal-start',
      method: 'turn/start',
      source: '44',
      reason: 'clean-restart',
      ts: 1530,
    });
    db.raw.prepare(`
      UPDATE codex_turn_attempts
         SET turn_id = 'turn-44', terminal_status = 'interrupted'
       WHERE attempt_id = 'non-null-terminal-start'
    `).run();

    claimReplayReservation(45);
    prepareReplayAttempt(45, 'reserved-prepared-start');

    checkpoint({
      kind: 'queued-send-cancelled',
      attemptId: 'partial-queued-send',
      method: 'queued/send',
      source: '46',
      reason: 'timeout',
      ts: 1540,
    });

    prepareReplayAttempt(47, 'conflicting-start-a');
    prepareReplayAttempt(47, 'conflicting-start-b');

    db.raw.prepare(`
      INSERT INTO codex_turn_attempts (
        attempt_id, generation_id, session_key, method, thread_id,
        telegram_source_message_id, delivery_state, recovery_state,
        created_ts, updated_ts
      ) VALUES (
        'unsupported-queued-send', 'generation-a', 'chat:topic',
        'queued/send', 'thread-a', '48', 'prepared', 'prepared', 1600, 1600
      )
    `).run();

    for (const messageId of [42, 43, 44, 45, 46, 47, 48]) {
      const evidence = replayEvidence(messageId);
      assert.notEqual(
        classifyCodexRecoveryEvidence(evidence).cleanRestartSafe,
        true,
        String(messageId),
      );
      if (evidence.provider === 'codex') {
        assert.equal(evidence.cancellationProof == null, true, String(messageId));
      }
    }

    assert.equal(
      classifyCodexRecoveryEvidence(replayEvidence(42)).action,
      'skip',
      'an explicit user cancellation remains cancelled',
    );
    assert.equal(
      classifyCodexRecoveryEvidence(replayEvidence(43)).action,
      'defer',
      'a write-attempted request remains ambiguous',
    );
    assert.equal(replayEvidence(47).provider, 'unknown');
    assert.equal(
      classifyCodexRecoveryEvidence(replayEvidence(48)).action,
      'defer',
      'an unsupported partial queued send is not generalized as safe',
    );
  });

  test('returns linked steer and exact target attempt evidence', () => {
    seedGeneration();
    select('codex');
    db.claimCodexDispatchReservation(reservation());
    seedAcceptedTurnAndSteer();
    db.finalizeCodexAcceptedSteer({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      steer_attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      ...identity,
      ts: 1300,
    });

    const evidence = db.getReplayProviderRecovery(replayKey);
    assert.equal(evidence.provider, 'codex');
    assert.equal(evidence.kind, 'linked-input');
    assert.equal(evidence.attempt.attemptId, 'steer-attempt');
    assert.equal(evidence.attempt.deliveryState, 'response-observed');
    assert.equal(evidence.linkedInput.state, 'linked');
    assert.equal(evidence.targetAttempt.attemptId, 'turn-attempt');
    assert.equal(evidence.targetAttempt.recoveryState, 'active');
    assert.notEqual(
      classifyCodexRecoveryEvidence(evidence).cleanRestartSafe,
      true,
    );
  });

  test('fails closed on provider conflict or multiple exact Codex attempts', () => {
    seedGeneration();
    select('claude');
    checkpoint({
      kind: 'request-prepared',
      attemptId: 'unexpected-codex',
      method: 'turn/start',
      source: '42',
      ts: 1100,
    });
    assert.deepEqual(db.getReplayProviderRecovery(replayKey), {
      provider: 'unknown',
      reason: 'provider-evidence-conflict',
    });

    db.raw.prepare(`
      UPDATE inbound_runtime_selections SET provider = 'codex'
    `).run();
    checkpoint({
      kind: 'request-prepared',
      attemptId: 'duplicate-codex',
      method: 'turn/start',
      source: '42',
      ts: 1110,
    });
    assert.deepEqual(db.getReplayProviderRecovery(replayKey), {
      provider: 'unknown',
      reason: 'codex-evidence-conflict',
    });
  });
});

describe('clean-restart Codex replay reservation rearm', () => {
  const source = {
    botName: 'bot-a',
    telegramChatId: 'chat',
    telegramMessageId: '42',
  };
  const currentGeneration = {
    generationId: 'generation-b',
  };
  const currentOwner = {
    stableHostId: 'host-a',
    bootSessionId: 'boot-b',
  };
  const replayKey = {
    sessionKey: 'chat:topic',
    botName: source.botName,
    telegramChatId: source.telegramChatId,
    telegramMessageId: source.telegramMessageId,
  };

  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-clean-codex-replay'));
  });
  afterEach(() => cleanupDb(dbPath, db));

  function seedReplaySelection() {
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'replay-pending',
    });
    db.recordInboundRuntimeSelection({
      session_key: 'chat:topic',
      bot_name: 'bot-a',
      telegram_chat_id: 'chat',
      telegram_message_id: '42',
      provider: 'codex',
      ts: 1050,
    });
  }

  function seedOldReplayShape(shape) {
    seedReplaySelection();
    if (shape === 'selection-only') {
      return db.getReplayProviderRecovery(replayKey);
    }

    seedGeneration();
    const reservationId = deterministicReservationId();
    if ([
      'reserved',
      'queue-authorized',
      'prepared-with-queue',
      'cancelled-start-with-queue',
      'cancelled-queued-send-with-queue',
    ].includes(shape)) {
      db.claimCodexDispatchReservation(reservation({ reservation_id: reservationId }));
    }
    if ([
      'queue-authorized',
      'prepared-with-queue',
      'cancelled-start-with-queue',
      'cancelled-queued-send-with-queue',
    ].includes(shape)) {
      db.markCodexDispatchDisposition({
        reservation_id: reservationId,
        generation_id: 'generation-a',
        disposition: 'queue-authorized',
        ...identity,
        ts: 1150,
      });
    }
    if ([
      'prepared-only',
      'prepared-with-queue',
      'cancelled-start',
      'cancelled-start-with-queue',
    ].includes(shape)) {
      checkpoint({
        kind: 'request-prepared',
        attemptId: `${shape}-attempt`,
        method: 'turn/start',
        source: '42',
        ts: 1200,
      });
    }
    if (['cancelled-start', 'cancelled-start-with-queue'].includes(shape)) {
      checkpoint({
        kind: 'active-start-cancelled',
        attemptId: `${shape}-attempt`,
        method: 'turn/start',
        source: '42',
        reason: 'clean-restart',
        ts: 1210,
      });
    }
    if (['cancelled-queued-send', 'cancelled-queued-send-with-queue'].includes(shape)) {
      checkpoint({
        kind: 'queued-send-cancelled',
        attemptId: `${shape}-attempt`,
        method: 'queued/send',
        source: '42',
        clientUserMessageId: `client-${shape}`,
        reason: 'clean-restart',
        ts: 1210,
      });
    }
    return db.getReplayProviderRecovery(replayKey);
  }

  function activateCurrentGeneration({ generationId = 'generation-b' } = {}) {
    if (db.getCodexLease()?.status === 'active') {
      db.markCodexGenerationRetired({
        generation_id: 'generation-a',
        ts: 1300,
      });
    }
    const persistedIdentity = db.raw.prepare(`
      SELECT last_boot_session_id
        FROM codex_runtime_identity
       WHERE singleton = 1
    `).get();
    if (
      persistedIdentity
      && persistedIdentity.last_boot_session_id !== 'boot-b'
    ) {
      const reconstructed = db.reconstructCodexRecovery({
        stable_host_id: 'host-a',
        boot_session_id: 'boot-b',
        startup_recovery: {
          exclusive_daemon_ownership: true,
          supervisor_grace_elapsed: true,
        },
        now: 1350,
      });
      assert.equal(reconstructed.status, 'clear');
    }
    db.createCodexGeneration({
      generation_id: generationId,
      session_key: 'chat:topic',
      thread_id: 'thread-b',
      app_server_session_id: 'diagnostic-b',
      stable_host_id: 'host-a',
      boot_session_id: 'boot-b',
      ts: 1400,
    });
    db.acquireCodexLease({
      generation_id: generationId,
      stable_host_id: 'host-a',
      boot_session_id: 'boot-b',
      ts: 1410,
    });
  }

  function prepareReplayInput(expectedEvidence, overrides = {}) {
    return {
      source,
      sessionKey: 'chat:topic',
      currentGeneration,
      expectedEvidence,
      owner: currentOwner,
      ts: 1500,
      ...overrides,
    };
  }

  function durableReplayState() {
    return {
      handlerStatus: db.raw.prepare(`
        SELECT handler_status
          FROM messages
         WHERE bot_name = 'bot-a'
           AND chat_id = 'chat'
           AND CAST(msg_id AS TEXT) = '42'
      `).get()?.handler_status,
      reservations: db.raw.prepare(`
        SELECT reservation_id, generation_id, session_key, state,
               steer_attempt_id, target_attempt_id, settled_ts
          FROM codex_dispatch_reservations
         WHERE bot_name = 'bot-a'
           AND telegram_chat_id = 'chat'
           AND telegram_message_id = '42'
         ORDER BY reservation_id
      `).all(),
    };
  }

  for (const shape of [
    'selection-only',
    'reserved',
    'queue-authorized',
    'prepared-only',
    'prepared-with-queue',
    'cancelled-start',
    'cancelled-start-with-queue',
    'cancelled-queued-send',
    'cancelled-queued-send-with-queue',
  ]) {
    test(`atomically rearms ${shape} under the new generation exactly once`, () => {
      const expectedEvidence = seedOldReplayShape(shape);
      activateCurrentGeneration();

      const receipt = db.prepareCodexCleanReplay(
        prepareReplayInput(expectedEvidence),
      );
      const reservationRow = durableReplayState().reservations[0];
      const expectedReservationId = deterministicReservationId();

      assert.equal(receipt.reservationId, expectedReservationId);
      assert.equal(receipt.generationId, 'generation-b');
      assert.equal(receipt.reservation.state, 'reserved');
      assert.deepEqual(reservationRow, {
        reservation_id: expectedReservationId,
        generation_id: 'generation-b',
        session_key: 'chat:topic',
        state: 'reserved',
        steer_attempt_id: null,
        target_attempt_id: null,
        settled_ts: null,
      });
      assert.equal(durableReplayState().handlerStatus, 'replay-attempted');
      assert.equal(
        db.getReplayCandidates({ chatIds: ['chat'] }).length,
        0,
        'a crash after commit must not select the one-shot input again',
      );
    });
  }

  for (const [name, mutate] of [
    [
      'stale expected evidence',
      ({ input }) => ({
        ...input,
        expectedEvidence: {
          ...input.expectedEvidence,
          kind: 'stale-shape',
        },
      }),
    ],
    [
      'wrong current generation',
      ({ input }) => ({
        ...input,
        currentGeneration: { generationId: 'generation-missing' },
      }),
    ],
    [
      'wrong active owner',
      ({ input }) => ({
        ...input,
        owner: { ...currentOwner, bootSessionId: 'boot-wrong' },
      }),
    ],
    [
      'reservation changed after evidence capture',
      ({ input }) => {
        db.raw.prepare(`
          UPDATE codex_dispatch_reservations
             SET state = 'ambiguous'
           WHERE telegram_message_id = '42'
        `).run();
        return input;
      },
    ],
  ]) {
    test(`${name} rolls back the reservation and one-shot guard together`, () => {
      const expectedEvidence = seedOldReplayShape('queue-authorized');
      activateCurrentGeneration();
      const input = mutate({ input: prepareReplayInput(expectedEvidence) });
      const before = durableReplayState();

      assert.throws(
        () => db.prepareCodexCleanReplay(input),
        (error) => (
          typeof error.code === 'string'
          && error.code.startsWith('CODEX_CLEAN_REPLAY_')
        ),
      );
      assert.deepEqual(durableReplayState(), before);
    });
  }

  test('a forced inbound write failure rolls back a safe reservation rebind', () => {
    const expectedEvidence = seedOldReplayShape('prepared-with-queue');
    activateCurrentGeneration();
    const before = durableReplayState();
    db.raw.exec(`
      CREATE TRIGGER reject_codex_clean_replay_guard
      BEFORE UPDATE OF handler_status ON messages
      WHEN NEW.handler_status = 'replay-attempted'
      BEGIN
        SELECT RAISE(ABORT, 'injected replay guard failure');
      END
    `);

    assert.throws(
      () => db.prepareCodexCleanReplay(prepareReplayInput(expectedEvidence)),
      /injected replay guard failure/,
    );
    assert.deepEqual(durableReplayState(), before);
  });
});

describe('queued Codex dispatch settlement', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-queued-settlement'));
    insertInbound(db, {
      chat_id: 'chat',
      msg_id: 42,
      bot_name: 'bot-a',
      handler_status: 'processing',
    });
    seedGeneration();
  });
  afterEach(() => cleanupDb(dbPath, db));

  const settlement = {
    attempt_id: 'queued-attempt',
    generation_id: 'generation-a',
    session_key: 'chat:topic',
    bot_name: 'bot-a',
    telegram_chat_id: 'chat',
    telegram_message_id: '42',
    ...identity,
    ts: 1400,
  };

  test('completed primary turn with no reservation is a safe no-op', () => {
    seedCompletedStartAttempt();
    assert.deepEqual(db.settleCodexQueuedDispatch(settlement), {
      changes: 0,
      outcome: 'no-reservation',
      reservation: null,
    });
  });

  test('settles the exact queue-authorized reservation idempotently', () => {
    db.recordInboundRuntimeSelection({
      session_key: 'chat:topic',
      bot_name: 'bot-a',
      telegram_chat_id: 'chat',
      telegram_message_id: '42',
      provider: 'codex',
      ts: 1100,
    });
    db.claimCodexDispatchReservation(reservation());
    db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      disposition: 'queue-authorized',
      ...identity,
      ts: 1150,
    });
    seedCompletedStartAttempt();

    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'replied',
    );
    assert.equal(
      db.getCodexDispatchReservation('dispatch-a').state,
      'settled',
    );
    const settled = db.settleCodexQueuedDispatch(settlement);
    assert.equal(settled.changes, 0);
    assert.equal(settled.outcome, 'settled');
    assert.equal(settled.reservation.state, 'settled');
    assert.equal(settled.reservation.target_attempt_id, 'queued-attempt');
    const recovery = db.getReplayProviderRecovery({
      sessionKey: 'chat:topic',
      botName: 'bot-a',
      telegramChatId: 'chat',
      telegramMessageId: '42',
    });
    assert.equal(recovery.provider, 'codex');
    assert.equal(recovery.kind, 'dispatch-reservation');
    assert.equal(recovery.reservation.state, 'settled');
    assert.equal(recovery.attempt.attemptId, 'queued-attempt');
    assert.equal(recovery.targetAttempt.attemptId, 'queued-attempt');
    assert.equal(db.settleCodexQueuedDispatch({
      ...settlement,
      ts: 1410,
    }).changes, 0);
  });

  test('delivery settlement rolls back the attempt, inbound, and queue together', () => {
    db.recordInboundRuntimeSelection({
      session_key: 'chat:topic',
      bot_name: 'bot-a',
      telegram_chat_id: 'chat',
      telegram_message_id: '42',
      provider: 'codex',
      ts: 1100,
    });
    db.claimCodexDispatchReservation(reservation());
    db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      disposition: 'queue-authorized',
      ...identity,
      ts: 1150,
    });
    seedCompletedStartAttempt({ settleDelivery: false });
    db.raw.exec(`
      CREATE TRIGGER reject_replied_inbound
      BEFORE UPDATE OF handler_status ON messages
      WHEN NEW.handler_status = 'replied'
      BEGIN
        SELECT RAISE(ABORT, 'injected inbound settlement failure');
      END
    `);

    assert.throws(
      () => checkpoint({
        kind: 'telegram-delivery-settled',
        attemptId: 'queued-attempt',
        turnId: 'queued-turn',
        source: '42',
        ts: 1250,
      }),
      /injected inbound settlement failure/,
    );
    assert.equal(
      db.getCodexAttempt('queued-attempt').recovery_state,
      'terminal-pending',
    );
    assert.equal(
      db.getCodexDispatchReservation('dispatch-a').state,
      'queue-authorized',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'processing',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE attempt_id = 'queued-attempt'
           AND kind = 'telegram-delivery-settled'
      `).get().count,
      0,
    );
  });

  test('failed Telegram delivery terminates the exact queue-authorized reservation', () => {
    db.recordInboundRuntimeSelection({
      session_key: 'chat:topic',
      bot_name: 'bot-a',
      telegram_chat_id: 'chat',
      telegram_message_id: '42',
      provider: 'codex',
      ts: 1100,
    });
    db.claimCodexDispatchReservation(reservation());
    db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      disposition: 'queue-authorized',
      ...identity,
      ts: 1150,
    });
    for (const row of [
      {
        kind: 'request-prepared',
        attemptId: 'queued-attempt',
        method: 'turn/start',
        source: '42',
        ts: 1200,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'queued-attempt',
        method: 'turn/start',
        source: '42',
        requestId: 'queued-attempt-request',
        ts: 1210,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'queued-attempt',
        method: 'turn/start',
        source: '42',
        requestId: 'queued-attempt-request',
        outcome: 'result',
        ts: 1220,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'queued-attempt',
        turnId: 'queued-turn',
        source: '42',
        ts: 1230,
      },
      {
        kind: 'turn-terminal',
        attemptId: 'queued-attempt',
        turnId: 'queued-turn',
        source: '42',
        terminalStatus: 'completed',
        ts: 1240,
      },
      {
        kind: 'telegram-delivery-failed',
        attemptId: 'queued-attempt',
        turnId: 'queued-turn',
        source: '42',
        ts: 1250,
      },
    ]) {
      checkpoint(row);
    }

    assert.deepEqual(
      {
        state: db.getCodexDispatchReservation('dispatch-a').state,
        targetAttemptId:
          db.getCodexDispatchReservation('dispatch-a').target_attempt_id,
      },
      {
        state: 'failed',
        targetAttemptId: 'queued-attempt',
      },
    );
    assert.equal(
      db.raw.prepare(`
        SELECT handler_status FROM messages
         WHERE chat_id = 'chat' AND msg_id = 42
      `).get().handler_status,
      'failed',
    );
  });

  test('fails closed for mismatched reservation or non-completed attempt', () => {
    db.claimCodexDispatchReservation(reservation());
    db.markCodexDispatchDisposition({
      reservation_id: 'dispatch-a',
      generation_id: 'generation-a',
      disposition: 'queue-authorized',
      ...identity,
      ts: 1150,
    });
    checkpoint({
      kind: 'request-prepared',
      attemptId: 'queued-attempt',
      method: 'turn/start',
      source: '42',
      ts: 1200,
    });
    assert.throws(
      () => db.settleCodexQueuedDispatch(settlement),
      (error) => error.code === 'CODEX_QUEUE_SETTLEMENT_NOT_DURABLE',
    );

    for (const row of [
      {
        kind: 'request-write-attempted',
        attemptId: 'queued-attempt',
        method: 'turn/start',
        source: '42',
        requestId: 'queued-attempt-request',
        ts: 1210,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'queued-attempt',
        method: 'turn/start',
        source: '42',
        requestId: 'queued-attempt-request',
        outcome: 'result',
        ts: 1220,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'queued-attempt',
        turnId: 'queued-turn',
        source: '42',
        ts: 1230,
      },
      {
        kind: 'turn-terminal',
        attemptId: 'queued-attempt',
        turnId: 'queued-turn',
        source: '42',
        terminalStatus: 'completed',
        ts: 1240,
      },
      {
        kind: 'telegram-delivery-settled',
        attemptId: 'queued-attempt',
        turnId: 'queued-turn',
        source: '42',
        ts: 1250,
      },
    ]) {
      checkpoint(row);
    }
    db.raw.prepare(`
      UPDATE codex_dispatch_reservations SET session_key = 'other:topic'
    `).run();
    assert.throws(
      () => db.settleCodexQueuedDispatch(settlement),
      (error) => error.code === 'CODEX_QUEUE_SETTLEMENT_CONFLICT',
    );
  });
});

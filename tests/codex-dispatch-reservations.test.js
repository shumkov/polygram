'use strict';

const { afterEach, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupDb,
  freshDb,
  insertInbound,
} = require('./helpers/db-fixture');

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

function checkpoint(row) {
  return db.recordCodexCheckpoint({
    generationId: 'generation-a',
    threadId: 'thread-a',
    ...identity,
    ...row,
  });
}

function seedAcceptedTurnAndSteer() {
  for (const row of [
    {
      kind: 'request-prepared',
      attemptId: 'turn-attempt',
      method: 'turn/start',
      ts: 1200,
    },
    {
      kind: 'request-write-attempted',
      attemptId: 'turn-attempt',
      method: 'turn/start',
      requestId: 'turn-request',
      ts: 1210,
    },
    {
      kind: 'request-response-observed',
      attemptId: 'turn-attempt',
      method: 'turn/start',
      requestId: 'turn-request',
      outcome: 'result',
      ts: 1220,
    },
    {
      kind: 'turn-accepted',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
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

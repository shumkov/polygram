'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCodexReconciliationView,
  createHandleCodexReconciliationCallback,
} = require('../lib/handlers/codex-reconciliation');
const {
  freshDb,
  cleanupDb,
  insertInbound,
} = require('./helpers/db-fixture');

let db;
let dbPath;

function seedAmbiguousAttempt() {
  insertInbound(db, {
    chat_id: '12345',
    msg_id: 42,
    user: 'Owner',
    user_id: 99,
    text: 'do not render this prompt',
    bot_name: 'test-bot',
    handler_status: 'codex-ambiguous',
    ts: 900,
  });
  db.recordInboundRuntimeSelection({
    session_key: '12345',
    bot_name: 'test-bot',
    telegram_chat_id: '12345',
    telegram_message_id: '42',
    provider: 'codex',
    ts: 950,
  });
  db.createCodexGeneration({
    generation_id: 'generation-a',
    session_key: '12345',
    thread_id: 'thread-a',
    stable_host_id: 'host-a',
    boot_session_id: 'boot-a',
    ts: 1000,
  });
  db.recordCodexCheckpoint({
    kind: 'request-prepared',
    generationId: 'generation-a',
    attemptId: 'attempt-a',
    method: 'turn/start',
    threadId: 'thread-a',
    source: '42',
    stable_host_id: 'host-a',
    boot_session_id: 'boot-a',
    ts: 1100,
  });
  db.acquireCodexLease({
    generation_id: 'generation-a',
    stable_host_id: 'host-a',
    boot_session_id: 'boot-a',
    ts: 1150,
  });
  db.recordCodexCheckpoint({
    kind: 'request-write-attempted',
    generationId: 'generation-a',
    attemptId: 'attempt-a',
    method: 'turn/start',
    requestId: '1',
    threadId: 'thread-a',
    stable_host_id: 'host-a',
    boot_session_id: 'boot-a',
    ts: 1200,
  });
  db.recordCodexCheckpoint({
    kind: 'failed-ambiguous-entered',
    generationId: 'generation-a',
    attemptId: 'attempt-a',
    threadId: 'thread-a',
    reason: 'transport-lost',
    stable_host_id: 'host-a',
    boot_session_id: 'boot-a',
    ts: 1300,
  });
  db.markCodexContainment({
    generation_id: 'generation-a',
    reason: 'transport-lost',
    stable_host_id: 'host-a',
    boot_session_id: 'boot-a',
    ts: 1400,
  });
}

function makeLock(trace) {
  return {
    acquire: async (key) => {
      trace.push(['lock', key]);
      return () => trace.push(['unlock', key]);
    },
  };
}

function makeCtx(data, overrides = {}) {
  const trace = overrides.trace ?? [];
  return {
    callbackQuery: {
      data,
      message: {
        chat: { id: 12345 },
      },
      from: { id: 99, first_name: 'Owner' },
    },
    from: { id: 99, first_name: 'Owner' },
    answerCallbackQuery: async (args) => trace.push(['ack', args]),
    editMessageReplyMarkup: async (replyMarkup) => {
      trace.push(['edit', replyMarkup]);
    },
    _trace: trace,
    ...overrides,
  };
}

function makeHandler(overrides = {}) {
  const trace = overrides.trace ?? [];
  return createHandleCodexReconciliationCallback({
    config: {
      bot: { operatorUserId: 99 },
      chats: { 12345: {} },
    },
    db,
    intentLock: makeLock(trace),
    getSessionKey: (chatId) => String(chatId),
    retryAttemptId: () => 'attempt-retry',
    now: () => 2000,
    logger: { error: () => {} },
    ...overrides,
  });
}

describe('Codex reconciliation Telegram UI', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('polygram-handler-codex-reconcile'));
    seedAmbiguousAttempt();
  });
  afterEach(() => cleanupDb(dbPath, db));

  test('renders content-free owner actions and an explicit duplicate-risk retry', () => {
    const [attempt] = db.listUnresolvedCodexAttempts({
      session_key: '12345',
    });
    const view = buildCodexReconciliationView(attempt);
    const buttons = view.reply_markup.inline_keyboard.flat();

    assert.match(view.text, /message #42/);
    assert.match(view.text, /does not control runtime availability/i);
    assert.doesNotMatch(view.text, /do not render this prompt/);
    assert.deepEqual(
      buttons.map((button) => button.text),
      [
        '✓ Mark incorporated',
        'Dismiss without retry',
        '⚠ Authorize one retry (duplicate risk)',
      ],
    );
    for (const button of buttons) {
      assert.ok(
        Buffer.byteLength(button.callback_data, 'utf8') <= 64,
        'Telegram callback data stays within the Bot API limit',
      );
    }
  });

  test('authorized owner decision persists under the intent lock before UI changes', async () => {
    const trace = [];
    const [attempt] = db.listUnresolvedCodexAttempts({
      session_key: '12345',
    });
    const view = buildCodexReconciliationView(attempt);
    const incorporated = view.reply_markup.inline_keyboard[0][0].callback_data;
    const originalReconcile = db.reconcileCodexAttempt;
    db.reconcileCodexAttempt = (input) => {
      trace.push(['persist', input]);
      return originalReconcile(input);
    };
    const handler = makeHandler({ trace, intentLock: makeLock(trace) });

    assert.equal(await handler(makeCtx(incorporated, { trace })), true);
    assert.deepEqual(
      trace.map(([kind]) => kind),
      ['lock', 'persist', 'edit', 'ack', 'unlock'],
    );
    assert.deepEqual(
      db.raw.prepare(`
        SELECT disposition, actor, reason, decided_ts
          FROM codex_attempt_reconciliations
      `).get(),
      {
        disposition: 'incorporated',
        actor: 'telegram-user:99',
        reason: 'owner marked the ambiguous input incorporated via Telegram',
        decided_ts: 2000,
      },
    );
  });

  test('persistence failure leaves the reconciliation UI actionable', async () => {
    const trace = [];
    const [attempt] = db.listUnresolvedCodexAttempts({
      session_key: '12345',
    });
    const view = buildCodexReconciliationView(attempt);
    const incorporated = view.reply_markup.inline_keyboard[0][0].callback_data;
    db.reconcileCodexAttempt = () => {
      trace.push(['persist-failed']);
      throw Object.assign(new Error('disk full'), {
        code: 'CODEX_RECONCILIATION_DURABILITY_FAILED',
      });
    };
    const handler = makeHandler({ trace, intentLock: makeLock(trace) });

    await assert.rejects(
      handler(makeCtx(incorporated, { trace })),
      (error) => error.code === 'CODEX_RECONCILIATION_DURABILITY_FAILED',
    );
    assert.deepEqual(
      trace.map(([kind]) => kind),
      ['lock', 'persist-failed', 'unlock'],
    );
  });

  test('retry click is explicit acknowledgement and creates one reservation without dispatch', async () => {
    const [attempt] = db.listUnresolvedCodexAttempts({
      session_key: '12345',
    });
    const view = buildCodexReconciliationView(attempt);
    const retry = view.reply_markup.inline_keyboard[1][0].callback_data;
    const handler = makeHandler();

    assert.equal(await handler(makeCtx(retry)), true);
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
    assert.equal(
      db.getCodexAttempt('attempt-retry'),
      undefined,
      'authorization alone does not materialize or dispatch the retry',
    );
    assert.equal(db.getCodexLease().status, 'quarantined');
  });

  test('retry stays blocked while the prior generation is active', async () => {
    db.raw.prepare(`
      UPDATE codex_generations
         SET state = 'active',
             containment_reason = NULL
       WHERE generation_id = 'generation-a'
    `).run();
    db.raw.prepare(`
      UPDATE codex_daemon_lease
         SET status = 'active',
             quarantine_reason = NULL
       WHERE singleton = 1
    `).run();
    const [attempt] = db.listUnresolvedCodexAttempts({
      session_key: '12345',
    });
    const view = buildCodexReconciliationView(attempt);
    const retry = view.reply_markup.inline_keyboard[1][0].callback_data;
    const ctx = makeCtx(retry);

    await makeHandler()(ctx);

    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count FROM codex_attempt_reconciliations
      `).get().count,
      0,
    );
    assert.match(ctx._trace.at(-1)[1].text, /wait .* finish/i);
  });

  test('foreign actor and cross-session callback are rejected without persistence', async () => {
    const [attempt] = db.listUnresolvedCodexAttempts({
      session_key: '12345',
    });
    const view = buildCodexReconciliationView(attempt);
    const dismissed = view.reply_markup.inline_keyboard[0][1].callback_data;
    const handler = makeHandler();
    const foreign = makeCtx(dismissed);
    foreign.from.id = 100;
    foreign.callbackQuery.from.id = 100;
    await handler(foreign);

    const wrongSession = makeCtx(dismissed);
    wrongSession.callbackQuery.message.chat.id = 54321;
    await handler(wrongSession);

    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count FROM codex_attempt_reconciliations
      `).get().count,
      0,
    );
    assert.match(foreign._trace.at(-1)[1].text, /not authorised/i);
    assert.match(wrongSession._trace.at(-1)[1].text, /not available/i);
  });

  test('missing explicit operator identity fails closed', async () => {
    const [attempt] = db.listUnresolvedCodexAttempts({
      session_key: '12345',
    });
    const view = buildCodexReconciliationView(attempt);
    const dismissed = view.reply_markup.inline_keyboard[0][1].callback_data;
    const ctx = makeCtx(dismissed);
    const handler = makeHandler({
      config: {
        bot: {},
        chats: { 12345: {} },
      },
    });

    await handler(ctx);

    assert.match(ctx._trace.at(-1)[1].text, /not authorised/i);
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count FROM codex_attempt_reconciliations
      `).get().count,
      0,
    );
  });

  test('duplicate callback is stale and cannot change the first durable decision', async () => {
    const [attempt] = db.listUnresolvedCodexAttempts({
      session_key: '12345',
    });
    const view = buildCodexReconciliationView(attempt);
    const incorporated = view.reply_markup.inline_keyboard[0][0].callback_data;
    const dismissed = view.reply_markup.inline_keyboard[0][1].callback_data;
    const handler = makeHandler();

    await handler(makeCtx(incorporated));
    const duplicate = makeCtx(dismissed);
    await handler(duplicate);

    assert.equal(
      db.raw.prepare(`
        SELECT disposition FROM codex_attempt_reconciliations
      `).get().disposition,
      'incorporated',
    );
    assert.match(duplicate._trace.at(-1)[1].text, /already resolved|no longer available/i);
  });
});

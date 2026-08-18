'use strict';

const { afterEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createAutosteerHandlers } = require('../lib/handlers/autosteer');
const { classifyReplay } = require('../lib/handlers/replay-disposition');
const {
  settleAcceptedAutosteerOwnership,
  shouldDispatchPrimaryAfterAutosteer,
} = require('../lib/handlers/claude-autosteer-ownership');
const {
  freshDb,
  cleanupDb,
  insertInbound,
} = require('./helpers/db-fixture');

const opened = [];

afterEach(() => {
  while (opened.length > 0) {
    const fixture = opened.pop();
    cleanupDb(fixture.dbPath, fixture.db);
  }
});

function database() {
  const fixture = freshDb('claude-autosteer-ownership');
  opened.push(fixture);
  return fixture.db;
}

function acceptedClaudeSteer({ chatId = '1', msgId = 42 } = {}) {
  const calls = [];
  const events = [];
  const handlers = createAutosteerHandlers({
    config: { bot: {} },
    pm: {
      has: () => true,
      get: () => ({ inFlight: true, backend: 'cli' }),
      getBackend: () => 'cli',
      injectUserMessage(sessionKey, input) {
        calls.push({ sessionKey, input });
        return true;
      },
    },
    autosteeredRefs: { add() {} },
    logEvent: (kind, detail) => events.push({ kind, detail }),
  });
  const steered = handlers.tryAutosteer({
    sessionKey: 'session-1',
    chatConfig: {},
    chatId,
    msg: { message_id: msgId },
    prompt: 'production-shaped follow-up',
  });
  return { calls, events, steered };
}

describe('accepted autosteer ownership', () => {
  test('an accepted Claude follow-up becomes terminal through the owning seam', () => {
    const db = database();
    insertInbound(db, {
      chat_id: '1',
      msg_id: 42,
      handler_status: 'dispatched',
    });
    const { calls, steered } = acceptedClaudeSteer();
    const beforeSettlement = classifyReplay({
      candidates: db.getReplayCandidates({ chatIds: ['1'] }),
      cleanShutdown: true,
    });

    const settled = settleAcceptedAutosteerOwnership({
      selectedProvider: 'claude',
      steered,
      db,
      chatId: '1',
      msgId: 42,
      sessionKey: 'session-1',
    });

    assert.equal(calls.length, 1, 'the provider accepted the follow-up first');
    assert.equal(beforeSettlement.notices.length, 1);
    assert.equal(beforeSettlement.notices[0].items.length, 1);
    assert.equal(settled.autosteered, true);
    assert.equal(db.getMessage('1', 42).handler_status, 'replied');
    const afterSettlement = classifyReplay({
      candidates: db.getReplayCandidates({ chatIds: ['1'] }),
      cleanShutdown: true,
    });
    assert.deepEqual(afterSettlement.notices, []);
  });

  test('Codex acceptance can pass the shared seam without early settlement', () => {
    let writes = 0;
    const steered = { autosteered: true, outcome: 'accepted' };

    const settled = settleAcceptedAutosteerOwnership({
      selectedProvider: 'codex',
      steered,
      db: { completeAcceptedClaudeAutosteer: () => { writes += 1; } },
      chatId: '1',
      msgId: 43,
      sessionKey: 'session-1',
    });

    assert.equal(settled, steered);
    assert.equal(writes, 0, 'Codex target-turn delivery owns final settlement');
  });

  test('a rejected Claude injection stays eligible for one normal primary dispatch', () => {
    const db = database();
    insertInbound(db, {
      chat_id: '1',
      msg_id: 44,
      handler_status: 'dispatched',
    });
    const handlers = createAutosteerHandlers({
      config: { bot: {} },
      pm: {
        has: () => true,
        get: () => ({ inFlight: true, backend: 'cli' }),
        injectUserMessage: () => false,
      },
      autosteeredRefs: { add() {} },
      logEvent() {},
    });
    const steered = handlers.tryAutosteer({
      sessionKey: 'session-1',
      chatConfig: {},
      chatId: '1',
      msg: { message_id: 44 },
      prompt: 'not accepted',
    });

    const settled = settleAcceptedAutosteerOwnership({
      selectedProvider: 'claude',
      steered,
      db,
      chatId: '1',
      msgId: 44,
      sessionKey: 'session-1',
    });

    assert.equal(db.getMessage('1', 44).handler_status, 'dispatched');
    assert.equal(shouldDispatchPrimaryAfterAutosteer({ steered: settled }), true);
  });

  test('post-injection persistence conflict fails closed without a primary resend', () => {
    const db = database();
    insertInbound(db, {
      chat_id: '1',
      msg_id: 45,
      handler_status: 'replied',
    });
    const events = [];
    const errors = [];
    const { steered } = acceptedClaudeSteer({ msgId: 45 });

    const settled = settleAcceptedAutosteerOwnership({
      selectedProvider: 'claude',
      steered,
      db,
      chatId: '1',
      msgId: 45,
      sessionKey: 'session-1',
      logEvent: (kind, detail) => events.push({ kind, detail }),
      logger: { error: (message) => errors.push(message) },
    });

    assert.equal(settled.autosteered, false);
    assert.equal(settled.outcome, 'accepted-persistence-ambiguous');
    assert.equal(settled.errorCode, 'CLAUDE_AUTOSTEER_STATUS_CONFLICT');
    assert.equal(shouldDispatchPrimaryAfterAutosteer({ steered: settled }), false);
    assert.deepEqual(events, [{
      kind: 'autosteer-handler-status-failed',
      detail: {
        chat_id: '1',
        msg_id: 45,
        session_key: 'session-1',
        code: 'CLAUDE_AUTOSTEER_STATUS_CONFLICT',
      },
    }]);
    assert.deepEqual(errors, [
      '[session-1] accepted Claude follow-up persistence failed: CLAUDE_AUTOSTEER_STATUS_CONFLICT',
    ]);
  });

  test('primary dispatch stays closed for every terminal Codex decision', () => {
    for (const codexDispatchDecision of ['duplicate', 'ambiguous', 'unavailable']) {
      assert.equal(shouldDispatchPrimaryAfterAutosteer({
        steered: { autosteered: false },
        codexDispatchDecision,
      }), false, codexDispatchDecision);
    }
  });
});

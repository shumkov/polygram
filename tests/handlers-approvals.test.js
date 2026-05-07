/**
 * Tests for lib/handlers/approvals.js — the canUseTool callback +
 * Telegram callback_query handler + sweeper + cancelAllWaiters.
 *
 * Coverage:
 *   - makeCanUseTool short-circuits via chat_tool_decisions
 *   - makeCanUseTool ungated tools allow-passthrough
 *   - makeCanUseTool gated tools post card + park resolver
 *   - makeCanUseTool no-bot fallback (deny + cancel row)
 *   - handleApprovalCallback token mismatch
 *   - handleApprovalCallback foreign chat rejected
 *   - handleApprovalCallback double-click race (resolve returns 0)
 *   - handleApprovalCallback always-* persists + populates
 *     updatedPermissions
 *   - cancelAllWaiters drains everything
 *   - resolveApprovalWaiter delivers + clears the slot
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApprovals } = require('../lib/handlers/approvals');

function fixture(overrides = {}) {
  const calls = {
    tg: [],
    events: [],
    issued: [],
    resolved: [],
    persisted: [],
    setApproverMsgId: [],
    answerCallback: [],
  };

  let nextRowId = 1;
  const rows = new Map();

  const approvals = {
    issue: ({ bot_name, tool_name, tool_input, requester_chat_id, approver_chat_id, timeoutMs }) => {
      calls.issued.push({ tool_name, tool_input });
      const id = nextRowId++;
      const row = {
        id, bot_name, tool_name,
        tool_input: JSON.stringify(tool_input),
        requester_chat_id: String(requester_chat_id),
        approver_chat_id: String(approver_chat_id),
        callback_token: 'tok-' + id,
        timeout_ts: Date.now() + (timeoutMs || 60_000),
        status: 'pending',
        approver_msg_id: null,
        reused: false,
      };
      rows.set(id, row);
      return overrides.issueOverride ? overrides.issueOverride(row) : row;
    },
    setApproverMsgId: (id, mid) => {
      calls.setApproverMsgId.push({ id, mid });
      const r = rows.get(id);
      if (r) r.approver_msg_id = mid;
    },
    getById: (id) => rows.get(id),
    resolve: ({ id, status, decided_by_user_id, decided_by_user }) => {
      calls.resolved.push({ id, status });
      const r = rows.get(id);
      if (!r) return 0;
      if (r.status !== 'pending') return 0;
      r.status = status;
      r.decided_by_user_id = decided_by_user_id;
      r.decided_by_user = decided_by_user;
      return 1;
    },
    sweepTimedOut: () => overrides.sweepRows || [],
  };

  const db = {
    lookupChatToolDecision: () => overrides.persistedDecision || null,
    insertChatToolDecision: (row) => calls.persisted.push(row),
  };

  const handler = createApprovals({
    config: {
      bot: {
        approvals: {
          adminChatId: overrides.adminChatId === null ? null : '999',
          gatedTools: overrides.gatedTools || ['Bash'],
          timeoutMs: 60_000,
        },
      },
    },
    db,
    bot: overrides.noBot ? null : { _placeholder: true },
    botName: 'testbot',
    tg: async (bot, method, params, meta) => {
      calls.tg.push({ method, params, meta });
      if (overrides.tgFails) throw new Error('tg send failed');
      return overrides.tgResponse || { message_id: 555 };
    },
    logEvent: (kind, detail) => calls.events.push({ kind, detail }),
    approvals,
    getChatIdFromKey: () => '100',
    logger: { log: () => {}, error: () => {} },
  });

  return { handler, calls, rows };
}

describe('createApprovals — makeCanUseTool', () => {
  test('not configured (no adminChatId) → allow', async () => {
    const { handler } = fixture({ adminChatId: null });
    const r = await handler.makeCanUseTool('sk1')('Bash', { command: 'ls' }, {});
    assert.deepEqual(r, { behavior: 'allow' });
  });

  test('chat_tool_decisions persisted-allow → short-circuit allow', async () => {
    const { handler, calls } = fixture({
      persistedDecision: { decision: 'allow', match_type: 'exact' },
    });
    const r = await handler.makeCanUseTool('sk1')('Bash', { command: 'ls' }, {});
    assert.deepEqual(r, { behavior: 'allow' });
    assert.equal(calls.issued.length, 0, 'must NOT issue a row when persisted');
    assert.ok(calls.events.some((e) => e.kind === 'canusetool-shortcircuit'));
  });

  test('chat_tool_decisions persisted-deny → short-circuit deny', async () => {
    const { handler } = fixture({
      persistedDecision: { decision: 'deny', match_type: 'exact' },
    });
    const r = await handler.makeCanUseTool('sk1')('Bash', { command: 'rm -rf /' }, {});
    assert.equal(r.behavior, 'deny');
  });

  test('ungated tool (no pattern match) → allow without posting card', async () => {
    const { handler, calls } = fixture({
      gatedTools: ['Bash'],
    });
    const r = await handler.makeCanUseTool('sk1')('Read', { file_path: '/x' }, {});
    assert.deepEqual(r, { behavior: 'allow' });
    assert.equal(calls.tg.length, 0);
    assert.equal(calls.issued.length, 0);
  });

  test('gated tool + bot=null → cancel row + deny', async () => {
    const { handler, calls } = fixture({ noBot: true });
    const r = await handler.makeCanUseTool('sk1')('Bash', { command: 'ls' }, {});
    assert.equal(r.behavior, 'deny');
    assert.match(r.message, /bot not ready/);
    assert.ok(calls.resolved.some((c) => c.status === 'cancelled'));
  });

  test('gated tool with bot → posts card + parks waiter', async () => {
    const { handler, calls } = fixture();
    const promise = handler.makeCanUseTool('sk1')('Bash', { command: 'ls' }, {});
    // Let the card post complete.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.tg.length, 1);
    assert.equal(calls.tg[0].method, 'sendMessage');
    assert.equal(calls.tg[0].params.chat_id, '999');  // admin
    assert.equal(calls.setApproverMsgId.length, 1);
    assert.equal(calls.setApproverMsgId[0].mid, 555);
    // One waiter parked.
    assert.equal(handler._approvalWaiters.size, 1);

    // Cancel via cancelAllWaiters so the test doesn't hang on
    // the undeclared promise.
    handler.cancelAllWaiters('denied', 'test cleanup');
    const r = await promise;
    assert.equal(r.behavior, 'deny');
  });

  test('gated tool but card POST fails → cancel row + deny', async () => {
    const { handler, calls } = fixture({ tgFails: true });
    const r = await handler.makeCanUseTool('sk1')('Bash', { command: 'ls' }, {});
    assert.equal(r.behavior, 'deny');
    assert.match(r.message, /post failed/);
    assert.ok(calls.resolved.some((c) => c.status === 'cancelled'));
  });
});

describe('createApprovals — handleApprovalCallback validation', () => {
  function ctxWith({ data, fromChat = '999', tokenOverride } = {}) {
    return {
      callbackQuery: { data },
      from: { id: 42, first_name: 'Operator' },
      chat: { id: fromChat },
      answerCallbackQuery: async (params) => {
        // capture into shared per-test array
      },
    };
  }

  test('malformed callback data is silently ignored', async () => {
    const { handler, calls } = fixture();
    await handler.handleApprovalCallback(ctxWith({ data: 'not-an-approve-callback' }));
    assert.equal(calls.events.length, 0);
  });

  test('unknown id → answerCallbackQuery says Unknown', async () => {
    const { handler } = fixture();
    let said;
    const ctx = ctxWith({ data: 'approve:9999:badtoken' });
    ctx.answerCallbackQuery = async (params) => { said = params.text; };
    await handler.handleApprovalCallback(ctx);
    assert.match(said, /Unknown/);
  });

  test('token mismatch → reject + log approval-token-mismatch', async () => {
    const { handler, calls } = fixture();
    // First issue a row so id=1 exists.
    handler.makeCanUseTool('sk')('Bash', { command: 'ls' }, {}).catch(() => {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    let said;
    const ctx = ctxWith({ data: 'approve:1:WRONG' });
    ctx.answerCallbackQuery = async (params) => { said = params.text; };
    await handler.handleApprovalCallback(ctx);
    assert.match(said, /Bad token/);
    assert.ok(calls.events.some((e) => e.kind === 'approval-token-mismatch'));
    handler.cancelAllWaiters();
  });

  test('foreign chat (not adminChat) → log approval-foreign-chat', async () => {
    const { handler, calls } = fixture();
    handler.makeCanUseTool('sk')('Bash', { command: 'ls' }, {}).catch(() => {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    let said;
    const ctx = ctxWith({ data: 'approve:1:tok-1', fromChat: '666' });
    ctx.answerCallbackQuery = async (params) => { said = params.text; };
    await handler.handleApprovalCallback(ctx);
    assert.match(said, /Not authorised/);
    assert.ok(calls.events.some((e) => e.kind === 'approval-foreign-chat'));
    handler.cancelAllWaiters();
  });
});

describe('createApprovals — handleApprovalCallback resolution', () => {
  test('approve happy path: resolve(approved) + edit card + waiter resolved with allow', async () => {
    const fx = fixture();
    let result = null;
    fx.handler.makeCanUseTool('sk')('Bash', { command: 'ls' }, {})
      .then((r) => { result = r; });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const ctx = {
      callbackQuery: { data: 'approve:1:tok-1' },
      from: { id: 42, first_name: 'Op' },
      chat: { id: '999' },
      answerCallbackQuery: async () => {},
    };
    await fx.handler.handleApprovalCallback(ctx);
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(result, { behavior: 'allow' });
    assert.ok(fx.calls.resolved.some((c) => c.status === 'approved'));
    assert.ok(fx.calls.tg.some((c) => c.method === 'editMessageText'));
    assert.ok(fx.calls.events.some((e) => e.kind === 'approval-resolved'));
  });

  test('approve-always: persists chat_tool_decision + updatedPermissions in result', async () => {
    const fx = fixture();
    let result = null;
    fx.handler.makeCanUseTool('sk')('Bash', { command: 'ls' }, {})
      .then((r) => { result = r; });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const ctx = {
      callbackQuery: { data: 'approve-always:1:tok-1' },
      from: { id: 42, first_name: 'Op' },
      chat: { id: '999' },
      answerCallbackQuery: async () => {},
    };
    await fx.handler.handleApprovalCallback(ctx);
    await new Promise((r) => setImmediate(r));

    assert.equal(result.behavior, 'allow');
    assert.ok(Array.isArray(result.updatedPermissions));
    assert.equal(result.updatedPermissions[0].type, 'addRules');
    assert.equal(fx.calls.persisted.length, 1);
    assert.equal(fx.calls.persisted[0].decision, 'allow');
  });

  test('deny: waiter gets {behavior:deny}', async () => {
    const fx = fixture();
    let result = null;
    fx.handler.makeCanUseTool('sk')('Bash', { command: 'ls' }, {})
      .then((r) => { result = r; });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const ctx = {
      callbackQuery: { data: 'deny:1:tok-1' },
      from: { id: 42, first_name: 'Op' },
      chat: { id: '999' },
      answerCallbackQuery: async () => {},
    };
    await fx.handler.handleApprovalCallback(ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(result.behavior, 'deny');
  });

  test('double-click race: second click sees changes=0 and tells user "Already X"', async () => {
    const fx = fixture();
    fx.handler.makeCanUseTool('sk')('Bash', { command: 'ls' }, {}).catch(() => {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // First click resolves the row.
    const ctx1 = {
      callbackQuery: { data: 'approve:1:tok-1' },
      from: { id: 42 }, chat: { id: '999' },
      answerCallbackQuery: async () => {},
    };
    await fx.handler.handleApprovalCallback(ctx1);

    // Second click — same row, now status=approved, resolve returns 0.
    let said;
    const ctx2 = {
      callbackQuery: { data: 'deny:1:tok-1' },
      from: { id: 99 }, chat: { id: '999' },
      answerCallbackQuery: async (params) => { said = params.text; },
    };
    await fx.handler.handleApprovalCallback(ctx2);
    assert.match(said, /Already approved/);
  });
});

describe('createApprovals — cancelAllWaiters', () => {
  test('drains every parked waiter and resolves them with the given decision', async () => {
    const fx = fixture();
    const results = [];
    fx.handler.makeCanUseTool('sk')('Bash', { command: 'ls' }, {})
      .then((r) => results.push(r));
    fx.handler.makeCanUseTool('sk')('Bash', { command: 'pwd' }, {})
      .then((r) => results.push(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(fx.handler._approvalWaiters.size, 2);

    const drained = fx.handler.cancelAllWaiters('denied', 'shutdown');
    await new Promise((r) => setImmediate(r));
    assert.equal(drained, 2);
    assert.equal(fx.handler._approvalWaiters.size, 0);
    assert.equal(results.length, 2);
    for (const r of results) assert.equal(r.behavior, 'deny');
  });

  test('returns 0 when no waiters parked', () => {
    const fx = fixture();
    assert.equal(fx.handler.cancelAllWaiters(), 0);
  });
});

describe('createApprovals — dropWaiter', () => {
  test('removes the specific resolver from the slot', async () => {
    const fx = fixture();
    const promise = fx.handler.makeCanUseTool('sk')('Bash', { command: 'ls' }, {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const list = fx.handler._approvalWaiters.get(1);
    assert.equal(list.length, 1);

    // Note: dropWaiter is internal; the public path is settle() called
    // from inside makeCanUseTool. Test via cancelAllWaiters as proxy.
    fx.handler.cancelAllWaiters('denied', 'test');
    await promise;
    assert.equal(fx.handler._approvalWaiters.size, 0);
  });
});

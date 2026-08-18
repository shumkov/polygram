'use strict';

/**
 * 0.13 P2 — D5 gateInbound (the ONE intake gate) + D4 redeliverAsFreshTurn
 * (the ONE redelivery tail). docs/0.13-channels-lifecycle-design.md §3 D4+D5.
 *
 * The tier × stage contract under test:
 *
 *   stage            | fresh            | edit             | redelivery
 *   abort            | eval + execute*  | eval + execute*  | eval, NEVER execute → blocked
 *   admin/pair       | eval + dispatch  | eval + dispatch  | eval, NEVER execute → blocked
 *   rewind           | eval + execute   | skip             | skip
 *   question-consume | eval + execute   | eval + execute   | skip
 *   shouldHandle     | evaluate         | evaluate         | evaluate
 *   final            | dispatch         | 'pass' to caller | 'pass' to caller
 *
 *   * identity-gated (0.13 D5): DM ‖ paired ‖ mentioned ‖ reply-to-bot — closes
 *     the pre-existing bystander-abort hole (any group member's bare "stop"
 *     aborted others' turns pre-gate, abort.js:39–44) BEFORE the edit path
 *     gains abort semantics.
 *
 * Red against pre-P2 code: the gate/redeliver units did not exist — intake ran
 * through four divergent inline gate chains (seam S11) and five re-dispatch
 * copies (seam S10), with the holes pinned here reachable in production.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createGateInbound } = require('../lib/handlers/gate-inbound');
const { createRedeliver } = require('../lib/handlers/redeliver');

function makeGate(over = {}) {
  const calls = { abort: [], dispatched: [], rewind: [], consumed: [], events: [] };
  const deps = {
    config: { chats: { '100': { name: 'X', requireMention: true } }, bot: { allowConfigCommands: true } },
    getBotUsername: () => 'mybot',
    getMentionRe: () => /@mybot\b/g,
    pairings: { hasLivePairing: ({ user_id }) => user_id === 777 },   // 777 = the paired user
    isAbortRequest: (t) => /^(\/stop|stop|стоп)$/i.test(String(t || '').trim()),
    handleAbortIfRequested: async (msg, chatId, chatConfig, cleanText) => {
      calls.abort.push({ chatId, cleanText, msgId: msg.message_id });
      return true;
    },
    getRewindHandler: () => over.rewindHandler ?? null,
    isRewindCommand: (t) => /^\/rewind\b/.test(String(t || '')),
    getQuestionHandlers: () => over.questionHandlers ?? {
      isAwaitingOtherFrom: () => false,
      tryConsumeAsAnswer: async () => ({ consumed: false }),
    },
    shouldHandle: over.shouldHandle ?? ((msg) => {
      // mirror prod: mention-gated group — pass on mention / reply-to-bot / paired / DM
      if (msg.chat.type === 'private') return true;
      const text = msg.text || msg.caption || '';
      if (text.includes('@mybot')) return true;
      if (msg.reply_to_message?.from?.username === 'mybot') return true;
      const repliesToOther = !!msg.reply_to_message && msg.reply_to_message.from?.username !== 'mybot';
      if (!repliesToOther && msg.from?.id === 777) return true;
      return false;
    }),
    getSessionKey: (cid, tid) => (tid ? `${cid}:${tid}` : cid),
    dispatchHandleMessage: (sk, cid, msg) => calls.dispatched.push({ sk, cid, msg }),
    bot: {},
    botName: 'mybot',
    logEvent: (k, d) => calls.events.push({ k, d }),
    logger: { error: () => {}, warn: () => {} },
    ...over.deps,
  };
  return { gate: createGateInbound(deps), calls };
}

const groupMsg = (over = {}) => ({
  chat: { id: 100, type: 'supergroup' }, message_id: 42,
  from: { id: 555, first_name: 'Bystander' }, text: 'hello', date: 1, ...over,
});
const dmMsg = (over = {}) => ({
  chat: { id: 100, type: 'private' }, message_id: 43,
  from: { id: 555, first_name: 'Owner' }, text: 'hello', date: 1, ...over,
});

describe('D5 gateInbound — abort stage (identity-gated)', () => {
  test('G1: bystander "stop" in a mention-gated group is BLOCKED, abort never executes', async () => {
    const { gate, calls } = makeGate();
    const res = await gate(groupMsg({ text: 'stop' }), { tier: 'fresh' });
    assert.equal(calls.abort.length, 0,
      'pre-P2 hole: any group member could kill others\' in-flight turns with a bare "stop"');
    assert.equal(res.action, 'blocked');
    assert.equal(res.stage, 'abort');
    assert.ok(calls.events.find((e) => e.k === 'abort-identity-blocked'));
  });

  test('G2: DM "stop" executes the abort (today\'s behavior preserved for addressed senders)', async () => {
    const { gate, calls } = makeGate();
    const res = await gate(dmMsg({ text: 'stop' }), { tier: 'fresh' });
    assert.equal(calls.abort.length, 1);
    assert.equal(res.action, 'handled');
  });

  test('G3: paired user / mention / reply-to-bot each satisfy the abort identity gate', async () => {
    for (const m of [
      groupMsg({ text: 'stop', from: { id: 777 } }),
      groupMsg({ text: '@mybot stop' }),
      groupMsg({ text: 'stop', reply_to_message: { message_id: 1, from: { username: 'mybot' } } }),
    ]) {
      const { gate, calls } = makeGate();
      const res = await gate(m, { tier: 'fresh' });
      assert.equal(calls.abort.length, 1, `identity variant must execute: ${m.text}`);
      assert.equal(res.action, 'handled');
    }
  });

  test('G11: redelivery tier NEVER executes an abort-shaped message — blocked + logged', async () => {
    const { gate, calls } = makeGate();
    const res = await gate(dmMsg({ text: '/stop' }), { tier: 'redelivery' });
    assert.equal(calls.abort.length, 0,
      'a redelivered abort would execute in a context the user never intended');
    assert.equal(res.action, 'blocked');
    assert.equal(res.stage, 'abort');
  });
});

describe('D5 gateInbound — operator can always abort (operator-bypass fix)', () => {
  // Prod gap (chat -1003369922517, 2026-06-15 14:48): the operator's bare "stop"
  // in the UMI group was abort-identity-blocked because isAddressedIdentity only
  // recognized @mention / reply-to-bot / pairing — not the bot's own operator.
  const opCfg = (bot) => ({ deps: { config: { chats: { '100': { name: 'X', requireMention: true } }, bot } } });

  test('G15: operator bare "stop" in a group EXECUTES the abort (adminChatId = user id)', async () => {
    const { gate, calls } = makeGate(opCfg({ allowConfigCommands: true, adminChatId: 999 }));
    const res = await gate(groupMsg({ text: 'stop', from: { id: 999, first_name: 'Operator' } }), { tier: 'fresh' });
    assert.equal(calls.abort.length, 1, 'the bot owner must be able to stop their own bot with a bare "stop" in a group');
    assert.equal(res.action, 'handled');
    assert.equal(res.stage, 'abort');
  });

  test('G16: under the same operator config, a NON-operator bystander "stop" stays BLOCKED (hole stays closed)', async () => {
    const { gate, calls } = makeGate(opCfg({ allowConfigCommands: true, adminChatId: 999 }));
    const res = await gate(groupMsg({ text: 'stop', from: { id: 555, first_name: 'Bystander' } }), { tier: 'fresh' });
    assert.equal(calls.abort.length, 0, 'only the operator gains the bypass — not every group member');
    assert.equal(res.action, 'blocked');
    assert.equal(res.stage, 'abort');
    assert.ok(calls.events.find((e) => e.k === 'abort-identity-blocked'));
  });

  test('G17: explicit operatorUserId grants bypass; a negative (group) adminChatId never does (fail-safe)', async () => {
    const g1 = makeGate(opCfg({ operatorUserId: 1234 }));
    await g1.gate(groupMsg({ text: 'stop', from: { id: 1234 } }), { tier: 'fresh' });
    assert.equal(g1.calls.abort.length, 1, 'operatorUserId identifies the operator');

    // a group adminChatId is negative — it must never equal a positive sender id
    const g2 = makeGate(opCfg({ adminChatId: -1003369922517 }));
    const res = await g2.gate(groupMsg({ text: 'stop', from: { id: 555 } }), { tier: 'fresh' });
    assert.equal(g2.calls.abort.length, 0, 'a group adminChatId must not grant a bystander the operator bypass');
    assert.equal(res.action, 'blocked');
  });

  test('G18: string/number coercion — config id as string still matches a numeric sender id (and vice versa)', async () => {
    // config.json can hold adminChatId as a string; from.id arrives numeric.
    const a = makeGate(opCfg({ adminChatId: '999' }));
    await a.gate(groupMsg({ text: 'stop', from: { id: 999 } }), { tier: 'fresh' });
    assert.equal(a.calls.abort.length, 1, 'string operator id must coerce-match a numeric sender id');
    // and the reverse (defensive — the Number() on from.id is the point)
    const b = makeGate(opCfg({ operatorUserId: 999 }));
    await b.gate(groupMsg({ text: 'stop', from: { id: '999' } }), { tier: 'fresh' });
    assert.equal(b.calls.abort.length, 1, 'numeric operator id must coerce-match a string sender id');
  });

  test('G19: operatorUserId takes precedence over adminChatId', async () => {
    const g = makeGate(opCfg({ operatorUserId: 1234, adminChatId: 999 }));
    await g.gate(groupMsg({ text: 'stop', from: { id: 1234 } }), { tier: 'fresh' });
    assert.equal(g.calls.abort.length, 1, 'operatorUserId is the operator when both are set');
    const g2 = makeGate(opCfg({ operatorUserId: 1234, adminChatId: 999 }));
    const res = await g2.gate(groupMsg({ text: 'stop', from: { id: 999 } }), { tier: 'fresh' });
    assert.equal(g2.calls.abort.length, 0, 'adminChatId is ignored for the bypass when operatorUserId is present');
    assert.equal(res.action, 'blocked');
  });
});

describe('D5 gateInbound — admin/pair stage', () => {
  test('G4: admin command routes through dispatchHandleMessage (the dispatcher wrapper, not bare handleMessage)', async () => {
    const { gate, calls } = makeGate();
    const res = await gate(dmMsg({ text: '/model opus' }), { tier: 'fresh' });
    assert.equal(res.action, 'dispatched');
    assert.equal(res.stage, 'admin');
    assert.equal(calls.dispatched.length, 1, 'admin path gains handler-error events + handler_status semantics');
  });

  test('G12: redelivery tier blocks admin-shaped content', async () => {
    const { gate, calls } = makeGate();
    const res = await gate(dmMsg({ text: '/model opus' }), { tier: 'redelivery' });
    assert.equal(res.action, 'blocked');
    assert.equal(res.stage, 'admin');
    assert.equal(calls.dispatched.length, 0);
  });
});

describe('D5 gateInbound — question-consume + shouldHandle + dispatch', () => {
  test('G5: normal fresh message dispatches when shouldHandle passes; blocked when it fails', async () => {
    const { gate, calls } = makeGate();
    const pass = await gate(groupMsg({ text: '@mybot do the thing' }), { tier: 'fresh' });
    assert.equal(pass.action, 'dispatched');
    assert.equal(calls.dispatched.length, 1);
    const blocked = await gate(groupMsg({ text: 'unaddressed chatter' }), { tier: 'fresh' });
    assert.equal(blocked.action, 'blocked');
    assert.equal(blocked.stage, 'shouldHandle');
  });

  test('G6: the open-Other owner bypasses the mention gate (rc.33 semantics preserved)', async () => {
    const consumed = [];
    const { gate } = makeGate({
      questionHandlers: {
        isAwaitingOtherFrom: (sk, fromId) => fromId === 555,
        tryConsumeAsAnswer: async ({ text }) => { consumed.push(text); return { consumed: true }; },
      },
    });
    const res = await gate(groupMsg({ text: 'my typed Other answer' }), { tier: 'fresh' });
    assert.equal(res.action, 'handled');
    assert.equal(res.stage, 'question-consume');
    assert.deepEqual(consumed, ['my typed Other answer']);
  });

  test('G9: an EDIT while that user owns an open "Other" capture becomes the answer (S11 hole)', async () => {
    const consumed = [];
    const { gate, calls } = makeGate({
      questionHandlers: {
        isAwaitingOtherFrom: (sk, fromId) => fromId === 555,
        tryConsumeAsAnswer: async ({ text }) => { consumed.push(text); return { consumed: true }; },
      },
    });
    const res = await gate(groupMsg({ text: 'corrected answer via edit' }), { tier: 'edit' });
    assert.equal(res.action, 'handled');
    assert.deepEqual(consumed, ['corrected answer via edit'],
      'pre-P2: the edit chain never consulted the question machinery — the answer dead-ended');
    assert.equal(calls.dispatched.length, 0);
  });

  test('G8: an edit to an abort phrase ABORTS (identity-gated) instead of being injected into the turn it tries to kill', async () => {
    const { gate, calls } = makeGate();
    const res = await gate(dmMsg({ text: '/stop' }), { tier: 'edit' });
    assert.equal(calls.abort.length, 1, 'S11 hole: pre-P2 the edit was injected as "[edit] … /stop"');
    assert.equal(res.action, 'handled');
  });

  test('G10: a normal edit passes through (caller owns inject/redeliver)', async () => {
    const { gate, calls } = makeGate();
    const res = await gate(dmMsg({ text: 'the corrected text' }), { tier: 'edit' });
    assert.equal(res.action, 'pass');
    assert.equal(calls.dispatched.length, 0, 'edit tier never auto-dispatches');
  });

  test('G13: a normal redelivery passes through; G14: rewind consumed on fresh only', async () => {
    const rewindCalls = [];
    const { gate } = makeGate({
      rewindHandler: { tryConsume: async (a) => { rewindCalls.push(a); return { consumed: true }; } },
    });
    const r1 = await gate(dmMsg({ text: 'plain replayed text' }), { tier: 'redelivery' });
    assert.equal(r1.action, 'pass');
    const r2 = await gate(dmMsg({ text: '/rewind' }), { tier: 'fresh' });
    assert.equal(r2.action, 'handled');
    assert.equal(rewindCalls.length, 1);
    const r3 = await gate(dmMsg({ text: '/rewind' }), { tier: 'edit' });
    assert.notEqual(r3.stage, 'rewind', 'edited /rewind is nonsensical — stage skipped');
    assert.equal(rewindCalls.length, 1);
  });

  test('disabled saved-Codex /rewind dispatches its scope denial instead of failing silently', async () => {
    const scopeError = Object.assign(
      new Error('Codex is not enabled for this chat'),
      { code: 'CODEX_SCOPE_DISABLED' },
    );
    const { gate, calls } = makeGate({
      rewindHandler: {
        tryConsume: async () => {
          throw new Error('rewind must not inspect a disabled Codex runtime');
        },
      },
      deps: {
        resolveRuntime: () => {
          throw scopeError;
        },
      },
    });
    const msg = dmMsg({ text: '/rewind' });

    const result = await gate(msg, { tier: 'fresh' });

    assert.deepEqual(result, {
      action: 'dispatched',
      stage: 'rewind',
    });
    assert.deepEqual(
      calls.dispatched,
      [{ sk: '100', cid: '100', msg }],
      'the dispatcher owns the visible error reply and terminal handler status',
    );
  });
});

describe('D4 redeliverAsFreshTurn — the ONE redelivery tail', () => {
  function makeRedeliver(over = {}) {
    const calls = { dispatched: [], reacted: [], marks: [], events: [], gated: [] };
    const redeliver = createRedeliver({
      gateInbound: over.gateInbound ?? (async (msg, opts) => { calls.gated.push(opts); return { action: 'pass' }; }),
      dispatchHandleMessage: (sk, cid, msg, bot, dispatchContext) => {
        calls.dispatched.push({ sk, cid, msg, bot, dispatchContext });
        return Promise.resolve('handler-settled');
      },
      getSessionKey: (cid, tid) => (tid ? `${cid}:${tid}` : cid),
      config: { chats: { '100': { name: 'X' } } },
      db: {},
      dbWrite: (fn) => { calls.marks.push('write'); try { fn(); } catch {} },
      setInboundHandlerStatus: ({ status }) => calls.marks.push(status),
      react: (cid, mid) => calls.reacted.push({ cid, mid }),
      bot: {},
      logEvent: (k, d) => calls.events.push({ k, d }),
      logger: { error: () => {}, warn: () => {} },
    });
    return { redeliver, calls };
  }

  test('R1: tags _isReplay, gates at tier redelivery, acks, pre-marks, dispatches', async () => {
    const { redeliver, calls } = makeRedeliver();
    const msg = dmMsg({ text: 'dropped message', message_id: 90 });
    const res = await redeliver({ chatId: '100', msg, source: 'drop', preMark: 'replay-attempted' });
    assert.equal(res.ok, true);
    assert.equal(msg._isReplay, true);
    assert.deepEqual(calls.gated[0], { tier: 'redelivery' });
    assert.equal(calls.reacted.length, 1, 'the 👀 ack is the rc.33 lesson — never silent');
    assert.ok(calls.marks.includes('replay-attempted'), 'one-shot DB pre-mark (boot-replay pattern)');
    assert.equal(calls.dispatched.length, 1);
  });

  test('R2: once-only per (chatId,msgId) — a second redelivery of the same message is suppressed', async () => {
    const { redeliver, calls } = makeRedeliver();
    const msg = dmMsg({ message_id: 91 });
    await redeliver({ chatId: '100', msg, source: 'drop' });
    const res2 = await redeliver({ chatId: '100', msg: dmMsg({ message_id: 91 }), source: 'drop' });
    assert.equal(res2.ok, false);
    assert.equal(calls.dispatched.length, 1, 'duplicates are the double-answer failure mode — hard cap');
    assert.ok(calls.events.find((e) => e.k === 'redeliver-suppressed-duplicate'));
  });

  test('R3: gate-blocked content (abort/admin-shaped) logs no-redeliver and never dispatches', async () => {
    const { redeliver, calls } = makeRedeliver({
      gateInbound: async () => ({ action: 'blocked', stage: 'abort' }),
    });
    const res = await redeliver({ chatId: '100', msg: dmMsg({ message_id: 92, text: '/stop' }), source: 'drop' });
    assert.equal(res.ok, false);
    assert.equal(calls.dispatched.length, 0);
    assert.ok(calls.events.find((e) => e.k === 'input-dropped-no-redeliver'));
  });

  test('R4: gate can be skipped for same-process retries that already passed it (startup-retry)', async () => {
    const { redeliver, calls } = makeRedeliver({
      gateInbound: async () => { throw new Error('must not be called'); },
    });
    const res = await redeliver({ chatId: '100', msg: dmMsg({ message_id: 93 }), source: 'startup-retry', gate: false, ack: false });
    assert.equal(res.ok, true);
    assert.equal(calls.dispatched.length, 1);
    assert.equal(calls.reacted.length, 0, 'silent retry stays silent');
  });

  test('clean replay prepares after the gate and passes private dispatch context', async () => {
    const order = [];
    const receipt = Object.freeze({});
    const dispatchContext = { recoveryReceipt: receipt, cleanReplay: { id: 1 } };
    const { redeliver, calls } = makeRedeliver({
      gateInbound: async () => {
        order.push('gate');
        return { action: 'pass' };
      },
    });

    const result = await redeliver({
      chatId: '100',
      msg: dmMsg({ message_id: 94 }),
      source: 'boot-replay-codex',
      prepareDispatch: async ({ sessionKey }) => {
        order.push(`prepare:${sessionKey}`);
        return dispatchContext;
      },
    });

    assert.deepEqual(order, ['gate', 'prepare:100']);
    assert.equal(calls.dispatched[0].dispatchContext, dispatchContext);
    assert.equal(await result.task, 'handler-settled');
  });

  test('clean replay can terminalize gate-blocked content without preparing it', async () => {
    const calls = [];
    const { redeliver } = makeRedeliver({
      gateInbound: async () => ({ action: 'blocked', stage: 'admin' }),
    });

    const result = await redeliver({
      chatId: '100',
      msg: dmMsg({ message_id: 95, text: '/model' }),
      source: 'boot-replay-codex',
      prepareDispatch: async () => {
        calls.push('prepare');
      },
      onGateBlocked: async ({ stage }) => calls.push(`blocked:${stage}`),
    });

    assert.deepEqual(calls, ['blocked:admin']);
    assert.deepEqual(result, { ok: false, reason: 'admin', terminal: true });
  });
});

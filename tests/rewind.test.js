'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { isRewindCommand, gateRewindRequest, previewOf, createRewindHandler } = require('../lib/rewind/rewind');

const tick = () => new Promise((r) => setImmediate(r));

describe('isRewindCommand', () => {
  test('matches /rewind and /rewind@bot, alone on the line', () => {
    assert.equal(isRewindCommand('/rewind'), true);
    assert.equal(isRewindCommand('  /rewind  '), true);
    assert.equal(isRewindCommand('/rewind@shumorobot'), true);
    assert.equal(isRewindCommand('/REWIND'), true);
  });
  test('rejects args, other commands, plain text', () => {
    assert.equal(isRewindCommand('/rewind now'), false, 'no args in P1 — a bare command only');
    assert.equal(isRewindCommand('rewind'), false);
    assert.equal(isRewindCommand('/rewindx'), false);
    assert.equal(isRewindCommand('please /rewind'), false);
    assert.equal(isRewindCommand(''), false);
  });
});

describe('gateRewindRequest', () => {
  const op = { from: { id: 7 } };
  test('rejects when there is no reply target', () => {
    const r = gateRewindRequest({ msg: { from: { id: 7 } }, isOperator: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /reply to the message/i);
  });
  test('rejects a non-operator', () => {
    const r = gateRewindRequest({ msg: { ...op, reply_to_message: { from: { id: 7 } } }, isOperator: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /only the operator/i);
  });
  test('rejects rewinding to ANOTHER user\'s message (ownership)', () => {
    const r = gateRewindRequest({ msg: { ...op, reply_to_message: { from: { id: 999, username: 'someoneelse' } } }, isOperator: true, botUsername: 'mybot' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /your own messages or mine/i);
  });
  test('accepts the operator\'s own message', () => {
    const r = gateRewindRequest({ msg: { ...op, reply_to_message: { from: { id: 7 } } }, isOperator: true, botUsername: 'mybot' });
    assert.equal(r.ok, true);
  });
  test('accepts a bot bubble', () => {
    const r = gateRewindRequest({ msg: { ...op, reply_to_message: { from: { id: 42, username: 'mybot' } } }, isOperator: true, botUsername: 'mybot' });
    assert.equal(r.ok, true);
  });
});

describe('previewOf', () => {
  test('first line, truncated', () => {
    assert.equal(previewOf('hello\nworld'), 'hello');
    assert.equal(previewOf('x'.repeat(80)).length, 58);
    assert.equal(previewOf(''), '(no text)');
  });
});

function harness({ inFlight = false, execResult = { ok: true, droppedCount: 3 } } = {}) {
  const sends = [];
  const execCalls = [];
  const proc = inFlight === null ? null : Object.assign(new EventEmitter(), { inFlight });
  const pm = { get: () => proc };
  const tg = async (_b, _m, params) => { sends.push(params); return { message_id: sends.length }; };
  const h = createRewindHandler({
    pm, tg, bot: {}, botName: 'b',
    executeRewind: async (req) => { execCalls.push(req); if (execResult instanceof Error) throw execResult; return execResult; },
    logEvent: () => {}, logger: { error: () => {} },
  });
  return { h, sends, execCalls, proc, lastSend: () => sends[sends.length - 1]?.text };
}

const opMsg = (reply) => ({ from: { id: 7 }, reply_to_message: reply });

describe('createRewindHandler.tryConsume', () => {
  test('non-/rewind text is not consumed', async () => {
    const { h, execCalls } = harness();
    const r = await h.tryConsume({ sessionKey: 's', chatId: '1', msg: opMsg({ from: { id: 7 } }), cleanText: 'hello', isOperator: true, botUsername: 'b' });
    assert.equal(r.consumed, false);
    assert.equal(execCalls.length, 0);
  });

  test('/rewind without a reply: consumed, told why, NOT executed', async () => {
    const { h, execCalls, lastSend } = harness();
    const r = await h.tryConsume({ sessionKey: 's', chatId: '1', msg: { from: { id: 7 } }, cleanText: '/rewind', isOperator: true, botUsername: 'b' });
    assert.equal(r.consumed, true, 'a /rewind is always consumed (never starts a normal turn)');
    assert.match(lastSend(), /reply to the message/i);
    assert.equal(execCalls.length, 0);
  });

  test('/rewind from a non-operator: consumed + rejected, NOT executed', async () => {
    const { h, execCalls, lastSend } = harness();
    await h.tryConsume({ sessionKey: 's', chatId: '1', msg: opMsg({ from: { id: 7 } }), cleanText: '/rewind', isOperator: false, botUsername: 'b' });
    assert.match(lastSend(), /only the operator/i);
    assert.equal(execCalls.length, 0);
  });

  test('valid /rewind on an IDLE session: acks + executes with the target', async () => {
    const { h, execCalls, lastSend } = harness({ inFlight: false });
    const r = await h.tryConsume({ sessionKey: 's', chatId: '1', threadId: '9', msg: opMsg({ message_id: 500, from: { id: 7 }, text: 'build the thing', date: 123 }), cleanText: '/rewind', isOperator: true, botUsername: 'b' });
    assert.equal(r.consumed, true);
    assert.match(lastSend(), /Rewinding/i);
    await tick();
    assert.equal(execCalls.length, 1, 'executor ran on the next tick (idle)');
    assert.deepEqual(execCalls[0].target, { msg_id: 500, text: 'build the thing', ts: 123 });
    assert.equal(execCalls[0].threadId, '9');
    assert.match(lastSend(), /Rewound to: «build the thing»/);
    assert.match(lastSend(), /still exists/, 'side-effect caveat stated');
  });

  test('valid /rewind while a turn is IN FLIGHT: deferred until idle, THEN executes', async () => {
    const { h, execCalls, proc, lastSend } = harness({ inFlight: true });
    await h.tryConsume({ sessionKey: 's', chatId: '1', msg: opMsg({ message_id: 5, from: { id: 7 }, text: 'x' }), cleanText: '/rewind', isOperator: true, botUsername: 'b' });
    assert.match(lastSend(), /queued/i);
    await tick();
    assert.equal(execCalls.length, 0, 'does NOT run mid-turn');
    proc.emit('idle');           // turn finishes
    await tick();
    assert.equal(execCalls.length, 1, 'runs once the turn ends');
  });

  // Finding D (both reviewers): the proc emits 'close'/'session-reset' on teardown, NEVER
  // 'idle'. A deferred rewind parked on once('idle') is silently lost if the in-flight turn
  // is killed/evicted/disconnected — the operator was told "queued" and then never hears back.
  test('deferred /rewind: proc CLOSES before idle → operator is told, not left hanging', async () => {
    const { h, execCalls, proc, lastSend } = harness({ inFlight: true });
    await h.tryConsume({ sessionKey: 's', chatId: '1', msg: opMsg({ message_id: 5, from: { id: 7 }, text: 'x' }), cleanText: '/rewind', isOperator: true, botUsername: 'b' });
    assert.match(lastSend(), /queued/i);
    proc.emit('close', 0);   // turn torn down (kill / LRU evict / bridge disconnect)
    await tick();
    assert.equal(execCalls.length, 0, 'executor does NOT run on a dead proc');
    assert.match(lastSend(), /couldn.t rewind/i, 'operator is told instead of left waiting');
  });

  test('deferred /rewind: session-reset before idle → operator is told', async () => {
    const { h, execCalls, proc, lastSend } = harness({ inFlight: true });
    await h.tryConsume({ sessionKey: 's', chatId: '1', msg: opMsg({ message_id: 5, from: { id: 7 }, text: 'x' }), cleanText: '/rewind', isOperator: true, botUsername: 'b' });
    proc.emit('session-reset', { reason: 'model-change' });
    await tick();
    assert.equal(execCalls.length, 0);
    assert.match(lastSend(), /couldn.t rewind/i);
  });

  test('deferred /rewind runs exactly once on idle (no double-fire if close follows)', async () => {
    const { h, execCalls, proc } = harness({ inFlight: true });
    await h.tryConsume({ sessionKey: 's', chatId: '1', msg: opMsg({ message_id: 5, from: { id: 7 }, text: 'x' }), cleanText: '/rewind', isOperator: true, botUsername: 'b' });
    proc.emit('idle');
    await tick();
    proc.emit('close', 0);   // teardown after the turn finished — must NOT re-run or re-ack
    await tick();
    assert.equal(execCalls.length, 1, 'ran once on idle; the trailing close is ignored');
  });

  test('executor failure → "couldn\'t rewind", not a crash', async () => {
    const { h, lastSend } = harness({ inFlight: false, execResult: { ok: false, error: 'compacted transcript' } });
    await h.tryConsume({ sessionKey: 's', chatId: '1', msg: opMsg({ message_id: 5, from: { id: 7 }, text: 'x' }), cleanText: '/rewind', isOperator: true, botUsername: 'b' });
    await tick();
    assert.match(lastSend(), /couldn.t rewind — compacted transcript/i);
  });

  test('executor throwing is caught → "couldn\'t rewind"', async () => {
    const { h, lastSend } = harness({ inFlight: false, execResult: new Error('boom') });
    await h.tryConsume({ sessionKey: 's', chatId: '1', msg: opMsg({ message_id: 5, from: { id: 7 }, text: 'x' }), cleanText: '/rewind', isOperator: true, botUsername: 'b' });
    await tick();
    assert.match(lastSend(), /couldn.t rewind — boom/i);
  });
});

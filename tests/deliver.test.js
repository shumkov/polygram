/**
 * Tests for lib/deliver.js — chunked reply delivery.
 *
 * Verifies:
 *   - Empty input returns empty results
 *   - Multi-chunk: each chunk is its own sendMessage
 *   - reply_parameters only on chunks[0], not subsequent
 *   - threadId propagates to every chunk
 *   - Per-chunk failures don't abort the loop (partial delivery wins)
 *   - Sent message_ids are returned in order; failures recorded with index
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { deliverReplies } = require('../lib/deliver');

function silentLogger() {
  return { log: () => {}, error: () => {} };
}

// Fake send() that records calls and returns synthetic message_ids.
// `errorOnIndex`: throws on the Nth call (0-indexed) for failure tests.
function makeFakeSend({ errorOnIndex = -1 } = {}) {
  const calls = [];
  let nextMsgId = 1000;
  const send = async (bot, method, params, meta) => {
    calls.push({ bot, method, params, meta });
    if (calls.length - 1 === errorOnIndex) {
      throw new Error(`fake send failure at index ${errorOnIndex}`);
    }
    return { message_id: nextMsgId++, date: 1700000000 };
  };
  return { send, calls };
}

describe('deliverReplies — early returns', () => {
  test('empty chunks array returns empty result', async () => {
    const { send, calls } = makeFakeSend();
    const r = await deliverReplies({
      bot: {}, send, chatId: '1', chunks: [], logger: silentLogger(),
    });
    assert.deepEqual(r, { sent: [], failed: [] });
    assert.equal(calls.length, 0);
  });

  test('null/undefined chunks returns empty result', async () => {
    const { send } = makeFakeSend();
    assert.deepEqual(
      await deliverReplies({ bot: {}, send, chatId: '1', chunks: null, logger: silentLogger() }),
      { sent: [], failed: [] },
    );
    assert.deepEqual(
      await deliverReplies({ bot: {}, send, chatId: '1', chunks: undefined, logger: silentLogger() }),
      { sent: [], failed: [] },
    );
  });
});

describe('deliverReplies — happy path', () => {
  test('single chunk sends one message', async () => {
    const { send, calls } = makeFakeSend();
    const r = await deliverReplies({
      bot: {}, send, chatId: '1', chunks: ['hello'], logger: silentLogger(),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendMessage');
    assert.equal(calls[0].params.text, 'hello');
    assert.deepEqual(r.sent, [1000]);
    assert.deepEqual(r.failed, []);
  });

  test('three chunks send three messages with sequential message_ids', async () => {
    const { send, calls } = makeFakeSend();
    const r = await deliverReplies({
      bot: {}, send, chatId: '1', chunks: ['a', 'b', 'c'], logger: silentLogger(),
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.params.text), ['a', 'b', 'c']);
    assert.deepEqual(r.sent, [1000, 1001, 1002]);
  });
});

describe('deliverReplies — reply linkage', () => {
  test('reply_parameters only on the first chunk', async () => {
    const { send, calls } = makeFakeSend();
    await deliverReplies({
      bot: {}, send, chatId: '1',
      chunks: ['part1', 'part2', 'part3'],
      replyToMessageId: 42,
      logger: silentLogger(),
    });
    assert.equal(calls[0].params.reply_parameters?.message_id, 42);
    assert.equal(calls[0].params.reply_parameters?.allow_sending_without_reply, true);
    assert.equal(calls[1].params.reply_parameters, undefined);
    assert.equal(calls[2].params.reply_parameters, undefined);
  });

  test('no reply_parameters when replyToMessageId is null', async () => {
    const { send, calls } = makeFakeSend();
    await deliverReplies({
      bot: {}, send, chatId: '1', chunks: ['part1'], replyToMessageId: null,
      logger: silentLogger(),
    });
    assert.equal(calls[0].params.reply_parameters, undefined);
  });
});

describe('deliverReplies — thread propagation', () => {
  test('threadId propagates to every chunk', async () => {
    const { send, calls } = makeFakeSend();
    await deliverReplies({
      bot: {}, send, chatId: '-100', threadId: 7,
      chunks: ['a', 'b'], logger: silentLogger(),
    });
    assert.equal(calls[0].params.message_thread_id, 7);
    assert.equal(calls[1].params.message_thread_id, 7);
  });

  test('no message_thread_id when threadId is null', async () => {
    const { send, calls } = makeFakeSend();
    await deliverReplies({
      bot: {}, send, chatId: '1', threadId: null,
      chunks: ['a'], logger: silentLogger(),
    });
    assert.equal(calls[0].params.message_thread_id, undefined);
  });
});

describe('deliverReplies — meta passthrough', () => {
  test('meta is forwarded to send() for each chunk', async () => {
    const { send, calls } = makeFakeSend();
    const meta = { source: 'bot-reply', botName: 'shumabit', sessionId: 'abc' };
    await deliverReplies({
      bot: {}, send, chatId: '1', chunks: ['a', 'b'],
      meta, logger: silentLogger(),
    });
    assert.deepEqual(calls[0].meta, meta);
    assert.deepEqual(calls[1].meta, meta);
  });
});

describe('deliverReplies — partial failure tolerance', () => {
  test('failure on chunk 1/3 still delivers chunks 2 and 3', async () => {
    const { send, calls } = makeFakeSend({ errorOnIndex: 0 });
    const r = await deliverReplies({
      bot: {}, send, chatId: '1', chunks: ['a', 'b', 'c'],
      logger: silentLogger(),
    });
    assert.equal(calls.length, 3, 'all 3 attempts made');
    assert.equal(r.sent.length, 2);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].index, 0);
    assert.match(r.failed[0].error, /index 0/);
  });

  test('failure on chunk 2/3 still delivers chunks 1 and 3', async () => {
    const { send, calls } = makeFakeSend({ errorOnIndex: 1 });
    const r = await deliverReplies({
      bot: {}, send, chatId: '1', chunks: ['a', 'b', 'c'],
      logger: silentLogger(),
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(r.failed.map((f) => f.index), [1]);
    assert.equal(r.sent.length, 2);
  });

  test('all chunks fail returns all-failed result without throwing', async () => {
    let count = 0;
    const send = async () => {
      count += 1;
      throw new Error('all bad');
    };
    const r = await deliverReplies({
      bot: {}, send, chatId: '1', chunks: ['a', 'b'],
      logger: silentLogger(),
    });
    assert.equal(count, 2);
    assert.equal(r.sent.length, 0);
    assert.equal(r.failed.length, 2);
  });
});

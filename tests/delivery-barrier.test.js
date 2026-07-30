'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSender } = require('../lib/telegram/api');
const { createDeliveryBarrier } = require('../lib/telegram/delivery-barrier');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeBot(handler) {
  return {
    api: {
      raw: new Proxy({}, {
        get: (_target, method) => (params) => handler(method, params),
      }),
    },
  };
}

describe('reply-bearing delivery barrier', () => {
  test('marks output and registers the promise before Telegram is invoked', async () => {
    const barrier = createDeliveryBarrier();
    const hold = deferred();
    let observed;
    const bot = fakeBot(async () => {
      observed = barrier.inspect('chat:3');
      return hold.promise;
    });
    const sender = createSender(null, console, null, barrier);

    const sending = sender(
      bot,
      'sendMessage',
      { chat_id: 'chat', text: 'answer' },
      {
        sessionKey: 'chat:3',
        sourceMsgId: 41,
        deliveryClass: 'reply-bearing',
      },
    );

    await Promise.resolve();
    assert.equal(barrier.inspect('chat:3', 41).outputAttempted, true);
    assert.equal(observed.pending, 1);
    hold.resolve({ message_id: 10, date: 1 });
    await sending;
    assert.equal(barrier.inspect('chat:3').pending, 0);
  });

  test('sticky output evidence is scoped to the interrupted source message', async () => {
    const barrier = createDeliveryBarrier();
    const bot = fakeBot(async () => ({ message_id: 10, date: 1 }));
    const sender = createSender(null, console, null, barrier);

    await sender(
      bot,
      'sendMessage',
      { chat_id: 'chat', text: 'answer to the prior turn' },
      {
        sessionKey: 'chat:3',
        sourceMsgId: 40,
        deliveryClass: 'reply-bearing',
      },
    );

    assert.equal(barrier.inspect('chat:3', 40).outputAttempted, true);
    assert.equal(barrier.inspect('chat:3', 41).outputAttempted, false);
  });

  test('output evidence keeps every attempted source until process retirement', async () => {
    const barrier = createDeliveryBarrier();
    const bot = fakeBot(async () => ({ message_id: 10, date: 1 }));
    const sender = createSender(null, console, null, barrier);

    for (const sourceMsgId of [40, 41]) {
      await sender(
        bot,
        'sendMessage',
        { chat_id: 'chat', text: `answer to ${sourceMsgId}` },
        { sessionKey: 'chat:3', sourceMsgId },
      );
    }

    assert.equal(barrier.inspect('chat:3', 40).outputAttempted, true);
    assert.equal(barrier.inspect('chat:3', 41).outputAttempted, true);
    assert.equal(barrier.inspect('chat:3', 42).outputAttempted, false);
  });

  test('confirmed process retirement forgets settled session evidence', async () => {
    const barrier = createDeliveryBarrier();
    const bot = fakeBot(async () => ({ message_id: 10, date: 1 }));
    const sender = createSender(null, console, null, barrier);
    await sender(
      bot,
      'sendMessage',
      { chat_id: 'chat', text: 'answer' },
      { sessionKey: 'chat:3', sourceMsgId: 40 },
    );

    barrier.retireSession('chat:3');

    assert.equal(barrier.inspect('chat:3', 40).outputAttempted, false);
  });

  test('retirement waits for pending delivery and a new generation cancels stale cleanup', async () => {
    const barrier = createDeliveryBarrier();
    const first = deferred();
    let calls = 0;
    const bot = fakeBot(() => {
      calls += 1;
      return calls === 1
        ? first.promise
        : Promise.resolve({ message_id: 11, date: 1 });
    });
    const sender = createSender(null, console, null, barrier);
    const oldDelivery = sender(
      bot,
      'sendMessage',
      { chat_id: 'chat', text: 'old answer' },
      { sessionKey: 'chat:3', sourceMsgId: 40 },
    );
    await Promise.resolve();
    barrier.retireSession('chat:3');
    await sender(
      bot,
      'sendMessage',
      { chat_id: 'chat', text: 'new answer' },
      { sessionKey: 'chat:3', sourceMsgId: 41 },
    );
    first.resolve({ message_id: 10, date: 1 });
    await oldDelivery;

    assert.equal(barrier.inspect('chat:3', 41).outputAttempted, true);
  });

  test('derives the configured session key when legacy callers omit metadata', async () => {
    const barrier = createDeliveryBarrier();
    const hold = deferred();
    const bot = fakeBot(() => hold.promise);
    const sender = createSender(null, console, {
      chats: {
        chat: { isolateTopics: true },
        shared: { isolateTopics: false },
      },
    }, barrier);

    const isolated = sender(bot, 'sendMessage', {
      chat_id: 'chat',
      message_thread_id: 3,
      text: 'isolated answer',
    });
    const shared = sender(bot, 'sendMessage', {
      chat_id: 'shared',
      message_thread_id: 8,
      text: 'shared answer',
    });
    await Promise.resolve();

    assert.equal(barrier.inspect('chat:3').outputAttempted, true);
    assert.equal(barrier.inspect('chat:3').pending, 1);
    assert.equal(barrier.inspect('shared').outputAttempted, true);
    assert.equal(barrier.inspect('shared').pending, 1);

    hold.resolve({ message_id: 10, date: 1 });
    await Promise.all([isolated, shared]);
  });

  test('fence waits for already-admitted work and rejects later reply-bearing sends', async () => {
    const barrier = createDeliveryBarrier();
    const hold = deferred();
    const bot = fakeBot(() => hold.promise);
    const sender = createSender(null, console, null, barrier);

    const admitted = sender(
      bot,
      'editMessageText',
      { chat_id: 'chat', message_id: 10, text: 'preview' },
      { sessionKey: 'chat:3', deliveryClass: 'reply-bearing' },
    );
    await Promise.resolve();

    let drained = false;
    const draining = barrier.fenceAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);

    await assert.rejects(
      () => sender(
        bot,
        'sendMessage',
        { chat_id: 'chat', text: 'late answer' },
        { sessionKey: 'chat:3', deliveryClass: 'reply-bearing' },
      ),
      (error) => error?.code === 'DELIVERY_FENCED',
    );

    hold.resolve({ message_id: 10, date: 1 });
    await admitted;
    await draining;
    assert.equal(drained, true);
  });

  test('operational UI remains allowed after the reply fence and never marks output', async () => {
    const barrier = createDeliveryBarrier();
    const calls = [];
    const bot = fakeBot(async (method) => {
      calls.push(method);
      return true;
    });
    const sender = createSender(null, console, null, barrier);
    await barrier.fenceAndDrain();

    await sender(
      bot,
      'setMessageReaction',
      { chat_id: 'chat', message_id: 10, reaction: [] },
      { sessionKey: 'chat:3', deliveryClass: 'operational-ui' },
    );

    assert.deepEqual(calls, ['setMessageReaction']);
    assert.deepEqual(barrier.inspect('chat:3'), {
      outputAttempted: false,
      pending: 0,
      fenced: true,
    });
  });

  test('invalid delivery classification fails before Telegram I/O', async () => {
    const barrier = createDeliveryBarrier();
    let called = false;
    const bot = fakeBot(async () => {
      called = true;
      return true;
    });
    const sender = createSender(null, console, null, barrier);

    await assert.rejects(
      () => sender(
        bot,
        'sendMessage',
        { chat_id: 'chat', text: 'answer' },
        { sessionKey: 'chat:3', deliveryClass: 'unknown' },
      ),
      /delivery class/i,
    );
    assert.equal(called, false);
  });

  test('an uncategorized Telegram method fails closed before I/O', async () => {
    const barrier = createDeliveryBarrier();
    let called = false;
    const bot = fakeBot(async () => {
      called = true;
      return true;
    });
    const sender = createSender(null, console, null, barrier);

    await assert.rejects(
      () => sender(bot, 'unknownMethod', { chat_id: 'chat' }),
      /delivery class/i,
    );
    assert.equal(called, false);
  });

  test('method defaults are exhaustive for legacy callers', async () => {
    const barrier = createDeliveryBarrier();
    const bot = fakeBot(async (_method, params) => ({
      message_id: params.message_id ?? 10,
      date: 1,
    }));
    const sender = createSender(null, console, null, barrier);

    await sender(
      bot,
      'sendSticker',
      { chat_id: 'chat', sticker: 'sticker' },
      { sessionKey: 'chat:3' },
    );
    await sender(
      bot,
      'setMessageReaction',
      { chat_id: 'chat', message_id: 10, reaction: [] },
      { sessionKey: 'chat:3' },
    );

    assert.equal(barrier.inspect('chat:3').outputAttempted, true);
  });
});

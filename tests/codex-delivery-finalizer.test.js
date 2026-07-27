'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createTelegramDeliveryFinalizer,
  finalizeTelegramDelivery,
} = require('../lib/codex/delivery-finalizer');

function codexResult(overrides = {}) {
  return {
    runtime: 'codex',
    backend: 'codex',
    generationId: 'generation-a',
    attemptId: 'attempt-a',
    providerSessionId: 'thread-a',
    providerTurnId: 'turn-a',
    error: null,
    ...overrides,
  };
}

function fixture() {
  const calls = [];
  const controller = {
    async settleTelegramDelivery(sessionKey, result, options) {
      calls.push(['settle', sessionKey, result.attemptId, options]);
      return { disposition: options.disposition };
    },
    settleQueuedDispatch(input) {
      calls.push(['queue', input]);
      return { outcome: 'settled' };
    },
  };
  return {
    calls,
    controller,
    markHandlerStatus(status) {
      calls.push(['handler', status]);
    },
  };
}

describe('Codex Telegram delivery finalizer', () => {
  test('a Telegram exception settles an unfinished Codex delivery as failed exactly once', async () => {
    const fx = fixture();
    const finalizer = createTelegramDeliveryFinalizer({
      controller: fx.controller,
      sessionKey: 'chat-a',
      result: codexResult(),
      markHandlerStatus: fx.markHandlerStatus,
    });

    const failed = await finalizer.failIfPending();
    const repeated = await finalizer.failIfPending();

    assert.equal(failed.disposition, 'failed');
    assert.strictEqual(repeated, failed);
    assert.deepEqual(fx.calls, [
      ['settle', 'chat-a', 'attempt-a', { disposition: 'failed' }],
      ['handler', 'failed'],
    ]);
  });

  test('the exception path leaves unfinished Claude delivery semantics to the existing handler', async () => {
    const fx = fixture();
    const finalizer = createTelegramDeliveryFinalizer({
      controller: fx.controller,
      sessionKey: 'chat-a',
      result: {
        runtime: 'claude',
        backend: 'sdk',
        error: null,
      },
      markHandlerStatus: fx.markHandlerStatus,
    });

    assert.equal(await finalizer.failIfPending(), null);
    assert.deepEqual(fx.calls, []);
  });

  test('commits exact delivery before marking the inbound replied', async () => {
    const fx = fixture();

    const outcome = await finalizeTelegramDelivery({
      controller: fx.controller,
      sessionKey: 'chat-a',
      result: codexResult(),
      deliveryComplete: true,
      markHandlerStatus: fx.markHandlerStatus,
    });

    assert.equal(outcome.handlerStatus, 'replied');
    assert.deepEqual(fx.calls, [
      ['settle', 'chat-a', 'attempt-a', { disposition: 'delivered' }],
      ['handler', 'replied'],
    ]);
  });

  test('commits incomplete delivery as failed before marking it failed', async () => {
    const fx = fixture();

    const outcome = await finalizeTelegramDelivery({
      controller: fx.controller,
      sessionKey: 'chat-a',
      result: codexResult(),
      deliveryComplete: false,
      markHandlerStatus: fx.markHandlerStatus,
    });

    assert.equal(outcome.handlerStatus, 'failed');
    assert.deepEqual(fx.calls, [
      ['settle', 'chat-a', 'attempt-a', { disposition: 'failed' }],
      ['handler', 'failed'],
    ]);
  });

  test('settles a successful queued turn only after exact delivery proof', async () => {
    const fx = fixture();
    const queuedDispatch = {
      reservationId: 'reservation-a',
      botName: 'bot-a',
      telegramChatId: '42',
      telegramMessageId: '91',
    };

    await finalizeTelegramDelivery({
      controller: fx.controller,
      sessionKey: 'chat-a',
      result: codexResult(),
      deliveryComplete: true,
      queuedDispatch,
      markHandlerStatus: fx.markHandlerStatus,
    });

    assert.deepEqual(fx.calls, [
      ['settle', 'chat-a', 'attempt-a', { disposition: 'delivered' }],
      ['queue', {
        sessionKey: 'chat-a',
        generationId: 'generation-a',
        reservationId: 'reservation-a',
        attemptId: 'attempt-a',
        botName: 'bot-a',
        telegramChatId: '42',
        telegramMessageId: '91',
      }],
      ['handler', 'replied'],
    ]);
  });

  test('failed delivery leaves queue settlement to the atomic failure disposition', async () => {
    const fx = fixture();

    await finalizeTelegramDelivery({
      controller: fx.controller,
      sessionKey: 'chat-a',
      result: codexResult(),
      deliveryComplete: false,
      queuedDispatch: {
        reservationId: 'reservation-a',
        botName: 'bot-a',
        telegramChatId: '42',
        telegramMessageId: '91',
      },
      markHandlerStatus: fx.markHandlerStatus,
    });

    assert.deepEqual(fx.calls, [
      ['settle', 'chat-a', 'attempt-a', { disposition: 'failed' }],
      ['handler', 'failed'],
    ]);
  });

  test('preserves existing Claude completion semantics without Codex calls', async () => {
    const fx = fixture();

    const outcome = await finalizeTelegramDelivery({
      controller: fx.controller,
      sessionKey: 'chat-a',
      result: {
        runtime: 'claude',
        backend: 'sdk',
        error: null,
      },
      deliveryComplete: false,
      markHandlerStatus: fx.markHandlerStatus,
    });

    assert.equal(outcome.handlerStatus, 'replied');
    assert.deepEqual(fx.calls, [['handler', 'replied']]);
  });

  test('fails closed when a Codex result has no runtime controller', async () => {
    await assert.rejects(
      finalizeTelegramDelivery({
        controller: null,
        sessionKey: 'chat-a',
        result: codexResult(),
        deliveryComplete: true,
        markHandlerStatus() {},
      }),
      (error) => error?.code === 'CODEX_DELIVERY_CONTROLLER_MISSING',
    );
  });
});

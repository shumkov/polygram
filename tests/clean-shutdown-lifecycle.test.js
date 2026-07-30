'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareCleanRetirement,
  buildResumeIntents,
} = require('../lib/ops/clean-shutdown');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('clean shutdown retirement boundary', () => {
  test('fences delivery and process output together, then awaits handler settlement', async () => {
    const sequence = [];
    const delivery = deferred();
    const retirement = deferred();
    const barrier = {
      fenceAndDrain() {
        sequence.push('delivery-fenced');
        return delivery.promise;
      },
      inspect(sessionKey, sourceMsgId) {
        return {
          sessionKey,
          sourceMsgId,
          outputAttempted: false,
          pending: 0,
          fenced: true,
        };
      },
    };
    const pm = {
      retireForCleanRestart(options) {
        sequence.push('process-fenced');
        assert.deepEqual(options.getDeliveryEvidence('chat:3', 9), {
          sessionKey: 'chat:3',
          sourceMsgId: 9,
          outputAttempted: false,
          pending: 0,
          fenced: true,
        });
        return retirement.promise;
      },
    };
    const awaitHandlerSettlement = async () => {
      sequence.push('handlers-settled');
    };

    let finished = false;
    const preparing = prepareCleanRetirement({
      pm,
      deliveryBarrier: barrier,
      awaitHandlerSettlement,
      settlementTimeoutMs: 1234,
    }).then((value) => {
      finished = true;
      return value;
    });

    assert.deepEqual(sequence, ['delivery-fenced', 'process-fenced']);
    delivery.resolve({ pending: 0 });
    await Promise.resolve();
    assert.equal(finished, false);
    retirement.resolve([{
      sessionKey: 'chat:3',
      sourceMsgId: 9,
      eligible: true,
    }]);

    const result = await preparing;
    assert.deepEqual(sequence, [
      'delivery-fenced',
      'process-fenced',
      'handlers-settled',
    ]);
    assert.deepEqual(result.snapshots, [{
      sessionKey: 'chat:3',
      sourceMsgId: 9,
      eligible: true,
    }]);
  });

  test('retirement failure prevents handler settlement and clean persistence inputs', async () => {
    let settled = false;
    await assert.rejects(
      () => prepareCleanRetirement({
        pm: {
          retireForCleanRestart: async () => {
            throw new Error('tmux termination uncertain');
          },
        },
        deliveryBarrier: {
          fenceAndDrain: async () => ({ pending: 0 }),
          inspect: () => ({ outputAttempted: false, pending: 0, fenced: true }),
        },
        awaitHandlerSettlement: async () => { settled = true; },
      }),
      /termination uncertain/,
    );
    assert.equal(settled, false);
  });

  test('handler settlement timeout rejects clean retirement snapshots', async () => {
    const timeout = Object.assign(new Error('handler settlement timed out'), {
      code: 'HANDLER_SETTLEMENT_TIMEOUT',
    });
    await assert.rejects(
      () => prepareCleanRetirement({
        pm: {
          retireForCleanRestart: async () => [{
            sessionKey: 'chat:3',
            sourceMsgId: 9,
            eligible: true,
          }],
        },
        deliveryBarrier: {
          fenceAndDrain: async () => ({ pending: 0 }),
          inspect: () => ({ outputAttempted: false, pending: 0, fenced: true }),
        },
        awaitHandlerSettlement: async () => { throw timeout; },
      }),
      (error) => error?.code === 'HANDLER_SETTLEMENT_TIMEOUT',
    );
  });

  test('missing retirement API fails closed', async () => {
    await assert.rejects(
      () => prepareCleanRetirement({
        pm: {},
        deliveryBarrier: {
          fenceAndDrain: async () => ({ pending: 0 }),
          inspect: () => ({ outputAttempted: false, pending: 0, fenced: true }),
        },
        awaitHandlerSettlement: async () => {},
      }),
      /retireForCleanRestart/,
    );
  });
});

describe('retirement snapshot persistence projection', () => {
  test('persists only eligible snapshots whose exact inbound source resolves', () => {
    const result = buildResumeIntents({
      snapshots: [
        { sessionKey: '100:3', sourceMsgId: 9, eligible: true },
        { sessionKey: '200', sourceMsgId: 10, eligible: false, reason: 'output-attempted' },
        { sessionKey: '300', sourceMsgId: 11, eligible: true },
      ],
      resolveSourceMessageId: ({ sessionKey, sourceMsgId }) => (
        sessionKey === '100:3' && sourceMsgId === 9 ? 55 : null
      ),
      policyVersion: 1,
    });

    assert.deepEqual(result.resumeIntents, [{
      sessionKey: '100:3',
      sourceMessageId: 55,
      policyVersion: 1,
    }]);
    assert.deepEqual(
      result.snapshots.map(({ sessionKey, eligible, reason }) => ({
        sessionKey,
        eligible,
        reason,
      })),
      [
        { sessionKey: '100:3', eligible: true, reason: null },
        { sessionKey: '200', eligible: false, reason: 'output-attempted' },
        { sessionKey: '300', eligible: false, reason: 'source-message-missing' },
      ],
    );
  });

  test('duplicate eligible receipts fail closed instead of choosing one', () => {
    assert.throws(
      () => buildResumeIntents({
        snapshots: [
          { sessionKey: '100', sourceMsgId: 9, eligible: true },
          { sessionKey: '100', sourceMsgId: 9, eligible: true },
        ],
        resolveSourceMessageId: () => 55,
      }),
      /duplicate retirement snapshot/,
    );
  });

  test('one inbound source cannot authorize continuations in two sessions', () => {
    assert.throws(
      () => buildResumeIntents({
        snapshots: [
          { sessionKey: '100:3', sourceMsgId: 9, eligible: true },
          { sessionKey: '100:4', sourceMsgId: 9, eligible: true },
        ],
        resolveSourceMessageId: () => 55,
      }),
      /duplicate retirement source/,
    );
  });
});

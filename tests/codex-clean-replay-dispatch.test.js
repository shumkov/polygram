'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authorizeCleanReplayDispatch,
} = require('../lib/codex/clean-replay-dispatch');

test('authorizes the exact rearmed reservation on the expected Codex process', () => {
  const process = {
    runtime: 'codex',
    state: 'Idle',
    closed: false,
    generationId: 'generation-new',
  };
  const calls = [];
  const result = authorizeCleanReplayDispatch({
    sessionKey: 'chat:topic',
    currentProcess: process,
    expectedProcess: process,
    reservation: {
      reservationId: 'reservation-a',
      generationId: 'generation-new',
    },
    controller: {
      markDispatchDisposition: (input) => calls.push(input),
    },
  });

  assert.deepEqual(calls, [{
    sessionKey: 'chat:topic',
    generationId: 'generation-new',
    reservationId: 'reservation-a',
    disposition: 'queue-authorized',
  }]);
  assert.deepEqual(result, {
    reservationId: 'reservation-a',
    generationId: 'generation-new',
    state: 'queue-authorized',
  });
});

for (const [name, mutate] of [
  ['replacement process', ({ process }) => ({ currentProcess: { ...process } })],
  ['closed process', ({ process }) => ({ currentProcess: { ...process, closed: true } })],
  ['wrong generation', () => ({
    reservation: {
      reservationId: 'reservation-a',
      generationId: 'generation-old',
    },
  })],
  ['stopping process', ({ process }) => ({
    currentProcess: { ...process, state: 'Quiescing' },
  })],
]) {
  test(`${name} fails before queue authorization`, () => {
    const process = {
      runtime: 'codex',
      state: 'Idle',
      closed: false,
      generationId: 'generation-new',
    };
    const calls = [];
    const input = {
      sessionKey: 'chat:topic',
      currentProcess: process,
      expectedProcess: process,
      reservation: {
        reservationId: 'reservation-a',
        generationId: 'generation-new',
      },
      controller: {
        markDispatchDisposition: (value) => calls.push(value),
      },
      ...mutate({ process }),
    };

    assert.throws(
      () => authorizeCleanReplayDispatch(input),
      { code: 'CODEX_CLEAN_REPLAY_PROCESS_CHANGED' },
    );
    assert.deepEqual(calls, []);
  });
}

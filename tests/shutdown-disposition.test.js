'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { persistShutdownDisposition } = require('../lib/ops/shutdown-disposition');

test('handled shutdown signals retain the existing clean-shutdown persistence', () => {
  const calls = [];
  const result = persistShutdownDisposition({
    db: {
      recordCleanShutdown(args) {
        calls.push(args);
        return { replayMarked: 2 };
      },
    },
    botName: 'shumabit',
    now: 1_800_000_000_000,
    since: 1_799_999_000_000,
  });

  assert.deepEqual(calls, [{
    botName: 'shumabit',
    now: 1_800_000_000_000,
    since: 1_799_999_000_000,
    resumeIntents: [],
  }]);
  assert.deepEqual(result, {
    clean: true,
    shutdownReason: 'oom-observer-unavailable',
    replayMarked: 2,
    intentsRecorded: 0,
  });
});

test('clean shutdown passes only retired resume intents into the atomic transaction', () => {
  const calls = [];
  const resumeIntents = [{
    sessionKey: '100:3',
    sourceMessageId: 55,
    policyVersion: 1,
  }];
  const result = persistShutdownDisposition({
    db: {
      recordCleanShutdown(args) {
        calls.push(args);
        return { replayMarked: 2, intentsRecorded: 1 };
      },
    },
    botName: 'shumabit',
    now: 1_800_000_000_000,
    resumeIntents,
  });

  assert.deepEqual(calls[0].resumeIntents, resumeIntents);
  assert.equal(result.intentsRecorded, 1);
});

test('detected cgroup OOM persists crash state with a JSON-safe counter delta', () => {
  const calls = [];
  const result = persistShutdownDisposition({
    db: {
      recordCleanShutdown() {
        throw new Error('must not record clean');
      },
      recordCrashShutdown(args) {
        calls.push(args);
        return { replayMarked: 1 };
      },
    },
    botName: 'shumabit',
    now: 1_800_000_000_000,
    observation: {
      status: 'detected',
      detected: true,
      delta: 9_007_199_254_740_993n,
    },
  });

  assert.deepEqual(calls, [{
    botName: 'shumabit',
    now: 1_800_000_000_000,
    since: undefined,
  }]);
  assert.deepEqual(result, {
    clean: false,
    shutdownReason: 'cgroup-oom-kill',
    replayMarked: 1,
    oomKillDelta: '9007199254740993',
  });
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('retirement uncertainty records crash state and never writes clean intents', () => {
  let crashArgs;
  const result = persistShutdownDisposition({
    db: {
      recordCleanShutdown() {
        throw new Error('must not record clean');
      },
      recordCrashShutdown(args) {
        crashArgs = args;
        return { replayMarked: 3 };
      },
    },
    botName: 'shumabit',
    resumeIntents: [{
      sessionKey: '100',
      sourceMessageId: 55,
      policyVersion: 1,
    }],
    forceCrashReason: 'clean-retirement-failed',
  });

  assert.equal(crashArgs.botName, 'shumabit');
  assert.deepEqual(result, {
    clean: false,
    shutdownReason: 'clean-retirement-failed',
    replayMarked: 3,
  });
});

test('non-OOM observer states retain clean persistence with truthful reasons', () => {
  for (const [status, shutdownReason] of [
    ['unchanged', 'no-oom-delta'],
    ['unsupported', 'oom-observer-unsupported'],
    ['unavailable', 'oom-observer-unavailable'],
  ]) {
    const result = persistShutdownDisposition({
      db: {
        recordCleanShutdown: () => ({ replayMarked: 0 }),
      },
      botName: 'shumabit',
      observation: { status, detected: false, delta: status === 'unchanged' ? 0n : null },
    });
    assert.equal(result.clean, true);
    assert.equal(result.shutdownReason, shutdownReason);
    assert.equal(result.oomKillDelta, undefined);
  }
});

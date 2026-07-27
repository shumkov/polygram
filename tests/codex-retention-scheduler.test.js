'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  DEFAULT_INTERVAL_MS,
  scheduleCodexRetention,
} = require('../lib/codex/retention-scheduler');

function fixture({ pruneResult, pruneError } = {}) {
  const immediateCallbacks = [];
  const intervalCallbacks = [];
  const logs = [];
  const errors = [];
  const events = [];
  let unrefCalls = 0;
  let pruneCalls = 0;
  const scheduled = scheduleCodexRetention({
    db: {
      pruneCodexOperationalData() {
        pruneCalls += 1;
        if (pruneError) throw pruneError;
        return pruneResult ?? {
          deletedAttempts: 0,
          deletedGenerations: 0,
        };
      },
    },
    logEvent: (name, detail) => events.push({ name, detail }),
    logger: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
    scheduleImmediate: (callback) => immediateCallbacks.push(callback),
    scheduleInterval: (callback, delay) => {
      intervalCallbacks.push({ callback, delay });
      return { unref: () => { unrefCalls += 1; } };
    },
  });
  return {
    scheduled,
    immediateCallbacks,
    intervalCallbacks,
    logs,
    errors,
    events,
    get pruneCalls() { return pruneCalls; },
    get unrefCalls() { return unrefCalls; },
  };
}

describe('Codex retention scheduler', () => {
  test('runs on boot and a daily unrefed interval', () => {
    const fx = fixture();
    assert.equal(fx.immediateCallbacks.length, 1);
    assert.equal(fx.intervalCallbacks.length, 1);
    assert.equal(fx.intervalCallbacks[0].delay, DEFAULT_INTERVAL_MS);
    assert.equal(fx.unrefCalls, 1);

    fx.immediateCallbacks[0]();
    fx.intervalCallbacks[0].callback();
    assert.equal(fx.pruneCalls, 2);
  });

  test('emits only deletion counts when rows are pruned', () => {
    const fx = fixture({
      pruneResult: {
        deletedAttempts: 3,
        deletedGenerations: 2,
      },
    });
    fx.immediateCallbacks[0]();

    assert.deepEqual(fx.events, [{
      name: 'codex-operational-data-pruned',
      detail: {
        trigger: 'boot',
        deleted_attempts: 3,
        deleted_generations: 2,
      },
    }]);
    assert.match(fx.logs[0], /3 attempts.*2 generations.*boot/);
    assert.equal(fx.errors.length, 0);
  });

  test('isolates pruning failures and logs no raw error message', () => {
    const error = Object.assign(
      new Error('secret path and prompt content'),
      { code: 'SQLITE_BUSY' },
    );
    const fx = fixture({ pruneError: error });

    assert.equal(fx.immediateCallbacks[0](), null);
    assert.deepEqual(fx.events, []);
    assert.deepEqual(fx.logs, []);
    assert.deepEqual(
      fx.errors,
      ['[codex-retention] prune failed (boot): SQLITE_BUSY'],
    );
  });

  test('the daemon installs the scheduler after DB initialization', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'polygram.js'),
      'utf8',
    );
    const dbOpen = source.indexOf('db = dbClient.open(DB_PATH);');
    const schedule = source.indexOf(
      'scheduleCodexRetention({ db, logEvent, logger: console });',
    );
    assert.ok(dbOpen >= 0 && schedule > dbOpen);
  });
});

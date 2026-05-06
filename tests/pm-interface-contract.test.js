/**
 * Pm interface contract test — exercises the full canonical surface
 * defined in lib/pm-interface.js against the fake-pm helper. Acts
 * as both a usage example for fake-pm and a regression guard for
 * the interface shape (if a method is renamed, this test breaks
 * loudly).
 *
 * This test is the canonical answer to "what does a Pm look like?"
 * Real pm classes (process-manager.js / process-manager-sdk.js)
 * declare @implements {Pm} JSDoc — drift between this test and
 * real impls is a signal to update the JSDoc typedef.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePm } = require('./_helpers/fake-pm');

describe('Pm interface — required methods on every fake', () => {
  const REQUIRED_METHODS = ['has', 'get', 'getOrSpawn', 'send', 'kill', 'killChat', 'shutdown'];

  for (const m of REQUIRED_METHODS) {
    test(`fake exposes ${m}() by default`, () => {
      const pm = makeFakePm('cli');
      assert.equal(typeof pm[m], 'function', `${m} must be on every Pm`);
    });
  }
});

describe('Pm interface — optional methods are off by default', () => {
  const OPTIONAL_METHODS = [
    'steer', 'setModel', 'applyFlagSettings', 'setPermissionMode',
    'drainQueue', 'interrupt', 'resetSession',
  ];

  for (const m of OPTIONAL_METHODS) {
    test(`${m}() not exposed unless opted in`, () => {
      const pm = makeFakePm('default');
      assert.equal(pm[m], undefined, `${m} should be absent on a default fake`);
    });

    test(`${m}() is exposed when opt-in is set`, () => {
      const pm = makeFakePm('opted', { [m]: true });
      assert.equal(typeof pm[m], 'function', `${m} should appear when opted in`);
    });
  }
});

describe('Pm interface — call recording', () => {
  test('every method call appends to .calls in order', () => {
    const pm = makeFakePm('rec', { steer: true, drainQueue: true });
    pm.has('a');
    pm.send('a', 'hi');
    pm.steer('a', 'mid-turn');
    pm.drainQueue('a', 'INTERRUPTED');
    assert.deepEqual(pm.calls.map((c) => c[0]), [
      'has', 'send', 'steer', 'drainQueue',
    ]);
  });

  test('async methods return promises that resolve with documented shapes', async () => {
    const pm = makeFakePm('async');
    const sendResult = await pm.send('x', 'hello');
    assert.equal(typeof sendResult.text, 'string');
    assert.ok('metrics' in sendResult);
  });

  test('async lifecycle methods (killChat, shutdown) resolve cleanly', async () => {
    const pm = makeFakePm('lc');
    await assert.doesNotReject(pm.killChat(123));
    await assert.doesNotReject(pm.shutdown());
  });
});

describe('Pm interface — opted-in optional methods record', () => {
  test('steer call captures all args', () => {
    const pm = makeFakePm('s', { steer: true });
    pm.steer('chat-1', 'hello', { shouldQuery: false });
    assert.deepEqual(pm.calls[0], ['steer', 'chat-1', 'hello', { shouldQuery: false }]);
  });

  test('setModel + applyFlagSettings + setPermissionMode return Promise<boolean>', async () => {
    const pm = makeFakePm('mid', {
      setModel: true,
      applyFlagSettings: true,
      setPermissionMode: true,
    });
    assert.equal(await pm.setModel('a', 'sonnet'), true);
    assert.equal(await pm.applyFlagSettings('a', { effortLevel: 'high' }), true);
    assert.equal(await pm.setPermissionMode('a', 'default'), true);
  });

  test('resetSession returns Promise of {closed, drainedPendings}', async () => {
    const pm = makeFakePm('sdk', { resetSession: true });
    const r = await pm.resetSession('a', { reason: 'user' });
    assert.equal(r.closed, true);
    assert.equal(r.drainedPendings, 0);
  });
});

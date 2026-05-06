/**
 * Tests for lib/pm-router.js — post-0.9.0 thin single-pm wrapper.
 *
 * The 0.8.x dual-pm router (CLI vs SDK with POLYGRAM_USE_SDK /
 * POLYGRAM_SDK_CHATS env-driven selection) was deleted in 0.9.0
 * cleanup commit 4. The router file remains as a forward-compatible
 * seam so a future alternate pm impl can slot in without polygram.js
 * changes.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createPmRouter } = require('../lib/sdk/router');

describe('createPmRouter — single-pm wrapper', () => {
  test('returns the wrapped pm instance', () => {
    const pm = { has: () => true, send: () => Promise.resolve() };
    const router = createPmRouter({ pm });
    assert.strictEqual(router, pm,
      'wrapper currently returns the underlying pm — extension point preserved');
  });

  test('throws when pm is missing', () => {
    assert.throws(() => createPmRouter({}), /pm required/);
    assert.throws(() => createPmRouter({ pm: null }), /pm required/);
    assert.throws(() => createPmRouter(), /pm required/);
  });

  test('preserves all pm methods (no method shadowing)', () => {
    const pm = {
      has: () => true,
      send: () => Promise.resolve(),
      kill: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      resetSession: () => Promise.resolve({ closed: true, drainedPendings: 0 }),
      interrupt: () => Promise.resolve(),
      drainQueue: () => 0,
      applyFlagSettings: () => Promise.resolve(true),
      setModel: () => Promise.resolve(true),
    };
    const router = createPmRouter({ pm });
    for (const m of Object.keys(pm)) {
      assert.equal(typeof router[m], 'function', `${m} should be present`);
    }
  });
});

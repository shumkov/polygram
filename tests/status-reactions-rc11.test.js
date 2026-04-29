/**
 * Tests for status-reactions changes shipped in rc.11+rc.16:
 *
 *   - rc.11: applyChain serialization (concurrent flushes are sent
 *     to Telegram in invocation order, not arbitrary).
 *   - rc.11: AUTOSTEERED terminal state (chain ['✍', '👀']).
 *   - rc.16: heartbeat() re-arms stall timers without changing
 *     the visible emoji.
 *
 * v6 plan §7.3 G1 unit coverage (autosteer reaction lifecycle).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createReactionManager, STATES } = require('../lib/status-reactions');

describe('reactor — applyChain serialization (rc.11)', () => {
  test('concurrent flushes complete in setState invocation order', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => {
        // Delay first call so a second one can race it.
        if (calls.length === 0) await new Promise((res) => setTimeout(res, 25));
        calls.push(emoji);
      },
      throttleMs: 0,
    });
    r.setState('THINKING');
    r.setState('CODING');
    // Wait long enough for both applies to land.
    await new Promise((res) => setTimeout(res, 100));
    // Order must be THINKING then CODING — NOT reversed by race.
    assert.deepEqual(calls, ['🤔', '👨‍💻']);
  });

  test('clear() also serializes through applyChain', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => {
        if (calls.length === 0) await new Promise((res) => setTimeout(res, 25));
        calls.push(emoji);
      },
      throttleMs: 0,
    });
    r.setState('QUEUED');
    await r.clear();
    // Both calls landed; order respected.
    assert.deepEqual(calls, ['👀', null]);
  });
});

describe('reactor — AUTOSTEERED state (rc.11)', () => {
  test('AUTOSTEERED state is defined with ✍ chain', () => {
    assert.ok(STATES.AUTOSTEERED);
    assert.equal(STATES.AUTOSTEERED.chain[0], '✍');
  });

  test('setState(AUTOSTEERED) flushes immediately (terminal — bypasses throttle)', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => calls.push(emoji),
      throttleMs: 1000,                      // long throttle to verify bypass
    });
    r.setState('THINKING');                  // primes lastFlushTs
    await new Promise((res) => setTimeout(res, 5));
    await r.setState('AUTOSTEERED');         // should flush immediately, not wait 1s
    assert.deepEqual(calls, ['🤔', '✍']);
  });

  test('AUTOSTEERED apply runs even after stop() is called', async () => {
    // Terminal states bypass the `stopped` early-return in flush so
    // an autosteer ack lands even if the outer finally fired stop().
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => calls.push(emoji),
      throttleMs: 0,
    });
    const p = r.setState('AUTOSTEERED');
    r.stop();
    await p;
    assert.deepEqual(calls, ['✍']);
  });
});

describe('reactor — heartbeat (rc.16)', () => {
  test('heartbeat does NOT change the visible emoji', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => calls.push(emoji),
      throttleMs: 0,
    });
    await r.setState('THINKING');
    r.heartbeat();
    await new Promise((res) => setImmediate(res));
    // Only the THINKING flush should have fired — heartbeat doesn't apply.
    assert.deepEqual(calls, ['🤔']);
  });

  test('heartbeat re-arms stall timer (no STALL fires after heartbeat keeps reactor alive)', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => calls.push(emoji),
      throttleMs: 0,
      stallMs: 50,
      freezeMs: 200,
    });
    await r.setState('THINKING');                       // arms 50ms stall
    // Heartbeat every 30ms — keeps stall timer perpetually re-armed.
    for (let i = 0; i < 4; i++) {
      await new Promise((res) => setTimeout(res, 30));
      r.heartbeat();
    }
    // Total elapsed ≈ 120ms — without heartbeats, STALL would have
    // fired at 50ms.
    await new Promise((res) => setTimeout(res, 30));    // grace
    assert.equal(calls.includes('🥱'), false, 'STALL should not fire while heartbeats arrive');
  });

  test('heartbeat is no-op when state is not STALL_PROMOTABLE', () => {
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
    });
    // No state set → currentState is null → heartbeat shouldn't arm timers.
    // Just verify it doesn't throw.
    assert.doesNotThrow(() => r.heartbeat());
  });

  test('heartbeat is no-op after stop()', () => {
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
    });
    r.stop();
    assert.doesNotThrow(() => r.heartbeat());
  });

  test('without heartbeat, STALL fires after stallMs', async () => {
    // Sanity check: confirms stall promotion is real, so the
    // heartbeat fix is solving an actual problem.
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => calls.push(emoji),
      throttleMs: 0,
      stallMs: 30,
      freezeMs: 200,
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(calls.includes('🥱'), true, 'STALL should fire after stallMs without heartbeat');
  });
});

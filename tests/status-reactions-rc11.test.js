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

describe('reactor — rc.24 no-throttle: every setState lands', () => {
  test('rapid QUEUED → THINKING → CODING all reach Telegram', async () => {
    // Pre-rc.24 the 800ms throttle would squash THINKING when
    // the user typed → onFirstStream → onToolUse fired in <30ms.
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => calls.push(emoji),
    });
    r.setState('QUEUED');
    r.setState('THINKING');
    r.setState('CODING');
    // applyChain serializes; wait for all three to land.
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(calls, ['👀', '🤔', '👨‍💻']);
  });

  test('every setState fires apply (no squashing of intermediate states)', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (emoji) => calls.push(emoji),
    });
    r.setState('THINKING');
    r.setState('CODING');
    r.setState('TOOL');
    r.setState('WRITING');
    r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 30));
    // All five should land in invocation order.
    assert.equal(calls.length, 5);
    assert.equal(calls[0], '🤔');                    // THINKING
    assert.equal(calls[4], '🤔');                    // back to THINKING
  });
});

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

describe('reactor — rc.32 thinking deepening cascade', () => {
  // Progressive deepening: setState('THINKING') auto-promotes through
  // THINKING_DEEPER (🤨, 12s) → THINKING_DEEPEST (🤓, 30s). State change
  // (CODING/TOOL/etc) clears it. Pre-rc.32 behaviour: stay at 🤔 the
  // entire thinking phase, then yawn at 45s.

  test('THINKING auto-promotes to THINKING_DEEPER after thinkingDeeperMs', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (e) => calls.push(e),
      throttleMs: 0,
      thinkingDeeperMs: 30,
      thinkingDeepestMs: 200,
      stallMs: 5000,
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(r.currentState, 'THINKING_DEEPER');
    assert.ok(calls.includes('🤨'), `🤨 should have fired; got ${JSON.stringify(calls)}`);
    r.stop();
  });

  test('THINKING auto-promotes to THINKING_DEEPEST after thinkingDeepestMs', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (e) => calls.push(e),
      throttleMs: 0,
      thinkingDeeperMs: 20,
      thinkingDeepestMs: 60,
      stallMs: 5000,
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.currentState, 'THINKING_DEEPEST');
    assert.ok(calls.includes('🤓'), `🧐 should have fired; got ${JSON.stringify(calls)}`);
    r.stop();
  });

  test('CODING fires before deepening — cancels both deeper + deepest', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (e) => calls.push(e),
      throttleMs: 0,
      thinkingDeeperMs: 30,
      thinkingDeepestMs: 80,
      stallMs: 5000,
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 5));
    await r.setState('CODING');
    await new Promise((res) => setTimeout(res, 100));
    // Should never have promoted to deeper or deepest.
    assert.equal(calls.includes('🤨'), false);
    assert.equal(calls.includes('🤓'), false);
    assert.equal(r.currentState, 'CODING');
    r.stop();
  });

  test('mid-cascade CODING cancels remaining deepening', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (e) => calls.push(e),
      throttleMs: 0,
      thinkingDeeperMs: 20,
      thinkingDeepestMs: 80,
      stallMs: 5000,
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 40));
    // Should have promoted to DEEPER but not yet DEEPEST.
    assert.equal(r.currentState, 'THINKING_DEEPER');
    await r.setState('CODING');
    await new Promise((res) => setTimeout(res, 100));
    // Deepest should NOT have fired after CODING took over.
    assert.equal(calls.includes('🤓'), false);
    assert.equal(r.currentState, 'CODING');
    r.stop();
  });

  test('explicit re-setState THINKING re-arms cascade fresh', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (e) => calls.push(e),
      throttleMs: 0,
      thinkingDeeperMs: 30,
      thinkingDeepestMs: 80,
      stallMs: 5000,
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(r.currentState, 'THINKING_DEEPER');
    // User effectively went CODING then back to THINKING — fresh cascade.
    await r.setState('CODING');
    await r.setState('THINKING');
    // Wait briefly — should NOT be at DEEPER yet (cascade restarted).
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(r.currentState, 'THINKING');
    // Now wait past threshold — DEEPER should fire again.
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(r.currentState, 'THINKING_DEEPER');
    r.stop();
  });

  test('stop() cancels pending deepening', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (e) => calls.push(e),
      throttleMs: 0,
      thinkingDeeperMs: 30,
      thinkingDeepestMs: 80,
      stallMs: 5000,
    });
    await r.setState('THINKING');
    r.stop();
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(calls.includes('🤨'), false);
    assert.equal(calls.includes('🤓'), false);
  });

  test('STALL still fires from a deepened state', async () => {
    const calls = [];
    const r = createReactionManager({
      apply: async (e) => calls.push(e),
      throttleMs: 0,
      thinkingDeeperMs: 10,
      thinkingDeepestMs: 30,
      stallMs: 80,
      freezeMs: 1000,
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 130));
    // STALL is in STALL_PROMOTABLE for THINKING_DEEPER/DEEPEST too.
    assert.ok(calls.includes('🥱'), `STALL should fire from a deepened state; got ${JSON.stringify(calls)}`);
    r.stop();
  });

  test('default thresholds match Ivan-DM-calibrated values', () => {
    const {
      DEFAULT_THINKING_DEEPER_MS,
      DEFAULT_THINKING_DEEPEST_MS,
    } = require('../lib/status-reactions');
    // 12s / 30s per Ivan DM 14-day data + rc.35 "less eager" tuning:
    // 12s lets the entire 5-15s bracket (33%) resolve on plain 🤔;
    // 30s lets the 15-30s bracket (25%) resolve on 🤨 without a
    // second cascade. STALL still fires at 45s for the long 17%.
    assert.equal(DEFAULT_THINKING_DEEPER_MS, 12000);
    assert.equal(DEFAULT_THINKING_DEEPEST_MS, 30000);
  });
});

describe('reactor — rc.39 onStateChange telemetry', () => {
  // Captures the visible-change moments for forensic reconstruction.
  // One event per setState/cascade/stall/clear that produces a
  // visible emoji change. Same-emoji no-op transitions DON'T fire.

  test('manual setState fires onStateChange with source=manual', async () => {
    const events = [];
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
      onStateChange: (e) => events.push(e),
    });
    await r.setState('THINKING');
    assert.equal(events.length, 1);
    assert.equal(events[0].fromState, null);
    assert.equal(events[0].toState, 'THINKING');
    assert.equal(events[0].fromEmoji, null);
    assert.equal(events[0].toEmoji, '🤔');
    assert.equal(events[0].source, 'manual');
    assert.ok(typeof events[0].ts === 'number');
    r.stop();
  });

  test('cascade-deeper auto-promotion fires with source=cascade-deeper', async () => {
    const events = [];
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
      thinkingDeeperMs: 20,
      thinkingDeepestMs: 999,
      onStateChange: (e) => events.push(e),
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 60));
    const cascade = events.find((e) => e.source === 'cascade-deeper');
    assert.ok(cascade, 'cascade-deeper event should fire');
    assert.equal(cascade.fromState, 'THINKING');
    assert.equal(cascade.toState, 'THINKING_DEEPER');
    assert.equal(cascade.fromEmoji, '🤔');
    assert.equal(cascade.toEmoji, '🤨');
    r.stop();
  });

  test('cascade-deepest auto-promotion fires with source=cascade-deepest', async () => {
    const events = [];
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
      thinkingDeeperMs: 10,
      thinkingDeepestMs: 30,
      onStateChange: (e) => events.push(e),
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 80));
    const ev = events.find((e) => e.source === 'cascade-deepest');
    assert.ok(ev, 'cascade-deepest event should fire');
    assert.equal(ev.toState, 'THINKING_DEEPEST');
    assert.equal(ev.toEmoji, '🤓');
    r.stop();
  });

  test('stall-timer fires with source=stall-timer', async () => {
    const events = [];
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
      stallMs: 30,
      freezeMs: 999,
      thinkingDeeperMs: 999,
      thinkingDeepestMs: 999,
      onStateChange: (e) => events.push(e),
    });
    await r.setState('THINKING');
    await new Promise((res) => setTimeout(res, 80));
    const ev = events.find((e) => e.source === 'stall-timer');
    assert.ok(ev, 'stall-timer event should fire');
    assert.equal(ev.toState, 'STALL');
    r.stop();
  });

  test('clear() fires with source=clear and toState=null', async () => {
    const events = [];
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
      onStateChange: (e) => events.push(e),
    });
    await r.setState('THINKING');
    await r.clear();
    const clearEv = events.find((e) => e.source === 'clear');
    assert.ok(clearEv, 'clear event should fire');
    assert.equal(clearEv.toState, null);
    assert.equal(clearEv.toEmoji, null);
    assert.equal(clearEv.fromEmoji, '🤔');
    r.stop();
  });

  test('same-emoji no-op transitions do NOT fire (only visible changes)', async () => {
    const events = [];
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
      onStateChange: (e) => events.push(e),
    });
    await r.setState('THINKING');  // → 🤔, fires
    await r.setState('THINKING');  // → 🤔 (no change), should NOT fire
    assert.equal(events.length, 1);
    r.stop();
  });

  test('callback throw is caught — does not break reactor', async () => {
    const errors = [];
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
      onStateChange: () => { throw new Error('boom'); },
      logError: (m) => errors.push(m),
    });
    await assert.doesNotReject(r.setState('THINKING'));
    assert.ok(errors.some((m) => /onStateChange/.test(m)));
    r.stop();
  });

  test('full turn produces an audit-trail of state transitions', async () => {
    // Verifies the typical lifecycle is captured end-to-end.
    const events = [];
    const r = createReactionManager({
      apply: async () => {},
      throttleMs: 0,
      onStateChange: (e) => events.push(e),
    });
    await r.setState('THINKING');
    await r.setState('CODING');
    await r.setState('WRITING');
    await r.clear();
    const sources = events.map((e) => e.source);
    assert.deepEqual(sources, ['manual', 'manual', 'manual', 'clear']);
    const states = events.map((e) => e.toState);
    assert.deepEqual(states, ['THINKING', 'CODING', 'WRITING', null]);
    r.stop();
  });
});

describe('reactor — rc.25 default timing thresholds', () => {
  // Pins the bumped defaults so accidental regression to the
  // pre-rc.25 values (10s STALL / 30s TIMEOUT) is caught.
  // The 30s TIMEOUT was firing on Ivan DM during routine multi-step
  // agent runs even though the bot was actively replying.
  const {
    DEFAULT_STALL_MS,
    DEFAULT_FREEZE_MS,
  } = require('../lib/status-reactions');

  test('DEFAULT_STALL_MS is at least 30s (not OpenClaw\'s aggressive 10s)', () => {
    assert.ok(DEFAULT_STALL_MS >= 30_000,
      `DEFAULT_STALL_MS=${DEFAULT_STALL_MS} too aggressive; SDK pm thinks > 10s routinely`);
  });

  test('DEFAULT_FREEZE_MS is at least 90s (was 30s pre-rc.25 — too aggressive)', () => {
    assert.ok(DEFAULT_FREEZE_MS >= 90_000,
      `DEFAULT_FREEZE_MS=${DEFAULT_FREEZE_MS} too aggressive for SDK pm long agent runs`);
  });

  test('DEFAULT_FREEZE_MS still bounded (under 10 min — pm has its own hard timeout)', () => {
    // Sanity: don't drift to "never fire". 5-minute pm idle timeout
    // is the real backstop; reactor should fire well before that to
    // give a visible signal to the user.
    assert.ok(DEFAULT_FREEZE_MS < 10 * 60_000,
      `DEFAULT_FREEZE_MS=${DEFAULT_FREEZE_MS} too lax`);
  });

  test('STALL fires before FREEZE (yawn before scary face)', () => {
    assert.ok(DEFAULT_STALL_MS < DEFAULT_FREEZE_MS);
  });
});

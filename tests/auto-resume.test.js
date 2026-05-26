/**
 * Tests for lib/auto-resume.js (rc.54).
 *
 * Cooldown semantics: when polygram auto-resumes a turn after a 300s
 * timeout, we record the attempt. If the SAME session times out
 * AGAIN within the cooldown window, we DON'T auto-resume the second
 * time — fall back to the existing user-facing "Try resending"
 * message. Without this guard, a permanently-wedged tool would
 * trigger an infinite resume → timeout → resume loop, billing real
 * tokens each cycle.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  createAutoResumeTracker,
  isAutoResumable,
  DEFAULT_COOLDOWN_MS,
} = require('../lib/db/auto-resume');

describe('createAutoResumeTracker — cooldown', () => {
  let now;
  let tracker;
  beforeEach(() => {
    let t = 1_000_000;
    now = () => t;
    now.advance = (ms) => { t += ms; };
    tracker = createAutoResumeTracker({ cooldownMs: 10 * 60 * 1000, now });
  });

  test('isInCooldown false when no attempts recorded', () => {
    assert.equal(tracker.isInCooldown('chat:1'), false);
  });

  test('markAttempt → isInCooldown true immediately after', () => {
    tracker.markAttempt('chat:1');
    assert.equal(tracker.isInCooldown('chat:1'), true);
  });

  test('isInCooldown stays true within the window', () => {
    tracker.markAttempt('chat:1');
    now.advance(5 * 60 * 1000); // 5 min in
    assert.equal(tracker.isInCooldown('chat:1'), true);
  });

  test('isInCooldown flips to false after the window expires', () => {
    tracker.markAttempt('chat:1');
    now.advance(10 * 60 * 1000 + 1); // just past 10 min
    assert.equal(tracker.isInCooldown('chat:1'), false);
  });

  test('cooldown is per-session, not global', () => {
    tracker.markAttempt('chat:1');
    assert.equal(tracker.isInCooldown('chat:1'), true);
    assert.equal(tracker.isInCooldown('chat:2'), false);
  });

  test('clear() drops the cooldown for that session only', () => {
    tracker.markAttempt('chat:1');
    tracker.markAttempt('chat:2');
    tracker.clear('chat:1');
    assert.equal(tracker.isInCooldown('chat:1'), false);
    assert.equal(tracker.isInCooldown('chat:2'), true);
  });

  test('reset() drops all cooldowns', () => {
    tracker.markAttempt('chat:1');
    tracker.markAttempt('chat:2');
    tracker.reset();
    assert.equal(tracker._size(), 0);
  });

  test('repeated markAttempt updates the timestamp (sliding window)', () => {
    tracker.markAttempt('chat:1');
    now.advance(9 * 60 * 1000); // close to expiring
    tracker.markAttempt('chat:1'); // refresh
    now.advance(9 * 60 * 1000); // 18 min total since first, 9 since second
    // Still in cooldown because the second markAttempt reset the window.
    assert.equal(tracker.isInCooldown('chat:1'), true);
  });

  test('default cooldown is 10 minutes', () => {
    assert.equal(DEFAULT_COOLDOWN_MS, 10 * 60 * 1000);
  });
});

describe('isAutoResumable — gate', () => {
  test('300s no-activity timeout → resumable', () => {
    assert.equal(
      isAutoResumable({ error: new Error('Timeout: 300s idle with no Claude activity') }),
      true,
    );
  });

  test('case-insensitive match on the error message', () => {
    assert.equal(
      isAutoResumable({ error: new Error('Timeout: 600s IDLE WITH NO CLAUDE ACTIVITY') }),
      true,
    );
  });

  test('wall-clock ceiling timeout → NOT resumable (rationale: runaway, not wedge)', () => {
    assert.equal(
      isAutoResumable({ error: new Error('Timeout: 1800s wall-clock ceiling exceeded') }),
      false,
    );
  });

  test('any other error → NOT resumable', () => {
    assert.equal(isAutoResumable({ error: new Error('error_during_execution') }), false);
    assert.equal(isAutoResumable({ error: new Error('socket hang up') }), false);
    assert.equal(isAutoResumable({ error: new Error('auth expired') }), false);
  });

  test('aborted=true blocks even if error matches', () => {
    assert.equal(
      isAutoResumable({
        error: new Error('Timeout: 300s idle with no Claude activity'),
        aborted: true,
      }),
      false,
    );
  });

  test('replay=true blocks (boot-replay turns are stale)', () => {
    assert.equal(
      isAutoResumable({
        error: new Error('Timeout: 300s idle with no Claude activity'),
        replay: true,
      }),
      false,
    );
  });

  test('shuttingDown=true blocks (boot replay will handle it)', () => {
    assert.equal(
      isAutoResumable({
        error: new Error('Timeout: 300s idle with no Claude activity'),
        shuttingDown: true,
      }),
      false,
    );
  });

  test('handles non-Error values gracefully', () => {
    assert.equal(isAutoResumable({ error: 'string error' }), false);
    assert.equal(isAutoResumable({ error: null }), false);
    assert.equal(isAutoResumable({}), false);
  });

  // ─── Review F#6: channels-specific error codes drive auto-resume too ──
  //
  // Pre-fix the regex only matched the tmux 'idle with no Claude activity'
  // string. Channels throws Error('bridge disconnected') with code
  // BRIDGE_DISCONNECTED, Error('turn timeout (600000ms)') with code
  // TURN_TIMEOUT — neither matches. Auto-resume silently never fires on
  // channels chats.
  //
  // Post-fix: code-based match for BRIDGE_DISCONNECTED (it's a wedge —
  // bridge socket dropped, claude likely crashed mid-turn, resume helps).
  // TURN_TIMEOUT stays non-resumable (10-min wall-clock cap is the channels
  // analog of the tmux ceiling — runaway, not wedge; resuming risks loop).

  test('F#6: BRIDGE_DISCONNECTED code → resumable (bridge wedge, mirror of idle pattern)', () => {
    const err = Object.assign(new Error('bridge disconnected'), { code: 'BRIDGE_DISCONNECTED' });
    assert.equal(isAutoResumable({ error: err }), true);
  });

  test('F#6: TURN_TIMEOUT code → NOT resumable (wall-clock ceiling, same as tmux 1800s)', () => {
    const err = Object.assign(new Error('turn timeout (600000ms)'), { code: 'TURN_TIMEOUT' });
    assert.equal(isAutoResumable({ error: err }), false);
  });

  test('F#6: BRIDGE_DISCONNECTED + aborted=true blocks (user said stop)', () => {
    const err = Object.assign(new Error('bridge disconnected'), { code: 'BRIDGE_DISCONNECTED' });
    assert.equal(isAutoResumable({ error: err, aborted: true }), false);
  });
});

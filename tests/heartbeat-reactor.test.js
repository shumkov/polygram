'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  HeartbeatReactor,
  DEFAULT_WORKING_POOL,
  DEFAULT_STALL_EMOJI,
} = require('../lib/telegram/heartbeat-reactor');

// Deterministic RNG returning floats in [0, 1) so Math.floor(rng() * n)
// produces predictable indices. fixedRng([0]) → always 0 (pool[0]).
// fixedRng([0, 0.5]) cycles between pool[0] and pool[floor(0.5*pool.length)].
function fixedRng(values) {
  let i = 0;
  return () => values[(i++) % values.length];
}

function makeRecorder() {
  const calls = [];
  const setReaction = async (chatId, messageId, reaction) => {
    calls.push({ chatId, messageId, reaction: [...reaction] });
  };
  return { calls, setReaction };
}

function makeProcess() {
  return new EventEmitter();
}

const quietLogger = { debug: () => {} };

test('construction validates required args', () => {
  assert.throws(() => new HeartbeatReactor({}), /process/, 'process required');
  assert.throws(
    () => new HeartbeatReactor({ process: new EventEmitter() }),
    /chatId/,
  );
  assert.throws(
    () => new HeartbeatReactor({ process: new EventEmitter(), chatId: 1 }),
    /messageId/,
  );
  assert.throws(
    () => new HeartbeatReactor({ process: new EventEmitter(), chatId: 1, messageId: 1 }),
    /setReaction/,
  );
  assert.throws(
    () => new HeartbeatReactor({
      process: new EventEmitter(), chatId: 1, messageId: 1,
      setReaction: () => {},
      workingPool: [],
    }),
    /workingPool/,
  );
});

test('fires immediate reaction on thinking', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    rng: fixedRng([0]),  // picks pool[0]
    logger: quietLogger,
  });

  proc.emit('thinking');
  await Promise.resolve();          // let _safeSetReaction microtask flush

  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0], {
    chatId: 1, messageId: 100,
    reaction: [DEFAULT_WORKING_POOL[0]],
  });
});

test('clears reaction on idle', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    rng: fixedRng([0]),
    logger: quietLogger,
  });

  proc.emit('thinking');
  await Promise.resolve();
  proc.emit('idle');
  await Promise.resolve();

  assert.equal(rec.calls.length, 2);
  assert.deepEqual(rec.calls[1].reaction, [], 'idle clears reaction');
});

test('STALL fires after stallAfterMs of no liveness', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    tickBaseMs: 100_000,       // suppress regular ticks during the short test
    tickJitterMs: 0,
    stallAfterMs: 50,          // very short for test
    rng: fixedRng([0]),
    logger: quietLogger,
  });

  proc.emit('thinking');
  await Promise.resolve();
  // wait past stall window
  await new Promise(r => setTimeout(r, 80));

  const stallCall = rec.calls.find(c => c.reaction[0] === DEFAULT_STALL_EMOJI);
  assert.ok(stallCall, 'stall emoji applied');
});

// Review #17: once STALL fires, a subsequent liveness event must resume
// cycling. Previously inStall was never cleared, so 🥱 stayed frozen for the
// rest of the turn.
test('STALL→liveness→cycling resumes (inStall clears on liveness)', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    tickBaseMs: 30,           // ticks fast so we observe resumption
    tickJitterMs: 0,
    stallAfterMs: 50,
    rng: fixedRng([0]),
    logger: quietLogger,
  });

  proc.emit('thinking');
  await Promise.resolve();

  // Wait past stall window
  await new Promise(r => setTimeout(r, 80));
  const stallFired = rec.calls.some(c => c.reaction[0] === DEFAULT_STALL_EMOJI);
  assert.ok(stallFired, 'stall emoji applied after stallAfterMs');

  // Now fire a liveness event — _resetStall should clear inStall, allowing
  // next tick to cycle again.
  const callsBeforeResume = rec.calls.length;
  proc.emit('tool-use', 'Bash');
  await new Promise(r => setTimeout(r, 60));   // 2 ticks at 30ms

  // After liveness + 2 ticks, at least one new working-pool reaction (NOT stall)
  const callsAfter = rec.calls.slice(callsBeforeResume);
  const resumedWithPoolEmoji = callsAfter.some(c =>
    c.reaction.length === 1 && DEFAULT_WORKING_POOL.includes(c.reaction[0]),
  );
  assert.ok(resumedWithPoolEmoji, `cycling resumed after liveness: got calls ${JSON.stringify(callsAfter.map(c => c.reaction))}`);
});

test('liveness event resets stall timer', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    tickBaseMs: 100_000,
    tickJitterMs: 0,
    stallAfterMs: 80,
    rng: fixedRng([0]),
    logger: quietLogger,
  });

  proc.emit('thinking');
  await new Promise(r => setTimeout(r, 40));
  proc.emit('tool-use', 'Bash');           // liveness — resets stall
  await new Promise(r => setTimeout(r, 60)); // would have stalled by now without the reset

  const stallCalls = rec.calls.filter(c => c.reaction[0] === DEFAULT_STALL_EMOJI);
  assert.equal(stallCalls.length, 0, 'no stall while liveness keeps firing');
});

test('stop() clears reaction and unbinds', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  const r = new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    rng: fixedRng([0]),
    logger: quietLogger,
  });

  proc.emit('thinking');
  await Promise.resolve();
  r.stop();
  await Promise.resolve();
  const before = rec.calls.length;

  // stop({clear:true} default) must end with reaction cleared
  assert.deepEqual(rec.calls[before - 1].reaction, [], 'stop clears reaction');

  // After stop, events should NOT trigger anything
  proc.emit('thinking');
  proc.emit('tool-use', 'Bash');
  await new Promise(r => setTimeout(r, 30));

  assert.equal(rec.calls.length, before, `no new calls after stop (before=${before} after=${rec.calls.length})`);
});

test('working pool members all valid (not in reserved set)', () => {
  // Belt-and-suspenders: ensures we didn't accidentally include
  // 👀/🤔/✍/🤯/😨/🥱 in the working pool.
  const reserved = new Set(['👀', '🤔', '✍', '🤯', '😨', '🥱']);
  for (const emoji of DEFAULT_WORKING_POOL) {
    assert.ok(!reserved.has(emoji), `working pool must not include reserved emoji ${emoji}`);
  }
});

test('bridge-disconnected stops permanently and clears reaction', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    rng: fixedRng([0]),
    logger: quietLogger,
  });

  proc.emit('thinking');
  await Promise.resolve();
  assert.ok(rec.calls.length >= 1, 'reactor fired on thinking');
  const beforeDisconnect = rec.calls.length;

  proc.emit('bridge-disconnected');
  await Promise.resolve();

  // Last reaction call must have been a clear ([]).
  const lastCall = rec.calls[rec.calls.length - 1];
  assert.deepEqual(lastCall.reaction, [], 'reaction cleared on bridge-disconnect');
  assert.ok(rec.calls.length > beforeDisconnect, 'an extra clear call landed');

  // Subsequent thinking ignored — reactor is stopped.
  proc.emit('thinking');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(rec.calls.length, beforeDisconnect + 1, 'no further reactions after disconnect');
});

test('close event stops permanently — subsequent thinking ignored', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    rng: fixedRng([0]),
    logger: quietLogger,
  });

  proc.emit('thinking');
  await Promise.resolve();
  proc.emit('close');
  await Promise.resolve();
  const before = rec.calls.length;

  proc.emit('thinking');                   // should be ignored — reactor stopped
  await new Promise(r => setTimeout(r, 20));

  assert.equal(rec.calls.length, before, 'no reactions after close');
});

test('multiple thinking → idle cycles handled', async () => {
  const proc = makeProcess();
  const rec = makeRecorder();
  // rng cycles through small floats so each tick picks a valid pool member.
  // Each cycle consumes ≥ 2 rng calls (emoji + jitter for scheduled tick).
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction: rec.setReaction,
    rng: fixedRng([0, 0.5, 0.2, 0.7]),
    logger: quietLogger,
  });

  // Turn 1
  proc.emit('thinking');
  await Promise.resolve();
  proc.emit('idle');
  await Promise.resolve();

  // Turn 2
  proc.emit('thinking');
  await Promise.resolve();
  proc.emit('idle');
  await Promise.resolve();

  // Each cycle: 1 thinking tick + 1 idle clear = 2 calls per cycle, 4 total
  assert.equal(rec.calls.length, 4);
  // Cycle 1: tick reaction is some working-pool emoji, idle clears to []
  assert.equal(rec.calls[0].reaction.length, 1);
  assert.ok(DEFAULT_WORKING_POOL.includes(rec.calls[0].reaction[0]), `cycle 1 tick emoji from pool: ${rec.calls[0].reaction[0]}`);
  assert.deepEqual(rec.calls[1].reaction, []);
  // Cycle 2: same shape
  assert.equal(rec.calls[2].reaction.length, 1);
  assert.ok(DEFAULT_WORKING_POOL.includes(rec.calls[2].reaction[0]), `cycle 2 tick emoji from pool: ${rec.calls[2].reaction[0]}`);
  assert.deepEqual(rec.calls[3].reaction, []);
});

test('setReaction failure is swallowed, heartbeat continues', async () => {
  const proc = makeProcess();
  let calls = 0;
  const setReaction = async () => {
    calls++;
    throw new Error('telegram rate limited');
  };
  new HeartbeatReactor({
    process: proc, chatId: 1, messageId: 100,
    setReaction,
    rng: fixedRng([0]),
    logger: quietLogger,
  });

  proc.emit('thinking');
  await new Promise(r => setTimeout(r, 20));
  proc.emit('idle');
  await new Promise(r => setTimeout(r, 20));

  // Should have attempted both the thinking-tick AND the idle-clear despite errors
  assert.ok(calls >= 2, `expected ≥ 2 setReaction attempts despite errors (got ${calls})`);
});

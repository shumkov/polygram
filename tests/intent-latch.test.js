/**
 * R9 — committed-intent latch coverage.
 *
 * The latch (`intentLock` in polygram.js handleMessage) serialises the
 * autosteer-vs-primary decision per session. The bug it fixes (the
 * 12:59 production trace): a burst of concurrent handlers each
 * mis-reads `inFlight` while the first turn is still spawning, so
 * EVERY message classifies itself as a fresh primary turn instead of
 * 1 primary + N-1 autosteers.
 *
 * `handleMessage` is a ~1500-line function and not unit-testable
 * directly. This test exercises the REAL latch primitives — the real
 * `createAsyncLock` and the real `createAutosteerHandlers.tryAutosteer`
 * — through a fake `pm` whose `send()` flips the entry's `inFlight`
 * exactly as `TmuxProcess._runTurn` does. The harness replicates the
 * exact handleMessage critical section:
 *
 *     releaseIntent = await intentLock.acquire(sessionKey)
 *     try {
 *       steered = tryAutosteer(...)            // reads pm.get().inFlight
 *       if (!steered.autosteered)
 *         await new Promise((dispatched) => {
 *           sendToProcess(..., { onDispatched: dispatched })
 *         })                                   // pm.send flips inFlight
 *     } finally { releaseIntent() }
 *
 * The PROPERTY pinned: for N concurrent dispatches against ONE idle
 * sessionKey, exactly ONE handler becomes primary and the other N-1
 * autosteer. The companion test stubs the latch to a no-op acquire and
 * shows the property BREAKS (multiple primaries) — proving the latch,
 * not luck, is what enforces it.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createAsyncLock } = require('../lib/async-lock');
const { createAutosteerHandlers } = require('../lib/handlers/autosteer');

/** Yield to the microtask/macrotask queue. */
function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Fake pm modelling the real autosteer-vs-primary surface:
 *   - `get(key).inFlight` — the predicate tryAutosteer reads.
 *   - `send()` — kicks a primary turn; flips `inFlight` true (mirrors
 *     TmuxProcess._runTurn setting `this.inFlight = true`) and calls
 *     `onDispatched` so the latch can release. Flipping inFlight is
 *     deliberately deferred past an await — the spawn gap the 12:59
 *     trace exploited — so without the latch a concurrent reader sees
 *     the still-idle entry.
 *   - `injectUserMessage()` — succeeds only while inFlight; mirrors
 *     TmuxProcess.injectUserMessage's `if (!this.inFlight) return false`.
 */
function makeFakePm({ spawnGapMs = 5 } = {}) {
  const entry = { inFlight: false };
  const calls = { sends: 0, injects: 0 };
  return {
    entry,
    calls,
    has() { return true; },
    get() { return entry; },
    async send(_key, _prompt, { onDispatched } = {}) {
      calls.sends += 1;
      // The spawn gap: a real TmuxProcess.send awaits getOrSpawn +
      // pasteAndEnter before _runTurn sets inFlight. Model it with an
      // await so a latch-less concurrent reader can slip in here.
      await tick(spawnGapMs);
      entry.inFlight = true;
      if (typeof onDispatched === 'function') onDispatched();
      return { text: 'ok', error: null };
    },
    injectUserMessage() {
      // Mirrors TmuxProcess.injectUserMessage: no live turn → false,
      // so the caller falls through to the pm.send queue path.
      if (!entry.inFlight) return false;
      calls.injects += 1;
      return true;
    },
  };
}

/**
 * Replicates handleMessage's committed-intent critical section for one
 * inbound message. `acquireIntent` is injected so the companion test
 * can swap in a no-op (latch removed) and observe the property break.
 *
 * Returns 'primary' or 'autosteer' — the classification this handler
 * committed to.
 */
async function runHandler({ pm, autosteer, sessionKey, acquireIntent, msgId }) {
  const release = await acquireIntent(sessionKey);
  let steered = { autosteered: false };
  try {
    steered = autosteer.tryAutosteer({
      sessionKey,
      chatConfig: {},
      chatId: '1',
      msg: { message_id: msgId },
      prompt: `m${msgId}`,
    });
    if (!steered.autosteered) {
      // Primary turn — hold the latch until pm.send has made the
      // process inFlight (onDispatched), exactly as sendToProcess does.
      await new Promise((dispatched) => {
        pm.send(sessionKey, `m${msgId}`, { onDispatched: dispatched })
          .catch(() => {})
          .finally(dispatched);
      });
    }
  } finally {
    release();
  }
  return steered.autosteered ? 'autosteer' : 'primary';
}

function makeAutosteer(pm) {
  return createAutosteerHandlers({
    config: { bot: {} },
    pm,
    autosteeredRefs: { add() {} },
    logEvent() {},
  });
}

describe('R9 — committed-intent latch', () => {
  test('with the latch: N concurrent dispatches → exactly 1 primary, N-1 autosteer', async () => {
    const N = 5;
    const pm = makeFakePm({ spawnGapMs: 5 });
    const autosteer = makeAutosteer(pm);
    const intentLock = createAsyncLock();   // the REAL latch
    const sessionKey = 'chat:100';

    // Fire all N handlers concurrently against ONE idle session — the
    // 12:59 burst shape.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runHandler({
          pm,
          autosteer,
          sessionKey,
          acquireIntent: (k) => intentLock.acquire(k),
          msgId: i + 1,
        })),
    );

    const primaries = results.filter((r) => r === 'primary').length;
    const autosteers = results.filter((r) => r === 'autosteer').length;

    assert.equal(primaries, 1,
      `exactly ONE handler must become primary — got ${primaries} (the 12:59 multi-primary bug)`);
    assert.equal(autosteers, N - 1,
      `the other ${N - 1} handlers must autosteer — got ${autosteers}`);
    assert.equal(pm.calls.sends, 1,
      'only the primary turn calls pm.send');
    assert.equal(pm.calls.injects, N - 1,
      'every non-primary message is injected as an autosteer');
  });

  test('latch removed (no-op acquire): the property BREAKS — multiple primaries', async () => {
    // Same harness, but acquireIntent is a no-op latch — every handler
    // enters the critical section immediately. This is the unfixed
    // 12:59 behaviour: each handler reads `inFlight` before the first
    // pm.send has flipped it, so they ALL classify as primary.
    const N = 5;
    const pm = makeFakePm({ spawnGapMs: 5 });
    const autosteer = makeAutosteer(pm);
    const sessionKey = 'chat:100';

    const noopAcquire = async () => () => {};

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runHandler({
          pm,
          autosteer,
          sessionKey,
          acquireIntent: noopAcquire,
          msgId: i + 1,
        })),
    );

    const primaries = results.filter((r) => r === 'primary').length;

    // The whole point of the latch: without it the burst races and
    // more than one handler commits a primary turn. If this ever
    // equals 1, the harness no longer reproduces the race and the
    // sibling test above is not actually proving the latch.
    assert.ok(primaries > 1,
      `without the latch the burst must produce MULTIPLE primaries — got ${primaries}; `
      + 'the latch is what collapses the burst to 1 primary + N-1 autosteers');
  });

  test('latch serialises a staggered burst too — late arrivals still autosteer', async () => {
    // Not a pure t=0 burst: messages arrive a few ms apart while the
    // first turn is still spawning. The latch must still admit exactly
    // one primary.
    const N = 4;
    const pm = makeFakePm({ spawnGapMs: 12 });
    const autosteer = makeAutosteer(pm);
    const intentLock = createAsyncLock();
    const sessionKey = 'chat:200';

    const pending = [];
    for (let i = 0; i < N; i += 1) {
      pending.push(runHandler({
        pm,
        autosteer,
        sessionKey,
        acquireIntent: (k) => intentLock.acquire(k),
        msgId: i + 1,
      }));
      await tick(3);   // stagger arrivals inside the spawn gap
    }
    const results = await Promise.all(pending);

    assert.equal(results.filter((r) => r === 'primary').length, 1,
      'a staggered burst during the spawn gap still yields exactly one primary');
    assert.equal(results.filter((r) => r === 'autosteer').length, N - 1,
      'every message that arrived during the in-flight turn autosteers');
  });
});

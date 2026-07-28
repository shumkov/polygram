/**
 * Tests for lib/queue-utils.js
 * Run: node --test tests/queue-utils.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { drainQueuesForChat, countInFlight, buildBusySnapshot } = require('../lib/queue-utils');

describe('drainQueuesForChat', () => {
  test('drops items under the top-level chat key', () => {
    const q = { '-100': [{ m: 1 }, { m: 2 }], '-200': [{ m: 3 }] };
    const dropped = drainQueuesForChat(q, '-100');
    assert.equal(dropped, 2);
    assert.deepEqual(q['-100'], []);
    assert.deepEqual(q['-200'], [{ m: 3 }]); // other chat untouched
  });

  test('drops items under thread-scoped keys (chatId:threadId)', () => {
    const q = {
      '-100': [{ m: 1 }],
      '-100:5': [{ m: 2 }],
      '-100:9': [{ m: 3 }, { m: 4 }],
      '-200:5': [{ m: 5 }],
    };
    const dropped = drainQueuesForChat(q, '-100');
    assert.equal(dropped, 4);
    assert.deepEqual(q['-100'], []);
    assert.deepEqual(q['-100:5'], []);
    assert.deepEqual(q['-100:9'], []);
    assert.deepEqual(q['-200:5'], [{ m: 5 }]);
  });

  test('does NOT match a prefix-only chatId (security: -10 must not match -100)', () => {
    const q = { '-10': [{ m: 1 }], '-100': [{ m: 2 }], '-100:5': [{ m: 3 }] };
    const dropped = drainQueuesForChat(q, '-10');
    assert.equal(dropped, 1);
    assert.deepEqual(q['-10'], []);
    assert.deepEqual(q['-100'], [{ m: 2 }]); // must not be cleared
    assert.deepEqual(q['-100:5'], [{ m: 3 }]);
  });

  test('returns 0 and mutates nothing when chat has no queued items', () => {
    const q = { '-200': [{ m: 1 }] };
    const dropped = drainQueuesForChat(q, '-100');
    assert.equal(dropped, 0);
    assert.deepEqual(q['-200'], [{ m: 1 }]);
  });

  test('empty array keys contribute 0 but still get reset cleanly', () => {
    const q = { '-100': [], '-100:5': [] };
    const dropped = drainQueuesForChat(q, '-100');
    assert.equal(dropped, 0);
    assert.deepEqual(q['-100'], []);
    assert.deepEqual(q['-100:5'], []);
  });

  test('accepts numeric chatId by coercing to string', () => {
    const q = { '-100': [{ m: 1 }], '-100:5': [{ m: 2 }] };
    const dropped = drainQueuesForChat(q, -100);
    assert.equal(dropped, 2);
    assert.deepEqual(q['-100'], []);
  });
});

describe('countInFlight', () => {
  test('sums handler counts across sessions', () => {
    const m = new Map([['-100', 2], ['-100:5', 1], ['451328391', 3]]);
    assert.equal(countInFlight(m), 6);
  });

  test('an idle daemon counts zero, not NaN', () => {
    assert.equal(countInFlight(new Map()), 0);
  });

  // The shutdown path samples this before the dispatcher is wired (early SIGTERM)
  // and after it is torn down. Neither may throw — a crash here would skip the
  // whole replay-marking step and silently drop the very turns it measures.
  test('tolerates an unwired dispatcher', () => {
    assert.equal(countInFlight(null), 0);
    assert.equal(countInFlight(undefined), 0);
  });
});

describe('buildBusySnapshot', () => {
  test('reports total and per-session in-flight work', () => {
    const snap = buildBusySnapshot({
      inFlightHandlers: new Map([['-100:5', 2], ['451328391', 1]]),
      botName: 'shumabit',
    });
    assert.equal(snap.bot, 'shumabit');
    assert.equal(snap.in_flight, 3);
    assert.deepEqual(
      [...snap.sessions].sort((a, b) => a.session_key.localeCompare(b.session_key)),
      [{ session_key: '-100:5', in_flight: 2 }, { session_key: '451328391', in_flight: 1 }],
    );
  });

  // A deploy pre-flight reads this to decide whether restarting is safe. Sessions
  // that have gone idle must not linger as phantom "busy" entries, or every
  // deploy looks unsafe and the operator learns to ignore the check.
  test('omits sessions whose work has finished', () => {
    const snap = buildBusySnapshot({
      inFlightHandlers: new Map([['-100', 0], ['-200', 1]]),
      botName: 'umi-assistant',
    });
    assert.equal(snap.in_flight, 1);
    assert.deepEqual(snap.sessions, [{ session_key: '-200', in_flight: 1 }]);
  });

  test('an idle bot reports zero and an empty session list', () => {
    const snap = buildBusySnapshot({ inFlightHandlers: new Map(), botName: 'shumabit' });
    assert.equal(snap.in_flight, 0);
    assert.deepEqual(snap.sessions, []);
  });
});

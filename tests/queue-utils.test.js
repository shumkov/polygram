/**
 * Tests for lib/queue-utils.js
 * Run: node --test tests/queue-utils.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { drainQueuesForChat } = require('../lib/queue-utils');

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

/**
 * Tests for lib/session-key.js
 * Run: node --test tests/session-key.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { getSessionKey, getChatIdFromKey } = require('../lib/session-key');

describe('getSessionKey', () => {
  test('no threadId, no chatConfig → just chatId', () => {
    assert.equal(getSessionKey('-100123', null), '-100123');
    assert.equal(getSessionKey('-100123', undefined), '-100123');
    assert.equal(getSessionKey('-100123', null, undefined), '-100123');
  });

  test('thread present + default (shared) → just chatId', () => {
    assert.equal(getSessionKey('-100123', '5379', {}), '-100123');
    assert.equal(
      getSessionKey('-100123', '5379', { isolateTopics: false }),
      '-100123',
    );
  });

  test('thread present + isolateTopics:true → chatId:thread', () => {
    assert.equal(
      getSessionKey('-100123', '5379', { isolateTopics: true }),
      '-100123:5379',
    );
    assert.equal(
      getSessionKey('-100123', '2', { isolateTopics: true }),
      '-100123:2',
    );
  });

  test('no thread → chatId regardless of isolateTopics', () => {
    assert.equal(getSessionKey('-100123', null, { isolateTopics: false }), '-100123');
    assert.equal(getSessionKey('-100123', null, { isolateTopics: true }), '-100123');
  });

  test('thread "0" / empty is treated as no thread (Telegram main chat)', () => {
    assert.equal(getSessionKey('-100123', '', { isolateTopics: true }), '-100123');
    assert.equal(getSessionKey('-100123', 0, { isolateTopics: true }), '-100123');
  });
});

describe('getChatIdFromKey', () => {
  test('extracts chat from chatId only', () => {
    assert.equal(getChatIdFromKey('-100123'), '-100123');
  });

  test('extracts chat from chatId:thread', () => {
    assert.equal(getChatIdFromKey('-100123:5379'), '-100123');
  });

  test('handles DM chat (positive id)', () => {
    assert.equal(getChatIdFromKey('111111111'), '111111111');
  });
});

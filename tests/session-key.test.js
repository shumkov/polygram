/**
 * Tests for lib/session-key.js
 * Run: node --test tests/session-key.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { getSessionKey, getChatIdFromKey, getThreadIdFromKey, getTopicConfig, getTopicName } = require('../lib/session-key');

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

describe('getTopicConfig (rc.48 per-topic overrides)', () => {
  // rc.48: topics[threadId] can be either a string (legacy: just a label)
  // or an object with optional fields { name, agent, cwd, model, effort,
  // permissionMode }. getTopicConfig returns the override fields
  // (excluding `name` — that's handled by getTopicName) so callers can
  // merge them on top of chat-level config when spawning the SDK Query.

  test('no threadId → empty', () => {
    assert.deepEqual(getTopicConfig({}, null), {});
    assert.deepEqual(getTopicConfig({}, undefined), {});
    assert.deepEqual(getTopicConfig({}, ''), {});
  });

  test('no chatConfig.topics → empty', () => {
    assert.deepEqual(getTopicConfig({}, '100'), {});
    assert.deepEqual(getTopicConfig({ topics: undefined }, '100'), {});
  });

  test('threadId not in topics → empty', () => {
    assert.deepEqual(getTopicConfig({ topics: { '200': 'X' } }, '100'), {});
  });

  test('legacy string topic entry → empty (no overrides)', () => {
    // Existing config schema: topics: { "100": "Orders" } — string
    // labels only. No overrides; getTopicConfig returns {}.
    assert.deepEqual(getTopicConfig({ topics: { '100': 'Orders' } }, '100'), {});
  });

  test('object with overrides returns overrides without `name`', () => {
    const cfg = {
      topics: {
        '200': {
          name: 'Music',
          agent: 'music-curation',
          cwd: '/Users/ivan/Music-Projects',
          permissionMode: 'default',
        },
      },
    };
    assert.deepEqual(getTopicConfig(cfg, '200'), {
      agent: 'music-curation',
      cwd: '/Users/ivan/Music-Projects',
      permissionMode: 'default',
    });
  });

  test('object with name only → empty (name is not an override)', () => {
    assert.deepEqual(
      getTopicConfig({ topics: { '300': { name: 'Planning' } } }, '300'),
      {},
    );
  });

  test('object with all override fields returns all', () => {
    const cfg = {
      topics: {
        '400': {
          name: 'Heavy work',
          agent: 'engineer',
          cwd: '/Users/x/repo',
          model: 'opus',
          effort: 'high',
          permissionMode: 'default',
        },
      },
    };
    assert.deepEqual(getTopicConfig(cfg, '400'), {
      agent: 'engineer',
      cwd: '/Users/x/repo',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
  });

  test('numeric threadId works (Telegram thread_ids are typically integers)', () => {
    const cfg = { topics: { '100': { agent: 'foo' } } };
    assert.deepEqual(getTopicConfig(cfg, 100), { agent: 'foo' });
    assert.deepEqual(getTopicConfig(cfg, '100'), { agent: 'foo' });
  });
});

describe('getTopicName (rc.48 — handles both string and object entries)', () => {
  // Backward-compat: existing string entries still return the label.
  // New: object entries return the .name field, falling back to threadId
  // if name is absent.

  test('legacy string entry → returns the string', () => {
    assert.equal(getTopicName({ topics: { '100': 'Orders' } }, '100'), 'Orders');
  });

  test('object with name → returns name', () => {
    const cfg = { topics: { '200': { name: 'Music', agent: 'music-curation' } } };
    assert.equal(getTopicName(cfg, '200'), 'Music');
  });

  test('object without name → falls back to threadId', () => {
    const cfg = { topics: { '300': { agent: 'foo' } } };
    assert.equal(getTopicName(cfg, '300'), '300');
  });

  test('threadId not in topics → returns threadId', () => {
    assert.equal(getTopicName({ topics: { '100': 'X' } }, '999'), '999');
  });

  test('no threadId → null', () => {
    assert.equal(getTopicName({ topics: { '100': 'X' } }, null), null);
    assert.equal(getTopicName({}, undefined), null);
  });
});

describe('getThreadIdFromKey (rc.47)', () => {
  // Inverse of getChatIdFromKey: returns thread_id when sessionKey
  // includes one (isolateTopics=true), else null. Used by rc.47
  // autonomous-wakeup routing — when ScheduleWakeup fires, the
  // generated assistant message has no head pending; polygram needs
  // to derive chat_id + thread_id from the sessionKey to route the
  // text to the right Telegram chat/topic.

  test('returns null for non-isolated key (just chatId)', () => {
    assert.equal(getThreadIdFromKey('-100123'), null);
    assert.equal(getThreadIdFromKey('111111111'), null);
  });

  test('returns thread_id for isolated key (chatId:thread)', () => {
    assert.equal(getThreadIdFromKey('-100123:5379'), '5379');
    assert.equal(getThreadIdFromKey('-100123:2'), '2');
  });

  test('handles edge cases gracefully', () => {
    assert.equal(getThreadIdFromKey(''), null);
    assert.equal(getThreadIdFromKey(null), null);
    assert.equal(getThreadIdFromKey(undefined), null);
  });
});

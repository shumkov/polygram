'use strict';

/**
 * Tests for lib/telegram/album-reactions.js — mirroring the status reaction
 * onto every message of an album (rc.16). Fixes the "steer reaction only on
 * the first file" observation: an album is one turn anchored on the first
 * message, so the reactor only reacted to that one; this mirrors it to siblings.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyReactionToMessages } = require('../lib/telegram/album-reactions');

function recorder() {
  const calls = [];
  const tg = async (bot, method, params, meta) => { calls.push({ method, params, meta }); return { ok: true }; };
  return { calls, tg };
}

test('applies the SAME reaction to the anchor and every sibling', async () => {
  const { calls, tg } = recorder();
  await applyReactionToMessages({ tg, bot: {}, chatId: '999', msgIds: [1300, 1301, 1302], emoji: '✍', botName: 'b' });

  assert.equal(calls.length, 3, 'one setMessageReaction per album message');
  for (const c of calls) {
    assert.equal(c.method, 'setMessageReaction');
    assert.equal(c.params.chat_id, '999');
    assert.deepEqual(c.params.reaction, [{ type: 'emoji', emoji: '✍' }]);
  }
  assert.deepEqual(calls.map((c) => c.params.message_id), [1300, 1301, 1302]);
  assert.equal(calls[0].meta.source, 'status-reaction', 'anchor uses the normal source');
  assert.equal(calls[1].meta.source, 'status-reaction-album-sibling', 'siblings flagged distinctly');
});

test('empty/null emoji clears the reaction on all messages', async () => {
  const { calls, tg } = recorder();
  await applyReactionToMessages({ tg, bot: {}, chatId: '1', msgIds: [10, 11], emoji: null });
  assert.equal(calls.length, 2);
  for (const c of calls) assert.deepEqual(c.params.reaction, [], 'null emoji → clear ([])');
});

test('single message (no siblings) behaves like a normal reaction', async () => {
  const { calls, tg } = recorder();
  await applyReactionToMessages({ tg, bot: {}, chatId: '1', msgIds: [42], emoji: '🤔' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.message_id, 42);
  assert.equal(calls[0].meta.source, 'status-reaction');
});

test('a sibling failure does NOT throw or drop the others', async () => {
  const calls = [];
  const tg = async (bot, method, params) => {
    calls.push(params.message_id);
    if (params.message_id === 1301) throw new Error('reaction failed on sibling');
    return { ok: true };
  };
  // Must resolve (not reject) and still attempt 1302 after 1301 failed.
  await applyReactionToMessages({ tg, bot: {}, chatId: '1', msgIds: [1300, 1301, 1302], emoji: '👍' });
  assert.deepEqual(calls, [1300, 1301, 1302], 'all attempted; sibling failure swallowed');
});

test('an ANCHOR failure propagates (surfaces to the reactor)', async () => {
  const tg = async () => { throw new Error('anchor reaction failed'); };
  await assert.rejects(
    () => applyReactionToMessages({ tg, bot: {}, chatId: '1', msgIds: [1300, 1301], emoji: '👍' }),
    /anchor reaction failed/,
    'anchor failure must propagate so the reactor logs it (same as single-message path)',
  );
});

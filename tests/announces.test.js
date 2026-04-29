const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { announce, shouldAnnounce, SUBAGENT_DEBOUNCE_MS } = require('../lib/announces');

function silentLogger() { return { log: () => {}, error: () => {}, warn: () => {} }; }

describe('shouldAnnounce debounce', () => {
  test('first call returns true', () => {
    assert.equal(shouldAnnounce('chat-A', 1000), true);
  });

  test('subsequent call within debounce window returns false', () => {
    shouldAnnounce('chat-B', 10_000);
    assert.equal(shouldAnnounce('chat-B', 10_000 + 1000), false);
  });

  test('call after debounce window returns true', () => {
    shouldAnnounce('chat-C', 100_000);
    assert.equal(
      shouldAnnounce('chat-C', 100_000 + SUBAGENT_DEBOUNCE_MS + 1),
      true,
    );
  });

  test('different chats are independent', () => {
    shouldAnnounce('chat-D', 50_000);
    assert.equal(shouldAnnounce('chat-E', 50_000), true);
  });
});

describe('announce', () => {
  test('sends a plain-text sendMessage with announce source', async () => {
    const calls = [];
    const send = async (bot, method, params, meta) => {
      calls.push({ method, params, meta });
      return { message_id: 42 };
    };
    const res = await announce({
      send, bot: {}, chatId: '1', text: 'spawning subagent',
      logger: silentLogger(),
    });
    assert.equal(res.message_id, 42);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendMessage');
    assert.equal(calls[0].params.text, 'spawning subagent');
    assert.equal(calls[0].meta.source, 'announce');
    assert.equal(calls[0].meta.plainText, true);
    assert.equal(calls[0].meta.linkPreview, false);
  });

  test('threadId propagates to params', async () => {
    const calls = [];
    const send = async (bot, method, params) => { calls.push(params); return { message_id: 1 }; };
    await announce({
      send, bot: {}, chatId: '-100', threadId: 7, text: 'hi',
      logger: silentLogger(),
    });
    assert.equal(calls[0].message_thread_id, 7);
  });

  test('empty text returns null without calling send', async () => {
    let count = 0;
    const send = async () => { count += 1; return {}; };
    const r = await announce({ send, bot: {}, chatId: '1', text: '', logger: silentLogger() });
    assert.equal(r, null);
    assert.equal(count, 0);
  });

  test('caller meta.source overrides default', async () => {
    const calls = [];
    const send = async (bot, method, params, meta) => { calls.push(meta); return { message_id: 1 }; };
    await announce({
      send, bot: {}, chatId: '1', text: 'hi', meta: { source: 'custom-announce' },
      logger: silentLogger(),
    });
    assert.equal(calls[0].source, 'custom-announce');
  });

  test('send failure is non-fatal — returns null', async () => {
    const send = async () => { throw new Error('telegram down'); };
    const r = await announce({
      send, bot: {}, chatId: '1', text: 'hi', logger: silentLogger(),
    });
    assert.equal(r, null);
  });
});

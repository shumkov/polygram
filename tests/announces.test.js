const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  announce,
  shouldAnnounce,
  createAnnouncer,
  SUBAGENT_DEBOUNCE_MS,
  _resetDefaultAnnouncerForTests,
} = require('../lib/announces');

function silentLogger() { return { log: () => {}, error: () => {}, warn: () => {} }; }

describe('shouldAnnounce debounce', () => {
  beforeEach(() => { _resetDefaultAnnouncerForTests(); });

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

// 0.7.1: factory + split read/write
describe('createAnnouncer (0.7.1)', () => {
  test('canAnnounce is pure (no mutation), markAnnounced records', () => {
    let now = 1000;
    const a = createAnnouncer({ clock: () => now });
    assert.equal(a.canAnnounce('1'), true);
    // Calling canAnnounce repeatedly without marking does NOT debounce.
    assert.equal(a.canAnnounce('1'), true);
    assert.equal(a.canAnnounce('1'), true);
    a.markAnnounced('1');
    assert.equal(a.canAnnounce('1'), false);
  });

  test('isolation: separate announcers do not share state', () => {
    const a = createAnnouncer({ clock: () => 1000 });
    const b = createAnnouncer({ clock: () => 1000 });
    a.markAnnounced('1');
    assert.equal(a.canAnnounce('1'), false);
    assert.equal(b.canAnnounce('1'), true);
  });

  test('debounce window expiry', () => {
    let now = 100_000;
    const a = createAnnouncer({ debounceMs: 5000, clock: () => now });
    a.markAnnounced('1');
    assert.equal(a.canAnnounce('1'), false);
    now += 4999;
    assert.equal(a.canAnnounce('1'), false);
    now += 2;
    assert.equal(a.canAnnounce('1'), true);
  });

  test('sweep prunes stale entries', () => {
    let now = 1000;
    const a = createAnnouncer({ debounceMs: 1000, clock: () => now, sweepThreshold: 5 });
    for (let i = 0; i < 10; i++) {
      a.markAnnounced('chat-' + i);
    }
    assert.equal(a.size, 10);
    // Advance well past 2× debounce window.
    now += 5000;
    a.sweep();
    assert.equal(a.size, 0, 'all entries should be swept');
  });

  test('lazy sweep fires when size exceeds threshold', () => {
    let now = 1000;
    const a = createAnnouncer({ debounceMs: 1000, clock: () => now, sweepThreshold: 3 });
    for (let i = 0; i < 5; i++) a.markAnnounced('c' + i);
    now += 5000;
    // canAnnounce check past threshold triggers sweep.
    a.canAnnounce('new-chat');
    assert.equal(a.size, 0);
  });

  test('clear() empties the announcer', () => {
    const a = createAnnouncer({ clock: () => 1000 });
    a.markAnnounced('1');
    a.markAnnounced('2');
    assert.equal(a.size, 2);
    a.clear();
    assert.equal(a.size, 0);
    assert.equal(a.canAnnounce('1'), true);
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

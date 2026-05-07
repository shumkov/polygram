/**
 * Tests for lib/handlers/ipc-send.js — the cross-bot guard,
 * method allowlist, and inline_message_id rejection.
 *
 * Run: node --test tests/handlers-ipc-send.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createHandleSendOverIpc,
  IPC_SEND_ALLOWED_METHODS,
} = require('../lib/handlers/ipc-send');

function fixture({ chats = { '111': { name: 'mine' } } } = {}) {
  const calls = [];
  const tg = async (_bot, method, params) => {
    calls.push({ method, params });
    return { ok: true, method, params };
  };
  const handler = createHandleSendOverIpc({
    config: { chats },
    bot: { _placeholder: true },
    tg,
    botName: 'testbot',
  });
  return { handler, calls };
}

describe('createHandleSendOverIpc — method allowlist', () => {
  test('rejects unknown method', async () => {
    const { handler } = fixture();
    await assert.rejects(
      () => handler({ method: 'deleteMessage', params: { chat_id: '111' } }),
      /method not allowed: deleteMessage/,
    );
  });

  test('rejects missing method', async () => {
    const { handler } = fixture();
    await assert.rejects(
      () => handler({ params: { chat_id: '111' } }),
      /method required/,
    );
  });

  test('every allowed method passes the allowlist gate', () => {
    const expected = [
      'sendMessage', 'sendPhoto', 'sendDocument', 'sendSticker',
      'sendChatAction', 'editMessageText', 'setMessageReaction',
    ];
    for (const m of expected) {
      assert.ok(IPC_SEND_ALLOWED_METHODS.has(m), `${m} should be allowed`);
    }
  });
});

describe('createHandleSendOverIpc — chat_id ownership', () => {
  test('rejects chat_id not in this bot config', async () => {
    const { handler } = fixture({ chats: { '111': {} } });
    await assert.rejects(
      () => handler({ method: 'sendMessage', params: { chat_id: '222', text: 'hi' } }),
      /chat not owned by testbot: 222/,
    );
  });

  test('accepts chat_id owned by this bot', async () => {
    const { handler, calls } = fixture({ chats: { '111': {} } });
    const res = await handler({
      method: 'sendMessage',
      params: { chat_id: '111', text: 'hi' },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendMessage');
    assert.deepEqual(res, { result: { ok: true, method: 'sendMessage', params: { chat_id: '111', text: 'hi' } } });
  });

  test('numeric chat_id stringified before lookup', async () => {
    const { handler, calls } = fixture({ chats: { '111': {} } });
    await handler({
      method: 'sendMessage',
      params: { chat_id: 111, text: 'hi' },
    });
    assert.equal(calls.length, 1);
  });
});

describe('createHandleSendOverIpc — inline_message_id bypass guard', () => {
  test('rejects inline_message_id on editMessageText (cross-bot bypass)', async () => {
    // Without the guard, a cron/IPC caller could supply
    // {inline_message_id: 'AAAA'} with NO chat_id and bypass the
    // ownership check entirely — Telegram would resolve the
    // inline-mode message globally.
    const { handler } = fixture();
    await assert.rejects(
      () => handler({
        method: 'editMessageText',
        params: { inline_message_id: 'inline-AAAA', text: 'pwned' },
      }),
      /inline_message_id editing not supported/,
    );
  });

  test('rejects inline_message_id even when paired with chat_id', async () => {
    // Defence-in-depth: don't accept either-or addressing modes
    // on the same call. Polygram never emits inline-mode buttons.
    const { handler } = fixture();
    await assert.rejects(
      () => handler({
        method: 'editMessageText',
        params: { chat_id: '111', message_id: 5, inline_message_id: 'X', text: 'pwned' },
      }),
      /inline_message_id editing not supported/,
    );
  });

  test('editMessageText without chat_id and without inline_message_id is rejected', async () => {
    const { handler } = fixture();
    await assert.rejects(
      () => handler({
        method: 'editMessageText',
        params: { message_id: 5, text: 'pwned' },
      }),
      /editMessageText requires chat_id/,
    );
  });

  test('editMessageText with chat_id (owned) succeeds', async () => {
    const { handler, calls } = fixture({ chats: { '111': {} } });
    await handler({
      method: 'editMessageText',
      params: { chat_id: '111', message_id: 5, text: 'updated' },
    });
    assert.equal(calls[0].method, 'editMessageText');
  });

  test('inline_message_id rejected even on non-edit method (defence-in-depth)', async () => {
    // There's no real method where this matters today, but the
    // guard rejects the field broadly so future allowed-method
    // additions don't accidentally re-open the hole.
    const { handler } = fixture({ chats: { '111': {} } });
    await assert.rejects(
      () => handler({
        method: 'sendMessage',
        params: { chat_id: '111', inline_message_id: 'X', text: 'hi' },
      }),
      /inline_message_id editing not supported/,
    );
  });
});

describe('createHandleSendOverIpc — bot readiness', () => {
  test('throws when bot not provided', async () => {
    const handler = createHandleSendOverIpc({
      config: { chats: { '111': {} } },
      bot: null,
      tg: async () => ({}),
      botName: 'testbot',
    });
    await assert.rejects(
      () => handler({ method: 'sendMessage', params: { chat_id: '111', text: 'hi' } }),
      /bot process not ready/,
    );
  });
});

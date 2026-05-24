'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');

const fakeBot = {};
const fakeChunk = (text, _max) => [text];      // pass-through chunker
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeRecordingSend() {
  const sent = [];
  const send = async (_bot, method, params, _meta) => {
    sent.push({ method, params });
    return { ok: true, result: { message_id: sent.length } };
  };
  return { send, sent };
}

test('construction validates required deps', () => {
  assert.throws(() => createChannelsToolDispatcher({}), /bot/);
  assert.throws(() => createChannelsToolDispatcher({ bot: fakeBot }), /send/);
  assert.throws(
    () => createChannelsToolDispatcher({ bot: fakeBot, send: () => {} }),
    /chunkText/,
  );
});

test('dispatches reply text via deliverReplies', async () => {
  const { send, sent } = makeRecordingSend();
  // Fake deliverReplies inline so we don't pull in the real chunking/delivery code.
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: fakeChunk,
    deliverReplies: async ({ chunks, chatId, threadId }) => {
      return { sent: chunks.map((_, i) => ({ message_id: i + 1 })), failed: [], results: [] };
    },
    logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'hello world', files: null,
  });

  assert.equal(result.ok, true);
});

test('returns error when toolName is not reply', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({}),
    chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    logger: quietLogger,
  });

  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'react', text: 'hello', files: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported tool/);
});

test('returns error on missing text', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({}),
    chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: '', files: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /text missing/);
});

test('returns error on missing chat_id', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({}),
    chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: null, threadId: null,
    toolName: 'reply', text: 'hi', files: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /chat_id missing/);
});

test('partial delivery surfaces failure count', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({}),
    chunkText: (text) => [text.slice(0, 5), text.slice(5)],
    deliverReplies: async ({ chunks }) => ({
      sent: [{ message_id: 1 }],
      failed: [{ chunk: chunks[1], error: new Error('429 rate limit') }],
      results: [],
    }),
    logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'helloworld', files: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /1 of 2 chunks/);
  assert.match(result.error, /429 rate limit/);
});

test('sends file attachments via sendPhoto for images', async () => {
  const { send, sent } = makeRecordingSend();
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [{ message_id: 1 }], failed: [], results: [] }),
    logger: quietLogger,
  });
  await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'see attached', files: ['/tmp/foo.png', '/tmp/bar.txt'],
  });
  // 2 file attachments
  const attachCalls = sent.filter(c => c.method === 'sendPhoto' || c.method === 'sendDocument');
  assert.equal(attachCalls.length, 2);
  assert.equal(attachCalls[0].method, 'sendPhoto', '.png → sendPhoto');
  assert.equal(attachCalls[1].method, 'sendDocument', '.txt → sendDocument');
});

test('file attach failure does not poison overall result', async () => {
  let attachAttempts = 0;
  const send = async (_b, method) => {
    if (method === 'sendPhoto') {
      attachAttempts++;
      throw new Error('TG photo upload failed');
    }
    return {};
  };
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot, send, chunkText: fakeChunk,
    deliverReplies: async () => ({ sent: [{ message_id: 1 }], failed: [], results: [] }),
    logger: quietLogger,
  });
  const result = await dispatcher({
    sessionKey: 'sess-1', chatId: '12345', threadId: null,
    toolName: 'reply', text: 'see attached', files: ['/tmp/foo.png'],
  });
  assert.equal(attachAttempts, 1);
  // Text delivery succeeded — overall ok even though file attach failed (logged + continued)
  assert.equal(result.ok, true);
});

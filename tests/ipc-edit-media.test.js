/**
 * IPC editMessageMedia and editMessageCaption.
 *
 * agent-org replaces the picture of its own approval card when the phone's
 * preview comes after the card. That needs two edit methods over IPC. They
 * are allowed only for a message this bot sent through the same IPC sender,
 * in a chat it owns, and the new media passes the same rules as a send: a
 * caller can never edit an agent's reply, a user's message, or another
 * sender's message, and a file goes through the same validation, coercion
 * and size cap as sendPhoto.
 *
 * Run: node --test tests/ipc-edit-media.test.js
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InputFile } = require('grammy');
const { createHandleSendOverIpc, IPC_SEND_ALLOWED_METHODS } = require('../lib/handlers/ipc-send');
const { coerceFileParams } = require('../lib/telegram/input-file');
const { send } = require('../lib/telegram/api');

const OWN = { direction: 'out', bot_name: 'testbot', source: 'agent-org' };
function fixture({ rows = { 501: OWN } } = {}) {
  const calls = [];
  const tg = async (_bot, method, params) => { calls.push({ method, params }); return { ok: true }; };
  const handler = createHandleSendOverIpc({
    config: { chats: { '111': {} } },
    bot: {},
    tg,
    botName: 'testbot',
    getMessage: (chatId, msgId) => (chatId === '111' ? rows[msgId] ?? null : null),
  });
  return { handler, calls };
}
const media = (extra = {}) => ({ type: 'photo', media: { source: '/tmp/preview.png' }, caption: 'Phone preview', ...extra });

describe('editMessageMedia and editMessageCaption over IPC', () => {
  test('both are allowed methods', () => {
    assert.ok(IPC_SEND_ALLOWED_METHODS.has('editMessageMedia'));
    assert.ok(IPC_SEND_ALLOWED_METHODS.has('editMessageCaption'));
  });

  test('a message this IPC sender sent may have its media and caption edited', async () => {
    const { handler, calls } = fixture();
    await handler({ method: 'editMessageMedia', source: 'agent-org', params: { chat_id: '111', message_id: 501, media: media(), reply_markup: { inline_keyboard: [] } } });
    await handler({ method: 'editMessageCaption', source: 'agent-org', params: { chat_id: '111', message_id: 501, caption: 'new' } });
    assert.deepEqual(calls.map((c) => c.method), ['editMessageMedia', 'editMessageCaption']);
  });

  test('any other message is refused: another sender\'s, an agent reply, an inbound message, another bot\'s, or one not on file', async () => {
    const rows = {
      501: OWN,
      502: { ...OWN, source: 'cron' },
      503: { ...OWN, source: 'bot-reply' },
      504: { ...OWN, direction: 'in' },
      505: { ...OWN, bot_name: 'otherbot' },
    };
    const { handler, calls } = fixture({ rows });
    for (const id of [502, 503, 504, 505, 506]) {
      for (const method of ['editMessageMedia', 'editMessageCaption']) {
        await assert.rejects(
          () => handler({ method, source: 'agent-org', params: { chat_id: '111', message_id: id, ...(method === 'editMessageMedia' ? { media: media() } : { caption: 'x' }) } }),
          /was not sent by this IPC sender/,
          `${method} ${id}`,
        );
      }
    }
    assert.equal(calls.length, 0);
  });

  test('the ownership and addressing rules of the other edits hold', async () => {
    const { handler } = fixture();
    await assert.rejects(() => handler({ method: 'editMessageMedia', source: 'agent-org', params: { chat_id: '222', message_id: 501, media: media() } }), /chat not owned by testbot: 222/);
    await assert.rejects(() => handler({ method: 'editMessageMedia', source: 'agent-org', params: { inline_message_id: 'x', media: media() } }), /inline_message_id/);
    await assert.rejects(() => handler({ method: 'editMessageMedia', source: 'agent-org', params: { message_id: 501, media: media() } }), /requires chat_id/);
    await assert.rejects(() => handler({ method: 'editMessageMedia', source: 'agent-org', params: { chat_id: '111', media: media() } }), /requires message_id/);
  });

  test('the new media passes the same rules as a send', async () => {
    const { handler, calls } = fixture();
    const bad = [
      [undefined, /needs media/],
      [{ type: 'sticker', media: 'abc' }, /media\.type/],
      [{ type: 'photo' }, /media\.media/],
      [{ type: 'photo', media: '/abs/preview.png' }, /bare file path not accepted/],
      [{ type: 'photo', media: 'http://localhost:8080/x.png' }, /localhost URLs/],
      [{ type: 'document', media: 'http://example.com/x.pdf' }, /only HTTPS URLs/],
    ];
    for (const [m, re] of bad) {
      await assert.rejects(() => handler({ method: 'editMessageMedia', source: 'agent-org', params: { chat_id: '111', message_id: 501, media: m } }), re, JSON.stringify(m));
    }
    assert.equal(calls.length, 0);
  });
});

describe('the media of an edit is uploaded and capped like a send', () => {
  test('a { source } inside media becomes an InputFile', () => {
    const params = { chat_id: 1, message_id: 2, media: { type: 'photo', media: { source: '/tmp/preview.png' }, caption: 'x' } };
    coerceFileParams('editMessageMedia', params);
    assert.ok(params.media.media instanceof InputFile);
    assert.equal(params.media.caption, 'x');
  });

  test('a local file over the send limit is refused before the call', async () => {
    const file = path.join(os.tmpdir(), `polygram-edit-media-cap-${process.pid}.bin`);
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 0x61));
    try {
      const calls = [];
      const bot = { api: { raw: new Proxy({}, { get: (_, method) => (params) => { calls.push({ method, params }); return Promise.resolve(true); } }) } };
      const config = { bot: { apiRoot: 'http://127.0.0.1:8081' }, chats: { '111': { maxFileBytes: 1024 * 1024 } } };
      await assert.rejects(
        () => send({ bot, method: 'editMessageMedia', params: { chat_id: '111', message_id: 2, media: { type: 'photo', media: { source: file } } }, config, logger: { log() {}, error() {} } }),
        /exceeds the 1\.0MB send limit/,
      );
      assert.equal(calls.length, 0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

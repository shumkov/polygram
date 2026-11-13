'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandleSendOverIpc } = require('../lib/handlers/ipc-send');
const { createRichSender } = require('../lib/telegram/rich-send');
const { isRichCapabilityError, isRichCapabilityErrorExplicit, isRichContentError } = require('../lib/telegram/rich');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');

const blocks = [{ type: 'blockquote', blocks: [{ type: 'paragraph', text: ['📌 ', { type: 'bold', text: 'New task' }, ' · prices'] },
  { type: 'paragraph', text: [{ type: 'url', text: 'New prices', url: 'https://notion.so/task42' }] }] }];
const request = (fallback = { text: '<b>New prices</b>', parse_mode: 'HTML' }) => ({ method: 'sendRichMessage',
  params: { chat_id: '111', message_thread_id: 142, rich_message: { blocks } }, ...(fallback === undefined ? {} : { fallback }) });

function fixture(t, send) {
  const { db, dbPath } = freshDb('ipc-rich-card');
  t.after(() => cleanupDb(dbPath, db));
  const calls = []; let unsupported = false;
  const tg = async (_bot, method, params, meta) => {
    calls.push({ method, params, meta });
    if (send) await send(method, calls.length);
    return { message_id: calls.length, message_thread_id: params.message_thread_id };
  };
  const sendRich = createRichSender({ tg, botName: 'test', isRichCapabilityError, isRichCapabilityErrorExplicit, isRichContentError,
    getRichKnownUnsupported: () => unsupported, setRichKnownUnsupported: () => { unsupported = true; }, insertSentRow: (row) => db.insertMessage(row) });
  return { calls, db, sendRich, handler: createHandleSendOverIpc({ config: { chats: { 111: {} } }, bot: {}, tg, botName: 'test', sendRich }) };
}

test('IPC refuses the rich task card that agent-org needs to send', async (t) => {
  const f = fixture(t);
  const req = request(); delete req.fallback;
  assert.deepEqual(await f.handler(req), { result: { message_id: 1, message_thread_id: 142 }, rich: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'sendRichMessage');
  assert.equal(f.calls[0].meta.strictDestination, true);
  const rows = f.db.raw.prepare('SELECT text, source FROM messages').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /New task.*prices/);
  assert.match(rows[0].text, /https:\/\/notion.so\/task42/);
  assert.equal(rows[0].source, 'ipc');
});

test('unsupported rich latches once and both fallbacks keep the exact topic', async (t) => {
  const f = fixture(t, (method) => { if (method === 'sendRichMessage') throw { error_code: 400, description: 'Bad Request: method sendRichMessage not found' }; });
  for (let i = 0; i < 2; i++) assert.equal((await f.handler(request())).rich, false);
  assert.deepEqual(f.calls.map((c) => c.method), ['sendRichMessage', 'sendMessage', 'sendMessage']);
  for (const c of f.calls) {
    assert.equal(c.params.chat_id, '111'); assert.equal(c.params.message_thread_id, 142);
    assert.equal(c.meta.strictDestination, true);
  }
  assert.equal(f.calls[1].params.parse_mode, 'HTML');
  assert.equal(f.calls[1].meta.linkPreview, false);
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM messages').get().n, 0, 'a rejected rich send records no transcript row');
});

test('content rejection falls back once without latching the next card off', async (t) => {
  const f = fixture(t, (_method, n) => { if (n === 1) throw { error_code: 400, description: 'Bad Request: invalid rich message block' }; });
  assert.equal((await f.handler(request())).rich, false);
  assert.equal((await f.handler(request())).rich, true);
  assert.deepEqual(f.calls.map((c) => c.method), ['sendRichMessage', 'sendMessage', 'sendRichMessage']);
});

test('a failed rich send without a fallback is an error, not an empty success', async (t) => {
  const f = fixture(t, () => { throw new Error('offline'); });
  const req = request(); delete req.fallback;
  await assert.rejects(f.handler(req), /rich.*failed/i);
  assert.equal(f.calls.length, 1);
});

test('rich ownership and malformed fallback are checked before any send', async (t) => {
  const f = fixture(t);
  const foreign = request(); foreign.params.chat_id = '222';
  await assert.rejects(f.handler(foreign), /not owned/);
  const missing = request(); delete missing.params.chat_id;
  await assert.rejects(f.handler(missing), /requires chat_id/);
  for (const fallback of [null, {}, { text: 'x', parse_mode: 'Markdown' }, { text: 'x', parse_mode: 'HTML', chat_id: '222' }]) {
    await assert.rejects(f.handler(request(fallback)), /fallback/i);
  }
  const invalid = request(); invalid.params.rich_message.blocks = [];
  await assert.rejects(f.handler(invalid), /blocks/);
  assert.equal(f.calls.length, 0);
});

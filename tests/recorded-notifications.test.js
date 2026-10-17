'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { send } = require('../lib/telegram/api');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');

test('a recorded infrastructure alert never reaches Telegram when history storage fails', async () => {
  let sends = 0;
  const db = { insertOutboundPending() { throw new Error('disk full'); } };
  await assert.rejects(send({ bot: { api: { raw: { sendMessage: async () => { sends++; return { message_id: 71 }; } } } },
    method: 'sendMessage', params: { chat_id: '-1001', message_thread_id: '2995', text: 'Disk WARNING' },
    db, logger: { error() {} }, meta: { requireRecording: true, strictDestination: true, durableDelivery: true } }), /disk full/);
  assert.equal(sends, 0);
});

test('recorded delivery binds the existing outbound alert row instead of creating a second history message', async (t) => {
  const { db, dbPath } = freshDb('notify-bound-row'); t.after(() => cleanupDb(dbPath, db));
  const rowId = Number(db.insertOutboundPending({ chat_id: '-1001', thread_id: '2995', text: 'Disk WARNING', source: 'netdata:shumabook', bot_name: 'test', pending_id: -77 }).lastInsertRowid);
  await send({ bot: { api: { raw: { sendMessage: async () => ({ message_id: 71, date: 1780000000, chat: { id: -1001 }, message_thread_id: 2995 }) } } },
    method: 'sendMessage', params: { chat_id: '-1001', message_thread_id: '2995', text: 'Disk WARNING' }, db,
    meta: { recordedRowId: rowId, botName: 'test', source: 'netdata:shumabook', requireRecording: true, strictDestination: true, durableDelivery: true } });
  const rows = db.raw.prepare('SELECT * FROM messages').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].id, rowId); assert.equal(rows[0].msg_id, 71); assert.equal(rows[0].status, 'sent');
});

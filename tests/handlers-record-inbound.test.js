'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createRecordInbound } = require('../lib/handlers/record-inbound');

describe('createRecordInbound', () => {
  let db, dbPath;

  beforeEach(() => { ({ db, dbPath } = freshDb('record-inbound')); });
  afterEach(() => cleanupDb(dbPath, db));

  function buildHandler({ extractAttachments = () => [], chatConfig = { model: 'sonnet', effort: 'high' } } = {}) {
    return createRecordInbound({
      db,
      dbWrite: (fn) => { try { fn(); } catch {} },
      config: { chats: { '100': chatConfig } },
      botName: 'testbot',
      extractAttachments,
    });
  }

  function inboundMsg(overrides = {}) {
    return {
      message_id: 1,
      chat: { id: 100 },
      date: 1700000000,
      from: { id: 42, first_name: 'Operator', username: 'op' },
      text: 'hello',
      ...overrides,
    };
  }

  test('records a plain message with no attachments', () => {
    const handler = buildHandler();
    handler(inboundMsg());

    const row = db.getInboundMessageId({ chat_id: '100', msg_id: 1 });
    assert.ok(row, 'message row inserted');
    const atts = db.getAttachmentsByMessage(row);
    assert.deepEqual(atts, []);
  });

  test('uses caption when text is missing', () => {
    const handler = buildHandler();
    handler(inboundMsg({ text: undefined, caption: 'caption text' }));
    // The text column should be the caption.
    const rows = db.raw.prepare('SELECT text FROM messages WHERE chat_id = ? AND msg_id = ?').all('100', 1);
    assert.equal(rows[0].text, 'caption text');
  });

  test('writes attachments atomically alongside the message', () => {
    const handler = buildHandler({
      extractAttachments: () => [
        { file_id: 'fid1', file_unique_id: 'u1', kind: 'photo', name: null, mime_type: 'image/jpeg', size: 1024 },
        { file_id: 'fid2', file_unique_id: 'u2', kind: 'document', name: 'doc.pdf', mime_type: 'application/pdf', size: 5000 },
      ],
    });
    handler(inboundMsg());

    const messageId = db.getInboundMessageId({ chat_id: '100', msg_id: 1 });
    const atts = db.getAttachmentsByMessage(messageId);
    assert.equal(atts.length, 2);
    assert.equal(atts[0].file_id, 'fid1');
    assert.equal(atts[1].file_id, 'fid2');
    assert.equal(atts[1].name, 'doc.pdf');
  });

  test('edit-safety: re-recording the same msg_id with attachments does NOT duplicate rows', () => {
    let calls = 0;
    const handler = buildHandler({
      extractAttachments: () => {
        calls += 1;
        return [{ file_id: 'fid1', file_unique_id: 'u1', kind: 'photo', mime_type: 'image/jpeg', size: 1024 }];
      },
    });
    handler(inboundMsg());
    handler(inboundMsg({ text: 'edited body' }));

    const messageId = db.getInboundMessageId({ chat_id: '100', msg_id: 1 });
    const atts = db.getAttachmentsByMessage(messageId);
    assert.equal(atts.length, 1, 'attachment must NOT duplicate on edit');
    assert.equal(calls, 2, 'extractAttachments still called both times (cheap)');
  });

  test('falls back to Math.floor(Date.now()/1000) when msg has no date', () => {
    const handler = buildHandler();
    const before = Date.now();
    handler(inboundMsg({ date: undefined }));
    const after = Date.now();

    const row = db.raw.prepare('SELECT ts FROM messages WHERE chat_id = ? AND msg_id = ?').get('100', 1);
    assert.ok(row.ts >= before - 1000 && row.ts <= after + 1000,
      `ts (${row.ts}) should be approximately now (${before}..${after})`);
  });

  test('uses chat config model + effort + bot_name', () => {
    const handler = buildHandler({ chatConfig: { model: 'opus', effort: 'low' } });
    handler(inboundMsg());

    const row = db.raw.prepare('SELECT model, effort, bot_name FROM messages WHERE chat_id = ? AND msg_id = ?').get('100', 1);
    assert.equal(row.model, 'opus');
    assert.equal(row.effort, 'low');
    assert.equal(row.bot_name, 'testbot');
  });

  test('reply_to_message.message_id captured', () => {
    const handler = buildHandler();
    handler(inboundMsg({ reply_to_message: { message_id: 999 } }));

    const row = db.raw.prepare('SELECT reply_to_id FROM messages WHERE chat_id = ? AND msg_id = ?').get('100', 1);
    assert.equal(row.reply_to_id, 999);
  });

  test('thread_id captured for forum-topic messages', () => {
    const handler = buildHandler();
    handler(inboundMsg({ message_thread_id: 555 }));

    const row = db.raw.prepare('SELECT thread_id FROM messages WHERE chat_id = ? AND msg_id = ?').get('100', 1);
    assert.equal(row.thread_id, '555');
  });

  test('user fallback: from.username used when first_name missing', () => {
    const handler = buildHandler();
    handler(inboundMsg({ from: { id: 42, username: 'opname' } }));

    const row = db.raw.prepare('SELECT user FROM messages WHERE chat_id = ? AND msg_id = ?').get('100', 1);
    assert.equal(row.user, 'opname');
  });

  test('returns silently when db is null (late shutdown arrival)', () => {
    const handler = createRecordInbound({
      db: null,
      dbWrite: () => {},
      config: { chats: {} },
      botName: 'testbot',
      extractAttachments: () => [],
    });
    assert.doesNotThrow(() => handler(inboundMsg()));
  });

  test('chat without chat config: model/effort fallback to null', () => {
    const handler = buildHandler();
    handler({ ...inboundMsg(), chat: { id: 99999 } });

    const row = db.raw.prepare('SELECT model, effort FROM messages WHERE chat_id = ? AND msg_id = ?').get('99999', 1);
    assert.equal(row.model, null);
    assert.equal(row.effort, null);
  });
});

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');

let db;
let dbPath;

function insertInbound(db, { chat_id, msg_id, text, handler_status = null, ts = Date.now() }) {
  db.insertMessage({
    chat_id, thread_id: null, msg_id,
    user: 'Ivan', user_id: 1,
    text, reply_to_id: null,
    direction: 'in', source: 'polygram', bot_name: 'testbot',
    attachments_json: null, session_id: null,
    model: 'sonnet', effort: 'medium', turn_id: null,
    status: null, error: null, cost_usd: null, ts,
  });
  if (handler_status) db.setInboundHandlerStatus({ chat_id, msg_id, status: handler_status });
}

describe('replay — getReplayCandidates + dedupe', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('replay')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('picks up rows with dispatched/processing/replay-pending status', () => {
    insertInbound(db, { chat_id: '1', msg_id: 100, text: 'dispatched', handler_status: 'dispatched' });
    insertInbound(db, { chat_id: '1', msg_id: 101, text: 'processing', handler_status: 'processing' });
    insertInbound(db, { chat_id: '1', msg_id: 102, text: 'replay-pending', handler_status: 'replay-pending' });
    insertInbound(db, { chat_id: '1', msg_id: 103, text: 'already replied', handler_status: 'replied' });
    insertInbound(db, { chat_id: '1', msg_id: 104, text: 'failed', handler_status: 'failed' });
    const rows = db.getReplayCandidates({ chatIds: ['1'] });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.msg_id).sort(), [100, 101, 102]);
  });

  test('ignores rows outside the chatIds filter', () => {
    insertInbound(db, { chat_id: '1', msg_id: 100, text: 'ours', handler_status: 'dispatched' });
    insertInbound(db, { chat_id: '2', msg_id: 101, text: 'other bot', handler_status: 'dispatched' });
    const rows = db.getReplayCandidates({ chatIds: ['1'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chat_id, '1');
  });

  test('ignores rows older than the window', () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    insertInbound(db, { chat_id: '1', msg_id: 100, text: 'fresh', handler_status: 'dispatched' });
    insertInbound(db, { chat_id: '1', msg_id: 99, text: 'stale', handler_status: 'dispatched', ts: oneHourAgo });
    const rows = db.getReplayCandidates({ chatIds: ['1'], olderThanMs: 30 * 60 * 1000 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].msg_id, 100);
  });

  test('hasOutboundReplyTo catches already-replied turns for dedupe', () => {
    insertInbound(db, { chat_id: '1', msg_id: 100, text: 'q', handler_status: 'dispatched' });
    // Fake an outbound reply with reply_to_id=100.
    const pendingId = -42;
    const res = db.insertOutboundPending({
      chat_id: '1', thread_id: null, user: null, text: 'answer',
      source: 'bot-reply-stream', bot_name: 'testbot',
      turn_id: null, session_id: null, pending_id: pendingId,
    });
    db.markOutboundSent(res.lastInsertRowid, { msg_id: 7777, ts: Date.now() });
    // Set reply_to_id via a manual UPDATE (outbound insert doesn't take it).
    db.raw.prepare("UPDATE messages SET reply_to_id = 100 WHERE id = ?").run(res.lastInsertRowid);

    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 100 }), true);
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 999 }), false);
  });

  test('markReplayPending flips dispatched/processing to replay-pending', () => {
    insertInbound(db, { chat_id: '1', msg_id: 100, text: 'a', handler_status: 'dispatched' });
    insertInbound(db, { chat_id: '1', msg_id: 101, text: 'b', handler_status: 'processing' });
    insertInbound(db, { chat_id: '1', msg_id: 102, text: 'c', handler_status: 'replied' });
    const res = db.markReplayPending({ botName: 'testbot' });
    assert.equal(res.changes, 2, 'only dispatched + processing rows get flipped');
    const rows = db.raw.prepare(
      `SELECT msg_id, handler_status FROM messages WHERE direction = 'in' ORDER BY msg_id`,
    ).all();
    assert.equal(rows.find((r) => r.msg_id === 100).handler_status, 'replay-pending');
    assert.equal(rows.find((r) => r.msg_id === 101).handler_status, 'replay-pending');
    assert.equal(rows.find((r) => r.msg_id === 102).handler_status, 'replied', 'replied rows untouched');
  });
});

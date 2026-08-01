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

  test("v0.37.1 false deploy notice: an accepted Claude follow-up is no longer replayable", () => {
    insertInbound(db, {
      chat_id: '1',
      msg_id: 105,
      text: 'accepted follow-up',
      handler_status: 'dispatched',
    });

    assert.deepEqual(
      db.getReplayCandidates({ chatIds: ['1'] }).map((row) => row.msg_id),
      [105],
      'production precondition: the stale dispatched row becomes notice-eligible',
    );

    const settled = db.completeAcceptedClaudeAutosteer({
      chat_id: '1',
      msg_id: 105,
    });

    assert.equal(settled.changes, 1);
    assert.equal(
      db.raw.prepare(
        `SELECT handler_status FROM messages
          WHERE chat_id = '1' AND msg_id = 105 AND direction = 'in'`,
      ).get().handler_status,
      'replied',
    );
    assert.equal(db.getReplayCandidates({ chatIds: ['1'] }).length, 0);
  });

  test('accepted Claude follow-up settlement fails loud when ownership is not unique', () => {
    insertInbound(db, {
      chat_id: '1',
      msg_id: 106,
      text: 'already terminal',
      handler_status: 'replied',
    });

    assert.throws(
      () => db.completeAcceptedClaudeAutosteer({
        chat_id: '1',
        msg_id: 106,
      }),
      (error) => error?.code === 'CLAUDE_AUTOSTEER_STATUS_CONFLICT',
    );
  });

  test('accepted Claude follow-up settlement wraps SQLite failures as typed errors', () => {
    insertInbound(db, {
      chat_id: '1',
      msg_id: 107,
      text: 'accepted before persistence failure',
      handler_status: 'dispatched',
    });
    db.raw.close();

    assert.throws(
      () => db.completeAcceptedClaudeAutosteer({
        chat_id: '1',
        msg_id: 107,
      }),
      (error) => (
        error?.code === 'CLAUDE_AUTOSTEER_STATUS_PERSIST_FAILED'
        && error.cause instanceof Error
      ),
    );
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

describe('replay — markStalePending (G6 outbound-pending sweep)', () => {
  // markStalePending operates on the OUTBOUND `status` column, not the
  // inbound `handler_status`. It flips rows where `status='pending'`
  // (an outbound row inserted before the daemon crashed mid-send) to
  // 'failed' so dedupe (hasOutboundReplyTo) can count them as "we
  // probably already sent this — don't re-dispatch the inbound".

  beforeEach(() => { ({ db, dbPath } = freshDb('replay-stale')); });
  afterEach(() => cleanupDb(dbPath, db));

  function insertOutboundPending(opts) {
    db.raw.prepare(
      `INSERT INTO messages (chat_id, msg_id, user, text, direction, source, bot_name,
        status, ts, model, effort)
        VALUES (?, ?, NULL, ?, 'out', 'polygram', ?, 'pending', ?, 'sonnet', 'medium')`,
    ).run(opts.chat_id, opts.msg_id, opts.text || 'reply', opts.bot_name || 'testbot', opts.ts || Date.now());
  }

  test('flips OLD pending outbound rows to failed; keeps fresh ones', () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    insertOutboundPending({ chat_id: '1', msg_id: 1000, ts: oneHourAgo });
    insertOutboundPending({ chat_id: '1', msg_id: 1001 });   // fresh
    const res = db.markStalePending(60_000);
    assert.equal(res.changes, 1);
    const old = db.raw.prepare("SELECT status, error FROM messages WHERE msg_id=1000").get();
    const fresh = db.raw.prepare("SELECT status FROM messages WHERE msg_id=1001").get();
    assert.equal(old.status, 'failed');
    assert.match(old.error, /crashed/i);
    assert.equal(fresh.status, 'pending');
  });

  test('does NOT flip rows in non-pending statuses', () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    db.raw.prepare(
      `INSERT INTO messages (chat_id, msg_id, user, text, direction, source, bot_name,
        status, ts, model, effort)
        VALUES ('1', 2000, NULL, 'sent reply', 'out', 'polygram', 'testbot', 'sent', ?, 'sonnet', 'medium')`,
    ).run(oneHourAgo);
    db.raw.prepare(
      `INSERT INTO messages (chat_id, msg_id, user, text, direction, source, bot_name,
        status, ts, model, effort)
        VALUES ('1', 2001, NULL, 'failed reply', 'out', 'polygram', 'testbot', 'failed', ?, 'sonnet', 'medium')`,
    ).run(oneHourAgo);
    const res = db.markStalePending(60_000);
    assert.equal(res.changes, 0);
  });

  test('botName filter scopes the sweep', () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    insertOutboundPending({ chat_id: '1', msg_id: 1000, ts: oneHourAgo, bot_name: 'testbot' });
    insertOutboundPending({ chat_id: '1', msg_id: 1001, ts: oneHourAgo, bot_name: 'otherbot' });
    const res = db.markStalePending(60_000, 'testbot');
    assert.equal(res.changes, 1, 'only testbot rows flipped');
    const us = db.raw.prepare("SELECT status FROM messages WHERE msg_id=1000").get();
    const them = db.raw.prepare("SELECT status FROM messages WHERE msg_id=1001").get();
    assert.equal(us.status, 'failed');
    assert.equal(them.status, 'pending');
  });

  test('default olderThanMs (60s) used when not specified', () => {
    insertOutboundPending({ chat_id: '1', msg_id: 1000, ts: Date.now() - 45_000 });
    insertOutboundPending({ chat_id: '1', msg_id: 1001, ts: Date.now() - 120_000 });
    const res = db.markStalePending();
    assert.equal(res.changes, 1, 'only the 120s-old row flipped');
    const r45 = db.raw.prepare("SELECT status FROM messages WHERE msg_id=1000").get();
    const r120 = db.raw.prepare("SELECT status FROM messages WHERE msg_id=1001").get();
    assert.equal(r45.status, 'pending');
    assert.equal(r120.status, 'failed');
  });
});

describe('replay — getReplayCandidates edge cases', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('replay-edge')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('limit caps the result count', () => {
    for (let i = 0; i < 10; i++) {
      insertInbound(db, { chat_id: '1', msg_id: 100 + i, text: `q${i}`, handler_status: 'dispatched' });
    }
    const rows = db.getReplayCandidates({ chatIds: ['1'], limit: 3 });
    assert.equal(rows.length, 3);
  });

  test('default limit (100) caps very large queues', () => {
    for (let i = 0; i < 150; i++) {
      insertInbound(db, { chat_id: '1', msg_id: 100 + i, text: `q${i}`, handler_status: 'dispatched' });
    }
    const rows = db.getReplayCandidates({ chatIds: ['1'] });
    assert.equal(rows.length, 100);
  });

  test('empty chatIds returns no rows', () => {
    insertInbound(db, { chat_id: '1', msg_id: 100, text: 'q', handler_status: 'dispatched' });
    const rows = db.getReplayCandidates({ chatIds: [] });
    assert.equal(rows.length, 0);
  });

  test('chatIds matching no rows returns empty', () => {
    insertInbound(db, { chat_id: '1', msg_id: 100, text: 'q', handler_status: 'dispatched' });
    const rows = db.getReplayCandidates({ chatIds: ['9999'] });
    assert.equal(rows.length, 0);
  });

  test('rows returned in chronological order (oldest first)', () => {
    // Stay within the 3-min default olderThanMs window.
    const baseTs = Date.now() - 60 * 1000;       // 60s ago
    insertInbound(db, { chat_id: '1', msg_id: 102, text: 'third', handler_status: 'dispatched', ts: baseTs + 200 });
    insertInbound(db, { chat_id: '1', msg_id: 100, text: 'first', handler_status: 'dispatched', ts: baseTs });
    insertInbound(db, { chat_id: '1', msg_id: 101, text: 'second', handler_status: 'dispatched', ts: baseTs + 100 });
    const rows = db.getReplayCandidates({ chatIds: ['1'] });
    assert.deepEqual(rows.map((r) => r.msg_id), [100, 101, 102],
      'replay must process oldest first to preserve user intent ordering');
  });
});

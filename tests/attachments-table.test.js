/**
 * Tests for the per-attachment table introduced in migration 007 (polygram 0.6.0).
 * Covers the new db methods, FK cascade, search filters, and the backfill
 * from messages.attachments_json.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { open } = require('../lib/db');

let db;
let dbPath;

function freshDb() {
  dbPath = path.join(os.tmpdir(), `polygram-att-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  return open(dbPath);
}

function cleanup() {
  if (db) { try { db.raw.close(); } catch {} db = null; }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

function insertInbound(d, { chat_id, msg_id, ts = Date.now() }) {
  d.insertMessage({
    chat_id, thread_id: null, msg_id,
    user: 'tester', user_id: 1,
    text: '', reply_to_id: null,
    direction: 'in', source: 'polygram', bot_name: 'shumabit',
    session_id: null,
    model: null, effort: null, turn_id: null,
    status: null, error: null, cost_usd: null, ts,
  });
  return d.getInboundMessageId({ chat_id, msg_id });
}

describe('attachments table — basic CRUD', () => {
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

  test('insertAttachment + getAttachmentsByMessage round-trip', () => {
    const mid = insertInbound(db, { chat_id: '1', msg_id: 100 });
    db.insertAttachment({
      message_id: mid, chat_id: '1', msg_id: 100,
      file_id: 'abc', file_unique_id: 'u1',
      kind: 'photo', name: 'p.jpg', mime_type: 'image/jpeg', size_bytes: 1234,
      ts: Date.now(),
    });
    const rows = db.getAttachmentsByMessage(mid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'photo');
    assert.equal(rows[0].file_unique_id, 'u1');
    assert.equal(rows[0].download_status, 'pending');
    assert.equal(rows[0].local_path, null);
  });

  test('markAttachmentDownloaded sets local_path + status, clears error', () => {
    const mid = insertInbound(db, { chat_id: '1', msg_id: 1 });
    db.insertAttachment({
      message_id: mid, chat_id: '1', msg_id: 1,
      file_id: 'a', kind: 'document', ts: Date.now(),
    });
    const r1 = db.getAttachmentsByMessage(mid)[0];
    db.markAttachmentFailed(r1.id, 'first try blew up');
    db.markAttachmentDownloaded(r1.id, { local_path: '/tmp/x.pdf', size_bytes: 999 });
    const r2 = db.getAttachmentsByMessage(mid)[0];
    assert.equal(r2.download_status, 'downloaded');
    assert.equal(r2.local_path, '/tmp/x.pdf');
    assert.equal(r2.size_bytes, 999);
    assert.equal(r2.download_error, null);
  });

  test('markAttachmentFailed records error', () => {
    const mid = insertInbound(db, { chat_id: '1', msg_id: 1 });
    db.insertAttachment({
      message_id: mid, chat_id: '1', msg_id: 1,
      file_id: 'a', kind: 'voice', ts: Date.now(),
    });
    const id = db.getAttachmentsByMessage(mid)[0].id;
    db.markAttachmentFailed(id, 'HTTP 410 Gone');
    const row = db.getAttachmentsByMessage(mid)[0];
    assert.equal(row.download_status, 'failed');
    assert.match(row.download_error, /HTTP 410/);
    assert.equal(row.local_path, null);
  });

  test('setAttachmentTranscription stores text', () => {
    const mid = insertInbound(db, { chat_id: '1', msg_id: 1 });
    db.insertAttachment({
      message_id: mid, chat_id: '1', msg_id: 1,
      file_id: 'a', kind: 'voice', ts: Date.now(),
    });
    const id = db.getAttachmentsByMessage(mid)[0].id;
    const payload = JSON.stringify({ text: 'hello world', language: 'en', duration_sec: 1.5 });
    db.setAttachmentTranscription(id, payload);
    const row = db.getAttachmentsByMessage(mid)[0];
    assert.equal(row.transcription, payload);
  });

  test('FK cascade: deleting a message wipes its attachments', () => {
    const mid = insertInbound(db, { chat_id: '1', msg_id: 1 });
    db.insertAttachment({
      message_id: mid, chat_id: '1', msg_id: 1,
      file_id: 'a', kind: 'document', ts: Date.now(),
    });
    assert.equal(db.getAttachmentsByMessage(mid).length, 1);
    db.raw.prepare('DELETE FROM messages WHERE id = ?').run(mid);
    assert.equal(db.getAttachmentsByMessage(mid).length, 0);
  });
});

describe('attachments table — search + ops queries', () => {
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

  test('searchAttachments filters by chat_id, kind, status, time range', () => {
    const now = Date.now();
    const m1 = insertInbound(db, { chat_id: '1', msg_id: 1, ts: now - 60_000 });
    const m2 = insertInbound(db, { chat_id: '2', msg_id: 1, ts: now - 30_000 });
    db.insertAttachment({ message_id: m1, chat_id: '1', msg_id: 1, file_id: 'a', kind: 'photo', ts: now - 60_000 });
    db.insertAttachment({ message_id: m2, chat_id: '2', msg_id: 1, file_id: 'b', kind: 'voice', ts: now - 30_000 });
    db.insertAttachment({ message_id: m2, chat_id: '2', msg_id: 1, file_id: 'c', kind: 'photo', ts: now - 30_000 });

    assert.equal(db.searchAttachments({ chat_id: '1' }).length, 1);
    assert.equal(db.searchAttachments({ kind: 'photo' }).length, 2);
    assert.equal(db.searchAttachments({ kind: 'voice' }).length, 1);
    assert.equal(db.searchAttachments({ chat_id: '2', kind: 'photo' }).length, 1);
    assert.equal(db.searchAttachments({ since: now - 45_000 }).length, 2);
    assert.equal(db.searchAttachments({ status: 'pending' }).length, 3);
  });

  test('listFailedAttachments returns recent failures only', () => {
    const now = Date.now();
    const old = now - 36 * 60 * 60_000; // 36h ago
    const mOld = insertInbound(db, { chat_id: '1', msg_id: 1, ts: old });
    const mNew = insertInbound(db, { chat_id: '1', msg_id: 2, ts: now - 60_000 });
    db.insertAttachment({ message_id: mOld, chat_id: '1', msg_id: 1, file_id: 'a', kind: 'doc', ts: old });
    db.insertAttachment({ message_id: mNew, chat_id: '1', msg_id: 2, file_id: 'b', kind: 'doc', ts: now - 60_000 });
    db.markAttachmentFailed(db.getAttachmentsByMessage(mOld)[0].id, 'old failure');
    db.markAttachmentFailed(db.getAttachmentsByMessage(mNew)[0].id, 'new failure');
    // default since = 24h cutoff
    const recent = db.listFailedAttachments();
    assert.equal(recent.length, 1);
    assert.match(recent[0].download_error, /new failure/);
    // explicit since pulling all
    assert.equal(db.listFailedAttachments({ since: 0 }).length, 2);
  });
});

describe('reassignAttachmentsToMessage — media-group coalescing', () => {
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

  test('moves sibling attachments to the primary message', () => {
    // Simulate a 3-photo album: each photo arrived as its own Telegram
    // message, recordInbound inserted message + attachment per arrival.
    // The media-group buffer then needs to FK them all under the primary
    // so handleMessage's lookup returns the whole album.
    const ts = Date.now();
    const primaryId   = insertInbound(db, { chat_id: '-100', msg_id: 100, ts });
    const sibling1Id  = insertInbound(db, { chat_id: '-100', msg_id: 101, ts });
    const sibling2Id  = insertInbound(db, { chat_id: '-100', msg_id: 102, ts });
    db.insertAttachment({ message_id: primaryId,  chat_id: '-100', msg_id: 100, file_id: 'p1', kind: 'photo', ts });
    db.insertAttachment({ message_id: sibling1Id, chat_id: '-100', msg_id: 101, file_id: 'p2', kind: 'photo', ts });
    db.insertAttachment({ message_id: sibling2Id, chat_id: '-100', msg_id: 102, file_id: 'p3', kind: 'photo', ts });

    // Pre-condition: the primary alone only has 1 attachment.
    assert.equal(db.getAttachmentsByMessage(primaryId).length, 1);

    db.reassignAttachmentsToMessage({
      chat_id: '-100',
      msg_ids: [101, 102],
      target_message_id: primaryId,
    });

    // Post-condition: primary now owns all 3; siblings own 0.
    assert.equal(db.getAttachmentsByMessage(primaryId).length, 3);
    assert.equal(db.getAttachmentsByMessage(sibling1Id).length, 0);
    assert.equal(db.getAttachmentsByMessage(sibling2Id).length, 0);
    // msg_id on the moved rows is rewritten to primary's msg_id so future
    // (chat_id, msg_id)-keyed lookups stay consistent.
    const rows = db.getAttachmentsByMessage(primaryId);
    for (const r of rows) {
      assert.equal(r.msg_id, 100, 'msg_id should be rewritten to primary');
    }
  });

  test('no-op when msg_ids is empty', () => {
    const r = db.reassignAttachmentsToMessage({
      chat_id: '-100', msg_ids: [], target_message_id: 1,
    });
    assert.equal(r.changes, 0);
  });

  test('idempotent — re-recording a message does not duplicate attachments', () => {
    // Simulate the edit cycle: recordInbound is called for the original
    // message, then again for the edited_message event. The bug would
    // be that the second call inserts another attachment row (pre-fix:
    // every edit added N more rows for the same photos).
    const ts = Date.now();
    const mid = insertInbound(db, { chat_id: '1', msg_id: 1, ts });

    // Simulate recordInbound's loop: getAttachmentsByMessage early-exits
    // on second call. We model both passes here.
    const insertOnce = () => {
      const existing = db.getAttachmentsByMessage(mid);
      if (existing.length > 0) return;  // edit-skip guard from polygram.js
      db.insertAttachment({
        message_id: mid, chat_id: '1', msg_id: 1,
        file_id: 'fid', file_unique_id: 'u1', kind: 'photo',
        ts,
      });
    };

    insertOnce();
    insertOnce();  // simulates edited_message re-firing recordInbound
    insertOnce();  // and again

    const rows = db.getAttachmentsByMessage(mid);
    assert.equal(rows.length, 1, 'should not duplicate on edit re-fire');
  });

  test('does not move rows already owned by primary', () => {
    const ts = Date.now();
    const primaryId = insertInbound(db, { chat_id: '-100', msg_id: 100, ts });
    db.insertAttachment({ message_id: primaryId, chat_id: '-100', msg_id: 100, file_id: 'p1', kind: 'photo', ts });
    const before = db.getAttachmentsByMessage(primaryId)[0];
    const r = db.reassignAttachmentsToMessage({
      chat_id: '-100', msg_ids: [100], target_message_id: primaryId,
    });
    // The `message_id != ?` guard skips already-correctly-owned rows.
    assert.equal(r.changes, 0);
    const after = db.getAttachmentsByMessage(primaryId)[0];
    assert.equal(after.id, before.id);
  });
});

describe('migrations 007 + 008 — schema state after open()', () => {
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

  test('attachments table exists and is queryable', () => {
    const cols = db.raw.prepare('PRAGMA table_info(attachments)').all();
    const names = cols.map((c) => c.name);
    for (const expected of [
      'id', 'message_id', 'chat_id', 'msg_id', 'file_id', 'file_unique_id',
      'kind', 'name', 'mime_type', 'size_bytes', 'local_path',
      'download_status', 'download_error', 'transcription', 'ts',
    ]) {
      assert.ok(names.includes(expected), `attachments.${expected} missing`);
    }
  });

  test('messages.attachments_json column was dropped by migration 008', () => {
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all();
    const names = cols.map((c) => c.name);
    assert.equal(names.includes('attachments_json'), false,
      'attachments_json should be gone after migration 008');
  });

  test('user_version is at SCHEMA_VERSION (8)', () => {
    const v = db.raw.pragma('user_version', { simple: true });
    assert.ok(v >= 8, `expected user_version >= 8, got ${v}`);
  });
});

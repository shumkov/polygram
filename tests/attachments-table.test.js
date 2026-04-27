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

function insertInbound(d, { chat_id, msg_id, attachments_json = null, ts = Date.now() }) {
  d.insertMessage({
    chat_id, thread_id: null, msg_id,
    user: 'tester', user_id: 1,
    text: '', reply_to_id: null,
    direction: 'in', source: 'polygram', bot_name: 'shumabit',
    attachments_json, session_id: null,
    model: null, effort: null, turn_id: null,
    status: null, error: null, cost_usd: null, ts,
  });
  return d.getInboundMessageId({ chat_id, msg_id });
}

const BACKFILL_SQL = `
  INSERT INTO attachments (
    message_id, chat_id, msg_id, thread_id, bot_name,
    file_id, file_unique_id, kind, name, mime_type, size_bytes,
    local_path, download_status, transcription, ts
  )
  SELECT
    m.id, m.chat_id, m.msg_id, m.thread_id, m.bot_name,
    COALESCE(json_extract(att.value, '$.file_id'), ''),
    json_extract(att.value, '$.file_unique_id'),
    COALESCE(json_extract(att.value, '$.kind'), 'document'),
    json_extract(att.value, '$.name'),
    json_extract(att.value, '$.mime_type'),
    json_extract(att.value, '$.size'),
    json_extract(att.value, '$.path'),
    'downloaded',
    json_extract(att.value, '$.transcription.text'),
    m.ts
  FROM messages m, json_each(m.attachments_json) att
  WHERE m.attachments_json IS NOT NULL AND m.direction = 'in'
    AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)
`;

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

describe('migration 007 — backfill from attachments_json', () => {
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

  test('backfill inserts one row per JSON item, marks downloaded, copies fields', () => {
    const json = JSON.stringify([
      { kind: 'photo', name: 'p.jpg', mime_type: 'image/jpeg', size: 1234, file_id: 'fid1', file_unique_id: 'u1' },
      { kind: 'voice', name: 'v.ogg', mime_type: 'audio/ogg', size: 9876, file_id: 'fid2', file_unique_id: 'u2',
        transcription: { text: 'hello there' } },
    ]);
    const mid = insertInbound(db, { chat_id: '5', msg_id: 42, attachments_json: json });
    // Simulate pre-007: clear any auto-inserted rows then run backfill.
    db.raw.prepare('DELETE FROM attachments WHERE message_id = ?').run(mid);
    db.raw.prepare(BACKFILL_SQL).run();

    const rows = db.getAttachmentsByMessage(mid);
    assert.equal(rows.length, 2);
    const photo = rows.find((r) => r.kind === 'photo');
    const voice = rows.find((r) => r.kind === 'voice');
    assert.equal(photo.file_unique_id, 'u1');
    assert.equal(photo.size_bytes, 1234);
    assert.equal(photo.download_status, 'downloaded');
    assert.equal(voice.transcription, 'hello there');
  });

  test('backfill is idempotent — re-running does not double-insert', () => {
    const json = JSON.stringify([{ kind: 'photo', name: 'p.jpg', file_id: 'fid', size: 10 }]);
    const mid = insertInbound(db, { chat_id: '1', msg_id: 1, attachments_json: json });
    db.raw.prepare('DELETE FROM attachments WHERE message_id = ?').run(mid);
    db.raw.prepare(BACKFILL_SQL).run();
    const after1 = db.getAttachmentsByMessage(mid).length;
    db.raw.prepare(BACKFILL_SQL).run();
    const after2 = db.getAttachmentsByMessage(mid).length;
    assert.equal(after1, 1);
    assert.equal(after2, 1);
  });
});

/**
 * Shared test fixture helpers for tests that need a fresh per-test DB.
 *
 * Pre-0.6.10 every DB-touching test file copy-pasted the same ~12 lines
 * of `freshDb()` + `cleanup()` boilerplate (10 files, ~120 LOC of
 * duplication). This module centralises it so a schema change or test
 * convention update lands in one place.
 *
 * Usage:
 *   const { freshDb, cleanupDb, insertInbound } = require('./helpers/db-fixture');
 *
 *   let db;
 *   let dbPath;
 *   beforeEach(() => { ({ db, dbPath } = freshDb('replay')); });
 *   afterEach(() => cleanupDb(dbPath, db));
 *
 * The `prefix` is a debug label embedded in the temp filename so a stuck
 * `tmpdir` is easier to grep through. Pick something that matches your
 * suite name.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../../lib/db');

function freshDb(prefix = 'polygram-test') {
  const dbPath = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  return { db: open(dbPath), dbPath };
}

function cleanupDb(dbPath, db) {
  if (db) { try { db.raw.close(); } catch {} }
  if (!dbPath) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

/**
 * Insert a typical inbound message row. Caller overrides any field via
 * the `fields` object. Returns the messages.id auto-pk so callers can
 * FK attachments.
 *
 * Defaults: chat_id='1', msg_id=1, user='tester', direction='in',
 * source='polygram', bot_name='testbot', ts=Date.now(). Anything else
 * is null.
 *
 * If `handler_status` is provided, it's applied via setInboundHandlerStatus
 * after the insert (the column doesn't accept it via insertMessage).
 */
function insertInbound(db, fields = {}) {
  const chat_id = fields.chat_id ?? '1';
  const msg_id = fields.msg_id ?? 1;
  const ts = fields.ts ?? Date.now();
  db.insertMessage({
    chat_id, thread_id: null, msg_id,
    user: 'tester', user_id: 1,
    text: '', reply_to_id: null,
    direction: 'in', source: 'polygram', bot_name: 'testbot',
    session_id: null,
    model: null, effort: null, turn_id: null,
    status: null, error: null, cost_usd: null,
    ts,
    ...fields,
  });
  if (fields.handler_status) {
    db.setInboundHandlerStatus({ chat_id, msg_id, status: fields.handler_status });
  }
  return db.getInboundMessageId({ chat_id, msg_id });
}

module.exports = { freshDb, cleanupDb, insertInbound };

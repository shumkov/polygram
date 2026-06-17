/**
 * Tests for the 0.14 clean-shutdown marker (lib/db.js recordCleanShutdown /
 * consumeCleanShutdownMarker) against a REAL migrated DB — the spike proved the
 * semantics in isolation; this proves them against migration 005's NOT NULL
 * polling_state + migration 013's clean_shutdown_at column.
 * Run: node --test tests/clean-shutdown-marker.test.js
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');

let db; let dbPath;
const NOW = 1_800_000_000_000;
const WINDOW = 72 * 60 * 1000;
const MAX_AGE = 2 * WINDOW;

function insertInbound({ bot = 'shumabit', chat = '-100', msg = 1, status = 'dispatched', ts = NOW }) {
  db.raw.prepare(`INSERT INTO messages (chat_id, msg_id, direction, bot_name, handler_status, ts)
                  VALUES (?, ?, 'in', ?, ?, ?)`).run(chat, msg, bot, status, ts);
}

describe('clean-shutdown marker', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('clean-shutdown-marker')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('migration applied: schema >= v13 and polling_state.clean_shutdown_at exists', () => {
    assert.ok(db.raw.pragma('user_version', { simple: true }) >= 13);
    const cols = db.raw.prepare("PRAGMA table_info(polling_state)").all().map((c) => c.name);
    assert.ok(cols.includes('clean_shutdown_at'), 'clean_shutdown_at column present');
  });

  test('recordCleanShutdown marks in-flight rows replay-pending AND boot reads CLEAN (one txn)', () => {
    insertInbound({ msg: 1, status: 'dispatched', ts: NOW - 1000 });
    insertInbound({ msg: 2, status: 'processing', ts: NOW - 1000 });
    const res = db.recordCleanShutdown({ botName: 'shumabit', now: NOW });
    assert.equal(res.replayMarked, 2);
    assert.equal(db.raw.prepare("SELECT handler_status h FROM messages WHERE msg_id=1").get().h, 'replay-pending');
    const c = db.consumeCleanShutdownMarker({ botName: 'shumabit', now: NOW + 1000, maxAgeMs: MAX_AGE });
    assert.equal(c.clean, true);
  });

  test('fresh/quiet bot with NO polling_state row → recordCleanShutdown does not throw (NOT NULL satisfied)', () => {
    // no messages, no polling_state row
    assert.doesNotThrow(() => db.recordCleanShutdown({ botName: 'umi-assistant', now: NOW }));
    const row = db.raw.prepare("SELECT last_update_id, ts, clean_shutdown_at FROM polling_state WHERE bot_name='umi-assistant'").get();
    assert.equal(row.last_update_id, 0);
    assert.equal(row.ts, NOW);
    assert.equal(db.consumeCleanShutdownMarker({ botName: 'umi-assistant', now: NOW + 1, maxAgeMs: MAX_AGE }).clean, true);
  });

  test('recordCleanShutdown PRESERVES an existing polling offset', () => {
    db.savePollingOffset('shumabit', 424242);
    db.recordCleanShutdown({ botName: 'shumabit', now: NOW });
    assert.equal(db.getPollingOffset('shumabit'), 424242, 'last_update_id preserved');
  });

  test('read-and-clear: a second boot (no new shutdown) reads CRASH', () => {
    db.recordCleanShutdown({ botName: 'shumabit', now: NOW });
    assert.equal(db.consumeCleanShutdownMarker({ botName: 'shumabit', now: NOW + 1, maxAgeMs: MAX_AGE }).clean, true);
    assert.equal(db.consumeCleanShutdownMarker({ botName: 'shumabit', now: NOW + 2, maxAgeMs: MAX_AGE }).clean, false);
  });

  test('stale marker (older than maxAgeMs) → CRASH', () => {
    db.recordCleanShutdown({ botName: 'shumabit', now: NOW });
    assert.equal(db.consumeCleanShutdownMarker({ botName: 'shumabit', now: NOW + MAX_AGE + 1000, maxAgeMs: MAX_AGE }).clean, false);
  });

  test('future-dated marker (clock skew) → CRASH', () => {
    db.recordCleanShutdown({ botName: 'shumabit', now: NOW });
    assert.equal(db.consumeCleanShutdownMarker({ botName: 'shumabit', now: NOW - 60_000, maxAgeMs: MAX_AGE }).clean, false);
  });

  test('no marker ever written → CRASH', () => {
    insertInbound({ msg: 1 });
    assert.equal(db.consumeCleanShutdownMarker({ botName: 'shumabit', now: NOW, maxAgeMs: MAX_AGE }).clean, false);
  });

  test('per-bot isolation: bot A clean shutdown does not make bot B read clean', () => {
    db.recordCleanShutdown({ botName: 'shumabit', now: NOW });
    assert.equal(db.consumeCleanShutdownMarker({ botName: 'umi-assistant', now: NOW + 1, maxAgeMs: MAX_AGE }).clean, false);
    assert.equal(db.consumeCleanShutdownMarker({ botName: 'shumabit', now: NOW + 1, maxAgeMs: MAX_AGE }).clean, true);
  });
});

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { open } = require('../lib/db');

let db;
let dbPath;

function freshDb() {
  dbPath = path.join(os.tmpdir(), `polling-state-${process.pid}-${Date.now()}.db`);
  return open(dbPath);
}

function cleanup() {
  if (db) { try { db.raw.close(); } catch {} db = null; }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

describe('polling_state persistence', () => {
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

  test('getPollingOffset returns 0 for unknown bot', () => {
    assert.equal(db.getPollingOffset('never-seen'), 0);
  });

  test('savePollingOffset then getPollingOffset roundtrip', () => {
    db.savePollingOffset('shumabit', 12345);
    assert.equal(db.getPollingOffset('shumabit'), 12345);
  });

  test('upsert updates ts and value in place (no duplicate rows)', () => {
    db.savePollingOffset('shumabit', 100);
    db.savePollingOffset('shumabit', 200);
    db.savePollingOffset('shumabit', 300);
    assert.equal(db.getPollingOffset('shumabit'), 300);
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM polling_state WHERE bot_name = 'shumabit'").get().n;
    assert.equal(count, 1, 'should be exactly one row per bot');
  });

  test('different bots are independent', () => {
    db.savePollingOffset('shumabit', 10);
    db.savePollingOffset('umi-assistant', 20);
    assert.equal(db.getPollingOffset('shumabit'), 10);
    assert.equal(db.getPollingOffset('umi-assistant'), 20);
  });
});

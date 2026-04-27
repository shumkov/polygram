const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');

let db;
let dbPath;

describe('polling_state persistence', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polling-state')); });
  afterEach(() => cleanupDb(dbPath, db));

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

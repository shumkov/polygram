/**
 * Tests for scripts/split-db.js (unit-level, no shell)
 * Run: node --test tests/split-db.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { open } = require('../lib/db');
const { copy, count, chatIdsForBot } = require('../scripts/split-db');

let tmpDir;
let srcDb, srcPath;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-test-'));
  srcPath = path.join(tmpDir, 'bridge.db');
  srcDb = open(srcPath);
}

function teardown() {
  if (srcDb) { try { srcDb.raw.close(); } catch {} srcDb = null; }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function seedMessage(db, overrides = {}) {
  const defaults = {
    chat_id: '1', msg_id: 1, user: 'x', text: 'hi',
    direction: 'in', source: 'bridge', bot_name: 'shumabit',
    status: 'received', ts: Date.now(),
  };
  const row = { ...defaults, ...overrides };
  return db.insertMessage(row);
}

describe('chatIdsForBot', () => {
  test('filters the chat→bot map', () => {
    const ids = chatIdsForBot({ '1': 'a', '2': 'b', '3': 'a' }, 'a');
    assert.deepEqual(ids.sort(), ['1', '3']);
    assert.deepEqual(chatIdsForBot({}, 'x'), []);
  });
});

describe('split-db copy', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('routes messages by chat_id and bot_name', () => {
    seedMessage(srcDb, { chat_id: 'A1', bot_name: 'shumabit', msg_id: 1 });
    seedMessage(srcDb, { chat_id: 'A2', bot_name: 'shumabit', msg_id: 2 });
    seedMessage(srcDb, { chat_id: 'B1', bot_name: 'umi-assistant', msg_id: 3 });

    const dstS = open(path.join(tmpDir, 'shumabit.db'));
    const dstU = open(path.join(tmpDir, 'umi-assistant.db'));
    const chatToBot = { 'A1': 'shumabit', 'A2': 'shumabit', 'B1': 'umi-assistant' };

    const sStats = copy(srcDb, dstS, 'shumabit', chatToBot);
    const uStats = copy(srcDb, dstU, 'umi-assistant', chatToBot);

    assert.equal(sStats.messages, 2);
    assert.equal(uStats.messages, 1);

    const sRows = dstS.raw.prepare('SELECT msg_id FROM messages ORDER BY msg_id').all();
    const uRows = dstU.raw.prepare('SELECT msg_id FROM messages ORDER BY msg_id').all();
    assert.deepEqual(sRows.map(r => r.msg_id), [1, 2]);
    assert.deepEqual(uRows.map(r => r.msg_id), [3]);

    dstS.raw.close(); dstU.raw.close();
  });

  test('is idempotent on re-run', () => {
    seedMessage(srcDb, { chat_id: 'A1', bot_name: 'shumabit', msg_id: 1 });
    const dst = open(path.join(tmpDir, 'shumabit.db'));
    const chatToBot = { 'A1': 'shumabit' };

    const first = copy(srcDb, dst, 'shumabit', chatToBot);
    const second = copy(srcDb, dst, 'shumabit', chatToBot);
    assert.equal(first.messages, 1);
    assert.equal(second.messages, 0, 'second run copies nothing new');

    const { n } = dst.raw.prepare('SELECT COUNT(*) AS n FROM messages').get();
    assert.equal(n, 1);
    dst.raw.close();
  });

  test('copies pairings scoped to the bot', () => {
    srcDb.raw.prepare(`
      INSERT INTO pair_codes (code, bot_name, scope, issued_by_user_id, issued_ts, expires_ts)
      VALUES (?, ?, 'user', ?, ?, ?)
    `).run('ABC12345', 'shumabit', 1, Date.now(), Date.now() + 10 * 60_000);
    srcDb.raw.prepare(`
      INSERT INTO pairings (bot_name, user_id, chat_id, granted_ts, granted_by_user_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('shumabit', 42, null, Date.now(), 1);
    srcDb.raw.prepare(`
      INSERT INTO pairings (bot_name, user_id, chat_id, granted_ts, granted_by_user_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('umi-assistant', 99, null, Date.now(), 1);

    const dstS = open(path.join(tmpDir, 'shumabit.db'));
    const stats = copy(srcDb, dstS, 'shumabit', {});
    assert.equal(stats.pair_codes, 1);
    assert.equal(stats.pairings, 1);
    const { n } = dstS.raw.prepare('SELECT COUNT(*) AS n FROM pairings').get();
    assert.equal(n, 1);
    dstS.raw.close();
  });

  test('events and chat_migrations are duplicated to each bot DB', () => {
    srcDb.logEvent('restart', { x: 1 });
    srcDb.logChatMigration('-100', '-200');

    const dstS = open(path.join(tmpDir, 'shumabit.db'));
    const dstU = open(path.join(tmpDir, 'umi-assistant.db'));
    copy(srcDb, dstS, 'shumabit', {});
    copy(srcDb, dstU, 'umi-assistant', {});

    for (const dst of [dstS, dstU]) {
      const e = dst.raw.prepare('SELECT COUNT(*) AS n FROM events').get().n;
      const m = dst.raw.prepare('SELECT COUNT(*) AS n FROM chat_migrations').get().n;
      assert.equal(e, 1, 'events copied');
      assert.equal(m, 1, 'chat_migrations copied');
    }
    dstS.raw.close(); dstU.raw.close();
  });

  test('count mode does not write', () => {
    seedMessage(srcDb, { chat_id: 'A1', bot_name: 'shumabit', msg_id: 1 });
    const stats = count(srcDb, 'shumabit', { 'A1': 'shumabit' });
    assert.equal(stats.messages, 1);
    // src DB unchanged
    const n = srcDb.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    assert.equal(n, 1);
  });
});

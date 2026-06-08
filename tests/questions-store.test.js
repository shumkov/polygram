'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createQuestionStore } = require('../lib/questions/store');

// Open a real temp DB and run the project migrations so the pending_questions
// table (migration 012) actually exists — this also asserts the migration is valid.
function openMigratedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-'));
  const db = new Database(path.join(dir, 't.db'));
  db.pragma('journal_mode = WAL');
  const migDir = path.join(__dirname, '..', 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }
  return { db, dir };
}

describe('pending_questions store', () => {
  let db, dir, store;
  let clock = 1000;
  before(() => { ({ db, dir } = openMigratedDb()); store = createQuestionStore(db, () => clock); });
  after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  test('migration 012 created the table + indexes', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_questions'").get();
    assert.ok(t, 'pending_questions table exists');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pq_open'").get();
    assert.ok(idx, 'open-question index exists');
  });

  test('issue stores a row with a token + open status', () => {
    const row = store.issue({
      bot_name: 'b', session_key: 's:1', chat_id: '100', thread_id: '1',
      tool_call_id: 'tc1', questions: [{ header: 'H', question: 'q', options: [{ label: 'a' }] }],
      state: { qIndex: 0 },
    });
    assert.ok(row.id);
    assert.equal(row.status, 'pending');
    assert.ok(row.callback_token && row.callback_token.length >= 16, '128-bit-ish token');
    assert.equal(row.timeout_ts, 1000 + 8 * 60 * 1000, 'default 8-min timeout under the turn caps');
    assert.deepEqual(JSON.parse(row.questions_json)[0].header, 'H');
  });

  test('getOpenForSession returns the single open question (one per session)', () => {
    const r = store.getOpenForSession('s:1');
    assert.ok(r && r.tool_call_id === 'tc1');
    assert.equal(store.getOpenForSession('s:other'), undefined);
  });

  test('getByToolCallId routes the answer back', () => {
    assert.equal(store.getByToolCallId('tc1').session_key, 's:1');
  });

  test('updateState + setMessageIds persist', () => {
    const id = store.getOpenForSession('s:1').id;
    store.updateState(id, { qIndex: 1 }, true);
    store.setMessageIds(id, [555]);
    const r = store.getById(id);
    assert.equal(JSON.parse(r.state_json).qIndex, 1);
    assert.equal(r.awaiting_other, 1);
    assert.deepEqual(JSON.parse(r.message_ids_json), [555]);
  });

  test('claimOrCheck — first tapper claims, others rejected', () => {
    const id = store.getOpenForSession('s:1').id;
    assert.deepEqual(store.claimOrCheck(id, 42), { ok: true, claimed: true }, 'user 42 claims it');
    assert.equal(store.claimOrCheck(id, 42).ok, true, 'same user can keep answering');
    assert.equal(store.claimOrCheck(id, 99).ok, false, 'a different group member is rejected');
  });

  test('resolve flips status off pending (idempotent)', () => {
    const id = store.getOpenForSession('s:1').id;
    assert.equal(store.resolve(id, 'answered'), 1);
    assert.equal(store.resolve(id, 'answered'), 0, 'second resolve is a no-op');
    assert.equal(store.getOpenForSession('s:1'), undefined, 'no longer open');
  });

  test('sweepTimedOut returns expired-but-still-pending rows', () => {
    store.issue({ bot_name: 'b', session_key: 's:2', chat_id: '1', tool_call_id: 'tc2', questions: [], state: {}, timeoutMs: 100 });
    clock = 1000 + 200;     // advance past the 100ms timeout
    const swept = store.sweepTimedOut();
    assert.ok(swept.some((r) => r.tool_call_id === 'tc2'));
  });
});

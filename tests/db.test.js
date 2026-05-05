/**
 * Unit tests for lib/db.js
 * Run: node --test tests/db.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { open } = require('../lib/db'); // a couple of tests open a 2nd connection to the same file

let db;
let dbPath;

describe('schema + migrations', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('user_version is at current schema after migration', () => {
    const v = db.raw.pragma('user_version', { simple: true });
    assert.ok(v >= 2, `expected user_version >= 2, got ${v}`);
  });

  test('WAL mode is enabled', () => {
    assert.equal(db.raw.pragma('journal_mode', { simple: true }), 'wal');
  });

  test('all tables exist', () => {
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['sessions', 'messages', 'chat_migrations', 'config_changes', 'events', 'messages_fts']) {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    }
  });

  test('FTS triggers are installed', () => {
    const triggers = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name);
    for (const t of ['messages_ai', 'messages_au', 'messages_ad']) {
      assert.ok(triggers.includes(t), `missing trigger: ${t}`);
    }
  });

  test('re-opening existing DB does not rerun migrations', () => {
    const v1 = db.raw.pragma('user_version', { simple: true });
    db.raw.close();
    const db2 = open(dbPath);
    assert.equal(db2.raw.pragma('user_version', { simple: true }), v1);
    db2.raw.close();
    db = null;
  });
});

describe('insertMessage', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('writes inbound row with defaults', () => {
    db.insertMessage({ chat_id: '123', msg_id: 1, user: 'Ivan', text: 'hi', direction: 'in' });
    const row = db.raw.prepare('SELECT * FROM messages WHERE chat_id=? AND msg_id=?').get('123', 1);
    assert.equal(row.user, 'Ivan');
    assert.equal(row.text, 'hi');
    assert.equal(row.direction, 'in');
    assert.equal(row.source, 'polygram');
    assert.equal(row.status, 'received');
    assert.ok(row.ts > 0);
  });

  test('coerces chat_id to string', () => {
    db.insertMessage({ chat_id: -100123, msg_id: 1, text: 'x', direction: 'in' });
    const row = db.raw.prepare('SELECT chat_id FROM messages WHERE msg_id=1').get();
    assert.equal(row.chat_id, '-100123');
  });

  test('stores reply_to_id when present', () => {
    db.insertMessage({ chat_id: '1', msg_id: 2, text: 'reply', direction: 'in', reply_to_id: 1 });
    const row = db.raw.prepare('SELECT reply_to_id FROM messages WHERE msg_id=2').get();
    assert.equal(row.reply_to_id, 1);
  });

  test('stores outbound row with model/effort/cost/turn_id', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 99, direction: 'out', text: 'bot reply',
      bot_name: 'shumabit', session_id: 'sess-123',
      model: 'opus', effort: 'medium', cost_usd: 0.42, turn_id: 't-1',
      status: 'sent', source: 'bot-reply',
    });
    const row = db.raw.prepare('SELECT * FROM messages WHERE msg_id=99').get();
    assert.equal(row.direction, 'out');
    assert.equal(row.model, 'opus');
    assert.equal(row.effort, 'medium');
    assert.equal(row.cost_usd, 0.42);
    assert.equal(row.turn_id, 't-1');
    assert.equal(row.status, 'sent');
  });

  test('edited msg: second insert with same (chat_id, msg_id) updates text + edited_ts', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'original', direction: 'in', ts: 1000 });
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'edited', direction: 'in', ts: 2000 });
    const row = db.raw.prepare('SELECT text, ts, edited_ts FROM messages WHERE msg_id=1').get();
    assert.equal(row.text, 'edited');
    assert.equal(row.edited_ts, 2000);
    assert.equal(row.ts, 1000, 'original ts preserved');
  });

  test('direction CHECK rejects bogus value', () => {
    assert.throws(
      () => db.insertMessage({ chat_id: '1', msg_id: 1, text: 'x', direction: 'sideways' }),
      /CHECK constraint/,
    );
  });

  test('status CHECK rejects bogus value', () => {
    assert.throws(
      () => db.insertMessage({ chat_id: '1', msg_id: 1, text: 'x', direction: 'in', status: 'maybe' }),
      /CHECK constraint/,
    );
  });
});

describe('outbound pending lifecycle', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('insertOutboundPending → markOutboundSent updates msg_id + status', () => {
    const res = db.insertOutboundPending({
      chat_id: '1', text: 'hi', bot_name: 'shumabit',
      turn_id: 't-1', session_id: 's-1', pending_id: -1,
    });
    const id = res.lastInsertRowid;
    const pendingRow = db.raw.prepare('SELECT status, msg_id FROM messages WHERE id=?').get(id);
    assert.equal(pendingRow.status, 'pending');
    assert.equal(pendingRow.msg_id, -1);

    db.markOutboundSent(id, { msg_id: 100, ts: 5000 });
    const sentRow = db.raw.prepare('SELECT status, msg_id, ts FROM messages WHERE id=?').get(id);
    assert.equal(sentRow.status, 'sent');
    assert.equal(sentRow.msg_id, 100);
    assert.equal(sentRow.ts, 5000);
  });

  test('markOutboundFailed sets status + error (truncated)', () => {
    const res = db.insertOutboundPending({ chat_id: '1', text: 'hi', bot_name: 'shumabit', pending_id: -2 });
    const id = res.lastInsertRowid;
    const longErr = 'x'.repeat(1000);
    db.markOutboundFailed(id, longErr);
    const row = db.raw.prepare('SELECT status, error FROM messages WHERE id=?').get(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error.length, 500);
  });

  test('markStalePending: flips old pending → failed, leaves fresh pending alone', () => {
    // Insert stale pending (ts=old)
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, ts)
      VALUES ('1', -10, 'out', 'pending', ?)
    `).run(Date.now() - 120_000); // 2 min ago
    // Fresh pending
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, ts)
      VALUES ('1', -11, 'out', 'pending', ?)
    `).run(Date.now() - 5_000); // 5s ago

    const res = db.markStalePending(60_000); // 60s threshold
    assert.equal(res.changes, 1);

    const stale = db.raw.prepare('SELECT status, error FROM messages WHERE msg_id=-10').get();
    const fresh = db.raw.prepare('SELECT status FROM messages WHERE msg_id=-11').get();
    assert.equal(stale.status, 'failed');
    assert.equal(stale.error, 'crashed-mid-send');
    assert.equal(fresh.status, 'pending');
  });

  test('markStalePending(ms, botName) scopes to one bot', () => {
    // Stale pending for bot A
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, bot_name, ts)
      VALUES ('1', -20, 'out', 'pending', 'shumabit', ?)
    `).run(Date.now() - 120_000);
    // Stale pending for bot B
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, bot_name, ts)
      VALUES ('2', -21, 'out', 'pending', 'umi-assistant', ?)
    `).run(Date.now() - 120_000);

    const res = db.markStalePending(60_000, 'shumabit');
    assert.equal(res.changes, 1);

    const shumabitRow = db.raw.prepare('SELECT status FROM messages WHERE msg_id=-20').get();
    const umiRow = db.raw.prepare('SELECT status FROM messages WHERE msg_id=-21').get();
    assert.equal(shumabitRow.status, 'failed');
    assert.equal(umiRow.status, 'pending', 'umi-assistant row must not be touched by shumabit sweep');
  });

  test('markStalePending with no botName touches all bots (back-compat)', () => {
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, bot_name, ts)
      VALUES ('1', -30, 'out', 'pending', 'shumabit', ?)
    `).run(Date.now() - 120_000);
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, bot_name, ts)
      VALUES ('2', -31, 'out', 'pending', 'umi-assistant', ?)
    `).run(Date.now() - 120_000);

    const res = db.markStalePending(60_000);
    assert.equal(res.changes, 2);
  });
});

describe('sessions', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('upsertSession inserts new row', () => {
    db.upsertSession({
      session_key: '123', chat_id: '123', claude_session_id: 'abc',
      agent: 'shumabit', cwd: '/tmp', model: 'opus', effort: 'medium',
    });
    const row = db.getSession('123');
    assert.equal(row.claude_session_id, 'abc');
    assert.equal(row.model, 'opus');
    assert.ok(row.created_ts > 0);
    assert.equal(row.created_ts, row.last_active_ts);
  });

  test('upsertSession updates existing, preserves created_ts', async () => {
    db.upsertSession({ session_key: '1', chat_id: '1', claude_session_id: 'old', ts: 1000 });
    const created = db.getSession('1').created_ts;
    db.upsertSession({ session_key: '1', chat_id: '1', claude_session_id: 'new', ts: 2000 });
    const row = db.getSession('1');
    assert.equal(row.claude_session_id, 'new');
    assert.equal(row.created_ts, created);
    assert.equal(row.last_active_ts, 2000);
  });

  test('thread_id preserved in session_key with topic', () => {
    db.upsertSession({ session_key: '123:5379', chat_id: '123', thread_id: '5379', claude_session_id: 'abc' });
    const row = db.getSession('123:5379');
    assert.equal(row.thread_id, '5379');
  });

  test('touchSession bumps last_active_ts only', () => {
    db.upsertSession({ session_key: '1', chat_id: '1', claude_session_id: 'abc', ts: 1000 });
    db.touchSession('1', 9999);
    const row = db.getSession('1');
    assert.equal(row.last_active_ts, 9999);
    assert.equal(row.created_ts, 1000);
  });

  test('clearSessionId removes the row (schema has NOT NULL on claude_session_id)', () => {
    db.upsertSession({ session_key: '1', chat_id: '1', claude_session_id: 'stale' });
    db.clearSessionId('1');
    assert.equal(db.getSession('1'), undefined);
  });

  test('clearSessionId on missing key is a no-op', () => {
    assert.doesNotThrow(() => db.clearSessionId('nope'));
  });
});

describe('events + config_changes', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('logEvent stores kind + JSON detail', () => {
    db.logEvent('spawn-fail', { chat_id: '123', code: 1, reason: 'resume-failed' });
    const row = db.raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.kind, 'spawn-fail');
    assert.equal(row.chat_id, '123');
    assert.deepEqual(JSON.parse(row.detail_json), { code: 1, reason: 'resume-failed' });
  });

  test('logEvent with no detail writes null detail_json', () => {
    db.logEvent('polygram-start');
    const row = db.raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.detail_json, null);
  });

  test('logConfigChange records field + values + user', () => {
    db.logConfigChange({
      chat_id: '123', thread_id: '5379', field: 'model',
      old_value: 'sonnet', new_value: 'opus',
      user: 'Ivan', user_id: 111111111, source: 'command',
    });
    const row = db.raw.prepare('SELECT * FROM config_changes ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.field, 'model');
    assert.equal(row.old_value, 'sonnet');
    assert.equal(row.new_value, 'opus');
    assert.equal(row.user, 'Ivan');
    assert.equal(row.user_id, 111111111);
  });

  test('config_changes CHECK rejects bad field', () => {
    assert.throws(
      () => db.logConfigChange({ chat_id: '1', field: 'bogus', new_value: 'x' }),
      /CHECK constraint/,
    );
  });
});

describe('FTS5 search', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('inserted message is indexed and findable', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, user: 'Ivan', text: 'meeting tomorrow at noon', direction: 'in' });
    db.insertMessage({ chat_id: '1', msg_id: 2, user: 'Maria', text: 'the quick brown fox', direction: 'in' });
    const hits = db.raw.prepare(`
      SELECT m.msg_id, m.text FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      WHERE messages_fts MATCH 'meeting'
    `).all();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].msg_id, 1);
  });

  test('edited message updates FTS index', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'original about cats', direction: 'in' });
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'edited about dogs', direction: 'in' });
    const catHits = db.raw.prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'cats'`).get();
    const dogHits = db.raw.prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'dogs'`).get();
    assert.equal(catHits.c, 0);
    assert.equal(dogHits.c, 1);
  });

  test('deleted message removes from FTS index', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'something unique', direction: 'in' });
    db.raw.prepare('DELETE FROM messages WHERE msg_id=1').run();
    const hits = db.raw.prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'unique'`).get();
    assert.equal(hits.c, 0);
  });

  test('unicode61 tokenizer handles cyrillic + diacritics', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, user: 'Дина', text: 'Привет мир', direction: 'in' });
    const hits = db.raw.prepare(`
      SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'привет'
    `).get();
    assert.equal(hits.c, 1, 'search should be case-insensitive across scripts');
  });
});

describe('uniqueness + constraints', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('same msg_id in different chats is allowed', () => {
    db.insertMessage({ chat_id: '1', msg_id: 100, text: 'a', direction: 'in' });
    db.insertMessage({ chat_id: '2', msg_id: 100, text: 'b', direction: 'in' });
    const count = db.raw.prepare('SELECT COUNT(*) as c FROM messages WHERE msg_id=100').get();
    assert.equal(count.c, 2);
  });

  test('multiple pending rows (negative msg_ids) coexist', () => {
    db.insertOutboundPending({ chat_id: '1', text: 'a', bot_name: 'shumabit', pending_id: -1 });
    db.insertOutboundPending({ chat_id: '1', text: 'b', bot_name: 'shumabit', pending_id: -2 });
    const count = db.raw.prepare(`SELECT COUNT(*) as c FROM messages WHERE status='pending'`).get();
    assert.equal(count.c, 2);
  });
});

describe('busy_timeout + concurrent access', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('second connection can read while first writes (WAL)', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'hello', direction: 'in' });
    const db2 = open(dbPath);
    const row = db2.raw.prepare('SELECT text FROM messages WHERE msg_id=1').get();
    assert.equal(row.text, 'hello');
    db2.raw.close();
  });

  test('busy_timeout is set to 5000ms', () => {
    assert.equal(db.raw.pragma('busy_timeout', { simple: true }), 5000);
  });
});

describe('getMessage', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('returns null when message not found', () => {
    assert.equal(db.getMessage('999', 1), undefined);
  });

  test('returns the message when found', () => {
    db.insertMessage({ chat_id: '42', msg_id: 5, text: 'hi', direction: 'in', user: 'Ivan' });
    const row = db.getMessage('42', 5);
    assert.equal(row.text, 'hi');
    assert.equal(row.user, 'Ivan');
  });

  test('accepts numeric chatId', () => {
    db.insertMessage({ chat_id: '42', msg_id: 5, text: 'hi', direction: 'in' });
    const row = db.getMessage(42, 5);
    assert.equal(row.text, 'hi');
  });

  test('returns latest when msg_id collision across chats is absent', () => {
    db.insertMessage({ chat_id: '1', msg_id: 100, text: 'a', direction: 'in' });
    db.insertMessage({ chat_id: '2', msg_id: 100, text: 'b', direction: 'in' });
    assert.equal(db.getMessage('1', 100).text, 'a');
    assert.equal(db.getMessage('2', 100).text, 'b');
  });
});

describe('chat_migrations', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('logChatMigration + resolveChatId round-trip', () => {
    db.logChatMigration('-100', '-200');
    assert.equal(db.resolveChatId('-100'), '-200');
  });

  test('resolveChatId returns input when no mapping', () => {
    assert.equal(db.resolveChatId('-999'), '-999');
  });

  test('logChatMigration replaces existing mapping', () => {
    db.logChatMigration('-100', '-200', 1000);
    db.logChatMigration('-100', '-300', 2000);
    assert.equal(db.resolveChatId('-100'), '-300');
    const row = db.raw.prepare('SELECT * FROM chat_migrations WHERE old_chat_id=?').get('-100');
    assert.equal(row.migrated_ts, 2000);
  });

  test('accepts numeric chat IDs', () => {
    db.logChatMigration(-100, -200);
    assert.equal(db.resolveChatId(-100), '-200');
  });
});

// 0.5.4 — boot replay had a dedupe bug: insertOutboundPending didn't persist
// reply_to_id, so hasOutboundReplyTo always returned false, so every restart
// re-dispatched already-answered messages. These tests pin down the wiring
// so we can't silently regress.
describe('boot replay dedupe wiring', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('insertOutboundPending persists reply_to_id', () => {
    const res = db.insertOutboundPending({
      chat_id: '1', text: 'reply', bot_name: 'b', pending_id: -1, reply_to_id: 42,
    });
    db.markOutboundSent(res.lastInsertRowid, { msg_id: 100, ts: Date.now() });
    const row = db.raw.prepare('SELECT reply_to_id FROM messages WHERE id=?').get(res.lastInsertRowid);
    assert.equal(row.reply_to_id, 42);
  });

  test('hasOutboundReplyTo finds a sent reply by inbound msg_id', () => {
    const res = db.insertOutboundPending({
      chat_id: '1', text: 'r', bot_name: 'b', pending_id: -1, reply_to_id: 7,
    });
    db.markOutboundSent(res.lastInsertRowid, { msg_id: 200, ts: Date.now() });
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 7 }), true);
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 8 }), false);
  });

  test('hasOutboundReplyTo counts pending rows (avoid double-reply on boot replay)', () => {
    // 0.6.14: an outbound row written by the previous polygram process
    // that was still 'pending' at boot means the API call may have hit
    // Telegram. Treat as replied so boot replay doesn't re-dispatch
    // the same inbound. (markStalePending will sweep these to 'failed'
    // with the 'crashed-mid-send' sentinel anyway, but we widen here in
    // case replay reads before the sweep, and to make the contract
    // robust to ordering.)
    const r = db.insertOutboundPending({ chat_id: '1', text: 'p', bot_name: 'b', pending_id: -1, reply_to_id: 9 });
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 9 }), true);
    // Sanity: a different inbound on the same chat is unaffected.
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 99 }), false);
    void r;
  });

  test('hasOutboundReplyTo ignores ordinary failed outbounds', () => {
    const r1 = db.insertOutboundPending({ chat_id: '1', text: 'p', bot_name: 'b', pending_id: -1, reply_to_id: 9 });
    db.markOutboundFailed(r1.lastInsertRowid, 'timeout');
    // failed with ordinary API error (not the crashed-mid-send sentinel)
    // → not counted; replay should re-dispatch.
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 9 }), false);
  });

  // rc.51: when an EIO orphan-loop kills a turn after sending only an
  // intermediate ack-bubble (the rc.50 incident exposed this), boot
  // replay's hasOutboundReplyTo dedupe sees the ack and skips the replay
  // — losing the user's actual answer. The fix: gate dedupe on
  // `turn_metrics`, which is only inserted when a turn definitively
  // completes. No turn_metrics row → turn never finished → replay.
  test('hasCompletedTurnFor true when turn_metrics row exists for that msg_id', () => {
    db.insertTurnMetric({
      chat_id: '1', msg_id: 158, bot_name: 'b',
      result_subtype: 'success', duration_ms: 1000,
    });
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 158 }), true);
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 159 }), false);
  });

  test('hasCompletedTurnFor false when turn errored mid-flight', () => {
    db.insertTurnMetric({
      chat_id: '1', msg_id: 158, bot_name: 'b',
      result_subtype: 'error_max_turns', duration_ms: 500, error: 'aborted',
    });
    // Turn that errored should NOT count as complete — replay if still in window.
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 158 }), false);
  });

  test('hasCompletedTurnFor distinguishes msg_id within same chat', () => {
    db.insertTurnMetric({ chat_id: '1', msg_id: 100, bot_name: 'b', result_subtype: 'success', duration_ms: 100 });
    db.insertTurnMetric({ chat_id: '1', msg_id: 200, bot_name: 'b', result_subtype: 'success', duration_ms: 100 });
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 100 }), true);
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 200 }), true);
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 300 }), false);
  });

  test('hasCompletedTurnFor scoped per-chat (same msg_id in different chats)', () => {
    db.insertTurnMetric({ chat_id: '1', msg_id: 5, bot_name: 'b', result_subtype: 'success', duration_ms: 100 });
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 5 }), true);
    assert.equal(db.hasCompletedTurnFor({ chat_id: '2', msg_id: 5 }), false);
  });

  test('hasOutboundReplyTo counts crashed-mid-send rows as replied (avoid double-reply on boot replay)', () => {
    // Polygram crashed after API call but before markOutboundSent.
    // markStalePending swept the row to status='failed' with the
    // 'crashed-mid-send' sentinel error. Telegram may have delivered
    // the message; we don't know. Treating it as un-replied caused
    // boot replay to re-dispatch the same inbound and the user got
    // the SAME answer twice.
    const r = db.insertOutboundPending({ chat_id: '1', text: 'reply', bot_name: 'b', pending_id: -1, reply_to_id: 42 });
    db.markOutboundFailed(r.lastInsertRowid, 'crashed-mid-send');
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 42 }), true);
  });

  test('getReplayCandidates default window is 3 minutes (recent stays, old drops)', () => {
    const now = Date.now();
    db.insertMessage({
      chat_id: '1', msg_id: 1, direction: 'in', source: 'tg',
      text: 'recent', ts: now - 60_000, // 1 min ago
    });
    db.insertMessage({
      chat_id: '1', msg_id: 2, direction: 'in', source: 'tg',
      text: 'ancient', ts: now - 10 * 60_000, // 10 min ago
    });
    db.setInboundHandlerStatus({ chat_id: '1', msg_id: 1, status: 'replay-pending' });
    db.setInboundHandlerStatus({ chat_id: '1', msg_id: 2, status: 'replay-pending' });
    const got = db.getReplayCandidates({ chatIds: ['1'] });
    assert.deepEqual(got.map((r) => r.msg_id), [1]);
  });

  test('getReplayCandidates excludes replay-attempted (one-shot guard)', () => {
    const now = Date.now();
    db.insertMessage({
      chat_id: '1', msg_id: 1, direction: 'in', source: 'tg',
      text: 'tried', ts: now - 30_000,
    });
    db.setInboundHandlerStatus({ chat_id: '1', msg_id: 1, status: 'replay-attempted' });
    assert.equal(db.getReplayCandidates({ chatIds: ['1'] }).length, 0);
  });
});

describe('insertTurnMetric', () => {
  // F-telemetry — one row per dispatched user turn, queryable via the
  // turn_metrics table. polygram.js inserts after every Result
  // message; this test pins the field round-trip.
  beforeEach(() => { ({ db, dbPath } = freshDb('turn-metric')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('happy-path roundtrip: full row inserts cleanly', () => {
    db.insertTurnMetric({
      chat_id: '1', thread_id: null, msg_id: 100,
      session_id: 'sess-1', bot_name: 'testbot',
      model: 'sonnet', effort: 'medium',
      input_tokens: 100, output_tokens: 50,
      cache_creation_tokens: 10, cache_read_tokens: 200,
      cost_usd: 0.0042, duration_ms: 1234,
      num_assistant_messages: 2, num_tool_uses: 1,
      result_subtype: 'success', error: null,
    });
    const row = db.raw.prepare('SELECT * FROM turn_metrics WHERE msg_id = 100').get();
    assert.equal(row.chat_id, '1');
    assert.equal(row.session_id, 'sess-1');
    assert.equal(row.input_tokens, 100);
    assert.equal(row.cache_read_tokens, 200);
    assert.equal(row.cost_usd, 0.0042);
    assert.equal(row.result_subtype, 'success');
  });

  test('numeric chat_id is stringified', () => {
    db.insertTurnMetric({ chat_id: 12345, msg_id: 1, bot_name: 'b' });
    const row = db.raw.prepare('SELECT chat_id FROM turn_metrics WHERE msg_id = 1').get();
    assert.equal(row.chat_id, '12345');
  });

  test('thread_id null vs non-null both accepted', () => {
    db.insertTurnMetric({ chat_id: '1', thread_id: null, msg_id: 1, bot_name: 'b' });
    db.insertTurnMetric({ chat_id: '1', thread_id: 42, msg_id: 2, bot_name: 'b' });
    const r1 = db.raw.prepare('SELECT thread_id FROM turn_metrics WHERE msg_id = 1').get();
    const r2 = db.raw.prepare('SELECT thread_id FROM turn_metrics WHERE msg_id = 2').get();
    assert.equal(r1.thread_id, null);
    assert.equal(r2.thread_id, '42');     // stringified
  });

  test('null/undefined optional fields stored as NULL (not 0/empty)', () => {
    db.insertTurnMetric({ chat_id: '1', msg_id: 1, bot_name: 'b' });
    const row = db.raw.prepare('SELECT * FROM turn_metrics WHERE msg_id = 1').get();
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.cost_usd, null);
    assert.equal(row.num_assistant_messages, null);
    assert.equal(row.num_tool_uses, null);
    assert.equal(row.result_subtype, null);
  });

  test('default ts is now (within 5 seconds)', () => {
    const before = Date.now();
    db.insertTurnMetric({ chat_id: '1', msg_id: 1, bot_name: 'b' });
    const row = db.raw.prepare('SELECT ts FROM turn_metrics WHERE msg_id = 1').get();
    assert.ok(row.ts >= before);
    assert.ok(row.ts <= Date.now() + 5000);
  });

  test('explicit ts is honored', () => {
    db.insertTurnMetric({ chat_id: '1', msg_id: 1, bot_name: 'b', ts: 1_700_000_000_000 });
    const row = db.raw.prepare('SELECT ts FROM turn_metrics WHERE msg_id = 1').get();
    assert.equal(row.ts, 1_700_000_000_000);
  });

  test('error result subtype: row still records (negative-path telemetry)', () => {
    db.insertTurnMetric({
      chat_id: '1', msg_id: 1, bot_name: 'b',
      result_subtype: 'error_during_execution',
      error: 'HTTP 503',
    });
    const row = db.raw.prepare('SELECT result_subtype, error FROM turn_metrics WHERE msg_id = 1').get();
    assert.equal(row.result_subtype, 'error_during_execution');
    assert.equal(row.error, 'HTTP 503');
  });

  test('multiple rows accumulate (no UPSERT — every turn is a new row)', () => {
    for (let i = 0; i < 5; i++) {
      db.insertTurnMetric({ chat_id: '1', msg_id: 100 + i, bot_name: 'b' });
    }
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM turn_metrics WHERE chat_id='1'").get();
    assert.equal(count.n, 5);
  });
});

describe('setMessageText', () => {
  // Used by polygram's stream-reply when an outbound message is edited:
  // sets messages.text to the final rendered content so the DB reflects
  // what the user actually saw (not the pre-edit placeholder).
  beforeEach(() => { ({ db, dbPath } = freshDb('set-text')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('updates the matching row\'s text', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 100, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'placeholder…',
    });
    db.setMessageText({ chat_id: '1', msg_id: 100, text: 'final answer' });
    const row = db.getMessage('1', 100);
    assert.equal(row.text, 'final answer');
  });

  test('handles null text by writing empty string (no NOT NULL violation)', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 100, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'placeholder',
    });
    assert.doesNotThrow(() => db.setMessageText({ chat_id: '1', msg_id: 100, text: null }));
    const row = db.getMessage('1', 100);
    assert.equal(row.text, '');
  });

  test('numeric chat_id is normalised to string before lookup', () => {
    // chat_id is stored as TEXT; setMessageText should coerce.
    db.insertMessage({
      chat_id: 100, msg_id: 1, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'p',
    });
    db.setMessageText({ chat_id: 100, msg_id: 1, text: 'updated' });
    const row = db.getMessage(100, 1);
    assert.equal(row.text, 'updated');
  });

  test('non-matching chat_id/msg_id is a no-op (no error, no creates)', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 100, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'unchanged',
    });
    const res = db.setMessageText({ chat_id: '999', msg_id: 999, text: 'never lands' });
    assert.equal(res.changes, 0);
    const original = db.getMessage('1', 100);
    assert.equal(original.text, 'unchanged');
    const ghost = db.getMessage('999', 999);
    assert.equal(ghost, undefined);
  });

  test('chat_id + msg_id is the composite key — same msg_id in different chats are independent', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 5, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'chat-1 msg',
    });
    db.insertMessage({
      chat_id: '2', msg_id: 5, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'chat-2 msg',
    });
    db.setMessageText({ chat_id: '1', msg_id: 5, text: 'edited chat 1' });
    assert.equal(db.getMessage('1', 5).text, 'edited chat 1');
    assert.equal(db.getMessage('2', 5).text, 'chat-2 msg');
  });

  test('long text passes through (no truncation)', () => {
    const long = 'x'.repeat(10_000);
    db.insertMessage({
      chat_id: '1', msg_id: 100, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'short',
    });
    db.setMessageText({ chat_id: '1', msg_id: 100, text: long });
    const row = db.getMessage('1', 100);
    assert.equal(row.text.length, 10_000);
  });
});

describe('findOrphanedCompactCommands — rc.61', () => {
  // Discovery: 2026-05-05 — Ivan ran /compact, polygram pushed it to
  // SDK input controller, then rc.59 deploy fired before SDK could
  // process. The compact-command event landed but no compact-boundary
  // followed. User saw "🗜️ Compacting..." then context stayed full.
  // Now: boot-time scan surfaces these as compact-failed-restart
  // events + posts to chat so user knows to re-run.

  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('returns empty when there are no compact-command events', () => {
    assert.deepEqual(db.findOrphanedCompactCommands(), []);
  });

  test('compact-command WITHOUT matching boundary → orphan returned', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, user: 'Ivan', user_id: 1,
    });
    const orphans = db.findOrphanedCompactCommands();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].session_key, '-100:24');
    assert.equal(orphans[0].chat_id, '-100');
    assert.equal(orphans[0].thread_id, '24');
    assert.equal(orphans[0].user, 'Ivan');
  });

  test('compact-command followed by matching boundary → NOT orphaned', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, user: 'Ivan', user_id: 1,
    });
    db.logEvent('compact-boundary', {
      session_key: '-100:24', trigger: 'manual', pre_tokens: 170000, post_tokens: 8000,
    });
    assert.deepEqual(db.findOrphanedCompactCommands(), []);
  });

  test('boundary BEFORE compact-command does NOT count as a match', () => {
    // Earlier compact (already handled) followed by a NEW /compact that's orphaned.
    db.logEvent('compact-boundary', {
      session_key: '-100:24', trigger: 'manual', pre_tokens: 170000, post_tokens: 8000,
    });
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, user: 'Ivan', user_id: 1,
    });
    const orphans = db.findOrphanedCompactCommands();
    assert.equal(orphans.length, 1, 'NEW /compact after earlier boundary is still orphaned');
  });

  test('boundary with DIFFERENT session_key does NOT count as a match', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, user: 'Ivan', user_id: 1,
    });
    db.logEvent('compact-boundary', {
      session_key: '-200:5', // different session
      trigger: 'manual', pre_tokens: 170000, post_tokens: 8000,
    });
    assert.equal(db.findOrphanedCompactCommands().length, 1);
  });

  test('multiple orphans returned in chronological order', () => {
    db.logEvent('compact-command', { session_key: 'a', chat_id: '1', thread_id: null });
    db.logEvent('compact-command', { session_key: 'b', chat_id: '2', thread_id: null });
    db.logEvent('compact-command', { session_key: 'c', chat_id: '3', thread_id: null });
    const orphans = db.findOrphanedCompactCommands();
    assert.equal(orphans.length, 3);
    assert.equal(orphans[0].session_key, 'a');
    assert.equal(orphans[1].session_key, 'b');
    assert.equal(orphans[2].session_key, 'c');
  });

  test('mixed: one resolved, one orphan — only the orphan returned', () => {
    db.logEvent('compact-command', { session_key: 'resolved', chat_id: '1', thread_id: null });
    db.logEvent('compact-boundary', { session_key: 'resolved', trigger: 'manual' });
    db.logEvent('compact-command', { session_key: 'orphan', chat_id: '2', thread_id: null });
    const orphans = db.findOrphanedCompactCommands();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].session_key, 'orphan');
  });

  test('respects olderThanMs cutoff', () => {
    // Force an old event by manipulating ts directly via raw insert.
    const oldTs = Date.now() - 60 * 60 * 1000; // 60 min ago
    db.raw.prepare(`
      INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)
    `).run(oldTs, '-100', 'compact-command', JSON.stringify({
      chat_id: '-100', session_key: '-100:24', user: 'Ivan',
    }));
    const recent = db.findOrphanedCompactCommands({ olderThanMs: 30 * 60 * 1000 });
    assert.deepEqual(recent, [], '60-min-old event filtered by 30-min window');
    const wide = db.findOrphanedCompactCommands({ olderThanMs: 90 * 60 * 1000 });
    assert.equal(wide.length, 1, '90-min window includes it');
  });

  test('compact-command without session_key in detail (legacy pre-rc.61) is skipped', () => {
    // Pre-rc.61 compact-command events had no session_key. Don't try
    // to surface those — we can't match them.
    db.raw.prepare(`
      INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)
    `).run(Date.now(), '-100', 'compact-command', JSON.stringify({
      chat_id: '-100', text_len: 50, user: 'Ivan', /* no session_key */
    }));
    assert.deepEqual(db.findOrphanedCompactCommands(), []);
  });
});

describe('findOrphanedCompactCommands — rc.65 returns full text', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('rc.65 events include the full /compact text in the result', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, text: '/compact keep the Q3 commission decisions',
      user: 'Ivan', user_id: 1,
    });
    const [orphan] = db.findOrphanedCompactCommands();
    assert.equal(orphan.text, '/compact keep the Q3 commission decisions');
  });

  test('pre-rc.65 events (no text field) return text=null gracefully', () => {
    // Simulate a legacy event written before rc.65.
    db.raw.prepare(`
      INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)
    `).run(Date.now(), '-100', 'compact-command', JSON.stringify({
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, /* no text field */
      user: 'Ivan', user_id: 1,
    }));
    const [orphan] = db.findOrphanedCompactCommands();
    assert.equal(orphan.text, null,
      'caller can fall back to "please retry" when text is null');
  });
});

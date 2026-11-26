'use strict';

// A press on a button that an IPC sender (agent-org) owns is recorded in
// button_presses and nowhere else; the owner reads the table to decide what
// the press means. A press that is recorded but toasted as failed makes the
// user press twice; a press that is toasted but not recorded is an approval
// that silently never happens. Both are tested here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { open } = require('../lib/db');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createHandleExtButtonCallback } = require('../lib/handlers/ext-button');

const OWNED = -1001;
const FOREIGN = -1002;
const DATA = 'ext:ao:ap:Rmwxarwe7db8def';

function fixture(t, { db: dbOverride, now = () => 1_700_000_000_000 } = {}) {
  const { db, dbPath } = freshDb('button-presses');
  t.after(() => cleanupDb(dbPath, db));
  const errors = [];
  const handle = createHandleExtButtonCallback({
    db: dbOverride || db, botName: 'test', now,
    ownsChat: (chatId) => chatId === String(OWNED),
    logEvent: (kind, detail) => db.logEvent(kind, detail),
    logger: { error: (line) => errors.push(line) },
  });
  const answers = [];
  const press = ({ id = 'cbq-1', chat = OWNED, thread = 142, msgId = 77, from = 5005, data = DATA, date = 1 } = {}) => handle({
    callbackQuery: {
      id, from: { id: from }, data,
      message: { chat: { id: chat }, message_id: msgId, date, ...(thread == null ? {} : { message_thread_id: thread }) },
    },
    answerCallbackQuery: async (opts) => { answers.push(opts); },
  });
  const rows = () => db.raw.prepare('SELECT * FROM button_presses ORDER BY id').all();
  const events = (kind) => db.raw.prepare('SELECT chat_id, detail_json FROM events WHERE kind = ?').all(kind);
  return { db, press, answers, rows, events, errors };
}

test('a press on an owned chat is stored and toasted Received', async (t) => {
  const f = fixture(t);
  await f.press();
  assert.deepEqual(f.rows(), [{
    id: 1, chat_id: String(OWNED), thread_id: '142', msg_id: 77, user_id: '5005',
    data: DATA, ts: 1_700_000_000_000, callback_query_id: 'cbq-1',
  }]);
  assert.deepEqual(f.answers, [{ text: 'Received' }]);
});

test('a redelivered press with the same callback_query_id stores nothing new', async (t) => {
  const f = fixture(t);
  await f.press();
  await f.press();
  assert.equal(f.rows().length, 1);
  // The press WAS stored, by the first delivery: the toast says so.
  assert.deepEqual(f.answers, [{ text: 'Received' }, { text: 'Received' }]);
});

test('a second press by the same person is its own row', async (t) => {
  const f = fixture(t);
  await f.press({ id: 'cbq-1' });
  await f.press({ id: 'cbq-2' });
  assert.deepEqual(f.rows().map((r) => r.callback_query_id), ['cbq-1', 'cbq-2']);
});

test('a press on a chat this bot does not own is not stored', async (t) => {
  const f = fixture(t);
  await f.press({ chat: FOREIGN });
  assert.equal(f.rows().length, 0);
  assert.deepEqual(f.answers, [{ text: 'Stale or invalid button.' }]);
  const [event] = f.events('button-press-foreign-chat');
  assert.equal(event.chat_id, String(FOREIGN));
  assert.ok(!event.detail_json.includes('Rmwxarwe7db8def'), 'the payload is never logged');
});

test('a failed insert toasts Not recorded and logs the event without the payload', async (t) => {
  const busy = Object.assign(new Error(`database is locked while storing ${DATA}`), { code: 'SQLITE_BUSY' });
  const f = fixture(t, { db: { insertButtonPress: () => { throw busy; } } });
  await f.press();
  assert.deepEqual(f.answers, [{ text: 'Not recorded, try again' }]);
  const [event] = f.events('button-press-not-recorded');
  assert.equal(event.chat_id, String(OWNED));
  const detail = JSON.parse(event.detail_json);
  assert.equal(detail.error_code, 'SQLITE_BUSY');
  assert.equal(detail.owner, 'ao');
  assert.equal(detail.msg_id, 77);
  assert.equal(detail.user_id, '5005');
  assert.equal(detail.dropped_field_count, undefined, 'every field survives the content-free event schema');
  assert.ok(!event.detail_json.includes('Rmwxarwe7db8def'));
  assert.equal(f.errors.length, 1);
  assert.ok(!f.errors[0].includes('Rmwxarwe7db8def'), 'the console line carries no payload either');
});

test('an insert against a database without the table is a failure, never a Received', async (t) => {
  const f = fixture(t);
  f.db.raw.exec('DROP TABLE button_presses');
  await f.press();
  assert.deepEqual(f.answers, [{ text: 'Not recorded, try again' }]);
});

test('a press outside a topic, or on an inaccessible message, is stored with no thread', async (t) => {
  const f = fixture(t);
  await f.press({ id: 'cbq-1', thread: null });
  await f.press({ id: 'cbq-2', thread: null, date: 0 });
  assert.deepEqual(f.rows().map((r) => r.thread_id), [null, null]);
});

test('an owner tag that is not a plain short token is logged as invalid', async (t) => {
  const busy = Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
  const f = fixture(t, { db: { insertButtonPress: () => { throw busy; } } });
  await f.press({ data: 'ext:Hello world, call me:x' });
  await f.press({ id: 'cbq-2', data: 'ext:nopayload' });
  const owners = f.events('button-press-not-recorded').map((e) => JSON.parse(e.detail_json).owner);
  assert.deepEqual(owners, ['invalid', 'invalid']);
});

test('callback data longer than Telegram allows is refused and not stored', async (t) => {
  // Telegram caps callback_data at 64 bytes; a forged query is not held to
  // that by anything but polygram.
  const f = fixture(t);
  const at64 = 'ext:ao:' + 'é'.repeat(28) + 'x';
  assert.equal(Buffer.byteLength(at64), 64);
  await f.press({ id: 'cbq-1', data: at64 });
  await f.press({ id: 'cbq-2', data: at64 + 'x' });
  assert.deepEqual(f.rows().map((r) => r.callback_query_id), ['cbq-1']);
  assert.deepEqual(f.answers, [{ text: 'Received' }, { text: 'Stale or invalid button.' }]);
  const [event] = f.events('button-press-oversized');
  assert.equal(JSON.parse(event.detail_json).bytes, 65);
});

test('the toast is still sent when telemetry itself fails', async (t) => {
  const answers = [];
  const handle = createHandleExtButtonCallback({
    db: { insertButtonPress: () => { throw new Error('locked'); } }, botName: 'test',
    ownsChat: (chatId) => chatId === String(OWNED),
    logEvent: () => { throw new Error('events table gone'); },
    logger: { error: () => { throw new Error('stderr closed'); } },
  });
  const press = (chat) => handle({
    callbackQuery: { id: 'cbq-1', from: { id: 1 }, data: DATA, message: { chat: { id: chat }, message_id: 1, date: 1 } },
    answerCallbackQuery: async (opts) => { answers.push(opts); },
  });
  await press(OWNED);
  await press(FOREIGN);
  assert.deepEqual(answers, [{ text: 'Not recorded, try again' }, { text: 'Stale or invalid button.' }]);
});

// ── migration ────────────────────────────────────────────────────────────

function legacyDb(version) {
  const dbPath = path.join(os.tmpdir(), `button-presses-v${version}-${process.pid}-${Date.now()}.db`);
  const legacy = new Database(dbPath);
  const migrations = path.join(__dirname, '..', 'migrations');
  for (const file of fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    const fileVersion = Number.parseInt(file.slice(0, 3), 10);
    if (fileVersion > version) continue;
    legacy.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
    legacy.pragma(`user_version = ${fileVersion}`);
  }
  return { dbPath, legacy };
}

test('a live v30 database gains button_presses and keeps its rows', (t) => {
  const { dbPath, legacy } = legacyDb(30);
  legacy.prepare(`INSERT INTO messages (chat_id, msg_id, text, direction, ts) VALUES ('-1001', 9, 'old row', 'in', 1)`).run();
  legacy.close();
  const db = open(dbPath);
  t.after(() => cleanupDb(dbPath, db));
  assert.equal(db.raw.pragma('user_version', { simple: true }), 31);
  assert.equal(db.raw.prepare('SELECT text FROM messages WHERE msg_id = 9').get().text, 'old row');
  const columns = db.raw.prepare('PRAGMA table_info(button_presses)').all()
    .map((c) => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(columns, [
    ['id', 'INTEGER', 0, 1],
    ['chat_id', 'TEXT', 1, 0],
    ['thread_id', 'TEXT', 0, 0],
    ['msg_id', 'INTEGER', 1, 0],
    ['user_id', 'TEXT', 1, 0],
    ['data', 'TEXT', 1, 0],
    ['ts', 'INTEGER', 1, 0],
    ['callback_query_id', 'TEXT', 1, 0],
  ]);
  const indexes = db.raw.prepare('PRAGMA index_list(button_presses)').all();
  const unique = indexes.filter((i) => i.unique).map((i) => db.raw.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name));
  assert.deepEqual(unique, [['callback_query_id']]);
  const byChatTs = db.raw.prepare('PRAGMA index_info(idx_button_presses_chat_ts)').all().map((c) => c.name);
  assert.deepEqual(byChatTs, ['chat_id', 'ts']);
});

test('row ids are never reused after the newest row is deleted', (t) => {
  // A reader that orders or pages by id must never see an old id come back.
  const { db, dbPath } = freshDb('button-presses-ids');
  t.after(() => cleanupDb(dbPath, db));
  const row = (id) => ({ chat_id: '-1001', thread_id: null, msg_id: 1, user_id: '5', data: 'ext:ao:x', ts: 1, callback_query_id: id });
  db.insertButtonPress(row('a'));
  db.raw.exec('DELETE FROM button_presses');
  db.insertButtonPress(row('b'));
  assert.equal(db.raw.prepare('SELECT id FROM button_presses').get().id, 2);
});

test('insertButtonPress reports whether the press is new', (t) => {
  const { db, dbPath } = freshDb('button-presses-insert');
  t.after(() => cleanupDb(dbPath, db));
  const row = { chat_id: '-1001', thread_id: '3', msg_id: 1, user_id: '5', data: 'ext:ao:x', ts: 1, callback_query_id: 'q1' };
  assert.deepEqual(db.insertButtonPress(row), { inserted: true });
  assert.deepEqual(db.insertButtonPress({ ...row, data: 'ext:ao:other' }), { inserted: false });
  assert.equal(db.raw.prepare('SELECT data FROM button_presses').get().data, 'ext:ao:x', 'a redelivery never rewrites the stored press');
});

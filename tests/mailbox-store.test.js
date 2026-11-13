'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { open } = require('../lib/db');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createMailboxStore } = require('../lib/mailbox/store');

function fixture(t) {
  const { db, dbPath } = freshDb('mailbox-store');
  t.after(() => cleanupDb(dbPath, db));
  let clock = 1000000;
  const store = createMailboxStore(db.raw, { botName: 'test', now: () => clock });
  return { db, store, advance(ms) { clock += ms; }, now: () => clock };
}
const message = (over = {}) => ({ id: 'm_0000000000000001', kind: 'ask', from: 'role:orchestrator', to: 'role:marketing',
  routeId: 'marketing', body: 'What is the campaign budget?', inReplyTo: null, depth: 1, bodyHash: 'h1', ...over });

test('migration 024 creates the mailbox table', (t) => {
  const { db } = fixture(t);
  const columns = db.raw.prepare('PRAGMA table_info(mailbox_messages)').all().map((c) => c.name);
  assert.deepEqual(columns.slice(0, 12), ['id', 'bot_name', 'kind', 'from_addr', 'to_addr', 'route_id', 'body', 'in_reply_to', 'depth', 'body_hash', 'notice_sent', 'created_at']);
  assert.throws(() => db.raw.prepare(`INSERT INTO mailbox_messages(id,bot_name,kind,from_addr,to_addr,route_id,body,depth,body_hash,created_at)
    VALUES ('m_x','test','forward','role:a','role:b','b','x',1,'h',1)`).run(), /CHECK/);
});

test('migrations 025 and 026 add the idempotency key, ref and origin name columns and bump the schema version', (t) => {
  const { db } = fixture(t);
  assert.equal(db.raw.pragma('user_version', { simple: true }), 26);
  const columns = db.raw.prepare('PRAGMA table_info(mailbox_messages)').all().map((c) => c.name);
  assert.deepEqual(columns.slice(12), ['idem_key', 'ref', 'origin_name']);
});

// A database built by applying the migrations up to `version` by hand.
function legacyDb(version) {
  const dbPath = path.join(os.tmpdir(), `mailbox-v${version}-${process.pid}-${Date.now()}.db`);
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

test('a database at version 24 upgrades to the current schema and keeps its messages, with no key, ref or origin', (t) => {
  const { dbPath, legacy } = legacyDb(24);
  legacy.prepare(`INSERT INTO mailbox_messages(id,bot_name,kind,from_addr,to_addr,route_id,body,depth,body_hash,created_at)
    VALUES ('m_old','test','ask','role:a','role:b','b','x',1,'h',1)`).run();
  legacy.close();
  const db = open(dbPath);
  t.after(() => cleanupDb(dbPath, db));
  assert.equal(db.raw.pragma('user_version', { simple: true }), 26);
  const row = createMailboxStore(db.raw, { botName: 'test' }).get('m_old');
  assert.equal(row.body, 'x');
  assert.equal(row.idem_key, null);
  assert.equal(row.ref, null);
  assert.equal(row.origin_name, null);
});

// System messages stored before origins existed must keep depth 1 and match
// their retries, so the upgrade leaves them without an origin.
test('a database at version 25 upgrades to 26 and keeps its system messages, with no origin', (t) => {
  const { dbPath, legacy } = legacyDb(25);
  legacy.prepare(`INSERT INTO mailbox_messages(id,bot_name,kind,from_addr,to_addr,route_id,body,depth,body_hash,created_at,idem_key,ref)
    VALUES ('m_sys','test','tell','system:agent-org','role:b','b','x',1,'h',1,'task:1','notion:1')`).run();
  legacy.close();
  const db = open(dbPath);
  t.after(() => cleanupDb(dbPath, db));
  assert.equal(db.raw.pragma('user_version', { simple: true }), 26);
  const row = createMailboxStore(db.raw, { botName: 'test' }).findByKey('system:agent-org', 'task:1');
  assert.deepEqual({ id: row.id, depth: row.depth, idem_key: row.idem_key, origin_name: row.origin_name }, { id: 'm_sys', depth: 1, idem_key: 'task:1', origin_name: null });
});

test('an idempotency key is unique per sender within a bot; messages without a key are unconstrained', (t) => {
  const { db, store } = fixture(t);
  const system = (over) => message({ kind: 'tell', from: 'system:agent-org', depth: 0, idemKey: 'task:1:marketing:1', ref: 'notion:abc', ...over });
  store.insert(system({ id: 'm_1' }));
  assert.throws(() => store.insert(system({ id: 'm_2', to: 'role:ops', bodyHash: 'other' })), /UNIQUE/, 'a reused key is refused whatever it carries');
  assert.doesNotThrow(() => store.insert(system({ id: 'm_3', from: 'system:other' })), 'each sender has its own keys');
  assert.doesNotThrow(() => createMailboxStore(db.raw, { botName: 'other', now: () => 1 }).insert(system({ id: 'm_4' })), 'each bot has its own keys');
  store.insert(message({ id: 'm_5' }));
  store.insert(message({ id: 'm_6' }));
  assert.equal(store.get('m_5').idem_key, null, 'role messages carry no key');
});

test('a message is found by its sender and key, scoped to the bot', (t) => {
  const { db, store } = fixture(t);
  store.insert(message({ id: 'm_1', kind: 'tell', from: 'system:agent-org', depth: 0, idemKey: 'k1', ref: 'notion:abc' }));
  const found = store.findByKey('system:agent-org', 'k1');
  assert.equal(found.id, 'm_1');
  assert.equal(found.idem_key, 'k1');
  assert.equal(found.ref, 'notion:abc');
  assert.equal(store.findByKey('system:agent-org', 'k2'), null);
  assert.equal(store.findByKey('system:other', 'k1'), null);
  assert.equal(createMailboxStore(db.raw, { botName: 'other' }).findByKey('system:agent-org', 'k1'), null);
});

test('a stored message reads back with every field', (t) => {
  const { store, now } = fixture(t);
  store.insert(message());
  assert.deepEqual(store.get('m_0000000000000001'), {
    id: 'm_0000000000000001', bot_name: 'test', kind: 'ask', from_addr: 'role:orchestrator', to_addr: 'role:marketing',
    route_id: 'marketing', body: 'What is the campaign budget?', in_reply_to: null, depth: 1, body_hash: 'h1', notice_sent: 0, created_at: now(),
    idem_key: null, ref: null, origin_name: null,
  });
  assert.equal(store.get('m_missing'), null);
});

test('messages are scoped to their bot', (t) => {
  const { db, store } = fixture(t);
  store.insert(message());
  const other = createMailboxStore(db.raw, { botName: 'other', now: () => 1 });
  assert.equal(other.get('m_0000000000000001'), null);
});

test('the unique index allows exactly one reply per ask', (t) => {
  const { store } = fixture(t);
  store.insert(message());
  store.insert(message({ id: 'm_r1', kind: 'reply', from: 'role:marketing', to: 'role:orchestrator', routeId: 'orchestrator', inReplyTo: 'm_0000000000000001' }));
  assert.throws(() => store.insert(message({ id: 'm_r2', kind: 'reply', from: 'role:marketing', to: 'role:orchestrator', routeId: 'orchestrator', inReplyTo: 'm_0000000000000001' })), /UNIQUE/);
  assert.equal(store.replyTo('m_0000000000000001').id, 'm_r1');
  assert.equal(store.replyTo('m_r1'), null);
});

test('a reply must reference a stored message', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.insert(message({ id: 'm_r1', kind: 'reply', inReplyTo: 'm_nothing' })), /FOREIGN KEY/);
});

test('the pair count covers asks and tells since a cutoff, never replies or other pairs', (t) => {
  const { store, advance, now } = fixture(t);
  store.insert(message({ id: 'm_1' }));
  advance(1000);
  const cutoff = now();
  store.insert(message({ id: 'm_2', kind: 'tell' }));
  store.insert(message({ id: 'm_3', from: 'role:ops' }));
  store.insert(message({ id: 'm_4', kind: 'reply', inReplyTo: 'm_1' }));
  assert.equal(store.countPair('role:orchestrator', 'role:marketing', cutoff), 1, 'the cutoff is inclusive');
  assert.equal(store.countPair('role:orchestrator', 'role:marketing', 0), 2);
});

test('a duplicate is the latest same-pair, same-kind, same-hash message since the cutoff', (t) => {
  const { store, advance, now } = fixture(t);
  store.insert(message({ id: 'm_1' }));
  advance(10);
  store.insert(message({ id: 'm_2' }));
  store.insert(message({ id: 'm_3', kind: 'tell' }));
  assert.equal(store.findDuplicate('role:orchestrator', 'role:marketing', 'ask', 'h1', 0).id, 'm_2');
  assert.equal(store.findDuplicate('role:orchestrator', 'role:marketing', 'tell', 'h1', 0).id, 'm_3');
  assert.equal(store.findDuplicate('role:orchestrator', 'role:marketing', 'ask', 'h1', now() + 1), null);
  assert.equal(store.findDuplicate('role:orchestrator', 'role:marketing', 'ask', 'other', 0), null);
  assert.equal(store.findDuplicate('role:orchestrator', 'role:ops', 'ask', 'h1', 0), null);
  store.markNoticeSent('m_2');
  assert.equal(store.findDuplicate('role:orchestrator', 'role:marketing', 'ask', 'h1', 0).id, 'm_1', 'a message with a notice no longer matches');
  store.markNoticeSent('m_1');
  assert.equal(store.findDuplicate('role:orchestrator', 'role:marketing', 'ask', 'h1', 0), null);
});

const job = (db, routeId, requestId, state) => db.raw.prepare(`INSERT INTO external_jobs(bot_name,route_id,request_id,content_hash,task,payload,target,session_key,state,created_at,updated_at)
  VALUES ('test',?,?,'h','t','{}','{}','s',?,1,1)`).run(routeId, requestId, state);

test('notice candidates are asks with no reply and no notice, oldest first', (t) => {
  const { db, store } = fixture(t);
  store.insert(message({ id: 'm_1' }));
  store.insert(message({ id: 'm_2' }));
  store.insert(message({ id: 'm_3', kind: 'tell' }));
  store.insert(message({ id: 'm_4' }));
  store.insert(message({ id: 'm_r', kind: 'reply', inReplyTo: 'm_2', routeId: 'orchestrator' }));
  job(db, 'orchestrator', 'mailbox:m_r', 'failed');
  store.markNoticeSent('m_4');
  assert.deepEqual(store.noticeCandidates().map((row) => row.id), ['m_1'], 'an ask with a reply is reported through its reply');
  store.markNoticeSent('m_1');
  assert.deepEqual(store.noticeCandidates(), []);
});

test('undelivered replies are failed, interrupted or uncertain replies without their own notice', (t) => {
  const { db, store } = fixture(t);
  store.insert(message({ id: 'm_1' }));
  store.insert(message({ id: 'm_r', kind: 'reply', inReplyTo: 'm_1', routeId: 'orchestrator' }));
  store.markNoticeSent('m_1');
  job(db, 'orchestrator', 'mailbox:m_r', 'queued');
  for (const state of ['queued', 'running', 'succeeded']) {
    db.raw.prepare("UPDATE external_jobs SET state=? WHERE request_id='mailbox:m_r'").run(state);
    assert.deepEqual(store.undeliveredReplies(), [], state);
  }
  for (const state of ['failed', 'interrupted', 'unknown']) {
    db.raw.prepare("UPDATE external_jobs SET state=? WHERE request_id='mailbox:m_r'").run(state);
    assert.deepEqual(store.undeliveredReplies().map((row) => row.id), ['m_r'], `${state}, even after the ask had a notice`);
  }
  job(db, 'orchestrator', 'mailbox-notice:m_r', 'queued');
  assert.deepEqual(store.undeliveredReplies(), [], 'a reply with its own notice is done');
});

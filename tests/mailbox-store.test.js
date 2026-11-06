'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
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

test('migration 024 creates the mailbox table and bumps the schema version', (t) => {
  const { db } = fixture(t);
  assert.equal(db.raw.pragma('user_version', { simple: true }), 24);
  const columns = db.raw.prepare('PRAGMA table_info(mailbox_messages)').all().map((c) => c.name);
  assert.deepEqual(columns, ['id', 'bot_name', 'kind', 'from_addr', 'to_addr', 'route_id', 'body', 'in_reply_to', 'depth', 'body_hash', 'notice_sent', 'created_at']);
  assert.throws(() => db.raw.prepare(`INSERT INTO mailbox_messages(id,bot_name,kind,from_addr,to_addr,route_id,body,depth,body_hash,created_at)
    VALUES ('m_x','test','forward','role:a','role:b','b','x',1,'h',1)`).run(), /CHECK/);
});

test('a stored message reads back with every field', (t) => {
  const { store, now } = fixture(t);
  store.insert(message());
  assert.deepEqual(store.get('m_0000000000000001'), {
    id: 'm_0000000000000001', bot_name: 'test', kind: 'ask', from_addr: 'role:orchestrator', to_addr: 'role:marketing',
    route_id: 'marketing', body: 'What is the campaign budget?', in_reply_to: null, depth: 1, body_hash: 'h1', notice_sent: 0, created_at: now(),
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

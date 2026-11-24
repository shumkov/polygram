'use strict';

// Ivan's history read policy for a roles bot with people's assistants:
// - the operator's admin chat reads every chat;
// - a person's DM is private to its owner (and the admin);
// - a person's assistant may read a role's topic only while its person is a
//   member of that role's Telegram group. Membership comes from the mailbox
//   (canReadRoleTopic); the history scope only asks.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../lib/db');
const { createHistoryService } = require('../lib/history-scope');

const BOT = 'shumabit';
const IVAN = '68861949';
const DINA = '451328391';
const MAI = '8744283195';
const MGMT = '-1004292131077';
const MARK = '-1004462674958';

let dir;
let db;
const config = {
  bot: { adminChatId: Number(IVAN) },
  chats: {
    [IVAN]: { bot: BOT }, [DINA]: { bot: BOT }, [MAI]: { bot: BOT },
    [MGMT]: { bot: BOT, isolateTopics: true, topics: { 1041: {}, 732: {} } },
    [MARK]: { bot: BOT, isolateTopics: true, topics: { 406: {} } },
  },
};
// What the mailbox answers: Dina is in UMI management, Mai is not; finance
// lives in management topic 1041, cmo in the markebot's General.
const ROLE_PLACES = [{ chatId: MGMT, threadId: '1041', members: [IVAN, DINA] }, { chatId: MARK, threadId: null, members: [IVAN, DINA, MAI] }];
const canReadTopic = (sessionKey, { chatId, threadId = null }) => ROLE_PLACES.some((place) => place.chatId === chatId
  && place.threadId === threadId && place.members.includes(sessionKey) && sessionKey !== IVAN);
const readsRoleTopics = (sessionKey) => [DINA, MAI].includes(sessionKey);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-role-'));
  db = open(path.join(dir, `${BOT}.db`));
  const now = Date.now();
  for (const r of [
    { chat_id: IVAN, msg_id: 1, text: 'ivandm private', ts: now - 9000 },
    { chat_id: DINA, msg_id: 1, text: 'dinadm private', ts: now - 8000 },
    { chat_id: MAI, msg_id: 1, text: 'maidm private', ts: now - 7000 },
    { chat_id: MGMT, thread_id: '1041', msg_id: 2, text: 'finance runway seven months', ts: now - 6000 },
    { chat_id: MGMT, thread_id: '732', msg_id: 3, text: 'ops weekly plan', ts: now - 5000 },
    { chat_id: MGMT, thread_id: null, msg_id: 4, text: 'production general note', ts: now - 4000 },
    { chat_id: MARK, thread_id: null, msg_id: 5, text: 'cmo campaign plan', ts: now - 3000 },
    { chat_id: MARK, thread_id: '406', msg_id: 6, text: 'ads budget', ts: now - 2000 },
  ]) db.insertMessage({ thread_id: null, user_id: null, user: 'someone', direction: 'in', source: 'polygram', bot_name: BOT, ...r });
});
after(() => { try { db.raw.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

const service = () => createHistoryService({ config, db, botName: BOT, canReadTopic, readsRoleTopics });
const texts = (result) => result.rows.map((row) => row.text);
const refused = (fn) => assert.throws(fn, (error) => error.code === 'HISTORY_SCOPE');

test('an assistant reads a role topic its person can reach, and only that topic', () => {
  const svc = service();
  const token = svc.scope(DINA);
  assert.deepEqual(texts(svc.query(token, { sub: 'recent', chatId: MGMT, threadId: '1041' })), ['finance runway seven months']);
  assert.deepEqual(texts(svc.query(token, { sub: 'search', query: 'plan', chatId: MGMT, threadId: '1041' })), [],
    'a search stays inside the role\'s topic: the ops plan next door is not returned');
  assert.deepEqual(texts(svc.query(token, { sub: 'recent', chatId: MARK })), ['cmo campaign plan'], 'a role in a General reads General rows only');
});

test('an assistant cannot read a group as a whole, another topic of it, or a role its person cannot reach', () => {
  const svc = service();
  refused(() => svc.query(svc.scope(DINA), { sub: 'recent', chatId: MGMT }));
  refused(() => svc.query(svc.scope(DINA), { sub: 'recent', chatId: MGMT, threadId: '732' }));
  refused(() => svc.query(svc.scope(MAI), { sub: 'recent', chatId: MGMT, threadId: '1041' }));
  refused(() => svc.query(svc.scope(DINA), { sub: 'search', query: 'plan', chatId: 'all' }));
});

test('a DM stays private to its owner; only the admin chat reads it', () => {
  const svc = service();
  refused(() => svc.query(svc.scope(DINA), { sub: 'recent', chatId: MAI }));
  refused(() => svc.query(svc.scope(MAI), { sub: 'recent', chatId: IVAN }));
  assert.deepEqual(texts(svc.query(svc.scope(DINA), { sub: 'recent' })), ['dinadm private']);
  assert.deepEqual(texts(svc.query(svc.scope(IVAN), { sub: 'recent', chatId: DINA })), ['dinadm private']);
});

test('without the mailbox predicate nothing widens: every non-admin session reads only its own chat', () => {
  const svc = createHistoryService({ config, db, botName: BOT });
  refused(() => svc.query(svc.scope(DINA), { sub: 'recent', chatId: MGMT, threadId: '1041' }));
});

test('an assistant\'s history command says it may read the topics of roles its person can reach', () => {
  const svc = service();
  assert.match(svc.instructions(DINA), /topic of a role/);
  assert.doesNotMatch(svc.instructions(`${MGMT}:1041`), /topic of a role/);
});

test('a job turn in an assistant reads only its own chat: another session\'s message cannot send it into a role\'s topic', () => {
  const svc = service();
  const token = svc.scope(DINA);
  svc.noteJobSend({ target: { sessionKey: DINA }, routeId: `session:${DINA}`, requestId: 'mailbox:m_0000000000000001' });
  refused(() => svc.query(token, { sub: 'recent', chatId: MGMT, threadId: '1041' }));
  assert.doesNotMatch(svc.instructions(DINA, { routeId: `session:${DINA}`, requestId: 'mailbox:m_0000000000000002' }), /topic of a role/);
});


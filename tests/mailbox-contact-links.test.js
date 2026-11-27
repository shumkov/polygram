'use strict';
// Roles refer to each other and to each other's messages by link, never by a
// bare number. The mailbox knows every role's chat and topic and, once
// Telegram's receipt proves where a card landed, that card's link, so it
// hands those links to the agents: in the contacts list, in every message it
// delivers, in receipts and in the open list. A chat without links (a direct
// chat) gets none, never an invented one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const { createExternalJobTargetResolver } = require('../lib/external-jobs/runtime');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createMailboxService } = require('../lib/mailbox/service');
const { createRichSender } = require('../lib/telegram/rich-send');

// A forum with topics (photoroom's topic, cmo in its General), a supergroup
// without topics (ops), and a person's direct chat (Ivan's assistant).
const MARK = '-1004462674958';
const PLAIN = '-1002400136088';
const IVAN = '68861949';
const PHOTOROOM = `${MARK}:1306`;
const OPS = PLAIN;
const IVAN_DM = IVAN;

function rolesConfig() {
  return {
    bot: {
      adminChatId: IVAN,
      externalJobs: { enabled: true, routes: {
        photoroom: { chatId: MARK, threadId: '1306' }, cmo: { chatId: MARK, general: true }, ops: { chatId: PLAIN },
      } },
      mailbox: {
        enabled: true, mirror: 'both', systemSenders: ['agent-org'],
        roles: { photoroom: { about: 'Product photos' }, cmo: { about: 'Marketing' }, ops: { about: 'Operations' } },
        allow: { photoroom: ['*'], cmo: ['*'], ops: ['*'] },
        assistants: { ivan: IVAN },
      },
    },
    chats: {
      [MARK]: { name: 'UMI markebot', isolateTopics: true, topics: { 1306: 'Photoroom' } },
      [PLAIN]: { name: 'UMI ops' },
      [IVAN]: { name: 'Ivan DM' },
    },
  };
}
const settle = async () => { for (let n = 0; n < 30; n++) await new Promise(setImmediate); };

// Real external jobs, dispatch and mailbox over one SQLite file. Telegram is
// a stub whose receipt echoes the destination, as the Bot API does; it says
// MARK is a forum and PLAIN is not. Every prompt a session is sent is kept.
async function fixture(t) {
  const { db, dbPath } = freshDb('mailbox-contact-links');
  const config = rolesConfig();
  const resolveBackend = () => 'cli';
  const resolveTarget = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend });
  const f = { db, posts: [], prompts: [] };
  const tg = async (_bot, method, params) => {
    f.posts.push({ method, params });
    return { message_id: 3400 + f.posts.length, chat: { id: Number(params.chat_id) },
      ...(params.message_thread_id == null ? {} : { message_thread_id: Number(params.message_thread_id) }) };
  };
  const sendRich = createRichSender({ tg, botName: 'test', insertSentRow: (row) => db.insertMessage(row) });
  const runtime = { dispatch: async (job, hooks) => {
    hooks.onSend?.();
    f.prompts.push({ sessionKey: job.target.sessionKey, requestId: job.requestId, task: job.task });
    return { outcome: 'succeeded', text: '', inactive: true };
  } };
  f.jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (o, run) => run(), runtime, getMailbox: () => f.mailbox, logger: { warn() {} } }),
    checkInactive: async () => false, deliverPart: async () => ({ messageId: 1 }), logger: { error() {} } });
  f.mailbox = createMailboxService({ config, db, botName: 'test', jobs: f.jobs, resolveTarget, resolveBackend, getSessionKey, tg, sendRich, bot: {},
    getChat: async (chatId) => ({ id: Number(chatId), is_forum: String(chatId) === MARK }),
    getChatMember: async () => ({ status: 'creator' }), logger: { error() {}, warn() {} } });
  await f.mailbox.refreshMembership();
  f.jobs.start(); f.mailbox.start();
  t.after(() => { f.mailbox.stop(); f.jobs.stop(); cleanupDb(dbPath, db); });
  f.token = (sessionKey) => { f.mailbox.noteHumanPrompt(sessionKey, { operator: true }); return f.mailbox.scope(sessionKey); };
  f.person = (sessionKey) => {
    f.mailbox.noteHumanPrompt(sessionKey, { owner: 'h1' });
    f.mailbox.noteHumanDispatch(sessionKey, { newTurn: true, owner: 'h1', fromId: IVAN });
    return f.mailbox.scope(sessionKey);
  };
  f.row = (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id);
  return f;
}
const byTo = (listed) => Object.fromEntries(listed.targets.map((entry) => [entry.to, entry]));

test('the contacts list links each role\'s topic: a forum topic, a forum\'s General, a supergroup without topics, a direct chat', async (t) => {
  const f = await fixture(t);
  const contacts = byTo(await f.mailbox.directory(f.token(OPS), {}));
  assert.equal(contacts.photoroom.link, 'https://t.me/c/4462674958/1306', 'a forum topic opens by its thread id');
  assert.equal(contacts.cmo.link, 'https://t.me/c/4462674958/1', 'General of a chat Telegram says is a forum opens at /1');
  assert.ok(contacts.ivan, 'the assistant is listed');
  assert.equal('link' in contacts.ivan, false, 'a direct chat has no link, so the field is left out');

  const fromPhotoroom = byTo(await f.mailbox.directory(f.token(PHOTOROOM), {}));
  // Telegram documents no link that opens a whole private supergroup, only
  // its messages, so a role there has none rather than a guessed one.
  assert.equal('link' in fromPhotoroom.ops, false, 'a supergroup without topics has no topic link');
});

test('the assistant\'s contacts list carries the same links', async (t) => {
  const f = await fixture(t);
  const contacts = byTo(await f.mailbox.directory(f.person(IVAN_DM), {}));
  assert.equal(contacts.photoroom.link, 'https://t.me/c/4462674958/1306');
  assert.equal(contacts.cmo.link, 'https://t.me/c/4462674958/1');
});

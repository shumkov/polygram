'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createMailboxService } = require('../lib/mailbox/service');
const envelope = require('../lib/mailbox/envelope');

const routes = { orchestrator: { chatId: '-1001', threadId: '11' }, marketing: { chatId: '-1001', threadId: '12' } };
const session = (role) => `${routes[role].chatId}:${routes[role].threadId}`;
const resolveTarget = (route) => ({ chatId: route.chatId, threadId: route.threadId, sessionKey: `${route.chatId}:${route.threadId}` });
const settle = async () => { for (let n = 0; n < 10; n++) await new Promise(setImmediate); };

function fixture(t, { mirror, send, turn } = {}) {
  const { db, dbPath } = freshDb('mailbox-mirror');
  const posts = []; const errors = []; const turns = [];
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes) }, mailbox: {
    enabled: true, roles: { orchestrator: { about: 'Strategy' }, marketing: { about: 'Campaigns' } },
    allow: { orchestrator: ['*'] }, ...(mirror === undefined ? {} : { mirror }),
  } } };
  const f = { db, posts, errors, turns };
  const jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (o, run) => run(), getMailbox: () => f.mailbox,
      runtime: { dispatch: async (job, hooks) => { hooks.onSend?.(); turns.push(job.requestId); return (turn || (async () => ({ outcome: 'succeeded', inactive: true })))(job); } } }),
    deliverPart: async () => ({ messageId: 1 }), logger: { error() {} } });
  const bot = { name: 'bot' };
  const tg = async (b, method, params, meta) => {
    assert.equal(b, bot);
    posts.push({ method, params, meta, committed: db.raw.prepare('SELECT count(*) n FROM external_jobs').get().n });
    return (send || (async () => ({ message_id: posts.length })))(params);
  };
  f.mailbox = createMailboxService({ config, db, botName: 'test', jobs, resolveTarget, bot, tg, logger: { error: (m) => errors.push(m), warn() {} } });
  f.jobs = jobs; jobs.start();
  t.after(() => { f.mailbox.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  f.token = (role) => { f.mailbox.noteHumanPrompt(session(role)); return f.mailbox.scope(session(role)); };
  return f;
}

test('each message is mirrored once, as plain text, into the target topic after it commits', async (t) => {
  const f = fixture(t);
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'What is the Q3 budget?' });
  await settle();
  assert.equal(f.posts.length, 1);
  const [post] = f.posts;
  assert.equal(post.method, 'sendMessage');
  assert.deepEqual(post.params, { chat_id: '-1001', message_thread_id: '12', text: `📨 role:orchestrator → role:marketing (ask ${sent.id})\nWhat is the Q3 budget?` });
  assert.equal(post.meta.plainText, true); assert.equal(post.meta.strictDestination, true);
  assert.equal(post.meta.source, 'mailbox-mirror'); assert.equal(post.meta.sessionKey, session('marketing'));
  assert.equal(post.committed, 1, 'the post happens only after the row and its job are committed');
});

test('a reply is mirrored into the asker topic; duplicates and refusals are not mirrored', async (t) => {
  const f = fixture(t);
  const token = f.token('orchestrator');
  const question = f.mailbox.send(token, { to: 'marketing', kind: 'ask', body: 'Q' });
  f.mailbox.send(token, { to: 'marketing', kind: 'ask', body: 'Q' });
  assert.throws(() => f.mailbox.send(token, { to: 'orchestrator', kind: 'ask', body: 'self' }));
  const answer = f.mailbox.reply(f.mailbox.scope(session('marketing')), { inReplyTo: question.id, body: 'A' });
  await settle();
  assert.deepEqual(f.posts.map((post) => [post.params.message_thread_id, post.params.text]), [
    ['12', `📨 role:orchestrator → role:marketing (ask ${question.id})\nQ`],
    ['11', `📨 role:marketing → role:orchestrator (reply ${answer.id})\nA`],
  ]);
});

test('the mirror carries the redacted body', async (t) => {
  const f = fixture(t);
  f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'tell', body: 'Use AKIAABCDEFGHIJKLMNOP for uploads' });
  await settle();
  assert.doesNotMatch(f.posts[0].params.text, /AKIAABCDEFGHIJKLMNOP/);
});

test('deferred dispatch never mirrors again', async (t) => {
  let busy = true;
  const f = fixture(t, { turn: async () => (busy ? { deferred: true, reason: 'Session is busy' } : { outcome: 'succeeded', inactive: true }) });
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'tell', body: 'FYI' });
  await f.jobs.tick(); await f.jobs.tick();
  busy = false; await f.jobs.tick();
  assert.deepEqual(f.turns, [`mailbox:${sent.id}`, `mailbox:${sent.id}`, `mailbox:${sent.id}`]);
  await settle();
  assert.equal(f.posts.length, 1);
});

test('a failed mirror is logged and never blocks delivery', async (t) => {
  const f = fixture(t, { send: async () => { throw Object.assign(new Error('Call to sendMessage failed!'), { error_code: 400, description: 'Bad Request: message thread not found' }); } });
  const sent = f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' });
  assert.equal(sent.state, 'queued');
  await settle();
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], new RegExp(`mirror of ${sent.id} failed: 400 Bad Request: message thread not found`), 'Telegram API text is logged; it is not user content');
  await f.jobs.tick();
  assert.deepEqual(f.turns, [`mailbox:${sent.id}`]);
  const g = fixture(t, { send: () => { throw new Error('synchronous transport failure'); } });
  assert.doesNotThrow(() => g.mailbox.send(g.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' }));
  await settle();
  assert.equal(g.errors.length, 1);
});

test('mirror: false posts nothing', async (t) => {
  const f = fixture(t, { mirror: false });
  f.mailbox.send(f.token('orchestrator'), { to: 'marketing', kind: 'ask', body: 'Q' });
  await settle();
  assert.deepEqual(f.posts, []);
});

test('the mirror line is rendered from the stored row', () => {
  assert.equal(envelope.renderMirror({ id: 'm_1', kind: 'tell', from_addr: 'role:a', to_addr: 'role:b', body: 'hi' }), '📨 role:a → role:b (tell m_1)\nhi');
});

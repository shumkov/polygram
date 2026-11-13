'use strict';
// A forum's General topic carries no message_thread_id, and polygram runs it
// as the bare-chat session. A route opts General in explicitly with
// `general: true`; these tests pin that every stage of an external job and of
// the mailbox then treats General as an ordinary destination.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAsyncLock } = require('@shumkov/orchestra');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const {
  createExternalJobTargetResolver, createExternalJobRuntime, createAutomationCommandHandler,
  findAutomationDestination, isAutomationDestination,
} = require('../lib/external-jobs/runtime');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createReportDelivery } = require('../lib/external-jobs/delivery');
const { createMailboxService } = require('../lib/mailbox/service');

const CHAT = '-1004462674958';
const GENERAL = Object.freeze({ chatId: CHAT, general: true });
const GENERAL_TARGET = Object.freeze({ chatId: CHAT, threadId: null, sessionKey: CHAT });
const settle = async () => { for (let n = 0; n < 10; n++) await new Promise(setImmediate); };

function makeConfig(routes = { lead: { ...GENERAL } }, extra = {}) {
  return {
    bot: { operatorUserId: 7, externalJobs: { enabled: true, routes }, ...extra },
    chats: {
      [CHAT]: { isolateTopics: true, topics: { 11: 'Orchestrator', 12: 'Marketing' } },
      '-1002': { isForum: true },
      '-1003': { topics: { 5: 'Ops' } },
      7: {},
    },
  };
}
const resolverFor = (config, backend = 'cli') => createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: () => backend });

test('general: true opens a forum General topic as the bare-chat session, apart from every topic session', () => {
  const resolve = resolverFor(makeConfig());
  assert.deepEqual(resolve(GENERAL), GENERAL_TARGET);
  assert.equal(Object.isFrozen(resolve(GENERAL)), true);
  assert.deepEqual(resolve({ chatId: Number(CHAT), general: true }), GENERAL_TARGET, 'a numeric chat id names the same chat');
  assert.deepEqual(resolve({ chatId: CHAT, threadId: '11' }), { chatId: CHAT, threadId: '11', sessionKey: `${CHAT}:11` },
    'topic routes of the same chat keep their own sessions');
  for (const chatId of ['-1002', '-1003']) {
    assert.deepEqual(resolve({ chatId, general: true }), { chatId, threadId: null, sessionKey: chatId },
      'a forum without isolated topics resolves General to its one shared session');
  }
});

test('only general === true with no threadId opens General; every other shape keeps today\'s rule', () => {
  const resolve = resolverFor(makeConfig());
  for (const route of [
    { chatId: CHAT },
    { chatId: CHAT, general: 'true' },
    { chatId: CHAT, general: 1 },
    { chatId: CHAT, general: false },
  ]) assert.throws(() => resolve(route), /explicit configured topic/, JSON.stringify(route));
  assert.throws(() => resolve({ chatId: CHAT, general: true, threadId: '11' }), /General/, 'General plus a topic is ambiguous');
  assert.throws(() => resolve({ chatId: '7', general: true, threadId: '3' }), /General/);
  assert.throws(() => resolve({ chatId: '-999', general: true }), /configured chat/);
  assert.throws(() => resolverFor(makeConfig(), 'sdk')(GENERAL), /CLI/, 'the CLI-only rule still applies');
  assert.deepEqual(resolve({ chatId: '7', general: true }), resolve({ chatId: '7' }),
    'a plain chat has one conversation, so the flag changes nothing there');
});

function runtimeFixture(config) {
  const calls = [];
  const entry = { backend: 'cli', inFlight: false, probeBusyState: async () => ({ busy: false }) };
  const runtime = createExternalJobRuntime({
    config, pm: { get: () => entry }, intentLock: createAsyncLock(), getSessionKey,
    resolveBackend: () => 'cli', isPaused: () => false, isShuttingDown: () => false,
    needsAuth: () => false, awaitSessionRecovery: async () => {}, getOrSpawnForChat: async () => entry,
    sendToProcess: async (...args) => { calls.push(args); args[3].onDispatched(); return { text: 'Done.' }; },
  });
  return { runtime, calls };
}

test('a General job is sent to the General session with no thread, and held once its route stops naming General', async () => {
  const config = makeConfig();
  const f = runtimeFixture(config);
  const job = { id: 'job-1', routeId: 'lead', requestId: 'req-1', task: 'Plan the week.', payload: {}, target: GENERAL_TARGET };
  const result = await f.runtime.dispatch(job);
  assert.equal(result.outcome, 'succeeded');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], CHAT, 'delivered into the bare-chat session');
  assert.equal(f.calls[0][2].threadId, null, 'no topic is attached to the turn');
  for (const moved of [{ chatId: CHAT, threadId: '11' }, { chatId: CHAT }]) {
    config.bot.externalJobs.routes.lead = moved;
    assert.equal((await f.runtime.dispatch(job)).deferred, true, JSON.stringify(moved));
  }
  assert.equal(f.calls.length, 1, 'a frozen General job is never redirected');
});

test('a General job report posts to General without message_thread_id and is held while its route points elsewhere', async (t) => {
  const { db, dbPath } = freshDb('general-route-report');
  const config = makeConfig();
  const posts = [];
  let reject = true;
  const deliver = createReportDelivery({ bot: {}, botName: 'test', tg: async (bot, method, params, meta) => {
    posts.push({ params, meta });
    if (reject) { reject = false; throw Object.assign(new Error('Too Many Requests'), { error_code: 429 }); }
    return { message_id: 40 + posts.length };
  } });
  let clock = 1000;
  const jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget: resolverFor(config), now: () => clock,
    dispatch: async () => ({ outcome: 'succeeded', inactive: true, text: 'Done.' }), deliverPart: deliver, logger: { error() {} } });
  t.after(() => { jobs.stop(); cleanupDb(dbPath, db); });
  const input = { routeId: 'lead', requestId: 'req-1', task: 'Plan the week.', payload: {} };
  jobs.submit(input); jobs.start(); await jobs.tick();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].params, { chat_id: CHAT, text: 'Done.' }, 'General is the chat root: no message_thread_id key at all');
  assert.equal(posts[0].meta.sessionKey, CHAT);
  assert.equal(posts[0].meta.strictDestination, true);
  assert.equal(jobs.get(input).job.reportState, 'pending', 'a definite rejection leaves the part to retry');
  config.bot.externalJobs.routes.lead = { chatId: CHAT, threadId: '11' };
  clock += 61000; await jobs.tick();
  assert.equal(posts.length, 1, 'a report frozen for General is not posted into a topic');
  assert.match(jobs.get(input).job.error, /route changed/);
  config.bot.externalJobs.routes.lead = { ...GENERAL };
  clock += 61000; await jobs.tick();
  assert.equal(posts.length, 2);
  assert.equal(Object.hasOwn(posts[1].params, 'message_thread_id'), false);
  assert.equal(jobs.get(input).job.reportState, 'delivered');
});

test('/automation sent in General controls the General route; a sibling topic controls only its own route', async () => {
  const config = makeConfig({ lead: { ...GENERAL }, marketing: { chatId: CHAT, threadId: '12' } });
  const deps = { config, getSessionKey };
  const pauses = []; const replies = [];
  const handler = createAutomationCommandHandler({ ...deps, intentLock: createAsyncLock(),
    getService: () => ({ pauseSession: (...args) => pauses.push(args), status: () => ({ paused: true, pending: 0, running: 0 }) }),
    reply: async (msg, chatId, text) => replies.push({ msg, chatId, text }) });
  const inGeneral = { from: { id: 7 }, message_id: 1 };
  assert.deepEqual(findAutomationDestination(deps, CHAT, undefined), { routeId: 'lead', target: GENERAL_TARGET });
  assert.equal(isAutomationDestination(deps, CHAT, null), true, 'the operator /stop in General also pauses automation');
  assert.equal(await handler({ msg: inGeneral, chatId: CHAT, cleanText: '/automation pause' }), true);
  assert.deepEqual(pauses, [[CHAT, true]]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].msg.message_thread_id, undefined, 'the reply goes back to General');
  assert.match(replies[0].text, /^Automation: paused/);
  await handler({ msg: { ...inGeneral, message_thread_id: 12 }, chatId: CHAT, cleanText: '/automation pause' });
  assert.deepEqual(pauses[1], [`${CHAT}:12`, true], 'a topic command never pauses General');
  assert.equal(await handler({ msg: { ...inGeneral, message_thread_id: 11 }, chatId: CHAT, cleanText: '/automation pause' }), true);
  assert.equal(pauses.length, 2, 'a topic with no route controls nothing, General included');
  assert.equal(findAutomationDestination(deps, CHAT, '11'), null);
  delete config.bot.externalJobs.routes.lead;
  assert.equal(findAutomationDestination(deps, CHAT, undefined), null, 'without the route General grants no control');
});

function mailboxFixture(t) {
  const { db, dbPath } = freshDb('general-route-mailbox');
  const config = makeConfig({ lead: { ...GENERAL }, marketing: { chatId: CHAT, threadId: '12' } }, { mailbox: {
    enabled: true,
    roles: { lead: { about: 'Owns strategy' }, marketing: { about: 'Campaigns' } },
    allow: { lead: ['*'], marketing: ['lead'] },
  } });
  const resolveTarget = resolverFor(config);
  const posts = []; const sent = [];
  const f = { posts, sent };
  const jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (origin, run) => run(), getMailbox: () => f.mailbox,
      runtime: { dispatch: async (job, hooks) => { hooks.onSend?.(); sent.push(job); return { outcome: 'succeeded', inactive: true }; } } }),
    deliverPart: async () => ({ messageId: 1 }), logger: { error() {} } });
  const tg = async (bot, method, params, meta) => { posts.push({ params, meta }); return { message_id: posts.length }; };
  f.mailbox = createMailboxService({ config, db, botName: 'test', jobs, resolveTarget, bot: {}, tg, logger: { error() {}, warn() {} } });
  f.jobs = jobs; jobs.start();
  t.after(() => { f.mailbox.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  return f;
}

test('a mailbox role whose route is General sends, receives, is mirrored and replies with no special case', async (t) => {
  const f = mailboxFixture(t);
  const topicSession = `${CHAT}:12`;
  const leadToken = f.mailbox.scope(CHAT);
  assert.ok(leadToken, 'the General session holds a role token');
  assert.notEqual(f.mailbox.scope(topicSession), leadToken, 'General and the topic are different roles');

  f.mailbox.noteHumanPrompt(topicSession);
  const question = f.mailbox.send(f.mailbox.scope(topicSession), { to: 'lead', kind: 'ask', body: 'Which campaign first?' });
  await settle();
  assert.deepEqual(f.posts[0].params, { chat_id: CHAT, parse_mode: 'HTML', text: '❓ <b>marketing asks lead</b>\n<blockquote expandable>Which campaign first?</blockquote>' },
    'the mirror lands in General: no message_thread_id key');
  assert.equal(f.posts[0].meta.sessionKey, CHAT);

  await f.jobs.tick();
  assert.equal(f.sent.length, 1);
  assert.deepEqual({ ...f.sent[0].target }, GENERAL_TARGET, 'the ask is delivered into the General session');
  assert.match(f.sent[0].task, /you are role:lead/, 'General gets the role instructions like any role session');
  assert.deepEqual(f.mailbox.identify({ token: leadToken }), { role: 'lead', depth: 1 }, 'the delivered ask set the General session depth');

  const answer = f.mailbox.reply(leadToken, { inReplyTo: question.id, body: 'Spring sale.' });
  await settle(); await f.jobs.tick();
  assert.deepEqual(f.posts[1].params, { chat_id: CHAT, message_thread_id: '12', parse_mode: 'HTML', text: '↩️ <b>lead answered marketing</b>\n<blockquote expandable>Spring sale.</blockquote>' });
  assert.deepEqual({ ...f.sent[1].target }, { chatId: CHAT, threadId: '12', sessionKey: topicSession }, 'the reply goes back to the topic');
});

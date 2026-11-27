'use strict';
// The card a job's turn reacts on is the card polygram posted in that job's
// own chat: a message's card in the receiver's topic or direct chat, or a
// notice's card in the asker's topic. Never the sender's copy, never a card
// in another chat. End to end, a silent job turn leaves its card at 👍 and
// its topic saw typing while it ran.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAsyncLock } = require('@shumkov/orchestra');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const { createExternalJobRuntime, createExternalJobTargetResolver } = require('../lib/external-jobs/runtime');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createJobPresence } = require('../lib/external-jobs/presence');
const { createMailboxService, humanTurn } = require('../lib/mailbox/service');
const { resetChatTypingState } = require('../lib/telegram/typing');

const MGMT = '-1004292131077';
const DINA = '451328391';
const MAI = '8744283195';
const OPS = `${MGMT}:732`;
const FINANCE = `${MGMT}:1041`;
const flush = async () => { for (let n = 0; n < 20; n++) await new Promise(setImmediate); };

function config({ mirror = 'both', assistants = true } = {}) {
  return {
    bot: {
      externalJobs: { enabled: true, routes: { ops: { chatId: MGMT, threadId: '732' }, finance: { chatId: MGMT, threadId: '1041' } } },
      mailbox: { enabled: true, mirror, systemSenders: ['agent-org'], roles: { ops: {}, finance: {} }, allow: { ops: ['*'], finance: ['*'] },
        ...(assistants ? { assistants: { dina: DINA, mai: MAI } } : {}) },
    },
    chats: { [MGMT]: { isolateTopics: true, topics: { 732: {}, 1041: {} } }, [DINA]: {}, [MAI]: {} },
  };
}

// Real mailbox, external jobs, dispatch, runtime and presence over one
// database. The process manager is an idle Claude CLI session; `turn` decides
// how each prompt's turn ends. Telegram is recorded.
async function fixture(t, { mirror, assistants, turn = async () => ({ text: '' }), failCards = false, checkInactive = async () => true } = {}) {
  resetChatTypingState();
  const { db, dbPath } = freshDb('job-presence-wiring');
  const cfg = config({ mirror, assistants });
  const f = { db, cfg, posts: [], reactions: [], typing: [], reports: [], turns: [] };
  const resolveTarget = createExternalJobTargetResolver({ config: cfg, getSessionKey, resolveBackend: () => 'cli' });
  let messageId = 100;
  const tg = async (_bot, method, params) => {
    if (method === 'setMessageReaction') { f.reactions.push({ chatId: String(params.chat_id), messageId: params.message_id, emoji: params.reaction[0]?.emoji ?? null }); return true; }
    if (failCards) throw Object.assign(new Error('Forbidden'), { error_code: 403 });
    const sent = { message_id: ++messageId, chat: { id: Number(params.chat_id) }, ...(params.message_thread_id ? { message_thread_id: Number(params.message_thread_id) } : {}) };
    f.posts.push({ chatId: String(params.chat_id), threadId: params.message_thread_id ?? null, messageId: sent.message_id, text: params.text });
    return sent;
  };
  const bot = { api: { sendChatAction: async (chatId, _action, opts) => { f.typing.push({ chatId: String(chatId), threadId: opts.message_thread_id ?? null }); return true; } } };
  const entry = { backend: 'cli', inFlight: false, probeBusyState: async () => ({ busy: false }) };
  const runtime = createExternalJobRuntime({
    config: cfg, pm: { get: () => entry }, intentLock: createAsyncLock(), getSessionKey, resolveBackend: () => 'cli',
    isPaused: () => false, isShuttingDown: () => false, needsAuth: () => false, awaitSessionRecovery: async () => {},
    getOrSpawnForChat: async () => entry,
    sendToProcess: async (_key, prompt, context, { onDispatched }) => {
      onDispatched();
      f.turns.push({ prompt, context });
      return turn(context, f);
    },
    logger: { error() {}, warn() {} },
  });
  const presence = createJobPresence({ bot, tg, botName: 'shumabit', typingIntervalMs: 20, logger: { error() {}, warn() {} } });
  f.jobs = createExternalJobService({ config: cfg, db, botName: 'shumabit', resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (_origin, run) => run(), runtime, getMailbox: () => f.mailbox,
      getPresence: () => presence, logger: { warn() {} } }),
    checkInactive, deliverPart: async (job, part) => { f.reports.push(part.text); return { messageId: 1 }; }, logger: { error() {} } });
  const members = { [MGMT]: { [DINA]: 'member', [MAI]: 'member' } };
  f.make = () => createMailboxService({ config: cfg, db, botName: 'shumabit', jobs: f.jobs, resolveTarget, resolveBackend: () => 'cli', getSessionKey,
    tg, bot: {}, sendRich: async () => ({ wentRich: false, fallback: 'unsupported' }),
    getChatMember: async (chatId, userId) => ({ status: members[chatId]?.[String(userId)] ?? 'left' }), logger: { error() {}, warn() {} } });
  f.mailbox = f.make();
  if (assistants !== false) await f.mailbox.refreshMembership();
  t.after(() => { f.mailbox.stop(); f.jobs.stop(); cleanupDb(dbPath, db); });
  f.role = (key) => { f.mailbox.noteHumanPrompt(key, { operator: true }); return f.mailbox.scope(key); };
  f.person = (chatId) => {
    const owner = humanTurn(chatId, 1);
    f.mailbox.noteHumanPrompt(chatId, { operator: false, owner });
    f.mailbox.noteHumanDispatch(chatId, { newTurn: true, owner, fromId: Number(chatId), idle: true });
    return f.mailbox.scope(chatId);
  };
  f.cardIn = (chatId, threadId = null) => f.posts.filter((p) => p.chatId === chatId && String(p.threadId ?? '') === String(threadId ?? ''));
  f.on = (messageIdOf) => f.reactions.filter((r) => r.messageId === messageIdOf).map((r) => r.emoji);
  return f;
}
const job = (requestId, target = { chatId: MGMT, threadId: '1041', sessionKey: FINANCE }) => ({ requestId, target });

test('a message\'s job reacts on its card in the receiver\'s topic, never on the sender\'s copy', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const sent = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'ask', body: 'What is the runway?' });
  const card = await f.mailbox.cardFor(job(`mailbox:${sent.id}`));
  await f.mailbox.cardsSettled();
  const [target] = f.cardIn(MGMT, '1041');
  assert.ok(target, 'the target card was posted');
  assert.deepEqual(card, { chatId: MGMT, threadId: '1041', messageId: target.messageId });
  assert.equal(f.cardIn(MGMT, '732').length, 1, 'the sender\'s copy exists but is not the job\'s card');
});

test('a message to a person\'s assistant reacts on the card in the person\'s direct chat', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const sent = f.mailbox.send(f.role(OPS), { to: 'mai', kind: 'ask', body: 'Can Mai approve the budget?' });
  const card = await f.mailbox.cardFor(job(`mailbox:${sent.id}`, { chatId: MAI, threadId: null, sessionKey: MAI }));
  const [dm] = f.cardIn(MAI);
  assert.deepEqual(card, { chatId: MAI, threadId: null, messageId: dm.messageId });
});

test('a notice reacts on its notice card in the asker\'s topic', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.jobs.start(); f.mailbox.start();
  const sent = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'ask', body: 'What is the runway?' });
  await f.mailbox.cardsSettled(); await f.jobs.tick();
  await f.mailbox.tick();
  const card = await f.mailbox.cardFor(job(`mailbox-notice:${sent.id}`, { chatId: MGMT, threadId: '732', sessionKey: OPS }));
  const notice = f.cardIn(MGMT, '732').at(-1);
  assert.match(notice.text, /No answer/);
  assert.deepEqual(card, { chatId: MGMT, threadId: '732', messageId: notice.messageId });
});

test('no card, no reaction: mirroring off, a card that failed to post, a job that is not mail', { timeout: 5000 }, async (t) => {
  const off = await fixture(t, { mirror: false, assistants: false });
  const quiet = off.mailbox.send(off.role(OPS), { to: 'finance', kind: 'tell', body: 'x' });
  assert.equal(off.mailbox.cardFor(job(`mailbox:${quiet.id}`)), null);
  assert.equal(off.mailbox.cardFor(job('notifications:1')), null);
  const failing = await fixture(t, { failCards: true });
  const lost = failing.mailbox.send(failing.role(OPS), { to: 'finance', kind: 'tell', body: 'y' });
  assert.equal(await failing.mailbox.cardFor(job(`mailbox:${lost.id}`)), null);
});

test('after a restart no card is known, so a queued job types without reactions', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const topic = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'tell', body: 'x' });
  await f.mailbox.cardsSettled();
  f.mailbox.stop();
  f.mailbox = f.make();
  assert.equal(f.mailbox.cardFor(job(`mailbox:${topic.id}`)), null);
});

// The card is registered in the same synchronous step that commits the
// message, so even a drain pass already running cannot claim the job first.
// A direct chat's delivery does not wait for its card, so nothing else hides
// a late registration.
test('a job claimed by a drain already in progress still finds its card', { timeout: 5000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { checkInactive: (queued) => (queued.requestId === 'stuck:1' ? gate : Promise.resolve(true)) });
  f.jobs.start();
  // A job of uncertain outcome in another session holds the next drain pass
  // in its inactivity check.
  f.jobs.submit({ routeId: 'finance', requestId: 'stuck:1', task: 'x', payload: {} });
  f.db.raw.prepare("UPDATE external_jobs SET state='unknown', inactive=0 WHERE request_id='stuck:1'").run();
  const pass = f.jobs.tick();
  await flush();
  const sent = f.mailbox.send(f.role(OPS), { to: 'mai', kind: 'tell', body: 'Sent while a drain pass runs.' });
  assert.equal(f.turns.length, 0, 'the pass is still in its inactivity check');
  release(false);
  await pass;
  await flush();
  const [card] = f.cardIn(MAI);
  assert.ok(f.turns.some((turn) => turn.prompt.includes(sent.id)), 'the pass that was running delivered the message');
  assert.deepEqual(f.on(card.messageId), ['🤔', '👍']);
});

test('end to end: a silent job turn types in its topic and leaves its card at 👍 with no report', { timeout: 5000 }, async (t) => {
  let typedWhileRunning = 0;
  const f = await fixture(t, { turn: async (context, fx) => {
    assert.ok(context.reactor, 'the card reactor rides the turn context');
    await new Promise((resolve) => setTimeout(resolve, 50));
    typedWhileRunning = fx.typing.length;
    context.reactor.setState('CODING');
    return { text: '' };
  } });
  f.jobs.start();
  const sent = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'tell', body: 'Budget review moved to Monday.' });
  await f.mailbox.cardsSettled();
  for (let n = 0; n < 3; n++) await f.jobs.tick();
  await flush();
  const [card] = f.cardIn(MGMT, '1041');
  assert.deepEqual(f.on(card.messageId), ['🤔', '👨‍💻', '👍']);
  assert.ok(typedWhileRunning >= 2, 'typing repeated while the turn ran');
  assert.ok(f.typing.every((call) => call.chatId === MGMT && call.threadId === 1041), 'typing shows only in the job\'s topic');
  const typed = f.typing.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.typing.length, typed, 'typing stopped with the turn');
  assert.deepEqual(f.reports, [], 'a silent turn posts no report');
  assert.equal(f.db.raw.prepare("SELECT state FROM external_jobs WHERE request_id=?").get(`mailbox:${sent.id}`).state, 'succeeded');
});

test('end to end: a failed job turn leaves its card at 🤯, and its delivery state is the turn\'s own', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { turn: async () => ({ error: 'provider rejected' }) });
  f.jobs.start();
  const sent = f.mailbox.send(f.person(DINA), { to: 'mai', kind: 'ask', body: 'Are you free on Friday?' });
  await f.mailbox.cardsSettled();
  for (let n = 0; n < 3; n++) await f.jobs.tick();
  await flush();
  const [card] = f.cardIn(MAI);
  assert.deepEqual(f.on(card.messageId), ['🤔', '🤯']);
  assert.equal(f.db.raw.prepare("SELECT state FROM external_jobs WHERE request_id=?").get(`mailbox:${sent.id}`).state, 'failed');
});

test('end to end: Telegram refusing every reaction and typing call leaves the job succeeded', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.jobs.start();
  // Every display call fails from here on; the cards were posted before.
  const sent = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'tell', body: 'x' });
  await f.mailbox.cardsSettled();
  f.reactions.push = () => { throw Object.assign(new Error('Bad Request: REACTION_INVALID'), { error_code: 400 }); };
  f.typing.push = () => { throw Object.assign(new Error('Forbidden'), { error_code: 403 }); };
  for (let n = 0; n < 3; n++) await f.jobs.tick();
  await flush();
  assert.equal(f.db.raw.prepare("SELECT state FROM external_jobs WHERE request_id=?").get(`mailbox:${sent.id}`).state, 'succeeded');
});

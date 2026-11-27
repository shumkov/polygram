'use strict';
// People's assistants in a roles bot: a person's direct chat with the bot is
// their assistant inside the organization. Access between a role and an
// assistant mirrors the person's membership of the role's Telegram group; an
// assistant acts only in a turn its person started; a person outside a
// role's group can never reach that role, and the role can reach them only
// with a one-way tell that a member of its group lets go.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const { createExternalJobTargetResolver } = require('../lib/external-jobs/runtime');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createMailboxService, humanTurn, jobTurn } = require('../lib/mailbox/service');
const rules = require('../lib/mailbox/rules');
const envelope = require('../lib/mailbox/envelope');

const MGMT = '-1004292131077';
const MARK = '-1004462674958';
const GROUP = '-1002400136088';
const IVAN = '68861949';
const DINA = '451328391';
const MAI = '8744283195';
const FINANCE = `${MGMT}:1041`;
const OPS = `${MGMT}:732`;

function umiConfig({ mailbox = {}, assistants = { ivan: IVAN, dina: DINA, mai: MAI }, roles = null, routes = null, chats = {} } = {}) {
  return {
    bot: {
      adminChatId: IVAN,
      externalJobs: { enabled: true, routes: routes ?? {
        ops: { chatId: MGMT, threadId: '732' }, finance: { chatId: MGMT, threadId: '1041' },
        cmo: { chatId: MARK, general: true }, ads: { chatId: MARK, threadId: '406' },
      } },
      mailbox: {
        enabled: true, mirror: 'both', systemSenders: ['agent-org'],
        roles: roles ?? { ops: { about: 'Operations' }, finance: { about: 'Finance' }, cmo: { about: 'Marketing' }, ads: { about: 'Ads' } },
        allow: { ops: ['*'], finance: ['*'], cmo: ['ads', 'ops'], ads: ['cmo', 'ops'] },
        ...(assistants ? { assistants } : {}),
        ...mailbox,
      },
    },
    chats: {
      [MGMT]: { name: 'UMI management', isolateTopics: true, topics: { 732: {}, 1041: {} } },
      [MARK]: { name: 'UMI markebot', isolateTopics: true, topics: { 406: {} } },
      [GROUP]: { name: 'UMI Group', isolateTopics: true, topics: { 2: 'Marketing' } },
      [IVAN]: { name: 'Ivan DM', pm: 'codex' },
      [DINA]: { name: '@Dina_Shumkova' },
      [MAI]: { name: '@MaiPrawanrat' },
      ...chats,
    },
  };
}
const backendOf = ({ chatId }) => (String(chatId) === IVAN ? 'codex' : 'cli');
// Telegram's answers as verified on 2026-11-24: Ivan and Dina are in UMI
// management, everyone is in UMI markebot.
const MEMBERS = {
  [MGMT]: { [IVAN]: 'creator', [DINA]: 'member', [MAI]: 'left' },
  [MARK]: { [IVAN]: 'creator', [DINA]: 'member', [MAI]: 'member' },
};

async function fixture(t, { config = umiConfig(), members = MEMBERS, getChatMember = null, refresh = true, resolveBackend = backendOf, failSource = null } = {}) {
  const { db, dbPath } = freshDb('mailbox-assistants');
  let clock = 1_000_000;
  const now = () => clock;
  const resolveTarget = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend });
  const jobs = createExternalJobService({ config, db, botName: 'shumabit', resolveTarget,
    dispatch: async () => ({ outcome: 'succeeded', inactive: true }), deliverPart: async () => ({}), logger: { error() {} } });
  // Every card attempt: rich first (recorded, refused), then the HTML send.
  const posts = [];
  const richAttempts = [];
  let messageId = 100;
  const tg = async (_bot, method, params, meta) => {
    if (failSource && meta?.source === failSource) throw Object.assign(new Error('Forbidden'), { error_code: 403 });
    const sent = { message_id: ++messageId, chat: { id: Number(params.chat_id) },
      ...(params.message_thread_id ? { message_thread_id: Number(params.message_thread_id) } : {}) };
    posts.push({ method, params, meta, messageId: sent.message_id });
    return sent;
  };
  const sendRich = async (args) => { richAttempts.push(args); return { wentRich: false, fallback: 'unsupported' }; };
  let answers = members;
  const lookup = getChatMember ?? (async (chatId, userId) => ({ status: answers[chatId]?.[String(userId)] ?? 'left' }));
  const service = createMailboxService({ config, db, botName: 'shumabit', jobs, resolveTarget, resolveBackend, getSessionKey,
    tg, bot: {}, sendRich, getChatMember: lookup, now, logger: { error() {}, warn() {} } });
  t.after(() => { service.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  if (refresh) await service.refreshMembership();
  let turn = 0;
  // The person writes in their DM; the dispatcher decides it starts a new turn.
  const person = (chatId, { fromId = chatId, idle = true } = {}) => {
    const owner = humanTurn(chatId, ++turn);
    service.noteHumanPrompt(chatId, { operator: false, owner });
    service.noteHumanDispatch(chatId, { newTurn: true, owner, fromId: Number(fromId), idle });
    return { token: service.scope(chatId), owner };
  };
  // The person writes while a turn runs, and the message folds into it.
  const fold = (chatId, { operator = false } = {}) => {
    const owner = humanTurn(chatId, ++turn);
    service.noteHumanPrompt(chatId, { operator, newTurn: true, owner });
    service.noteHumanDispatch(chatId, { newTurn: false, owner, fromId: Number(chatId) });
    return service.scope(chatId);
  };
  // A human writes in a role's topic.
  const roleTurn = (key) => { service.noteHumanPrompt(key, { operator: true }); return service.scope(key); };
  // Another session's message, a notice or any job is sent into a session.
  const jobInto = (chatId, requestId = `mailbox:m_${String(++turn).padStart(16, '0')}`, routeId = `session:${chatId}`) => {
    const job = { target: { sessionKey: chatId }, routeId, requestId };
    service.instructions(chatId, job);
    service.noteJobSend(job);
    return { token: service.scope(chatId), job };
  };
  const row = (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id);
  const rows = () => db.raw.prepare('SELECT * FROM mailbox_messages ORDER BY rowid').all();
  const jobFor = (id) => db.raw.prepare("SELECT * FROM external_jobs WHERE request_id='mailbox:' || ?").get(id);
  const settle = () => service.cardsSettled();
  const htmlTo = (chatId) => posts.filter((p) => p.method === 'sendMessage' && p.params.chat_id === chatId).map((p) => p.params.text);
  const richTo = (chatId) => richAttempts.filter((a) => String(a.chatId) === chatId).map((a) => JSON.stringify(a.blocks));
  const press = async ({ from, data, chatId, messageId: cardMessageId }) => {
    const replies = [];
    await service.handleGoCallback({ callbackQuery: { data, from: { id: Number(from) }, message: { chat: { id: Number(chatId) }, message_id: cardMessageId } },
      answerCallbackQuery: async ({ text }) => { replies.push(text); } });
    return replies[0];
  };
  return { db, config, jobs, service, posts, person, fold, roleTurn, jobInto, row, rows, jobFor, settle, htmlTo, richTo, press,
    advance: (ms) => { clock += ms; }, setMembers: (next) => { answers = next; } };
}
const coded = (code) => (error) => error?.code === code;

test('config: an assistant names a configured direct chat that is not a role, once, in a roles bot', () => {
  const read = (config) => rules.readMailboxConfig(config.bot, createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: backendOf }), config.chats);
  assert.equal(read(umiConfig()).assistants.get('dina').label, "Dina's assistant");
  for (const [assistants, message] of [
    [{ finance: DINA }, /has a role's name/],
    [{ dina: '999' }, /must name a configured direct chat/],
    [{ dina: MGMT }, /must name a configured direct chat/],
    [{ dina: DINA, dina2: DINA }, /share a chat/],
    [{ Dina: DINA }, /Invalid mailbox assistant key/],
  ]) assert.throws(() => read(umiConfig({ assistants })), message);
  const roleInDm = umiConfig({ roles: { ops: {}, finance: {}, cmo: {}, ads: {}, desk: {} },
    routes: { ops: { chatId: MGMT, threadId: '732' }, finance: { chatId: MGMT, threadId: '1041' }, cmo: { chatId: MARK, general: true },
      ads: { chatId: MARK, threadId: '406' }, desk: { chatId: DINA } } });
  assert.throws(() => read(roleInDm), /is role desk's session/);
  assert.throws(() => read(umiConfig({ mailbox: { mirror: false } })), /need mirror on/);
  const open = umiConfig();
  open.bot.mailbox.intra = 'open';
  delete open.bot.mailbox.allow;
  assert.throws(() => read(open), /apply only to intra "roles"/);
});

test('an assistant chat on a backend the mailbox does not know fails boot', async (t) => {
  await assert.rejects(fixture(t, { resolveBackend: ({ chatId }) => (String(chatId) === MAI ? 'sdk' : 'cli') }), /mai must run on the Claude CLI or Codex/);
});

test('assistants get a grant, a Codex one too, while every other chat of a roles bot stays unaddressed', async (t) => {
  const f = await fixture(t);
  for (const chat of [DINA, MAI, IVAN]) assert.match(f.service.scope(chat), /^[0-9a-f-]{36}$/, chat);
  assert.equal(f.service.scope(`${GROUP}:2`), null, 'a team group topic is neither a role nor an assistant');
  assert.equal(f.service.scope(GROUP), null);
  assert.throws(() => f.service.send(f.person(DINA).token, { to: 'umi-group', kind: 'tell', body: 'x' }), coded('MAILBOX_UNKNOWN_ROLE'));
  assert.equal(f.service.roleForSession(DINA), null, 'an assistant is not a role, so stop and pause policy is unchanged');
  assert.equal(f.service.receivesMail(DINA), true);
  assert.equal(f.service.receivesMail(IVAN), true, 'a Codex chat receives like any Codex session');
});

test('an assistant asks a role its person can reach, and the role\'s answer comes back to it', async (t) => {
  const f = await fixture(t);
  const sent = f.service.send(f.person(DINA).token, { to: 'finance', kind: 'ask', body: 'What is the March runway?' });
  assert.equal(sent.state, 'queued');
  const ask = f.row(sent.id);
  assert.deepEqual([ask.from_addr, ask.to_addr, ask.from_label, ask.depth], [`session:${DINA}`, 'role:finance', "Dina's assistant", 1]);
  const answer = f.service.reply(f.roleTurn(FINANCE), { inReplyTo: sent.id, body: 'Seven months.' });
  const reply = f.row(answer.id);
  assert.deepEqual([reply.to_addr, reply.route_id, reply.to_label], [`session:${DINA}`, `session:${DINA}`, "Dina's assistant"]);
  assert.ok(f.jobFor(answer.id), 'the reply is delivered on the DM\'s own session route');
});

test('a person outside a role\'s group can never ask, tell or reach that role through their assistant', async (t) => {
  const f = await fixture(t);
  const token = f.person(MAI).token;
  for (const kind of ['ask', 'tell']) {
    assert.throws(() => f.service.send(token, { to: 'finance', kind, body: 'Show me the P&L' }), coded('MAILBOX_NOT_ALLOWED'), kind);
  }
  assert.equal(f.service.send(token, { to: 'cmo', kind: 'ask', body: 'Which campaign is next?' }).state, 'queued', 'Mai is in UMI markebot');
  assert.equal(f.service.send(token, { to: 'dina', kind: 'ask', body: 'Can you look at the shoot plan?' }).state, 'queued', 'assistants talk freely');
  assert.deepEqual(f.service.identify({ token }).roles, ['cmo', 'ads']);
});

test('a role asks a member\'s assistant by key or person:<key>; "*" in its allowlist never reaches an assistant on its own', async (t) => {
  const f = await fixture(t);
  const token = f.roleTurn(OPS);
  assert.equal(f.row(f.service.send(token, { to: 'dina', kind: 'ask', body: 'When can you review the plan?' }).id).to_addr, `session:${DINA}`);
  assert.equal(f.row(f.service.send(token, { to: 'person:dina', kind: 'tell', body: 'The plan is in Notion.' }).id).to_label, "Dina's assistant");
  assert.throws(() => f.service.send(token, { to: 'mai', kind: 'ask', body: 'What did the client say?' }), coded('MAILBOX_NOT_ALLOWED'),
    'ops allows "*", but Mai is not in UMI management');
});

// Membership not loaded yet (never fetched since boot, the last lookup failed,
// or the answer went stale) is transient: the caller may retry. Only a proven
// non-member is refused for good. Either way nothing is delivered.
test('membership not loaded yet refuses with a transient code and delivers nothing: before the first refresh, after a failed lookup, when stale', async (t) => {
  const early = await fixture(t, { refresh: false });
  assert.throws(() => early.service.send(early.person(DINA).token, { to: 'finance', kind: 'ask', body: 'x' }), coded('MAILBOX_MEMBERSHIP_UNKNOWN'));
  assert.throws(() => early.service.send(early.roleTurn(FINANCE), { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_MEMBERSHIP_UNKNOWN'),
    'no go card while it is unknown whether Mai is a member');
  assert.throws(() => early.service.submit({ sender: 'agent-org', to: 'person:dina', role: 'finance', body: 'Done.', key: 'k1' }), coded('MAILBOX_MEMBERSHIP_UNKNOWN'),
    'a task final waiting for membership can be retried, not dropped');
  assert.equal(early.rows().length, 0);
  await early.service.refreshMembership();
  assert.equal(early.service.submit({ sender: 'agent-org', to: 'person:dina', role: 'finance', body: 'Done.', key: 'k1' }).state, 'queued', 'the retry succeeds');

  const broken = await fixture(t, { getChatMember: async () => { throw Object.assign(new Error('Bad Gateway'), { error_code: 502 }); } });
  assert.throws(() => broken.service.send(broken.person(DINA).token, { to: 'cmo', kind: 'ask', body: 'x' }), coded('MAILBOX_MEMBERSHIP_UNKNOWN'));

  const stale = await fixture(t);
  stale.advance(11 * 60000);
  assert.throws(() => stale.service.send(stale.person(DINA).token, { to: 'finance', kind: 'ask', body: 'x' }), coded('MAILBOX_MEMBERSHIP_UNKNOWN'),
    'an answer older than two refreshes no longer counts');
});

test('a proven non-member is refused for good: left, kicked, or restricted without membership', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.send(f.person(MAI).token, { to: 'finance', kind: 'ask', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'person:mai', role: 'finance', body: 'x', key: 'k' }), coded('MAILBOX_NOT_ALLOWED'));
  const restricted = await fixture(t, { getChatMember: async (chatId, userId) => (String(userId) === DINA
    ? { status: 'restricted', is_member: chatId === MARK } : { status: 'member' }) });
  assert.deepEqual(restricted.service.identify({ token: restricted.person(DINA).token }).roles, ['cmo', 'ads'],
    'restricted counts only while still a member');
  assert.throws(() => restricted.service.send(restricted.person(DINA).token, { to: 'finance', kind: 'ask', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'));
});

test('a person who leaves the group loses access on the next refresh; a failed refresh makes it unknown, never keeps the old answer', async (t) => {
  for (const [next, code] of [
    [async (chatId, userId) => ({ status: chatId === MGMT && String(userId) === DINA ? 'left' : 'member' }), 'MAILBOX_NOT_ALLOWED'],
    [async (chatId, userId) => { if (chatId === MGMT && String(userId) === DINA) throw new Error('timeout'); return { status: 'member' }; }, 'MAILBOX_MEMBERSHIP_UNKNOWN'],
  ]) {
    let lookup = async () => ({ status: 'member' });
    const f = await fixture(t, { getChatMember: (chatId, userId) => lookup(chatId, userId) });
    const open = f.service.send(f.roleTurn(FINANCE), { to: 'dina', kind: 'ask', body: 'Approve?' });
    assert.equal(f.service.send(f.person(DINA).token, { to: 'finance', kind: 'tell', body: 'one' }).state, 'queued');
    lookup = next;
    await f.service.refreshMembership();
    assert.throws(() => f.service.send(f.person(DINA).token, { to: 'finance', kind: 'tell', body: 'two' }), coded(code));
    assert.throws(() => f.service.reply(f.person(DINA).token, { inReplyTo: open.id, body: 'Yes.' }), coded(code), 'replies too');
  }
});

test('a Codex assistant takes full part: it asks, is asked, replies, and hears about its person\'s tasks', async (t) => {
  const f = await fixture(t);
  const ask = f.service.send(f.person(IVAN).token, { to: 'finance', kind: 'ask', body: 'Runway?' });
  assert.equal(ask.state, 'queued');
  const answer = f.service.reply(f.roleTurn(FINANCE), { inReplyTo: ask.id, body: 'Seven months.' });
  assert.ok(f.jobFor(answer.id), 'the reply is delivered into the Codex chat');
  const fromDina = f.service.send(f.person(DINA).token, { to: 'ivan', kind: 'ask', body: 'Shoot budget?' });
  const fromOps = f.service.send(f.roleTurn(OPS), { to: 'ivan', kind: 'ask', body: 'Plan ok?' });
  assert.deepEqual([f.row(fromDina.id).to_addr, f.row(fromOps.id).to_addr], [`session:${IVAN}`, `session:${IVAN}`]);
  assert.equal(f.service.submit({ sender: 'agent-org', to: 'person:ivan', role: 'finance', body: 'Task done.', key: 'k-ivan' }).state, 'queued');
  assert.equal(f.service.reply(f.person(IVAN).token, { inReplyTo: fromDina.id, body: 'Approved.' }).state, 'queued');
  assert.deepEqual(f.service.identify({ token: f.person(IVAN).token }), { assistant: 'ivan', chatId: IVAN, depth: 0, roles: ['ops', 'finance', 'cmo', 'ads'], unconfirmed: [] });
  assert.match(f.service.instructions(IVAN), /reply '/);
});

test('an assistant chat moved off the CLI and Codex while running stops receiving and may only tell', async (t) => {
  let ivanBackend = 'codex';
  const f = await fixture(t, { resolveBackend: ({ chatId }) => (String(chatId) === IVAN ? ivanBackend : 'cli') });
  ivanBackend = 'sdk';
  assert.throws(() => f.service.send(f.person(IVAN).token, { to: 'finance', kind: 'ask', body: 'x' }), coded('MAILBOX_BACKEND_UNSUPPORTED'));
  assert.equal(f.service.send(f.person(IVAN).token, { to: 'finance', kind: 'tell', body: 'x' }).state, 'queued');
  assert.throws(() => f.service.send(f.person(DINA).token, { to: 'ivan', kind: 'tell', body: 'x' }), coded('MAILBOX_BACKEND_UNSUPPORTED'));
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'person:ivan', role: 'finance', body: 'x', key: 'k' }), coded('MAILBOX_BACKEND_UNSUPPORTED'));
  assert.doesNotMatch(f.service.instructions(IVAN), /reply '/);
});

test('nothing assumes a particular person is configured: a DM left out of assistants stays unaddressed', async (t) => {
  const f = await fixture(t, { config: umiConfig({ assistants: { dina: DINA, mai: MAI } }) });
  assert.equal(f.service.scope(IVAN), null, 'Ivan\'s Codex DM gets no grant');
  assert.throws(() => f.service.send(f.roleTurn(FINANCE), { to: 'ivan', kind: 'tell', body: 'x' }), coded('MAILBOX_UNKNOWN_ROLE'));
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'person:ivan', role: 'finance', body: 'x', key: 'k' }), coded('MAILBOX_UNKNOWN_ADDRESS'));
  assert.deepEqual((await f.service.directory(f.person(MAI).token, {})).targets.map((x) => x.to).sort(), ['ads', 'cmo', 'dina']);
  assert.equal(f.service.send(f.person(DINA).token, { to: 'finance', kind: 'ask', body: 'Runway?' }).state, 'queued');
});

test('a turn another session started can only tell the person: it cannot message, reply or create a task', async (t) => {
  const f = await fixture(t);
  const ask = f.service.send(f.roleTurn(FINANCE), { to: 'dina', kind: 'ask', body: 'Do you approve the March budget?' });
  const { token: tainted, job } = f.jobInto(DINA, `mailbox:${ask.id}`);
  assert.throws(() => f.service.reply(tainted, { inReplyTo: ask.id, body: 'Dina approves.' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.throws(() => f.service.send(tainted, { to: 'ops', kind: 'ask', body: 'Change the plan' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.equal(f.service.identify({ token: tainted }).depth, 2, 'agent-org sees no human asking, so it refuses tasks');

  // The person's message folded into that turn joins it and does not clear
  // it, even when the message looks like the operator's.
  assert.throws(() => f.service.reply(f.fold(DINA, { operator: true }), { inReplyTo: ask.id, body: 'Approved.' }), coded('MAILBOX_NOT_ALLOWED'));

  // Once that turn ends, her own next turn clears it, and she finds the ask
  // she still owes.
  f.service.noteTurnEnd(DINA, jobTurn(job));
  const own = f.person(DINA).token;
  assert.deepEqual(f.service.open(own, {}).toAnswer.map((a) => a.id), [ask.id]);
  assert.equal(f.service.reply(own, { inReplyTo: ask.id, body: 'Approved.' }).state, 'queued');
  assert.deepEqual(f.service.open(own, {}).toAnswer, []);
});

test('a notice or any other job sent into an assistant taints it, and its person\'s live command stops working', async (t) => {
  for (const [requestId, routeId] of [['mailbox-notice:m_0000000000000009', `session:${DINA}`], ['notifications:7', 'admin']]) {
    const f = await fixture(t);
    const ask = f.service.send(f.roleTurn(OPS), { to: 'dina', kind: 'ask', body: 'Shoot date?' });
    const live = f.person(DINA).token;
    const job = f.jobInto(DINA, requestId, routeId).token;
    for (const token of [live, job]) {
      assert.throws(() => f.service.send(token, { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'), requestId);
      assert.throws(() => f.service.reply(token, { inReplyTo: ask.id, body: 'Friday' }), coded('MAILBOX_NOT_ALLOWED'), requestId);
    }
  }
});

test('an assistant\'s grant ends with its turn, folded messages included, so a wakeup or a copied token cannot act afterwards', async (t) => {
  const f = await fixture(t);
  const ask = f.service.send(f.roleTurn(OPS), { to: 'dina', kind: 'ask', body: 'Shoot date?' });
  const { token, owner } = f.person(DINA);
  const folded = f.fold(DINA);
  f.service.noteTurnEnd(DINA, jobTurn({ routeId: 'x', requestId: 'y' }));
  assert.equal(f.service.send(folded, { to: 'mai', kind: 'tell', body: 'still my turn' }).state, 'queued', 'another turn\'s end ends nothing');
  f.service.noteTurnEnd(DINA, owner);
  for (const grant of [token, folded]) {
    assert.throws(() => f.service.send(grant, { to: 'mai', kind: 'tell', body: 'after the turn' }), coded('MAILBOX_NOT_ALLOWED'));
    assert.throws(() => f.service.reply(grant, { inReplyTo: ask.id, body: 'Friday' }), coded('MAILBOX_NOT_ALLOWED'));
    assert.equal(f.service.identify({ token: grant }).depth, 2);
  }
});

test('a message folded into a turn the mailbox does not know of ends at once', async (t) => {
  const f = await fixture(t);
  f.person(DINA);
  f.service.noteTurnEnd(DINA, 'not this one');
  const { owner } = f.person(DINA);
  f.service.noteTurnEnd(DINA, owner);
  // An untracked continuation runs; the person's follow-up folds into it.
  const folded = f.fold(DINA);
  assert.throws(() => f.service.send(folded, { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.equal(f.service.identify({ token: folded }).depth, 2);
});

test('every assistant starts tainted at boot, and only its own person clears it', async (t) => {
  const f = await fixture(t);
  f.service.noteHumanPrompt(DINA, { operator: false, owner: 'boot' });
  assert.throws(() => f.service.send(f.service.scope(DINA), { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'),
    'a turn that survived a restart may still carry another session\'s text');
  const stranger = f.person(DINA, { fromId: MAI });
  assert.throws(() => f.service.send(stranger.token, { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'), 'only the DM\'s own person clears it');
  f.service.noteTurnEnd(DINA, stranger.owner);
  assert.equal(f.service.send(f.person(DINA).token, { to: 'mai', kind: 'tell', body: 'x' }).state, 'queued');
});

test('a role is never tainted by its deliveries, so a role turn another role started can still message', async (t) => {
  const f = await fixture(t);
  const ask = f.service.send(f.roleTurn(FINANCE), { to: 'ops', kind: 'ask', body: 'Who owns the March plan?' });
  const job = f.jobInto(OPS, `mailbox:${ask.id}`, 'ops').token;
  assert.equal(f.service.send(job, { to: 'cmo', kind: 'tell', body: 'Plan is ready.' }).state, 'queued');
});

test('identify: an assistant gets its key, chat, depth and reachable roles; a role gets exactly what it got before', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.service.identify({ token: f.person(DINA).token }), { assistant: 'dina', chatId: DINA, depth: 0, roles: ['ops', 'finance', 'cmo', 'ads'], unconfirmed: [] });
  assert.deepEqual(f.service.identify({ token: f.roleTurn(OPS) }), { role: 'ops', depth: 0 });
});

test('a system sender tells an assistant about a role\'s task only if the person can reach that role, never with an origin', async (t) => {
  const f = await fixture(t);
  let n = 0;
  const submit = (input) => f.service.submit({ sender: 'agent-org', body: 'Task done: runway report.', key: `k${++n}`, ...input });
  const sent = submit({ to: 'person:dina', role: 'finance' });
  assert.deepEqual([f.row(sent.id).to_addr, f.row(sent.id).depth, f.row(sent.id).origin_name], [`session:${DINA}`, 1, null]);
  assert.throws(() => submit({ to: 'person:mai', role: 'finance' }), coded('MAILBOX_NOT_ALLOWED'), 'a forged Requested by cannot reach a non-member');
  assert.equal(submit({ to: 'person:mai', role: 'cmo' }).state, 'queued');
  assert.throws(() => submit({ to: 'person:dina', role: 'finance', origin: { kind: 'human', name: 'Ivan' } }), coded('MAILBOX_INVALID_ORIGIN'));
  assert.throws(() => submit({ to: 'person:dina' }), coded('MAILBOX_UNKNOWN_ROLE'));
  assert.throws(() => submit({ to: 'person:nobody', role: 'finance' }), coded('MAILBOX_UNKNOWN_ADDRESS'));
  assert.throws(() => submit({ to: 'finance', role: 'finance' }), /role applies only/);
});

test('a system message to an assistant keeps the key-first rule: a retry gets its receipt, another target conflicts', async (t) => {
  const f = await fixture(t);
  const first = f.service.submit({ sender: 'agent-org', to: 'person:dina', role: 'finance', body: 'Done.', key: 'task-final:1' });
  f.setMembers({});
  await f.service.refreshMembership();
  assert.deepEqual(f.service.submit({ sender: 'agent-org', to: 'person:dina', role: 'finance', body: 'Done.', key: 'task-final:1' }),
    { ...first, duplicate: true }, 'membership lapsed, but the accepted message keeps its receipt');
  assert.throws(() => f.service.submit({ sender: 'agent-org', to: 'person:mai', role: 'finance', body: 'Done.', key: 'task-final:1' }),
    coded('MAILBOX_KEY_CONFLICT'));
});

test('cards: the person\'s DM always gets the full card; a group topic gets who wrote to whom, in both formats, without the text', async (t) => {
  const f = await fixture(t);
  f.service.send(f.person(DINA).token, { to: 'finance', kind: 'ask', body: 'Private: my salary advance?', summary: 'Salary advance question' });
  await f.settle();
  assert.match(f.htmlTo(MGMT)[0], /Dina&#39;s assistant|Dina's assistant/);
  for (const shown of [...f.htmlTo(MGMT), ...f.richTo(MGMT)]) assert.doesNotMatch(shown, /salary|Salary/i, 'the role\'s topic never shows the text or summary');
  assert.match(f.htmlTo(DINA)[0], /salary advance/);
  assert.match(f.richTo(DINA)[0], /salary advance/);

  // The role's own copy of what it sends an assistant is header-only too.
  f.service.send(f.roleTurn(FINANCE), { to: 'dina', kind: 'ask', body: 'Confirm the advance amount?' });
  await f.settle();
  assert.ok(f.htmlTo(MGMT).length >= 2);
  for (const shown of [...f.htmlTo(MGMT), ...f.richTo(MGMT)]) assert.doesNotMatch(shown, /advance amount/);
  assert.ok(f.htmlTo(DINA).some((text) => /advance amount/.test(text)));
});

test('assistant traffic never appears in a group, and the DM card carries the text whatever the mirror mode', async (t) => {
  const f = await fixture(t);
  f.service.send(f.person(MAI).token, { to: 'dina', kind: 'ask', body: 'Shoot on Friday?' });
  await f.settle();
  assert.deepEqual(f.posts.map((p) => p.params.chat_id).sort(), [DINA, MAI].sort());
  for (const chat of [DINA, MAI]) assert.match(f.htmlTo(chat)[0], /Shoot on Friday/);

  const quiet = await fixture(t, { config: umiConfig({ mailbox: { mirror: 'target' } }) });
  quiet.service.send(quiet.person(DINA).token, { to: 'cmo', kind: 'ask', body: 'Which drop is next?' });
  await quiet.settle();
  assert.match(quiet.htmlTo(DINA)[0], /Which drop is next/);
});

test('a notice card in a role\'s topic about its ask to an assistant leaves the ask\'s text out', () => {
  const ask = { id: 'm_1', kind: 'ask', from_addr: 'role:finance', to_addr: `session:${DINA}`, to_label: "Dina's assistant", body: 'Private matter', summary: 'Private matter' };
  for (const card of [JSON.stringify(envelope.renderNoticeCard(ask, 'succeeded', null, { hidden: true })), envelope.renderNoticeCardHtml(ask, 'succeeded', null, { hidden: true })]) {
    assert.doesNotMatch(card, /Private matter/);
  }
  assert.match(envelope.renderNoticeCardHtml(ask, 'succeeded'), /Private matter/, 'shown when not hidden');
});

test('a role\'s tell to a non-member\'s assistant waits for a member\'s go, and only a member\'s press on that card sends it', async (t) => {
  const f = await fixture(t);
  const token = f.roleTurn(FINANCE);
  assert.throws(() => f.service.send(token, { to: 'mai', kind: 'ask', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'), 'no ask, only a tell');
  const waiting = f.service.send(token, { to: 'mai', kind: 'tell', body: 'Your reimbursement is approved.' });
  assert.equal(waiting.state, 'awaiting-go');
  assert.equal(f.rows().length, 0, 'nothing is stored or delivered before the go');
  assert.deepEqual(f.service.send(token, { to: 'mai', kind: 'tell', body: 'Your reimbursement is approved.' }), { ...waiting, duplicate: true });
  await f.settle();
  const card = f.posts.find((p) => p.meta?.source === 'mailbox-go');
  assert.deepEqual([card.params.chat_id, card.params.message_thread_id], [MGMT, '1041']);
  assert.match(card.params.text, /reimbursement is approved/);
  const go = { data: `mbx:go:${waiting.id}`, chatId: MGMT, messageId: card.messageId };
  assert.match(await f.press({ ...go, from: MAI }), /Only a member/);
  assert.match(await f.press({ ...go, from: '12345' }), /Only a member/);
  assert.match(await f.press({ ...go, from: DINA, messageId: card.messageId + 50 }), /Only a member/, 'a press on another message');
  assert.match(await f.press({ ...go, from: DINA, chatId: MARK }), /Only a member/, 'a press in another chat');
  assert.equal(f.rows().length, 0);
  assert.equal(await f.press({ ...go, from: DINA }), 'Sent.');
  const sent = f.row(waiting.id);
  assert.deepEqual([sent.kind, sent.to_addr, sent.approved_by], ['tell', `session:${MAI}`, 'dina']);
  assert.ok(f.jobFor(waiting.id), 'delivered to Mai\'s assistant');
  await f.settle();
  assert.ok(f.posts.some((p) => p.method === 'editMessageText' && /Sent with Dina's go/.test(p.params.text)));
  assert.ok(f.htmlTo(MAI).some((text) => /go: Dina/.test(text) && /reimbursement/.test(text)), 'Mai\'s card shows the text and whose go sent it');
  assert.match(await f.press({ ...go, from: DINA }), /no longer waiting/, 'a second press does nothing');
});

test('a waiting tell can be dropped, expires after a day, and at most five wait per role', async (t) => {
  const f = await fixture(t);
  const token = f.roleTurn(FINANCE);
  const cardFor = async (id) => { await f.settle(); return f.posts.find((p) => p.method === 'sendMessage' && p.meta?.source === 'mailbox-go' && p.params.reply_markup.inline_keyboard[0][0].callback_data.endsWith(id)); };

  const dropped = f.service.send(token, { to: 'mai', kind: 'tell', body: 'one' });
  const dropCard = await cardFor(dropped.id);
  assert.equal(await f.press({ from: IVAN, data: `mbx:no:${dropped.id}`, chatId: MGMT, messageId: dropCard.messageId }), 'Dropped.');
  assert.match(await f.press({ from: IVAN, data: `mbx:go:${dropped.id}`, chatId: MGMT, messageId: dropCard.messageId }), /no longer waiting/);
  assert.equal(f.rows().length, 0);
  await f.settle();
  assert.ok(f.posts.some((p) => p.method === 'editMessageText' && /Dropped by Ivan/.test(p.params.text)));

  const old = f.service.send(token, { to: 'mai', kind: 'tell', body: 'two' });
  const oldCard = await cardFor(old.id);
  f.advance(25 * 60 * 60000);
  await f.service.refreshMembership();
  assert.match(await f.press({ from: IVAN, data: `mbx:go:${old.id}`, chatId: MGMT, messageId: oldCard.messageId }), /no longer waiting/);
  assert.equal(f.rows().length, 0, 'a go pressed after a day sends nothing');
  await f.settle();
  assert.ok(f.posts.some((p) => p.method === 'editMessageText' && /Expired/.test(p.params.text)));

  for (let i = 0; i < 5; i++) f.service.send(token, { to: 'mai', kind: 'tell', body: `n${i}` });
  assert.throws(() => f.service.send(token, { to: 'mai', kind: 'tell', body: 'six' }), coded('MAILBOX_RATE_LIMITED'));
});

test('a tell whose go card cannot be posted stops waiting, so it neither lingers nor counts toward the cap', async (t) => {
  const f = await fixture(t, { failSource: 'mailbox-go' });
  const token = f.roleTurn(FINANCE);
  const first = f.service.send(token, { to: 'mai', kind: 'tell', body: 'm0' });
  await f.settle();
  assert.match(await f.press({ from: DINA, data: `mbx:go:${first.id}`, chatId: MGMT, messageId: 1 }), /no longer waiting/);
  for (let i = 1; i <= 6; i++) { f.service.send(token, { to: 'mai', kind: 'tell', body: `m${i}` }); await f.settle(); }
  assert.equal(f.rows().length, 0, 'nothing without a go is ever sent');
});

test('directory: an assistant sees the roles its person can reach; a role sees members\' assistants and the go-only rest', async (t) => {
  const f = await fixture(t);
  const mai = (await f.service.directory(f.person(MAI).token, {})).targets.map((x) => x.to);
  assert.deepEqual(mai.sort(), ['ads', 'cmo', 'dina', 'ivan'].sort());
  const finance = (await f.service.directory(f.roleTurn(FINANCE), {})).targets;
  assert.equal(finance.find((x) => x.to === 'dina').access, undefined);
  assert.match(finance.find((x) => x.to === 'mai').access, /tell only/);
});

test('prompts: an assistant learns whose it is and that only its person\'s turn can act; a role learns it may ask assistants', async (t) => {
  const f = await fixture(t);
  const dina = f.service.instructions(DINA);
  assert.match(dina, /you are Dina's assistant/);
  assert.match(dina, /In a turn another session started you cannot message or reply/);
  assert.match(dina, /never Dina's private conversation/);
  assert.match(f.service.instructions(FINANCE), /ask a person's assistant/);
});

test('history: an assistant may read a role topic only while its person is in that role\'s group', async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.canReadRoleTopic(DINA, { chatId: MGMT, threadId: '1041' }), true, 'Dina is in UMI management');
  assert.equal(f.service.canReadRoleTopic(MAI, { chatId: MGMT, threadId: '1041' }), false, 'Mai is not');
  assert.equal(f.service.canReadRoleTopic(MAI, { chatId: MARK }), true, 'a role in a forum\'s General');
  assert.equal(f.service.canReadRoleTopic(MAI, { chatId: MARK, threadId: '999' }), false, 'a topic that is no role\'s place');
  assert.equal(f.service.canReadRoleTopic(FINANCE, { chatId: MGMT, threadId: '732' }), false, 'only assistants read this way');
  assert.deepEqual([f.service.isAssistant(DINA), f.service.isAssistant(FINANCE), f.service.isAssistant(GROUP)], [true, false, false]);
  f.setMembers({});
  await f.service.refreshMembership();
  assert.equal(f.service.canReadRoleTopic(DINA, { chatId: MGMT, threadId: '1041' }), false, 'leaving the group ends it');
});

test('a role and an assistant whose person left the group cannot answer each other\'s open asks', async (t) => {
  const f = await fixture(t);
  const fromDina = f.service.send(f.person(DINA).token, { to: 'finance', kind: 'ask', body: 'Runway?' });
  const fromFinance = f.service.send(f.roleTurn(FINANCE), { to: 'dina', kind: 'ask', body: 'Approve the budget?' });
  f.setMembers({ ...MEMBERS, [MGMT]: { ...MEMBERS[MGMT], [DINA]: 'kicked' } });
  await f.service.refreshMembership();
  assert.throws(() => f.service.reply(f.roleTurn(FINANCE), { inReplyTo: fromDina.id, body: 'Seven months.' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.throws(() => f.service.reply(f.person(DINA).token, { inReplyTo: fromFinance.id, body: 'Approved.' }), coded('MAILBOX_NOT_ALLOWED'));
});

test('taint clears only on a new turn into a session proven idle, with no other turn of the assistant still open', async (t) => {
  const f = await fixture(t);
  // The CLI is busy with a cycle polygram did not start: no idle proof.
  const busy = f.person(DINA, { idle: false });
  assert.throws(() => f.service.send(busy.token, { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'));
  f.service.noteTurnEnd(DINA, busy.owner);
  // A job turn is still open when the person's message goes out as a new
  // primary (a queued send): it may still be folded into the job's cycle.
  f.jobInto(DINA);
  const overlapping = f.person(DINA);
  assert.throws(() => f.service.send(overlapping.token, { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.throws(() => f.service.send(f.fold(DINA), { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'),
    'a message folded meanwhile is tainted too');
  // Once that turn has ended, her next idle turn clears it.
  f.service.noteTurnEnd(DINA, overlapping.owner);
  assert.equal(f.service.send(f.person(DINA).token, { to: 'mai', kind: 'tell', body: 'x' }).state, 'queued');
});

test('only a tainted assistant pays for an idle proof', async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.needsIdleProof(DINA), true, 'tainted from boot');
  f.person(DINA);
  assert.equal(f.service.needsIdleProof(DINA), false);
  assert.equal(f.service.needsIdleProof(FINANCE), false, 'roles never need it');
});

test('a member\'s press while membership is unknown keeps the tell waiting and asks to press again', async (t) => {
  let fail = false;
  const f = await fixture(t, { getChatMember: async (chatId, userId) => {
    if (fail) throw new Error('timeout');
    return { status: MEMBERS[chatId]?.[String(userId)] ?? 'left' };
  } });
  const waiting = f.service.send(f.roleTurn(FINANCE), { to: 'mai', kind: 'tell', body: 'Approved.' });
  await f.settle();
  const card = f.posts.find((p) => p.method === 'sendMessage' && p.meta?.source === 'mailbox-go');
  const go = { from: DINA, data: `mbx:go:${waiting.id}`, chatId: MGMT, messageId: card.messageId };
  fail = true;
  await f.service.refreshMembership();
  assert.match(await f.press(go), /not confirmed yet/);
  assert.equal(f.rows().length, 0);
  fail = false;
  await f.service.refreshMembership();
  assert.equal(await f.press(go), 'Sent.');
});

// agent-org's tasks CLI tells "not reachable" from "not known yet" by this
// field, and retries only the latter.
test('identify lists the roles whose membership is not known yet as unconfirmed, and never throws for it', async (t) => {
  const early = await fixture(t, { refresh: false });
  assert.deepEqual(early.service.identify({ token: early.person(DINA).token }),
    { assistant: 'dina', chatId: DINA, depth: 0, roles: [], unconfirmed: ['ops', 'finance', 'cmo', 'ads'] }, 'before the first refresh');

  const partial = await fixture(t, { getChatMember: async (chatId, userId) => {
    if (chatId === MGMT) throw new Error('timeout');
    return { status: MEMBERS[chatId]?.[String(userId)] ?? 'left' };
  } });
  assert.deepEqual(partial.service.identify({ token: partial.person(DINA).token }),
    { assistant: 'dina', chatId: DINA, depth: 0, roles: ['cmo', 'ads'], unconfirmed: ['ops', 'finance'] }, 'a failed lookup');
  const mai = partial.service.identify({ token: partial.person(MAI).token });
  assert.deepEqual([mai.roles, mai.unconfirmed], [['cmo', 'ads'], ['ops', 'finance']]);

  const known = await fixture(t);
  assert.deepEqual(known.service.identify({ token: known.person(MAI).token }).unconfirmed, [],
    'a proven non-member is neither reachable nor unconfirmed');
  known.advance(11 * 60000);
  assert.deepEqual(known.service.identify({ token: known.person(MAI).token }).unconfirmed, ['ops', 'finance', 'cmo', 'ads'], 'a stale answer');
  assert.deepEqual(known.service.identify({ token: known.roleTurn(OPS) }), { role: 'ops', depth: 0 }, 'a role gets exactly what it got before');
});


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

const MGMT = '-1004292131077';
const MARK = '-1004462674958';
const GROUP = '-1002400136088';
const IVAN = '68861949';
const DINA = '451328391';
const MAI = '8744283195';
const FINANCE = `${MGMT}:1041`;
const OPS = `${MGMT}:732`;
const CMO = MARK;

function umiConfig({ mailbox = {}, assistants = { ivan: IVAN, dina: DINA, mai: MAI } } = {}) {
  return {
    bot: {
      adminChatId: IVAN,
      externalJobs: { enabled: true, routes: {
        ops: { chatId: MGMT, threadId: '732' }, finance: { chatId: MGMT, threadId: '1041' },
        cmo: { chatId: MARK, general: true }, ads: { chatId: MARK, threadId: '406' },
      } },
      mailbox: {
        enabled: true, mirror: 'both', systemSenders: ['agent-org'],
        roles: { ops: { about: 'Operations' }, finance: { about: 'Finance' }, cmo: { about: 'Marketing' }, ads: { about: 'Ads' } },
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

async function fixture(t, { config = umiConfig(), members = MEMBERS, getChatMember = null, refresh = true } = {}) {
  const { db, dbPath } = freshDb('mailbox-assistants');
  let clock = 1_000_000;
  const now = () => clock;
  const resolveTarget = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: backendOf });
  const jobs = createExternalJobService({ config, db, botName: 'shumabit', resolveTarget,
    dispatch: async () => ({ outcome: 'succeeded', inactive: true }), deliverPart: async () => ({}), logger: { error() {} } });
  const posts = [];
  let messageId = 100;
  const tg = async (_bot, method, params, meta) => { posts.push({ method, params, meta }); return { message_id: ++messageId, chat: { id: Number(params.chat_id) },
    ...(params.message_thread_id ? { message_thread_id: Number(params.message_thread_id) } : {}) }; };
  const lookup = getChatMember ?? (async (chatId, userId) => ({ status: members[chatId]?.[String(userId)] ?? 'left' }));
  const service = createMailboxService({ config, db, botName: 'shumabit', jobs, resolveTarget, resolveBackend: backendOf, getSessionKey,
    tg, bot: {}, sendRich: async () => ({ wentRich: false, fallback: 'unsupported' }), getChatMember: lookup, now,
    logger: { error() {}, warn() {} } });
  t.after(() => { service.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  if (refresh) await service.refreshMembership();
  let turn = 0;
  // The person writes in their DM and the message starts a new turn.
  const person = (chatId, { fromId = chatId } = {}) => {
    service.noteHumanPrompt(chatId, { operator: false });
    const owner = humanTurn(chatId, ++turn);
    service.noteHumanDispatch(chatId, { newTurn: true, owner, fromId: Number(fromId) });
    return { token: service.scope(chatId), owner };
  };
  // A human writes in a role's topic.
  const roleTurn = (key) => { service.noteHumanPrompt(key, { operator: true }); return service.scope(key); };
  // Another session's message, a notice or any job is sent into a session.
  const jobInto = (chatId, requestId = `mailbox:m_${String(++turn).padStart(16, '0')}`) => {
    const job = { target: { sessionKey: chatId }, routeId: `session:${chatId}`, requestId };
    service.instructions(chatId, job);
    service.noteJobSend(job);
    return { token: service.scope(chatId), job };
  };
  const row = (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id);
  const rows = () => db.raw.prepare('SELECT * FROM mailbox_messages ORDER BY rowid').all();
  const jobFor = (id) => db.raw.prepare("SELECT * FROM external_jobs WHERE request_id='mailbox:' || ?").get(id);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { db, config, jobs, service, posts, person, roleTurn, jobInto, row, rows, jobFor, settle, advance: (ms) => { clock += ms; } };
}
const coded = (code) => (error) => error?.code === code;

test('config: an assistant names a configured direct chat that is not a role, once, in a roles bot', () => {
  const read = (config) => rules.readMailboxConfig(config.bot, createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: backendOf }), config.chats);
  assert.equal(read(umiConfig()).assistants.get('dina').label, "Dina's assistant");
  for (const [assistants, why] of [
    [{ finance: DINA }, 'a role name'],
    [{ dina: '999' }, 'an unconfigured chat'],
    [{ dina: MGMT }, 'a group, not a direct chat'],
    [{ dina: DINA, dina2: DINA }, 'two assistants in one chat'],
    [{ Dina: DINA }, 'a key that is not lowercase'],
  ]) assert.throws(() => read(umiConfig({ assistants })), Error, why);
  const open = umiConfig({ mailbox: { intra: 'open', allow: undefined, roles: undefined } });
  delete open.bot.mailbox.allow; delete open.bot.mailbox.roles;
  assert.throws(() => read(open), /apply only to intra "roles"/);
});

test('assistants get a grant, a Codex one too, while every other chat of a roles bot stays unaddressed', async (t) => {
  const f = await fixture(t);
  for (const chat of [DINA, MAI, IVAN]) assert.match(f.service.scope(chat), /^[0-9a-f-]{36}$/, chat);
  assert.equal(f.service.scope(`${GROUP}:2`), null, 'a team group topic is neither a role nor an assistant');
  assert.equal(f.service.scope(GROUP), null);
  assert.equal(f.service.roleForSession(DINA), null, 'an assistant is not a role, so stop and pause policy is unchanged');
  assert.equal(f.service.receivesMail(DINA), true);
  assert.equal(f.service.receivesMail(IVAN), false, 'a Codex chat cannot receive yet, so a stop there takes no mailbox lock');
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

test('membership fails closed: before the first refresh, on a lookup error, for a non-member restriction, and when stale', async (t) => {
  const early = await fixture(t, { refresh: false });
  assert.throws(() => early.service.send(early.person(DINA).token, { to: 'finance', kind: 'ask', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'));

  const broken = await fixture(t, { getChatMember: async () => { throw Object.assign(new Error('Bad Gateway'), { error_code: 502 }); } });
  assert.throws(() => broken.service.send(broken.person(DINA).token, { to: 'cmo', kind: 'ask', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'));

  const restricted = await fixture(t, { getChatMember: async (chatId, userId) => (String(userId) === DINA
    ? { status: 'restricted', is_member: chatId === MARK } : { status: 'member' }) });
  const dina = restricted.service.identify({ token: restricted.person(DINA).token });
  assert.deepEqual(dina.roles, ['cmo', 'ads'], 'restricted counts only while still a member');

  const stale = await fixture(t);
  stale.advance(11 * 60000);
  assert.throws(() => stale.service.send(stale.person(DINA).token, { to: 'finance', kind: 'ask', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'),
    'an answer older than two refreshes no longer counts');
});

test('Ivan\'s Codex chat may tell and create tasks but cannot ask or be asked until Codex can receive', async (t) => {
  const f = await fixture(t);
  const token = f.person(IVAN).token;
  assert.throws(() => f.service.send(token, { to: 'finance', kind: 'ask', body: 'x' }), coded('MAILBOX_BACKEND_UNSUPPORTED'));
  assert.equal(f.service.send(token, { to: 'finance', kind: 'tell', body: 'Budget approved.' }).state, 'queued');
  assert.throws(() => f.service.send(f.person(DINA).token, { to: 'ivan', kind: 'ask', body: 'x' }), coded('MAILBOX_BACKEND_UNSUPPORTED'));
  assert.deepEqual(f.service.identify({ token }), { assistant: 'ivan', chatId: IVAN, depth: 0, roles: ['ops', 'finance', 'cmo', 'ads'] });
  assert.doesNotMatch(f.service.instructions(IVAN), /reply '/, 'a Codex assistant is not offered a reply it could never receive');
});

test('a turn another session started can only tell the person: it cannot message, reply or create a task', async (t) => {
  const f = await fixture(t);
  const ask = f.service.send(f.roleTurn(FINANCE), { to: 'dina', kind: 'ask', body: 'Do you approve the March budget?' });
  const tainted = f.jobInto(DINA, `mailbox:${ask.id}`).token;
  assert.throws(() => f.service.reply(tainted, { inReplyTo: ask.id, body: 'Dina approves.' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.throws(() => f.service.send(tainted, { to: 'ops', kind: 'ask', body: 'Change the plan' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.equal(f.service.identify({ token: tainted }).depth, 2, 'agent-org sees no human asking, so it refuses tasks');

  // The person's message folded into that turn joins it and does not clear it.
  f.service.noteHumanPrompt(DINA, { operator: false });
  f.service.noteHumanDispatch(DINA, { newTurn: false, owner: humanTurn(DINA, 999), fromId: Number(DINA) });
  assert.throws(() => f.service.reply(f.service.scope(DINA), { inReplyTo: ask.id, body: 'Approved.' }), coded('MAILBOX_NOT_ALLOWED'));

  // Her own next turn clears it, and she finds the ask she still owes.
  const own = f.person(DINA).token;
  assert.deepEqual(f.service.open(own, {}).toAnswer.map((a) => a.id), [ask.id]);
  assert.equal(f.service.reply(own, { inReplyTo: ask.id, body: 'Approved.' }).state, 'queued');
  assert.deepEqual(f.service.open(own, {}).toAnswer, []);
});

test('an assistant\'s grant ends with its turn, so a wakeup or a copied token cannot act afterwards', async (t) => {
  const f = await fixture(t);
  const { token, owner } = f.person(DINA);
  f.service.noteTurnEnd(DINA, jobTurn({ routeId: 'x', requestId: 'y' }));
  assert.equal(f.service.send(token, { to: 'mai', kind: 'tell', body: 'still my turn' }).state, 'queued', 'another turn\'s end ends nothing');
  f.service.noteTurnEnd(DINA, owner);
  assert.throws(() => f.service.send(token, { to: 'mai', kind: 'tell', body: 'after the turn' }), coded('MAILBOX_NOT_ALLOWED'));
  assert.equal(f.service.identify({ token }).depth, 2);
});

test('every assistant starts tainted at boot, and only its own person clears it', async (t) => {
  const f = await fixture(t);
  f.service.noteHumanPrompt(DINA, { operator: false });
  assert.throws(() => f.service.send(f.service.scope(DINA), { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'),
    'a turn that survived a restart may still carry another session\'s text');
  const stranger = f.person(DINA, { fromId: MAI }).token;
  assert.throws(() => f.service.send(stranger, { to: 'mai', kind: 'tell', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'), 'only the DM\'s own person clears it');
  assert.equal(f.service.send(f.person(DINA).token, { to: 'mai', kind: 'tell', body: 'x' }).state, 'queued');
});

test('a role is never tainted by its deliveries, so role chains work as before', async (t) => {
  const f = await fixture(t);
  f.jobInto(FINANCE);
  assert.equal(f.service.send(f.roleTurn(FINANCE), { to: 'ops', kind: 'ask', body: 'x' }).state, 'queued');
});

test('identify: an assistant gets its key, chat, depth and reachable roles; a role gets exactly what it got before', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.service.identify({ token: f.person(DINA).token }), { assistant: 'dina', chatId: DINA, depth: 0, roles: ['ops', 'finance', 'cmo', 'ads'] });
  assert.deepEqual(f.service.identify({ token: f.roleTurn(OPS) }), { role: 'ops', depth: 0 });
});

test('a system sender tells an assistant about a role\'s task only if the person can reach that role, never with an origin', async (t) => {
  const f = await fixture(t);
  const submit = (input) => f.service.submit({ sender: 'agent-org', body: 'Task done: runway report.', key: `k${Math.random()}`, ...input });
  const sent = submit({ to: 'person:dina', role: 'finance' });
  assert.deepEqual([f.row(sent.id).to_addr, f.row(sent.id).depth, f.row(sent.id).origin_name], [`session:${DINA}`, 1, null]);
  assert.throws(() => submit({ to: 'person:mai', role: 'finance' }), coded('MAILBOX_NOT_ALLOWED'), 'a forged Requested by cannot reach a non-member');
  assert.equal(submit({ to: 'person:mai', role: 'cmo' }).state, 'queued');
  assert.throws(() => submit({ to: 'person:dina', role: 'finance', origin: { kind: 'human', name: 'Ivan' } }), coded('MAILBOX_INVALID_ORIGIN'));
  assert.throws(() => submit({ to: 'person:dina' }), coded('MAILBOX_UNKNOWN_ROLE'));
  assert.throws(() => submit({ to: 'person:ivan', role: 'finance' }), coded('MAILBOX_BACKEND_UNSUPPORTED'));
  assert.throws(() => submit({ to: 'person:nobody', role: 'finance' }), coded('MAILBOX_UNKNOWN_ADDRESS'));
  assert.throws(() => submit({ to: 'finance', role: 'finance' }), /role applies only/);
});

test('cards: the person\'s DM always gets the full card; a group topic gets who wrote to whom, without the text', async (t) => {
  const f = await fixture(t);
  f.service.send(f.person(DINA).token, { to: 'finance', kind: 'ask', body: 'Private: my salary advance?' });
  await f.settle();
  const inFinance = f.posts.find((p) => p.params.chat_id === MGMT);
  const inDm = f.posts.find((p) => p.params.chat_id === DINA);
  assert.match(inFinance.params.text, /Dina&#39;s assistant|Dina's assistant/);
  assert.doesNotMatch(inFinance.params.text, /salary/, 'the role\'s topic never shows the text');
  assert.match(inDm.params.text, /salary advance/);

  f.posts.length = 0;
  f.service.send(f.person(MAI).token, { to: 'dina', kind: 'ask', body: 'Shoot on Friday?' });
  await f.settle();
  assert.deepEqual(f.posts.map((p) => p.params.chat_id).sort(), [DINA, MAI].sort(), 'assistant traffic never appears in a group');

  const quiet = await fixture(t, { config: umiConfig({ mailbox: { mirror: 'target' } }) });
  quiet.service.send(quiet.person(DINA).token, { to: 'cmo', kind: 'ask', body: 'Which drop is next?' });
  await quiet.settle();
  assert.ok(quiet.posts.some((p) => p.params.chat_id === DINA), 'the person sees their assistant\'s message whatever the mirror mode');
});

test('a role\'s tell to a non-member\'s assistant waits for a member\'s go, and only a member\'s press sends it', async (t) => {
  const f = await fixture(t);
  const token = f.roleTurn(FINANCE);
  assert.throws(() => f.service.send(token, { to: 'mai', kind: 'ask', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'), 'no ask, only a tell');
  const waiting = f.service.send(token, { to: 'mai', kind: 'tell', body: 'Your reimbursement is approved.' });
  assert.equal(waiting.state, 'awaiting-go');
  assert.equal(f.rows().length, 0, 'nothing is stored or delivered before the go');
  assert.deepEqual(f.service.send(token, { to: 'mai', kind: 'tell', body: 'Your reimbursement is approved.' }), { ...waiting, duplicate: true });
  await f.settle();
  const card = f.posts.find((p) => p.meta?.source === 'mailbox-go');
  assert.equal(card.params.chat_id, MGMT);
  assert.equal(card.params.message_thread_id, '1041');
  assert.match(card.params.text, /reimbursement is approved/);
  const cardId = 100 + f.posts.indexOf(card) + 1;
  const press = async (from, data) => {
    const answers = [];
    await f.service.handleGoCallback({ callbackQuery: { data, from: { id: Number(from) }, message: { chat: { id: Number(MGMT) }, message_id: cardId } },
      answerCallbackQuery: async ({ text }) => { answers.push(text); } });
    return answers[0];
  };
  assert.match(await press(MAI, `mbx:go:${waiting.id}`), /Only a member/);
  assert.match(await press('12345', `mbx:go:${waiting.id}`), /Only a member/);
  assert.equal(f.rows().length, 0);
  assert.equal(await press(DINA, `mbx:go:${waiting.id}`), 'Sent.');
  const sent = f.row(waiting.id);
  assert.deepEqual([sent.kind, sent.to_addr, sent.approved_by], ['tell', `session:${MAI}`, 'dina']);
  assert.ok(f.jobFor(waiting.id), 'delivered to Mai\'s assistant');
  await f.settle();
  assert.ok(f.posts.some((p) => p.method === 'editMessageText' && /Sent with Dina's go/.test(p.params.text)));
  assert.ok(f.posts.some((p) => p.params.chat_id === MAI && /go: Dina/.test(p.params.text)), 'Mai\'s card says whose go sent it');
  assert.match(await press(DINA, `mbx:go:${waiting.id}`), /no longer waiting/, 'a second press does nothing');
});

test('a waiting tell can be dropped, expires after a day, and at most five wait per role', async (t) => {
  const f = await fixture(t);
  const token = f.roleTurn(FINANCE);
  const press = (id, data) => f.service.handleGoCallback({ callbackQuery: { data, from: { id: Number(IVAN) }, message: { chat: { id: Number(MGMT) }, message_id: 0 } },
    answerCallbackQuery: async () => {} });
  const dropped = f.service.send(token, { to: 'mai', kind: 'tell', body: 'one' });
  await f.settle();
  const card = f.posts.find((p) => p.meta?.source === 'mailbox-go');
  await f.service.handleGoCallback({ callbackQuery: { data: `mbx:no:${dropped.id}`, from: { id: Number(IVAN) }, message: { chat: { id: Number(MGMT) }, message_id: 100 + f.posts.indexOf(card) + 1 } },
    answerCallbackQuery: async () => {} });
  assert.equal(f.rows().length, 0);
  await f.settle();
  assert.ok(f.posts.some((p) => p.method === 'editMessageText' && /Dropped by Ivan/.test(p.params.text)));

  const old = f.service.send(token, { to: 'mai', kind: 'tell', body: 'two' });
  f.advance(25 * 60 * 60000);
  await press(old.id, `mbx:go:${old.id}`);
  assert.equal(f.rows().length, 0, 'a go pressed after a day sends nothing');

  for (let i = 0; i < 5; i++) f.service.send(token, { to: 'mai', kind: 'tell', body: `n${i}` });
  assert.throws(() => f.service.send(token, { to: 'mai', kind: 'tell', body: 'six' }), coded('MAILBOX_RATE_LIMITED'));
});

test('directory: an assistant sees the roles its person can reach; a role sees members\' assistants and the go-only rest', async (t) => {
  const f = await fixture(t);
  const mai = f.service.directory(f.person(MAI).token, {}).targets.map((x) => x.to);
  assert.deepEqual(mai.sort(), ['ads', 'cmo', 'dina', 'ivan'].sort());
  const finance = f.service.directory(f.roleTurn(FINANCE), {}).targets;
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

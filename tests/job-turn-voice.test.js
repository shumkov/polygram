'use strict';
// A job turn's final text is posted to the people in its chat as the job
// report. Agents that did not know this posted private turn summaries
// ("nothing to do", "I did not post in the topic") into busy topics, in the
// wrong language, while a person's assistant stayed silent about asks meant
// for its person. Every job turn, whatever started it and whichever backend
// runs it, is told who reads its final text and when to write one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const { createExternalJobTargetResolver } = require('../lib/external-jobs/runtime');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createMailboxService, humanTurn } = require('../lib/mailbox/service');
const envelope = require('../lib/mailbox/envelope');

const MGMT = '-1004292131077';
const IVAN = '68861949';
const DINA = '451328391';
const MAI = '8744283195';
const OPS = `${MGMT}:732`;
const FINANCE = `${MGMT}:1041`;

// The paragraph every job turn carries, in order: that no person here wrote,
// that any text is posted here, when to write, how, and that silence is the
// right outcome otherwise, overriding the progress rules a person's turn has.
const VOICE = [
  'No person in this chat wrote to you in this turn, yet any text you write in it is posted to the people here, like any message you send to this chat.',
  'Write only when a person here needs to know something: a result, a problem you found, or a decision they must make; write it to them, in the language they are using in this chat now.',
  'Otherwise write no text at all and just end the turn: that is the right outcome here.',
  'The chat already shows that you are working, so post no plan, checklist or progress note;',
].map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^]*?');
const VOICE_RE = new RegExp(VOICE);

function config({ mirror = 'both', assistants = true } = {}) {
  return {
    bot: {
      adminChatId: IVAN,
      externalJobs: { enabled: true, routes: { ops: { chatId: MGMT, threadId: '732' }, finance: { chatId: MGMT, threadId: '1041' } } },
      mailbox: {
        enabled: true, mirror, systemSenders: ['agent-org'],
        roles: { ops: { about: 'Operations' }, finance: { about: 'Finance' } },
        allow: { ops: ['*'], finance: ['*'] },
        ...(assistants ? { assistants: { ivan: IVAN, dina: DINA, mai: MAI } } : {}),
      },
    },
    chats: {
      [MGMT]: { name: 'UMI management', isolateTopics: true, topics: { 732: {}, 1041: {} } },
      [IVAN]: { name: 'Ivan DM', pm: 'codex' },
      [DINA]: { name: '@Dina' },
      [MAI]: { name: '@Mai' },
    },
  };
}
// Ivan's direct chat runs Codex; everything else the Claude CLI.
const backendOf = ({ chatId }) => (String(chatId) === IVAN ? 'codex' : 'cli');

// Real mailbox and external jobs over one database; the agent turn is
// simulated and records the prompt each job was dispatched with.
async function fixture(t, { mirror, assistants } = {}) {
  const { db, dbPath } = freshDb('job-turn-voice');
  const cfg = config({ mirror, assistants });
  const resolveTarget = createExternalJobTargetResolver({ config: cfg, getSessionKey, resolveBackend: backendOf });
  const f = { db, dispatched: [] };
  const runtime = { dispatch: async (job, hooks) => { hooks.onSend?.(); f.dispatched.push(job); return { outcome: 'succeeded', text: '', inactive: true }; } };
  f.jobs = createExternalJobService({ config: cfg, db, botName: 'shumabit', resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (_origin, run) => run(), runtime, getMailbox: () => f.mailbox, logger: { warn() {} } }),
    checkInactive: async () => false, deliverPart: async () => ({ messageId: 1 }), logger: { error() {} } });
  let messageId = 100;
  const tg = async (_bot, _method, params) => ({ message_id: ++messageId, chat: { id: Number(params.chat_id) },
    ...(params.message_thread_id ? { message_thread_id: Number(params.message_thread_id) } : {}) });
  const members = { [MGMT]: { [IVAN]: 'creator', [DINA]: 'member', [MAI]: 'member' } };
  f.mailbox = createMailboxService({ config: cfg, db, botName: 'shumabit', jobs: f.jobs, resolveTarget, resolveBackend: backendOf, getSessionKey,
    tg, bot: {}, sendRich: async () => ({ wentRich: false, fallback: 'unsupported' }),
    getChatMember: async (chatId, userId) => ({ status: members[chatId]?.[String(userId)] ?? 'left' }), logger: { error() {}, warn() {} } });
  await f.mailbox.refreshMembership();
  f.jobs.start(); f.mailbox.start();
  t.after(() => { f.mailbox.stop(); f.jobs.stop(); cleanupDb(dbPath, db); });
  f.role = (key) => { f.mailbox.noteHumanPrompt(key, { operator: true }); return f.mailbox.scope(key); };
  let turn = 0;
  f.person = (chatId) => {
    const owner = humanTurn(chatId, ++turn);
    f.mailbox.noteHumanPrompt(chatId, { operator: false, owner });
    f.mailbox.noteHumanDispatch(chatId, { newTurn: true, owner, fromId: Number(chatId), idle: true });
    return f.mailbox.scope(chatId);
  };
  f.prompt = (requestId) => f.dispatched.find((job) => job.requestId === requestId)?.task;
  f.stored = (requestId) => db.raw.prepare('SELECT task FROM external_jobs WHERE request_id=?').get(requestId).task;
  // One job per session runs at a time; each settled turn frees the next.
  f.run = async () => { await f.mailbox.cardsSettled(); for (let n = 0; n < 5; n++) await f.jobs.tick(); };
  return f;
}

// The rule follows the stored task directly, before the tool blocks, so the
// stored header and its tail still lead the prompt.
function assertVoice(f, requestId) {
  const prompt = f.prompt(requestId);
  assert.ok(prompt, `${requestId} was dispatched`);
  const stored = f.stored(requestId);
  assert.ok(prompt.startsWith(`${stored}\n`), 'the stored task leads the prompt');
  assert.match(prompt.slice(stored.length), new RegExp(`^\\n${VOICE}`), 'the rule follows the stored task');
  return prompt;
}

test('an ask, a tell and a reply between roles each tell the receiving turn who reads its final text', async (t) => {
  const f = await fixture(t);
  const asked = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'ask', body: 'What is the March runway?' });
  const told = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'tell', body: 'Budget review moved to Monday.' });
  await f.run();
  const answered = f.mailbox.reply(f.role(FINANCE), { inReplyTo: asked.id, body: 'Seven months.' });
  await f.run();
  for (const id of [asked.id, told.id, answered.id]) assertVoice(f, `mailbox:${id}`);
  assert.match(f.prompt(`mailbox:${asked.id}`), /Answer once with the mailbox reply command/, 'the ask still has to be answered through the mailbox');
});

test('a system sender\'s task and a relayed human comment carry the rule', async (t) => {
  const f = await fixture(t);
  const task = f.mailbox.submit({ sender: 'agent-org', to: 'ops', body: 'Task 42 is yours.', key: 'task:42' });
  const comment = f.mailbox.submit({ sender: 'agent-org', to: 'ops', body: 'Please hurry.', key: 'comment:1', origin: { kind: 'human', name: 'Ivan' } });
  await f.run();
  for (const id of [task.id, comment.id]) assertVoice(f, `mailbox:${id}`);
});

test('a delivery notice carries the rule and no longer asks for a word in the topic', async (t) => {
  const f = await fixture(t);
  const asked = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'ask', body: 'What is the March runway?' });
  await f.run();
  await f.mailbox.tick();
  await f.run();
  const prompt = assertVoice(f, `mailbox-notice:${asked.id}`);
  assert.match(prompt, /^\[Inter-session notice\]/);
  assert.doesNotMatch(prompt, /say so in your topic/);
});

test('a notice tail only states what the turn can do, for every reason', () => {
  const ask = { id: 'm_00000000000000a1', kind: 'ask', from_addr: 'role:ops', to_addr: 'role:finance' };
  for (const reason of ['succeeded', 'failed', 'interrupted', 'unknown', 'reply-undelivered', 'reply-uncertain']) {
    const task = envelope.renderNoticeTask(ask, reason);
    assert.doesNotMatch(task, /say so in your topic/, reason);
    assert.match(task, /This turn can reply to asks but cannot start a new ask or tell\.$/, reason);
  }
});

test('a person\'s assistant is told to tell its person who asks what, by the configured name', async (t) => {
  const f = await fixture(t);
  const fromRole = f.mailbox.send(f.role(OPS), { to: 'mai', kind: 'ask', body: 'Can Mai approve the shoot budget?' });
  const fromAssistant = f.mailbox.send(f.person(DINA), { to: 'mai', kind: 'ask', body: 'Are you free on Friday?' });
  const toCodex = f.mailbox.send(f.role(OPS), { to: 'ivan', kind: 'tell', body: 'The report is ready.' });
  await f.run();
  for (const [id, name] of [[fromRole.id, 'Mai'], [fromAssistant.id, 'Mai'], [toCodex.id, 'Ivan']]) {
    const prompt = assertVoice(f, `mailbox:${id}`);
    assert.ok(prompt.includes(`This is ${name}'s direct chat with you. When what you received is for ${name} or asks something of ${name}, `
      + `telling ${name} is the point of this turn: say who is asking, what, and what they need from ${name}, even though the message card shows it.`), name);
  }
  assert.match(f.prompt(`mailbox:${fromRole.id}`), /In a turn another session started you cannot run the mailbox send or reply commands: tell Mai in your final text what is asked/,
    'on the Claude CLI "reply" is also the Telegram tool, so the mailbox commands are named');
  const roleTurn = f.mailbox.send(f.person(MAI), { to: 'ops', kind: 'tell', body: 'Approved.' });
  await f.run();
  assert.doesNotMatch(f.prompt(`mailbox:${roleTurn.id}`), /direct chat with you/, 'a role\'s turn has no person sentence');
});

test('jobs that are not mailbox messages carry the rule too: a notification batch and an API job', async () => {
  const dispatched = [];
  const dispatch = createExternalJobDispatch({
    dispatchExternalEvent: (_origin, run) => run(),
    runtime: { dispatch: async (job) => { dispatched.push(job); return { outcome: 'succeeded' }; } },
  });
  const target = { chatId: '-1001', threadId: '12', sessionKey: '-1001:12' };
  for (const requestId of ['notifications:1', 'daily-digest:2026-11-27']) {
    await dispatch({ id: 1, routeId: 'admin', requestId, task: 'Review the supplied data.', payload: {}, target }, {});
  }
  for (const job of dispatched) {
    assert.ok(job.task.startsWith('Review the supplied data.\n'));
    assert.match(job.task, VOICE_RE);
    assert.doesNotMatch(job.task, /direct chat with you/);
  }
});

test('a job stored before the rule existed gets it when dispatched', async (t) => {
  const f = await fixture(t);
  const sent = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'tell', body: 'Old news.' });
  // The stored task is exactly what was stored before this change: the rule
  // is never part of it.
  assert.doesNotMatch(f.stored(`mailbox:${sent.id}`), VOICE_RE);
  await f.run();
  assertVoice(f, `mailbox:${sent.id}`);
});

test('with mirroring off the rule still applies', async (t) => {
  // People's assistants need mirroring, so this bot has none.
  const f = await fixture(t, { mirror: false, assistants: false });
  const sent = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'tell', body: 'No mirror needed.' });
  await f.run();
  assertVoice(f, `mailbox:${sent.id}`);
});

// Every session's system prompt says the chat has no silent-no-op state. That
// rule answers a person's short message; a job turn ending silently is right.
test('the display hint scopes its no-silence rule to a person\'s message', () => {
  const { buildPolygramDisplayHint } = require('../lib/telegram/display-hint');
  for (const rich of [false, true]) {
    const hint = buildPolygramDisplayHint(rich);
    assert.match(hint, /the chat surface has no silent-no-op state\. Every reply must be intentional content\. This is about a message a person sent; /);
    assert.match(hint, /a turn polygram starts without one \(a message from another session, a notice, a task\) follows its own instructions on when to end with no text\./);
  }
});

// A notice queued before this change keeps its stored ending, which still
// asks for a word in the topic; the rule follows it, so the turn reads both
// for as long as that notice waits in the queue (seconds).
test('a notice stored with the old ending gets the rule after it', async () => {
  const dispatched = [];
  const dispatch = createExternalJobDispatch({
    dispatchExternalEvent: (_origin, run) => run(),
    runtime: { dispatch: async (job) => { dispatched.push(job); return { outcome: 'succeeded' }; } },
    getMailbox: () => ({ enabled: true, instructions: () => '', noteJobSend() {} }),
  });
  const old = '[Inter-session notice] from=system:polygram to=role:ops about=m_00000000000000a1 isUser=false\n'
    + 'Your ask m_00000000000000a1 to role:finance was delivered, but that role\'s turn ended without a reply. '
    + 'This turn can reply to asks but cannot start a new ask or tell; if you still need the answer, say so in your topic.';
  await dispatch({ id: 1, routeId: 'ops', requestId: 'mailbox-notice:m_00000000000000a1', task: old, payload: {},
    target: { chatId: MGMT, threadId: '732', sessionKey: OPS } }, {});
  assert.ok(dispatched[0].task.startsWith(`${old}\n`));
  assert.match(dispatched[0].task.slice(old.length), new RegExp(`^\\n${VOICE}`));
});

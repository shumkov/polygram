'use strict';
// A job turn's final text is posted to the people in its chat as the job
// report. Agents that did not know this posted private turn summaries
// ("nothing to do", "I did not post in the topic") into busy topics, in the
// wrong language, while a person's assistant stayed silent about asks meant
// for its person. Every job turn, whatever started it and whichever backend
// runs it, is told who reads its final text, when to write one, and that
// NO_REPLY posts nothing. 0.56.1 put that paragraph before the long tool
// blocks and the payload and it changed nothing, so it is now the last thing
// in the prompt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const { createExternalJobTargetResolver, buildExternalJobPrompt } = require('../lib/external-jobs/runtime');
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

// The paragraph every job turn ends with, per backend. Orchestra's system
// prompt tells a Claude CLI session that its inline text is not seen and that
// anything for a person goes through the reply tool, so a Claude CLI job
// turn's final text is a private log, never posted. Codex joins and posts
// every message the turn wrote, and has no reply tool.
const CLI_VOICE = 'No person in this chat wrote to you in this turn.'
  + ' Anything a person here needs goes through the reply tool: a result, a problem, or a decision they must make, addressed to them, in the language they use in this chat.'
  + ' Your final text is kept as a private log and is not posted. If nothing is needed, just end the turn.'
  + ' For this turn, the plan-first checklist rule does not apply: don\'t post a plan or progress checklist.';
const CODEX_VOICE = 'No person in this chat wrote to you in this turn. What you write is not a private summary: polygram joins every message you write in this turn and posts them, word for word, to this chat as a message from you.'
  + ' If what you would write describes what you did, says that you posted nothing, or says that nothing was needed, write nothing in this turn but exactly NO_REPLY.'
  + ' Write only when a person here needs it: a result, a problem, or a decision they must make, addressed to them, in the language they use in this chat.'
  + ' Post no plan or progress note: the chat already shows that you are working.';
// A notice's text is never posted, so its turn is told that instead.
const CLI_NOTICE = 'This notice is for you, not for the people in this chat: your final text is kept as a private log and is not posted.'
  + ' Use the reply tool only if a person here must know something now; don\'t post a plan or progress checklist.';
const CODEX_NOTICE = 'This notice is for you, not for the people in this chat: polygram posts nothing you write in this turn.';
const CLI_PERSON = (name) => ` This is ${name}'s direct chat with you.`
  + ` If what you received asks something of ${name} or is for ${name}, tell ${name} with the reply tool: who asks, what, by when, in ${name}'s language.`
  + ` Never end such a turn before ${name} has been told.`;
const CODEX_PERSON = (name) => ` This is ${name}'s direct chat with you.`
  + ` If what you received asks something of ${name} or is for ${name}, tell ${name} in what you write: who asks, what, by when, in ${name}'s language.`
  + ` Never end such a turn with NO_REPLY before ${name} has been told.`;
// The 0.56.1 wording, which must be gone.
const OLD_VOICE_RE = /any text you write in it is posted to the people here|Otherwise write no text at all and just end the turn|polygram posts it, word for word|tell \w+ in your final text/;

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
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (_origin, run) => run(), runtime, getMailbox: () => f.mailbox, getBackend: backendOf, logger: { warn() {} } }),
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

// The prompt the process gets: the stored task leads, the tool blocks and the
// untrusted payload follow, and the paragraph is the very last thing.
function assertVoice(f, requestId, voice = CLI_VOICE) {
  const job = f.dispatched.find((sent) => sent.requestId === requestId);
  assert.ok(job, `${requestId} was dispatched`);
  const prompt = buildExternalJobPrompt(job);
  const stored = f.stored(requestId);
  assert.ok(prompt.startsWith(`${stored}\n`), 'the stored task leads the prompt');
  assert.ok(prompt.endsWith(`</untrusted-input>\n\n${voice}`), `${requestId} ends with its paragraph, after the payload`);
  assert.equal(prompt.indexOf(voice), prompt.length - voice.length, 'the paragraph appears once');
  assert.doesNotMatch(prompt, OLD_VOICE_RE);
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

test('a delivery notice ends with the notice paragraph: its text is not posted, and the reply tool is how to tell a person', async (t) => {
  const f = await fixture(t);
  const asked = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'ask', body: 'What is the March runway?' });
  await f.run();
  await f.mailbox.tick();
  await f.run();
  const prompt = assertVoice(f, `mailbox-notice:${asked.id}`, CLI_NOTICE);
  assert.match(prompt, /^\[Inter-session notice\]/);
  assert.doesNotMatch(prompt, /say so in your topic/);
  assert.doesNotMatch(prompt, /polygram joins every message/, 'a notice is not told that its text is posted');
});

test('a notice tail only states what the turn can do, for every reason', () => {
  const ask = { id: 'm_00000000000000a1', kind: 'ask', from_addr: 'role:ops', to_addr: 'role:finance' };
  for (const reason of ['succeeded', 'failed', 'interrupted', 'unknown', 'reply-undelivered', 'reply-uncertain']) {
    const task = envelope.renderNoticeTask(ask, reason);
    assert.doesNotMatch(task, /say so in your topic/, reason);
    assert.match(task, /This turn can reply to asks but cannot start a new ask or tell\.$/, reason);
  }
});

test('a person\'s assistant is told to tell its person with the reply tool who asks what, by when, before the turn ends', async (t) => {
  const f = await fixture(t);
  const fromRole = f.mailbox.send(f.role(OPS), { to: 'mai', kind: 'ask', body: 'Can Mai approve the shoot budget?' });
  const fromAssistant = f.mailbox.send(f.person(DINA), { to: 'mai', kind: 'ask', body: 'Are you free on Friday?' });
  await f.run();
  for (const id of [fromRole.id, fromAssistant.id]) assertVoice(f, `mailbox:${id}`, CLI_VOICE + CLI_PERSON('Mai'));
  // The mailbox block agrees with the voice: a Claude CLI assistant's final
  // text is private, so it tells its person with the reply tool.
  assert.match(f.prompt(`mailbox:${fromRole.id}`), /In a turn another session started you cannot run the mailbox send or reply commands: tell Mai with the reply tool what is asked/,
    'on the Claude CLI "reply" is also the Telegram tool, so the mailbox commands are named');
  const roleTurn = f.mailbox.send(f.person(MAI), { to: 'ops', kind: 'tell', body: 'Approved.' });
  await f.run();
  assertVoice(f, `mailbox:${roleTurn.id}`);
  assert.doesNotMatch(buildExternalJobPrompt(f.dispatched.find((job) => job.requestId === `mailbox:${roleTurn.id}`)), /direct chat with you/,
    'a role\'s turn has no person sentence');
});

// Codex joins and posts every message of the turn and has no reply tool, so
// its turn is told that, and silence is writing nothing but NO_REPLY.
test('a Codex target gets the Codex wording, its person sentence included', async (t) => {
  const f = await fixture(t);
  const told = f.mailbox.send(f.role(OPS), { to: 'ivan', kind: 'tell', body: 'The report is ready.' });
  await f.run();
  const prompt = assertVoice(f, `mailbox:${told.id}`, CODEX_VOICE + CODEX_PERSON('Ivan'));
  assert.doesNotMatch(prompt.slice(prompt.indexOf('</untrusted-input>')), /reply tool/, 'Codex has no reply tool');
  assert.match(prompt, /cannot run the mailbox send or reply commands: tell Ivan what is asked in what you write, and reply/, 'the Codex assistant\'s mailbox block says the same');
});

test('a notice to an assistant gets the notice paragraph without the person sentence, and Codex its own notice wording', () => {
  const { renderJobVoice } = require('../lib/external-jobs/voice');
  assert.equal(renderJobVoice({ notice: true, person: 'Mai' }), CLI_NOTICE);
  assert.equal(renderJobVoice({ notice: true, backend: 'codex', person: 'Ivan' }), CODEX_NOTICE);
  assert.equal(renderJobVoice({ backend: 'sdk' }), CLI_VOICE, 'an unknown backend gets the Claude CLI wording');
  assert.equal(renderJobVoice(), CLI_VOICE);
});

test('jobs that are not mailbox messages end with the rule too: a notification batch and an API job, on both backends', async () => {
  const dispatched = [];
  const dispatch = createExternalJobDispatch({
    dispatchExternalEvent: (_origin, run) => run(),
    runtime: { dispatch: async (job) => { dispatched.push(job); return { outcome: 'succeeded' }; } },
    getBackend: ({ chatId }) => (chatId === '-1002' ? 'codex' : 'cli'),
  });
  for (const chatId of ['-1001', '-1002']) {
    const target = { chatId, threadId: '12', sessionKey: `${chatId}:12` };
    for (const requestId of ['notifications:1', 'daily-digest:2026-11-27']) {
      await dispatch({ id: 1, routeId: 'admin', requestId, task: 'Review the supplied data.', payload: { rows: 1 }, target }, {});
    }
  }
  assert.equal(dispatched.length, 4);
  for (const job of dispatched) {
    const prompt = buildExternalJobPrompt(job);
    assert.ok(prompt.startsWith('Review the supplied data.\n'));
    assert.ok(prompt.endsWith(`</untrusted-input>\n\n${job.target.chatId === '-1002' ? CODEX_VOICE : CLI_VOICE}`), job.requestId);
    assert.doesNotMatch(prompt, /direct chat with you/);
  }
});

test('a job stored before the rule existed gets it when dispatched', async (t) => {
  const f = await fixture(t);
  const sent = f.mailbox.send(f.role(OPS), { to: 'finance', kind: 'tell', body: 'Old news.' });
  // The stored task is exactly what was stored before this change: the rule
  // is never part of it.
  assert.ok(!f.stored(`mailbox:${sent.id}`).includes('NO_REPLY'));
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

// A notice queued before 0.56.1 keeps its stored ending, which still asks
// for a word in the topic; the notice paragraph comes last and its text is
// not posted anyway.
test('a notice stored with the old ending ends with the notice paragraph', async () => {
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
  const prompt = buildExternalJobPrompt(dispatched[0]);
  assert.ok(prompt.startsWith(`${old}\n`));
  assert.ok(prompt.endsWith(`</untrusted-input>\n\n${CLI_NOTICE}`));
});

'use strict';
// Universal addresses inside one bot: in an `intra: "open"` bot every Claude
// CLI or Codex session can message every other one by a readable alias, with
// no configured role or route. A bot with roles keeps today's rules exactly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const { createExternalJobTargetResolver } = require('../lib/external-jobs/runtime');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createMailboxService } = require('../lib/mailbox/service');
const envelope = require('../lib/mailbox/envelope');

const HOME = '-1003807211164';
const GROUP = '-1009';
const GENERAL = HOME;
const MUSIC = `${HOME}:3`;
const CODEX = `${HOME}:5`;
const ADMIN = `${HOME}:2995`;
const UNNAMED = `${HOME}:3528`;
const OPS_TOPIC = `${HOME}:40`;

function homeConfig(mailbox = {}) {
  return {
    bot: {
      operatorUserId: 68861949,
      externalJobs: { enabled: true, routes: { admin: { chatId: HOME, threadId: '2995' } } },
      mailbox: { enabled: true, ...mailbox },
    },
    chats: {
      [HOME]: { name: 'Shumabit@HOME', isolateTopics: true, topics: {
        3: { name: 'Music' }, 5: { name: 'Orchestra', pm: 'codex' }, 2995: { name: 'Admin' }, 3528: { model: 'opus' }, 40: 'Ops',
      } },
      [GROUP]: { name: 'Ops' },
    },
  };
}
const backendOf = ({ chatId, threadId }) => (chatId === HOME && String(threadId) === '5' ? 'codex' : 'cli');
// The same bot with its Ops group on the SDK backend.
const sdkGroupBackendOf = (where) => (where.chatId === GROUP ? 'sdk' : backendOf(where));

function fixture(t, { config = homeConfig(), posts = null, backends = backendOf } = {}) {
  const { db, dbPath } = freshDb('mailbox-universal');
  const resolveTarget = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: backends });
  const jobs = createExternalJobService({ config, db, botName: 'shumorobot', resolveTarget,
    dispatch: async () => ({ outcome: 'succeeded', inactive: true }), deliverPart: async () => ({}), logger: { error() {} } });
  const tg = posts ? async (_bot, method, params) => { posts.push({ method, params }); return { message_id: posts.length }; } : null;
  const service = createMailboxService({ config, db, botName: 'shumorobot', jobs, resolveTarget, resolveBackend: backends, getSessionKey,
    tg, bot: {}, sendRich: async () => ({ wentRich: false, fallback: 'unsupported' }),
    logger: { error() {}, warn() {} } });
  t.after(() => { service.stop(); jobs.stop(); cleanupDb(dbPath, db); });
  const human = (key) => { service.noteHumanPrompt(key, { operator: true }); return service.scope(key); };
  const row = (id) => db.raw.prepare('SELECT * FROM mailbox_messages WHERE id=?').get(id);
  const job = (routeId, requestId) => db.raw.prepare('SELECT * FROM external_jobs WHERE route_id=? AND request_id=?').get(routeId, requestId);
  return { db, config, jobs, service, human, row, job };
}
const coded = (code) => (error) => error?.code === code;

test('an open bot gives every Claude CLI and Codex session a grant, with the command in its prompt', (t) => {
  const f = fixture(t);
  for (const key of [GENERAL, MUSIC, ADMIN, UNNAMED, CODEX]) assert.match(f.service.scope(key), /^[0-9a-f-]{36}$/, key);
  assert.match(f.service.instructions(CODEX), /msg\.js" "shumorobot" "[0-9a-f-]{36}" send/, 'a Codex session can send and reply, so its prompt carries the command');
  assert.equal(f.service.scope('-555'), null, 'an unconfigured chat is not a session of this bot');
  assert.equal(f.service.roleForSession(MUSIC), null, 'sessions are not roles, so stop and pause policy is unchanged');
});

test('General asks Music by its topic name; the job runs on Music\'s own session route; Music\'s answer returns to General', (t) => {
  const f = fixture(t);
  const sent = f.service.send(f.human(GENERAL), { to: 'music', kind: 'ask', body: 'What did you add today?' });
  assert.deepEqual(sent, { id: sent.id, state: 'queued' });
  const ask = f.row(sent.id);
  assert.equal(ask.from_addr, `session:${GENERAL}`);
  assert.equal(ask.to_addr, `session:${MUSIC}`);
  assert.equal(ask.route_id, `session:${MUSIC}`, 'the route id is the address, so no configured route is needed');
  assert.deepEqual([ask.from_label, ask.to_label], ['general', 'music']);
  assert.ok(f.job(`session:${MUSIC}`, `mailbox:${sent.id}`), 'a delivery job exists on the implicit route');

  const answer = f.service.reply(f.human(MUSIC), { inReplyTo: sent.id, body: 'Three tracks.' });
  const reply = f.row(answer.id);
  assert.equal(reply.to_addr, `session:${GENERAL}`);
  assert.equal(reply.route_id, `session:${GENERAL}`);
  assert.deepEqual([reply.from_label, reply.to_label], ['music', 'general']);
  assert.ok(f.job(`session:${GENERAL}`, `mailbox:${answer.id}`));
});

test('aliases: topic name, t<id>, general, a plain chat\'s name, and the canonical address', (t) => {
  const f = fixture(t);
  const token = f.human(MUSIC);
  const to = (target) => f.row(f.service.send(token, { to: target, kind: 'tell', body: `hello ${target}` }).id).to_addr;
  assert.equal(to('general'), `session:${GENERAL}`);
  assert.equal(to('admin'), `session:${ADMIN}`);
  assert.equal(to('t3528'), `session:${UNNAMED}`, 'an unnamed topic is reachable as t<threadId>');
  assert.equal(to('t2995'), `session:${ADMIN}`, 't<threadId> also works for a named topic');
  assert.equal(to('shumabit-home'), `session:${GENERAL}`, 'a chat\'s slug names its bare session');
  assert.equal(to(`session:${UNNAMED}`), `session:${UNNAMED}`, 'the canonical address always works');
});

test('an alias that names two sessions is refused with the candidates; an unknown one is refused too', (t) => {
  const f = fixture(t);
  const token = f.human(GENERAL);
  assert.throws(() => f.service.send(token, { to: 'ops', kind: 'tell', body: 'x' }),
    (error) => error.code === 'MAILBOX_UNKNOWN_ADDRESS' && error.message.includes(`session:${OPS_TOPIC}`) && error.message.includes(`session:${GROUP}`));
  for (const to of ['sales', 'umi:ops', 'orca:main', 'role:ops', 'session:-1', '', 7]) {
    assert.throws(() => f.service.send(token, { to, kind: 'tell', body: 'x' }), coded('MAILBOX_UNKNOWN_ADDRESS'), String(to));
  }
});

test('every session\'s label names only it, so a header never points at the wrong sender', (t) => {
  const f = fixture(t);
  const fromTopic = f.service.send(f.human(OPS_TOPIC), { to: 'general', kind: 'tell', body: 'from the topic' });
  const fromGroup = f.service.send(f.human(GROUP), { to: 'general', kind: 'tell', body: 'from the group' });
  assert.equal(f.row(fromTopic.id).from_label, 't40', 'the topic and the group are both named Ops, so the topic uses t40');
  assert.equal(f.row(fromGroup.id).from_label, `session:${GROUP}`, 'with no unique name left, the canonical address');
  assert.match(envelope.renderTask(f.row(fromGroup.id)), new RegExp(`from=session:${GROUP} `));
});

test('a Codex session receives like any other: an ask to it is a job on its implicit route, and it answers with its own grant', (t) => {
  const f = fixture(t);
  const sent = f.service.send(f.human(GENERAL), { to: 'orchestra', kind: 'ask', body: 'What changed in Orchestra?' });
  assert.deepEqual(sent, { id: sent.id, state: 'queued' });
  assert.equal(f.row(sent.id).to_addr, `session:${CODEX}`);
  assert.equal(f.job(`session:${CODEX}`, `mailbox:${sent.id}`).state, 'queued', 'delivered by the same external-job path as a Claude session');
  const answer = f.service.reply(f.human(CODEX), { inReplyTo: sent.id, body: 'A new release.' });
  assert.equal(f.row(answer.id).from_addr, `session:${CODEX}`);
  assert.equal(f.row(answer.id).to_addr, `session:${GENERAL}`);
  const asked = f.service.send(f.human(CODEX), { to: 'music', kind: 'ask', body: 'Anything new?' });
  assert.equal(f.row(asked.id).from_addr, `session:${CODEX}`, 'a Codex session can start a conversation too');
});

test('an SDK session is still refused as a target, with a stable code', (t) => {
  const f = fixture(t, { backends: sdkGroupBackendOf });
  assert.equal(f.service.scope(GROUP), null, 'it cannot run the mailbox command, so it gets no grant');
  assert.throws(() => f.service.send(f.human(GENERAL), { to: `session:${GROUP}`, kind: 'ask', body: 'x' }), coded('MAILBOX_BACKEND_UNSUPPORTED'));
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM mailbox_messages').get().n, 0);
});

test('a session cannot message itself under any of its names', (t) => {
  const f = fixture(t);
  const token = f.human(MUSIC);
  for (const to of ['music', 't3', `session:${MUSIC}`]) assert.throws(() => f.service.send(token, { to, kind: 'ask', body: 'x' }), /itself/, to);
});

test('directory lists whom the caller may message, by the name to use, including who cannot receive yet', (t) => {
  const f = fixture(t);
  const listed = f.service.directory(f.human(GENERAL), {});
  const byAddress = Object.fromEntries(listed.targets.map((entry) => [entry.address, entry]));
  assert.equal(byAddress[`session:${GENERAL}`], undefined, 'the caller is not listed');
  assert.deepEqual(byAddress[`session:${MUSIC}`], { to: 'music', address: `session:${MUSIC}`, name: 'Shumabit@HOME / Music', canReceive: true });
  assert.deepEqual(byAddress[`session:${CODEX}`], { to: 'orchestra', address: `session:${CODEX}`, name: 'Shumabit@HOME / Orchestra', canReceive: true });
  assert.equal(byAddress[`session:${OPS_TOPIC}`].to, 't40', 'an ambiguous alias gives way to one that names only this session');
  assert.equal(byAddress[`session:${GROUP}`].to, `session:${GROUP}`, 'with no unique alias left, the canonical address');
  assert.equal(byAddress[`session:${UNNAMED}`].to, 't3528');
  assert.equal(listed.you, 'general');
  assert.throws(() => f.service.directory('invented', {}), /token/i);
  assert.throws(() => f.service.directory(f.service.scope(GENERAL), { extra: 1 }), /unknown mailbox field/i);
});

test('open lists the caller\'s asks still waiting for a reply, with their delivery state', (t) => {
  const f = fixture(t);
  const token = f.human(GENERAL);
  const first = f.service.send(token, { to: 'music', kind: 'ask', body: 'one' });
  const second = f.service.send(token, { to: 'admin', kind: 'ask', body: 'two' });
  f.service.send(token, { to: 'admin', kind: 'tell', body: 'fyi' });
  f.service.reply(f.human(MUSIC), { inReplyTo: first.id, body: 'done' });
  const { asks } = f.service.open(f.service.scope(GENERAL), {});
  assert.deepEqual(asks.map((ask) => [ask.id, ask.to, ask.state]), [[second.id, 'admin', 'queued']]);
  assert.deepEqual(f.service.open(f.service.scope(ADMIN), {}).asks, [], 'another session sees only its own asks');
});

test('the trusted header and the mirror card name sessions by label, never by transport id', (t) => {
  const posts = [];
  const f = fixture(t, { posts });
  const sent = f.service.send(f.human(GENERAL), { to: 'music', kind: 'ask', body: 'Status?' });
  const task = envelope.renderTask(f.row(sent.id));
  assert.match(task, /^\[Inter-session message\] from=general to=music kind=ask id=m_[0-9a-f]{16} isUser=false/);
  assert.doesNotMatch(task, /session:/);
  assert.match(envelope.renderMirror(f.row(sent.id)), /general asks music/);
  return new Promise(setImmediate).then(() => new Promise(setImmediate)).then(() => {
    const target = posts.find((post) => post.params.message_thread_id === '3');
    assert.ok(target, 'the card lands in Music, the target session\'s own topic');
    assert.doesNotMatch(target.params.text, /session:|-100/);
  });
});

test('configuration: intra must be open or roles; allow belongs to roles; unbuilt keys still fail boot', (t) => {
  const { db, dbPath } = freshDb('mailbox-universal-config');
  t.after(() => cleanupDb(dbPath, db));
  const build = (mailbox) => {
    const config = homeConfig(mailbox);
    const resolveTarget = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: backendOf });
    return createMailboxService({ config, db, botName: 'b', jobs: {}, resolveTarget, resolveBackend: backendOf, getSessionKey });
  };
  assert.throws(() => build({ intra: 'everyone' }), /intra/);
  assert.throws(() => build({ intra: 'open', allow: { x: ['*'] } }), /allow/);
  assert.throws(() => build({ peers: {} }), /Unknown mailbox key peers/);
  assert.throws(() => build({ orca: {} }), /Unknown mailbox key orca/);
  assert.equal(build({}).enabled, true, 'no roles: open by default');
  assert.equal(build({ intra: 'open' }).scope(MUSIC) !== null, true);
});

// A bot with roles keeps today's behaviour exactly: only roles start, only
// allowlisted targets, and its other sessions get nothing new.
function rolesConfig() {
  const config = homeConfig({
    roles: { lead: { about: 'Leads' }, music: { about: 'Music role' } },
    allow: { lead: ['*'] },
  });
  config.bot.externalJobs.routes.lead = { chatId: HOME, general: true };
  config.bot.externalJobs.routes.music = { chatId: HOME, threadId: '3' };
  return config;
}

test('roles bot: a role may run on Codex, and its deliveries travel on its configured route', (t) => {
  const config = rolesConfig();
  config.bot.mailbox.roles.orchestra = { about: 'Runs releases' };
  config.bot.externalJobs.routes.orchestra = { chatId: HOME, threadId: '5' };
  const f = fixture(t, { config });
  assert.match(f.service.scope(CODEX), /^[0-9a-f-]{36}$/, 'a Codex role gets its grant like any role');
  const sent = f.service.send(f.human(GENERAL), { to: 'orchestra', kind: 'ask', body: 'Ready to ship?' });
  assert.equal(f.row(sent.id).route_id, 'orchestra');
  assert.equal(f.row(sent.id).to_addr, 'role:orchestra');
});

test('roles bot: a role on an SDK session still fails boot', () => {
  const config = rolesConfig();
  config.bot.mailbox.roles.ops = { about: 'Ops' };
  config.bot.externalJobs.routes.ops = { chatId: GROUP };
  const resolveTarget = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: sdkGroupBackendOf });
  assert.throws(() => createMailboxService({ config, db: null, botName: 'shumorobot', jobs: {}, resolveTarget, resolveBackend: sdkGroupBackendOf, getSessionKey }),
    /Mailbox role ops: External jobs require the Claude CLI or Codex backend/);
});

test('roles bot: other sessions get no grant, and roles cannot reach them', (t) => {
  const f = fixture(t, { config: rolesConfig() });
  assert.equal(f.service.scope(ADMIN), null);
  assert.equal(f.service.scope(UNNAMED), null);
  const lead = f.human(GENERAL);
  for (const to of ['admin', 'ops', `session:${ADMIN}`, 'sales']) {
    assert.throws(() => f.service.send(lead, { to, kind: 'tell', body: 'x' }),
      (error) => error.code === 'MAILBOX_UNKNOWN_ROLE' && error.message === 'Unknown role',
      `${to}: a roles bot names only roles, with today's code, and never lists other sessions`);
  }
  const sent = f.service.send(lead, { to: 'music', kind: 'ask', body: 'x' });
  assert.deepEqual([f.row(sent.id).from_addr, f.row(sent.id).to_addr, f.row(sent.id).route_id], ['role:lead', 'role:music', 'music'],
    'role rows keep role addresses and configured routes');
  assert.throws(() => f.service.send(f.human(MUSIC), { to: 'lead', kind: 'ask', body: 'x' }), coded('MAILBOX_NOT_ALLOWED'),
    'a role without an allow entry can only reply');
});

test('roles bot: the per-prompt instructions are unchanged', (t) => {
  const f = fixture(t, { config: rolesConfig() });
  f.human(GENERAL);
  const text = f.service.instructions(GENERAL);
  assert.match(text, /you are role:lead in an organization of agent sessions\. Roles you may message: music \(Music role\)\./);
  assert.doesNotMatch(text, /directory/);
});

test('open bot: the per-prompt instructions name the caller and point to directory, without listing every session', (t) => {
  const f = fixture(t);
  f.human(MUSIC);
  const text = f.service.instructions(MUSIC);
  assert.match(text, /you are music/);
  assert.match(text, / directory/);
  assert.match(text, / open/);
  assert.doesNotMatch(text, /admin|t3528/);
});

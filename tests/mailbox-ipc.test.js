'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createIpcHandlers } = require('../lib/ipc/handlers');
const server = require('../lib/ipc/server');

const SCRIPT = path.join(__dirname, '..', 'skills', 'mailbox', 'scripts', 'msg.js');

test('mailbox ops pass the token separately and strip transport metadata', async () => {
  const seen = [];
  const handlers = createIpcHandlers({ mailbox: {
    send: (token, input) => { seen.push(['send', token, input]); return { id: 'm_1', state: 'queued' }; },
    reply: (token, input) => { seen.push(['reply', token, input]); return { id: 'm_2', state: 'queued' }; },
  } });
  assert.deepEqual(await handlers.mailbox_send({ op: 'mailbox_send', id: null, secret: 's', token: 'tok', to: 'ops', kind: 'ask', body: 'Q' }), { id: 'm_1', state: 'queued' });
  await handlers.mailbox_reply({ op: 'mailbox_reply', secret: 's', token: 'tok', inReplyTo: 'm_1', body: 'A' });
  assert.deepEqual(seen, [['send', 'tok', { to: 'ops', kind: 'ask', body: 'Q' }], ['reply', 'tok', { inReplyTo: 'm_1', body: 'A' }]]);
});

test('mailbox_submit passes the sender fields and strips transport metadata', async () => {
  const seen = [];
  const handlers = createIpcHandlers({ mailbox: { submit: (input) => { seen.push(input); return { id: 'm_1', state: 'queued' }; } } });
  assert.deepEqual(await handlers.mailbox_submit({ op: 'mailbox_submit', id: 'req-1', secret: 's', sender: 'agent-org', to: 'ops', body: 'B', key: 'k', ref: 'r' }),
    { id: 'm_1', state: 'queued' });
  assert.deepEqual(seen, [{ sender: 'agent-org', to: 'ops', body: 'B', key: 'k', ref: 'r' }]);
});

test('without a mailbox the ops refuse', async () => {
  const handlers = createIpcHandlers();
  await assert.rejects(async () => handlers.mailbox_send({ token: 't', to: 'x', kind: 'ask', body: 'y' }), /mailbox is disabled/i);
  await assert.rejects(async () => handlers.mailbox_reply({ token: 't', inReplyTo: 'm', body: 'y' }), /mailbox is disabled/i);
  await assert.rejects(async () => handlers.mailbox_submit({ sender: 's', to: 'x', body: 'y', key: 'k' }), /mailbox is disabled/i);
});

test('the skill script sends over the authenticated socket and maps the reply id', async (t) => {
  // The IPC directory refuses temporary locations, as in production.
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.mbx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, POLYGRAM_IPC_DIR: dir, POLYGRAM_IPC_SECRET: 'synthetic-secret' };
  const seen = [];
  const ipc = await server.start({
    path: server.socketPathFor('testbot', { env }), secret: 'synthetic-secret', logger: { error() {}, log() {} },
    handlers: createIpcHandlers({ mailbox: {
      send: (token, input) => { seen.push(['send', token, input]); return { id: 'm_1', state: 'queued' }; },
      reply: (token, input) => { if (input.body === 'fail') throw new Error('That ask already has a reply'); seen.push(['reply', token, input]); return { id: 'm_2', state: 'paused' }; },
    } }),
  });
  t.after(() => ipc.close());
  const run = (...args) => promisify(execFile)(process.execPath, [SCRIPT, ...args], { env });
  const sent = await run('testbot', 'tok', 'send', '{"to":"ops","kind":"ask","body":"Q"}');
  assert.deepEqual(JSON.parse(sent.stdout), { id: 'm_1', ok: true, state: 'queued' });
  const replied = await run('testbot', 'tok', 'reply', '{"id":"m_1","body":"A"}');
  assert.equal(JSON.parse(replied.stdout).state, 'paused');
  assert.deepEqual(seen, [['send', 'tok', { to: 'ops', kind: 'ask', body: 'Q' }], ['reply', 'tok', { inReplyTo: 'm_1', body: 'A' }]]);
  await run('testbot', 'tok', 'send', '{"to":"ops","token":"forged","kind":"ask","body":"Q"}');
  assert.equal(seen.at(-1)[1], 'tok', 'the command-line token always wins over a token inside the JSON');
  await assert.rejects(run('testbot', 'tok', 'reply', '{"id":"m_1","body":"fail"}'), (error) => /already has a reply/.test(error.stderr) && error.code === 1);
  await assert.rejects(run('testbot', 'tok', 'forward', '{}'), (error) => /Usage/.test(error.stderr));
  await assert.rejects(run('testbot', 'tok', 'send', '[1]'), (error) => /JSON object/.test(error.stderr));
});

test('stray transport keys in the agent JSON cannot reroute the call or replace the request id', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.mbx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, POLYGRAM_IPC_DIR: dir, POLYGRAM_IPC_SECRET: 'synthetic-secret' };
  const requests = []; const submitted = [];
  const handlers = createIpcHandlers({
    mailbox: { send: (token, input) => ({ id: 'm_1', state: 'queued', input }), reply: (token, input) => ({ id: 'm_2', state: 'queued', input }) },
    externalJobs: { submit: (input) => { submitted.push(input); return { accepted: true }; } },
  });
  const spy = (op) => (req) => { requests.push({ op, req }); return handlers[op](req); };
  const ipc = await server.start({
    path: server.socketPathFor('testbot', { env }), secret: 'synthetic-secret', logger: { error() {}, log() {} },
    handlers: { ...handlers, mailbox_send: spy('mailbox_send'), mailbox_reply: spy('mailbox_reply') },
  });
  t.after(() => ipc.close());
  const run = (...args) => promisify(execFile)(process.execPath, [SCRIPT, ...args], { env });
  const sent = JSON.parse((await run('testbot', 'tok', 'send', '{"to":"ops","kind":"ask","body":"Q","op":"external_job_submit","id":"forged","secret":"forged"}')).stdout);
  const replied = JSON.parse((await run('testbot', 'tok', 'reply', '{"id":"m_1","body":"A","op":"external_job_submit","secret":"forged"}')).stdout);
  assert.deepEqual(submitted, [], 'the call was never rerouted to another op');
  assert.deepEqual(requests.map((r) => r.op), ['mailbox_send', 'mailbox_reply']);
  for (const { req } of requests) { assert.equal(req.id, null, 'the transport id is the client\'s, not the agent\'s'); assert.equal(req.secret, 'synthetic-secret'); }
  assert.deepEqual(sent.input, { to: 'ops', kind: 'ask', body: 'Q' });
  assert.deepEqual(replied.input, { inReplyTo: 'm_1', body: 'A' });
});

test('the injected command reaches the daemon from a session whose environment lacks the IPC location', async (t) => {
  // A CLI session gets its environment from whoever started the tmux server,
  // which is often not the daemon, so the command must carry the IPC location.
  const { freshDb, cleanupDb } = require('./helpers/db-fixture');
  const { createExternalJobService } = require('../lib/external-jobs/service');
  const { createMailboxService } = require('../lib/mailbox/service');
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.mbx-'));
  const elsewhere = fs.mkdtempSync(path.join(process.cwd(), '.mbx-cwd-'));
  const { db, dbPath } = freshDb('mailbox-command');
  t.after(() => { cleanupDb(dbPath, db); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true }); });
  const routes = { orchestrator: { chatId: '-1001', threadId: '11' }, marketing: { chatId: '-1001', threadId: '12' } };
  const resolveTarget = (route) => ({ chatId: route.chatId, threadId: route.threadId, sessionKey: `${route.chatId}:${route.threadId}` });
  const config = { bot: { externalJobs: { enabled: true, routes }, mailbox: { enabled: true,
    roles: { orchestrator: { about: 'Strategy' }, marketing: { about: 'Campaigns' } }, allow: { orchestrator: ['*'] } } } };
  const jobs = createExternalJobService({ config, db, botName: 'testbot', resolveTarget, dispatch: async () => ({}), deliverPart: async () => ({}), logger: { error() {} } });
  const mailbox = createMailboxService({ config, db, botName: 'testbot', jobs, resolveTarget, ipcDir: dir, logger: { error() {}, warn() {} } });
  const ipcOptions = { env: { POLYGRAM_IPC_DIR: dir } };
  const secret = server.writeSecret('testbot', ipcOptions);
  const ipc = await server.start({ path: server.socketPathFor('testbot', ipcOptions), secret, logger: { error() {}, log() {} }, handlers: createIpcHandlers({ mailbox }) });
  t.after(() => ipc.close());

  mailbox.noteHumanPrompt('-1001:11');
  const command = /Ask or tell another role: run (.+?) send '/.exec(mailbox.instructions('-1001:11'))[1];
  const env = { ...process.env }; delete env.POLYGRAM_IPC_DIR; delete env.POLYGRAM_IPC_SECRET;
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `${command} send '{"to":"marketing","kind":"ask","body":"Launch date?"}'`], { env, cwd: elsewhere });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true);
  assert.equal(db.raw.prepare('SELECT from_addr FROM mailbox_messages WHERE id=?').get(receipt.id).from_addr, 'role:orchestrator');
});

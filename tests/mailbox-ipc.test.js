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

test('without a mailbox the ops refuse', async () => {
  const handlers = createIpcHandlers();
  await assert.rejects(async () => handlers.mailbox_send({ token: 't', to: 'x', kind: 'ask', body: 'y' }), /mailbox is disabled/i);
  await assert.rejects(async () => handlers.mailbox_reply({ token: 't', inReplyTo: 'm', body: 'y' }), /mailbox is disabled/i);
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

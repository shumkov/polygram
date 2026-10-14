'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIpcHandlers } = require('../lib/ipc/handlers');

test('public external-job operations remove transport metadata and expose no domain or resume API', async () => {
  const request = { routeId: 'review', requestId: 'stable', task: 'Review', payload: {} };
  const handlers = createIpcHandlers({ externalJobs: {
    info: () => ({ protocolVersion: 1, enabled: true }),
    submit: (req) => { assert.deepEqual(req, request); return { accepted: true }; },
    get: (req) => ({ job: req }), status: (req) => ({ route: req.routeId }),
  } });
  assert.equal((await handlers.external_jobs_info({})).protocolVersion, 1);
  assert.equal((await handlers.external_job_submit({ ...request, op: 'external_job_submit', id: 'transport', secret: 'private' })).accepted, true);
  assert.deepEqual(await handlers.external_job_get({ routeId: 'review', requestId: 'stable', op: 'external_job_get' }), { job: { routeId: 'review', requestId: 'stable' } });
  assert.deepEqual(await handlers.external_jobs_status({ routeId: 'review' }), { route: 'review' });
  for (const op of ['ingest_event', 'infra_observe', 'infra_incidents', 'infra_status', 'infra_tick', 'external_jobs_resume']) assert.equal(handlers[op], undefined);
});

test('disabled external jobs advertise incompatibility without accepting work', async () => {
  const handlers = createIpcHandlers();
  assert.deepEqual(await handlers.external_jobs_info({}), { protocolVersion: 1, enabled: false, supportedBackends: ['cli'] });
  await assert.rejects(async () => handlers.external_job_submit({}), /not enabled/);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const publicClient = require('..');

test('separate client process submits domain-neutral work through the authenticated public API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-ipc-'));
  const socket = path.join(dir, 'ipc.sock');
  const child = fork(path.join(__dirname, 'helpers/external-jobs-server.js'), { env: { ...process.env, JOB_TEST_DATABASE: path.join(dir, 'jobs.db'), JOB_TEST_SOCKET: socket }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('close'); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual((await once(child, 'message'))[0], { ready: true });
  const call = (op, payload = {}, secret = 'synthetic-secret') => publicClient.call({ path: socket, secret, op, payload, callTimeoutMs: 2000 });
  assert.equal((await call('external_jobs_info', {}, 'wrong')).ok, false);
  assert.equal((await call('external_jobs_info')).protocolVersion, 1);
  const request = { routeId: 'review', requestId: 'weekly-document', task: 'Review a document', payload: { document: 'fixture' } };
  assert.equal((await call('external_job_submit', request)).accepted, true);
  assert.equal((await call('external_job_submit', request)).duplicate, true);
  let final;
  for (let n = 0; n < 100; n++) {
    final = await call('external_job_get', { routeId: request.routeId, requestId: request.requestId });
    if (final.job.reportState === 'delivered') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(final.job.state, 'succeeded');
  assert.equal(final.job.turnId, 'turn-1');
  assert.equal(final.job.reportState, 'delivered');
  assert.equal(final.job.reportReceipt.parts[0].receipt.messageId, 1);
  assert.equal((await call('external_job_submit', { ...request, payload: { document: 'changed' } })).ok, false);
  assert.equal((await call('infra_status')).ok, false);
});

for (const boundary of ['execution', 'report']) {
  test(`physical daemon crash at ${boundary} reopens durable state without repeating the uncertain effect`, { timeout: 10000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-crash-'));
    const socket = path.join(dir, 'ipc.sock');
    let child;
    async function kill() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    async function start() {
      child = fork(path.join(__dirname, 'helpers/external-jobs-server.js'), { env: { ...process.env, JOB_TEST_DATABASE: path.join(dir, 'jobs.db'), JOB_TEST_SOCKET: socket }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      assert.deepEqual((await once(child, 'message'))[0], { ready: true });
    }
    t.after(async () => { await kill(); fs.rmSync(dir, { recursive: true, force: true }); });
    await start();
    const call = (op, payload) => publicClient.call({ path: socket, secret: 'synthetic-secret', op, payload, callTimeoutMs: 2000 });
    const request = { routeId: 'review', requestId: 'crash-fixture', task: 'Synthetic review', payload: { crashAt: boundary } };
    const reached = once(child, 'message');
    assert.equal((await call('external_job_submit', request)).accepted, true);
    assert.deepEqual((await reached)[0], { boundary });
    await kill(); await start();
    const recovered = (await call('external_job_get', { routeId: request.routeId, requestId: request.requestId })).job;
    assert.equal(recovered.state, boundary === 'execution' ? 'unknown' : 'succeeded');
    assert.equal(recovered.reportState, boundary === 'report' ? 'unknown' : 'none');
    assert.equal(recovered.turnId, 'turn-1');
    assert.equal((await call('external_job_submit', request)).duplicate, true);
    const afterDuplicate = (await call('external_job_get', { routeId: request.routeId, requestId: request.requestId })).job;
    assert.equal(afterDuplicate.state, recovered.state);
    assert.equal(afterDuplicate.reportState, recovered.reportState);
    assert.equal(afterDuplicate.turnId, recovered.turnId);
  });
}

test('acceptance reply lost on the actual socket is recovered without another execution', { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-lost-reply-'));
  const socket = path.join(dir, 'ipc.sock');
  const child = fork(path.join(__dirname, 'helpers/external-jobs-server.js'), { env: { ...process.env, JOB_TEST_DATABASE: path.join(dir, 'jobs.db'), JOB_TEST_SOCKET: socket, JOB_TEST_DROP_ACK: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual((await once(child, 'message'))[0], { ready: true });
  const request = { routeId: 'review', requestId: 'lost-on-wire', task: 'Synthetic review', payload: {} };
  const call = (op, payload, timeout = 2000) => publicClient.call({ path: socket, secret: 'synthetic-secret', op, payload, callTimeoutMs: timeout });
  const accepted = once(child, 'message');
  const lostReply = assert.rejects(call('external_job_submit', request, 1000), /timeout/);
  assert.deepEqual((await accepted)[0], { boundary: 'acceptance' });
  await lostReply;
  const duplicate = await call('external_job_submit', request);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.turnId, 'turn-1');
  assert.equal(duplicate.job.reportState, 'delivered');
  assert.equal(duplicate.job.reportReceipt.parts[0].receipt.messageId, 1);
});

test('accepted queued work survives process death and executes once after startup', { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-accepted-crash-'));
  const socket = path.join(dir, 'ipc.sock');
  let child;
  async function kill() {
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  }
  async function start(hold) {
    child = fork(path.join(__dirname, 'helpers/external-jobs-server.js'), { env: { ...process.env, JOB_TEST_DATABASE: path.join(dir, 'jobs.db'), JOB_TEST_SOCKET: socket, JOB_TEST_HOLD_QUEUE: hold ? '1' : '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    assert.deepEqual((await once(child, 'message'))[0], { ready: true });
  }
  t.after(async () => { await kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (op, payload) => publicClient.call({ path: socket, secret: 'synthetic-secret', op, payload, callTimeoutMs: 2000 });
  const request = { routeId: 'review', requestId: 'accepted-before-crash', task: 'Synthetic review', payload: {} };
  await start(true);
  assert.equal((await call('external_job_submit', request)).job.state, 'queued');
  await kill(); await start(false);
  let job;
  for (let n = 0; n < 100; n++) {
    job = (await call('external_job_get', request)).job;
    if (job.reportState === 'delivered') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.state, 'succeeded');
  assert.equal(job.reportState, 'delivered');
  assert.equal((await call('external_job_submit', request)).duplicate, true);
  const stats = once(child, 'message'); child.send('stats');
  assert.deepEqual((await stats)[0], { stats: { executions: 1, deliveries: 1 } });
});

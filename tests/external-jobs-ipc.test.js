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

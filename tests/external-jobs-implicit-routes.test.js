'use strict';
// A mailbox delivery to a session that is not a configured role travels on an
// implicit route whose id is the session's address, `session:<sessionKey>`.
// These tests pin that every external-job stage accepts such a route only
// when it rebuilds to exactly that session, that the reserved address
// prefixes cannot be configured as ordinary route ids, and that IPC clients
// outside the daemon cannot use implicit routes to reach arbitrary sessions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAsyncLock } = require('@shumkov/orchestra');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const {
  createExternalJobTargetResolver, createExternalJobRuntime, findAutomationDestination, resolveRouteId,
} = require('../lib/external-jobs/runtime');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createIpcHandlers } = require('../lib/ipc/handlers');

const FORUM = '-1003807211164';
function makeConfig(extra = {}) {
  return {
    bot: { operatorUserId: 7, externalJobs: { enabled: true, routes: { admin: { chatId: FORUM, threadId: '2995' } } }, ...extra },
    chats: {
      [FORUM]: { name: 'Shumabit@HOME', isolateTopics: true, topics: { 3: { name: 'Music' }, 2995: { name: 'Admin' } } },
      '-1002': { name: 'Shared forum', topics: { 5: 'Ops' } },
      '-1009': { name: 'Plain group' },
    },
  };
}
const resolverFor = (config) => createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: () => 'cli' });

test('a session route rebuilds the topic, General or plain-chat destination from the session key', () => {
  const config = makeConfig();
  const resolve = resolverFor(config);
  assert.deepEqual(resolveRouteId(config, resolve, `session:${FORUM}:3`), { chatId: FORUM, threadId: '3', sessionKey: `${FORUM}:3` });
  assert.deepEqual(resolveRouteId(config, resolve, `session:${FORUM}`), { chatId: FORUM, threadId: null, sessionKey: FORUM },
    'a bare key in a forum is its General session');
  assert.deepEqual(resolveRouteId(config, resolve, 'session:-1002'), { chatId: '-1002', threadId: null, sessionKey: '-1002' },
    'a forum without isolated topics has one session, reported in General');
  assert.deepEqual(resolveRouteId(config, resolve, 'session:-1009'), { chatId: '-1009', threadId: null, sessionKey: '-1009' });
  assert.deepEqual(resolveRouteId(config, resolve, 'admin'), { chatId: FORUM, threadId: '2995', sessionKey: `${FORUM}:2995` },
    'configured routes resolve as before');
});

test('a session route that does not rebuild to exactly its own session is unavailable', () => {
  const config = makeConfig();
  const resolve = resolverFor(config);
  for (const routeId of [
    'session:-1002:5', // a topic of a non-isolated forum shares the chat session, so this key never names a session
    `session:${FORUM}:99`, // a topic that is not configured
    'session:-555', // a chat that is not configured
    'session:abc', `session:${FORUM}:0`, `session:${FORUM}:3:4`, 'session:', 'peer:umi/role:ops', 'orca:abc',
  ]) {
    assert.throws(() => resolveRouteId(config, resolve, routeId), (error) => error.code === 'EXTERNAL_JOB_ROUTE_UNAVAILABLE', routeId);
  }
});

test('reserved address prefixes cannot be used as configured route ids, so boot fails', (t) => {
  const { db, dbPath } = freshDb('implicit-routes-boot');
  t.after(() => cleanupDb(dbPath, db));
  for (const id of ['session:x', 'peer:umi', 'orca:main']) {
    const config = makeConfig();
    config.bot.externalJobs.routes[id] = { chatId: FORUM, threadId: '3' };
    assert.throws(() => createExternalJobService({ config, db, botName: 'b', resolveTarget: resolverFor(config), dispatch: async () => ({}) }),
      /reserved/i, id);
  }
  const ok = makeConfig();
  ok.bot.externalJobs.routes.orchestrator = { chatId: FORUM, threadId: '3' };
  assert.doesNotThrow(() => createExternalJobService({ config: ok, db, botName: 'b', resolveTarget: resolverFor(ok), dispatch: async () => ({}) }),
    'a route merely starting with the letters of a prefix is fine');
});

test('the service accepts, reports status for and settles a job on a session route', async (t) => {
  const { db, dbPath } = freshDb('implicit-routes-service');
  const config = makeConfig();
  const dispatched = [];
  const jobs = createExternalJobService({ config, db, botName: 'b', resolveTarget: resolverFor(config),
    dispatch: async (job) => { dispatched.push(job); return { outcome: 'succeeded', inactive: true }; }, deliverPart: async () => ({}), logger: { error() {} } });
  t.after(() => { jobs.stop(); cleanupDb(dbPath, db); });
  const routeId = `session:${FORUM}:3`;
  const receipt = jobs.submit({ routeId, requestId: 'mailbox:m_0000000000000001', task: 'T', payload: {} });
  assert.equal(receipt.job.state, 'queued');
  assert.deepEqual(jobs.status(routeId), { enabled: true, pending: 1, running: 0, paused: false });
  jobs.start();
  await jobs.tick();
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].target, { chatId: FORUM, threadId: '3', sessionKey: `${FORUM}:3` });
  assert.equal(jobs.get({ routeId, requestId: 'mailbox:m_0000000000000001' }).job.state, 'succeeded');
});

test('a queued job on a session route is held, not run, once its topic disappears', async (t) => {
  const { db, dbPath } = freshDb('implicit-routes-held');
  const config = makeConfig();
  const dispatched = [];
  const jobs = createExternalJobService({ config, db, botName: 'b', resolveTarget: resolverFor(config),
    dispatch: async (job) => { dispatched.push(job); return { outcome: 'succeeded', inactive: true }; }, deliverPart: async () => ({}), logger: { error() {} } });
  t.after(() => { jobs.stop(); cleanupDb(dbPath, db); });
  const routeId = `session:${FORUM}:3`;
  jobs.submit({ routeId, requestId: 'mailbox:m_0000000000000002', task: 'T', payload: {} });
  delete config.chats[FORUM].topics[3];
  jobs.start();
  await jobs.tick();
  assert.equal(dispatched.length, 0);
  const held = jobs.get({ routeId, requestId: 'mailbox:m_0000000000000002' }).job;
  assert.equal(held.state, 'queued');
  assert.equal(held.error, 'Configured route changed or is unavailable', 'held by the route check, not merely skipped');
});

test('an unknown job on a session route recovers through the same route check', async (t) => {
  const { db, dbPath } = freshDb('implicit-routes-recovery');
  const config = makeConfig();
  const recovered = [];
  const jobs = createExternalJobService({ config, db, botName: 'b', resolveTarget: resolverFor(config),
    dispatch: async () => ({ outcome: 'unknown', inactive: false }), deliverPart: async () => ({}), logger: { error() {} },
    recoverInactive: async (job, confirmInactive) => { recovered.push(job.target.sessionKey); confirmInactive(); return true; } });
  t.after(() => { jobs.stop(); cleanupDb(dbPath, db); });
  const routeId = `session:${FORUM}:3`;
  const requestId = 'mailbox:m_0000000000000003';
  jobs.submit({ routeId, requestId, task: 'T', payload: {} });
  jobs.start();
  await jobs.tick();
  assert.equal(jobs.get({ routeId, requestId }).job.state, 'unknown');
  await jobs.prepareRecovery({ routeId, requestId });
  assert.deepEqual(recovered, [`${FORUM}:3`]);
  assert.equal(jobs.get({ routeId, requestId }).job.inactive, true);
  delete config.chats[FORUM].topics[3];
  await assert.rejects(jobs.prepareRecovery({ routeId, requestId }), (error) => error.code === 'EXTERNAL_JOB_RECOVERY_UNAVAILABLE',
    'a session route that no longer resolves cannot be recovered');
});

test('the runtime admits a session-route job only while its route still names the same session', async () => {
  const config = makeConfig();
  const sent = [];
  const entry = { backend: 'cli', inFlight: false, probeBusyState: async () => ({ busy: false }) };
  const runtime = createExternalJobRuntime({
    config, pm: { get: () => entry }, intentLock: createAsyncLock(), getSessionKey,
    resolveBackend: () => 'cli', isPaused: () => false, isShuttingDown: () => false,
    needsAuth: () => false, awaitSessionRecovery: async () => {}, getOrSpawnForChat: async () => entry,
    sendToProcess: async (...args) => { sent.push(args); args[3].onDispatched(); return { text: 'Done.' }; },
  });
  const job = { id: 1, routeId: `session:${FORUM}:3`, requestId: 'mailbox:m_1', task: 'T', payload: {},
    target: { chatId: FORUM, threadId: '3', sessionKey: `${FORUM}:3` } };
  assert.equal((await runtime.dispatch(job)).outcome, 'succeeded');
  assert.equal(sent.length, 1);
  delete config.chats[FORUM].topics[3];
  assert.deepEqual(await runtime.dispatch(job), { deferred: true, reason: 'Configured route changed or is unavailable' });
});

test('session routes never become automation destinations, so stop and /automation keep their meaning', () => {
  const config = makeConfig();
  assert.equal(findAutomationDestination({ config, getSessionKey }, FORUM, '3'), null, 'Music has no configured route');
  assert.equal(findAutomationDestination({ config, getSessionKey }, FORUM, '2995')?.routeId, 'admin');
});

test('IPC clients cannot submit to or inspect implicit or reserved routes', async () => {
  const seen = [];
  const handlers = createIpcHandlers({ externalJobs: {
    info: () => ({}), submit: (req) => { seen.push(req); return { accepted: true }; },
    get: (req) => ({ job: req }), status: (req) => { seen.push(req); return {}; },
  } });
  for (const routeId of [`session:${FORUM}:3`, 'peer:umi', 'orca:x']) {
    await assert.rejects(async () => handlers.external_job_submit({ routeId, requestId: 'r', task: 'T', payload: {} }),
      (error) => error.code === 'EXTERNAL_JOB_ROUTE_UNAVAILABLE', routeId);
    await assert.rejects(async () => handlers.external_jobs_status({ routeId }),
      (error) => error.code === 'EXTERNAL_JOB_ROUTE_UNAVAILABLE', routeId);
  }
  assert.deepEqual(seen, []);
  assert.equal((await handlers.external_job_submit({ routeId: 'admin', requestId: 'r', task: 'T', payload: {} })).accepted, true);
});

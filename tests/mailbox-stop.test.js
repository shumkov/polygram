'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseExpressionAt } = require('acorn');
const { createAsyncLock } = require('@shumkov/orchestra');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { getSessionKey } = require('../lib/session-key');
const { isAbortRequest } = require('../lib/abort-detector');
const { createHandleAbort } = require('../lib/handlers/abort');
const runtime = require('../lib/external-jobs/runtime');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');
const { createMailboxService } = require('../lib/mailbox/service');

// Evaluate the daemon's actual dependency wiring without booting a bot.
const source = fs.readFileSync(require.resolve('../polygram.js'), 'utf8');
const start = source.indexOf('createHandleAbort(', source.indexOf('handleAbortIfRequested = createHandleAbort('));
const wiring = source.slice(start, parseExpressionAt(source, start, { ecmaVersion: 'latest' }).end);
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(setImmediate); };
const CHAT = '-1004292131077';

function fixture(t, { enabled = true, general = false } = {}) {
  const { db, dbPath } = freshDb('mailbox-stop');
  const roleRoute = general ? { chatId: CHAT, general: true } : { chatId: CHAT, threadId: '142' };
  const sessionKey = general ? CHAT : `${CHAT}:142`;
  const config = { bot: { operatorUserId: 7,
    externalJobs: { enabled: true, routes: { infra: { chatId: CHAT, threadId: '2995' }, alias: roleRoute, prices: roleRoute } },
    mailbox: { enabled, roles: { prices: {} }, systemSenders: ['agent-org'], mirror: false },
  }, chats: { [CHAT]: { isolateTopics: true, topics: { '142': 'Prices', '2995': 'Admin' } } } };
  const intentLock = createAsyncLock();
  const calls = []; const reactions = []; const replies = [];
  const entry = { backend: 'cli', inFlight: false, closed: false, probeBusyState: async () => ({ busy: entry.inFlight, backgroundShell: false }) };
  let finish;
  const f = { config, db, calls, reactions, replies, entry, sessionKey, intentLock };
  const pm = { has: () => true, get: () => entry, drainQueue() {}, interrupt: async () => {
    f.interruptedRequest = calls.at(-1);
    f.finish({ error: null, metrics: { resultSubtype: 'interrupted' } });
  } };
  f.finish = (result) => { entry.inFlight = false; finish?.(result); };
  const externalRuntime = runtime.createExternalJobRuntime({
    config, pm, intentLock, getSessionKey, resolveBackend: () => 'cli',
    isPaused: (key) => f.jobs.isPaused(key), isShuttingDown: () => false, needsAuth: () => false,
    awaitSessionRecovery: async () => {}, getOrSpawnForChat: async () => entry,
    sendToProcess: async (key, prompt, options, hooks) => {
      entry.inFlight = true;
      calls.push(options.origin.requestId);
      options.onTurnId(`turn-${calls.length}`);
      hooks.onDispatched();
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  const resolveTarget = runtime.createExternalJobTargetResolver({ config, getSessionKey });
  f.jobs = createExternalJobService({ config, db, botName: 'test', resolveTarget,
    dispatch: createExternalJobDispatch({ runtime: externalRuntime, dispatchExternalEvent: (target, run) => run(), getMailbox: () => f.mailbox }),
    checkInactive: externalRuntime.checkInactive, deliverPart: async () => ({ messageId: 1 }),
  });
  f.mailbox = createMailboxService({ config, db, botName: 'test', jobs: f.jobs, resolveTarget });
  const deps = vm.runInNewContext(wiring, { ...runtime, createHandleAbort: (options) => options,
    config, getSessionKey, intentLock, pm, bot: {}, BOT_NAME: 'test', console: { error() {} },
    externalJobService: f.jobs, mailboxService: f.mailbox, questionHandlers: null, isAbortRequest,
    tg: async (bot, method, params) => { reactions.push({ method, params }); },
    logEvent() {}, markSessionAborted() {}, clearAutosteeredReactions: async () => {},
  });
  deps.dualProbeDelayMs = 0;
  f.deps = deps;
  f.abort = (text = 'стоп', thread = general ? null : '142') => createHandleAbort(deps)(
    { from: { id: 7 }, message_id: 100, ...(thread == null ? {} : { message_thread_id: thread }) }, CHAT, config.chats[CHAT], text);
  f.command = (cleanText) => runtime.createAutomationCommandHandler({ config, getSessionKey, intentLock,
    getService: () => f.jobs, reply: async (msg, chatId, text) => replies.push(text),
  })({ msg: { from: { id: 7 }, ...(general ? {} : { message_thread_id: '142' }) }, chatId: CHAT, cleanText });
  f.submit = (key) => f.mailbox.submit({ sender: 'agent-org', to: 'prices', body: `Task ${key}`, key });
  f.job = (receipt) => f.jobs.get({ routeId: 'prices', requestId: `mailbox:${receipt.id}` }).job;
  t.after(async () => { f.finish({ aborted: true }); f.jobs.stop(); f.mailbox.stop(); await settle(); cleanupDb(dbPath, db); });
  return f;
}

test('«стоп» in a role topic paused agent-org deliveries for 3 days', async (t) => {
  const f = fixture(t);
  const first = f.submit('first'); const next = f.submit('next');
  f.jobs.start(); await settle();
  assert.equal(f.job(first).state, 'running');
  await f.abort(); await settle();
  assert.equal(f.jobs.status('prices').paused, false, 'a turn interruption must not pause future deliveries');
  assert.equal(f.db.raw.prepare('SELECT count(*) n FROM external_job_controls WHERE paused=1').get().n, 0);
  assert.equal(f.job(first).state, 'interrupted');
  assert.equal(f.job(next).state, 'running', 'the scheduler advances without resume or another tick');
  assert.deepEqual(f.calls, [`mailbox:${first.id}`, `mailbox:${next.id}`], 'the interrupted job is never retried');
  assert.equal(f.reactions.at(-1).params.reaction[0].emoji, '👍');
  await f.command('/automation status');
  assert.match(f.replies.at(-1), /Automation: enabled\. Pending jobs: 0\. Running jobs: 1\./);
});

test('infra-admin operator stop still durably pauses its destination', async (t) => {
  const f = fixture(t);
  await f.abort('/stop', '2995');
  assert.equal(f.jobs.status('infra').paused, true);
  assert.equal(f.jobs.status('prices').paused, false);
});

test('role aliases and General use interrupt-only stop; disabled mailbox retains pause-on-stop', async (t) => {
  for (const general of [false, true]) {
    const f = fixture(t, { general });
    await f.abort('/stop');
    assert.equal(f.jobs.status('alias').paused, false);
    assert.deepEqual(f.reactions, [], 'an idle stop stays silent');
    await f.command('/automation pause');
    await f.abort();
    assert.equal(f.jobs.status('prices').paused, true, 'stop never clears an explicit pause');
    assert.equal(f.jobs.status('alias').paused, true);
    await f.command('/automation status');
    assert.match(f.replies.at(-1), /Automation: paused/);
    await f.command('/automation resume');
    assert.equal(f.jobs.status('prices').paused, false);
  }
  const f = fixture(t, { enabled: false });
  await f.abort();
  assert.equal(f.jobs.status('prices').paused, true);
});

test('a turn ending during stop probes cannot admit the next job until stop finishes', async (t) => {
  const f = fixture(t);
  const first = f.submit('first'); const next = f.submit('next');
  f.jobs.start(); await settle();
  let probes = 0;
  f.entry.probeBusyState = async () => {
    if (++probes === 1) { f.finish({ text: '' }); await settle(); }
    return { busy: false, backgroundShell: false };
  };
  await f.abort(); await settle();
  assert.equal(f.interruptedRequest, `mailbox:${first.id}`, 'stop must not hit the newly queued turn');
  assert.equal(f.job(next).state, 'running');
});

test('uncertain inactivity holds the next job without setting an automation pause', async (t) => {
  const f = fixture(t);
  const first = f.submit('first'); const next = f.submit('next');
  f.jobs.start(); await settle();
  f.entry.probeBusyState = async () => ({});
  await f.abort(); await settle();
  assert.equal(f.job(first).state, 'interrupted');
  assert.equal(f.job(first).inactive, false);
  assert.equal(f.job(next).state, 'queued');
  assert.equal(f.jobs.status('prices').paused, false);
});

test('a failed stop cleanup releases mailbox admission', async (t) => {
  const f = fixture(t);
  f.deps.retireQuestionSession = async () => { throw new Error('cleanup unavailable'); };
  await assert.rejects(f.abort(), /cleanup unavailable/);
  const release = await f.intentLock.acquire(f.sessionKey);
  release();
  assert.equal(f.jobs.status('prices').paused, false);
});

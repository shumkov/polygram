'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const { createExternalJobService } = require('../lib/external-jobs/service');
const input = (requestId = 'one') => ({ routeId: 'review', requestId, task: 'Summarize this document.', payload: { title: 'Example' } });
function fixture(t, overrides = {}) {
  const raw = new Database(':memory:'); raw.exec(fs.readFileSync(require.resolve('../lib/external-jobs/schema.sql'), 'utf8'));
  const calls = []; const sends = []; let now = 1000;
  const config = { bot: { externalJobs: { enabled: true, routes: { review: { chatId: '-1001', threadId: '2' } } } } };
  const options = { config, db: { raw }, botName: 'test', now: () => now,
    resolveTarget: (route) => ({ ...route, sessionKey: `${route.chatId}:${route.threadId}` }),
    dispatch: async (job, hooks) => { calls.push(job); hooks.onTurnId('turn-one'); return { outcome: 'succeeded', text: 'Done.', inactive: true }; },
    checkInactive: async () => false, prepareReport: (text) => [text],
    deliverPart: async (job, part) => { sends.push(part); return { messageId: sends.length }; }, ...overrides };
  const service = createExternalJobService(options);
  t.after(() => { service.stop(); raw.close(); });
  return { service, calls, sends, config, raw, options, advance: () => { now += 61000; } };
}
test('disabled feature does not touch schema or require runtime adapters', async () => {
  const service = createExternalJobService({ config: {}, botName: 'test' });
  assert.equal(service.info().enabled, false); service.start(); await service.tick(); service.stop();
  assert.throws(() => service.submit(input()), /disabled/i);
});
test('acknowledgement is durable before execution; reporting records independent receipt', async (t) => {
  const f = fixture(t); const accepted = f.service.submit(input());
  assert.equal(accepted.job.state, 'queued'); assert.equal(f.calls.length, 0);
  f.service.start(); await f.service.tick();
  const job = f.service.get(input()).job;
  assert.equal(job.state, 'succeeded'); assert.equal(job.reportState, 'delivered');
  assert.equal(job.turnId, 'turn-one'); assert.equal(job.inactive, true); assert.equal(f.calls.length, 1);
  assert.equal(f.service.submit(input()).duplicate, true);
});
test('uncertain dispatch never replays, blocks the session until positive inactivity', async (t) => {
  let inactive = false; let calls = 0;
  const f = fixture(t, { dispatch: async () => { calls++; throw new Error('Lost dispatch response'); }, checkInactive: async () => inactive });
  f.service.submit(input()); f.service.submit(input('two')); f.service.start(); await f.service.tick(); await f.service.tick();
  assert.equal(calls, 1); assert.equal(f.service.get(input()).job.state, 'unknown');
  inactive = true; await f.service.tick(); assert.equal(calls, 2);
  assert.equal(f.service.get(input()).job.state, 'unknown');
});
test('only provably unsent report parts retry without regenerating the agent turn', async (t) => {
  let attempts = 0;
  const f = fixture(t, { prepareReport: () => ['first', 'second'], deliverPart: async (job, part) => {
    attempts++; if (part.index === 1 && attempts === 2) throw Object.assign(new Error('Not sent'), { definitelyNotSent: true });
    return { messageId: attempts };
  } });
  f.service.submit(input()); f.service.start(); await f.service.tick();
  assert.equal(f.service.get(input()).job.state, 'succeeded'); assert.equal(f.service.get(input()).job.reportState, 'pending');
  f.advance(); await f.service.tick(); assert.equal(attempts, 3); assert.equal(f.calls.length, 1);
  assert.equal(f.service.get(input()).job.reportState, 'delivered');
});
test('lost send receipt and Channels acknowledgement remain unknown, without resend', async (t) => {
  let sends = 0;
  const f = fixture(t, { deliverPart: async () => { sends++; throw new Error('Lost send receipt'); } });
  f.service.submit(input()); f.service.start(); await f.service.tick(); f.advance(); await f.service.tick();
  assert.equal(sends, 1); assert.equal(f.service.get(input()).job.reportState, 'unknown');
  const g = fixture(t, { dispatch: async () => ({ outcome: 'succeeded', channelsAcknowledged: true, inactive: true }) });
  g.service.submit(input()); g.service.start(); await g.service.tick();
  assert.equal(g.service.get(input()).job.reportState, 'unknown'); assert.equal(g.sends.length, 0);
});
test('retargeted routes hold queued work and duplicates retain the original destination', async (t) => {
  const f = fixture(t); f.service.submit(input()); f.config.bot.externalJobs.routes.review.chatId = '-1002';
  f.service.start(); await f.service.tick(); assert.equal(f.calls.length, 0);
  assert.match(f.service.get(input()).job.error, /route/i);
  assert.equal(f.service.submit(input()).duplicate, true);
});
test('busy deferral stays queued while persistent session pause stops aliases', async (t) => {
  const f = fixture(t, { dispatch: async () => ({ deferred: true, reason: 'busy' }) });
  f.service.submit(input()); f.service.start(); await f.service.tick();
  assert.equal(f.service.get(input()).job.state, 'queued');
  f.service.pauseSession('-1001:2', true);
  assert.equal(f.service.status('review').paused, true);
  assert.equal(f.service.get(input()).job.paused, true);
});
test('report preparation failure preserves the known execution outcome', async (t) => {
  const f = fixture(t, { prepareReport: () => { throw new Error('Cannot render report'); } });
  f.service.submit(input()); f.service.start(); await f.service.tick();
  const job = f.service.get(input()).job;
  assert.equal(job.state, 'succeeded'); assert.equal(job.reportState, 'unknown');
  assert.equal(job.inactive, true); assert.equal(f.calls.length, 1);
});
test('deferred result cannot replay work after its turn identity was observed', async (t) => {
  const f = fixture(t, { dispatch: async (job, hooks) => { hooks.onTurnId('turn-one'); return { deferred: true }; } });
  f.service.submit(input()); f.service.start(); await f.service.tick();
  assert.equal(f.service.get(input()).job.state, 'unknown');
});
test('a second route to the same effective session shares persistent pause', async (t) => {
  const f = fixture(t);
  f.config.bot.externalJobs.routes.alias = { chatId: '-1001', threadId: '2' };
  f.service.pauseSession('-1001:2', true);
  f.service.submit({ ...input(), routeId: 'alias' }); f.service.start(); await f.service.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.service.status('alias').paused, true);
  f.service.pauseSession('-1001:2', false); await f.service.tick(); assert.equal(f.calls.length, 1);
});
test('pending report retries respect pause and frozen route without dispatching again', async (t) => {
  let attempts = 0;
  const f = fixture(t, { deliverPart: async () => {
    attempts++; if (attempts === 1) throw Object.assign(new Error('Not sent'), { definitelyNotSent: true });
    return { messageId: 22 };
  } });
  f.service.submit(input()); f.service.start(); await f.service.tick(); f.advance();
  f.service.pauseSession('-1001:2', true); await f.service.tick();
  assert.equal(attempts, 1); assert.equal(f.service.isPaused('-1001:2'), true);
  f.config.bot.externalJobs.routes.review.chatId = '-1002';
  f.service.pauseSession('-1001:2', false); await f.service.tick(); assert.equal(attempts, 1);
  assert.match(f.service.get(input()).job.error, /route/i);
  f.config.bot.externalJobs.routes.review.chatId = '-1001'; await f.service.tick();
  assert.equal(attempts, 2); assert.equal(f.calls.length, 1);
});

test('failed pause persistence holds automatic admission until a successful human resume', async (t) => {
  const f = fixture(t);
  f.service.submit(input());
  f.raw.exec("CREATE TRIGGER reject_pause BEFORE INSERT ON external_job_controls BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.throws(() => f.service.pauseSession('-1001:2', true), /disk full/);
  assert.equal(f.service.isPaused('-1001:2'), true);
  assert.equal(f.service.status('review').paused, true);
  assert.equal(f.service.get(input()).job.paused, true);
  f.service.start(); await f.service.tick();
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.service.pauseSession('-1001:2', false), /disk full/);
  await f.service.tick(); assert.equal(f.calls.length, 0);
  f.raw.exec('DROP TRIGGER reject_pause');
  f.service.pauseSession('-1001:2', false);
  await f.service.tick(); assert.equal(f.calls.length, 1);
});

test('failed pause persistence also holds pending report retries', async (t) => {
  let sends = 0;
  const f = fixture(t, { deliverPart: async () => { sends++; throw Object.assign(new Error('unavailable'), { definitelyNotSent: true }); } });
  f.service.submit(input()); f.service.start(); await f.service.tick();
  f.raw.exec("CREATE TRIGGER reject_pause BEFORE INSERT ON external_job_controls BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.throws(() => f.service.pauseSession('-1001:2', true), /disk full/);
  f.advance(); await f.service.tick();
  assert.equal(sends, 1);
});

test('disk reopen preserves human pause and retries only the unsent report part', async (t) => {
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-pause-reopen-'));
  const dbPath = path.join(dir, 'jobs.db');
  let raw; let service; let turns = 0; let now = 1000;
  const sent = [];
  const config = { bot: { externalJobs: { enabled: true, routes: { review: { chatId: '-1001', threadId: '2' } } } } };
  function open(failSecond) {
    raw = new Database(dbPath);
    raw.exec(fs.readFileSync(require.resolve('../lib/external-jobs/schema.sql'), 'utf8'));
    service = createExternalJobService({ config, db: { raw }, botName: 'test', now: () => now,
      resolveTarget: (route) => ({ ...route, sessionKey: '-1001:2' }),
      dispatch: async () => { turns++; return { outcome: 'succeeded', text: 'Report', inactive: true }; },
      checkInactive: async () => false, prepareReport: () => ['first', 'second'],
      deliverPart: async (job, part) => {
        if (failSecond && part.index === 1) throw Object.assign(new Error('unsent'), { definitelyNotSent: true });
        sent.push(part.index); return { messageId: sent.length };
      },
    });
  }
  t.after(() => { service?.stop(); if (raw?.open) raw.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  open(true);
  service.submit(input()); service.start(); await service.tick();
  assert.equal(service.get(input()).job.reportState, 'pending');
  service.pauseSession('-1001:2', true);
  service.stop(); raw.close();
  now += 61000;
  open(false); service.start(); await service.tick();
  assert.equal(service.status('review').paused, true);
  assert.deepEqual(sent, [0]);
  service.pauseSession('-1001:2', false); await service.tick();
  assert.equal(service.get(input()).job.reportState, 'delivered');
  assert.deepEqual(sent, [0, 1], 'persisted first receipt prevents a duplicate part');
  assert.equal(turns, 1, 'report recovery does not repeat diagnosis');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const { createExternalJobService } = require('../lib/external-jobs/service');

const routes = {
  a: { chatId: '-1001', threadId: '11' },
  b: { chatId: '-1001', threadId: '12' },
  c: { chatId: '-1001', threadId: '13' },
};
const sessionOf = (routeId) => `${routes[routeId].chatId}:${routes[routeId].threadId}`;
const job = (routeId, requestId = routeId) => ({ routeId, requestId, task: 'Do the work.', payload: { n: 1 } });
const turns = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };

// A dispatch whose turns stay open until the test releases them, so a test
// can observe what the service does while a turn is still in flight.
function heldTurns() {
  const open = new Map();
  let all = false;
  const done = { outcome: 'succeeded', text: 'Done.', inactive: true };
  return {
    calls: [],
    dispatch(job) {
      this.calls.push(job.requestId);
      if (all) return Promise.resolve(done);
      return new Promise((resolve) => open.set(job.requestId, resolve));
    },
    release(requestId, result = done) { const resolve = open.get(requestId); open.delete(requestId); resolve?.(result); },
    releaseAll() { all = true; for (const id of [...open.keys()]) this.release(id); },
    isOpen: (requestId) => open.has(requestId),
  };
}

function fixture(t, overrides = {}, settings = {}) {
  const raw = new Database(':memory:'); raw.exec(fs.readFileSync(require.resolve('../lib/external-jobs/schema.sql'), 'utf8'));
  const sends = [];
  const config = { bot: { externalJobs: { enabled: true, routes: structuredClone(routes), ...settings } } };
  t.after(() => raw.close());
  const service = createExternalJobService({ config, db: { raw }, botName: 'test', now: () => 1000,
    resolveTarget: (route) => ({ ...route, sessionKey: `${route.chatId}:${route.threadId}` }),
    checkInactive: async () => false, prepareReport: (text) => [text],
    deliverPart: async (j, part) => { sends.push(j.requestId); return { messageId: sends.length }; },
    logger: { error() {} }, ...overrides });
  t.after(() => service.stop());
  const state = (requestId, routeId = requestId) => service.get({ routeId, requestId }).job;
  return { service, raw, sends, config, state };
}

test('a long turn in one role does not hold back another role', async (t) => {
  const held = heldTurns();
  const f = fixture(t, { dispatch: (j) => held.dispatch(j) });
  f.service.submit(job('a')); f.service.submit(job('b'));
  f.service.start();
  const ticking = f.service.tick();
  try {
    await turns();
    assert.deepEqual([...held.calls].sort(), ['a', 'b'], 'both sessions must have a turn in flight at once');
    held.release('b');
    await turns();
    assert.equal(f.state('b').state, 'succeeded', 'the short turn settles while the long one is still running');
    assert.equal(f.state('b').reportState, 'delivered');
    assert.equal(f.state('a').state, 'running');
  } finally { held.releaseAll(); }
  await ticking;
  assert.equal(f.state('a').state, 'succeeded');
  assert.equal(f.state('a').reportState, 'delivered', 'tick resolves only after every claimed job is settled and reported');
});

test('a job submitted while another role works starts without waiting for that turn', async (t) => {
  const held = heldTurns();
  const f = fixture(t, { dispatch: (j) => held.dispatch(j) });
  f.service.submit(job('a')); f.service.start();
  const ticking = f.service.tick();
  try {
    await turns();
    f.service.submit(job('b'));
    await turns();
    assert.ok(held.calls.includes('b'), 'a submit during a running turn must schedule its own dispatch');
  } finally { held.releaseAll(); }
  await ticking; await f.service.tick();
  assert.equal(f.state('b').state, 'succeeded');
});

test('a busy role neither starves the others nor makes the scheduler spin', async (t) => {
  const held = heldTurns(); let busyAttempts = 0;
  const f = fixture(t, { dispatch: (j) => {
    if (j.routeId === 'a') { busyAttempts++; return Promise.resolve({ deferred: true, reason: 'Session is busy' }); }
    return held.dispatch(j);
  } });
  f.service.submit(job('a')); f.service.submit(job('b')); f.service.start();
  const ticking = f.service.tick();
  try {
    await turns();
    f.service.submit(job('c'));
    await turns();
    assert.ok(held.calls.includes('c'), 'a third role starts while the second is still working and the first is busy');
  } finally { held.releaseAll(); }
  await ticking; await f.service.tick(); await turns();
  assert.equal(f.state('b').state, 'succeeded'); assert.equal(f.state('c').state, 'succeeded');
  assert.equal(f.state('a').state, 'queued', 'a busy target keeps its job queued');
  const settled = busyAttempts;
  await turns(50);
  assert.equal(busyAttempts, settled, 'a deferral alone never triggers another pass');
});

test('claimed, unsettled dispatches are capped by maxConcurrent', async (t) => {
  const held = heldTurns();
  const f = fixture(t, { dispatch: (j) => held.dispatch(j) }, { maxConcurrent: 2 });
  for (const id of ['a', 'b', 'c']) f.service.submit(job(id));
  f.service.start();
  const ticking = f.service.tick();
  try {
    await turns();
    assert.deepEqual(held.calls, ['a', 'b'], 'the third session waits for a free slot');
    held.release('a');
    await turns();
    assert.deepEqual(held.calls, ['a', 'b', 'c'], 'a terminal finish frees its slot and schedules the waiting job');
  } finally { held.releaseAll(); }
  await ticking; await f.service.tick();
  for (const id of ['a', 'b', 'c']) assert.equal(f.state(id).state, 'succeeded');
});

test('the default cap allows four concurrent sessions', async (t) => {
  const held = heldTurns();
  const config = structuredClone(routes);
  for (const n of [14, 15]) config[`r${n}`] = { chatId: '-1001', threadId: String(n) };
  const f = fixture(t, { dispatch: (j) => held.dispatch(j) });
  Object.assign(f.config.bot.externalJobs.routes, config);
  for (const id of ['a', 'b', 'c', 'r14', 'r15']) f.service.submit(job(id));
  f.service.start();
  const ticking = f.service.tick();
  try { await turns(); assert.equal(held.calls.length, 4); }
  finally { held.releaseAll(); }
  await ticking; await f.service.tick();
  assert.equal(f.state('r15').state, 'succeeded');
});

test('a schedule request that arrives during a pass runs one more pass', async (t) => {
  let openGate; let probes = 0;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const dispatched = [];
  const f = fixture(t, {
    dispatch: async (j) => { dispatched.push(j.requestId); return { outcome: 'succeeded', text: 'Done.', inactive: true }; },
    // The first probe sees the earlier turn still busy; the session goes
    // idle while that probe is running.
    checkInactive: async () => { probes++; if (probes === 1) { await gate; return false; } return true; },
  });
  f.service.submit(job('b', 'b0')); f.service.submit(job('b', 'b1'));
  f.raw.prepare("UPDATE external_jobs SET state='unknown' WHERE request_id='b0'").run();
  f.service.start();
  const ticking = f.service.tick();
  await turns();
  assert.equal(probes, 1, 'the pass is waiting in its inactivity probe');
  // A resume is a schedule request that is not a submit.
  f.service.pauseSession(sessionOf('c'), false);
  openGate();
  await ticking;
  assert.deepEqual(dispatched, ['b1'], 'the extra pass re-probes and admits the blocked job');
  assert.equal(f.state('b1', 'b').state, 'succeeded');
});

test('the inactivity probe skips a job whose turn this process is driving', async (t) => {
  const held = heldTurns(); const probed = [];
  const f = fixture(t, { dispatch: (j) => held.dispatch(j), checkInactive: async (j) => { probed.push(j.requestId); return false; } });
  f.service.submit(job('a')); f.service.start();
  const ticking = f.service.tick();
  let probedWhileRunning;
  try {
    await turns();
    assert.ok(held.isOpen('a'));
    f.service.submit(job('b'));
    await turns();
    assert.ok(held.calls.includes('b'), 'a second pass ran while the first turn was in flight');
    probedWhileRunning = [...probed];
  } finally { held.releaseAll(); }
  await ticking;
  assert.deepEqual(probedWhileRunning.filter((id) => id === 'a'), [], 'an in-flight job is never probed by a concurrent pass');
});

test('an invalid concurrency cap fails loudly instead of silently stopping automation', (t) => {
  for (const maxConcurrent of [0, -1, 1.5, '4']) {
    assert.throws(() => fixture(t, { dispatch: async () => ({}) }, { maxConcurrent }), /maxConcurrent/);
  }
  const off = createExternalJobService({ config: { bot: { externalJobs: { enabled: false, maxConcurrent: 0 } } }, botName: 'test' });
  assert.equal(off.info().enabled, false, 'a disabled feature does not validate its tuning');
});

test('a session runs its next job only after the previous job has settled and its report is delivered', async (t) => {
  const held = heldTurns(); const events = [];
  let releaseReport;
  const reportGate = new Promise((resolve) => { releaseReport = resolve; });
  const f = fixture(t, {
    dispatch: (j) => { events.push(`dispatch:${j.requestId}`); return held.dispatch(j); },
    deliverPart: async (j) => {
      if (j.requestId === 'a1') { events.push('report:a1:start'); await reportGate; events.push('report:a1:end'); }
      return { messageId: events.length };
    },
  });
  f.service.submit(job('a', 'a1')); f.service.submit(job('a', 'a2'));
  f.service.start();
  const ticking = f.service.tick();
  try {
    await turns();
    assert.deepEqual(held.calls, ['a1']);
    f.service.submit(job('b'));
    await turns();
    assert.equal(f.state('a2', 'a').error, null, 'a pass skips a busy session instead of marking its next job blocked');
    held.release('a1');
    await turns();
    assert.ok(events.includes('report:a1:start'), 'the first job is delivering its report');
    f.service.submit(job('c'));
    await turns();
    assert.ok(!held.calls.includes('a2'), 'the next job must not overlap the previous report');
    releaseReport();
    await turns();
    assert.ok(held.calls.includes('a2'));
    assert.ok(events.indexOf('report:a1:end') < events.indexOf('dispatch:a2'), events.join(', '));
  } finally { releaseReport(); held.releaseAll(); }
  await ticking; await f.service.tick();
  assert.equal(f.state('a2', 'a').state, 'succeeded');
});

test('a failed settle is logged with its ids and still frees its slot for the next job', async (t) => {
  const errors = []; const dispatched = [];
  const f = fixture(t, {
    dispatch: async (j) => { dispatched.push(j.requestId); return { outcome: 'succeeded', text: 'Done.', inactive: true }; },
    logger: { error: (line) => errors.push(line) },
  }, { maxConcurrent: 1 });
  f.raw.exec("CREATE TRIGGER refuse_finish BEFORE UPDATE OF state ON external_jobs WHEN NEW.state='succeeded' AND OLD.request_id='a' BEGIN SELECT RAISE(ABORT, 'disk full at /private/path'); END");
  f.service.submit(job('a')); f.service.submit(job('b'));
  f.service.start();
  await turns(30);
  const failed = f.raw.prepare("SELECT id FROM external_jobs WHERE request_id='a'").get().id;
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`job ${failed} \\(a\\).*SQLITE_CONSTRAINT`));
  assert.doesNotMatch(errors[0], /disk full|private/, 'external-jobs logs codes, never message text');
  assert.ok(dispatched.includes('b'), 'the failed continuation released its slot and scheduled the next pass');
});

test('spin guard: a deferral never schedules another pass by itself', async (t) => {
  let attempts = 0;
  const f = fixture(t, { dispatch: async () => {
    attempts++;
    // A spinning scheduler would retry forever; a terminal result after a
    // bounded number of attempts ends the loop so this test fails fast
    // instead of hanging the suite.
    if (attempts > 25) return { outcome: 'failed', inactive: true };
    return { deferred: true, reason: 'Session is busy' };
  } });
  f.service.submit(job('a'));
  f.service.start();
  await f.service.tick(); await turns(50);
  assert.ok(attempts <= 2, `deferred dispatch must wait for a real wake-up; saw ${attempts} attempts`);
  assert.equal(f.state('a').state, 'queued');
});

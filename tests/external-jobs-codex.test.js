'use strict';
// Codex sessions take external jobs (mailbox deliveries) exactly as Claude CLI
// sessions do: only when idle, through the ordinary Codex queue, with the
// turn's ledger attempt settled as soon as the turn resolves, and with an
// inactivity proof that survives a /stop, which kills the Codex process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAsyncLock } = require('@shumkov/orchestra');
const { getSessionKey } = require('../lib/session-key');
const { createExternalJobRuntime, createExternalJobTargetResolver, JOB_BACKENDS } = require('../lib/external-jobs/runtime');

const route = { chatId: '-1001', threadId: '5' };
const target = { ...route, sessionKey: '-1001:5' };
const job = { id: 'job-codex', routeId: 'session:-1001:5', requestId: 'mailbox:m_0123456789abcdef', task: 'Inter-session message.', payload: { message: { body: 'hi' } }, target };
const codexResult = (overrides = {}) => ({
  runtime: 'codex', backend: 'codex', text: 'Answered', error: null, metrics: { resultSubtype: 'success' },
  generationId: 'gen-1', attemptId: 'attempt-1', providerSessionId: 'thread-1', providerTurnId: 'turn-1', ...overrides,
});
function codexEntry(overrides = {}) {
  return { runtime: 'codex', backend: 'codex', state: 'Idle', inFlight: false, closed: false, hasPendingDeliveryWork: () => false, ...overrides };
}
function fixture(overrides = {}) {
  const calls = [];
  const events = [];
  const entry = codexEntry();
  const config = { bot: { externalJobs: { enabled: true, routes: {} } }, chats: { '-1001': { isolateTopics: true, topics: { 5: { name: 'Orchestra', pm: 'codex' } } } } };
  const deps = {
    config, pm: { get: () => entry, getModelSettingsStatus: async () => ({ outcome: 'not-loaded' }) },
    intentLock: createAsyncLock(), getSessionKey,
    resolveBackend: () => 'codex', isPaused: () => false, isShuttingDown: () => false,
    needsAuth: () => false, checkAuth: () => ({ state: 'ok' }), awaitSessionRecovery: async () => {},
    getOrSpawnForChat: async () => entry,
    sendToProcess: async (...args) => { calls.push(args); events.push('send'); args[3].onDispatched(); return codexResult(); },
    settleResult: async (...args) => { events.push(['settle', ...args]); },
    logger: { warn() {}, error() {} },
    ...overrides,
  };
  const runtime = createExternalJobRuntime(deps);
  return { runtime, deps, entry, calls, events };
}

test('Codex and the Claude CLI are the external-job backends; SDK is not', () => {
  assert.deepEqual([...JOB_BACKENDS], ['cli', 'codex']);
  const config = { chats: { '-1001': { isolateTopics: true, topics: { 5: {} } } } };
  const resolve = (backend) => createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: () => backend })(route);
  assert.deepEqual(resolve('codex'), target, 'a Codex session is a valid job destination');
  assert.throws(() => resolve('sdk'), /Claude CLI or Codex/);
});

test('an idle Codex session takes one job turn with no Telegram source, and the attempt is settled before anything else', async () => {
  const f = fixture();
  const sent = [];
  const result = await f.runtime.dispatch(job, { onSend: () => sent.push(f.calls.length) });
  assert.deepEqual(sent, [0], 'the grant activates right before the send, never after');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][2].sourceMsgId, null, 'a job turn never invents a Telegram sender');
  assert.equal(f.calls[0][3].expectedProcess, f.entry, 'the send is bound to the generation admission proved idle');
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.text, 'Answered');
  assert.equal(result.inactive, true);
  assert.equal(result.channelsAcknowledged, false);
  assert.deepEqual(f.events[1], ['settle', target.sessionKey, codexResult(), 'delivered'],
    'an unsettled attempt would make the next retirement of this generation wait and quarantine the lease');
});

test('a Codex session that owns or may start a turn defers the job with nothing sent', async () => {
  const busy = [
    { inFlight: true }, { state: 'StartingTurn' }, { state: 'Active' }, { state: 'Settling' },
    { state: 'BackgroundWorking' }, { state: 'BackgroundSettling' }, { state: 'Quiescing' }, { state: 'Stopped' },
    { hasPendingDeliveryWork: () => true }, { hasPendingDeliveryWork: undefined },
  ];
  for (const overrides of busy) {
    const entry = codexEntry(overrides);
    const f = fixture({ pm: { get: () => entry, getModelSettingsStatus: async () => ({ outcome: 'loaded' }) }, getOrSpawnForChat: async () => entry });
    const result = await f.runtime.dispatch(job);
    assert.equal(result.deferred, true, JSON.stringify(overrides));
    assert.equal(f.calls.length, 0, JSON.stringify(overrides));
  }
});

test('the Claude login gate is asked about the job\'s own backend, so an expired Claude login does not hold Codex mail', async () => {
  const asked = [];
  const needsAuth = (backend) => { asked.push(backend); return backend === 'cli'; };
  const f = fixture({ needsAuth, checkAuth: () => ({ state: 'expired' }) });
  assert.equal((await f.runtime.dispatch(job)).outcome, 'succeeded');
  assert.deepEqual(asked, ['codex']);
  const cli = { backend: 'cli', inFlight: false, probeBusyState: async () => ({ busy: false }) };
  const g = fixture({ needsAuth, checkAuth: () => ({ state: 'expired' }), resolveBackend: () => 'cli', pm: { get: () => cli }, getOrSpawnForChat: async () => cli });
  assert.equal((await g.runtime.dispatch(job)).deferred, true, 'a CLI job still waits for a valid login');
});

test('with no Codex process the job spawns one, proves it idle and sends; a spawn that fails defers', async () => {
  let current;
  const spawned = codexEntry();
  const f = fixture({ pm: { get: () => current, getModelSettingsStatus: async () => ({ outcome: 'not-loaded' }) }, getOrSpawnForChat: async () => { current = spawned; return spawned; } });
  assert.equal((await f.runtime.dispatch(job)).outcome, 'succeeded');
  assert.equal(f.calls[0][3].expectedProcess, spawned);
  const lease = Object.assign(new Error('Native Codex generation is already active'), { code: 'CODEX_DAEMON_GENERATION_BUSY' });
  const g = fixture({ pm: { get: () => undefined, getModelSettingsStatus: async () => ({ outcome: 'daemon-busy' }) }, getOrSpawnForChat: async () => { throw lease; } });
  const deferred = await g.runtime.dispatch(job);
  assert.equal(deferred.deferred, true, 'another session holding the daemon\'s Codex lease delays the job, never fails it');
  assert.equal(g.calls.length, 0);
});

test('Codex turn endings map to the job outcomes; only resolved turns are settled, and settlement never changes the outcome', async () => {
  const interruptedBeforeSend = Object.assign(new Error('Codex turn start was interrupted before dispatch'), { code: 'INTERRUPTED' });
  const lost = Object.assign(new Error('Codex RPC outcome unknown'), { code: 'CODEX_RPC_OUTCOME_UNKNOWN' });
  const cases = [
    [codexResult({ error: 'interrupted', metrics: { resultSubtype: 'interrupted' } }), 'interrupted', 'failed'],
    [interruptedBeforeSend, 'interrupted', null],
    [codexResult({ error: 'failed', metrics: { resultSubtype: 'failed' } }), 'failed', 'failed'],
    [lost, 'unknown', null],
  ];
  for (const [ending, outcome, disposition] of cases) {
    const f = fixture({
      sendToProcess: async (...args) => { args[3].onDispatched(); if (ending instanceof Error) throw ending; return ending; },
    });
    const result = await f.runtime.dispatch(job);
    assert.equal(result.outcome, outcome, ending.message || ending.error);
    const settled = f.events.filter((event) => Array.isArray(event));
    assert.deepEqual(settled.map((event) => event[3]), disposition ? [disposition] : [], ending.message || ending.error);
  }
  const failing = fixture({ settleResult: async () => { throw Object.assign(new Error('ledger write failed'), { code: 'CODEX_DURABILITY_FAILED' }); } });
  const result = await failing.runtime.dispatch(job);
  assert.equal(result.outcome, 'succeeded', 'the turn\'s result is already known; a ledger fault must not hide it');
  assert.equal(result.text, 'Answered');
});

test('a Claude CLI turn is never passed to Codex settlement, and an INTERRUPTED rejection there stays unknown', async () => {
  const cli = { backend: 'cli', inFlight: false, probeBusyState: async () => ({ busy: false }) };
  const f = fixture({ resolveBackend: () => 'cli', pm: { get: () => cli }, getOrSpawnForChat: async () => cli,
    sendToProcess: async (...args) => { args[3].onDispatched(); return { text: 'Completed' }; } });
  assert.equal((await f.runtime.dispatch(job)).outcome, 'succeeded');
  assert.equal(f.events.filter((event) => Array.isArray(event)).length, 0);
  const g = fixture({ resolveBackend: () => 'cli', pm: { get: () => cli }, getOrSpawnForChat: async () => cli,
    sendToProcess: async (...args) => { args[3].onDispatched(); throw Object.assign(new Error('x'), { code: 'INTERRUPTED' }); } });
  assert.equal((await g.runtime.dispatch(job)).outcome, 'unknown');
});

test('inactivity: a live idle Codex process proves it, and after a stop killed the process the no-process status proves it without a spawn', async () => {
  assert.equal(await fixture().runtime.checkInactive(job), true);
  assert.equal(await fixture({ pm: { get: () => codexEntry({ state: 'Active' }), getModelSettingsStatus: async () => ({ outcome: 'not-loaded' }) } }).runtime.checkInactive(job), false);
  for (const [outcome, expected] of [['not-loaded', true], ['daemon-busy', true], ['unavailable', false], ['loaded', false]]) {
    const f = fixture({ pm: { get: () => undefined, getModelSettingsStatus: async () => ({ outcome, reason: 'containment' }) } });
    assert.equal(await f.runtime.checkInactive(job), expected, outcome);
    assert.equal(await f.runtime.checkInactive(job), expected, `${outcome} again`);
  }
  const closed = fixture({ pm: { get: () => codexEntry({ closed: true, state: 'Closed' }), getModelSettingsStatus: async () => ({ outcome: 'not-loaded' }) } });
  assert.equal(await closed.runtime.checkInactive(job), true, 'a closed process is no process');
  const noStatus = fixture({ pm: { get: () => undefined } });
  assert.equal(await noStatus.runtime.checkInactive(job), false, 'without the status there is no proof');
  const cliSelected = fixture({ resolveBackend: () => 'cli', pm: { get: () => undefined, getModelSettingsStatus: async () => ({ outcome: 'not-loaded' }) } });
  assert.equal(await cliSelected.runtime.checkInactive(job), false, 'a missing Claude CLI process may still have a surviving tmux session');
});

test('recovery of an unknown Codex job proves inactivity without spawning, so it never takes the daemon\'s Codex lease', async () => {
  let spawns = 0;
  for (const [current, status, expected] of [
    [undefined, 'not-loaded', true], [undefined, 'daemon-busy', true], [undefined, 'unavailable', false],
    [codexEntry(), 'loaded', true], [codexEntry({ state: 'BackgroundWorking' }), 'loaded', false], [codexEntry({ inFlight: true }), 'loaded', false],
  ]) {
    let confirmed = 0;
    const f = fixture({ pm: { get: () => current, getModelSettingsStatus: async () => ({ outcome: status }) }, getOrSpawnForChat: async () => { spawns++; return codexEntry(); } });
    assert.equal(await f.runtime.recoverInactive(job, () => { confirmed++; }), expected, `${status} ${current?.state}`);
    assert.equal(confirmed, expected ? 1 : 0);
  }
  assert.equal(spawns, 0);
  const paused = fixture({ isPaused: () => true, pm: { get: () => undefined, getModelSettingsStatus: async () => ({ outcome: 'not-loaded' }) } });
  assert.equal(await paused.runtime.recoverInactive(job, () => { throw new Error('must not confirm'); }), false);
});

test('a live process of the other backend fails the job instead of sending into it', async () => {
  const cli = { backend: 'cli', inFlight: false, probeBusyState: async () => ({ busy: false }) };
  const f = fixture({ pm: { get: () => cli, getModelSettingsStatus: async () => ({ outcome: 'unavailable', reason: 'wrong-runtime' }) } });
  const result = await f.runtime.dispatch(job);
  assert.equal(result.outcome, 'failed');
  assert.equal(f.calls.length, 0);
  const g = fixture({ pm: { get: () => undefined, getModelSettingsStatus: async () => ({ outcome: 'not-loaded' }) }, getOrSpawnForChat: async () => cli });
  assert.equal((await g.runtime.dispatch(job)).outcome, 'failed');
  assert.equal(g.calls.length, 0);
});

test('the turn is settled right after it resolves: after the send, before the end-of-turn inactivity check', async () => {
  const f = fixture();
  f.deps.awaitSessionRecovery = async () => { f.events.push('recovery'); };
  const runtime = createExternalJobRuntime(f.deps);
  await runtime.dispatch(job);
  assert.deepEqual(f.events, ['recovery', 'send', ['settle', target.sessionKey, codexResult(), 'delivered'], 'recovery']);
});

test('a failed settlement is reported with its code and the job and attempt ids, never the error text', async () => {
  const logged = [];
  const recorded = [];
  const f = fixture({
    settleResult: async () => { throw Object.assign(new Error('ledger write failed: secret detail'), { code: 'CODEX_DURABILITY_FAILED' }); },
    logger: { warn: (line) => logged.push(line), error: (line) => logged.push(line) },
    logEvent: (kind, detail) => recorded.push([kind, detail]),
  });
  assert.equal((await f.runtime.dispatch(job)).outcome, 'succeeded');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /CODEX_DURABILITY_FAILED/);
  assert.doesNotMatch(logged[0], /secret detail/);
  assert.deepEqual(recorded, [['codex-external-job-settlement-failed', {
    request_id: job.requestId, session_key: target.sessionKey, generation_id: 'gen-1', attempt_id: 'attempt-1', disposition: 'delivered', code: 'CODEX_DURABILITY_FAILED',
  }]], 'an unsettled attempt quarantines the lease at the next retirement, so the events table must show why');
});

test('the no-process proof rereads the process after the status, so a process spawned meanwhile is never declared idle', async () => {
  let current;
  const f = fixture({ pm: { get: () => current, getModelSettingsStatus: async () => { current = codexEntry({ state: 'Active' }); return { outcome: 'not-loaded' }; } } });
  assert.equal(await f.runtime.checkInactive(job), false);
});

test('a status call stuck behind the session\'s lifecycle gate gives no proof instead of stalling the job queue', async () => {
  const f = fixture({ pm: { get: () => undefined, getModelSettingsStatus: () => new Promise(() => {}) }, statusTimeoutMs: 20 });
  const started = Date.now();
  assert.equal(await f.runtime.checkInactive(job), false);
  assert.ok(Date.now() - started < 1000);
});

test('recovery confirms nothing when the session is paused or switched away from Codex during the proof', async () => {
  let paused = false;
  const f = fixture({ isPaused: () => paused, pm: { get: () => undefined, getModelSettingsStatus: async () => { paused = true; return { outcome: 'not-loaded' }; } } });
  assert.equal(await f.runtime.recoverInactive(job, () => { throw new Error('must not confirm'); }), false);
  let backend = 'codex';
  const g = fixture({ resolveBackend: () => backend, pm: { get: () => undefined, getModelSettingsStatus: async () => { backend = 'cli'; return { outcome: 'not-loaded' }; } } });
  assert.equal(await g.runtime.recoverInactive(job, () => { throw new Error('must not confirm'); }), false);
});

test('with the production login rule, an expired Claude login neither delays nor blocks recovery of Codex mail', async () => {
  const { needsNativeClaudeAuth } = require('../lib/ops/claude-auth-health');
  const needsAuth = (backend) => needsNativeClaudeAuth({}, backend);
  let current;
  const f = fixture({ needsAuth, checkAuth: () => ({ state: 'expired' }), pm: { get: () => current, getModelSettingsStatus: async () => ({ outcome: 'not-loaded' }) },
    getOrSpawnForChat: async () => { current = codexEntry(); return current; } });
  let confirmed = 0;
  assert.equal(await f.runtime.recoverInactive(job, () => { confirmed++; }), true, 'needsAuth must receive the backend: without it the production rule throws');
  assert.equal(confirmed, 1);
  assert.equal((await f.runtime.dispatch(job)).outcome, 'succeeded');
});

test('a resolver limited to the Claude CLI refuses a Codex destination, so a notification consumer there fails loudly', () => {
  const config = { chats: { '-1001': { isolateTopics: true, topics: { 5: {} } } } };
  const cliOnly = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend: () => 'codex', backends: ['cli'] });
  assert.throws(() => cliOnly(route), /require the Claude CLI backend/);
});

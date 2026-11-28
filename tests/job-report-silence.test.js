'use strict';
// A job turn's final text is posted to its chat as the job report. After
// 0.56.1, 74% of 47 reports were noise ("nothing to do", bookkeeping, "I didn't
// post in the topic") because agents almost never end a turn with an empty
// text. NO_REPLY, the silence the human-turn path already honors, lets the
// agent decide to post nothing: such a report is not posted and is recorded
// as silent, so a later review can count it. The token inside other text is
// cut out, never posted, and never silences a result written next to it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const { reportOf } = require('../lib/external-jobs/voice');
const { createExternalJobStore } = require('../lib/external-jobs/store');
const { createExternalJobService } = require('../lib/external-jobs/service');
const { createExternalJobDispatch } = require('../lib/external-jobs/dispatch');

const target = { chatId: '-1001', threadId: '2', sessionKey: '-1001:2' };
const memoryDb = (t) => {
  const raw = new Database(':memory:'); raw.exec(fs.readFileSync(require.resolve('../lib/external-jobs/schema.sql'), 'utf8'));
  t.after(() => raw.close());
  return raw;
};

test('a final text that is exactly NO_REPLY, trimmed, is silent', () => {
  for (const text of ['NO_REPLY', '  NO_REPLY\n', '\nNO_REPLY\n\n']) {
    assert.deepEqual(reportOf(text), { text: '', silent: 'no-reply', stripped: false }, JSON.stringify(text));
  }
});

test('NO_REPLY next to a result posts the result without the token, so nothing a person needed is lost', () => {
  assert.deepEqual(reportOf('Runway is seven months.\n\nNO_REPLY'), { text: 'Runway is seven months.', silent: null, stripped: true });
  assert.deepEqual(reportOf('NO_REPLY\nRunway is seven months.'), { text: 'Runway is seven months.', silent: null, stripped: true });
  assert.deepEqual(reportOf('Runway: seven months. NO_REPLY'), { text: 'Runway: seven months.', silent: null, stripped: true });
  assert.deepEqual(reportOf('First.\n\nNO_REPLY\n\nSecond.'), { text: 'First.\n\nSecond.', silent: null, stripped: true },
    'a line left blank by the token is dropped, so no gap is posted');
});

test('only a whole word is the token: other words and text without it are posted as written', () => {
  for (const text of ['Set NO_REPLY_TIMEOUT to 5.', 'XNO_REPLY', 'Runway is seven months.', '  indented\n\n\nkept  ']) {
    assert.deepEqual(reportOf(text), { text, silent: null, stripped: false }, text);
  }
  assert.deepEqual(reportOf(''), { text: '', silent: null, stripped: false });
  assert.deepEqual(reportOf(undefined), { text: undefined, silent: null, stripped: false });
});

// The token is a control word only where an agent ends or starts on it, or
// gives it a line of its own. Anywhere else it is a mention (a result about
// polygram's own NO_REPLY rule, a code sample), and cutting it would garble
// text a person needs.
test('wrapping markup and dashes go with the token, so no stray "``", "****" or "—" is posted', () => {
  assert.deepEqual(reportOf('Done.\n\n`NO_REPLY`'), { text: 'Done.', silent: null, stripped: true });
  assert.deepEqual(reportOf('Done.\n\n**NO_REPLY**'), { text: 'Done.', silent: null, stripped: true });
  assert.deepEqual(reportOf('Готово.\n\n— NO_REPLY'), { text: 'Готово.', silent: null, stripped: true });
  assert.deepEqual(reportOf('Ничего не нужно. NO_REPLY'), { text: 'Ничего не нужно.', silent: null, stripped: true });
  assert.deepEqual(reportOf('Done — NO_REPLY'), { text: 'Done', silent: null, stripped: true });
  assert.deepEqual(reportOf('NO_REPLY — nothing else was needed.'), { text: 'nothing else was needed.', silent: null, stripped: true });
});

test('a mention of the token inside a sentence or in code is posted as written', () => {
  for (const text of [
    'Reports that are exactly NO_REPLY are now silent.',
    'Fixed it:\n```js\n    if (text === NO_REPLY) return;\n```\nDeployed.',
    'Done.\n```\nNO_REPLY\n```\nThat is the token.',
  ]) assert.deepEqual(reportOf(text), { text, silent: null, stripped: false }, text);
});

test('a lookalike word is not the token: the text comes back exactly as written', () => {
  for (const text of ['FOO_NO_REPLY_BAR\n\n\nx  ', 'NO_REPLYING is not a word']) {
    assert.deepEqual(reportOf(text), { text, silent: null, stripped: false }, text);
  }
});

// reportOf runs on the daemon's event loop for every job report, on text the
// agent wrote. A backtracking pattern over a long whitespace run (a pasted
// log, a wide table) took 1 s for 16 000 spaces and grew with the square of
// the length, which would stall every chat. It must stay linear.
test('a long text is checked in linear time, however much whitespace it holds', () => {
  for (const text of [' '.repeat(20000) + 'a NO_REPLY b', 'x '.repeat(20000) + ' '.repeat(20000) + 'end NO_REPLY', `${'\t'.repeat(20000)}NO_REPLY`]) {
    const started = process.hrtime.bigint();
    reportOf(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 300, `took ${ms.toFixed(0)} ms for ${text.length} characters`);
  }
});

test('with nothing readable left once the token is cut, the report is silent', () => {
  // Markdown around the token, a full stop, or two Codex messages that were
  // both NO_REPLY (Codex joins every message of the turn with a blank line).
  for (const text of ['`NO_REPLY`', '**NO_REPLY**', 'NO_REPLY.', 'NO_REPLY\n\nNO_REPLY', '— NO_REPLY 👍']) {
    assert.deepEqual(reportOf(text), { text: '', silent: 'no-reply', stripped: false }, text);
  }
});

test('Codex: a narration followed by a NO_REPLY message posts the narration, without the token', () => {
  // `_finalTurnText` joins the turn's agent messages with "\n\n"; polygram
  // gets only the joined text, so it cannot drop the narration without also
  // dropping a result written the same way.
  const joined = ['Checking the inbox first.', 'NO_REPLY'].join('\n\n');
  assert.deepEqual(reportOf(joined), { text: 'Checking the inbox first.', silent: null, stripped: true });
});

test('the store records a silent report with its reason and posts no part', (t) => {
  const store = createExternalJobStore(memoryDb(t), { botName: 'test', now: () => 1000 });
  const submit = (requestId, sessionKey = target.sessionKey) => store.claim(store.submit({ routeId: 'review', requestId, task: 'Review.', payload: {} }, { ...target, sessionKey }).job.id);
  const job = submit('one'); store.setTurnId(job.id, 'turn-one');
  const done = store.finish(job.id, { outcome: 'succeeded', silent: 'no-reply', inactive: true });
  assert.equal(done.reportState, 'silent');
  assert.deepEqual(done.reportReceipt, { silent: 'no-reply', turnId: 'turn-one' });
  assert.deepEqual(store.parts(job.id), []);
  assert.deepEqual(store.reports(), [], 'a silent report is never picked up for delivery');
  // The rule holds for any outcome: NO_REPLY is the agent's own choice.
  assert.equal(store.finish(submit('two').id, { outcome: 'failed', error: 'x', silent: 'no-reply', inactive: true }).reportState, 'silent');
  assert.throws(() => store.finish(submit('three').id, { outcome: 'succeeded', silent: 'bored', inactive: true }), /silence/i);
  // The service's fallback after a failed report records the outcome with
  // the error; the reason no longer matters then, so it must not throw again
  // and leave the job running.
  assert.equal(store.finish(submit('four', '-1001:4').id, { outcome: 'succeeded', silent: 'bored', reportError: 'Report preparation failed', inactive: true }).reportState, 'unknown');
});

test('a reply-tool delivery keeps its own record: channelsAcknowledged wins over silence', (t) => {
  const store = createExternalJobStore(memoryDb(t), { botName: 'test', now: () => 1000 });
  const job = store.claim(store.submit({ routeId: 'review', requestId: 'one', task: 'Review.', payload: {} }, target).job.id);
  const done = store.finish(job.id, { outcome: 'succeeded', channelsAcknowledged: true, silent: 'no-reply' });
  assert.equal(done.reportState, 'unknown');
  assert.equal(done.reportReceipt.channelsAcknowledged, true);
});

test('the service posts nothing for a silent result and records it as silent', async (t) => {
  const raw = memoryDb(t);
  const sends = []; let prepared = 0;
  const service = createExternalJobService({
    config: { bot: { externalJobs: { enabled: true, routes: { review: { chatId: '-1001', threadId: '2' } } } } },
    db: { raw }, botName: 'test', resolveTarget: (route) => ({ ...route, sessionKey: `${route.chatId}:${route.threadId}` }),
    dispatch: async (job, hooks) => { hooks.onTurnId('turn-one'); return { outcome: 'succeeded', text: '', silent: 'no-reply', inactive: true }; },
    prepareReport: (text) => { prepared++; return [text]; },
    deliverPart: async (job, part) => { sends.push(part); return { messageId: 1 }; }, logger: { error() {} },
  });
  t.after(() => service.stop());
  service.submit({ routeId: 'review', requestId: 'one', task: 'Review.', payload: {} }); service.start(); await service.tick();
  const { job } = service.get({ routeId: 'review', requestId: 'one' });
  assert.deepEqual([job.state, job.reportState, job.reportReceipt], ['succeeded', 'silent', { silent: 'no-reply', turnId: 'turn-one' }]);
  assert.deepEqual([sends, prepared], [[], 0]);
});

// The dispatch every external job takes applies the rule to the turn's
// result, so every job kind on both backends gets it.
function dispatchWith(result) {
  const logged = [];
  const dispatch = createExternalJobDispatch({
    dispatchExternalEvent: (_origin, run) => run(),
    runtime: { dispatch: async () => result },
    logEvent: (kind, detail) => logged.push([kind, detail]),
  });
  return { logged, run: (requestId = 'daily-digest:2026-11-28') => dispatch({ id: 1, routeId: 'admin', requestId, task: 'Review.', payload: {}, target }, {}) };
}

test('the dispatch turns a NO_REPLY result into a silent one and keeps the turn\'s outcome', async () => {
  for (const outcome of ['succeeded', 'failed']) {
    const f = dispatchWith({ outcome, turnId: 't', text: ' NO_REPLY\n', inactive: true });
    assert.deepEqual(await f.run(), { outcome, turnId: 't', text: '', silent: 'no-reply', inactive: true });
    assert.deepEqual(f.logged, []);
  }
});

test('the dispatch cuts the token from a mixed text and records that it did', async () => {
  const f = dispatchWith({ outcome: 'succeeded', text: 'Runway is seven months.\n\nNO_REPLY' });
  assert.deepEqual(await f.run(), { outcome: 'succeeded', text: 'Runway is seven months.' });
  assert.deepEqual(f.logged, [['job-report-no-reply-stripped', { request_id: 'daily-digest:2026-11-28', session_key: target.sessionKey }]]);
});

test('the dispatch leaves a text without the token, and a deferral, untouched', async () => {
  const plain = { outcome: 'succeeded', text: 'Runway is seven months.' };
  assert.equal(await dispatchWith(plain).run(), plain);
  const deferred = { deferred: true, reason: 'Session is busy' };
  assert.equal(await dispatchWith(deferred).run(), deferred);
});

// The reply tool already delivered this turn's final message, so its text is
// never posted: nothing to decide, and no false "stripped" event.
test('the dispatch leaves a reply-tool delivery alone', async () => {
  const acked = { outcome: 'succeeded', text: 'Runway is seven months.\n\nNO_REPLY', channelsAcknowledged: true };
  const f = dispatchWith(acked);
  assert.equal(await f.run(), acked);
  assert.deepEqual(f.logged, []);
});

// Polygram's own delivery notice ("[Inter-session notice] …") is a status
// message to the session that asked, not news for the people in its topic.
// All 10 notices after 0.56.1 posted text against "don't acknowledge it", so
// a notice turn's text is never posted; on the Claude CLI the agent can still
// tell a person with the reply tool during the turn.
const NOTICE = 'mailbox-notice:m_0000000000000001';
function noticeDispatch(result) {
  const dispatch = createExternalJobDispatch({
    dispatchExternalEvent: (_origin, run) => run(),
    runtime: { dispatch: async () => result },
    getMailbox: () => ({ enabled: true, instructions: () => '', noteJobSend() {} }),
  });
  return (requestId = NOTICE) => dispatch({ id: 1, routeId: 'ops', requestId, task: '[Inter-session notice] …', payload: {}, target }, {});
}

test('a notice never posts its final text, whatever it says', async () => {
  for (const text of ['Noted; nothing for the team here.', 'NO_REPLY', '']) {
    const result = await noticeDispatch({ outcome: 'succeeded', text, inactive: true })();
    assert.deepEqual(result, { outcome: 'succeeded', text: '', silent: 'notice', inactive: true }, String(text));
  }
  const failed = await noticeDispatch({ outcome: 'failed', text: 'It broke.', error: 'x' })();
  assert.equal(failed.silent, 'notice', 'a failed notice turn posts nothing either');
});

// "silent" records a text deliberately not posted; a notice whose send failed
// ran no turn and has no text, like one the kill switch withdrew.
test('a notice that ran no turn keeps its own record', async () => {
  const sendFailed = { outcome: 'unknown', turnId: null, inactive: false, error: 'Turn receipt is unavailable' };
  assert.equal(await noticeDispatch(sendFailed)(), sendFailed);
});

test('only polygram\'s notices are silenced: a reply about the same ask still reports', async () => {
  const result = await noticeDispatch({ outcome: 'succeeded', text: 'Runway is seven months.' })('mailbox:m_0000000000000001');
  assert.deepEqual(result, { outcome: 'succeeded', text: 'Runway is seven months.' });
});

test('the store records a notice as silent with reason notice; a reply-tool delivery keeps its own record', (t) => {
  const store = createExternalJobStore(memoryDb(t), { botName: 'test', now: () => 1000 });
  const submit = (requestId) => store.claim(store.submit({ routeId: 'ops', requestId, task: 'Notice.', payload: {} }, target).job.id);
  const one = submit(NOTICE);
  assert.deepEqual(store.finish(one.id, { outcome: 'succeeded', silent: 'notice', inactive: true }).reportReceipt, { silent: 'notice', turnId: null });
  const two = submit('mailbox-notice:m_0000000000000002');
  assert.equal(store.finish(two.id, { outcome: 'succeeded', silent: 'notice', channelsAcknowledged: true, inactive: true }).reportState, 'unknown');
});

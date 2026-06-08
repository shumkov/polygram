'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createQuestionStore } = require('../lib/questions/store');
const { createQuestionHandlers } = require('../lib/handlers/questions');

function migratedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-'));
  const db = new Database(path.join(dir, 't.db'));
  const migDir = path.join(__dirname, '..', 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  return { db, dir };
}

function harness(opts = {}) {
  const { db, dir } = migratedDb();
  let nextMsgId = 1000;
  let sends = 0;
  const tgCalls = [];
  const answers = [];      // [sessionKey, toolCallId, result]
  const logEvents = [];    // [{ kind, detail }]
  const errors = [];       // logger.error messages
  const store = createQuestionStore(db);
  const h = createQuestionHandlers({
    questions: store,
    bot: {},
    botName: 'b',
    logEvent: (kind, detail) => { logEvents.push({ kind, detail }); },
    answerQuestion: (sk, tc, result) => {
      if (opts.throwAnswer) throw new Error('bridge write-back failed');
      if (opts.falsyAnswer) return false;   // undelivered: session gone / no live bridge
      answers.push({ sk, tc, result });
      return true;
    },
    logger: { error: (m) => { errors.push(m); } },
    tg: async (_b, method, params) => {
      tgCalls.push({ method, params });
      if (method === 'sendMessage') {
        sends += 1;
        if (opts.failSendAfter != null && sends > opts.failSendAfter) throw new Error('telegram send failed');
        return { message_id: ++nextMsgId };
      }
      return { ok: true };
    },
  });
  return { db, dir, store, h, tgCalls, answers, logEvents, errors,
    lastSend: () => [...tgCalls].reverse().find((c) => c.method === 'sendMessage'),
    edits: () => tgCalls.filter((c) => c.method === 'editMessageText') };
}

function cbCtx(data, fromId = 7) {
  const acks = [];
  return {
    callbackQuery: { data },
    from: { id: fromId },
    answerCallbackQuery: async (o) => { acks.push(o || {}); },
    _acks: acks,
  };
}

const SINGLE = [{ header: 'Setup', question: 'Which engine?', options: [{ label: 'Cloud API' }, { label: 'Business app' }] }];
const MULTI = [{ header: 'Features', question: 'Pick any', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }];

describe('question handler — render + single-select round-trip', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  test('renderAsk issues a row + sends a keyboard with token in callback_data', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    assert.ok(row && row.tool_call_id === 'tc1');
    const send = H.lastSend();
    assert.match(send.params.text, /Which engine\?/);
    assert.equal(send.params.parse_mode, undefined, 'plain text — no parse_mode for agent content');
    const cb = send.params.reply_markup.inline_keyboard[0][0].callback_data;
    assert.equal(cb, `q:${row.id}:${row.callback_token}:opt:0`);
  });

  test('tap an option → answers claude + resolves the row', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:1`));
    assert.deepEqual(H.answers, [{ sk: 's:1', tc: 'tc1', result: { answers: [{ header: 'Setup', selected: ['Business app'] }] } }]);
    assert.equal(H.store.getOpenForSession('s:1'), undefined, 'resolved');
  });

  test('empty questions answers immediately (no hang)', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tcX', questions: [] });
    assert.deepEqual(H.answers, [{ sk: 's:1', tc: 'tcX', result: { answers: [] } }]);
  });
});

describe('question handler — security', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  test('bad token is rejected, claude NOT answered', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    const ctx = cbCtx(`q:${row.id}:WRONGTOKEN:opt:0`);
    await H.h.handleQuestionCallback(ctx);
    assert.match(ctx._acks[0].text, /Bad token/);
    assert.equal(H.answers.length, 0);
    assert.ok(H.store.getOpenForSession('s:1'), 'still open');
  });

  test('a different user (not the claimer) cannot answer', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`, 42)); // user 42 claims + answers
    // re-open a fresh one to test the foreign-user path mid-flow:
    await H.h.renderAsk({ sessionKey: 's:2', chatId: '100', toolCallId: 'tc2', questions: MULTI });
    const r2 = H.store.getOpenForSession('s:2');
    await H.h.handleQuestionCallback(cbCtx(`q:${r2.id}:${r2.callback_token}:opt:0`, 42));   // 42 claims by toggling
    const ctx = cbCtx(`q:${r2.id}:${r2.callback_token}:submit`, 99);                         // 99 tries to submit
    await H.h.handleQuestionCallback(ctx);
    assert.match(ctx._acks[0].text, /someone else/i);
    assert.equal(H.answers.filter((a) => a.tc === 'tc2').length, 0, 'foreign responder did NOT answer claude');
    assert.ok(H.store.getOpenForSession('s:2'), 'question stays open for the rightful user');
  });
});

// Review-flagged: the anti-hang invariant must hold on FAILURE paths, not just the
// happy path; the wrong-user nudge must not swallow ordinary chatter.
describe('question handler — anti-hang on failures (review)', () => {
  test('first-question send failure → claude answered {cancelled}, no stranded pending row', async () => {
    const H = harness({ failSendAfter: 0 });   // every sendMessage throws
    try {
      await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
      assert.ok(H.answers.find((a) => a.tc === 'tc1' && a.result.cancelled), 'claude answered {cancelled} (not hung)');
      assert.equal(H.store.getOpenForSession('s:1'), undefined, 'no stranded pending row');
    } finally { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); }
  });

  test('next-question send failure mid-sequence → claude answered {cancelled}, not hung', async () => {
    const H = harness({ failSendAfter: 1 });   // first send ok, second (Q2) throws
    try {
      const TWO = [
        { header: 'Q1', question: 'p', options: [{ label: 'a' }, { label: 'b' }] },
        { header: 'Q2', question: 'p', options: [{ label: 'c' }] },
      ];
      await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: TWO });
      const row = H.store.getOpenForSession('s:1');
      await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
      assert.ok(H.answers.find((a) => a.result.cancelled), 'claude answered {cancelled} when Q2 could not be delivered');
      assert.equal(H.store.getOpenForSession('s:1'), undefined, 'not left pending');
    } finally { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); }
  });

  test('answerQuestion write-back throwing → row LEFT pending (not resolved-but-hung), no crash', async () => {
    const H = harness({ throwAnswer: true });
    try {
      await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
      const row = H.store.getOpenForSession('s:1');
      await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));   // must not throw out
      const fresh = H.store.getById(row.id);
      assert.equal(fresh.status, 'pending', 'NOT marked answered — left for the timeout sweep to recover');
    } finally { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); }
  });

  test('expireQuestion answers {timedout} + strips + resolves timeout', async () => {
    const H = harness();
    try {
      await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
      const row = H.store.getOpenForSession('s:1');
      await H.h.expireQuestion(row);
      assert.ok(H.answers.find((a) => a.tc === 'tc1' && a.result.timedout), 'claude answered {timedout}');
      assert.equal(H.store.getById(row.id).status, 'timeout');
      assert.ok(H.edits().some((e) => /timed out/i.test(e.params.text)), 'keyboard stripped with a notice');
    } finally { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); }
  });
});

// Wiring-review (commit 768b17e follow-up): the anti-hang contract must also hold
// when the STORE or the bridge write-back misbehaves, and the free-text "Other"
// flow must reach the dispatcher even behind a group's mention gate.
describe('question handler — wiring-review hardening', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  // Finding E: a throw inside tryConsumeAsAnswer (e.g. SQLITE_BUSY, poisoned
  // state_json) must NOT propagate — the dispatcher would otherwise drop the
  // user's unrelated message entirely (no reply, no new turn).
  test('tryConsumeAsAnswer never throws on a store error → falls through (msg not dropped)', async () => {
    H.store.getOpenForSession = () => { throw new Error('SQLITE_BUSY'); };
    const r = await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: 'an unrelated message' });
    assert.equal(r.consumed, false, 'a store error must degrade to "not an answer", never throw out of the dispatcher');
  });

  // Finding C: if renderAsk throws BEFORE a row is issued, no row exists for the
  // sweep to recover — claude would block until the bridge's 20-min ceiling.
  // It must answer {cancelled} immediately instead.
  test('renderAsk throwing before issuing a row still answers claude {cancelled} (no 20-min hang)', async () => {
    H.store.issue = () => { throw new Error('SQLITE_BUSY at issue'); };
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tcZ', questions: SINGLE });
    assert.ok(H.answers.find((a) => a.tc === 'tcZ' && a.result.cancelled),
      'claude is answered {cancelled} rather than left to the 20-min bridge ceiling');
  });

  // Finding A: pm.answerQuestion returns false (session gone / no live bridge) —
  // a no-op, not a throw. finalize must surface it loudly AND still resolve the
  // row so the 30s sweep does not re-strip + re-answer it forever.
  test('undelivered answer (answerQuestion → false) is surfaced loud + row still resolved', async () => {
    const H2 = harness({ falsyAnswer: true });
    try {
      await H2.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
      const row = H2.store.getOpenForSession('s:1');
      await H2.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
      assert.notEqual(H2.store.getById(row.id).status, 'pending',
        'resolved (not left pending) so the timeout sweep does not loop forever on a dead session');
      assert.ok(H2.logEvents.find((e) => e.kind === 'question-answer-undelivered'),
        'undelivered delivery is emitted as an event (fail loud)');
      assert.ok(H2.errors.some((m) => /undeliver/i.test(m)), 'and logged');
    } finally { H2.db.close(); fs.rmSync(H2.dir, { recursive: true, force: true }); }
  });

  // Finding 1: in a mention-gated group the owner's free-text "Other" answer is
  // sent without an @mention; the dispatcher needs a way to know it should bypass
  // the gate. isAwaitingOtherFrom is that predicate — owner-only.
  test('isAwaitingOtherFrom is true only for the owner of an open free-text capture', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    assert.equal(H.h.isAwaitingOtherFrom('s:1', 7), false, 'not awaiting Other before any tap');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`, 7));  // user 7 claims + arms Other
    assert.equal(H.h.isAwaitingOtherFrom('s:1', 7), true, 'owner is awaiting their free-text answer');
    assert.equal(H.h.isAwaitingOtherFrom('s:1', 99), false, 'a different user does NOT bypass the gate');
    assert.equal(H.h.isAwaitingOtherFrom('s:none', 7), false, 'no open question for that session');
  });
});

describe('question handler — typed-message diversion (review)', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  test('a question awaiting a BUTTON tap does NOT swallow ordinary chatter', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    // not in awaiting_other → a bystander's normal message must flow through
    const r = await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 999, text: 'unrelated chat' });
    assert.equal(r.consumed, false, 'normal messages are not eaten while waiting for a button tap');
    assert.equal(H.answers.length, 0);
  });

  test('during free-text capture, the WRONG user is nudged (not consumed as the answer)', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`, 7));   // user 7 claims + arms Other
    const r = await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 99, text: 'I am not the asker' });
    assert.equal(r.consumed, true, 'swallowed (does not start a turn) ...');
    assert.equal(H.answers.length, 0, '... but NOT recorded as the answer');
    assert.ok(H.store.getOpenForSession('s:1'), 'question stays open for the rightful user');
  });

  test('/stop while awaiting Other is NOT consumed (command escape)', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`, 7));
    const r = await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: '/stop' });
    assert.equal(r.consumed, false, '/stop escapes free-text capture so the abort handler runs');
  });
});

describe('question handler — multi-question sequencing + receipt (review)', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  test('two questions answered through the handler: Q2 sent, msg_id updated, done only after both', async () => {
    const TWO = [
      { header: 'Q1', question: 'p', options: [{ label: 'a' }, { label: 'b' }] },
      { header: 'Q2', question: 'p', options: [{ label: 'c' }, { label: 'd' }] },
    ];
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: TWO });
    let row = H.store.getOpenForSession('s:1');
    const firstMsg = JSON.parse(row.message_ids_json)[0];
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:1`));   // b
    assert.equal(H.answers.length, 0, 'claude not answered after Q1');
    row = H.store.getById(row.id);
    const secondMsg = JSON.parse(row.message_ids_json)[0];
    assert.notEqual(secondMsg, firstMsg, 'message_ids advanced to the Q2 keyboard');
    assert.match(H.lastSend().params.text, /Question 2 of 2/);
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));   // c
    assert.deepEqual(H.answers[0].result.answers, [{ header: 'Q1', selected: ['b'] }, { header: 'Q2', selected: ['c'] }]);
  });

  test('single-select tap posts a ✓ receipt (keyboard stripped, no double-submit)', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
    assert.ok(H.edits().some((e) => /✓ Cloud API/.test(e.params.text)), 'receipt shows the choice + removes the keyboard');
  });
});

describe('question handler — multi-select + free-text', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  test('toggle two then submit → answers claude with both', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: MULTI });
    const row = H.store.getOpenForSession('s:1');
    const base = `q:${row.id}:${row.callback_token}`;
    await H.h.handleQuestionCallback(cbCtx(`${base}:opt:0`));   // A
    await H.h.handleQuestionCallback(cbCtx(`${base}:opt:2`));   // C
    await H.h.handleQuestionCallback(cbCtx(`${base}:submit`));
    assert.deepEqual(H.answers[0].result, { answers: [{ header: 'Features', selected: ['A', 'C'] }] });
  });

  test('Other → typed reply consumed as free text + answers claude', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`, 7));
    assert.equal(H.store.getById(row.id).awaiting_other, 1);
    const r = await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: 'my own answer' });
    assert.equal(r.consumed, true);
    assert.deepEqual(H.answers[0].result, { answers: [{ header: 'Setup', selected: [], other: 'my own answer' }] });
  });

  test('typed reply with no open question is NOT consumed', async () => {
    const r = await H.h.tryConsumeAsAnswer({ sessionKey: 's:none', fromId: 7, text: 'hi' });
    assert.equal(r.consumed, false);
  });

  test('a second ask while one is open cancels + unblocks the first', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tcOLD', questions: SINGLE });
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tcNEW', questions: MULTI });
    assert.ok(H.answers.find((a) => a.tc === 'tcOLD' && a.result.cancelled), 'old ask answered cancelled (no hang)');
    assert.equal(H.store.getOpenForSession('s:1').tool_call_id, 'tcNEW');
  });
});

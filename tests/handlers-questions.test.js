'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createQuestionStore } = require('../lib/questions/store');
const { createQuestionHandlers } = require('../lib/handlers/questions');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      if (method === 'editMessageText' && opts.editPromise) {
        return opts.editPromise;
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

  test('answerQuestion write-back throwing → row cancelled, never answered, no crash', async () => {
    // The handler holds the agent's exact questions in memory for the life of
    // the ask. A write-back that failed cannot be retried from the row alone —
    // the row only has sanitized text — so the question ends here rather than
    // waiting for a sweep that could only deliver the wrong thing.
    const H = harness({ throwAnswer: true });
    try {
      await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
      const row = H.store.getOpenForSession('s:1');
      await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));   // must not throw out
      const fresh = H.store.getById(row.id);
      assert.equal(fresh.status, 'cancelled', 'NOT marked answered');
      assert.equal(H.h.liveContextCount(), 0, 'and nothing exact is left behind');
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

  test('authorized deploy cancellation registers the card edit without answering the retiring provider', async () => {
    const edit = deferred();
    const H = harness({ editPromise: edit.promise });
    try {
      await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
      const row = H.store.getOpenForSession('s:1');
      const editing = H.h.beginShutdownDisposition(row, {
        message: 'Bot is restarting — this question was cancelled.',
      });

      assert.equal(H.store.getById(row.id).status, 'cancelled');
      assert.deepEqual(H.answers, [], 'the old provider must not resume from a synthetic cancellation answer');
      assert.equal(H.edits().length, 1, 'the already-admitted card edit is registered immediately');

      edit.resolve({ ok: true });
      await editing;
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

  // Prod (hire topic, 2026-06-09): a typed "Other" answer was delivered to claude but the
  // question card stayed frozen on "Send your answer as a message." — no ✓ receipt — so the
  // user got zero acknowledgment and thought nothing happened. A typed answer must confirm
  // visibly the same way a button tap does (the `✓ receipt` edit at line ~299).
  test('Other → typed reply ALSO posts a ✓ receipt (was silent: hire-topic dead-air)', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc1', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`, 7));
    const before = H.edits().length;   // the "Send your answer…" edit already happened
    await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: 'ship it tomorrow' });
    assert.ok(
      H.edits().slice(before).some((e) => /✓ ship it tomorrow/.test(e.params.text)),
      'the typed answer strips the card to a ✓ receipt (visible acknowledgment)',
    );
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

// ── the provider's question text is live-only ─────────────────────────
//
// `Q.renderCurrent` builds the card from `state.questions` and `Q.applyTap`
// records `options[i].label` from the same array, so the array the handler
// holds decides both what the user sees and what the state machine matches.
// It is kept exact in the handler's live context and sanitized in every
// durable copy.
const SECRET_Q = [
  {
    header: 'Creds',
    question: 'use password: hunter2-fake-value for staging?',
    options: [{ label: 'yes, password: hunter2-fake-value' }, { label: 'no' }],
  },
];
const THREE_SECRET_Q = [0, 1, 2].map((i) => ({
  header: `Step ${i + 1}`,
  question: `step ${i + 1} uses password: hunter2-fake-value`,
  options: [{ label: 'ok' }, { label: 'skip' }],
}));

describe('question handler — exact questions stay live-only', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  const stateOf = (id) => JSON.parse(H.db.prepare('SELECT state_json FROM pending_questions WHERE id=?').get(id).state_json);

  test('the card the user sees keeps the exact question and option labels', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-q', questions: SECRET_Q });
    const sent = H.lastSend();
    assert.match(sent.params.text, /use password: hunter2-fake-value for staging\?/);
    assert.equal(sent.params.reply_markup.inline_keyboard[0][0].text, 'yes, password: hunter2-fake-value');
  });

  test('neither durable copy holds the exact question while the row is open', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-q', questions: SECRET_Q });
    const row = H.store.getOpenForSession('s:1');
    assert.ok(!row.questions_json.includes('hunter2-fake-value'), row.questions_json);
    assert.ok(!row.state_json.includes('hunter2-fake-value'), row.state_json);
  });

  test('option matching still selects the exact label the user tapped', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-q', questions: SECRET_Q });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:1`));
    assert.equal(H.answers.length, 1);
    assert.deepEqual(H.answers[0].result, { answers: [{ header: 'Creds', selected: ['no'] }] });
  });

  test('every tap of a 1..N sequence leaves only sanitized question text durable', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-3q', questions: THREE_SECRET_Q });
    const row = H.store.getOpenForSession('s:1');
    for (let i = 0; i < 3; i++) {
      const live = H.store.getById(row.id);
      // eslint-disable-next-line no-await-in-loop
      await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${live.callback_token}:opt:0`));
      const after = H.db.prepare('SELECT state_json FROM pending_questions WHERE id=?').get(row.id).state_json;
      assert.ok(!after.includes('hunter2-fake-value'), `after tap ${i + 1}: ${after}`);
      if (i < 2) {
        assert.match(H.lastSend().params.text, /uses password: hunter2-fake-value/,
          'the next card still shows the exact question');
      }
    }
    assert.equal(H.answers.length, 1, 'answered once, after the last question');
    assert.deepEqual(H.answers[0].result.answers.map((a) => a.selected[0]), ['ok', 'ok', 'ok']);
  });

  test('after a restart an unmarked row falls back to the sanitized copy', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-q', questions: SECRET_Q });
    const row = H.store.getOpenForSession('s:1');
    // A fresh handler over the same store is exactly what a restart leaves.
    const restarted = harness();
    try {
      const store2 = createQuestionStore(H.db);
      const h2 = createQuestionHandlers({
        questions: store2, bot: {}, botName: 'b',
        logEvent: () => {}, logger: { error: () => {} },
        answerQuestion: (sk, tc, result) => { restarted.answers.push({ sk, tc, result }); return true; },
        tg: async () => ({ message_id: 1 }),
      });
      await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
      assert.equal(restarted.answers.length, 1, 'the tap still resolves rather than crashing');
      const label = restarted.answers[0].result.answers[0].selected[0];
      assert.ok(!label.includes('hunter2-fake-value'),
        'the exact label is gone with the process; the sanitized copy is what is left');
    } finally {
      try { restarted.db.close(); fs.rmSync(restarted.dir, { recursive: true, force: true }); } catch {}
    }
    assert.equal(stateOf(row.id).qIndex, 1);
  });
});

// ── a flagged answer is held live, never durable ──────────────────────
//
// The predicate is the durable-write sanitizer, so its allowlist decides the
// benign cases. What the provider receives must stay byte-identical to the
// value the state machine accepted. Assertions target the PENDING row: the
// terminal mask would hide the window this unit exists to close.
const SECRET_ANSWER = 'password: hunter2-fake-value';
const ONE_Q = [{ header: 'Creds', question: 'staging password?', options: [{ label: 'skip' }] }];
const TWO_Q = [
  { header: 'Creds', question: 'staging password?', options: [{ label: 'password: hunter2-fake-value' }, { label: 'skip' }] },
  { header: 'Next', question: 'anything else?', options: [{ label: 'no' }] },
];

async function typeAnswer(H, key, toolCallId, questions, text) {
  await H.h.renderAsk({ sessionKey: key, chatId: '100', toolCallId, questions });
  const row = H.store.getOpenForSession(key);
  await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
  await H.h.tryConsumeAsAnswer({ sessionKey: key, fromId: 7, text });
  return row;
}

describe('question handler — flagged answers held live', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  const rawState = (id) => H.db.prepare('SELECT state_json FROM pending_questions WHERE id=?').get(id).state_json;

  test('a flagged typed answer reaches the provider exactly and the row not at all', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-a', ONE_Q, SECRET_ANSWER);
    assert.equal(H.answers.length, 1);
    assert.deepEqual(H.answers[0].result,
      { answers: [{ header: 'Creds', selected: [], other: SECRET_ANSWER }] });
    assert.ok(!rawState(row.id).includes('hunter2-fake-value'), rawState(row.id));
    assert.equal(H.h.liveAnswerCount(), 0, 'the live copy is dropped after delivery');
  });

  test('the pending row carries a marker with no answer text', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-m', TWO_Q, SECRET_ANSWER);
    const pending = H.store.getById(row.id);
    assert.equal(pending.status, 'pending', 'still mid-prompt, so nothing has been masked yet');
    assert.deepEqual(JSON.parse(pending.state_json).answers[0],
      { header: 'Creds', selected: [], secret_omitted: true });
    assert.ok(!pending.state_json.includes('hunter2-fake-value'), pending.state_json);
    assert.equal(H.h.liveAnswerCount(), 1, 'held until the prompt completes');
  });

  test('a flagged SELECTED label is held live while the row is still open', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-l', questions: TWO_Q });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
    const pending = H.store.getById(row.id);
    assert.equal(pending.status, 'pending');
    assert.equal(JSON.parse(pending.state_json).answers[0].secret_omitted, true);
    assert.ok(!pending.state_json.includes('hunter2-fake-value'), pending.state_json);
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${pending.callback_token}:opt:0`));
    assert.deepEqual(H.answers[0].result.answers[0].selected, ['password: hunter2-fake-value']);
  });

  test('an allowlisted or plain answer stays durable and exact', async () => {
    for (const [i, text] of ['password: required', 'sonnet please'].entries()) {
      const key = `s:allow${i}`;
      // eslint-disable-next-line no-await-in-loop
      const row = await typeAnswer(H, key, `tc-allow${i}`, TWO_Q, text);
      const pending = H.store.getById(row.id);
      assert.ok(pending.state_json.includes(text), `${text} should stay durable`);
      assert.equal(H.h.liveAnswerCount(), 0, `${text} is not held live`);
    }
  });

  test('an over-long flagged answer round-trips as the already-capped value', async () => {
    const long = `${SECRET_ANSWER}-${'x'.repeat(2000)}`;
    const row = await typeAnswer(H, 's:1', 'tc-cap', TWO_Q, long);
    assert.ok(!rawState(row.id).includes('xxxx'), 'no capped body in the row either');
    const pending = H.store.getById(row.id);
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${pending.callback_token}:opt:0`));
    assert.equal(H.answers[0].result.answers[0].other, long.slice(0, 1000));
  });

  test('a missing live answer cancels with a notice and delivers nothing', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-gone', TWO_Q, SECRET_ANSWER);
    H.h.discardSession('s:1');                 // the session was retired mid-prompt
    const pending = H.store.getById(row.id);
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${pending.callback_token}:opt:0`));
    assert.deepEqual(H.answers, [], 'nothing is delivered upstream');
    assert.equal(H.store.getById(row.id).status, 'cancelled');
    const notice = H.edits().slice(-1)[0].params.text;
    assert.match(notice, /did not keep/i);
    assert.ok(!notice.includes('hunter2-fake-value') && !notice.includes('secret_omitted'), notice);
  });

  test('a throwing write-back clears the live answer and cancels the row', async () => {
    const H2 = harness({ throwAnswer: true });
    try {
      const row = await typeAnswer(H2, 's:1', 'tc-throw', ONE_Q, SECRET_ANSWER);
      assert.equal(H2.h.liveAnswerCount(), 0, 'no secret is retained for an implicit retry');
      assert.equal(H2.store.getById(row.id).status, 'cancelled');
      assert.ok(!H2.errors.join('|').includes('hunter2-fake-value'), 'no secret in the error log');
    } finally {
      try { H2.db.close(); fs.rmSync(H2.dir, { recursive: true, force: true }); } catch {}
    }
  });

  test('an unflagged answer whose write-back throws is cancelled too', async () => {
    // Even with nothing held, the context still carries the agent's exact
    // questions — so the same scrub-and-cancel applies.
    const H2 = harness({ throwAnswer: true });
    try {
      const row = await typeAnswer(H2, 's:1', 'tc-plain-throw', ONE_Q, 'sonnet please');
      assert.equal(H2.store.getById(row.id).status, 'cancelled');
      assert.equal(H2.h.liveContextCount(), 0);
    } finally {
      try { H2.db.close(); fs.rmSync(H2.dir, { recursive: true, force: true }); } catch {}
    }
  });

  test('a mixed three-question prompt keeps only the flagged field live', async () => {
    const qs = [ONE_Q[0], { header: 'Model', question: 'which?', options: [{ label: 'sonnet' }] }, ONE_Q[0]];
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-mix', questions: qs });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: SECRET_ANSWER });
    let live = H.store.getById(row.id);
    assert.equal(JSON.parse(live.state_json).answers[0].secret_omitted, true);
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${live.callback_token}:opt:0`));
    live = H.store.getById(row.id);
    assert.deepEqual(JSON.parse(live.state_json).answers[1], { header: 'Model', selected: ['sonnet'] });
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${live.callback_token}:other`));
    await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: 'nothing sensitive' });
    assert.deepEqual(H.answers[0].result.answers, [
      { header: 'Creds', selected: [], other: SECRET_ANSWER },
      { header: 'Model', selected: ['sonnet'] },
      { header: 'Creds', selected: [], other: 'nothing sensitive' },
    ]);
    assert.equal(H.h.liveAnswerCount(), 0);
  });

  test('expiry, shutdown disposition and session reset each drop the live answer', async () => {
    for (const [i, terminal] of ['expire', 'shutdown', 'discard'].entries()) {
      const key = `s:t${i}`;
      // eslint-disable-next-line no-await-in-loop
      const row = await typeAnswer(H, key, `tc-t${i}`, TWO_Q, SECRET_ANSWER);
      assert.equal(H.h.liveAnswerCount(), 1, `${terminal}: held before the terminal step`);
      const fresh = H.store.getById(row.id);
      // eslint-disable-next-line no-await-in-loop
      if (terminal === 'expire') await H.h.expireQuestion(fresh);
      if (terminal === 'shutdown') H.h.beginShutdownDisposition(fresh);
      if (terminal === 'discard') H.h.discardSession(key);
      assert.equal(H.h.liveAnswerCount(), 0, `${terminal}: dropped`);
    }
  });

  test('the marker never reaches Telegram, a log line or an event', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-leak', TWO_Q, SECRET_ANSWER);
    assert.equal(H.store.getById(row.id).status, 'pending', 'a marker exists right now');
    const seen = JSON.stringify({ tg: H.tgCalls, events: H.logEvents, errors: H.errors });
    assert.ok(!seen.includes('secret_omitted'), seen);
    assert.ok(!JSON.stringify(H.logEvents).includes('hunter2-fake-value'));
  });
});

// ── one delivery, and marked rows never outlive their process ─────────
describe('question handler — one delivery, and boot reconciliation', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  test('two concurrent taps on the last question deliver exactly once', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-race', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await Promise.all([
      H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`)),
      H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:1`)),
    ]);
    assert.equal(H.answers.length, 1, `answered ${H.answers.length} times`);
    assert.equal(H.store.getById(row.id).status, 'answered');
  });

  test('a racing loser neither delivers nor destroys the held answer', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-race2', TWO_Q, SECRET_ANSWER);
    const pending = H.store.getById(row.id);
    await Promise.all([
      H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${pending.callback_token}:opt:0`)),
      H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${pending.callback_token}:opt:0`)),
    ]);
    assert.equal(H.answers.length, 1, `answered ${H.answers.length} times`);
    assert.equal(H.answers[0].result.answers[0].other, SECRET_ANSWER,
      'the winner still found the held answer the loser must not have cleared');
    assert.equal(H.h.liveAnswerCount(), 0);
  });

  test('a marked row is cancelled at boot without any upstream answer', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-boot', TWO_Q, SECRET_ANSWER);
    // A restart: a fresh handler over the same store has no live context.
    const store2 = createQuestionStore(H.db);
    const upstream = [];
    const events = [];
    const edits = [];
    const h2 = createQuestionHandlers({
      questions: store2, bot: {}, botName: 'b',
      logEvent: (kind, detail) => events.push({ kind, detail }),
      answerQuestion: (sk, tc, result) => { upstream.push({ sk, tc, result }); return true; },
      logger: { error: () => {} },
      tg: async (_b, method, params) => { edits.push({ method, params }); return { message_id: 1 }; },
    });
    await h2.reconcileMarkedQuestionsAtBoot(store2.listOpen('b'));
    assert.deepEqual(upstream, [], 'a marked row is never replayed upstream');
    assert.equal(store2.getById(row.id).status, 'cancelled');
    const notice = edits.filter((e) => e.method === 'editMessageText').slice(-1)[0].params.text;
    assert.match(notice, /did not keep/i);
    assert.ok(!notice.includes('hunter2-fake-value'), notice);
    assert.ok(!JSON.stringify(events).includes('hunter2-fake-value'));
    assert.ok(!JSON.stringify(events).includes('secret_omitted'));
  });

  test('an unmarked stale row is left alone at boot', async () => {
    await H.h.renderAsk({ sessionKey: 's:2', chatId: '100', toolCallId: 'tc-plain', questions: SINGLE });
    const row = H.store.getOpenForSession('s:2');
    const store2 = createQuestionStore(H.db);
    const h2 = createQuestionHandlers({
      questions: store2, bot: {}, botName: 'b', logEvent: () => {},
      answerQuestion: () => true, logger: { error: () => {} }, tg: async () => ({ message_id: 1 }),
    });
    await h2.reconcileMarkedQuestionsAtBoot(store2.listOpen('b'));
    assert.equal(store2.getById(row.id).status, 'pending',
      'the broader orphaned-question bug is out of scope here');
  });

  test('the marker survives terminal masking with no text', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-mask', TWO_Q, SECRET_ANSWER);
    H.store.resolve(row.id, 'cancelled');
    const after = JSON.parse(H.store.getById(row.id).state_json);
    assert.equal(after.answers[0].secret_omitted, true);
    assert.deepEqual(after.answers[0].selected, []);
    assert.equal(after.answers[0].other, undefined);
  });
});

describe('question handler — failure and staleness are never silent', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  const SECRET_HEADER_Q = [
    { header: `Creds ${SECRET_ANSWER}`, question: 'which one?', options: [{ label: 'skip' }] },
    { header: 'Next', question: 'anything else?', options: [{ label: 'no' }] },
  ];

  test('a secret-bearing question header is held live, not written with a benign answer', async () => {
    // The header travels into every recorded answer, so an ordinary selection
    // to a question whose header names a credential still writes it.
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-hdr', questions: SECRET_HEADER_Q });
    const row = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
    const pending = H.store.getById(row.id);
    assert.equal(pending.status, 'pending');
    assert.ok(!pending.state_json.includes('hunter2-fake-value'), pending.state_json);
    await H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${pending.callback_token}:opt:0`));
    assert.equal(H.answers[0].result.answers[0].header, `Creds ${SECRET_ANSWER}`,
      'the provider still receives the exact header');
  });

  test('a reset while the receipt edit is in flight neither persists nor delivers', async () => {
    // Only the receipt edit is gated, so the interaction can be suspended at
    // exactly the Telegram await where a reset can land.
    const gate = deferred();
    const delivered = [];
    let sends = 0;
    const h2 = createQuestionHandlers({
      questions: H.store, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async (_b, method, params) => {
        if (method === 'editMessageText' && /^✓ /.test(params.text || '')) return gate.promise;
        if (method === 'sendMessage') { sends += 1; return { message_id: 1 }; }
        return { ok: true };
      },
    });
    await h2.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-stale', questions: TWO_Q });
    sends = 0;   // the opening card is not what this is about
    const row = H.store.getOpenForSession('s:1');
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    const inFlight = h2.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: SECRET_ANSWER });
    await new Promise((r) => setImmediate(r));   // let it reach the receipt await
    h2.discardSession('s:1');                    // the session is retired mid-answer
    gate.resolve({ ok: true });
    await inFlight;
    assert.deepEqual(delivered, [], 'a disposed interaction delivers nothing');
    assert.equal(h2.liveContextCount(), 0, 'and no context is recreated');
    const after = H.store.getById(row.id);
    assert.ok(!after.state_json.includes('hunter2-fake-value'), after.state_json);
    assert.equal(sends, 0, 'and the next question is never sent into a retired session');
    assert.equal(after.status, 'cancelled', 'the row does not stay open');
  });

  test('a reset while the FINAL receipt is in flight delivers nothing', async () => {
    // The final answer is resolved from the closure this call is holding, so a
    // reset that lands while the receipt edit is blocked must still stop it:
    // the interaction it belongs to is gone, and the exact value it is holding
    // has nowhere legitimate left to go.
    const gate = deferred();
    const delivered = [];
    const cards = [];
    const h2 = createQuestionHandlers({
      questions: H.store, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async (_b, method, params) => {
        if (method === 'editMessageText') {
          cards.push(params.text);
          if (/^✓ /.test(params.text || '')) return gate.promise;
        }
        return method === 'sendMessage' ? { message_id: 1 } : { ok: true };
      },
    });
    await h2.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-final', questions: ONE_Q });
    const row = H.store.getOpenForSession('s:1');
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    const inFlight = h2.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: SECRET_ANSWER });
    await new Promise((r) => setImmediate(r));   // suspend on the final receipt
    h2.discardSession('s:1');                    // the session is retired
    gate.resolve({ ok: true });
    const outcome = await inFlight;

    assert.deepEqual(delivered, [], 'a retired session receives nothing');
    assert.equal(h2.liveContextCount(), 0, 'and no context is recreated by the late closure');
    assert.equal(h2.liveAnswerCount(), 0);
    const after = H.store.getById(row.id);
    assert.ok(!after.state_json.includes('hunter2-fake-value'), after.state_json);
    assert.equal(outcome.consumed, true, 'the typed text stays consumed, not re-dispatched');
    assert.equal(after.status, 'cancelled', 'no row is left open behind a success card');
    assert.match(cards.slice(-1)[0], /interrupted/i, `card still reads: ${cards.slice(-1)[0]}`);
  });

  test('a callback landing while the cancellation notice is in flight cannot deliver', async () => {
    // The cancel path used to scrub, await Telegram, and only then close the
    // row. During that await an older callback saw pending-and-no-context,
    // recreated ownership and delivered into a session already being retired.
    const gate = deferred();
    const delivered = [];
    const h2 = createQuestionHandlers({
      questions: H.store, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async (_b, method, params) => {
        if (method === 'editMessageText' && /interrupted/i.test(params.text || '')) return gate.promise;
        return method === 'sendMessage' ? { message_id: 1 } : { ok: true };
      },
    });
    await h2.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-race-cancel', questions: ONE_Q });
    const row = H.store.getOpenForSession('s:1');
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));

    const retiring = h2.retireSession('s:1');          // suspends on the notice edit
    await new Promise((r) => setImmediate(r));
    // An older callback arrives while the notice is still in flight.
    const late = await h2.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: 'benign answer' });
    gate.resolve({ ok: true });
    await retiring;

    assert.deepEqual(delivered, [], 'the retiring session must not be answered');
    assert.equal(H.store.getById(row.id).status, 'cancelled');
    assert.equal(h2.liveAnswerCount(), 0);
    assert.ok(late.consumed === true || late.consumed === false, 'and the late call still returns cleanly');
  });

  test('/reload is not swallowed as a free-text answer', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-escape', TWO_Q, 'first answer');
    const open = H.store.getById(row.id);
    await H.h.handleQuestionCallback(cbCtx(`q:${open.id}:${open.callback_token}:other`));
    const outcome = await H.h.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: '/reload' });
    assert.equal(outcome.consumed, false, 'a command must reach the slash dispatcher');
  });

  test('a state-write failure unblocks the agent with one content-free cancellation', async () => {
    // Sealing locally is not enough: the ask is still blocking the provider,
    // so exactly one {cancelled:true} goes out — carrying no state at all.
    const brokenStore = {
      ...H.store,
      updateState: (id, state, awaitingOther) => {
        if ((state.answers || []).length > 0) throw new Error('disk is full');
        return H.store.updateState(id, state, awaitingOther);
      },
    };
    const delivered = [];
    const h2 = createQuestionHandlers({
      questions: brokenStore, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async () => ({ message_id: 1 }),
    });
    await h2.renderAsk({ sessionKey: 's:6', chatId: '100', toolCallId: 'tc-unblock', questions: ONE_Q });
    const row = brokenStore.getOpenForSession('s:6');
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    const outcome = await h2.tryConsumeAsAnswer({ sessionKey: 's:6', fromId: 7, text: SECRET_ANSWER });

    assert.deepEqual(delivered, [{ cancelled: true }], `delivered: ${JSON.stringify(delivered)}`);
    assert.ok(!JSON.stringify(delivered).includes('hunter2-fake-value'));
    assert.equal(outcome.consumed, true);
    assert.equal(h2.liveAnswerCount(), 0);
    assert.equal(H.store.getById(row.id).status, 'cancelled');
  });

  test('a losing sweep neither overwrites the success card nor reports a timeout', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-sweep-race', questions: SINGLE });
    const stale = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${stale.id}:${stale.callback_token}:opt:0`));
    assert.equal(H.answers.length, 1);
    const cardsBefore = H.edits().length;
    const receipt = H.edits().slice(-1)[0].params.text;

    await H.h.expireQuestion(stale);      // the 30s sweep, on its stale snapshot

    assert.equal(H.edits().length, cardsBefore, 'the answered card is left alone');
    assert.equal(H.edits().slice(-1)[0].params.text, receipt);
    assert.deepEqual(H.logEvents.filter((e) => e.kind === 'question-expired'), [],
      'a sweep that owns nothing reports nothing');
    assert.equal(H.answers.length, 1);
  });

  // Every Telegram await is a window a retirement can land in. Whatever the
  // suspended call was about to show, it must not leave the user an actionable
  // or successful-looking card for a question that is already closed.
  function gatedHandlers({ gate, gateWhen }) {
    const delivered = [];
    const edits = [];
    const sends = [];
    const calls = [];   // every Telegram mutation, in completion order
    const h = createQuestionHandlers({
      questions: H.store, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async (_b, method, params) => {
        if (method === 'editMessageText') edits.push({ id: params.message_id, text: params.text });
        if (method === 'sendMessage') sends.push(params);
        if (gateWhen(method, params)) {
          await gate.promise;
          calls.push({ method, params });
          return method === 'sendMessage' ? { message_id: 4242 } : { ok: true };
        }
        calls.push({ method, params });
        return method === 'sendMessage' ? { message_id: 900 + sends.length } : { ok: true };
      },
    });
    return { h, delivered, edits, sends, calls };
  }

  test('a retirement during the free-text prompt leaves the interruption notice, not an invitation', async () => {
    const gate = deferred();
    const g = gatedHandlers({ gate, gateWhen: (m, p) => m === 'editMessageText' && /Send your answer/.test(p.text || '') });
    await g.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-ui-other', questions: ONE_Q });
    const row = H.store.getOpenForSession('s:1');
    const ctx = cbCtx(`q:${row.id}:${row.callback_token}:other`);
    const tapping = g.h.handleQuestionCallback(ctx);
    await new Promise((r) => setImmediate(r));
    await g.h.retireSession('s:1');
    gate.resolve({ ok: true });
    await tapping;

    assert.equal(H.store.getById(row.id).status, 'cancelled');
    assert.match(g.edits.slice(-1)[0].text, /interrupted/i, `card ends as: ${g.edits.slice(-1)[0].text}`);
    assert.deepEqual(ctx._acks.filter((a) => /Type your answer/.test(a?.text || '')), [],
      'no success ack for a question that is already closed');
    assert.deepEqual(g.delivered, []);
  });

  test('a retirement during a toggle re-render leaves no actionable stale card', async () => {
    const gate = deferred();
    const g = gatedHandlers({ gate, gateWhen: (m) => m === 'editMessageReplyMarkup' });
    await g.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-ui-toggle', questions: MULTI });
    const row = H.store.getOpenForSession('s:1');
    const ctx = cbCtx(`q:${row.id}:${row.callback_token}:opt:0`);
    const tapping = g.h.handleQuestionCallback(ctx);
    await new Promise((r) => setImmediate(r));
    await g.h.retireSession('s:1');
    gate.resolve({ ok: true });
    await tapping;

    assert.equal(H.store.getById(row.id).status, 'cancelled');
    // The blocked keyboard edit lands AFTER the retirement notice, so the
    // closed question becomes tappable again unless the last word is ours.
    const last = g.calls.slice(-1)[0];
    assert.equal(last.method, 'editMessageText', `last mutation was ${last.method}`);
    assert.match(last.params.text, /interrupted/i);
    assert.deepEqual(g.delivered, []);
  });

  test('a retirement during the next-question send corrects the new card and writes nothing', async () => {
    const gate = deferred();
    const g = gatedHandlers({ gate, gateWhen: (m, p) => m === 'sendMessage' && /anything else/.test(p.text || '') });
    await g.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-ui-next', questions: TWO_Q });
    const row = H.store.getOpenForSession('s:1');
    const idsBefore = H.store.getById(row.id).message_ids_json;
    const tapping = g.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:1`));
    await new Promise((r) => setImmediate(r));
    await g.h.retireSession('s:1');
    gate.resolve({ message_id: 4242 });
    await tapping;

    const after = H.store.getById(row.id);
    assert.equal(after.status, 'cancelled');
    assert.equal(after.message_ids_json, idsBefore, 'a cancelled row does not adopt the new card');
    const corrective = g.edits.filter((e) => e.id === 4242 && /interrupted/i.test(e.text));
    assert.equal(corrective.length, 1, `the new card was left as a live question: ${JSON.stringify(g.edits)}`);
    assert.deepEqual(g.delivered, []);
  });

  test('a late free-text prompt after a real answer ends on neutral answered text', async () => {
    // The invitation edit completes after the answer's receipt. Leaving it up
    // invites the user to type into a question that is already finished — and
    // the correction must not try to reconstruct the receipt it overwrote.
    const gate = deferred();
    const g = gatedHandlers({ gate, gateWhen: (m, p) => m === 'editMessageText' && /Send your answer/.test(p.text || '') });
    await g.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-late-other', questions: ONE_Q });
    const row = H.store.getOpenForSession('s:1');
    const inviting = g.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    await new Promise((r) => setImmediate(r));
    await g.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));   // the real answer
    assert.equal(g.delivered.length, 1);
    gate.resolve({ ok: true });
    await inviting;

    assert.equal(H.store.getById(row.id).status, 'answered', 'the winner keeps ownership');
    const last = g.calls.slice(-1)[0];
    assert.equal(last.method, 'editMessageText');
    assert.match(last.params.text, /answered/i, `card ends as: ${last.params.text}`);
    assert.doesNotMatch(last.params.text, /Send your answer/);
    assert.equal(g.delivered.length, 1, 'no second provider write');
  });

  test('a late toggle re-render after a real answer leaves no keyboard', async () => {
    const gate = deferred();
    let gatedOnce = false;
    const g = gatedHandlers({
      gate,
      gateWhen: (m) => {
        if (m !== 'editMessageReplyMarkup' || gatedOnce) return false;
        gatedOnce = true;
        return true;
      },
    });
    await g.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-late-toggle', questions: MULTI });
    const row = H.store.getOpenForSession('s:1');
    const toggling = g.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
    await new Promise((r) => setImmediate(r));
    await g.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:1`));
    await g.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:submit`));
    assert.equal(g.delivered.length, 1);
    gate.resolve({ ok: true });
    await toggling;

    assert.equal(H.store.getById(row.id).status, 'answered');
    const last = g.calls.slice(-1)[0];
    assert.equal(last.method, 'editMessageText', `last mutation was ${last.method}`);
    assert.match(last.params.text, /answered/i);
    assert.equal(g.delivered.length, 1);
  });

  test('an unreadable row status leaves a legitimate terminal card alone', async () => {
    // Without a status there is nothing to correct TO. Guessing would risk
    // overwriting a real answer's card, so the stale caller does nothing.
    let failReadOnce = false;
    const flaky = {
      ...H.store,
      getById: (id) => {
        if (failReadOnce) { failReadOnce = false; throw new Error('read failed'); }
        return H.store.getById(id);
      },
    };
    const gate = deferred();
    const delivered = [];
    const calls = [];
    const h2 = createQuestionHandlers({
      questions: flaky, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async (_b, method, params) => {
        if (method === 'editMessageText' && /Send your answer/.test(params.text || '')) {
          await gate.promise;
          calls.push({ method, params });
          return { ok: true };
        }
        calls.push({ method, params });
        return method === 'sendMessage' ? { message_id: 1 } : { ok: true };
      },
    });
    await h2.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-late-read', questions: ONE_Q });
    const row = flaky.getOpenForSession('s:1');
    const inviting = h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    await new Promise((r) => setImmediate(r));
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
    const callsBeforeRelease = calls.length;
    failReadOnce = true;                     // the stale caller's status read fails
    gate.resolve({ ok: true });
    await inviting;

    assert.equal(calls.length, callsBeforeRelease + 1,
      'only the already-issued edit lands; nothing is written on an unproven status');
    assert.equal(H.store.getById(row.id).status, 'answered', 'and no row mutation');
    assert.equal(delivered.length, 1);
  });

  test('a sweep whose ownership re-read fails changes nothing and can retry', async () => {
    // The sweep claims first, then re-reads to confirm the row is still its
    // to settle. A failed read is not permission to proceed: continuing would
    // overwrite an answered card and report an expiry that never happened.
    let failReadOnce = false;
    const flaky = {
      ...H.store,
      getById: (id) => {
        if (failReadOnce) { failReadOnce = false; throw new Error('read failed'); }
        return H.store.getById(id);
      },
    };
    const delivered = [];
    const events = [];
    const edits = [];
    const h2 = createQuestionHandlers({
      questions: flaky, bot: {}, botName: 'b',
      logEvent: (kind, detail) => events.push({ kind, detail }),
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async (_b, method, params) => {
        if (method === 'editMessageText') edits.push(params.text);
        return method === 'sendMessage' ? { message_id: 1 } : { ok: true };
      },
    });
    await h2.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-sweep-read', questions: SINGLE });
    const stale = flaky.getOpenForSession('s:1');
    await h2.handleQuestionCallback(cbCtx(`q:${stale.id}:${stale.callback_token}:opt:0`));
    assert.equal(delivered.length, 1);
    const receipt = edits.slice(-1)[0];
    const editsAfterAnswer = edits.length;

    failReadOnce = true;
    await h2.expireQuestion(stale);      // the sweep, on its stale snapshot

    assert.equal(edits.length, editsAfterAnswer, 'the answered card is untouched');
    assert.equal(edits.slice(-1)[0], receipt);
    assert.deepEqual(events.filter((e) => e.kind === 'question-expired'), [],
      'a disposition that did not happen is not reported');
    assert.equal(delivered.length, 1);

    // The claim was released, so a later sweep can still evaluate the row —
    // and now correctly finds it settled.
    await h2.expireQuestion(stale);
    assert.equal(edits.length, editsAfterAnswer);
    assert.deepEqual(events.filter((e) => e.kind === 'question-expired'), []);
    assert.equal(delivered.length, 1);
  });

  test('retiring a session terminalizes its open question and scrubs everything', async () => {
    // One operation for every path that retires the process owning a
    // question: the row is closed, the card corrected, and nothing exact is
    // left behind — whatever the caller does with the process afterwards.
    const row = await typeAnswer(H, 's:1', 'tc-retire', TWO_Q, SECRET_ANSWER);
    assert.equal(H.h.liveAnswerCount(), 1);
    const before = H.answers.length;

    await H.h.retireSession('s:1');

    assert.equal(H.answers.length, before, 'a retiring session is never answered');
    assert.equal(H.h.liveContextCount(), 0);
    assert.equal(H.h.liveAnswerCount(), 0);
    const after = H.store.getById(row.id);
    assert.equal(after.status, 'cancelled');
    assert.ok(!after.state_json.includes('hunter2-fake-value'), after.state_json);
    assert.match(H.edits().slice(-1)[0].params.text, /interrupted/i);
  });

  test('retiring a session with no open question is a no-op that still scrubs', async () => {
    await H.h.retireSession('s:none');
    assert.equal(H.h.liveContextCount(), 0);
  });

  test('retirement never throws, and a row it could not close stays blocked', async () => {
    const brokenStore = { ...H.store, resolve: () => { throw new Error('database is locked'); } };
    const delivered = [];
    const h2 = createQuestionHandlers({
      questions: brokenStore, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async () => ({ message_id: 1 }),
    });
    await h2.renderAsk({ sessionKey: 's:5', chatId: '100', toolCallId: 'tc-retire-fail', questions: TWO_Q });
    const row = brokenStore.getOpenForSession('s:5');
    await h2.retireSession('s:5');   // must not throw: the caller is mid-teardown

    assert.equal(h2.liveAnswerCount(), 0, 'nothing exact is retained');
    // The row could not be closed, so the block has to live in memory: a
    // content-free tombstone that still refuses a later delivery.
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
    assert.deepEqual(delivered, [], 'a row that could not be cancelled is not answered either');
  });

  test('boot reconciliation rejects when a marked row cannot be cancelled', async () => {
    // The boot fence can only stop startup if reconciliation reports failure.
    // A row it could not cancel is still pending and would meet replay.
    const row = await typeAnswer(H, 's:1', 'tc-boot-fail', TWO_Q, SECRET_ANSWER);
    const brokenStore = {
      ...H.store,
      resolve: () => { throw new Error('database is locked'); },
    };
    const delivered = [];
    const h2 = createQuestionHandlers({
      questions: brokenStore, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async () => ({ ok: true }),
    });
    await assert.rejects(
      () => h2.reconcileMarkedQuestionsAtBoot([brokenStore.getById(row.id)]),
      /database is locked/,
      'reconciliation must not report success for a row it left pending',
    );
    assert.deepEqual(delivered, [], 'and never answers upstream from a marker');
  });

  test('a callback path still does not throw when the cancel write fails', async () => {
    // Boot propagates; a Telegram callback must not, or the dispatcher would
    // see a thrown error and re-dispatch the user's text as a normal turn.
    const brokenStore = {
      ...H.store,
      resolve: () => { throw new Error('database is locked'); },
    };
    const h2 = createQuestionHandlers({
      questions: brokenStore, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} }, answerQuestion: () => true,
      tg: async () => ({ message_id: 1 }),
    });
    await h2.renderAsk({ sessionKey: 's:2', chatId: '100', toolCallId: 'tc-cb-cancel', questions: TWO_Q });
    const row = brokenStore.getOpenForSession('s:2');
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    h2.discardSession('s:2');                    // the held answer has nowhere to go
    const outcome = await h2.tryConsumeAsAnswer({ sessionKey: 's:2', fromId: 7, text: SECRET_ANSWER });
    assert.equal(outcome.consumed, true);
    assert.equal(h2.liveAnswerCount(), 0);
  });

  test('a row read failure at delivery time scrubs and cancels instead of retaining', async () => {
    // finalize re-reads the row before delivering. That read is I/O like any
    // other: if it fails after a flagged answer was accepted, the exact value
    // is already held and must not be left behind with the row pending.
    let failReads = false;
    const brokenStore = {
      ...H.store,
      getById: (id) => {
        if (failReads) throw new Error('read failed');
        return H.store.getById(id);
      },
    };
    const delivered = [];
    const edits = [];
    const h2 = createQuestionHandlers({
      questions: brokenStore, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async (_b, method, params) => {
        if (method === 'editMessageText') edits.push(params.text);
        return method === 'sendMessage' ? { message_id: 1 } : { ok: true };
      },
    });
    await h2.renderAsk({ sessionKey: 's:3', chatId: '100', toolCallId: 'tc-read', questions: ONE_Q });
    const row = brokenStore.getOpenForSession('s:3');
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    failReads = true;
    const outcome = await h2.tryConsumeAsAnswer({ sessionKey: 's:3', fromId: 7, text: SECRET_ANSWER });

    assert.deepEqual(delivered, [], 'nothing is delivered on a failed read');
    assert.equal(h2.liveAnswerCount(), 0, 'and nothing exact is retained');
    assert.equal(h2.liveContextCount(), 0);
    assert.equal(outcome.consumed, true, 'the typed text stays consumed');
    assert.equal(H.store.getById(row.id).status, 'cancelled');
    assert.match(edits.slice(-1)[0], /interrupted/i);
  });

  test('two taps choosing different final options deliver one answer and one receipt', async () => {
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-two', questions: SINGLE });
    const row = H.store.getOpenForSession('s:1');
    await Promise.all([
      H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`)),
      H.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:1`)),
    ]);
    assert.equal(H.answers.length, 1);
    const receipts = H.edits().filter((e) => /^✓ /.test(e.params.text));
    assert.equal(receipts.length, 1, `the loser posted a receipt too: ${receipts.map((r) => r.params.text)}`);
  });

  test('a write-back throw scrubs the exact questions too, not just held answers', async () => {
    const H2 = harness({ throwAnswer: true });
    try {
      await H2.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-scrub', questions: SECRET_HEADER_Q });
      const row = H2.store.getOpenForSession('s:1');
      await H2.h.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
      const mid = H2.store.getById(row.id);
      await H2.h.handleQuestionCallback(cbCtx(`q:${row.id}:${mid.callback_token}:opt:0`));
      assert.equal(H2.h.liveContextCount(), 0, 'the exact question array is gone');
      assert.equal(H2.store.getById(row.id).status, 'cancelled', 'and the row is safely terminal');
    } finally {
      try { H2.db.close(); fs.rmSync(H2.dir, { recursive: true, force: true }); } catch {}
    }
  });

  test('a state-write failure scrubs, cancels, and still consumes the typed answer', async () => {
    const row = await typeAnswer(H, 's:1', 'tc-write', TWO_Q, 'benign first');
    // Only the write that carries the recorded answer fails, so the failure
    // lands exactly where the exact value is already being held.
    const brokenStore = {
      ...H.store,
      updateState: (id, state, awaitingOther) => {
        if ((state.answers || []).length > 1) throw new Error('disk is full');
        return H.store.updateState(id, state, awaitingOther);
      },
    };
    const h2 = createQuestionHandlers({
      questions: brokenStore, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { H.answers.push({ sk, tc, result }); return true; },
      tg: async () => ({ message_id: 1 }),
    });
    const before = H.answers.length;
    const open = H.store.getById(row.id);
    await h2.handleQuestionCallback(cbCtx(`q:${open.id}:${open.callback_token}:other`));
    const consumed = await h2.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: SECRET_ANSWER });
    assert.equal(consumed.consumed, true, 'the answer must not fall through as a normal turn');
    assert.equal(H.answers.length, before, 'nothing is delivered on a failed write');
    assert.equal(h2.liveAnswerCount(), 0, 'and nothing exact is retained');
  });

  test('a resolve failure after a successful write scrubs but blocks a second delivery', async () => {
    let resolveCalls = 0;
    const brokenStore = {
      ...H.store,
      resolve: (id, status) => {
        resolveCalls += 1;
        if (resolveCalls === 1) throw new Error('resolve failed');
        return H.store.resolve(id, status);
      },
    };
    const delivered = [];
    const h2 = createQuestionHandlers({
      questions: brokenStore, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { delivered.push(result); return true; },
      tg: async () => ({ message_id: 1 }),
    });
    await h2.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-resolve', questions: ONE_Q });
    const row = brokenStore.getOpenForSession('s:1');
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:other`));
    await h2.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: SECRET_ANSWER });
    assert.equal(delivered.length, 1, 'delivered once');
    assert.equal(h2.liveAnswerCount(), 0, 'exact values are scrubbed even though resolve failed');
    // The row is still pending, so a later tap must not deliver a second time.
    const stale = brokenStore.getById(row.id);
    await h2.handleQuestionCallback(cbCtx(`q:${stale.id}:${stale.callback_token}:other`));
    await h2.tryConsumeAsAnswer({ sessionKey: 's:1', fromId: 7, text: SECRET_ANSWER });
    assert.equal(delivered.length, 1, `delivered ${delivered.length} times`);
  });

  test('an undelivered write-back cancels with the notice instead of a success receipt', async () => {
    const H2 = harness({ falsyAnswer: true });
    try {
      const row = await typeAnswer(H2, 's:1', 'tc-false', ONE_Q, SECRET_ANSWER);
      assert.equal(H2.store.getById(row.id).status, 'cancelled', 'a confirmed non-delivery is not success');
      assert.deepEqual(H2.logEvents.filter((e) => e.kind === 'question-answered'), []);
      const lastEdit = H2.edits().slice(-1)[0].params.text;
      assert.match(lastEdit, /interrupted/i, `card still reads: ${lastEdit}`);
      assert.equal(H2.h.liveAnswerCount(), 0);
    } finally {
      try { H2.db.close(); fs.rmSync(H2.dir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('question handler — live context lifecycle', () => {
  let H;
  beforeEach(() => { H = harness(); });
  afterEach(() => { try { H.db.close(); fs.rmSync(H.dir, { recursive: true, force: true }); } catch {} });

  test('a failed issue leaves no live context behind', async () => {
    // renderAsk opens the context before the row exists, so a store that
    // throws on issue would otherwise strand an entry keyed by a tool call
    // that never got a row — nothing terminal can ever reach it again.
    const broken = { ...H.store, issue: () => { throw new Error('store is down'); } };
    const h = createQuestionHandlers({
      questions: broken, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: (sk, tc, result) => { H.answers.push({ sk, tc, result }); return true; },
      tg: async () => ({ message_id: 1 }),
    });
    await h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-broken', questions: SINGLE });
    assert.equal(H.answers.length, 1, 'the agent is still unblocked');
    assert.equal(h.liveContextCount(), 0, 'and nothing is left holding that tool call');
  });

  test('an ownership tombstone belongs to its session', async () => {
    // A delivered answer whose bookkeeping failed leaves a content-free
    // tombstone so the still-pending row cannot be answered twice. It must
    // carry the session, or retiring that session could never drop it.
    let resolveCalls = 0;
    const brokenStore = {
      ...H.store,
      resolve: (id, status) => {
        resolveCalls += 1;
        if (resolveCalls === 1) throw new Error('resolve failed');
        return H.store.resolve(id, status);
      },
    };
    const h2 = createQuestionHandlers({
      questions: brokenStore, bot: {}, botName: 'b', logEvent: () => {},
      logger: { error: () => {} }, answerQuestion: () => true,
      tg: async () => ({ message_id: 1 }),
    });
    await h2.renderAsk({ sessionKey: 's:9', chatId: '100', toolCallId: 'tc-claim', questions: SINGLE });
    const row = brokenStore.getOpenForSession('s:9');
    await h2.handleQuestionCallback(cbCtx(`q:${row.id}:${row.callback_token}:opt:0`));
    assert.equal(h2.liveContextCount(), 1, 'the tombstone blocks a second delivery');
    assert.equal(h2.liveAnswerCount(), 0, 'and holds nothing exact');
    h2.discardSession('s:9');
    assert.equal(h2.liveContextCount(), 0, 'which the session teardown can reach');
  });

  test('the sweep landing on a row it does not own changes nothing', async () => {
    // The 30s sweep works from a snapshot and can reach a row another path
    // already settled. It must not deliver again, not report a failure, and
    // not clean up state it never owned.
    await H.h.renderAsk({ sessionKey: 's:1', chatId: '100', toolCallId: 'tc-sweep', questions: SINGLE });
    const stale = H.store.getOpenForSession('s:1');
    await H.h.handleQuestionCallback(cbCtx(`q:${stale.id}:${stale.callback_token}:opt:0`));
    assert.equal(H.answers.length, 1);
    // Another prompt is mid-flight in a different session, holding an answer.
    const other = await typeAnswer(H, 's:2', 'tc-other', TWO_Q, SECRET_ANSWER);
    assert.equal(H.h.liveAnswerCount(), 1);

    await H.h.expireQuestion(stale);               // the sweep, on its stale snapshot

    assert.equal(H.answers.length, 1, 'no second delivery for the settled row');
    assert.deepEqual(H.logEvents.filter((e) => e.kind === 'question-answer-writeback-failed'), []);
    assert.equal(H.h.liveAnswerCount(), 1, 'the in-flight prompt is untouched');
    assert.equal(H.store.getById(other.id).status, 'pending');
  });

  test('one thrown write-back reports exactly one failure event', async () => {
    const H2 = harness({ throwAnswer: true });
    try {
      await typeAnswer(H2, 's:1', 'tc-once', ONE_Q, SECRET_ANSWER);
      const failures = H2.logEvents.filter((e) => e.kind === 'question-answer-writeback-failed');
      assert.equal(failures.length, 1, `emitted ${failures.length} times`);
    } finally {
      try { H2.db.close(); fs.rmSync(H2.dir, { recursive: true, force: true }); } catch {}
    }
  });
});

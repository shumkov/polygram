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

function harness() {
  const { db, dir } = migratedDb();
  let nextMsgId = 1000;
  const tgCalls = [];
  const answers = [];      // [sessionKey, toolCallId, result]
  const store = createQuestionStore(db);
  const h = createQuestionHandlers({
    questions: store,
    bot: {},
    botName: 'b',
    logEvent: () => {},
    answerQuestion: (sk, tc, result) => answers.push({ sk, tc, result }),
    logger: { error: () => {} },
    tg: async (_b, method, params) => {
      tgCalls.push({ method, params });
      if (method === 'sendMessage') return { message_id: ++nextMsgId };
      return { ok: true };
    },
  });
  return { db, dir, store, h, tgCalls, answers, lastSend: () => [...tgCalls].reverse().find((c) => c.method === 'sendMessage') };
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

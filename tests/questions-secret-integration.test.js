/**
 * Integration coverage for the pending-question secret boundary, at the two
 * seams unit tests cannot speak for:
 *
 *   1. Boot ordering in polygram.js itself — a marked row must be reconciled
 *      before anything can act on it. Asserted against the real source, the
 *      way tests/boot-smoke.test.js pins factory wiring order, because the
 *      ordering IS the guarantee and a mock cannot express it.
 *   2. The Orchestra bridge boundary — the answer is followed through the real
 *      CliProcess.writeQuestionAnswer into the message that reaches the bridge,
 *      rather than stopping at a stubbed answerQuestion.
 *
 * Run: node --test tests/questions-secret-integration.test.js   (FAKE secrets only)
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { CliProcess } = require('@shumkov/orchestra');

const { createQuestionStore } = require('../lib/questions/store');
const { createQuestionHandlers } = require('../lib/handlers/questions');

const POLYGRAM_SRC = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
const SECRET_ANSWER = 'password: hunter2-fake-value';

describe('boot ordering — the reconciliation barrier', () => {
  const at = (needle) => {
    const index = POLYGRAM_SRC.indexOf(needle);
    assert.notEqual(index, -1, `boot marker missing from polygram.js: ${needle}`);
    return index;
  };

  test('marked rows are reconciled before anything can act on them', () => {
    const barrier = at('reconcileMarkedQuestionsAtBoot(');
    // Everything that could answer, replay, redeliver or admit traffic for a
    // leftover row has to come after the barrier.
    for (const later of [
      "logEvent('compact-replay'",                 // boot replay of interrupted work
      'const pollPromise = pollBot(bot)',          // inbound polling
      "logEvent('polygram-admission-open'",        // inbound admission
    ]) {
      assert.ok(barrier < at(later),
        `the barrier must precede ${later} (barrier ${barrier}, marker ${at(later)})`);
    }
  });

  test('the barrier is awaited, not fired and forgotten', () => {
    assert.match(POLYGRAM_SRC, /await questionHandlers\.reconcileMarkedQuestionsAtBoot\(/);
  });

  test('the barrier runs after the store and handlers exist', () => {
    assert.ok(at('const questionStore = createQuestionStore(') < at('reconcileMarkedQuestionsAtBoot('));
    assert.ok(at('questionHandlers = createQuestionHandlers(') < at('reconcileMarkedQuestionsAtBoot('));
  });

  test('a failed reconciliation keeps admission closed rather than continuing', () => {
    // A fence that logs and carries on is not a fence: the rows it could not
    // cancel would then meet replay and inbound traffic.
    const barrier = at('reconcileMarkedQuestionsAtBoot(');
    const tail = POLYGRAM_SRC.slice(barrier, barrier + 400);
    const guard = /catch\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/.exec(tail);
    assert.ok(guard, 'the barrier is guarded, so the guard is what must not swallow');
    assert.match(guard[1], /throw|process\.exit/,
      'a failure has to stop startup, not just be reported');
  });
});

describe('composition — the retirement hook is wired where processes are retired', () => {
  const at = (needle) => {
    const index = POLYGRAM_SRC.indexOf(needle);
    assert.notEqual(index, -1, `composition marker missing from polygram.js: ${needle}`);
    return index;
  };
  // The block a construction call spans, so an assertion cannot pass on some
  // unrelated occurrence elsewhere in the file.
  const constructionBlock = (needle) => {
    const start = at(needle);
    return POLYGRAM_SRC.slice(start, POLYGRAM_SRC.indexOf('});', start) + 3);
  };

  test('the auto-recover reset retires the question session, not a bare discard', () => {
    const start = at("if (cls.autoRecover === 'reset_session') {");
    const block = POLYGRAM_SRC.slice(start, start + 700);
    assert.match(block, /retireSession\(/, 'auto-recover must use the shared retirement');
    assert.doesNotMatch(block, /discardSession\(/, 'a bare discard leaves the row open');
    // Terminalization is synchronous inside retireSession; the reset must not
    // wait on the card edit that follows it.
    assert.doesNotMatch(block, /await\s+questionHandlers\?\.retireSession/,
      'the reset must not depend on Telegram latency');
  });

  test('the rewind executor is constructed with the retirement hook', () => {
    assert.match(constructionBlock('createRewindExecutor({'), /retireQuestionSession/);
  });

  test('the abort handler is constructed with the retirement hook', () => {
    assert.match(constructionBlock('createHandleAbort({'), /retireQuestionSession/);
  });

  test('no production callsite disposes without terminalizing the row', () => {
    assert.doesNotMatch(POLYGRAM_SRC, /questionHandlers\??\.discardSession\(/,
      'discardSession scrubs memory but leaves the durable row open');
  });
});

describe('shutdown — one bad row cannot strand the rest', () => {
  const at = (needle) => {
    const index = POLYGRAM_SRC.indexOf(needle);
    assert.notEqual(index, -1, `shutdown marker missing from polygram.js: ${needle}`);
    return index;
  };

  test('row disposition is isolated and the live contexts are always dropped', () => {
    const block = POLYGRAM_SRC.slice(at('const openQuestions = questionStore.listOpen'), at('shutdown-questions-cancelled') + 600);
    // Each row is disposed inside its own guard...
    assert.match(block, /for \(const row of openQuestions\)[\s\S]{0,400}?try \{/,
      'per-row disposition must be guarded');
    // ...and the global drop runs whatever happened to any of them.
    assert.match(block, /finally\s*\{[\s\S]{0,200}?discardAll\(\)/,
      'discardAll must run in a finally');
  });
});

describe('bridge boundary — the exact answer reaches the wire', () => {
  test('a held answer travels through CliProcess into the question_answer message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsi-'));
    const db = new Database(path.join(dir, 't.db'));
    const migDir = path.join(__dirname, '..', 'migrations');
    for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
      db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }
    const written = [];
    try {
      // A real CliProcess with its bridge socket replaced by a recorder: the
      // answer still travels through Orchestra's own writeQuestionAnswer.
      const proc = new CliProcess({
        botName: 'b', sessionKey: '100:1', label: 't',
        tmuxRunner: { spawn: async () => {}, killSession: async () => {}, sendControl: async () => {}, captureWide: async () => '' },
        toolDispatcher: async () => ({ ok: true }),
        claudeBin: '/usr/bin/echo',
        logger: { error() {}, warn() {}, info() {}, debug() {}, log() {} },
      });
      proc.bridgeServer = { writeMessage: (obj) => written.push(obj) };

      const store = createQuestionStore(db);
      const handlers = createQuestionHandlers({
        questions: store, bot: {}, botName: 'b', logEvent: () => {},
        logger: { error() {} },
        tg: async (_b, method) => (method === 'sendMessage' ? { message_id: 1 } : { ok: true }),
        // The seam under test: no stub in between, the handler hands the
        // answer to the process the way pm.answerQuestion does.
        answerQuestion: (_sessionKey, toolCallId, result) => proc.writeQuestionAnswer(toolCallId, result),
      });

      // Two questions, so the row is still PENDING when the durable copy is
      // inspected — the terminal mask would otherwise hide the whole window.
      await handlers.renderAsk({
        sessionKey: '100:1', chatId: '100', toolCallId: 'tc-bridge',
        questions: [
          { header: 'Creds', question: 'staging password?', options: [{ label: 'skip' }] },
          { header: 'Next', question: 'anything else?', options: [{ label: 'no' }] },
        ],
      });
      const row = store.getOpenForSession('100:1');
      const tap = (action, token) => handlers.handleQuestionCallback({
        callbackQuery: { data: `q:${row.id}:${token}:${action}` },
        from: { id: 7 },
        answerCallbackQuery: async () => {},
      });
      await tap('other', row.callback_token);
      await handlers.tryConsumeAsAnswer({ sessionKey: '100:1', fromId: 7, text: SECRET_ANSWER });

      const pending = store.getById(row.id);
      assert.equal(pending.status, 'pending', 'still mid-prompt');
      assert.ok(!pending.state_json.includes('hunter2-fake-value'),
        `the pending row kept the answer: ${pending.state_json}`);

      await tap('opt:0', pending.callback_token);

      const answer = written.find((m) => m.kind === 'question_answer');
      assert.ok(answer, `no question_answer written: ${JSON.stringify(written)}`);
      assert.equal(answer.tool_call_id, 'tc-bridge');
      assert.deepEqual(answer.result.answers, [
        { header: 'Creds', selected: [], other: SECRET_ANSWER },
        { header: 'Next', selected: ['no'] },
      ]);
      assert.equal(handlers.liveAnswerCount(), 0);
    } finally {
      try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  });
});

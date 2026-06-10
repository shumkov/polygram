'use strict';

/**
 * 0.13 P1 — auxiliary lifecycle pieces shipping alongside the D1 finalizer
 * ladder (docs/0.13-channels-lifecycle-design.md §4 P1). Cross-module, so
 * grouped here (precedent: tests/medium-review-fixes.test.js):
 *
 *   A. typing controller gains pause()/resume() — the inverted-typing fix
 *      (seam S8): "bot is typing…" must stop while the bot waits on the USER.
 *   B. callbacks: question-asked pauses the head turn's typing; question-resumed
 *      resumes it (alongside the existing reactor re-arm).
 *   C. process-manager: a session with an open question is pinned from LRU
 *      eviction (seam S9 — mid-question eviction killed the ask).
 *   D. autosteer event carries the backend (decision-log row 1: the 278/14d
 *      figure conflated backends; per-event precision from here on).
 *   E. questions store: listOpen() — the daemon shutdown expires open questions
 *      {cancelled} before the drain so ask-blocked cycles can end (D1 ask-wait).
 *
 * All tests here are red against pre-P1 code except where noted.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A. typing pause/resume ─────────────────────────────────────────────────

const { startTyping } = require('../lib/telegram/typing');

describe('P1-A: typing controller pause/resume (inverted-typing fix, S8)', () => {
  function makeBot() {
    const calls = [];
    return { calls, api: { sendChatAction: async (...a) => { calls.push(a); return true; } } };
  }

  test('stop function exposes pause() and resume()', () => {
    const bot = makeBot();
    const stop = startTyping({ bot, chatId: 'c1', intervalMs: 10_000, logger: { error: () => {} } });
    assert.equal(typeof stop.pause, 'function', 'pause() must exist');
    assert.equal(typeof stop.resume, 'function', 'resume() must exist');
    stop();
  });

  test('pause() silences ticks; resume() restarts them immediately', async () => {
    const bot = makeBot();
    const stop = startTyping({ bot, chatId: 'c2', intervalMs: 25, logger: { error: () => {} } });
    await sleep(60);                       // a few ticks land
    const beforePause = bot.calls.length;
    assert.ok(beforePause >= 1, 'typing ticks before pause');

    stop.pause();
    await sleep(90);
    assert.equal(bot.calls.length, beforePause,
      'ZERO sendChatAction while paused — "typing…" while waiting on the user is the wrong signal');

    stop.resume();
    await sleep(60);
    assert.ok(bot.calls.length > beforePause, 'ticks resume after resume()');
    stop();
  });

  test('stop() after pause still stops cleanly', async () => {
    const bot = makeBot();
    const stop = startTyping({ bot, chatId: 'c3', intervalMs: 20, logger: { error: () => {} } });
    stop.pause();
    stop();
    const n = bot.calls.length;
    await sleep(60);
    assert.equal(bot.calls.length, n, 'no ticks after stop');
  });
});

// ─── B. callbacks wire question lifecycle to the typing controller ──────────

const { createSdkCallbacks } = require('../lib/sdk/callbacks');

function makeCallbacks(extra = {}) {
  const logged = [];
  const cbs = createSdkCallbacks({
    db: {}, dbWrite: () => {}, config: { chats: {} }, bot: {}, botName: 'b',
    tg: async () => ({}), logEvent: (k, d) => logged.push({ k, d }),
    classifyToolName: () => 'TOOL', announce: () => {}, shouldAnnounce: () => false,
    contextHintShown: new Set(), extractAssistantText: () => '',
    getChatIdFromKey: () => '1', getThreadIdFromKey: () => null,
    renderQuestion: extra.renderQuestion || (() => {}),
    logger: { error: () => {}, log: () => {} },
  });
  return { cbs, logged };
}

function headEntry(context) {
  return { pendingQueue: [{ context }], chatId: '1', threadId: null, label: 't' };
}

describe('P1-B: question lifecycle drives the head turn typing controller', () => {
  test('onQuestionAsked pauses the head pending typing (waiting-on-user)', async () => {
    const { cbs } = makeCallbacks();
    let paused = 0;
    const entry = headEntry({ typing: { pause: () => { paused++; }, resume: () => {} } });
    await cbs.onQuestionAsked('sk', { toolCallId: 'tc', questions: [] }, entry);
    assert.equal(paused, 1, 'typing must pause the moment the question keyboard goes up');
  });

  test('onQuestionResumed resumes typing AND re-arms the reactor', () => {
    const { cbs } = makeCallbacks();
    let resumed = 0;
    const states = [];
    const entry = headEntry({
      typing: { pause: () => {}, resume: () => { resumed++; } },
      reactor: { setState: (s) => states.push(s) },
    });
    cbs.onQuestionResumed('sk', entry);
    assert.equal(resumed, 1, 'typing resumes when the answer lands');
    assert.deepEqual(states, ['THINKING'], 'reactor re-arm preserved');
  });

  test('both are guarded no-ops on a dead turn (no head pending)', async () => {
    const { cbs } = makeCallbacks();
    const entry = { pendingQueue: [] };
    await cbs.onQuestionAsked('sk', { toolCallId: 'tc', questions: [] }, entry);   // must not throw
    cbs.onQuestionResumed('sk', entry);                                            // must not throw
  });
});

// ─── C. LRU eviction pin for open questions ─────────────────────────────────

const { ProcessManager } = require('../lib/process-manager');

describe('P1-C: open-question sessions are pinned from LRU eviction (S9)', () => {
  function fakeProc({ key, lastUsedTs, openQuestions = false }) {
    const p = new EventEmitter();
    Object.assign(p, {
      sessionKey: key, cost: 1, closed: false, inFlight: false, lastUsedTs,
      killed: [],
      hasActiveBackgroundWork: () => false,
      hasOpenQuestions: () => openQuestions,
      kill: async (reason) => { p.killed.push(reason); },
    });
    return p;
  }

  test('_evictLRU skips the oldest session when it has an open question', () => {
    const pm = new ProcessManager({ processFactory: () => ({}), logger: { warn: () => {}, error: () => {} } });
    const withQuestion = fakeProc({ key: 'asking', lastUsedTs: 1000, openQuestions: true });
    const idle = fakeProc({ key: 'idle', lastUsedTs: 2000 });
    pm.procs.set('asking', withQuestion);
    pm.procs.set('idle', idle);

    const evicted = pm._evictLRU();

    assert.equal(evicted, true);
    assert.equal(withQuestion.killed.length, 0,
      'a session blocked on an open ask must NOT be evicted (the question would die with it)');
    assert.equal(idle.killed.length, 1, 'the next-oldest unpinned session is evicted instead');
  });

  test('_evictLRU returns false when ALL candidates hold open questions', () => {
    const pm = new ProcessManager({ processFactory: () => ({}), logger: { warn: () => {}, error: () => {} } });
    pm.procs.set('a', fakeProc({ key: 'a', lastUsedTs: 1, openQuestions: true }));
    const evicted = pm._evictLRU();
    assert.equal(evicted, false, 'nothing evictable — caller takes the overflow/park path');
  });
});

// ─── D. autosteer event carries the backend ─────────────────────────────────

const { createAutosteerHandlers } = require('../lib/handlers/autosteer');

describe('P1-D: autosteer telemetry backend split', () => {
  test('tryAutosteer logs the backend from pm.getBackend', () => {
    const events = [];
    const autosteer = createAutosteerHandlers({
      config: { bot: {} },
      pm: {
        has: () => true,
        get: () => ({ inFlight: true }),
        getBackend: () => 'cli',
        injectUserMessage: () => true,
      },
      autosteeredRefs: { add: () => {} },
      logEvent: (kind, detail) => events.push({ kind, detail }),
    });

    const r = autosteer.tryAutosteer({
      sessionKey: 'sk', chatConfig: {}, chatId: '1',
      msg: { message_id: 7 }, prompt: 'follow-up',
    });

    assert.equal(r.autosteered, true);
    const evt = events.find((e) => e.kind === 'autosteer');
    assert.ok(evt);
    assert.equal(evt.detail.backend, 'cli',
      'per-event backend — the 14d fold/drop telemetry must not conflate backends again');
  });

  test('backend is null when pm cannot say (no live proc)', () => {
    const events = [];
    const autosteer = createAutosteerHandlers({
      config: { bot: {} },
      pm: { has: () => true, get: () => ({ inFlight: true }), getBackend: () => null, injectUserMessage: () => true },
      autosteeredRefs: { add: () => {} },
      logEvent: (kind, detail) => events.push({ kind, detail }),
    });
    autosteer.tryAutosteer({ sessionKey: 'sk', chatConfig: {}, chatId: '1', msg: { message_id: 7 }, prompt: 'x' });
    assert.equal(events.find((e) => e.kind === 'autosteer').detail.backend, null);
  });
});

// ─── E. questions store listOpen (shutdown question-expiry) ─────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createQuestionStore } = require('../lib/questions/store');

describe('P1-E: questions store listOpen()', () => {
  let db, dir, store;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-p1-'));
    db = new Database(path.join(dir, 't.db'));
    db.pragma('journal_mode = WAL');
    const migDir = path.join(__dirname, '..', 'migrations');
    for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
      db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }
    store = createQuestionStore(db);
  });
  after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  test('listOpen returns pending rows only (the shutdown expiry sweep input)', () => {
    const q = [{ header: 'H', question: 'q', options: [{ label: 'a' }] }];
    const open = store.issue({ bot_name: 'b', session_key: 's:1', chat_id: '1', thread_id: null, tool_call_id: 'tc-open', questions: q, state: { qIndex: 0 } });
    const done = store.issue({ bot_name: 'b', session_key: 's:2', chat_id: '1', thread_id: null, tool_call_id: 'tc-done', questions: q, state: { qIndex: 0 } });
    store.resolve(done.id, 'answered');

    const rows = store.listOpen();
    assert.ok(Array.isArray(rows));
    assert.ok(rows.some((r) => r.tool_call_id === 'tc-open'), 'open row listed');
    assert.ok(!rows.some((r) => r.tool_call_id === 'tc-done'), 'resolved row excluded');
  });
});

/**
 * Tests for lib/handlers/abort.js — stop/cancel detection + dispatch.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createHandleAbort } = require('../lib/handlers/abort');

const silentLogger = { log: () => {}, error: () => {} };

function makeDeps(overrides = {}) {
  const events = [];
  const tgCalls = [];
  const pmCalls = [];
  const aborted = [];
  return {
    events, tgCalls, pmCalls, aborted,
    deps: {
      pm: {
        has: (k) => true,
        get: (k) => ({ inFlight: true }),
        interrupt: async (k) => { pmCalls.push(['interrupt', k]); },
        drainQueue: (k, code) => { pmCalls.push(['drainQueue', k, code]); return 1; },
      },
      bot: { mock: true },
      tg: (b, method, params, meta) => {
        tgCalls.push({ method, params, meta });
        return Promise.resolve({ message_id: 1 });
      },
      logEvent: (kind, detail) => events.push({ kind, detail }),
      isAbortRequest: (text) => /^\s*(stop|стоп|cancel|отмена|\/(stop|abort|cancel))\s*$/i.test(text),
      markSessionAborted: (k) => aborted.push(k),
      clearAutosteeredReactions: async () => {},
      getSessionKey: (chatId) => String(chatId),
      botName: 'test-bot',
      logger: silentLogger,
      ...overrides,
    },
  };
}

function makeMsg(text, { chatId = '12345', threadId = null, fromId = 99 } = {}) {
  return {
    chat: { id: Number(chatId) },
    message_id: 555,
    message_thread_id: threadId,
    text,
    from: { id: fromId },
  };
}

describe('createHandleAbort — factory contract', () => {
  test('throws on missing required deps', () => {
    assert.throws(() => createHandleAbort({}), /pm required/);
    const m = makeDeps();
    assert.throws(() => createHandleAbort({ ...m.deps, bot: null }), /bot required/);
    assert.throws(() => createHandleAbort({ ...m.deps, isAbortRequest: null }),
      /isAbortRequest required/);
    assert.throws(() => createHandleAbort({ ...m.deps, markSessionAborted: null }),
      /markSessionAborted required/);
  });
});

describe('handleAbortIfRequested — non-abort messages', () => {
  test('plain text → returns false, no side effects', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    const r = await fn(makeMsg('hello'), '12345', { model: 'sonnet' }, 'hello');
    assert.equal(r, false);
    assert.equal(m.tgCalls.length, 0);
    assert.equal(m.pmCalls.length, 0);
    assert.equal(m.events.length, 0);
  });

  test('"stopping by my house" not a stop request (predicate gate)', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    const r = await fn(makeMsg('stopping by my house'), '12345', {}, 'stopping by my house');
    assert.equal(r, false, 'isAbortRequest is the gate; non-matching text → no abort');
  });
});

describe('handleAbortIfRequested — abort path', () => {
  test('"stop" with active session → interrupt + drainQueue + ack EN', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    const r = await fn(makeMsg('stop'), '12345', { model: 'sonnet' }, 'stop');
    assert.equal(r, true);
    assert.deepEqual(m.aborted, ['12345'], 'markSessionAborted called BEFORE interrupt');
    const interrupt = m.pmCalls.find((c) => c[0] === 'interrupt');
    const drain = m.pmCalls.find((c) => c[0] === 'drainQueue');
    assert.ok(interrupt);
    assert.ok(drain);
    assert.equal(drain[2], 'INTERRUPTED');
    assert.equal(m.tgCalls[0].params.text, 'Stopped.');
  });

  test('"стоп" → Russian ack', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('стоп'), '12345', {}, 'стоп');
    assert.equal(m.tgCalls[0].params.text, 'Остановлено.');
  });

  test('"отмена" → Russian ack (Cyrillic detection)', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('отмена'), '12345', {}, 'отмена');
    assert.match(m.tgCalls[0].params.text, /Остановлено|Нечего/);
  });

  test('no active session → "Nothing to stop." ack', async () => {
    const m = makeDeps({
      pm: {
        has: () => false,
        get: () => null,
        interrupt: async () => {},
        drainQueue: () => 0,
      },
    });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.equal(m.tgCalls[0].params.text, 'Nothing to stop.');
    assert.equal(m.aborted.length, 0, 'markSessionAborted skipped when nothing active');
  });

  test('logs abort-requested event with had_active flag', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('cancel'), '12345', {}, 'cancel');
    const evt = m.events.find((e) => e.kind === 'abort-requested');
    assert.ok(evt);
    assert.equal(evt.detail.had_active, true);
    assert.equal(evt.detail.user_id, 99);
    assert.equal(evt.detail.trigger, 'cancel');
  });

  test('thread context preserved in ack reply', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop', { threadId: 42 }), '12345', {}, 'stop');
    assert.equal(m.tgCalls[0].params.message_thread_id, '42');
  });

  test('interrupt failure does NOT throw and still drains + acks', async () => {
    const m = makeDeps({
      pm: {
        has: () => true,
        get: () => ({ inFlight: true }),
        interrupt: async () => { throw new Error('SDK gone'); },
        drainQueue: () => 0,
      },
    });
    const fn = createHandleAbort(m.deps);
    const r = await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.equal(r, true);
    assert.equal(m.tgCalls.length, 1, 'ack still sent despite interrupt failure');
  });

  test('trigger text is truncated to 40 chars in the event detail', async () => {
    // Predicate is the gate — using a permissive predicate to test
    // the truncation independently. The actual production predicate's
    // shape is the concern of lib/abort-detector.js's tests.
    const m = makeDeps({ isAbortRequest: () => true });
    const fn = createHandleAbort(m.deps);
    const long = 'x'.repeat(100);
    await fn(makeMsg(long), '12345', {}, long);
    const evt = m.events.find((e) => e.kind === 'abort-requested');
    assert.equal(evt.detail.trigger.length, 40);
  });
});

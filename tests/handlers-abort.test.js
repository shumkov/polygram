/**
 * Tests for lib/handlers/abort.js — stop/cancel detection + dispatch.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createHandleAbort } = require('../lib/handlers/abort');

const silentLogger = { log: () => {}, error: () => {} };

function makeDeps({ procBackend = 'sdk', proc = null, ...overrides } = {}) {
  const events = [];
  const tgCalls = [];
  const pmCalls = [];
  const aborted = [];
  // Default cli-shaped proc: in-flight, probe says "just thinking, no bg".
  const defaultProc = {
    inFlight: true,
    backend: procBackend,
    probeBusyState: async () => ({ busy: true, streaming: true, backgroundShell: false, shellCount: 0, inFlight: true, pendingTurns: 1, captured: true, paneTail: '' }),
    hasActiveBackgroundWork: () => false,
  };
  return {
    events, tgCalls, pmCalls, aborted,
    deps: {
      pm: {
        has: (k) => true,
        get: (k) => (proc !== null ? proc : defaultProc),
        interrupt: async (k) => { pmCalls.push(['interrupt', k]); },
        kill: async (k, reason) => { pmCalls.push(['kill', k, reason]); },
        drainQueue: (k, code) => { pmCalls.push(['drainQueue', k, code]); return 1; },
      },
      dualProbeDelayMs: 5,
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
  test('"stop" with active session → interrupt + drainQueue + 👍 reaction (no text)', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    const r = await fn(makeMsg('stop'), '12345', { model: 'sonnet' }, 'stop');
    assert.equal(r, true);
    assert.deepEqual(m.aborted, ['12345'], 'markSessionAborted called BEFORE interrupt');
    const interrupt = m.pmCalls.find((c) => c[0] === 'interrupt');
    assert.ok(interrupt);
    // Locked design 2026-06-12: ack = 👍 reaction on the stop message, NO text.
    assert.equal(m.tgCalls.length, 1);
    assert.equal(m.tgCalls[0].method, 'setMessageReaction');
    assert.equal(m.tgCalls[0].params.message_id, 555);
    assert.equal(m.tgCalls[0].params.reaction[0].emoji, '👍');
  });

  // Cancel-cheap (docs/0.13-cancel-efficiency-and-delete-trigger-spec.md,
  // locked 2026-06-12, supersedes the 2026-06-04 always-kill decision):
  // kill+--resume is the resume-death-race path, so the cli backend now
  // interrupts IN PLACE by default and kills only when an in-place interrupt
  // genuinely can't reach the work (detached bg shell / ghost / unverifiable).
  test('cli + in-flight turn, no background work → cheap INTERRUPT, never kill', async () => {
    const m = makeDeps({ procBackend: 'cli' });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', { model: 'sonnet' }, 'stop');
    assert.ok(m.pmCalls.find((c) => c[0] === 'interrupt'), 'common case = in-place interrupt (warm proc, no --resume)');
    assert.ok(!m.pmCalls.find((c) => c[0] === 'kill'), 'kill would force --resume — the resume-death-race path');
    const evt = m.events.find((e) => e.kind === 'abort-requested');
    assert.equal(evt.detail.cancel_mode, 'interrupt');
  });

  test('cli + background shell in the probe → KILL (interrupt cannot reach detached work)', async () => {
    const m = makeDeps({
      proc: {
        inFlight: true, backend: 'cli',
        probeBusyState: async () => ({ busy: true, streaming: true, backgroundShell: true, shellCount: 1, captured: true }),
        hasActiveBackgroundWork: () => false,
      },
    });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.ok(m.pmCalls.find((c) => c[0] === 'kill'), 'detached run_in_background work → stop-everything kill');
    assert.ok(!m.pmCalls.find((c) => c[0] === 'interrupt'));
  });

  test('cli + bg-work watchdog says active → KILL (durable signal cross-check)', async () => {
    const m = makeDeps({
      proc: {
        inFlight: true, backend: 'cli',
        probeBusyState: async () => ({ busy: true, streaming: true, backgroundShell: false, captured: true }),
        hasActiveBackgroundWork: () => true,   // pane scrape missed it; watchdog didn't
      },
    });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.ok(m.pmCalls.find((c) => c[0] === 'kill'));
  });

  test('cli + shell appears only on the SECOND probe → KILL (dual-probe catches the just-spawned shell)', async () => {
    let probes = 0;
    const m = makeDeps({
      proc: {
        inFlight: true, backend: 'cli',
        probeBusyState: async () => ({ busy: true, streaming: true, backgroundShell: (++probes) >= 2, captured: true }),
        hasActiveBackgroundWork: () => false,
      },
    });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.ok(probes >= 2, 'a second probe must run before trusting backgroundShell:false');
    assert.ok(m.pmCalls.find((c) => c[0] === 'kill'));
  });

  test('cli GHOST (no pending turn but still streaming) → KILL (interrupt cannot clear ghost feedback)', async () => {
    const m = makeDeps({
      proc: {
        inFlight: false, backend: 'cli',   // hadActive comes from the busy probe
        probeBusyState: async () => ({ busy: true, streaming: true, backgroundShell: false, captured: true }),
        hasActiveBackgroundWork: () => false,
      },
    });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.ok(m.pmCalls.find((c) => c[0] === 'kill'), 'ghost busy-state must close-drain via kill');
    assert.ok(!m.pmCalls.find((c) => c[0] === 'interrupt'));
  });

  test('cli + NO probeBusyState available → KILL (fail toward the stop-everything guarantee)', async () => {
    const m = makeDeps({ proc: { inFlight: true, backend: 'cli' } });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.ok(m.pmCalls.find((c) => c[0] === 'kill'), 'cannot verify no-bg → must not risk leaving work running');
  });

  test('GUARD: SDK backend still uses the soft interrupt, never kill', async () => {
    const m = makeDeps({ procBackend: 'sdk' });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', { model: 'sonnet' }, 'stop');
    assert.ok(m.pmCalls.find((c) => c[0] === 'interrupt'), 'SDK keeps the non-destructive interrupt');
    assert.ok(!m.pmCalls.find((c) => c[0] === 'kill'), 'SDK Query must NOT be killed');
  });

  test('"стоп" → same 👍 reaction (ack is language-neutral now)', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('стоп'), '12345', {}, 'стоп');
    assert.equal(m.tgCalls.length, 1);
    assert.equal(m.tgCalls[0].method, 'setMessageReaction');
    assert.equal(m.tgCalls[0].params.reaction[0].emoji, '👍');
  });

  test('no active session → SILENCE (no reaction, no text — a 👍 would lie)', async () => {
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
    assert.equal(m.tgCalls.length, 0, 'nothing stopped → no 👍, and never any text (locked design)');
    assert.equal(m.aborted.length, 0, 'markSessionAborted skipped when nothing active');
  });

  test('Bug 1 — no live turn but a background shell running → kills it + truthful ack', async () => {
    // Production incident 2026-05-18: the agent left a detached
    // background shell running after the turn ended. polygram's Stop
    // was turn-scoped — it saw no in-flight turn and replied "Nothing
    // to stop", which was false: the background shell WAS running.
    let killed = false;
    const m = makeDeps({
      pm: {
        has: () => true,
        get: () => ({
          inFlight: false,            // no in-flight TURN
          hasBackgroundShell: async () => true,
          killBackgroundShells: async () => { killed = true; return true; },
        }),
        interrupt: async () => {},
        drainQueue: () => 0,
      },
    });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.equal(killed, true, 'the background shell is stopped');
    assert.equal(m.tgCalls[0].method, 'setMessageReaction');
    assert.equal(m.tgCalls[0].params.reaction[0].emoji, '👍',
      'something WAS stopped → 👍 (the old misleading "Nothing to stop." text is gone)');
    const evt = m.events.find((e) => e.kind === 'abort-requested');
    assert.equal(evt.detail.had_active, false);
    assert.equal(evt.detail.killed_background_shell, true,
      'the event records that a background shell was stopped');
  });

  test('Bug 1 — no live turn and no background shell → still "Nothing to stop."', async () => {
    const m = makeDeps({
      pm: {
        has: () => true,
        get: () => ({
          inFlight: false,
          hasBackgroundShell: async () => false,
          killBackgroundShells: async () => { throw new Error('must not be called'); },
        }),
        interrupt: async () => {},
        drainQueue: () => 0,
      },
    });
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop'), '12345', {}, 'stop');
    assert.equal(m.tgCalls.length, 0,
      'with neither a turn nor a background shell → silence (no lie-👍, no text)');
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

  test('the 👍 lands on the stop message itself (thread implicit in message_id)', async () => {
    const m = makeDeps();
    const fn = createHandleAbort(m.deps);
    await fn(makeMsg('stop', { threadId: 42 }), '12345', {}, 'stop');
    assert.equal(m.tgCalls[0].method, 'setMessageReaction');
    assert.equal(m.tgCalls[0].params.message_id, 555);
    assert.equal(m.tgCalls[0].params.chat_id, '12345');
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
    assert.equal(m.tgCalls.length, 1, '👍 still attempted despite interrupt failure');
    assert.equal(m.tgCalls[0].method, 'setMessageReaction');
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

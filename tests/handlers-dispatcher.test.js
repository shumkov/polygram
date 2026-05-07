/**
 * Tests for lib/handlers/dispatcher.js — the dispatch hot path
 * every inbound message flows through.
 *
 * Surface under test:
 *   - in-flight counter increments + decrements
 *   - queue-depth-warning fires at threshold (and only at threshold)
 *   - terminal status mapping: aborted / replay-pending /
 *     replay-attempted / failed
 *   - replay-failure user reply (rc.55)
 *   - error-reply suppression in shutdown / abort-grace / replay
 *   - auto-resume gating (cooldown + isAutoResumable)
 *   - errorReplyText null-suppression
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher, CONCURRENT_WARN_THRESHOLD_DEFAULT } = require('../lib/handlers/dispatcher');

function nextTick() {
  return new Promise((r) => setImmediate(r));
}

function fixture(overrides = {}) {
  const calls = {
    handle: [],            // [sessionKey, chatId, msg, bot]
    sendToProcess: [],
    tg: [],                // [bot, method, params, meta]
    setInboundStatus: [],
    events: [],
    autoResumeAttempts: [],
    autoResumeClears: [],
    deliverReplies: [],
  };

  let handleResolver;
  const handleMessage = overrides.handleMessage || ((sessionKey, chatId, msg, bot) => {
    calls.handle.push({ sessionKey, chatId, msg, bot });
    return new Promise((resolve, reject) => {
      handleResolver = { resolve, reject };
    });
  });

  const dispatcher = createDispatcher({
    config: { bot: { queueWarnThreshold: overrides.queueWarnThreshold ?? 3 } },
    db: {
      setInboundHandlerStatus: (row) => calls.setInboundStatus.push(row),
    },
    dbWrite: (fn) => { try { fn(); } catch {} },
    tg: async (bot, method, params, meta) => {
      calls.tg.push({ bot, method, params, meta });
      return { ok: true };
    },
    botName: 'testbot',
    logEvent: (kind, detail) => calls.events.push({ kind, detail }),
    handleMessage,
    sendToProcess: async (sk, prompt, ctx) => {
      calls.sendToProcess.push({ sessionKey: sk, prompt, ctx });
      return overrides.sendToProcessResult || { text: 'auto-resume reply text' };
    },
    classifyError: (err) => ({
      kind: overrides.classifyKind || 'unknown',
      userMessage: overrides.userMessage === undefined ? `error: ${err.message}` : overrides.userMessage,
      isTransient: false,
      autoRecover: false,
    }),
    isAutoResumable: () => overrides.isAutoResumable === true,
    abortGrace: {
      isRecent: (sk) => overrides.abortRecent === true,
    },
    autoResumeTracker: {
      isInCooldown: () => overrides.inCooldown === true,
      markAttempt: (sk) => calls.autoResumeAttempts.push(sk),
      clear: (sk) => calls.autoResumeClears.push(sk),
    },
    chunkMarkdownText: (text) => [text],
    deliverReplies: async (args) => {
      calls.deliverReplies.push(args);
    },
    TG_MAX_LEN: 4096,
    getIsShuttingDown: () => overrides.shuttingDown === true,
    logger: { log: () => {}, error: () => {} },
  });

  return { dispatcher, calls, getResolver: () => handleResolver };
}

const baseMsg = { message_id: 1, chat: { id: 100 } };

describe('createDispatcher — in-flight counter', () => {
  test('increments + decrements around handleMessage', async () => {
    const { dispatcher, getResolver } = fixture();
    dispatcher.dispatchHandleMessage('sk1', 100, baseMsg, {});
    await nextTick();
    assert.equal(dispatcher.inFlightHandlers.get('sk1'), 1);
    getResolver().resolve();
    await nextTick(); await nextTick();
    assert.equal(dispatcher.inFlightHandlers.has('sk1'), false);
  });

  test('counter goes to N then back to 0 with N parallel calls', async () => {
    const resolvers = [];
    const handleMessage = () => new Promise((res) => resolvers.push(res));
    const { dispatcher } = fixture({ handleMessage });

    for (let i = 0; i < 5; i++) {
      dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg, message_id: i }, {});
    }
    await nextTick();
    assert.equal(dispatcher.inFlightHandlers.get('sk'), 5);
    for (const r of resolvers) r();
    await nextTick(); await nextTick();
    assert.equal(dispatcher.inFlightHandlers.has('sk'), false);
  });
});

describe('createDispatcher — queue-depth-warning telemetry', () => {
  test('fires once at threshold, not below, not after', async () => {
    const resolvers = [];
    const handleMessage = () => new Promise((r) => resolvers.push(r));
    const { dispatcher, calls } = fixture({ handleMessage, queueWarnThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg, message_id: i }, {});
    }
    await nextTick();
    const warnings = calls.events.filter((e) => e.kind === 'queue-depth-warning');
    assert.equal(warnings.length, 1, 'exactly one warning at the threshold crossing');
    assert.equal(warnings[0].detail.in_flight, 3);
    assert.equal(warnings[0].detail.threshold, 3);
    for (const r of resolvers) r();
    await nextTick(); await nextTick();
  });

  test('honours config-driven threshold; falls back to default on bad values', async () => {
    // Bad config → default threshold (20).
    const resolvers = [];
    const handleMessage = () => new Promise((r) => resolvers.push(r));
    const { dispatcher } = fixture({ handleMessage, queueWarnThreshold: 'not a number' });
    assert.equal(dispatcher.queueWarnThreshold(), CONCURRENT_WARN_THRESHOLD_DEFAULT);
    for (let i = 0; i < 3; i++) {
      dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg, message_id: i }, {});
    }
    for (const r of resolvers) r();
    await nextTick(); await nextTick();
  });
});

describe('createDispatcher — error → terminal status mapping', () => {
  async function runAndFail(err, overrides = {}) {
    const fx = fixture(overrides);
    const p = new Promise((res) => { fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {}); setImmediate(res); });
    await p;
    fx.getResolver().reject(err);
    await nextTick(); await nextTick(); await nextTick();
    return fx;
  }

  test('aborted: status=aborted, no error reply', async () => {
    const { calls } = await runAndFail(new Error('killed'), { abortRecent: true });
    assert.equal(calls.setInboundStatus[0]?.status, 'aborted');
    assert.equal(calls.tg.length, 0);
    assert.ok(calls.events.some((e) => e.kind === 'handler-error' && e.detail.aborted === true));
  });

  test('shutting down + new: status=replay-pending, no error reply', async () => {
    const { calls } = await runAndFail(new Error('killed'), { shuttingDown: true });
    assert.equal(calls.setInboundStatus[0]?.status, 'replay-pending');
    assert.equal(calls.tg.length, 0);
  });

  test('shutting down + replay: status=replay-attempted', async () => {
    const replayMsg = { ...baseMsg, _isReplay: true };
    const fx = fixture({ shuttingDown: true });
    fx.dispatcher.dispatchHandleMessage('sk', 100, replayMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('killed'));
    await nextTick(); await nextTick();
    assert.equal(fx.calls.setInboundStatus[0]?.status, 'replay-attempted');
  });

  test('genuine error: status=failed + user error reply sent', async () => {
    const { calls } = await runAndFail(new Error('boom'), {});
    assert.equal(calls.setInboundStatus[0]?.status, 'failed');
    assert.equal(calls.tg.length, 1);
    assert.equal(calls.tg[0].method, 'sendMessage');
    assert.match(calls.tg[0].params.text, /error: boom/);
  });
});

describe('createDispatcher — replay-failure user reply (rc.55)', () => {
  test('replay msg failing in normal state → friendly retry reply', async () => {
    const replayMsg = { ...baseMsg, _isReplay: true };
    const fx = fixture();
    fx.dispatcher.dispatchHandleMessage('sk', 100, replayMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('boom'));
    await nextTick(); await nextTick();
    const replayReply = fx.calls.tg.find(
      (c) => c.params.text?.includes("interrupted and didn't complete"),
    );
    assert.ok(replayReply, 'replay-failure reply must be sent');
  });

  test('replay msg failing while ABORTED → no replay-failure reply', async () => {
    const replayMsg = { ...baseMsg, _isReplay: true };
    const fx = fixture({ abortRecent: true });
    fx.dispatcher.dispatchHandleMessage('sk', 100, replayMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('boom'));
    await nextTick(); await nextTick();
    assert.equal(fx.calls.tg.length, 0);
  });
});

describe('createDispatcher — auto-resume gating', () => {
  test('resumable + not in cooldown → markAttempt + sendToProcess called', async () => {
    const fx = fixture({ isAutoResumable: true });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('300s no activity'));
    await nextTick(); await nextTick(); await nextTick(); await nextTick();
    assert.deepEqual(fx.calls.autoResumeAttempts, ['sk']);
    assert.equal(fx.calls.sendToProcess.length, 1);
    assert.deepEqual(fx.calls.autoResumeClears, ['sk']);
    assert.ok(fx.calls.events.some((e) => e.kind === 'auto-resume-attempted'));
    assert.ok(fx.calls.events.some((e) => e.kind === 'auto-resume-success'));
  });

  test('resumable + IN cooldown → no resume attempt, fall through to error reply', async () => {
    const fx = fixture({ isAutoResumable: true, inCooldown: true });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('300s no activity'));
    await nextTick(); await nextTick();
    assert.equal(fx.calls.autoResumeAttempts.length, 0);
    assert.equal(fx.calls.sendToProcess.length, 0);
    // Falls through to user error reply.
    assert.equal(fx.calls.tg.length, 1);
  });

  test('non-resumable error → straight to error reply', async () => {
    const fx = fixture({ isAutoResumable: false });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('regular crash'));
    await nextTick(); await nextTick();
    assert.equal(fx.calls.autoResumeAttempts.length, 0);
    assert.equal(fx.calls.tg.length, 1);
  });
});

describe('createDispatcher — errorReplyText null-suppression', () => {
  test('classifyError returns null userMessage → no Telegram send', async () => {
    const fx = fixture({ userMessage: null });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('whatever'));
    await nextTick(); await nextTick();
    assert.equal(fx.calls.tg.length, 0,
      'null userMessage from classifier must suppress the error reply');
  });
});

describe('createDispatcher — happy path', () => {
  test('handleMessage resolves cleanly → no events, no DB writes, no replies', async () => {
    const fx = fixture();
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().resolve('done');
    await nextTick(); await nextTick();
    assert.equal(fx.calls.tg.length, 0);
    assert.equal(fx.calls.setInboundStatus.length, 0);
    assert.equal(fx.calls.events.filter((e) => e.kind === 'handler-error').length, 0);
  });
});

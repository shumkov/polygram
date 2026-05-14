'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { SdkProcess } = require('../lib/process/sdk-process');
const { createProcessFactory } = require('../lib/process/factory');
const { UnsupportedOperationError } = require('../lib/process/process');

// ── Mock underlying SDK pm ──────────────────────────────────────────

function makeMockSdkPm() {
  const procs = new Map();
  const calls = [];
  return {
    procs,
    queryCloseTimeoutMs: 100,
    get(sk) { return procs.get(sk) || null; },
    has(sk) { return procs.has(sk); },
    async getOrSpawn(sk, ctx) {
      calls.push({ method: 'getOrSpawn', sk, ctx });
      const entry = {
        sessionKey: sk, chatId: ctx?.chatId, threadId: ctx?.threadId,
        closed: false, inFlight: false, pendingQueue: [],
        sessionId: 'sess-' + sk,
        query: { close: () => calls.push({ method: 'query.close', sk }) },
        inputController: { close: () => calls.push({ method: 'inputController.close', sk }) },
        iteratePromise: Promise.resolve(),
      };
      procs.set(sk, entry);
      return entry;
    },
    async send(sk, prompt, opts) {
      calls.push({ method: 'send', sk, prompt, opts });
      return { text: 'mock reply', sessionId: 'sess-' + sk, cost: 0, duration: 0, error: null, metrics: {} };
    },
    async interrupt(sk) {
      calls.push({ method: 'interrupt', sk });
      return true;
    },
    async setModel(sk, m) { calls.push({ method: 'setModel', sk, m }); return true; },
    async applyFlagSettings(sk, s) { calls.push({ method: 'applyFlagSettings', sk, s }); return true; },
    async setPermissionMode(sk, m) { calls.push({ method: 'setPermissionMode', sk, m }); return true; },
    async resetSession(sk, opts) { calls.push({ method: 'resetSession', sk, opts }); return { closed: true, drainedPendings: 0 }; },
    drainQueue(sk, code) { calls.push({ method: 'drainQueue', sk, code }); return 0; },
    injectUserMessage(sk, opts) { calls.push({ method: 'injectUserMessage', sk, opts }); return true; },
    steer(sk, text, opts) { calls.push({ method: 'steer', sk, text, opts }); return true; },
    _calls: calls,
  };
}

// ── SdkProcess tests ────────────────────────────────────────────────

describe('SdkProcess — construction', () => {
  test('requires sdkPm', () => {
    assert.throws(() => new SdkProcess({ sessionKey: 'sk' }), /sdkPm required/);
  });

  test('backend = sdk, cost = 1', () => {
    const sdkPm = makeMockSdkPm();
    const p = new SdkProcess({ sessionKey: 'sk', sdkPm });
    assert.equal(p.backend, 'sdk');
    assert.equal(p.cost, 1);
  });
});

describe('SdkProcess — state proxies', () => {
  let sdkPm, proc;
  beforeEach(async () => {
    sdkPm = makeMockSdkPm();
    proc = new SdkProcess({ sessionKey: 'sk', sdkPm });
    await proc.start({ chatId: 100 });
  });

  test('closed reflects underlying entry', () => {
    assert.equal(proc.closed, false);
    sdkPm.get('sk').closed = true;
    assert.equal(proc.closed, true);
  });

  test('inFlight reflects underlying entry', () => {
    assert.equal(proc.inFlight, false);
    sdkPm.get('sk').inFlight = true;
    assert.equal(proc.inFlight, true);
  });

  test('pendingQueue reflects underlying entry', () => {
    assert.deepEqual(proc.pendingQueue, []);
    sdkPm.get('sk').pendingQueue.push({ foo: 'bar' });
    assert.equal(proc.pendingQueue.length, 1);
  });

  test('claudeSessionId reflects underlying entry sessionId', () => {
    assert.equal(proc.claudeSessionId, 'sess-sk');
  });

  test('closed when no underlying entry exists', () => {
    sdkPm.procs.delete('sk');
    assert.equal(proc.closed, true);
    assert.equal(proc.inFlight, false);
    assert.deepEqual(proc.pendingQueue, []);
    assert.equal(proc.claudeSessionId, null);
  });
});

describe('SdkProcess — method delegation', () => {
  let sdkPm, proc;
  beforeEach(async () => {
    sdkPm = makeMockSdkPm();
    proc = new SdkProcess({ sessionKey: 'sk', sdkPm });
    await proc.start({ chatId: 100 });
  });

  test('send → sdkPm.send(sessionKey, prompt, opts)', async () => {
    const r = await proc.send('hi', { timeoutMs: 999 });
    assert.equal(r.text, 'mock reply');
    const call = sdkPm._calls.find((c) => c.method === 'send');
    assert.equal(call.sk, 'sk');
    assert.equal(call.prompt, 'hi');
    assert.equal(call.opts.timeoutMs, 999);
  });

  test('interrupt delegates', async () => {
    assert.equal(await proc.interrupt(), true);
    assert.ok(sdkPm._calls.some((c) => c.method === 'interrupt' && c.sk === 'sk'));
  });

  test('setModel delegates', async () => {
    assert.equal(await proc.setModel('opus'), true);
    const call = sdkPm._calls.find((c) => c.method === 'setModel');
    assert.equal(call.m, 'opus');
  });

  test('applyFlagSettings delegates', async () => {
    await proc.applyFlagSettings({ effortLevel: 'high' });
    const call = sdkPm._calls.find((c) => c.method === 'applyFlagSettings');
    assert.deepEqual(call.s, { effortLevel: 'high' });
  });

  test('drainQueue delegates + returns 0 sentinel (hot-path)', () => {
    assert.equal(proc.drainQueue('CUSTOM'), 0);
    const call = sdkPm._calls.find((c) => c.method === 'drainQueue');
    assert.equal(call.code, 'CUSTOM');
  });

  test('injectUserMessage delegates', () => {
    proc.injectUserMessage({ content: 'mid-turn' });
    const call = sdkPm._calls.find((c) => c.method === 'injectUserMessage');
    assert.equal(call.opts.content, 'mid-turn');
  });

  test('steer delegates', () => {
    proc.steer('hint', { shouldQuery: false });
    const call = sdkPm._calls.find((c) => c.method === 'steer');
    assert.equal(call.text, 'hint');
  });

  test('getContextUsage throws UnsupportedOperationError when entry.query has no getContextUsage', async () => {
    try {
      await proc.getContextUsage();
      assert.fail('should throw');
    } catch (err) {
      assert.equal(err.code, 'UNSUPPORTED_OPERATION');
    }
  });

  test('getContextUsage works when entry.query supports it', async () => {
    sdkPm.get('sk').query.getContextUsage = async () => ({ remaining: 9000 });
    const u = await proc.getContextUsage();
    assert.deepEqual(u, { remaining: 9000 });
  });
});

describe('SdkProcess — kill', () => {
  let sdkPm, proc;
  beforeEach(async () => {
    sdkPm = makeMockSdkPm();
    proc = new SdkProcess({ sessionKey: 'sk', sdkPm });
    await proc.start({ chatId: 100 });
  });

  test('kill closes query + inputController + clears procs entry', async () => {
    await proc.kill('test');
    assert.ok(sdkPm._calls.some((c) => c.method === 'query.close'));
    assert.ok(sdkPm._calls.some((c) => c.method === 'inputController.close'));
    assert.equal(sdkPm.has('sk'), false);
  });

  test('kill is safe when no underlying entry', async () => {
    sdkPm.procs.delete('sk');
    // Should not throw
    await proc.kill('test');
  });
});

// ── Factory + event bridge tests ────────────────────────────────────

describe('createProcessFactory', () => {
  test('returns factory + legacyCallbacks shapes', () => {
    const sdkPm = makeMockSdkPm();
    const { factory, legacyCallbacks } = createProcessFactory({
      sdkPmGetter: () => sdkPm,
      config: { chats: {}, bot: {} },
    });
    assert.equal(typeof factory, 'function');
    assert.equal(typeof legacyCallbacks.onInit, 'function');
    assert.equal(typeof legacyCallbacks.onStreamChunk, 'function');
    assert.equal(typeof legacyCallbacks.onResult, 'function');
  });

  test('factory mints SdkProcess instances', () => {
    const sdkPm = makeMockSdkPm();
    const { factory } = createProcessFactory({
      sdkPmGetter: () => sdkPm,
      config: { chats: {}, bot: {} },
    });
    const proc = factory('sk1', { chatId: 100 });
    assert.equal(proc.backend, 'sdk');
    assert.equal(proc.sessionKey, 'sk1');
    assert.equal(proc.chatId, '100');
  });

  test('factory throws if sdkPm not yet wired', () => {
    const { factory } = createProcessFactory({
      sdkPmGetter: () => null,
      config: { chats: {}, bot: {} },
    });
    assert.throws(() => factory('sk', {}), /sdkPm not yet available/);
  });

  test('legacy callback routes event to the right SdkProcess EventEmitter', () => {
    const sdkPm = makeMockSdkPm();
    const { factory, legacyCallbacks } = createProcessFactory({
      sdkPmGetter: () => sdkPm,
      config: { chats: {}, bot: {} },
    });
    const proc = factory('sk1', { chatId: 100 });
    const events = [];
    proc.on('init', (...args) => events.push(['init', ...args]));
    proc.on('stream-chunk', (...args) => events.push(['stream-chunk', ...args]));
    legacyCallbacks.onInit('sk1', { sessionId: 'sess-1' }, { foo: 'bar' });
    legacyCallbacks.onStreamChunk('sk1', 'hello world', { foo: 'bar' });
    assert.equal(events.length, 2);
    assert.equal(events[0][0], 'init');
    assert.equal(events[1][0], 'stream-chunk');
    assert.equal(events[1][1], 'hello world');
  });

  test('legacy callback drops events for unknown sessionKey (no crash)', () => {
    const sdkPm = makeMockSdkPm();
    const { legacyCallbacks } = createProcessFactory({
      sdkPmGetter: () => sdkPm,
      config: { chats: {}, bot: {} },
    });
    // No proc registered for 'sk-unknown' — should NOT throw
    legacyCallbacks.onInit('sk-unknown', {}, {});
    legacyCallbacks.onStreamChunk('sk-unknown', 'text');
  });

  test('proc de-registers from index on close', () => {
    const sdkPm = makeMockSdkPm();
    const { factory, procIndex } = createProcessFactory({
      sdkPmGetter: () => sdkPm,
      config: { chats: {}, bot: {} },
    });
    const proc = factory('sk1', { chatId: 100 });
    assert.equal(procIndex.has('sk1'), true);
    proc.emit('close', { reason: 'test' });
    assert.equal(procIndex.has('sk1'), false);
  });
});

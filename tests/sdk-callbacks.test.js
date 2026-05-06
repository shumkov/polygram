/**
 * Tests for lib/sdk/callbacks.js — the SDK lifecycle callback factory.
 *
 * Each callback is a thin glue layer that:
 *   - persists state via dbWrite + logEvent
 *   - heartbeats reactor + streamer state machines
 *   - posts user-visible messages via tg(...)
 *
 * Tests inject mock deps and assert the side effects.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSdkCallbacks } = require('../lib/sdk/callbacks');

const silentLogger = { log: () => {}, error: () => {} };

function baseDeps(overrides = {}) {
  const events = [];
  const upsertCalls = [];
  const tgCalls = [];
  const announceCalls = [];

  return {
    events,
    upsertCalls,
    tgCalls,
    announceCalls,
    deps: {
      db: {
        upsertSession(args) { upsertCalls.push(args); },
      },
      dbWrite: (fn /* , label */) => fn(),
      config: {
        chats: { '12345': { agent: 'finance', cwd: '/u', model: 'sonnet', effort: 'high' } },
        bot: {},
      },
      bot: { mock: true },
      botName: 'test-bot',
      tg: (b, method, params, meta) => {
        tgCalls.push({ method, params, meta });
        return Promise.resolve({ message_id: 1 });
      },
      logEvent: (kind, detail) => events.push({ kind, detail }),
      classifyToolName: (name) => `state-for-${name}`,
      announce: (args) => announceCalls.push(args),
      shouldAnnounce: () => true,
      contextHintShown: new Set(),
      extractAssistantText: (msg) => msg?.message?.content?.[0]?.text || '',
      getChatIdFromKey: (k) => k.split(':')[0],
      getThreadIdFromKey: (k) => k.includes(':') ? k.split(':')[1] : null,
      logger: silentLogger,
      ...overrides,
    },
  };
}

describe('createSdkCallbacks — factory contract', () => {
  test('returns the 6 callbacks', () => {
    const { deps } = baseDeps();
    const cbs = createSdkCallbacks(deps);
    for (const k of [
      'onInit', 'onClose', 'onStreamChunk', 'onToolUse',
      'onAssistantMessageStart', 'onAutonomousAssistantMessage',
      'onCompactBoundary',
    ]) {
      assert.equal(typeof cbs[k], 'function', `${k} should be a function`);
    }
  });
});

describe('onInit — upserts session row', () => {
  test('persists session_id + chat config via db.upsertSession', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onInit('12345:24', { session_id: 'sess-abc' }, {
      chatId: '12345', threadId: '24', label: 't',
    });
    assert.equal(h.upsertCalls.length, 1);
    assert.deepEqual(h.upsertCalls[0], {
      session_key: '12345:24',
      chat_id: '12345',
      thread_id: '24',
      claude_session_id: 'sess-abc',
      agent: 'finance',
      cwd: '/u',
      model: 'sonnet',
      effort: 'high',
    });
  });
});

describe('onClose — logs process-close event', () => {
  test('emits process-close event with code', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onClose('12345', 137, { chatId: '12345', label: 't' });
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].kind, 'process-close');
    assert.equal(h.events[0].detail.code, 137);
  });
});

describe('onStreamChunk — routes to head pending streamer + heartbeats reactor', () => {
  test('forwards partial to streamer.onChunk', () => {
    const h = baseDeps();
    const onChunkCalls = [];
    const head = {
      context: {
        streamer: { onChunk: (t) => { onChunkCalls.push(t); return Promise.resolve(); } },
        reactor: { heartbeat: () => {} },
      },
    };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onStreamChunk('k', 'hello world', { pendingQueue: [head] });
    assert.deepEqual(onChunkCalls, ['hello world']);
  });

  test('heartbeats reactor when present', () => {
    const h = baseDeps();
    let beats = 0;
    const head = {
      context: {
        streamer: { onChunk: () => Promise.resolve() },
        reactor: { heartbeat: () => beats++ },
      },
    };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onStreamChunk('k', 'x', { pendingQueue: [head] });
    assert.equal(beats, 1);
  });

  test('no head pending → no-op (does not throw)', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    assert.doesNotThrow(() => cbs.onStreamChunk('k', 'x', { pendingQueue: [] }));
  });
});

describe('onToolUse — classifies + maybe announces subagent', () => {
  test('sets reactor state from classifyToolName', () => {
    const h = baseDeps();
    const states = [];
    const head = { context: { reactor: { setState: (s) => states.push(s) } } };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onToolUse('k', 'Bash', { pendingQueue: [head], chatId: '12345' });
    assert.deepEqual(states, ['state-for-Bash']);
  });

  test('Task tool announces subagent when not opted out', () => {
    const h = baseDeps();
    const head = { context: { reactor: { setState: () => {} }, threadId: '24' } };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onToolUse('k', 'Task', { pendingQueue: [head], chatId: '12345', label: 't' });
    assert.equal(h.announceCalls.length, 1);
    assert.match(h.announceCalls[0].text, /subagent/);
  });

  test('announceSubagents=false in chat config silences it', () => {
    const h = baseDeps({
      config: {
        chats: { '12345': { announceSubagents: false } },
        bot: {},
      },
    });
    const head = { context: { reactor: { setState: () => {} } } };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onToolUse('k', 'Task', { pendingQueue: [head], chatId: '12345', label: 't' });
    assert.equal(h.announceCalls.length, 0);
  });

  test('non-Task tools never trigger announce', () => {
    const h = baseDeps();
    const head = { context: { reactor: { setState: () => {} } } };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onToolUse('k', 'Bash', { pendingQueue: [head], chatId: '12345', label: 't' });
    assert.equal(h.announceCalls.length, 0);
  });
});

describe('onAssistantMessageStart — fresh bubble + heartbeat', () => {
  test('calls streamer.forceNewMessage', () => {
    const h = baseDeps();
    let forced = 0;
    const head = {
      context: {
        streamer: { forceNewMessage: () => forced++ },
        reactor: { heartbeat: () => {} },
      },
    };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAssistantMessageStart('k', { pendingQueue: [head] });
    assert.equal(forced, 1);
  });
});

describe('onAutonomousAssistantMessage — bot-initiated wakeup', () => {
  test('sends extracted text via tg', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345:24', {
      message: { content: [{ type: 'text', text: 'Wake-up reminder' }] },
    });
    assert.equal(h.tgCalls.length, 1);
    assert.equal(h.tgCalls[0].params.text, 'Wake-up reminder');
    assert.equal(h.tgCalls[0].params.chat_id, '12345');
    assert.equal(h.tgCalls[0].params.message_thread_id, 24);
  });

  test('emits autonomous-wakeup-message event', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].kind, 'autonomous-wakeup-message');
    assert.equal(h.events[0].detail.text_len, 2);
  });

  test('empty text is dropped silently', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', { message: { content: [] } });
    assert.equal(h.tgCalls.length, 0);
    assert.equal(h.events.length, 0);
  });

  test('null bot drops message + logs error (does not throw)', () => {
    const h = baseDeps({ bot: null });
    const cbs = createSdkCallbacks(h.deps);
    assert.doesNotThrow(() => cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'orphaned' }] },
    }));
    assert.equal(h.tgCalls.length, 0);
  });
});

describe('onCompactBoundary — surface compaction + clear hint flag', () => {
  test('clears contextHintShown for the session', async () => {
    const set = new Set(['key-A']);
    const { deps } = baseDeps({ contextHintShown: set });
    const cbs = createSdkCallbacks(deps);
    await cbs.onCompactBoundary('key-A', { compact_metadata: { trigger: 'auto' } },
      { chatId: '12345', label: 't' });
    assert.equal(set.has('key-A'), false);
  });

  test('manual trigger emits ✅ + ratio + duration', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onCompactBoundary('k', {
      compact_metadata: {
        trigger: 'manual',
        pre_tokens: 50_000, post_tokens: 12_000, duration_ms: 1500,
      },
    }, { chatId: '12345', label: 't' });
    assert.equal(h.tgCalls.length, 1);
    assert.match(h.tgCalls[0].params.text, /✅ Compacted/);
    assert.match(h.tgCalls[0].params.text, /50\.0k → 12\.0k/);
    assert.match(h.tgCalls[0].params.text, /1\.5s/);
    assert.match(h.tgCalls[0].params.text, /Ready for your next message/);
  });

  test('auto trigger emits 💭 + Continuing…', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onCompactBoundary('k', {
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 80_000, post_tokens: 30_000, duration_ms: 2200,
      },
    }, { chatId: '12345', label: 't' });
    assert.match(h.tgCalls[0].params.text, /💭 Auto-compacted/);
    assert.match(h.tgCalls[0].params.text, /Continuing…/);
  });

  test('announceCompact=false in chat config silences', async () => {
    const h = baseDeps({
      config: {
        chats: { '12345': { announceCompact: false } },
        bot: {},
      },
    });
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onCompactBoundary('k', { compact_metadata: { trigger: 'manual' } },
      { chatId: '12345', label: 't' });
    assert.equal(h.tgCalls.length, 0);
  });

  test('missing compact_metadata still produces a sane message', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onCompactBoundary('k', {}, { chatId: '12345', label: 't' });
    assert.equal(h.tgCalls.length, 1);
    assert.match(h.tgCalls[0].params.text, /Auto-compacted/);
  });
});

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
  test('returns the expected callbacks (rc.9: now includes the two autosteer extra-turn ones)', () => {
    const { deps } = baseDeps();
    const cbs = createSdkCallbacks(deps);
    for (const k of [
      'onInit', 'onClose', 'onStreamChunk', 'onToolUse',
      'onAssistantMessageStart', 'onAutonomousAssistantMessage',
      'onCompactBoundary',
      // rc.7 + rc.9 additions — tmux backend NEW-TURN autosteer
      // visual bridge:
      'onExtraTurnStarted', 'onExtraTurnReply',
      // rc.11.1 observability — autosteer resolution / match-miss
      // events so post-hoc diagnosis of autosteer regressions is
      // possible without re-running with live capture-pane.
      'onAutosteerResolution', 'onAutosteerMatchMiss',
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

// ─── rc.7 + rc.9: autosteer NEW-TURN extra-turn bridge ────────────────
//
// The scenario being protected here was caught manually by Ivan against
// shumorobot on 2026-05-15: tmux backend FOLD path correctly produces
// one combined reply, but the NEW-TURN path (TUI dequeued the autosteer
// as a fresh user turn because primary turn 1 ended too fast to absorb
// it) left the second turn's reply unwatched, the typing-indicator
// vanished, and the ✍ reaction got cleared by clearAutosteeredReactions
// at primary-turn success. These tests pin the polygram-side bridge:
//   - onExtraTurnStarted re-applies ✍ + starts a 4-second typing
//     sendChatAction loop, tracked per-sessionKey in extraTurnTracker.
//   - onExtraTurnReply sends the second reply with
//     reply_to_message_id=autosteeredMsgId, clears ✍, stops the typing
//     loop.
//   - onClose tears down typing/reaction if the session dies mid-
//     extra-turn (defensive — otherwise the typing loop leaks).

describe('onExtraTurnStarted — autosteer NEW-TURN visual bridge', () => {
  test('re-applies ✍ on autosteered msgId AND fires sendChatAction("typing") immediately', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onExtraTurnStarted('12345:24', { msgId: 658, sessionId: 'sess-abc', backend: 'tmux' });

    const reaction = h.tgCalls.find((c) => c.method === 'setMessageReaction');
    assert.ok(reaction, 'setMessageReaction must be called to re-apply ✍');
    assert.equal(reaction.params.chat_id, '12345');
    assert.equal(reaction.params.message_id, 658);
    assert.deepEqual(reaction.params.reaction, [{ type: 'emoji', emoji: '✍' }]);
    assert.equal(reaction.meta.source, 'extra-turn-started');

    const typing = h.tgCalls.find((c) => c.method === 'sendChatAction');
    assert.ok(typing, 'sendChatAction must fire at least once on extra-turn-started');
    assert.equal(typing.params.chat_id, '12345');
    assert.equal(typing.params.action, 'typing');

    const ev = h.events.find((e) => e.kind === 'extra-turn-started');
    assert.ok(ev, 'extra-turn-started telemetry must be logged');
    assert.equal(ev.detail.msg_id, 658);
    assert.equal(ev.detail.backend, 'tmux');

    // Cleanup: tear down the typing interval so the test runner can exit.
    cbs.onClose('12345:24', 0, { chatId: '12345', label: 't' });
  });

  test('null/missing msgId is a no-op (defensive, never spams Telegram)', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onExtraTurnStarted('12345:24', { sessionId: 'sess-abc' /* no msgId */ });
    assert.equal(h.tgCalls.length, 0);
    assert.equal(h.events.length, 0);
  });
});

describe('onExtraTurnReply — autosteer NEW-TURN delivery + visual teardown', () => {
  test('sends the reply with reply_to_message_id, clears ✍, stops typing loop', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);

    // First start the extra-turn (so we have a typing loop to tear down).
    cbs.onExtraTurnStarted('12345:24', { msgId: 658, sessionId: 'sess-abc' });
    const tgCountAfterStart = h.tgCalls.length;

    // Now fire the reply
    cbs.onExtraTurnReply('12345:24', {
      msgId: 658,
      text: 'Also already done — 4 tracks downloaded.',
      sessionId: 'sess-abc',
      backend: 'tmux',
    });

    // After reply, MUST have: (1) reaction clear, (2) sendMessage with reply_to.
    const post = h.tgCalls.slice(tgCountAfterStart);
    const clear = post.find((c) => c.method === 'setMessageReaction'
      && Array.isArray(c.params.reaction) && c.params.reaction.length === 0);
    assert.ok(clear, 'setMessageReaction(reaction=[]) must fire to clear ✍');
    assert.equal(clear.params.chat_id, '12345');
    assert.equal(clear.params.message_id, 658);

    const reply = post.find((c) => c.method === 'sendMessage');
    assert.ok(reply, 'sendMessage must fire with the extra-turn reply text');
    assert.equal(reply.params.chat_id, '12345');
    assert.equal(reply.params.reply_to_message_id, 658,
      'reply MUST be addressed to the autosteered msgId so it visually replies to msg 658');
    assert.equal(reply.params.text, 'Also already done — 4 tracks downloaded.');
    assert.equal(reply.params.message_thread_id, 24, 'thread_id from sessionKey suffix');
    assert.equal(reply.meta.source, 'extra-turn-reply');

    const ev = h.events.find((e) => e.kind === 'extra-turn-reply');
    assert.ok(ev, 'extra-turn-reply telemetry must be logged');
    assert.equal(ev.detail.msg_id, 658);
  });

  test('reply with empty text still tears down visuals (no leaked typing loop)', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onExtraTurnStarted('12345:24', { msgId: 658 });
    h.tgCalls.length = 0;
    cbs.onExtraTurnReply('12345:24', { msgId: 658, text: '', sessionId: 'sess-abc' });
    // No sendMessage (empty text), but reaction cleanup must still happen.
    const clear = h.tgCalls.find((c) => c.method === 'setMessageReaction'
      && Array.isArray(c.params.reaction) && c.params.reaction.length === 0);
    assert.ok(clear, 'extra-turn-reply with empty text must still clear ✍');
    const sendMsg = h.tgCalls.find((c) => c.method === 'sendMessage');
    assert.equal(sendMsg, undefined, 'must NOT send empty text as a Telegram message');
  });
});

describe('typing-indicator lifecycle — interval cleanup', () => {
  test('onExtraTurnReply stops the sendChatAction interval (no more typing fires after reply)', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onExtraTurnStarted('12345:24', { msgId: 658 });
    // Reply right away — should kill the interval before it fires again
    cbs.onExtraTurnReply('12345:24', {
      msgId: 658, text: 'done', sessionId: 'sess-abc',
    });
    const typingCallsAtReply = h.tgCalls.filter((c) => c.method === 'sendChatAction').length;
    // Wait > 4 seconds (interval period). If the interval wasn't cleared,
    // a new typing fire would land. We use a short delay since the
    // interval is 4s; this is a smoke check, not a perfect race.
    // For a tighter test we'd want fake timers; this is a sanity bound.
    await new Promise((r) => setTimeout(r, 50));
    const typingCallsAfter = h.tgCalls.filter((c) => c.method === 'sendChatAction').length;
    assert.equal(typingCallsAfter, typingCallsAtReply,
      'no additional sendChatAction after extra-turn-reply tore down the interval');
  });

  test('onClose mid-extra-turn tears down visuals (safety net against forever-typing leak)', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onExtraTurnStarted('12345:24', { msgId: 658 });
    h.tgCalls.length = 0;
    cbs.onClose('12345:24', 137, { chatId: '12345', label: 't' });
    // Should have called setMessageReaction(reaction=[]) to clear ✍.
    const clear = h.tgCalls.find((c) => c.method === 'setMessageReaction'
      && Array.isArray(c.params.reaction) && c.params.reaction.length === 0);
    assert.ok(clear,
      'onClose mid-extra-turn must clear the ✍ so it doesn\'t linger on a dead session');
  });
});

describe('cross-session isolation — autosteer for one chat doesn\'t affect another', () => {
  test('two parallel extra-turns on different sessions track independently', () => {
    const h = baseDeps({
      // need a config entry for chat 99999 too for clean event logging
      config: {
        chats: {
          '12345': { agent: 'a' },
          '99999': { agent: 'b' },
        },
        bot: {},
      },
    });
    const cbs = createSdkCallbacks(h.deps);

    // Both sessions have an extra-turn started.
    cbs.onExtraTurnStarted('12345:24', { msgId: 658 });
    cbs.onExtraTurnStarted('99999', { msgId: 421 });
    h.tgCalls.length = 0;

    // Reply for session 1 only.
    cbs.onExtraTurnReply('12345:24', { msgId: 658, text: 'reply 1' });
    const post = h.tgCalls;
    // We should see ✍ cleared on msg 658 for chat 12345 but NOT msg 421.
    const clearedFor658 = post.find((c) => c.method === 'setMessageReaction'
      && c.params.message_id === 658
      && Array.isArray(c.params.reaction) && c.params.reaction.length === 0);
    assert.ok(clearedFor658, '✍ cleared on msg 658');
    const clearedFor421 = post.find((c) => c.method === 'setMessageReaction'
      && c.params.message_id === 421
      && Array.isArray(c.params.reaction) && c.params.reaction.length === 0);
    assert.equal(clearedFor421, undefined,
      '✍ on msg 421 in the OTHER session must NOT be cleared by session 1\'s reply');

    // Cleanup the still-running session 2 typing interval
    cbs.onClose('99999', 0, { chatId: '99999', label: 't' });
  });
});

describe('FOLD-path safety (rc.7) — sdk callbacks must not emit visible noise without explicit events', () => {
  test('createSdkCallbacks alone produces no Telegram traffic until an event handler fires', () => {
    // SDK backend never emits onExtraTurnStarted/Reply (it relies on
    // PostToolBatch fold). Confirm constructing the callbacks doesn't
    // accidentally start a typing loop or any background traffic.
    const h = baseDeps();
    createSdkCallbacks(h.deps);
    assert.equal(h.tgCalls.length, 0);
  });
});

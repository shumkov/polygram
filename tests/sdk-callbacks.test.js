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
      // rc.13: per-chat compaction warning (proactive + reactive).
      'onCompactionWarn',
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

describe('onInit — upserts session row with TOPIC-RESOLVED spawn identity', () => {
  test('chat-only config: persists chat-level agent/cwd/model/effort + resolved pm_backend', () => {
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
      agent: 'finance',                       // chat-level (no topic override)
      cwd: '/u',
      model: 'sonnet',
      effort: 'high',
      pm_backend: 'sdk',                      // no pm set → defaults via pickBackend
    });
  });

  test('topic override wins over chat-level (Music topic regression — shumorobot 2026-05-21)', () => {
    // Production trigger: chat-level was agent=shumabit / cwd=$HOME /
    // pm=sdk. Music topic (thread :3) had a topic-level override:
    // agent=music-curation:music-curator, cwd=.../Music/rekordbox,
    // pm=tmux. Pre-fix `onInit` read chat-level only, persisting the
    // WRONG agent+cwd. Next turn → S2 drift fires (resolved topic
    // config vs persisted chat config) → drop row → fresh sid →
    // context lost. Every turn forever.
    const { deps, upsertCalls } = baseDeps({
      config: {
        chats: {
          '-1003807211164': {
            agent: 'shumabit',
            cwd: '/Users/ivanshumkov',
            model: 'sonnet', effort: 'high',
            pm: 'sdk',
            topics: {
              '3': {
                name: 'Music',
                agent: 'music-curation:music-curator',
                cwd: '/Users/ivanshumkov/Music/rekordbox',
                pm: 'tmux',
              },
            },
          },
        },
        bot: {},
      },
    });
    const cbs = createSdkCallbacks(deps);
    cbs.onInit('-1003807211164:3', { session_id: 'sess-music' }, {
      chatId: '-1003807211164', threadId: '3', label: 'Music',
    });
    assert.equal(upsertCalls.length, 1);
    assert.deepEqual(upsertCalls[0], {
      session_key: '-1003807211164:3',
      chat_id: '-1003807211164',
      thread_id: '3',
      claude_session_id: 'sess-music',
      agent: 'music-curation:music-curator',  // ← topic, not chat
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      model: 'sonnet',                        // ← inherited from chat (no topic override)
      effort: 'high',
      pm_backend: 'cli',                      // ← topic override; pm:'tmux' aliases to 'cli' (factory.js Phase 4)
    });
  });

  test('pm_backend is always persisted, never defaulted by upsertSession', () => {
    // Defensive: pre-fix onInit did not pass pm_backend at all. The
    // DB layer defaulted it to 'sdk' for every spawn — so tmux
    // sessions were silently labelled 'sdk' in telemetry forever.
    // Verify onInit now passes it explicitly.
    const { deps, upsertCalls } = baseDeps({
      config: {
        chats: { '99': { agent: 'a', cwd: '/c', pm: 'tmux' } },
        bot: {},
      },
    });
    createSdkCallbacks(deps).onInit('99', { session_id: 's' }, {
      chatId: '99', threadId: null, label: 't',
    });
    assert.equal(upsertCalls[0].pm_backend, 'cli',
      "pm_backend must be passed explicitly so DB layer never defaults "
        + "(pm:'tmux' aliases to 'cli' — factory.js Phase 4)");
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

describe('onQuestionResumed — re-lights the turn reactor after a question is answered', () => {
  test('sets the head pending reactor to THINKING + logs (regression guard)', () => {
    const h = baseDeps();
    const states = [];
    const entry = { pendingQueue: [{ context: { reactor: { setState: (s) => states.push(s) } } }] };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onQuestionResumed('12345:7', entry);
    assert.deepEqual(states, ['THINKING'], 'reactor re-armed to THINKING so post-answer work shows progress');
    assert.ok(h.events.some((e) => e.kind === 'question-resumed'), 'logs question-resumed for the forensic regression guard');
  });

  test('dead/torn-down turn (no reactor) → safe no-op, never throws', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onQuestionResumed('12345:7', { pendingQueue: [] });
    cbs.onQuestionResumed('12345:7', { pendingQueue: [{ context: {} }] });
    cbs.onQuestionResumed('12345:7', {});
    cbs.onQuestionResumed('12345:7', undefined);
    assert.ok(true, 'no throw on any degenerate entry');
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

// ── 0.10.0 H2 — hook events route to reactor ────────────────────────
//
// H2 extends `onHookEvent` (which was H1 observer-only DB persist) to
// also call reactor.setState / reactor.heartbeat. The win is that
// PreToolUse fires for subagent-inner tools (scoped by `agent_id`)
// that JSONL `tool-use` never surfaces — keeps the reactor meaningful
// on long subagent turns and kills the 🥱→😨→🤯 fear escalation.
describe('onHookEvent — H2 reactor wiring', () => {
  function makeRig() {
    const h = baseDeps();
    const states = [];
    let heartbeats = 0;
    const head = {
      context: {
        reactor: {
          setState: (s) => states.push(s),
          heartbeat: () => { heartbeats += 1; },
        },
      },
    };
    const entry = { pendingQueue: [head], chatId: '12345', label: 't' };
    const cbs = createSdkCallbacks(h.deps);
    return { h, cbs, entry, head, states, get heartbeats() { return heartbeats; } };
  }

  test('PreToolUse → reactor.setState(classifyToolName(toolName))', () => {
    const r = makeRig();
    r.cbs.onHookEvent('k', { type: 'PreToolUse', toolName: 'Bash' }, r.entry);
    assert.deepEqual(r.states, ['state-for-Bash']);
  });

  test('PreToolUse for subagent-inner tool still routes (agent_id present)', () => {
    // The whole point of H2: JSONL `tool-use` never fires for tools
    // inside a Task subagent — but hook `PreToolUse` does, scoped by
    // `agent_id`. The reactor doesn't care WHO ran the tool, only
    // WHAT — so the setState fires the same way for inner tools.
    const r = makeRig();
    r.cbs.onHookEvent('k', {
      type: 'PreToolUse',
      toolName: 'WebFetch',
      agentId: 'a-1', agentType: 'general-purpose',
    }, r.entry);
    assert.deepEqual(r.states, ['state-for-WebFetch']);
  });

  test('PreToolUse with no toolName is a no-op (defensive)', () => {
    const r = makeRig();
    r.cbs.onHookEvent('k', { type: 'PreToolUse' }, r.entry);
    assert.deepEqual(r.states, []);
  });

  test('PostToolUse → reactor.heartbeat', () => {
    const r = makeRig();
    r.cbs.onHookEvent('k', { type: 'PostToolUse', toolName: 'Bash', toolUseId: 'x' }, r.entry);
    assert.equal(r.heartbeats, 1);
    assert.deepEqual(r.states, []);
  });

  test('SubagentStop → reactor.heartbeat', () => {
    const r = makeRig();
    r.cbs.onHookEvent('k', { type: 'SubagentStop', agentId: 'a-1' }, r.entry);
    assert.equal(r.heartbeats, 1);
  });

  test('Notification → reactor.heartbeat', () => {
    const r = makeRig();
    r.cbs.onHookEvent('k', { type: 'Notification' }, r.entry);
    assert.equal(r.heartbeats, 1);
  });

  test('UserPromptSubmit + Stop are intentionally NO-OPs (lifecycle owns those)', () => {
    const r = makeRig();
    r.cbs.onHookEvent('k', { type: 'UserPromptSubmit', prompt: 'hi' }, r.entry);
    r.cbs.onHookEvent('k', { type: 'Stop', lastAssistantMessage: 'done' }, r.entry);
    assert.deepEqual(r.states, []);
    assert.equal(r.heartbeats, 0);
  });

  test('unknown / parse-error don\'t touch the reactor', () => {
    const r = makeRig();
    r.cbs.onHookEvent('k', { type: 'unknown', raw: { x: 1 } }, r.entry);
    r.cbs.onHookEvent('k', { type: 'parse-error', error: 'bad', raw: '...' }, r.entry);
    assert.deepEqual(r.states, []);
    assert.equal(r.heartbeats, 0);
  });

  test('skips silently when there is no head pending (between turns)', () => {
    const r = makeRig();
    // No throw — and the DB persist (H1 side) still happens.
    assert.doesNotThrow(() => {
      r.cbs.onHookEvent('k', { type: 'PreToolUse', toolName: 'Bash' },
        { pendingQueue: [] });
    });
    const persisted = r.h.events.filter((e) => e.kind === 'hook-event');
    assert.equal(persisted.length, 1, 'H1 persist still runs even when reactor is absent');
  });

  test('skips silently when reactor is absent on the head context', () => {
    const r = makeRig();
    assert.doesNotThrow(() => {
      r.cbs.onHookEvent('k', { type: 'PostToolUse', toolName: 'Bash' },
        { pendingQueue: [{ context: {} }] });
    });
  });

  test('reactor.heartbeat being non-function is tolerated (older reactor)', () => {
    const h = baseDeps();
    const head = { context: { reactor: { setState: () => {} } } };  // no heartbeat
    const cbs = createSdkCallbacks(h.deps);
    assert.doesNotThrow(() => {
      cbs.onHookEvent('k', { type: 'PostToolUse', toolName: 'Bash' },
        { pendingQueue: [head] });
    });
  });

  test('H1 DB persist still runs when H2 routes to reactor (augment, not replace)', () => {
    const r = makeRig();
    r.cbs.onHookEvent('k', { type: 'PreToolUse', toolName: 'Bash' }, r.entry);
    const persisted = r.h.events.filter((e) => e.kind === 'hook-event');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].detail.hook_type, 'PreToolUse');
    assert.equal(persisted[0].detail.tool_name, 'Bash');
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

  // ─── F#22 — channels backend: dispatcher already delivered, handler skips ──
  //
  // Production observation: Claude continued researching post-turn-resolve and
  // called reply again. Dispatcher delivered → cli-process emitted the
  // autonomous-assistant-message event → handler delivered AGAIN. Double-send.
  // The channels emit now carries alreadyDelivered: true (see
  // cli-process-lifecycle.test.js's F#22). Handler must honor it.

  test('F#22: alreadyDelivered=true skips tg send (channels dispatcher already shipped)', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', {
      text: 'orphan reply',
      sessionId: 'sess-1',
      backend: 'cli',
      alreadyDelivered: true,
    });
    assert.equal(
      h.tgCalls.length,
      0,
      'handler must skip the second tg(sendMessage) when alreadyDelivered=true',
    );
    // Forensic log still fires — the transcript line is the record of the
    // autonomous wakeup having happened, just not the delivery.
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].kind, 'autonomous-wakeup-message');
    assert.equal(
      h.events[0].detail.already_delivered,
      true,
      'event detail records that the dispatcher (not this handler) delivered',
    );
  });

  test('F#22: alreadyDelivered missing/false → existing delivery path still fires', () => {
    // Regression-safety against the new branch — SDK/tmux shapes without the
    // flag must still get the existing sendMessage behavior.
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'sdk wakeup' }] },
    });
    assert.equal(h.tgCalls.length, 1, 'SDK shape: existing tg send must still fire');
    assert.equal(h.tgCalls[0].params.text, 'sdk wakeup');
  });

  // ─── F#23 — autonomous wakeup respects parseResponse + sanitizer ──────
  //
  // F#22 closed the channels double-send. But the handler's `tg(sendMessage)`
  // path is RAW — no parseResponse, no sanitizeAssistantReply, no inline
  // sticker/react handling. For SDK/tmux autonomous wakeups (ScheduleWakeup,
  // tmux autosteer extra reply, etc.) `[sticker:NAME]` and `No response
  // requested.` still leak as literal text into Telegram. The rc.51 helper
  // (lib/telegram/process-agent-reply.js, backported in rc.10 F#1) was built
  // exactly for this — autonomous-wakeup was its original target use-case.
  // Wire it through.

  function makeAutonomousDeps() {
    const h = baseDeps();
    const stickerSentCalls = [];
    const deliverCalls = [];

    // Real-shape parseResponse stub (matches lib/telegram/parse.js contract).
    h.deps.parseResponse = (text) => {
      const stickers = [];
      const reactions = [];
      let cleaned = String(text);
      cleaned = cleaned.replace(/\[sticker:([a-zA-Z0-9_-]+)\]/g, (_m, name) => {
        stickers.push({ name, fileId: `file-id-${name}` });
        return '';
      });
      cleaned = cleaned.replace(/\[react:(.+?)\]/g, (_m, emoji) => {
        reactions.push(emoji);
        return '';
      });
      return {
        text: cleaned.trim(),
        sticker: null, stickerLabel: null, stickers,
        reaction: null, reactions,
      };
    };
    h.deps.sanitizeAssistantReply = (text) => {
      if (/^No response requested\.?$/i.test(String(text).trim())) {
        return { text: '(canned reply suppressed)', replaced: true, original: text };
      }
      return { text, replaced: false };
    };
    h.deps.chunkMarkdownText = (text) => [text];
    h.deps.deliverReplies = async ({ chunks, chatId, threadId }) => {
      deliverCalls.push({ chunks: [...chunks], chatId, threadId });
      return { sent: chunks.map((_, i) => ({ message_id: i + 1 })), failed: [], results: [] };
    };
    // Wire the REAL helper so the integration is tested end-to-end.
    h.deps.processAndDeliverAgentText = require('../lib/telegram/process-agent-reply').processAndDeliverAgentText;

    // Track sticker sends (real helper invokes tg(sendSticker)).
    return { h, deliverCalls, stickerSentCalls };
  }

  test('F#23: autonomous wakeup with [sticker:pumped] strips tag from delivered text + sends sticker', async () => {
    const { h, deliverCalls } = makeAutonomousDeps();
    const cbs = createSdkCallbacks(h.deps);

    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'Wake-up! [sticker:pumped]' }] },
    });
    // Helper is async; let microtasks settle.
    await new Promise(r => setImmediate(r));

    // No raw tg sendMessage with the literal sticker tag.
    const literalSticker = h.tgCalls.find(c =>
      c.method === 'sendMessage' && /\[sticker:/.test(String(c.params?.text || ''))
    );
    assert.equal(
      literalSticker,
      undefined,
      `[sticker:NAME] must NOT reach Telegram as literal text. tgCalls: ${JSON.stringify(h.tgCalls.map(c => ({ method: c.method, text: c.params?.text })))}`,
    );

    // Delivered text (via deliverReplies → helper) has the tag stripped.
    const allDelivered = deliverCalls.flatMap(c => c.chunks).join('\n');
    assert.ok(
      !allDelivered.includes('[sticker:'),
      `Expected sticker tag stripped from delivered chunks. Got: ${JSON.stringify(allDelivered)}`,
    );

    // sendSticker IS fired (via tg from the helper's inline-sticker branch).
    const stickerSent = h.tgCalls.find(
      c => c.method === 'sendSticker' && c.params?.sticker === 'file-id-pumped',
    );
    assert.ok(
      stickerSent,
      `Expected sendSticker(file-id-pumped). tgCalls: ${JSON.stringify(h.tgCalls.map(c => c.method))}`,
    );
  });

  test('F#23: autonomous wakeup with `No response requested.` is sanitized', async () => {
    const { h, deliverCalls } = makeAutonomousDeps();
    const cbs = createSdkCallbacks(h.deps);

    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'No response requested.' }] },
    });
    await new Promise(r => setImmediate(r));

    const allDelivered = deliverCalls.flatMap(c => c.chunks).join('\n');
    assert.ok(
      !/^No response requested\.?$/i.test(allDelivered.trim()),
      `Sanitizer should have replaced canned string on the autonomous-wakeup path. Got: ${JSON.stringify(allDelivered)}`,
    );
    assert.match(allDelivered, /suppressed/i, 'Expected canned-reply replacement marker');
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

describe('R8 — onInjectFail surfaces a failed autosteer paste promptly', () => {
  test('onInjectFail is part of the callback table', () => {
    const { deps } = baseDeps();
    const cbs = createSdkCallbacks(deps);
    assert.equal(typeof cbs.onInjectFail, 'function',
      'onInjectFail must exist — a failed autosteer paste (inject-fail '
      + 'event) was previously silent until the stale-sweep caught it '
      + 'turnTimeoutMs later');
  });

  test('onInjectFail logs telemetry + clears the ✍ on the failed msgId', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    // injectUserMessage's paste rejected — the autosteer never landed.
    cbs.onInjectFail('12345:24', {
      err: 'tmux paste-buffer: no server running',
      msgId: 658,
      backend: 'tmux',
    });

    // Telemetry: the failure must be recorded, not swallowed.
    const ev = h.events.find((e) => e.kind === 'inject-fail');
    assert.ok(ev, 'inject-fail must be logged so a failed paste is diagnosable');
    assert.equal(ev.detail.msg_id, 658);
    assert.match(ev.detail.error, /no server running/);

    // The ✍ reaction (applied by autosteeredRefs.add when the message
    // was classified as an autosteer) must be cleared — otherwise it
    // lingers on a message whose paste never reached the TUI.
    const clear = h.tgCalls.find((c) => c.method === 'setMessageReaction'
      && c.params.message_id === 658
      && Array.isArray(c.params.reaction) && c.params.reaction.length === 0);
    assert.ok(clear, 'a failed inject must clear the ✍ on its msgId promptly, '
      + 'not leave it stuck until the stale-sweep fires');
  });

  test('onInjectFail without a msgId still logs (does not throw)', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    assert.doesNotThrow(() => cbs.onInjectFail('12345:24', {
      err: 'paste failed', backend: 'tmux',
    }));
    const ev = h.events.find((e) => e.kind === 'inject-fail');
    assert.ok(ev, 'inject-fail is logged even when no msgId is available');
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

describe('onCompactionWarn — per-chat compaction warning (rc.13)', () => {
  test('proactive: posts "context ~N% full → run /compact" threaded under the topic + logs event', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onCompactionWarn('12345:3', { kind: 'proactive', pct: 80, backend: 'cli' });

    const send = h.tgCalls.find((c) => c.method === 'sendMessage');
    assert.ok(send, 'must post a chat message');
    assert.equal(send.params.chat_id, '12345');
    assert.equal(send.params.message_thread_id, 3, 'threaded under the topic');
    assert.match(send.params.text, /80%/, 'states the fill %');
    assert.match(send.params.text, /\/compact/, 'proposes /compact');
    assert.ok(
      h.events.some((e) => e.kind === 'compaction-warn' && e.detail.kind === 'proactive' && e.detail.pct === 80),
      'forensic compaction-warn event must fire',
    );
  });

  test('reactive: posts "auto-compacting now, resend if quiet"; no thread → no message_thread_id', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onCompactionWarn('12345', { kind: 'reactive', backend: 'cli' });

    const send = h.tgCalls.find((c) => c.method === 'sendMessage');
    assert.ok(send);
    assert.equal(send.params.chat_id, '12345');
    assert.equal(send.params.message_thread_id, undefined);
    assert.match(send.params.text, /auto-compact/i);
    assert.match(send.params.text, /resend/i);
    assert.ok(h.events.some((e) => e.kind === 'compaction-warn' && e.detail.kind === 'reactive'));
  });
});

describe('onBgWorkStatus — background-work visibility (Use 3)', () => {
  test('running → posts a status message in the topic thread + stores its id', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onBgWorkStatus('12345:3', { state: 'running', count: 1 });
    const send = h.tgCalls.find((c) => c.method === 'sendMessage');
    assert.ok(send, 'a status message was sent');
    assert.match(send.params.text, /working in the background/i);
    assert.equal(send.params.message_thread_id, 3, 'posted in the topic thread');
    assert.ok(h.events.some((e) => e.kind === 'bg-work-status' && e.detail.state === 'running'));
  });

  test('running is idempotent while one is already shown', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onBgWorkStatus('12345:3', { state: 'running', count: 1 });
    await cbs.onBgWorkStatus('12345:3', { state: 'running', count: 2 });
    assert.equal(h.tgCalls.filter((c) => c.method === 'sendMessage').length, 1, 'one status message, not two');
  });

  test('cleared → edits the status message to done', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onBgWorkStatus('12345:3', { state: 'running', count: 1 });
    await cbs.onBgWorkStatus('12345:3', { state: 'cleared' });
    const edit = h.tgCalls.find((c) => c.method === 'editMessageText');
    assert.ok(edit, 'edited the status message');
    assert.equal(edit.params.message_id, 1);
    assert.match(edit.params.text, /finished/i);
    assert.ok(h.events.some((e) => e.kind === 'bg-work-status' && e.detail.state === 'cleared'));
  });

  test('cleared with no prior running is a no-op', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onBgWorkStatus('12345:3', { state: 'cleared' });
    assert.equal(h.tgCalls.length, 0, 'nothing to edit');
  });

  test('onClose edits a dangling status message to ended', async () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onBgWorkStatus('12345:3', { state: 'running', count: 1 });
    cbs.onClose('12345:3', 0, { chatId: '12345', label: 'topic' });
    const edit = h.tgCalls.find((c) => c.method === 'editMessageText');
    assert.ok(edit, 'closed session edits the dangling status');
    assert.match(edit.params.text, /ended|restarted/i);
  });
});

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
      pm_backend: 'tmux',                     // ← topic override
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
    assert.equal(upsertCalls[0].pm_backend, 'tmux',
      'pm_backend must be passed explicitly so DB layer never defaults');
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

  // ─── rc.50: full pipeline (parseResponse + sanitize + deliver) ───
  //
  // Production bugs 2026-05-24 (shumorobot HOME): pre-rc.50 this
  // handler called `tg(bot, 'sendMessage', { text: <raw> })` directly,
  // bypassing the streamer's pipeline. Two user-visible bugs:
  //   - `[sticker:pumped]` showed up as literal text in Telegram
  //     because parseResponse never ran.
  //   - `No response requested.` (CLI canned-string leak) reached
  //     Telegram because the rc.45 sanitizer was wired into the
  //     regular reply path only.
  // The fix routes autonomous-wakeup text through the same pipeline
  // as bot-reply-stream: parseResponse → sanitize → chunk →
  // deliverReplies → send inline stickers/sticker; inline reactions
  // logged-and-dropped (no target msg to react against).

  // Helper: pipeline-wired deps that record what each stage does.
  function pipelineDeps(overrides = {}) {
    const h = baseDeps(overrides);
    const stickerMap = { pumped: 'file_id_pumped', happy: 'file_id_happy' };
    const deliverCalls = [];
    const sanitizeCalls = [];
    const parseCalls = [];

    // Use the REAL parseResponse — that's the contract we're trying
    // to preserve. Importing here keeps the test honest: a future
    // change to parseResponse that breaks autonomous-wakeup will be
    // caught by this suite.
    const { parseResponse: parseResponseImpl } = require('../lib/telegram/parse');
    const parseResponse = (text) => {
      parseCalls.push(text);
      return parseResponseImpl(text, { stickerMap, emojiToSticker: {} });
    };

    // Use the REAL sanitizer too. Same reasoning.
    const { sanitizeAssistantReply: sanitizeImpl } = require('../lib/telegram/sanitize-reply');
    const sanitizeAssistantReply = (text) => {
      sanitizeCalls.push(text);
      return sanitizeImpl(text);
    };

    // Stub deliverReplies — record what it WOULD have sent. Real
    // delivery is over the wire; we just need to verify the
    // pipeline routes through it with the right shape.
    const deliverReplies = async ({ chatId, threadId, chunks, replyToMessageId, meta }) => {
      deliverCalls.push({ chatId, threadId, chunks, replyToMessageId, meta });
      return { sent: chunks.map((_, i) => 100 + i), failed: [], results: [] };
    };

    // Use the REAL chunker so chunking behavior is honest.
    const { chunkMarkdownText } = require('../lib/telegram/chunk');

    return {
      ...h,
      stickerMap,
      deliverCalls,
      sanitizeCalls,
      parseCalls,
      deps: {
        ...h.deps,
        parseResponse,
        sanitizeAssistantReply,
        chunkMarkdownText,
        deliverReplies,
        chunkBudget: 3500,
      },
    };
  }

  test('rc.50: pipeline routes plain text through deliverReplies (no raw sendMessage)', async () => {
    const h = pipelineDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345:24', {
      message: { content: [{ type: 'text', text: 'Build finished, all green.' }] },
    });
    // Pipeline is async (the handler kicks off an IIFE) — let
    // microtasks settle.
    await new Promise((r) => setImmediate(r));

    assert.equal(h.parseCalls.length, 1,
      'parseResponse must run on autonomous text (was bypassed pre-rc.50)');
    assert.equal(h.sanitizeCalls.length, 1,
      'sanitizer must run on autonomous text (was bypassed pre-rc.50)');
    assert.equal(h.deliverCalls.length, 1,
      'deliverReplies must be used (was a raw tg(sendMessage) pre-rc.50)');
    assert.equal(h.deliverCalls[0].chunks[0], 'Build finished, all green.');
    assert.equal(h.deliverCalls[0].threadId, 24);
    assert.equal(h.deliverCalls[0].replyToMessageId, null,
      'autonomous-wakeup has no inbound msg to reply to');
    assert.equal(h.deliverCalls[0].meta.source, 'autonomous-wakeup');
  });

  test('rc.50: [sticker:NAME] tags fire sendSticker (not literal text)', async () => {
    // The production-failure pin (msg ids 1593 + 1312 from the
    // shumorobot DB on 2026-05-24): autonomous-wakeup messages with
    // `[sticker:pumped]` were stored + delivered with the literal
    // tag visible in the chat.
    const h = pipelineDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'Tests passed. [sticker:pumped]' }] },
    });
    await new Promise((r) => setImmediate(r));

    // Text bubble: the sticker tag was stripped, only the prefix
    // remains.
    assert.equal(h.deliverCalls.length, 1);
    assert.equal(h.deliverCalls[0].chunks[0].trim(), 'Tests passed.');
    // Inline sticker fired via tg(sendSticker) — the actual sticker
    // bubble Ivan should see in Telegram.
    const stickerCalls = h.tgCalls.filter((c) => c.method === 'sendSticker');
    assert.equal(stickerCalls.length, 1,
      'parsed [sticker:pumped] MUST fire sendSticker, not show as literal text');
    assert.equal(stickerCalls[0].params.sticker, 'file_id_pumped');
    assert.equal(stickerCalls[0].meta.source, 'autonomous-wakeup-inline-sticker');
    assert.equal(stickerCalls[0].meta.stickerName, 'pumped');
  });

  test('rc.50: solo [sticker:NAME] (whole reply) sends only the sticker', async () => {
    // When the WHOLE autonomous text is a single sticker tag,
    // parseResponse returns `text:'', sticker: <fileId>`. The
    // pipeline must skip deliverReplies and send the sticker alone.
    const h = pipelineDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: '[sticker:happy]' }] },
    });
    await new Promise((r) => setImmediate(r));

    assert.equal(h.deliverCalls.length, 0,
      'no text bubble — solo-sticker path');
    const stickerCalls = h.tgCalls.filter((c) => c.method === 'sendSticker');
    assert.equal(stickerCalls.length, 1);
    assert.equal(stickerCalls[0].params.sticker, 'file_id_happy');
    assert.equal(stickerCalls[0].meta.source, 'autonomous-wakeup-sticker',
      'solo-sticker path uses a distinct source from inline-sticker for forensics');
  });

  test('rc.50: canned-string "No response requested." is sanitized + emits event', async () => {
    // The other production leak (3 occurrences in shumorobot DB on
    // 2026-05-24, all source='autonomous-wakeup'): the CLI-context
    // canned string reached Telegram. rc.45 fixed this for the
    // regular reply path; rc.50 extends the protection here.
    const h = pipelineDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'No response requested.' }] },
    });
    await new Promise((r) => setImmediate(r));

    // deliverReplies still fired, but with the REPLACED text, not
    // the canned string.
    assert.equal(h.deliverCalls.length, 1);
    assert.doesNotMatch(h.deliverCalls[0].chunks[0], /No response requested\./,
      'canned string must NOT reach deliverReplies — sanitizer replaces it');

    // canned-reply-suppressed event surfaces the substitution so a
    // soak can count autonomous-path leaks separately from the
    // regular reply path.
    const cannedEvents = h.events.filter((e) => e.kind === 'canned-reply-suppressed');
    assert.equal(cannedEvents.length, 1,
      'canned-reply-suppressed event must fire with source=autonomous-wakeup');
    assert.equal(cannedEvents[0].detail.source, 'autonomous-wakeup');
    assert.equal(cannedEvents[0].detail.original, 'No response requested.');
  });

  test('rc.50: inline [react:EMOJI] tags are dropped + logged (no target msg)', async () => {
    // Autonomous-wakeup has no inbound msg to react against. The
    // pipeline strips [react:EMOJI] tags via parseResponse, then
    // logs them as dropped instead of calling setMessageReaction
    // against a nonexistent message.
    const h = pipelineDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'Done! [react:👍]' }] },
    });
    await new Promise((r) => setImmediate(r));

    // No setMessageReaction call (no target msg).
    const reactionCalls = h.tgCalls.filter((c) => c.method === 'setMessageReaction');
    assert.equal(reactionCalls.length, 0);
    // Dropped-reactions event for forensics.
    const droppedEvents = h.events.filter((e) => e.kind === 'autonomous-wakeup-reactions-dropped');
    assert.equal(droppedEvents.length, 1);
    assert.deepEqual(droppedEvents[0].detail.dropped, ['👍']);
  });

  test('rc.50: pipeline-missing fallback path still works (back-compat for old test harnesses)', async () => {
    // If a caller of createSdkCallbacks doesn't wire the pipeline
    // deps (the four optional callback params: parseResponse,
    // sanitizeAssistantReply, chunkMarkdownText, deliverReplies),
    // the handler falls back to the pre-rc.50 raw-sendMessage path.
    // Existing tests above (line 399-437) exercise exactly this
    // fallback and must keep passing — assert here that the event
    // is tagged so an operator can tell the two paths apart.
    const h = baseDeps();    // NO pipeline deps wired
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('12345', {
      message: { content: [{ type: 'text', text: 'raw fallback path' }] },
    });
    await new Promise((r) => setImmediate(r));

    assert.equal(h.tgCalls.length, 1,
      'fallback path uses a single raw tg(sendMessage)');
    assert.equal(h.tgCalls[0].method, 'sendMessage');
    assert.equal(h.tgCalls[0].params.text, 'raw fallback path',
      'text is sent UNPROCESSED — no parseResponse, no sanitize');
    const event = h.events.find((e) => e.kind === 'autonomous-wakeup-message');
    assert.equal(event.detail.pipeline, 'raw-fallback',
      'event must tag which path ran so soak can verify production runs the full path');
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

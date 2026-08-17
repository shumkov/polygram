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
const { sanitizeAssistantReply } = require('../lib/telegram/sanitize-reply');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');

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
        upsertProviderSession(args) { upsertCalls.push(args); },
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
  test('returns the expected callbacks (0.13: tmux-era extra-turn handlers deleted; D3 edges added)', () => {
    const { deps } = baseDeps();
    const cbs = createSdkCallbacks(deps);
    for (const k of [
      'onInit', 'onClose', 'onStreamChunk', 'onToolUse',
      'onAssistantMessageStart', 'onAutonomousAssistantMessage',
      'onCompactBoundary',
      // rc.13: per-chat compaction warning (proactive + reactive).
      'onCompactionWarn',
      // 0.13 D3: session feedback controller edges (no-pending cycles).
      'onTurnStart', 'onIdle',
    ]) {
      assert.equal(typeof cbs[k], 'function', `${k} should be a function`);
    }
    // 0.13 P4: tmux-era handlers deleted (zero emitters on any backend since
    // the 0.12 tmux deletion; no-pending-cycle visuals belong to the session
    // feedback controller — tests/p4-session-feedback.test.js).
    for (const k of ['onExtraTurnStarted', 'onExtraTurnReply', 'onAutosteerResolution', 'onAutosteerMatchMiss']) {
      assert.equal(cbs[k], undefined, `${k} should be deleted`);
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

  test('Codex init does not persist incomplete provider identity or overwrite dormant Claude state', () => {
    const { db, dbPath } = freshDb('sdk-callbacks-codex-init');
    try {
      db.upsertSession({
        session_key: '12345:24',
        chat_id: '12345',
        thread_id: '24',
        claude_session_id: 'claude-session-a',
        agent: 'finance',
        cwd: '/claude/workspace',
        model: 'sonnet',
        effort: 'high',
        pm_backend: 'sdk',
        ts: 100,
      });
      const h = baseDeps({ db });
      createSdkCallbacks(h.deps).onInit('12345:24', {
        session_id: 'thread-codex-a',
        providerSessionId: 'thread-codex-a',
        generationId: 'generation-a',
        backend: 'codex',
      }, {
        runtime: 'codex',
        backend: 'codex',
        chatId: '12345',
        threadId: '24',
        label: 'Codex',
        cwd: '/codex/workspace',
        desiredSettings: Object.freeze({
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
        }),
        spawnProfileId: 'a'.repeat(64),
      });

      const codex = db.getProviderSession('12345:24', 'codex:app-server');
      assert.equal(codex, undefined);

      const claude = db.getSession('12345:24');
      assert.equal(claude.claude_session_id, 'claude-session-a');
      assert.equal(claude.cwd, '/claude/workspace');
      assert.equal(claude.model, 'sonnet');
      assert.equal(
        db.getProviderSession('12345:24', 'claude:inline').provider_session_id,
        'claude-session-a',
      );
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  test('Claude initialization retains the legacy and namespaced dual-write', () => {
    const { db, dbPath } = freshDb('sdk-callbacks-claude-init');
    try {
      const h = baseDeps({ db });
      createSdkCallbacks(h.deps).onInit('12345:24', {
        session_id: 'claude-session-a',
      }, {
        runtime: 'claude',
        backend: 'sdk',
        chatId: '12345',
        threadId: '24',
        label: 'Claude',
      });

      const legacy = db.getSession('12345:24');
      assert.equal(legacy.claude_session_id, 'claude-session-a');
      assert.equal(legacy.agent, 'finance');
      assert.equal(legacy.cwd, '/u');
      assert.equal(legacy.model, 'sonnet');
      assert.equal(legacy.effort, 'high');
      assert.equal(legacy.pm_backend, 'sdk');
      assert.equal(
        db.getProviderSession('12345:24', 'claude:inline').provider_session_id,
        'claude-session-a',
      );
      assert.equal(
        db.getProviderSession('12345:24', 'codex:app-server'),
        undefined,
      );
    } finally {
      cleanupDb(dbPath, db);
    }
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

  test('Codex close detail does not replace the appended process entry', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onClose(
      '12345',
      0,
      { backend: 'codex', generationId: 'generation-a', reason: 'stop' },
      {
        runtime: 'codex',
        backend: 'codex',
        chatId: '12345',
        label: 'Codex chat',
      },
    );
    assert.equal(h.events[0].detail.chat_id, '12345');
    assert.equal(h.events[0].detail.session_key, '12345');
  });

  test('releases reply evidence after the owning process closes', () => {
    const retired = [];
    const h = baseDeps({
      deliveryBarrier: {
        retireSession: (sessionKey) => retired.push(sessionKey),
      },
    });

    createSdkCallbacks(h.deps).onClose(
      '12345:3',
      0,
      { chatId: '12345', label: 'topic' },
    );

    assert.deepEqual(retired, ['12345:3']);
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

describe('onQuestionAsked/Resumed — hold the reaction through a question wait (no 😨)', () => {
  test('asked holds work-in-flight; resumed releases it', async () => {
    const h = baseDeps();
    const work = [];
    const entry = { pendingQueue: [{ context: {
      reactor: { setState: () => {}, setWorkInFlight: (a) => work.push(a) },
      typing: { pause: () => {}, resume: () => {} },
    } }] };
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onQuestionAsked('12345:7', { questions: [] }, entry);
    assert.deepEqual(work, [true], 'a question wait holds the reaction — no decay to 🥱/😨 while waiting on the user');
    cbs.onQuestionResumed('12345:7', entry);
    assert.deepEqual(work, [true, false], 'answering releases the hold so the normal cascade resumes');
  });

  test('reactor without setWorkInFlight → safe no-op', async () => {
    const h = baseDeps();
    const entry = { pendingQueue: [{ context: { reactor: { setState: () => {} }, typing: { pause: () => {}, resume: () => {} } } }] };
    const cbs = createSdkCallbacks(h.deps);
    await cbs.onQuestionAsked('12345:7', { questions: [] }, entry);
    cbs.onQuestionResumed('12345:7', entry);
    assert.ok(true, 'never throws on the old reactor shape');
  });
});

describe('onSubagentStart/Done — B3 holds a "working" reactor face while sub-agents run', () => {
  test('start holds work-in-flight; only the LAST done releases it', () => {
    const h = baseDeps();
    const states = [];
    const work = [];
    const entry = { pendingQueue: [{ context: { reactor: {
      setState: (s) => states.push(s),
      setWorkInFlight: (a) => work.push(a),
      heartbeat: () => {},
    } } }] };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onSubagentStart('12345:7', { agentType: 'general', inFlight: 1 }, entry);
    assert.deepEqual(states, ['SUBAGENT'], 'shows the distinct 👾 sub-agent state');
    assert.deepEqual(work, [true], 'a starting sub-agent holds the working face');
    cbs.onSubagentDone('12345:7', { inFlight: 1 }, entry);   // a nested one ends, another remains
    cbs.onSubagentDone('12345:7', { inFlight: 0 }, entry);   // the LAST one ends → release
    assert.deepEqual(work, [true, true, false], 'released only once the last sub-agent finishes');
  });

  test('reactor without setWorkInFlight (degenerate shape) → safe no-op', () => {
    const h = baseDeps();
    const entry = { pendingQueue: [{ context: { reactor: { setState: () => {}, heartbeat: () => {} } } }] };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onSubagentStart('12345:7', { inFlight: 1 }, entry);
    cbs.onSubagentDone('12345:7', { inFlight: 0 }, entry);
    assert.ok(true, 'never throws when the reactor lacks setWorkInFlight');
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

  test('canned CLI strings never render in the live bubble', () => {
    // The same safety net a delivered reply gets: the model occasionally emits
    // CLI-context boilerplate verbatim, and on the streaming path it would
    // appear in the preview bubble as the bot's answer.
    const h = baseDeps({ sanitizeAssistantReply });
    const onChunkCalls = [];
    const head = { context: { streamer: { onChunk: (t) => { onChunkCalls.push(t); return Promise.resolve(); } } } };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onStreamChunk('k', 'No response requested.', { pendingQueue: [head] });
    assert.equal(onChunkCalls.length, 1);
    assert.doesNotMatch(onChunkCalls[0], /No response requested\./);
  });

  test('a chunk arriving after finalize is dropped, but is recorded so it is diagnosable', () => {
    // A finalized streamer silently swallows further chunks — correct, the
    // bubble is settled — but from outside it reads as "streaming just
    // stopped", with nothing in the log to say why.
    const h = baseDeps();
    let onChunkCalls = 0;
    const head = {
      context: { streamer: { state: 'finalized', onChunk: () => { onChunkCalls++; return Promise.resolve(); } } },
    };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onStreamChunk('12345:7', 'a late chunk', { chatId: '12345', pendingQueue: [head] });

    const ev = h.events.find((e) => e.kind === 'stream-after-finalize');
    assert.ok(ev, 'the drop must leave a trace');
    assert.equal(ev.detail.chat_id, '12345');
    assert.equal(onChunkCalls, 1, 'the streamer still owns the drop decision');
  });

  test('Codex cumulative snapshots replace rather than append in callback glue', () => {
    const h = baseDeps();
    const onChunkCalls = [];
    const entry = {
      runtime: 'codex',
      generationId: 'generation-a',
      pendingQueue: [{
        context: {
          streamer: {
            onChunk: (text) => {
              onChunkCalls.push(text);
              return Promise.resolve();
            },
          },
          reactor: { heartbeat: () => {} },
        },
      }],
    };
    const cbs = createSdkCallbacks(h.deps);
    cbs.onStreamChunk('k', 'Hel', entry);
    cbs.onStreamChunk('k', 'Hello', entry);
    cbs.onStreamChunk('k', 'Hello world', entry);
    assert.deepEqual(onChunkCalls, ['Hel', 'Hello', 'Hello world']);
  });

  test('malformed Codex stream values are ignored with content-free telemetry', () => {
    const h = baseDeps();
    const onChunkCalls = [];
    const cbs = createSdkCallbacks(h.deps);
    cbs.onStreamChunk('12345', { text: 'unexpected envelope' }, {
      runtime: 'codex',
      generationId: 'generation-a',
      chatId: '12345',
      pendingQueue: [{
        context: {
          streamer: {
            onChunk: (text) => {
              onChunkCalls.push(text);
              return Promise.resolve();
            },
          },
        },
      }],
    });
    assert.deepEqual(onChunkCalls, []);
    assert.deepEqual(h.events, [{
      kind: 'codex-stream-event-invalid',
      detail: {
        chat_id: '12345',
        session_key: '12345',
        generation_id: 'generation-a',
        value_type: 'object',
      },
    }]);
    assert.equal(JSON.stringify(h.events).includes('unexpected envelope'), false);
  });

  test('Claude stream callback retains its prior opaque pass-through', () => {
    const h = baseDeps();
    const value = { legacy: 'opaque callback value' };
    let observed;
    const cbs = createSdkCallbacks(h.deps);
    cbs.onStreamChunk('k', value, {
      runtime: 'claude',
      backend: 'sdk',
      pendingQueue: [{
        context: {
          streamer: {
            onChunk: (text) => {
              observed = text;
              return Promise.resolve();
            },
          },
        },
      }],
    });
    assert.equal(observed, value);
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

  test('isolated-topic autonomous output is sent to its originating thread', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('-1003369922517:37', {
      text: 'completed report',
      sessionId: 'sess-topic',
      backend: 'cli',
      alreadyDelivered: false,
    });
    assert.equal(h.tgCalls.length, 1);
    assert.deepEqual(h.tgCalls[0].params, {
      chat_id: '-1003369922517',
      text: 'completed report',
      message_thread_id: 37,
    });
  });

  test('isolated-topic autonomous output is suppressed after confirmed delivery', () => {
    const h = baseDeps();
    const cbs = createSdkCallbacks(h.deps);
    cbs.onAutonomousAssistantMessage('-1003369922517:37', {
      text: 'completed report',
      sessionId: 'sess-topic',
      backend: 'cli',
      alreadyDelivered: true,
    });
    assert.equal(h.tgCalls.length, 0);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].detail.chat_id, '-1003369922517');
    assert.equal(h.events[0].detail.thread_id, '37');
    assert.equal(h.events[0].detail.already_delivered, true);
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
    // The paste error text can quote whatever was being pasted, so the event
    // carries its size; the message itself stays in the process log.
    assert.equal(ev.detail.error_len, 'tmux paste-buffer: no server running'.length);
    assert.equal(ev.detail.error, undefined);

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

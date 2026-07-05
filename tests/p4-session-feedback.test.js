'use strict';

/**
 * 0.13 P4 — D3 session-scoped feedback (docs/0.13-channels-lifecycle-design.md §3 D3).
 *
 * The residual gap after D1+D2 (the design's scope contract for D3):
 *   (a) autonomous/wakeup cycles have no pending turn — pre-P4 the user saw
 *       NOTHING until text landed. Now: a session-scoped typing loop runs for
 *       the cycle (the dead 'turn-start' emit finally gets a consumer).
 *   (b) an injected message picked up as its OWN next cycle gets feedback
 *       anchored to its message (the ledger knows the msgId → 🤔 on it).
 *   (d) the voice-ack 👂 never promoted on cli (onFirstStream is dead here):
 *       the pane 'thinking' heartbeat now promotes a never-set reactor.
 *   (e) extraTurnTracker (zero emitters on every backend since the tmux
 *       deletion) and the dead autosteer-resolution/match-miss handlers are
 *       deleted; their CALLBACK_TO_EVENT rows replaced by onTurnStart/onIdle.
 *
 * ((c) waiting-on-user typing pause/resume shipped in P1 and stays as wired.)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSessionFeedback } = require('../lib/feedback/session-feedback');
const { createSdkCallbacks } = require('../lib/sdk/callbacks');
const { CALLBACK_TO_EVENT } = require('@shumkov/orchestra');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeController() {
  const actions = [];
  const reactions = [];
  const bot = { api: { sendChatAction: async (...a) => { actions.push(a); return true; } } };
  const tg = async (b, method, params) => {
    if (method === 'setMessageReaction') reactions.push(params);
    return {};
  };
  const fb = createSessionFeedback({
    bot, tg,
    getChatIdFromKey: (sk) => sk.split(':')[0],
    getThreadIdFromKey: (sk) => (sk.includes(':') ? sk.split(':')[1] : null),
    botName: 'b',
    typingIntervalMs: 25,
    logEvent: () => {},
    logger: { error: () => {} },
  });
  return { fb, actions, reactions };
}

describe('P4-A: session feedback controller — autonomous cycle visuals', () => {
  test('startAutonomousCycle runs a typing loop; endCycle stops it', async () => {
    const { fb, actions } = makeController();
    fb.startAutonomousCycle('100');
    await sleep(70);
    assert.ok(actions.length >= 2, 'autonomous work must be visible (typing) — pre-P4 it was dead air until text landed');
    fb.endCycle('100');
    const n = actions.length;
    await sleep(70);
    assert.equal(actions.length, n, 'typing stops at cycle end');
  });

  // The autonomous cycle's typing used to stop only at endCycle (Process idle =
  // SESSION idle), so a later turn delayed teardown and typing spun minutes past the
  // delivered answer (field: Ivan DM 2026-06-26, answer 07:06:57 → typing-off 07:16:41).
  // Fix: stop the cycle's typing the moment IT delivers, decoupled from session idle.
  // docs/typing-tracks-activity-spec.md
  test('stopCycleTyping stops the typing loop at delivery — before endCycle', async () => {
    const { fb, actions, reactions } = makeController();
    fb.startAutonomousCycle('100', { anchorMsgId: 42 });
    await sleep(70);
    assert.ok(actions.length >= 2, 'typing running during the cycle');
    fb.stopCycleTyping('100');                       // the cycle delivered its answer
    const n = actions.length;
    await sleep(70);
    assert.equal(actions.length, n, 'typing stopped at delivery, NOT held until endCycle/session-idle');
    fb.endCycle('100');                              // teardown still clears the anchor
    await sleep(10);
    assert.ok(reactions.find((r) => r.message_id === 42 && Array.isArray(r.reaction) && r.reaction.length === 0),
      'anchor still cleared at endCycle after stopCycleTyping');
  });

  test('stopCycleTyping is idempotent and a no-op on an unknown session', async () => {
    const { fb, actions } = makeController();
    fb.startAutonomousCycle('100');
    await sleep(50);
    fb.stopCycleTyping('100');
    fb.stopCycleTyping('100');   // idempotent
    fb.stopCycleTyping('999');   // unknown — must not throw
    const n = actions.length;
    await sleep(50);
    assert.equal(actions.length, n, 'stays stopped');
    fb.endCycle('100');
  });

  test('anchored cycle: 🤔 lands on the anchor message and clears at end', async () => {
    const { fb, reactions } = makeController();
    fb.startAutonomousCycle('100', { anchorMsgId: 42 });
    await sleep(10);
    assert.ok(reactions.find((r) => r.message_id === 42 && r.reaction?.[0]?.emoji === '🤔'),
      'an injected message picked up as its own cycle gets feedback on ITS message');
    fb.endCycle('100');
    await sleep(10);
    assert.ok(reactions.find((r) => r.message_id === 42 && Array.isArray(r.reaction) && r.reaction.length === 0),
      'reaction cleared at cycle end');
  });

  test('idempotent: double start is one loop; endCycle on unknown session is a no-op', async () => {
    const { fb, actions } = makeController();
    fb.startAutonomousCycle('100');
    fb.startAutonomousCycle('100');
    await sleep(60);
    fb.endCycle('100');
    fb.endCycle('999');   // must not throw
    const n = actions.length;
    await sleep(60);
    assert.equal(actions.length, n);
  });
});

function makeCallbacks(extra = {}) {
  return createSdkCallbacks({
    db: {}, dbWrite: () => {}, config: { chats: {} }, bot: {}, botName: 'b',
    tg: async () => ({}), logEvent: () => {},
    classifyToolName: () => 'TOOL', announce: () => {}, shouldAnnounce: () => false,
    contextHintShown: new Set(), extractAssistantText: () => '',
    getChatIdFromKey: () => '1', getThreadIdFromKey: () => null,
    renderQuestion: () => {},
    logger: { error: () => {}, log: () => {} },
    ...extra,
  });
}

describe('P4-B: callbacks wiring', () => {
  test('onTurnStart with NO pending engages the controller; with a head pending it does not', () => {
    const calls = [];
    const cbs = makeCallbacks({
      sessionFeedback: {
        startAutonomousCycle: (sk, o) => calls.push(['start', sk, o]),
        endCycle: (sk) => calls.push(['end', sk]),
      },
    });
    assert.equal(typeof cbs.onTurnStart, 'function', "the dead 'turn-start' emit finally gets a consumer");
    cbs.onTurnStart('sk', { hasPending: false, anchorMsgId: '42' }, { pendingQueue: [] });
    assert.deepEqual(calls[0], ['start', 'sk', { anchorMsgId: '42' }]);
    cbs.onTurnStart('sk', { hasPending: true, anchorMsgId: null }, { pendingQueue: [{ context: {} }] });
    assert.equal(calls.length, 1, 'a normal turn owns its own per-turn visuals');
  });

  test('onIdle ends the autonomous visuals; onClose is the safety net', () => {
    const calls = [];
    const cbs = makeCallbacks({
      sessionFeedback: {
        startAutonomousCycle: () => {},
        endCycle: (sk) => calls.push(sk),
      },
    });
    assert.equal(typeof cbs.onIdle, 'function');
    cbs.onIdle('sk', {});
    cbs.onClose('sk', 0, { label: 'x', chatId: '1', pendingQueue: [] });
    assert.deepEqual(calls, ['sk', 'sk']);
  });

  test('onAutonomousAssistantMessage stops the cycle typing at delivery (not at session idle)', () => {
    const calls = [];
    const cbs = makeCallbacks({
      sessionFeedback: { stopCycleTyping: (sk) => calls.push(sk) },
    });
    assert.equal(typeof cbs.onAutonomousAssistantMessage, 'function');
    // cli/channels shape: the dispatcher already shipped the text (alreadyDelivered)
    cbs.onAutonomousAssistantMessage('sk', { text: 'the answer', alreadyDelivered: true });
    assert.deepEqual(calls, ['sk'], 'the delivered cycle stops its typing immediately');
    cbs.onAutonomousAssistantMessage('sk', { text: '', alreadyDelivered: true });
    assert.deepEqual(calls, ['sk'], 'an empty (no-text) message delivers nothing → does not stop typing');
  });

  test('voice-ack fix: onThinking promotes a NEVER-SET reactor to THINKING (heartbeat alone left 👂 forever)', () => {
    const states = [];
    let current = null;
    const reactor = {
      heartbeat: () => {},
      setState: (st) => { states.push(st); current = st; },
      get currentState() { return current; },
    };
    const cbs = makeCallbacks({});
    cbs.onThinking('sk', { pendingQueue: [{ context: { reactor } }] });
    assert.deepEqual(states, ['THINKING'],
      'cli has no onFirstStream — the pane heartbeat is the first life sign after a voice ack');
    cbs.onThinking('sk', { pendingQueue: [{ context: { reactor } }] });
    assert.deepEqual(states, ['THINKING'], 'promotes only from never-set — no churn on later polls');
  });

  test('extraTurnTracker is gone: the tmux-era handlers are no longer exported', () => {
    const cbs = makeCallbacks({});
    assert.equal(cbs.onExtraTurnStarted, undefined, 'zero emitters on every backend since the tmux deletion');
    assert.equal(cbs.onExtraTurnReply, undefined);
    assert.equal(cbs.onAutosteerResolution, undefined, 'its comment promised an audit trail no event ever fed');
    assert.equal(cbs.onAutosteerMatchMiss, undefined);
  });
});

describe('P4-C: process-manager forwarding', () => {
  test('CALLBACK_TO_EVENT: turn-start + idle forwarded; dead tmux-era rows removed', () => {
    assert.equal(CALLBACK_TO_EVENT.onTurnStart, 'turn-start');
    assert.equal(CALLBACK_TO_EVENT.onIdle, 'idle');
    assert.equal(CALLBACK_TO_EVENT.onExtraTurnReply, undefined);
    assert.equal(CALLBACK_TO_EVENT.onExtraTurnStarted, undefined);
    assert.equal(CALLBACK_TO_EVENT.onAutosteerResolution, undefined);
    assert.equal(CALLBACK_TO_EVENT.onAutosteerMatchMiss, undefined);
  });
});

describe('P4-D: cli-process turn-start payload', () => {
  test("the 'turn-start' emit carries hasPending + the picked-up anchor msgId", async () => {
    const { CliProcess } = require('@shumkov/orchestra');
    const proc = new CliProcess({
      sessionKey: 's', chatId: '12345',
      tmuxRunner: { sendControl: async () => {}, killSession: async () => {}, captureWide: async () => '' },
      botName: 'b', claudeBin: '/usr/bin/false',
      toolDispatcher: async () => ({ ok: true }),
      logger: { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} },
    });
    proc.bridgeReady = true;
    proc.bridgeServer = { writeMessage: () => {} };
    proc.inFlight = true;
    proc.injectUserMessage({ content: 'x', msgId: 77, source: 'autosteer' });
    const injectedId = [...proc.inputLedger.keys()][0];

    const starts = [];
    proc.on('turn-start', (p) => starts.push(p));
    proc._handleHookEvent({
      type: 'UserPromptSubmit',
      prompt: `<channel source="polygram-bridge" chat_id="12345" turn_id="${injectedId}">x</channel>`,
    });

    assert.equal(starts.length, 1);
    assert.equal(starts[0].hasPending, false, 'no pending = an autonomous/injected cycle starting');
    assert.equal(starts[0].anchorMsgId, '77', 'the ledger knows which message this cycle picked up');
    await proc.kill('test');
  });
});

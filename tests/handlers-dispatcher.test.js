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
 *   - AUTH_DISABLED handling (docs/AUTH_DISABLED_HANDLING_SPEC.md): operator
 *     notify + dedupe, loud logging, no chat reply, safe-by-default gate
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher, CONCURRENT_WARN_THRESHOLD_DEFAULT } = require('../lib/handlers/dispatcher');
const { createAuthDisabledGate } = require('../lib/ops/auth-disabled-gate');
const { classify: realClassify } = require('../lib/error/classify');

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
    clearSessionId: [],
    deliverReplies: [],
    loggerErrors: [],
    sequence: [],
  };

  let handleResolver;
  const handleMessage = overrides.handleMessage || ((sessionKey, chatId, msg, bot) => {
    calls.handle.push({ sessionKey, chatId, msg, bot });
    return new Promise((resolve, reject) => {
      handleResolver = { resolve, reject };
    });
  });

  const dispatcher = createDispatcher({
    config: {
      bot: {
        queueWarnThreshold: overrides.queueWarnThreshold ?? 3,
        ...(overrides.adminChatId !== undefined ? { approvals: { adminChatId: overrides.adminChatId } } : {}),
      },
    },
    db: {
      setInboundHandlerStatus: (row) => calls.setInboundStatus.push(row),
      clearSessionId: (sk) => {
        calls.clearSessionId.push(sk);
        calls.sequence.push('clearSessionId');
      },
    },
    dbWrite: (fn) => { try { fn(); } catch {} },
    tg: async (bot, method, params, meta) => {
      calls.tg.push({ bot, method, params, meta });
      calls.sequence.push(`tg:${meta?.source || 'unknown'}`);
      return { ok: true };
    },
    botName: 'testbot',
    logEvent: (kind, detail) => calls.events.push({ kind, detail }),
    handleMessage,
    sendToProcess: async (sk, prompt, ctx) => {
      calls.sendToProcess.push({ sessionKey: sk, prompt, ctx });
      return overrides.sendToProcessResult || { text: 'auto-resume reply text' };
    },
    classifyError: overrides.classifyError || ((err) => ({
      kind: overrides.classifyKind || 'unknown',
      userMessage: overrides.userMessage === undefined ? `error: ${err.message}` : overrides.userMessage,
      isTransient: false,
      autoRecover: false,
    })),
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
    chunkBudget: 4096,
    startupRetryDelayMs: overrides.startupRetryDelayMs,
    getIsShuttingDown: () => overrides.shuttingDown === true,
    getOomObservation: overrides.getOomObservation
      || (() => (overrides.oomDetected
        ? { status: 'detected', detected: true, delta: 1n }
        : { status: 'unchanged', detected: false, delta: 0n })),
    ...(overrides.authDisabledGate !== undefined ? { authDisabledGate: overrides.authDisabledGate } : {}),
    logger: { log: () => {}, error: (m) => calls.loggerErrors.push(m) },
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
    const { calls } = await runAndFail(new Error('bridge disconnected'), {
      shuttingDown: true,
      isAutoResumable: true,
    });
    assert.equal(calls.setInboundStatus[0]?.status, 'replay-pending');
    assert.equal(calls.tg.length, 0);
    assert.equal(calls.autoResumeAttempts.length, 0);
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

  test('OOM visible before shutdown signal: status=replay-pending, no error reply or auto-resume', async () => {
    const { calls } = await runAndFail(new Error('bridge disconnected'), {
      oomDetected: true,
      isAutoResumable: true,
    });
    assert.equal(calls.setInboundStatus[0]?.status, 'replay-pending');
    assert.equal(calls.tg.length, 0);
    assert.equal(calls.autoResumeAttempts.length, 0);
    assert.ok(calls.events.some((event) => (
      event.kind === 'handler-error' && event.detail.oom_shutdown === true
    )));
  });

  test('OOM visible before shutdown signal preserves the replay one-shot guard', async () => {
    const replayMsg = { ...baseMsg, _isReplay: true };
    const fx = fixture({ oomDetected: true });
    fx.dispatcher.dispatchHandleMessage('sk', 100, replayMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('bridge disconnected'));
    await nextTick(); await nextTick();
    assert.equal(fx.calls.setInboundStatus[0]?.status, 'replay-attempted');
    assert.equal(fx.calls.tg.length, 0);
  });

  test('OOM observer failure preserves ordinary error handling', async () => {
    const { calls } = await runAndFail(new Error('boom'), {
      getOomObservation: () => { throw new Error('observer failed'); },
    });
    assert.equal(calls.setInboundStatus[0]?.status, 'failed');
    assert.equal(calls.tg.length, 1);
  });

  test('genuine error: status=failed + user error reply sent', async () => {
    const { calls } = await runAndFail(new Error('boom'), {});
    assert.equal(calls.setInboundStatus[0]?.status, 'failed');
    assert.equal(calls.tg.length, 1);
    assert.equal(calls.tg[0].method, 'sendMessage');
    assert.match(calls.tg[0].params.text, /error: boom/);
  });

  test('SESSION_PROCESS_LOST clears the saved session before guidance and never auto-resumes', async () => {
    const err = Object.assign(new Error('contained process tree exited'), {
      code: 'SESSION_PROCESS_LOST',
    });
    const { calls } = await runAndFail(err, {
      classifyError: realClassify,
      isAutoResumable: true,
    });

    assert.deepEqual(calls.clearSessionId, ['sk']);
    assert.equal(calls.autoResumeAttempts.length, 0);
    assert.equal(calls.sendToProcess.length, 0);
    assert.equal(calls.tg.length, 1);
    assert.match(calls.tg[0].params.text, /resend/i);
    assert.match(calls.tg[0].params.text, /fresh session/i);
    assert.ok(
      calls.sequence.indexOf('clearSessionId') < calls.sequence.indexOf('tg:error-reply'),
      'the stale session id must be cleared before resend guidance is sent',
    );
    assert.ok(calls.events.some((event) => event.kind === 'session-reset-after-process-loss'));
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

  // Field: shumabit@umi WhatsApp topic 2026-06-27 — a bridge-disconnect mid-turn
  // triggered an auto-resume; the cli REPLY TOOL delivered the answer DURING the
  // re-run turn (result.alreadyDelivered=true), and attemptAutoResume ALSO re-sent
  // result.text at the end → the SAME answer delivered twice. The resume path must
  // honor alreadyDelivered just like the main dispatch path does.
  test('already-delivered (cli reply-tool) resume → does NOT re-send result.text (no double-answer)', async () => {
    const fx = fixture({
      isAutoResumable: true,
      sendToProcessResult: { text: 'Fixed. ✅ It was the WhatsApp channel.', alreadyDelivered: true },
    });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('bridge disconnected'));
    await nextTick(); await nextTick(); await nextTick(); await nextTick();
    assert.equal(fx.calls.sendToProcess.length, 1, 'the turn was re-run');
    assert.equal(fx.calls.deliverReplies.length, 0,
      'the reply tool already delivered → auto-resume must NOT re-send the same answer');
    assert.ok(fx.calls.events.some((e) => e.kind === 'auto-resume-already-delivered'));
    assert.ok(fx.calls.events.some((e) => e.kind === 'auto-resume-success'));
  });

  test('NOT already-delivered (SDK / no-reply turn) → auto-resume DOES deliver result.text', async () => {
    const fx = fixture({
      isAutoResumable: true,
      sendToProcessResult: { text: 'the SDK answer' },   // no alreadyDelivered → must be delivered
    });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('300s no activity'));
    await nextTick(); await nextTick(); await nextTick(); await nextTick();
    assert.equal(fx.calls.deliverReplies.length, 1,
      'no reply-tool delivery → auto-resume still delivers the answer (unchanged behavior)');
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

describe('createDispatcher — poisoned-session reset after bridge-detach (Music topic, 2026-06-01)', () => {
  // A channels session whose context grew large enough to auto-/compact on
  // resume loses its MCP bridge binding on EVERY resume ("no MCP server
  // configured"), so the resumed turn re-detaches (BRIDGE_DISCONNECTED) and
  // auto-resume fails. The persisted claude_session_id is then poisoned:
  // every future message re-resumes it and re-detaches — an endless
  // "🔌 please resend" loop (the 18:01 production trace). Break it by
  // dropping the session row when a bridge-detached turn ALSO fails to
  // auto-resume, so the next message spawns FRESH (no --resume).
  function bridgeErr() {
    const e = new Error('bridge disconnected');
    e.code = 'BRIDGE_DISCONNECTED';
    return e;
  }

  test('bridge-detach + auto-resume re-detaches → clearSessionId drops the poisoned session', async () => {
    const fx = fixture({
      isAutoResumable: true,
      // resume itself re-detaches → attemptAutoResume throws → auto-resume-failed
      sendToProcessResult: { error: 'bridge disconnected again' },
    });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(bridgeErr());
    await nextTick(); await nextTick(); await nextTick(); await nextTick();

    assert.deepEqual(
      fx.calls.clearSessionId,
      ['sk'],
      'poisoned session id MUST be dropped so the next message forks a fresh session (no --resume)',
    );
    assert.ok(
      fx.calls.events.some((e) => e.kind === 'session-reset-after-bridge-detach'),
      'forensic event must record the poison reset',
    );
    assert.ok(fx.calls.events.some((e) => e.kind === 'auto-resume-failed'));
  });

  test('GUARD: bridge-detach that auto-resumes SUCCESSFULLY → session id preserved (one-off crash, not poison)', async () => {
    // sendToProcess returns text (default) → resume succeeds → NOT poisoned.
    const fx = fixture({ isAutoResumable: true });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(bridgeErr());
    await nextTick(); await nextTick(); await nextTick(); await nextTick();

    assert.deepEqual(
      fx.calls.clearSessionId,
      [],
      'a session that resumes cleanly is a one-off bridge crash, not poison — keep its context',
    );
    assert.ok(fx.calls.events.some((e) => e.kind === 'auto-resume-success'));
  });

  test('GUARD: non-bridge resumable (300s timeout) that fails auto-resume → session id NOT cleared', async () => {
    // A wedged-tool timeout is not session poison; resuming usually works and
    // clearing would needlessly discard recoverable context.
    const fx = fixture({ isAutoResumable: true, sendToProcessResult: { error: 'still wedged' } });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(new Error('300s no activity'));  // no .code
    await nextTick(); await nextTick(); await nextTick(); await nextTick();

    assert.deepEqual(
      fx.calls.clearSessionId,
      [],
      'timeout-wedge is not bridge poison — must not drop the session id',
    );
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

describe('createDispatcher — poisoned-session reset after startup-gate death (general chat, 2026-06-03)', () => {
  // An aged claude_session_id renders claude's "Resume from summary?" dialog
  // whose /compact resume exits code 0 → the startup-gate reports
  // TMUX_SESSION_GONE. Every message re-resumes the same dead id → the chat sat
  // stuck for DAYS. Fix: poison-clear on the startup-gate codes (mirroring the
  // BRIDGE_DISCONNECTED clear) so the NEXT message spawns FRESH (no --resume).
  // This replaced an rc.19 in-CliProcess recursive this.start() retry that
  // reused a lifecycle-closed instance ("cannot start a closed instance"
  // regression that took down BOTH chats after a restart).
  function gateErr(code) {
    const e = new Error('[Shumabit@HOME:startup-gate] tmux session disappeared for polygram-... (matched: dev-channels, session-age)');
    e.code = code;
    return e;
  }
  async function settle() { for (let i = 0; i < 4; i++) await nextTick(); }

  test('TMUX_SESSION_GONE → clearSessionId drops the unresumable session', async () => {
    const fx = fixture({});
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(gateErr('TMUX_SESSION_GONE'));
    await settle();
    assert.deepEqual(fx.calls.clearSessionId, ['sk'],
      'unresumable session id MUST be dropped so the next message spawns fresh (no --resume)');
    assert.ok(fx.calls.events.some((e) => e.kind === 'session-reset-after-startup-gate'),
      'forensic event must record the startup-gate poison reset');
  });

  test('CHANNELS_DIALOG_TIMEOUT also poison-clears', async () => {
    const fx = fixture({});
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(gateErr('CHANNELS_DIALOG_TIMEOUT'));
    await settle();
    assert.deepEqual(fx.calls.clearSessionId, ['sk']);
  });

  test('GUARD: a non-startup-gate failure does NOT clear the session', async () => {
    const fx = fixture({});
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    const e = new Error('claude crashed mid-turn'); // no startup-gate code
    fx.getResolver().reject(e);
    await settle();
    assert.deepEqual(fx.calls.clearSessionId, [],
      'only startup-gate deaths poison-clear; a generic failure keeps the session');
  });
});

describe('createDispatcher — startup auto-retry (silent recovery from TMUX_SESSION_GONE)', () => {
  // 2026-06-04 (option a). The dev-channels startup gate intermittently fails
  // (claude exits before the channel goes live) ~once every 9h on shumorobot.
  // Today that surfaces "🔄 That chat got stuck starting up, so I reset it. Send
  // your message again…" and forces the user to RESEND. But TMUX_SESSION_GONE
  // means the message was NEVER delivered to claude (the session died IN the
  // startup gate, pre-channel) — so re-delivery is idempotent by construction.
  // The session_id is poison-cleared on this code, so a re-dispatch spawns a
  // FRESH session and delivers the same message. Fix: silently re-dispatch once;
  // a transient flake never reaches the user. One-shot (_startupRetried) so a
  // host that genuinely can't start claude shows the friendly reset reply after
  // exactly one retry instead of looping.
  function gateErr(code) {
    const e = new Error('[Shumabit@HOME:startup-gate] tmux session disappeared for polygram-...');
    e.code = code;
    return e;
  }
  // The retry is scheduled via setTimeout INSIDE the rejection's .catch
  // microtask, so we must (1) drain that microtask to let the retry timer arm,
  // then (2) wait past the retry delay (Node clamps setTimeout(0) to ~1ms) — a
  // plain setTimeout(0) flush-resolver scheduled before the microtask runs would
  // otherwise win the 1ms tie and the assertion would race the retry.
  async function flush() {
    await nextTick();                                  // let .catch arm the retry timer
    await new Promise((r) => setTimeout(r, 25));        // 25ms ≫ clamped retry delay
    for (let i = 0; i < 4; i++) await nextTick();       // let the retry turn settle
  }
  function resetReplySent(calls) {
    return calls.tg.some((t) => t.method === 'sendMessage'
      && t.meta?.source === 'error-reply');
  }

  test('TMUX_SESSION_GONE → silently re-dispatches the SAME message fresh, suppresses the reset reply', async () => {
    const handled = [];
    let n = 0;
    const handleMessage = (sk, chatId, msg) => {
      handled.push(msg);
      n += 1;
      // First attempt dies in the startup gate; the retry succeeds.
      return n === 1 ? Promise.reject(gateErr('TMUX_SESSION_GONE')) : Promise.resolve();
    };
    const fx = fixture({ handleMessage, startupRetryDelayMs: 0 });
    fx.dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg }, {});
    await flush();

    assert.equal(handled.length, 2, 'the message is re-dispatched exactly once on TMUX_SESSION_GONE');
    assert.equal(handled[1]._startupRetried, true,
      'the retry carries the one-shot marker so it cannot retry again');
    assert.ok(fx.calls.events.some((e) => e.kind === 'startup-auto-retry'),
      'forensic event records the silent retry');
    assert.equal(resetReplySent(fx.calls), false,
      'the user sees NO "reset it, resend" message — the retry recovered transparently');
  });

  test('GUARD: second startup-gate death (already retried) → NO third dispatch, shows the reset reply', async () => {
    const handled = [];
    const handleMessage = (sk, chatId, msg) => {
      handled.push(msg);
      return Promise.reject(gateErr('TMUX_SESSION_GONE')); // persistent failure
    };
    const fx = fixture({ handleMessage, startupRetryDelayMs: 0 });
    // Arrive already-retried: the retry's own failure must surface, not loop.
    fx.dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg, _startupRetried: true }, {});
    await flush();

    assert.equal(handled.length, 1, 'an already-retried message must NOT be re-dispatched again');
    assert.ok(!fx.calls.events.some((e) => e.kind === 'startup-auto-retry'),
      'no further retry is scheduled');
    assert.equal(resetReplySent(fx.calls), true,
      'a persistent startup failure still surfaces the friendly reset reply');
  });

  test('GUARD: a non-TMUX_SESSION_GONE failure is never startup-retried', async () => {
    const handled = [];
    const handleMessage = (sk, chatId, msg) => {
      handled.push(msg);
      return Promise.reject(new Error('claude crashed mid-turn')); // no startup-gate code
    };
    const fx = fixture({ handleMessage, startupRetryDelayMs: 0 });
    fx.dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg }, {});
    await flush();

    assert.equal(handled.length, 1, 'only TMUX_SESSION_GONE triggers the startup retry');
    assert.ok(!fx.calls.events.some((e) => e.kind === 'startup-auto-retry'));
  });
});

describe('createDispatcher — AUTH_DISABLED handling (docs/AUTH_DISABLED_HANDLING_SPEC.md)', () => {
  function authDisabledErr() {
    return Object.assign(new Error('Claude subscription access disabled'), { code: 'AUTH_DISABLED' });
  }
  async function settle() { for (let i = 0; i < 4; i++) await nextTick(); }
  function notifyCalls(calls) {
    return calls.tg.filter((c) => c.meta?.source === 'auth-disabled-notify');
  }

  test('first occurrence notifies the operator via tg() targeting approvals.adminChatId', async () => {
    const gate = createAuthDisabledGate();
    const fx = fixture({ authDisabledGate: gate, adminChatId: '999', userMessage: null });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    const notified = notifyCalls(fx.calls);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].params.chat_id, '999');
    assert.match(notified[0].params.text, /DISABLED/);
  });

  test('a second occurrence before any success does NOT re-notify', async () => {
    const gate = createAuthDisabledGate();
    const fx = fixture({ authDisabledGate: gate, adminChatId: '999', userMessage: null });

    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    fx.dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg, message_id: 2 }, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    assert.equal(notifyCalls(fx.calls).length, 1, 'deduped — only the first occurrence pages');
  });

  test('logEvent("auth-disabled", ...) fires on every occurrence, even when the DM is deduped', async () => {
    const gate = createAuthDisabledGate();
    const fx = fixture({ authDisabledGate: gate, adminChatId: '999', userMessage: null });

    for (let i = 0; i < 2; i++) {
      fx.dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg, message_id: i }, {});
      await nextTick();
      fx.getResolver().reject(authDisabledErr());
      await settle();
    }

    const events = fx.calls.events.filter((e) => e.kind === 'auth-disabled');
    assert.equal(events.length, 2, 'logging is never deduped, only the operator DM is');
  });

  test('no chat-facing reply is ever sent for AUTH_DISABLED', async () => {
    const gate = createAuthDisabledGate();
    const fx = fixture({ authDisabledGate: gate, adminChatId: '999', userMessage: null });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    const chatReplies = fx.calls.tg.filter((c) => c.meta?.source === 'error-reply');
    assert.equal(chatReplies.length, 0, 'userMessage: null must suppress the chat reply (classify.js contract)');
  });

  test('missing approvals.adminChatId logs a warning and does not throw', async () => {
    const gate = createAuthDisabledGate();
    const fx = fixture({ authDisabledGate: gate, userMessage: null }); // no adminChatId override
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    assert.equal(notifyCalls(fx.calls).length, 0);
    assert.ok(fx.calls.loggerErrors.some((m) => /AUTH_DISABLED fired but no.*adminChatId/.test(m)));
  });

  test('a throwing authDisabledGate.noteFailure() is caught — dispatch still completes normally', async () => {
    const throwingGate = {
      noteFailure: () => { throw new Error('gate exploded'); },
      noteSuccess: () => {},
      snapshot: () => ({ count: 0, lastAt: null, armed: true }),
    };
    const fx = fixture({ authDisabledGate: throwingGate, adminChatId: '999', userMessage: null });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    await assert.doesNotReject(async () => {
      fx.getResolver().reject(authDisabledErr());
      await settle();
    });

    // Normal terminal-status bookkeeping still ran (the gate failure didn't
    // abort the rest of the catch handler), and no false-positive DM was sent.
    assert.equal(fx.calls.setInboundStatus.length, 1);
    assert.equal(notifyCalls(fx.calls).length, 0);
  });

  test('omitting authDisabledGate uses a safe default instead of throwing', async () => {
    const fx = fixture({ adminChatId: '999', userMessage: null }); // authDisabledGate NOT passed
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    await assert.doesNotReject(async () => {
      fx.getResolver().reject(authDisabledErr());
      await settle();
    });
    // Default gate starts armed, so the DM still fires — just proving the
    // missing DI param degrades gracefully instead of crashing.
    assert.equal(notifyCalls(fx.calls).length, 1);
  });

  // Found in code review: the pre-existing rc.55 replay-failure block
  // (below, gated only on isReplay/!wasAborted/!isShuttingDown — NOT on
  // err.code) is a SEPARATE unconditional `if` in the same catch handler.
  // Without an explicit exclusion, an AUTH_DISABLED failure on a replayed
  // message (boot-replay after a restart) falls through into it and gets a
  // hardcoded "interrupted, please resend" chat reply — contradicting the
  // "chat is never told" contract classify.js establishes via
  // userMessage: null.
  test('a replayed message failing with AUTH_DISABLED still gets NO chat reply', async () => {
    const gate = createAuthDisabledGate();
    const fx = fixture({ authDisabledGate: gate, adminChatId: '999', userMessage: null });
    fx.dispatcher.dispatchHandleMessage('sk', 100, { ...baseMsg, _isReplay: true }, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    const chatReplies = fx.calls.tg.filter((c) => c.meta?.source === 'error-reply');
    assert.equal(chatReplies.length, 0,
      'the rc.55 replay-failure reply must not fire for AUTH_DISABLED — the operator is notified, the chat is not, replay or not');
    assert.equal(notifyCalls(fx.calls).length, 1, 'the operator DM must still fire on replay dispatch');
  });

  // Cross-session dedupe: the gate is a single process-wide instance shared
  // across every chat (AUTH_DISABLED is account-wide, not per-chat), so a
  // burst of concurrently-failing chats during a real outage must still page
  // the operator only once, not once per chat.
  test('dedupe is global across sessionKeys, not per-session', async () => {
    const gate = createAuthDisabledGate();
    const fx = fixture({ authDisabledGate: gate, adminChatId: '999', userMessage: null });

    fx.dispatcher.dispatchHandleMessage('sk-a', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    fx.dispatcher.dispatchHandleMessage('sk-b', 200, { ...baseMsg, message_id: 2 }, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    assert.equal(notifyCalls(fx.calls).length, 1,
      'a different chat failing during the same outage must NOT trigger a second page');
  });

  test('a real AUTH_DISABLED error run through the actual classify.js is suppressed end-to-end', async () => {
    const gate = createAuthDisabledGate();
    // Use the REAL classify() instead of the fixture's configurable stub —
    // proves the dispatcher-level suppression actually depends on
    // classify.js's CODES.AUTH_DISABLED.userMessage being null, not just on
    // whatever the test tells the stub to return.
    const fx = fixture({ authDisabledGate: gate, adminChatId: '999', classifyError: realClassify });
    fx.dispatcher.dispatchHandleMessage('sk', 100, baseMsg, {});
    await nextTick();
    fx.getResolver().reject(authDisabledErr());
    await settle();

    const chatReplies = fx.calls.tg.filter((c) => c.meta?.source === 'error-reply');
    assert.equal(chatReplies.length, 0);
  });
});

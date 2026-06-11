'use strict';

/**
 * 0.13 P3 — D2 InputLedger (docs/0.13-channels-lifecycle-design.md §3 D2,
 * tier verdict: docs/0.13-p0-spike-findings.md → Tier 2C).
 *
 * Every user-shaped input written to the bridge gets an observable lifecycle:
 *   written → seen (UPS envelope parse) → resolved (reply echo /
 *   consumed_turn_ids acknowledgment / attributed cycle end)
 *           → dropped (never seen/acked by cycle-end + confirm window, with
 *             the ack CONTRACT observed in the cycle — else 'fold-suspected',
 *             telemetry only: the A1-killing base-rate inversion guard)
 *           → superseded (a newer primary was seen meanwhile — the user
 *             re-sent or moved on; never double-answer).
 *
 * Plus the primary-delivery watchdog (KI-drop's missing half): a dispatched
 * primary with NO pickup and NO session activity within the window gets ONE
 * idempotent re-write; still nothing + no activity → bridge teardown
 * (existing recovery machinery). Activity since dispatch = claude is busy
 * (foreign cycle) — extend, never re-write (round-2 panel: false-positive
 * re-writes double-prompt healthy sessions).
 *
 * Red against pre-P3 code: injectUserMessage minted a turn_id that never
 * escaped the function (fold/new-turn/drop indistinguishable, live AND
 * forensically — seam S4); drops were invisible (#14 msg 2385).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('../lib/process/cli-process');
const { CALLBACK_TO_EVENT } = require('../lib/process-manager');
const { createDropRedeliverer } = require('../lib/handlers/drop-redeliver');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProc(opts = {}) {
  const events = [];
  const written = [];
  const destroyed = [];
  const proc = new CliProcess({
    sessionKey: 'sess-1', chatId: '12345',
    tmuxRunner: { sendControl: async () => {}, killSession: async () => {}, captureWide: async () => opts.pane ?? '' },
    botName: 'testbot', claudeBin: '/usr/bin/false',
    toolDispatcher: opts.toolDispatcher || (async () => ({ ok: true, message_id: 1 })),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    stopGraceMs: opts.stopGraceMs ?? 30,
    turnQuietMs: opts.turnQuietMs ?? 60_000,
    activityQuietMs: opts.activityQuietMs ?? 60_000,
    turnTimeoutMs: opts.turnTimeoutMs ?? 60_000,
    turnAbsoluteMs: opts.turnAbsoluteMs ?? 60_000,
    dropConfirmMs: opts.dropConfirmMs ?? 80,
    deliveryWatchdogMs: opts.deliveryWatchdogMs ?? 60_000,
  });
  proc.bridgeReady = true;
  proc.bridgeServer = {
    writeMessage: (obj) => { written.push(obj); },
    destroyConnection: () => { destroyed.push(Date.now()); },
  };
  proc.tmuxSession = 'pgr-testbot-channels-abc';
  return { proc, events, written, destroyed };
}

function startTurn(proc, written, text = 'do the thing') {
  const before = written.length;
  const sendP = proc.send(text, { context: { sourceMsgId: 1 } });
  sendP.catch(() => {});
  const userMsg = written.slice(before).find((w) => w.kind === 'user_msg');
  return { sendP, turnId: userMsg.turn_id };
}

const upsFor = (turnId) => ({
  type: 'UserPromptSubmit',
  prompt: `<channel source="polygram-bridge" chat_id="12345" user="u" msg_id="9" turn_id="${turnId}">x</channel>`,
});

// ─── T1: registration per source ────────────────────────────────────────────

test('T1: send/inject/fire register ledger entries with their source', async () => {
  const { proc, written } = makeProc();
  const { sendP, turnId } = startTurn(proc, written);
  proc.inFlight = true;
  proc.injectUserMessage({ content: 'follow-up', msgId: 43, source: 'autosteer' });
  proc.fireUserMessage('system push');

  assert.equal(proc.inputLedger.get(turnId)?.source, 'primary');
  const injected = [...proc.inputLedger.values()].find((e) => e.source === 'autosteer');
  assert.ok(injected, 'the injected turn_id must be LEDGERED (pre-P3 it never escaped injectUserMessage)');
  assert.equal(injected.msgId, '43');
  assert.equal(injected.state, 'written');
  assert.ok([...proc.inputLedger.values()].find((e) => e.source === 'system'));

  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── T2: UPS pickup marks ledger entries seen (pendings AND injects) ────────

test('T2: UPS envelope marks an INJECTED (no-pending) entry seen', async () => {
  const { proc, written, events } = makeProc();
  const { sendP } = startTurn(proc, written);
  proc.inFlight = true;
  proc.injectUserMessage({ content: 'follow-up', msgId: 43, source: 'autosteer' });
  const injectedId = [...proc.inputLedger.keys()].find((k) => proc.inputLedger.get(k).source === 'autosteer');

  proc._handleHookEvent(upsFor(injectedId));
  assert.equal(proc.inputLedger.get(injectedId).state, 'seen',
    'pickup of the injected envelope is the fold/new-turn signal');
  assert.ok(events.find((e) => e.kind === 'cli-ups-seen' && e.detail.turn_id === injectedId));

  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── T3: consumed_turn_ids acknowledgment (the Tier 2C contract) ────────────

test('T3: a reply carrying consumed_turn_ids resolves the acknowledged entries', async () => {
  const { proc, written } = makeProc();
  const { sendP, turnId } = startTurn(proc, written);
  proc.inFlight = true;
  proc.injectUserMessage({ content: 'follow-up', msgId: 43, source: 'autosteer' });
  const injectedId = [...proc.inputLedger.keys()].find((k) => proc.inputLedger.get(k).source === 'autosteer');

  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'r1',
    args: { chat_id: '12345', turn_id: turnId, text: 'combined answer', consumed_turn_ids: [turnId, injectedId] },
  });

  assert.equal(proc.inputLedger.get(injectedId).state, 'resolved',
    'the fold acknowledgment is an explicit contract field on OUR reply tool schema (P0 spike: incidental echo carries only the trigger id)');

  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── T4/T5: drop detection at cycle end — contract-aware ────────────────────

test('T4: unseen+unacked inject at cycle end (contract observed) → input-dropped after the confirm window', async () => {
  const { proc, written, events } = makeProc({ dropConfirmMs: 80 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc.injectUserMessage({ content: 'will be dropped', msgId: 43, source: 'autosteer' });
  const injectedId = [...proc.inputLedger.keys()].find((k) => proc.inputLedger.get(k).source === 'autosteer');

  let droppedPayload = null;
  proc.on('input-dropped', (p) => { droppedPayload = p; });

  // the trigger cycle answers ONLY the primary, with the contract field present
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'r1',
    args: { chat_id: '12345', turn_id: turnId, text: 'primary answer', consumed_turn_ids: [turnId] },
  });
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'x' });
  await sleep(80);    // stop-grace → finalize
  assert.equal(proc.pendingTurns.size, 0, 'trigger cycle finalized');
  assert.equal(droppedPayload, null, 'not yet — the confirm window must elapse (late pickup as a next cycle is legal)');

  await sleep(150);   // > dropConfirmMs
  assert.ok(droppedPayload, 'the #14 msg-2385 class becomes detectable: written → never seen/acked → dropped');
  assert.equal(droppedPayload.msgId, '43');
  assert.equal(droppedPayload.source, 'autosteer');
  assert.equal(proc.inputLedger.get(injectedId).state, 'dropped');
  assert.ok(events.find((e) => e.kind === 'input-dropped'));

  sendP.catch(() => {});
  await proc.kill('test');
});

test('T5: same shape but NO reply carried the contract field → fold-suspected, telemetry only', async () => {
  const { proc, written, events } = makeProc({ dropConfirmMs: 60 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc.injectUserMessage({ content: 'probably folded', msgId: 44, source: 'autosteer' });

  let dropped = false;
  proc.on('input-dropped', () => { dropped = true; });

  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'r1',
    args: { chat_id: '12345', turn_id: turnId, text: 'combined answer with no ack field' },
  });
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'x' });
  await sleep(200);

  assert.equal(dropped, false,
    'without the contract signal a fold is indistinguishable from a drop — auto-redelivering would double-answer the COMMON case (the A1 inversion)');
  const entry = [...proc.inputLedger.values()].find((e) => e.source === 'autosteer');
  assert.equal(entry.state, 'fold-suspected');
  assert.ok(events.find((e) => e.kind === 'input-fold-suspected'));

  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── T6: late pickup cancels the drop confirm ───────────────────────────────

test('T6: a late UPS (queued inject picked up as the NEXT cycle) cancels the pending drop', async () => {
  const { proc, written } = makeProc({ dropConfirmMs: 120 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc.injectUserMessage({ content: 'queued, not dropped', msgId: 45, source: 'autosteer' });
  const injectedId = [...proc.inputLedger.keys()].find((k) => proc.inputLedger.get(k).source === 'autosteer');

  let dropped = false;
  proc.on('input-dropped', () => { dropped = true; });

  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'r1',
    args: { chat_id: '12345', turn_id: turnId, text: 'answer', consumed_turn_ids: [turnId] },
  });
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'x' });
  await sleep(70);                                   // inside the confirm window
  proc._handleHookEvent(upsFor(injectedId));         // next-cycle pickup
  await sleep(200);

  assert.equal(dropped, false, 'a deferred pickup is the LEGAL outcome — never redeliver it');
  assert.equal(proc.inputLedger.get(injectedId).state, 'seen');

  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── T7: supersession ───────────────────────────────────────────────────────

test('T7: a newer primary seen before the drop confirms → superseded, no redelivery', async () => {
  const { proc, written, events } = makeProc({ dropConfirmMs: 100 });
  const a = startTurn(proc, written, 'first');
  proc._handleHookEvent(upsFor(a.turnId));
  proc.injectUserMessage({ content: 'stale follow-up', msgId: 46, source: 'autosteer' });

  let dropped = false;
  proc.on('input-dropped', () => { dropped = true; });
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'r1',
    args: { chat_id: '12345', turn_id: a.turnId, text: 'answer', consumed_turn_ids: [a.turnId] },
  });
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'x' });
  await sleep(60);

  // the user re-sent: a NEWER primary gets written and seen
  const b = startTurn(proc, written, 'first (re-sent by the user)');
  proc._handleHookEvent(upsFor(b.turnId));
  await sleep(150);   // confirm window elapses

  assert.equal(dropped, false, 'the user already re-sent — redelivering the stale one double-answers');
  const entry = [...proc.inputLedger.values()].find((e) => e.source === 'autosteer');
  assert.equal(entry.state, 'superseded');
  assert.ok(events.find((e) => e.kind === 'input-superseded'));

  a.sendP.catch(() => {}); b.sendP.catch(() => {});
  await proc.kill('test');
});

// ─── T8/T9: the primary-delivery watchdog ───────────────────────────────────

test('T8: unseen primary + NO activity since dispatch → exactly one idempotent re-write', async () => {
  const { proc, written, events } = makeProc({ deliveryWatchdogMs: 70 });
  const { sendP, turnId } = startTurn(proc, written);

  await sleep(120);   // first watchdog window elapses, no UPS, no activity
  const rewrites = written.filter((w) => w.kind === 'user_msg' && w.turn_id === turnId);
  assert.equal(rewrites.length, 2, 'ONE re-write of the SAME envelope (never seen + zero activity ⇒ claude never had it)');
  assert.ok(events.find((e) => e.kind === 'cli-delivery-rewrite'));

  sendP.catch(() => {});
  await proc.kill('test');
});

test('T8b: activity since dispatch (claude busy on a foreign cycle) → NO re-write', async () => {
  const { proc, written } = makeProc({ deliveryWatchdogMs: 60 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent({ type: 'PreToolUse', toolName: 'Bash' });   // foreign-cycle activity

  await sleep(140);
  const writes = written.filter((w) => w.kind === 'user_msg' && w.turn_id === turnId);
  assert.equal(writes.length, 1,
    'round-2 panel: re-writing while claude is busy double-prompts a healthy session — extend instead');

  sendP.catch(() => {});
  await proc.kill('test');
});

test('T9: still unseen after the re-write + still zero activity → bridge teardown (recovery path)', async () => {
  const { proc, written, destroyed, events } = makeProc({ deliveryWatchdogMs: 60 });
  const { sendP } = startTurn(proc, written);

  await sleep(240);   // rewrite window + escalation window
  assert.ok(destroyed.length >= 1,
    'escalation requires bridge-level silence too — teardown rides the EXISTING bridge-disconnected recovery');
  assert.ok(events.find((e) => e.kind === 'cli-delivery-watchdog-escalate'));

  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── T10: late-reply correlation (S5 tightening) ────────────────────────────

test('T10: a reply echoing a KNOWN resolved ledger id is never bound to the current pending', async () => {
  const { proc, written, events } = makeProc({ stopGraceMs: 30 });
  const a = startTurn(proc, written, 'first');
  proc._handleHookEvent(upsFor(a.turnId));
  proc._recordReplyForPendingTurn('first answer', a.turnId);
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'x' });
  await sleep(80);    // cycle A finalized; its ledger entry resolved
  assert.equal(proc.pendingTurns.size, 0);

  const b = startTurn(proc, written, 'second');
  let autonomous = null;
  proc.on('autonomous-assistant-message', (p) => { autonomous = p; });

  // a LATE reply from cycle A's tail arrives, echoing A's (resolved) turn_id
  proc._recordReplyForPendingTurn('late wrap-up from cycle A', a.turnId);

  const bPending = proc.pendingTurns.get(b.turnId);
  assert.equal(bPending.replies.length, 0,
    'pre-P3 the ==1 fallback bound this late reply into turn B\'s result (live misattribution)');
  assert.ok(autonomous?.alreadyDelivered, 'routed as an already-delivered late reply instead');
  assert.ok(events.find((e) => e.kind === 'cli-late-reply-correlated'));

  b.sendP.catch(() => {});
  await proc.kill('test');
});

// ─── T11-T13: contract surface + wiring ─────────────────────────────────────

test('T11: system entries never produce input-dropped', async () => {
  const { proc, written } = makeProc({ dropConfirmMs: 50, stopGraceMs: 30 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc.fireUserMessage('background self-check');

  let dropped = false;
  proc.on('input-dropped', () => { dropped = true; });
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'r1',
    args: { chat_id: '12345', turn_id: turnId, text: 'answer', consumed_turn_ids: [turnId] },
  });
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'x' });
  await sleep(200);
  assert.equal(dropped, false, 'system pushes are never auto-redelivered');

  sendP.catch(() => {});
  await proc.kill('test');
});

test('T12: the spawn system prompt carries the consumed_turn_ids contract', async () => {
  const spawns = [];
  const proc = new CliProcess({
    sessionKey: 's', chatId: '1',
    tmuxRunner: {
      spawn: async (o) => { spawns.push(o); throw new Error('stop-after-capture'); },
      sendControl: async () => {}, killSession: async () => {}, captureWide: async () => '',
    },
    botName: 'b', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
  });
  proc.sockPath = '/tmp/polygram-test-probe.sock';   // normally set by start()
  proc.claudeSessionId = 'test-session-id';
  await proc._spawnTmuxClaude({ tmuxName: 't', opts: {} }).catch(() => {});
  assert.ok(spawns.length, 'spawn must have been reached (env precondition)');
  const sysPromptIdx = spawns[0].args.indexOf('--append-system-prompt');
  assert.ok(sysPromptIdx >= 0);
  assert.match(spawns[0].args[sysPromptIdx + 1], /consumed_turn_ids/,
    'the fold-acknowledgment contract must be instructed, not hoped for');
});

test('T13: bridge reply schema declares consumed_turn_ids; pm forwards input-dropped', () => {
  const fs = require('node:fs');
  const bridgeSrc = fs.readFileSync(require.resolve('../lib/process/channels-bridge.mjs'), 'utf8');
  assert.match(bridgeSrc, /consumed_turn_ids/, 'reply tool schema carries the contract field');
  assert.equal(CALLBACK_TO_EVENT.onInputDropped, 'input-dropped', 'pm forwards the drop event to polygram');
});

// ─── T14: the polygram-side drop-redeliverer ────────────────────────────────

test('T14: drop-redeliverer reconstructs from the DB row and calls the D4 tail (primary/autosteer only)', async () => {
  const calls = { redelivered: [], events: [] };
  const handler = createDropRedeliverer({
    db: {
      getMessage: (chatId, msgId) => (msgId === 43
        ? { chat_id: chatId, msg_id: 43, text: 'the dropped text', user: 'Ivan', user_id: 7, ts: 1000, thread_id: null, reply_to_id: null }
        : null),
    },
    redeliver: async (args) => { calls.redelivered.push(args); return { ok: true }; },
    logEvent: (k, d) => calls.events.push({ k, d }),
    logger: quietLogger,
  });

  await handler('sess-1', { chatId: '100', msgId: 43, source: 'autosteer', turnId: 'x' });
  assert.equal(calls.redelivered.length, 1);
  assert.equal(calls.redelivered[0].source, 'drop');
  assert.equal(calls.redelivered[0].msg.text, 'the dropped text');
  assert.equal(calls.redelivered[0].msg.message_id, 43);

  await handler('sess-1', { chatId: '100', msgId: 44, source: 'edit-fold', turnId: 'y' });
  assert.equal(calls.redelivered.length, 1, 'edit-fold/system sources park as telemetry, never auto-redeliver');
  assert.ok(calls.events.find((e) => e.k === 'input-dropped-no-redeliver'));

  await handler('sess-1', { chatId: '100', msgId: 999, source: 'primary', turnId: 'z' });
  assert.equal(calls.redelivered.length, 1, 'no DB row → no redelivery (logged)');
});

// ─── T15: reply dispatch carries the originating msg (dropped-"4" fix A2) ───
// docs/0.13-resume-dialog-fix-spec.md. 2026-06-10 19:32 shumorobot Music:
// claude answered "2+2" with "4"; parse classified it as a solo reaction and
// the dispatcher DROPPED it (channels-tool-dispatcher-reactions-dropped
// {"dropped":["4"]}) because _dispatchToolCall never passed sourceMsgId —
// applyReactions was unconditionally false on the channels backend, so every
// solo reaction (legit 👍 included) vanished with no target to land on.

test('T15a: reply echoing a ledgered turn_id passes that turn\'s msgId to the dispatcher', async () => {
  const dispatched = [];
  const { proc, written } = makeProc({
    toolDispatcher: async (call) => { dispatched.push(call); return { ok: true, message_id: 7 }; },
  });
  const { sendP, turnId } = startTurn(proc, written);

  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-1',
    args: { chat_id: '12345', turn_id: turnId, text: 'hello' },
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sourceMsgId, 1,
    'the dispatcher must receive the originating TG msg_id (as a NUMBER, like every other delivery call site) so solo-emoji replies can react instead of dropping');

  proc.pendingTurns.forEach(p => p.resolve({}));
  await sendP.catch(() => {});
  proc.kill?.();
});

test('T15b: reply with unknown/absent turn_id falls back to the single pending turn\'s msgId', async () => {
  const dispatched = [];
  const { proc, written } = makeProc({
    toolDispatcher: async (call) => { dispatched.push(call); return { ok: true, message_id: 7 }; },
  });
  const { sendP } = startTurn(proc, written);

  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-2',
    args: { chat_id: '12345', text: 'hello' },   // no turn_id echoed
  });
  assert.equal(dispatched[0].sourceMsgId, 1,
    'single pending turn = unambiguous; mirror _recordReplyForPendingTurn\'s fallback');

  proc.pendingTurns.forEach(p => p.resolve({}));
  await sendP.catch(() => {});
  proc.kill?.();
});

test('T15c: no pending turns + unknown turn_id → null sourceMsgId (never misattribute)', async () => {
  const dispatched = [];
  const { proc } = makeProc({
    toolDispatcher: async (call) => { dispatched.push(call); return { ok: true, message_id: 7 }; },
  });
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-3',
    args: { chat_id: '12345', turn_id: 'ffffffff-0000-0000-0000-000000000000', text: 'late' },
  });
  assert.equal(dispatched[0].sourceMsgId ?? null, null,
    'an unattributable reply must not react to / quote an unrelated message');
  proc.kill?.();
});

test('T15d: only the FIRST delivered reply of a turn carries the quote target (review F1)', async () => {
  // On SDK, deliverReplies fires once per turn → one quote. On channels the
  // dispatcher fires once per reply tool call; an N-reply turn must not
  // produce N bubbles all quote-quoting the same user message.
  const dispatched = [];
  const { proc, written } = makeProc({
    toolDispatcher: async (call) => { dispatched.push(call); return { ok: true, message_id: 7 }; },
  });
  const { sendP, turnId } = startTurn(proc, written);

  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-d1',
    args: { chat_id: '12345', turn_id: turnId, text: 'part one' },
  });
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-d2',
    args: { chat_id: '12345', turn_id: turnId, text: 'part two' },
  });
  assert.equal(dispatched[0].sourceMsgId, 1, 'first reply quotes');
  assert.equal(dispatched[1].sourceMsgId ?? null, null, 'second reply of the same turn must NOT re-quote');

  proc.pendingTurns.forEach(p => p.resolve({}));
  await sendP.catch(() => {});
  proc.kill?.();
});

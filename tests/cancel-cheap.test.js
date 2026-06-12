'use strict';

/**
 * Cheap turn-cancel — CliProcess.interrupt() contract
 * (docs/0.13-cancel-efficiency-and-delete-trigger-spec.md, Ask A).
 *
 * The adversarial review (v3) proved the naive "just call interrupt()" plan
 * has a BLOCKER: interrupt's 5s grace synthesizes the resolution WITHOUT
 * _finalizeTurn, leaving the cancelled turn's InputLedger entries 'written'.
 * A later cycle-end sweep can then declare the cancelled autosteer input
 * dropped → drop-redeliver re-injects it → the user's CANCELLED message gets
 * answered minutes after they stopped it.
 *
 * Contract pinned here:
 *   C1 — interrupt() transitions every non-terminal ledger entry of the
 *        cancelled work to 'cancelled' (a no-redeliver terminal state); a
 *        later sweep must emit ZERO input-dropped for them.
 *   C2 — double-interrupt is a no-op: ONE C-c only (a second C-c at the
 *        now-idle prompt is claude's EXIT chord — re-sending converts the
 *        cheap cancel into an accidental kill), and the grace timer is NOT
 *        reset (a user double-tapping "stop" must not DELAY resolution).
 *   C3 — the grace resolution leaves no live per-pending machinery: timers
 *        cleared, stop-hook listener detached, inFlight false.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('../lib/process/cli-process');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeProc(opts = {}) {
  const events = [];
  const written = [];
  const keys = [];
  const proc = new CliProcess({
    sessionKey: 'sess-c', chatId: '12345',
    tmuxRunner: {
      sendControl: async (_n, key) => { keys.push(key); },
      killSession: async () => {},
      captureWide: async () => opts.pane ?? '',
    },
    botName: 'testbot', claudeBin: '/usr/bin/false',
    toolDispatcher: opts.toolDispatcher || (async () => ({ ok: true, message_id: 1 })),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    stopGraceMs: 30,
    turnQuietMs: 60_000,
    activityQuietMs: 60_000,
    turnTimeoutMs: 60_000,
    turnAbsoluteMs: 60_000,
    dropConfirmMs: opts.dropConfirmMs ?? 50,
    deliveryWatchdogMs: 60_000,
    interruptGraceMs: opts.interruptGraceMs ?? 40,
  });
  proc.bridgeReady = true;
  proc.bridgeServer = {
    writeMessage: (obj) => { written.push(obj); return true; },
    destroyConnection: () => {},
  };
  proc.tmuxSession = 'pgr-testbot-channels-c';
  return { proc, events, written, keys };
}

function startTurn(proc, written, text = 'long task') {
  const before = written.length;
  const sendP = proc.send(text, { context: { sourceMsgId: 7 } });
  sendP.catch(() => {});
  const userMsg = written.slice(before).find((w) => w.kind === 'user_msg');
  return { sendP, turnId: userMsg.turn_id };
}

const upsFor = (turnId) => ({
  type: 'UserPromptSubmit',
  prompt: `<channel source="polygram-bridge" chat_id="12345" user="u" msg_id="9" turn_id="${turnId}">x</channel>`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('C1 (BLOCKER): cancelled turn\'s autosteer ledger entry is terminal — a later sweep re-delivers NOTHING', async () => {
  const { proc, events, written } = makeProc({ dropConfirmMs: 40, interruptGraceMs: 30 });
  const dropped = [];
  proc.on('input-dropped', (e) => dropped.push(e));

  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));                                   // primary seen

  proc.injectUserMessage({ content: 'follow-up the user later cancels', msgId: 43, source: 'autosteer' });
  const foldId = written.filter(w => w.kind === 'user_msg').slice(-1)[0].turn_id;

  // claude's pre-cancel reply observed the consumed_turn_ids contract but did
  // NOT cover the fold — the exact prod shape that later classifies the
  // stale 'written' entry as a confirmable DROP (not fold-suspected).
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-c1',
    args: { chat_id: '12345', turn_id: turnId, text: 'partial…', consumed_turn_ids: [turnId] },
  });

  await proc.interrupt();           // the user cancelled
  await sleep(60);                  // grace fires, turn synth-resolves
  await sendP.catch(() => {});

  // Any later cycle-end runs the sweep (this is what every _finalizeTurn does).
  proc._armDropConfirmSweep();
  await sleep(80);                  // past dropConfirmMs

  assert.equal(dropped.length, 0,
    'the CANCELLED autosteer input must never be declared dropped → re-delivered');
  assert.ok(!events.some(e => e.kind === 'input-dropped'),
    'no input-dropped event for cancelled inputs');
  const fold = proc.inputLedger.get(foldId);
  assert.ok(fold && fold.state !== 'written' && fold.state !== 'seen',
    `the fold entry must be terminal after cancel, got: ${fold?.state}`);
  proc.kill?.();
});

test('C2: double-interrupt sends ONE C-c and does not reset the grace (no delayed resolution, no exit chord)', async () => {
  const { proc, written, keys } = makeProc({ interruptGraceMs: 60 });
  const { sendP } = startTurn(proc, written);

  const t0 = Date.now();
  await proc.interrupt();
  await sleep(25);
  await proc.interrupt();           // user double-taps "stop" inside the grace

  const result = await sendP;       // must resolve at ~t0+60, NOT t0+25+60
  const elapsed = Date.now() - t0;
  assert.equal(keys.filter(k => k === 'C-c').length, 1,
    'a second C-c at the idle prompt is claude\'s exit chord — never re-send while a cancel is in flight');
  assert.ok(elapsed < 110,
    `double-tap must not delay the synthetic resolution (took ${elapsed}ms; grace=60)`);
  assert.equal(result.metrics.resultSubtype, 'interrupted');
  proc.kill?.();
});

test('C3: grace resolution leaves no live turn machinery', async () => {
  const { proc, written, events } = makeProc({ interruptGraceMs: 30 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));

  // a delivered reply arms the activity-quiet rung — the cancelled turn's
  // timer must not survive the synthetic resolution
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-c3',
    args: { chat_id: '12345', turn_id: turnId, text: 'partial…' },
  });

  await proc.interrupt();
  await sleep(50);
  await sendP.catch(() => {});

  assert.equal(proc.pendingTurns.size, 0);
  assert.equal(proc.inFlight, false);
  const before = events.length;
  await sleep(120);                 // well past all short timers in this fixture
  const late = events.slice(before).filter(e =>
    ['cli-activity-quiet-finalize', 'cli-turn-resolved-by-stop'].includes(e.kind));
  assert.deepEqual(late, [], 'no finalizer machinery may fire after the synthetic interrupt resolution');
  proc.kill?.();
});

test('C4 (BLOCKER): a NEW turn started during the interrupt grace is NOT swallowed as interrupted', async () => {
  // Multi-agent review 2026-06-12: the grace timer iterated pendingTurns LIVE
  // and resolved EVERY pending it found — including a fresh turn the user
  // started after the cancelled one finalized. That silently kills the exact
  // "stop, then redirect" flow cheap-cancel exists for. The grace must only
  // resolve the turns that were in flight AT interrupt() time.
  const { proc, written } = makeProc({ interruptGraceMs: 80, stopGraceMs: 10 });
  const t0 = startTurn(proc, written, 'first task');
  proc._handleHookEvent(upsFor(t0.turnId));

  // claude acks the C-c: a reply lands and the turn finalizes cleanly DURING
  // the grace window (this is the common case — interrupt is graceful).
  await proc.interrupt();
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-c4',
    args: { chat_id: '12345', turn_id: t0.turnId, text: 'stopped mid-task', consumed_turn_ids: [t0.turnId] },
  });
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: '' });
  await sleep(20);                     // t0 settles via stop-grace, still inside the 80ms interrupt grace
  const r0 = await t0.sendP.catch((e) => ({ thrown: e }));

  // the user now redirects with a brand-new turn — still inside the grace
  const t1 = startTurn(proc, written, 'actually do THIS instead');
  proc._handleHookEvent(upsFor(t1.turnId));
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 'tc-c4b',
    args: { chat_id: '12345', turn_id: t1.turnId, text: 'on it', consumed_turn_ids: [t1.turnId] },
  });
  await sleep(120);                    // let the stale grace fire (and the new turn settle)
  proc.pendingTurns.forEach(p => p.resolve?.({ metrics: {} }));
  const r1 = await t1.sendP;

  assert.notEqual(r1?.metrics?.resultSubtype, 'interrupted',
    'a turn started AFTER the cancel must never be resolved as interrupted by the stale grace');
  proc.kill?.();
});

test('C5: a follow-up injected DURING the interrupt grace does not autosteer into cancelled work', async () => {
  // Review #2: inject can run during the grace (inFlight still true) and add a
  // fresh 'written' ledger entry the cancel-loop already passed → later
  // re-delivery. A cancel is in flight: the inject must be refused so the
  // caller queues it as a fresh turn instead of merging into stopped work.
  const { proc, written } = makeProc({ interruptGraceMs: 80 });
  const t0 = startTurn(proc, written, 'task');
  proc._handleHookEvent(upsFor(t0.turnId));

  await proc.interrupt();
  const ok = proc.injectUserMessage({ content: 'follow-up during grace', msgId: 71, source: 'autosteer' });
  assert.equal(ok, false, 'inject must be refused while a cancel grace is in flight');

  await sleep(120);
  proc.pendingTurns.forEach(p => p.resolve?.({ metrics: {} }));
  await t0.sendP.catch(() => {});
  // no autosteer ledger entry should be sitting 'written'
  const stray = [...proc.inputLedger.values()].filter(e => e.source === 'autosteer' && (e.state === 'written' || e.state === 'seen'));
  assert.equal(stray.length, 0, 'no during-grace autosteer entry left re-deliverable');
  proc.kill?.();
});

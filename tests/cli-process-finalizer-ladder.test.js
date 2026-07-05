'use strict';

/**
 * 0.13 P1 — D1 finalizer ladder (docs/0.13-channels-lifecycle-design.md §3 D1).
 *
 * The channels turn no longer finalizes on the reply-quiet heuristic when the
 * hook stream is live. The ladder:
 *   rung 1  attributed Stop (pending.seen via UPS-envelope parse OR ≥1 bound reply;
 *           never when stop_hook_active=true) — finalizes through stop-grace, and
 *           any same-session activity during the grace CANCELS it (stale/lagged Stop).
 *   rung 2  activity-quiet window (hooks + pane thinking heartbeat + bridge tool
 *           calls + replies all reset it; requires ≥1 delivered reply; suspended
 *           while a question is open).
 *   rung 3  legacy reply-quiet — ONLY for sessions where hooks never came up.
 *   rung 4  ceilings — but a ceiling on a REPLIED turn resolves with its replies
 *           (cli-turn-ceiling-resolved) instead of rejecting TURN_TIMEOUT, and
 *           open questions are resolved {timedout} first.
 *
 * TDD discipline: every test in this file (except the rung-3 legacy guard, which
 * pins behavior preservation) FAILS against the pre-D1 cli-process.js — the
 * red→green transition is surfaced in the commit message.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('@shumkov/orchestra');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProc(opts = {}) {
  const events = [];
  const written = [];
  const sendCalls = [];
  const proc = new CliProcess({
    sessionKey: 'sess-1',
    chatId: '12345',
    tmuxRunner: {
      sendControl: async (name, key) => { sendCalls.push({ name, key }); },
      killSession: async () => {},
      captureWide: async () => opts.pane ?? '',
    },
    botName: 'testbot',
    claudeBin: '/usr/bin/false',
    toolDispatcher: opts.toolDispatcher || (async () => ({ ok: true, message_id: 1 })),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    stopGraceMs: opts.stopGraceMs ?? 40,
    turnQuietMs: opts.turnQuietMs ?? 30,
    turnTimeoutMs: opts.turnTimeoutMs ?? 60_000,
    turnAbsoluteMs: opts.turnAbsoluteMs ?? 60_000,
    activityQuietMs: opts.activityQuietMs ?? 120,
    maxRepliesPerTurn: opts.maxRepliesPerTurn ?? 20,
  });
  proc.bridgeReady = true;
  proc.bridgeServer = { writeMessage: (obj) => { written.push(obj); } };
  proc.tmuxSession = 'pgr-testbot-channels-abc';
  return { proc, events, written, sendCalls };
}

// Start a turn and capture the turn_id the bridge write carried.
function startTurn(proc, written, text = 'do the thing') {
  const before = written.length;
  const sendP = proc.send(text, { context: { sourceMsgId: 1 } });
  sendP.catch(() => {});
  const userMsg = written.slice(before).find((w) => w.kind === 'user_msg');
  assert.ok(userMsg, 'send() wrote a user_msg');
  return { sendP, turnId: userMsg.turn_id };
}

// A realistic UserPromptSubmit hook payload for a channel pickup: the prompt
// carries the bridge-authored envelope (verified in the P0 spike — Q1).
function upsFor(turnId, body = 'hello') {
  return {
    type: 'UserPromptSubmit',
    prompt: `<channel source="polygram-bridge" chat_id="12345" user="probe" msg_id="1" turn_id="${turnId}">${body}</channel>`,
  };
}

const ASK_ARGS = {
  chat_id: '12345',
  questions: [{ header: 'Pick', question: 'pick one', options: [{ label: 'a' }, { label: 'b' }] }],
};

// ─── L1: the reply-then-ask shape (bug #2's root, seam S2) ──────────────────
// Today the reply arms a 2s quiet window the ask cannot park, so the turn
// finalizes ~4s into the question wait and everything per-turn dies (verified
// in prod: question 23745077 resolved 21ms after the ask). Under D1 the open
// question suspends rung 2 and the turn survives the whole wait.

test('L1: reply-then-ask — the turn survives the question wait and finalizes after the answer', async () => {
  const { proc, events, written } = makeProc({ activityQuietMs: 120, stopGraceMs: 40, turnQuietMs: 30 });
  const { sendP, turnId } = startTurn(proc, written);

  proc._handleHookEvent(upsFor(turnId));                       // pickup → seen, hooks live
  proc._recordReplyForPendingTurn('here is my answer — but first:', turnId);
  await proc._dispatchToolCall({ name: 'ask', tool_call_id: 'q1', args: ASK_ARGS });

  await sleep(320);   // >> reply-quiet + grace AND >> activityQuietMs
  assert.equal(proc.pendingTurns.size, 1,
    'the turn must stay pending through the ask wait (rung 2 suspended while a question is open)');

  proc.writeQuestionAnswer('q1', { answers: [{ header: 'Pick', selected: ['a'] }] });
  await sleep(220);   // > activityQuietMs — rung 2 resumed by the answer
  assert.equal(proc.pendingTurns.size, 0, 'the turn finalizes via activity-quiet after the answer');

  const result = await sendP;
  assert.equal(result.alreadyDelivered, true, 'reply-tool text was already delivered');
  assert.ok(events.find((e) => e.kind === 'cli-activity-quiet-finalize'),
    'rung-2 finalize is observable in the events DB');
  await proc.kill('test');
});

// ─── L2: a foreign cycle's Stop must not finalize an unseen pending ─────────
// (Seam S5's Stop-identity gap; reachable today: a /compact or wakeup cycle's
// Stop closes a queued user turn with the FOREIGN cycle's text as its answer.)

test('L2: foreign-cycle Stop does NOT finalize an unseen, reply-less pending', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 40 });
  const { sendP, turnId } = startTurn(proc, written);
  void turnId;

  // No UPS for this pending — claude never picked it up (it is queued behind a
  // foreign cycle). The foreign cycle ends:
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'foreign /compact summary text' });
  await sleep(120);   // > stopGraceMs

  assert.equal(proc.pendingTurns.size, 1,
    'an unattributable Stop must never finalize the pending (the foreign text would have been delivered as its answer)');
  assert.ok(events.find((e) => e.kind === 'cli-stop-foreign'),
    'the ignored foreign Stop is observable in the events DB');

  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── L3: attributed Stop finalizes through a grace that activity cancels ────
// (Round-2 panel finding: Stop arrives via the ndjson tail with 250ms–5s lag;
// a lagged foreign Stop can land after our fast first pickup — activity during
// the grace proves the Stop stale.)

test('L3: in-grace activity cancels an attributed Stop; the NEXT Stop finalizes', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 80, activityQuietMs: 60_000, turnQuietMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);

  proc._handleHookEvent(upsFor(turnId));                       // seen → attributable
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'stale stop' });
  assert.equal(proc.pendingTurns.size, 1, 'attributed Stop must not finalize synchronously (grace window)');

  await sleep(25);
  proc._handleHookEvent({ type: 'PreToolUse', toolName: 'Bash' });   // claude is demonstrably still working
  await sleep(140);   // well past the original grace
  assert.equal(proc.pendingTurns.size, 1, 'activity inside the grace cancels the stale Stop finalize');
  assert.ok(events.find((e) => e.kind === 'cli-stop-grace-cancelled'));

  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'real end' });
  await sleep(140);   // grace completes undisturbed
  assert.equal(proc.pendingTurns.size, 0, 'the real Stop finalizes after an undisturbed grace');
  const result = await sendP;
  assert.equal(result.text, 'real end', 'text falls back to the REAL stop\'s last_assistant_message');
  await proc.kill('test');
});

// ─── L4: pure-thinking tail — the pane heartbeat is activity ────────────────
// (Round-2 panel finding: pure-thinking gaps exceed 45s with ZERO hooks; a
// hook-only quiet clock would finalize mid-thought. The pane "esc to interrupt"
// heartbeat bounds busy-phase gaps at ~5s and must reset rung 2.)

test('L4: pane thinking heartbeat keeps a replied turn alive; rung 2 fires only when the tail goes quiet', async () => {
  const { proc, events, written } = makeProc({
    pane: 'working…\nesc to interrupt', activityQuietMs: 120, turnQuietMs: 60_000, stopGraceMs: 30,
  });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._recordReplyForPendingTurn('quick ack', turnId);         // rung 2 armed

  for (let i = 0; i < 6; i++) {                                 // ~300ms of thinking heartbeats
    await proc._pollMidTurnDialogs();
    await sleep(50);
  }
  assert.equal(proc.pendingTurns.size, 1,
    'pane heartbeat (claude thinking, zero hooks) must keep resetting the activity-quiet clock');

  await sleep(240);                                             // heartbeats stopped → tail quiet
  assert.equal(proc.pendingTurns.size, 0, 'rung 2 finalizes once the whole activity surface is quiet');
  assert.ok(events.find((e) => e.kind === 'cli-activity-quiet-finalize'));
  const result = await sendP;
  assert.equal(result.alreadyDelivered, true);
  await proc.kill('test');
});

// ─── L5: ceilings resolve replied turns instead of rejecting ────────────────
// (Round-2 panel finding: the absolute ceiling REJECTING a turn whose answer
// was already delivered sends a scary timeout after a successful reply.)

test('L5a: absolute ceiling on a REPLIED turn resolves with its replies (no TURN_TIMEOUT)', async () => {
  const { proc, events, written } = makeProc({
    turnAbsoluteMs: 100, activityQuietMs: 60_000, turnQuietMs: 60_000, stopGraceMs: 30,
  });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._recordReplyForPendingTurn('partial but delivered answer', turnId);

  const result = await sendP;   // the ceiling fires ~100ms in
  assert.equal(result.text, 'partial but delivered answer');
  assert.equal(result.alreadyDelivered, true);
  assert.ok(events.find((e) => e.kind === 'cli-turn-ceiling-resolved'),
    'ceiling-resolve is observable (distinct from TURN_TIMEOUT)');
  await proc.kill('test');
});

test('L5b: absolute ceiling on a ZERO-reply turn still rejects TURN_TIMEOUT', async () => {
  const { proc, written } = makeProc({ turnAbsoluteMs: 80, activityQuietMs: 60_000, turnQuietMs: 60_000 });
  const { sendP } = startTurn(proc, written);
  await assert.rejects(sendP, (err) => err.code === 'TURN_TIMEOUT',
    'nothing was delivered — the timeout rejection (and its user-facing error) is correct here');
  await proc.kill('test');
});

// ─── L6: a question WAITS for the user — the ceiling does NOT time it out ────
// 0.17.4: pre-fix the absolute cap force-answered the ask {timedout} at ~30 min and
// killed the turn. A question should wait for the answer however long it takes; the
// turn ceiling now defers while a question is open. docs/progress-is-not-turn-end-spec.md
test('L6: a question is NOT timed out at the ceiling — the turn WAITS for the answer', async () => {
  const { proc, events, written } = makeProc({ turnAbsoluteMs: 50, activityQuietMs: 60_000, turnQuietMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);
  sendP.catch(() => {});
  proc._handleHookEvent(upsFor(turnId));
  await proc._dispatchToolCall({ name: 'ask', tool_call_id: 'qq', args: ASK_ARGS });

  await sleep(220);   // >> turnAbsoluteMs — pre-fix the ceiling would have timed the question out
  assert.equal(proc.pendingTurns.size, 1, 'the turn stays alive — a question waits for the user');
  assert.equal(proc._openQuestions.size, 1, 'the question stays open (NOT force-answered {timedout})');
  assert.ok(!written.find((w) => w.kind === 'question_answer' && w.result?.timedout),
    'the ask must NOT be force-answered {timedout} at the ceiling');
  assert.ok(events.find((e) => e.kind === 'cli-question-wait-extended'),
    'the wait-extension is observable; cli-question-timedout-at-ceiling must NOT fire');
  assert.ok(!events.find((e) => e.kind === 'cli-question-timedout-at-ceiling'), 'no ceiling timeout');

  // answering it resolves the question normally
  proc.writeQuestionAnswer('qq', { answers: [{ header: 'Pick', selected: ['a'] }] });
  assert.equal(proc._openQuestions.size, 0, 'answered → the question clears and the turn resumes');
  await proc.kill('test');
});

// ─── L7: the UPS-seen parser (the P1 ledger slice) ──────────────────────────
// (P0 spike Q1: the UPS prompt carries the bridge-authored envelope. The
// parser anchors on the raw `<channel ` prefix — body text can never contain
// a raw `<` (bridge body-escape), so a pasted/spoofed turn_id cannot mark seen.)

test('L7a: UPS with the channel envelope marks the pending seen', async () => {
  const { proc, events, written } = makeProc({});
  const { sendP, turnId } = startTurn(proc, written);

  proc._handleHookEvent(upsFor(turnId));

  const pending = proc.pendingTurns.get(turnId);
  assert.equal(pending.seen, true, 'envelope turn_id match must mark the pending seen');
  const evt = events.find((e) => e.kind === 'cli-ups-seen');
  assert.ok(evt, 'cli-ups-seen telemetry fires');
  assert.equal(evt.detail.turn_id, turnId);
  assert.equal('text' in (evt.detail || {}), false, 'never log prompt content (L13 convention)');

  sendP.catch(() => {});
  await proc.kill('test');
});

test('L7b: a turn_id pasted in body text (no raw <channel prefix) does NOT mark seen', async () => {
  const { proc, written } = makeProc({});
  const { sendP, turnId } = startTurn(proc, written);

  // Spoof shape: the uuid appears, but not inside a bridge-authored raw tag —
  // e.g. a user pasted an old envelope; the bridge body-escape turns its `<`
  // into `&lt;` so the raw prefix can only ever be bridge-authored.
  proc._handleHookEvent({
    type: 'UserPromptSubmit',
    prompt: `&lt;channel turn_id="${turnId}"&gt; pasted log line turn_id="${turnId}"`,
  });

  assert.notEqual(proc.pendingTurns.get(turnId).seen, true,
    'spoofed/pasted turn_id must not count as pickup');
  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── L8: stop_hook_active=true means the cycle is NOT over ──────────────────

test('L8: Stop with stop_hook_active=true never finalizes (forced continuation)', async () => {
  const { proc, written } = makeProc({ stopGraceMs: 40, activityQuietMs: 60_000, turnQuietMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._recordReplyForPendingTurn('answer so far', turnId);

  proc._handleHookEvent({ type: 'Stop', stopHookActive: true, lastAssistantMessage: 'not really done' });
  await sleep(120);   // > grace
  assert.equal(proc.pendingTurns.size, 1,
    'a stop-hook-forced continuation Stop must not close the turn');
  sendP.catch(() => {});
  await proc.kill('test');
});

// ─── L9: legacy guard — hooks-never-alive sessions keep today's exact path ──
// (Rung 3. This test must pass BOTH before and after D1: byte-identical
// behavior for the hook-dead session class.)

test('L9: hook-never-alive session — reply-quiet + stop-grace finalize exactly as today', async () => {
  const { proc, written } = makeProc({ turnQuietMs: 40, stopGraceMs: 40 });
  const { sendP, turnId } = startTurn(proc, written);

  // NO hook events at all (_sawHookStream stays false).
  proc._recordReplyForPendingTurn('legacy answer', turnId);

  const result = await sendP;   // quiet 40ms + grace 40ms
  assert.equal(result.text, 'legacy answer');
  assert.equal(result.alreadyDelivered, true);
  assert.equal(proc.pendingTurns.size, 0);
  await proc.kill('test');
});

// ─── L10: the single-active-cycle invariant becomes an observable assertion ─

test('L10: a second concurrent pending logs the multi-pending assertion event (drop-rather-than-misattribute)', async () => {
  const { proc, events, written } = makeProc({});
  const a = startTurn(proc, written, 'first');
  const b = startTurn(proc, written, 'second');   // violates the daemon-side stdinLock contract

  assert.ok(events.find((e) => e.kind === 'cli-multi-pending-assert'),
    'the unreachable-in-prod state must be loudly observable, never silent');

  a.sendP.catch(() => {}); b.sendP.catch(() => {});
  await proc.kill('test');
});

// ─── L11: the maxRepliesPerTurn cap no longer instant-resolves under live hooks ─
// (Seam S1's third premature-finalize trigger: ≥20 replies resolved IMMEDIATELY
// mid-work. Under D1 the cap defers to rung 2; the ceilings bound true runaways.)

test('L11: reply cap under live hooks defers to activity-quiet instead of resolving instantly', async () => {
  const { proc, events, written } = makeProc({
    maxRepliesPerTurn: 3, activityQuietMs: 150, turnQuietMs: 60_000, stopGraceMs: 30,
  });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._recordReplyForPendingTurn('one', turnId);
  proc._recordReplyForPendingTurn('two', turnId);
  proc._recordReplyForPendingTurn('three', turnId);             // cap reached

  await sleep(90);    // > old grace path — today the cap has already finalized by now
  assert.equal(proc.pendingTurns.size, 1,
    'cap must not instant-resolve a turn claude is still working');

  await sleep(200);   // > activityQuietMs with no further activity
  assert.equal(proc.pendingTurns.size, 0, 'rung 2 finalizes the capped turn once truly quiet');
  const result = await sendP;
  assert.equal(result.text, 'one\n\ntwo\n\nthree');
  assert.ok(events.find((e) => e.kind === 'cli-activity-quiet-finalize'));
  await proc.kill('test');
});

// ─── L12: consumed-ack must NOT suppress a substantive Stop-fallback answer ──
// Prod 2026-06-13 (Shumabit@UMI/37, msg 2956): two folded inbounds; claude sent a
// 294-char "Researching now…" ack via reply() AND named the sibling turn in
// consumed_turn_ids, then produced the REAL 2066-char answer as plain assistant
// text (no reply tool call) → Stop fallback. _finalizeTurn marked the turn
// alreadyDelivered (just because _consumedAcked was set) and polygram.js's
// short-circuit sent NOTHING — the partner waited 5h20m in silence.
// docs/0.13-consumed-ack-stop-fallback-drop-spec.md
test('L12: consumed-ack ack ≠ Stop-fallback answer → deliver the rescued answer (no silent drop)', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 40, activityQuietMs: 60_000, turnQuietMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);

  proc._handleHookEvent(upsFor(turnId));                       // pickup → seen, hooks live
  // A SIBLING reply consumed this turn but delivered only a short ack:
  proc._ledgerAckConsumed([turnId], 'Researching WhatsApp call options now…');
  // claude then produced the real answer as plain assistant text (no reply tool call):
  const answer = 'Research done — SIP mode → self-hosted PBX keeps Chatwoot for chat AND accepts WhatsApp calls. [2066 chars in prod]';
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: answer });

  await sleep(120);   // > stopGrace
  assert.equal(proc.pendingTurns.size, 0, 'the consumed-acked turn finalizes via the Stop fallback');

  const result = await sendP;
  assert.equal(result.alreadyDelivered, false,
    'the ack did NOT deliver this answer → the turn must NOT be marked already-delivered (else polygram short-circuits and drops it)');
  assert.equal(result.text, answer, 'the rescued Stop-fallback answer is carried for delivery');
  assert.ok(events.find((e) => e.kind === 'cli-consumed-ack-fallback-rescued'),
    'the rescue is observable in the events DB (forensic signal the fix fired)');
  await proc.kill('test');
});

// ─── L13: genuine fold-echo stays suppressed (no double-delivery regression) ──
// When the consuming reply DID carry the answer and claude echoed the consumed
// turn_id, the Stop fallback text equals what was already delivered — re-sending
// would double-answer. This must remain suppressed before AND after the L12 fix.
test('L13: consumed-ack ack == Stop-fallback text → stays already-delivered (no duplicate)', async () => {
  const { proc, written } = makeProc({ stopGraceMs: 40, activityQuietMs: 60_000, turnQuietMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);

  proc._handleHookEvent(upsFor(turnId));
  const folded = 'Here is the combined answer covering both of your messages.';
  proc._ledgerAckConsumed([turnId], folded);                  // sibling delivered the full answer
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: folded });   // same text echoes back

  await sleep(120);
  assert.equal(proc.pendingTurns.size, 0, 'the folded turn finalizes');

  const result = await sendP;
  assert.equal(result.alreadyDelivered, true,
    'the consuming reply already delivered this exact text → must stay suppressed (no double-delivery)');
  await proc.kill('test');
});

// ─── L14: a zero-reply ceiling captures the wedge pane (0.12.3 telemetry) ────
// docs/0.13-turn-wedge-autorecovery-spec.md — characterize-first: when a turn
// hits a ceiling with no reply (claude wedged — no hooks AND no streaming hint
// the whole window), capture the TUI pane tail so we learn WHAT state claude is
// stuck in. Fire-and-forget, never touches the kill path.
test('L14: zero-reply ceiling emits turn-timeout-pane with the captured wedge pane', async () => {
  const stuckPane = 'Sautéed for 31m\n  …(truncated)…\n❯  ';   // idle ❯, NO "esc to interrupt" = wedged
  const { proc, events, written } = makeProc({
    turnAbsoluteMs: 60, activityQuietMs: 60_000, turnQuietMs: 60_000, pane: stuckPane,
  });
  const { sendP } = startTurn(proc, written);
  await assert.rejects(sendP, (err) => err.code === 'TURN_TIMEOUT',
    'zero replies → the ceiling still rejects (behavior unchanged)');
  await sleep(40);   // let the fire-and-forget probeBusyState + log resolve
  const ev = events.find((e) => e.kind === 'turn-timeout-pane');
  assert.ok(ev, 'wedge-characterization event is emitted on a zero-reply ceiling');
  assert.ok(ev.detail.pane_tail && ev.detail.pane_tail.includes('❯'),
    'captures the TUI pane tail (the stuck-state diagnostic)');
  assert.equal(ev.detail.streaming, false, 'a wedged turn shows no "esc to interrupt" streaming hint');
  await proc.kill('test');
});

// ─── L9: a status (interim) reply is NOT the turn's answer ──────────────────
// Field incident (shumabit@UMI "conversion" topic, 2026-06-22): claude replied
// "Loading… give me a couple min", did the work in a sub-agent, then ENDED the
// turn — and polygram dropped the produced answer because a reply tool call had
// fired (the status). The real answer sat undelivered for 19 min until the user
// prodded. A status reply must not count as the answer; the produced final must
// be delivered. docs/progress-is-not-turn-end-spec.md

test('L9: interim-only turn → the produced final answer is DELIVERED (not the status)', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 30 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));                          // pickup → seen, hooks live
  // claude posts a STATUS (interim) reply, then ends the turn with no final reply…
  proc._recordReplyForPendingTurn('📱 Loading your product page… give me a couple min', turnId, true);
  // …but it DID produce the real answer as its last assistant message.
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'Both answered with data: the real analysis.' });
  await sleep(90);   // > stopGraceMs

  const result = await sendP;
  assert.equal(proc.pendingTurns.size, 0, 'turn finalized');
  assert.equal(result.text, 'Both answered with data: the real analysis.',
    'the produced final answer is delivered — not the interim status promise');
  assert.equal(result.alreadyDelivered, false,
    'the final was never sent via the reply tool (only the status was) — polygram MUST deliver it');
  assert.ok(events.find((e) => e.kind === 'cli-interim-only-final-rescued'),
    'the rescue is observable in the events DB');
  await proc.kill('test');
});

test('L9b: a real (non-interim) reply still suppresses the stop-fallback (no regression)', async () => {
  const { proc, written } = makeProc({ stopGraceMs: 30 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._recordReplyForPendingTurn('hello', turnId);              // FINAL reply (no interim flag)
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'ignored-when-a-final-reply-exists' });
  await sleep(90);

  const result = await sendP;
  assert.equal(result.text, 'hello', 'uses the reply-tool text');
  assert.equal(result.alreadyDelivered, true, 'already delivered incrementally — must not re-send');
  await proc.kill('test');
});

test('L9c: interim-only with NO produced answer → status stays, nothing re-sent (no double-send)', async () => {
  const { proc, written } = makeProc({ stopGraceMs: 30 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._recordReplyForPendingTurn('⏳ on it…', turnId, true);    // interim only
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: '' });   // no answer produced
  await sleep(90);

  const result = await sendP;
  assert.equal(result.alreadyDelivered, true,
    'only a status was delivered and no answer was produced — do NOT re-send the status');
  await proc.kill('test');
});

test('L9d: interim:true threads through the reply tool args (full dispatch path)', async () => {
  const { proc, written } = makeProc({ stopGraceMs: 30 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  await proc._dispatchToolCall({
    name: 'reply', tool_call_id: 's1',
    args: { chat_id: '12345', turn_id: turnId, text: 'Working on it…', interim: true },
  });
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'The final result.' });
  await sleep(90);

  const result = await sendP;
  assert.equal(result.text, 'The final result.',
    'interim:true via tool args → the status is not the answer; the produced final is delivered');
  assert.equal(result.alreadyDelivered, false);
  await proc.kill('test');
});

// L9e: the SAME rescue must apply when an interim-only turn resolves at a CEILING
// (idle / hard-max) instead of via Stop — else the produced answer is dropped there
// instead (the M1 review finding: the fix was complete for the Stop path but the
// fireTimeout ceiling-resolve still delivered the status). docs/progress-is-not-turn-end-spec.md
test('L9e: interim-only turn resolving at the CEILING also delivers the produced answer', async () => {
  const { proc, events, written } = makeProc({
    stopGraceMs: 300, turnQuietMs: 5000, activityQuietMs: 5000, turnTimeoutMs: 80,
  });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));                          // pickup → seen, hooks live
  proc._recordReplyForPendingTurn('⏳ give me a couple min', turnId, true);   // interim only
  // claude's Stop lands carrying the real produced answer (begins the grace, sets _stopHookData)…
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'THE REAL PRODUCED ANSWER' });
  // …but same-session activity cancels the grace (stale/lagged Stop); _stopHookData stays set.
  proc._handleHookEvent(upsFor(turnId, 'still working'));
  // now the idle ceiling fires (no further activity) → the fireTimeout resolve path.
  await sleep(180);   // > turnTimeoutMs (80)

  const result = await sendP;
  assert.equal(proc.pendingTurns.size, 0, 'turn resolved at the ceiling');
  assert.equal(result.text, 'THE REAL PRODUCED ANSWER',
    'the produced final answer is delivered at the CEILING too — not the status promise');
  assert.equal(result.alreadyDelivered, false, 'the answer was never sent via the reply tool — deliver it');
  assert.ok(events.find((e) => e.kind === 'cli-interim-only-final-rescued'),
    'the rescue fires on the ceiling path, not just the Stop path');
  await proc.kill('test');
});

// L10: a Stop that fires while a sub-agent is still running must NOT finalize the
// turn (clearing the reaction mid-work). It DEFERS until the sub-agent drains, then
// finalizes + delivers the produced answer. Field: return topic 2026-06-23 — the
// turn resolved-by-stop at 14:31:03 while sub-agents ran to 14:33:26, clearing the
// 👾 reaction while work continued. docs/progress-is-not-turn-end-spec.md
test('L11: stop-grace DEFERS while a sub-agent is in flight; finalizes + delivers when it drains', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 25, turnTimeoutMs: 5000 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));                                       // pickup → seen
  proc._recordReplyForPendingTurn('Processing your comments…', turnId, true);  // status (interim)
  proc._pendingSubagentStarts = [{ agentType: 'g', toolUseId: 'a1' }];         // a sub-agent is running
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'boundary/partial' });   // boundary Stop
  await sleep(100);   // >> stopGraceMs — pre-fix this finalized + cleared the reaction
  assert.equal(proc.pendingTurns.size, 1,
    'turn must stay alive (reaction held by B3) while the sub-agent runs — NOT finalized');
  assert.ok(events.find((e) => e.kind === 'cli-stop-grace-deferred-subagent'),
    'the defer is observable in the events DB');

  // claude's real end-of-work Stop carries the produced answer (refreshes _stopHookData)…
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'The final analysis.' });
  proc._pendingSubagentStarts = [];                                            // …and the sub-agent drains
  await sleep(100);                                                            // next grace fire → no work → finalize

  const result = await sendP;
  assert.equal(proc.pendingTurns.size, 0, 'finalizes once the sub-agent drains');
  assert.equal(result.text, 'The final analysis.',
    'delivers the produced final answer (latest Stop), not the status promise');
  assert.equal(result.alreadyDelivered, false);
  await proc.kill('test');
});

// ─── L15-L17: the stop-grace cancel race — a NO-REPLY turn must not be orphaned ──
// A reply-less turn's only finalizer is its attributed Stop grace. When the pane
// heartbeat (the turn's OWN residual "esc to interrupt") fires _noteActivity at the
// instant the real Stop lands, it cancels the grace — and rung 2 used to require a
// delivered reply, so the no-reply turn fell back to NOTHING and dangled to the
// 60-min idle ceiling, dropping the answer. Field-confirmed: shumabit@UMI root topic
// 2026-06-23 (cli-stop-grace-cancelled source:"pane-thinking", answer dropped).
// docs/stop-grace-cancel-race-spec.md

test('L15: no-reply turn — pane-thinking cancels the Stop grace, rung 2 still delivers the answer', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 40, activityQuietMs: 120, turnTimeoutMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));                                    // pickup → seen, hooks live
  // claude finishes with NO reply tool call; the Stop carries the answer (begins grace, sets _stopHookData)…
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'THE CHROME ANSWER' });
  // …but the pane still shows "esc to interrupt" from this turn's OWN final render → the
  // heartbeat fires _noteActivity('pane-thinking') 39ms later, cancelling the grace (the race).
  proc._noteActivity('pane-thinking');
  // no further activity (the idle pane's unknown-prompt poll does NOT note activity).
  await sleep(220);   // > activityQuietMs (120)

  assert.equal(proc.pendingTurns.size, 0,
    'the no-reply turn finalized via the rung-2 backstop instead of orphaning to the ceiling');
  const result = await sendP;
  assert.equal(result.text, 'THE CHROME ANSWER', 'the Stop-captured answer is delivered, not dropped');
  assert.equal(result.alreadyDelivered, false, 'never sent via the reply tool — deliver it');
  assert.ok(events.find((e) => e.kind === 'cli-noreply-stop-rescued'),
    'the rescue is observable in the events DB for the soak watcher');
  await proc.kill('test');
});

test('L16: no-reply backstop does NOT finalize stale text when the turn resumes work after the Stop', async () => {
  // Audit MEDIUM: a Stop can capture text early (foreign/lagged, or a boundary Stop),
  // then claude RESUMES into a long silent tool — no streaming hint, so pane-thinking
  // can't re-arm. Without the hook-recency guard, rung 2 would fire on the STALE text and
  // kill a still-working turn. A resume emits a work hook (PreToolUse) that bumps
  // _lastHookEventAt past the Stop capture → eligibility withdrawn → no premature finalize.
  const { proc, written } = makeProc({ stopGraceMs: 40, activityQuietMs: 120, turnTimeoutMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'STALE PARTIAL' });   // early Stop captures partial
  proc._noteActivity('pane-thinking');                                              // cancels the grace
  proc._handleHookEvent({ type: 'PreToolUse', toolName: 'Bash' });                  // claude RESUMES → work hook AFTER the Stop
  await sleep(220);   // > activityQuietMs — a silent tool shows no streaming hint, so pane-thinking can't re-arm

  assert.equal(proc.pendingTurns.size, 1,
    'a resumed turn keeps working — rung 2 must NOT finalize it on the stale captured text');

  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'THE REAL ANSWER' });  // real end-of-work Stop, no hook after
  await sleep(120);   // > stopGraceMs → grace fires
  const result = await sendP;
  assert.equal(proc.pendingTurns.size, 0, 'finalizes on the real Stop');
  assert.equal(result.text, 'THE REAL ANSWER', 'delivers the real end-of-work answer, not the stale partial');
  await proc.kill('test');
});

test('L17: a no-reply turn with NO Stop yet is never finalized by the rung-2 backstop', async () => {
  // The backstop is gated on a CAPTURED Stop. A seen, no-reply turn still thinking (no
  // Stop) has no captured answer → ineligible → a pane-thinking heartbeat can't finalize
  // it; only the ceiling applies, exactly as before.
  const { proc, written } = makeProc({ stopGraceMs: 40, activityQuietMs: 120, turnTimeoutMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);
  sendP.catch(() => {});
  proc._handleHookEvent(upsFor(turnId));        // pickup → seen, but NO Stop, NO reply
  proc._noteActivity('pane-thinking');          // heartbeat
  await sleep(220);                             // > activityQuietMs
  assert.equal(proc.pendingTurns.size, 1,
    'still working (no Stop captured) → not eligible for rung 2 → not finalized');
  await proc.kill('test');
});

test('L18: a sub-agent work hook after a boundary Stop withdraws rung-2 eligibility (no stale finalize)', async () => {
  // Pins the claim that lets us drop an explicit sub-agent gate: a top-level Stop fired
  // while a sub-agent is in flight is ALWAYS followed by a sub-agent work hook (its
  // SubagentStop), which bumps _workHookSeq past the capture and withdraws the stale
  // Stop's eligibility. pane-thinking arms the timer FIRST (while still eligible) → this
  // also exercises the fire-time eligibility RE-check.
  const { proc, written } = makeProc({ stopGraceMs: 40, activityQuietMs: 120, turnTimeoutMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._pendingSubagentStarts = [{ agentType: 'g', toolUseId: 'a1' }];                // a sub-agent is running
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'boundary/partial' });  // boundary Stop captures stale text
  proc._noteActivity('pane-thinking');                                                // cancels the deferred grace; arms while eligible
  proc._handleHookEvent({ type: 'SubagentStop', agentType: 'g' });                    // the sub-agent's work hook → bumps the seq
  await sleep(220);   // > activityQuietMs — the armed timer must re-check and bail

  assert.equal(proc.pendingTurns.size, 1,
    'the sub-agent work hook withdrew eligibility — rung 2 must NOT finalize on the boundary text');

  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'The sub-agent analysis.' });   // real end-of-work Stop
  await sleep(120);   // > stopGraceMs → grace fires
  const result = await sendP;
  assert.equal(proc.pendingTurns.size, 0, 'finalizes on the real Stop');
  assert.equal(result.text, 'The sub-agent analysis.', 'delivers the real answer, not the boundary partial');
  await proc.kill('test');
});

// L19: the 0.17.8 characterization instrument — _resolveTurnDelivery emits a
// cli-resolve-delivery event tagging the branch + counts, so a channels
// double-delivery (reply tool + daemon re-send) can be pinned to WHY alreadyDelivered
// was false. docs note: shumorobot Music dup, 2026-06-28.
test('L19: _resolveTurnDelivery emits cli-resolve-delivery tagging the branch', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 40 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));
  proc._recordReplyForPendingTurn('the final answer', turnId);          // a FINAL reply
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'the final answer' });
  await sleep(90);
  await sendP;
  const ev = events.find((e) => e.kind === 'cli-resolve-delivery');
  assert.ok(ev, 'resolution emits a cli-resolve-delivery characterization event');
  assert.equal(ev.detail.branch, 'final-reply');
  assert.equal(ev.detail.already_delivered, true);
  assert.equal(ev.detail.reply_count, 1);
  await proc.kill('test');
});

// L20-L22: an ORPHAN SubagentStop (a late/lagged/foreign teardown hook with NO matching
// in-flight sub-agent start) must be treated as TERMINAL, not work. Field-confirmed:
// umi/shumabit "return" topic 2026-06-29 — a trailing SubagentStop (agent_type="", no
// start) bumped _workHookSeq past the Stop capture, withdrew rung-2 eligibility, and the
// no-reply turn orphaned to the idle ceiling → false "⏱ went quiet", answer dropped.
// (73 grace-cancels → 0 rescues in prod because ~62% had this trailing SubagentStop.)
// docs/stop-grace-cancel-race-spec.md (follow-up). The MATCHED case stays green in L18.

test('L20: orphan SubagentStop after a pane-thinking grace-cancel must NOT poison the rescue', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 40, activityQuietMs: 120, turnTimeoutMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._handleHookEvent(upsFor(turnId));                                       // pickup → seen, hooks live
  // claude finishes with NO reply tool call; the Stop carries the answer (begins grace, sets _stopHookData)…
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'THE PAYMENT INFO ANSWER' });
  // …the pane heartbeat cancels the grace and arms rung-2 (eligible at this instant)…
  proc._noteActivity('pane-thinking');
  // …then a late / orphan SubagentStop lands with NO matching in-flight start (prod: agent_type="",
  // _pendingSubagentStarts empty — earlier sub-agents already drained; start() init'd it to []).
  proc._pendingSubagentStarts = [];
  assert.equal(proc._pendingSubagentStarts.length, 0, 'precondition: no in-flight sub-agent (orphan)');
  proc._handleHookEvent({ type: 'SubagentStop', agentType: '' });
  await sleep(220);   // > activityQuietMs (120), no further activity

  assert.equal(proc.pendingTurns.size, 0,
    'orphan SubagentStop is terminal → rung-2 stays eligible → finalized, not orphaned to the ceiling');
  const result = await sendP;
  assert.equal(result.text, 'THE PAYMENT INFO ANSWER', 'the Stop-captured answer is delivered, not dropped');
  assert.equal(result.alreadyDelivered, false, 'never sent via the reply tool — deliver it');
  assert.ok(events.find((e) => e.kind === 'cli-noreply-stop-rescued'),
    'the rescue is observable in the events DB for the soak watcher');
  await proc.kill('test');
});

test('L21: orphan SubagentStop still emits subagent-done (reactor path unaffected)', async () => {
  const { proc, written } = makeProc({ activityQuietMs: 5000, turnTimeoutMs: 60_000 });
  const dones = [];
  proc.on('subagent-done', (d) => dones.push(d));
  const { sendP, turnId } = startTurn(proc, written);
  sendP.catch(() => {});
  proc._handleHookEvent(upsFor(turnId));
  proc._pendingSubagentStarts = [];                                  // orphan (no in-flight start)
  proc._handleHookEvent({ type: 'SubagentStop', agentType: '' });
  assert.equal(dones.length, 1,
    'the switch-case still emits subagent-done — only the activity/counter bookkeeping moved');
  await proc.kill('test');
});

test('L22: orphan SubagentStop does NOT cancel an undisturbed attributed Stop grace (rung 1 delivers)', async () => {
  const { proc, events, written } = makeProc({ stopGraceMs: 80, activityQuietMs: 5000, turnTimeoutMs: 60_000 });
  const { sendP, turnId } = startTurn(proc, written);
  proc._pendingSubagentStarts = [];                                  // no in-flight sub-agent
  proc._handleHookEvent(upsFor(turnId));
  // claude finishes with NO reply; the Stop begins an attributed grace (rung 1).
  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'GRACE ANSWER' });
  // an orphan SubagentStop lands DURING the grace — pre-fix its _noteActivity cancelled the grace
  // (source: hook:SubagentStop); as terminal it must leave the grace untouched.
  proc._handleHookEvent({ type: 'SubagentStop', agentType: '' });
  await sleep(160);   // > stopGraceMs (80), << activityQuietMs — only rung 1 can fire here

  assert.equal(proc.pendingTurns.size, 0, 'the undisturbed grace finalized (orphan did not cancel it)');
  assert.ok(!events.find((e) => e.kind === 'cli-stop-grace-cancelled'),
    'the orphan SubagentStop did not cancel the attributed Stop grace');
  const result = await sendP;
  assert.equal(result.text, 'GRACE ANSWER', 'rung 1 delivered the captured answer');
  await proc.kill('test');
});

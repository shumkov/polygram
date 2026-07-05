'use strict';

// Regression tests for the "Stop says 'Nothing to stop' while claude is
// still working" incident (shumorobot Music topic, 2026-05-31 13:08).
//
// Root cause: on the CliProcess/channels backend a turn resolves on the
// quiet-window after claude's last reply tool call (inFlight → false),
// but claude can keep working afterwards (subagent, long Bash). The abort
// handler gated its ack on inFlight alone, so "Stop" said "Nothing to
// stop" while a subagent download churned.
//
// Fix: CliProcess.probeBusyState() reads the TUI "esc to interrupt" hint
// via capture-pane; the abort handler folds it into hadActive so the ack,
// the markSessionAborted, and the interrupt all agree with reality.
// (2026-06-12 cancel-cheap update: the ack is now a 👍 reaction / silence —
// the busy-DETECTION behavior pinned here is unchanged.)

const { test } = require('node:test');
const assert = require('node:assert');

const { createHandleAbort } = require('../lib/handlers/abort');
const { CliProcess } = require('@shumkov/orchestra');

// ── abort-handler harness ───────────────────────────────────────────
function makeHandler({ proc, isAbort = true } = {}) {
  const calls = { interrupt: [], drainQueue: [], marked: [], events: [], sent: [] };
  const pm = {
    has: () => !!proc,
    get: () => proc,
    interrupt: async (k) => { calls.interrupt.push(k); },
    drainQueue: (k, code) => { calls.drainQueue.push([k, code]); },
  };
  const handler = createHandleAbort({
    pm,
    bot: {},
    tg: async (_b, _m, params) => { calls.sent.push(params); return {}; },
    logEvent: (kind, detail) => calls.events.push({ kind, detail }),
    isAbortRequest: () => isAbort,
    markSessionAborted: (k) => calls.marked.push(k),
    clearAutosteeredReactions: async () => {},
    getSessionKey: () => 'k',
    botName: 'testbot',
    logger: { error() {}, warn() {}, log() {} },
  });
  return { handler, calls };
}

const msg = { from: { id: 1 }, message_id: 99, message_thread_id: 3 };

// ── the bug: resolved turn (inFlight=false) but claude still busy ────
test('Stop while busy (inFlight=false, esc-to-interrupt visible) → "Stopped.", marks aborted, interrupts', async () => {
  // proc looks idle by the resolved flag, but the busy probe sees claude working.
  const proc = { inFlight: false, closed: false, probeBusyState: async () => ({ busy: true, streaming: true, inFlight: false, pendingTurns: 0, captured: true, paneTail: 'esc to interrupt' }) };
  const { handler, calls } = makeHandler({ proc });

  const handled = await handler(msg, '-100', {}, 'Stop');

  assert.equal(handled, true);
  // Locked ack design 2026-06-12: 👍 reaction on the stop message, no text.
  assert.equal(calls.sent[0].reaction[0].emoji, '👍', 'something WAS running → 👍 ack (never the silent no-op)');
  assert.deepEqual(calls.marked, ['k'], 'session marked aborted so the error-reply is suppressed');
  assert.deepEqual(calls.interrupt, ['k'], 'C-c interrupt sent');
});

test('Stop while genuinely idle (inFlight=false, no esc-to-interrupt) → "Nothing to stop."', async () => {
  const proc = { inFlight: false, closed: false, probeBusyState: async () => ({ busy: false, streaming: false, inFlight: false, pendingTurns: 0, captured: true, paneTail: '❯' }) };
  const { handler, calls } = makeHandler({ proc });

  await handler(msg, '-100', {}, 'Stop');

  assert.equal(calls.sent.length, 0, 'genuinely idle → silence (no lie-👍, no text — locked design 2026-06-12)');
  assert.deepEqual(calls.marked, [], 'nothing to mark when not busy');
});

test('Stop with a live in-flight turn → "Stopped." (no probe needed)', async () => {
  let probed = false;
  const proc = { inFlight: true, closed: false, probeBusyState: async () => { probed = true; return { busy: false }; } };
  const { handler, calls } = makeHandler({ proc });

  await handler(msg, '-100', {}, 'Stop');

  assert.equal(calls.sent[0].reaction[0].emoji, '👍');
  assert.equal(probed, false, 'no busy probe when inFlight is already true (non-cli proc: no bg gate)');
});

test('forensics: abort-requested event records the raw busy-probe signals', async () => {
  const proc = { inFlight: false, closed: false, probeBusyState: async () => ({ busy: true, streaming: true, inFlight: false, pendingTurns: 1, captured: true, paneTail: '...esc to interrupt' }) };
  const { handler, calls } = makeHandler({ proc });

  await handler(msg, '-100', {}, 'Stop');

  const ev = calls.events.find((e) => e.kind === 'abort-requested');
  assert.ok(ev, 'abort-requested logged');
  assert.equal(ev.detail.had_active, true);
  assert.ok(ev.detail.busy_probe, 'busy_probe block recorded for later heuristic tuning');
  assert.equal(ev.detail.busy_probe.streaming, true);
  assert.equal(ev.detail.busy_probe.in_flight, false);
  assert.equal(ev.detail.busy_probe.captured, true);
  assert.match(ev.detail.busy_probe.pane_tail, /esc to interrupt/);
});

// ── CliProcess.probeBusyState unit ──────────────────────────────────
function makeProc(captureWide) {
  return new CliProcess({
    botName: 'b', sessionKey: '1:t', label: 't',
    tmuxRunner: { spawn: async () => {}, killSession: async () => {}, sendControl: async () => {}, captureWide },
    toolDispatcher: async () => ({ ok: true }),
    claudeBin: '/usr/bin/echo',
    logger: { error() {}, warn() {}, info() {}, debug() {}, log() {} },
  });
}

test('probeBusyState: pane showing "esc to interrupt" → busy:true', async () => {
  const proc = makeProc(async () => 'doing things...\n  ⏵⏵ esc to interrupt');
  proc.tmuxSession = 'sess';
  const r = await proc.probeBusyState();
  assert.equal(r.busy, true);
  assert.equal(r.streaming, true);
  assert.equal(r.captured, true);
});

test('probeBusyState: idle pane (no hint) → busy:false', async () => {
  const proc = makeProc(async () => 'Listening for channel messages from: server:polygram-bridge\n❯');
  proc.tmuxSession = 'sess';
  const r = await proc.probeBusyState();
  assert.equal(r.busy, false);
  assert.equal(r.streaming, false);
  assert.equal(r.captured, true);
});

test('probeBusyState: capture-pane failure → captured:false, busy:false (never throws)', async () => {
  const proc = makeProc(async () => { throw new Error('no server running'); });
  proc.tmuxSession = 'sess';
  const r = await proc.probeBusyState();
  assert.equal(r.captured, false);
  assert.equal(r.busy, false);
});

test('isBusy() is the boolean shorthand for probeBusyState().busy', async () => {
  const proc = makeProc(async () => 'esc to interrupt');
  proc.tmuxSession = 'sess';
  assert.equal(await proc.isBusy(), true);
});

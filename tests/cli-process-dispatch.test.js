'use strict';

// Dispatch-level tests for CliProcess._dispatchToolCall — the daemon wiring that
// unit tests previously skipped for edit_message (the operator-flagged gap,
// 2026-06-09). _dispatchToolCall does NOT bind a socket, so these run without
// start() and without the sandbox carve-out the spawn tests need.

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('../lib/process/cli-process');

const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => '',
};
const quiet = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

// Build a CliProcess wired for dispatch-only testing: capture tool_acks + the
// calls that reach the dispatcher, without spawning anything.
function makeProc({ dispatchResult = { ok: true, message_id: 555 }, dispatchImpl } = {}) {
  const acks = [];
  const dispatched = [];
  const proc = new CliProcess({
    sessionKey: 'k', chatId: '100', threadId: null, label: 'disp', botName: 'b',
    tmuxRunner: fakeRunner,
    claudeBin: '/usr/bin/true',   // constructor-required; never spawned in these tests
    toolDispatcher: dispatchImpl || (async (call) => { dispatched.push(call); return dispatchResult; }),
    logger: quiet,
    db: { logEvent: () => {} },
  });
  // _writeToBridge normally writes to the unix socket; capture instead.
  proc._writeToBridge = (msg) => { acks.push(msg); return true; };
  return { proc, acks, dispatched };
}

const ackOf = (acks) => acks.find((a) => a.kind === 'tool_ack');

test('edit_message: threads args.message_id to the dispatcher AND tool_ack carries result.message_id', async () => {
  const { proc, acks, dispatched } = makeProc({ dispatchResult: { ok: true, message_id: 500 } });
  await proc._dispatchToolCall({ name: 'edit_message', tool_call_id: 'tc1', args: { chat_id: '100', message_id: 500, text: 'updated' } });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].toolName, 'edit_message');
  assert.equal(dispatched[0].messageId, 500, 'args.message_id reaches the dispatcher');
  const ack = ackOf(acks);
  assert.equal(ack.ok, true);
  assert.equal(ack.message_id, 500, 'tool_ack carries the id back to the bridge → claude');
});

test('reply: tool_ack carries the delivered message_id', async () => {
  const { proc, acks } = makeProc({ dispatchResult: { ok: true, message_id: 4242 } });
  await proc._dispatchToolCall({ name: 'reply', tool_call_id: 'r1', args: { chat_id: '100', text: 'hi' } });
  assert.equal(ackOf(acks).message_id, 4242);
});

test('SECURITY: edit_message with a foreign chat_id is rejected BEFORE dispatch', async () => {
  const { proc, acks, dispatched } = makeProc();
  await proc._dispatchToolCall({ name: 'edit_message', tool_call_id: 'tc2', args: { chat_id: '999', message_id: 5, text: 'x' } });
  assert.equal(dispatched.length, 0, 'a foreign chat_id never reaches the Telegram edit — no cross-chat edit');
  const ack = ackOf(acks);
  assert.equal(ack.ok, false);
  assert.match(ack.error, /chat_id mismatch/);
});

test('edit_message: a duplicate tool_call_id re-ACKs without re-dispatching (idempotency)', async () => {
  const { proc, acks, dispatched } = makeProc({ dispatchResult: { ok: true, message_id: 7 } });
  const msg = { name: 'edit_message', tool_call_id: 'dup', args: { chat_id: '100', message_id: 7, text: 'a' } };
  await proc._dispatchToolCall(msg);   // success → caches tool_call_id
  await proc._dispatchToolCall(msg);   // retry with same id → must NOT edit again
  assert.equal(dispatched.length, 1, 'second call with the same tool_call_id did not re-dispatch');
  assert.ok(acks.filter((a) => a.kind === 'tool_ack' && a.ok).length >= 2, 'both calls got an ok ack');
});

test('edit_message: progressive — two DISTINCT edits to the same message_id both dispatch', async () => {
  // The deterministic counterpart to the (flaky) real-claude multi-edit E2E: a
  // progressive status edits one bubble repeatedly. Distinct tool_call_ids, same
  // message_id → both must reach Telegram (the content-hash dedup is reply-only).
  const { proc, acks, dispatched } = makeProc({ dispatchResult: { ok: true, message_id: 42 } });
  await proc._dispatchToolCall({ name: 'edit_message', tool_call_id: 'e1', args: { chat_id: '100', message_id: 42, text: 'Step 1…' } });
  await proc._dispatchToolCall({ name: 'edit_message', tool_call_id: 'e2', args: { chat_id: '100', message_id: 42, text: 'Step 2 — done.' } });
  assert.equal(dispatched.length, 2, 'both progressive edits dispatched (not deduped)');
  assert.equal(dispatched[0].messageId, 42);
  assert.equal(dispatched[1].messageId, 42);
  assert.deepEqual(dispatched.map((d) => d.text), ['Step 1…', 'Step 2 — done.']);
  assert.equal(acks.filter((a) => a.kind === 'tool_ack' && a.ok && a.message_id === 42).length, 2);
});

test('edit_message: participates in the per-session rate limit (clean NACK when exhausted)', async () => {
  const { proc, acks, dispatched } = makeProc();
  proc.toolRateTokens = 0;                    // drain the bucket
  proc.toolRateLastRefillAt = Date.now();     // and prevent a refill this tick
  await proc._dispatchToolCall({ name: 'edit_message', tool_call_id: 'rl', args: { chat_id: '100', message_id: 5, text: 'x' } });
  assert.equal(dispatched.length, 0, 'a rate-limited edit never dispatches');
  const ack = ackOf(acks);
  assert.equal(ack.ok, false);
  assert.match(ack.error, /rate limit/);
});

test('edit_message: a dispatcher error (failed edit) NACKs — claude sees it, no hang', async () => {
  const { proc, acks, dispatched } = makeProc({ dispatchImpl: async () => ({ ok: false, error: 'message to edit not found' }) });
  await proc._dispatchToolCall({ name: 'edit_message', tool_call_id: 'e1', args: { chat_id: '100', message_id: 5, text: 'x' } });
  const ack = ackOf(acks);
  assert.equal(ack.ok, false);
  assert.match(ack.error, /not found/);
});

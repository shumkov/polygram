'use strict';

// Regression tests for the four MEDIUM findings from the 0.12.0
// CliProcess multi-agent code review (docs/0.12.0-review-findings.md).
// Each test is written to FAIL against the pre-fix code and PASS after
// the fix, so it pins the corrected behavior against future regression.
//
//   M1  cli-process.js  — Stop-hook fallback not turn-scoped
//   M2  cli-process.js  — --resume replays prior session's hook ndjson
//   M3  sdk/callbacks.js — hook handlers mislabel backend as 'tmux'
//   M4  cli-process.js + callbacks.js — subagent-start/done not JOINable

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { CliProcess } = require('../lib/process/cli-process');
const { createSdkCallbacks } = require('../lib/sdk/callbacks');

const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => '',
};
const fakeDispatcher = async () => ({ ok: true });

// ── CliProcess test double (no tmux / bridge / real hook tail) ──────
function makeProc(overrides = {}) {
  return new CliProcess({
    botName: 'testbot',
    sessionKey: '123:thread',
    label: 'test',
    tmuxRunner: fakeRunner,
    toolDispatcher: fakeDispatcher,
    claudeBin: '/usr/bin/echo',
    logger: { error() {}, warn() {}, info() {}, debug() {}, log() {} },
    db: { logEvent() {} },
    // Large grace so the unref'd grace TIMER never fires during a test —
    // we want to isolate the Stop-HOOK path, not the timer fallback.
    stopGraceMs: 60_000,
    ...overrides,
  });
}

// Inject a pending turn the way send() would, capturing its resolution.
function addPending(proc, turnId, { replies = [] } = {}) {
  const rec = { resolved: null, rejected: null };
  proc.pendingTurns.set(turnId, {
    replies,
    startedAt: Date.now(),
    resolve: (r) => { rec.resolved = r; },
    reject: (e) => { rec.rejected = e; },
    quietTimer: null,
    hardTimer: null,
    absoluteTimer: null,
    _stopGracePending: false,
  });
  return rec;
}

function clearGraceTimers(proc) {
  for (const [, p] of proc.pendingTurns) {
    if (p._stopGraceTimer) clearTimeout(p._stopGraceTimer);
  }
}

// ── M1 ─────────────────────────────────────────────────────────────
// A single global 'stop-hook' (no turn_id) must NOT finalize every
// grace-pending turn nor cross-attribute one turn's last_assistant_message
// to another. With >1 turn in grace the Stop is ambiguous → ignore it.

test('M1: ambiguous stop-hook does not cross-attribute text to a concurrent empty-reply turn', () => {
  const proc = makeProc();
  const a = addPending(proc, 'A', { replies: ['real answer for A'] });
  const b = addPending(proc, 'B', { replies: [] }); // empty → would adopt fallback text
  proc._resolveTurn('A'); // both enter stop-grace, each registers an onStop
  proc._resolveTurn('B');

  proc.emit('stop-hook', { lastAssistantMessage: 'text belonging to whichever turn just ended' });

  // Pre-fix: one Stop fired BOTH onStop closures → B finalized with the
  // stale fallback text (cross-attribution). After fix: ambiguous Stop is
  // ignored; neither turn finalizes synchronously off it.
  assert.equal(b.resolved, null, 'turn B must not finalize off an ambiguous stop-hook');
  assert.equal(a.resolved, null, 'turn A must not finalize off an ambiguous stop-hook');
  assert.ok(proc.pendingTurns.has('A') && proc.pendingTurns.has('B'), 'both turns still pending');

  clearGraceTimers(proc);
});

test('M1: a sole grace-pending turn still finalizes via stop-hook fallback (good path preserved)', () => {
  const proc = makeProc();
  const s = addPending(proc, 'S', { replies: [] }); // no reply-tool text
  proc._resolveTurn('S');

  proc.emit('stop-hook', { lastAssistantMessage: 'rescued via stop hook' });

  assert.ok(s.resolved, 'sole grace turn should finalize on its stop-hook');
  assert.equal(s.resolved.text, 'rescued via stop hook');
  assert.equal(proc.pendingTurns.has('S'), false, 'finalized turn removed from pendingTurns');
});

// ── M2 ─────────────────────────────────────────────────────────────
// On a --resume respawn the prior session's hook ndjson is still on disk
// (writeHookFiles appends, never truncates). The tail MUST skip the
// existing content so stale Stop/PreToolUse lines don't replay into the
// fresh turn.

test('M2: _armHookTail skips existing ndjson on a resumed session', () => {
  const tmp = path.join(os.tmpdir(), `polygram-hooktail-resume-${process.pid}-${Math.random().toString(36).slice(2)}.ndjson`);
  const proc = makeProc();
  proc._hookNdjsonPath = tmp;
  proc._resumedSession = true;
  proc._armHookTail();
  assert.equal(proc._hookTail.skipExisting, true, 'resumed respawn must NOT replay the prior session ndjson');
  proc._hookTail.stop?.();
});

test('M2: _armHookTail does not skip on a fresh (non-resumed) session', () => {
  const tmp = path.join(os.tmpdir(), `polygram-hooktail-fresh-${process.pid}-${Math.random().toString(36).slice(2)}.ndjson`);
  const proc = makeProc();
  proc._hookNdjsonPath = tmp;
  proc._resumedSession = false;
  proc._armHookTail();
  assert.equal(proc._hookTail.skipExisting, false, 'fresh spawn reads from the start of its own empty ndjson');
  proc._hookTail.stop?.();
});

// ── M3 ─────────────────────────────────────────────────────────────
// tmux backend was deleted in 0.12; hook handlers must default backend to
// 'cli', not the stale hardcoded 'tmux'. onHookTailError genuinely fires on
// the CLI hook tail, so its mislabel is a live telemetry defect.

function makeHarness(overrides = {}) {
  const events = [];
  const cbs = createSdkCallbacks({
    db: { upsertSession() {} },
    dbWrite: (fn) => fn(),
    config: { chats: {}, bot: {} },
    bot: null,
    botName: 'testbot',
    tg: () => Promise.resolve({ message_id: 1 }),
    logEvent: (kind, detail) => events.push({ kind, detail }),
    classifyToolName: (name) => `state-for-${name}`,
    announce: () => {},
    shouldAnnounce: () => false,
    contextHintShown: new Set(),
    extractAssistantText: (m) => m?.message?.content?.[0]?.text || '',
    getChatIdFromKey: (k) => String(k).split(':')[0],
    getThreadIdFromKey: (k) => (String(k).includes(':') ? String(k).split(':')[1] : null),
    logger: { error() {}, warn() {}, info() {}, log() {} },
    ...overrides,
  });
  return { cbs, events };
}

test('M3: onHookTailError defaults backend to cli', () => {
  const { cbs, events } = makeHarness();
  cbs.onHookTailError('123:thread', { message: 'tail boom', path: '/x.ndjson' });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'hook-tail-error');
  assert.equal(events[0].detail.backend, 'cli');
});

test('M3: onHookEvent defaults backend to cli', () => {
  const { cbs, events } = makeHarness();
  cbs.onHookEvent('123:thread', { type: 'PostToolUse', toolName: 'Bash' }, {});
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'hook-event');
  assert.equal(events[0].detail.backend, 'cli');
});

// ── M4 ─────────────────────────────────────────────────────────────
// The documented soak query JOINs subagent-start and subagent-done on
// $.tool_use_id. SubagentStop carries no tool_use_id, so cli-process must
// recover the originating Agent tool_use_id and stamp it on subagent-done,
// and the callback must persist it.

test('M4: subagent-done carries the originating Agent tool_use_id', () => {
  const proc = makeProc();
  const starts = [];
  const dones = [];
  proc.on('subagent-start', (d) => starts.push(d));
  proc.on('subagent-done', (d) => dones.push(d));

  proc._handleHookEvent({ type: 'PreToolUse', toolName: 'Agent', toolInput: { subagent_type: 'code-reviewer' }, toolUseId: 'tu-agent-1' });
  proc._handleHookEvent({ type: 'SubagentStop', agentType: 'code-reviewer', agentId: 'a-1', durationMs: 1234 });

  assert.equal(starts[0].toolUseId, 'tu-agent-1');
  assert.equal(dones[0].toolUseId, 'tu-agent-1', 'subagent-done must echo the start tool_use_id so the soak JOIN matches');
});

test('M4: parallel subagents of different types pair their tool_use_ids correctly', () => {
  const proc = makeProc();
  const dones = [];
  proc.on('subagent-done', (d) => dones.push({ type: d.agentType, tu: d.toolUseId }));

  // Two starts, then completions in REVERSE order — type-keyed matching
  // must still pair each done with its own start.
  proc._handleHookEvent({ type: 'PreToolUse', toolName: 'Agent', toolInput: { subagent_type: 'reviewer' }, toolUseId: 'tu-rev' });
  proc._handleHookEvent({ type: 'PreToolUse', toolName: 'Agent', toolInput: { subagent_type: 'researcher' }, toolUseId: 'tu-res' });
  proc._handleHookEvent({ type: 'SubagentStop', agentType: 'researcher', agentId: 'a-res', durationMs: 10 });
  proc._handleHookEvent({ type: 'SubagentStop', agentType: 'reviewer', agentId: 'a-rev', durationMs: 20 });

  assert.deepEqual(dones, [
    { type: 'researcher', tu: 'tu-res' },
    { type: 'reviewer', tu: 'tu-rev' },
  ]);
});

test('M4: onSubagentDone persists tool_use_id', () => {
  const { cbs, events } = makeHarness();
  cbs.onSubagentDone('123:thread', { agentType: 'x', agentId: 'a', durationMs: 5, toolUseId: 'tu-9' });
  assert.equal(events[0].kind, 'subagent-done');
  assert.equal(events[0].detail.tool_use_id, 'tu-9');
});

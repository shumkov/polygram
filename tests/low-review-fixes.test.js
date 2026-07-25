'use strict';

// Regression tests for the LOW findings from the 0.12.0 CliProcess
// multi-agent review (docs/0.12.0-review-findings.md). Behavioral lows
// only — pure log-text / dead-code removals (#7 pollScheduler, #12 boot
// log) are mechanical and verified by grep, not pinned here.
//
//   L5   cli-process.js — stop-hook listener leaks on teardown
//   L6   cli-process.js — bridge-disconnect doesn't clear interrupt grace timer
//   L8   log-tail.js    — multibyte char split across read chunk corrupts line
//   L9   reactions.js + callbacks.js — SUBAGENT reaction state (plan claim c)
//   L10  cli-process.js — hook-lag-sample double-persisted
//   L13  cli-process.js — reply text leaked into warn logs

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { CliProcess } = require('@shumkov/orchestra');
const { STATES } = require('../lib/telegram/reactions');
const { createSdkCallbacks } = require('../lib/sdk/callbacks');

const fakeRunner = {
  spawn: async () => {},
  killSession: async () => {},
  sendControl: async () => {},
  captureWide: async () => '',
};
const fakeDispatcher = async () => ({ ok: true });

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
    stopGraceMs: 60_000,
    ...overrides,
  });
}

function addPending(proc, turnId, { replies = [] } = {}) {
  proc.pendingTurns.set(turnId, {
    replies, startedAt: Date.now(),
    resolve() {}, reject() {},
    quietTimer: null, hardTimer: null, absoluteTimer: null,
    _stopGracePending: false,
  });
}

// ── L5 ──────────────────────────────────────────────────────────────
// A turn torn down mid-stop-grace must not leave its onStop listener
// subscribed on the EventEmitter. The base Process.kill() blanket-
// removeAllListeners covers the kill() path, but the bridge-disconnect
// drain and resetSession do NOT — those are the genuine leak paths.

test('L5: bridge-disconnect drain removes the per-turn stop-hook listener', async () => {
  const proc = makeProc();
  addPending(proc, 'A');
  proc._resolveTurn('A'); // registers onStop
  assert.equal(proc.listenerCount('stop-hook'), 1, 'precondition: one onStop registered');
  await proc._handleBridgeDisconnected();
  assert.equal(proc.listenerCount('stop-hook'), 0, 'disconnect drain must remove the stop-hook listener');
});

test('L5: resetSession removes the per-turn stop-hook listener', async () => {
  const proc = makeProc();
  addPending(proc, 'A');
  proc._resolveTurn('A');
  assert.equal(proc.listenerCount('stop-hook'), 1);
  await proc.resetSession({ reason: 'test' });
  assert.equal(proc.listenerCount('stop-hook'), 0, 'resetSession must remove the stop-hook listener');
});

// ── L6 ──────────────────────────────────────────────────────────────
// The bridge-disconnect drain must clear _interruptGraceTimer, matching
// _doKill (otherwise a stray timer survives on a dead instance).

test('L6: bridge-disconnect drain clears _interruptGraceTimer', async () => {
  const proc = makeProc();
  let fired = false;
  proc._interruptGraceTimer = setTimeout(() => { fired = true; }, 50_000);
  assert.ok(proc._interruptGraceTimer, 'precondition: interrupt grace timer armed');
  // Invoke the disconnect drain directly (extracted helper).
  await proc._handleBridgeDisconnected();
  assert.equal(proc._interruptGraceTimer, null, 'disconnect drain must null the interrupt grace timer');
  assert.equal(fired, false);
});

// ── L8 ──────────────────────────────────────────────────────────────
// LogTail reads in DEFAULT_CHUNK_BYTES (64KB) chunks. A 4-byte emoji
// straddling that boundary splits across two physical reads; the pre-fix
// per-chunk toString('utf8') corrupted each half into U+FFFD. (Verified
// reproducible against a real file at the exact boundary.)

test('L8: multibyte char at the 64KB read boundary is not corrupted', async () => {
  const fs = require('node:fs');
  const { LogTail } = require('@shumkov/orchestra').logTail;
  const CHUNK = 64 * 1024;
  // Pad so the 😀's first 2 bytes end chunk 1 and its last 2 bytes begin chunk 2.
  const content = 'A'.repeat(CHUNK - 2) + String.fromCodePoint(0x1F600) + '\n';
  const file = path.join(os.tmpdir(), `polygram-logtail-utf8-${process.pid}-${Date.now()}.ndjson`);
  fs.writeFileSync(file, content, 'utf8');
  try {
    const tail = new LogTail({ path: file, useWatch: false, logger: { log() {} } });
    const lines = [];
    tail.on('line', (l) => lines.push(l));
    await tail._readNew();
    tail.close();
    assert.equal(lines.length, 1, 'exactly one line emitted');
    assert.ok(!lines[0].includes(String.fromCodePoint(0xFFFD)), 'no U+FFFD replacement char');
    assert.equal(lines[0].codePointAt(CHUNK - 2), 0x1F600, 'emoji at the boundary survives intact');
  } finally {
    fs.unlinkSync(file);
  }
});

// ── L9 / L14 ────────────────────────────────────────────────────────
// The plan promised a distinct SUBAGENT reaction state. It must exist in
// reactions.js with a Telegram-valid preferred emoji, and onSubagentStart
// must drive the head reactor into it.

test('L9: SUBAGENT reaction state exists with a non-empty chain', () => {
  assert.ok(STATES.SUBAGENT, 'SUBAGENT state must be defined in reactions.js');
  assert.ok(Array.isArray(STATES.SUBAGENT.chain) && STATES.SUBAGENT.chain.length > 0,
    'SUBAGENT must have a fallback chain');
  // rc.37 lesson: preferred emoji must be a real bot-usable reaction, not
  // an arbitrary one (🤖 is REACTION_INVALID for bots, like 🧐 was).
  assert.ok(!STATES.SUBAGENT.chain.includes('🤖') || STATES.SUBAGENT.chain[0] !== '🤖',
    'preferred SUBAGENT emoji must not be the bot-invalid 🤖');
});

test('L9: onSubagentStart drives the head reactor into SUBAGENT', () => {
  const states = [];
  const cbs = createSdkCallbacks({
    db: { upsertSession() {} }, dbWrite: (f) => f(),
    config: { chats: {}, bot: {} }, bot: null, botName: 'b',
    tg: () => Promise.resolve({}), logEvent: () => {},
    classifyToolName: (n) => n, announce() {}, shouldAnnounce: () => false,
    contextHintShown: new Set(), extractAssistantText: () => '',
    getChatIdFromKey: (k) => k, getThreadIdFromKey: () => null,
    logger: { error() {}, warn() {}, info() {}, log() {} },
  });
  const entry = { pendingQueue: [{ context: { reactor: { setState: (s) => states.push(s), heartbeat() {} } } }] };
  cbs.onSubagentStart('123:t', { agentType: 'code-reviewer', toolUseId: 'tu-1' }, entry);
  assert.deepEqual(states, ['SUBAGENT'], 'onSubagentStart must setState(SUBAGENT) on the head reactor');
});

// ── L10 ─────────────────────────────────────────────────────────────
// hook-lag-sample must be persisted exactly once. cli-process should emit
// the event (callback owns the DB write) and NOT also write it directly.

test('L10: hook-lag-sample is not double-persisted by cli-process', () => {
  const dbRows = [];
  const proc = makeProc({ db: { logEvent: (kind, d) => dbRows.push({ kind, d }) } });
  let emitted = 0;
  proc.on('hook-lag-sample', () => { emitted += 1; });

  proc._handleHookEvent({ type: 'PostToolUse', toolName: 'Bash', receivedAtMs: Date.now() - 5 });

  assert.equal(emitted, 1, 'event emitted once (callback persists it)');
  const direct = dbRows.filter((r) => r.kind === 'hook-lag-sample');
  assert.equal(direct.length, 0, 'cli-process must NOT also write hook-lag-sample directly');
});

// ── L13 ─────────────────────────────────────────────────────────────
// The inbound reply text must not be logged at warn level by default
// (content leak into daemon logs).

test('L13: reply text is not emitted into warn-level logs', async () => {
  const warns = [];
  const proc = makeProc({
    logger: { warn: (m) => warns.push(String(m)), error() {}, info() {}, debug() {}, log() {} },
  });
  proc.bridgeReady = true;
  const secret = 'TOP SECRET private chat content abc123';
  await proc._dispatchToolCall({ name: 'reply', args: { chat_id: '123', text: secret, turn_id: 't1' } });

  const leaked = warns.find((w) => w.includes(secret) || w.includes('text_head'));
  assert.equal(leaked, undefined, `reply text/text_head must not appear in warn logs; got: ${JSON.stringify(warns)}`);
});

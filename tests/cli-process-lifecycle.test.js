'use strict';

/**
 * Tests for cli-process lifecycle findings in 0.11.0-channels review.
 *
 * F#4 — `_teardownOnStartFailure` references `this.sockClient` and
 *       `this.sockServer`, neither of which is assigned anywhere post-M1
 *       refactor. The actual `this.bridgeServer` (ChannelsBridgeServer) is
 *       never closed on start-failure, leaking the net.Server listener +
 *       FD across every spawn retry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('@shumkov/orchestra');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeProc() {
  return new CliProcess({
    sessionKey: 'sess-1',
    chatId: '12345',
    tmuxRunner: { sendControl: async () => {}, killSession: async () => {} },
    botName: 'testbot',
    claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
  });
}

test('F#4: _teardownOnStartFailure closes bridgeServer (not the dead sockClient/sockServer refs)', async () => {
  const proc = makeProc();
  // Plant a fake bridgeServer the way _createSocketServer would.
  let closeCalls = 0;
  proc.bridgeServer = {
    close: async () => { closeCalls++; },
  };

  await proc._teardownOnStartFailure();

  assert.equal(
    closeCalls,
    1,
    'bridgeServer.close() must be invoked exactly once on start-failure teardown ' +
    '(was missing pre-fix: the function checked dead sockClient/sockServer refs)',
  );
  assert.equal(
    proc.bridgeServer,
    null,
    'bridgeServer reference cleared after close so subsequent retries see a fresh state',
  );
});

test('F#4: teardown swallows bridgeServer.close() errors (defensive)', async () => {
  const proc = makeProc();
  proc.bridgeServer = {
    close: async () => { throw new Error('socket already closed'); },
  };

  // Must not throw — teardown is a best-effort cleanup path; throwing here
  // would mask the original start() error that triggered the teardown.
  await proc._teardownOnStartFailure();
  // No assertion needed beyond "didn't throw" — implicit.
});

// ─── F#8 — late permission verdict on closed instance ──────────────────────
//
// Scenario: user taps Approve 11+ min after the request. Turn timed out, the
// CliProcess was killed (this.closed=true, bridgeServer=null), respawn
// already happened on a new inbound. The respond() closure stored from
// canUseTool() is bound to the ORIGINAL (now-closed) instance. Pre-fix,
// respondToPermission silently no-ops because _writeToBridge returns early
// on `!this.bridgeServer`. User sees nothing.
//
// Post-fix: respondToPermission detects this.closed and logs/events a
// `channels-late-perm-verdict-dropped` event for forensics, returns false
// so the caller can react.

test('F#8: respondToPermission on a closed instance logs + does not silently no-op', async () => {
  const events = [];
  const fakeDb = { logEvent: (kind, detail) => { events.push({ kind, detail }); } };
  const { CliProcess } = require('@shumkov/orchestra');
  const proc = new CliProcess({
    sessionKey: 'sess-1', chatId: '12345',
    tmuxRunner: { sendControl: async () => {}, killSession: async () => {} },
    botName: 'testbot', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    db: fakeDb,
  });

  // Simulate post-kill state: closed flag set, bridgeServer null.
  proc.closed = true;
  proc.bridgeServer = null;

  const ret = await proc.respondToPermission('req-stale-123', 'allow');

  assert.equal(ret, false, 'must return false to signal the verdict could not be delivered');
  const lateEvt = events.find(e => /late.*perm.*verdict|perm.*verdict.*dropped/i.test(e.kind));
  assert.ok(
    lateEvt,
    `Expected a late-perm-verdict-dropped event. Got events: ${JSON.stringify(events)}`,
  );
  assert.equal(lateEvt.detail.request_id, 'req-stale-123');
  assert.equal(lateEvt.detail.behavior, 'allow');
});

test('F#8: respondToPermission on a live instance still writes verdict', async () => {
  const proc = makeProc();
  let written = null;
  proc.bridgeServer = {
    writeMessage: (obj) => { written = obj; },
  };

  const ret = await proc.respondToPermission('req-live-456', 'allow');

  // Either undefined (existing behavior — no explicit return) or true.
  // Contract: not false. The verdict was actually sent.
  assert.notEqual(ret, false, 'live-instance verdict must not return the closed-instance sentinel');
  assert.deepEqual(written, {
    kind: 'perm_verdict', request_id: 'req-live-456', behavior: 'allow',
  });
});

// ─── F#9 — resetSession leaks tmux + bridge + socket + mcp-config ────────
//
// Pre-fix: resetSession only drained pendings and cleared claudeSessionId,
// returning closed:false. pm.resetSession unconditionally deletes the proc
// from the map → the underlying tmux session, bridge socket server, and
// secret-bearing mcp-config tmp file (0600) all leak until daemon boot.
//
// Post-fix: resetSession also kills the tmux session, closes the bridge
// server, unlinks the mcp-config tmp file, clears timers, sets closed=true,
// and returns closed:true so the contract is honest.

test('F#9: resetSession kills tmux session', async () => {
  const killed = [];
  const proc = new (require('@shumkov/orchestra').CliProcess)({
    sessionKey: 'sess-1', chatId: '12345',
    tmuxRunner: {
      sendControl: async () => {},
      killSession: async (name) => { killed.push(name); },
    },
    botName: 'testbot', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
  });
  proc.tmuxSession = 'polygram-testbot-channels-abc';

  const result = await proc.resetSession({ reason: 'reset' });

  assert.deepEqual(killed, ['polygram-testbot-channels-abc']);
  assert.equal(result.closed, true, 'must return closed:true so pm knows underlying resources were freed');
  assert.equal(proc.tmuxSession, null);
});

test('F#9: resetSession closes bridgeServer and unlinks mcp-config tmp file', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-reset-mcp-'));
  const mcpPath = path.join(tmpDir, 'mcp-config.json');
  fs.writeFileSync(mcpPath, '{}', { mode: 0o600 });

  let bridgeClosed = 0;
  const proc = new (require('@shumkov/orchestra').CliProcess)({
    sessionKey: 'sess-1', chatId: '12345',
    tmuxRunner: { sendControl: async () => {}, killSession: async () => {} },
    botName: 'testbot', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
  });
  proc.bridgeServer = { close: async () => { bridgeClosed++; } };
  proc.mcpConfigPath = mcpPath;

  await proc.resetSession({ reason: 'reset' });

  assert.equal(bridgeClosed, 1, 'bridgeServer.close() must be called exactly once');
  assert.equal(proc.bridgeServer, null);
  assert.equal(
    fs.existsSync(mcpPath),
    false,
    'mcp-config tmp file (secret-bearing) must be unlinked',
  );
  assert.equal(proc.mcpConfigPath, null);

  // cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ─── F#22 — autonomous-assistant-message event must signal alreadyDelivered ──
//
// Production observation: Claude continued researching after its turn resolved,
// then called reply again — an "autonomous wakeup". polygram routed it via the
// autonomous-assistant-message event… but delivered TWICE (OUT 1148 + 1149
// identical text, same timestamp). The path:
//   1. Dispatcher delivers immediately on tool call (rc.10 F#1 helper)
//   2. _recordReplyForPendingTurn finds no pending turn (post-resolve)
//   3. Emits autonomous-assistant-message event
//   4. polygram's onAutonomousAssistantMessage handler ALSO does tg(sendMessage)
//
// F#2's alreadyDelivered flag covers the in-turn pm.send pipeline; the
// autonomous emit didn't carry the flag — handler had no signal to skip.
//
// Post-fix: channels emits the event with alreadyDelivered: true; polygram's
// handler (in lib/sdk/callbacks.js) checks the flag and skips the second send.

// ─── F#17 — mid-turn dialog watchdog ─────────────────────────────────────
//
// Even though channels uses MCP for IO, the underlying claude TUI can still
// pop interactive prompts mid-turn (session-age, future usage-limit menus)
// that don't surface as MCP notifications. Without polling the pane we'd
// only catch them when the F#13 idle ceiling fires (~10 min). The fix
// piggybacks on the pong-watchdog's 5s tick: when pending turns exist AND
// the tmux session is live, capture-pane and match against a known-pattern
// catalog. action='enter' dismisses; action='emit-only' surfaces telemetry.

function makeProcWithCapture(paneContent, opts = {}) {
  const sendCalls = [];
  const runner = {
    sendControl: async (name, key) => { sendCalls.push({ name, key }); },
    killSession: async () => {},
    captureWide: async () => paneContent,
  };
  const events = [];
  const proc = new (require('@shumkov/orchestra').CliProcess)({
    sessionKey: 'sess-1', chatId: '12345',
    tmuxRunner: runner, botName: 'testbot', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    ...opts,
  });
  proc.tmuxSession = 'pgr-testbot-channels-abc';
  return { proc, runner, sendCalls, events };
}

test('F#17: session-age dialog mid-turn → Down,Enter picks FULL resume (2026-06-11 resume-dialog fix)', async () => {
  const paneShowingDialog =
    'Some pre-amble...\n' +
    'This session is 8h 38m old and 117.6k tokens.\n' +
    'Resuming the full session will consume a substantial portion of your usage limits.\n' +
    '> 1. Resume from summary (recommended)\n' +
    '  2. Resume full session as-is';
  const { proc, sendCalls } = makeProcWithCapture(paneShowingDialog);
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => {}, replies: [] });

  await proc._pollMidTurnDialogs();

  // Resume-dialog fix: bare Enter selected the pre-selected "Resume from
  // summary" — which literally runs /compact on the resumed session. The
  // watchdog must navigate to "Resume full session as-is" instead.
  assert.deepEqual(
    sendCalls.map(c => c.key),
    ['Down', 'Enter'],
    'mid-turn session-age must pick full resume, not the compact default',
  );
  assert.equal(sendCalls[0].name, 'pgr-testbot-channels-abc');
});

test('F#17: emits mid-turn-dialog-detected event with pattern name + action', async () => {
  const paneShowingDialog =
    'Resuming the full session will consume a substantial portion of your usage limits.\n' +
    'Resume from summary';
  const { proc, events } = makeProcWithCapture(paneShowingDialog);
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => {}, replies: [] });

  let emitted = null;
  proc.on('mid-turn-dialog-detected', (payload) => { emitted = payload; });

  await proc._pollMidTurnDialogs();

  assert.ok(emitted, 'mid-turn-dialog-detected must fire');
  assert.equal(emitted.name, 'session-age');
  assert.equal(emitted.action, 'keys');   // resume-dialog fix: Down,Enter navigation
  assert.equal(emitted.backend, 'cli');

  const logEvt = events.find(e => e.kind === 'cli-mid-turn-dialog-detected');
  assert.ok(logEvt, 'cli-mid-turn-dialog-detected forensic event must fire');
  assert.equal(logEvt.detail.name, 'session-age');
  assert.equal(logEvt.detail.pending_count, 1);
});

test('F#17: skipped when no pending turns (idle = no work)', async () => {
  const paneShowingDialog =
    'Resuming the full session will consume a substantial portion of your usage limits.\n' +
    'Resume from summary';
  const { proc, sendCalls } = makeProcWithCapture(paneShowingDialog);
  // proc.pendingTurns is empty — idle

  await proc._pollMidTurnDialogs();

  assert.equal(sendCalls.length, 0, 'idle proc must NOT poll/act');
});

test('F#17: skipped when no tmuxSession (pre-spawn / post-kill)', async () => {
  const { proc, sendCalls } = makeProcWithCapture('Resume from summary');
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => {}, replies: [] });
  proc.tmuxSession = null;   // simulate pre-spawn

  await proc._pollMidTurnDialogs();

  assert.equal(sendCalls.length, 0, 'no tmux session → no capture, no action');
});

test('F#17: dedups within rate-limit window', async () => {
  const paneShowingDialog =
    'Resuming the full session will consume a substantial portion of your usage limits.\n' +
    'Resume from summary';
  const { proc, sendCalls } = makeProcWithCapture(paneShowingDialog);
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => {}, replies: [] });

  // First poll fires
  await proc._pollMidTurnDialogs();
  // Second poll (same tick, same dialog) must dedup
  await proc._pollMidTurnDialogs();
  // Third
  await proc._pollMidTurnDialogs();

  assert.equal(
    sendCalls.length,
    2,   // one Down,Enter sequence — NOT repeated per poll
    'lingering dialog across multiple polls must not spam key sends',
  );
});

test('F#17: captureWide failure is swallowed (does not throw, does not crash watchdog)', async () => {
  const runner = {
    sendControl: async () => {},
    killSession: async () => {},
    captureWide: async () => { throw new Error('tmux died'); },
  };
  const proc = new (require('@shumkov/orchestra').CliProcess)({
    sessionKey: 'sess-1', chatId: '12345',
    tmuxRunner: runner, botName: 'testbot', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
  });
  proc.tmuxSession = 'pgr-testbot-channels-abc';
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => {}, replies: [] });

  // Must not throw — the pong watchdog calls this via .catch() too, but we
  // pin the contract here.
  await proc._pollMidTurnDialogs();
});

test('F#17: normal turn output (no dialog) → no action', async () => {
  const benignPane =
    'I am thinking about your question.\n' +
    'Let me check a few files first.\n' +
    'esc to interrupt';
  const { proc, sendCalls, events } = makeProcWithCapture(benignPane);
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => {}, replies: [] });

  await proc._pollMidTurnDialogs();

  assert.equal(sendCalls.length, 0);
  assert.equal(
    events.filter(e => e.kind === 'cli-mid-turn-dialog-detected').length,
    0,
    'no false positives on benign turn output',
  );
});

// ─── rc.14: benign dev-channels banner must NOT trigger a kill ──────
//
// rc.11 added a pane matcher (BRIDGE_DEAD_RE) that treated the line
//   "server:polygram-bridge  no MCP server configured with that name"
// as a dead bridge and tore the turn down. That was a MISDIAGNOSIS: the line
// is a BENIGN banner that `--dangerously-load-development-channels` +
// `--strict-mcp-config` prints on EVERY healthy session — the channel still
// delivers messages and the reply tool still works (reproduced 2026-06-01
// with a test MCP server that demonstrably functions; see
// tests/e2e-channels-real-claude.test.js). The matcher false-fired ~5s into
// every channels turn and killed healthy Music sessions (the "mid-turn
// detach" regression that started 06-01 with rc.11; Music worked 05-31
// because the matcher didn't exist yet). rc.14 removed it. This test pins
// that the banner is now IGNORED. Real bridge loss is the socket-close path
// (bridgeServer 'bridge-disconnected' → _handleBridgeDisconnected), not
// anything observable in the pane.
//
// Red→green: with rc.11's BRIDGE_DEAD_RE present this test FAILS (the banner
// rejects the turn + emits 'bridge-disconnected'); after rc.14's removal it
// passes.

test('rc.14: benign "no MCP server configured" dev-channels banner does NOT kill a healthy turn', async () => {
  // Exact banner from a HEALTHY session (reproduced with a working test MCP
  // server): the line is present but the channel functions normally.
  const healthyPaneWithBanner =
    '  Claude Code v2.1.142\n' +
    '  @music-curation:music-curator  ~/Music/rekordbox\n' +
    '  Listening for channel messages from: server:polygram-bridge\n' +
    '  server:polygram-bridge  no MCP server configured with that name\n' +
    '  esc to interrupt';
  const { proc, events } = makeProcWithCapture(healthyPaneWithBanner);

  let rejected = false;
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => { rejected = true; }, replies: [] });
  let bridgeDisconnectedEmitted = false;
  proc.on('bridge-disconnected', () => { bridgeDisconnectedEmitted = true; });

  await proc._pollMidTurnDialogs();

  assert.equal(rejected, false, 'the benign banner must NOT reject the in-flight turn');
  assert.equal(bridgeDisconnectedEmitted, false, "the benign banner must NOT emit 'bridge-disconnected'");
  assert.equal(proc.pendingTurns.size, 1, 'turn stays in flight — the channel is healthy');
  assert.equal(
    events.filter(e => e.kind === 'cli-bridge-detached-midturn').length,
    0,
    'no false bridge-detach event from the cosmetic banner',
  );
});

// ─── F#24 — injectUserMessage on CliProcess (autosteer parity) ─────
//
// Pre-fix: channels inherited the base-class default (returns false), so
// polygram's autosteer flow (lib/handlers/autosteer.js:77) reported
// {autosteered: false} for any follow-up arriving mid-turn. End result:
// no AUTOSTEERED (✍) reaction was set on the follow-up message; it sat
// without any reactor state until the stdin-lock released.
//
// Post-fix: CliProcess.injectUserMessage writes the follow-up to
// the bridge as a fresh user_msg. Returns true so autosteer.tryAutosteer
// reports {autosteered: true, priority}. Polygram then marks ✍ on the
// follow-up msg + records it in autosteeredRefs.

test('F#24: injectUserMessage returns true + emits inject-user-message when inFlight + content valid', () => {
  const proc = makeProc();
  proc.bridgeReady = true;
  proc.bridgeServer = { writeMessage: () => {} };
  proc.inFlight = true;

  let emitted = null;
  proc.on('inject-user-message', (payload) => { emitted = payload; });

  const ok = proc.injectUserMessage({ content: 'follow-up payload', priority: 'next', msgId: 1234 });

  assert.equal(ok, true, 'must return true for valid content + live turn');
  assert.ok(emitted, 'inject-user-message event must fire');
  assert.equal(emitted.text_len, 'follow-up payload'.length);
  assert.equal(emitted.priority, 'next');
  assert.equal(emitted.msgId, '1234');
});

test('F#24: injectUserMessage returns false when not in-flight (no live turn to merge into)', () => {
  const proc = makeProc();
  proc.bridgeReady = true;
  proc.bridgeServer = { writeMessage: () => {} };
  proc.inFlight = false;   // no live turn

  const ok = proc.injectUserMessage({ content: 'follow-up' });
  assert.equal(ok, false, 'idle proc → return false so polygram falls through to normal send');
});

test('F#24: injectUserMessage returns false when bridge not ready', () => {
  const proc = makeProc();
  proc.bridgeReady = false;
  proc.bridgeServer = null;
  proc.inFlight = true;

  const ok = proc.injectUserMessage({ content: 'follow-up' });
  assert.equal(ok, false);
});

test('F#24: injectUserMessage sanitizes C0 control chars + emits prompt-sanitized', () => {
  const proc = makeProc();
  proc.bridgeReady = true;
  proc.bridgeServer = { writeMessage: () => {} };
  proc.inFlight = true;

  let sanitizedEvent = null;
  proc.on('prompt-sanitized', (payload) => { sanitizedEvent = payload; });

  // "hi\x01\x02world" — two control chars between hi and world
  const ok = proc.injectUserMessage({ content: 'hi\x01\x02world' });
  assert.equal(ok, true);
  assert.ok(sanitizedEvent, 'prompt-sanitized event must fire');
  assert.equal(sanitizedEvent.stripped, 2);
  assert.equal(sanitizedEvent.source, 'inject');
});

test('F#24: injectUserMessage returns false when content sanitizes to empty (only control chars)', () => {
  const proc = makeProc();
  proc.bridgeReady = true;
  proc.bridgeServer = { writeMessage: () => {} };
  proc.inFlight = true;

  const ok = proc.injectUserMessage({ content: '\x01\x02\x03' });
  assert.equal(ok, false, 'all-control-chars sanitizes to empty → return false');
});

test('F#24: injectUserMessage emits inject-fail on transport failure (bridge gone)', () => {
  const proc = makeProc();
  proc.bridgeReady = true;
  proc.bridgeServer = null;   // F#18: _writeToBridge returns false on no-bridge
  proc.inFlight = true;

  let failEvent = null;
  proc.on('inject-fail', (payload) => { failEvent = payload; });

  const ok = proc.injectUserMessage({ content: 'follow-up' });
  assert.equal(ok, false, 'transport failure must return false');
  assert.ok(failEvent, 'inject-fail must fire');
  assert.equal(typeof failEvent.err, 'string');
  assert.ok(failEvent.err.length > 0);
  assert.equal(failEvent.source, 'inject');
});

test('F#24: injectUserMessage actually writes user_msg to the bridge with correct shape', () => {
  const proc = makeProc();
  proc.bridgeReady = true;
  proc.inFlight = true;
  let written = null;
  proc.bridgeServer = { writeMessage: (obj) => { written = obj; } };

  const ok = proc.injectUserMessage({ content: 'merge this in', msgId: 5678 });
  assert.equal(ok, true);
  assert.ok(written, 'bridge writeMessage must be called');
  assert.equal(written.kind, 'user_msg');
  assert.equal(written.text, 'merge this in');
  assert.equal(written.chat_id, '12345');
  assert.equal(written.msg_id, '5678');
  assert.equal(typeof written.turn_id, 'string');
  assert.ok(written.turn_id.length > 0);
});

test('F#22: orphan reply with zero pending turns emits autonomous event WITH alreadyDelivered=true', () => {
  const proc = makeProc();

  let emittedPayload = null;
  proc.on('autonomous-assistant-message', (payload) => { emittedPayload = payload; });

  // pendingTurns.size === 0 → falls into the autonomous-emit branch
  proc._recordReplyForPendingTurn('post-turn-resolve orphan reply', undefined);

  assert.ok(emittedPayload, 'autonomous-assistant-message must fire when no pending turns');
  assert.equal(emittedPayload.text, 'post-turn-resolve orphan reply');
  assert.equal(emittedPayload.backend, 'cli');
  assert.equal(
    emittedPayload.alreadyDelivered,
    true,
    'channels-emit must carry alreadyDelivered=true so polygram\'s handler skips the redundant send (the dispatcher already shipped the text)',
  );
});

// ─── Compaction warning (0.12.0-rc.13): PreCompact/PostCompact + proactive Stop ───
//
// Music topic root cause: claude auto-compaction detaches the channels MCP
// bridge mid-turn. rc.11/rc.12 recover after the fact; rc.13 WARNS the user
// (per-chat opt-in) so they can /compact on their terms BEFORE it happens
// (proactive, at a context-% threshold) and tells them when it happens anyway
// (reactive, on PreCompact trigger=auto). Manual /compact is the user's own
// deliberate action and must NOT nag.

const _cwFs = require('node:fs');
const _cwOs = require('node:os');
const _cwPath = require('node:path');

function writeTranscript(usage) {
  const dir = _cwFs.mkdtempSync(_cwPath.join(_cwOs.tmpdir(), 'pgr-cw-'));
  const tp = _cwPath.join(dir, 't.jsonl');
  _cwFs.writeFileSync(tp, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', usage },
  }) + '\n');
  return { tp, dir };
}

test('rc.13 compaction-warn: PreCompact trigger=auto (enabled) → emits reactive warn', () => {
  const { proc } = makeProcWithCapture('');
  proc.compactionWarn = { enabled: true, thresholdPct: 75 };
  let warn = null;
  proc.on('compaction-warn', (p) => { warn = p; });
  proc._handleHookEvent({ type: 'PreCompact', trigger: 'auto' });
  assert.ok(warn, 'auto-compaction must emit a reactive warning the chat layer posts');
  assert.equal(warn.kind, 'reactive');
});

test('rc.13 compaction-warn: PreCompact trigger=manual → NO warn (deliberate user action)', () => {
  const { proc } = makeProcWithCapture('');
  proc.compactionWarn = { enabled: true, thresholdPct: 75 };
  let warned = false;
  proc.on('compaction-warn', () => { warned = true; });
  proc._handleHookEvent({ type: 'PreCompact', trigger: 'manual' });
  assert.equal(warned, false, 'manual /compact must not nag the user');
});

test('rc.13 compaction-warn: PreCompact when feature disabled → NO warn', () => {
  const { proc } = makeProcWithCapture('');
  proc.compactionWarn = { enabled: false, thresholdPct: 75 };
  let warned = false;
  proc.on('compaction-warn', () => { warned = true; });
  proc._handleHookEvent({ type: 'PreCompact', trigger: 'auto' });
  assert.equal(warned, false, 'off-by-default: disabled chat gets no warning');
});

test('rc.13 compaction-warn: PostCompact re-arms the proactive warn-once', () => {
  const { proc } = makeProcWithCapture('');
  proc.compactionWarn = { enabled: true, thresholdPct: 75 };
  proc._compactionWarned = true;
  proc._handleHookEvent({ type: 'PostCompact', trigger: 'auto' });
  assert.equal(proc._compactionWarned, false, 'PostCompact (context dropped) must re-arm for the next climb');
});

test('rc.13 compaction-warn: proactive fires at/above threshold, once per climb', async () => {
  // 160010 / 200000 ≈ 80% ≥ 75% threshold.
  const { tp, dir } = writeTranscript({ input_tokens: 10, cache_read_input_tokens: 160000, cache_creation_input_tokens: 0 });
  const { proc } = makeProcWithCapture('');
  proc.compactionWarn = { enabled: true, thresholdPct: 75 };
  const warns = [];
  proc.on('compaction-warn', (p) => warns.push(p));

  await proc._maybeProactiveCompactionWarn(tp);
  await proc._maybeProactiveCompactionWarn(tp);   // same climb → deduped
  _cwFs.rmSync(dir, { recursive: true, force: true });

  assert.equal(warns.length, 1, 'warns exactly once per climb (no per-turn spam)');
  assert.equal(warns[0].kind, 'proactive');
  assert.equal(warns[0].pct, 80);
});

test('rc.13 compaction-warn: proactive does NOT fire below threshold', async () => {
  // 100010 / 200000 ≈ 50% < 75%.
  const { tp, dir } = writeTranscript({ input_tokens: 10, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 });
  const { proc } = makeProcWithCapture('');
  proc.compactionWarn = { enabled: true, thresholdPct: 75 };
  let warned = false;
  proc.on('compaction-warn', () => { warned = true; });
  await proc._maybeProactiveCompactionWarn(tp);
  _cwFs.rmSync(dir, { recursive: true, force: true });
  assert.equal(warned, false, '~50% is below the 75% threshold → no warning');
});

// ─── rc.16: Stop hook is the authoritative turn-end (Phase 1.7 completion) ───
//
// Bug (2026-06-02 stuck Music turn): a turn that ended WITHOUT a reply tool
// call had no quiet-window to fire _resolveTurn, and the Stop hook was only
// consumed inside that post-reply grace window — so such a turn hung until the
// 30-min wall-clock backstop while the unknown-prompt watchdog spun. This is a
// REAL fix (Stop resolves the turn), not a pane-scraping workaround. The e2e
// (tests/e2e-channels-real-claude.test.js) confirms the Stop hook actually
// lands in the ndjson, so this resolution path is reachable in production.

// 0.13 D1 update: Stop now finalizes only an ATTRIBUTED pending (seen at
// pickup via the UPS envelope, or ≥1 bound reply) and does so through a short
// activity-cancellable grace — an unattributed Stop is a FOREIGN cycle's
// (/compact, wakeup, self-check) and pre-D1 this test's branch would have
// delivered that foreign cycle's last_assistant_message as the user's answer.
// The rc.16 intent (a no-reply turn must not hang to the wall-clock backstop)
// is preserved: the seen marker is set at pickup in production (P0 spike Q1),
// so claude's own no-reply Stop still resolves the turn ~stopGraceMs later.
test('rc.16/D1: Stop resolves an ATTRIBUTED no-reply turn (fallback text) after the grace', async () => {
  const { proc, events } = makeProcWithCapture('', { stopGraceMs: 30 });
  let result = null;
  proc.pendingTurns.set('t1', { resolve: (r) => { result = r; }, reject: () => {}, replies: [], seen: true, startedAt: Date.now() });

  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'Removed the skill. Done.' });
  assert.equal(result, null, 'D1: finalize goes through the stop-grace, not synchronously');

  await new Promise((r) => setTimeout(r, 90));
  assert.ok(result, 'turn MUST resolve on its own (attributed) Stop — not hang until the wall-clock backstop');
  assert.equal(proc.pendingTurns.size, 0, 'pendingTurns drains');
  assert.equal(result.text, 'Removed the skill. Done.', 'falls back to last_assistant_message when no reply tool call');
  assert.equal(result.alreadyDelivered, false, 'no-reply fallback must be DELIVERED (nothing was sent yet) — else the user still sees nothing');
  const evt = events.find((e) => e.kind === 'cli-turn-resolved-by-stop');
  assert.ok(evt, 'observability: cli-turn-resolved-by-stop must fire');
  assert.equal(evt.detail.attributed, 'seen', 'attribution path recorded');
});

test('rc.16/D1: Stop resolves a turn WITH replies (reply-bound attribution) → already-delivered, no double-send', async () => {
  const { proc } = makeProcWithCapture('', { stopGraceMs: 30 });
  let result = null;
  proc.pendingTurns.set('t1', { resolve: (r) => { result = r; }, reject: () => {}, replies: ['hello', 'world'], startedAt: Date.now() });

  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'ignored-when-replies-exist' });
  await new Promise((r) => setTimeout(r, 90));   // D1: through the grace

  assert.ok(result);
  assert.equal(result.text, 'hello\n\nworld', 'uses the reply-tool text');
  assert.equal(result.alreadyDelivered, true, 'reply-tool text was already delivered incrementally — must not re-send');
});

test('rc.16: Stop does NOT force-resolve when multiple turns are in flight (no cross-attribution)', () => {
  const { proc, events } = makeProcWithCapture('');
  let r1 = false, r2 = false;
  proc.pendingTurns.set('t1', { resolve: () => { r1 = true; }, reject: () => {}, replies: [], startedAt: Date.now() });
  proc.pendingTurns.set('t2', { resolve: () => { r2 = true; }, reject: () => {}, replies: [], startedAt: Date.now() });

  proc._handleHookEvent({ type: 'Stop', lastAssistantMessage: 'x' });

  assert.equal(r1, false, 'must not finalize t1 (Stop has no turn_id — cannot attribute)');
  assert.equal(r2, false, 'must not finalize t2');
  assert.equal(proc.pendingTurns.size, 2, 'both stay in flight (each resolves on its own grace/reply)');
  assert.ok(events.find((e) => e.kind === 'cli-stop-unattributed'), 'observability: cli-stop-unattributed must fire');
});

// ─── Finding #11: hook-Notification approval path feeds makeCanUseTool ───────
//
// The Phase 4.5 hook-Notification approval path (non-bypass permissionMode)
// was shipped UNTESTED. makeCanUseTool matches gated patterns via
// matchesAnyPattern, which reads input.command (Bash) / input.url (WebFetch) —
// i.e. it needs the STRUCTURED tool_input. The Notification handler passed a
// formatted STRING (_formatToolInputForApproval), so input.command was
// undefined → a gated `Bash(rm *)` never matched → the tool was ALLOWED with
// NO approval card. Approval gating silently failed for Bash/WebFetch on the
// CLI backend. This test pins the structured-input contract; respond() verdict
// mapping is covered too.

const { matchesAnyPattern } = require('../lib/approvals/store');

test('finding #11: hook-Notification emits STRUCTURED toolInput so gated Bash patterns actually match', () => {
  const { proc } = makeProcWithCapture('pane');
  proc.permissionMode = 'default';          // non-bypass → approval path active
  proc.tmuxSession = 'pgr-testbot-channels-abc';

  let approval = null;
  proc.on('approval-required', (p) => { approval = p; });

  // Real hook-Notification permission payload for a gated Bash command.
  proc._handleHookEvent({
    type: 'Notification',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf /tmp/x', description: 'clean tmp' },
    toolUseId: 'tu-1',
    raw: {},
  });

  assert.ok(approval, 'non-bypass Notification with a tool must emit approval-required');
  assert.equal(approval.toolName, 'Bash');
  // The crux: matchesAnyPattern reads input.command for Bash. A formatted
  // STRING makes that undefined → the gate never matches → silent bypass.
  const gate = matchesAnyPattern('Bash', approval.toolInput, ['Bash(rm *)']);
  assert.equal(
    gate.matched, true,
    'gated Bash(rm *) MUST match the hook-Notification toolInput — else approval gating silently fails',
  );
});

test('finding #11: hook-Notification respond() pipes allow→"1"+Enter, deny→"3"+Enter to the TUI', async () => {
  const { proc, sendCalls } = makeProcWithCapture('pane');
  proc.permissionMode = 'default';
  proc.tmuxSession = 'pgr-testbot-channels-abc';
  let approval = null;
  proc.on('approval-required', (p) => { approval = p; });

  proc._handleHookEvent({ type: 'Notification', toolName: 'Bash', toolInput: { command: 'rm -rf /x' }, toolUseId: 'tu-2', raw: {} });
  assert.ok(approval?.respond, 'approval-required must carry a respond closure');

  await approval.respond('allow');
  assert.deepEqual(sendCalls.map((c) => c.key), ['1', 'Enter'], "allow → '1' then Enter");
  sendCalls.length = 0;
  await approval.respond('deny');
  assert.deepEqual(sendCalls.map((c) => c.key), ['3', 'Enter'], "deny → '3' then Enter");
});

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

const { CliProcess } = require('../lib/process/cli-process');

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
  const { CliProcess } = require('../lib/process/cli-process');
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
  const proc = new (require('../lib/process/cli-process').CliProcess)({
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
  const proc = new (require('../lib/process/cli-process').CliProcess)({
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
  const proc = new (require('../lib/process/cli-process').CliProcess)({
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

test('F#17: session-age dialog mid-turn → sendControl(Enter) fires', async () => {
  const paneShowingDialog =
    'Some pre-amble...\n' +
    'This session is 8h 38m old and 117.6k tokens.\n' +
    'Resuming the full session will consume a substantial portion of your usage limits.\n' +
    '> 1. Resume from summary (recommended)\n' +
    '  2. Resume full session as-is';
  const { proc, sendCalls } = makeProcWithCapture(paneShowingDialog);
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => {}, replies: [] });

  await proc._pollMidTurnDialogs();

  assert.equal(
    sendCalls.length,
    1,
    'one sendControl(Enter) must fire on detection',
  );
  assert.equal(sendCalls[0].name, 'pgr-testbot-channels-abc');
  assert.equal(sendCalls[0].key, 'Enter');
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
  assert.equal(emitted.action, 'enter');
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
    1,
    'lingering dialog across multiple polls must not spam sendControl(Enter)',
  );
});

test('F#17: captureWide failure is swallowed (does not throw, does not crash watchdog)', async () => {
  const runner = {
    sendControl: async () => {},
    killSession: async () => {},
    captureWide: async () => { throw new Error('tmux died'); },
  };
  const proc = new (require('../lib/process/cli-process').CliProcess)({
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

// ─── Wedge recovery — channels MCP registration lost mid-turn ──────
//
// Music topic incident (2026-06-01): msg 1275 got no reply for 25 minutes.
// Root cause: after the turn spawned, claude auto-/compacted a large
// resumed session; the TUI redraw left the channel source unresolved —
// "server:polygram-bridge  no MCP server configured with that name". The
// bridge SOCKET stayed up, so the socket-close recovery path
// (bridgeServer 'bridge-disconnected' → _handleBridgeDisconnected) never
// fired. claude could no longer deliver its reply, the turn orphaned, and
// this watchdog logged cli-mid-turn-unknown-prompt every 30s while
// recovering NOTHING. Fix: detect the dead-bridge pane signal and route it
// through the SAME recovery as a real socket disconnect.

test('wedge-recovery: dead-bridge pane mid-turn → pending turn rejected (BRIDGE_DISCONNECTED) + bridge-disconnected emitted', async () => {
  // Exact shape from the wedged Music pane (PID 9435, session 218be7d5).
  const deadBridgePane =
    'music-curator(Search rekordbox by artist names DROXAL and Ace Vision)\n' +
    '  Called polygram-bridge (ctrl+o to expand)\n' +
    '  Listening for channel messages from: server:polygram-bridge\n' +
    '  server:polygram-bridge  no MCP server configured with that name\n' +
    ' Conversation compacted (ctrl+o for history)';
  const { proc, events } = makeProcWithCapture(deadBridgePane);

  let rejectedErr = null;
  proc.pendingTurns.set('turn-1', {
    resolve: () => {},
    reject: (err) => { rejectedErr = err; },
    replies: [],
  });

  let bridgeDisconnectedEmitted = false;
  proc.on('bridge-disconnected', () => { bridgeDisconnectedEmitted = true; });

  await proc._pollMidTurnDialogs();

  assert.ok(
    rejectedErr,
    'orphaned pending turn must be rejected, not left hanging until the wall-clock cap',
  );
  assert.equal(
    rejectedErr.code,
    'BRIDGE_DISCONNECTED',
    'rejection must carry BRIDGE_DISCONNECTED so the user gets the 🔌 "please resend" message',
  );
  assert.equal(proc.pendingTurns.size, 0, 'pendingTurns must drain so the slot frees');
  assert.ok(
    bridgeDisconnectedEmitted,
    "'bridge-disconnected' must emit so process-manager kills + lazy-respawns the dead instance",
  );
  const evt = events.find(e => e.kind === 'cli-bridge-detached-midturn');
  assert.ok(evt, 'forensic event cli-bridge-detached-midturn must fire (distinguishes this trigger from socket-close)');
  assert.equal(evt.detail.pending_count, 1);
});

test('wedge-recovery: benign polygram-bridge connection line does NOT trigger false recovery', async () => {
  // The normal channels connection notice mentions "polygram-bridge" on
  // every turn. The recovery must key on the SPECIFIC "no MCP server
  // configured" error, not the bridge name alone — else every healthy turn
  // would be torn down.
  const benignPane =
    'polygram-bridge: <polygram-info>You are connected via a Telegram daemon\n' +
    'Working on it.\n' +
    'esc to interrupt';
  const { proc } = makeProcWithCapture(benignPane);

  let rejected = false;
  proc.pendingTurns.set('turn-1', { resolve: () => {}, reject: () => { rejected = true; }, replies: [] });
  let emitted = false;
  proc.on('bridge-disconnected', () => { emitted = true; });

  await proc._pollMidTurnDialogs();

  assert.equal(rejected, false, 'a healthy bridge connection line must not be mistaken for a dead bridge');
  assert.equal(emitted, false, "no spurious 'bridge-disconnected'");
  assert.equal(proc.pendingTurns.size, 1, 'turn stays in flight');
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

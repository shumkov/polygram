'use strict';

/**
 * Tests for channels-process lifecycle findings in 0.11.0-channels review.
 *
 * F#4 — `_teardownOnStartFailure` references `this.sockClient` and
 *       `this.sockServer`, neither of which is assigned anywhere post-M1
 *       refactor. The actual `this.bridgeServer` (ChannelsBridgeServer) is
 *       never closed on start-failure, leaking the net.Server listener +
 *       FD across every spawn retry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ChannelsProcess } = require('../lib/process/channels-process');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function makeProc() {
  return new ChannelsProcess({
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
// ChannelsProcess was killed (this.closed=true, bridgeServer=null), respawn
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
  const { ChannelsProcess } = require('../lib/process/channels-process');
  const proc = new ChannelsProcess({
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
  const proc = new (require('../lib/process/channels-process').ChannelsProcess)({
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
  const proc = new (require('../lib/process/channels-process').ChannelsProcess)({
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

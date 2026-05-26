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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runStartupGate } = require('../lib/tmux/startup-gate');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

/**
 * Fake runner whose capture-pane returns scripted frames, advancing one
 * frame each call. Records every sendControl invocation so tests can
 * assert the gate hit the right key for the right trigger.
 */
function makeScriptedRunner(frames) {
  let i = 0;
  const sent = [];
  return {
    sent,
    captureWide: async (_name) => {
      // Last frame sticks if we run past the script.
      const frame = frames[Math.min(i, frames.length - 1)];
      i += 1;
      return frame;
    },
    sendControl: async (_name, key) => {
      sent.push(key);
    },
  };
}

test('rejects missing/invalid runner', async () => {
  await assert.rejects(
    () => runStartupGate({ tmuxName: 's', readySignal: /ok/ }),
    /runner must have captureWide \+ sendControl/,
  );
  await assert.rejects(
    () => runStartupGate({
      runner: { captureWide: () => {} }, // missing sendControl
      tmuxName: 's',
      readySignal: /ok/,
    }),
    /runner must have captureWide \+ sendControl/,
  );
});

test('rejects missing tmuxName', async () => {
  await assert.rejects(
    () => runStartupGate({
      runner: { captureWide: async () => '', sendControl: async () => {} },
      readySignal: /ok/,
    }),
    /tmuxName required/,
  );
});

test('rejects non-regex readySignal', async () => {
  await assert.rejects(
    () => runStartupGate({
      runner: { captureWide: async () => '', sendControl: async () => {} },
      tmuxName: 's',
      readySignal: 'ok', // string, not RegExp
    }),
    /readySignal must be a RegExp/,
  );
});

test('resolves immediately when ready signal already present', async () => {
  const runner = makeScriptedRunner([
    'Listening for channel messages from: server:polygram-bridge',
  ]);
  const result = await runStartupGate({
    runner,
    tmuxName: 'sess',
    triggers: [],
    readySignal: /Listening for channel messages from: server:polygram-bridge/i,
    logger: quietLogger,
    pollMs: 10,
    settleMs: 10,
  });
  assert.deepEqual(result.matchedTriggers, []);
  assert.equal(runner.sent.length, 0);
});

test('fires Enter for matched trigger then resolves on ready', async () => {
  const runner = makeScriptedRunner([
    'WARNING: Loading development channels — press Enter to continue',
    'Listening for channel messages from: server:polygram-bridge',
  ]);
  const result = await runStartupGate({
    runner,
    tmuxName: 'sess',
    triggers: [
      { name: 'dev-channels', regex: /WARNING: Loading development channels/i, key: 'Enter' },
    ],
    readySignal: /Listening for channel messages from: server:polygram-bridge/i,
    logger: quietLogger,
    pollMs: 5,
    settleMs: 5,
  });
  assert.deepEqual(result.matchedTriggers, ['dev-channels']);
  assert.deepEqual(runner.sent, ['Enter']);
});

test('handles multiple triggers in declared order and dedupes by name', async () => {
  const runner = makeScriptedRunner([
    'WARNING: Loading development channels',
    'Do you trust the files in this folder?',
    // re-show dev-channels (should NOT re-fire because already seen)
    'WARNING: Loading development channels (still showing in scrollback)',
    'Listening for channel messages from: server:polygram-bridge',
  ]);
  const result = await runStartupGate({
    runner,
    tmuxName: 'sess',
    triggers: [
      { name: 'dev-channels', regex: /WARNING: Loading development channels/i, key: 'Enter' },
      { name: 'trust',        regex: /trust the files in this folder/i,        key: 'Enter' },
    ],
    readySignal: /Listening for channel messages from: server:polygram-bridge/i,
    logger: quietLogger,
    pollMs: 5,
    settleMs: 5,
  });
  assert.deepEqual(result.matchedTriggers, ['dev-channels', 'trust']);
  assert.deepEqual(runner.sent, ['Enter', 'Enter']);
});

test('captureWide error is non-fatal and loop continues', async () => {
  let calls = 0;
  const runner = {
    sent: [],
    captureWide: async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom: tmux capture-pane failed');
      return 'Listening for channel messages from: server:polygram-bridge';
    },
    sendControl: async () => {},
  };
  const result = await runStartupGate({
    runner,
    tmuxName: 'sess',
    triggers: [],
    readySignal: /Listening for channel messages from: server:polygram-bridge/i,
    logger: quietLogger,
    pollMs: 5,
    settleMs: 5,
  });
  assert.deepEqual(result.matchedTriggers, []);
  assert.ok(calls >= 2, 'gate retried after captureWide error');
});

test('sendControl error does not poison the gate (warn + continue)', async () => {
  let sendControlCalls = 0;
  const runner = {
    sent: [],
    captureWide: async () => {
      // Show the trigger on call 1, then the ready signal forever.
      return sendControlCalls === 0
        ? 'WARNING: Loading development channels'
        : 'Listening for channel messages from: server:polygram-bridge';
    },
    sendControl: async (_name, _key) => {
      sendControlCalls += 1;
      throw new Error('boom: send-keys failed');
    },
  };
  const result = await runStartupGate({
    runner,
    tmuxName: 'sess',
    triggers: [
      { name: 'dev-channels', regex: /WARNING: Loading development channels/i, key: 'Enter' },
    ],
    readySignal: /Listening for channel messages from: server:polygram-bridge/i,
    logger: quietLogger,
    pollMs: 5,
    settleMs: 5,
  });
  // Trigger was still marked as seen (one-shot semantic) and gate resolved on ready.
  assert.deepEqual(result.matchedTriggers, ['dev-channels']);
  assert.equal(sendControlCalls, 1, 'sendControl tried once, error swallowed');
});

test('times out with the supplied error code when readySignal never matches', async () => {
  // Pane never shows the ready banner.
  const runner = {
    sent: [],
    captureWide: async () => 'some unrelated output',
    sendControl: async () => {},
  };
  await assert.rejects(
    () => runStartupGate({
      runner,
      tmuxName: 'sess',
      triggers: [],
      readySignal: /Listening for channel messages from: server:polygram-bridge/i,
      logger: quietLogger,
      deadlineMs: 60,   // very short for test speed
      pollMs: 10,
      settleMs: 10,
      timeoutCode: 'CHANNELS_DIALOG_TIMEOUT',
      label: 'channels:startup-gate',
    }),
    (err) => {
      assert.equal(err.code, 'CHANNELS_DIALOG_TIMEOUT');
      assert.match(err.message, /startup gate did not resolve within 60ms/);
      assert.match(err.message, /matched: none/);
      return true;
    },
  );
});

test('default timeout error code applies when none supplied', async () => {
  const runner = {
    sent: [],
    captureWide: async () => 'nope',
    sendControl: async () => {},
  };
  await assert.rejects(
    () => runStartupGate({
      runner,
      tmuxName: 'sess',
      triggers: [],
      readySignal: /never/,
      logger: quietLogger,
      deadlineMs: 50,
      pollMs: 10,
      settleMs: 10,
    }),
    (err) => {
      assert.equal(err.code, 'TUI_STARTUP_TIMEOUT');
      return true;
    },
  );
});

test('rc.4: fast-fail with TMUX_SESSION_GONE when captureWide reports "can\'t find pane"', async () => {
  // Sim: first capture shows the dev-channels banner; the trigger fires Enter;
  // then claude exits and tmux tears down the pane → subsequent captureWide
  // errors with "can't find pane". Should bail fast with TMUX_SESSION_GONE,
  // NOT spin for the full deadline.
  let calls = 0;
  const runner = {
    captureWide: async () => {
      calls += 1;
      if (calls === 1) return 'WARNING: Loading development channels — press Enter';
      // After Enter, claude exited: pane gone
      throw new Error("can't find pane: polygram-test-channels-abc123");
    },
    sendControl: async () => {},
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => runStartupGate({
      runner,
      tmuxName: 'polygram-test-channels-abc123',
      triggers: [
        { name: 'dev-channels', regex: /WARNING: Loading development channels/i, key: 'Enter' },
      ],
      readySignal: /never-shows-up/,
      logger: quietLogger,
      deadlineMs: 30_000,             // long enough that we'd KNOW if we waited it out
      pollMs: 5,
      settleMs: 5,
    }),
    (err) => {
      assert.equal(err.code, 'TMUX_SESSION_GONE');
      assert.match(err.message, /tmux session disappeared/);
      assert.match(err.message, /matched: dev-channels/);
      assert.match(err.message, /WARNING: Loading development channels/);
      assert.equal(err.matchedTriggers[0], 'dev-channels');
      assert.ok(err.lastPane, 'lastPane snapshot attached to error');
      return true;
    },
  );
  // Must have bailed in well under the deadline.
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3_000, `expected fast-fail < 3s, got ${elapsed}ms`);
});

test('rc.4: deadline-timeout error includes last pane snapshot', async () => {
  // Sim: ready signal never appears, captureWide keeps returning content.
  // The deadline-timeout error should contain a truncated tail of the last
  // pane content so we can see what claude was showing.
  const runner = {
    captureWide: async () => 'some-banner\nstill loading…\nclaude is doing something\n$',
    sendControl: async () => {},
  };
  await assert.rejects(
    () => runStartupGate({
      runner,
      tmuxName: 'sess',
      triggers: [],
      readySignal: /will-never-appear/,
      logger: quietLogger,
      deadlineMs: 80,
      pollMs: 10,
      settleMs: 10,
    }),
    (err) => {
      assert.match(err.message, /Last pane content:/);
      assert.match(err.message, /still loading/);
      assert.ok(err.lastPane, 'lastPane attached');
      return true;
    },
  );
});

test('rc.4: error message indicates when no pane was ever captured', async () => {
  // Sim: captureWide always errors (e.g., tmux session never even existed
  // from frame 1). lastPane stays null; error message should say so.
  const runner = {
    captureWide: async () => { throw new Error("can't find pane: doesntexist"); },
    sendControl: async () => {},
  };
  await assert.rejects(
    () => runStartupGate({
      runner,
      tmuxName: 'doesntexist',
      triggers: [],
      readySignal: /any/,
      logger: quietLogger,
      deadlineMs: 200,
      pollMs: 5,
      settleMs: 5,
    }),
    (err) => {
      assert.equal(err.code, 'TMUX_SESSION_GONE');
      assert.match(err.message, /no pane content ever captured/);
      return true;
    },
  );
});

test('timeout message lists triggers that fired even when ready never came', async () => {
  // dev-channels fires; ready signal never matches → message should record what we hit.
  const runner = {
    sent: [],
    captureWide: async () => 'WARNING: Loading development channels',
    sendControl: async () => {},
  };
  await assert.rejects(
    () => runStartupGate({
      runner,
      tmuxName: 'sess',
      triggers: [
        { name: 'dev-channels', regex: /WARNING: Loading development channels/i, key: 'Enter' },
      ],
      readySignal: /will-never-appear/,
      logger: quietLogger,
      deadlineMs: 100,
      pollMs: 10,
      settleMs: 10,
    }),
    (err) => {
      assert.match(err.message, /matched: dev-channels/);
      return true;
    },
  );
});

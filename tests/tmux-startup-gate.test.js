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

// ─── Progress-aware (stall-based) gate — shumorobot General incident ──────
//
// 2026-05-30: a cold-spawn of the General topic was killed by the blind
// 30s wall-clock deadline while claude was mid-download (pane showed a
// `24%` progress bar — genuine progress). The gate must distinguish
// "downloading / doing something" (pane CHANGING → keep waiting) from
// "wedged" (pane FROZEN for stallMs → fail). When `stallMs` is set:
//   - the stall clock resets every time the pane content changes
//   - the gate fails only after stallMs of NO change
//   - an absolute backstop (deadlineMs) still bounds a forever-animating
//     but never-ready pane
// When `stallMs` is NOT set, behavior is the pure wall-clock as before.

test('stall gate: does NOT fire while the pane keeps changing past stallMs (download progress)', async () => {
  // Pane advances 0% → 24% → 60% → ready over many polls. Each frame is
  // distinct, so a stall deadline shorter than the total runtime must NOT
  // trip — the gate should ride the progress out to the ready signal.
  const frames = [
    'downloading claude runtime\n▰▱▱▱▱ 0%',
    'downloading claude runtime\n▰▰▱▱▱ 24%',
    'downloading claude runtime\n▰▰▰▱▱ 60%',
    'downloading claude runtime\n▰▰▰▰▰ 98%',
    'Listening for channel messages from: server:polygram-bridge',
  ];
  let i = 0;
  const runner = {
    sent: [],
    captureWide: async () => frames[Math.min(i++, frames.length - 1)],
    sendControl: async () => {},
  };
  const result = await runStartupGate({
    runner,
    tmuxName: 'sess',
    triggers: [],
    readySignal: /Listening for channel messages from: server:polygram-bridge/i,
    logger: quietLogger,
    pollMs: 10,
    settleMs: 10,
    stallMs: 40,        // shorter than the 5-frame * 10ms progression
    deadlineMs: 10_000, // generous absolute backstop
  });
  assert.deepEqual(result.matchedTriggers, []);
});

test('stall gate: fires when the pane is FROZEN for stallMs (genuinely wedged)', async () => {
  // Pane never changes and never shows ready → stall deadline must trip
  // well before the (much larger) absolute backstop.
  const runner = {
    sent: [],
    captureWide: async () => 'frozen pane — nothing happening here',
    sendControl: async () => {},
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => runStartupGate({
      runner,
      tmuxName: 'sess',
      triggers: [],
      readySignal: /never/,
      logger: quietLogger,
      pollMs: 5,
      settleMs: 5,
      stallMs: 60,
      deadlineMs: 10_000,   // would dominate if stall logic were ignored
      timeoutCode: 'CHANNELS_DIALOG_TIMEOUT',
    }),
    (err) => {
      assert.equal(err.code, 'CHANNELS_DIALOG_TIMEOUT');
      assert.match(err.message, /went static for 60ms/);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3_000, `stall should fire fast (~60ms), got ${elapsed}ms`);
});

test('stall gate: absolute deadline still bounds a forever-animating-but-never-ready pane', async () => {
  // Pane changes on EVERY poll (so the stall clock never trips) but the
  // ready signal never appears. The absolute backstop must still fire.
  let n = 0;
  const runner = {
    sent: [],
    captureWide: async () => `spinner frame ${n++}`, // always distinct
    sendControl: async () => {},
  };
  await assert.rejects(
    () => runStartupGate({
      runner,
      tmuxName: 'sess',
      triggers: [],
      readySignal: /never/,
      logger: quietLogger,
      pollMs: 5,
      settleMs: 5,
      stallMs: 10_000,  // never trips — pane always changes
      deadlineMs: 80,   // absolute backstop must win
    }),
    (err) => {
      assert.match(err.message, /startup gate did not resolve within 80ms/);
      return true;
    },
  );
});

test('stall gate: a fired trigger counts as activity (resets the stall clock)', async () => {
  // Pane shows the dev-channels banner (static text) until the trigger
  // fires, then flips to ready. Even though the pre-trigger pane is
  // unchanging, sending the trigger key is activity — the stall clock must
  // reset so we don't fail a session that's actively being navigated.
  let fired = false;
  const runner = {
    sent: [],
    captureWide: async () => (fired
      ? 'Listening for channel messages from: server:polygram-bridge'
      : 'WARNING: Loading development channels'),
    sendControl: async (_n, k) => { fired = true; runner.sent.push(k); },
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
    stallMs: 1_000,   // the static banner would trip a naive stall timer well before this if triggers didn't count
    deadlineMs: 10_000,
  });
  assert.deepEqual(result.matchedTriggers, ['dev-channels']);
  assert.deepEqual(runner.sent, ['Enter']);
});

// ─── Blank-pane cold-start must NOT trip the stall timer (Music incident) ──
//
// shumorobot Music topic (2026-06-01 14:20): a cold CLI spawn whose TUI
// rendered slowly left the captured pane BLANK for >stallMs. The stall
// check killed it at 30s with "Pane appears wedged" — but a blank pane is
// "claude hasn't started rendering yet" (cold start), NOT wedged. The stall
// timer must only arm once the pane has shown SOME content; until then the
// absolute deadline alone governs.

test('stall gate: a BLANK pane does NOT trip the stall timer (slow cold-start)', async () => {
  // Production shape: pane is the SAME blank string every poll for longer
  // than stallMs, THEN renders. Identical bytes each poll = no reference
  // change, so a naive stall timer (reset only on change) trips. The fix:
  // the stall timer must not arm until the pane has shown content.
  let calls = 0;
  const runner = {
    sent: [],
    captureWide: async () => { calls++; return calls <= 6 ? '' : 'Listening for channel messages from: server:polygram-bridge'; },
    sendControl: async () => {},
  };
  const result = await runStartupGate({
    runner,
    tmuxName: 'sess',
    triggers: [],
    readySignal: /Listening for channel messages from: server:polygram-bridge/i,
    logger: quietLogger,
    pollMs: 10,
    settleMs: 10,
    stallMs: 25,        // SHORTER than the blank-pane phase (4 frames × 10ms)
    deadlineMs: 10_000, // absolute backstop, generous
  });
  assert.deepEqual(result.matchedTriggers, []);
});

test('stall gate: still fires when the pane RENDERED then froze (real wedge, content seen)', async () => {
  const runner = {
    sent: [],
    captureWide: async () => 'Claude Code v2.1.142\n  ~/work\n> ',  // rendered, static
    sendControl: async () => {},
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => runStartupGate({
      runner, tmuxName: 'sess', triggers: [],
      readySignal: /never-appears/,
      logger: quietLogger, pollMs: 5, settleMs: 5,
      stallMs: 60, deadlineMs: 10_000,
      timeoutCode: 'CHANNELS_DIALOG_TIMEOUT',
    }),
    (err) => { assert.equal(err.code, 'CHANNELS_DIALOG_TIMEOUT'); assert.equal(err.reason, 'stall'); return true; },
  );
  assert.ok(Date.now() - startedAt < 3_000, 'stall still fires fast once content was seen');
});

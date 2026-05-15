'use strict';

/**
 * End-to-end autosteer scenario tests.
 *
 * Each scenario drives TmuxProcess with a TuiSimulator runner that
 * models the actual TUI mechanics (paste serialisation, queue
 * fold-vs-new-turn, JSONL emission). The tests assert OBSERVABLE
 * polygram-level behaviour:
 *   - which events were emitted (extra-turn-started, extra-turn-reply,
 *     autosteer-resolution, autosteer-match-miss)
 *   - the correct msgId attribution
 *   - no leaked typing intervals
 *
 * These tests cover the regressions Ivan caught manually on
 * shumorobot across rc.7→rc.13 — without requiring a real TUI run.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TmuxProcess } = require('../lib/process/tmux-process');
const { createTuiSimulator } = require('./_helpers/tui-simulator');

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Spin up a TmuxProcess wired to a TuiSimulator. Returns:
 *   - p: the TmuxProcess instance
 *   - sim: the simulator (for scripting agent behaviour + inspection)
 *   - events: an array that captures all p.emit() events (for assertions)
 *   - cleanup: tear down temp dir
 */
async function setupScenario({ sessionId, useLock = true } = {}) {
  sessionId = sessionId || require('crypto').randomUUID();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autosteer-scn-'));
  const homeBackup = process.env.HOME;
  process.env.HOME = tmp;
  const cwd = tmp;
  const projectDir = path.join(tmp, '.claude', 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const logPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(logPath, '');

  const sim = createTuiSimulator({
    sessionName: 'polygram-test-100-main',
    logPath,
    sessionId,
    useLock,
  });

  const p = new TmuxProcess({
    sessionKey: 'chat:100',
    chatId: '100',
    threadId: null,
    label: 'test',
    runner: sim.runner,
    botName: 'shumabit',
    logger: SILENT,
    pollMs: 5,
    quiesceMs: 10,
    readyTimeoutMs: 1000,
    turnTimeoutMs: 10_000,
  });

  // Capture every event the process emits.
  const events = [];
  const eventNames = [
    'extra-turn-started', 'extra-turn-reply',
    'autosteer-resolution', 'autosteer-match-miss',
    'inject-user-message', 'inject-fail',
    'autonomous-assistant-message',
    'result', 'tool-use',
  ];
  for (const name of eventNames) {
    p.on(name, (payload) => events.push({ name, payload }));
  }

  await p.start({
    existingSessionId: sessionId,
    chatConfig: { model: 'sonnet', effort: 'low', cwd },
  });

  function cleanup() {
    process.env.HOME = homeBackup;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  return { p, sim, events, cleanup };
}

// ─── SCENARIO 1: short turn 1, autosteer dequeued as new turn ─────

describe('autosteer scenario — short turn + autosteer → NEW-TURN delivers separate reply', () => {
  test('extra-turn-started AND extra-turn-reply both fire; reply carries the autosteered msgId', async () => {
    const { p, sim, events, cleanup } = await setupScenario();
    try {
      // Script the agent's replies for both prompts.
      sim.scheduleReply(/heay/, 'Hey! What\'s up?', { delayMs: 10 });
      sim.scheduleReply(/how many files/, '42 files at the top level.', { delayMs: 10 });

      // msg 696 — primary turn 1, "heay!" — short, no tools.
      const sendP = p.send('<polygram-info>heay!</polygram-info>');
      await sleep(20);
      // While turn 1 is in flight, autosteer msg 698 "how many files".
      // The TUI's queue will dequeue it as a NEW USER TURN (not fold)
      // because turn 1 ends short (no pending tool to absorb during).
      sim.nextQueueNewTurn();
      const injectOk = p.injectUserMessage({
        content: '<polygram-info>how many files</polygram-info>',
        msgId: 698,
      });
      assert.equal(injectOk, true, 'inject must succeed when turn is in flight');

      const turn1 = await sendP;
      // primary turn 1's reply
      assert.match(turn1.text, /Hey!/);

      await sim.waitForIdle();
      // Give the JSONL tail a moment to fully drain.
      await sleep(80);

      // Assertions: BOTH events fired, msgId correctly attributed.
      const started = events.filter((e) => e.name === 'extra-turn-started');
      const replied = events.filter((e) => e.name === 'extra-turn-reply');
      const resolutions = events.filter((e) => e.name === 'autosteer-resolution');
      assert.equal(started.length, 1, 'exactly one extra-turn-started');
      assert.equal(started[0].payload.msgId, 698);
      assert.equal(replied.length, 1, 'exactly one extra-turn-reply');
      assert.equal(replied[0].payload.msgId, 698, 'reply must carry the autosteered msgId');
      assert.match(replied[0].payload.text, /42 files/, 'reply must be the second-turn text');
      assert.equal(resolutions.length, 1, 'one autosteer-resolution');
      assert.equal(resolutions[0].payload.via, 'new-turn');

      // No autosteer-match-miss events — the content matched.
      const miss = events.filter((e) => e.name === 'autosteer-match-miss');
      assert.equal(miss.length, 0, 'no content mismatch should occur');

      await p.kill('done');
    } finally { cleanup(); }
  });
});

// ─── SCENARIO 2: long turn 1 (with tool), autosteer FOLDS in ─────

describe('autosteer scenario — long turn (tool call) + autosteer → FOLD, one combined reply', () => {
  test('queue-folded event clears the pending autosteer; no extra-turn-reply fires', async () => {
    const { p, sim, events, cleanup } = await setupScenario();
    try {
      sim.scheduleReply(/count files/, 'Found 42 files.', {
        delayMs: 20,
        withTool: { name: 'Bash', input: { command: 'ls' }, result: '42' },
      });

      const sendP = p.send('<polygram-info>count files</polygram-info>');
      await sleep(20);
      // Autosteer arrives during the tool execution window.
      sim.nextQueueFolds();
      p.injectUserMessage({
        content: '<polygram-info>also in /var</polygram-info>',
        msgId: 999,
      });

      await sendP;
      await sim.waitForIdle();
      await sleep(80);

      const started = events.filter((e) => e.name === 'extra-turn-started');
      const replied = events.filter((e) => e.name === 'extra-turn-reply');
      assert.equal(started.length, 0, 'FOLD: no extra-turn-started');
      assert.equal(replied.length, 0, 'FOLD: no extra-turn-reply (primary reply covers both)');

      const resolutions = events.filter((e) => e.name === 'autosteer-resolution');
      assert.equal(resolutions.length, 1);
      assert.equal(resolutions[0].payload.via, 'fold');
      assert.equal(resolutions[0].payload.msgId, 999);

      await p.kill('done');
    } finally { cleanup(); }
  });
});

// ─── SCENARIO 3: multi-line autosteer content (rc.12 regression) ─────

describe('autosteer scenario — multi-line autosteer content (rc.12 oneLine match)', () => {
  test('newline-containing autosteer content matches the post-paste oneLine form in JSONL', async () => {
    const { p, sim, events, cleanup } = await setupScenario();
    try {
      sim.scheduleReply(/how many lines/, 'Three lines.', { delayMs: 5 });
      // Real polygram prompts have newlines inside <polygram-info>.
      const multiLineContent = '<polygram-info>line1\nline2\nline3</polygram-info>\n<channel>how many lines</channel>';

      const sendP = p.send('<polygram-info>primary turn</polygram-info>');
      await sleep(20);
      sim.nextQueueNewTurn();
      p.injectUserMessage({ content: multiLineContent, msgId: 555 });

      await sendP;
      await sim.waitForIdle();
      await sleep(80);

      // The TUI paste serialises \n → ' / '. _pendingAutosteers must
      // store the oneLine form for the match to succeed.
      const started = events.filter((e) => e.name === 'extra-turn-started');
      const replied = events.filter((e) => e.name === 'extra-turn-reply');
      assert.equal(started.length, 1,
        'rc.12: extra-turn-started MUST fire for multi-line autosteer (was 100% broken pre-rc.12)');
      assert.equal(replied.length, 1);
      assert.equal(replied[0].payload.msgId, 555);

      await p.kill('done');
    } finally { cleanup(); }
  });
});

// ─── SCENARIO 4: extra-turn in progress + new pm.send arrives (rc.13) ─────

describe('autosteer scenario — extra-turn running + new pm.send (rc.13 priority routing)', () => {
  test('turn 2 (extra-turn) reply is correctly attributed to its msgId even when turn 3 is queued', async () => {
    const { p, sim, events, cleanup } = await setupScenario();
    try {
      sim.scheduleReply(/turn1/, 'turn1-reply', { delayMs: 5 });
      sim.scheduleReply(/turn2-content/, 'turn2-extra-reply', { delayMs: 20 });
      sim.scheduleReply(/turn3/, 'turn3-reply', { delayMs: 5 });

      // Turn 1
      const turn1P = p.send('<polygram-info>turn1</polygram-info>');
      await sleep(20);
      // Autosteer msg 692 (will become turn 2 as new-turn).
      sim.nextQueueNewTurn();
      p.injectUserMessage({
        content: '<polygram-info>turn2-content</polygram-info>',
        msgId: 692,
      });
      await turn1P;
      // Now turn 2 is starting in the simulator. Before turn 2's
      // result arrives, start a new pm.send (msg 694, turn 3).
      const turn3P = p.send('<polygram-info>turn3</polygram-info>');
      // The simulator queues turn 3's submission behind turn 2.

      await turn3P;
      await sim.waitForIdle();
      await sleep(80);

      const replied = events.filter((e) => e.name === 'extra-turn-reply');
      assert.equal(replied.length, 1,
        'rc.13: extra-turn-reply MUST fire for msg 692 even with turn 3 already in flight');
      assert.equal(replied[0].payload.msgId, 692,
        'reply must NOT be mis-attributed to turn 3');
      assert.match(replied[0].payload.text, /turn2-extra-reply/);

      // turn 3 got its own reply
      assert.match((await turn3P).text, /turn3-reply/);

      await p.kill('done');
    } finally { cleanup(); }
  });
});

// ─── SCENARIO 5: tool-use stop_reason is intermediate (rc.11 fix) ─────

describe('autosteer scenario — tool_use stop_reason does NOT prematurely end the turn (rc.11)', () => {
  test('pm.send waits past intermediate tool_use; full text returned', async () => {
    const { p, sim, events, cleanup } = await setupScenario();
    try {
      sim.scheduleReply(/count/, '42 files counted.', {
        delayMs: 5,
        withTool: { name: 'Bash', input: { command: 'ls' }, result: '42' },
      });

      const res = await p.send('<polygram-info>count</polygram-info>');
      assert.match(res.text, /42 files counted/,
        'rc.11: pm.send waits past tool_use and returns the post-tool text');
      assert.ok(res.metrics.numToolUses >= 1, 'tool-use count tracked');

      await p.kill('done');
    } finally { cleanup(); }
  });
});

// ─── SCENARIO 6: concurrent pastes — rc.14 atomicity lock ─────

describe('autosteer scenario — concurrent paste safety (rc.14 atomicity lock)', () => {
  test('with pasteAndEnter lock, concurrent send + injectUserMessage do NOT corrupt prompts', async () => {
    const { p, sim, events, cleanup } = await setupScenario({ useLock: true });
    try {
      sim.scheduleReply(/primary-turn/, 'OK primary.', { delayMs: 5 });
      sim.scheduleReply(/autosteer-turn/, 'OK autosteer.', { delayMs: 5 });

      const sendP = p.send('<polygram-info>primary-turn</polygram-info>');
      // Fire the inject immediately (no sleep) — maximum race.
      p.injectUserMessage({
        content: '<polygram-info>autosteer-turn</polygram-info>',
        msgId: 777,
      });
      sim.nextQueueNewTurn();

      await sendP;
      await sim.waitForIdle();
      await sleep(80);

      // The primary turn's reply must NOT contain bytes from the
      // autosteered content (would indicate paste interleave).
      const primaryResult = await sendP;
      assert.match(primaryResult.text, /OK primary/);
      assert.doesNotMatch(primaryResult.text, /autosteer-turn/,
        'rc.14: primary turn reply must not contain autosteered prompt bytes');

      const replied = events.filter((e) => e.name === 'extra-turn-reply');
      assert.equal(replied.length, 1, 'autosteer reply lands as extra-turn-reply');
      assert.equal(replied[0].payload.msgId, 777);

      await p.kill('done');
    } finally { cleanup(); }
  });
});

// ─── SCENARIO 6b: PROOF that rc.14 race exists when lock is bypassed ───

describe('autosteer scenario — rc.14 PROOF: without the paste lock, concurrent pastes interleave', () => {
  // This test uses the simulator's useLock=false mode to demonstrate
  // that pre-rc.14 code (parallel pasteText + sendControl pairs) DOES
  // produce corruption. If this test passes, the bug is reproducible
  // and the rc.14 fix (above) is necessary. If it fails (no
  // corruption), the simulator isn't faithfully modelling the race.
  test('without the lock: simulator records paste interleave (the bug rc.14 fixes)', async () => {
    const { p, sim, events, cleanup } = await setupScenario({ useLock: false });
    try {
      sim.scheduleReply(/.*/, 'OK', { delayMs: 5 });

      // Fire two pasteAndEnter (in legacy non-locked mode → calls
      // pasteText + sendControl sequentially but the two top-level
      // calls race). Wait briefly then check pasteLog order.
      const p1 = p.send('<polygram-info>AAA-primary</polygram-info>');
      p.injectUserMessage({
        content: '<polygram-info>BBB-autosteer</polygram-info>',
        msgId: 123,
      });
      await p1.catch(() => {});  // turn might fail/timeout in race mode
      await sleep(80);

      // Inspect pasteLog: did the two paste ops land adjacent
      // (proper serialisation) or interleaved with enter from the
      // other call?
      // We expect a paste→enter→paste→enter pattern if locked,
      // or paste→paste→enter→enter (or some other mix) if NOT locked.
      const ops = sim.pasteLog.filter((e) => e.op === 'paste' || e.op === 'enter');
      // Detect interleave: any paste followed immediately by another
      // paste WITHOUT an intervening enter signals concurrent overlap.
      let foundInterleave = false;
      for (let i = 0; i < ops.length - 1; i++) {
        if (ops[i].op === 'paste' && ops[i + 1].op === 'paste') {
          foundInterleave = true;
          break;
        }
      }
      assert.equal(foundInterleave, true,
        'rc.14 PROOF: without the per-session lock, two pasteText calls land back-to-back without an intervening Enter — exactly the race that corrupted msg 696\'s prompt on shumorobot 2026-05-15');

      await p.kill('done');
    } finally { cleanup(); }
  });
});

// ─── SCENARIO 7: no autosteer attempted — sanity ───────────────────

describe('autosteer scenario — single turn no autosteer (sanity)', () => {
  test('single pm.send with no inject emits no autosteer events', async () => {
    const { p, sim, events, cleanup } = await setupScenario();
    try {
      sim.scheduleReply(/hi/, 'hello back', { delayMs: 5 });
      const res = await p.send('<polygram-info>hi</polygram-info>');
      assert.match(res.text, /hello back/);
      await sleep(40);

      const autosteerEvents = events.filter((e) =>
        e.name === 'extra-turn-started' || e.name === 'extra-turn-reply'
        || e.name === 'autosteer-resolution' || e.name === 'autosteer-match-miss',
      );
      assert.equal(autosteerEvents.length, 0,
        'no autosteer events should fire when nothing was autosteered');

      await p.kill('done');
    } finally { cleanup(); }
  });
});

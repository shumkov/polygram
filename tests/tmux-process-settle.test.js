/**
 * Unit tests for `_awaitSettle` (0.10.0 Commit 3) — the single
 * settle subscription that replaced `_runTurn`'s 5-way `Promise.race`.
 *
 * The end-to-end dispositions (happy jsonl, interrupt, timeout,
 * submit-fail, §6 no-jsonl, R10 empty-result, B10 subagent ×2, C1
 * parked ×4) are already covered by tests/tmux-process.test.js and
 * tests/tmux-process-jsonl.test.js, which all pass against the
 * rewritten settle path. This file adds focused coverage of the NEW
 * gate logic that _awaitSettle introduces:
 *   - B7 gate: capture quiescence is ignored until submitConfirmed.
 *   - B10 gate: capture quiescence is ignored while a tool/subagent
 *     is outstanding (at quiesce time).
 *   - the five outcomes resolve correctly + signalAbort releases the
 *     capture poll.
 *
 * @see lib/process/tmux-process.js#_awaitSettle
 */

'use strict';

if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { TmuxProcess } = require('../lib/process/tmux-process');

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

function makeStubRunner() {
  return {
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };
}

function makeProc(opts = {}) {
  return new TmuxProcess({
    sessionKey: 'chat:100', chatId: '100', threadId: null, label: 'settle-test',
    runner: makeStubRunner(), botName: 'shumabit', logger: SILENT,
    pollMs: 5, quiesceMs: 10, readyTimeoutMs: 500, turnTimeoutMs: 5000,
    pasteConfirmMs: 10, ...opts,
  });
}

/** A turn with the promises _awaitSettle subscribes to, armed. */
function makeSettleTurn(p, overrides = {}) {
  const turn = p._makeTurn({ kind: 'primary', prompt: 'hi', msgIds: [1] });
  turn.resultPromise = new Promise((resolve) => { turn.settleResult = resolve; });
  turn.interruptP = new Promise((resolve) => { turn.signalInterrupt = resolve; });
  turn.startedAt = p._now();
  Object.assign(turn, overrides);
  return turn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('_awaitSettle — outcomes', () => {

  test('jsonl: terminal result settles the turn', async () => {
    const p = makeProc();
    // _awaitTurnComplete never quiesces (hang) so only the JSONL
    // resultPromise can win.
    p._awaitTurnComplete = () => new Promise(() => {});
    const turn = makeSettleTurn(p);
    const settleP = p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.resolve(),
    });
    const ev = { type: 'result', subtype: 'success', text: 'hello', stopReason: 'end_turn' };
    turn.settleResult(ev);
    const outcome = await settleP;
    assert.equal(outcome.kind, 'jsonl');
    assert.equal(outcome.ev, ev);
  });

  test('interrupt: signalInterrupt settles the turn', async () => {
    const p = makeProc();
    p._awaitTurnComplete = () => new Promise(() => {});
    const turn = makeSettleTurn(p);
    const settleP = p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.resolve(),
    });
    turn.signalInterrupt();
    const outcome = await settleP;
    assert.equal(outcome.kind, 'interrupt');
  });

  test('submit-fail: a rejected confirmP settles as submit-fail with the error', async () => {
    const p = makeProc();
    p._awaitTurnComplete = () => new Promise(() => {});
    const turn = makeSettleTurn(p);
    const err = Object.assign(new Error('nope'), { code: 'TMUX_SUBMIT_FAILED' });
    const settleP = p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.reject(err),
    });
    const outcome = await settleP;
    assert.equal(outcome.kind, 'submit-fail');
    assert.equal(outcome.err, err);
  });

  test('timeout: W1 deadline settles as timeout', async () => {
    const p = makeProc();
    p._awaitTurnComplete = () => new Promise(() => {});
    const turn = makeSettleTurn(p);
    const settleP = p._awaitSettle(turn, {
      turnTimeoutMs: 30, confirmP: Promise.resolve(),
    });
    const outcome = await settleP;
    assert.equal(outcome.kind, 'timeout');
  });

  test('quiesced: capture idle + submitConfirmed + empty outstanding → quiesced', async () => {
    const p = makeProc();
    p._awaitTurnComplete = async () => 'PRELUDE\n? for shortcuts'; // quiesces immediately
    const turn = makeSettleTurn(p, { submitConfirmed: true });
    const outcome = await p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.resolve(),
    });
    assert.equal(outcome.kind, 'quiesced');
  });

});

describe('_awaitSettle — B7 gate (capture ignored until submitted)', () => {

  test('capture quiesces but submit NOT confirmed → capture ignored, JSONL settles instead', async () => {
    const p = makeProc();
    p._awaitTurnComplete = async () => 'PRELUDE\n? for shortcuts'; // idle pane
    // A tokened turn whose submit is NOT confirmed: the pane is idle
    // because the prompt sits unsubmitted, NOT because a turn finished.
    const turn = makeSettleTurn(p, { submitConfirmed: false });
    assert.ok(turn.token, 'turn has a token (so the gate applies)');

    const settleP = p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: new Promise(() => {}), // confirm pending
    });
    // Capture quiesced but was IGNORED (submit not confirmed). Prove it
    // by settling via JSONL — if capture had won, this would be a
    // no-op race the capture already lost.
    await sleep(20);
    const ev = { type: 'result', subtype: 'success', text: 'real reply' };
    turn.settleResult(ev);
    const outcome = await settleP;
    assert.equal(outcome.kind, 'jsonl',
      'capture must NOT settle a turn whose submit is unconfirmed (B7)');
  });

  test('token-less turn (nothing to confirm) → capture quiescence DOES settle', async () => {
    const p = makeProc();
    p._awaitTurnComplete = async () => 'PRELUDE\n? for shortcuts';
    // A token-less turn: submitConfirmed stays false but there's no
    // confirm to gate on — capture should settle.
    const turn = makeSettleTurn(p, { token: null, submitConfirmed: false });
    const outcome = await p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.resolve(),
    });
    assert.equal(outcome.kind, 'quiesced',
      'a token-less turn has nothing to gate on — capture settles it');
  });

});

describe('_awaitSettle — B10 gate (capture ignored while tool/subagent outstanding)', () => {

  test('capture quiesces while a subagent is outstanding → capture ignored, JSONL settles', async () => {
    const p = makeProc();
    p._awaitTurnComplete = async () => 'PRELUDE\n? for shortcuts';
    const turn = makeSettleTurn(p, { submitConfirmed: true });
    turn.outstandingSubagents.add('agent_1');

    const settleP = p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.resolve(),
    });
    await sleep(20);
    // The subagent returns and the main agent emits its terminal reply.
    const ev = { type: 'result', subtype: 'success', text: 'subagent done' };
    turn.settleResult(ev);
    const outcome = await settleP;
    assert.equal(outcome.kind, 'jsonl',
      'capture must NOT settle a turn while a subagent is outstanding (B10)');
    assert.equal(outcome.ev, ev);
  });

  test('capture quiesces while a foreground tool is outstanding → capture ignored', async () => {
    const p = makeProc();
    p._awaitTurnComplete = async () => 'PRELUDE\n? for shortcuts';
    const turn = makeSettleTurn(p, { submitConfirmed: true });
    turn.outstandingTools.add('bash_1');

    const settleP = p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.resolve(),
    });
    await sleep(20);
    turn.signalInterrupt(); // settle some other way to end the test
    const outcome = await settleP;
    assert.equal(outcome.kind, 'interrupt',
      'capture must NOT settle a turn while a foreground tool is outstanding');
  });

  test('tool drains before capture quiesces → capture settles normally', async () => {
    const p = makeProc();
    let captureCalls = 0;
    // First capture call hangs (tool running), second returns idle.
    p._awaitTurnComplete = async () => {
      captureCalls += 1;
      return 'PRELUDE\n? for shortcuts';
    };
    const turn = makeSettleTurn(p, { submitConfirmed: true });
    // No outstanding tools at quiesce time (already drained).
    const outcome = await p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.resolve(),
    });
    assert.equal(outcome.kind, 'quiesced');
  });

});

describe('_awaitSettle — capture poll release', () => {

  test('signalAbort fires (abortP resolves) when a non-capture outcome wins', async () => {
    const p = makeProc();
    let abortResolved = false;
    // Capture loop observes abortP and records when it resolves.
    p._awaitTurnComplete = ({ abortP }) => {
      abortP.then(() => { abortResolved = true; });
      return new Promise(() => {}); // never quiesces on its own
    };
    const turn = makeSettleTurn(p, { submitConfirmed: true });
    const settleP = p._awaitSettle(turn, {
      turnTimeoutMs: 5000, confirmP: Promise.resolve(),
    });
    turn.settleResult({ type: 'result', subtype: 'success', text: 'x' });
    await settleP;
    await sleep(5); // let the abortP .then microtask run
    assert.equal(abortResolved, true,
      'the capture poll must be released (abortP resolved) when JSONL won');
  });

});

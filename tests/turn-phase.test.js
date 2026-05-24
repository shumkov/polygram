/**
 * Unit tests for the 0.10.0 turn-phase predicate (Commit 1, observer-
 * only). Drives the predicate via canned event sequences and asserts
 * the expected TurnPhase trajectory.
 *
 * Replays the three production traces that motivated the structural
 * fix:
 *   - C1 (2026-05-20): TUI parks the primary paste while busy.
 *     `queue-operation enqueue` carrying our corr-id → `paste-parked`,
 *     a future `_scheduleSubmitRetries` reads `turn.parked === true`
 *     and stops re-sending Enter.
 *   - C2 (2026-05-20): subagent launches AFTER §6 grace. Capture-pane
 *     quiescence does NOT win — the predicate stays in
 *     `subagent-running` while the main pane is silent.
 *   - B10 long subagent: 11 minutes of main-JSONL silence; predicate
 *     stays in `subagent-running` until the `Agent` tool_result lands.
 *
 * Plus the legal-transition graph (turn-phase module) and the
 * burst-of-5 autosteer scenario.
 *
 * Tests use the predicate in isolation — no runner / JSONL tail / poll
 * loops. The wiring tests live in tmux-process-jsonl.test.js (they
 * already cover the JSONL routing; this file proves the predicate
 * computes the right phase given those events).
 *
 * @see docs/0.10.0-tmux-patience-model-solution.md
 */

'use strict';

if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { TmuxProcess } = require('../lib/process/tmux-process');
const {
  TurnPhase,
  ACTIVE_PHASES,
  TERMINAL_PHASES,
  isActive,
  isTerminal,
  isLegalTransition,
  ALLOWED_TRANSITIONS,
} = require('../lib/process/turn-phase');

const SILENT = {
  warn: () => {}, error: () => {}, info: () => {},
  debug: () => {}, log: () => {},
};

/** Stub runner — only the construction-time methods need to exist
 *  (TmuxProcess constructor calls runner.sessionName + debugLogPath).
 *  No method is invoked by the predicate tests. */
function makeStubRunner() {
  return {
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };
}

/** Minimal TmuxProcess instance for predicate testing — never starts
 *  a real tmux session; we only use `_makeTurn` + `_handleSessionEvent`
 *  + the predicate methods. */
function makeProc() {
  const p = new TmuxProcess({
    sessionKey: 'chat:100', chatId: '100', threadId: null, label: 'pred-test',
    runner: makeStubRunner(),
    botName: 'shumabit', logger: SILENT,
    pollMs: 5, quiesceMs: 10, readyTimeoutMs: 500, turnTimeoutMs: 5000,
    pasteConfirmMs: 10,
  });
  // Stub `_now` to a controllable clock so phaseSince / lastActivityAt
  // are deterministic. Tests advance the clock manually.
  let clock = 1_000_000;
  p._now = () => clock;
  p._advanceClock = (ms) => { clock += ms; };
  return p;
}

/** Stage a turn so the predicate has something to operate on. Pushes
 *  to the active group and the ledger so `_handleSessionEvent` routes
 *  there. */
function stageTurn(p, prompt = 'hello', kind = 'primary') {
  const turn = p._makeTurn({ kind, prompt, msgIds: [1] });
  p._ledger.push(turn);
  p._activeGroup = {
    text: '', turns: [turn], primaryTurnId: kind === 'primary' ? turn.turnId : null,
    pendingSteerCausesNewBubble: false,
  };
  return turn;
}

/** Collect phase-change events for assertions. */
function recordPhases(p) {
  const events = [];
  p.on('phase-change', (ev) => events.push(ev));
  return events;
}

describe('turn-phase module — enum + helpers', () => {

  test('enum values are unique strings', () => {
    const vals = Object.values(TurnPhase);
    assert.equal(new Set(vals).size, vals.length, 'phase values must be unique');
    for (const v of vals) assert.equal(typeof v, 'string');
  });

  test('ACTIVE_PHASES + inactive partition every phase', () => {
    const all = new Set(Object.values(TurnPhase));
    const inactive = new Set([
      TurnPhase.QUEUED, TurnPhase.QUIET, TurnPhase.WEDGED,
      TurnPhase.DONE, TurnPhase.FAILED,
    ]);
    for (const v of all) {
      const a = ACTIVE_PHASES.has(v);
      const i = inactive.has(v);
      assert.equal(a !== i, true,
        `phase ${v}: exactly one of active/inactive (active=${a}, inactive=${i})`);
    }
  });

  test('TERMINAL_PHASES are DONE + FAILED only', () => {
    assert.equal(TERMINAL_PHASES.size, 2);
    assert.ok(TERMINAL_PHASES.has(TurnPhase.DONE));
    assert.ok(TERMINAL_PHASES.has(TurnPhase.FAILED));
  });

  test('isActive / isTerminal classify correctly', () => {
    assert.equal(isActive(TurnPhase.STREAMING), true);
    assert.equal(isActive(TurnPhase.QUIET), false);
    assert.equal(isTerminal(TurnPhase.DONE), true);
    assert.equal(isTerminal(TurnPhase.STREAMING), false);
  });

  test('isLegalTransition accepts the documented graph', () => {
    // QUEUED → PASTED_UNCONFIRMED is the canonical start.
    assert.equal(isLegalTransition(TurnPhase.QUEUED, TurnPhase.PASTED_UNCONFIRMED), true);
    // PASTED_UNCONFIRMED → SUBMITTED is normal warm-session path.
    assert.equal(isLegalTransition(TurnPhase.PASTED_UNCONFIRMED, TurnPhase.SUBMITTED), true);
    // SUBMITTED → DONE legal (a quick text-only reply).
    assert.equal(isLegalTransition(TurnPhase.SUBMITTED, TurnPhase.DONE), true);
    // Self-transition is a no-op but legal (predicate may re-affirm).
    assert.equal(isLegalTransition(TurnPhase.STREAMING, TurnPhase.STREAMING), true);
  });

  test('isLegalTransition rejects illegal jumps', () => {
    // Terminal phases are absorbing.
    assert.equal(isLegalTransition(TurnPhase.DONE, TurnPhase.STREAMING), false);
    assert.equal(isLegalTransition(TurnPhase.FAILED, TurnPhase.DONE), false);
    // QUEUED can advance to PASTED_UNCONFIRMED, PASTE_PARKED, SUBMITTED,
    // or FAILED — see the QUEUED→PASTE_PARKED and QUEUED→SUBMITTED
    // tests below for the cold-start race rationales. Steady-running
    // phases beyond submitted (STREAMING, DONE, etc.) are NOT
    // reachable directly from QUEUED.
    assert.equal(isLegalTransition(TurnPhase.QUEUED, TurnPhase.STREAMING), false);
    assert.equal(isLegalTransition(TurnPhase.QUEUED, TurnPhase.DONE), false);
  });

  // rc.35 production regression (2026-05-22): the predicate WARN
  // `phase illegal transition: queued → paste-parked (reason
  // jsonl:queue-operation:enqueue)` fired on every freshly-stacked
  // Music message after a cold-start respawn. Root cause: when a
  // paste arrives while claude TUI is still cold-starting (or busy
  // with an in-flight turn), the JSONL emits `queue-operation:enqueue`
  // BEFORE the corresponding `user-message`. The predicate's path
  // for `queue-operation:enqueue` sets PASTE_PARKED directly, so the
  // observed transition is `QUEUED → PASTE_PARKED` without ever
  // passing through PASTED_UNCONFIRMED. This is a legitimate
  // real-world flow (Commit 2 introduced PASTE_PARKED specifically
  // for this enqueue-before-user-message ordering) — the predicate
  // table just hadn't been updated to permit it. `_setPhase` applies
  // the transition regardless of legality, so the bug manifested as
  // log noise only until Commit 3 (rc.35) started consuming
  // predicate fields more strictly.
  test('isLegalTransition accepts QUEUED → PASTE_PARKED (cold-start enqueue)', () => {
    assert.equal(isLegalTransition(TurnPhase.QUEUED, TurnPhase.PASTE_PARKED), true,
      'queue-operation:enqueue can land before user-message when TUI is busy/cold-starting');
  });

  // rc.49 (production 2026-05-24, shumorobot HOME): symmetric to the
  // rc.35→rc.36 PASTE_PARKED fix above. Observed warning:
  // `[Shumabit@HOME] phase illegal transition: queued → submitted
  // (turn 3, reason jsonl:user-message)`. Root cause: the JSONL
  // `user-message` event arrived BEFORE the `paste:returned` event
  // (which would have first advanced QUEUED → PASTED_UNCONFIRMED).
  // This is a known race — the TUI's JSONL emitter and the
  // pasteAndEnter event-return ordering aren't guaranteed. As with
  // QUEUED→PASTE_PARKED, the predicate table just hadn't been
  // updated to permit the direct path; the actual control flow
  // tolerates it (the eventual paste-returned still flows in).
  // `_setPhase` warns-and-applies on illegal transitions, so the
  // bug is observer-only — but it's noise we should silence.
  test('isLegalTransition accepts QUEUED → SUBMITTED (user-message-before-paste-returned race)', () => {
    assert.equal(isLegalTransition(TurnPhase.QUEUED, TurnPhase.SUBMITTED), true,
      'jsonl:user-message can land before paste:returned when TUI submit is fast');
  });

  test('every phase has an entry in ALLOWED_TRANSITIONS', () => {
    for (const v of Object.values(TurnPhase)) {
      assert.ok(ALLOWED_TRANSITIONS[v] !== undefined,
        `phase ${v} must be in ALLOWED_TRANSITIONS`);
    }
  });

});

describe('predicate — _setPhase + phase-change emission', () => {

  test('_setPhase emits phase-change with prev/next/reason', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    const events = recordPhases(p);

    const changed = p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'test:paste');
    assert.equal(changed, true);
    assert.equal(turn.phase, TurnPhase.PASTED_UNCONFIRMED);
    assert.equal(events.length, 1);
    assert.equal(events[0].prev, TurnPhase.QUEUED);
    assert.equal(events[0].next, TurnPhase.PASTED_UNCONFIRMED);
    assert.equal(events[0].reason, 'test:paste');
    assert.equal(events[0].turnId, turn.turnId);
  });

  test('_setPhase to the same phase is a no-op (no event)', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'first');
    const events = recordPhases(p);
    const changed = p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'second');
    assert.equal(changed, false);
    assert.equal(events.length, 0);
  });

  test('illegal transition logs a warning but still applies (observer-only)', () => {
    const warnings = [];
    const p = makeProc();
    p.logger = {
      ...SILENT,
      warn: (m) => warnings.push(m),
    };
    const turn = stageTurn(p);
    // QUEUED → STREAMING is illegal.
    p._setPhase(turn, TurnPhase.STREAMING, 'illegal-jump');
    assert.equal(turn.phase, TurnPhase.STREAMING, 'observer-only must not block');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /illegal transition: queued → streaming/);
  });

  test('_heartbeat bumps lastActivityAt without changing phase', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.STREAMING, 'init');
    const before = turn.lastActivityAt;
    p._advanceClock(500);
    p._heartbeat(turn, 'capture:streaming');
    assert.equal(turn.phase, TurnPhase.STREAMING);
    assert.equal(turn.lastActivityAt, before + 500);
  });

});

describe('predicate — JSONL event transitions', () => {

  test('user-message → SUBMITTED + submitConfirmed', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'init');
    p._handleSessionEvent({
      type: 'user-message',
      text: `<polygram-info corr-id="${turn.token}"></polygram-info>\nhi`,
    });
    assert.equal(turn.phase, TurnPhase.SUBMITTED);
    assert.equal(turn.submitConfirmed, true);
  });

  test('assistant-chunk → STREAMING', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.SUBMITTED, 'init');
    p._handleSessionEvent({ type: 'assistant-chunk', text: 'partial reply' });
    assert.equal(turn.phase, TurnPhase.STREAMING);
  });

  test('non-Agent tool-use → TOOL_RUNNING + outstandingTools tracked', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.STREAMING, 'init');
    p._handleSessionEvent({ type: 'tool-use', name: 'Bash', id: 'bash_1' });
    assert.equal(turn.phase, TurnPhase.TOOL_RUNNING);
    assert.ok(turn.outstandingTools.has('bash_1'));
  });

  test('Agent tool-use → SUBAGENT_RUNNING + outstandingSubagents tracked', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.STREAMING, 'init');
    p._handleSessionEvent({ type: 'tool-use', name: 'Agent', id: 'agent_1' });
    assert.equal(turn.phase, TurnPhase.SUBAGENT_RUNNING);
    assert.ok(turn.outstandingSubagents.has('agent_1'));
  });

  test('tool-result drains outstandingTools and returns to STREAMING', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.STREAMING, 'init');
    p._handleSessionEvent({ type: 'tool-use', name: 'Bash', id: 'bash_1' });
    assert.equal(turn.phase, TurnPhase.TOOL_RUNNING);
    p._handleSessionEvent({ type: 'tool-result', toolUseId: 'bash_1' });
    assert.equal(turn.phase, TurnPhase.STREAMING);
    assert.equal(turn.outstandingTools.size, 0);
  });

  test('terminal result → DONE', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.STREAMING, 'init');
    p._handleSessionEvent({
      type: 'result',
      subtype: 'success',
      stopReason: 'end_turn',
      text: 'done',
    });
    assert.equal(turn.phase, TurnPhase.DONE);
  });

  test('non-terminal tool_use result does NOT move turn to done', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.TOOL_RUNNING, 'init');
    p._handleSessionEvent({ type: 'result', subtype: 'tool_use' });
    assert.equal(turn.phase, TurnPhase.TOOL_RUNNING);
  });

});

describe('predicate — C1 trace: TUI parks primary paste while busy', () => {

  test('queue-operation enqueue carrying our corr-id → PASTE_PARKED + parked flag', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'paste:returned');

    // C1: the TUI is busy with a prior turn; our paste is parked.
    p._handleSessionEvent({
      type: 'queue-operation',
      operation: 'enqueue',
      content: `<polygram-info corr-id="${turn.token}"></polygram-info>\nthe parked prompt`,
    });

    assert.equal(turn.phase, TurnPhase.PASTE_PARKED);
    assert.equal(turn.parked, true);
  });

  test('parked paste eventually receives user-message → SUBMITTED', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'paste:returned');
    p._handleSessionEvent({
      type: 'queue-operation', operation: 'enqueue',
      content: `<polygram-info corr-id="${turn.token}"></polygram-info>\nparked`,
    });
    assert.equal(turn.phase, TurnPhase.PASTE_PARKED);

    // Prior turn completes; TUI dequeues ours and emits user-message.
    p._handleSessionEvent({
      type: 'user-message',
      text: `<polygram-info corr-id="${turn.token}"></polygram-info>\nparked`,
    });
    assert.equal(turn.phase, TurnPhase.SUBMITTED);
    assert.equal(turn.parked, true, 'parked flag stays true (history); phase moves');
    assert.equal(turn.submitConfirmed, true);
  });

  test('enqueue without our corr-id does NOT park us', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'init');
    p._handleSessionEvent({
      type: 'queue-operation', operation: 'enqueue',
      content: '<polygram-info corr-id="pgm-corr-000000000000000000000000"></polygram-info>',
    });
    assert.equal(turn.phase, TurnPhase.PASTED_UNCONFIRMED);
    assert.equal(turn.parked, false);
  });

});

describe('predicate — C2 trace: subagent launches AFTER §6 grace', () => {

  test('subagent tool-use → SUBAGENT_RUNNING; tool-result drains it', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    // Timeline:
    //   t+0     user-message  (submitted)
    //   t+200ms assistant-chunk "I'll delegate..."  (streaming)
    //   t+2500ms tool-use Agent ag_1                 (subagent-running)
    //   ...11 min main-pane quiescent...             (predicate stays)
    //   t+670s  tool-result Agent ag_1               (back to streaming)
    //   t+672s  assistant-chunk final answer
    //   t+673s  result success                       (done)
    p._handleSessionEvent({
      type: 'user-message',
      text: `<polygram-info corr-id="${turn.token}"></polygram-info>\nrun X`,
    });
    p._advanceClock(200);
    p._handleSessionEvent({ type: 'assistant-chunk', text: "I'll delegate" });
    p._advanceClock(2300);
    p._handleSessionEvent({ type: 'tool-use', name: 'Agent', id: 'ag_1' });
    assert.equal(turn.phase, TurnPhase.SUBAGENT_RUNNING);
    assert.equal(turn.outstandingSubagents.size, 1);

    // 11 minutes of silence — clock advances but no events.
    p._advanceClock(11 * 60 * 1000);
    assert.equal(turn.phase, TurnPhase.SUBAGENT_RUNNING,
      'predicate must stay subagent-running while outstanding subagent ≠ 0');

    p._handleSessionEvent({ type: 'tool-result', toolUseId: 'ag_1' });
    assert.equal(turn.phase, TurnPhase.STREAMING);
    assert.equal(turn.outstandingSubagents.size, 0);

    p._handleSessionEvent({
      type: 'result', subtype: 'success', stopReason: 'end_turn',
    });
    assert.equal(turn.phase, TurnPhase.DONE);
  });

  test('parallel Agents — both must drain before SUBAGENT_RUNNING ends', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.STREAMING, 'init');
    p._handleSessionEvent({ type: 'tool-use', name: 'Agent', id: 'ag_a' });
    p._handleSessionEvent({ type: 'tool-use', name: 'Agent', id: 'ag_b' });
    assert.equal(turn.outstandingSubagents.size, 2);

    p._handleSessionEvent({ type: 'tool-result', toolUseId: 'ag_a' });
    assert.equal(turn.phase, TurnPhase.SUBAGENT_RUNNING,
      'one Agent still outstanding — phase must stay');
    assert.equal(turn.outstandingSubagents.size, 1);

    p._handleSessionEvent({ type: 'tool-result', toolUseId: 'ag_b' });
    assert.equal(turn.phase, TurnPhase.STREAMING);
    assert.equal(turn.outstandingSubagents.size, 0);
  });

  test('Bash + Agent interleaved — tool ledger is separate from subagent ledger', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.STREAMING, 'init');
    p._handleSessionEvent({ type: 'tool-use', name: 'Agent', id: 'ag_1' });
    p._handleSessionEvent({ type: 'tool-use', name: 'Bash', id: 'bash_1' });
    assert.equal(turn.outstandingSubagents.size, 1);
    assert.equal(turn.outstandingTools.size, 1);

    // Bash returns — but Agent still outstanding, so we stay
    // SUBAGENT_RUNNING (predicate prefers the more-active phase).
    p._handleSessionEvent({ type: 'tool-result', toolUseId: 'bash_1' });
    assert.equal(turn.phase, TurnPhase.SUBAGENT_RUNNING,
      'subagent still outstanding — Bash drain leaves subagent phase intact');
    assert.equal(turn.outstandingTools.size, 0);

    p._handleSessionEvent({ type: 'tool-result', toolUseId: 'ag_1' });
    assert.equal(turn.phase, TurnPhase.STREAMING);
  });

});

describe('predicate — phase-change events log full trajectory', () => {

  test('a normal warm-session turn emits the expected phase sequence', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    const events = recordPhases(p);

    p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'paste:returned');
    p._handleSessionEvent({
      type: 'user-message',
      text: `<polygram-info corr-id="${turn.token}"></polygram-info>\nhi`,
    });
    p._handleSessionEvent({ type: 'assistant-chunk', text: 'response' });
    p._handleSessionEvent({
      type: 'result', subtype: 'success', stopReason: 'end_turn',
    });

    const sequence = events.map((e) => e.next);
    assert.deepEqual(sequence, [
      TurnPhase.PASTED_UNCONFIRMED,
      TurnPhase.SUBMITTED,
      TurnPhase.STREAMING,
      TurnPhase.DONE,
    ]);
  });

  test('every emitted event has prev, next, reason, turnId, ts', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    const events = recordPhases(p);
    p._setPhase(turn, TurnPhase.PASTED_UNCONFIRMED, 'paste:returned');
    p._handleSessionEvent({
      type: 'user-message',
      text: `<polygram-info corr-id="${turn.token}"></polygram-info>`,
    });
    for (const ev of events) {
      assert.equal(typeof ev.prev, 'string');
      assert.equal(typeof ev.next, 'string');
      assert.equal(typeof ev.reason, 'string');
      assert.equal(typeof ev.turnId, 'number');
      assert.equal(typeof ev.ts, 'number');
      assert.equal(ev.backend, 'tmux');
    }
  });

});

describe('predicate — burst of autosteers during a working turn', () => {

  test('multiple ledger turns each park on their own corr-id enqueue', () => {
    const p = makeProc();
    // Primary turn is mid-flight; autosteers stack up in the ledger.
    const primary = p._makeTurn({ kind: 'primary', prompt: 'work', msgIds: [1] });
    primary.phase = TurnPhase.SUBAGENT_RUNNING;     // stand-in for live work
    p._ledger.push(primary);

    const a1 = p._makeTurn({ kind: 'autosteer', prompt: 'a', msgIds: [2] });
    const a2 = p._makeTurn({ kind: 'autosteer', prompt: 'b', msgIds: [3] });
    const a3 = p._makeTurn({ kind: 'autosteer', prompt: 'c', msgIds: [4] });
    for (const a of [a1, a2, a3]) {
      a.phase = TurnPhase.PASTED_UNCONFIRMED;
      p._ledger.push(a);
    }
    // Primary is the active group; autosteers live in the ledger but
    // not yet in the active group.
    p._activeGroup = {
      text: '', turns: [primary], primaryTurnId: primary.turnId,
      pendingSteerCausesNewBubble: false,
    };

    // Each autosteer enqueues with its own corr-id.
    for (const a of [a1, a2, a3]) {
      p._handleSessionEvent({
        type: 'queue-operation', operation: 'enqueue',
        content: `<polygram-info corr-id="${a.token}"></polygram-info>`,
      });
    }
    assert.equal(a1.phase, TurnPhase.PASTE_PARKED);
    assert.equal(a2.phase, TurnPhase.PASTE_PARKED);
    assert.equal(a3.phase, TurnPhase.PASTE_PARKED);
    assert.equal(primary.phase, TurnPhase.SUBAGENT_RUNNING,
      'primary remains in its active phase');
  });

});

describe('predicate — terminal phases are absorbing', () => {

  test('events after DONE do not move the phase', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.DONE, 'final');
    const events = recordPhases(p);
    p._handleSessionEvent({ type: 'assistant-chunk', text: 'late chunk' });
    p._handleSessionEvent({ type: 'tool-use', name: 'Bash', id: 'bash_late' });
    assert.equal(turn.phase, TurnPhase.DONE);
    assert.equal(events.length, 0);
  });

  test('events after FAILED do not move the phase', () => {
    const p = makeProc();
    const turn = stageTurn(p);
    p._setPhase(turn, TurnPhase.FAILED, 'submit-fail');
    const events = recordPhases(p);
    p._handleSessionEvent({ type: 'assistant-chunk', text: 'late' });
    p._handleSessionEvent({
      type: 'result', subtype: 'success', stopReason: 'end_turn',
    });
    assert.equal(turn.phase, TurnPhase.FAILED);
    assert.equal(events.length, 0);
  });

});

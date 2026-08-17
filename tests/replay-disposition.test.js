/**
 * Tests for lib/handlers/replay-disposition.js (0.14 boot-replay).
 * Run: node --test tests/replay-disposition.test.js
 *
 * Pins the v3 design: crash → recover all unanswered; deliberate restart →
 * skip all + group per (chat,thread) for visibility notices; dedup drops
 * already-answered from both.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyReplay,
  executeReplayPlan,
  classifyCodexRecoveryEvidence,
} = require('../lib/handlers/replay-disposition');

const C = (chat_id, msg_id, thread_id = null) => ({ chat_id, msg_id, thread_id });

describe('classifyReplay — crash branch (recover all)', () => {
  test('crash recovers every unanswered candidate, no skip, no notice', () => {
    const candidates = [C('-100', 1, '37'), C('-100', 2, '24'), C('-200', 3)];
    const r = classifyReplay({ candidates, cleanShutdown: false });
    assert.equal(r.recover.length, 3);
    assert.equal(r.skip.length, 0);
    assert.equal(r.notices.length, 0);
  });

  test('crash still dedups already-answered (rc.50/rc.51: predicate is the caller\'s hasCompletedTurnFor)', () => {
    const answered = new Set(['-100/2']);
    const candidates = [C('-100', 1, '37'), C('-100', 2, '37')];
    const r = classifyReplay({
      candidates, cleanShutdown: false,
      hasCompletedTurn: (c) => answered.has(`${c.chat_id}/${c.msg_id}`),
    });
    assert.deepEqual(r.recover.map((c) => c.msg_id), [1]);
  });
});

describe('classifyReplay — provider-aware Codex recovery fence', () => {
  const codex = (delivery_state, recovery_state, extra = {}) => ({
    provider: 'codex',
    delivery_state,
    recovery_state,
    ...extra,
  });

  const nestedCodex = ({
    kind = 'selection-only',
    reservation = null,
    attempt = null,
    linkedInput = null,
    targetAttempt = null,
    cancellationProof = null,
  } = {}) => ({
    provider: 'codex',
    kind,
    selection: {
      provider: 'codex',
      sessionKey: 'chat:topic',
      selectedTs: 1000,
    },
    reservation,
    attempt,
    linkedInput,
    targetAttempt,
    cancellationProof,
  });

  const preparedAttempt = (overrides = {}) => ({
    attemptId: 'attempt-a',
    generationId: 'generation-a',
    method: 'turn/start',
    deliveryState: 'prepared',
    recoveryState: 'prepared',
    turnId: null,
    terminalStatus: null,
    ...overrides,
  });

  const safeReservation = (state = 'reserved') => ({
    reservationId: 'reservation-a',
    generationId: 'generation-a',
    state,
    steerAttemptId: null,
    targetAttemptId: null,
  });

  test('crash routes a prepared-only Codex request to the dedicated Codex recoverer', () => {
    const candidate = C('-100', 1, '37');
    const r = classifyReplay({
      candidates: [candidate],
      cleanShutdown: false,
      getProviderRecovery: () => codex('prepared', 'prepared'),
    });
    assert.deepEqual(r.recover, [], 'must not enter the legacy/Claude recover path');
    assert.deepEqual(r.recoverCodex, [candidate]);
    assert.deepEqual(r.skip, []);
    assert.deepEqual(r.notices, []);
  });

  test('clean restart preserves restart intent for prepared-only Codex work', () => {
    const candidate = C('-100', 1, '37');
    const r = classifyReplay({
      candidates: [candidate],
      cleanShutdown: true,
      getProviderRecovery: () => codex('prepared', 'prepared'),
    });
    assert.deepEqual(r.recover, []);
    assert.equal(r.recoverCodex, undefined);
    assert.deepEqual(r.skip, [candidate]);
    assert.equal(r.notices.length, 1);
    assert.deepEqual(r.notices[0].items, [candidate]);
  });

  test('clean restart redispatches exact clean-safe Codex rows without a restart notice', () => {
    const candidates = Array.from(
      { length: 8 },
      (_, index) => C('-100', index + 1, '37'),
    );
    const evidence = new Map([
      [1, nestedCodex()],
      [2, nestedCodex({
        kind: 'dispatch-reservation',
        reservation: safeReservation('reserved'),
      })],
      [3, nestedCodex({
        kind: 'dispatch-reservation',
        reservation: safeReservation('queue-authorized'),
      })],
      [4, nestedCodex({
        kind: 'primary-turn',
        attempt: preparedAttempt(),
      })],
      [5, nestedCodex({
        kind: 'dispatch-reservation',
        reservation: safeReservation('queue-authorized'),
        attempt: preparedAttempt(),
      })],
      [6, nestedCodex({
        kind: 'primary-turn',
        attempt: preparedAttempt({ recoveryState: 'cancelled' }),
        cancellationProof: {
          kind: 'active-start-cancelled',
          reason: 'clean-restart',
        },
      })],
      [7, nestedCodex({
        kind: 'queued-send',
        attempt: preparedAttempt({
          method: 'queued/send',
          recoveryState: 'cancelled',
        }),
        cancellationProof: {
          kind: 'queued-send-cancelled',
          reason: 'clean-restart',
        },
      })],
      [8, nestedCodex({
        kind: 'dispatch-reservation',
        reservation: safeReservation('queue-authorized'),
        attempt: preparedAttempt({ recoveryState: 'cancelled' }),
        cancellationProof: {
          kind: 'active-start-cancelled',
          reason: 'clean-restart',
        },
      })],
    ]);

    for (const value of evidence.values()) {
      assert.equal(
        classifyCodexRecoveryEvidence(value).cleanRestartSafe,
        true,
      );
    }
    const r = classifyReplay({
      candidates,
      cleanShutdown: true,
      getProviderRecovery: (candidate) => evidence.get(candidate.msg_id),
    });
    assert.deepEqual(r.recover, []);
    assert.deepEqual(r.recoverCodex, candidates);
    assert.deepEqual(r.skip, []);
    assert.deepEqual(r.notices, []);
    assert.equal(r.defer, undefined);
  });

  test('clean restart skips user-owned cancellation and defers ambiguous nested evidence', () => {
    const userCancelled = C('-100', 1, '37');
    const timedOut = C('-100', 2, '37');
    const ambiguousReservation = C('-100', 3, '37');
    const linked = C('-100', 4, '37');
    const conflict = C('-100', 5, '37');
    const evidence = new Map([
      [1, nestedCodex({
        kind: 'primary-turn',
        attempt: preparedAttempt({ recoveryState: 'cancelled' }),
      })],
      [2, nestedCodex({
        kind: 'primary-turn',
        attempt: preparedAttempt({ recoveryState: 'cancelled' }),
        cancellationProof: {
          kind: 'active-start-cancelled',
          reason: 'timeout',
        },
      })],
      [3, nestedCodex({
        kind: 'dispatch-reservation',
        reservation: safeReservation('reserved'),
        attempt: preparedAttempt(),
      })],
      [4, nestedCodex({
        kind: 'linked-input',
        reservation: {
          ...safeReservation('steer-accepted'),
          steerAttemptId: 'steer-a',
          targetAttemptId: 'target-a',
        },
        attempt: preparedAttempt({
          attemptId: 'steer-a',
          method: 'turn/steer',
        }),
        linkedInput: {
          linkedInputId: 'reservation-a',
          state: 'linked',
          attemptId: 'steer-a',
          targetAttemptId: 'target-a',
        },
        targetAttempt: preparedAttempt({ attemptId: 'target-a' }),
      })],
      [5, { provider: 'unknown', reason: 'codex-evidence-conflict' }],
    ]);

    const r = classifyReplay({
      candidates: [
        userCancelled,
        timedOut,
        ambiguousReservation,
        linked,
        conflict,
      ],
      cleanShutdown: true,
      getProviderRecovery: (candidate) => evidence.get(candidate.msg_id),
    });
    assert.equal(r.recoverCodex, undefined);
    assert.deepEqual(r.skip, [userCancelled, timedOut]);
    assert.deepEqual(r.notices, []);
    assert.deepEqual(r.defer, [ambiguousReservation, linked, conflict]);
  });

  test('prepared then explicitly cancelled work is skipped silently on crash or clean restart', () => {
    for (const cleanShutdown of [false, true]) {
      const candidate = C('-100', cleanShutdown ? 2 : 1, '37');
      const r = classifyReplay({
        candidates: [candidate],
        cleanShutdown,
        getProviderRecovery: () => codex('prepared', 'cancelled'),
      });
      assert.deepEqual(r.recover, []);
      assert.equal(r.recoverCodex, undefined);
      assert.deepEqual(r.skip, [candidate]);
      assert.deepEqual(r.notices, []);
    }
  });

  test('write-attempted, response-observed, active, terminal, and ambiguous work is deferred', () => {
    const cases = [
      codex('write-attempted', 'ambiguous'),
      codex('response-observed', 'active'),
      codex('response-observed', 'terminal-pending'),
      codex('response-observed', 'clean-pending'),
      codex('response-observed', 'empty-registry-pending'),
      codex('response-observed', 'ambiguous'),
    ];
    for (const [index, evidence] of cases.entries()) {
      const candidate = C('-100', index + 1, '37');
      const r = classifyReplay({
        candidates: [candidate],
        cleanShutdown: false,
        getProviderRecovery: () => evidence,
      });
      assert.deepEqual(r.recover, [], JSON.stringify(evidence));
      assert.equal(r.recoverCodex, undefined, JSON.stringify(evidence));
      assert.deepEqual(r.skip, [], JSON.stringify(evidence));
      assert.deepEqual(r.defer, [candidate], JSON.stringify(evidence));
    }
  });

  test('linked steering input inherits its target and is never replayed independently', () => {
    const candidate = C('-100', 1, '37');
    const evidence = codex('prepared', 'prepared', {
      linked_input_state: 'linked',
      target_delivery_state: 'prepared',
      target_recovery_state: 'prepared',
    });
    const disposition = classifyCodexRecoveryEvidence(evidence);
    assert.deepEqual(disposition, {
      action: 'defer',
      reason: 'linked-input',
      target: {
        action: 'recover',
        reason: 'request-proven-not-accepted',
      },
    });

    const r = classifyReplay({
      candidates: [candidate],
      cleanShutdown: false,
      getProviderRecovery: () => evidence,
    });
    assert.deepEqual(r.recover, []);
    assert.equal(r.recoverCodex, undefined);
    assert.deepEqual(r.skip, []);
    assert.deepEqual(r.defer, [candidate]);
  });

  test('an authoritative resolver error or unknown provider fails closed', () => {
    const candidates = [C('-100', 1), C('-100', 2)];
    const threw = classifyReplay({
      candidates: [candidates[0]],
      getProviderRecovery: () => { throw new Error('ledger unavailable'); },
    });
    const unknown = classifyReplay({
      candidates: [candidates[1]],
      getProviderRecovery: () => null,
    });
    assert.deepEqual(threw.defer, [candidates[0]]);
    assert.deepEqual(unknown.defer, [candidates[1]]);
    assert.deepEqual(threw.recover, []);
    assert.deepEqual(unknown.recover, []);
  });

  test('explicit Claude evidence retains the exact legacy crash policy', () => {
    const candidate = C('-100', 1);
    const r = classifyReplay({
      candidates: [candidate],
      cleanShutdown: false,
      getProviderRecovery: () => ({ provider: 'claude' }),
    });
    assert.deepEqual(r, { recover: [candidate], skip: [], notices: [] });
  });
});

describe('classifyReplay — clean branch (skip all + notices)', () => {
  test('deliberate restart skips all pending, recovers none', () => {
    const candidates = [C('-100', 1, '37'), C('-100', 2, '37'), C('-100', 3, '24')];
    const r = classifyReplay({ candidates, cleanShutdown: true });
    assert.equal(r.recover.length, 0);
    assert.equal(r.skip.length, 3);
  });

  test('notices are grouped per (chat_id, thread_id) — isolateTopics-safe', () => {
    const candidates = [
      C('-100', 1, '37'), C('-100', 2, '37'),  // chat -100 / th37  → one group of 2
      C('-100', 3, '24'),                       // chat -100 / th24  → separate group
      C('-200', 4, null),                       // chat -200 / no thread → separate
    ];
    const r = classifyReplay({ candidates, cleanShutdown: true });
    assert.equal(r.notices.length, 3, 'three distinct (chat,thread) groups');
    const th37 = r.notices.find((n) => n.chat_id === '-100' && n.thread_id === '37');
    assert.equal(th37.items.length, 2);
    const noThread = r.notices.find((n) => n.chat_id === '-200');
    assert.equal(noThread.thread_id, null);
    assert.equal(noThread.items.length, 1);
  });

  test('already-answered candidates are skipped from the notice too (no stale announce)', () => {
    const answered = new Set(['-100/2']);
    const candidates = [C('-100', 1, '37'), C('-100', 2, '37')];
    const r = classifyReplay({
      candidates, cleanShutdown: true,
      hasCompletedTurn: (c) => answered.has(`${c.chat_id}/${c.msg_id}`),
    });
    assert.equal(r.skip.length, 1);
    assert.equal(r.notices.length, 1);
    assert.deepEqual(r.notices[0].items.map((c) => c.msg_id), [1]);
  });

  test('zero pending candidates → no notice (clean restart with nothing pending is silent)', () => {
    const r = classifyReplay({ candidates: [], cleanShutdown: true });
    assert.equal(r.skip.length, 0);
    assert.equal(r.notices.length, 0);
  });

  test('all candidates already answered → no skip, no notice', () => {
    const candidates = [C('-100', 1, '37')];
    const r = classifyReplay({ candidates, cleanShutdown: true, hasCompletedTurn: () => true });
    assert.equal(r.skip.length, 0);
    assert.equal(r.notices.length, 0);
  });
});

describe('classifyReplay — defaults / robustness', () => {
  test('no candidates / no opts → empty plan', () => {
    assert.deepEqual(classifyReplay({}), { recover: [], skip: [], notices: [] });
  });
  test('numeric chat/thread ids group the same as strings would (consistent keying)', () => {
    const r = classifyReplay({ candidates: [C(-100, 1, 37), C(-100, 2, 37)], cleanShutdown: true });
    assert.equal(r.notices.length, 1);
    assert.equal(r.notices[0].items.length, 2);
  });
});

describe('classifyReplay — announceable filter (H5: don\'t announce /new, abort, etc.)', () => {
  test('gate-blocked candidates are SKIPPED but NOT announced', () => {
    const cands = [C('-100', 1, '37'), C('-100', 2, '37')];
    cands[1].text = '/new';
    const announceable = (c) => c.text !== '/new';
    const r = classifyReplay({ candidates: cands, cleanShutdown: true, announceable });
    assert.equal(r.skip.length, 2, 'both skipped (neither re-fires)');
    assert.equal(r.notices.length, 1, 'only the non-/new one is announced');
    assert.deepEqual(r.notices[0].items.map((c) => c.msg_id), [1]);
  });
  test('all-gate-blocked → skip all, zero notices', () => {
    const cands = [C('-100', 1, '37')]; cands[0].text = '/compact';
    const r = classifyReplay({ candidates: cands, cleanShutdown: true, announceable: () => false });
    assert.equal(r.skip.length, 1);
    assert.equal(r.notices.length, 0);
  });
});

describe('executeReplayPlan — crash branch', () => {
  test('recovers each candidate via deps.recover; counts ok vs not', async () => {
    const recovered = [];
    const plan = classifyReplay({ candidates: [C('-100', 1), C('-100', 2)], cleanShutdown: false });
    const res = await executeReplayPlan({
      plan,
      deps: {
        recover: async (c) => { recovered.push(c.msg_id); return { ok: c.msg_id !== 2 }; },
        sendNotice: async () => { throw new Error('must not notice on crash'); },
        markSkipped: () => { throw new Error('must not skip on crash'); },
      },
    });
    assert.deepEqual(recovered, [1, 2]);
    assert.equal(res.recovered, 1);
    assert.equal(res.skipped, 1);
    assert.equal(res.noticed, 0);
  });

  test('a scope-disabled legacy recovery row is deferred without blocking the next row', async () => {
    const disabled = C('-100', 1);
    const recoverable = C('-200', 2);
    const calls = [];
    const events = [];
    const res = await executeReplayPlan({
      plan: {
        recover: [disabled, recoverable],
        skip: [],
        notices: [],
      },
      deps: {
        recover: async (candidate) => {
          calls.push(candidate.msg_id);
          if (candidate === disabled) {
            const error = new Error('Codex is not enabled for this chat');
            error.code = 'CODEX_SCOPE_DISABLED';
            throw error;
          }
          return { ok: true };
        },
        sendNotice: async () => ({ ok: true }),
        markSkipped: () => {},
        logEvent: (kind, detail) => events.push({ kind, detail }),
      },
    });

    assert.deepEqual(calls, [1, 2]);
    assert.equal(res.recovered, 1);
    assert.equal(res.deferred, 1);
    assert.deepEqual(
      events.find((event) => event.kind === 'codex-replay-deferred')?.detail,
      {
        chat_id: '-100',
        thread_id: null,
        msg_id: 1,
        reason: 'scope-disabled',
      },
    );
  });

  test('an unrelated legacy recovery error still rejects the replay batch', async () => {
    const failure = new Error('recovery transport failed');
    await assert.rejects(
      executeReplayPlan({
        plan: {
          recover: [C('-100', 1)],
          skip: [],
          notices: [],
        },
        deps: {
          recover: async () => { throw failure; },
          sendNotice: async () => ({ ok: true }),
          markSkipped: () => {},
        },
      }),
      (error) => error === failure,
    );
  });

  test('Codex recovery never falls through to the legacy/Claude recoverer', async () => {
    const candidate = C('-100', 1);
    const plan = classifyReplay({
      candidates: [candidate],
      cleanShutdown: false,
      getProviderRecovery: () => ({
        provider: 'codex',
        delivery_state: 'prepared',
        recovery_state: 'prepared',
      }),
    });
    let legacyCalls = 0;
    const events = [];
    const res = await executeReplayPlan({
      plan,
      deps: {
        recover: async () => { legacyCalls += 1; return { ok: true }; },
        sendNotice: async () => ({ ok: true }),
        markSkipped: () => {},
        logEvent: (kind, detail) => events.push({ kind, detail }),
      },
    });
    assert.equal(legacyCalls, 0);
    assert.equal(res.recovered, 0);
    assert.equal(res.deferred, 1);
    assert.equal(events[0].kind, 'codex-replay-deferred');
    assert.equal(events[0].detail.reason, 'codex-recoverer-unavailable');
  });

  test('prepared-only Codex work uses the dedicated recoverer', async () => {
    const candidate = C('-100', 1);
    const plan = classifyReplay({
      candidates: [candidate],
      cleanShutdown: false,
      getProviderRecovery: () => ({
        provider: 'codex',
        delivery_state: 'prepared',
        recovery_state: 'prepared',
      }),
    });
    const calls = [];
    const res = await executeReplayPlan({
      plan,
      deps: {
        recover: async () => { throw new Error('must not fail over to Claude'); },
        recoverCodex: async (c) => { calls.push(c); return { ok: true }; },
        sendNotice: async () => ({ ok: true }),
        markSkipped: () => {},
      },
    });
    assert.deepEqual(calls, [candidate]);
    assert.equal(res.recovered, 1);
    assert.equal(res.deferred, undefined);
  });

  test('a scope-disabled Codex row is deferred without blocking the next row', async () => {
    const disabled = C('-100', 1);
    const recoverable = C('-200', 2);
    const plan = classifyReplay({
      candidates: [disabled, recoverable],
      cleanShutdown: false,
      getProviderRecovery: () => ({
        provider: 'codex',
        delivery_state: 'prepared',
        recovery_state: 'prepared',
      }),
    });
    const calls = [];
    const events = [];
    const res = await executeReplayPlan({
      plan,
      deps: {
        recover: async () => {
          throw new Error('must not fail over to Claude');
        },
        recoverCodex: async (candidate) => {
          calls.push(candidate.msg_id);
          if (candidate === disabled) {
            const error = new Error('Codex is not enabled for this chat');
            error.code = 'CODEX_SCOPE_DISABLED';
            throw error;
          }
          return { ok: true };
        },
        sendNotice: async () => ({ ok: true }),
        markSkipped: () => {},
        logEvent: (kind, detail) => events.push({ kind, detail }),
      },
    });

    assert.deepEqual(calls, [1, 2]);
    assert.equal(res.recovered, 1);
    assert.equal(res.deferred, 1);
    assert.deepEqual(
      events.find((event) => event.kind === 'codex-replay-deferred')?.detail,
      {
        chat_id: '-100',
        thread_id: null,
        msg_id: 1,
        reason: 'scope-disabled',
      },
    );
  });
});

describe('executeReplayPlan — clean branch (notice-then-mark ordering, H6)', () => {
  test('on confirmed notice send, rows are marked skipped', async () => {
    const skippedMarks = []; const events = [];
    const plan = classifyReplay({ candidates: [C('-100', 1, '37'), C('-100', 2, '37')], cleanShutdown: true });
    const res = await executeReplayPlan({
      plan,
      deps: {
        recover: async () => { throw new Error('no recover on clean'); },
        sendNotice: async (g) => ({ ok: true, messageId: 555 }),
        markSkipped: (c) => skippedMarks.push(c.msg_id),
        logEvent: (k, d) => events.push([k, d]),
      },
    });
    assert.deepEqual(skippedMarks.sort(), [1, 2]);
    assert.equal(res.noticed, 1);
    assert.ok(events.find((e) => e[0] === 'replay-notice-sent' && e[1].notice_msg_id === 555));
  });

  test('on notice FAILURE, rows are LEFT (recoverable) — not marked skipped', async () => {
    const skippedMarks = []; const events = [];
    const plan = classifyReplay({ candidates: [C('-100', 1, '37')], cleanShutdown: true });
    const res = await executeReplayPlan({
      plan,
      deps: {
        recover: async () => ({ ok: false }),
        sendNotice: async () => { throw new Error('429 rate limited'); },
        markSkipped: (c) => skippedMarks.push(c.msg_id),
        logEvent: (k, d) => events.push([k, d]),
      },
    });
    assert.deepEqual(skippedMarks, [], 'no rows marked terminal when the notice failed');
    assert.equal(res.noticeFailed, 1);
    assert.ok(events.find((e) => e[0] === 'replay-notice-failed' && /rate limited/.test(e[1].error)));
  });

  test('gate-blocked skip items are marked skipped SILENTLY (no notice)', async () => {
    const skippedMarks = []; const sent = [];
    const c1 = C('-100', 1, '37'); const c2 = C('-100', 2, '37'); c2.text = '/new';
    const plan = classifyReplay({
      candidates: [c1, c2], cleanShutdown: true, announceable: (c) => c.text !== '/new',
    });
    await executeReplayPlan({
      plan,
      deps: {
        recover: async () => ({ ok: false }),
        sendNotice: async (g) => { sent.push(g.items.map((c) => c.msg_id)); return { ok: true }; },
        markSkipped: (c) => skippedMarks.push(c.msg_id),
      },
    });
    assert.deepEqual(sent, [[1]], 'only msg 1 announced');
    assert.deepEqual(skippedMarks.sort(), [1, 2], 'both marked terminal (msg 2 silently)');
  });
});

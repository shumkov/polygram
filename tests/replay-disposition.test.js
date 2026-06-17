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

const { classifyReplay, executeReplayPlan } = require('../lib/handlers/replay-disposition');

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

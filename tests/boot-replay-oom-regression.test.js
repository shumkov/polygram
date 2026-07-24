'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb, insertInbound } = require('./helpers/db-fixture');
const { persistShutdownDisposition } = require('../lib/ops/shutdown-disposition');
const { classifyReplay, executeReplayPlan } = require('../lib/handlers/replay-disposition');

test("OOM-stopped service recovers the unfinished turn instead of sending the didn't-auto-resume notice", async (t) => {
  const { db, dbPath } = freshDb('boot-replay-oom');
  t.after(() => cleanupDb(dbPath, db));

  const now = Date.now();
  insertInbound(db, {
    bot_name: 'shumabit',
    chat_id: '-1001',
    msg_id: 101,
    text: 'unfinished request',
    handler_status: 'processing',
    ts: now - 1_000,
  });
  insertInbound(db, {
    bot_name: 'shumabit',
    chat_id: '-1001',
    msg_id: 102,
    text: 'already completed request',
    handler_status: 'dispatched',
    ts: now - 500,
  });
  db.insertTurnMetric({
    ts: now,
    chat_id: '-1001',
    msg_id: 102,
    bot_name: 'shumabit',
    result_subtype: 'success',
  });

  persistShutdownDisposition({
    db,
    botName: 'shumabit',
    now,
    observation: {
      status: 'detected',
      detected: true,
      delta: 1n,
    },
  });

  const marker = db.consumeCleanShutdownMarker({
    botName: 'shumabit',
    now: now + 1_000,
    maxAgeMs: 10 * 60 * 1000,
  });
  const candidates = db.getReplayCandidates({
    chatIds: ['-1001'],
    olderThanMs: 10 * 60 * 1000,
  });
  const plan = classifyReplay({
    candidates,
    cleanShutdown: marker.clean,
    hasCompletedTurn: (row) => db.hasCompletedTurnFor(row),
  });

  const recovered = [];
  const notices = [];
  const result = await executeReplayPlan({
    plan,
    deps: {
      recover: async (row) => {
        recovered.push(row.msg_id);
        return { ok: true };
      },
      sendNotice: async (group) => {
        notices.push(group);
        return { ok: true, messageId: 9001 };
      },
      markSkipped: () => {},
    },
  });

  assert.equal(marker.clean, false, 'the next boot must take the crash-recovery branch');
  assert.deepEqual(recovered, [101], 'only the unfinished turn is recovered');
  assert.deepEqual(notices, [], 'the resend notice is not sent for the recovered turn');
  assert.deepEqual(result, {
    recovered: 1,
    skipped: 0,
    noticed: 0,
    noticeFailed: 0,
  });
});

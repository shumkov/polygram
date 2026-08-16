'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRewindExecutor, transcriptPathFor } = require('../lib/rewind/execute');

function harness({ session = { session_key: 's', chat_id: '1', thread_id: null, claude_session_id: 'OLD', cwd: '/w', agent: null, model: null, effort: null, pm_backend: 'cli' }, fork = { ok: true, forkPath: '/w/NEW.jsonl', droppedTurns: 2 }, outbound = [{ msg_id: 201 }, { msg_id: 202 }] } = {}) {
  const upserts = [];
  const kills = [];
  const tgCalls = [];
  const db = {
    getSession: () => session,
    upsertSession: (r) => { upserts.push(r); },
    raw: { prepare: () => ({ all: () => outbound }) },
  };
  const pm = { kill: async (sk, reason) => { kills.push({ sk, reason }); } };
  const tg = async (_b, method, params) => { tgCalls.push({ method, params }); return { ok: true }; };
  const retiredQuestions = [];
  const exec = createRewindExecutor({
    db, pm, tg, bot: {}, botName: 'b', logEvent: () => {}, logger: { error: () => {} },
    buildForkImpl: () => fork,
    retireQuestionSession: async (sk) => { retiredQuestions.push(sk); },
  });
  const req = { sessionKey: 's', chatId: '1', threadId: null, target: { msg_id: 200, text: 'go', ts: 1 } };
  return { exec, req, upserts, kills, tgCalls, retiredQuestions };
}

// Finding A (code-reviewer): transcriptPathFor MUST compute the same path cli-process.js:604
// uses to find the resume file — which mangles the RAW resolvedCwd (no realpath). If this
// realpaths a symlinked cwd, the fork is written where claude keeps it but the resume check
// looks in the raw dir → miss → fresh session = silent full-context wipe.
describe('transcriptPathFor (must match the cli-process resume path, raw cwd)', () => {
  test('uses the raw cwd, not its realpath, so fork-path == resume-look-path', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-real-'));
    const linkDir = `${realDir}-link`;
    try {
      fs.symlinkSync(realDir, linkDir);
      const got = transcriptPathFor(linkDir, 'ID');
      // cli-process.js:604 — path.join(homedir, '.claude','projects', cwd.replace(/\//g,'-'), id+'.jsonl')
      const expected = path.join(os.homedir(), '.claude', 'projects', linkDir.replace(/\//g, '-'), 'ID.jsonl');
      assert.equal(got, expected, 'raw symlink path mangled — NOT the realpath target');
    } finally {
      try { fs.unlinkSync(linkDir); } catch { /* ignore */ }
      try { fs.rmdirSync(realDir); } catch { /* ignore */ }
    }
  });
});

describe('createRewindExecutor', () => {
  test('happy path: swaps the session id, kills the proc, deletes orphaned bot messages', async () => {
    const H = harness();
    const r = await H.exec(H.req);
    assert.equal(r.ok, true);
    assert.equal(r.droppedCount, 2, 'deleted the 2 outbound messages after M');
    assert.equal(H.upserts.length, 1);
    assert.equal(H.upserts[0].claude_session_id !== 'OLD' && !!H.upserts[0].claude_session_id, true, 'session repointed to the fork id');
    assert.equal(H.kills.length, 1, 'live proc killed (next message resumes the fork)');
    const deletes = H.tgCalls.filter((c) => c.method === 'deleteMessage');
    assert.equal(deletes.length, 2);
    assert.deepEqual(deletes.map((c) => c.params.message_id), [201, 202]);
  });

  test('retiring the old proc retires its question state too', async () => {
    // The killed process owned any open question; its exact state must not
    // outlive it into the rewound session.
    const h = harness();
    await h.exec(h.req);
    assert.deepEqual(h.retiredQuestions, ['s']);
  });

  test('a fork that never happened retires nothing', async () => {
    // Retirement follows the process actually being replaced. No fork, no
    // kill, no retirement — the live interaction is untouched.
    const H = harness({ fork: { ok: false, error: 'mid-tool-call' } });
    await H.exec(H.req);
    assert.deepEqual(H.retiredQuestions, []);
  });

  test('fork failure → original session UNTOUCHED, no kill, error surfaced', async () => {
    const H = harness({ fork: { ok: false, error: 'mid-tool-call' } });
    const r = await H.exec(H.req);
    assert.equal(r.ok, false);
    assert.match(r.error, /mid-tool-call/);
    assert.equal(H.upserts.length, 0, 'session id NOT swapped on fork failure');
    assert.equal(H.kills.length, 0, 'session NOT killed on fork failure');
  });

  test('no live session row → clean error', async () => {
    const H = harness({ session: null });
    const r = await H.exec(H.req);
    assert.equal(r.ok, false);
    assert.match(r.error, /no live session/i);
  });

  // Finding E (silent-failure-hunter): if pm.kill throws, the OLD proc may survive holding the
  // old session id while the DB points at the fork — a two-transcript split reported as success.
  // Surface the kill failure as a warning so it reaches the operator + telemetry.
  test('pm.kill failure is surfaced as a warning (orphan-proc risk), not silently swallowed', async () => {
    const exec = createRewindExecutor({
      db: { getSession: () => ({ session_key: 's', chat_id: '1', thread_id: null, claude_session_id: 'OLD', cwd: '/w', pm_backend: 'cli' }), upsertSession: () => {}, raw: { prepare: () => ({ all: () => [] }) } },
      pm: { kill: async () => { throw new Error('tmux gone'); } },
      tg: async () => ({ ok: true }), bot: {}, botName: 'b', logEvent: () => {}, logger: { error: () => {} },
      buildForkImpl: () => ({ ok: true, forkPath: '/w/N.jsonl', droppedTurns: 0 }),
    });
    const r = await exec({ sessionKey: 's', chatId: '1', threadId: null, target: { msg_id: 5 } });
    assert.equal(r.ok, true, 'the fork+repoint already took — the rewind stands');
    assert.ok(r.warning, 'the kill failure is surfaced, not swallowed');
    assert.match(r.warning, /old session|still|kill/i);
  });

  test('cleanup query failure does not fail the rewind (the fork already succeeded)', async () => {
    const H = harness();
    H.exec; // rebuild with a throwing raw
    const db2Exec = createRewindExecutor({
      db: { getSession: () => ({ session_key: 's', chat_id: '1', claude_session_id: 'OLD', cwd: '/w', pm_backend: 'cli' }), upsertSession: () => {}, raw: { prepare: () => { throw new Error('db locked'); } } },
      pm: { kill: async () => {} }, tg: async () => ({}), bot: {}, botName: 'b',
      logEvent: () => {}, logger: { error: () => {} }, buildForkImpl: () => ({ ok: true, forkPath: '/w/N.jsonl', droppedTurns: 0 }),
    });
    const r = await db2Exec({ sessionKey: 's', chatId: '1', threadId: null, target: { msg_id: 5 } });
    assert.equal(r.ok, true, 'rewind still succeeds; cleanup is best-effort');
    assert.equal(r.droppedCount, 0);
  });
});

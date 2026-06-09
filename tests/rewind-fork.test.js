'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFork } = require('../lib/rewind/fork');

// Synthetic channels transcript: system + (APPLE user, OK1) + (BANANA user, OK2).
const J = (o) => JSON.stringify(o);
function transcript() {
  return [
    J({ type: 'system', sessionId: 'OLD', subtype: 'init' }),
    J({ type: 'user', sessionId: 'OLD', parentUuid: null, uuid: 'u1', message: { role: 'user', content: '<channel source="polygram-bridge" msg_id="100">remember APPLE' } }),
    J({ type: 'assistant', sessionId: 'OLD', parentUuid: 'u1', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'OK1' }] } }),
    J({ type: 'user', sessionId: 'OLD', parentUuid: 'a1', uuid: 'u2', message: { role: 'user', content: '<channel source="polygram-bridge" msg_id="200">remember BANANA' } }),
    J({ type: 'assistant', sessionId: 'OLD', parentUuid: 'u2', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'OK2' }] } }),
  ].join('\n') + '\n';
}

function fakeFs(content, { failWrite = false } = {}) {
  const writes = {};
  const writeTargets = [];
  const renames = [];
  return {
    writes, writeTargets, renames,
    impl: {
      readFileSync: () => { if (content == null) { const e = new Error('no file'); e.code = 'ENOENT'; throw e; } return content; },
      writeFileSync: (p, data, opts) => {
        writeTargets.push(p);
        if (failWrite) { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; }
        writes[p] = { data, opts };
      },
      renameSync: (from, to) => { renames.push({ from, to }); writes[to] = writes[from]; delete writes[from]; },
      unlinkSync: (p) => { delete writes[p]; },
    },
  };
}

describe('buildFork', () => {
  test('clean cut: keeps the prefix, rewrites sessionId, writes the fork, counts dropped turns', () => {
    const f = fakeFs(transcript());
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, true);
    assert.equal(r.forkPath, '/p/NEW.jsonl');
    assert.equal(r.droppedTurns, 1, 'one user turn (BANANA) dropped');
    const written = f.writes['/p/NEW.jsonl'].data.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(written.length, 3, 'kept system + APPLE-user + OK1-assistant');
    assert.ok(written.every((o) => o.sessionId === 'NEW'), 'sessionId rewritten on every line');
    assert.equal(f.writes['/p/NEW.jsonl'].opts.mode, 0o600, 'written 0o600');
    assert.ok(JSON.stringify(written).includes('APPLE'), 'APPLE kept');
    assert.ok(!JSON.stringify(written).includes('BANANA'), 'BANANA dropped');
  });

  test('original transcript is NEVER written (copy-only)', () => {
    const f = fakeFs(transcript());
    buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(f.writes['/p/OLD.jsonl'], undefined, 'the live transcript is untouched');
  });

  test('target not found → fail-safe (handles compacted-away targets)', () => {
    const f = fakeFs(transcript());
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 9999, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, false);
    assert.match(r.error, /couldn.t find that message/i);
    assert.equal(Object.keys(f.writes).length, 0, 'no fork written on failure');
  });

  test('target is the first message → "already the start"', () => {
    const f = fakeFs(transcript());
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 100, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, false);
    assert.match(r.error, /already the start/i);
  });

  test('cut point mid-tool-call (dangling tool_use in prefix) → refuse', () => {
    const lines = [
      J({ type: 'user', sessionId: 'OLD', message: { content: '<channel msg_id="100">do bash' } }),
      J({ type: 'assistant', sessionId: 'OLD', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }),
      // NO tool_result for t1 — then the next user turn:
      J({ type: 'user', sessionId: 'OLD', message: { content: '<channel msg_id="200">next' } }),
    ].join('\n');
    const f = fakeFs(lines);
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, false);
    assert.match(r.error, /mid-tool-call/i);
  });

  test('a completed tool turn in the prefix is fine (tool_use + tool_result)', () => {
    const lines = [
      J({ type: 'user', sessionId: 'OLD', message: { content: '<channel msg_id="100">do bash' } }),
      J({ type: 'assistant', sessionId: 'OLD', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }),
      J({ type: 'user', sessionId: 'OLD', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] } }),
      J({ type: 'assistant', sessionId: 'OLD', message: { content: [{ type: 'text', text: 'done' }] } }),
      J({ type: 'user', sessionId: 'OLD', message: { content: '<channel msg_id="200">next' } }),
    ].join('\n');
    const f = fakeFs(lines);
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, true, 'a closed tool turn cuts cleanly');
  });

  test('unreadable transcript → fail-safe', () => {
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: fakeFs(null).impl });
    assert.equal(r.ok, false);
    assert.match(r.error, /unreadable/i);
  });

  test('invalid JSONL → fail-safe', () => {
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: fakeFs('{not json\n').impl });
    assert.equal(r.ok, false);
    assert.match(r.error, /not valid JSONL/i);
  });

  // Finding B (silent-failure-hunter): the cut locator must match the channel ENVELOPE's
  // own msg_id, never a `<reply_to msg_id="X">` echoed inside a LATER turn's body. When the
  // genuine target (msg_id=200) has been compacted away but a later turn replied to it, the
  // bare-substring matcher false-matches the reply turn and silently cuts at the WRONG point
  // (reporting success) — defeating the not-found fail-safe. The fix returns not-found.
  test('reply_to echo of a compacted-away target → not-found fail-safe (no false-match)', () => {
    // msg_id=200's own turn is GONE (compacted). msg_id=300 replied to it, so its body
    // carries the escaped reply_to block — `&lt;reply_to msg_id="200" …&gt;` (quotes are NOT
    // escaped by escapeChannelBody, so the substring `msg_id="200"` is present).
    const lines = [
      J({ type: 'system', sessionId: 'OLD', subtype: 'init' }),
      J({ type: 'user', sessionId: 'OLD', uuid: 'u1', message: { role: 'user', content: '<channel source="polygram-bridge" msg_id="100">remember APPLE' } }),
      J({ type: 'assistant', sessionId: 'OLD', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'OK1' }] } }),
      J({ type: 'user', sessionId: 'OLD', uuid: 'u3', message: { role: 'user', content: '<channel source="polygram-bridge" msg_id="300">\n&lt;reply_to msg_id="200" source="telegram"&gt;\nremember BANANA\n&lt;/reply_to&gt;\n&lt;untrusted-input&gt;and CHERRY&lt;/untrusted-input&gt;' } }),
      J({ type: 'assistant', sessionId: 'OLD', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'OK3' }] } }),
    ].join('\n') + '\n';
    const f = fakeFs(lines);
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, false, 'must NOT false-match the reply_to echo in the msg_id=300 turn');
    assert.match(r.error, /couldn.t find that message/i);
    assert.equal(Object.keys(f.writes).length, 0, 'no fork written on the not-found fail-safe');
  });

  test('the genuine envelope still matches even when a later turn echoes its id in reply_to', () => {
    // Both the real target (msg_id=200, its OWN envelope) AND a later reply to it are present.
    // The cut must land on the genuine target turn, dropping it and everything after.
    const lines = [
      J({ type: 'system', sessionId: 'OLD' }),
      J({ type: 'user', sessionId: 'OLD', message: { role: 'user', content: '<channel source="polygram-bridge" msg_id="100">APPLE' } }),
      J({ type: 'user', sessionId: 'OLD', message: { role: 'user', content: '<channel source="polygram-bridge" msg_id="200">BANANA' } }),
      J({ type: 'assistant', sessionId: 'OLD', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } }),
      J({ type: 'user', sessionId: 'OLD', message: { role: 'user', content: '<channel source="polygram-bridge" msg_id="300">\n&lt;reply_to msg_id="200"&gt;BANANA&lt;/reply_to&gt;CHERRY' } }),
    ].join('\n') + '\n';
    const f = fakeFs(lines);
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, true);
    const kept = f.writes['/p/NEW.jsonl'].data;
    assert.ok(kept.includes('APPLE'), 'APPLE (before target) kept');
    assert.ok(!kept.includes('BANANA'), 'target (msg_id=200) and everything after dropped');
    assert.ok(!kept.includes('CHERRY'), 'the later reply turn dropped too');
  });

  // Finding C (silent-failure-hunter): the fork must be written atomically. A direct write to
  // the live resume path can leave a truncated <newId>.jsonl that claude resumes as
  // partial/empty context. Write to a temp sibling then rename into place.
  test('atomic write: fork goes to a temp path then renames into place', () => {
    const f = fakeFs(transcript());
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, true);
    assert.equal(f.writeTargets.length, 1, 'one write');
    assert.notEqual(f.writeTargets[0], '/p/NEW.jsonl', 'write goes to a temp sibling, not the live resume path');
    assert.equal(f.renames.length, 1, 'renamed into place');
    assert.equal(f.renames[0].to, '/p/NEW.jsonl', 'rename target is the resume path');
    assert.equal(f.renames[0].from, f.writeTargets[0], 'rename moves the temp file');
    assert.ok(f.writes['/p/NEW.jsonl'], 'final fork lives at the resume path');
  });

  test('interrupted write leaves NO file at the resume path (cleans the temp)', () => {
    const f = fakeFs(transcript(), { failWrite: true });
    const r = buildFork({ transcriptPath: '/p/OLD.jsonl', targetMsgId: 200, newSessionId: 'NEW' }, { fsImpl: f.impl });
    assert.equal(r.ok, false);
    assert.match(r.error, /write the fork/i);
    assert.equal(f.writes['/p/NEW.jsonl'], undefined, 'no truncated fork at the resume path');
    assert.equal(f.renames.length, 0, 'never renamed a failed write into place');
  });
});

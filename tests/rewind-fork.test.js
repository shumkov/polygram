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

function fakeFs(content) {
  const writes = {};
  return {
    writes,
    impl: {
      readFileSync: () => { if (content == null) { const e = new Error('no file'); e.code = 'ENOENT'; throw e; } return content; },
      writeFileSync: (p, data, opts) => { writes[p] = { data, opts }; },
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
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  normalizeHookEvent,
  pipeHookParser,
  createHookTail,
} = require('../lib/process/hook-event-tail');

// ─── normalizeHookEvent — typed parsing per event ───────────────────

describe('normalizeHookEvent — typed parsing', () => {
  test('UserPromptSubmit carries prompt + session fields', () => {
    const ev = normalizeHookEvent({
      session_id: 'sid', transcript_path: '/t', cwd: '/c', permission_mode: 'bypassPermissions',
      hook_event_name: 'UserPromptSubmit', prompt: 'hello',
      polygram_received_at_ms: 1700000000000,
    });
    assert.equal(ev.type, 'UserPromptSubmit');
    assert.equal(ev.sessionId, 'sid');
    assert.equal(ev.prompt, 'hello');
    assert.equal(ev.permissionMode, 'bypassPermissions');
    assert.equal(ev.receivedAtMs, 1700000000000);
  });

  test('PreToolUse pairs by tool_use_id with PostToolUse', () => {
    const pre = normalizeHookEvent({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo X' }, tool_use_id: 'toolu_AAA',
    });
    const post = normalizeHookEvent({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_use_id: 'toolu_AAA', duration_ms: 42,
      tool_response: { stdout: 'X', stderr: '', interrupted: false },
    });
    assert.equal(pre.type, 'PreToolUse');
    assert.equal(post.type, 'PostToolUse');
    assert.equal(pre.toolUseId, post.toolUseId);
    assert.equal(post.durationMs, 42);
    assert.deepEqual(post.toolResponse, { stdout: 'X', stderr: '', interrupted: false });
  });

  test('subagent-inner Pre/Post carry agent_id + agent_type (per 2.1.142 spike)', () => {
    const inner = normalizeHookEvent({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_use_id: 'toolu_BBB',
      agent_id: 'a-123', agent_type: 'general-purpose',
    });
    assert.equal(inner.agentId, 'a-123');
    assert.equal(inner.agentType, 'general-purpose');
  });

  test('SubagentStop carries agent_transcript_path (free sidechain JSONL path)', () => {
    const ev = normalizeHookEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'a-1', agent_type: 'gp',
      agent_transcript_path: '/x/y.jsonl',
    });
    assert.equal(ev.type, 'SubagentStop');
    assert.equal(ev.agentTranscriptPath, '/x/y.jsonl');
  });

  test('Stop carries stop_hook_active + last_assistant_message', () => {
    const ev = normalizeHookEvent({
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'done.',
    });
    assert.equal(ev.type, 'Stop');
    assert.equal(ev.stopHookActive, false);
    assert.equal(ev.lastAssistantMessage, 'done.');
  });

  test('unknown hook_event_name passes through as type=unknown with raw attached', () => {
    const raw = { hook_event_name: 'FutureHookXYZ', foo: 1 };
    const ev = normalizeHookEvent(raw);
    assert.equal(ev.type, 'unknown');
    assert.equal(ev.raw, raw);
  });

  test('helper-wrapped parse-error is flagged as type=parse-error', () => {
    const raw = { polygram_parse_error: 'unexpected token', polygram_received_at_ms: 1, raw: 'xx' };
    const ev = normalizeHookEvent(raw);
    assert.equal(ev.type, 'parse-error');
    assert.equal(ev.error, 'unexpected token');
    assert.equal(ev.receivedAtMs, 1);
    assert.equal(ev.raw, raw);
  });

  test('all-undefined input is safe (defensive against schema drift)', () => {
    const ev = normalizeHookEvent({});
    assert.equal(ev.type, 'unknown');
    assert.equal(ev.toolName, null);
    assert.equal(ev.agentId, null);
  });
});

// ─── pipeHookParser — line-by-line handling on a synthetic LogTail ──

describe('pipeHookParser — line emission', () => {
  test('parses one JSON line into one typed event', () => {
    const tail = new EventEmitter();
    pipeHookParser(tail);
    const got = [];
    tail.on('event', (e) => got.push(e));
    tail.emit('line', JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }));
    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'Stop');
  });

  test('blank lines are ignored (no event emitted)', () => {
    const tail = new EventEmitter();
    pipeHookParser(tail);
    const got = [];
    tail.on('event', (e) => got.push(e));
    tail.emit('line', '');
    tail.emit('line', '   ');
    assert.equal(got.length, 0);
  });

  test('malformed JSON emits a parse-error event (never silent-drops)', () => {
    const tail = new EventEmitter();
    pipeHookParser(tail);
    const got = [];
    tail.on('event', (e) => got.push(e));
    tail.emit('line', '{not valid json');
    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'parse-error');
    assert.ok(got[0].error);
    assert.ok(typeof got[0].raw === 'string');
  });

  test('long malformed lines are truncated in the parse-error raw', () => {
    const tail = new EventEmitter();
    pipeHookParser(tail);
    const got = [];
    tail.on('event', (e) => got.push(e));
    const huge = 'x'.repeat(5000);
    tail.emit('line', huge);
    assert.equal(got[0].type, 'parse-error');
    assert.ok(got[0].raw.length <= 1025); // 1024 + ellipsis
  });
});

// ─── createHookTail — integration with the real LogTail ─────────────

describe('createHookTail — end-to-end against the real LogTail', () => {
  test('appends to an ndjson and emits a typed event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-tail-int-'));
    const p = path.join(dir, 'evts.ndjson');
    // Pre-create so fs.watch can attach immediately.
    fs.closeSync(fs.openSync(p, 'a'));
    const tail = createHookTail({ path: p });
    const got = [];
    tail.on('event', (e) => got.push(e));
    tail.start();
    // tiny delay to let the watcher attach.
    await new Promise((r) => setTimeout(r, 80));
    fs.appendFileSync(p, JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_X',
    }) + '\n');
    // poll up to 500ms for the event to arrive.
    const deadline = Date.now() + 500;
    while (got.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    try { tail.close(); } catch { /* swallow */ }
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'PreToolUse');
    assert.equal(got[0].toolUseId, 'toolu_X');
  });
});

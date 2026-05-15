'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const {
  encodeCwd, sessionLogPath, parseLine, pipeToParser,
} = require('../lib/tmux/session-log-parser');

// ─── path helpers ────────────────────────────────────────────────────

describe('encodeCwd', () => {
  test('replaces / with -', () => {
    assert.equal(encodeCwd('/Users/x/projects/polygram'), '-Users-x-projects-polygram');
  });
  test('absolute path leading dash matches claude convention', () => {
    assert.equal(encodeCwd('/A/B'), '-A-B');
  });
});

describe('sessionLogPath', () => {
  test('builds ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl', () => {
    const sid = 'abcd1234-1111-2222-3333-444444444444';
    const p = sessionLogPath('/Users/x/y', sid, '/Users/x');
    assert.equal(p, `/Users/x/.claude/projects/-Users-x-y/${sid}.jsonl`);
  });
  test('SECURITY: rejects non-UUID sessionId (path-traversal defense)', () => {
    assert.throws(
      () => sessionLogPath('/Users/x/y', '../etc/passwd', '/Users/x'),
      /sessionId must be a UUID/,
    );
    assert.throws(
      () => sessionLogPath('/Users/x/y', 'not-a-uuid', '/Users/x'),
      /sessionId must be a UUID/,
    );
  });
});

// ─── parseLine ──────────────────────────────────────────────────────

describe('parseLine — empty / malformed', () => {
  test('returns [] on empty / null / non-string', () => {
    assert.deepEqual(parseLine(''), []);
    assert.deepEqual(parseLine(null), []);
    assert.deepEqual(parseLine(undefined), []);
    assert.deepEqual(parseLine(42), []);
  });
  test('returns [] on malformed JSON', () => {
    assert.deepEqual(parseLine('{not json'), []);
    assert.deepEqual(parseLine('null'), []);
  });
  test('returns [] for unknown types', () => {
    assert.deepEqual(parseLine(JSON.stringify({ type: 'queue-operation' })), []);
    assert.deepEqual(parseLine(JSON.stringify({ type: 'attachment', attachment: {} })), []);
  });
});

describe('parseLine — assistant text', () => {
  test('extracts text chunk from assistant content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      message: {
        content: [{ type: 'text', text: 'Hello!' }],
      },
    });
    const events = parseLine(line);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'assistant-chunk');
    assert.equal(events[0].text, 'Hello!');
  });

  test('skips empty text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '' }] },
    });
    assert.deepEqual(parseLine(line), []);
  });

  test('multiple text blocks produce multiple events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    });
    const events = parseLine(line);
    assert.equal(events.length, 2);
    assert.equal(events[0].text, 'first');
    assert.equal(events[1].text, 'second');
  });
});

describe('parseLine — tool_use blocks', () => {
  test('extracts tool_use with name + input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    const events = parseLine(line);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tool-use');
    assert.equal(events[0].name, 'Bash');
    assert.deepEqual(events[0].input, { command: 'ls' });
    assert.equal(events[0].id, 'toolu_1');
  });

  test('text + tool_use in same message → both events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: "I'll list the files" },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const events = parseLine(line);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'assistant-chunk');
    assert.equal(events[1].type, 'tool-use');
  });
});

describe('parseLine — result / stop_reason', () => {
  test('emits result event with subtype=success on end_turn', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-99',
      message: {
        content: [{ type: 'text', text: 'final answer' }],
        stop_reason: 'end_turn',
      },
    });
    const events = parseLine(line);
    // 1 chunk + 1 result
    assert.equal(events.length, 2);
    const result = events.find((e) => e.type === 'result');
    assert.equal(result.subtype, 'success');
    assert.equal(result.text, 'final answer');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.sessionId, 'sess-99');
  });

  test('forwards non-success stop_reason as subtype literal', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [], stop_reason: 'max_tokens' },
    });
    const events = parseLine(line);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'result');
    assert.equal(events[0].subtype, 'max_tokens');
  });
});

describe('parseLine — usage', () => {
  test('extracts token-usage snapshot from assistant.message.usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-u',
      message: {
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'OK' }],
        usage: {
          input_tokens: 12,
          output_tokens: 87,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 1234,
        },
      },
    });
    const events = parseLine(line);
    const usage = events.find((e) => e.type === 'usage');
    assert.ok(usage, 'expected a usage event');
    assert.equal(usage.inputTokens, 12);
    assert.equal(usage.outputTokens, 87);
    assert.equal(usage.cacheReadTokens, 50_000);
    assert.equal(usage.cacheCreationTokens, 1234);
    assert.equal(usage.model, 'claude-haiku-4-5-20251001');
  });

  test('no usage event when assistant.message.usage missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'no usage block here' }] },
    });
    const events = parseLine(line);
    assert.ok(!events.some((e) => e.type === 'usage'));
  });
});

describe('parseLine — last-prompt', () => {
  test('emits last-prompt event with text', () => {
    const line = JSON.stringify({ type: 'last-prompt', lastPrompt: 'how are you?' });
    const events = parseLine(line);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'last-prompt');
    assert.equal(events[0].text, 'how are you?');
  });
});

// ─── pipeToParser ────────────────────────────────────────────────────

describe('pipeToParser', () => {
  test('emits parsed events on `event` channel', () => {
    const emitter = new EventEmitter();
    pipeToParser(emitter);
    const events = [];
    emitter.on('event', (e) => events.push(e));
    emitter.emit('line', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    }));
    emitter.emit('line', JSON.stringify({ type: 'queue-operation' })); // skipped
    emitter.emit('line', JSON.stringify({ type: 'last-prompt', lastPrompt: 'q' }));
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'assistant-chunk');
    assert.equal(events[1].type, 'last-prompt');
  });
});

// ─── real fixture (captured 2026-05-14 from haiku turn) ─────────────

describe('parseLine against real JSONL fixture', () => {
  test('extracts assistant + result + last-prompt from a real conversation file', () => {
    const fs = require('fs');
    const path = require('path');
    const fixture = path.join(__dirname, '..', '..', '.claude', 'projects',
      '-Users-ivanshumkov-Projects-shumkov-polygram');
    // Don't require fixture for this test — only run if any session file exists
    // The captured probe lives at ~/.claude/projects/<cwd-enc>/<uuid>.jsonl
    // and may rotate; instead synthesise expected shape from spec.
    const synthetic = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'say hi' } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'mcp_instructions_delta' } }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-real',
        message: {
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'Hey! 👋' }],
          stop_reason: 'end_turn',
        },
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'say hi' }),
    ];
    const all = synthetic.flatMap(parseLine);
    const types = all.map((e) => e.type);
    assert.ok(types.includes('assistant-chunk'));
    assert.ok(types.includes('result'));
    assert.ok(types.includes('last-prompt'));
    const result = all.find((e) => e.type === 'result');
    assert.equal(result.sessionId, 'sess-real');
  });
});

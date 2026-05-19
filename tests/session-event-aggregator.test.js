/**
 * SessionEventAggregator — 0.10.0 Phase 1 (docs/0.10.0-tmux-concurrency-
 * solution.md §3). Deterministic unit tests with hand-written JSONL.
 *
 * The aggregator coalesces a logical assistant message that claude
 * writes across MULTIPLE JSONL lines sharing one `message.id`, and
 * fires `result` ONCE per message — fixing the zero-concurrency
 * empty-turn bug where a `thinking` line resolved the turn empty
 * before its sibling `text` line was read.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  SessionEventAggregator, parseLine,
} = require('../lib/tmux/session-log-parser');

// Hand-written JSONL line helpers.
function asstLine(message, sessionId = 'sess-1') {
  return JSON.stringify({ type: 'assistant', sessionId, message });
}
function userLine(content, extra = {}) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
}

// Drain an aggregator over a list of lines, returning all events.
function run(lines, { flush = true } = {}) {
  const agg = new SessionEventAggregator();
  const events = [];
  for (const line of lines) events.push(...agg.push(line));
  if (flush) events.push(...agg.flush());
  return events;
}

describe('SessionEventAggregator — malformed input', () => {
  test('empty / null / non-string / bad JSON → []', () => {
    const agg = new SessionEventAggregator();
    assert.deepEqual(agg.push(''), []);
    assert.deepEqual(agg.push(null), []);
    assert.deepEqual(agg.push(undefined), []);
    assert.deepEqual(agg.push(42), []);
    assert.deepEqual(agg.push('{not json'), []);
    assert.deepEqual(agg.push('null'), []);
    assert.deepEqual(agg.flush(), []);
  });
});

describe('SessionEventAggregator — message.id coalescing', () => {
  test('EMPTY-TURN FIX: thinking line then text line, SAME message.id → exactly ONE result, with the text', () => {
    // The exact production shape: claude writes the terminal message
    // as a `thinking` line then a `text` line — both carry the same
    // message.id and both repeat stop_reason=end_turn.
    const events = run([
      asstLine({
        id: 'msg_A',
        content: [{ type: 'thinking', thinking: 'let me think' }],
        stop_reason: 'end_turn',
      }),
      asstLine({
        id: 'msg_A',
        content: [{ type: 'text', text: 'the real answer' }],
        stop_reason: 'end_turn',
      }),
    ]);
    const results = events.filter((e) => e.type === 'result');
    assert.equal(results.length, 1, 'exactly one result for one logical message');
    assert.equal(results[0].text, 'the real answer',
      'result carries the coalesced text, NOT the empty thinking segment');
    assert.equal(results[0].subtype, 'success');
    assert.equal(results[0].stopReason, 'end_turn');
  });

  test('CONTRAST: the stateless parseLine fires an EMPTY result on the thinking line — that is the bug the aggregator fixes', () => {
    // Red-state proof: feeding the very same thinking line to the
    // OLD per-line parser yields a result with text='' — which, in
    // TmuxProcess, resolves the turn empty.
    const thinkingLine = asstLine({
      id: 'msg_A',
      content: [{ type: 'thinking', thinking: 'let me think' }],
      stop_reason: 'end_turn',
    });
    const stateless = parseLine(thinkingLine);
    const statelessResult = stateless.find((e) => e.type === 'result');
    assert.ok(statelessResult, 'parseLine DOES emit a result for the thinking line');
    assert.equal(statelessResult.text, '',
      'parseLine result has empty text — the empty-turn bug');

    // Green-state: the aggregator does NOT emit a premature result
    // for the same line — it buffers, waiting for the message to
    // finalize.
    const agg = new SessionEventAggregator();
    const aggEvents = agg.push(thinkingLine);
    assert.equal(aggEvents.filter((e) => e.type === 'result').length, 0,
      'aggregator emits NO result while the message is still buffered');
  });

  test('result fires when a DIFFERENT message.id arrives', () => {
    const agg = new SessionEventAggregator();
    agg.push(asstLine({ id: 'msg_A', content: [{ type: 'text', text: 'A' }], stop_reason: 'end_turn' }));
    // msg_A is buffered, no result yet.
    const onNew = agg.push(asstLine({ id: 'msg_B', content: [{ type: 'text', text: 'B' }] }));
    const result = onNew.find((e) => e.type === 'result');
    assert.ok(result, 'a new message.id finalizes the previous message');
    assert.equal(result.text, 'A');
  });

  test('result fires when a non-assistant line arrives (e.g. claude writes a `system` line after the turn)', () => {
    const agg = new SessionEventAggregator();
    agg.push(asstLine({ id: 'msg_A', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }));
    const onSystem = agg.push(JSON.stringify({ type: 'system', subtype: 'turn_complete' }));
    assert.equal(onSystem.filter((e) => e.type === 'result').length, 1);
    assert.equal(onSystem[0].text, 'done');
  });

  test('result fires on flush() — the genuinely-last message of a session has no trailing line', () => {
    const agg = new SessionEventAggregator();
    const eager = agg.push(asstLine({ id: 'msg_A', content: [{ type: 'text', text: 'last' }], stop_reason: 'end_turn' }));
    assert.equal(eager.filter((e) => e.type === 'result').length, 0, 'no result before flush');
    const flushed = agg.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].type, 'result');
    assert.equal(flushed[0].text, 'last');
    // flush is idempotent.
    assert.deepEqual(agg.flush(), []);
  });

  test('a message with no stop_reason produces NO result (text already streamed via assistant-chunk)', () => {
    // last-prompt fallback in TmuxProcess covers a genuinely missing
    // end_turn; the aggregator must not invent a result.
    const events = run([
      asstLine({ id: 'msg_A', content: [{ type: 'text', text: 'streaming…' }] }),
    ]);
    assert.equal(events.filter((e) => e.type === 'result').length, 0);
    assert.equal(events.filter((e) => e.type === 'assistant-chunk').length, 1);
  });

  test('eager events: assistant-chunk / tool-use / usage emit per-line, BEFORE finalize', () => {
    const agg = new SessionEventAggregator();
    const line1 = agg.push(asstLine({
      id: 'msg_A',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: "I'll list files" },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'toolu_1' },
      ],
      usage: { input_tokens: 5, output_tokens: 9 },
      stop_reason: 'tool_use',
    }));
    // All three eager events present; NO result yet (buffered).
    assert.equal(line1.find((e) => e.type === 'assistant-chunk').text, "I'll list files");
    assert.equal(line1.find((e) => e.type === 'tool-use').name, 'Bash');
    assert.equal(line1.find((e) => e.type === 'usage').inputTokens, 5);
    assert.equal(line1.filter((e) => e.type === 'result').length, 0);
  });

  test('tool turn: message A (tool_use) finalizes when message B begins; both get one result', () => {
    const events = run([
      asstLine({ id: 'msg_A', content: [{ type: 'tool_use', name: 'Bash', input: {} }], stop_reason: 'tool_use' }),
      // claude writes the API-shaped tool_result as a user line (array
      // content) — a non-assistant line that finalizes msg_A.
      userLine([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
      asstLine({ id: 'msg_B', content: [{ type: 'text', text: 'final' }], stop_reason: 'end_turn' }),
    ]);
    const results = events.filter((e) => e.type === 'result');
    assert.equal(results.length, 2, 'one result per logical message');
    assert.equal(results[0].subtype, 'tool_use', 'msg_A non-terminal');
    assert.equal(results[1].subtype, 'success', 'msg_B terminal');
    assert.equal(results[1].text, 'final');
  });
});

describe('SessionEventAggregator — assistant lines WITHOUT message.id (legacy / synthetic)', () => {
  test('a line with no message.id is its own standalone message — result emitted per-line', () => {
    // Real claude always writes message.id; absent id only happens in
    // synthetic fixtures, which keep the legacy per-line behaviour.
    const events = run([
      asstLine({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }),
    ], { flush: false });
    assert.equal(events.filter((e) => e.type === 'result').length, 1,
      'no-id line resolves immediately (legacy contract preserved)');
    assert.equal(events.find((e) => e.type === 'result').text, 'hi');
  });

  test('a buffered id-message is finalized before a following no-id line is emitted', () => {
    const agg = new SessionEventAggregator();
    agg.push(asstLine({ id: 'msg_A', content: [{ type: 'text', text: 'A' }], stop_reason: 'end_turn' }));
    const onNoId = agg.push(asstLine({ content: [{ type: 'text', text: 'B' }], stop_reason: 'end_turn' }));
    const results = onNoId.filter((e) => e.type === 'result');
    assert.equal(results.length, 2, 'msg_A finalized + the no-id line emitted');
    assert.equal(results[0].text, 'A');
    assert.equal(results[1].text, 'B');
  });
});

describe('SessionEventAggregator — queue-operation (0.10.0 §3: the live fold signal)', () => {
  test('enqueue carries the pasted content', () => {
    const events = run([
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'a queued prompt' }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'queue-operation');
    assert.equal(events[0].operation, 'enqueue');
    assert.equal(events[0].content, 'a queued prompt');
  });

  test('dequeue is bare — operation set, content null', () => {
    const events = run([
      JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, 'dequeue');
    assert.equal(events[0].content, null);
  });

  test('a queue-operation line finalizes a buffered assistant message first', () => {
    const agg = new SessionEventAggregator();
    agg.push(asstLine({ id: 'msg_A', content: [{ type: 'text', text: 'A' }], stop_reason: 'end_turn' }));
    const ev = agg.push(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'q' }));
    assert.equal(ev[0].type, 'result', 'buffered message finalized first');
    assert.equal(ev[1].type, 'queue-operation');
  });
});

describe('SessionEventAggregator — user-message + correlation metadata', () => {
  test('top-level string user content emits user-message with parentUuid + promptId forwarded', () => {
    const events = run([
      userLine('what is the capital of France?', {
        parentUuid: 'parent-9', promptId: 'prompt-9',
      }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'user-message');
    assert.equal(events[0].text, 'what is the capital of France?');
    assert.equal(events[0].parentUuid, 'parent-9');
    assert.equal(events[0].promptId, 'prompt-9');
  });

  test('user content as a tool_result array emits tool-result, never user-message', () => {
    // B10: array-content user lines carry `tool_result` blocks (tool
    // feedback). They emit `tool-result` (so the turn ledger can clear
    // an outstanding `Agent`/subagent call) and NEVER `user-message`.
    const events = run([
      userLine([{ type: 'tool_result', tool_use_id: 'x', content: 'V', is_error: false }]),
    ]);
    assert.deepEqual(events, [
      { type: 'tool-result', toolUseId: 'x', isError: false },
    ]);
    assert.ok(!events.some((e) => e.type === 'user-message'),
      'tool_result feedback must never be mistaken for a user prompt');
  });

  test('last-prompt forwarded; missing lastPrompt field tolerated', () => {
    const events = run([
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello' }),
      JSON.stringify({ type: 'last-prompt', leafUuid: 'x' }), // no lastPrompt field
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'last-prompt');
    assert.equal(events[0].text, 'hello');
    assert.equal(events[1].text, '', 'missing lastPrompt → empty string, no crash');
  });
});

describe('SessionEventAggregator — result metadata', () => {
  test('result forwards sessionId + parentUuid from the assistant line', () => {
    const agg = new SessionEventAggregator();
    agg.push(JSON.stringify({
      type: 'assistant', sessionId: 'sess-XYZ', parentUuid: 'parent-XYZ',
      message: { id: 'msg_A', content: [{ type: 'text', text: 'r' }], stop_reason: 'end_turn' },
    }));
    const [result] = agg.flush();
    assert.equal(result.sessionId, 'sess-XYZ');
    assert.equal(result.parentUuid, 'parent-XYZ');
  });

  test('non-success stop_reason forwarded as subtype literal', () => {
    const agg = new SessionEventAggregator();
    agg.push(asstLine({ id: 'msg_A', content: [], stop_reason: 'max_tokens' }));
    const [result] = agg.flush();
    assert.equal(result.subtype, 'max_tokens');
    assert.equal(result.stopReason, 'max_tokens');
  });
});

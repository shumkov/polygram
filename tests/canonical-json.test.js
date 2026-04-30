/**
 * Tests for lib/canonical-json.js — canonical-JSON-stringify used as
 * the dedup key for chat_tool_decisions "always allow" / "always deny"
 * decisions (rc.6 Phase 2 step 6 / v4 plan §6.6 M8).
 *
 * Critical correctness property: same SEMANTIC tool-input must produce
 * the SAME canonical string regardless of:
 *   - key insertion order
 *   - nested-object key order
 *   - object literal vs. constructed
 *
 * Wrong canonicalisation = user gets the same approval card twice
 * for the SAME logical tool call.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeToolInput } = require('../lib/canonical-json');

describe('canonicalizeToolInput — non-object inputs', () => {
  test('null', () => {
    assert.equal(canonicalizeToolInput(null), 'null');
  });

  test('undefined', () => {
    assert.equal(canonicalizeToolInput(undefined), undefined);
    // JSON.stringify(undefined) returns undefined — that's the documented behaviour
  });

  test('string', () => {
    assert.equal(canonicalizeToolInput('hello'), '"hello"');
  });

  test('number', () => {
    assert.equal(canonicalizeToolInput(42), '42');
  });

  test('boolean', () => {
    assert.equal(canonicalizeToolInput(true), 'true');
    assert.equal(canonicalizeToolInput(false), 'false');
  });
});

describe('canonicalizeToolInput — flat objects', () => {
  test('keys sorted alphabetically', () => {
    const result = canonicalizeToolInput({ b: 2, a: 1, c: 3 });
    assert.equal(result, '{"a":1,"b":2,"c":3}');
  });

  test('SAME canonical string for different insertion orders', () => {
    const a = canonicalizeToolInput({ command: 'ls', timeout: 5000 });
    const b = canonicalizeToolInput({ timeout: 5000, command: 'ls' });
    assert.equal(a, b);
  });

  test('empty object', () => {
    assert.equal(canonicalizeToolInput({}), '{}');
  });

  test('mixed value types', () => {
    const result = canonicalizeToolInput({
      str: 'hello',
      num: 42,
      bool: true,
      nul: null,
      undef: undefined,
    });
    // undefined fields drop out per JSON.stringify spec
    assert.equal(result, '{"bool":true,"nul":null,"num":42,"str":"hello"}');
  });
});

describe('canonicalizeToolInput — nested objects', () => {
  test('nested keys also sorted', () => {
    const result = canonicalizeToolInput({
      outer: 'val',
      nested: { z: 1, a: 2 },
    });
    assert.equal(result, '{"nested":{"a":2,"z":1},"outer":"val"}');
  });

  test('deeply nested objects all sorted', () => {
    const result = canonicalizeToolInput({
      a: { y: { c: 1, b: 2 } },
      b: 'top',
    });
    assert.equal(result, '{"a":{"y":{"b":2,"c":1}},"b":"top"}');
  });

  test('semantically equal nested objects produce same string', () => {
    const a = canonicalizeToolInput({
      command: 'git status',
      env: { HOME: '/x', PATH: '/usr/bin' },
    });
    const b = canonicalizeToolInput({
      env: { PATH: '/usr/bin', HOME: '/x' },
      command: 'git status',
    });
    assert.equal(a, b);
  });
});

describe('canonicalizeToolInput — arrays', () => {
  test('arrays preserve element order (NOT sorted)', () => {
    const result = canonicalizeToolInput([3, 1, 2]);
    assert.equal(result, '[3,1,2]');
  });

  test('array elements that are objects: keys sorted but element order kept', () => {
    const result = canonicalizeToolInput([{ b: 2, a: 1 }, { d: 4, c: 3 }]);
    assert.equal(result, '[{"a":1,"b":2},{"c":3,"d":4}]');
  });

  test('different array orders → different canonical strings', () => {
    const a = canonicalizeToolInput([1, 2, 3]);
    const b = canonicalizeToolInput([3, 2, 1]);
    assert.notEqual(a, b);
  });

  test('nested array inside object', () => {
    const result = canonicalizeToolInput({
      tools: ['Read', 'Bash'],
      meta: { id: 'x' },
    });
    assert.equal(result, '{"meta":{"id":"x"},"tools":["Read","Bash"]}');
  });
});

describe('canonicalizeToolInput — real SDK tool-input shapes', () => {
  test('Bash tool input round-trips identically', () => {
    const input1 = { command: 'ls /tmp', description: 'list files' };
    const input2 = { description: 'list files', command: 'ls /tmp' };
    assert.equal(canonicalizeToolInput(input1), canonicalizeToolInput(input2));
  });

  test('Read tool input', () => {
    const input = { file_path: '/Users/ivan/foo.txt', limit: 100, offset: 0 };
    const result = canonicalizeToolInput(input);
    assert.equal(result, '{"file_path":"/Users/ivan/foo.txt","limit":100,"offset":0}');
  });

  test('Write tool with multiline content', () => {
    const input = {
      file_path: '/x.md',
      content: 'line1\nline2\n',
    };
    const result = canonicalizeToolInput(input);
    // newlines should be JSON-escaped
    assert.match(result, /\\n/);
  });

  test('TodoWrite with array of objects', () => {
    const input = {
      todos: [
        { status: 'pending', content: 'task 1' },
        { content: 'task 2', status: 'completed' },
      ],
    };
    const result = canonicalizeToolInput(input);
    // Inner object keys sorted; array order kept
    assert.equal(result, '{"todos":[{"content":"task 1","status":"pending"},{"content":"task 2","status":"completed"}]}');
  });
});

describe('canonicalizeToolInput — edge cases', () => {
  test('object with quoted values', () => {
    const result = canonicalizeToolInput({ msg: 'hello "world"' });
    assert.equal(result, '{"msg":"hello \\"world\\""}');
  });

  test('object with unicode keys', () => {
    const result = canonicalizeToolInput({ '😀': 1, 'a': 2 });
    // Key sort is lexicographic on UTF-16 — emoji surrogates sort
    // higher than ASCII, so 'a' first.
    assert.match(result, /"a":2/);
  });

  test('numeric string keys are stable across input orderings', () => {
    // JS integer-like string keys iterate in NUMERIC order regardless
    // of insertion order or .sort() — Object.keys({"10":..,"2":..})
    // returns ["2","10"]. The good news: this means semantically
    // equal inputs DO produce the same canonical string.
    const a = canonicalizeToolInput({ '10': 'a', '2': 'b' });
    const b = canonicalizeToolInput({ '2': 'b', '10': 'a' });
    assert.equal(a, b);
    assert.equal(a, '{"2":"b","10":"a"}');
  });

  test('does NOT mutate the input object', () => {
    const input = { b: 1, a: 2, nested: { y: 1, x: 2 } };
    const before = JSON.stringify(input);
    canonicalizeToolInput(input);
    // Direct compare — input should be unchanged
    assert.equal(JSON.stringify(input), before);
    // Original key ordering also preserved (Node returns keys in insertion order)
    assert.deepEqual(Object.keys(input), ['b', 'a', 'nested']);
    assert.deepEqual(Object.keys(input.nested), ['y', 'x']);
  });
});

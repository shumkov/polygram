/**
 * Tests for lib/autosteer-buffer.js — the per-sessionKey queue that
 * holds mid-turn user follow-ups so the SDK pm's PostToolBatch hook
 * can drain them into `additionalContext` on each tool boundary.
 *
 * v6 plan §7.3 G1/G2 unit coverage.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createAutosteerBuffer } = require('../lib/autosteer-buffer');

describe('autosteer-buffer', () => {
  let buf;
  beforeEach(() => { buf = createAutosteerBuffer(); });

  test('append + drain round-trips a single message', () => {
    assert.equal(buf.append('s1', 'hello'), true);
    const drained = buf.drain('s1');
    assert.deepEqual(drained, ['hello']);
  });

  test('drain after empty returns empty array', () => {
    assert.deepEqual(buf.drain('never-existed'), []);
  });

  test('drain consumes the buffer (subsequent drain is empty)', () => {
    buf.append('s1', 'a');
    buf.append('s1', 'b');
    assert.deepEqual(buf.drain('s1'), ['a', 'b']);
    assert.deepEqual(buf.drain('s1'), []);
  });

  test('drain preserves arrival order', () => {
    buf.append('s1', 'first');
    buf.append('s1', 'second');
    buf.append('s1', 'third');
    assert.deepEqual(buf.drain('s1'), ['first', 'second', 'third']);
  });

  test('multi-session isolation — drain one does not affect another', () => {
    buf.append('s1', 'A');
    buf.append('s2', 'B');
    buf.append('s1', 'C');
    assert.deepEqual(buf.drain('s1'), ['A', 'C']);
    assert.deepEqual(buf.drain('s2'), ['B']);
  });

  test('size reflects pending messages', () => {
    assert.equal(buf.size('s1'), 0);
    buf.append('s1', 'a');
    assert.equal(buf.size('s1'), 1);
    buf.append('s1', 'b');
    assert.equal(buf.size('s1'), 2);
    buf.drain('s1');
    assert.equal(buf.size('s1'), 0);
  });

  test('clear removes session without returning content', () => {
    buf.append('s1', 'a');
    buf.append('s1', 'b');
    buf.clear('s1');
    assert.equal(buf.size('s1'), 0);
    assert.deepEqual(buf.drain('s1'), []);
  });

  test('clear is per-session', () => {
    buf.append('s1', 'a');
    buf.append('s2', 'b');
    buf.clear('s1');
    assert.deepEqual(buf.drain('s1'), []);
    assert.deepEqual(buf.drain('s2'), ['b']);
  });

  test('append rejects null/undefined/empty text', () => {
    assert.equal(buf.append('s1', null), false);
    assert.equal(buf.append('s1', undefined), false);
    assert.equal(buf.append('s1', ''), false);
    assert.equal(buf.size('s1'), 0);
  });

  test('append rejects non-string text', () => {
    assert.equal(buf.append('s1', 123), false);
    assert.equal(buf.append('s1', { foo: 'bar' }), false);
    assert.equal(buf.size('s1'), 0);
  });

  test('append rejects null sessionKey', () => {
    assert.equal(buf.append(null, 'hi'), false);
    assert.equal(buf.append('', 'hi'), false);
  });

  test('formatForHook wraps in <channel source="user-followup"> tag', () => {
    const formatted = buf.formatForHook(['hello', 'world']);
    assert.match(formatted, /^<channel source="user-followup">/);
    assert.match(formatted, /<\/channel>$/);
    assert.match(formatted, /hello/);
    assert.match(formatted, /world/);
  });

  test('formatForHook joins multiple messages with blank line', () => {
    const formatted = buf.formatForHook(['msg1', 'msg2', 'msg3']);
    // body inside the channel tag is the messages joined by '\n\n'
    const body = formatted
      .replace(/^<channel[^>]*>\n/, '')
      .replace(/\n<\/channel>$/, '');
    assert.equal(body, 'msg1\n\nmsg2\n\nmsg3');
  });

  test('formatForHook returns null for empty array', () => {
    assert.equal(buf.formatForHook([]), null);
    assert.equal(buf.formatForHook(null), null);
  });

  test('formatForHook of a single message — same wrapping, no extra blank', () => {
    const formatted = buf.formatForHook(['only one']);
    assert.equal(formatted, '<channel source="user-followup">\nonly one\n</channel>');
  });
});

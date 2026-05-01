/**
 * Tests for makePostToolBatchHook in lib/autosteer-buffer.js — the
 * factory that builds the SDK PostToolBatch hook callback.
 *
 * The callback's contract:
 *  - Returns a HookJSONOutput per SDK sdk.d.ts:726-728
 *  - Drains the buffer for its sessionKey on each invocation
 *  - Returns { continue: true, hookSpecificOutput: { hookEventName, additionalContext } }
 *    when buffer non-empty
 *  - Returns { continue: true } when buffer empty
 *  - NEVER throws (catches and logs)
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createAutosteerBuffer, makePostToolBatchHook } = require('../lib/autosteer-buffer');

describe('makePostToolBatchHook — basic flow', () => {
  let buffer;
  beforeEach(() => { buffer = createAutosteerBuffer(); });

  test('empty buffer → returns { continue: true } with no output', async () => {
    const hook = makePostToolBatchHook({ buffer, sessionKey: 's1' });
    const r = await hook();
    assert.deepEqual(r, { continue: true });
  });

  test('non-empty buffer → drains and returns additionalContext', async () => {
    buffer.append('s1', 'hello');
    buffer.append('s1', 'world');
    const hook = makePostToolBatchHook({ buffer, sessionKey: 's1' });
    const r = await hook();
    assert.equal(r.continue, true);
    assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolBatch');
    assert.match(r.hookSpecificOutput.additionalContext, /<channel source="user-followup">/);
    assert.match(r.hookSpecificOutput.additionalContext, /hello/);
    assert.match(r.hookSpecificOutput.additionalContext, /world/);
  });

  test('drain consumes buffer — second invocation returns empty', async () => {
    buffer.append('s1', 'first');
    const hook = makePostToolBatchHook({ buffer, sessionKey: 's1' });
    await hook();
    const r2 = await hook();
    assert.deepEqual(r2, { continue: true });
  });

  test('per-session — only drains the bound sessionKey', async () => {
    buffer.append('s1', 'A');
    buffer.append('s2', 'B');
    const hook1 = makePostToolBatchHook({ buffer, sessionKey: 's1' });
    const r1 = await hook1();
    assert.match(r1.hookSpecificOutput.additionalContext, /A/);
    assert.equal(buffer.size('s2'), 1);                    // s2 untouched
  });
});

describe('makePostToolBatchHook — error safety', () => {
  test('catches buffer errors and returns continue:true (no throw)', async () => {
    // Construct a buffer-shaped object whose drain() throws.
    const broken = {
      drain() { throw new Error('boom'); },
      formatForHook() { return null; },
    };
    const errors = [];
    const hook = makePostToolBatchHook({
      buffer: broken,
      sessionKey: 's1',
      logger: { error: (m) => errors.push(m) },
    });
    const r = await hook();
    assert.deepEqual(r, { continue: true });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /boom/);
  });

  test('logger errors do NOT propagate out of the hook', async () => {
    const buffer = createAutosteerBuffer();
    buffer.append('s1', 'hi');
    const hook = makePostToolBatchHook({
      buffer,
      sessionKey: 's1',
      logEvent: () => { throw new Error('logger blew up'); },
    });
    // Should not throw — logger error is swallowed.
    const r = await hook();
    assert.equal(r.continue, true);
    assert.match(r.hookSpecificOutput.additionalContext, /hi/);
  });
});

describe('makePostToolBatchHook — telemetry', () => {
  test('logEvent fires with autosteer-hook-drained kind on non-empty drain', async () => {
    const buffer = createAutosteerBuffer();
    buffer.append('s1', 'hi');
    buffer.append('s1', 'there');
    const events = [];
    const hook = makePostToolBatchHook({
      buffer,
      sessionKey: 's1',
      chatId: 12345,
      logEvent: (kind, detail) => events.push({ kind, detail }),
    });
    await hook();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'autosteer-hook-drained');
    assert.equal(events[0].detail.session_key, 's1');
    assert.equal(events[0].detail.chat_id, 12345);
    assert.equal(events[0].detail.message_count, 2);
  });

  test('logEvent does NOT fire on empty drain', async () => {
    const buffer = createAutosteerBuffer();
    const events = [];
    const hook = makePostToolBatchHook({
      buffer,
      sessionKey: 's1',
      logEvent: (kind, detail) => events.push({ kind, detail }),
    });
    await hook();
    assert.equal(events.length, 0);
  });

  test('logEvent is optional — no-op when not provided', async () => {
    const buffer = createAutosteerBuffer();
    buffer.append('s1', 'hi');
    const hook = makePostToolBatchHook({ buffer, sessionKey: 's1' });
    await assert.doesNotReject(hook());
  });
});

describe('makePostToolBatchHook — rc.37 onDrained', () => {
  test('onDrained fires with sessionKey and count after non-empty drain', async () => {
    const buffer = createAutosteerBuffer();
    buffer.append('s1', 'hi');
    buffer.append('s1', 'there');
    const calls = [];
    const hook = makePostToolBatchHook({
      buffer,
      sessionKey: 's1',
      onDrained: (key, count) => calls.push({ key, count }),
    });
    await hook();
    assert.deepEqual(calls, [{ key: 's1', count: 2 }]);
  });

  test('onDrained does NOT fire on empty drain', async () => {
    const buffer = createAutosteerBuffer();
    const calls = [];
    const hook = makePostToolBatchHook({
      buffer,
      sessionKey: 's1',
      onDrained: (key, count) => calls.push({ key, count }),
    });
    await hook();
    assert.equal(calls.length, 0);
  });

  test('onDrained throw is swallowed (logged, hook still returns)', async () => {
    const buffer = createAutosteerBuffer();
    buffer.append('s1', 'hi');
    const errors = [];
    const hook = makePostToolBatchHook({
      buffer,
      sessionKey: 's1',
      onDrained: () => { throw new Error('boom'); },
      logger: { error: (msg) => errors.push(msg) },
    });
    const r = await hook();
    assert.equal(r.continue, true);
    assert.match(r.hookSpecificOutput.additionalContext, /hi/);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /onDrained/);
  });
});

describe('makePostToolBatchHook — input validation', () => {
  test('throws if buffer is missing', () => {
    assert.throws(() => makePostToolBatchHook({ sessionKey: 's1' }), /buffer/);
  });

  test('throws if sessionKey is missing', () => {
    const buffer = createAutosteerBuffer();
    assert.throws(() => makePostToolBatchHook({ buffer }), /sessionKey/);
  });
});

/**
 * Smoke tests for lib/process-manager-sdk.js.
 *
 * Covers the canonical happy paths and a handful of regression
 * scenarios. NOT exhaustive — Phase 1 step 9 will port the existing
 * 47+ pm tests via the fakeQuery harness in a follow-up commit.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  ProcessManagerSdk,
  extractAssistantText,
  sumUsage,
  makeInputController,
} = require('../lib/process-manager-sdk');
const { makeFakeQuery } = require('./_helpers/fake-query');

function mockDb() {
  const events = [];
  return {
    events,
    logEvent: (kind, detail) => events.push({ kind, detail }),
    clearSessionId: () => {},
  };
}

describe('extractAssistantText', () => {
  test('joins text blocks, normalizes trailing colon → ellipsis', () => {
    const evt = { message: { content: [{ type: 'text', text: 'Hello there:' }] } };
    assert.equal(extractAssistantText(evt), 'Hello there…');
  });
  test('skips non-text blocks (tool_use)', () => {
    const evt = {
      message: {
        content: [
          { type: 'text', text: 'Hi' },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    };
    assert.equal(extractAssistantText(evt), 'Hi');
  });
  test('returns "" on missing content', () => {
    assert.equal(extractAssistantText({}), '');
    assert.equal(extractAssistantText(null), '');
  });
});

describe('sumUsage', () => {
  test('zeros for empty map', () => {
    assert.deepEqual(sumUsage(new Map()), {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
  test('sums across distinct messages', () => {
    const m = new Map();
    m.set('a', { input_tokens: 100, output_tokens: 20 });
    m.set('b', { input_tokens: 50, cache_read_input_tokens: 200 });
    const r = sumUsage(m);
    assert.equal(r.input_tokens, 150);
    assert.equal(r.output_tokens, 20);
    assert.equal(r.cache_read_input_tokens, 200);
  });
});

describe('makeInputController', () => {
  test('push/consume preserves FIFO', async () => {
    const ic = makeInputController({ queueCap: 5 });
    ic.push({ id: 1 });
    ic.push({ id: 2 });
    ic.push({ id: 3 });
    const collected = [];
    const consumer = (async () => {
      for await (const m of ic.iter) {
        collected.push(m);
        if (collected.length === 3) break;
      }
    })();
    await consumer;
    ic.close();
    assert.deepEqual(collected.map((m) => m.id), [1, 2, 3]);
  });
  test('queueCap drops oldest', () => {
    const ic = makeInputController({ queueCap: 2 });
    const dropped = [];
    ic.onDrop((m) => dropped.push(m));
    ic.push({ id: 1 });
    ic.push({ id: 2 });
    ic.push({ id: 3 });        // overflow → drops id=1
    ic.push({ id: 4 });        // overflow → drops id=2
    assert.deepEqual(dropped.map((m) => m.id), [1, 2]);
  });
  test('push after close throws INPUT_CLOSED', () => {
    const ic = makeInputController();
    ic.close();
    assert.throws(() => ic.push({ id: 1 }), { code: 'INPUT_CLOSED' });
  });

  test('push wakes a pending waiter directly (bypasses queue)', async () => {
    const ic = makeInputController({ queueCap: 5 });
    // Start an awaiter BEFORE any push — queue empty, hits waiter path.
    const p = ic.iter.next();
    ic.push({ id: 'wakeup' });
    const r = await p;
    assert.equal(r.done, false);
    assert.equal(r.value.id, 'wakeup');
    // Queue should be empty (delivered directly, not buffered).
    assert.equal(ic.size, 0);
  });

  test('multiple awaiters resolve FIFO as pushes arrive', async () => {
    const ic = makeInputController({ queueCap: 5 });
    const p1 = ic.iter.next();
    const p2 = ic.iter.next();
    const p3 = ic.iter.next();
    ic.push({ id: 1 });
    ic.push({ id: 2 });
    ic.push({ id: 3 });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1.value.id, 1);
    assert.equal(r2.value.id, 2);
    assert.equal(r3.value.id, 3);
  });

  test('size reflects queued depth', () => {
    const ic = makeInputController({ queueCap: 10 });
    assert.equal(ic.size, 0);
    ic.push({ id: 1 });
    ic.push({ id: 2 });
    assert.equal(ic.size, 2);
  });

  test('close resolves all waiting awaiters as done:true', async () => {
    const ic = makeInputController();
    const p1 = ic.iter.next();
    const p2 = ic.iter.next();
    ic.close();
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1.done, true);
    assert.equal(r2.done, true);
    assert.equal(r1.value, undefined);
  });

  test('next() after close (queue empty) returns done:true immediately', async () => {
    const ic = makeInputController();
    ic.close();
    const r = await ic.iter.next();
    assert.equal(r.done, true);
  });

  test('next() after close still drains items already buffered', async () => {
    // Pushed items survive close: drain them, THEN done:true.
    const ic = makeInputController({ queueCap: 5 });
    ic.push({ id: 1 });
    ic.push({ id: 2 });
    ic.close();
    const r1 = await ic.iter.next();
    const r2 = await ic.iter.next();
    const r3 = await ic.iter.next();
    assert.equal(r1.value.id, 1);
    assert.equal(r2.value.id, 2);
    assert.equal(r3.done, true);
  });

  test('return() also closes (idempotent with close)', async () => {
    const ic = makeInputController();
    const p = ic.iter.next();
    await ic.iter.return();
    const r = await p;
    assert.equal(r.done, true);
    // Subsequent push throws.
    assert.throws(() => ic.push({ id: 1 }), { code: 'INPUT_CLOSED' });
  });

  test('close is idempotent', () => {
    const ic = makeInputController();
    ic.close();
    assert.doesNotThrow(() => ic.close());
  });

  test('onDrop callback may throw — push survives, drop continues', () => {
    const ic = makeInputController({ queueCap: 1 });
    let dropCount = 0;
    ic.onDrop(() => { dropCount += 1; throw new Error('drop callback boom'); });
    ic.push({ id: 1 });
    // Each push past cap drops the oldest and fires the callback.
    assert.doesNotThrow(() => ic.push({ id: 2 }));
    assert.doesNotThrow(() => ic.push({ id: 3 }));
    assert.equal(dropCount, 2);
  });

  test('onDrop replacement: latest registered callback receives drops', () => {
    const ic = makeInputController({ queueCap: 1 });
    const first = [];
    const second = [];
    ic.onDrop((m) => first.push(m));
    ic.push({ id: 1 });
    ic.push({ id: 2 });                        // drops id=1 → first
    ic.onDrop((m) => second.push(m));
    ic.push({ id: 3 });                        // drops id=2 → second
    assert.deepEqual(first.map((m) => m.id), [1]);
    assert.deepEqual(second.map((m) => m.id), [2]);
  });

  test('queueCap default is exposed and reasonable', () => {
    // Smoke check: caller can construct with default and push without
    // hitting cap on small bursts.
    const ic = makeInputController();
    for (let i = 0; i < 10; i++) ic.push({ id: i });
    assert.equal(ic.size, 10);
  });

  test('rapid push+iterate interleave maintains order across the boundary', async () => {
    // Realistic shape: SDK pm worker pushes user msgs while a for-await
    // consumer drains. Order must be preserved even when pushes
    // arrive between awaits.
    const ic = makeInputController({ queueCap: 10 });
    const collected = [];
    ic.push({ id: 'a' });
    const consumer = (async () => {
      for await (const m of ic.iter) {
        collected.push(m.id);
        if (m.id === 'd') break;
      }
    })();
    // Interleave pushes between microtasks.
    await new Promise((r) => setImmediate(r));
    ic.push({ id: 'b' });
    await new Promise((r) => setImmediate(r));
    ic.push({ id: 'c' });
    ic.push({ id: 'd' });
    await consumer;
    assert.deepEqual(collected, ['a', 'b', 'c', 'd']);
  });
});

describe('ProcessManagerSdk — basic happy path', () => {
  let pm;
  let fq;
  let db;

  beforeEach(() => {
    fq = makeFakeQuery();
    db = mockDb();
    pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db,
      logger: { error: () => {}, log: () => {} },
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('init event captures session_id; result resolves pending', async () => {
    const entry = await pm.getOrSpawn('chat-1');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await new Promise((r) => setImmediate(r));
    assert.equal(entry.sessionId, 'sess-1');

    const promise = pm.send('chat-1', 'hi');
    await new Promise((r) => setImmediate(r));
    fq.emitEvent({
      type: 'assistant',
      message: {
        id: 'msg-1',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: 'hi back' }],
      },
    });
    fq.emitEvent({
      type: 'result', subtype: 'success',
      result: 'hi back', session_id: 'sess-1',
      total_cost_usd: 0.001, duration_ms: 50,
      usage: { input_tokens: 10, output_tokens: 5,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const r = await promise;
    assert.equal(r.text, 'hi back');
    assert.equal(r.error, null);
    assert.equal(r.cost, 0.001);
  });

  test('telemetry sums usage across two assistant messages', async () => {
    await pm.getOrSpawn('chat-2');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-2' });
    const promise = pm.send('chat-2', 'multi-msg');
    await new Promise((r) => setImmediate(r));
    fq.emitEvent({
      type: 'assistant',
      message: {
        id: 'm1',
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: 'text', text: 'first' }],
      },
    });
    fq.emitEvent({
      type: 'assistant',
      message: {
        id: 'm2',
        usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 500 },
        content: [
          { type: 'text', text: 'second' },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    });
    fq.emitEvent({
      type: 'result', subtype: 'success', result: 'done',
      session_id: 'sess-2', total_cost_usd: 0.005, duration_ms: 200,
      usage: { input_tokens: 150, output_tokens: 30,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
    });
    const r = await promise;
    assert.equal(r.metrics.inputTokens, 150);
    assert.equal(r.metrics.outputTokens, 30);
    assert.equal(r.metrics.cacheReadTokens, 500);
    assert.equal(r.metrics.numAssistantMessages, 2);
    assert.equal(r.metrics.numToolUses, 1);
    assert.equal(r.metrics.resultSubtype, 'success');
  });
});

describe('ProcessManagerSdk — interrupt + drainQueue (D8)', () => {
  let pm;
  let fq;

  beforeEach(() => {
    fq = makeFakeQuery();
    pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('interrupt() calls Query.interrupt; drainQueue rejects all pendings with INTERRUPTED', async () => {
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const p1 = pm.send('c', 'a');
    const p2 = pm.send('c', 'b');
    const p3 = pm.send('c', 'c');
    await new Promise((r) => setImmediate(r));
    await pm.interrupt('c');
    assert.equal(fq.interrupted, true);
    pm.drainQueue('c', 'INTERRUPTED');
    const e1 = await p1.catch((e) => e);
    const e2 = await p2.catch((e) => e);
    const e3 = await p3.catch((e) => e);
    assert.equal(e1.code, 'INTERRUPTED');
    assert.equal(e2.code, 'INTERRUPTED');
    assert.equal(e3.code, 'INTERRUPTED');
  });
});

describe('ProcessManagerSdk — mid-session config (D3, D4)', () => {
  let pm;
  let fq;

  beforeEach(() => {
    fq = makeFakeQuery();
    pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('setModel delegates to Query.setModel', async () => {
    await pm.getOrSpawn('c');
    const ok = await pm.setModel('c', 'claude-sonnet-4-6');
    assert.equal(ok, true);
    assert.equal(fq.modelChanged, 'claude-sonnet-4-6');
  });

  test('applyFlagSettings delegates to Query.applyFlagSettings (D3 — replaces respawn)', async () => {
    await pm.getOrSpawn('c');
    const ok = await pm.applyFlagSettings('c', { effortLevel: 'high' });
    assert.equal(ok, true);
    assert.deepEqual(fq.flagSettingsApplied, { effortLevel: 'high' });
  });

  test('setPermissionMode delegates', async () => {
    await pm.getOrSpawn('c');
    const ok = await pm.setPermissionMode('c', 'plan');
    assert.equal(ok, true);
    assert.equal(fq.permissionModeChanged, 'plan');
  });
});

describe('ProcessManagerSdk — subagent filter (Phase 1 step 7)', () => {
  let pm;
  let fq;
  let chunks;

  beforeEach(() => {
    fq = makeFakeQuery();
    chunks = [];
    pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
      onStreamChunk: (_k, t) => chunks.push(t),
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('parent_tool_use_id != null does NOT fire onStreamChunk', async () => {
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const promise = pm.send('c', 'q');
    await new Promise((r) => setImmediate(r));
    // Subagent assistant — should be filtered.
    fq.emitEvent({
      type: 'assistant',
      parent_tool_use_id: 'tool-call-xyz',
      message: { id: 'sub-1', content: [{ type: 'text', text: 'subagent thinking' }] },
    });
    // Top-level assistant — should fire.
    fq.emitEvent({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'top-1', content: [{ type: 'text', text: 'main reply' }] },
    });
    fq.emitEvent({
      type: 'result', subtype: 'success', result: 'main reply',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await promise;
    assert.deepEqual(chunks, ['main reply']);  // subagent text omitted
  });
});

describe('ProcessManagerSdk — compact_boundary (D6 / §5)', () => {
  let pm;
  let fq;
  let boundaries;

  beforeEach(() => {
    fq = makeFakeQuery();
    boundaries = [];
    pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
      onCompactBoundary: (_k, msg) => boundaries.push(msg),
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('SDKCompactBoundaryMessage fires onCompactBoundary with nested compact_metadata', async () => {
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const promise = pm.send('c', 'q');
    await new Promise((r) => setImmediate(r));
    fq.emitEvent({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 50000 },
    });
    fq.emitEvent({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'compacted reply' }] },
    });
    fq.emitEvent({
      type: 'result', subtype: 'success', result: 'compacted reply',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await promise;
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].compact_metadata.trigger, 'auto');
  });
});

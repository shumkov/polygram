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

describe('ProcessManagerSdk — injectUserMessage (rc.42 native autosteer)', () => {
  // U7 spike (scripts/spikes/native-queue.mjs, 2026-05-01) verified
  // SDK priority hints work cleanly:
  //   'now'   → aborts current turn, fresh turn for the followup
  //   'next'  → absorbs into current turn at next pause (default
  //             autosteer mode)
  //   'later' → queues separate turn after current ends
  // pm.injectUserMessage pushes a typed SDKUserMessage onto the
  // SDK's input controller with the chosen priority. Replaces the
  // pre-rc.42 autosteerBuffer + PostToolBatch detour.

  let pm; let fq; let db;

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

  test('pushes SDKUserMessage with priority="next" by default', async () => {
    await pm.getOrSpawn('chat-1');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's1' });
    await new Promise((r) => setImmediate(r));

    const ok = pm.injectUserMessage('chat-1', { content: 'follow-up text' });
    assert.equal(ok, true);
    await new Promise((r) => setImmediate(r));

    const last = fq.pushedMessages[fq.pushedMessages.length - 1];
    assert.equal(last.type, 'user');
    assert.equal(last.message.role, 'user');
    assert.equal(last.message.content, 'follow-up text');
    assert.equal(last.priority, 'next');
    assert.equal(last.parent_tool_use_id, null);
    assert.equal(last.shouldQuery, undefined);
  });

  test('forwards explicit priority + shouldQuery', async () => {
    await pm.getOrSpawn('chat-2');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's2' });
    await new Promise((r) => setImmediate(r));

    pm.injectUserMessage('chat-2', { content: 'queue me', priority: 'later' });
    pm.injectUserMessage('chat-2', { content: 'urgent', priority: 'now', shouldQuery: true });
    await new Promise((r) => setImmediate(r));

    const recent = fq.pushedMessages.slice(-2);
    assert.equal(recent[0].priority, 'later');
    assert.equal(recent[0].shouldQuery, undefined);
    assert.equal(recent[1].priority, 'now');
    assert.equal(recent[1].shouldQuery, true);
  });

  test('emits inject-user-message event for telemetry', async () => {
    await pm.getOrSpawn('chat-3');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's3' });
    await new Promise((r) => setImmediate(r));

    pm.injectUserMessage('chat-3', { content: 'hi', priority: 'next' });
    const ev = db.events.find((e) => e.kind === 'inject-user-message');
    assert.ok(ev, 'inject-user-message event should fire');
    assert.equal(ev.detail.session_key, 'chat-3');
    assert.equal(ev.detail.priority, 'next');
    assert.equal(ev.detail.text_len, 2);
  });

  test('returns false when sessionKey not found', () => {
    const ok = pm.injectUserMessage('nonexistent', { content: 'hi' });
    assert.equal(ok, false);
  });

  test('throws TypeError when content is missing or non-string', async () => {
    await pm.getOrSpawn('chat-4');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's4' });
    await new Promise((r) => setImmediate(r));
    assert.throws(() => pm.injectUserMessage('chat-4', {}), /content.*required/);
    assert.throws(() => pm.injectUserMessage('chat-4', { content: '' }), /content.*required/);
    assert.throws(() => pm.injectUserMessage('chat-4', { content: 42 }), /content.*required/);
  });

  test('returns false when entry is closed', async () => {
    const entry = await pm.getOrSpawn('chat-5');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's5' });
    await new Promise((r) => setImmediate(r));
    entry.closed = true;
    const ok = pm.injectUserMessage('chat-5', { content: 'hi' });
    assert.equal(ok, false);
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

  // Q1 (rc.25-x): "after /stop SDK starts slowly". The /stop path is
  // interrupt() + drainQueue() — explicitly chosen over kill() to keep
  // the Query warm. These tests pin the warm-Query contract:
  //
  //   pm.has(key) stays true; spawnFn is NOT called again; the next
  //   pm.send() reuses the same Query and resumes the same session_id.
  //
  // If any of these fail, the user's "slow restart" complaint has a
  // real fix at the lib level (instead of a UX/latency-elsewhere issue).

  test('warm-Query after interrupt: pm.has stays true, no respawn', async () => {
    let spawnCount = 0;
    const fq2 = makeFakeQuery();
    const pm2 = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => { spawnCount += 1; return fq2.query; },
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    await pm2.getOrSpawn('c');
    fq2.emitEvent({ type: 'system', subtype: 'init', session_id: 's-1' });
    const p1 = pm2.send('c', 'first turn');
    await new Promise((r) => setImmediate(r));
    assert.equal(spawnCount, 1);

    // /stop = interrupt + drainQueue (does NOT kill).
    await pm2.interrupt('c');
    pm2.drainQueue('c', 'INTERRUPTED');
    await p1.catch(() => {});

    // Pin the warm-reuse contract:
    assert.equal(pm2.has('c'), true,
      'Query must stay alive after interrupt — /stop should not respawn');
    assert.equal(pm2.get('c').inFlight, false,
      'inFlight reset to false so a follow-up send can land');

    // Next user message — must NOT respawn.
    const p2 = pm2.send('c', 'follow-up turn');
    await new Promise((r) => setImmediate(r));
    assert.equal(spawnCount, 1,
      `spawnFn called ${spawnCount} times; must remain 1 for warm reuse`);

    // Drive a clean result for the new turn so afterEach shutdown is fast.
    fq2.emitEvent({
      type: 'assistant',
      message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 },
                 content: [{ type: 'text', text: 'ok' }] },
    });
    fq2.emitEvent({
      type: 'result', subtype: 'success', result: 'ok',
      session_id: 's-1', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const r = await p2;
    assert.equal(r.error, null);
    assert.equal(r.sessionId, 's-1', 'session_id must persist across interrupt');
    await pm2.shutdown();
  });

  test('warm-Query: follow-up message is pushed via streamInput, not via fresh spawn', async () => {
    // Stronger version of the above: verify the actual SDKUserMessage
    // arrives on the SAME inputController that served the first turn.
    const fq2 = makeFakeQuery();
    const pm2 = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq2.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    await pm2.getOrSpawn('c');
    fq2.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const p1 = pm2.send('c', 'first');
    await new Promise((r) => setImmediate(r));
    await pm2.interrupt('c');
    pm2.drainQueue('c', 'INTERRUPTED');
    await p1.catch(() => {});

    // Both messages land on the same fake's pushedMessages list —
    // proves a single underlying Query handled both turns.
    const p2 = pm2.send('c', 'second');
    await new Promise((r) => setImmediate(r));
    fq2.emitEvent({
      type: 'assistant',
      message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 },
                 content: [{ type: 'text', text: 'ok' }] },
    });
    fq2.emitEvent({
      type: 'result', subtype: 'success', result: 'ok',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await p2;

    // pushedMessages contains BOTH user messages from the same Query.
    const texts = fq2.pushedMessages
      .map((m) => m?.message?.content)
      .filter(Boolean);
    const flat = texts.flat().filter((t) => typeof t === 'string').join('|');
    assert.match(flat, /first/);
    assert.match(flat, /second/);
    await pm2.shutdown();
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

  test('subagent tool_use does NOT fire onToolUse', async () => {
    const tools = [];
    const localFq = makeFakeQuery();
    const localPm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => localFq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
      onToolUse: (_k, name) => tools.push(name),
    });
    await localPm.getOrSpawn('c');
    localFq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const promise = localPm.send('c', 'q');
    await new Promise((r) => setImmediate(r));

    // Subagent fires Read — must be filtered.
    localFq.emitEvent({
      type: 'assistant',
      parent_tool_use_id: 'task-1',
      message: { id: 'sub-tool', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
    });
    // Top-level fires Bash — must register.
    localFq.emitEvent({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'top-tool', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    localFq.emitEvent({
      type: 'result', subtype: 'success', result: 'done',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await promise;
    assert.deepEqual(tools, ['Bash'], 'Read from subagent must be filtered');
    await localPm.shutdown();
  });

  test('subagent usage does NOT count toward turn token metrics', async () => {
    const localFq = makeFakeQuery();
    const localPm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => localFq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    await localPm.getOrSpawn('c');
    localFq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const promise = localPm.send('c', 'q');
    await new Promise((r) => setImmediate(r));

    // Subagent burns 5000 input tokens — should NOT count (filtered).
    localFq.emitEvent({
      type: 'assistant',
      parent_tool_use_id: 'task-1',
      message: {
        id: 'sub-msg',
        usage: { input_tokens: 5000, output_tokens: 1000 },
        content: [{ type: 'text', text: 'subagent output' }],
      },
    });
    // Top-level uses 100/20 — only this should count via per-message map.
    localFq.emitEvent({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'top-msg',
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: 'text', text: 'main reply' }],
      },
    });
    // Result usage is the SDK's authoritative aggregate (subagent
    // tokens roll up here for billing) — pm passes it through. The
    // per-MESSAGE telemetry map is what we're verifying isn't
    // polluted by subagent ids.
    localFq.emitEvent({
      type: 'result', subtype: 'success', result: 'main reply',
      session_id: 's', total_cost_usd: 0.01, duration_ms: 1,
      usage: { input_tokens: 5100, output_tokens: 1020,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const r = await promise;
    // numAssistantMessages counts only TOP-LEVEL messages.
    assert.equal(r.metrics.numAssistantMessages, 1, 'subagent message must not count');
    await localPm.shutdown();
  });

  test('subagent text + tool_use do NOT trigger fireFirstStream', async () => {
    const localFq = makeFakeQuery();
    let firstStreamFired = false;
    const localPm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => localFq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    await localPm.getOrSpawn('c');
    localFq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const promise = localPm.send('c', 'q', {
      context: { onFirstStream: () => { firstStreamFired = true; } },
    });
    await new Promise((r) => setImmediate(r));

    // 3 subagent events back-to-back — none should fire firstStream.
    for (let i = 0; i < 3; i++) {
      localFq.emitEvent({
        type: 'assistant',
        parent_tool_use_id: `task-${i}`,
        message: { id: `sub-${i}`, content: [{ type: 'text', text: `chunk ${i}` }] },
      });
      localFq.emitEvent({
        type: 'assistant',
        parent_tool_use_id: `task-${i}`,
        message: { id: `sub-tool-${i}`, content: [{ type: 'tool_use', name: 'Read', input: {} }] },
      });
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(firstStreamFired, false, 'subagents must not fire firstStream');

    // Top-level finally arrives → firstStream now fires.
    localFq.emitEvent({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'top', content: [{ type: 'text', text: 'real' }] },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(firstStreamFired, true);

    localFq.emitEvent({
      type: 'result', subtype: 'success', result: 'real',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await promise;
    await localPm.shutdown();
  });
});

describe('ProcessManagerSdk — resetSession (G9 primitive)', () => {
  // Closes v6 plan §7.1 G9 unit gate (context-overflow auto-recovery).
  // Polygram's classifier wires resetSession on role_ordering /
  // context_overflow / missing_tool_input kinds. Pin every contract
  // resetSession promises to its caller.

  test('unknown session returns no-op result', async () => {
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => makeFakeQuery().query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    const r = await pm.resetSession('never-spawned');
    assert.deepEqual(r, { closed: false, drainedPendings: 0 });
    await pm.shutdown();
  });

  test('drains pending queue with RESET_SESSION code', async () => {
    const fq = makeFakeQuery();
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const p1 = pm.send('c', 'a');
    const p2 = pm.send('c', 'b');
    await new Promise((r) => setImmediate(r));

    const r = await pm.resetSession('c', { reason: 'context_overflow' });
    assert.equal(r.drainedPendings, 2);
    const e1 = await p1.catch((e) => e);
    const e2 = await p2.catch((e) => e);
    assert.equal(e1.code, 'RESET_SESSION');
    assert.equal(e2.code, 'RESET_SESSION');
    await pm.shutdown();
  });

  test('closes the Query and removes from procs map', async () => {
    const fq = makeFakeQuery();
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    await new Promise((r) => setImmediate(r));
    assert.equal(pm.has('c'), true);

    await pm.resetSession('c', { reason: 'role_ordering' });
    assert.equal(pm.has('c'), false);
    assert.equal(fq.closed, true, 'Query.close must be called');
    await pm.shutdown();
  });

  test('clears persisted claude_session_id via db.clearSessionId', async () => {
    const cleared = [];
    const db = {
      ...mockDb(),
      clearSessionId: (key) => cleared.push(key),
    };
    const fq = makeFakeQuery();
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db,
      logger: { error: () => {}, log: () => {} },
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    await new Promise((r) => setImmediate(r));
    await pm.resetSession('c', { reason: 'auth_expired' });
    assert.deepEqual(cleared, ['c']);
    await pm.shutdown();
  });

  test('survives db.clearSessionId throwing — still closes & drains', async () => {
    const errors = [];
    const db = {
      ...mockDb(),
      clearSessionId: () => { throw new Error('db locked'); },
    };
    const fq = makeFakeQuery();
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db,
      logger: { error: (m) => errors.push(m), log: () => {} },
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    await new Promise((r) => setImmediate(r));
    const r = await pm.resetSession('c', { reason: 'context_overflow' });
    assert.equal(r.closed, true);
    assert.equal(pm.has('c'), false);
    assert.ok(errors.some((m) => /clearSessionId/.test(m)));
    await pm.shutdown();
  });

  test('logs session-reset telemetry event', async () => {
    const events = [];
    const fq = makeFakeQuery();
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
      logger: { error: () => {}, log: () => {} },
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    pm.send('c', 'a').catch(() => {});
    await new Promise((r) => setImmediate(r));
    await pm.resetSession('c', { reason: 'context_overflow' });
    const ev = events.find((e) => e.kind === 'session-reset');
    assert.ok(ev, 'session-reset event must fire');
    assert.equal(ev.detail.session_key, 'c');
    assert.equal(ev.detail.reason, 'context_overflow');
    assert.equal(ev.detail.drained_pendings, 1);
    assert.equal(ev.detail.closed, true);
    await pm.shutdown();
  });

  test('signals parked LRU waiter so a new spawn unparks', async () => {
    const fqs = [makeFakeQuery(), makeFakeQuery(), makeFakeQuery()];
    let idx = 0;
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fqs[idx++].query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    // Fill cap with in-flight entries.
    await pm.getOrSpawn('c1');
    fqs[0].emitEvent({ type: 'system', subtype: 'init', session_id: 's1' });
    pm.send('c1', 'a').catch(() => {});
    await pm.getOrSpawn('c2');
    fqs[1].emitEvent({ type: 'system', subtype: 'init', session_id: 's2' });
    pm.send('c2', 'b').catch(() => {});
    await new Promise((r) => setImmediate(r));

    // Park c3.
    const parked = pm.getOrSpawn('c3');
    await new Promise((r) => setTimeout(r, 20));

    // Reset c1 — signals LRU waiter, c3 unparks.
    await pm.resetSession('c1', { reason: 'context_overflow' });
    fqs[2].emitEvent({ type: 'system', subtype: 'init', session_id: 's3' });
    await parked;
    assert.equal(pm.has('c3'), true);
    await pm.shutdown();
  });

  test('idempotent: second resetSession on same key is a no-op', async () => {
    const fq = makeFakeQuery();
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    await new Promise((r) => setImmediate(r));
    const r1 = await pm.resetSession('c', { reason: 'first' });
    const r2 = await pm.resetSession('c', { reason: 'second' });
    assert.equal(r1.closed, true);
    assert.deepEqual(r2, { closed: false, drainedPendings: 0 });
    await pm.shutdown();
  });
});

describe('ProcessManagerSdk — LRU eviction (G14)', () => {
  // v6 plan §7.1 G14: cap=2, spawn 3 chats, oldest evicts cleanly.
  // Pins the contract pre-SDK-pm-rollout to partner chats.

  test('cap=2: spawning third chat evicts oldest idle entry', async () => {
    const fqs = [makeFakeQuery(), makeFakeQuery(), makeFakeQuery()];
    let spawnIdx = 0;
    const events = [];
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fqs[spawnIdx++].query,
      logger: { error: () => {}, log: () => {} },
      // Capture lru/evict events.
      db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    });

    // chat-1 spawned.
    await pm.getOrSpawn('chat-1');
    fqs[0].emitEvent({ type: 'system', subtype: 'init', session_id: 's1' });
    await new Promise((r) => setImmediate(r));
    assert.equal(pm.size, 1);

    // chat-2 spawned. lastUsedTs guarantees chat-1 is older.
    await new Promise((r) => setTimeout(r, 5));
    await pm.getOrSpawn('chat-2');
    fqs[1].emitEvent({ type: 'system', subtype: 'init', session_id: 's2' });
    await new Promise((r) => setImmediate(r));
    assert.equal(pm.size, 2);

    // chat-3 — at cap, must evict oldest (chat-1, idle).
    await new Promise((r) => setTimeout(r, 5));
    await pm.getOrSpawn('chat-3');
    fqs[2].emitEvent({ type: 'system', subtype: 'init', session_id: 's3' });
    await new Promise((r) => setImmediate(r));

    assert.equal(pm.size, 2);
    assert.ok(!pm.has('chat-1'), 'chat-1 should be evicted');
    assert.ok(pm.has('chat-2'));
    assert.ok(pm.has('chat-3'));
    assert.ok(events.some((e) => e.kind === 'evict' && e.detail.session_key === 'chat-1'));

    await pm.shutdown();
  });

  test('in-flight entry is NOT evicted; idle one with later lastUsedTs is', async () => {
    const fqs = [makeFakeQuery(), makeFakeQuery(), makeFakeQuery()];
    let spawnIdx = 0;
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fqs[spawnIdx++].query,
      logger: { error: () => {}, log: () => {} },
    });

    // chat-1 spawned and KEPT in-flight (no result event).
    await pm.getOrSpawn('chat-1');
    fqs[0].emitEvent({ type: 'system', subtype: 'init', session_id: 's1' });
    pm.send('chat-1', 'in-flight prompt').catch(() => {});
    await new Promise((r) => setImmediate(r));
    // Verify in-flight.
    assert.equal(pm.get('chat-1').inFlight, true);

    // chat-2 spawned, finished, idle.
    await pm.getOrSpawn('chat-2');
    fqs[1].emitEvent({ type: 'system', subtype: 'init', session_id: 's2' });
    await new Promise((r) => setImmediate(r));

    // chat-3 — must evict chat-2 (idle), NOT chat-1 (in-flight).
    await pm.getOrSpawn('chat-3');
    fqs[2].emitEvent({ type: 'system', subtype: 'init', session_id: 's3' });
    await new Promise((r) => setImmediate(r));

    assert.ok(pm.has('chat-1'), 'chat-1 in-flight must be preserved');
    assert.ok(!pm.has('chat-2'), 'chat-2 idle must be evicted');
    assert.ok(pm.has('chat-3'));

    await pm.shutdown();
  });

  test('all entries in-flight: getOrSpawn parks until a slot opens', async () => {
    const fqs = [makeFakeQuery(), makeFakeQuery(), makeFakeQuery()];
    let spawnIdx = 0;
    const events = [];
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fqs[spawnIdx++].query,
      logger: { error: () => {}, log: () => {} },
      db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    });

    // Both slots filled with in-flight entries.
    await pm.getOrSpawn('chat-1');
    fqs[0].emitEvent({ type: 'system', subtype: 'init', session_id: 's1' });
    pm.send('chat-1', 'p1').catch(() => {});
    await pm.getOrSpawn('chat-2');
    fqs[1].emitEvent({ type: 'system', subtype: 'init', session_id: 's2' });
    pm.send('chat-2', 'p2').catch(() => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(pm.get('chat-1').inFlight, true);
    assert.equal(pm.get('chat-2').inFlight, true);

    // Third spawn should park.
    let parked = true;
    const thirdSpawn = pm.getOrSpawn('chat-3').then(() => { parked = false; });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(parked, true, 'chat-3 must park while all entries in-flight');
    assert.ok(events.some((e) => e.kind === 'lru-wait'));
    assert.ok(events.some((e) => e.kind === 'lru-full'));

    // Free a slot via kill — chat-3 parked spawn should resume.
    await pm.kill('chat-1');
    await thirdSpawn;
    assert.ok(pm.has('chat-3'));

    await pm.shutdown();
  });

  test('evict-close-timeout fires when query.close exceeds queryCloseTimeoutMs', async () => {
    const fqs = [makeFakeQuery(), makeFakeQuery(), makeFakeQuery()];
    let spawnIdx = 0;
    // Override fqs[0].query.close to hang forever — pm should
    // race it against queryCloseTimeoutMs and log the timeout.
    fqs[0].query.close = () => new Promise(() => {});

    const events = [];
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 25,                           // tight for the test
      spawnFn: () => fqs[spawnIdx++].query,
      logger: { error: () => {}, log: () => {} },
      db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    });

    await pm.getOrSpawn('chat-1');
    fqs[0].emitEvent({ type: 'system', subtype: 'init', session_id: 's1' });
    await pm.getOrSpawn('chat-2');
    fqs[1].emitEvent({ type: 'system', subtype: 'init', session_id: 's2' });
    await new Promise((r) => setImmediate(r));

    // Trigger eviction — chat-1's hung close() exceeds timeout.
    await pm.getOrSpawn('chat-3');
    fqs[2].emitEvent({ type: 'system', subtype: 'init', session_id: 's3' });
    await new Promise((r) => setTimeout(r, 80));         // > queryCloseTimeoutMs

    const evictTimeout = events.find((e) => e.kind === 'evict-close-timeout');
    assert.ok(evictTimeout, 'evict-close-timeout event must fire');
    assert.equal(evictTimeout.detail.session_key, 'chat-1');
    // Evicted entry still removed from procs map regardless.
    assert.ok(!pm.has('chat-1'));

    await pm.shutdown();
  });

  test('shutdown signals all parked LRU waiters with rejection', async () => {
    const fqs = [makeFakeQuery(), makeFakeQuery(), makeFakeQuery()];
    let spawnIdx = 0;
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fqs[spawnIdx++].query,
      logger: { error: () => {}, log: () => {} },
    });

    await pm.getOrSpawn('chat-1');
    fqs[0].emitEvent({ type: 'system', subtype: 'init', session_id: 's1' });
    pm.send('chat-1', 'p1').catch(() => {});
    await pm.getOrSpawn('chat-2');
    fqs[1].emitEvent({ type: 'system', subtype: 'init', session_id: 's2' });
    pm.send('chat-2', 'p2').catch(() => {});
    await new Promise((r) => setImmediate(r));

    // Park chat-3 — both slots in-flight.
    const parked = pm.getOrSpawn('chat-3');
    await new Promise((r) => setTimeout(r, 20));

    // Shutdown should reject the parked waiter.
    await pm.shutdown();
    await assert.rejects(parked, /shutdown/);
  });
});

describe('ProcessManagerSdk — onThinking (rc.29 extended-thinking signal)', () => {
  // The fix for "👀 sits for 10+ s under effort=high before 🤔 fires".
  // pm-sdk now listens for SDKPartialAssistantMessage stream_events
  // (requires Options.includePartialMessages: true) and fires
  // onThinking on the FIRST content_block_start with type='thinking'.
  // polygram wires this to reactor.setState('THINKING').

  test('fires onThinking on first content_block_start type=thinking', async () => {
    const fq = makeFakeQuery();
    const calls = [];
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
      onThinking: (sessionKey, entry) => calls.push({ sessionKey, entry }),
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const promise = pm.send('c', 'long task');
    await new Promise((r) => setImmediate(r));

    fq.emitEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    });
    await new Promise((r) => setImmediate(r));

    assert.equal(calls.length, 1, 'onThinking must fire exactly once');
    assert.equal(calls[0].sessionKey, 'c');

    fq.emitEvent({
      type: 'assistant',
      message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 },
                 content: [{ type: 'text', text: 'done' }] },
    });
    fq.emitEvent({
      type: 'result', subtype: 'success', result: 'done',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await promise;
    await pm.shutdown();
  });

  test('subsequent thinking blocks do NOT re-fire onThinking (idempotent)', async () => {
    const fq = makeFakeQuery();
    const calls = [];
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
      onThinking: () => calls.push('fired'),
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const promise = pm.send('c', 'q');
    await new Promise((r) => setImmediate(r));

    // 3 thinking starts in a row — only the first should fire.
    for (let i = 0; i < 3; i++) {
      fq.emitEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', index: i,
                 content_block: { type: 'thinking', thinking: '' } },
      });
    }
    await new Promise((r) => setImmediate(r));

    assert.equal(calls.length, 1, 'only first thinking start fires');

    fq.emitEvent({
      type: 'result', subtype: 'success', result: '',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await promise;
    await pm.shutdown();
  });

  test('non-thinking stream_events do NOT fire onThinking', async () => {
    const fq = makeFakeQuery();
    const calls = [];
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
      onThinking: () => calls.push('fired'),
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });
    const promise = pm.send('c', 'q');
    await new Promise((r) => setImmediate(r));

    // Various non-thinking stream_events.
    fq.emitEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0,
               content_block: { type: 'text', text: '' } },
    });
    fq.emitEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1,
               content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } },
    });
    fq.emitEvent({
      type: 'stream_event',
      event: { type: 'message_start', message: {} },
    });
    await new Promise((r) => setImmediate(r));

    assert.equal(calls.length, 0, 'only thinking content_block fires onThinking');
    fq.emitEvent({
      type: 'result', subtype: 'success', result: '',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await promise;
    await pm.shutdown();
  });

  test('next turn re-arms thinkingFired (fires once per pending)', async () => {
    const fq = makeFakeQuery();
    const calls = [];
    const pm = new ProcessManagerSdk({
      cap: 2,
      queryCloseTimeoutMs: 100,
      spawnFn: () => fq.query,
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
      onThinking: () => calls.push('fired'),
    });
    await pm.getOrSpawn('c');
    fq.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });

    // Turn 1.
    const p1 = pm.send('c', 't1');
    await new Promise((r) => setImmediate(r));
    fq.emitEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0,
               content_block: { type: 'thinking', thinking: '' } },
    });
    fq.emitEvent({
      type: 'result', subtype: 'success', result: '',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await p1;

    // Turn 2 — should fire AGAIN.
    const p2 = pm.send('c', 't2');
    await new Promise((r) => setImmediate(r));
    fq.emitEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0,
               content_block: { type: 'thinking', thinking: '' } },
    });
    fq.emitEvent({
      type: 'result', subtype: 'success', result: '',
      session_id: 's', total_cost_usd: 0, duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await p2;

    assert.equal(calls.length, 2, 'onThinking fires once per turn');
    await pm.shutdown();
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

/**
 * Tests for the 0.7.6 telemetry + queue-cap features in ProcessManager.
 *   F — sumUsage helper + per-pending usage accumulation through to
 *       result.metrics on resolve()
 *   H — queueCap drop-oldest policy with rejection of dropped pendings
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, PassThrough } = require('stream');

const { ProcessManager, sumUsage } = require('../lib/process-manager');

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('close', 0)); };
  proc.emitEvent = (obj) => proc.stdout.write(JSON.stringify(obj) + '\n');
  return proc;
}

function mockDb() {
  const events = [];
  return {
    events,
    logEvent: (kind, detail) => events.push({ kind, detail }),
    clearSessionId: () => {},
  };
}

describe('sumUsage helper (F)', () => {
  test('returns zeros for an empty map', () => {
    const r = sumUsage(new Map());
    assert.deepEqual(r, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  test('sums across distinct messages (last-seen-per-id wins)', () => {
    const m = new Map();
    m.set('msg_1', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 });
    m.set('msg_2', { input_tokens: 80, output_tokens: 30, cache_creation_input_tokens: 40 });
    const r = sumUsage(m);
    assert.equal(r.input_tokens, 180);
    assert.equal(r.output_tokens, 80);
    assert.equal(r.cache_creation_input_tokens, 40);
    assert.equal(r.cache_read_input_tokens, 200);
  });

  test('treats missing fields as zero, not NaN', () => {
    const m = new Map();
    m.set('msg_1', { input_tokens: 100 });
    const r = sumUsage(m);
    assert.equal(r.input_tokens, 100);
    assert.equal(r.output_tokens, 0);
  });

  test('ignores null / undefined values defensively', () => {
    const m = new Map();
    m.set('a', null);
    m.set('b', { input_tokens: 5 });
    m.set('c', undefined);
    const r = sumUsage(m);
    assert.equal(r.input_tokens, 5);
  });
});

describe('ProcessManager — usage accumulation through to result.metrics (F)', () => {
  let pm;

  beforeEach(() => {
    pm = new ProcessManager({
      cap: 2,
      killTimeoutMs: 50,
      spawnFn: () => makeFakeProc(),
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('result.metrics reflects summed usage across two assistant messages', async () => {
    const entry = await pm.getOrSpawn('c1');
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' });

    const promise = pm.send('c1', 'hi');
    await new Promise((r) => setImmediate(r));

    entry.proc.emitEvent({
      type: 'assistant',
      message: {
        id: 'msg_1',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500 },
        content: [{ type: 'text', text: 'first reply' }],
      },
    });
    entry.proc.emitEvent({
      type: 'assistant',
      message: {
        id: 'msg_2',
        usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 30 },
        content: [
          { type: 'text', text: 'second reply' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    });
    entry.proc.emitEvent({
      type: 'result',
      subtype: 'success',
      result: 'final text',
      session_id: 'sess-1',
      total_cost_usd: 0.0123,
      duration_ms: 1234,
    });

    const result = await promise;
    assert.equal(result.cost, 0.0123);
    assert.equal(result.duration, 1234);
    assert.ok(result.metrics);
    assert.equal(result.metrics.inputTokens, 150);
    assert.equal(result.metrics.outputTokens, 30);
    assert.equal(result.metrics.cacheCreationTokens, 30);
    assert.equal(result.metrics.cacheReadTokens, 500);
    assert.equal(result.metrics.numAssistantMessages, 2);
    assert.equal(result.metrics.numToolUses, 1);
    assert.equal(result.metrics.resultSubtype, 'success');
  });

  test('within-message updates do NOT double-count (last-seen wins)', async () => {
    const entry = await pm.getOrSpawn('c2');
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-2' });

    const promise = pm.send('c2', 'hi');
    await new Promise((r) => setImmediate(r));

    entry.proc.emitEvent({
      type: 'assistant',
      message: {
        id: 'msg_a',
        usage: { input_tokens: 50, output_tokens: 5 },
        content: [{ type: 'text', text: 'partial' }],
      },
    });
    entry.proc.emitEvent({
      type: 'assistant',
      message: {
        id: 'msg_a',
        usage: { input_tokens: 150, output_tokens: 25 },
        content: [{ type: 'text', text: 'partial more' }],
      },
    });
    entry.proc.emitEvent({
      type: 'result', subtype: 'success', session_id: 'sess-2',
      total_cost_usd: 0.001, duration_ms: 100, result: '',
    });

    const result = await promise;
    assert.equal(result.metrics.inputTokens, 150);
    assert.equal(result.metrics.outputTokens, 25);
    assert.equal(result.metrics.numAssistantMessages, 1);
  });

  test('result.metrics is present even when no usage was emitted', async () => {
    const entry = await pm.getOrSpawn('c3');
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-3' });

    const promise = pm.send('c3', 'hi');
    await new Promise((r) => setImmediate(r));
    entry.proc.emitEvent({
      type: 'result', subtype: 'success', session_id: 'sess-3',
      total_cost_usd: 0, duration_ms: 50, result: 'no-usage-claude',
    });

    const result = await promise;
    assert.ok(result.metrics);
    assert.equal(result.metrics.inputTokens, 0);
    assert.equal(result.metrics.numAssistantMessages, 0);
    assert.equal(result.metrics.numToolUses, 0);
  });
});

describe('ProcessManager — queue cap (H)', () => {
  let pm;
  let dropped;

  beforeEach(() => {
    dropped = [];
    pm = new ProcessManager({
      cap: 2,
      queueCap: 3,
      killTimeoutMs: 50,
      spawnFn: () => makeFakeProc(),
      db: mockDb(),
      logger: { error: () => {}, log: () => {} },
      onQueueDrop: (sessionKey, p) => dropped.push({ sessionKey, msgId: p.context?.sourceMsgId }),
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('drops oldest non-active pending when queueCap is exceeded', async () => {
    const entry = await pm.getOrSpawn('c1');
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });

    const p1 = pm.send('c1', 'one',   { context: { sourceMsgId: 1 } });
    const p2 = pm.send('c1', 'two',   { context: { sourceMsgId: 2 } });
    const p3 = pm.send('c1', 'three', { context: { sourceMsgId: 3 } });
    await new Promise((r) => setImmediate(r));

    const p4 = pm.send('c1', 'four', { context: { sourceMsgId: 4 } });

    const dropErr = await p2.catch((e) => e);
    assert.equal(dropErr.code, 'QUEUE_OVERFLOW');
    assert.match(dropErr.message, /queue cap 3/);
    assert.deepEqual(dropped, [{ sessionKey: 'c1', msgId: 2 }]);

    entry.proc.emitEvent({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, duration_ms: 1, result: 'r1' });
    entry.proc.emitEvent({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, duration_ms: 1, result: 'r3' });
    entry.proc.emitEvent({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, duration_ms: 1, result: 'r4' });

    const [r1, r3, r4] = await Promise.all([p1, p3, p4]);
    assert.equal(r1.text, 'r1');
    assert.equal(r3.text, 'r3');
    assert.equal(r4.text, 'r4');
  });

  test('drops multiple if pushed well past cap (oldest first)', async () => {
    const entry = await pm.getOrSpawn('c2');
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });

    const head = pm.send('c2', 'head', { context: { sourceMsgId: 100 } });
    const q1 = pm.send('c2', 'q1', { context: { sourceMsgId: 101 } });
    const q2 = pm.send('c2', 'q2', { context: { sourceMsgId: 102 } });
    const q3 = pm.send('c2', 'q3', { context: { sourceMsgId: 103 } });
    const q4 = pm.send('c2', 'q4', { context: { sourceMsgId: 104 } });

    const e1 = await q1.catch((e) => e);
    const e2 = await q2.catch((e) => e);
    assert.equal(e1.code, 'QUEUE_OVERFLOW');
    assert.equal(e2.code, 'QUEUE_OVERFLOW');
    assert.deepEqual(dropped.map((d) => d.msgId).sort(), [101, 102]);

    for (let i = 0; i < 3; i++) {
      entry.proc.emitEvent({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, duration_ms: 1, result: `r${i}` });
    }
    await Promise.all([head, q3, q4]);
  });

  test('queue-overflow-drop event is logged with source_msg_id', async () => {
    const db = mockDb();
    pm = new ProcessManager({
      cap: 2,
      queueCap: 2,
      killTimeoutMs: 50,
      spawnFn: () => makeFakeProc(),
      db,
      logger: { error: () => {}, log: () => {} },
    });
    const entry = await pm.getOrSpawn('c3');
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 's' });

    const p1 = pm.send('c3', 'a', { context: { sourceMsgId: 10 } });
    const p2 = pm.send('c3', 'b', { context: { sourceMsgId: 11 } });
    const p3 = pm.send('c3', 'c', { context: { sourceMsgId: 12 } });

    const dropErr = await p2.catch((e) => e);
    assert.equal(dropErr.code, 'QUEUE_OVERFLOW');

    const drops = db.events.filter((e) => e.kind === 'queue-overflow-drop');
    assert.equal(drops.length, 1);
    assert.equal(drops[0].detail.source_msg_id, 11);
    assert.equal(drops[0].detail.session_key, 'c3');

    entry.proc.emitEvent({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, duration_ms: 1, result: 'r1' });
    entry.proc.emitEvent({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, duration_ms: 1, result: 'r3' });
    await Promise.all([p1, p3]);
  });
});

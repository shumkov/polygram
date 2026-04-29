/**
 * Tests for the 0.7.7 transient HTTP retry path in ProcessManager.
 *
 * Behaviour: when a result event carries a retryable error
 * (`isTransientHttpError`-classified) AND the turn produced zero
 * assistant content yet, pm sleeps DEFAULT_TRANSIENT_RETRY_DELAY_MS
 * (2.5s) and re-writes the same user prompt to stdin. After
 * MAX_TRANSIENT_RETRIES (1), the next failure surfaces normally.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, PassThrough } = require('stream');

const { ProcessManager } = require('../lib/process-manager');

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

// Drain stdin into an array so tests can assert on the exact JSON
// lines pm wrote.
function captureStdin(proc) {
  const writes = [];
  proc.stdin.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => {
      try { writes.push(JSON.parse(line)); }
      catch { /* fragmented */ }
    });
  });
  return writes;
}

describe('ProcessManager — transient HTTP retry (0.7.7)', () => {
  let pm;
  let db;

  beforeEach(() => {
    db = mockDb();
    pm = new ProcessManager({
      cap: 2,
      killTimeoutMs: 50,
      spawnFn: () => makeFakeProc(),
      db,
      logger: { error: () => {}, log: () => {} },
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('transient 503 with no assistant content → retries once and resolves', async (t) => {
    const entry = await pm.getOrSpawn('chat-1');
    const writes = captureStdin(entry.proc);
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' });

    const promise = pm.send('chat-1', 'do the thing');
    await new Promise((r) => setImmediate(r));
    assert.equal(writes.length, 1, 'first write happens immediately');
    assert.equal(writes[0].message.content, 'do the thing');

    // First result: transient 503, no assistant content yet → retry.
    entry.proc.emitEvent({
      type: 'result', subtype: 'error_during_execution',
      session_id: 'sess-1', total_cost_usd: 0, duration_ms: 100,
      error: 'HTTP 503 Service Unavailable',
    });

    // Wait for retry sleep + re-write. Default delay is 2.5s but
    // we don't want to wait that long — fake timers would be ideal,
    // but a 3s real wait keeps the test simple and deterministic.
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(writes.length, 2, 'pm re-wrote the prompt');
    assert.equal(writes[1].message.content, 'do the thing', 'same prompt content');

    // Second result: success.
    entry.proc.emitEvent({
      type: 'result', subtype: 'success',
      result: 'done!', session_id: 'sess-1',
      total_cost_usd: 0.001, duration_ms: 200,
    });

    const result = await promise;
    assert.equal(result.text, 'done!');
    assert.equal(result.error, null);

    // Telemetry: one transient-retry event with attempt=1.
    const retries = db.events.filter((e) => e.kind === 'transient-retry');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].detail.attempt, 1);
    assert.match(retries[0].detail.error, /503/);
  });

  test('two consecutive 503s → second one surfaces (no infinite retry)', async () => {
    const entry = await pm.getOrSpawn('chat-2');
    const writes = captureStdin(entry.proc);
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-2' });

    const promise = pm.send('chat-2', 'try this');
    await new Promise((r) => setImmediate(r));
    entry.proc.emitEvent({
      type: 'result', subtype: 'error_during_execution',
      session_id: 'sess-2', total_cost_usd: 0, duration_ms: 50,
      error: 'HTTP 503',
    });
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(writes.length, 2, 'first retry happened');

    // Second 503 — already retried once, so this surfaces.
    entry.proc.emitEvent({
      type: 'result', subtype: 'error_during_execution',
      session_id: 'sess-2', total_cost_usd: 0, duration_ms: 50,
      error: 'HTTP 503 again',
    });

    const result = await promise;
    assert.match(result.error, /503 again/);
    assert.equal(writes.length, 2, 'pm did NOT write a third time');

    const retries = db.events.filter((e) => e.kind === 'transient-retry');
    assert.equal(retries.length, 1, 'only one retry recorded');
  });

  test('503 AFTER assistant content streamed → no retry (idempotency)', async () => {
    const entry = await pm.getOrSpawn('chat-3');
    const writes = captureStdin(entry.proc);
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-3' });

    const promise = pm.send('chat-3', 'multi-step task');
    await new Promise((r) => setImmediate(r));

    // Assistant streams something — could be text or tool_use.
    entry.proc.emitEvent({
      type: 'assistant',
      message: {
        id: 'msg-1',
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: 'text', text: 'Working on it…' }],
      },
    });
    await new Promise((r) => setImmediate(r));

    // Then a transient error. Because firstAssistantSeen=true, retry
    // is suppressed (replaying the prompt could re-execute tools).
    entry.proc.emitEvent({
      type: 'result', subtype: 'error_during_execution',
      session_id: 'sess-3', total_cost_usd: 0.001, duration_ms: 100,
      error: 'HTTP 503',
    });

    const result = await promise;
    assert.match(result.error, /503/);
    assert.equal(writes.length, 1, 'no re-write');
    const retries = db.events.filter((e) => e.kind === 'transient-retry');
    assert.equal(retries.length, 0);
  });

  test('503 after tool_use → no retry (tools may have run)', async () => {
    const entry = await pm.getOrSpawn('chat-4');
    const writes = captureStdin(entry.proc);
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-4' });

    const promise = pm.send('chat-4', 'list files');
    await new Promise((r) => setImmediate(r));

    entry.proc.emitEvent({
      type: 'assistant',
      message: {
        id: 'msg-1',
        usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    await new Promise((r) => setImmediate(r));

    entry.proc.emitEvent({
      type: 'result', subtype: 'error_during_execution',
      session_id: 'sess-4', total_cost_usd: 0.001, duration_ms: 50,
      error: 'HTTP 503',
    });

    const result = await promise;
    assert.match(result.error, /503/);
    assert.equal(writes.length, 1, 'no re-write — tool already ran');
  });

  test('non-transient error (e.g. 401) does NOT retry', async () => {
    const entry = await pm.getOrSpawn('chat-5');
    const writes = captureStdin(entry.proc);
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-5' });

    const promise = pm.send('chat-5', 'auth-fail flow');
    await new Promise((r) => setImmediate(r));
    entry.proc.emitEvent({
      type: 'result', subtype: 'error_during_execution',
      session_id: 'sess-5', total_cost_usd: 0, duration_ms: 50,
      error: 'HTTP 401 Unauthorized',
    });

    const result = await promise;
    assert.match(result.error, /401/);
    assert.equal(writes.length, 1, 'no retry on auth error');
    const retries = db.events.filter((e) => e.kind === 'transient-retry');
    assert.equal(retries.length, 0);
  });

  test('429 rate-limit retries (treated as transient)', async () => {
    const entry = await pm.getOrSpawn('chat-6');
    const writes = captureStdin(entry.proc);
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-6' });

    const promise = pm.send('chat-6', 'rate-limit test');
    await new Promise((r) => setImmediate(r));
    entry.proc.emitEvent({
      type: 'result', subtype: 'error_during_execution',
      session_id: 'sess-6', total_cost_usd: 0, duration_ms: 50,
      error: 'HTTP 429 Too Many Requests',
    });

    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(writes.length, 2, 'pm retried after 429');

    entry.proc.emitEvent({
      type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-6',
      total_cost_usd: 0.001, duration_ms: 100,
    });
    const result = await promise;
    assert.equal(result.text, 'ok');
  });
});

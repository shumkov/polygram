/**
 * Tests for lib/process-manager.js
 * Run: node --test tests/process-manager.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, PassThrough } = require('stream');

const { ProcessManager } = require('../lib/process-manager');

// ─── Fake claude process ────────────────────────────────────────────

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = (sig = 'SIGTERM') => {
    if (proc.killed) return;
    proc.killed = true;
    // Simulate async close like a real process would
    setImmediate(() => {
      proc.emit('close', sig === 'SIGKILL' ? 137 : 0);
    });
  };
  // Helper to emit stdout events as JSON lines
  proc.emitEvent = (obj) => {
    proc.stdout.write(JSON.stringify(obj) + '\n');
  };
  return proc;
}

function mockDb() {
  const events = [];
  const cleared = [];
  return {
    events,
    cleared,
    logEvent: (kind, detail) => events.push({ kind, detail }),
    clearSessionId: (sessionKey) => cleared.push(sessionKey),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('ProcessManager basics', () => {
  let pm;
  let spawnCalls;

  beforeEach(() => {
    spawnCalls = [];
    pm = new ProcessManager({
      cap: 3,
      killTimeoutMs: 50,
      logger: { error: () => {}, log: () => {} },
      spawnFn: (key, ctx) => {
        const proc = makeFakeProc();
        spawnCalls.push({ key, ctx, proc });
        return proc;
      },
    });
  });

  afterEach(async () => {
    await pm.shutdown();
  });

  test('getOrSpawn spawns on first call, returns cached on second', async () => {
    const e1 = await pm.getOrSpawn('a');
    const e2 = await pm.getOrSpawn('a');
    assert.equal(spawnCalls.length, 1);
    assert.equal(e1, e2);
  });

  test('tracks sessionKey → entry map', async () => {
    await pm.getOrSpawn('a');
    await pm.getOrSpawn('b');
    assert.equal(pm.size(), 2);
    assert.deepEqual(pm.keys().sort(), ['a', 'b']);
    assert.ok(pm.has('a'));
    assert.ok(!pm.has('c'));
  });

  test('proc close removes entry from map', async () => {
    const e = await pm.getOrSpawn('a');
    assert.equal(pm.size(), 1);
    e.proc.emit('close', 0);
    assert.equal(pm.size(), 0);
  });

  test('proc error removes entry from map and marks closed', async () => {
    const e = await pm.getOrSpawn('a');
    assert.equal(pm.size(), 1);
    e.proc.emit('error', new Error('ENOENT'));
    assert.equal(pm.size(), 0);
    assert.equal(e.closed, true);
  });

  test('proc error rejects pending send and clears inFlight', async () => {
    const e = await pm.getOrSpawn('a');
    const p = pm.send('a', { foo: 1 }, { timeoutMs: 5000 });
    e.proc.emit('error', new Error('spawn failed'));
    await assert.rejects(p, /spawn failed/);
    assert.equal(e.inFlight, false);
    assert.equal(pm.size(), 0);
  });

  test('kill removes entry and resolves', async () => {
    await pm.getOrSpawn('a');
    await pm.kill('a');
    assert.equal(pm.size(), 0);
  });

  test('shutdown kills all entries', async () => {
    await pm.getOrSpawn('a');
    await pm.getOrSpawn('b');
    await pm.shutdown();
    assert.equal(pm.size(), 0);
  });

  test('killChat kills only matching chat', async () => {
    await pm.getOrSpawn('-100');
    await pm.getOrSpawn('-100:5');
    await pm.getOrSpawn('-200');
    await pm.killChat('-100');
    assert.deepEqual(pm.keys(), ['-200']);
  });
});

describe('ProcessManager LRU eviction', () => {
  let pm;
  let db;

  beforeEach(() => {
    db = mockDb();
    pm = new ProcessManager({
      cap: 2,
      killTimeoutMs: 50,
      db,
      logger: { error: () => {}, log: () => {} },
      spawnFn: () => makeFakeProc(),
    });
  });

  afterEach(async () => {
    await pm.shutdown();
  });

  test('exceeds cap → evicts oldest idle', async () => {
    const a = await pm.getOrSpawn('a');
    a.lastUsedTs = 100;
    const b = await pm.getOrSpawn('b');
    b.lastUsedTs = 200;
    await pm.getOrSpawn('c'); // triggers evict of 'a'
    assert.equal(pm.size(), 2);
    assert.ok(!pm.has('a'), 'oldest (a) should be evicted');
    assert.ok(pm.has('b'));
    assert.ok(pm.has('c'));
    const evictEvent = db.events.find((e) => e.kind === 'evict');
    assert.ok(evictEvent, 'evict event should be logged');
    assert.equal(evictEvent.detail.session_key, 'a');
  });

  test('all in-flight → throws with lru-full event', async () => {
    const a = await pm.getOrSpawn('a');
    a.inFlight = true;
    const b = await pm.getOrSpawn('b');
    b.inFlight = true;
    await assert.rejects(() => pm.getOrSpawn('c'), /LRU full/);
    assert.ok(db.events.find((e) => e.kind === 'lru-full'));
  });

  test('in-flight process is never evicted', async () => {
    const a = await pm.getOrSpawn('a');
    a.lastUsedTs = 1;
    a.inFlight = true; // a is busy, oldest, but should not be evicted
    const b = await pm.getOrSpawn('b');
    b.lastUsedTs = 500;
    await pm.getOrSpawn('c'); // should evict b (the only idle one)
    assert.ok(pm.has('a'));
    assert.ok(!pm.has('b'));
    assert.ok(pm.has('c'));
  });

  test('lastUsedTs refreshed on each getOrSpawn hit', async () => {
    const a = await pm.getOrSpawn('a');
    const t0 = a.lastUsedTs;
    await new Promise(r => setTimeout(r, 5));
    const a2 = await pm.getOrSpawn('a');
    assert.ok(a2.lastUsedTs >= t0, 'lastUsedTs should advance on hit');
  });
});

describe('ProcessManager stream-json handling', () => {
  let pm;

  beforeEach(() => {
    pm = new ProcessManager({
      cap: 4,
      killTimeoutMs: 50,
      logger: { error: () => {}, log: () => {} },
      spawnFn: () => makeFakeProc(),
    });
  });

  afterEach(async () => { await pm.shutdown(); });

  test('init event sets sessionId on entry', async () => {
    const entry = await pm.getOrSpawn('a');
    entry.proc.emitEvent({ type: 'system', subtype: 'init', session_id: 'abc-123' });
    await new Promise(r => setImmediate(r));
    assert.equal(entry.sessionId, 'abc-123');
  });

  test('send → result event resolves promise', async () => {
    const entry = await pm.getOrSpawn('a');
    const p = pm.send('a', 'hello');
    // echo: verify stdin got the JSON-encoded user message
    const writes = [];
    entry.proc.stdin.on('data', (chunk) => writes.push(chunk.toString()));
    await new Promise(r => setImmediate(r));
    entry.proc.emitEvent({ type: 'result', subtype: 'success', result: 'hi back', session_id: 'abc', total_cost_usd: 0.001, duration_ms: 100 });
    const res = await p;
    assert.equal(res.text, 'hi back');
    assert.equal(res.sessionId, 'abc');
    assert.equal(res.error, null);
    assert.equal(entry.inFlight, false);
  });

  test('send → process exits → rejects', async () => {
    const entry = await pm.getOrSpawn('a');
    const p = pm.send('a', 'hello');
    entry.proc.emit('close', 1);
    await assert.rejects(() => p, /Process exited/);
  });

  test('send to missing session rejects', async () => {
    await assert.rejects(() => pm.send('nope', 'x'), /No process/);
  });

  test('send to destroyed stdin rejects cleanly (no EPIPE)', async () => {
    const entry = await pm.getOrSpawn('a');
    entry.proc.stdin.destroy();
    await assert.rejects(() => pm.send('a', 'x'), /stdin not writable/);
    assert.equal(entry.inFlight, false);
  });

  test('send while busy rejects', async () => {
    const entry = await pm.getOrSpawn('a');
    pm.send('a', 'first'); // pending, no resolution
    await assert.rejects(() => pm.send('a', 'second'), /busy/);
    // clean up
    entry.proc.emitEvent({ type: 'result', subtype: 'success', result: 'x' });
  });

  test('send timeout rejects + clears inFlight', async () => {
    await pm.getOrSpawn('a');
    const p = pm.send('a', 'hi', { timeoutMs: 30 });
    await assert.rejects(() => p, /Timeout/);
    const e = pm.get('a');
    assert.equal(e.inFlight, false);
    assert.equal(e.pending, null);
  });

  test('result with error subtype surfaces error', async () => {
    const entry = await pm.getOrSpawn('a');
    const p = pm.send('a', 'hi');
    entry.proc.emitEvent({ type: 'result', subtype: 'max_turns', error: 'hit limit' });
    const res = await p;
    assert.equal(res.error, 'hit limit');
  });
});

describe('ProcessManager resume-fail', () => {
  test('non-zero exit + existing session → clearSessionId called', async () => {
    const db = mockDb();
    const pm = new ProcessManager({
      cap: 2,
      killTimeoutMs: 50,
      db,
      logger: { error: () => {}, log: () => {} },
      spawnFn: () => makeFakeProc(),
    });
    const e = await pm.getOrSpawn('a', { existingSessionId: 'stale-session' });
    e.proc.emit('close', 1);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(db.cleared, ['a']);
    assert.ok(db.events.find((ev) => ev.kind === 'resume-fail'));
  });

  test('clean exit → no clearSessionId', async () => {
    const db = mockDb();
    const pm = new ProcessManager({
      cap: 2,
      db,
      logger: { error: () => {}, log: () => {} },
      spawnFn: () => makeFakeProc(),
    });
    const e = await pm.getOrSpawn('a', { existingSessionId: 'good-session' });
    e.proc.emit('close', 0);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(db.cleared, []);
  });

  test('fresh spawn (no existing session) → never clears', async () => {
    const db = mockDb();
    const pm = new ProcessManager({
      cap: 2,
      db,
      logger: { error: () => {}, log: () => {} },
      spawnFn: () => makeFakeProc(),
    });
    const e = await pm.getOrSpawn('a', {});
    e.proc.emit('close', 1);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(db.cleared, []);
  });
});

describe('ProcessManager construction', () => {
  test('throws when spawnFn missing', () => {
    assert.throws(() => new ProcessManager({}), /spawnFn required/);
  });
});

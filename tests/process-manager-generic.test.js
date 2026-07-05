'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ProcessManager } = require('@shumkov/orchestra');
const { Process, UnsupportedOperationError } = require('@shumkov/orchestra');

// ── Mock Process ─────────────────────────────────────────────────────

class MockProcess extends Process {
  constructor(opts, mockOpts = {}) {
    super(opts);
    this.backend = mockOpts.backend || 'mock';
    this._cost = mockOpts.cost ?? 1;
    this._startSpy = [];
    this._killSpy = [];
    this._sendSpy = [];
    this._sendResult = mockOpts.sendResult ?? { text: 'mock reply', sessionId: null, cost: 0, duration: 0, error: null, metrics: {} };
    this._failStart = mockOpts.failStart;
    this._supports = new Set(mockOpts.supports || ['interrupt', 'setModel', 'applyFlagSettings', 'resetSession']);
  }
  get cost() { return this._cost; }
  async start(opts) {
    this._startSpy.push(opts);
    if (this._failStart) throw this._failStart;
  }
  async send(prompt, opts) {
    this.inFlight = true;
    this._sendSpy.push({ prompt, opts });
    this.inFlight = false;
    return this._sendResult;
  }
  async kill(reason) {
    this._killSpy.push(reason);
    this.closed = true;
    this.emit('close', { reason });
  }
  async interrupt() {
    if (!this._supports.has('interrupt')) throw new UnsupportedOperationError('interrupt', this.backend);
    return true;
  }
  async setModel(model) {
    if (!this._supports.has('setModel')) throw new UnsupportedOperationError('setModel', this.backend);
    return true;
  }
  async applyFlagSettings(s) {
    if (!this._supports.has('applyFlagSettings')) throw new UnsupportedOperationError('applyFlagSettings', this.backend);
    return true;
  }
  async resetSession(opts) {
    if (!this._supports.has('resetSession')) throw new UnsupportedOperationError('resetSession', this.backend);
    return { closed: true, drainedPendings: 0 };
  }
  drainQueue(code) {
    const n = this.pendingQueue.length;
    this.pendingQueue.length = 0;
    return n;
  }
  injectUserMessage(opts) {
    return this.inFlight;
  }
  emitInit() { this.emit('init', { sessionId: 'sess-1' }); }
  emitClose() { this.emit('close', { reason: 'test' }); }
  emitResult(payload) { this.emit('result', payload); }
}

function mockFactory(opts = {}) {
  return (sessionKey, ctx) => new MockProcess({ sessionKey, chatId: ctx?.chatId, threadId: ctx?.threadId }, opts);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ProcessManager — construction', () => {
  test('requires processFactory', () => {
    assert.throws(() => new ProcessManager({}), /processFactory/);
  });
  test('default budget = 10', () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    assert.equal(pm.budget, 10);
  });
});

describe('ProcessManager — introspection', () => {
  let pm;
  beforeEach(() => { pm = new ProcessManager({ processFactory: mockFactory() }); });

  test('has/get/keys/size on empty pm', () => {
    assert.equal(pm.has('sk'), false);
    assert.equal(pm.get('sk'), null);
    assert.deepEqual(pm.keys(), []);
    assert.equal(pm.size, 0);
  });

  test('after getOrSpawn', async () => {
    await pm.getOrSpawn('sk', { chatId: 1 });
    assert.equal(pm.has('sk'), true);
    assert.ok(pm.get('sk'));
    assert.deepEqual(pm.keys(), ['sk']);
    assert.equal(pm.size, 1);
  });
});

describe('ProcessManager — getOrSpawn', () => {
  test('factory called once per fresh sessionKey', async () => {
    let calls = 0;
    const pm = new ProcessManager({
      processFactory: (sk, ctx) => { calls++; return new MockProcess({ sessionKey: sk }); },
    });
    await pm.getOrSpawn('sk1');
    await pm.getOrSpawn('sk1');  // cache hit
    assert.equal(calls, 1);
  });

  test('returns same instance on cache hit', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    const p1 = await pm.getOrSpawn('sk');
    const p2 = await pm.getOrSpawn('sk');
    assert.equal(p1, p2);
  });

  test('calls start() with spawn context', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk', { chatId: 100, model: 'sonnet' });
    const p = pm.get('sk');
    assert.deepEqual(p._startSpy[0], { chatId: 100, model: 'sonnet' });
  });

  test('start() failure does NOT add to procs map', async () => {
    const failFactory = (sk, ctx) => new MockProcess({ sessionKey: sk }, { failStart: new Error('boom') });
    const pm = new ProcessManager({ processFactory: failFactory });
    await assert.rejects(() => pm.getOrSpawn('sk'), /boom/);
    assert.equal(pm.has('sk'), false);
  });
});

describe('ProcessManager — getOrSpawn concurrent spawn (production 2026-05-16)', () => {
  // Production bug, shumorobot 2026-05-16 09:24: Ivan sent three
  // messages ~2s apart on a freshly-spawned tmux session. getOrSpawn
  // registers the proc in this.procs BEFORE awaiting start(); a
  // second message arriving during the ~11s spawn got the
  // still-spawning proc and called send() on it — pasting a turn
  // into a TUI that was not ready. The paste was silently dropped,
  // and the turn returned empty → "No response generated. Please
  // try again." The JSONL recorded only the first message's turn.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test('second getOrSpawn during an in-flight spawn waits for start() to complete', async () => {
    let releaseStart;
    const startGate = new Promise((r) => { releaseStart = r; });
    let startCompleted = false;

    class SlowStartProc extends MockProcess {
      async start(opts) {
        this._startSpy.push(opts);
        await startGate;
        startCompleted = true;
      }
    }
    const pm = new ProcessManager({
      processFactory: (sk) => new SlowStartProc({ sessionKey: sk }),
    });

    const call1 = pm.getOrSpawn('sk');   // triggers the spawn
    const call2 = pm.getOrSpawn('sk');   // arrives DURING the spawn

    let call2Resolved = false;
    call2.then(() => { call2Resolved = true; }, () => {});

    // Let microtasks + timers settle. On the buggy code call2
    // returns `existing` immediately; on the fix it awaits start().
    await sleep(20);
    assert.equal(call2Resolved, false,
      'getOrSpawn during an in-flight spawn must NOT resolve before start() completes');

    releaseStart();
    const [p1, p2] = await Promise.all([call1, call2]);
    assert.equal(p1, p2, 'both callers receive the same proc');
    assert.equal(startCompleted, true,
      'start() must have completed before getOrSpawn returned the proc');
  });

  test('start() is called exactly once under concurrent getOrSpawn', async () => {
    let releaseStart;
    const startGate = new Promise((r) => { releaseStart = r; });
    let startCalls = 0;

    class SlowStartProc extends MockProcess {
      async start(opts) {
        startCalls += 1;
        this._startSpy.push(opts);
        await startGate;
      }
    }
    let factoryCalls = 0;
    const pm = new ProcessManager({
      processFactory: (sk) => { factoryCalls += 1; return new SlowStartProc({ sessionKey: sk }); },
    });

    const calls = [
      pm.getOrSpawn('sk'),
      pm.getOrSpawn('sk'),
      pm.getOrSpawn('sk'),
    ];
    await sleep(20);
    releaseStart();
    await Promise.all(calls);

    assert.equal(factoryCalls, 1, 'factory called once for the same sessionKey');
    assert.equal(startCalls, 1, 'start() called once for the same sessionKey');
  });
});

describe('ProcessManager — weighted LRU eviction', () => {
  test('SDK cost=1, default budget=10 → 10 fit', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }) });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    assert.equal(pm.size, 10);
    assert.equal(pm.totalCost, 10);
  });

  test('11th SDK Process triggers eviction', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }) });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    // 11th — should evict oldest (sk0)
    await pm.getOrSpawn('sk10');
    assert.equal(pm.size, 10);
    assert.equal(pm.has('sk0'), false);
    assert.equal(pm.has('sk10'), true);
  });

  test('tmux cost=3 → 3 fit, 4th evicts', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 3 }) });
    for (let i = 0; i < 3; i++) await pm.getOrSpawn('sk' + i);
    assert.equal(pm.totalCost, 9);
    await pm.getOrSpawn('sk3');   // would push to 12 > 10
    assert.equal(pm.size, 3);
    assert.equal(pm.has('sk0'), false);
  });

  test('mixed: 7 SDK + 1 tmux = 10 (full)', async () => {
    let n = 0;
    const pm = new ProcessManager({
      processFactory: (sk, ctx) => {
        const cost = n++ < 7 ? 1 : 3;
        return new MockProcess({ sessionKey: sk }, { cost });
      },
    });
    for (let i = 0; i < 8; i++) await pm.getOrSpawn('sk' + i);
    assert.equal(pm.totalCost, 7 * 1 + 1 * 3);
    assert.equal(pm.size, 8);
  });

  test('inFlight processes are NOT evicted', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }) });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    // Mark sk0 inFlight
    pm.get('sk0').inFlight = true;
    // sk1 should evict (next oldest, not inFlight)
    await pm.getOrSpawn('sk10');
    assert.equal(pm.has('sk0'), true);
    assert.equal(pm.has('sk1'), false);
  });

  test('all-inFlight pm parks new spawn until slot frees', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }), lruWaitMs: 200 });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    for (const p of pm.procs.values()) p.inFlight = true;
    const spawnP = pm.getOrSpawn('skNew');
    // Free a slot
    setTimeout(() => { pm.get('sk0').inFlight = false; pm._maybeSignalLruWaiter(); }, 30);
    await spawnP;
    assert.equal(pm.has('skNew'), true);
  });
});

describe('ProcessManager — eviction-pin for live background work (Policy C)', () => {
  // A Process reports active detached background work (the cli `_bgWorkSince` signal).
  const pin = (p) => { p.hasActiveBackgroundWork = () => true; };

  test('_evictLRU skips a pinned session and evicts the next-oldest UNpinned one', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }) });
    for (let i = 0; i < 10; i++) await pm.getOrSpawn('sk' + i);
    pin(pm.get('sk0'));                       // oldest — but holds a live background job
    await pm.getOrSpawn('sk10');              // budget full → must evict
    assert.equal(pm.has('sk0'), true, 'pinned oldest survives');
    assert.equal(pm.has('sk1'), false, 'next-oldest unpinned evicted instead');
    assert.equal(pm.has('sk10'), true);
    assert.equal(pm.size, 10, 'still at budget — evicted, not overflowed');
  });

  test('the UNpinned session is evicted even when the pinned one is OLDER', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }), budget: 2 });
    await pm.getOrSpawn('old');
    await pm.getOrSpawn('young');
    pin(pm.get('old'));
    await pm.getOrSpawn('new');
    assert.equal(pm.has('old'), true, 'older pinned survives');
    assert.equal(pm.has('young'), false, 'younger unpinned evicted');
    assert.equal(pm.has('new'), true);
  });

  test('Policy C: all free slots pinned → spawns OVER budget, emits lru-overflow-pinned, no job killed', async () => {
    const events = [];
    const pm = new ProcessManager({
      processFactory: mockFactory({ cost: 1 }), budget: 2,
      db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
    });
    await pm.getOrSpawn('bg0'); await pm.getOrSpawn('bg1');
    pin(pm.get('bg0')); pin(pm.get('bg1'));   // every free slot holds a live job
    await pm.getOrSpawn('fresh');             // can't evict a job → soft overflow
    assert.equal(pm.has('bg0'), true);
    assert.equal(pm.has('bg1'), true, 'no background job killed');
    assert.equal(pm.has('fresh'), true, 'the new chat is not blocked');
    assert.equal(pm.size, 3);
    assert.equal(pm.totalCost, 3, 'spawned over the budget of 2 (soft overflow)');
    const ov = events.find((e) => e.kind === 'lru-overflow-pinned');
    assert.ok(ov, 'lru-overflow-pinned emitted');
    assert.deepEqual(ov.detail.pinned.sort(), ['bg0', 'bg1'], 'names the pinned sessions so the operator can /reset one');
  });

  test('park-split: all blockers inFlight (NO pin) → parks (times out), does NOT overflow', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }), budget: 2, lruWaitMs: 80 });
    await pm.getOrSpawn('sk0'); await pm.getOrSpawn('sk1');
    pm.get('sk0').inFlight = true; pm.get('sk1').inFlight = true;   // transient blockers, no bg work
    await assert.rejects(pm.getOrSpawn('sk2'), /lru wait timed out/);
    assert.equal(pm.size, 2, 'parked for a slot — did NOT overflow the budget');
  });

  test('end-to-end: over budget with one pinned + one unpinned evicts the unpinned, keeps the background job', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ cost: 1 }), budget: 2 });
    await pm.getOrSpawn('job');                // the long background job (older)
    await pm.getOrSpawn('idle');               // a plain idle chat (younger)
    pin(pm.get('job'));
    await pm.getOrSpawn('new');
    assert.equal(pm.has('job'), true, 'background-job session survives eviction');
    assert.equal(pm.has('idle'), false, 'idle session evicted instead');
    assert.equal(pm.size, 2, 'evicted (not overflowed) — a free unpinned slot existed');
  });
});

describe('ProcessManager — kill / killChat / shutdown', () => {
  test('kill removes from map + calls Process.kill', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk', { chatId: 100 });
    const p = pm.get('sk');
    await pm.kill('sk', 'test');
    assert.equal(pm.has('sk'), false);
    assert.deepEqual(p._killSpy, ['test']);
  });

  test('killChat kills all processes for chat', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('100:main', { chatId: 100 });
    await pm.getOrSpawn('100:t5', { chatId: 100, threadId: 5 });
    await pm.getOrSpawn('200:main', { chatId: 200 });
    await pm.killChat(100);
    assert.equal(pm.has('100:main'), false);
    assert.equal(pm.has('100:t5'), false);
    assert.equal(pm.has('200:main'), true);
  });

  test('shutdown closes all + rejects future getOrSpawn', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk1');
    await pm.getOrSpawn('sk2');
    await pm.shutdown();
    assert.equal(pm.size, 0);
    await assert.rejects(() => pm.getOrSpawn('sk3'), /shutdown/);
  });
});

describe('ProcessManager — optional method delegation', () => {
  test('interrupt returns true when supported', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ supports: ['interrupt'] }) });
    await pm.getOrSpawn('sk');
    assert.equal(await pm.interrupt('sk'), true);
  });

  test('interrupt returns false when not supported (no throw)', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ supports: [] }) });
    await pm.getOrSpawn('sk');
    assert.equal(await pm.interrupt('sk'), false);
  });

  test('setModel + applyFlagSettings return true when supported', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk');
    assert.equal(await pm.setModel('sk', 'opus'), true);
    assert.equal(await pm.applyFlagSettings('sk', { effortLevel: 'high' }), true);
  });

  test('resetSession unsupported → fallback drainQueue + kill', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory({ supports: [] }) });
    await pm.getOrSpawn('sk');
    const res = await pm.resetSession('sk');
    assert.equal(res.closed, true);
    assert.equal(pm.has('sk'), false);
  });
});

describe('ProcessManager — hot-path methods never throw (R1-F1)', () => {
  test('drainQueue returns 0 for unknown sessionKey', () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    assert.equal(pm.drainQueue('unknown'), 0);
  });

  test('injectUserMessage returns false for closed process', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk');
    pm.get('sk').closed = true;
    assert.equal(pm.injectUserMessage('sk', { content: 'x' }), false);
  });

  test('steer returns false when no in-flight', async () => {
    const pm = new ProcessManager({ processFactory: mockFactory() });
    await pm.getOrSpawn('sk');
    assert.equal(pm.steer('sk', 'x'), false);
  });
});

describe('ProcessManager — callback forwarding', () => {
  test('onInit gets sessionKey + event payload + process', async () => {
    const calls = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: { onInit: (sk, payload, proc) => calls.push({ sk, payload, label: proc.label }) },
    });
    await pm.getOrSpawn('sk1', { chatId: 100 });
    pm.get('sk1').emitInit();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sk, 'sk1');
    assert.deepEqual(calls[0].payload, { sessionId: 'sess-1' });
  });

  test('onResult forwarded', async () => {
    const calls = [];
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: { onResult: (sk, r) => calls.push({ sk, r }) },
    });
    await pm.getOrSpawn('sk1');
    pm.get('sk1').emitResult({ text: 'ok' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].r, { text: 'ok' });
  });

  test('callback throwing does not crash event emission', async () => {
    const pm = new ProcessManager({
      processFactory: mockFactory(),
      callbacks: { onInit: () => { throw new Error('bad cb'); } },
      logger: { error: () => {} },
    });
    await pm.getOrSpawn('sk1');
    // Should not throw
    pm.get('sk1').emitInit();
  });
});

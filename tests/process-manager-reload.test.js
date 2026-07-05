'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ProcessManager } = require('@shumkov/orchestra');
const { Process } = require('@shumkov/orchestra');

// Minimal cli-like proc whose wouldReloadFor mirrors the real one: reload when
// the spawnContext's resolved model differs from this proc's spawn-time model.
class ReloadMock extends Process {
  constructor(opts, mockOpts = {}) {
    super(opts);
    this.backend = 'cli';
    this._cost = 1;
    this.model = mockOpts.model;
    this.effort = mockOpts.effort;
    this.killSpy = [];
    if (mockOpts.hasReload !== false) {
      this.wouldReloadFor = (ctx) => {
        if (this.inFlight || this.closed) return false;
        const wantModel = ctx?.chatConfig?.model || this.model;
        const wantEffort = ctx?.chatConfig?.effort || this.effort;
        return wantModel !== this.model || wantEffort !== this.effort;
      };
    }
  }
  get cost() { return this._cost; }
  async start() {}
  async kill(reason) { this.killSpy.push(reason); this.closed = true; this.emit('close', { reason }); }
  async send() { return {}; }
}

function factory(mockOpts = {}) {
  const created = [];
  const f = (sk, ctx) => {
    const p = new ReloadMock({ sessionKey: sk, chatId: ctx?.chatId }, {
      ...mockOpts,
      model: ctx?.chatConfig?.model ?? mockOpts.model ?? 'sonnet',
      effort: ctx?.chatConfig?.effort ?? mockOpts.effort,
    });
    created.push(p);
    return p;
  };
  f.created = created;
  return f;
}

describe('ProcessManager.getOrSpawn — reload-on-drift (cli model/effort)', () => {
  test('matched config → reuse the warm proc (no kill, no respawn)', async () => {
    const f = factory();
    const pm = new ProcessManager({ processFactory: f });
    const a = await pm.getOrSpawn('sk', { chatConfig: { model: 'sonnet' } });
    const a2 = await pm.getOrSpawn('sk', { chatConfig: { model: 'sonnet' } });
    assert.equal(a2, a, 'reused');
    assert.equal(f.created.length, 1, 'factory called once');
    assert.deepEqual(a.killSpy, [], 'not killed');
  });

  test('drifted model → kill + cold-respawn (the new proc carries the new model)', async () => {
    const f = factory();
    const pm = new ProcessManager({ processFactory: f });
    const a = await pm.getOrSpawn('sk', { chatConfig: { model: 'sonnet' } });
    const b = await pm.getOrSpawn('sk', { chatConfig: { model: 'opus' } });
    assert.notEqual(b, a, 'a NEW proc');
    assert.equal(f.created.length, 2, 'factory called again');
    assert.deepEqual(a.killSpy, ['config-reload'], 'old proc reloaded');
    assert.equal(b.model, 'opus', 'respawn uses the new model');
    assert.equal(pm.get('sk'), b, 'pm now holds the reloaded proc');
  });

  test('drifted effort → reload too', async () => {
    const f = factory();
    const pm = new ProcessManager({ processFactory: f });
    const a = await pm.getOrSpawn('sk', { chatConfig: { model: 'sonnet', effort: 'high' } });
    const b = await pm.getOrSpawn('sk', { chatConfig: { model: 'sonnet', effort: 'max' } });
    assert.notEqual(b, a);
    assert.deepEqual(a.killSpy, ['config-reload']);
    assert.equal(b.effort, 'max');
  });

  test('in-flight → no reload even on drift (fold; reload defers to next idle dispatch)', async () => {
    const f = factory();
    const pm = new ProcessManager({ processFactory: f });
    const a = await pm.getOrSpawn('sk', { chatConfig: { model: 'sonnet' } });
    a.inFlight = true;
    const a2 = await pm.getOrSpawn('sk', { chatConfig: { model: 'opus' } });
    assert.equal(a2, a, 'reused mid-turn');
    assert.deepEqual(a.killSpy, [], 'not killed mid-turn');
  });

  test('SDK parity: a proc without wouldReloadFor is reused even on drift', async () => {
    const f = factory({ hasReload: false });
    const pm = new ProcessManager({ processFactory: f });
    const a = await pm.getOrSpawn('sk', { chatConfig: { model: 'sonnet' } });
    const a2 = await pm.getOrSpawn('sk', { chatConfig: { model: 'opus' } });
    assert.equal(a2, a, 'SDK applies model live → no reload');
    assert.equal(f.created.length, 1);
  });
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  Process, UnsupportedOperationError,
} = require('../lib/process/process');

describe('Process — abstract base', () => {
  test('constructor requires sessionKey', () => {
    assert.throws(() => new Process({}), /sessionKey/);
    assert.throws(() => new Process({ sessionKey: '' }), /sessionKey/);
    assert.throws(() => new Process({ sessionKey: 42 }), /sessionKey/);
  });

  test('identity fields set + immutable-after-ctor', () => {
    const p = new Process({ sessionKey: 'sk', chatId: 100, threadId: 5, label: 'X' });
    assert.equal(p.sessionKey, 'sk');
    assert.equal(p.chatId, '100');
    assert.equal(p.threadId, '5');
    assert.equal(p.label, 'X');
    assert.equal(p.backend, 'abstract');
  });

  test('label fallback when not provided', () => {
    const p = new Process({ sessionKey: 'sk', chatId: 100, threadId: 5 });
    assert.equal(p.label, '100/5');
  });

  test('label fallback when threadId is null', () => {
    const p = new Process({ sessionKey: 'sk', chatId: 100 });
    assert.equal(p.label, '100');
  });

  test('label fallback to sessionKey when chatId+threadId both null', () => {
    const p = new Process({ sessionKey: 'sk' });
    assert.equal(p.label, 'sk');
  });

  test('initial state', () => {
    const p = new Process({ sessionKey: 'sk' });
    assert.equal(p.closed, false);
    assert.equal(p.inFlight, false);
    assert.deepEqual(p.pendingQueue, []);
    assert.equal(p.claudeSessionId, null);
  });

  test('default cost is 1', () => {
    const p = new Process({ sessionKey: 'sk' });
    assert.equal(p.cost, 1);
  });
});

describe('Process — REQUIRED methods throw if not overridden', () => {
  test('start() throws', async () => {
    const p = new Process({ sessionKey: 'sk' });
    await assert.rejects(() => p.start(), /start.*must be overridden/);
  });
  test('send() throws', async () => {
    const p = new Process({ sessionKey: 'sk' });
    await assert.rejects(() => p.send('hi'), /send.*must be overridden/);
  });
  test('kill() throws', async () => {
    const p = new Process({ sessionKey: 'sk' });
    await assert.rejects(() => p.kill(), /kill.*must be overridden/);
  });
});

describe('Process — OPTIONAL async methods throw UnsupportedOperationError', () => {
  const methods = [
    'interrupt', 'setModel', 'applyFlagSettings',
    'setPermissionMode', 'resetSession', 'getContextUsage',
  ];
  for (const m of methods) {
    test(`${m}() throws UnsupportedOperationError`, async () => {
      const p = new Process({ sessionKey: 'sk' });
      try {
        await p[m]('arg');
        assert.fail(`${m} should have thrown`);
      } catch (err) {
        assert.equal(err.code, 'UNSUPPORTED_OPERATION');
        assert.equal(err.method, m);
        assert.equal(err.backend, 'abstract');
      }
    });
  }
});

describe('Process — OPTIONAL sync hot-path methods return sentinels (R1-F1)', () => {
  test('drainQueue() returns 0, does not throw', () => {
    const p = new Process({ sessionKey: 'sk' });
    assert.equal(p.drainQueue(), 0);
    assert.equal(p.drainQueue('CUSTOM_CODE'), 0);
  });
  test('injectUserMessage() returns false, does not throw', () => {
    const p = new Process({ sessionKey: 'sk' });
    assert.equal(p.injectUserMessage({ content: 'x' }), false);
  });
  test('steer() returns false, does not throw', () => {
    const p = new Process({ sessionKey: 'sk' });
    assert.equal(p.steer('x', {}), false);
  });
});

describe('Process — EventEmitter behavior', () => {
  test('on + emit work', () => {
    const p = new Process({ sessionKey: 'sk' });
    const events = [];
    p.on('test', (data) => events.push(data));
    p.emit('test', { foo: 'bar' });
    p.emit('test', { baz: 'qux' });
    assert.deepEqual(events, [{ foo: 'bar' }, { baz: 'qux' }]);
  });

  test('off removes listener', () => {
    const p = new Process({ sessionKey: 'sk' });
    const events = [];
    const handler = (d) => events.push(d);
    p.on('test', handler);
    p.emit('test', 1);
    p.off('test', handler);
    p.emit('test', 2);
    assert.deepEqual(events, [1]);
  });
});

describe('UnsupportedOperationError', () => {
  test('shape', () => {
    const err = new UnsupportedOperationError('foo', 'tmux');
    assert.equal(err.name, 'UnsupportedOperationError');
    assert.equal(err.code, 'UNSUPPORTED_OPERATION');
    assert.equal(err.method, 'foo');
    assert.equal(err.backend, 'tmux');
    assert.match(err.message, /foo.*not supported.*tmux/);
  });
});


describe('Process — subclass override sets backend', () => {
  class TestBackend extends Process {
    constructor(opts) { super(opts); this.backend = 'test'; }
    get cost() { return 5; }
  }
  test('backend overridden', () => {
    const p = new TestBackend({ sessionKey: 'sk' });
    assert.equal(p.backend, 'test');
  });
  test('cost overridden', () => {
    const p = new TestBackend({ sessionKey: 'sk' });
    assert.equal(p.cost, 5);
  });
  test('UnsupportedOperationError reports subclass backend', async () => {
    const p = new TestBackend({ sessionKey: 'sk' });
    try { await p.interrupt(); assert.fail('should throw'); }
    catch (err) { assert.equal(err.backend, 'test'); }
  });
});

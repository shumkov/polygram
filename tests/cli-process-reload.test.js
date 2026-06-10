'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { CliProcess } = require('../lib/process/cli-process');

const fakeRunner = {
  spawn: async () => {}, killSession: async () => {}, sendControl: async () => {},
  captureWide: async () => 'Listening for channel messages from: server:polygram-bridge',
};
const fakeDispatcher = async () => ({ ok: true });

function mk() {
  return new CliProcess({
    sessionKey: 'k', chatId: '1', threadId: null, tmuxRunner: fakeRunner,
    botName: 'b', toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
}

describe('CliProcess._resolveModel / _resolveEffort (topic→chat→fallback precedence)', () => {
  test('chat-level', () => {
    const p = mk();
    assert.equal(p._resolveModel({ chatConfig: { model: 'opus' } }), 'opus');
    assert.equal(p._resolveEffort({ chatConfig: { effort: 'max' } }), 'max');
  });
  test('topic override wins over chat', () => {
    const p = mk();
    assert.equal(p._resolveModel({ threadId: '3', chatConfig: { model: 'sonnet', topics: { '3': { model: 'haiku' } } } }), 'haiku');
    assert.equal(p._resolveEffort({ threadId: '3', chatConfig: { effort: 'low', topics: { '3': { effort: 'high' } } } }), 'high');
  });
  test('falls back to opts when no chat/topic value', () => {
    const p = mk();
    assert.equal(p._resolveModel({ chatConfig: {}, model: 'sonnet' }), 'sonnet');
  });
});

describe('CliProcess.wouldReloadFor', () => {
  test('model drift → true', () => {
    const p = mk(); p.model = 'sonnet'; p.effort = 'high';
    assert.equal(p.wouldReloadFor({ chatConfig: { model: 'opus', effort: 'high' } }), true);
  });
  test('effort drift → true', () => {
    const p = mk(); p.model = 'sonnet'; p.effort = 'high';
    assert.equal(p.wouldReloadFor({ chatConfig: { model: 'sonnet', effort: 'max' } }), true);
  });
  test('matched model+effort → false (no needless reload)', () => {
    const p = mk(); p.model = 'sonnet'; p.effort = 'high';
    assert.equal(p.wouldReloadFor({ chatConfig: { model: 'sonnet', effort: 'high' } }), false);
  });
  test('in-flight → false (fold into the running turn; reload on next idle dispatch)', () => {
    const p = mk(); p.model = 'sonnet'; p.effort = 'high'; p.inFlight = true;
    assert.equal(p.wouldReloadFor({ chatConfig: { model: 'opus', effort: 'high' } }), false);
  });
  test('closed → false', () => {
    const p = mk(); p.model = 'sonnet'; p.effort = 'high'; p.closed = true;
    assert.equal(p.wouldReloadFor({ chatConfig: { model: 'opus' } }), false);
  });
  test('topic override drift → true; topic override matching spawn → false', () => {
    const p = mk(); p.model = 'sonnet'; p.effort = 'high';
    assert.equal(p.wouldReloadFor({ threadId: '3', chatConfig: { model: 'sonnet', effort: 'high', topics: { '3': { model: 'opus' } } } }), true);
    const q = mk(); q.model = 'opus'; q.effort = 'high';
    assert.equal(q.wouldReloadFor({ threadId: '3', chatConfig: { model: 'sonnet', effort: 'high', topics: { '3': { model: 'opus' } } } }), false);
  });
});

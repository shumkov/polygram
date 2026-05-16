'use strict';

// TmuxProcess.start() verifies the pinned claude binary exists
// (lib/claude-bin.js); the real binary isn't present in CI. Point
// the override at the node executable — always present. The fake
// runner never actually execs it.
if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createProcessFactory, pickBackend } = require('../lib/process/factory');
const { SdkProcess } = require('../lib/process/sdk-process');
const { TmuxProcess } = require('../lib/process/tmux-process');

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

function makeFakeRunner() {
  return {
    spawn: async () => {},
    sendControl: async () => {},
    pasteText: async () => ({ sanitized: '', oneLine: '', stripped: 0 }),
    captureWide: async () => '',
    capturePane: async () => '',
    sessionExists: async () => true,
    killSession: async () => {},
    listPolygramSessions: async () => [],
    setPaneReadOnly: async () => {},
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };
}

// ─── pickBackend ────────────────────────────────────────────────────

describe('pickBackend', () => {
  test('returns "sdk" when no chatId', () => {
    assert.equal(pickBackend({ config: {} }), 'sdk');
  });
  test('returns "sdk" by default', () => {
    assert.equal(pickBackend({ config: { chats: { 100: {} } }, chatId: '100' }), 'sdk');
  });
  test('chatConfig.pm overrides default', () => {
    assert.equal(
      pickBackend({ config: { chats: { 100: { pm: 'tmux' } } }, chatId: '100' }),
      'tmux',
    );
  });
  test('topicConfig.pm overrides chatConfig.pm', () => {
    const config = {
      chats: { 100: { pm: 'sdk', topics: { 5: { pm: 'tmux' } } } },
    };
    assert.equal(pickBackend({ config, chatId: '100', threadId: '5' }), 'tmux');
  });
  test('bot.pm acts as global default when chat has none', () => {
    const config = { bot: { pm: 'tmux' }, chats: { 100: {} } };
    assert.equal(pickBackend({ config, chatId: '100' }), 'tmux');
  });
});

// ─── createProcessFactory routing ───────────────────────────────────

describe('createProcessFactory routing', () => {
  test('default route returns SdkProcess', () => {
    const factory = createProcessFactory({
      config: { chats: { 100: {} } },
      spawnFn: () => ({}),
      logger: SILENT,
    });
    const p = factory('chat:100', { chatId: '100', threadId: null });
    assert.ok(p instanceof SdkProcess);
    assert.equal(p.backend, 'sdk');
    assert.equal(p.cost, 1);
  });

  test('pm:"tmux" chat returns TmuxProcess when runner+botName wired', () => {
    const factory = createProcessFactory({
      config: { chats: { 100: { pm: 'tmux' } } },
      spawnFn: () => ({}),
      tmuxRunner: makeFakeRunner(),
      botName: 'shumabit',
      logger: SILENT,
    });
    const p = factory('chat:100', { chatId: '100', threadId: null });
    assert.ok(p instanceof TmuxProcess);
    assert.equal(p.backend, 'tmux');
    assert.equal(p.cost, 3);
    assert.equal(p.botName, 'shumabit');
    assert.equal(p.tmuxName, 'polygram-shumabit-100-main');
  });

  test('pm:"tmux" falls back to Sdk + warns when runner missing', () => {
    let warned = null;
    const logger = { ...SILENT, warn: (m) => { warned = m; } };
    const factory = createProcessFactory({
      config: { chats: { 100: { pm: 'tmux' } } },
      spawnFn: () => ({}),
      logger,
      // tmuxRunner deliberately omitted
    });
    const p = factory('chat:100', { chatId: '100', threadId: null });
    assert.ok(p instanceof SdkProcess);
    assert.match(warned || '', /tmuxRunner\/botName not wired/);
  });

  test('pm:"tmux" falls back to Sdk + warns when botName missing', () => {
    let warned = null;
    const logger = { ...SILENT, warn: (m) => { warned = m; } };
    const factory = createProcessFactory({
      config: { chats: { 100: { pm: 'tmux' } } },
      spawnFn: () => ({}),
      tmuxRunner: makeFakeRunner(),
      // botName deliberately omitted
      logger,
    });
    const p = factory('chat:100', { chatId: '100', threadId: null });
    assert.ok(p instanceof SdkProcess);
    assert.match(warned || '', /tmuxRunner\/botName not wired/);
  });

  test('topic-level pm:"tmux" overrides chat-level pm:"sdk"', () => {
    const factory = createProcessFactory({
      config: { chats: { 100: { pm: 'sdk', topics: { 5: { pm: 'tmux' } } } } },
      spawnFn: () => ({}),
      tmuxRunner: makeFakeRunner(),
      botName: 'shumabit',
      logger: SILENT,
    });
    const pTopic = factory('chat:100:t5', { chatId: '100', threadId: '5' });
    assert.ok(pTopic instanceof TmuxProcess);
    const pBase = factory('chat:100', { chatId: '100', threadId: null });
    assert.ok(pBase instanceof SdkProcess);
  });

  test('createProcessFactory throws without spawnFn', () => {
    assert.throws(
      () => createProcessFactory({ config: {} }),
      /spawnFn required/,
    );
  });
});

'use strict';

// CliProcess.start() verifies the pinned claude binary exists
// (lib/claude-bin.js); the real binary isn't present in CI. Point
// the override at the node executable — always present. The fake
// runner never actually execs it.
if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const factory = require('@shumkov/orchestra');
const { createProcessFactory, pickBackend } = factory;
const { SdkProcess } = require('../lib/process/sdk-process');

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

// ─── pickBackend ────────────────────────────────────────────────────

describe('pickBackend', () => {
  test('returns "sdk" when no chatId', () => {
    assert.equal(pickBackend({ config: {} }), 'sdk');
  });
  test('returns "sdk" by default', () => {
    assert.equal(pickBackend({ config: { chats: { 100: {} } }, chatId: '100' }), 'sdk');
  });
  test('chatConfig.pm overrides default — pm:"cli" resolves directly', () => {
    factory._resetAliasWarnings?.();
    assert.equal(
      pickBackend({ config: { chats: { 100: { pm: 'cli' } } }, chatId: '100', logger: SILENT }),
      'cli',
    );
  });
  test('topicConfig.pm overrides chatConfig.pm', () => {
    factory._resetAliasWarnings?.();
    const config = {
      chats: { 100: { pm: 'sdk', topics: { 5: { pm: 'cli' } } } },
    };
    assert.equal(pickBackend({ config, chatId: '100', threadId: '5', logger: SILENT }), 'cli');
  });
  test('bot.pm acts as global default when chat has none', () => {
    factory._resetAliasWarnings?.();
    const config = { bot: { pm: 'cli' }, chats: { 100: {} } };
    assert.equal(pickBackend({ config, chatId: '100', logger: SILENT }), 'cli');
  });
  test('0.12 Phase 4 — pm:"tmux" resolves to "cli" via the alias map', () => {
    factory._resetAliasWarnings?.();
    assert.equal(
      pickBackend({ config: { chats: { 100: { pm: 'tmux' } } }, chatId: '100', logger: SILENT }),
      'cli',
    );
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

  // 0.12 Phase 4: TmuxProcess construction tests removed alongside the
  // deleted backend. CliProcess construction is covered by
  // tests/cli-process.test.js. Alias resolution from pm:"tmux"/"channels"
  // to pm:"cli" is covered above in the pickBackend describe block.

  test('createProcessFactory throws without spawnFn', () => {
    assert.throws(
      () => createProcessFactory({ config: {} }),
      /spawnFn required/,
    );
  });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateClaudeCliAuthSource,
  needsNativeClaudeAuth,
  hasNativeClaudeRuntime,
  assertExternalClaudeCliReady,
} = require('../lib/ops/claude-auth-health');

for (const value of [null, false, true, '', 'proxy', {}, ['external']]) {
  test(`invalid auth source ${JSON.stringify(value)} fails visibly`, () => {
    assert.throws(() => validateClaudeCliAuthSource({ claudeCliAuthSource: value }), /claudeCliAuthSource/);
  });
}

test('missing declaration preserves native checks even when a launcher exists', () => {
  assert.equal(needsNativeClaudeAuth({}, 'cli'), true);
  assert.equal(needsNativeClaudeAuth({ claudeCliAuthSource: 'native' }, 'cli'), true);
  assert.equal(needsNativeClaudeAuth({ claudeCliAuthSource: 'external' }, 'cli'), false);
  assert.equal(needsNativeClaudeAuth({ claudeCliAuthSource: 'external' }, 'sdk'), true);
  assert.equal(needsNativeClaudeAuth({}, 'codex'), false);
});

test('only canonical runtime decisions enter the auth policy', () => {
  assert.throws(() => needsNativeClaudeAuth({}, 'unknown'), /backend/);
});

test('monitor follows bot defaults, aliases, and mutable topic overrides', () => {
  const config = {
    bot: { pm: 'channels', claudeCliAuthSource: 'external' },
    chats: { '1': {}, '2': { pm: 'codex' } },
  };
  assert.equal(hasNativeClaudeRuntime(config), false);
  config.chats['1'].topics = { '3': { pm: 'sdk' } };
  assert.equal(hasNativeClaudeRuntime(config), true);
  config.chats['1'].topics['3'].pm = 'tmux';
  assert.equal(hasNativeClaudeRuntime(config), false);
  config.bot.claudeCliAuthSource = 'native';
  assert.equal(hasNativeClaudeRuntime(config), true);
});

test('SDK chat default remains monitored when its explicit topics are external CLI', () => {
  const config = { bot: { claudeCliAuthSource: 'external' }, chats: { '1': { topics: { '2': { pm: 'cli' } } } } };
  assert.equal(hasNativeClaudeRuntime(config), true);
});

test('external declaration requires CLI prerequisites even before a chat selects CLI', () => {
  const bot = { claudeCliAuthSource: 'external', pm: 'sdk' };
  assert.throws(() => assertExternalClaudeCliReady(bot, { sessionLauncher: '/launcher', pinnedClaudeBin: null }), /pinned Claude/);
  for (const sessionLauncher of [undefined, '', 'relative']) {
    assert.throws(() => assertExternalClaudeCliReady(bot, { sessionLauncher, pinnedClaudeBin: '/claude' }), /absolute session launcher/);
  }
  assert.doesNotThrow(() => assertExternalClaudeCliReady(bot, { sessionLauncher: '/launcher', pinnedClaudeBin: '/claude' }));
  assert.doesNotThrow(() => assertExternalClaudeCliReady({}, {}));
});

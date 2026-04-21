/**
 * Tests for lib/config-scope.js
 * Run: node --test tests/config-scope.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseBotArg, filterConfigToBot } = require('../lib/config-scope');

const fullConfig = {
  bots: {
    shumabit: { token: 'a', allowConfigCommands: true },
    'umi-assistant': { token: 'b' },
  },
  chats: {
    '111111111': { name: 'Ivan DM', bot: 'shumabit' },
    '-1000000000001': { name: 'UMI Group', bot: 'shumabit' },
    '-1000000000003': { name: 'TA Beauty Space', bot: 'umi-assistant' },
  },
  defaults: { model: 'sonnet', effort: 'low' },
  maxWarmProcesses: 10,
};

describe('parseBotArg', () => {
  test('returns null when --bot not in argv', () => {
    assert.equal(parseBotArg(['node', 'polygram.js']), null);
    assert.equal(parseBotArg([]), null);
  });

  test('returns bot name when --bot <name> present', () => {
    assert.equal(parseBotArg(['node', 'polygram.js', '--bot', 'shumabit']), 'shumabit');
    assert.equal(parseBotArg(['--bot', 'umi-assistant']), 'umi-assistant');
  });

  test('throws when --bot has no value', () => {
    assert.throws(() => parseBotArg(['node', 'polygram.js', '--bot']), /requires a bot name/);
  });

  test('throws when --bot followed by another flag', () => {
    assert.throws(() => parseBotArg(['--bot', '--other']), /requires a bot name/);
  });
});

describe('filterConfigToBot', () => {
  test('narrows bots to a single entry', () => {
    const scoped = filterConfigToBot(fullConfig, 'shumabit');
    assert.deepEqual(Object.keys(scoped.bots), ['shumabit']);
    assert.equal(scoped.bots.shumabit.token, 'a');
  });

  test('narrows chats to those owned by the bot', () => {
    const scoped = filterConfigToBot(fullConfig, 'shumabit');
    assert.deepEqual(Object.keys(scoped.chats).sort(), ['-1000000000001', '111111111']);
    for (const c of Object.values(scoped.chats)) {
      assert.equal(c.bot, 'shumabit');
    }
  });

  test('preserves defaults and other top-level keys', () => {
    const scoped = filterConfigToBot(fullConfig, 'umi-assistant');
    assert.deepEqual(scoped.defaults, fullConfig.defaults);
    assert.equal(scoped.maxWarmProcesses, 10);
  });

  test('does not mutate the input config', () => {
    const before = JSON.stringify(fullConfig);
    filterConfigToBot(fullConfig, 'shumabit');
    assert.equal(JSON.stringify(fullConfig), before);
  });

  test('throws when bot is unknown', () => {
    assert.throws(() => filterConfigToBot(fullConfig, 'ghost'), /not in config\.bots/);
  });

  test('throws when bot owns no chats', () => {
    const cfg = {
      bots: { orphan: { token: 'x' } },
      chats: { '1': { name: 'c', bot: 'shumabit' } },
    };
    assert.throws(() => filterConfigToBot(cfg, 'orphan'), /owns no chats/);
  });

  test('throws on malformed config', () => {
    assert.throws(() => filterConfigToBot(null, 'x'), /must have bots and chats/);
    assert.throws(() => filterConfigToBot({}, 'x'), /must have bots and chats/);
    assert.throws(() => filterConfigToBot({ bots: {} }, 'x'), /must have bots and chats/);
  });
});

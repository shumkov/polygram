'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ChannelsProcess } = require('../lib/process/channels-process');
const { createProcessFactory, pickBackend } = require('../lib/process/factory');

// Minimal fakes so we can construct without touching tmux / claude.
const fakeRunner = {
  spawnSession: async () => {},
  killSession: async () => {},
  sendKeys: async () => {},
};
const fakeDispatcher = async () => ({ ok: true });

test('ChannelsProcess construction — required params', () => {
  assert.throws(
    () => new ChannelsProcess({}),
    /sessionKey/,
    'sessionKey required',
  );

  assert.throws(
    () => new ChannelsProcess({ sessionKey: 'k', botName: 'b', toolDispatcher: fakeDispatcher }),
    /tmuxRunner required/,
  );

  assert.throws(
    () => new ChannelsProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, toolDispatcher: fakeDispatcher }),
    /botName required/,
  );

  assert.throws(
    () => new ChannelsProcess({ sessionKey: 'k', tmuxRunner: fakeRunner, botName: 'b' }),
    /toolDispatcher.*required/,
  );
});

test('ChannelsProcess construction — valid params', () => {
  const p = new ChannelsProcess({
    sessionKey: 'session-1',
    chatId: '12345',
    threadId: null,
    label: 'test-chat',
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    claudeBin: '/usr/bin/echo',
    toolDispatcher: fakeDispatcher,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  assert.equal(p.sessionKey, 'session-1');
  assert.equal(p.chatId, '12345');
  assert.equal(p.threadId, null);
  assert.equal(p.label, 'test-chat');
  assert.equal(p.backend, 'channels');
  assert.equal(p.cost, 3);
  assert.equal(p.closed, false);
  assert.equal(p.inFlight, false);
  assert.equal(p.bridgeReady, false);
});

test('ChannelsProcess.respondToPermission validates behavior arg', async () => {
  const p = new ChannelsProcess({
    sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => p.respondToPermission('abcde', 'maybe'),
    /'allow' or 'deny'/,
  );
});

test('ChannelsProcess.send rejects on unstarted instance', async () => {
  const p = new ChannelsProcess({
    sessionKey: 'k', chatId: '1', tmuxRunner: fakeRunner, botName: 'b',
    toolDispatcher: fakeDispatcher, claudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  await assert.rejects(
    () => p.send('hello'),
    /bridge not ready/,
  );
});

test('pickBackend honors channels via chatConfig.pm', () => {
  const cfg = { chats: { '12345': { pm: 'channels' } } };
  assert.equal(pickBackend({ config: cfg, chatId: '12345', threadId: null }), 'channels');
});

test('pickBackend honors channels via topicConfig.pm overriding chat', () => {
  const cfg = {
    chats: {
      '12345': {
        pm: 'sdk',
        topics: { '7': { pm: 'channels' } },
      },
    },
  };
  assert.equal(pickBackend({ config: cfg, chatId: '12345', threadId: '7' }), 'channels');
});

test('pickBackend honors channels via bot.pm default', () => {
  const cfg = { bot: { pm: 'channels' } };
  assert.equal(pickBackend({ config: cfg, chatId: '99', threadId: null }), 'channels');
});

test('factory falls back to sdk when channels wiring incomplete', () => {
  const warns = [];
  const logger = { warn: msg => warns.push(msg) };
  const cfg = { bot: { pm: 'channels' } };

  // Missing toolDispatcher + channelsClaudeBin
  const factory = createProcessFactory({
    config: cfg,
    spawnFn: () => ({}),
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    logger,
  });

  const proc = factory('sess-1', { chatId: '99' });
  assert.equal(proc.backend, 'sdk', 'falls back to SDK');
  assert.equal(warns.length, 1, 'logged a warning');
  assert.match(warns[0], /channels/);
  assert.match(warns[0], /toolDispatcher/);
  assert.match(warns[0], /channelsClaudeBin/);

  // cleanup — SdkProcess construction may have spun up internals
  proc.kill?.('test-cleanup').catch(() => {});
});

test('factory constructs ChannelsProcess when fully wired', () => {
  const cfg = { bot: { pm: 'channels' } };
  const factory = createProcessFactory({
    config: cfg,
    spawnFn: () => ({}),
    tmuxRunner: fakeRunner,
    botName: 'testbot',
    toolDispatcher: fakeDispatcher,
    channelsClaudeBin: '/usr/bin/echo',
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  const proc = factory('sess-2', { chatId: '99' });
  assert.equal(proc.backend, 'channels');
  assert.equal(proc.cost, 3);
});

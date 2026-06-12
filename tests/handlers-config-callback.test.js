/**
 * Tests for lib/handlers/config-callback.js — /model + /effort
 * inline-keyboard button handler.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHandleConfigCallback,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
} = require('../lib/handlers/config-callback');

const silentLogger = { log: () => {}, error: () => {} };

function makeCtx({ data, chatId = '12345', existingRows = 1 }) {
  const acks = [];
  const edits = [];
  return {
    callbackQuery: {
      data,
      message: {
        chat: { id: Number(chatId) },
        reply_markup: { inline_keyboard: Array.from({ length: existingRows }, () => []) },
      },
      from: { id: 99, first_name: 'Ivan', username: 'ivan' },
    },
    answerCallbackQuery: async (args) => acks.push(args),
    editMessageText: async (text, opts) => edits.push({ text, opts }),
    _acks: acks,
    _edits: edits,
  };
}

function makeDeps(overrides = {}) {
  const dbCalls = [];
  const pmCalls = [];
  return {
    dbCalls, pmCalls,
    deps: {
      config: {
        bot: { allowConfigCommands: true },
        chats: { '12345': { model: 'sonnet', effort: 'high' } },
      },
      db: {
        logConfigChange: (args) => dbCalls.push(['logConfigChange', args]),
      },
      dbWrite: (fn) => fn(),
      pm: {
        applyFlagSettings: async (key, settings) => {
          pmCalls.push(['applyFlagSettings', key, settings]);
          return true;
        },
        setModel: async (key, model) => {
          pmCalls.push(['setModel', key, model]);
          return true;
        },
      },
      getSessionKey: (chatId) => String(chatId),
      formatConfigInfoText: (cfg, show) => `Model: ${cfg.model}, Effort: ${cfg.effort} (${show})`,
      buildConfigKeyboard: () => ({ inline_keyboard: [] }),
      botName: 'test-bot',
      logger: silentLogger,
      ...overrides,
    },
  };
}

describe('handleConfigCallback — factory contract', () => {
  test('exports MODEL_OPTIONS + EFFORT_OPTIONS as the canonical lists', () => {
    assert.deepEqual(MODEL_OPTIONS, ['opus', 'sonnet', 'haiku']);
    assert.deepEqual(EFFORT_OPTIONS, ['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('handleConfigCallback — input validation', () => {
  test('non-cfg callback data is ignored', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'approve:7:abc' });
    await fn(ctx);
    assert.equal(ctx._acks.length, 0);
    assert.equal(m.pmCalls.length, 0);
  });

  test('chat not in config → alert toast, no mutation', async () => {
    const m = makeDeps({ config: { bot: { allowConfigCommands: true }, chats: {} } });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:opus', chatId: '99999' });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /Chat not configured/);
    assert.equal(ctx._acks[0].show_alert, true);
  });

  test('config commands disabled → alert toast', async () => {
    const m = makeDeps({
      config: { bot: { allowConfigCommands: false }, chats: { '12345': { model: 'sonnet' } } },
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:opus' });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /disabled/);
  });

  test('invalid model value → ack with error', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:notarealmodel' });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /Invalid model/);
    assert.equal(m.pmCalls.length, 0);
  });

  test('invalid effort value → ack with error', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:effort:turbo' });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /Invalid effort/);
  });

  test('same value as current → "Already X" toast, no mutation', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:sonnet' });  // already sonnet
    await fn(ctx);
    assert.match(ctx._acks[0].text, /Already sonnet/);
    assert.equal(m.pmCalls.length, 0);
    assert.equal(m.dbCalls.length, 0);
  });
});

describe('handleConfigCallback — happy path', () => {
  test('valid model change: mutates config + persists + applies live', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:opus' });
    await fn(ctx);
    assert.equal(m.deps.config.chats['12345'].model, 'opus', 'config mutated in place');
    const log = m.dbCalls.find((c) => c[0] === 'logConfigChange');
    assert.ok(log);
    assert.equal(log[1].field, 'model');
    assert.equal(log[1].old_value, 'sonnet');
    assert.equal(log[1].new_value, 'opus');
    assert.equal(log[1].source, 'inline-button');
    const setModel = m.pmCalls.find((c) => c[0] === 'setModel');
    assert.ok(setModel, 'pm.setModel called');
    assert.equal(setModel[2], 'opus');
  });

  test('valid effort change: mutates + persists + applyFlagSettings', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:effort:max' });
    await fn(ctx);
    assert.equal(m.deps.config.chats['12345'].effort, 'max');
    const apply = m.pmCalls.find((c) => c[0] === 'applyFlagSettings');
    assert.ok(apply);
    assert.deepEqual(apply[2], { effortLevel: 'max' });
  });

  test('toast says "switching when finished" if no live session', async () => {
    const m = makeDeps({
      pm: {
        applyFlagSettings: async () => false,  // no live session
        setModel: async () => false,
      },
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:opus' });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /switching when finished/);
  });

  test('toast says "model → opus" plain when live apply succeeded', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:opus' });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /^model → opus$/);
    assert.doesNotMatch(ctx._acks[0].text, /switching/);
  });

  test('re-renders card via editMessageText with HTML parse_mode', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:effort:max' });
    await fn(ctx);
    assert.equal(ctx._edits.length, 1);
    assert.match(ctx._edits[0].text, /Model: sonnet, Effort: max/);
  });
});

describe('handleConfigCallback — scope + persistence (2026-06-12 "/model in Music does nothing")', () => {
  function makeTopicDeps() {
    const saved = [];
    const m = makeDeps({
      config: {
        bot: { allowConfigCommands: true },
        chats: { '-100': { model: 'sonnet', effort: 'high', topics: { '3': { name: 'Music', agent: 'music-curator' } } } },
      },
      getSessionKey: (chatId, threadId) => threadId ? `${chatId}:${threadId}` : String(chatId),
      saveConfig: () => saved.push(true),
    });
    m.saved = saved;
    return m;
  }
  function topicCtx(data) {
    const c = makeCtx({ data, chatId: '-100' });
    c.callbackQuery.message.message_thread_id = 3;   // Music topic
    return c;
  }

  test('tap in a topic writes the TOPIC override, NOT the chat root', async () => {
    const m = makeTopicDeps();
    const fn = createHandleConfigCallback(m.deps);
    await fn(topicCtx('cfg:model:opus'));
    assert.equal(m.deps.config.chats['-100'].topics['3'].model, 'opus',
      'the Music topic must get its own model override');
    assert.equal(m.deps.config.chats['-100'].model, 'sonnet',
      'the chat root must NOT change — no leak to General / other topics');
  });

  test('tap in a topic persists via saveConfig (survives restart)', async () => {
    const m = makeTopicDeps();
    const fn = createHandleConfigCallback(m.deps);
    await fn(topicCtx('cfg:model:opus'));
    assert.equal(m.saved.length, 1, 'saveConfig MUST be called or the change dies on the next restart');
  });

  test('tap in a topic logs the REAL thread_id (not null)', async () => {
    const m = makeTopicDeps();
    const fn = createHandleConfigCallback(m.deps);
    await fn(topicCtx('cfg:effort:max'));
    const log = m.dbCalls.find((c) => c[0] === 'logConfigChange');
    assert.equal(log[1].thread_id, '3', 'the audit row must record the topic it applied to');
  });

  test('tap at the chat level (no topic) still writes the chat root + persists', async () => {
    const saved = [];
    const m = makeDeps({ saveConfig: () => saved.push(true) });
    const fn = createHandleConfigCallback(m.deps);
    await fn(makeCtx({ data: 'cfg:model:opus' }));   // no message_thread_id
    assert.equal(m.deps.config.chats['12345'].model, 'opus');
    assert.equal(saved.length, 1);
  });
})

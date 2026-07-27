/**
 * Tests for lib/handlers/config-callback.js — /model + /effort
 * inline-keyboard button handler.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createAsyncLock } = require('@shumkov/orchestra');

const {
  createHandleConfigCallback,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
} = require('../lib/handlers/config-callback');

const silentLogger = { log: () => {}, error: () => {} };
const CODEX_VIEW = Object.freeze({
  runtime: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  models: [
    {
      model: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 SOL',
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['high', 'xhigh'],
    },
    {
      model: 'gpt-5.5',
      displayName: 'GPT-5.5',
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['medium', 'high'],
    },
  ],
  efforts: ['medium', 'high', 'xhigh'],
});

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
        logConfigChanges: (rows) => {
          if (overrides.auditError) throw overrides.auditError;
          dbCalls.push(...rows.map((row) => ['logConfigChange', row]));
        },
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
        selectModelSettings: async (key, settings) => {
          pmCalls.push(['selectModelSettings', key, settings]);
          if (typeof overrides.selectModelSettings === 'function') {
            return overrides.selectModelSettings(key, settings);
          }
          if (overrides.selectModelSettingsError) {
            throw overrides.selectModelSettingsError;
          }
          return overrides.selectModelSettingsResult ?? {
            outcome: 'not-loaded',
            nextTurn: settings,
          };
        },
      },
      intentLock: overrides.intentLock || createAsyncLock(),
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

describe('handleConfigCallback — Codex model and effort', () => {
  function codexDeps(overrides = {}) {
    const seen = [];
    const m = makeDeps({
      config: {
        bot: { allowConfigCommands: true },
        chats: {
          '12345': {
            model: 'sonnet',
            effort: 'max',
            codexModel: 'gpt-5.6-sol',
            codexEffort: 'high',
          },
        },
      },
      resolveRuntimeView: async (context) => {
        seen.push(context);
        return CODEX_VIEW;
      },
      ...overrides,
    });
    m.runtimeCalls = seen;
    return m;
  }

  test('catalog model writes codexModel only and applies one complete Codex pair', async () => {
    const views = [];
    const m = codexDeps({
      formatConfigInfoText: (...args) => {
        views.push(['info', args[2], args[5]]);
        return `Codex model: ${args[0].codexModel}`;
      },
      buildConfigKeyboard: (...args) => {
        views.push(['keyboard', args[4]]);
        return { inline_keyboard: [] };
      },
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:gpt-5.5' });
    await fn(ctx);

    const chat = m.deps.config.chats['12345'];
    assert.equal(chat.codexModel, 'gpt-5.5');
    assert.equal(chat.codexEffort, 'high');
    assert.equal(chat.model, 'sonnet');
    assert.deepEqual(m.pmCalls, [[
      'selectModelSettings',
      '12345',
      { model: 'gpt-5.5', effort: 'high' },
    ]]);
    assert.deepEqual(m.runtimeCalls, [{
      sessionKey: '12345',
      chatId: '12345',
      threadId: null,
    }]);
    assert.equal(m.dbCalls[0][1].field, 'model');
    assert.equal(m.dbCalls[0][1].old_value, 'gpt-5.6-sol');
    assert.equal(m.dbCalls.length, 1);
    assert.match(ctx._acks[0].text, /next session/i);
    assert.equal(views[0][0], 'info');
    assert.equal(views[0][1], '12345');
    assert.deepEqual(views[0][2].desiredSettings, {
      model: 'gpt-5.5',
      effort: 'high',
    });
    assert.equal(views[0][2].processStatus, 'not-loaded');
    assert.equal(views[1][0], 'keyboard');
    assert.equal(views[1][1], views[0][2]);
  });

  test('model switch atomically resets an unsupported effort to the target catalog default', async () => {
    const saved = [];
    const rendered = [];
    const m = codexDeps({
      saveConfig: () => saved.push(true),
      formatConfigInfoText: (chat) => {
        rendered.push({
          model: chat.codexModel,
          effort: chat.codexEffort,
        });
        return 'updated Codex config';
      },
    });
    m.deps.config.chats['12345'].codexEffort = 'xhigh';
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:gpt-5.5' });
    await fn(ctx);

    const chat = m.deps.config.chats['12345'];
    assert.deepEqual({
      model: chat.codexModel,
      effort: chat.codexEffort,
    }, {
      model: 'gpt-5.5',
      effort: 'high',
    });
    assert.equal(saved.length, 1);
    assert.deepEqual(
      m.dbCalls.map((call) => ({
        field: call[1].field,
        old: call[1].old_value,
        value: call[1].new_value,
      })),
      [
        { field: 'model', old: 'gpt-5.6-sol', value: 'gpt-5.5' },
        { field: 'effort', old: 'xhigh', value: 'high' },
      ],
    );
    assert.deepEqual(rendered, [{
      model: 'gpt-5.5',
      effort: 'high',
    }]);
    assert.deepEqual(m.pmCalls, [[
      'selectModelSettings',
      '12345',
      { model: 'gpt-5.5', effort: 'high' },
    ]]);
    assert.match(ctx._acks[0].text, /effort → high/);
    assert.match(ctx._acks[0].text, /next session/i);
  });

  test('effort must be authenticated and supported by the selected Codex model', async () => {
    const m = codexDeps();
    const fn = createHandleConfigCallback(m.deps);

    const invalid = makeCtx({ data: 'cfg:effort:medium' });
    await fn(invalid);
    assert.match(invalid._acks[0].text, /Invalid effort/);
    assert.equal(m.dbCalls.length, 0);

    const valid = makeCtx({ data: 'cfg:effort:xhigh' });
    await fn(valid);
    const chat = m.deps.config.chats['12345'];
    assert.equal(chat.codexEffort, 'xhigh');
    assert.equal(chat.effort, 'max');
    assert.deepEqual(m.pmCalls.at(-1), [
      'selectModelSettings',
      '12345',
      { model: 'gpt-5.6-sol', effort: 'xhigh' },
    ]);
    assert.match(valid._acks[0].text, /next session/i);
  });

  test('Claude aliases absent from the authenticated Codex catalog are rejected', async () => {
    const m = codexDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:opus' });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /Invalid model/);
    assert.equal(m.dbCalls.length, 0);
    assert.equal(m.pmCalls.length, 0);
    assert.equal(
      m.deps.config.chats['12345'].codexModel,
      'gpt-5.6-sol',
    );
  });

  test('an explicit Claude runtime view retains legacy fields and live apply', async () => {
    const m = makeDeps({
      resolveRuntimeView: async () => ({ runtime: 'claude' }),
    });
    const fn = createHandleConfigCallback(m.deps);
    await fn(makeCtx({ data: 'cfg:model:opus' }));
    const chat = m.deps.config.chats['12345'];
    assert.equal(chat.model, 'opus');
    assert.equal(chat.codexModel, undefined);
    assert.equal(
      m.pmCalls.some((call) => call[0] === 'setModel' && call[2] === 'opus'),
      true,
    );
  });

  test('runtime-view failure rejects a model write before config, DB, or process mutation', async () => {
    const m = makeDeps({
      resolveRuntimeView: async () => {
        throw new Error('preflight unavailable');
      },
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:opus' });
    await fn(ctx);
    assert.equal(m.deps.config.chats['12345'].model, 'sonnet');
    assert.equal(m.dbCalls.length, 0);
    assert.equal(m.pmCalls.length, 0);
    assert.equal(ctx._acks[0].show_alert, true);
  });

  test('save failure restores exact Codex properties and skips audit/process update', async () => {
    const m = codexDeps({
      saveConfig: () => {
        throw new Error('read only filesystem');
      },
    });
    const chat = m.deps.config.chats['12345'];
    chat.codexEffort = 'xhigh';
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:gpt-5.5' });

    await fn(ctx);

    assert.deepEqual({
      model: chat.codexModel,
      effort: chat.codexEffort,
    }, {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    assert.equal(m.dbCalls.length, 0);
    assert.equal(m.pmCalls.length, 0);
    assert.equal(ctx._edits.length, 0);
    assert.match(ctx._acks[0].text, /couldn't save/i);
    assert.equal(ctx._acks[0].show_alert, true);
  });

  test('atomic audit failure restores the persisted Codex pair and skips live selection', async () => {
    let saves = 0;
    const m = codexDeps({
      auditError: new Error('second audit row rejected'),
      saveConfig: () => { saves += 1; },
    });
    const chat = m.deps.config.chats['12345'];
    chat.codexEffort = 'xhigh';
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:gpt-5.5' });

    await fn(ctx);

    assert.equal(saves, 2);
    assert.deepEqual({
      model: chat.codexModel,
      effort: chat.codexEffort,
    }, {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    assert.equal(m.dbCalls.length, 0);
    assert.equal(m.pmCalls.length, 0);
    assert.equal(ctx._edits.length, 0);
    assert.match(ctx._acks[0].text, /couldn't audit.*nothing changed/i);
    assert.equal(ctx._acks[0].show_alert, true);
  });

  test('audit plus rollback-save failure alerts on persisted config uncertainty', async () => {
    let saves = 0;
    const m = codexDeps({
      auditError: new Error('audit unavailable'),
      saveConfig: () => {
        saves += 1;
        if (saves === 2) throw new Error('rollback save failed');
      },
    });
    m.deps.config.chats['12345'].codexEffort = 'xhigh';
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:gpt-5.5' });

    await fn(ctx);

    assert.equal(saves, 2);
    assert.equal(m.pmCalls.length, 0);
    assert.equal(ctx._edits.length, 0);
    assert.match(
      ctx._acks[0].text,
      /persisted config needs attention/i,
    );
    assert.equal(ctx._acks[0].show_alert, true);
  });

  test('active Codex update reports current unchanged and next selected pair', async () => {
    const m = codexDeps({
      selectModelSettingsResult: {
        outcome: 'updated-live',
        threadId: 'thread-1',
        generationId: 'generation-1',
        currentTurn: { model: 'gpt-5.6-sol', effort: 'high' },
        nextTurn: { model: 'gpt-5.5', effort: 'high' },
      },
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:model:gpt-5.5' });

    await fn(ctx);

    assert.match(ctx._acks[0].text, /current turn gpt-5\.6-sol\/high unchanged/i);
    assert.match(ctx._acks[0].text, /next turn gpt-5\.5\/high/i);
  });

  test('unexpected PM failure reports durable selection with unknown live status', async () => {
    const m = codexDeps({
      selectModelSettingsError: new Error('unexpected PM failure'),
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:effort:xhigh' });

    await fn(ctx);

    assert.equal(m.deps.config.chats['12345'].codexEffort, 'xhigh');
    assert.equal(m.dbCalls.length, 1);
    assert.match(ctx._acks[0].text, /durabl.*live status is unknown/i);
  });

  test('releases the session intent lock before card rendering and Telegram calls', async () => {
    let held = false;
    let rendered = false;
    const m = codexDeps({
      intentLock: {
        async acquire(key) {
          assert.equal(key, '12345');
          held = true;
          return () => { held = false; };
        },
      },
      selectModelSettings: async () => {
        assert.equal(held, true);
        return {
          outcome: 'not-loaded',
          nextTurn: { model: 'gpt-5.5', effort: 'high' },
        };
      },
      formatConfigInfoText: () => {
        assert.equal(held, false);
        rendered = true;
        return 'updated';
      },
    });
    const fn = createHandleConfigCallback(m.deps);

    await fn(makeCtx({ data: 'cfg:model:gpt-5.5' }));
    assert.equal(rendered, true);
    assert.equal(
      m.pmCalls.some((call) => call[0] === 'selectModelSettings'),
      true,
    );
  });
});

describe('handleConfigCallback — scope + persistence (2026-06-12 "/model in Music does nothing")', () => {
  function makeTopicDeps() {
    const saved = [];
    const m = makeDeps({
      config: {
        bot: { allowConfigCommands: true },
        chats: { '-100': { model: 'sonnet', effort: 'high', isolateTopics: true, topics: { '3': { name: 'Music', agent: 'music-curator' } } } },
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
});

describe('handleConfigCallback — richtext toggle', () => {
  test('card re-renderers receive the effective inherited value as a boolean', async () => {
    const received = [];
    const m = makeDeps({
      config: {
        bot: { allowConfigCommands: true, richText: true },
        chats: { '12345': { model: 'sonnet', effort: 'high' } },
      },
      formatConfigInfoText: (...args) => {
        received.push(['info', args[4]]);
        return 'updated config';
      },
      buildConfigKeyboard: (...args) => {
        received.push(['keyboard', args[3]]);
        return { inline_keyboard: [] };
      },
    });
    const fn = createHandleConfigCallback(m.deps);
    await fn(makeCtx({ data: 'cfg:model:opus', existingRows: 3 }));
    assert.deepEqual(received, [['info', true], ['keyboard', true]]);
  });

  test('turning off an inherited value records the effective old value', async () => {
    const m = makeDeps({
      config: {
        bot: { allowConfigCommands: true, richText: true },
        chats: { '12345': { model: 'sonnet', effort: 'high' } },
      },
    });
    const fn = createHandleConfigCallback(m.deps);
    await fn(makeCtx({ data: 'cfg:richtext:off', existingRows: 3 }));
    const log = m.dbCalls.find((c) => c[0] === 'logConfigChange');
    assert.equal(log[1].old_value, true);
    assert.equal(log[1].new_value, false);
  });

  test('cfg:richtext:on writes a real boolean true, not the string "on"', async () => {
    const saved = [];
    const m = makeDeps({ saveConfig: () => saved.push(true) });
    const fn = createHandleConfigCallback(m.deps);
    await fn(makeCtx({ data: 'cfg:richtext:on', existingRows: 3 }));
    assert.strictEqual(m.deps.config.chats['12345'].richText, true);
    assert.equal(saved.length, 1);
  });

  test('cfg:richtext:off writes a real boolean false', async () => {
    const m = makeDeps({
      config: { bot: { allowConfigCommands: true }, chats: { '12345': { model: 'sonnet', richText: true } } },
    });
    const fn = createHandleConfigCallback(m.deps);
    await fn(makeCtx({ data: 'cfg:richtext:off', existingRows: 3 }));
    assert.strictEqual(m.deps.config.chats['12345'].richText, false);
  });

  test('does not call pm.applyFlagSettings or pm.setModel — richText is not spawn-time', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    await fn(makeCtx({ data: 'cfg:richtext:on', existingRows: 3 }));
    assert.equal(m.pmCalls.length, 0);
  });

  test('ack text distinguishes live delivery from the next-spawn authoring lag', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:richtext:on', existingRows: 3 });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /next session/i);
  });

  test('ack text for turning off is plain, no session-lag caveat', async () => {
    const m = makeDeps({
      config: { bot: { allowConfigCommands: true }, chats: { '12345': { model: 'sonnet', richText: true } } },
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:richtext:off', existingRows: 3 });
    await fn(ctx);
    assert.equal(ctx._acks[0].text, 'Rich text → off');
  });

  test('tapping the already-current value acks "Already X" without a duplicate write', async () => {
    const m = makeDeps({
      config: { bot: { allowConfigCommands: true }, chats: { '12345': { model: 'sonnet', richText: true } } },
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:richtext:on', existingRows: 3 });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /Already on/);
    assert.equal(m.dbCalls.length, 0, 'no logConfigChange for a no-op toggle');
  });

  test('invalid richtext value → ack with error, no mutation', async () => {
    const m = makeDeps();
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:richtext:maybe', existingRows: 3 });
    await fn(ctx);
    assert.match(ctx._acks[0].text, /Invalid richtext/);
    assert.equal(m.deps.config.chats['12345'].richText, undefined);
  });

  test('a topic tap writes the TOPIC override, matching /model\'s scoping rule', async () => {
    const saved = [];
    const m = makeDeps({
      config: {
        bot: { allowConfigCommands: true },
        chats: { '-100': { model: 'sonnet', isolateTopics: true, topics: { '3': { name: 'Music' } } } },
      },
      getSessionKey: (chatId, threadId) => threadId ? `${chatId}:${threadId}` : String(chatId),
      saveConfig: () => saved.push(true),
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:richtext:on', chatId: '-100', existingRows: 3 });
    ctx.callbackQuery.message.message_thread_id = 3;
    await fn(ctx);
    assert.strictEqual(m.deps.config.chats['-100'].topics['3'].richText, true);
    assert.equal(m.deps.config.chats['-100'].richText, undefined, 'chat root must not change');
  });

  test('a non-isolated topic toggle updates the topic value that delivery resolves', async () => {
    const m = makeDeps({
      config: {
        bot: { allowConfigCommands: true },
        chats: {
          '-100': {
            model: 'sonnet',
            isolateTopics: false,
            topics: { '3': { name: 'General', richText: true } },
          },
        },
      },
      getSessionKey: (chatId) => String(chatId),
    });
    const fn = createHandleConfigCallback(m.deps);
    const ctx = makeCtx({ data: 'cfg:richtext:off', chatId: '-100', existingRows: 3 });
    ctx.callbackQuery.message.message_thread_id = 3;
    await fn(ctx);

    assert.equal(m.deps.config.chats['-100'].topics['3'].richText, false);
    assert.equal(m.deps.config.chats['-100'].richText, undefined, 'the topic toggle must not alter every topic');
    const log = m.dbCalls.find((c) => c[0] === 'logConfigChange');
    assert.equal(log[1].thread_id, '3');
    assert.equal(ctx._acks[0].text, 'Rich text → off');
  });
});

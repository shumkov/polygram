'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createAsyncLock } = require('@shumkov/orchestra');
const { createSlashCommands } = require('../lib/handlers/slash-commands');

function fixture(overrides = {}) {
  const calls = {
    sendReply: [],
    events: [],
    pmCalls: [],
    db: { configChanges: [] },
    pairings: [],
    discarded: [],
  };

  // 0.10.0 P0.2/P0.3 fix: slash-commands routes through Process
  // abstraction (pm.getContextUsage + entry.fireUserMessage) instead
  // of poking entry.query / entry.inputController directly. Fixture
  // mirrors the new contract.
  const pmEntry = overrides.pmEntry === undefined
    ? {
        fireUserMessage: (text) => {
          calls.pmCalls.push({ kind: 'push', m: { type: 'user', message: { role: 'user', content: text } } });
          return true;
        },
      }
    : overrides.pmEntry;

  const pm = {
    get: () => pmEntry,
    has: () => pmEntry != null,
    getContextUsage: overrides.getContextUsage
      || (async () => ({ remaining: 9999 })),
    kill: overrides.kill || (async (sk) => calls.pmCalls.push({ kind: 'kill', sk })),
    resetSession: async (sk, opts) => {
      if (overrides.resetError) throw overrides.resetError;
      calls.pmCalls.push({ kind: 'reset', sk, opts });
      return { drainedPendings: 0 };
    },
    setModel: async (sk, m) => { calls.pmCalls.push({ kind: 'setModel', m }); return overrides.applyApplied !== false; },
    applyFlagSettings: async (sk, s) => { calls.pmCalls.push({ kind: 'applyFlag', s }); return overrides.applyApplied !== false; },
    selectModelSettings: async (sk, settings) => {
      calls.pmCalls.push({ kind: 'selectModelSettings', sk, settings });
      if (typeof overrides.selectModelSettings === 'function') {
        return overrides.selectModelSettings(sk, settings);
      }
      if (overrides.selectModelSettingsError) {
        throw overrides.selectModelSettingsError;
      }
      return overrides.selectModelSettingsResult ?? {
        outcome: 'not-loaded',
        nextTurn: settings,
      };
    },
  };

  const pairings = {
    issueCode: (args) => { calls.pairings.push({ op: 'issue', args }); return { code: 'CODE-123', scope: args.scope, chat_id: args.chat_id, note: args.note }; },
    listActive: () => overrides.activePairings || [],
    revokeByUser: (args) => { calls.pairings.push({ op: 'revoke', args }); return overrides.revokeCount ?? 1; },
    claimCode: (args) => { calls.pairings.push({ op: 'claim', args }); return overrides.claimResult || { ok: true, chat_id: '111' }; },
  };

  const dispatch = createSlashCommands({
    config: {
      bot: {
        allowConfigCommands: overrides.allowConfigCommands !== false,
        adminChatId: overrides.adminChatId || '999',
      },
    },
    db: {
      logConfigChange: (row) => calls.db.configChanges.push(row),
      logConfigChanges: (rows) => {
        if (overrides.auditError) throw overrides.auditError;
        calls.db.configChanges.push(...rows);
      },
    },
    dbWrite: (fn) => { try { fn(); } catch {} },
    pm,
    pairings,
    parsePairingTtl: (s) => 600000,
    contextHintShown: new Map(),
    formatContextReply: (u) => 'Remaining: ' + u.remaining,
    getClaudeSessionId: () => overrides.savedSessionId || null,
    getOrSpawnForChat: async (sk) => overrides.spawnEntry || pmEntry,
    parsePairCodeArgs: (text) => {
      const m = /scope=(\S+)/.exec(text);
      return { scope: m ? m[1] : 'user', chat: null, ttl: null, note: null };
    },
    modelVersionsDesc: { sonnet: 'sonnet-4-6', opus: 'opus-4-7', haiku: 'haiku-4-5' },
    resolveRuntimeView: overrides.resolveRuntimeView,
    intentLock: overrides.intentLock || createAsyncLock(),
    saveConfig: overrides.saveConfig || (() => {}),
    botName: 'testbot',
    logEvent: (kind, detail) => calls.events.push({ kind, detail }),
    retireQuestionSession: async (sk) => { calls.discarded.push(sk); },
    logger: { log: () => {}, error: () => {} },
  });

  function makeCtx({ text, chatId = '999', userId = 42 } = {}) {
    return {
      text,
      sessionKey: 'sk:' + chatId,
      chatId,
      threadIdStr: null,
      chatConfig: { model: 'sonnet', effort: 'medium' },
      cmdUser: 'OperatorName',
      cmdUserId: userId,
      label: 'TestChat',
      sendReply: async (msg) => calls.sendReply.push(msg),
    };
  }

  return { dispatch, calls, makeCtx };
}

describe('slash-commands — non-command pass-through', () => {
  test('plain text returns false', async () => {
    const fx = fixture();
    const res = await fx.dispatch(fx.makeCtx({ text: 'hello world' }));
    assert.equal(res, false);
    assert.equal(fx.calls.sendReply.length, 0);
  });

  test('unknown slash command returns false', async () => {
    const fx = fixture();
    const res = await fx.dispatch(fx.makeCtx({ text: '/unknown' }));
    assert.equal(res, false);
  });
});

describe('slash-commands — gate by allowConfigCommands', () => {
  test('allowConfigCommands=false then /model is unrecognized (returns false)', async () => {
    const fx = fixture({ allowConfigCommands: false });
    const res = await fx.dispatch(fx.makeCtx({ text: '/model opus' }));
    assert.equal(res, false);
  });
});

describe('slash-commands — /context', () => {
  test('Codex reports context usage as unsupported without Claude guidance', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => ({
        runtime: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });
    await fx.dispatch(fx.makeCtx({ text: '/context' }));
    assert.match(fx.calls.sendReply[0], /Codex/i);
    assert.match(fx.calls.sendReply[0], /not supported/i);
    assert.doesNotMatch(fx.calls.sendReply[0], /send a message first/i);
  });

  test('with active session: fetches usage and replies formatted', async () => {
    const fx = fixture();
    const res = await fx.dispatch(fx.makeCtx({ text: '/context' }));
    assert.equal(res, true);
    assert.equal(fx.calls.sendReply.length, 1);
    assert.match(fx.calls.sendReply[0], /Remaining: 9999/);
  });

  test('with no active session: send a message first hint', async () => {
    const fx = fixture({ pmEntry: null });
    await fx.dispatch(fx.makeCtx({ text: '/context' }));
    assert.match(fx.calls.sendReply[0], /No active session/);
  });

  test('getContextUsage throws: user-friendly error', async () => {
    const fx = fixture({
      getContextUsage: async () => { throw new Error('boom'); },
    });
    await fx.dispatch(fx.makeCtx({ text: '/context' }));
    assert.match(fx.calls.sendReply[0], /Couldn't fetch context info: boom/);
  });
});

describe('slash-commands — /reload', () => {
  test('Codex reload names the provider after exact retirement succeeds', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => ({ runtime: 'codex' }),
    });
    await fx.dispatch(fx.makeCtx({ text: '/reload' }));
    assert.match(fx.calls.sendReply[0], /Reloaded Codex/i);
  });

  test('reload failure is visible and never claims the session changed', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => ({ runtime: 'codex' }),
      kill: async () => {
        throw Object.assign(new Error('cleanup not proven'), {
          code: 'CODEX_RETIREMENT_UNVERIFIED',
        });
      },
    });
    await fx.dispatch(fx.makeCtx({ text: '/reload' }));
    assert.match(fx.calls.sendReply[0], /couldn.t reload Codex/i);
    assert.doesNotMatch(fx.calls.sendReply[0], /^🔄 Reloaded/);
  });

  test('reload disposes the live question context for the session', async () => {
    // /reload retires the provider that owns any open question, so whatever
    // the handler is holding exactly for that session must go with it.
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/reload', chatId: '999' }));
    assert.deepEqual(fx.calls.discarded, ['sk:999']);
  });

  test('reload with no live process still disposes', async () => {
    const fx = fixture({ pmEntry: null });
    await fx.dispatch(fx.makeCtx({ text: '/reload', chatId: '999' }));
    assert.deepEqual(fx.calls.discarded, ['sk:999']);
  });

  test('with active session: kills and replies', async () => {
    const fx = fixture();
    const res = await fx.dispatch(fx.makeCtx({ text: '/reload' }));
    assert.equal(res, true);
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'kill'));
    assert.match(fx.calls.sendReply[0], /Reloaded/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'session-reload-command'));
  });

  test('without active session: still acks (no-op)', async () => {
    const fx = fixture({ pmEntry: null });
    await fx.dispatch(fx.makeCtx({ text: '/reload' }));
    assert.match(fx.calls.sendReply[0], /Reloaded/);
  });
});

describe('slash-commands — /new + /reset', () => {
  test('Codex reset names the provider only after strict reset succeeds', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => ({ runtime: 'codex' }),
    });
    await fx.dispatch(fx.makeCtx({ text: '/new' }));
    assert.match(fx.calls.sendReply[0], /fresh Codex thread/i);
  });

  test('reset failure is visible and never claims a fresh session', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => ({ runtime: 'codex' }),
      resetError: Object.assign(new Error('cleanup not proven'), {
        code: 'CODEX_RETIREMENT_UNVERIFIED',
      }),
    });
    await fx.dispatch(fx.makeCtx({ text: '/new' }));
    assert.match(fx.calls.sendReply[0], /couldn.t start a fresh Codex thread/i);
    assert.doesNotMatch(fx.calls.sendReply[0], /^✨ Started/);
  });

  test('/new calls resetSession and acks', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/new' }));
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'reset' && c.opts.reason === 'new'));
    assert.match(fx.calls.sendReply[0], /fresh session/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'session-reset-command'));
  });

  test('/reset calls resetSession (reason=reset)', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/reset' }));
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'reset' && c.opts.reason === 'reset'));
  });

  test('/clear is a synonym for /new — resets the session (reason=clear) and acks', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/clear' }));
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'reset' && c.opts.reason === 'clear'));
    assert.match(fx.calls.sendReply[0], /fresh session/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'session-reset-command'));
  });
});

describe('slash-commands — /model', () => {
  test('valid model: persists and applies and acks', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/model opus' }));
    assert.equal(fx.calls.db.configChanges.length, 1);
    assert.equal(fx.calls.db.configChanges[0].new_value, 'opus');
    assert.ok(fx.calls.pmCalls.some((c) => c.kind === 'setModel' && c.m === 'opus'));
    assert.match(fx.calls.sendReply[0], /Model → opus \(opus-4-7\)/);
  });

  test('invalid model: rejects without DB write', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/model haikuish' }));
    assert.equal(fx.calls.db.configChanges.length, 0);
    assert.match(fx.calls.sendReply[0], /Unknown model/);
  });

  test('apply returned false (no live session): suffix Ill switch when I finish', async () => {
    const fx = fixture({ applyApplied: false });
    await fx.dispatch(fx.makeCtx({ text: '/model sonnet' }));
    assert.match(fx.calls.sendReply[0], /switch when I finish/);
  });
});

describe('slash-commands — /effort', () => {
  test('valid effort: persists and applies', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/effort high' }));
    assert.equal(fx.calls.db.configChanges[0].new_value, 'high');
    assert.match(fx.calls.sendReply[0], /Effort → high/);
  });

  test('invalid effort: rejects', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/effort ludicrous' }));
    assert.match(fx.calls.sendReply[0], /Unknown effort/);
  });
});

describe('slash-commands — Codex model and effort', () => {
  const codexView = {
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
        model: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 TERRA',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh'],
      },
      {
        model: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 LUNA',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['medium', 'high'],
      },
      {
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['medium', 'high'],
      },
    ],
    efforts: ['medium', 'high', 'xhigh'],
  };

  test('/model validates the catalog, writes codexModel only, and reports the next-session timing', async () => {
    const runtimeCalls = [];
    const fx = fixture({
      resolveRuntimeView: async (context) => {
        runtimeCalls.push(context);
        return codexView;
      },
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.6-terra' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'high';
    await fx.dispatch(ctx);

    assert.equal(ctx.chatConfig.codexModel, 'gpt-5.6-terra');
    assert.equal(ctx.chatConfig.codexEffort, 'high');
    assert.equal(ctx.chatConfig.model, 'sonnet');
    assert.deepEqual(
      fx.calls.pmCalls.filter((call) => call.kind === 'selectModelSettings'),
      [{
        kind: 'selectModelSettings',
        sk: 'sk:999',
        settings: { model: 'gpt-5.6-terra', effort: 'high' },
      }],
    );
    assert.deepEqual(runtimeCalls, [{
      sessionKey: 'sk:999',
      chatId: '999',
      threadId: null,
    }]);
    assert.equal(fx.calls.db.configChanges[0].field, 'model');
    assert.equal(fx.calls.db.configChanges.length, 1);
    assert.match(
      fx.calls.sendReply[0],
      /Model → gpt-5\.6-terra \(GPT-5\.6 TERRA\)/,
    );
    assert.match(fx.calls.sendReply[0], /selected for this chat's next session/i);
  });

  test('/model atomically resets an unsupported Codex effort and audits both changes', async () => {
    const saved = [];
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
      saveConfig: () => saved.push(true),
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.6-luna' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'xhigh';
    await fx.dispatch(ctx);

    assert.deepEqual({
      model: ctx.chatConfig.codexModel,
      effort: ctx.chatConfig.codexEffort,
    }, {
      model: 'gpt-5.6-luna',
      effort: 'high',
    });
    assert.equal(saved.length, 1);
    assert.deepEqual(
      fx.calls.db.configChanges.map(({ field, old_value, new_value }) => ({
        field,
        old: old_value,
        value: new_value,
      })),
      [
        { field: 'model', old: 'gpt-5.6-sol', value: 'gpt-5.6-luna' },
        { field: 'effort', old: 'xhigh', value: 'high' },
      ],
    );
    assert.deepEqual(
      fx.calls.pmCalls.filter((call) => call.kind === 'selectModelSettings'),
      [{
        kind: 'selectModelSettings',
        sk: 'sk:999',
        settings: { model: 'gpt-5.6-luna', effort: 'high' },
      }],
    );
    assert.match(fx.calls.sendReply[0], /Effort → high/);
    assert.match(fx.calls.sendReply[0], /next session/i);
  });

  test('/effort accepts only the selected catalog model efforts and never applies Claude flags', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
    });
    const ctx = fx.makeCtx({ text: '/effort xhigh' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'high';
    await fx.dispatch(ctx);

    assert.equal(ctx.chatConfig.codexEffort, 'xhigh');
    assert.equal(ctx.chatConfig.effort, 'medium');
    assert.deepEqual(
      fx.calls.pmCalls.filter((call) => call.kind === 'selectModelSettings')
        .at(-1).settings,
      { model: 'gpt-5.6-sol', effort: 'xhigh' },
    );
    assert.match(fx.calls.sendReply[0], /next session/i);

    const rejected = fx.makeCtx({ text: '/effort medium' });
    rejected.chatConfig.codexModel = 'gpt-5.6-sol';
    rejected.chatConfig.codexEffort = 'high';
    await fx.dispatch(rejected);
    assert.match(fx.calls.sendReply.at(-1), /Unknown effort/);
    assert.equal(rejected.chatConfig.codexEffort, 'high');
  });

  test('save failure restores exact property presence and skips audit/process update', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
      saveConfig: () => {
        throw new Error('disk full');
      },
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.6-luna' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    assert.equal(Object.hasOwn(ctx.chatConfig, 'codexEffort'), false);

    await fx.dispatch(ctx);

    assert.equal(ctx.chatConfig.codexModel, 'gpt-5.6-sol');
    assert.equal(Object.hasOwn(ctx.chatConfig, 'codexEffort'), false);
    assert.equal(fx.calls.db.configChanges.length, 0);
    assert.equal(
      fx.calls.pmCalls.some((call) => call.kind === 'selectModelSettings'),
      false,
    );
    assert.match(fx.calls.sendReply[0], /couldn't save/i);
  });

  test('atomic audit failure rolls back the saved Codex pair before live selection', async () => {
    let saves = 0;
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
      auditError: new Error('second audit row rejected'),
      saveConfig: () => { saves += 1; },
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.6-luna' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'xhigh';

    await fx.dispatch(ctx);

    assert.equal(saves, 2);
    assert.deepEqual({
      model: ctx.chatConfig.codexModel,
      effort: ctx.chatConfig.codexEffort,
    }, {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    assert.equal(fx.calls.db.configChanges.length, 0);
    assert.equal(
      fx.calls.pmCalls.some((call) => call.kind === 'selectModelSettings'),
      false,
    );
    assert.match(fx.calls.sendReply[0], /couldn't audit.*nothing changed/i);
  });

  test('audit plus rollback-save failure reports persisted config uncertainty', async () => {
    let saves = 0;
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
      auditError: new Error('audit unavailable'),
      saveConfig: () => {
        saves += 1;
        if (saves === 2) throw new Error('rollback save failed');
      },
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.6-luna' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'xhigh';

    await fx.dispatch(ctx);

    assert.equal(saves, 2);
    assert.equal(
      fx.calls.pmCalls.some((call) => call.kind === 'selectModelSettings'),
      false,
    );
    assert.match(
      fx.calls.sendReply[0],
      /persisted config needs attention/i,
    );
  });

  test('active update reports the current pair unchanged and the complete next pair', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
      selectModelSettingsResult: {
        outcome: 'updated-live',
        threadId: 'thread-1',
        generationId: 'generation-1',
        currentTurn: { model: 'gpt-5.6-sol', effort: 'high' },
        nextTurn: { model: 'gpt-5.6-terra', effort: 'high' },
      },
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.6-terra' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'high';

    await fx.dispatch(ctx);

    assert.match(fx.calls.sendReply[0], /current turn gpt-5\.6-sol\/high unchanged/i);
    assert.match(fx.calls.sendReply[0], /next turn gpt-5\.6-terra\/high/i);
  });

  for (const [outcome, expected] of [
    ['daemon-busy', /not loaded; its next message may be busy/i],
    ['unavailable', /durabl.*process did not accept/i],
  ]) {
    test(`${outcome} keeps the durable selection and reports the lifecycle honestly`, async () => {
      const fx = fixture({
        resolveRuntimeView: async () => codexView,
        selectModelSettingsResult: {
          outcome,
          ...(outcome === 'unavailable' && { reason: 'quiescing' }),
          nextTurn: { model: 'gpt-5.6-terra', effort: 'high' },
        },
      });
      const ctx = fx.makeCtx({ text: '/model gpt-5.6-terra' });
      ctx.chatConfig.codexModel = 'gpt-5.6-sol';
      ctx.chatConfig.codexEffort = 'high';

      await fx.dispatch(ctx);

      assert.equal(ctx.chatConfig.codexModel, 'gpt-5.6-terra');
      assert.match(fx.calls.sendReply[0], expected);
    });
  }

  test('unexpected PM failure keeps the durable pair and reports unknown live status', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
      selectModelSettingsError: new Error('unexpected PM failure'),
    });
    const ctx = fx.makeCtx({ text: '/effort xhigh' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'high';

    await fx.dispatch(ctx);

    assert.equal(ctx.chatConfig.codexEffort, 'xhigh');
    assert.equal(fx.calls.db.configChanges.length, 1);
    assert.match(fx.calls.sendReply[0], /durabl.*live status is unknown/i);
  });

  test('releases the session intent lock before Telegram reply rendering', async () => {
    let held = false;
    const fx = fixture({
      resolveRuntimeView: async () => {
        assert.equal(held, true);
        return codexView;
      },
      intentLock: {
        async acquire(key) {
          assert.equal(key, 'sk:999');
          held = true;
          return () => { held = false; };
        },
      },
      selectModelSettings: async () => {
        assert.equal(held, true);
        return {
          outcome: 'not-loaded',
          nextTurn: { model: 'gpt-5.6-terra', effort: 'high' },
        };
      },
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.6-terra' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'high';
    ctx.sendReply = async (text) => {
      assert.equal(held, false);
      fx.calls.sendReply.push(text);
    };

    await fx.dispatch(ctx);
    assert.match(fx.calls.sendReply[0], /next session/i);
    assert.equal(
      fx.calls.pmCalls.some((call) => call.kind === 'selectModelSettings'),
      true,
    );
  });

  test('/model rejects a Claude alias missing from the authenticated Codex catalog', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
    });
    const ctx = fx.makeCtx({ text: '/model opus' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    await fx.dispatch(ctx);
    assert.match(fx.calls.sendReply[0], /Unknown model/);
    assert.equal(fx.calls.db.configChanges.length, 0);
    assert.equal(ctx.chatConfig.codexModel, 'gpt-5.6-sol');
  });

  test('/model rejects an authenticated model outside the compact product set without side effects', async () => {
    let saves = 0;
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
      saveConfig: () => { saves += 1; },
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.5' });
    ctx.chatConfig.codexModel = 'gpt-5.6-sol';
    ctx.chatConfig.codexEffort = 'high';

    await fx.dispatch(ctx);

    assert.match(fx.calls.sendReply[0], /Unknown model/);
    assert.equal(ctx.chatConfig.codexModel, 'gpt-5.6-sol');
    assert.equal(ctx.chatConfig.codexEffort, 'high');
    assert.equal(saves, 0);
    assert.equal(fx.calls.db.configChanges.length, 0);
    assert.equal(
      fx.calls.pmCalls.some((call) => call.kind === 'selectModelSettings'),
      false,
    );
  });

  test('Codex topic change writes only the topic codexModel override', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => codexView,
    });
    const ctx = fx.makeCtx({ text: '/model gpt-5.6-luna' });
    ctx.threadIdStr = '3';
    ctx.chatConfig = {
      model: 'sonnet',
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'xhigh',
      isolateTopics: true,
      topics: {
        '3': {
          name: 'Music',
          model: 'opus',
          codexEffort: 'xhigh',
        },
      },
    };
    await fx.dispatch(ctx);
    assert.equal(ctx.chatConfig.topics['3'].codexModel, 'gpt-5.6-luna');
    assert.equal(ctx.chatConfig.topics['3'].codexEffort, 'high');
    assert.equal(ctx.chatConfig.topics['3'].model, 'opus');
    assert.equal(ctx.chatConfig.codexModel, 'gpt-5.6-sol');
    assert.equal(ctx.chatConfig.codexEffort, 'xhigh');
    assert.equal(fx.calls.db.configChanges[0].thread_id, '3');
    assert.deepEqual(
      fx.calls.db.configChanges.map((change) => change.field),
      ['model', 'effort'],
    );
  });

  test('an explicit Claude runtime view retains the legacy effort field and live apply', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => ({ runtime: 'claude' }),
    });
    const ctx = fx.makeCtx({ text: '/effort high' });
    await fx.dispatch(ctx);
    assert.equal(ctx.chatConfig.effort, 'high');
    assert.equal(ctx.chatConfig.codexEffort, undefined);
    assert.equal(
      fx.calls.pmCalls.some((call) => call.kind === 'applyFlag'),
      true,
    );
  });
});

describe('slash-commands — pairing admin gates', () => {
  test('/pair-code from non-admin chat is rejected', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/pair-code', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /admin-only/);
  });

  test('/pair-code from admin chat issues code and logs event', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/pair-code scope=user', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /Code: CODE-123/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'pair-code-issued'));
  });

  test('/pairings from admin chat shows No active pairings when empty', async () => {
    const fx = fixture({ activePairings: [] });
    await fx.dispatch(fx.makeCtx({ text: '/pairings', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /No active pairings/);
  });

  test('/pairings from admin chat lists rows', async () => {
    const fx = fixture({
      activePairings: [
        { user_id: 42, chat_id: '111', granted_ts: 1700000000000, note: null },
        { user_id: 99, chat_id: null, granted_ts: 1700000001000, note: 'all chats' },
      ],
    });
    await fx.dispatch(fx.makeCtx({ text: '/pairings', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /Active pairings \(2\)/);
    assert.match(fx.calls.sendReply[0], /user 42/);
    assert.match(fx.calls.sendReply[0], /any chat/);
  });

  test('/unpair: parses target_id and reports count', async () => {
    const fx = fixture({ revokeCount: 3 });
    await fx.dispatch(fx.makeCtx({ text: '/unpair 42', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /Revoked 3 pairing/);
  });

  test('/unpair: bad target_id then usage hint', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/unpair notanumber', chatId: '999' }));
    assert.match(fx.calls.sendReply[0], /Usage: \/unpair/);
  });
});

describe('slash-commands — /pair (open)', () => {
  test('successful claim: chat-scoped pairing', async () => {
    const fx = fixture({ claimResult: { ok: true, chat_id: '111' } });
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /Paired. You can use me in chat 111/);
  });

  test('successful claim: defensive fallback when result has no chat', async () => {
    // claimCode no longer returns a null chat_id — pairings are always chat-scoped
    // now (the all-chats footgun is closed) — so this exercises the handler's
    // defensive fallback wording rather than the old "every chat" message.
    const fx = fixture({ claimResult: { ok: true, chat_id: null } });
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /this chat/);
  });

  test('rate-limited claim: distinct UX message', async () => {
    const fx = fixture({ claimResult: { ok: false, reason: 'rate-limited' } });
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /Too many attempts/);
  });

  test('expired/invalid claim: collapsed UX message', async () => {
    const fx = fixture({ claimResult: { ok: false, reason: 'expired' } });
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /invalid or expired/);
  });

  test('no user id on request then rejects', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/pair CODE-123', userId: null, chatId: '111' }));
    assert.match(fx.calls.sendReply[0], /No user id/);
  });
});

describe('slash-commands — /compact', () => {
  test('Codex reports compaction as unsupported without mutating the thread', async () => {
    const fx = fixture({
      resolveRuntimeView: async () => ({
        runtime: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });
    await fx.dispatch(fx.makeCtx({ text: '/compact' }));
    assert.match(fx.calls.sendReply[0], /Codex/i);
    assert.match(fx.calls.sendReply[0], /not supported/i);
    assert.equal(
      fx.calls.pmCalls.some((call) => call.kind === 'push'),
      false,
    );
  });

  test('with active session: pushes /compact text and replies', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/compact' }));
    const push = fx.calls.pmCalls.find((c) => c.kind === 'push');
    assert.ok(push);
    assert.equal(push.m.message.content, '/compact');
    assert.match(fx.calls.sendReply[0], /Compacting/);
    assert.ok(fx.calls.events.some((e) => e.kind === 'compact-command'));
  });

  test('with hint: replies with hint suffix', async () => {
    const fx = fixture();
    await fx.dispatch(fx.makeCtx({ text: '/compact preserve everything about Q4' }));
    assert.match(fx.calls.sendReply[0], /with your hint/);
  });

  test('without session AND no saved id: no-conversation hint', async () => {
    const fx = fixture({ pmEntry: null, savedSessionId: null });
    await fx.dispatch(fx.makeCtx({ text: '/compact' }));
    assert.match(fx.calls.sendReply[0], /No conversation to compact/);
  });

  test('without session BUT saved id: auto-spawn-resume and log compact-spawn-resumed', async () => {
    // Post-0.10.0-P0.3: slash-commands routes through Process.fireUserMessage.
    const spawned = {
      fireUserMessage: () => true,
    };
    const fx = fixture({ pmEntry: null, savedSessionId: 'sess-abc', spawnEntry: spawned });
    await fx.dispatch(fx.makeCtx({ text: '/compact' }));
    assert.ok(fx.calls.events.some((e) => e.kind === 'compact-spawn-resumed'));
    assert.match(fx.calls.sendReply[0], /Compacting/);
  });
});

describe('slash-commands — /model /effort scope + persistence (2026-06-12 topic bug)', () => {
  test('/model X in a topic writes the TOPIC override + persists, not the chat root', async () => {
    const saved = [];
    const fx = fixture({ saveConfig: () => saved.push(true) });
    const ctx = fx.makeCtx({ text: '/model opus' });
    ctx.threadIdStr = '3';
    ctx.chatConfig = { model: 'sonnet', effort: 'high', isolateTopics: true, topics: { '3': { name: 'Music' } } };
    await fx.dispatch(ctx);
    assert.equal(ctx.chatConfig.topics['3'].model, 'opus', 'topic gets its own model');
    assert.equal(ctx.chatConfig.model, 'sonnet', 'chat root unchanged (no leak)');
    assert.equal(saved.length, 1, 'persisted to disk → survives restart');
    assert.equal(fx.calls.db.configChanges[0].thread_id, '3', 'audit row records the topic');
  });

  test('/effort X at the chat level still writes the chat root + persists', async () => {
    const saved = [];
    const fx = fixture({ saveConfig: () => saved.push(true) });
    const ctx = fx.makeCtx({ text: '/effort max' });   // threadIdStr null
    await fx.dispatch(ctx);
    assert.equal(ctx.chatConfig.effort, 'max');
    assert.equal(saved.length, 1);
  });
});

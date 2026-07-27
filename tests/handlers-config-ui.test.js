'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildConfigKeyboard,
  createFormatConfigInfoText,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  MODEL_VERSIONS_DESC,
} = require('../lib/handlers/config-ui');

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

describe('buildConfigKeyboard', () => {
  test('show=all renders model + effort + rich-text rows with current values marked', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high' }, 'all');
    assert.equal(kb.inline_keyboard.length, 3);
    const modelRow = kb.inline_keyboard[0];
    assert.equal(modelRow.length, MODEL_OPTIONS.length);
    const sonnet = modelRow.find((b) => b.callback_data === 'cfg:model:sonnet');
    assert.match(sonnet.text, /^✓ sonnet$/);
    const opus = modelRow.find((b) => b.callback_data === 'cfg:model:opus');
    assert.equal(opus.text, 'opus');

    const effortRow = kb.inline_keyboard[1];
    const high = effortRow.find((b) => b.callback_data === 'cfg:effort:high');
    assert.match(high.text, /^✓ high$/);

    const richTextRow = kb.inline_keyboard[2];
    assert.equal(richTextRow.length, 1);
    assert.equal(richTextRow[0].callback_data, 'cfg:richtext:on');
    assert.match(richTextRow[0].text, /off$/);
  });

  test('rich-text row toggles: on when set, callback flips to off', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high', richText: true }, 'all');
    const richTextRow = kb.inline_keyboard[2];
    assert.equal(richTextRow[0].callback_data, 'cfg:richtext:off');
    assert.match(richTextRow[0].text, /^✓ Rich text: on$/);
  });

  test('rich-text row is NOT shown for show=model or show=effort (no new command surface)', () => {
    const kbModel = buildConfigKeyboard({ model: 'opus', effort: 'low' }, 'model');
    const kbEffort = buildConfigKeyboard({ model: 'opus', effort: 'low' }, 'effort');
    assert.equal(kbModel.inline_keyboard.length, 1);
    assert.equal(kbEffort.inline_keyboard.length, 1);
  });

  test('a topic-level richText override takes precedence over chat-level for the ✓ marker', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high', richText: false }, 'all', { richText: true });
    assert.match(kb.inline_keyboard[2][0].text, /^✓ Rich text: on$/);
  });

  test('an inherited effective rich-text value shows ✓ on the card', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high' }, 'all', null, true);
    assert.match(kb.inline_keyboard[2][0].text, /^✓ Rich text: on$/);
  });

  test('an explicit effective false overrides local values in the card', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high', richText: true }, 'all', null, false);
    assert.match(kb.inline_keyboard[2][0].text, /off$/);
    assert.equal(kb.inline_keyboard[2][0].callback_data, 'cfg:richtext:on');
  });

  test('no effective value passed falls back to chat/topic only, defaults to off', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high' }, 'all');
    assert.match(kb.inline_keyboard[2][0].text, /off$/);
  });

  test('show=model only renders the model row', () => {
    const kb = buildConfigKeyboard({ model: 'opus', effort: 'low' }, 'model');
    assert.equal(kb.inline_keyboard.length, 1);
    assert.match(kb.inline_keyboard[0][0].text, /opus/);
  });

  test('show=effort only renders the effort row', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'low' }, 'effort');
    assert.equal(kb.inline_keyboard.length, 1);
    const low = kb.inline_keyboard[0].find((b) => b.callback_data === 'cfg:effort:low');
    assert.match(low.text, /^✓ low$/);
  });

  test('default show is all', () => {
    const kb = buildConfigKeyboard({ model: 'haiku', effort: 'medium' });
    assert.equal(kb.inline_keyboard.length, 3);
  });

  test('every model option produces a button with cfg:model:* callback_data', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'medium' }, 'model');
    const data = kb.inline_keyboard[0].map((b) => b.callback_data);
    for (const m of MODEL_OPTIONS) {
      assert.ok(data.includes('cfg:model:' + m), 'missing cfg:model:' + m);
    }
  });

  test('every effort option produces a button with cfg:effort:* callback_data', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'medium' }, 'effort');
    const data = kb.inline_keyboard[0].map((b) => b.callback_data);
    for (const e of EFFORT_OPTIONS) {
      assert.ok(data.includes('cfg:effort:' + e), 'missing cfg:effort:' + e);
    }
  });

  test('Codex card uses only authenticated model and per-model effort options', () => {
    const kb = buildConfigKeyboard({
      model: 'sonnet',
      effort: 'max',
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'xhigh',
    }, 'all', null, false, CODEX_VIEW);
    assert.deepEqual(
      kb.inline_keyboard[0].map((button) => button.callback_data),
      ['cfg:model:gpt-5.6-sol', 'cfg:model:gpt-5.5'],
    );
    assert.match(kb.inline_keyboard[0][0].text, /^✓ GPT-5\.6 SOL$/);
    assert.deepEqual(
      kb.inline_keyboard[1].map((button) => button.callback_data),
      ['cfg:effort:high', 'cfg:effort:xhigh'],
    );
    assert.match(kb.inline_keyboard[1][1].text, /^✓ xhigh$/);
  });
});

describe('createFormatConfigInfoText', () => {
  function buildFormat({ alive = true, savedSessionId = 'sess-12345678-rest' } = {}) {
    const pm = {
      has: () => alive,
      get: () => ({ closed: !alive }),
    };
    return createFormatConfigInfoText({
      pm,
      db: { _placeholder: true },
      getClaudeSessionId: () => savedSessionId,
    });
  }

  test('header lines: model + version + effort + agent + process + session', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'sonnet', effort: 'high', agent: 'shumabit' }, 'all', 'sk');
    assert.match(out, /^Model: sonnet \(claude-sonnet-4-6\)/m);
    assert.match(out, /^Effort: high/m);
    assert.match(out, /^Agent: shumabit/m);
    assert.match(out, /^Process: warm/m);
    assert.match(out, /^Session: sess-123/m);
  });

  test('cold process when pm.has=false', () => {
    const fmt = buildFormat({ alive: false });
    const out = fmt({ model: 'opus', effort: 'low', agent: 'x' }, 'all', 'sk');
    assert.match(out, /Process: cold/);
  });

  test('Session: new when no saved id', () => {
    const fmt = buildFormat({ savedSessionId: null });
    const out = fmt({ model: 'opus', effort: 'low', agent: 'x' }, 'all', 'sk');
    assert.match(out, /Session: new/);
  });

  test('richText line reflects an inherited effective value', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'sonnet', effort: 'high', agent: 'x' }, 'all', 'sk', null, true);
    assert.match(out, /^Rich text: on/m);
  });

  test('an explicit effective false overrides local values in the info text', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'sonnet', effort: 'high', agent: 'x', richText: true }, 'all', 'sk', null, false);
    assert.match(out, /^Rich text: off/m);
  });

  test('no effective value passed defaults to off without crashing', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'sonnet', effort: 'high', agent: 'x' }, 'all', 'sk');
    assert.match(out, /^Rich text: off/m);
  });

  test('show=model omits effort help block', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'sonnet', effort: 'medium', agent: 'x' }, 'model', 'sk');
    assert.match(out, /\*\*Models\*\*/);
    assert.doesNotMatch(out, /\*\*Effort\*\*/);
  });

  test('show=effort omits model help block', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'sonnet', effort: 'medium', agent: 'x' }, 'effort', 'sk');
    assert.doesNotMatch(out, /\*\*Models\*\*/);
    assert.match(out, /\*\*Effort\*\*/);
  });

  test('show=all renders both help blocks', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'sonnet', effort: 'medium', agent: 'x' }, 'all', 'sk');
    assert.match(out, /\*\*Models\*\*/);
    assert.match(out, /\*\*Effort\*\*/);
  });

  test('unknown model alias falls back to its own name', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'mystery', effort: 'medium', agent: 'x' }, 'all', 'sk');
    assert.match(out, /Model: mystery \(mystery\)/);
  });

  test('async runtime resolver renders explicit Codex selected, observed, and active-turn fields', async () => {
    const calls = [];
    const fmt = createFormatConfigInfoText({
      pm: {
        has: () => true,
        get: () => ({
          closed: false,
          // These legacy fields are intentionally misleading. Codex UI must
          // use the explicit settings projections instead.
          model: 'must-not-render',
          effort: 'must-not-render',
        }),
      },
      db: {},
      getClaudeSessionId: () => {
        throw new Error('Codex card must not read the dormant Claude row');
      },
      resolveRuntimeView: async (context) => {
        calls.push(context);
        return {
          ...CODEX_VIEW,
          desiredSettings: {
            model: 'gpt-5.6-sol',
            effort: 'high',
          },
          observedThreadSettings: {
            model: 'gpt-5.5',
            effort: 'medium',
          },
          activeTurnSettings: {
            model: 'gpt-5.5',
            effort: 'medium',
          },
          nextTurnSettings: {
            model: 'gpt-5.6-sol',
            effort: 'high',
          },
          processStatus: 'loaded',
        };
      },
    });
    const out = await fmt({
      model: 'sonnet',
      effort: 'max',
      agent: 'claude-agent',
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'high',
    }, 'all', '42:7');

    assert.deepEqual(calls, [{
      sessionKey: '42:7',
      chatId: '42',
      threadId: '7',
    }]);
    assert.match(out, /Current turn: gpt-5\.5\/medium/);
    assert.match(out, /Next turn: gpt-5\.6-sol\/high/);
    assert.match(out, /Observed thread: gpt-5\.5\/medium/);
    assert.doesNotMatch(out, /must-not-render/);
    assert.doesNotMatch(out, /controlled session replacement/);
    assert.match(out, /^Runtime: Codex app-server$/m);
    assert.match(out, /^Session: managed by Codex$/m);
    assert.match(out, /Native macOS beta/);
    assert.match(out, /network and web search are disabled/);
    assert.match(out, /Product MCP tools and interactive approvals are unavailable/);
    assert.match(out, /Detached\/background servers are unsupported/);
    assert.match(out, /\*\*gpt-5\.6-sol\*\* — GPT-5\.6 SOL/);
    assert.doesNotMatch(out, /Agent: claude-agent/);
    assert.doesNotMatch(out, /deep analysis, code refactor/);
  });

  test('Codex card exposes a saved selection that the warm process has not accepted', () => {
    const fmt = createFormatConfigInfoText({
      pm: {
        has: () => true,
        get: () => ({ closed: false }),
      },
      db: {},
      getClaudeSessionId: () => null,
    });
    const out = fmt({
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'xhigh',
    }, 'all', 'sk', null, false, {
      ...CODEX_VIEW,
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      desiredSettings: {
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      },
      nextTurnSettings: {
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      observedThreadSettings: null,
      activeTurnSettings: null,
      processStatus: 'loaded',
    });

    assert.match(out, /Selected for next turn: gpt-5\.6-sol\/high/);
    assert.match(
      out,
      /Saved selection awaiting live reconciliation: gpt-5\.6-sol\/xhigh/,
    );
  });

  for (const [processStatus, expected] of [
    ['not-loaded', /Selected for this chat's next session: gpt-5\.6-sol\/high/],
    ['daemon-busy', /Selected: gpt-5\.6-sol\/high[\s\S]*not loaded; its next message may be busy/],
    ['unavailable', /Selected: gpt-5\.6-sol\/high[\s\S]*Process: unavailable \(containment\)/],
  ]) {
    test(`Codex ${processStatus} card copy is explicit`, () => {
      const fmt = createFormatConfigInfoText({
        pm: { has: () => false, get: () => null },
        db: {},
        getClaudeSessionId: () => {
          throw new Error('Codex card must not read Claude state');
        },
      });
      const out = fmt({
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'high',
      }, 'all', 'sk', null, false, {
        ...CODEX_VIEW,
        desiredSettings: {
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
        observedThreadSettings: null,
        activeTurnSettings: null,
        processStatus,
        ...(processStatus === 'unavailable' && {
          unavailableReason: 'containment',
        }),
      });
      assert.match(out, expected);
    });
  }

  test('an async Claude runtime view produces the exact legacy card', async () => {
    const deps = {
      pm: { has: () => false, get: () => null },
      db: {},
      getClaudeSessionId: () => 'sess-12345678-rest',
    };
    const legacy = createFormatConfigInfoText(deps);
    const resolved = createFormatConfigInfoText({
      ...deps,
      resolveRuntimeView: async () => ({ runtime: 'claude' }),
    });
    const chat = { model: 'sonnet', effort: 'high', agent: 'shumabit' };
    assert.equal(
      await resolved(chat, 'all', '42'),
      legacy(chat, 'all', '42'),
    );
  });
});

describe('MODEL_VERSIONS_DESC', () => {
  test('contains all current aliases', () => {
    for (const alias of MODEL_OPTIONS) {
      assert.ok(MODEL_VERSIONS_DESC[alias], 'missing version desc for ' + alias);
    }
  });

  test('versions are claude-* strings', () => {
    for (const v of Object.values(MODEL_VERSIONS_DESC)) {
      assert.match(v, /^claude-/);
    }
  });
});

describe('config card — per-topic override resolution (Music topic /model bug, 2026-06-03)', () => {
  // The Music topic (thread 3) overrides agent → music-curation:music-curator,
  // but /model rendered the chat-level "Agent: shumabit" because the card read
  // chatConfig directly. The card must resolve topic > chat for the displayed
  // agent/model/effort, mirroring the spawn path. Before the fix the new
  // `topicConfig` arg didn't exist and these asserts fail (chat-level leaks).
  function buildFormat() {
    return createFormatConfigInfoText({
      pm: { has: () => true, get: () => ({ closed: false }) },
      db: {},
      getClaudeSessionId: () => 'sess-abcd1234',
    });
  }

  test('topic agent override wins over chat-level in the card', () => {
    const fmt = buildFormat();
    const chatConfig = { model: 'sonnet', effort: 'high', agent: 'shumabit' };
    const out = fmt(chatConfig, 'all', 'sk', { agent: 'music-curation:music-curator' });
    assert.match(out, /^Agent: music-curation:music-curator/m, 'must show the topic agent');
    assert.doesNotMatch(out, /Agent: shumabit/, 'must NOT leak the chat-level agent');
  });

  test('topic model + effort overrides win in card AND keyboard ✓', () => {
    const fmt = buildFormat();
    const chatConfig = { model: 'sonnet', effort: 'high', agent: 'x' };
    const topicConfig = { model: 'opus', effort: 'max' };
    const out = fmt(chatConfig, 'all', 'sk', topicConfig);
    assert.match(out, /^Model: opus/m);
    assert.match(out, /^Effort: max/m);
    const modelRow = buildConfigKeyboard(chatConfig, 'all', topicConfig).inline_keyboard[0];
    assert.match(modelRow.find((b) => b.callback_data === 'cfg:model:opus').text, /^✓ opus$/);
    assert.equal(modelRow.find((b) => b.callback_data === 'cfg:model:sonnet').text, 'sonnet');
  });

  test('no topic / empty / partial overrides fall back to chat-level (backward compat)', () => {
    const fmt = buildFormat();
    const chatConfig = { model: 'sonnet', effort: 'high', agent: 'shumabit' };
    assert.match(fmt(chatConfig, 'all', 'sk', null), /^Agent: shumabit/m);
    assert.match(fmt(chatConfig, 'all', 'sk', {}), /^Agent: shumabit/m);
    assert.match(buildConfigKeyboard(chatConfig, 'all').inline_keyboard[0]
      .find((b) => b.callback_data === 'cfg:model:sonnet').text, /^✓ sonnet$/);
    // partial override: topic sets only agent → model/effort stay chat-level
    const out = fmt(chatConfig, 'all', 'sk', { agent: 'curator' });
    assert.match(out, /^Agent: curator/m);
    assert.match(out, /^Model: sonnet/m);
    assert.match(out, /^Effort: high/m);
  });
});

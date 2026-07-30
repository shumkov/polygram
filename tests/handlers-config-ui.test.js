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
    assert.equal(kb.inline_keyboard.length, 4);
    assert.deepEqual(kb.inline_keyboard[0], [
      { text: 'Claude', callback_data: 'cfg:runtime:cli' },
      { text: 'Codex', callback_data: 'cfg:runtime:codex' },
    ]);
    const modelRow = kb.inline_keyboard[1];
    assert.equal(modelRow.length, MODEL_OPTIONS.length);
    const sonnet = modelRow.find((b) => b.callback_data === 'cfg:model:sonnet');
    assert.match(sonnet.text, /^✓ sonnet$/);
    const opus = modelRow.find((b) => b.callback_data === 'cfg:model:opus');
    assert.equal(opus.text, 'opus');

    const effortRow = kb.inline_keyboard[2];
    const high = effortRow.find((b) => b.callback_data === 'cfg:effort:high');
    assert.match(high.text, /^✓ high$/);

    const richTextRow = kb.inline_keyboard[3];
    assert.equal(richTextRow.length, 1);
    assert.equal(richTextRow[0].callback_data, 'cfg:richtext:on');
    assert.match(richTextRow[0].text, /off$/);
  });

  test('the SDK backend has no button, and a chat already on it renders fine', () => {
    // SDK is a per-token backend nobody selects from the card, so the button is
    // gone — but the backend itself is still supported in config. Such a chat
    // must still get a card; its runtime row simply carries no ✓.
    const kb = buildConfigKeyboard(
      { model: 'sonnet', effort: 'high' },
      'all',
      null,
      false,
      { runtime: 'claude', backend: 'sdk', selectionSource: 'chat' },
    );
    assert.deepEqual(
      kb.inline_keyboard[0].map((button) => button.callback_data),
      ['cfg:runtime:cli', 'cfg:runtime:codex'],
    );
    assert.equal(
      kb.inline_keyboard.flat().some((button) => button.text.startsWith('✓ Claude')),
      false,
      'no runtime button may claim to be the current one',
    );
    // The rest of the card is unaffected — model/effort/rich-text rows intact.
    assert.equal(kb.inline_keyboard.length, 4);
  });

  test('rich-text row toggles: on when set, callback flips to off', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high', richText: true }, 'all');
    const richTextRow = kb.inline_keyboard[3];
    assert.equal(richTextRow[0].callback_data, 'cfg:richtext:off');
    assert.match(richTextRow[0].text, /^✓ Rich text: on$/);
  });

  test('rich-text row is NOT shown for show=model or show=effort (no new command surface)', () => {
    const kbModel = buildConfigKeyboard({ model: 'opus', effort: 'low' }, 'model');
    const kbEffort = buildConfigKeyboard({ model: 'opus', effort: 'low' }, 'effort');
    assert.equal(kbModel.inline_keyboard.length, 1);
    assert.equal(kbEffort.inline_keyboard.length, 1);
  });

  test('runtime row is shown only on the full card and marks the canonical backend', () => {
    const cli = buildConfigKeyboard(
      { model: 'sonnet', effort: 'high' },
      'all',
      null,
      false,
      { runtime: 'claude', backend: 'cli' },
    );
    assert.deepEqual(cli.inline_keyboard[0], [
      { text: '✓ Claude', callback_data: 'cfg:runtime:cli' },
      { text: 'Codex', callback_data: 'cfg:runtime:codex' },
    ]);

    const codex = buildConfigKeyboard(
      { codexModel: 'gpt-5.6-sol', codexEffort: 'high' },
      'all',
      null,
      false,
      CODEX_VIEW,
    );
    assert.match(codex.inline_keyboard[0][1].text, /^✓ Codex$/);

    const modelOnly = buildConfigKeyboard(
      { model: 'sonnet', effort: 'high' },
      'model',
      null,
      false,
      { runtime: 'claude', backend: 'cli' },
    );
    const effortOnly = buildConfigKeyboard(
      { model: 'sonnet', effort: 'high' },
      'effort',
      null,
      false,
      { runtime: 'claude', backend: 'cli' },
    );
    assert.equal(
      modelOnly.inline_keyboard.flat()
        .some((button) => button.callback_data.startsWith('cfg:runtime:')),
      false,
    );
    assert.equal(
      effortOnly.inline_keyboard.flat()
        .some((button) => button.callback_data.startsWith('cfg:runtime:')),
      false,
    );
  });

  test('unavailable Codex keeps runtime escape controls without empty Telegram rows', () => {
    const unavailable = {
      runtime: 'codex',
      backend: 'codex',
      model: null,
      effort: null,
      models: [],
      efforts: [],
      processStatus: 'unavailable',
      unavailableReason: 'CODEX_RUNTIME_UNAVAILABLE',
    };
    const kb = buildConfigKeyboard(
      {},
      'all',
      null,
      false,
      unavailable,
    );

    assert.deepEqual(
      kb.inline_keyboard.map((row) => row.map((button) => button.callback_data)),
      [
        ['cfg:runtime:cli', 'cfg:runtime:codex'],
        ['cfg:richtext:on'],
      ],
    );
    assert.equal(kb.inline_keyboard.some((row) => row.length === 0), false);
  });

  test('a topic-level richText override takes precedence over chat-level for the ✓ marker', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high', richText: false }, 'all', { richText: true });
    assert.match(kb.inline_keyboard[3][0].text, /^✓ Rich text: on$/);
  });

  test('an inherited effective rich-text value shows ✓ on the card', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high' }, 'all', null, true);
    assert.match(kb.inline_keyboard[3][0].text, /^✓ Rich text: on$/);
  });

  test('an explicit effective false overrides local values in the card', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high', richText: true }, 'all', null, false);
    assert.match(kb.inline_keyboard[3][0].text, /off$/);
    assert.equal(kb.inline_keyboard[3][0].callback_data, 'cfg:richtext:on');
  });

  test('no effective value passed falls back to chat/topic only, defaults to off', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high' }, 'all');
    assert.match(kb.inline_keyboard[3][0].text, /off$/);
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
    assert.equal(kb.inline_keyboard.length, 4);
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
      kb.inline_keyboard[1].map((button) => button.callback_data),
      ['cfg:model:gpt-5.6-sol', 'cfg:model:gpt-5.5'],
    );
    assert.match(kb.inline_keyboard[1][0].text, /^✓ GPT-5\.6 SOL$/);
    assert.deepEqual(
      kb.inline_keyboard[2].map((button) => button.callback_data),
      ['cfg:effort:high', 'cfg:effort:xhigh'],
    );
    assert.match(kb.inline_keyboard[2][1].text, /^✓ xhigh$/);
  });
});

// Every technical line the card used to print. The buttons below the card
// already show model, effort, runtime and rich-text state with a ✓, so the
// text was restating them — these patterns must never match a card body again.
const TECHNICAL_LINES = [
  [/^Model: /m, 'model line'],
  [/^Effort: [a-z]/m, 'effort line'],
  [/^Rich text[:.]/m, 'rich-text line'],
  [/^Runtime: /m, 'runtime line'],
  [/^Agent: /m, 'agent line'],
  [/^Process: /m, 'process line'],
  [/^Session: /m, 'session line'],
  [/\(running\)/, 'running-vs-configured drift'],
  [/pending — applies/, 'pending-change caveat'],
  [/next \(re\)spawns/, 'respawn caveat'],
  [/Current turn: /, 'Codex current-turn line'],
  [/Next turn: /, 'Codex next-turn line'],
  [/Observed thread: /, 'Codex observed-thread line'],
  [/^Selected/m, 'Codex selection line'],
];

function assertNoTechnicalLines(body) {
  for (const [pattern, what] of TECHNICAL_LINES) {
    assert.doesNotMatch(body, pattern, `card body still carries the ${what}`);
  }
}

describe('createFormatConfigInfoText', () => {
  // The formatter takes no process, db or session-id context — the card stopped
  // reporting any of it, so there is nothing to inject.
  function buildFormat() {
    return createFormatConfigInfoText();
  }

  test('the card body is a bare header — every technical line is gone', () => {
    const fmt = buildFormat();
    const out = fmt({ model: 'sonnet', effort: 'high', agent: 'shumabit' }, 'all', 'sk');
    assert.match(out, /^⚙️ Settings/);
    assertNoTechnicalLines(out);
  });

  test('the header is the floor — a card with no help block is still sendable', () => {
    // Telegram rejects an empty message. With the technical lines gone, an
    // unrecognized `show` would otherwise render nothing at all.
    const fmt = buildFormat();
    assert.equal(fmt({ model: 'sonnet', effort: 'high' }, 'unknown-show', 'sk'), '⚙️ Settings');
    for (const show of ['all', 'model', 'effort']) {
      assert.match(fmt({ model: 'sonnet', effort: 'high' }, show, 'sk'), /^⚙️ Settings/);
    }
  });

  test('process and session state cannot reach the card at all', () => {
    // The card used to read pm/db for warm-vs-cold and the session id. Those
    // lines are gone and so are the deps: a formatter built with no arguments
    // at all must still render every card.
    const fmt = createFormatConfigInfoText();
    for (const show of ['all', 'model', 'effort']) {
      const out = fmt({ model: 'opus', effort: 'low', agent: 'x' }, show, 'sk');
      assert.match(out, /^⚙️ Settings/);
      assertNoTechnicalLines(out);
    }
  });

  test('rich-text state no longer appears in the body, whatever it resolves to', () => {
    const fmt = buildFormat();
    for (const effective of [true, false, undefined]) {
      const out = fmt(
        { model: 'sonnet', effort: 'high', agent: 'x', richText: true },
        'all', 'sk', null, effective,
      );
      assertNoTechnicalLines(out);
    }
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

  test('async runtime resolver still decides which help blocks the card gets', async () => {
    const calls = [];
    const fmt = createFormatConfigInfoText({
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
    // The runtime view still decides Codex-vs-Claude: the beta warning and the
    // authenticated model catalog are Codex-only, and the Claude help must not
    // leak into a Codex card.
    assert.match(out, /Native Codex beta/);
    assert.doesNotMatch(out, /macOS/);
    assert.match(out, /network and web search are disabled/);
    assert.match(out, /Product MCP tools and interactive approvals are unavailable/);
    assert.match(out, /Detached\/background servers are unsupported/);
    assert.match(
      out,
      /Native goals are disabled for Polygram-managed Codex sessions until native goal support is implemented/,
    );
    assert.match(out, /\*\*gpt-5\.6-sol\*\* — GPT-5\.6 SOL/);
    assert.doesNotMatch(out, /deep analysis, code refactor/);
    assertNoTechnicalLines(out);
  });

  for (const processStatus of ['loaded', 'not-loaded', 'daemon-busy', 'unavailable']) {
    test(`Codex ${processStatus} renders the minimal card without process copy`, () => {
      // Process/selection state is what the card stopped saying. Each status
      // used to get its own sentence; now it changes nothing about the body.
      const fmt = createFormatConfigInfoText();
      const out = fmt({
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'high',
      }, 'all', 'sk', null, false, {
        ...CODEX_VIEW,
        desiredSettings: { model: 'gpt-5.6-sol', effort: 'high' },
        nextTurnSettings: { model: 'gpt-5.6-sol', effort: 'high' },
        observedThreadSettings: null,
        activeTurnSettings: null,
        processStatus,
        ...(processStatus === 'unavailable' && {
          unavailableReason: 'containment',
        }),
      });
      assert.match(out, /^⚙️ Settings/);
      assert.match(out, /Native Codex beta/);
      assert.doesNotMatch(out, /containment/, 'the unavailable reason was card copy');
      assert.doesNotMatch(out, /not loaded; its next message may be busy/);
      assert.doesNotMatch(out, /Saved selection awaiting live reconciliation/);
      assertNoTechnicalLines(out);
    });
  }

  test('an async Claude runtime view produces the exact legacy card', async () => {
    const legacy = createFormatConfigInfoText();
    const resolved = createFormatConfigInfoText({
      resolveRuntimeView: async () => ({ runtime: 'claude' }),
    });
    const chat = { model: 'sonnet', effort: 'high', agent: 'shumabit' };
    assert.equal(
      await resolved(chat, 'all', '42'),
      legacy(chat, 'all', '42'),
    );
  });

  test('no runtime, backend or selection source is named in the body', () => {
    // Which backend is current is a ✓ on the runtime row of the keyboard; the
    // card used to restate it, plus where in the config hierarchy it came from.
    const fmt = buildFormat();
    const chat = { model: 'sonnet', effort: 'high', agent: 'shumabit' };
    for (const view of [
      { runtime: 'claude', backend: 'sdk', selectionSource: 'chat' },
      { runtime: 'claude', backend: 'cli', selectionSource: 'topic' },
      { ...CODEX_VIEW, selectionSource: 'bot' },
    ]) {
      const out = fmt(chat, 'all', '42', null, false, view);
      assertNoTechnicalLines(out);
      assert.doesNotMatch(out, /source: (chat|topic|bot)/);
    }
  });

  test('unavailable incomplete Codex card remains readable and switchable', () => {
    const fmt = buildFormat();
    const out = fmt({}, 'all', '42', null, false, {
      runtime: 'codex',
      backend: 'codex',
      model: null,
      effort: null,
      models: [],
      efforts: [],
      processStatus: 'unavailable',
      unavailableReason: 'CODEX_RUNTIME_UNAVAILABLE',
    });

    assert.match(out, /^⚙️ Settings/);
    assert.match(out, /Models are unavailable until Codex preflight succeeds/);
    assert.match(out, /Effort options are unavailable until Codex preflight succeeds/);
    assert.doesNotMatch(out, /\bnull\/null\b/);
    assert.doesNotMatch(out, /incomplete Codex selection/);
    assertNoTechnicalLines(out);
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

  // `/model opus` tells the user which concrete model the alias runs. That
  // answer comes from the pinned claude CLI, not from us — the pinned 2.1.220
  // resolves `--model opus` to claude-opus-5 (2.1.173 resolved it to
  // claude-opus-4-8). A generic /^claude-/ assertion lets the mapping rot
  // silently through a CLI bump, and the reply then names a model the session
  // isn't running.
  test('opus names the model the pinned CLI actually resolves it to', () => {
    assert.equal(MODEL_VERSIONS_DESC.opus, 'claude-opus-5');
  });
});

describe('config card — per-topic override resolution (Music topic /model bug, 2026-06-03)', () => {
  // The Music topic (thread 3) overrides agent → music-curation:music-curator,
  // but /model rendered the chat-level "Agent: shumabit" because the card read
  // chatConfig directly. The card body no longer names any of it, so the whole
  // class of leak is now pinned as absence — and the ✓ markers, which are what
  // the user reads instead, carry the topic > chat precedence.
  function buildFormat() {
    return createFormatConfigInfoText();
  }

  test('neither topic nor chat values can leak into the card body', () => {
    const fmt = buildFormat();
    const chatConfig = { model: 'sonnet', effort: 'high', agent: 'shumabit' };
    for (const topicConfig of [
      { agent: 'music-curation:music-curator', model: 'opus', effort: 'max' },
      { agent: 'curator' },
      {},
      null,
    ]) {
      const out = fmt(chatConfig, 'all', 'sk', topicConfig);
      assertNoTechnicalLines(out);
      assert.doesNotMatch(out, /shumabit|music-curator|curator/);
    }
  });

  test('topic model + effort overrides still win the keyboard ✓', () => {
    const chatConfig = { model: 'sonnet', effort: 'high', agent: 'x' };
    const topicConfig = { model: 'opus', effort: 'max' };
    const modelRow = buildConfigKeyboard(chatConfig, 'all', topicConfig).inline_keyboard[1];
    assert.match(modelRow.find((b) => b.callback_data === 'cfg:model:opus').text, /^✓ opus$/);
    assert.equal(modelRow.find((b) => b.callback_data === 'cfg:model:sonnet').text, 'sonnet');
    const effortRow = buildConfigKeyboard(chatConfig, 'all', topicConfig).inline_keyboard[2];
    assert.match(effortRow.find((b) => b.callback_data === 'cfg:effort:max').text, /^✓ max$/);
  });

  test('no topic override falls back to chat-level for the ✓ (backward compat)', () => {
    const chatConfig = { model: 'sonnet', effort: 'high', agent: 'shumabit' };
    assert.match(buildConfigKeyboard(chatConfig, 'all').inline_keyboard[1]
      .find((b) => b.callback_data === 'cfg:model:sonnet').text, /^✓ sonnet$/);
    // partial override: topic sets only agent → model/effort stay chat-level
    assert.match(buildConfigKeyboard(chatConfig, 'all', { agent: 'curator' }).inline_keyboard[1]
      .find((b) => b.callback_data === 'cfg:model:sonnet').text, /^✓ sonnet$/);
  });
});

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

describe('buildConfigKeyboard', () => {
  test('show=all renders both rows with current values marked', () => {
    const kb = buildConfigKeyboard({ model: 'sonnet', effort: 'high' }, 'all');
    assert.equal(kb.inline_keyboard.length, 2);
    const modelRow = kb.inline_keyboard[0];
    assert.equal(modelRow.length, MODEL_OPTIONS.length);
    const sonnet = modelRow.find((b) => b.callback_data === 'cfg:model:sonnet');
    assert.match(sonnet.text, /^✓ sonnet$/);
    const opus = modelRow.find((b) => b.callback_data === 'cfg:model:opus');
    assert.equal(opus.text, 'opus');

    const effortRow = kb.inline_keyboard[1];
    const high = effortRow.find((b) => b.callback_data === 'cfg:effort:high');
    assert.match(high.text, /^✓ high$/);
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
    assert.equal(kb.inline_keyboard.length, 2);
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

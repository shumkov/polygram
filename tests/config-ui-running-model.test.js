'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFormatConfigInfoText } = require('../lib/handlers/config-ui');

function fmt({ procModel, procEffort, alive = true } = {}) {
  const proc = { model: procModel, effort: procEffort, closed: false };
  const pm = { has: () => alive, get: () => (alive ? proc : null) };
  return createFormatConfigInfoText({ pm, db: {}, getClaudeSessionId: () => 'abcdef1234567890' });
}

describe('config card — running vs configured model/effort (cli reload-pending)', () => {
  test('model drift → "sonnet (running) → opus (pending)"', () => {
    const f = fmt({ procModel: 'sonnet' });
    const body = f({ model: 'opus', effort: 'high' }, 'all', 'sk');
    assert.match(body, /Model: sonnet \(running\) → opus \(pending — applies on your next message\)/);
  });

  test('matched model → plain "Model: opus (ver)", no running line', () => {
    const f = fmt({ procModel: 'opus' });
    const body = f({ model: 'opus', effort: 'high' }, 'all', 'sk');
    assert.match(body, /Model: opus \(claude-opus-4-7\)/);
    assert.doesNotMatch(body, /running/);
  });

  test('no live proc (cold) → plain configured model, no running line', () => {
    const f = fmt({ procModel: 'sonnet', alive: false });
    const body = f({ model: 'opus', effort: 'high' }, 'all', 'sk');
    assert.match(body, /Model: opus \(claude-opus-4-7\)/);
    assert.doesNotMatch(body, /running/);
  });

  test('effort drift → "high (running) → max (pending)"', () => {
    const f = fmt({ procModel: 'opus', procEffort: 'high' });
    const body = f({ model: 'opus', effort: 'max' }, 'all', 'sk');
    assert.match(body, /Effort: high \(running\) → max \(pending — applies on your next message\)/);
  });
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFormatConfigInfoText } = require('../lib/handlers/config-ui');

// The card used to compare the live proc's spawn-time model/effort against the
// configured ones and print "sonnet (running) → opus (pending — applies on your
// next message)". The body carries no settings at all now, so the comparison
// and every phrasing of it must be gone — including for a live proc that really
// has drifted, which is the case that used to produce the line.
function fmt({ procModel, procEffort, alive = true } = {}) {
  const proc = { model: procModel, effort: procEffort, closed: false };
  const pm = { has: () => alive, get: () => (alive ? proc : null) };
  return createFormatConfigInfoText({ pm, db: {}, getClaudeSessionId: () => 'abcdef1234567890' });
}

describe('config card — the running-vs-configured lines are gone', () => {
  for (const [name, deps, chatConfig] of [
    ['model drift', { procModel: 'sonnet' }, { model: 'opus', effort: 'high' }],
    ['effort drift', { procModel: 'opus', procEffort: 'high' }, { model: 'opus', effort: 'max' }],
    ['no drift', { procModel: 'opus', procEffort: 'high' }, { model: 'opus', effort: 'high' }],
    ['cold process', { procModel: 'sonnet', alive: false }, { model: 'opus', effort: 'high' }],
  ]) {
    test(`${name} → a bare header, no settings, no drift copy`, () => {
      const body = fmt(deps)(chatConfig, 'all', 'sk');
      assert.match(body, /^⚙️ Settings/);
      assert.doesNotMatch(body, /running/);
      assert.doesNotMatch(body, /pending/);
      assert.doesNotMatch(body, /^Model: /m);
      assert.doesNotMatch(body, /^Effort: [a-z]/m);
      assert.doesNotMatch(body, /^Session: /m);
      assert.doesNotMatch(body, /^Process: /m);
    });
  }
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFormatConfigInfoText } = require('../lib/handlers/config-ui');

// The card used to compare the live proc's spawn-time model/effort against the
// configured ones and print "sonnet (running) → opus (pending — applies on your
// next message)". The body carries no settings at all now, so the comparison
// and every phrasing of it must be gone — including for the live-proc states
// that used to produce the line. The formatter is given no process or session
// context whatsoever: it cannot report what it cannot see.
const fmt = createFormatConfigInfoText();

describe('config card — the running-vs-configured lines are gone', () => {
  for (const [name, chatConfig] of [
    ['model drift', { model: 'opus', effort: 'high' }],
    ['effort drift', { model: 'opus', effort: 'max' }],
    ['no drift', { model: 'opus', effort: 'high' }],
    ['cold process', { model: 'opus', effort: 'high' }],
  ]) {
    test(`${name} → a bare header, no settings, no drift copy`, () => {
      const body = fmt(chatConfig, 'all', 'sk');
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

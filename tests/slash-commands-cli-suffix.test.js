'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSlashCommands } = require('../lib/handlers/slash-commands');

// Minimal cli-flavored harness — exercises cliAwareSuffix via /model + /effort.
function build({ backend = null, inFlight = false, botPm = null, applied = false } = {}) {
  const replies = [];
  const proc = { inFlight };
  const pm = {
    get: () => proc,
    has: () => true,
    getBackend: () => backend,
    setModel: async () => applied,
    applyFlagSettings: async () => applied,
  };
  const dispatch = createSlashCommands({
    config: { bot: { allowConfigCommands: true, pm: botPm } },
    db: { logConfigChange: () => {} },
    dbWrite: (fn) => { try { fn(); } catch { /* ignore */ } },
    intentLock: {
      async acquire() {
        return () => {};
      },
    },
    pm,
    pairings: {},
    modelVersionsDesc: { opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6' },
    botName: 'b',
    logEvent: () => {},
    logger: { log: () => {}, error: () => {} },
  });
  const run = (text) => dispatch({
    text, sessionKey: 'sk', chatId: '100', threadIdStr: null,
    chatConfig: { model: 'sonnet', effort: 'high' },
    cmdUser: 'u', cmdUserId: '1', label: 'L',
    sendReply: (t) => { replies.push(t); },
  });
  return { run, replies };
}

describe('slash-commands — cli-aware /model + /effort suffix', () => {
  test('cli + idle → "applies on your next message (conversation kept)"', async () => {
    const H = build({ backend: 'cli', inFlight: false });
    await H.run('/model opus');
    assert.equal(H.replies[0], 'Model → opus (claude-opus-4-8) — applies on your next message (conversation kept)');
  });

  test('cli + in-flight → "applies after this turn (conversation kept)"', async () => {
    const H = build({ backend: 'cli', inFlight: true });
    await H.run('/model opus');
    assert.match(H.replies[0], / — applies after this turn \(conversation kept\)$/);
  });

  test('cli cold (no live proc, bot pm=cli) → "applies on your next message"', async () => {
    const H = build({ backend: null, botPm: 'cli' });
    await H.run('/model opus');
    assert.equal(H.replies[0], 'Model → opus (claude-opus-4-8) — applies on your next message');
  });

  test('NOT the old misleading "I\'ll switch when I finish" on cli', async () => {
    const H = build({ backend: 'cli', inFlight: false });
    await H.run('/model opus');
    assert.doesNotMatch(H.replies[0], /I'll switch when I finish/);
  });

  test('SDK applied live → bare "Model → X" (no suffix)', async () => {
    const H = build({ backend: 'sdk', applied: true });
    await H.run('/model opus');
    assert.equal(H.replies[0], 'Model → opus (claude-opus-4-8)');
  });

  test('SDK no live session → keeps "I\'ll switch when I finish"', async () => {
    const H = build({ backend: null, botPm: null, applied: false });
    await H.run('/model opus');
    assert.match(H.replies[0], / — I'll switch when I finish$/);
  });

  test('/effort on cli idle gets the same honest suffix', async () => {
    const H = build({ backend: 'cli', inFlight: false });
    await H.run('/effort max');
    assert.equal(H.replies[0], 'Effort → max — applies on your next message (conversation kept)');
  });
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sweepTmuxOrphans } = require('@shumkov/orchestra').orphanSweep;

const SILENT = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeFakeRunner({ sessions = [], killThrows = new Set(), listThrows = false } = {}) {
  const calls = [];
  return {
    _calls: calls,
    listPolygramSessions: async (botName) => {
      calls.push({ kind: 'list', botName });
      if (listThrows) throw new Error('tmux: no server running');
      return sessions.filter((n) => n.startsWith(`polygram-${botName}-`));
    },
    killSession: async (name) => {
      calls.push({ kind: 'kill', name });
      if (killThrows.has(name)) throw new Error(`kill ${name} failed`);
    },
  };
}

describe('sweepTmuxOrphans', () => {
  test('throws without botName', async () => {
    await assert.rejects(
      () => sweepTmuxOrphans({ runner: makeFakeRunner(), logger: SILENT }),
      /botName required/,
    );
  });

  test('returns empty result when no orphans', async () => {
    const runner = makeFakeRunner({ sessions: [] });
    const r = await sweepTmuxOrphans({ botName: 'shumabit', runner, logger: SILENT });
    assert.deepEqual(r.swept, []);
    assert.deepEqual(r.errors, []);
    // Did NOT call kill
    assert.equal(runner._calls.filter((c) => c.kind === 'kill').length, 0);
  });

  test('kills only this-bot orphans (other bots untouched)', async () => {
    const runner = makeFakeRunner({
      sessions: [
        'polygram-shumabit-100-main',
        'polygram-shumabit-200-main',
        'polygram-umi-assistant-300-main',
        'unrelated-session',
      ],
    });
    const r = await sweepTmuxOrphans({ botName: 'shumabit', runner, logger: SILENT });
    assert.deepEqual(r.swept.sort(), [
      'polygram-shumabit-100-main', 'polygram-shumabit-200-main',
    ].sort());
    const kills = runner._calls.filter((c) => c.kind === 'kill').map((c) => c.name);
    assert.deepEqual(kills.sort(), [
      'polygram-shumabit-100-main', 'polygram-shumabit-200-main',
    ].sort());
  });

  test('continues sweeping when one kill fails', async () => {
    const runner = makeFakeRunner({
      sessions: ['polygram-shumabit-100-main', 'polygram-shumabit-200-main'],
      killThrows: new Set(['polygram-shumabit-100-main']),
    });
    const r = await sweepTmuxOrphans({ botName: 'shumabit', runner, logger: SILENT });
    assert.deepEqual(r.swept, ['polygram-shumabit-200-main']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'polygram-shumabit-100-main');
  });

  test('tmux-not-running surfaces empty result, not error', async () => {
    const runner = makeFakeRunner({ listThrows: true });
    const r = await sweepTmuxOrphans({ botName: 'shumabit', runner, logger: SILENT });
    assert.deepEqual(r.swept, []);
    assert.deepEqual(r.errors, []);
  });

  test('handles thread-suffixed session names', async () => {
    const runner = makeFakeRunner({
      sessions: [
        'polygram-shumabit-100-main',
        'polygram-shumabit-100-5',   // topic 5
        'polygram-shumabit--1002-main', // negative chatId
      ],
    });
    const r = await sweepTmuxOrphans({ botName: 'shumabit', runner, logger: SILENT });
    assert.equal(r.swept.length, 3);
  });
});

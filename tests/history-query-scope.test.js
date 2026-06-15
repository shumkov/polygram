'use strict';

/**
 * #4 regression pin (0.12.5–0.12.7 ultra-review): the history skill's scope must
 * derive ONLY from the spawn-time cwd and fail closed — the removed env overrides
 * (POLYGRAM_ADMIN / CLAUDE_CHANNEL_BOT) must never widen it again. Before this
 * test the security fix had ZERO coverage AND query.js wasn't even importable
 * (it crashed at a wrong require path). Both are fixed; this pins them.
 */

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deriveBotScope } = require('../skills/history/scripts/query.js');

const origCwd = process.cwd();
const origExit = process.exit;
let mappedDir;
let unmappedDir;

before(() => {
  // realpathSync so the path matches process.cwd() after chdir (macOS resolves
  // /var/folders → /private/var/folders, which would otherwise break the match).
  mappedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-mapped-')));
  unmappedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-unmapped-')));
});

afterEach(() => {
  process.chdir(origCwd);
  process.exit = origExit;
  delete process.env.POLYGRAM_ADMIN;
  delete process.env.CLAUDE_CHANNEL_BOT;
});

after(() => {
  for (const d of [mappedDir, unmappedDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

const cfg = () => ({
  chats: {
    111: { cwd: mappedDir, bot: 'shumabit' },
    222: { cwd: '/some/other/bot/cwd', bot: 'umi-assistant' },
  },
  bots: { shumabit: {}, 'umi-assistant': {} },
});

// die() calls process.exit; stub it to throw so "refused" is observable.
function stubExitThrows() {
  process.exit = (code) => { throw new Error(`die(exit ${code})`); };
}

describe('#4 history skill scope — cwd-only, fail-closed, no env backdoor', () => {
  test('a MAPPED cwd derives scope restricted to that bot\'s chats', () => {
    process.chdir(mappedDir);
    const scope = deriveBotScope(cfg());
    assert.equal(scope.bot, 'shumabit');
    assert.deepEqual(scope.allowedChatIds, ['111'], 'scope is the single chat whose cwd matches');
  });

  test('an UNMAPPED cwd refuses even with POLYGRAM_ADMIN=1 (the closed backdoor)', () => {
    process.chdir(unmappedDir);
    process.env.POLYGRAM_ADMIN = '1';
    stubExitThrows();
    assert.throws(() => deriveBotScope(cfg()), /die\(exit 1\)/,
      'POLYGRAM_ADMIN must NOT grant unrestricted scope — re-adding that path would fail this test');
  });

  test('an UNMAPPED cwd refuses even with CLAUDE_CHANNEL_BOT set', () => {
    process.chdir(unmappedDir);
    process.env.CLAUDE_CHANNEL_BOT = 'shumabit';
    stubExitThrows();
    assert.throws(() => deriveBotScope(cfg()), /die\(exit 1\)/,
      'CLAUDE_CHANNEL_BOT must NOT grant scope from an unmapped cwd');
  });
});

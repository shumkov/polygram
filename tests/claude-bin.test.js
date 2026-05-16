'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { resolvePinnedClaudeBin, verifyPinnedClaudeBin } = require('../lib/claude-bin');

const ORIGINAL_OVERRIDE = process.env.POLYGRAM_CLAUDE_BIN;

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.POLYGRAM_CLAUDE_BIN;
  else process.env.POLYGRAM_CLAUDE_BIN = ORIGINAL_OVERRIDE;
});

describe('claude-bin — resolvePinnedClaudeBin', () => {
  test('resolves to the standard claude-CLI versions path', () => {
    delete process.env.POLYGRAM_CLAUDE_BIN;
    assert.equal(
      resolvePinnedClaudeBin('2.1.142'),
      path.join(os.homedir(), '.local', 'share', 'claude', 'versions', '2.1.142'),
    );
  });

  test('the version string is part of the path (different versions → different paths)', () => {
    delete process.env.POLYGRAM_CLAUDE_BIN;
    assert.notEqual(
      resolvePinnedClaudeBin('2.1.142'),
      resolvePinnedClaudeBin('2.1.143'),
    );
  });

  test('POLYGRAM_CLAUDE_BIN env overrides the default path', () => {
    process.env.POLYGRAM_CLAUDE_BIN = '/custom/claude';
    assert.equal(resolvePinnedClaudeBin('2.1.142'), '/custom/claude');
  });
});

describe('claude-bin — verifyPinnedClaudeBin', () => {
  test('ok=true for an existing executable file', () => {
    // node itself is a reliable executable to point at.
    process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
    const r = verifyPinnedClaudeBin('2.1.142');
    assert.equal(r.ok, true);
    assert.equal(r.path, process.execPath);
    assert.equal(r.reason, undefined);
  });

  test('ok=false with an actionable reason for a missing binary', () => {
    process.env.POLYGRAM_CLAUDE_BIN = path.join(
      os.tmpdir(), `polygram-claude-bin-missing-${Date.now()}`,
    );
    const r = verifyPinnedClaudeBin('2.1.142');
    assert.equal(r.ok, false);
    assert.match(r.reason, /pinned claude CLI v2\.1\.142 not found/);
    assert.match(r.reason, /claude install 2\.1\.142/);
    assert.match(r.reason, /POLYGRAM_CLAUDE_BIN/);
  });

  test('ok=false for a non-executable file', () => {
    const tmp = path.join(os.tmpdir(), `polygram-claude-bin-noexec-${Date.now()}`);
    fs.writeFileSync(tmp, 'not a binary', { mode: 0o600 });
    try {
      process.env.POLYGRAM_CLAUDE_BIN = tmp;
      const r = verifyPinnedClaudeBin('2.1.142');
      assert.equal(r.ok, false);
      assert.match(r.reason, /not found or not executable/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

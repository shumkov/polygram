'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  HOOK_HELPER_ABS_PATH,
  HOOK_EVENTS,
  hooksBaseDir,
  hookNdjsonPath,
  hookSettingsPath,
  buildHookSettings,
  writeHookFiles,
  removeHookFiles,
} = require('../lib/process/hook-settings');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hook-settings-'));
}

describe('hook-settings — path helpers', () => {
  test('hooksBaseDir uses ~/.polygram/<safeBot>/hooks by default', () => {
    const dir = hooksBaseDir('shumorobot');
    assert.equal(dir, path.join(process.env.HOME, '.polygram', 'shumorobot', 'hooks'));
  });

  test('hooksBaseDir respects override (for tests)', () => {
    assert.equal(hooksBaseDir('shumorobot', '/x/y'), '/x/y');
  });

  test('hooksBaseDir sanitizes bot names with shell metachars', () => {
    const dir = hooksBaseDir('foo;rm -rf');
    assert.match(dir, /\/\.polygram\/foo_rm_-rf\/hooks$/);
  });

  test('hooksBaseDir throws when HOME unset and no override', () => {
    const orig = process.env.HOME;
    delete process.env.HOME;
    try {
      assert.throws(() => hooksBaseDir('shumorobot'), /HOME env var unset/);
    } finally {
      process.env.HOME = orig;
    }
  });

  test('hookNdjsonPath + hookSettingsPath compose correctly', () => {
    const base = '/tmp/x';
    assert.equal(hookNdjsonPath('b', 'sid', base), '/tmp/x/sid.ndjson');
    assert.equal(hookSettingsPath('b', 'sid', base), '/tmp/x/sid.settings.json');
  });
});

describe('hook-settings — buildHookSettings', () => {
  test('registers a hook for every documented event name', () => {
    const settings = buildHookSettings({ ndjsonPath: '/abs/foo.ndjson' });
    assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  });

  test('PreToolUse + PostToolUse use the ".*" matcher, lifecycle events have no matcher', () => {
    const s = buildHookSettings({ ndjsonPath: '/abs/foo.ndjson' });
    assert.equal(s.hooks.PreToolUse[0].matcher, '.*');
    assert.equal(s.hooks.PostToolUse[0].matcher, '.*');
    for (const evt of ['UserPromptSubmit', 'Stop', 'SubagentStop', 'Notification']) {
      assert.equal(s.hooks[evt][0].matcher, undefined, `${evt} should not declare a matcher`);
    }
  });

  test('hook command is the polygram-hook-append helper + the ndjson path', () => {
    const s = buildHookSettings({ ndjsonPath: '/abs/foo.ndjson' });
    const cmd = s.hooks.PreToolUse[0].hooks[0].command;
    assert.match(cmd, /^node /);
    assert.ok(cmd.includes(HOOK_HELPER_ABS_PATH), 'command should include the helper abs path');
    // 0.12 Phase 1.2 SEC-03: command shell-quotes both paths so HOME with
    // spaces doesn't break tokenization. Quoted form ends with "'/abs/foo.ndjson'".
    assert.ok(cmd.includes('/abs/foo.ndjson'), 'command should include the ndjson abs path');
    assert.match(cmd, /'\/abs\/foo\.ndjson'$/, 'command should end with single-quoted ndjson path');
  });

  test('default helper path is the shipped polygram-hook-append.js', () => {
    assert.equal(path.basename(HOOK_HELPER_ABS_PATH), 'polygram-hook-append.js');
    assert.ok(path.isAbsolute(HOOK_HELPER_ABS_PATH));
    assert.ok(fs.existsSync(HOOK_HELPER_ABS_PATH), 'helper must exist on disk');
  });

  test('every hook has timeout: 30 (belt-and-braces backstop)', () => {
    const s = buildHookSettings({ ndjsonPath: '/abs/foo.ndjson' });
    for (const evt of HOOK_EVENTS) {
      assert.equal(s.hooks[evt][0].hooks[0].timeout, 30);
    }
  });

  test('rejects non-absolute ndjsonPath', () => {
    assert.throws(() => buildHookSettings({ ndjsonPath: 'rel.ndjson' }),
      /must be an absolute path/);
  });

  test('rejects non-absolute helperPath', () => {
    assert.throws(
      () => buildHookSettings({ ndjsonPath: '/abs/foo.ndjson', helperPath: 'rel.js' }),
      /must be an absolute path/,
    );
  });
});

describe('hook-settings — writeHookFiles + removeHookFiles', () => {
  test('writes a parseable settings JSON + touches an empty ndjson', () => {
    const dir = tmpdir();
    try {
      const { settingsPath, ndjsonPath } = writeHookFiles({
        botName: 'shumorobot', sessionId: 'sid-1', hooksDir: dir,
      });
      assert.ok(fs.existsSync(settingsPath));
      assert.ok(fs.existsSync(ndjsonPath));
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(parsed.hooks.PreToolUse);
      // ndjson is empty — fs.watch can still attach to a 0-byte file
      assert.equal(fs.statSync(ndjsonPath).size, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removeHookFiles unlinks both', () => {
    const dir = tmpdir();
    try {
      const { settingsPath, ndjsonPath } = writeHookFiles({
        botName: 'shumorobot', sessionId: 'sid-2', hooksDir: dir,
      });
      removeHookFiles({ botName: 'shumorobot', sessionId: 'sid-2', hooksDir: dir });
      assert.equal(fs.existsSync(settingsPath), false);
      assert.equal(fs.existsSync(ndjsonPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removeHookFiles is idempotent (no throw if files already gone)', () => {
    const dir = tmpdir();
    try {
      assert.doesNotThrow(() => removeHookFiles({
        botName: 'shumorobot', sessionId: 'never-created', hooksDir: dir,
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

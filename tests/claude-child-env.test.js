'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const test = require('node:test');
const { parseEnv } = require('node:util');

const {
  createClaudeTmuxRunner,
} = require('../lib/process/claude-environment');

// tmux transports the complete command argv in one 16 KiB protocol message;
// the four-byte argc header leaves this much room for NUL-terminated arguments.
const TMUX_COMMAND_PAYLOAD_MAX_BYTES = 16_380;

function commandPayloadBytes({ command, args = [] }) {
  return [command, ...args].reduce(
    (total, arg) => total + Buffer.byteLength(String(arg)) + 1,
    0,
  );
}

test('Codex temp selection is absent from the Claude CLI child environment', async () => {
  const processEnv = {
    HOME: '/Users/service',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/private/claude-tmp',
    POLYGRAM_CODEX_TMPDIR: '/private/codex-tmp',
  };

  let cliEnv;
  const runner = createClaudeTmuxRunner({
    async spawn(options) {
      const output = execFileSync(options.command, options.args, {
        encoding: 'utf8',
        env: processEnv,
      });
      cliEnv = parseEnv(output);
    },
  });
  await runner.spawn({
    name: 'test',
    command: '/usr/bin/env',
    args: [],
  });

  assert.equal(cliEnv.TMPDIR, '/private/claude-tmp');
  assert.equal(cliEnv.POLYGRAM_CODEX_TMPDIR, undefined);
});

test('rich+stream Claude launch avoids tmux "command too long" by staging the append prompt privately', async (t) => {
  const appendPrompt = [
    '## Telegram rich display and channels contract',
    'x'.repeat(17_000),
  ].join('\n');
  let launched;
  let killedSession = null;
  let promptPath = null;

  const runner = createClaudeTmuxRunner({
    async spawn(options) {
      launched = options;
      if (commandPayloadBytes(options) > TMUX_COMMAND_PAYLOAD_MAX_BYTES) {
        throw Object.assign(new Error('command too long'), {
          code: 'TMUX_SPAWN_FAILED',
          stderr: 'command too long\n',
        });
      }
    },
    async killSession(name) {
      killedSession = name;
    },
  });

  await runner.spawn({
    name: 'polygram-shumabit-channels-test',
    command: '/opt/polygram/claude',
    args: [
      '--append-system-prompt',
      appendPrompt,
      '--permission-mode',
      'bypassPermissions',
    ],
  });

  assert.ok(
    commandPayloadBytes(launched) <= TMUX_COMMAND_PAYLOAD_MAX_BYTES,
    'tmux sees only the short prompt-file path, not the 17 KB prompt',
  );
  assert.equal(launched.args.includes('--append-system-prompt'), false);
  const promptFlagIndex = launched.args.indexOf('--append-system-prompt-file');
  assert.notEqual(promptFlagIndex, -1);
  promptPath = launched.args[promptFlagIndex + 1];
  t.after(() => {
    try { fs.unlinkSync(promptPath); } catch {}
  });

  assert.equal(fs.readFileSync(promptPath, 'utf8'), appendPrompt);
  assert.equal(fs.statSync(promptPath).mode & 0o777, 0o600);

  await runner.killSession('polygram-shumabit-channels-test');

  assert.equal(killedSession, 'polygram-shumabit-channels-test');
  assert.equal(fs.existsSync(promptPath), false);
});

test('Claude append prompt file is removed when tmux spawn fails', async () => {
  let promptPath = null;
  const runner = createClaudeTmuxRunner({
    async spawn(options) {
      const promptFlagIndex = options.args.indexOf('--append-system-prompt-file');
      promptPath = options.args[promptFlagIndex + 1];
      throw Object.assign(new Error('tmux spawn failed'), {
        code: 'TMUX_SPAWN_FAILED',
      });
    },
  });

  await assert.rejects(
    runner.spawn({
      name: 'polygram-shumabit-channels-failed',
      command: '/opt/polygram/claude',
      args: ['--append-system-prompt', 'private prompt'],
    }),
    { code: 'TMUX_SPAWN_FAILED' },
  );

  assert.equal(typeof promptPath, 'string');
  assert.equal(fs.existsSync(promptPath), false);
});

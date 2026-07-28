'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { parseEnv } = require('node:util');

const {
  createClaudeTmuxRunner,
} = require('../lib/process/claude-environment');

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

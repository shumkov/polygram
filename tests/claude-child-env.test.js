'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  createClaudeTmuxRunner,
} = require('../lib/process/claude-environment');
const {
  createBuildSdkOptions,
} = require('../lib/sdk/build-options');

test('Codex temp selection is absent from every Claude child environment', async () => {
  const processEnv = {
    HOME: '/Users/service',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/private/claude-tmp',
    POLYGRAM_CODEX_TMPDIR: '/private/codex-tmp',
  };
  const buildSdkOptions = createBuildSdkOptions({
    config: {
      bot: {},
      defaults: { model: 'sonnet', effort: 'medium' },
    },
    botName: 'test-bot',
    childHome: '/Users/claude',
    makeCanUseTool: () => null,
    logEvent: () => {},
    logger: { log: () => {} },
    processEnv,
  });
  const sdkOptions = buildSdkOptions('chat:100', {
    chatConfig: {
      model: 'sonnet',
      effort: 'medium',
      cwd: '/Users/workspace',
    },
    existingSessionId: null,
    label: 'test',
    chatId: '100',
    threadId: null,
  });

  let cliEnv;
  const runner = createClaudeTmuxRunner({
    async spawn(options) {
      const output = execFileSync(options.command, options.args, {
        encoding: 'utf8',
        env: processEnv,
      });
      cliEnv = Object.fromEntries(
        output.trimEnd().split('\n').map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
    },
  });
  await runner.spawn({
    name: 'test',
    command: '/usr/bin/env',
    args: [],
  });

  assert.equal(sdkOptions.env.TMPDIR, '/private/claude-tmp');
  assert.equal(sdkOptions.env.POLYGRAM_CODEX_TMPDIR, undefined);
  assert.equal(cliEnv.TMPDIR, '/private/claude-tmp');
  assert.equal(cliEnv.POLYGRAM_CODEX_TMPDIR, undefined);
});

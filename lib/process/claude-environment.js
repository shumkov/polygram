'use strict';

const CODEX_TEMP_SELECTOR = 'POLYGRAM_CODEX_TMPDIR';
const ENV_BIN = '/usr/bin/env';

function createClaudeTmuxRunner(runner) {
  if (!runner || typeof runner.spawn !== 'function') {
    throw new TypeError('Claude tmux runner requires spawn()');
  }
  return {
    ...runner,
    spawn(options) {
      return runner.spawn({
        ...options,
        command: ENV_BIN,
        args: [
          '-u',
          CODEX_TEMP_SELECTOR,
          options.command,
          ...(options.args ?? []),
        ],
      });
    },
  };
}

module.exports = {
  createClaudeTmuxRunner,
};

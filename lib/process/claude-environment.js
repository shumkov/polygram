'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_TEMP_SELECTOR = 'POLYGRAM_CODEX_TMPDIR';
const ENV_BIN = '/usr/bin/env';
const APPEND_PROMPT_FLAG = '--append-system-prompt';
const APPEND_PROMPT_FILE_FLAG = '--append-system-prompt-file';

function removePromptFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

function stageAppendPrompt(args) {
  const rewritten = [...(args ?? [])];
  const promptIndex = rewritten.indexOf(APPEND_PROMPT_FLAG);
  if (promptIndex === -1) return { args: rewritten, promptFile: null };

  const prompt = rewritten[promptIndex + 1];
  if (typeof prompt !== 'string') {
    throw new TypeError(`${APPEND_PROMPT_FLAG} requires a string value`);
  }

  const promptFile = path.join(
    os.tmpdir(),
    `polygram-claude-prompt-${crypto.randomUUID()}.txt`,
  );
  try {
    fs.writeFileSync(promptFile, prompt, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.chmodSync(promptFile, 0o600);
  } catch (error) {
    removePromptFile(promptFile);
    throw error;
  }

  rewritten.splice(
    promptIndex,
    2,
    APPEND_PROMPT_FILE_FLAG,
    promptFile,
  );
  return { args: rewritten, promptFile };
}

function createClaudeTmuxRunner(runner) {
  if (!runner || typeof runner.spawn !== 'function') {
    throw new TypeError('Claude tmux runner requires spawn()');
  }
  const promptFiles = new Map();

  return {
    ...runner,
    async spawn(options) {
      const staged = stageAppendPrompt(options.args);
      if (staged.promptFile) {
        removePromptFile(promptFiles.get(options.name));
        promptFiles.set(options.name, staged.promptFile);
      }

      try {
        return await runner.spawn({
          ...options,
          command: ENV_BIN,
          args: [
            '-u',
            CODEX_TEMP_SELECTOR,
            options.command,
            ...staged.args,
          ],
        });
      } catch (error) {
        if (promptFiles.get(options.name) === staged.promptFile) {
          promptFiles.delete(options.name);
        }
        removePromptFile(staged.promptFile);
        throw error;
      }
    },
    async killSession(name, ...args) {
      try {
        return await runner.killSession?.(name, ...args);
      } finally {
        const promptFile = promptFiles.get(name);
        promptFiles.delete(name);
        removePromptFile(promptFile);
      }
    },
  };
}

module.exports = {
  createClaudeTmuxRunner,
};

'use strict';

const path = require('node:path');
const { resolveRuntimeDescriptor } = require('../runtime-config');

function validateClaudeCliAuthSource(botConfig = {}) {
  const source = botConfig.claudeCliAuthSource;
  if (source !== undefined && source !== 'native' && source !== 'external') {
    throw new TypeError('claudeCliAuthSource must be native or external');
  }
}

function needsNativeClaudeAuth(botConfig, backend) {
  validateClaudeCliAuthSource(botConfig);
  if (backend === 'codex') return false;
  if (backend === 'sdk') return true;
  if (backend !== 'cli') throw new TypeError('Unknown Claude auth backend');
  return botConfig?.claudeCliAuthSource !== 'external';
}

function hasNativeClaudeRuntime(config) {
  validateClaudeCliAuthSource(config.bot);
  for (const [chatId, chat] of Object.entries(config.chats || {})) {
    for (const threadId of [null, ...Object.keys(chat.topics || {})]) {
      const { backend } = resolveRuntimeDescriptor({
        config, chatId, threadId, defaultPm: 'sdk',
      });
      if (needsNativeClaudeAuth(config.bot, backend)) return true;
    }
  }
  return false;
}

function assertExternalClaudeCliReady(botConfig, { sessionLauncher, pinnedClaudeBin }) {
  validateClaudeCliAuthSource(botConfig);
  if (botConfig?.claudeCliAuthSource !== 'external') return;
  if (typeof sessionLauncher !== 'string' || !path.isAbsolute(sessionLauncher)) {
    throw new Error('External Claude CLI auth requires an absolute session launcher');
  }
  // Without a pinned binary the process factory falls back to SDK, which does
  // not use the CLI launcher's external credentials.
  if (!pinnedClaudeBin) {
    throw new Error('External Claude CLI auth requires a verified pinned Claude binary');
  }
}

module.exports = {
  validateClaudeCliAuthSource,
  needsNativeClaudeAuth,
  hasNativeClaudeRuntime,
  assertExternalClaudeCliReady,
};

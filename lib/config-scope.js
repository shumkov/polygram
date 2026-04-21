/**
 * Per-bot config scoping.
 *
 * `filterConfigToBot(config, botName)` narrows a full-bridge config down to
 * the subset owned by one bot. Enables Phase 7 (per-bot process isolation):
 * each bot runs in its own Node process, sees only its own chats, and can't
 * accidentally touch another bot's queue or Claude pool.
 */

function parseBotArg(argv) {
  return parseFlag(argv, '--bot', 'a bot name (e.g. --bot shumabit)');
}

function parseDbArg(argv) {
  return parseFlag(argv, '--db', 'a path (e.g. --db /path/to/shumabit.db)');
}

function parseFlag(argv, flag, hint) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) {
    throw new Error(`${flag} requires ${hint}`);
  }
  return v;
}

function filterConfigToBot(config, botName) {
  if (!config || !config.bots || !config.chats) {
    throw new Error('config must have bots and chats');
  }
  if (!config.bots[botName]) {
    throw new Error(`bot "${botName}" not in config.bots`);
  }
  const chats = {};
  for (const [chatId, chat] of Object.entries(config.chats)) {
    if (chat.bot === botName) chats[chatId] = chat;
  }
  if (Object.keys(chats).length === 0) {
    throw new Error(`bot "${botName}" owns no chats in config.chats`);
  }
  return {
    ...config,
    bots: { [botName]: config.bots[botName] },
    chats,
  };
}

module.exports = { parseBotArg, parseDbArg, filterConfigToBot };

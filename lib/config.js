/**
 * Config loader / saver / sticker-map loader.
 *
 * Pure I/O functions extracted from polygram.js. The caller owns
 * the module-level mutable `config` / `stickerMap` state and
 * assigns the return values; this module never touches process
 * globals.
 *
 * - `loadConfig(configPath)` — sync read + JSON.parse. Throws on
 *   parse error so the caller fails fast at boot.
 * - `saveConfig({ configPath, botName, config })` — atomic
 *   read-merge-write. In-memory `config` is filtered (one bot's
 *   scope only); to avoid clobbering OTHER bots on disk we read
 *   the live file fresh, overlay our bot's section + chats, then
 *   rename a temp file in place. Top-level non-bot-scoped fields
 *   are NOT touched (ops-wide policy lives there).
 * - `loadStickers(stickersPath)` — read sticker map. Returns
 *   `{ stickerMap, emojiToSticker }`. Missing file is non-fatal:
 *   returns empty maps and logs "No sticker map found".
 * - `isWellFormedMessage(msg)` — pure predicate; quick shape
 *   check before recordInbound runs hashing/DB-writes on
 *   user-controlled Telegram updates.
 */

'use strict';

const fs = require('fs');

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Atomic read-merge-write. We only ever write our bot's section +
 * its chats; other bots in the same on-disk file are preserved.
 * The temp file + rename is for atomicity (a crash mid-write
 * leaves the .tmp.<pid> rather than a truncated config).
 */
function saveConfig({ configPath, botName, config }) {
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  if (botName && config.bots?.[botName]) {
    onDisk.bots = onDisk.bots || {};
    onDisk.bots[botName] = config.bots[botName];
  }
  if (config.chats) {
    onDisk.chats = onDisk.chats || {};
    for (const [chatId, chat] of Object.entries(config.chats)) {
      onDisk.chats[chatId] = chat;
    }
  }
  // Top-level non-bot-scoped fields (defaults, maxWarmProcesses,
  // etc.) are ops-wide policy — leave them as-is on disk.

  const tmp = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
  fs.renameSync(tmp, configPath);
}

/**
 * @returns {{ stickerMap: object, emojiToSticker: object }}
 */
function loadStickers(stickersPath, { logger = console } = {}) {
  const stickerMap = {};
  const emojiToSticker = {};
  try {
    const data = JSON.parse(fs.readFileSync(stickersPath, 'utf8'));
    for (const [name, s] of Object.entries(data.stickers || {})) {
      stickerMap[name] = s.file_id;
      if (s.emoji) emojiToSticker[s.emoji] = s.file_id;
    }
    logger.log?.(`Stickers: ${Object.keys(stickerMap).join(', ')}`);
  } catch {
    logger.log?.('No sticker map found');
  }
  return { stickerMap, emojiToSticker };
}

/**
 * Quick shape check before recordInbound runs. Telegram updates
 * are user-controlled; a hostile or malformed payload without
 * chat.id / message_id would throw deep in the writer.
 */
function isWellFormedMessage(msg) {
  return !!(msg
    && msg.chat
    && (typeof msg.chat.id === 'number' || typeof msg.chat.id === 'bigint')
    && typeof msg.message_id === 'number');
}

module.exports = {
  loadConfig,
  saveConfig,
  loadStickers,
  isWellFormedMessage,
};

#!/usr/bin/env node
/**
 * telegram-history skill CLI.
 *
 *   node query.js <subcmd> [positional args] [--flag value]
 *
 * Subcommands: recent | around | search | by-user | msg | stats
 *
 * Opens bridge.db read-only. Bot scope is derived from process.cwd() —
 * each bot's Claude project dir maps to a chat.cwd in config.json, so a
 * partner-spawned skill invocation cannot escape its bot's chat allowlist.
 * Set BRIDGE_ADMIN=1 for unrestricted queries from unmapped cwd.
 *
 * Default output: JSON (one row per message). Pass --format pretty for
 * human-readable lines.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const history = require('../lib/history');

const BRIDGE_DIR = process.env.BRIDGE_DIR || path.resolve(__dirname, '../../../../polygram');
const CONFIG_PATH = process.env.BRIDGE_CONFIG || path.join(BRIDGE_DIR, 'config.json');
// BRIDGE_DB overrides auto-resolution. Otherwise the skill reads one DB per
// bot (<bot>.db) when the bot scope is known, or all bot DBs for admin.
// Legacy `bridge.db` is used as a fallback when per-bot DBs don't exist yet.
const DB_OVERRIDE = process.env.BRIDGE_DB || null;

function die(msg, code = 1) {
  process.stderr.write(`history: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    die(`cannot read config at ${CONFIG_PATH}: ${err.message}`);
  }
}

/**
 * Derive bot scope from the current working directory.
 * Each chat in config.json has a `cwd` pointing at the bot's Claude project
 * root. process.cwd() is set by the bridge when it spawns Claude, so this
 * cannot be spoofed from inside a prompt. Fails closed: if no chat's cwd
 * matches and no admin override is set, we refuse to run.
 */
function deriveBotScope(cfg) {
  const cwd = path.resolve(process.cwd());
  const matching = Object.entries(cfg.chats || {})
    .filter(([, c]) => c.cwd && path.resolve(c.cwd) === cwd);

  if (matching.length) {
    const bots = new Set(matching.map(([, c]) => c.bot).filter(Boolean));
    if (bots.size !== 1) {
      die(`cwd ${cwd} maps to multiple bots (${[...bots].join(', ')}) — refusing`);
    }
    return {
      bot: [...bots][0],
      allowedChatIds: matching.map(([id]) => id),
    };
  }

  // No cwd match. Allow explicit admin override via env var, which the bridge
  // never sets and thus cannot be triggered from a bot-spawned subprocess.
  if (process.env.BRIDGE_ADMIN === '1') {
    return { bot: null, allowedChatIds: null };
  }

  // Legacy fallback: respect CLAUDE_CHANNEL_BOT ONLY if it matches a known bot
  // in the config. This preserves manual shumabit/umi-assistant invocation via
  // the bridge env var without opening an admin-by-default hole.
  const envBot = process.env.CLAUDE_CHANNEL_BOT;
  if (envBot && cfg.bots?.[envBot]) {
    const allowed = Object.entries(cfg.chats || {})
      .filter(([, c]) => c.bot === envBot)
      .map(([id]) => id);
    if (allowed.length) return { bot: envBot, allowedChatIds: allowed };
  }

  die(`cannot determine bot scope for cwd ${cwd}; set BRIDGE_ADMIN=1 for unrestricted access`);
}

function openDbReadOnly(dbPath) {
  if (!fs.existsSync(dbPath)) die(`bridge DB not found at ${dbPath}`);
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  return { raw };
}

/**
 * Post-Phase-8: pick the right DB file(s) to query.
 *  - If BRIDGE_DB is set, use it (explicit override).
 *  - If bot scope is known and <bot>.db exists, use that single file.
 *  - If bot scope is known but per-bot DB is missing, fall back to legacy
 *    bridge.db (pre-cutover state).
 *  - If admin (bot null): open every <bot>.db that exists; if none, fall
 *    back to bridge.db.
 */
function resolveDbPaths(cfg, bot) {
  if (DB_OVERRIDE) return [DB_OVERRIDE];
  const perBot = (b) => path.join(BRIDGE_DIR, `${b}.db`);
  const legacy = path.join(BRIDGE_DIR, 'bridge.db');

  if (bot) {
    const p = perBot(bot);
    if (fs.existsSync(p)) return [p];
    if (fs.existsSync(legacy)) return [legacy];
    die(`no DB found for bot "${bot}" (tried ${p} and ${legacy})`);
  }

  // Admin: union across all bots that have a DB.
  const paths = Object.keys(cfg.bots || {})
    .map(perBot)
    .filter((p) => fs.existsSync(p));
  if (paths.length) return paths;
  if (fs.existsSync(legacy)) return [legacy];
  die(`no per-bot DBs found in ${BRIDGE_DIR} and no legacy bridge.db either`);
}

/**
 * Call a history helper once per DB and merge results.
 *  - For array-returning helpers (recent/around/search/by-user/stats),
 *    concat, re-sort by ts desc, and re-apply the requested limit.
 *  - For single-row helpers (msg), return the first non-null hit.
 */
function queryAcross(dbs, fn, { limit } = {}) {
  const out = [];
  for (const db of dbs) {
    const rows = fn(db);
    if (Array.isArray(rows)) out.push(...rows);
    else if (rows) return rows;
  }
  if (!out.length) return out;
  if (out[0] && typeof out[0].ts === 'number') {
    out.sort((a, b) => b.ts - a.ts);
  }
  if (limit && out.length > limit) out.length = limit;
  return out;
}

function emit(rows, format) {
  if (format === 'pretty') {
    if (!Array.isArray(rows)) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return; }
    process.stdout.write(history.formatPretty(rows) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

function runSub(sub, positional, flags, dbs, allowedChatIds) {
  const format = flags.format || 'json';
  const limit = flags.limit ? Number(flags.limit) : undefined;

  switch (sub) {
    case 'recent': {
      const chatId = positional[0];
      const threadId = positional[1] || null;
      if (!chatId) die('recent: <chat_id> required');
      const rows = queryAcross(dbs, (db) => history.recent(db, {
        chatId,
        threadId,
        limit: flags.limit,
        since: flags.since || null,
        includeOutbound: flags['include-outbound'] !== false && flags['include-outbound'] !== 'false',
        allowedChatIds,
      }), { limit });
      return emit(rows, format);
    }

    case 'around': {
      const chatId = flags.chat;
      const msgId = Number(flags['msg-id']);
      if (!chatId) die('around: --chat required');
      if (!msgId) die('around: --msg-id required');
      const rows = queryAcross(dbs, (db) => history.around(db, {
        chatId,
        msgId,
        before: Number(flags.before) || 5,
        after: Number(flags.after) || 5,
        allowedChatIds,
      }));
      return emit(rows, format);
    }

    case 'search': {
      const query = positional[0];
      const chatId = positional[1] || flags.chat || null;
      const threadId = positional[2] || flags.thread || null;
      if (!query) die('search: <term> required');
      const rows = queryAcross(dbs, (db) => history.search(db, {
        query,
        chatId,
        threadId,
        user: flags.user || null,
        days: flags.days ? Number(flags.days) : null,
        limit: flags.limit,
        allowedChatIds,
      }), { limit });
      return emit(rows, format);
    }

    case 'by-user': {
      const user = positional[0];
      const chatId = positional[1] || flags.chat || null;
      const threadId = positional[2] || flags.thread || null;
      if (!user) die('by-user: <user> required');
      const rows = queryAcross(dbs, (db) => history.byUser(db, {
        user,
        chatId,
        threadId,
        days: flags.days !== undefined ? Number(flags.days) : 7,
        limit: flags.limit,
        allowedChatIds,
      }), { limit });
      return emit(rows, format);
    }

    case 'msg': {
      const msgId = Number(positional[0]);
      const chatId = positional[1] || flags.chat || null;
      if (!msgId) die('msg: <msg_id> required');
      const row = queryAcross(dbs, (db) => history.getMsg(db, { msgId, chatId, allowedChatIds }));
      return emit(row ? [row] : [], format);
    }

    case 'stats': {
      const chatId = positional[0] || flags.chat || null;
      const threadId = positional[1] || flags.thread || null;
      // stats returns aggregates — merging naively concatenates the per-DB
      // breakdown. That's what we want when admin queries across bots.
      const rows = queryAcross(dbs, (db) => history.stats(db, {
        chatId,
        threadId,
        days: flags.days !== undefined ? Number(flags.days) : 7,
        allowedChatIds,
      }));
      return emit(rows, format);
    }

    default:
      die(`unknown subcommand: ${sub}. Try: recent|around|search|by-user|msg|stats`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(`usage: query.js <recent|around|search|by-user|msg|stats> [args]\n`);
    process.exit(0);
  }
  const sub = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));

  const cfg = loadConfig();
  const { bot, allowedChatIds } = deriveBotScope(cfg);
  const dbPaths = resolveDbPaths(cfg, bot);
  const dbs = dbPaths.map(openDbReadOnly);
  try {
    runSub(sub, positional, flags, dbs, allowedChatIds);
  } finally {
    for (const db of dbs) { try { db.raw.close(); } catch {} }
  }
}

main();

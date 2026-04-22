#!/usr/bin/env node
/**
 * Phase 8 - one-time migration: split shared `bridge.db` into per-bot DBs.
 *
 * Usage:
 *   node scripts/split-db.js --config config.json [--src bridge.db] [--dry-run]
 *
 * Behaviour:
 *   1. Reads config.json to learn the bot set and which chat belongs to whom.
 *   2. For each bot:
 *        - Creates <bot>.db by opening it (runs all migrations via lib/db.open).
 *        - Copies sessions, messages, events, chat_migrations, config_changes,
 *          pair_codes, pairings, pending_approvals scoped to that bot.
 *   3. Renames the source DB to bridge.db.archived-<ISO-date> unless --dry-run.
 *
 * Idempotent: INSERT OR IGNORE / INSERT OR REPLACE throughout. Safe to re-run.
 */

const fs = require('fs');
const path = require('path');

const { open } = require('../lib/db');

function parseArg(argv, flag, required = false) {
  const i = argv.indexOf(flag);
  if (i === -1) {
    if (required) { console.error(`${flag} required`); process.exit(2); }
    return null;
  }
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`${flag} requires a value`); process.exit(2);
  }
  return v;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function main() {
  const configPath = parseArg(process.argv, '--config', true);
  const srcPath = parseArg(process.argv, '--src') || path.join(path.dirname(path.resolve(configPath)), 'bridge.db');
  const dryRun = hasFlag(process.argv, '--dry-run');

  if (!fs.existsSync(configPath)) { console.error(`config missing: ${configPath}`); process.exit(2); }
  if (!fs.existsSync(srcPath))    { console.error(`src missing: ${srcPath}`);     process.exit(2); }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const bots = Object.keys(config.bots || {});
  if (!bots.length) { console.error('no bots in config'); process.exit(2); }

  const chatToBot = {};
  for (const [chatId, chat] of Object.entries(config.chats || {})) {
    chatToBot[chatId] = chat.bot;
  }

  console.log(`[split-db] src: ${srcPath}`);
  console.log(`[split-db] bots: ${bots.join(', ')}`);
  if (dryRun) console.log('[split-db] DRY RUN - no files written or renamed');

  // Refuse to split if a live polygram is writing to srcPath. The WAL file's
  // presence + recent mtime is a strong proxy: SQLite WAL checkpoints after
  // ~1000 pages or a clean close, so a hot WAL means an active writer.
  refuseIfActiveWriter(srcPath);

  const src = open(srcPath);
  const stats = {};

  // One BEGIN IMMEDIATE transaction over the source gives us a consistent
  // read snapshot across all per-bot copies. Without this, rows inserted
  // between bot-A's SELECT and bot-B's SELECT could vanish in the archive.
  const srcTx = src.raw.transaction(() => {
    for (const bot of bots) {
      const target = path.join(path.dirname(srcPath), `${bot}.db`);
      console.log(`[split-db] ${bot} -> ${target}`);
      if (dryRun) {
        stats[bot] = count(src, bot, chatToBot);
        continue;
      }
      const dst = open(target);
      try {
        stats[bot] = copy(src, dst, bot, chatToBot);
      } finally {
        dst.raw.close();
      }
    }
  });
  // `transaction` runs deferred by default; we want immediate write-lock
  // on the source to block any concurrent polygram from slipping in.
  srcTx.immediate();

  src.raw.close();

  console.log('\n[split-db] copied rows:');
  for (const [bot, s] of Object.entries(stats)) {
    console.log(`  ${bot}: messages=${s.messages} sessions=${s.sessions} pairings=${s.pairings} approvals=${s.approvals} pair_codes=${s.pair_codes} config_changes=${s.config_changes} events=${s.events} chat_migrations=${s.chat_migrations}`);
  }

  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const archivePath = `${srcPath}.archived-${stamp}`;
    fs.renameSync(srcPath, archivePath);
    for (const suf of ['-wal', '-shm']) {
      if (fs.existsSync(srcPath + suf)) fs.renameSync(srcPath + suf, archivePath + suf);
    }
    console.log(`\n[split-db] archived source -> ${archivePath}`);
  }
}

function refuseIfActiveWriter(srcPath) {
  const wal = `${srcPath}-wal`;
  if (!fs.existsSync(wal)) return;
  const age = Date.now() - fs.statSync(wal).mtimeMs;
  // 60s is generous — a clean polygram shutdown checkpoints the WAL.
  // A hot WAL (< 60s) strongly suggests a live writer.
  if (age < 60_000) {
    console.error(`[split-db] refusing: ${wal} is active (mtime ${Math.round(age/1000)}s ago)`);
    console.error('[split-db] stop the polygram process(es) first: launchctl unload ...');
    process.exit(3);
  }
}

function count(src, bot, chatToBot) {
  const chatIds = chatIdsForBot(chatToBot, bot);
  const q = (sql, params = []) => src.raw.prepare(sql).get(...params).n;
  return {
    messages:         chatIds.length ? q(`SELECT COUNT(*) AS n FROM messages WHERE chat_id IN (${ph(chatIds.length)}) OR bot_name = ?`, [...chatIds, bot]) : 0,
    sessions:         chatIds.length ? q(`SELECT COUNT(*) AS n FROM sessions WHERE chat_id IN (${ph(chatIds.length)})`, chatIds) : 0,
    pair_codes:       q(`SELECT COUNT(*) AS n FROM pair_codes WHERE bot_name = ?`, [bot]),
    pairings:         q(`SELECT COUNT(*) AS n FROM pairings WHERE bot_name = ?`, [bot]),
    approvals:        q(`SELECT COUNT(*) AS n FROM pending_approvals WHERE bot_name = ?`, [bot]),
    config_changes:   chatIds.length ? q(`SELECT COUNT(*) AS n FROM config_changes WHERE chat_id IN (${ph(chatIds.length)})`, chatIds) : 0,
    events:           q(`SELECT COUNT(*) AS n FROM events`),
    chat_migrations:  q(`SELECT COUNT(*) AS n FROM chat_migrations`),
  };
}

function copy(src, dst, bot, chatToBot) {
  const chatIds = chatIdsForBot(chatToBot, bot);
  const stats = {
    messages: 0, sessions: 0, pair_codes: 0, pairings: 0, approvals: 0,
    config_changes: 0, events: 0, chat_migrations: 0,
  };

  const tx = dst.raw.transaction(() => {
    if (chatIds.length) {
      const rows = src.raw.prepare(
        `SELECT * FROM messages WHERE chat_id IN (${ph(chatIds.length)}) OR bot_name = ?`,
      ).all(...chatIds, bot);
      const ins = dst.raw.prepare(`
        INSERT OR IGNORE INTO messages
          (id, chat_id, thread_id, msg_id, user, user_id, text, reply_to_id,
           direction, source, bot_name, attachments_json, session_id,
           model, effort, turn_id, status, error, cost_usd, ts, edited_ts)
        VALUES
          (@id, @chat_id, @thread_id, @msg_id, @user, @user_id, @text, @reply_to_id,
           @direction, @source, @bot_name, @attachments_json, @session_id,
           @model, @effort, @turn_id, @status, @error, @cost_usd, @ts, @edited_ts)
      `);
      for (const r of rows) { if (ins.run(r).changes) stats.messages++; }

      const srows = src.raw.prepare(`SELECT * FROM sessions WHERE chat_id IN (${ph(chatIds.length)})`).all(...chatIds);
      const sins = dst.raw.prepare(`
        INSERT OR REPLACE INTO sessions
          (session_key, chat_id, thread_id, claude_session_id,
           agent, cwd, model, effort, created_ts, last_active_ts)
        VALUES
          (@session_key, @chat_id, @thread_id, @claude_session_id,
           @agent, @cwd, @model, @effort, @created_ts, @last_active_ts)
      `);
      for (const r of srows) { if (sins.run(r).changes) stats.sessions++; }

      const crows = src.raw.prepare(`SELECT * FROM config_changes WHERE chat_id IN (${ph(chatIds.length)})`).all(...chatIds);
      const cins = dst.raw.prepare(`
        INSERT OR IGNORE INTO config_changes
          (id, chat_id, thread_id, field, old_value, new_value, user_id, user, source, ts)
        VALUES
          (@id, @chat_id, @thread_id, @field, @old_value, @new_value, @user_id, @user, @source, @ts)
      `);
      for (const r of crows) { if (cins.run(r).changes) stats.config_changes++; }
    }

    copyTable(src, dst,
      `SELECT * FROM pair_codes WHERE bot_name = ?`, [bot],
      `INSERT OR IGNORE INTO pair_codes
        (code, bot_name, chat_id, scope, issued_by_user_id, issued_ts,
         expires_ts, used_by_user_id, used_ts, note)
       VALUES
        (@code, @bot_name, @chat_id, @scope, @issued_by_user_id, @issued_ts,
         @expires_ts, @used_by_user_id, @used_ts, @note)`,
      stats, 'pair_codes');

    copyTable(src, dst,
      `SELECT * FROM pairings WHERE bot_name = ?`, [bot],
      `INSERT OR IGNORE INTO pairings
        (id, bot_name, user_id, chat_id, granted_ts, granted_by_user_id, revoked_ts, note)
       VALUES
        (@id, @bot_name, @user_id, @chat_id, @granted_ts, @granted_by_user_id, @revoked_ts, @note)`,
      stats, 'pairings');

    copyTable(src, dst,
      `SELECT * FROM pending_approvals WHERE bot_name = ?`, [bot],
      `INSERT OR IGNORE INTO pending_approvals
        (id, bot_name, turn_id, requester_chat_id, approver_chat_id, approver_msg_id,
         tool_name, tool_input_json, tool_input_digest, callback_token,
         status, requested_ts, decided_ts, decided_by_user_id, decided_by_user,
         timeout_ts, reason)
       VALUES
        (@id, @bot_name, @turn_id, @requester_chat_id, @approver_chat_id, @approver_msg_id,
         @tool_name, @tool_input_json, @tool_input_digest, @callback_token,
         @status, @requested_ts, @decided_ts, @decided_by_user_id, @decided_by_user,
         @timeout_ts, @reason)`,
      stats, 'approvals');

    copyTable(src, dst,
      `SELECT * FROM events`, [],
      `INSERT OR IGNORE INTO events
        (id, ts, chat_id, kind, detail_json)
       VALUES (@id, @ts, @chat_id, @kind, @detail_json)`,
      stats, 'events');

    copyTable(src, dst,
      `SELECT * FROM chat_migrations`, [],
      `INSERT OR IGNORE INTO chat_migrations
        (old_chat_id, new_chat_id, migrated_ts)
       VALUES (@old_chat_id, @new_chat_id, @migrated_ts)`,
      stats, 'chat_migrations');
  });
  tx();

  return stats;
}

function copyTable(src, dst, selectSql, selectParams, insertSql, stats, statKey) {
  const rows = src.raw.prepare(selectSql).all(...selectParams);
  const ins = dst.raw.prepare(insertSql);
  for (const r of rows) {
    if (ins.run(r).changes) stats[statKey]++;
  }
}

function chatIdsForBot(chatToBot, bot) {
  return Object.entries(chatToBot).filter(([, b]) => b === bot).map(([id]) => id);
}

function ph(n) { return new Array(n).fill('?').join(','); }

if (require.main === module) main();

module.exports = { copy, count, chatIdsForBot };

#!/usr/bin/env node
/**
 * polygram-doctor — operational health check for a polygram bot.
 *
 *   polygram-doctor --bot <name>
 *     run default static checks (config / DB / IPC / Telegram)
 *
 *   polygram-doctor --bot <name> --roundtrip --to <chat_id>
 *     also do an outbound round-trip: IPC send → Telegram → DB read-back
 *
 *   polygram-doctor --bot <name> --json
 *     machine-readable output for monitoring pipelines
 *
 * Exit codes:
 *   0  all checks passed (warnings allowed unless --strict)
 *   1  at least one check failed
 *   2  bad invocation / missing args
 *
 * Extended from OpenClaw's doctor.ts pattern: config, token, reachability,
 * membership checks, recent-error trail. Safe to run against a live bot
 * (no state changes) unless --roundtrip is passed, which posts a single
 * disable_notification=true message.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const {
  call, tell, socketPathFor, readSecret,
} = require('../lib/ipc-client');

// ─── Arg parsing ─────────────────────────────────────────────────────

function parseArg(argv, flag, { required = false } = {}) {
  const i = argv.indexOf(flag);
  if (i === -1) {
    if (required) die(`missing required flag: ${flag}`);
    return null;
  }
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) die(`${flag} requires a value`);
  return v;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function die(msg) {
  process.stderr.write(`polygram-doctor: ${msg}\n`);
  process.exit(2);
}

const argv = process.argv;
const botName = parseArg(argv, '--bot', { required: true });
const configPath = parseArg(argv, '--config')
  || process.env.POLYGRAM_CONFIG
  || path.join(process.cwd(), 'config.json');
const dbPath = parseArg(argv, '--db')
  || process.env.POLYGRAM_DB
  || path.join(process.cwd(), `${botName}.db`);
const roundtripTo = parseArg(argv, '--to');
const doRoundtrip = hasFlag(argv, '--roundtrip');
const asJson = hasFlag(argv, '--json');
const strict = hasFlag(argv, '--strict');
const timeoutMs = parseInt(parseArg(argv, '--timeout-ms') || '8000', 10);

if (doRoundtrip && !roundtripTo) die('--roundtrip requires --to <chat_id>');

// ─── Check accumulator ───────────────────────────────────────────────

const checks = [];
function push(name, status, detail, extra) {
  checks.push({ name, status, detail, extra });
  if (!asJson) {
    const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
    let line = `${icon} ${name}`;
    if (detail) line += ` — ${detail}`;
    console.log(line);
  }
}

// ─── Checks ──────────────────────────────────────────────────────────

function checkConfig() {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); }
  catch (e) { push('config', 'fail', `cannot read ${configPath}: ${e.message}`); return null; }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { push('config', 'fail', `invalid JSON: ${e.message}`); return null; }
  if (!cfg.bots || !cfg.bots[botName]) {
    push('config', 'fail', `bot "${botName}" not in config.bots`);
    return null;
  }
  const bot = cfg.bots[botName];
  if (!bot.token) {
    push('config', 'fail', `bot.${botName}.token is empty`);
    return cfg;
  }
  const chatCount = Object.values(cfg.chats || {}).filter(c => c.bot === botName).length;
  if (chatCount === 0) {
    push('config', 'warn', `bot owns 0 chats in config.chats`);
  } else {
    push('config', 'ok', `bot found, ${chatCount} chat(s), admin=${bot.adminChatId || 'none'}`);
  }
  return cfg;
}

function checkDb() {
  if (!fs.existsSync(dbPath)) {
    push('db', 'fail', `no file at ${dbPath}`);
    return null;
  }
  let db;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch (e) { push('db', 'fail', `cannot open: ${e.message}`); return null; }
  try {
    const version = db.pragma('user_version', { simple: true });
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => /^\d+.*\.sql$/.test(f));
    const latest = files.length
      ? Math.max(...files.map(f => parseInt(f.match(/^(\d+)/)[1], 10)))
      : 0;
    if (version === latest) {
      push('db', 'ok', `schema v${version}`, { version, latest });
    } else if (version < latest) {
      push('db', 'warn', `schema v${version}, migrations dir has v${latest}; restart bot to apply`, { version, latest });
    } else {
      push('db', 'warn', `schema v${version} ahead of migrations dir v${latest}`, { version, latest });
    }
    return db;
  } catch (e) {
    push('db', 'fail', e.message);
    db.close();
    return null;
  }
}

async function checkIpc() {
  try {
    const res = await call({
      path: socketPathFor(botName),
      op: 'ping',
      callTimeoutMs: timeoutMs,
    });
    if (res?.ok && res.pong) {
      push('ipc', 'ok', `socket responsive, bot=${res.bot}`);
      return true;
    }
    push('ipc', 'fail', JSON.stringify(res));
    return false;
  } catch (err) {
    // Distinguish "no socket" (bot not running) from "socket dead"
    if (/ENOENT|ECONNREFUSED/.test(err.message)) {
      push('ipc', 'warn', `bot not running — IPC socket absent at ${socketPathFor(botName)}`);
    } else {
      push('ipc', 'fail', err.message);
    }
    return false;
  }
}

async function checkTelegram(cfg) {
  if (!cfg || !cfg.bots?.[botName]?.token) {
    push('telegram', 'warn', 'skipped — no token in config');
    return;
  }
  const token = cfg.bots[botName].token;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!data.ok) {
      push('telegram', 'fail', `getMe returned: ${data.description || data.error_code}`);
      return;
    }
    push('telegram', 'ok', `@${data.result.username} (${data.result.first_name})`,
      { username: data.result.username, id: data.result.id });
  } catch (err) {
    push('telegram', 'fail', err.message);
  }
}

function checkRecentErrors(db) {
  if (!db) { push('recent-errors', 'warn', 'skipped — no db'); return; }
  try {
    const since = Date.now() - 24 * 3600 * 1000;
    const rows = db.prepare(`
      SELECT kind, COUNT(*) AS n
        FROM events
       WHERE ts >= ?
         AND kind IN (
           'handler-error', 'telegram-api-error', 'telegram-edit-failed',
           'poll-stalled', 'resume-fail', 'turn-timeout',
           'typing-suspended', 'approval-sweep-failed', 'malformed-update',
           'telegram-retry', 'telegram-thread-fallback'
         )
       GROUP BY kind
       ORDER BY n DESC
    `).all(since);
    if (rows.length === 0) {
      push('recent-errors', 'ok', 'no failure events in last 24h');
      return;
    }
    const summary = rows.map(r => `${r.kind}=${r.n}`).join(', ');
    // Hard-fail on real errors, warn on retry/fallback (those are recoveries).
    const hasHardError = rows.some(r =>
      r.kind === 'handler-error' || r.kind === 'resume-fail' ||
      r.kind === 'turn-timeout' || r.kind === 'approval-sweep-failed'
    );
    push('recent-errors', hasHardError ? 'warn' : 'ok', summary, { rows });
  } catch (e) {
    push('recent-errors', 'fail', e.message);
  }
}

function checkPendingOutbound(db) {
  if (!db) return;
  try {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const stale = db.prepare(`
      SELECT COUNT(*) AS n FROM messages
       WHERE status = 'pending' AND bot_name = ? AND ts < ?
    `).get(botName, cutoff).n;
    if (stale > 0) {
      push('pending-outbound', 'warn', `${stale} pending rows older than 5min — bot may have crashed mid-send`);
    } else {
      push('pending-outbound', 'ok', 'no stale pending outbound rows');
    }
  } catch (e) {
    push('pending-outbound', 'fail', e.message);
  }
}

function checkApprovals(db) {
  if (!db) return;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM approvals
       WHERE status = 'pending' AND bot_name = ?
    `).get(botName);
    if (row.n > 0) {
      push('approvals', 'warn', `${row.n} pending approval(s) — operator may need to act`);
    } else {
      push('approvals', 'ok', 'no pending approvals');
    }
  } catch (e) {
    // Table may not exist pre-migration — not fatal.
    push('approvals', 'warn', `skipped: ${e.message}`);
  }
}

async function checkRoundtrip() {
  if (!doRoundtrip) return;
  const marker = `polygram-doctor:${Date.now()}`;
  try {
    const res = await tell(botName, 'sendMessage', {
      chat_id: roundtripTo,
      text: marker,
      disable_notification: true,
    }, { source: 'polygram-doctor', callTimeoutMs: timeoutMs });
    const msgId = res?.message_id;
    if (!msgId) {
      push('roundtrip', 'fail', `no message_id: ${JSON.stringify(res)}`);
      return;
    }
    // DB read-back
    await new Promise((r) => setTimeout(r, 250));
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`
      SELECT direction, status, text FROM messages
       WHERE chat_id = ? AND msg_id = ?
    `).get(String(roundtripTo), msgId);
    db.close();
    if (!row) { push('roundtrip', 'fail', `no DB row for msg_id=${msgId}`); return; }
    if (row.status !== 'sent' || row.direction !== 'out') {
      push('roundtrip', 'fail', `row status=${row.status} direction=${row.direction}`);
      return;
    }
    if (!String(row.text).includes(marker)) {
      push('roundtrip', 'fail', 'marker not in DB row');
      return;
    }
    push('roundtrip', 'ok', `msg_id=${msgId} delivered + recorded`);
  } catch (err) {
    push('roundtrip', 'fail', err.message);
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const cfg = checkConfig();
  const db = checkDb();
  await checkIpc();
  await checkTelegram(cfg);
  checkRecentErrors(db);
  checkPendingOutbound(db);
  checkApprovals(db);
  await checkRoundtrip();
  if (db) try { db.close(); } catch {}

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;

  if (asJson) {
    console.log(JSON.stringify({ bot: botName, checks, fails, warns }, null, 2));
  } else {
    const passed = checks.length - fails - warns;
    console.log(`\n${passed} ok / ${warns} warn / ${fails} fail  (bot=${botName})`);
  }

  if (fails > 0) process.exit(1);
  if (strict && warns > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`polygram-doctor: unexpected error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * polygram-smoke — round-trip health check for a polygram bot.
 *
 *   polygram-smoke --bot <name> --to <chat_id>
 *
 * Exits 0 if all three round-trips pass, 1 otherwise.
 *
 * Intended for cron (heartbeat) or ad-hoc operator verification.
 *
 * Round-trips:
 *   1. IPC ping     — socket is alive and handshakes
 *   2. Outbound     — IPC 'send' op → Telegram API → returns msg_id
 *   3. DB read-back — that msg_id appears in messages table with
 *                     direction='out', status='sent', matching text
 */

const path = require('path');
const Database = require('better-sqlite3');
const { call, tell, socketPathFor, readSecret } = require('../lib/ipc-client');

function parseArg(argv, flag, required = false) {
  const i = argv.indexOf(flag);
  if (i === -1) {
    if (required) die(`missing required flag: ${flag}`);
    return null;
  }
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) die(`${flag} requires a value`);
  return v;
}

function die(msg) {
  process.stderr.write(`polygram-smoke: ${msg}\n`);
  process.exit(2);
}

const bot = parseArg(process.argv, '--bot', true);
const to = parseArg(process.argv, '--to', true);
const dbPath = parseArg(process.argv, '--db')
  || process.env.POLYGRAM_DB
  || path.join(process.cwd(), `${bot}.db`);
const timeoutMs = parseInt(parseArg(process.argv, '--timeout-ms') || '8000', 10);

const stamp = Date.now();
const marker = `polygram-smoke:${stamp}`;
const results = [];

function report(step, ok, detail) {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${step}${detail ? ` — ${detail}` : ''}`);
  results.push({ step, ok, detail });
}

async function main() {
  // Step 1 — IPC ping
  try {
    const res = await call({
      path: socketPathFor(bot),
      op: 'ping',
      callTimeoutMs: timeoutMs,
    });
    if (res?.ok && res.pong) report('ipc-ping', true, `bot=${res.bot}`);
    else { report('ipc-ping', false, JSON.stringify(res)); exitNow(); }
  } catch (err) {
    report('ipc-ping', false, err.message);
    exitNow();
  }

  // Step 2 — outbound round-trip
  let msgId = null;
  try {
    const res = await tell(bot, 'sendMessage', {
      chat_id: to,
      text: marker,
      disable_notification: true,
    }, { source: 'polygram-smoke', callTimeoutMs: timeoutMs });
    msgId = res?.message_id;
    if (msgId) report('outbound-send', true, `msg_id=${msgId}`);
    else { report('outbound-send', false, JSON.stringify(res)); exitNow(); }
  } catch (err) {
    report('outbound-send', false, err.message);
    exitNow();
  }

  // Step 3 — DB read-back. The sender writes pending→sent in two steps;
  // give it a tick, then query by msg_id.
  await new Promise((r) => setTimeout(r, 250));
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`
      SELECT direction, status, text, source, msg_id
        FROM messages
       WHERE chat_id = ? AND msg_id = ?
    `).get(String(to), msgId);
    db.close();

    if (!row) { report('db-readback', false, `no row for msg_id=${msgId}`); exitNow(); }
    if (row.direction !== 'out') { report('db-readback', false, `direction=${row.direction}`); exitNow(); }
    if (row.status !== 'sent') { report('db-readback', false, `status=${row.status}`); exitNow(); }
    if (!String(row.text).includes(marker)) { report('db-readback', false, `text mismatch: ${row.text?.slice(0, 60)}`); exitNow(); }
    report('db-readback', true, `sent row confirmed (source=${row.source})`);
  } catch (err) {
    report('db-readback', false, err.message);
    exitNow();
  }

  console.log(`\npolygram-smoke: PASS  ${bot}  ${new Date().toISOString()}`);
  process.exit(0);
}

function exitNow() {
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log(`\npolygram-smoke: FAIL  ${passed}/${total} steps  bot=${bot}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('polygram-smoke: unexpected error:', err.message);
  process.exit(1);
});

/**
 * Bridge DB client. Wraps better-sqlite3 with the ops polygram + skill need.
 * Synchronous (better-sqlite3). DB errors are caught by callers so polygram
 * never drops messages because of transcript failures.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 6;

function open(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  runMigrations(db, path.join(__dirname, '..', 'migrations'));
  return wrap(db);
}

function runMigrations(db, migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const currentPre = db.pragma('user_version', { simple: true });
  if (currentPre >= SCHEMA_VERSION) return;

  for (const file of files) {
    const n = parseInt(file.slice(0, 3), 10);
    if (Number.isNaN(n)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // BEGIN IMMEDIATE acquires the write lock up-front, preventing two
    // processes from both reading user_version=N and both attempting to
    // apply migration N+1. The second migrator hits SQLITE_BUSY beyond
    // busy_timeout and errors cleanly instead of corrupting state.
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read inside the transaction so we skip anything another process
      // just committed (check-and-set semantics).
      const current = db.pragma('user_version', { simple: true });
      if (n <= current) {
        db.exec('COMMIT');
        continue;
      }
      console.log(`[db] applying migration ${file}`);
      db.exec(sql);
      db.pragma(`user_version = ${n}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
}

function wrap(db) {
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (
      chat_id, thread_id, msg_id, user, user_id, text, reply_to_id,
      direction, source, bot_name, attachments_json, session_id,
      model, effort, turn_id, status, error, cost_usd, ts
    ) VALUES (
      @chat_id, @thread_id, @msg_id, @user, @user_id, @text, @reply_to_id,
      @direction, @source, @bot_name, @attachments_json, @session_id,
      @model, @effort, @turn_id, @status, @error, @cost_usd, @ts
    )
    ON CONFLICT(chat_id, msg_id) DO UPDATE SET
      text = excluded.text,
      edited_ts = excluded.ts
  `);

  const insertOutboundPendingStmt = db.prepare(`
    INSERT INTO messages (
      chat_id, thread_id, user, text, direction, source, bot_name,
      turn_id, session_id, status, ts, msg_id
    ) VALUES (
      @chat_id, @thread_id, @user, @text, 'out', @source, @bot_name,
      @turn_id, @session_id, 'pending', @ts, @pending_id
    )
  `);

  const markOutboundSentStmt = db.prepare(`
    UPDATE messages SET msg_id = @msg_id, status = 'sent', ts = @ts
    WHERE id = @id
  `);

  const markOutboundFailedStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = @error
    WHERE id = @id
  `);

  const upsertSessionStmt = db.prepare(`
    INSERT INTO sessions (
      session_key, chat_id, thread_id, claude_session_id,
      agent, cwd, model, effort, created_ts, last_active_ts
    ) VALUES (
      @session_key, @chat_id, @thread_id, @claude_session_id,
      @agent, @cwd, @model, @effort, @ts, @ts
    )
    ON CONFLICT(session_key) DO UPDATE SET
      chat_id = excluded.chat_id,
      thread_id = excluded.thread_id,
      claude_session_id = excluded.claude_session_id,
      agent = excluded.agent,
      cwd = excluded.cwd,
      model = excluded.model,
      effort = excluded.effort,
      last_active_ts = excluded.last_active_ts
  `);

  const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE session_key = ?`);
  const touchSessionStmt = db.prepare(`UPDATE sessions SET last_active_ts = ? WHERE session_key = ?`);
  const clearSessionIdStmt = db.prepare(`DELETE FROM sessions WHERE session_key = ?`);

  const getMessageStmt = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? AND msg_id = ?
    ORDER BY id DESC LIMIT 1
  `);

  const setMessageTextStmt = db.prepare(`
    UPDATE messages
       SET text = @text,
           attachments_json = COALESCE(@attachments_json, attachments_json)
     WHERE chat_id = @chat_id AND msg_id = @msg_id
  `);

  const logChatMigrationStmt = db.prepare(`
    INSERT OR REPLACE INTO chat_migrations (old_chat_id, new_chat_id, migrated_ts)
    VALUES (?, ?, ?)
  `);

  const resolveChatIdStmt = db.prepare(`
    SELECT new_chat_id FROM chat_migrations WHERE old_chat_id = ?
  `);

  const logEventStmt = db.prepare(`
    INSERT INTO events (ts, chat_id, kind, detail_json)
    VALUES (?, ?, ?, ?)
  `);

  const logConfigChangeStmt = db.prepare(`
    INSERT INTO config_changes (
      chat_id, thread_id, field, old_value, new_value,
      user_id, user, source, ts
    ) VALUES (
      @chat_id, @thread_id, @field, @old_value, @new_value,
      @user_id, @user, @source, @ts
    )
  `);

  const markStalePendingStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = 'crashed-mid-send'
    WHERE status = 'pending' AND ts < ?
  `);
  const markStalePendingForBotStmt = db.prepare(`
    UPDATE messages SET status = 'failed', error = 'crashed-mid-send'
    WHERE status = 'pending' AND ts < ? AND bot_name = ?
  `);

  return {
    raw: db,

    insertMessage(row) {
      return insertMessageStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        msg_id: row.msg_id,
        user: row.user || null,
        user_id: row.user_id || null,
        text: row.text || '',
        reply_to_id: row.reply_to_id || null,
        direction: row.direction || 'in',
        source: row.source || 'polygram',
        bot_name: row.bot_name || null,
        attachments_json: row.attachments_json || null,
        session_id: row.session_id || null,
        model: row.model || null,
        effort: row.effort || null,
        turn_id: row.turn_id || null,
        status: row.status || 'received',
        error: row.error || null,
        cost_usd: row.cost_usd ?? null,
        ts: row.ts || Date.now(),
      });
    },

    insertOutboundPending(row) {
      return insertOutboundPendingStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        user: row.user || null,
        text: row.text || '',
        source: row.source || 'polygram',
        bot_name: row.bot_name || null,
        turn_id: row.turn_id || null,
        session_id: row.session_id || null,
        ts: row.ts || Date.now(),
        pending_id: row.pending_id,
      });
    },

    markOutboundSent(id, { msg_id, ts }) {
      return markOutboundSentStmt.run({ id, msg_id, ts: ts || Date.now() });
    },

    markOutboundFailed(id, err) {
      return markOutboundFailedStmt.run({ id, error: String(err).slice(0, 500) });
    },

    upsertSession(row) {
      return upsertSessionStmt.run({
        session_key: row.session_key,
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        claude_session_id: row.claude_session_id,
        agent: row.agent || null,
        cwd: row.cwd || null,
        model: row.model || null,
        effort: row.effort || null,
        ts: row.ts || Date.now(),
      });
    },

    getSession(sessionKey) {
      return getSessionStmt.get(sessionKey);
    },

    touchSession(sessionKey, ts = Date.now()) {
      return touchSessionStmt.run(ts, sessionKey);
    },

    clearSessionId(sessionKey) {
      return clearSessionIdStmt.run(sessionKey);
    },

    getMessage(chatId, msgId) {
      return getMessageStmt.get(String(chatId), msgId);
    },

    setMessageText({ chat_id, msg_id, text, attachments_json = null }) {
      return setMessageTextStmt.run({
        chat_id: String(chat_id),
        msg_id,
        text: text ?? '',
        attachments_json,
      });
    },

    logChatMigration(oldChatId, newChatId, ts = Date.now()) {
      return logChatMigrationStmt.run(String(oldChatId), String(newChatId), ts);
    },

    resolveChatId(chatId) {
      const row = resolveChatIdStmt.get(String(chatId));
      return row?.new_chat_id || String(chatId);
    },

    logEvent(kind, { chat_id = null, ...detail } = {}) {
      return logEventStmt.run(
        Date.now(),
        chat_id ? String(chat_id) : null,
        kind,
        Object.keys(detail).length ? JSON.stringify(detail) : null,
      );
    },

    logConfigChange(row) {
      return logConfigChangeStmt.run({
        chat_id: String(row.chat_id),
        thread_id: row.thread_id ? String(row.thread_id) : null,
        field: row.field,
        old_value: row.old_value ?? null,
        new_value: row.new_value,
        user_id: row.user_id || null,
        user: row.user || null,
        source: row.source || 'command',
        ts: row.ts || Date.now(),
      });
    },

    markStalePending(olderThanMs = 60_000, botName = null) {
      const cutoff = Date.now() - olderThanMs;
      if (botName) return markStalePendingForBotStmt.run(cutoff, botName);
      return markStalePendingStmt.run(cutoff);
    },

    // Polling offset persistence — see migrations/005-polling-state.sql.
    // Exposed as its own pair of calls (not lazy-prepared) so tests can
    // round-trip them without going through the full polygram boot flow.
    getPollingOffset(botName) {
      const row = db.prepare('SELECT last_update_id FROM polling_state WHERE bot_name = ?').get(botName);
      return row?.last_update_id ?? 0;
    },
    savePollingOffset(botName, lastUpdateId) {
      db.prepare(`
        INSERT INTO polling_state (bot_name, last_update_id, ts)
        VALUES (?, ?, ?)
        ON CONFLICT(bot_name) DO UPDATE SET last_update_id = excluded.last_update_id, ts = excluded.ts
      `).run(botName, lastUpdateId, Date.now());
    },

    // Inbound handler lifecycle — see migrations/006-inbound-handler-status.sql.
    // Called by handleMessage as the turn progresses. Used by boot replay to
    // find work that was interrupted by a crash or restart.
    setInboundHandlerStatus({ chat_id, msg_id, status }) {
      return db.prepare(`
        UPDATE messages SET handler_status = ?
        WHERE chat_id = ? AND msg_id = ? AND direction = 'in'
      `).run(status, chat_id, msg_id);
    },

    // Find inbound messages that were being processed when polygram stopped.
    // Scoped by bot_name via the chat_id → config mapping, so each bot only
    // replays its own turns on boot. Scoped by olderThanMs (default 30 min)
    // so we never resurrect ancient messages after a long outage.
    getReplayCandidates({ chatIds, olderThanMs = 30 * 60 * 1000, limit = 100 } = {}) {
      if (!Array.isArray(chatIds) || chatIds.length === 0) return [];
      const cutoff = Date.now() - olderThanMs;
      const placeholders = chatIds.map(() => '?').join(',');
      return db.prepare(`
        SELECT id, chat_id, thread_id, msg_id, user, user_id, text, reply_to_id,
               attachments_json, ts, handler_status
          FROM messages
         WHERE direction = 'in'
           AND handler_status IN ('dispatched', 'processing', 'replay-pending')
           AND chat_id IN (${placeholders})
           AND ts > ?
         ORDER BY ts ASC
         LIMIT ?
      `).all(...chatIds, cutoff, limit);
    },

    // Dedupe check: did we already send an outbound reply to this inbound?
    // Prevents double-processing if a redelivered/replayed message has
    // already been answered.
    hasOutboundReplyTo({ chat_id, msg_id }) {
      const row = db.prepare(`
        SELECT 1 FROM messages
         WHERE chat_id = ? AND direction = 'out' AND reply_to_id = ? AND status = 'sent'
         LIMIT 1
      `).get(chat_id, msg_id);
      return !!row;
    },

    // On shutdown, mark any inbound rows still in-flight so the boot replay
    // knows to pick them up. `sessionKey`s narrow the update to the sessions
    // we're draining (useful if we ever do partial shutdown; otherwise leave
    // null to mark all dispatched/processing rows for a bot).
    markReplayPending({ botName, since }) {
      const cutoff = since ?? Date.now() - 30 * 60 * 1000;
      return db.prepare(`
        UPDATE messages SET handler_status = 'replay-pending'
         WHERE direction = 'in'
           AND handler_status IN ('dispatched', 'processing')
           AND bot_name = ?
           AND ts > ?
      `).run(botName, cutoff);
    },
  };
}

module.exports = { open };

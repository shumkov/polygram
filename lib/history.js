/**
 * Read-only query helpers against the bridge transcript DB.
 *
 * All functions take an opened DB wrapper (from `lib/db.js` or a read-only
 * handle). Bot-scope isolation is enforced here: pass `allowedChatIds` and
 * no result will leak outside that list.
 */

const HARD_LIMIT = 500;

function clampLimit(limit, defaultLimit = 20) {
  const n = Number(limit) || defaultLimit;
  if (n < 1) return 1;
  if (n > HARD_LIMIT) return HARD_LIMIT;
  return Math.floor(n);
}

function parseSinceMs(since) {
  if (!since) return null;
  const m = String(since).match(/^(\d+)\s*(h|d|m)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'd').toLowerCase();
  const ms = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 86_400_000;
  return n * ms;
}

// Scope semantics:
//   allowedChatIds === null        → scope disabled (admin/global)
//   allowedChatIds === []          → deny all (bot owns no chats yet)
//   allowedChatIds === [id, ...]   → restrict to those chats
// Empty array must NOT be conflated with null, or a newly-configured bot
// with no chats yet would see the entire transcript.
function withChatScope(sql, params, allowedChatIds, column = 'chat_id') {
  if (allowedChatIds === null || allowedChatIds === undefined) return { sql, params };
  const joiner = /where/i.test(sql) ? ' AND' : ' WHERE';
  if (allowedChatIds.length === 0) {
    return { sql: `${sql}${joiner} 1=0`, params };
  }
  const placeholders = allowedChatIds.map(() => '?').join(',');
  return {
    sql: `${sql}${joiner} ${column} IN (${placeholders})`,
    params: [...params, ...allowedChatIds.map(String)],
  };
}

/**
 * FTS5 input sanitizer. Wraps each whitespace-separated token in double
 * quotes so special operators (AND/OR/NEAR/*) become literals.
 */
function fts5Escape(query) {
  return String(query || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => '"' + t.replace(/"/g, '""') + '"')
    .join(' ');
}

function recent(db, { chatId, threadId = null, limit = 20, since = null, includeOutbound = true, allowedChatIds = null } = {}) {
  const clamped = clampLimit(limit);
  let sql = 'SELECT * FROM messages WHERE chat_id = ?';
  const params = [String(chatId)];
  if (threadId) { sql += ' AND thread_id = ?'; params.push(String(threadId)); }
  if (!includeOutbound) sql += ` AND direction = 'in'`;
  const sinceMs = parseSinceMs(since);
  if (sinceMs) { sql += ' AND ts >= ?'; params.push(Date.now() - sinceMs); }
  const scoped = withChatScope(sql, params, allowedChatIds);
  scoped.sql += ' ORDER BY ts DESC LIMIT ?';
  return db.raw.prepare(scoped.sql).all(...scoped.params, clamped).reverse();
}

function around(db, { chatId, msgId, before = 5, after = 5, allowedChatIds = null } = {}) {
  const chat = String(chatId);
  if (allowedChatIds && !allowedChatIds.map(String).includes(chat)) return [];
  const anchor = db.raw.prepare('SELECT * FROM messages WHERE chat_id = ? AND msg_id = ? ORDER BY id DESC LIMIT 1').get(chat, msgId);
  if (!anchor) return [];
  const b = Math.min(Math.max(0, Number(before) || 0), HARD_LIMIT);
  const a = Math.min(Math.max(0, Number(after) || 0), HARD_LIMIT);
  const beforeRows = db.raw.prepare('SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?').all(chat, anchor.ts, b).reverse();
  const afterRows = db.raw.prepare('SELECT * FROM messages WHERE chat_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?').all(chat, anchor.ts, a);
  return [...beforeRows, anchor, ...afterRows];
}

function search(db, { query, chatId = null, threadId = null, user = null, days = null, limit = 20, allowedChatIds = null } = {}) {
  const q = fts5Escape(query);
  if (!q) return [];
  const clamped = clampLimit(limit);
  let sql = `
    SELECT m.* FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    WHERE messages_fts MATCH ?
  `;
  const params = [q];
  if (chatId) { sql += ' AND m.chat_id = ?'; params.push(String(chatId)); }
  if (threadId) { sql += ' AND m.thread_id = ?'; params.push(String(threadId)); }
  if (user) { sql += ' AND m.user LIKE ?'; params.push(`%${user}%`); }
  if (days) { sql += ' AND m.ts >= ?'; params.push(Date.now() - days * 86_400_000); }
  const scoped = withChatScope(sql, params, allowedChatIds, 'm.chat_id');
  scoped.sql += ' ORDER BY m.ts DESC LIMIT ?';
  return db.raw.prepare(scoped.sql).all(...scoped.params, clamped);
}

function byUser(db, { user, chatId = null, threadId = null, days = 7, limit = 50, allowedChatIds = null } = {}) {
  const clamped = clampLimit(limit, 50);
  let sql = 'SELECT * FROM messages WHERE user LIKE ?';
  const params = [`%${user}%`];
  if (chatId) { sql += ' AND chat_id = ?'; params.push(String(chatId)); }
  if (threadId) { sql += ' AND thread_id = ?'; params.push(String(threadId)); }
  if (days) { sql += ' AND ts >= ?'; params.push(Date.now() - days * 86_400_000); }
  const scoped = withChatScope(sql, params, allowedChatIds);
  scoped.sql += ' ORDER BY ts DESC LIMIT ?';
  return db.raw.prepare(scoped.sql).all(...scoped.params, clamped);
}

function getMsg(db, { msgId, chatId = null, allowedChatIds = null } = {}) {
  let sql = 'SELECT * FROM messages WHERE msg_id = ?';
  const params = [msgId];
  if (chatId) { sql += ' AND chat_id = ?'; params.push(String(chatId)); }
  const scoped = withChatScope(sql, params, allowedChatIds);
  scoped.sql += ' ORDER BY id DESC LIMIT 1';
  return db.raw.prepare(scoped.sql).get(...scoped.params) || null;
}

function stats(db, { chatId = null, threadId = null, days = 7, allowedChatIds = null } = {}) {
  const sinceTs = Date.now() - days * 86_400_000;
  let sql = `SELECT user, direction, COUNT(*) AS count FROM messages WHERE ts >= ?`;
  const params = [sinceTs];
  if (chatId) { sql += ' AND chat_id = ?'; params.push(String(chatId)); }
  if (threadId) { sql += ' AND thread_id = ?'; params.push(String(threadId)); }
  const scoped = withChatScope(sql, params, allowedChatIds);
  scoped.sql += ' GROUP BY user, direction ORDER BY count DESC';
  return db.raw.prepare(scoped.sql).all(...scoped.params);
}

function formatPretty(rows) {
  return rows.map((r) => {
    const d = new Date(r.ts);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const who = r.direction === 'out' ? `[bot:${r.bot_name || '?'}]` : (r.user || '?');
    const text = (r.text || '').replace(/\s+/g, ' ').slice(0, 200);
    return `[${hhmm}] ${who}: ${text} (msg ${r.msg_id})`;
  }).join('\n');
}

module.exports = {
  recent, around, search, byUser, getMsg, stats,
  formatPretty, fts5Escape, parseSinceMs, clampLimit,
  HARD_LIMIT,
};

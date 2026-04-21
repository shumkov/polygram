/**
 * Session lookup helpers.
 *
 * Phase 2: DB is the sole source of truth for session IDs.
 * sessions.json is imported once on first boot after Phase 2 and then renamed
 * out of the way so the bridge can never accidentally fall back to it.
 */

const fs = require('fs');
const path = require('path');

function now() { return Date.now(); }

function countSessions(db) {
  return db.raw.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
}

/**
 * Import sessions.json into the DB if DB is empty. Rename sessions.json once
 * the import (or the detection that DB already has content) is done.
 * Safe to call on every boot — after the first run, sessions.json is gone.
 *
 * @returns {{ imported: number, renamed: boolean, reason: string }}
 */
function migrateJsonToDb(db, sessionsJsonPath, configChats = {}) {
  const exists = fs.existsSync(sessionsJsonPath);
  if (!exists) {
    return { imported: 0, renamed: false, reason: 'no-json' };
  }

  const dbCount = countSessions(db);
  let imported = 0;

  if (dbCount === 0) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
    } catch (err) {
      // Malformed sessions.json must NOT crash the bridge at boot. Rename
      // it out of the way so the next boot doesn't retry the same bad
      // file (crash-loop), log the event for post-mortem, and proceed.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantine = `${sessionsJsonPath}.malformed-${stamp}`;
      try { fs.renameSync(sessionsJsonPath, quarantine); } catch {}
      if (db?.logEvent) {
        try { db.logEvent('sessions-json-malformed', { path: sessionsJsonPath, error: err.message, quarantined_to: quarantine }); } catch {}
      }
      return { imported: 0, renamed: true, reason: `malformed-json: ${err.message}` };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantine = `${sessionsJsonPath}.malformed-${stamp}`;
      try { fs.renameSync(sessionsJsonPath, quarantine); } catch {}
      if (db?.logEvent) {
        try { db.logEvent('sessions-json-malformed', { path: sessionsJsonPath, error: 'not an object', quarantined_to: quarantine }); } catch {}
      }
      return { imported: 0, renamed: true, reason: 'malformed-json: not an object' };
    }
    for (const [sessionKey, claudeSessionId] of Object.entries(json)) {
      if (!claudeSessionId) continue;
      const [chatId, threadId] = sessionKey.split(':');
      const chatConfig = configChats[chatId] || {};
      db.upsertSession({
        session_key: sessionKey,
        chat_id: chatId,
        thread_id: threadId || null,
        claude_session_id: claudeSessionId,
        agent: chatConfig.agent || null,
        cwd: chatConfig.cwd || null,
        model: chatConfig.model || null,
        effort: chatConfig.effort || null,
        ts: now(),
      });
      imported++;
    }
  }

  // Rename so the bridge cannot read it again.
  const stamp = new Date().toISOString().slice(0, 10);
  const archived = `${sessionsJsonPath}.migrated-${stamp}`;
  try {
    fs.renameSync(sessionsJsonPath, archived);
  } catch (err) {
    return { imported, renamed: false, reason: `rename-failed: ${err.message}` };
  }
  return { imported, renamed: true, reason: dbCount === 0 ? 'imported' : 'db-already-populated' };
}

/**
 * Get claude_session_id for a sessionKey, or null.
 */
function getClaudeSessionId(db, sessionKey) {
  if (!db) return null;
  const row = db.getSession(sessionKey);
  return row?.claude_session_id || null;
}

module.exports = { migrateJsonToDb, getClaudeSessionId, countSessions };

/**
 * Session lookup helpers.
 *
 * Phase 2: DB is the sole source of truth for session IDs.
 * sessions.json is imported once on first boot after Phase 2 and then renamed
 * out of the way so polygram can never accidentally fall back to it.
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
      // Malformed sessions.json must NOT crash polygram at boot. Rename
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

  // Rename so polygram cannot read it again.
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

// ─── S2: session-config drift ────────────────────────────────────────
//
// A stored `sessions` row records the config the claude session was
// SPAWNED under (agent / cwd / pm_backend). Those three are
// spawn-identity: they are baked into the process at spawn time —
// `--agent`, the tmux/SDK working dir, the backend class — and cannot
// be changed on a live session. If the chat/topic config has drifted
// from the stored row, `--resume`-ing the old session forces claude
// to run under a config it was never built for. shumorobot
// 2026-05-17 22:03, topic :3: the row was agent=shumabit / cwd=$HOME
// / sdk (created before the Music topic got its per-topic override);
// resuming it under agent=music-curation:music-curator /
// cwd=.../Music/rekordbox / tmux left the TUI never signalling ready.
//
// model + effort are deliberately EXCLUDED from the invalidating set.
// They are NOT spawn-identity: a live `/model` or `/effort` change is
// pushed into the running session by `pm.setModel` /
// `pm.applyFlagSettings` with no respawn (lib/handlers/slash-commands.js,
// lib/handlers/config-callback.js). Including them here would
// destructively drop the whole session — discarding all context — on
// every model switch, double-handling what the live-apply path
// already covers cleanly. The stored model/effort columns are
// informational, not identity.
const SPAWN_IDENTITY_FIELDS = ['agent', 'cwd', 'pm_backend'];

/**
 * Decide whether a stored session can be resumed for the next spawn,
 * or whether config drift means it must be dropped and re-spawned
 * fresh.
 *
 * On drift the stale row is DELETED here — so the very next spawn
 * mints a fresh claude_session_id under the correct config and the
 * `onInit` callback re-upserts the row. This self-heals every
 * pre-migration stale row across all chats with no manual SQL.
 *
 * @param {object|null} db          — DB handle (null → fresh spawn)
 * @param {string} sessionKey
 * @param {object} resolved         — freshly-resolved spawn config
 * @param {string} [resolved.agent]
 * @param {string} [resolved.cwd]
 * @param {string} [resolved.backend] — 'sdk' | 'tmux' (resolved by
 *   process/factory.js pickBackend); compared to the row's pm_backend
 * @returns {{ existingSessionId: string|null, drift: object|null }}
 *   existingSessionId — pass to start() for --resume, or null for a
 *     fresh spawn (no stored row, or drift dropped it)
 *   drift — null when no drift; otherwise { fields, before, after }
 *     for the `session-config-drift` telemetry event
 */
function resolveSessionForSpawn(db, sessionKey, resolved = {}) {
  if (!db) return { existingSessionId: null, drift: null };
  const row = db.getSession(sessionKey);
  if (!row || !row.claude_session_id) {
    return { existingSessionId: null, drift: null };
  }

  // Normalise: a missing field on either side is treated as equal to
  // a missing field on the other (both null/undefined → no drift).
  const after = {
    agent: resolved.agent || null,
    cwd: resolved.cwd || null,
    pm_backend: resolved.backend || null,
  };
  const before = {
    agent: row.agent || null,
    cwd: row.cwd || null,
    pm_backend: row.pm_backend || null,
  };
  const drifted = SPAWN_IDENTITY_FIELDS.filter((f) => {
    // If the resolved config does not specify a field, do not treat
    // it as drift — we have nothing to compare against.
    if (after[f] == null) return false;
    return before[f] !== after[f];
  });

  if (drifted.length === 0) {
    return { existingSessionId: row.claude_session_id, drift: null };
  }

  // Drift: drop the stale row so the next spawn is fresh + correct.
  db.clearSessionId(sessionKey);
  return {
    existingSessionId: null,
    drift: {
      fields: drifted,
      before: { ...before, claude_session_id: row.claude_session_id },
      after,
    },
  };
}

module.exports = {
  migrateJsonToDb,
  getClaudeSessionId,
  resolveSessionForSpawn,
  countSessions,
  SPAWN_IDENTITY_FIELDS,
};

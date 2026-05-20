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
// SPAWNED under. Two of the recorded fields are spawn-identity:
//   - agent — `--agent <name>` is baked into the spawned process;
//     resuming a session spawned under agent X under agent Y forces
//     claude to use Y's system prompt + tool whitelist against
//     conversation history built under X's. Incoherent.
//   - cwd — `--cwd <path>` (SDK) / tmux session cwd; claude resolves
//     project-local config (.claude/settings.json, agent files,
//     plugins) relative to it. Mid-conversation cwd drift means
//     half the messages are answered with one project's allowlist
//     and the other half with another's.
//
// pm_backend was REMOVED from spawn-identity (rc.32, 2026-05-21).
// Both backends spawn the same pinned claude binary and write the
// same on-disk JSONL (~/.claude/projects/<cwd-enc>/<sid>.jsonl) —
// claude itself doesn't know or care which Node-side wrapper invoked
// it. Treating a backend flip as drift was destructively dropping
// context across the SDK→tmux migration window, costing every chat
// its conversation history on its first turn under the new backend.
// shumorobot 2026-05-20 18:51 incident: the Music topic flipped
// tmux→sdk→tmux during runtime and lost its agent's prior context
// at each flip. The orphan-tmux problem that the flip ALSO triggered
// is solved by rc.31's spawn-time reconcile (TmuxProcess.start) —
// independently, so a backend flip is now a no-op for session-state.
//
// shumorobot 2026-05-17 22:03, topic :3 (the original drift incident)
// remains correctly handled: that row had agent+cwd drift in
// addition to backend, so the agent+cwd drift alone still drops it.
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
const SPAWN_IDENTITY_FIELDS = ['agent', 'cwd'];

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

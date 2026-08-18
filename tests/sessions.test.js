/**
 * Tests for lib/sessions.js
 * Run: node --test tests/sessions.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { open } = require('../lib/db');
const {
  migrateJsonToDb,
  getClaudeSessionId,
  resolveSessionForSpawn,
  resolveProviderSessionForSpawn,
  sessionNamespaceFor,
  CLAUDE_INLINE_NAMESPACE,
  CLAUDE_CHANNELS_NAMESPACE,
  CODEX_APP_SERVER_NAMESPACE,
  CODEX_SPAWN_IDENTITY_FIELDS,
} = require('../lib/db/sessions');

let db;
let dbPath;
let jsonPath;

function freshEnv() {
  const rand = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  dbPath = path.join(os.tmpdir(), `sessions-test-${rand}.db`);
  jsonPath = path.join(os.tmpdir(), `sessions-test-${rand}.json`);
  db = open(dbPath);
}

function cleanup() {
  if (db) { try { db.raw.close(); } catch {} db = null; }
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm', jsonPath]) {
    try { fs.unlinkSync(p); } catch {}
  }
  // Clean migrated / malformed sidecars
  const dir = path.dirname(jsonPath);
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(path.basename(jsonPath)) && (f.includes('.migrated-') || f.includes('.malformed-'))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  }
}

const chatConfigs = {
  '123': { agent: 'shumabit', cwd: '/tmp/a', model: 'opus', effort: 'medium' },
  '-100456': { agent: 'umi-assistant', cwd: '/tmp/b', model: 'sonnet', effort: 'low' },
};

describe('migrateJsonToDb', () => {
  beforeEach(() => freshEnv());
  afterEach(() => cleanup());

  test('returns no-json when file is absent', () => {
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.equal(res.renamed, false);
    assert.equal(res.reason, 'no-json');
  });

  test('imports empty DB from JSON, renames file', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({
      '123': 'abc-123',
      '-100456:789': 'def-456',
    }));
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 2);
    assert.equal(res.renamed, true);
    assert.equal(res.reason, 'imported');
    assert.equal(fs.existsSync(jsonPath), false);

    const row1 = db.getSession('123');
    assert.equal(row1.claude_session_id, 'abc-123');
    assert.equal(row1.agent, 'shumabit');
    assert.equal(row1.cwd, '/tmp/a');

    const row2 = db.getSession('-100456:789');
    assert.equal(row2.claude_session_id, 'def-456');
    assert.equal(row2.thread_id, '789');
    assert.equal(row2.agent, 'umi-assistant');
  });

  test('does not overwrite populated DB, still renames JSON', () => {
    db.upsertSession({
      session_key: '123', chat_id: '123', claude_session_id: 'existing',
      model: 'opus', effort: 'high',
    });
    fs.writeFileSync(jsonPath, JSON.stringify({ '123': 'different' }));
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.equal(res.renamed, true);
    assert.equal(res.reason, 'db-already-populated');
    assert.equal(fs.existsSync(jsonPath), false);

    const row = db.getSession('123');
    assert.equal(row.claude_session_id, 'existing', 'DB value wins');
    assert.equal(row.effort, 'high', 'existing row untouched');
  });

  test('second call is a no-op (file already gone)', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({ '1': 'a' }));
    migrateJsonToDb(db, jsonPath, chatConfigs);
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.reason, 'no-json');
  });

  test('skips falsy session ids', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({
      '123': 'good',
      'null-key': null,
      'empty-key': '',
    }));
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 1);
  });

  test('survives missing chat config (unknown chat id)', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({
      '999unknown': 'orphan-session',
    }));
    const res = migrateJsonToDb(db, jsonPath, {});
    assert.equal(res.imported, 1);
    const row = db.getSession('999unknown');
    assert.equal(row.claude_session_id, 'orphan-session');
    assert.equal(row.agent, null);
    assert.equal(row.cwd, null);
  });

  test('renamed file contains original content (for forensics)', () => {
    const payload = { '123': 'abc' };
    fs.writeFileSync(jsonPath, JSON.stringify(payload));
    migrateJsonToDb(db, jsonPath, chatConfigs);
    const dir = path.dirname(jsonPath);
    const base = path.basename(jsonPath);
    const archived = fs.readdirSync(dir).find((f) => f.startsWith(base) && f.includes('.migrated-'));
    assert.ok(archived, 'archived file should exist');
    const content = JSON.parse(fs.readFileSync(path.join(dir, archived), 'utf8'));
    assert.deepEqual(content, payload);
  });
});

describe('migrateJsonToDb — malformed JSON does not crash boot', () => {
  beforeEach(() => freshEnv());
  afterEach(() => cleanup());

  test('syntactically invalid JSON is quarantined, returns malformed-json reason', () => {
    fs.writeFileSync(jsonPath, '{this is not {{ valid json');
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.equal(res.renamed, true);
    assert.match(res.reason, /^malformed-json/);
    // Original file should no longer exist at its original path
    assert.equal(fs.existsSync(jsonPath), false);
    // A .malformed- sidecar should exist
    const dir = path.dirname(jsonPath);
    const base = path.basename(jsonPath);
    const quarantined = fs.readdirSync(dir).find((f) => f.startsWith(base) && f.includes('.malformed-'));
    assert.ok(quarantined, 'quarantined file should exist');
  });

  test('JSON array (not object) is quarantined', () => {
    fs.writeFileSync(jsonPath, JSON.stringify(['not', 'an', 'object']));
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.equal(res.renamed, true);
    assert.match(res.reason, /not an object/);
    assert.equal(fs.existsSync(jsonPath), false);
  });

  test('JSON null is quarantined', () => {
    fs.writeFileSync(jsonPath, 'null');
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.match(res.reason, /not an object/);
  });

  test('sessions-json-malformed event is logged when db.logEvent exists', () => {
    fs.writeFileSync(jsonPath, 'not json');
    migrateJsonToDb(db, jsonPath, chatConfigs);
    const ev = db.raw.prepare("SELECT * FROM events WHERE kind='sessions-json-malformed'").get();
    assert.ok(ev, 'sessions-json-malformed event should be logged');
    const detail = JSON.parse(ev.detail_json);
    // The quarantine is recorded as a fact, not as a filesystem path.
    assert.equal(detail.quarantined, true);
    assert.equal(detail.path, undefined);
  });

  test('works even when db lacks logEvent (no crash)', () => {
    fs.writeFileSync(jsonPath, 'not json');
    const stub = {
      raw: db.raw,
      getSession: db.getSession.bind(db),
      upsertSession: db.upsertSession.bind(db),
      // intentionally no logEvent
    };
    const res = migrateJsonToDb(stub, jsonPath, chatConfigs);
    assert.equal(res.renamed, true);
    assert.match(res.reason, /^malformed-json/);
  });
});

describe('getClaudeSessionId', () => {
  beforeEach(() => freshEnv());
  afterEach(() => cleanup());

  test('returns null when db is null', () => {
    assert.equal(getClaudeSessionId(null, '123'), null);
  });

  test('returns null when session does not exist', () => {
    assert.equal(getClaudeSessionId(db, 'unknown'), null);
  });

  test('returns claude_session_id when present', () => {
    db.upsertSession({ session_key: '123', chat_id: '123', claude_session_id: 'abc' });
    assert.equal(getClaudeSessionId(db, '123'), 'abc');
  });
});

describe('provider session namespaces', () => {
  beforeEach(() => freshEnv());
  afterEach(() => cleanup());

  test('inline, Channels, and Codex resolve to distinct compatibility namespaces', () => {
    assert.equal(
      sessionNamespaceFor({ runtime: 'claude', backend: 'sdk' }),
      CLAUDE_INLINE_NAMESPACE,
    );
    assert.equal(
      sessionNamespaceFor({ runtime: 'claude', backend: 'tmux' }),
      CLAUDE_INLINE_NAMESPACE,
    );
    assert.equal(
      sessionNamespaceFor({ runtime: 'claude', backend: 'cli' }),
      CLAUDE_CHANNELS_NAMESPACE,
    );
    assert.equal(
      sessionNamespaceFor({ runtime: 'claude', backend: 'channels' }),
      CLAUDE_CHANNELS_NAMESPACE,
    );
    assert.equal(
      sessionNamespaceFor({ runtime: 'codex', backend: 'codex' }),
      CODEX_APP_SERVER_NAMESPACE,
    );
  });

  test('Claude → Codex → Claude preserves dormant rows without cross-resume', () => {
    db.upsertSession({
      session_key: 'chat:3',
      chat_id: 'chat',
      thread_id: '3',
      claude_session_id: 'claude-session',
      agent: 'shumabit',
      cwd: '/workspace',
      pm_backend: 'sdk',
      ts: 1000,
    });
    db.upsertProviderSession({
      session_key: 'chat:3',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'codex-thread',
      app_server_session_id: 'diagnostic-session',
      agent: 'shumabit',
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      pm_backend: 'codex',
      ts: 2000,
    });

    const codex = resolveProviderSessionForSpawn(db, 'chat:3', {
      runtime: 'codex',
      backend: 'codex',
      agent: 'shumabit',
      cwd: '/workspace',
    });
    assert.equal(codex.existingSessionId, 'codex-thread');
    assert.equal(codex.appServerSessionId, 'diagnostic-session');

    const claude = resolveProviderSessionForSpawn(db, 'chat:3', {
      runtime: 'claude',
      backend: 'tmux',
      agent: 'shumabit',
      cwd: '/workspace',
    });
    assert.equal(claude.existingSessionId, 'claude-session');
    assert.equal(claude.appServerSessionId, null);
    assert.equal(getClaudeSessionId(db, 'chat:3'), 'claude-session');
    assert.equal(
      db.getProviderSession('chat:3', CODEX_APP_SERVER_NAMESPACE)
        .provider_session_id,
      'codex-thread',
    );
  });

  test('provider reset clears only the selected namespace', () => {
    db.upsertSession({
      session_key: 'chat',
      chat_id: 'chat',
      claude_session_id: 'claude-session',
      pm_backend: 'sdk',
    });
    db.upsertProviderSession({
      session_key: 'chat',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'codex-thread',
      pm_backend: 'codex',
    });

    db.clearProviderSession('chat', CODEX_APP_SERVER_NAMESPACE);

    assert.equal(
      db.getProviderSession('chat', CODEX_APP_SERVER_NAMESPACE),
      undefined,
    );
    assert.equal(getClaudeSessionId(db, 'chat'), 'claude-session');
    assert.equal(
      db.getProviderSession('chat', CLAUDE_INLINE_NAMESPACE)
        .provider_session_id,
      'claude-session',
    );
  });

  test('Codex thread ID is the resume key and app-server session ID is diagnostic only', () => {
    db.upsertProviderSession({
      session_key: 'chat',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'thread-resume-key',
      app_server_session_id: 'diagnostic-only',
      pm_backend: 'codex',
    });
    const resolved = resolveProviderSessionForSpawn(db, 'chat', {
      runtime: 'codex',
      backend: 'codex',
    });
    assert.equal(resolved.existingSessionId, 'thread-resume-key');
    assert.notEqual(resolved.existingSessionId, resolved.appServerSessionId);
  });

  test('Codex spawn identity is exactly cwd', () => {
    assert.deepEqual(CODEX_SPAWN_IDENTITY_FIELDS, ['cwd']);
  });

  test('Codex model and effort changes preserve the provider thread', () => {
    db.upsertProviderSession({
      session_key: 'chat',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'old-thread',
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'high',
      pm_backend: 'codex',
    });

    const resolved = resolveProviderSessionForSpawn(db, 'chat', {
      runtime: 'codex',
      backend: 'codex',
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });

    assert.equal(resolved.existingSessionId, 'old-thread');
    assert.equal(resolved.drift, null);
    assert.equal(
      db.getProviderSession('chat', CODEX_APP_SERVER_NAMESPACE)
        .provider_session_id,
      'old-thread',
    );
  });

  test('Codex cwd change still clears the provider thread', () => {
    db.upsertProviderSession({
      session_key: 'chat',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'old-thread',
      cwd: '/workspace-a',
      model: 'gpt-5.6-sol',
      effort: 'high',
      pm_backend: 'codex',
    });

    const resolved = resolveProviderSessionForSpawn(db, 'chat', {
      runtime: 'codex',
      backend: 'codex',
      cwd: '/workspace-b',
      model: 'gpt-5.5',
      effort: 'xhigh',
    });

    assert.equal(resolved.existingSessionId, null);
    assert.deepEqual(resolved.drift.fields, ['cwd']);
    assert.equal(
      db.getProviderSession('chat', CODEX_APP_SERVER_NAMESPACE),
      undefined,
    );
  });

  test('runtime-switch preparation reports Codex drift without deleting the dormant thread', () => {
    db.upsertProviderSession({
      session_key: 'chat',
      namespace: CODEX_APP_SERVER_NAMESPACE,
      provider: 'codex',
      provider_session_id: 'old-thread',
      cwd: '/workspace-a',
      model: 'gpt-5.6-sol',
      effort: 'high',
      pm_backend: 'codex',
    });

    const resolved = resolveProviderSessionForSpawn(db, 'chat', {
      runtime: 'codex',
      backend: 'codex',
      cwd: '/workspace-b',
      model: 'gpt-5.6-sol',
      effort: 'high',
    }, { mutateOnDrift: false });

    assert.equal(resolved.existingSessionId, null);
    assert.deepEqual(resolved.drift.fields, ['cwd']);
    assert.equal(
      db.getProviderSession('chat', CODEX_APP_SERVER_NAMESPACE)
        .provider_session_id,
      'old-thread',
    );
  });
});

// ─── S2: session-config drift detection ──────────────────────────────
//
// A stored session row is valid ONLY for the config it was created
// under. agent / cwd / pm_backend are spawn-identity — baked into the
// process at spawn time, never mutable on a live session. If the
// chat/topic config has drifted from the stored row, polygram must
// DROP the session and spawn fresh, never `--resume` into a stale
// config. shumorobot 2026-05-17 22:03, topic :3: the stored row was
// agent=shumabit / cwd=$HOME / sdk (pre per-topic config); the Music
// topic now resolves to agent=music-curation:music-curator /
// cwd=.../Music/rekordbox / tmux. A `--resume` into that mismatch
// left the TUI never signalling ready.
describe('resolveSessionForSpawn (S2 drift)', () => {
  beforeEach(() => freshEnv());
  afterEach(() => cleanup());

  const resolved = {
    agent: 'music-curation:music-curator',
    cwd: '/Users/ivanshumkov/Music/rekordbox',
    backend: 'tmux',
  };

  test('no stored row → fresh spawn, no drift', () => {
    const r = resolveSessionForSpawn(db, 'chat:new', resolved);
    assert.equal(r.existingSessionId, null);
    assert.equal(r.drift, null);
  });

  test('matching row → resumes (existingSessionId returned, no drift)', () => {
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-match',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'tmux',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', resolved);
    assert.equal(r.existingSessionId, 'sess-match');
    assert.equal(r.drift, null);
  });

  test('agent drift → drops the session, fresh spawn, drift reported', () => {
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-stale',
      agent: 'shumabit',                              // ← differs
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'tmux',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', resolved);
    assert.equal(r.existingSessionId, null, 'must NOT resume a stale-agent session');
    assert.ok(r.drift, 'drift must be reported');
    assert.ok(r.drift.fields.includes('agent'), 'agent listed as drifted field');
    assert.equal(r.drift.before.agent, 'shumabit');
    assert.equal(r.drift.after.agent, 'music-curation:music-curator');
    // The stale row must be gone so a fresh claude_session_id is minted.
    assert.equal(db.getSession('chat:3'), undefined);
  });

  test('cwd drift → drops the session, fresh spawn', () => {
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-stale',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov',                      // ← differs
      pm_backend: 'tmux',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', resolved);
    assert.equal(r.existingSessionId, null);
    assert.ok(r.drift.fields.includes('cwd'));
    assert.equal(db.getSession('chat:3'), undefined);
  });

  test('backend flip alone (sdk↔tmux) PRESERVES the session', () => {
    // Migration target: pm_backend is no longer drift-invalidating.
    // Both backends spawn the same pinned claude binary and write the
    // same on-disk JSONL at ~/.claude/projects/<cwd>/<sid>.jsonl —
    // claude itself doesn't know or care which Node-side wrapper
    // invoked it. Flipping pm_backend with agent+cwd unchanged must
    // preserve the row so the next spawn `--resume`s with full
    // conversation context. (Pre-this-change, this drift dropped the
    // row, costing the user every prior message in the chat across
    // the SDK→tmux migration window.)
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-keep-across-flip',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'sdk',                              // ← prior backend
    });
    const r = resolveSessionForSpawn(db, 'chat:3', resolved); // resolved.backend = 'tmux'
    assert.equal(r.existingSessionId, 'sess-keep-across-flip',
      'backend flip alone must preserve session id');
    assert.equal(r.drift, null);
    assert.ok(db.getSession('chat:3'), 'row stays in place');
  });

  // 0.11.0 rc.6: channels boundary. SDK ↔ tmux flips preserve sessions
  // (per rc.32 reasoning above) but any transition INVOLVING channels
  // drops the prior session. Channels mode adds a bridge MCP server +
  // a system-prompt reply-tool directive — sessions created without
  // those elements have different conversation-context expectations,
  // and resuming them under channels (or back from channels to a
  // non-channels backend) caused the live shumorobot 2026-05-25 Music
  // topic incident: claude resumed a pre-channels session id and
  // continued the OLD task instead of treating the new channel
  // message as a fresh prompt.
  test('rc.6: sdk → channels flip DROPS the session', () => {
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-pre-channels-from-sdk',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'sdk',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', { ...resolved, backend: 'cli' });
    assert.equal(r.existingSessionId, null, 'sdk → channels must drop the session');
    assert.ok(r.drift, 'drift must be reported');
    assert.ok(r.drift.fields.includes('pm_backend'), 'pm_backend listed as drifted field');
    assert.equal(r.drift.before.pm_backend, 'sdk');
    assert.equal(r.drift.after.pm_backend, 'cli');
    assert.equal(db.getSession('chat:3'), undefined, 'row deleted');
  });

  test('runtime-switch preparation reports a channels boundary without deleting first', () => {
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-prepared-only',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'sdk',
    });

    const r = resolveSessionForSpawn(
      db,
      'chat:3',
      { ...resolved, backend: 'cli' },
      { mutateOnDrift: false },
    );

    assert.equal(r.existingSessionId, null);
    assert.ok(r.drift.fields.includes('pm_backend'));
    assert.equal(
      db.getSession('chat:3').claude_session_id,
      'sess-prepared-only',
    );
  });

  test('rc.6: tmux → channels flip DROPS the session', () => {
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-pre-channels-from-tmux',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'tmux',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', { ...resolved, backend: 'cli' });
    assert.equal(r.existingSessionId, null, 'tmux → channels must drop the session');
    assert.ok(r.drift, 'drift must be reported');
    assert.ok(r.drift.fields.includes('pm_backend'), 'pm_backend in drifted fields');
  });

  test('rc.6: channels → tmux flip ALSO drops (XOR — both directions invalidate)', () => {
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-from-channels-back-to-tmux',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'cli',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', { ...resolved, backend: 'tmux' });
    assert.equal(r.existingSessionId, null,
      'channels → tmux drops too — the reverse direction is symmetric. ' +
      'Conversation context from a channels turn (where claude responded via ' +
      'mcp__polygram-bridge__reply) is incompatible with the inline-reply pattern ' +
      'tmux expects.');
    assert.ok(r.drift, 'drift reported in reverse direction too');
  });

  test('rc.6: channels → channels is NOT drift (in-daemon lazy respawn must --resume)', () => {
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-still-channels',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'cli',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', { ...resolved, backend: 'cli' });
    assert.equal(r.existingSessionId, 'sess-still-channels',
      'channels → channels preserves the session — the lazy-respawn case ' +
      'after a bridge-disconnect depends on --resume restoring the in-flight turn');
    assert.equal(r.drift, null);
  });

  test('rc.6: sdk → tmux still preserves (rc.32 contract untouched)', () => {
    // Defensive: make sure the channels-boundary addition didn't break
    // the rc.32 invariant that sdk ↔ tmux is freely interchangeable.
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-sdk-to-tmux-keep',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      pm_backend: 'sdk',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', { ...resolved, backend: 'tmux' });
    assert.equal(r.existingSessionId, 'sess-sdk-to-tmux-keep',
      'sdk → tmux must STILL preserve — channels boundary is the only new exception');
    assert.equal(r.drift, null);
  });

  test('model/effort difference does NOT invalidate (applied live, not spawn-identity)', () => {
    // /model and /effort are pushed into a live session via
    // setModel / applyFlagSettings — no respawn. Including them here
    // would destructively drop context on every model switch.
    db.upsertSession({
      session_key: 'chat:3', chat_id: 'chat', thread_id: '3',
      claude_session_id: 'sess-keep',
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      model: 'opus', effort: 'low',
      pm_backend: 'tmux',
    });
    const r = resolveSessionForSpawn(db, 'chat:3', {
      ...resolved, model: 'sonnet', effort: 'high',
    });
    assert.equal(r.existingSessionId, 'sess-keep', 'model/effort drift must NOT drop the session');
    assert.equal(r.drift, null);
  });

  test('the actual stale shumorobot :3 row self-heals (agent+cwd drift; backend flip incidental)', () => {
    // Reproduce the exact production row (from ~/.polygram/shumorobot.db
    // sessions table): agent=shumabit, cwd=$HOME, pm_backend=sdk.
    db.upsertSession({
      session_key: '-1003807211164:3',
      chat_id: '-1003807211164', thread_id: '3',
      claude_session_id: 'ec13e620-4975-4bff-a5d3-451f9d2dd390',
      agent: 'shumabit',
      cwd: '/Users/ivanshumkov',
      model: 'sonnet', effort: 'high',
      pm_backend: 'sdk',
    });
    // The Music topic's resolved config today.
    const r = resolveSessionForSpawn(db, '-1003807211164:3', {
      agent: 'music-curation:music-curator',
      cwd: '/Users/ivanshumkov/Music/rekordbox',
      backend: 'tmux',
    });
    assert.equal(r.existingSessionId, null, 'stale :3 row must NOT be resumed');
    // Backend flip is no longer drift-invalidating (see "backend flip
    // alone" test above) — only the real config drift (agent + cwd)
    // appears in the drift report. The row still drops because agent
    // AND cwd both changed.
    assert.deepEqual(r.drift.fields.sort(), ['agent', 'cwd']);
    assert.equal(db.getSession('-1003807211164:3'), undefined, ':3 row self-heals (dropped)');
  });

  test('null db → fresh spawn, no throw', () => {
    const r = resolveSessionForSpawn(null, 'chat:3', resolved);
    assert.equal(r.existingSessionId, null);
    assert.equal(r.drift, null);
  });
});

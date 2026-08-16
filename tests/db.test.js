/**
 * Unit tests for lib/db.js
 * Run: node --test tests/db.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { open } = require('../lib/db'); // a couple of tests open a 2nd connection to the same file

let db;
let dbPath;

describe('schema + migrations', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('user_version is at current schema after migration', () => {
    const v = db.raw.pragma('user_version', { simple: true });
    assert.equal(v, 19);
  });

  test('WAL mode is enabled', () => {
    assert.equal(db.raw.pragma('journal_mode', { simple: true }), 'wal');
  });

  test('all tables exist', () => {
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of [
      'sessions',
      'agent_runtime_sessions',
      'clean_restart_resume_intents',
      'codex_runtime_identity',
      'codex_reboot_releases',
      'codex_generations',
      'codex_daemon_lease',
      'codex_turn_attempts',
      'codex_attempt_checkpoints',
      'inbound_runtime_selections',
      'codex_linked_inputs',
      'codex_dispatch_reservations',
      'codex_item_effects',
      'codex_attempt_reconciliations',
      'codex_retry_reservations',
      'messages',
      'chat_migrations',
      'config_changes',
      'events',
      'messages_fts',
    ]) {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    }
  });

  test('Codex linked-input retention lookups are indexed in both directions', () => {
    const indexes = db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all().map((row) => row.name);
    assert.ok(indexes.includes('idx_codex_linked_inputs_attempt'));
    assert.ok(indexes.includes('idx_codex_linked_inputs_target'));
  });

  test('production-shaped Claude row remains exact across v14 migration and legacy rollback writes', () => {
    const fixturePath = path.join(
      os.tmpdir(),
      `polygram-u5-migration-${process.pid}-${Date.now()}.db`,
    );
    let raw = new Database(fixturePath);
    try {
      const migrationDir = path.join(__dirname, '..', 'migrations');
      for (const file of fs.readdirSync(migrationDir).sort()) {
        const version = Number.parseInt(file.slice(0, 3), 10);
        if (!Number.isSafeInteger(version) || version > 14) continue;
        raw.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
        raw.pragma(`user_version = ${version}`);
      }
      raw.prepare(`
        INSERT INTO sessions (
          session_key, chat_id, thread_id, claude_session_id, agent, cwd,
          model, effort, created_ts, last_active_ts, pm_backend
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '-1003807211164:3',
        '-1003807211164',
        '3',
        'ec13e620-4975-4bff-a5d3-451f9d2dd390',
        'music-curation:music-curator',
        '/Users/ivanshumkov/Music/rekordbox',
        'sonnet',
        'high',
        1_700_000_000_000,
        1_700_000_000_123,
        'tmux',
      );
      const before = raw.prepare('SELECT * FROM sessions').get();
      raw.close();

      const upgraded = open(fixturePath);
      const after = upgraded.raw.prepare('SELECT * FROM sessions').get();
      assert.deepEqual(after, before);
      const providerSession = upgraded.getProviderSession(
        '-1003807211164:3',
        'claude:inline',
      );
      assert.match(providerSession.generation_id, /^[a-f0-9]{32}$/);
      const { generation_id: _generationId, ...providerSessionWithoutGeneration } =
        providerSession;
      assert.deepEqual(
        providerSessionWithoutGeneration,
        {
          session_key: '-1003807211164:3',
          namespace: 'claude:inline',
          provider: 'claude',
          provider_session_id: 'ec13e620-4975-4bff-a5d3-451f9d2dd390',
          app_server_session_id: null,
          agent: 'music-curation:music-curator',
          cwd: '/Users/ivanshumkov/Music/rekordbox',
          model: 'sonnet',
          effort: 'high',
          pm_backend: 'tmux',
          created_ts: 1_700_000_000_000,
          last_active_ts: 1_700_000_000_123,
          spawn_profile_id: null,
        },
      );
      upgraded.upsertProviderSession({
        session_key: '-1003807211164:3',
        namespace: 'codex:app-server',
        provider: 'codex',
        provider_session_id: 'dormant-codex-thread',
        app_server_session_id: 'diagnostic-session',
        pm_backend: 'codex',
        ts: 1_700_000_000_200,
      });
      upgraded.raw.close();

      // Shape used by an old binary: it knows only the legacy sessions table.
      raw = new Database(fixturePath);
      raw.prepare(`
        UPDATE sessions
           SET claude_session_id = ?, last_active_ts = ?
         WHERE session_key = ?
      `).run(
        'rollback-compatible-session',
        1_700_000_000_456,
        '-1003807211164:3',
      );
      assert.equal(
        raw.prepare('SELECT claude_session_id FROM sessions').get().claude_session_id,
        'rollback-compatible-session',
      );
      raw.close();

      const returned = open(fixturePath);
      assert.equal(
        returned.getProviderSession(
          '-1003807211164:3',
          'claude:inline',
        ).provider_session_id,
        'rollback-compatible-session',
      );
      assert.equal(
        returned.getProviderSession(
          '-1003807211164:3',
          'claude:inline',
        ).last_active_ts,
        1_700_000_000_456,
      );
      assert.equal(
        returned.getProviderSession(
          '-1003807211164:3',
          'codex:app-server',
        ).provider_session_id,
        'dormant-codex-thread',
      );
      returned.raw.close();
      raw = null;
    } finally {
      try { raw.close(); } catch {}
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(fixturePath + suffix); } catch {}
      }
    }
  });

  test('FTS triggers are installed', () => {
    const triggers = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name);
    for (const t of ['messages_ai', 'messages_au', 'messages_ad']) {
      assert.ok(triggers.includes(t), `missing trigger: ${t}`);
    }
  });

  test('re-opening existing DB does not rerun migrations', () => {
    const v1 = db.raw.pragma('user_version', { simple: true });
    db.raw.close();
    const db2 = open(dbPath);
    assert.equal(db2.raw.pragma('user_version', { simple: true }), v1);
    db2.raw.close();
    db = null;
  });
});

describe('insertMessage', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('writes inbound row with defaults', () => {
    db.insertMessage({ chat_id: '123', msg_id: 1, user: 'Ivan', text: 'hi', direction: 'in' });
    const row = db.raw.prepare('SELECT * FROM messages WHERE chat_id=? AND msg_id=?').get('123', 1);
    assert.equal(row.user, 'Ivan');
    assert.equal(row.text, 'hi');
    assert.equal(row.direction, 'in');
    assert.equal(row.source, 'polygram');
    assert.equal(row.status, 'received');
    assert.ok(row.ts > 0);
  });

  test('coerces chat_id to string', () => {
    db.insertMessage({ chat_id: -100123, msg_id: 1, text: 'x', direction: 'in' });
    const row = db.raw.prepare('SELECT chat_id FROM messages WHERE msg_id=1').get();
    assert.equal(row.chat_id, '-100123');
  });

  test('stores reply_to_id when present', () => {
    db.insertMessage({ chat_id: '1', msg_id: 2, text: 'reply', direction: 'in', reply_to_id: 1 });
    const row = db.raw.prepare('SELECT reply_to_id FROM messages WHERE msg_id=2').get();
    assert.equal(row.reply_to_id, 1);
  });

  test('stores outbound row with model/effort/cost/turn_id', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 99, direction: 'out', text: 'bot reply',
      bot_name: 'shumabit', session_id: 'sess-123',
      model: 'opus', effort: 'medium', cost_usd: 0.42, turn_id: 't-1',
      status: 'sent', source: 'bot-reply',
    });
    const row = db.raw.prepare('SELECT * FROM messages WHERE msg_id=99').get();
    assert.equal(row.direction, 'out');
    assert.equal(row.model, 'opus');
    assert.equal(row.effort, 'medium');
    assert.equal(row.cost_usd, 0.42);
    assert.equal(row.turn_id, 't-1');
    assert.equal(row.status, 'sent');
  });

  test('edited msg: second insert with same (chat_id, msg_id) updates text + edited_ts', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'original', direction: 'in', ts: 1000 });
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'edited', direction: 'in', ts: 2000 });
    const row = db.raw.prepare('SELECT text, ts, edited_ts FROM messages WHERE msg_id=1').get();
    assert.equal(row.text, 'edited');
    assert.equal(row.edited_ts, 2000);
    assert.equal(row.ts, 1000, 'original ts preserved');
  });

  test('direction CHECK rejects bogus value', () => {
    assert.throws(
      () => db.insertMessage({ chat_id: '1', msg_id: 1, text: 'x', direction: 'sideways' }),
      /CHECK constraint/,
    );
  });

  test('status CHECK rejects bogus value', () => {
    assert.throws(
      () => db.insertMessage({ chat_id: '1', msg_id: 1, text: 'x', direction: 'in', status: 'maybe' }),
      /CHECK constraint/,
    );
  });
});

describe('outbound pending lifecycle', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('insertOutboundPending → markOutboundSent updates msg_id + status', () => {
    const res = db.insertOutboundPending({
      chat_id: '1', text: 'hi', bot_name: 'shumabit',
      turn_id: 't-1', session_id: 's-1', pending_id: -1,
    });
    const id = res.lastInsertRowid;
    const pendingRow = db.raw.prepare('SELECT status, msg_id FROM messages WHERE id=?').get(id);
    assert.equal(pendingRow.status, 'pending');
    assert.equal(pendingRow.msg_id, -1);

    db.markOutboundSent(id, { msg_id: 100, ts: 5000 });
    const sentRow = db.raw.prepare('SELECT status, msg_id, ts FROM messages WHERE id=?').get(id);
    assert.equal(sentRow.status, 'sent');
    assert.equal(sentRow.msg_id, 100);
    assert.equal(sentRow.ts, 5000);
  });

  // A streamed reply's row is written by the INITIAL send — the first ~30
  // characters — and Telegram edits never revisit it, so the transcript (and
  // the agent's preloaded history) would keep a torso of every streamed answer.
  test('updateOutboundText brings a streamed bubble\'s row up to the final body', () => {
    const res = db.insertOutboundPending({
      chat_id: '1', text: 'The answer beg', bot_name: 'shumabit', pending_id: -7,
    });
    db.markOutboundSent(res.lastInsertRowid, { msg_id: 555, ts: 1000 });

    db.updateOutboundText({ chat_id: '1', msg_id: 555, text: 'The answer begins and ends here.', ts: 2000 });

    const row = db.raw.prepare('SELECT text, edited_ts, ts FROM messages WHERE msg_id=? AND chat_id=?').get(555, '1');
    assert.equal(row.text, 'The answer begins and ends here.');
    assert.equal(row.edited_ts, 2000);
    assert.equal(row.ts, 1000, 'the send time is not rewritten');
  });

  test('updateOutboundText touches neither inbound rows nor another chat', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 555, text: 'a user message', direction: 'in', bot_name: 'shumabit',
    });
    const other = db.insertOutboundPending({ chat_id: '2', text: 'other chat', bot_name: 'shumabit', pending_id: -8 });
    db.markOutboundSent(other.lastInsertRowid, { msg_id: 555 });

    const changed = db.updateOutboundText({ chat_id: '1', msg_id: 555, text: 'REWRITTEN' });

    assert.equal(changed.changes, 0, 'an inbound row with the same id must not be rewritten');
    assert.equal(
      db.raw.prepare('SELECT text FROM messages WHERE chat_id=? AND msg_id=?').get('1', 555).text,
      'a user message',
    );
    assert.equal(
      db.raw.prepare('SELECT text FROM messages WHERE chat_id=? AND msg_id=?').get('2', 555).text,
      'other chat',
    );
  });

  test('updateOutboundText ignores incomplete arguments instead of throwing', () => {
    assert.deepEqual(db.updateOutboundText({ chat_id: '1', msg_id: null, text: 'x' }), { changes: 0 });
    assert.deepEqual(db.updateOutboundText({ chat_id: '1', msg_id: 5, text: null }), { changes: 0 });
  });

  test('markOutboundFailed sets status + error (truncated)', () => {
    const res = db.insertOutboundPending({ chat_id: '1', text: 'hi', bot_name: 'shumabit', pending_id: -2 });
    const id = res.lastInsertRowid;
    const longErr = 'x'.repeat(1000);
    db.markOutboundFailed(id, longErr);
    const row = db.raw.prepare('SELECT status, error FROM messages WHERE id=?').get(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error.length, 500);
  });

  test('markStalePending: flips old pending → failed, leaves fresh pending alone', () => {
    // Insert stale pending (ts=old)
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, ts)
      VALUES ('1', -10, 'out', 'pending', ?)
    `).run(Date.now() - 120_000); // 2 min ago
    // Fresh pending
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, ts)
      VALUES ('1', -11, 'out', 'pending', ?)
    `).run(Date.now() - 5_000); // 5s ago

    const res = db.markStalePending(60_000); // 60s threshold
    assert.equal(res.changes, 1);

    const stale = db.raw.prepare('SELECT status, error FROM messages WHERE msg_id=-10').get();
    const fresh = db.raw.prepare('SELECT status FROM messages WHERE msg_id=-11').get();
    assert.equal(stale.status, 'failed');
    assert.equal(stale.error, 'crashed-mid-send');
    assert.equal(fresh.status, 'pending');
  });

  test('markStalePending(ms, botName) scopes to one bot', () => {
    // Stale pending for bot A
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, bot_name, ts)
      VALUES ('1', -20, 'out', 'pending', 'shumabit', ?)
    `).run(Date.now() - 120_000);
    // Stale pending for bot B
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, bot_name, ts)
      VALUES ('2', -21, 'out', 'pending', 'umi-assistant', ?)
    `).run(Date.now() - 120_000);

    const res = db.markStalePending(60_000, 'shumabit');
    assert.equal(res.changes, 1);

    const shumabitRow = db.raw.prepare('SELECT status FROM messages WHERE msg_id=-20').get();
    const umiRow = db.raw.prepare('SELECT status FROM messages WHERE msg_id=-21').get();
    assert.equal(shumabitRow.status, 'failed');
    assert.equal(umiRow.status, 'pending', 'umi-assistant row must not be touched by shumabit sweep');
  });

  test('markStalePending with no botName touches all bots (back-compat)', () => {
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, bot_name, ts)
      VALUES ('1', -30, 'out', 'pending', 'shumabit', ?)
    `).run(Date.now() - 120_000);
    db.raw.prepare(`
      INSERT INTO messages (chat_id, msg_id, direction, status, bot_name, ts)
      VALUES ('2', -31, 'out', 'pending', 'umi-assistant', ?)
    `).run(Date.now() - 120_000);

    const res = db.markStalePending(60_000);
    assert.equal(res.changes, 2);
  });
});

describe('sessions', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('upsertSession inserts new row', () => {
    db.upsertSession({
      session_key: '123', chat_id: '123', claude_session_id: 'abc',
      agent: 'shumabit', cwd: '/tmp', model: 'opus', effort: 'medium',
    });
    const row = db.getSession('123');
    assert.equal(row.claude_session_id, 'abc');
    assert.equal(row.model, 'opus');
    assert.ok(row.created_ts > 0);
    assert.equal(row.created_ts, row.last_active_ts);
  });

  test('upsertSession updates existing, preserves created_ts', async () => {
    db.upsertSession({ session_key: '1', chat_id: '1', claude_session_id: 'old', ts: 1000 });
    const created = db.getSession('1').created_ts;
    db.upsertSession({ session_key: '1', chat_id: '1', claude_session_id: 'new', ts: 2000 });
    const row = db.getSession('1');
    assert.equal(row.claude_session_id, 'new');
    assert.equal(row.created_ts, created);
    assert.equal(row.last_active_ts, 2000);
  });

  test('thread_id preserved in session_key with topic', () => {
    db.upsertSession({ session_key: '123:5379', chat_id: '123', thread_id: '5379', claude_session_id: 'abc' });
    const row = db.getSession('123:5379');
    assert.equal(row.thread_id, '5379');
  });

  test('touchSession bumps last_active_ts only', () => {
    db.upsertSession({ session_key: '1', chat_id: '1', claude_session_id: 'abc', ts: 1000 });
    db.touchSession('1', 9999);
    const row = db.getSession('1');
    assert.equal(row.last_active_ts, 9999);
    assert.equal(row.created_ts, 1000);
  });

  test('clearSessionId removes the row (schema has NOT NULL on claude_session_id)', () => {
    db.upsertSession({ session_key: '1', chat_id: '1', claude_session_id: 'stale' });
    db.clearSessionId('1');
    assert.equal(db.getSession('1'), undefined);
  });

  test('clearSessionId on missing key is a no-op', () => {
    assert.doesNotThrow(() => db.clearSessionId('nope'));
  });

  test('Claude writes are dual-written into the compatibility namespace', () => {
    db.upsertSession({
      session_key: 'inline',
      chat_id: 'inline',
      claude_session_id: 'claude-inline',
      pm_backend: 'sdk',
      ts: 1000,
    });
    db.upsertSession({
      session_key: 'channels',
      chat_id: 'channels',
      claude_session_id: 'claude-channels',
      pm_backend: 'cli',
      ts: 2000,
    });

    assert.equal(
      db.getProviderSession('inline', 'claude:inline').provider_session_id,
      'claude-inline',
    );
    assert.equal(
      db.getProviderSession('channels', 'claude:channels').provider_session_id,
      'claude-channels',
    );
    assert.equal(db.getProviderSession('inline', 'claude:channels'), undefined);
    assert.equal(db.getProviderSession('channels', 'claude:inline'), undefined);
  });

  test('equal legacy and namespace timestamps prefer a different legacy session ID', () => {
    db.upsertSession({
      session_key: 'rollback-tie',
      chat_id: 'rollback-tie',
      claude_session_id: 'before-rollback',
      pm_backend: 'sdk',
      ts: 1000,
    });
    db.raw.prepare(`
      UPDATE sessions
         SET claude_session_id = ?
       WHERE session_key = ?
    `).run('written-by-old-binary', 'rollback-tie');

    assert.equal(
      db.getProviderSession(
        'rollback-tie',
        'claude:inline',
      ).provider_session_id,
      'written-by-old-binary',
    );
  });
});

describe('Codex synchronous durability ledger', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-codex-ledger')); });
  afterEach(() => cleanupDb(dbPath, db));

  const identity = {
    stable_host_id: 'host-a',
    boot_session_id: 'boot-a',
  };

  function generation(overrides = {}) {
    return {
      generation_id: 'generation-a',
      session_key: 'chat:topic',
      thread_id: 'thread-a',
      app_server_session_id: 'app-server-diagnostic-a',
      ...identity,
      ts: 1000,
      ...overrides,
    };
  }

  function acquire(generationId = 'generation-a', ts = 1050) {
    return db.acquireCodexLease({
      generation_id: generationId,
      ...identity,
      ts,
    });
  }

  function seedStoppedTurn(terminalStatus = 'interrupted') {
    const base = {
      generationId: 'generation-a',
      threadId: 'thread-a',
      ...identity,
    };
    for (const checkpoint of [
      {
        kind: 'request-prepared',
        attemptId: 'attempt-a',
        method: 'turn/start',
        ts: 1100,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'attempt-a',
        method: 'turn/start',
        requestId: 'start-request',
        ts: 1110,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'attempt-a',
        method: 'turn/start',
        requestId: 'start-request',
        outcome: 'result',
        ts: 1120,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'attempt-a',
        turnId: 'turn-a',
        ts: 1130,
      },
      {
        kind: 'turn-terminal',
        attemptId: 'attempt-a',
        turnId: 'turn-a',
        terminalStatus,
        ts: 1140,
      },
      {
        kind: 'stop-terminal-reconciled',
        turnId: 'turn-a',
        ts: 1150,
      },
      {
        kind: 'stop-empty-registry-observed',
        turnId: 'turn-a',
        ts: 1160,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }
  }

  function seedActiveTurn() {
    const base = {
      generationId: 'generation-a',
      threadId: 'thread-a',
      source: 'telegram-message-a',
      ...identity,
    };
    for (const checkpoint of [
      {
        kind: 'request-prepared',
        attemptId: 'attempt-a',
        method: 'turn/start',
        ts: 1100,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'attempt-a',
        method: 'turn/start',
        requestId: 'start-request',
        ts: 1110,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'attempt-a',
        method: 'turn/start',
        requestId: 'start-request',
        outcome: 'result',
        ts: 1120,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'attempt-a',
        turnId: 'turn-a',
        ts: 1130,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }
  }

  function cleanRetirementPreparation(overrides = {}) {
    return {
      generation_id: 'generation-a',
      session_key: 'chat:topic',
      attempt_id: 'attempt-a',
      provider_session_id: 'thread-a',
      provider_turn_id: 'turn-a',
      source_message_id: 'telegram-message-a',
      ...identity,
      ts: 1140,
      ...overrides,
    };
  }

  test('clean retirement preparation marks only the exact active accepted turn', () => {
    db.createCodexGeneration(generation());
    acquire();
    seedActiveTurn();

    const partialPreparation = cleanRetirementPreparation();
    delete partialPreparation.source_message_id;
    assert.throws(
      () => db.prepareCodexCleanRetirement(partialPreparation),
      (error) => error.code === 'CODEX_PERSISTENCE_INPUT_INVALID',
    );
    assert.throws(
      () => db.prepareCodexCleanRetirement(cleanRetirementPreparation({
        source_message_id: 'other-message',
      })),
      (error) => error.code === 'CODEX_RETIREMENT_PREPARATION_REJECTED',
    );
    assert.deepEqual(
      db.prepareCodexCleanRetirement(cleanRetirementPreparation()),
      {
        changes: 1,
        disposition: 'retirement-requested',
        generationId: 'generation-a',
        attemptId: 'attempt-a',
      },
    );
    assert.deepEqual(
      db.prepareCodexCleanRetirement(cleanRetirementPreparation({ ts: 1150 })),
      {
        changes: 0,
        disposition: 'retirement-requested',
        generationId: 'generation-a',
        attemptId: 'attempt-a',
      },
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-a'
           AND attempt_id = 'attempt-a'
           AND kind = 'clean-retirement-requested'
      `).get().count,
      1,
    );

    db.recordCodexCheckpoint({
      kind: 'turn-terminal',
      generationId: 'generation-a',
      attemptId: 'attempt-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
      source: 'telegram-message-a',
      terminalStatus: 'interrupted',
      ...identity,
      ts: 1160,
    });
    assert.throws(
      () => db.prepareCodexCleanRetirement(cleanRetirementPreparation({
        ts: 1170,
      })),
      (error) => error.code === 'CODEX_RETIREMENT_PREPARATION_REJECTED',
    );
  });

  test('terminal interruption immediately before preparation creates no deploy marker', () => {
    db.createCodexGeneration(generation());
    acquire();
    seedActiveTurn();
    db.recordCodexCheckpoint({
      kind: 'turn-terminal',
      generationId: 'generation-a',
      attemptId: 'attempt-a',
      threadId: 'thread-a',
      turnId: 'turn-a',
      source: 'telegram-message-a',
      terminalStatus: 'interrupted',
      ...identity,
      ts: 1140,
    });

    assert.throws(
      () => db.prepareCodexCleanRetirement(cleanRetirementPreparation({
        ts: 1150,
      })),
      (error) => error.code === 'CODEX_RETIREMENT_PREPARATION_REJECTED',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-a'
           AND attempt_id = 'attempt-a'
           AND kind = 'clean-retirement-requested'
      `).get().count,
      0,
    );
  });

  test('conflicting clean retirement marker never authorizes the active turn', () => {
    db.createCodexGeneration(generation());
    acquire();
    seedActiveTurn();
    db.raw.prepare(`
      INSERT INTO codex_attempt_checkpoints (
        generation_id, attempt_id, kind, thread_id, turn_id,
        request_id, item_id, detail_json, ts
      ) VALUES (?, ?, 'clean-retirement-requested', ?, ?, NULL, NULL, NULL, ?)
    `).run('generation-a', 'attempt-a', 'thread-a', 'turn-other', 1140);

    assert.throws(
      () => db.prepareCodexCleanRetirement(cleanRetirementPreparation({
        ts: 1150,
      })),
      (error) => error.code === 'CODEX_RETIREMENT_PREPARATION_REJECTED',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE generation_id = 'generation-a'
           AND attempt_id = 'attempt-a'
           AND kind = 'clean-retirement-requested'
      `).get().count,
      1,
    );
  });

  test('stopped generation disposal and lease retirement commit together', () => {
    db.createCodexGeneration(generation());
    acquire();
    seedStoppedTurn();

    assert.deepEqual(db.settleCodexStoppedGeneration({
      generation_id: 'generation-a',
      ...identity,
      ts: 1200,
    }), {
      changes: 1,
      disposition: 'stop-cancelled',
      attemptId: 'attempt-a',
      retired: true,
    });
    assert.equal(db.getCodexAttempt('attempt-a').recovery_state, 'cancelled');
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_generations WHERE generation_id = 'generation-a'
      `).get().state,
      'retired',
    );
    assert.equal(db.getCodexLease().status, 'clear');
  });

  test('stopped generation disposal rolls back when lease retirement fails', () => {
    db.createCodexGeneration(generation());
    acquire();
    seedStoppedTurn();
    db.raw.exec(`
      CREATE TRIGGER reject_codex_lease_release
      BEFORE UPDATE OF status ON codex_daemon_lease
      WHEN NEW.status = 'clear'
      BEGIN
        SELECT RAISE(ABORT, 'injected lease release failure');
      END
    `);

    assert.throws(
      () => db.settleCodexStoppedGeneration({
        generation_id: 'generation-a',
        ...identity,
        ts: 1200,
      }),
      /injected lease release failure/,
    );
    assert.equal(
      db.getCodexAttempt('attempt-a').recovery_state,
      'clean-pending',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_generations WHERE generation_id = 'generation-a'
      `).get().state,
      'active',
    );
    assert.equal(db.getCodexLease().status, 'active');
  });

  test('final stopped delivery rolls back when atomic lease retirement fails', () => {
    db.createCodexGeneration(generation());
    acquire();
    seedStoppedTurn('completed');
    const base = {
      generationId: 'generation-a',
      threadId: 'thread-a',
      ...identity,
    };
    db.raw.exec(`
      CREATE TRIGGER reject_final_delivery_lease_release
      BEFORE UPDATE OF status ON codex_daemon_lease
      WHEN NEW.status = 'clear'
      BEGIN
        SELECT RAISE(ABORT, 'injected final delivery retirement failure');
      END
    `);

    assert.throws(
      () => db.recordCodexDeliveryCheckpoint({
        checkpoint: {
          ...base,
          kind: 'telegram-delivery-settled',
          attemptId: 'attempt-a',
          turnId: 'turn-a',
          ts: 1200,
        },
        retireGeneration: true,
      }),
      /injected final delivery retirement failure/,
    );
    assert.equal(
      db.getCodexAttempt('attempt-a').recovery_state,
      'clean-pending',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_generations WHERE generation_id = 'generation-a'
      `).get().state,
      'active',
    );
    assert.equal(db.getCodexLease().status, 'active');
    assert.equal(
      db.raw.prepare(`
        SELECT COUNT(*) AS count
          FROM codex_attempt_checkpoints
         WHERE attempt_id = 'attempt-a'
           AND kind = 'telegram-delivery-settled'
      `).get().count,
      0,
    );
  });

  test('unverified stopped delivery settles consumers but keeps the lease', () => {
    db.createCodexGeneration(generation());
    acquire();
    seedStoppedTurn('completed');

    const result = db.recordCodexDeliveryCheckpoint({
      checkpoint: {
        generationId: 'generation-a',
        threadId: 'thread-a',
        ...identity,
        kind: 'telegram-delivery-settled',
        attemptId: 'attempt-a',
        turnId: 'turn-a',
        ts: 1200,
      },
      retireGeneration: false,
    });
    assert.equal(result.retired, false);
    assert.equal(db.getCodexAttempt('attempt-a').recovery_state, 'settled');
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_generations WHERE generation_id = 'generation-a'
      `).get().state,
      'healthy-stopped',
    );
    assert.equal(db.getCodexLease().status, 'active');
  });

  test('prepared-only is replayable while write-attempted reconstructs quarantine', () => {
    db.createCodexGeneration(generation());
    const preparedResult = db.recordCodexCheckpoint({
      kind: 'request-prepared',
      generationId: 'generation-a',
      attemptId: 'attempt-a',
      method: 'turn/start',
      threadId: 'thread-a',
      source: 'telegram-message-a',
      clientUserMessageId: 'client-message-a',
      ...identity,
      ts: 1100,
    });
    assert.equal(preparedResult instanceof Promise, false);

    assert.deepEqual(
      db.reconstructCodexRecovery({ ...identity, now: 1200 }),
      {
        status: 'clear',
        reason: null,
        containmentReleased: false,
        replayableAttemptIds: ['attempt-a'],
        unresolvedAttemptIds: [],
      },
    );

    acquire();
    db.recordCodexCheckpoint({
      kind: 'request-write-attempted',
      generationId: 'generation-a',
      attemptId: 'attempt-a',
      method: 'turn/start',
      requestId: '1',
      threadId: 'thread-a',
      ...identity,
      ts: 1300,
    });

    const restored = db.reconstructCodexRecovery({ ...identity, now: 1400 });
    assert.equal(restored.status, 'recovery-blocked');
    assert.equal(restored.reason, 'exclusive-startup-recovery-unproven');
    assert.deepEqual(restored.unresolvedAttemptIds, ['attempt-a']);
    assert.deepEqual(restored.replayableAttemptIds, []);
  });

  test('checkpoint transitions are ordered, content-free, and transactional', () => {
    db.createCodexGeneration(generation());
    acquire();
    db.recordCodexCheckpoint({
      kind: 'request-prepared',
      generationId: 'generation-a',
      attemptId: 'attempt-a',
      method: 'turn/start',
      threadId: 'thread-a',
      ...identity,
      ts: 1100,
    });

    assert.throws(
      () => db.recordCodexCheckpoint({
        kind: 'request-response-observed',
        generationId: 'generation-a',
        attemptId: 'attempt-a',
        method: 'turn/start',
        requestId: '1',
        outcome: 'result',
        threadId: 'thread-a',
        ...identity,
        ts: 1200,
      }),
      (error) => error.code === 'CODEX_CHECKPOINT_SEQUENCE_INVALID',
    );
    assert.equal(db.getCodexAttempt('attempt-a').delivery_state, 'prepared');
    assert.equal(db.listCodexAttemptCheckpoints('attempt-a').length, 1);

    db.recordCodexCheckpoint({
      kind: 'request-write-attempted',
      generationId: 'generation-a',
      attemptId: 'attempt-a',
      method: 'turn/start',
      requestId: '1',
      threadId: 'thread-a',
      prompt: 'must never be persisted',
      ...identity,
      ts: 1300,
    });
    db.recordCodexCheckpoint({
      kind: 'request-response-observed',
      generationId: 'generation-a',
      attemptId: 'attempt-a',
      method: 'turn/start',
      requestId: '1',
      outcome: 'result',
      threadId: 'thread-a',
      ...identity,
      ts: 1400,
    });

    const rows = db.listCodexAttemptCheckpoints('attempt-a');
    assert.deepEqual(rows.map((row) => row.kind), [
      'request-prepared',
      'request-write-attempted',
      'request-response-observed',
    ]);
    assert.equal(JSON.stringify(rows).includes('must never be persisted'), false);
    assert.equal(db.getCodexAttempt('attempt-a').delivery_state, 'response-observed');
  });

  test('persists the exact Orchestra thread-status callback without payload content', () => {
    db.createCodexGeneration(generation());
    acquire();

    db.recordCodexCheckpoint({
      kind: 'thread-status-changed',
      generationId: 'generation-a',
      threadId: 'thread-a',
      turnId: null,
      source: null,
      clientUserMessageId: null,
      hostIdentity: 'host-a',
      bootSessionIdentity: 'boot-a',
      statusType: 'active',
    });

    const row = db.raw.prepare(`
      SELECT kind, thread_id, detail_json
        FROM codex_attempt_checkpoints
       WHERE generation_id = ?
    `).get('generation-a');
    assert.deepEqual(row, {
      kind: 'thread-status-changed',
      thread_id: 'thread-a',
      detail_json: JSON.stringify({ statusType: 'active' }),
    });
  });

  test('settles linked steering only when the target turn delivery settles', () => {
    db.createCodexGeneration(generation());
    acquire();
    const base = {
      generationId: 'generation-a',
      threadId: 'thread-a',
      ...identity,
    };
    for (const checkpoint of [
      {
        kind: 'request-prepared',
        attemptId: 'turn-attempt',
        method: 'turn/start',
        ts: 1100,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'turn-attempt',
        requestId: 'request-turn',
        ts: 1200,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'turn-attempt',
        requestId: 'request-turn',
        outcome: 'result',
        ts: 1300,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'turn-attempt',
        turnId: 'turn-a',
        ts: 1400,
      },
      {
        kind: 'request-prepared',
        attemptId: 'steer-attempt',
        method: 'turn/steer',
        turnId: 'turn-a',
        ts: 1500,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }
    db.linkCodexSteeringInput({
      linked_input_id: 'linked-a',
      generation_id: 'generation-a',
      attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      telegram_chat_id: 'chat',
      telegram_message_id: '2',
      ts: 1600,
    });
    db.recordCodexCheckpoint({
      ...base,
      kind: 'turn-terminal',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      terminalStatus: 'completed',
      ts: 1700,
    });
    for (const checkpoint of [
      { kind: 'stop-terminal-reconciled', ts: 1710 },
      { kind: 'stop-clean-accepted', ts: 1720 },
      { kind: 'stop-empty-registry-observed', ts: 1730 },
    ]) {
      db.recordCodexCheckpoint({
        ...base,
        turnId: 'turn-a',
        ...checkpoint,
      });
    }

    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_linked_inputs WHERE linked_input_id = ?
      `).get('linked-a').state,
      'linked',
    );
    assert.equal(
      db.getCodexAttempt('turn-attempt').recovery_state,
      'clean-pending',
    );

    db.recordCodexCheckpoint({
      ...base,
      kind: 'telegram-delivery-settled',
      attemptId: 'turn-attempt',
      turnId: 'turn-a',
      ts: 1800,
    });

    assert.equal(db.getCodexAttempt('turn-attempt').recovery_state, 'settled');
    assert.equal(db.getCodexAttempt('steer-attempt').recovery_state, 'settled');
    assert.deepEqual(
      db.raw.prepare(`
        SELECT state, settled_ts
          FROM codex_linked_inputs
         WHERE linked_input_id = ?
      `).get('linked-a'),
      { state: 'settled', settled_ts: 1800 },
    );
  });

  test('delivery and cleanup settle safely in either stop/background order', () => {
    const seedLifecycle = ({
      generationId,
      threadId,
      prefix,
      startTs,
    }) => {
      const host = {
        generationId,
        threadId,
        ...identity,
      };
      const record = (checkpoint) => db.recordCodexCheckpoint({
        ...host,
        ...checkpoint,
      });
      const startAttempt = `${prefix}-turn`;
      const interruptAttempt = `${prefix}-interrupt`;
      const cleanAttempt = `${prefix}-clean`;
      for (const checkpoint of [
        {
          kind: 'request-prepared',
          attemptId: startAttempt,
          method: 'turn/start',
          ts: startTs,
        },
        {
          kind: 'request-write-attempted',
          attemptId: startAttempt,
          method: 'turn/start',
          requestId: `${prefix}-start-request`,
          ts: startTs + 10,
        },
        {
          kind: 'request-response-observed',
          attemptId: startAttempt,
          method: 'turn/start',
          requestId: `${prefix}-start-request`,
          outcome: 'result',
          ts: startTs + 20,
        },
        {
          kind: 'turn-accepted',
          attemptId: startAttempt,
          turnId: `${prefix}-turn-id`,
          ts: startTs + 30,
        },
        {
          kind: 'turn-terminal',
          attemptId: startAttempt,
          turnId: `${prefix}-turn-id`,
          terminalStatus: 'completed',
          ts: startTs + 40,
        },
      ]) record(checkpoint);
      for (const [attemptId, method, offset] of [
        [interruptAttempt, 'turn/interrupt', 50],
        [cleanAttempt, 'thread/backgroundTerminals/clean', 80],
      ]) {
        for (const checkpoint of [
          {
            kind: 'request-prepared',
            attemptId,
            method,
            turnId: method === 'turn/interrupt' ? `${prefix}-turn-id` : null,
            ts: startTs + offset,
          },
          {
            kind: 'request-write-attempted',
            attemptId,
            method,
            requestId: `${attemptId}-request`,
            turnId: method === 'turn/interrupt' ? `${prefix}-turn-id` : null,
            ts: startTs + offset + 10,
          },
          {
            kind: 'request-response-observed',
            attemptId,
            method,
            requestId: `${attemptId}-request`,
            outcome: 'result',
            turnId: method === 'turn/interrupt' ? `${prefix}-turn-id` : null,
            ts: startTs + offset + 20,
          },
        ]) record(checkpoint);
      }
      return {
        record,
        startAttempt,
        interruptAttempt,
        cleanAttempt,
        turnId: `${prefix}-turn-id`,
      };
    };

    db.createCodexGeneration(generation());
    acquire();
    const stop = seedLifecycle({
      generationId: 'generation-a',
      threadId: 'thread-a',
      prefix: 'stop',
      startTs: 1100,
    });
    stop.record({
      kind: 'telegram-delivery-settled',
      attemptId: stop.startAttempt,
      turnId: stop.turnId,
      ts: 1300,
    });
    for (const checkpoint of [
      { kind: 'stop-terminal-reconciled', turnId: stop.turnId, ts: 1310 },
      { kind: 'stop-clean-accepted', ts: 1320 },
      { kind: 'stop-empty-registry-observed', ts: 1330 },
    ]) stop.record(checkpoint);
    assert.deepEqual(
      [stop.startAttempt, stop.interruptAttempt, stop.cleanAttempt]
        .map((attemptId) => db.getCodexAttempt(attemptId).recovery_state),
      ['settled', 'settled', 'settled'],
    );
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_generations WHERE generation_id = 'generation-a'
      `).get().state,
      'healthy-stopped',
    );
    db.markCodexGenerationRetired({
      generation_id: 'generation-a',
      ts: 1340,
    });

    db.createCodexGeneration(generation({
      generation_id: 'generation-b',
      session_key: 'chat:background',
      thread_id: 'thread-b',
      ts: 2000,
    }));
    acquire('generation-b', 2010);
    const background = seedLifecycle({
      generationId: 'generation-b',
      threadId: 'thread-b',
      prefix: 'background',
      startTs: 2100,
    });
    for (const checkpoint of [
      {
        kind: 'background-terminal-reconciled',
        turnId: background.turnId,
        ts: 2300,
      },
      { kind: 'background-clean-accepted', ts: 2310 },
      { kind: 'background-empty-registry-observed', ts: 2320 },
    ]) background.record(checkpoint);
    assert.equal(
      db.getCodexAttempt(background.startAttempt).recovery_state,
      'clean-pending',
    );
    background.record({
      kind: 'telegram-delivery-settled',
      attemptId: background.startAttempt,
      turnId: background.turnId,
      ts: 2330,
    });
    assert.deepEqual(
      [
        background.startAttempt,
        background.interruptAttempt,
        background.cleanAttempt,
      ].map((attemptId) => db.getCodexAttempt(attemptId).recovery_state),
      ['settled', 'settled', 'settled'],
    );
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_generations WHERE generation_id = 'generation-b'
      `).get().state,
      'active',
    );
  });

  test('natural completion keeps the generation active for the next turn', () => {
    db.createCodexGeneration(generation());
    acquire();
    const base = {
      generationId: 'generation-a',
      threadId: 'thread-a',
      ...identity,
    };
    for (const checkpoint of [
      {
        kind: 'request-prepared',
        attemptId: 'first-turn',
        method: 'turn/start',
        ts: 1100,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'first-turn',
        method: 'turn/start',
        requestId: 1,
        ts: 1200,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'first-turn',
        method: 'turn/start',
        requestId: 1,
        outcome: 'result',
        ts: 1300,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'first-turn',
        turnId: 'turn-1',
        ts: 1400,
      },
      {
        kind: 'turn-terminal',
        attemptId: 'first-turn',
        turnId: 'turn-1',
        terminalStatus: 'completed',
        ts: 1500,
      },
      {
        kind: 'telegram-delivery-settled',
        attemptId: 'first-turn',
        turnId: 'turn-1',
        ts: 1600,
      },
      {
        kind: 'request-prepared',
        attemptId: 'second-turn',
        method: 'turn/start',
        ts: 1700,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'second-turn',
        method: 'turn/start',
        requestId: 2,
        ts: 1800,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_generations WHERE generation_id = 'generation-a'
      `).get().state,
      'active',
    );
    assert.equal(
      db.getCodexAttempt('second-turn').delivery_state,
      'write-attempted',
    );
  });

  test('only one Codex generation can own the daemon lease', () => {
    db.createCodexGeneration(generation());
    db.createCodexGeneration(generation({
      generation_id: 'generation-b',
      session_key: 'chat:other',
      thread_id: 'thread-b',
      ts: 1100,
    }));
    db.acquireCodexLease({
      generation_id: 'generation-a',
      ...identity,
      ts: 1200,
    });

    assert.throws(
      () => db.acquireCodexLease({
        generation_id: 'generation-b',
        ...identity,
        ts: 1300,
      }),
      (error) => error.code === 'CODEX_DAEMON_GENERATION_BUSY',
    );
  });

  test('checkpoint ownership, identifiers, predecessors, and duplicates are monotonic', () => {
    db.createCodexGeneration(generation());
    acquire();
    const base = {
      generationId: 'generation-a',
      attemptId: 'attempt-a',
      threadId: 'thread-a',
      ...identity,
    };
    for (const checkpoint of [
      { kind: 'request-prepared', method: 'turn/start', source: 'message-a', ts: 1100 },
      { kind: 'request-write-attempted', method: 'turn/start', requestId: 'request-a', ts: 1200 },
      {
        kind: 'request-response-observed',
        method: 'turn/start',
        requestId: 'request-a',
        outcome: 'result',
        ts: 1300,
      },
      { kind: 'turn-accepted', turnId: 'turn-a', ts: 1400 },
      {
        kind: 'item-started',
        turnId: 'turn-a',
        itemId: 'item-a',
        itemType: 'commandExecution',
        ts: 1500,
      },
      {
        kind: 'turn-terminal',
        turnId: 'turn-a',
        terminalStatus: 'completed',
        ts: 1600,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }

    assert.equal(db.recordCodexCheckpoint({
      ...base,
      kind: 'item-started',
      turnId: 'turn-a',
      itemId: 'item-a',
      itemType: 'commandExecution',
      ts: 1700,
    }).changes, 0);
    assert.equal(db.recordCodexCheckpoint({
      ...base,
      kind: 'turn-terminal',
      turnId: 'turn-a',
      terminalStatus: 'completed',
      ts: 1800,
    }).changes, 0);
    assert.throws(
      () => db.recordCodexCheckpoint({
        ...base,
        kind: 'request-response-observed',
        method: 'turn/start',
        requestId: 'different-request',
        outcome: 'result',
        ts: 1900,
      }),
      (error) => error.code === 'CODEX_ATTEMPT_IDENTITY_MISMATCH',
    );

    db.recordCodexCheckpoint({
      ...base,
      kind: 'telegram-delivery-settled',
      turnId: 'turn-a',
      ts: 2000,
    });
    db.markCodexGenerationRetired({
      generation_id: 'generation-a',
      ts: 2100,
    });
    db.createCodexGeneration(generation({
      generation_id: 'generation-b',
      session_key: 'chat:other',
      thread_id: 'thread-b',
      ts: 2200,
    }));
    acquire('generation-b', 2300);

    assert.throws(
      () => db.recordCodexCheckpoint({
        kind: 'thread-status-changed',
        generationId: 'generation-a',
        threadId: 'thread-a',
        hostIdentity: 'host-a',
        bootSessionIdentity: 'boot-a',
        statusType: 'active',
        ts: 2400,
      }),
      (error) => error.code === 'CODEX_CHECKPOINT_STALE_GENERATION',
    );
    assert.throws(
      () => db.recordCodexItemEffect({
        generation_id: 'generation-a',
        attempt_id: 'attempt-a',
        item_id: 'item-a',
        item_type: 'commandExecution',
        state: 'started',
        ts: 2450,
      }),
      (error) => error.code === 'CODEX_CHECKPOINT_STALE_GENERATION',
    );
    assert.equal(
      db.raw.prepare(`
        SELECT state FROM codex_generations WHERE generation_id = ?
      `).get('generation-a').state,
      'retired',
    );
  });

  test('numeric and string JSON-RPC request IDs remain durably distinct', () => {
    db.createCodexGeneration(generation());
    acquire();
    for (const [attemptId, requestId] of [
      ['numeric-attempt', 1],
      ['string-attempt', '1'],
    ]) {
      db.recordCodexCheckpoint({
        kind: 'request-prepared',
        generationId: 'generation-a',
        attemptId,
        method: 'turn/start',
        threadId: 'thread-a',
        ...identity,
        ts: 1100,
      });
      db.recordCodexCheckpoint({
        kind: 'request-write-attempted',
        generationId: 'generation-a',
        attemptId,
        method: 'turn/start',
        requestId,
        threadId: 'thread-a',
        ...identity,
        ts: 1200,
      });
    }

    assert.deepEqual(
      db.raw.prepare(`
        SELECT attempt_id, request_id
          FROM codex_turn_attempts
         ORDER BY attempt_id
      `).all(),
      [
        { attempt_id: 'numeric-attempt', request_id: 'number:1' },
        { attempt_id: 'string-attempt', request_id: 'string:1' },
      ],
    );
    assert.throws(
      () => db.recordCodexCheckpoint({
        kind: 'request-response-observed',
        generationId: 'generation-a',
        attemptId: 'numeric-attempt',
        method: 'turn/start',
        requestId: '1',
        outcome: 'result',
        threadId: 'thread-a',
        ...identity,
        ts: 1300,
      }),
      (error) => error.code === 'CODEX_ATTEMPT_IDENTITY_MISMATCH',
    );
  });

  test('notification-first and response-first turn batches preserve transport ambiguity', () => {
    db.createCodexGeneration(generation());
    acquire();
    const base = {
      generationId: 'generation-a',
      threadId: 'thread-a',
      ...identity,
    };
    for (const checkpoint of [
      {
        kind: 'request-prepared',
        attemptId: 'early-attempt',
        method: 'turn/start',
        ts: 1100,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'early-attempt',
        method: 'turn/start',
        requestId: 1,
        ts: 1200,
      },
      {
        kind: 'turn-started',
        attemptId: 'early-attempt',
        turnId: 'turn-early',
        ts: 1300,
      },
      {
        kind: 'item-started',
        attemptId: 'early-attempt',
        turnId: 'turn-early',
        itemId: 'item-early',
        itemType: 'commandExecution',
        ts: 1400,
      },
      {
        kind: 'item-delta-observed',
        attemptId: 'early-attempt',
        turnId: 'turn-early',
        itemId: 'item-early',
        deltaBytes: 12,
        ts: 1500,
      },
      {
        kind: 'item-completed',
        attemptId: 'early-attempt',
        turnId: 'turn-early',
        itemId: 'item-early',
        itemType: 'commandExecution',
        ts: 1600,
      },
      {
        kind: 'turn-terminal',
        attemptId: 'early-attempt',
        turnId: 'turn-early',
        terminalStatus: 'completed',
        ts: 1700,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }
    assert.deepEqual(
      {
        delivery_state: db.getCodexAttempt('early-attempt').delivery_state,
        recovery_state: db.getCodexAttempt('early-attempt').recovery_state,
        terminal_status: db.getCodexAttempt('early-attempt').terminal_status,
      },
      {
        delivery_state: 'write-attempted',
        recovery_state: 'ambiguous',
        terminal_status: 'completed',
      },
    );
    assert.throws(
      () => db.recordCodexCheckpoint({
        ...base,
        kind: 'item-started',
        attemptId: 'early-attempt',
        turnId: 'turn-early',
        itemId: 'late-item',
        itemType: 'commandExecution',
        ts: 1750,
      }),
      (error) => error.code === 'CODEX_CHECKPOINT_SEQUENCE_INVALID',
    );
    for (const checkpoint of [
      {
        kind: 'request-response-observed',
        attemptId: 'early-attempt',
        method: 'turn/start',
        requestId: 1,
        outcome: 'result',
        ts: 1800,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'early-attempt',
        turnId: 'turn-early',
        ts: 1900,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }
    assert.equal(
      db.getCodexAttempt('early-attempt').recovery_state,
      'terminal-pending',
    );

    for (const checkpoint of [
      {
        kind: 'request-prepared',
        attemptId: 'response-first-attempt',
        method: 'turn/start',
        ts: 2000,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'response-first-attempt',
        method: 'turn/start',
        requestId: 2,
        ts: 2100,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'response-first-attempt',
        method: 'turn/start',
        requestId: 2,
        outcome: 'result',
        ts: 2200,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'response-first-attempt',
        turnId: 'turn-response-first',
        ts: 2300,
      },
      {
        kind: 'turn-started',
        attemptId: 'response-first-attempt',
        turnId: 'turn-response-first',
        ts: 2400,
      },
      {
        kind: 'turn-terminal',
        attemptId: 'response-first-attempt',
        turnId: 'turn-response-first',
        terminalStatus: 'completed',
        ts: 2500,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }
    assert.equal(
      db.getCodexAttempt('response-first-attempt').recovery_state,
      'terminal-pending',
    );
  });

  test('containment makes every unsafe generation attempt reconcilable', () => {
    db.createCodexGeneration(generation());
    acquire();
    const base = {
      generationId: 'generation-a',
      threadId: 'thread-a',
      ...identity,
    };
    for (const checkpoint of [
      {
        kind: 'request-prepared',
        attemptId: 'active-turn',
        method: 'turn/start',
        ts: 1100,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'active-turn',
        method: 'turn/start',
        requestId: 1,
        ts: 1200,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'active-turn',
        method: 'turn/start',
        requestId: 1,
        outcome: 'result',
        ts: 1300,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'active-turn',
        turnId: 'turn-a',
        ts: 1400,
      },
      {
        kind: 'request-prepared',
        attemptId: 'cleanup-attempt',
        method: 'thread/backgroundTerminals/clean',
        ts: 1500,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'cleanup-attempt',
        method: 'thread/backgroundTerminals/clean',
        requestId: 2,
        ts: 1600,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'cleanup-attempt',
        method: 'thread/backgroundTerminals/clean',
        requestId: 2,
        outcome: 'result',
        ts: 1700,
      },
      {
        kind: 'background-clean-accepted',
        ts: 1800,
      },
      {
        kind: 'request-prepared',
        attemptId: 'safe-prepared',
        method: 'turn/steer',
        turnId: 'turn-a',
        ts: 1900,
      },
      {
        kind: 'containment-entered',
        reason: 'notification-sink-failed',
        ts: 2000,
      },
    ]) {
      db.recordCodexCheckpoint({ ...base, ...checkpoint });
    }

    assert.deepEqual(
      [
        db.getCodexAttempt('active-turn').recovery_state,
        db.getCodexAttempt('cleanup-attempt').recovery_state,
        db.getCodexAttempt('safe-prepared').recovery_state,
      ],
      ['ambiguous', 'ambiguous', 'prepared'],
    );
    assert.equal(db.getCodexAttempt('active-turn').turn_id, 'turn-a');
    assert.equal(db.getCodexAttempt('cleanup-attempt').request_id, 'number:2');
    for (const attemptId of ['active-turn', 'cleanup-attempt']) {
      assert.doesNotThrow(() => db.reconcileCodexAttempt({
        attempt_id: attemptId,
        disposition: 'dismissed',
        actor: 'telegram:42',
        reason: 'operator reviewed containment',
        ts: 2100,
      }));
    }
  });

  test('linked steering and item effects persist identifiers but no raw payloads', () => {
    db.createCodexGeneration(generation());
    acquire();
    for (const row of [
      {
        kind: 'request-prepared',
        attemptId: 'turn-attempt',
        method: 'turn/start',
        ts: 1100,
      },
      {
        kind: 'request-write-attempted',
        attemptId: 'turn-attempt',
        method: 'turn/start',
        requestId: 1,
        ts: 1120,
      },
      {
        kind: 'request-response-observed',
        attemptId: 'turn-attempt',
        method: 'turn/start',
        requestId: 1,
        outcome: 'result',
        ts: 1140,
      },
      {
        kind: 'turn-accepted',
        attemptId: 'turn-attempt',
        turnId: 'turn-a',
        ts: 1160,
      },
      {
        kind: 'request-prepared',
        attemptId: 'steer-attempt',
        method: 'turn/steer',
        turnId: 'turn-a',
        source: 'message-2',
        ts: 1200,
      },
    ]) {
      db.recordCodexCheckpoint({
        generationId: 'generation-a',
        threadId: 'thread-a',
        ...identity,
        ...row,
      });
    }
    db.linkCodexSteeringInput({
      linked_input_id: 'linked-a',
      generation_id: 'generation-a',
      attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      telegram_chat_id: 'chat',
      telegram_message_id: '2',
      ts: 1300,
    });
    assert.equal(db.linkCodexSteeringInput({
      linked_input_id: 'linked-a',
      generation_id: 'generation-a',
      attempt_id: 'steer-attempt',
      target_attempt_id: 'turn-attempt',
      telegram_chat_id: 'chat',
      telegram_message_id: '2',
      ts: 1350,
    }).changes, 0);
    assert.throws(
      () => db.linkCodexSteeringInput({
        linked_input_id: 'linked-a',
        generation_id: 'generation-a',
        attempt_id: 'steer-attempt',
        target_attempt_id: 'turn-attempt',
        telegram_chat_id: 'chat',
        telegram_message_id: 'different-message',
        ts: 1360,
      }),
      (error) => error.code === 'CODEX_LINKED_INPUT_ID_REUSED',
    );
    assert.equal(db.recordCodexItemEffect({
      generation_id: 'generation-a',
      attempt_id: 'turn-attempt',
      item_id: 'item-a',
      item_type: 'commandExecution',
      state: 'started',
      ts: 1400,
    }).changes, 1);
    assert.equal(db.recordCodexItemEffect({
      generation_id: 'generation-a',
      attempt_id: 'turn-attempt',
      item_id: 'item-a',
      item_type: 'commandExecution',
      state: 'completed',
      ts: 1410,
    }).changes, 1);
    assert.equal(db.recordCodexItemEffect({
      generation_id: 'generation-a',
      attempt_id: 'turn-attempt',
      item_id: 'item-a',
      item_type: 'commandExecution',
      state: 'completed',
      ts: 1420,
    }).changes, 0);
    assert.throws(
      () => db.recordCodexItemEffect({
        generation_id: 'generation-a',
        attempt_id: 'turn-attempt',
        item_id: 'item-a',
        item_type: 'commandExecution',
        state: 'started',
        ts: 1430,
      }),
      (error) => error.code === 'CODEX_EFFECT_STATE_CONFLICT',
    );
    assert.throws(
      () => db.recordCodexItemEffect({
        generation_id: 'generation-a',
        attempt_id: 'turn-attempt',
        item_id: 'item-a',
        item_type: 'fileChange',
        state: 'completed',
        ts: 1440,
      }),
      (error) => error.code === 'CODEX_EFFECT_IDENTITY_MISMATCH',
    );

    assert.equal(
      db.raw.prepare('SELECT target_attempt_id FROM codex_linked_inputs').get()
        .target_attempt_id,
      'turn-attempt',
    );
    assert.deepEqual(
      db.raw.prepare(`
        SELECT item_id, item_type, state
          FROM codex_item_effects
      `).get(),
      {
        item_id: 'item-a',
        item_type: 'commandExecution',
        state: 'completed',
      },
    );
    assert.throws(
      () => db.recordCodexItemEffect({
        generation_id: 'generation-a',
        attempt_id: 'turn-attempt',
        item_id: 'item-b',
        item_type: 'commandExecution',
        state: 'started',
        raw: { command: 'cat ~/.config/secrets' },
      }),
      (error) => error.code === 'CODEX_EFFECT_PAYLOAD_REJECTED',
    );
  });
});

describe('events + config_changes', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('logEvent stores kind + JSON detail', () => {
    db.logEvent('spawn-fail', { chat_id: '123', code: 1, reason: 'resume-failed' });
    const row = db.raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.kind, 'spawn-fail');
    assert.equal(row.chat_id, '123');
    assert.deepEqual(JSON.parse(row.detail_json), { code: 1, reason: 'resume-failed' });
  });

  test('logEvent with no detail writes null detail_json', () => {
    db.logEvent('polygram-start');
    const row = db.raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.detail_json, null);
  });

  test('logConfigChange records field + values + user', () => {
    db.logConfigChange({
      chat_id: '123', thread_id: '5379', field: 'model',
      old_value: 'sonnet', new_value: 'opus',
      user: 'Ivan', user_id: 111111111, source: 'command',
    });
    const row = db.raw.prepare('SELECT * FROM config_changes ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.field, 'model');
    assert.equal(row.old_value, 'sonnet');
    assert.equal(row.new_value, 'opus');
    assert.equal(row.user, 'Ivan');
    assert.equal(row.user_id, 111111111);
  });

  test('logConfigChanges rolls back the complete model and effort audit pair', () => {
    assert.throws(
      () => db.logConfigChanges([
        {
          chat_id: '1',
          field: 'model',
          old_value: 'gpt-a',
          new_value: 'gpt-b',
        },
        {
          chat_id: '1',
          field: 'bogus',
          old_value: 'high',
          new_value: 'xhigh',
        },
      ]),
    );
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM config_changes').get().count,
      0,
    );
  });

  test('config_changes CHECK rejects bad field', () => {
    assert.throws(
      () => db.logConfigChange({ chat_id: '1', field: 'bogus', new_value: 'x' }),
      /CHECK constraint/,
    );
  });

  test('logConfigChange rejects malformed and cyclic values before SQLite binding', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    for (const newValue of [undefined, {}, cyclic, Symbol('bad'), Number.NaN]) {
      assert.throws(
        () => db.logConfigChange({
          chat_id: '1',
          field: 'runtime',
          old_value: 'claude',
          new_value: newValue,
        }),
        (error) => error.code === 'CONFIG_CHANGE_VALUE_INVALID',
      );
    }
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM config_changes').get().count,
      0,
    );
  });
});

describe('FTS5 search', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('inserted message is indexed and findable', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, user: 'Ivan', text: 'meeting tomorrow at noon', direction: 'in' });
    db.insertMessage({ chat_id: '1', msg_id: 2, user: 'Maria', text: 'the quick brown fox', direction: 'in' });
    const hits = db.raw.prepare(`
      SELECT m.msg_id, m.text FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      WHERE messages_fts MATCH 'meeting'
    `).all();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].msg_id, 1);
  });

  test('edited message updates FTS index', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'original about cats', direction: 'in' });
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'edited about dogs', direction: 'in' });
    const catHits = db.raw.prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'cats'`).get();
    const dogHits = db.raw.prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'dogs'`).get();
    assert.equal(catHits.c, 0);
    assert.equal(dogHits.c, 1);
  });

  test('deleted message removes from FTS index', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'something unique', direction: 'in' });
    db.raw.prepare('DELETE FROM messages WHERE msg_id=1').run();
    const hits = db.raw.prepare(`SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'unique'`).get();
    assert.equal(hits.c, 0);
  });

  test('unicode61 tokenizer handles cyrillic + diacritics', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, user: 'Дина', text: 'Привет мир', direction: 'in' });
    const hits = db.raw.prepare(`
      SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'привет'
    `).get();
    assert.equal(hits.c, 1, 'search should be case-insensitive across scripts');
  });
});

describe('uniqueness + constraints', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('same msg_id in different chats is allowed', () => {
    db.insertMessage({ chat_id: '1', msg_id: 100, text: 'a', direction: 'in' });
    db.insertMessage({ chat_id: '2', msg_id: 100, text: 'b', direction: 'in' });
    const count = db.raw.prepare('SELECT COUNT(*) as c FROM messages WHERE msg_id=100').get();
    assert.equal(count.c, 2);
  });

  test('multiple pending rows (negative msg_ids) coexist', () => {
    db.insertOutboundPending({ chat_id: '1', text: 'a', bot_name: 'shumabit', pending_id: -1 });
    db.insertOutboundPending({ chat_id: '1', text: 'b', bot_name: 'shumabit', pending_id: -2 });
    const count = db.raw.prepare(`SELECT COUNT(*) as c FROM messages WHERE status='pending'`).get();
    assert.equal(count.c, 2);
  });
});

describe('busy_timeout + concurrent access', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('second connection can read while first writes (WAL)', () => {
    db.insertMessage({ chat_id: '1', msg_id: 1, text: 'hello', direction: 'in' });
    const db2 = open(dbPath);
    const row = db2.raw.prepare('SELECT text FROM messages WHERE msg_id=1').get();
    assert.equal(row.text, 'hello');
    db2.raw.close();
  });

  test('busy_timeout is set to 5000ms', () => {
    assert.equal(db.raw.pragma('busy_timeout', { simple: true }), 5000);
  });
});

describe('getMessage', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('returns null when message not found', () => {
    assert.equal(db.getMessage('999', 1), undefined);
  });

  test('returns the message when found', () => {
    db.insertMessage({ chat_id: '42', msg_id: 5, text: 'hi', direction: 'in', user: 'Ivan' });
    const row = db.getMessage('42', 5);
    assert.equal(row.text, 'hi');
    assert.equal(row.user, 'Ivan');
  });

  test('accepts numeric chatId', () => {
    db.insertMessage({ chat_id: '42', msg_id: 5, text: 'hi', direction: 'in' });
    const row = db.getMessage(42, 5);
    assert.equal(row.text, 'hi');
  });

  test('returns latest when msg_id collision across chats is absent', () => {
    db.insertMessage({ chat_id: '1', msg_id: 100, text: 'a', direction: 'in' });
    db.insertMessage({ chat_id: '2', msg_id: 100, text: 'b', direction: 'in' });
    assert.equal(db.getMessage('1', 100).text, 'a');
    assert.equal(db.getMessage('2', 100).text, 'b');
  });
});

describe('chat_migrations', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('logChatMigration + resolveChatId round-trip', () => {
    db.logChatMigration('-100', '-200');
    assert.equal(db.resolveChatId('-100'), '-200');
  });

  test('resolveChatId returns input when no mapping', () => {
    assert.equal(db.resolveChatId('-999'), '-999');
  });

  test('logChatMigration replaces existing mapping', () => {
    db.logChatMigration('-100', '-200', 1000);
    db.logChatMigration('-100', '-300', 2000);
    assert.equal(db.resolveChatId('-100'), '-300');
    const row = db.raw.prepare('SELECT * FROM chat_migrations WHERE old_chat_id=?').get('-100');
    assert.equal(row.migrated_ts, 2000);
  });

  test('accepts numeric chat IDs', () => {
    db.logChatMigration(-100, -200);
    assert.equal(db.resolveChatId(-100), '-200');
  });
});

// 0.5.4 — boot replay had a dedupe bug: insertOutboundPending didn't persist
// reply_to_id, so hasOutboundReplyTo always returned false, so every restart
// re-dispatched already-answered messages. These tests pin down the wiring
// so we can't silently regress.
describe('boot replay dedupe wiring', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('insertOutboundPending persists reply_to_id', () => {
    const res = db.insertOutboundPending({
      chat_id: '1', text: 'reply', bot_name: 'b', pending_id: -1, reply_to_id: 42,
    });
    db.markOutboundSent(res.lastInsertRowid, { msg_id: 100, ts: Date.now() });
    const row = db.raw.prepare('SELECT reply_to_id FROM messages WHERE id=?').get(res.lastInsertRowid);
    assert.equal(row.reply_to_id, 42);
  });

  test('hasOutboundReplyTo finds a sent reply by inbound msg_id', () => {
    const res = db.insertOutboundPending({
      chat_id: '1', text: 'r', bot_name: 'b', pending_id: -1, reply_to_id: 7,
    });
    db.markOutboundSent(res.lastInsertRowid, { msg_id: 200, ts: Date.now() });
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 7 }), true);
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 8 }), false);
  });

  test('hasOutboundReplyTo counts pending rows (avoid double-reply on boot replay)', () => {
    // 0.6.14: an outbound row written by the previous polygram process
    // that was still 'pending' at boot means the API call may have hit
    // Telegram. Treat as replied so boot replay doesn't re-dispatch
    // the same inbound. (markStalePending will sweep these to 'failed'
    // with the 'crashed-mid-send' sentinel anyway, but we widen here in
    // case replay reads before the sweep, and to make the contract
    // robust to ordering.)
    const r = db.insertOutboundPending({ chat_id: '1', text: 'p', bot_name: 'b', pending_id: -1, reply_to_id: 9 });
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 9 }), true);
    // Sanity: a different inbound on the same chat is unaffected.
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 99 }), false);
    void r;
  });

  test('hasOutboundReplyTo ignores ordinary failed outbounds', () => {
    const r1 = db.insertOutboundPending({ chat_id: '1', text: 'p', bot_name: 'b', pending_id: -1, reply_to_id: 9 });
    db.markOutboundFailed(r1.lastInsertRowid, 'timeout');
    // failed with ordinary API error (not the crashed-mid-send sentinel)
    // → not counted; replay should re-dispatch.
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 9 }), false);
  });

  // rc.51: when an EIO orphan-loop kills a turn after sending only an
  // intermediate ack-bubble (the rc.50 incident exposed this), boot
  // replay's hasOutboundReplyTo dedupe sees the ack and skips the replay
  // — losing the user's actual answer. The fix: gate dedupe on
  // `turn_metrics`, which is only inserted when a turn definitively
  // completes. No turn_metrics row → turn never finished → replay.
  test('hasCompletedTurnFor true when turn_metrics row exists for that msg_id', () => {
    db.insertTurnMetric({
      chat_id: '1', msg_id: 158, bot_name: 'b',
      result_subtype: 'success', duration_ms: 1000,
    });
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 158 }), true);
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 159 }), false);
  });

  test('hasCompletedTurnFor false when turn errored mid-flight', () => {
    db.insertTurnMetric({
      chat_id: '1', msg_id: 158, bot_name: 'b',
      result_subtype: 'error_max_turns', duration_ms: 500, error: 'aborted',
    });
    // Turn that errored should NOT count as complete — replay if still in window.
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 158 }), false);
  });

  test('hasCompletedTurnFor distinguishes msg_id within same chat', () => {
    db.insertTurnMetric({ chat_id: '1', msg_id: 100, bot_name: 'b', result_subtype: 'success', duration_ms: 100 });
    db.insertTurnMetric({ chat_id: '1', msg_id: 200, bot_name: 'b', result_subtype: 'success', duration_ms: 100 });
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 100 }), true);
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 200 }), true);
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 300 }), false);
  });

  test('hasCompletedTurnFor scoped per-chat (same msg_id in different chats)', () => {
    db.insertTurnMetric({ chat_id: '1', msg_id: 5, bot_name: 'b', result_subtype: 'success', duration_ms: 100 });
    assert.equal(db.hasCompletedTurnFor({ chat_id: '1', msg_id: 5 }), true);
    assert.equal(db.hasCompletedTurnFor({ chat_id: '2', msg_id: 5 }), false);
  });

  test('hasOutboundReplyTo counts crashed-mid-send rows as replied (avoid double-reply on boot replay)', () => {
    // Polygram crashed after API call but before markOutboundSent.
    // markStalePending swept the row to status='failed' with the
    // 'crashed-mid-send' sentinel error. Telegram may have delivered
    // the message; we don't know. Treating it as un-replied caused
    // boot replay to re-dispatch the same inbound and the user got
    // the SAME answer twice.
    const r = db.insertOutboundPending({ chat_id: '1', text: 'reply', bot_name: 'b', pending_id: -1, reply_to_id: 42 });
    db.markOutboundFailed(r.lastInsertRowid, 'crashed-mid-send');
    assert.equal(db.hasOutboundReplyTo({ chat_id: '1', msg_id: 42 }), true);
  });

  test('getReplayCandidates default window is 3 minutes (recent stays, old drops)', () => {
    const now = Date.now();
    db.insertMessage({
      chat_id: '1', msg_id: 1, direction: 'in', source: 'tg',
      text: 'recent', ts: now - 60_000, // 1 min ago
    });
    db.insertMessage({
      chat_id: '1', msg_id: 2, direction: 'in', source: 'tg',
      text: 'ancient', ts: now - 10 * 60_000, // 10 min ago
    });
    db.setInboundHandlerStatus({ chat_id: '1', msg_id: 1, status: 'replay-pending' });
    db.setInboundHandlerStatus({ chat_id: '1', msg_id: 2, status: 'replay-pending' });
    const got = db.getReplayCandidates({ chatIds: ['1'] });
    assert.deepEqual(got.map((r) => r.msg_id), [1]);
  });

  test('getReplayCandidates excludes replay-attempted (one-shot guard)', () => {
    const now = Date.now();
    db.insertMessage({
      chat_id: '1', msg_id: 1, direction: 'in', source: 'tg',
      text: 'tried', ts: now - 30_000,
    });
    db.setInboundHandlerStatus({ chat_id: '1', msg_id: 1, status: 'replay-attempted' });
    assert.equal(db.getReplayCandidates({ chatIds: ['1'] }).length, 0);
  });
});

describe('insertTurnMetric', () => {
  // F-telemetry — one row per dispatched user turn, queryable via the
  // turn_metrics table. polygram.js inserts after every Result
  // message; this test pins the field round-trip.
  beforeEach(() => { ({ db, dbPath } = freshDb('turn-metric')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('happy-path roundtrip: full row inserts cleanly', () => {
    db.insertTurnMetric({
      chat_id: '1', thread_id: null, msg_id: 100,
      session_id: 'sess-1', bot_name: 'testbot',
      model: 'sonnet', effort: 'medium',
      input_tokens: 100, output_tokens: 50,
      cache_creation_tokens: 10, cache_read_tokens: 200,
      cost_usd: 0.0042, duration_ms: 1234,
      num_assistant_messages: 2, num_tool_uses: 1,
      result_subtype: 'success', error: null,
    });
    const row = db.raw.prepare('SELECT * FROM turn_metrics WHERE msg_id = 100').get();
    assert.equal(row.chat_id, '1');
    assert.equal(row.session_id, 'sess-1');
    assert.equal(row.input_tokens, 100);
    assert.equal(row.cache_read_tokens, 200);
    assert.equal(row.cost_usd, 0.0042);
    assert.equal(row.result_subtype, 'success');
  });

  test('numeric chat_id is stringified', () => {
    db.insertTurnMetric({ chat_id: 12345, msg_id: 1, bot_name: 'b' });
    const row = db.raw.prepare('SELECT chat_id FROM turn_metrics WHERE msg_id = 1').get();
    assert.equal(row.chat_id, '12345');
  });

  test('thread_id null vs non-null both accepted', () => {
    db.insertTurnMetric({ chat_id: '1', thread_id: null, msg_id: 1, bot_name: 'b' });
    db.insertTurnMetric({ chat_id: '1', thread_id: 42, msg_id: 2, bot_name: 'b' });
    const r1 = db.raw.prepare('SELECT thread_id FROM turn_metrics WHERE msg_id = 1').get();
    const r2 = db.raw.prepare('SELECT thread_id FROM turn_metrics WHERE msg_id = 2').get();
    assert.equal(r1.thread_id, null);
    assert.equal(r2.thread_id, '42');     // stringified
  });

  test('null/undefined optional fields stored as NULL (not 0/empty)', () => {
    db.insertTurnMetric({ chat_id: '1', msg_id: 1, bot_name: 'b' });
    const row = db.raw.prepare('SELECT * FROM turn_metrics WHERE msg_id = 1').get();
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.cost_usd, null);
    assert.equal(row.num_assistant_messages, null);
    assert.equal(row.num_tool_uses, null);
    assert.equal(row.result_subtype, null);
  });

  test('default ts is now (within 5 seconds)', () => {
    const before = Date.now();
    db.insertTurnMetric({ chat_id: '1', msg_id: 1, bot_name: 'b' });
    const row = db.raw.prepare('SELECT ts FROM turn_metrics WHERE msg_id = 1').get();
    assert.ok(row.ts >= before);
    assert.ok(row.ts <= Date.now() + 5000);
  });

  test('explicit ts is honored', () => {
    db.insertTurnMetric({ chat_id: '1', msg_id: 1, bot_name: 'b', ts: 1_700_000_000_000 });
    const row = db.raw.prepare('SELECT ts FROM turn_metrics WHERE msg_id = 1').get();
    assert.equal(row.ts, 1_700_000_000_000);
  });

  test('error result subtype: row still records (negative-path telemetry)', () => {
    db.insertTurnMetric({
      chat_id: '1', msg_id: 1, bot_name: 'b',
      result_subtype: 'error_during_execution',
      error: 'HTTP 503',
    });
    const row = db.raw.prepare('SELECT result_subtype, error FROM turn_metrics WHERE msg_id = 1').get();
    assert.equal(row.result_subtype, 'error_during_execution');
    assert.equal(row.error, 'HTTP 503');
  });

  test('multiple rows accumulate (no UPSERT — every turn is a new row)', () => {
    for (let i = 0; i < 5; i++) {
      db.insertTurnMetric({ chat_id: '1', msg_id: 100 + i, bot_name: 'b' });
    }
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM turn_metrics WHERE chat_id='1'").get();
    assert.equal(count.n, 5);
  });
});

describe('setMessageText', () => {
  // Used by polygram's stream-reply when an outbound message is edited:
  // sets messages.text to the final rendered content so the DB reflects
  // what the user actually saw (not the pre-edit placeholder).
  beforeEach(() => { ({ db, dbPath } = freshDb('set-text')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('updates the matching row\'s text', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 100, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'placeholder…',
    });
    db.setMessageText({ chat_id: '1', msg_id: 100, text: 'final answer' });
    const row = db.getMessage('1', 100);
    assert.equal(row.text, 'final answer');
  });

  test('handles null text by writing empty string (no NOT NULL violation)', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 100, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'placeholder',
    });
    assert.doesNotThrow(() => db.setMessageText({ chat_id: '1', msg_id: 100, text: null }));
    const row = db.getMessage('1', 100);
    assert.equal(row.text, '');
  });

  test('numeric chat_id is normalised to string before lookup', () => {
    // chat_id is stored as TEXT; setMessageText should coerce.
    db.insertMessage({
      chat_id: 100, msg_id: 1, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'p',
    });
    db.setMessageText({ chat_id: 100, msg_id: 1, text: 'updated' });
    const row = db.getMessage(100, 1);
    assert.equal(row.text, 'updated');
  });

  test('non-matching chat_id/msg_id is a no-op (no error, no creates)', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 100, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'unchanged',
    });
    const res = db.setMessageText({ chat_id: '999', msg_id: 999, text: 'never lands' });
    assert.equal(res.changes, 0);
    const original = db.getMessage('1', 100);
    assert.equal(original.text, 'unchanged');
    const ghost = db.getMessage('999', 999);
    assert.equal(ghost, undefined);
  });

  test('chat_id + msg_id is the composite key — same msg_id in different chats are independent', () => {
    db.insertMessage({
      chat_id: '1', msg_id: 5, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'chat-1 msg',
    });
    db.insertMessage({
      chat_id: '2', msg_id: 5, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'chat-2 msg',
    });
    db.setMessageText({ chat_id: '1', msg_id: 5, text: 'edited chat 1' });
    assert.equal(db.getMessage('1', 5).text, 'edited chat 1');
    assert.equal(db.getMessage('2', 5).text, 'chat-2 msg');
  });

  test('long text passes through (no truncation)', () => {
    const long = 'x'.repeat(10_000);
    db.insertMessage({
      chat_id: '1', msg_id: 100, direction: 'out', source: 'polygram',
      bot_name: 'testbot', text: 'short',
    });
    db.setMessageText({ chat_id: '1', msg_id: 100, text: long });
    const row = db.getMessage('1', 100);
    assert.equal(row.text.length, 10_000);
  });
});

describe('findOrphanedCompactCommands — rc.61', () => {
  // Discovery: 2026-05-05 — Ivan ran /compact, polygram pushed it to
  // SDK input controller, then rc.59 deploy fired before SDK could
  // process. The compact-command event landed but no compact-boundary
  // followed. User saw "🗜️ Compacting..." then context stayed full.
  // Now: boot-time scan surfaces these as compact-failed-restart
  // events + posts to chat so user knows to re-run.

  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('returns empty when there are no compact-command events', () => {
    assert.deepEqual(db.findOrphanedCompactCommands(), []);
  });

  test('compact-command WITHOUT matching boundary → orphan returned', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, user: 'Ivan', user_id: 1,
    });
    const orphans = db.findOrphanedCompactCommands();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].session_key, '-100:24');
    assert.equal(orphans[0].chat_id, '-100');
    assert.equal(orphans[0].thread_id, '24');
    assert.equal(orphans[0].user, 'Ivan');
  });

  test('compact-command followed by matching boundary → NOT orphaned', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, user: 'Ivan', user_id: 1,
    });
    db.logEvent('compact-boundary', {
      session_key: '-100:24', trigger: 'manual', pre_tokens: 170000, post_tokens: 8000,
    });
    assert.deepEqual(db.findOrphanedCompactCommands(), []);
  });

  test('boundary BEFORE compact-command does NOT count as a match', () => {
    // Earlier compact (already handled) followed by a NEW /compact that's orphaned.
    db.logEvent('compact-boundary', {
      session_key: '-100:24', trigger: 'manual', pre_tokens: 170000, post_tokens: 8000,
    });
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, user: 'Ivan', user_id: 1,
    });
    const orphans = db.findOrphanedCompactCommands();
    assert.equal(orphans.length, 1, 'NEW /compact after earlier boundary is still orphaned');
  });

  test('boundary with DIFFERENT session_key does NOT count as a match', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, user: 'Ivan', user_id: 1,
    });
    db.logEvent('compact-boundary', {
      session_key: '-200:5', // different session
      trigger: 'manual', pre_tokens: 170000, post_tokens: 8000,
    });
    assert.equal(db.findOrphanedCompactCommands().length, 1);
  });

  test('multiple orphans returned in chronological order', () => {
    db.logEvent('compact-command', { session_key: 'a', chat_id: '1', thread_id: null });
    db.logEvent('compact-command', { session_key: 'b', chat_id: '2', thread_id: null });
    db.logEvent('compact-command', { session_key: 'c', chat_id: '3', thread_id: null });
    const orphans = db.findOrphanedCompactCommands();
    assert.equal(orphans.length, 3);
    assert.equal(orphans[0].session_key, 'a');
    assert.equal(orphans[1].session_key, 'b');
    assert.equal(orphans[2].session_key, 'c');
  });

  test('mixed: one resolved, one orphan — only the orphan returned', () => {
    db.logEvent('compact-command', { session_key: 'resolved', chat_id: '1', thread_id: null });
    db.logEvent('compact-boundary', { session_key: 'resolved', trigger: 'manual' });
    db.logEvent('compact-command', { session_key: 'orphan', chat_id: '2', thread_id: null });
    const orphans = db.findOrphanedCompactCommands();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].session_key, 'orphan');
  });

  test('respects olderThanMs cutoff', () => {
    // Force an old event by manipulating ts directly via raw insert.
    const oldTs = Date.now() - 60 * 60 * 1000; // 60 min ago
    db.raw.prepare(`
      INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)
    `).run(oldTs, '-100', 'compact-command', JSON.stringify({
      chat_id: '-100', session_key: '-100:24', user: 'Ivan',
    }));
    const recent = db.findOrphanedCompactCommands({ olderThanMs: 30 * 60 * 1000 });
    assert.deepEqual(recent, [], '60-min-old event filtered by 30-min window');
    const wide = db.findOrphanedCompactCommands({ olderThanMs: 90 * 60 * 1000 });
    assert.equal(wide.length, 1, '90-min window includes it');
  });

  test('compact-command without session_key in detail (legacy pre-rc.61) is skipped', () => {
    // Pre-rc.61 compact-command events had no session_key. Don't try
    // to surface those — we can't match them.
    db.raw.prepare(`
      INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)
    `).run(Date.now(), '-100', 'compact-command', JSON.stringify({
      chat_id: '-100', text_len: 50, user: 'Ivan', /* no session_key */
    }));
    assert.deepEqual(db.findOrphanedCompactCommands(), []);
  });
});

describe('findOrphanedCompactCommands — rc.65 returns full text', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('rc.65 events include the full /compact text in the result', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, text: '/compact keep the Q3 commission decisions',
      user: 'Ivan', user_id: 1,
    });
    const [orphan] = db.findOrphanedCompactCommands();
    assert.equal(orphan.text, '/compact keep the Q3 commission decisions');
  });

  test('pre-rc.65 events (no text field) return text=null gracefully', () => {
    // Simulate a legacy event written before rc.65.
    db.raw.prepare(`
      INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)
    `).run(Date.now(), '-100', 'compact-command', JSON.stringify({
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text_len: 50, /* no text field */
      user: 'Ivan', user_id: 1,
    }));
    const [orphan] = db.findOrphanedCompactCommands();
    assert.equal(orphan.text, null,
      'caller can fall back to "please retry" when text is null');
  });
});

describe('findOrphanedCompactCommands — rc.66 dedupe handled orphans', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('orphan with prior compact-replay event is NOT re-returned', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      text: '/compact xyz', user: 'Ivan',
    });
    const cmd = db.raw.prepare("SELECT id, ts FROM events WHERE kind='compact-command'").get();
    db.logEvent('compact-replay', {
      chat_id: '-100', session_key: '-100:24',
      original_ts: cmd.ts, text_len: 12, user: 'Ivan',
    });
    assert.deepEqual(db.findOrphanedCompactCommands(), []);
  });

  test('orphan with prior compact-failed-restart event is NOT re-returned', () => {
    db.logEvent('compact-command', {
      chat_id: '-100', thread_id: '24', session_key: '-100:24',
      user: 'Ivan',
    });
    const cmd = db.raw.prepare("SELECT id, ts FROM events WHERE kind='compact-command'").get();
    db.logEvent('compact-failed-restart', {
      chat_id: '-100', session_key: '-100:24',
      original_ts: cmd.ts, user: 'Ivan',
    });
    assert.deepEqual(db.findOrphanedCompactCommands(), []);
  });

  test('handled-marker for ONE orphan does NOT mask another fresh orphan', () => {
    // Use explicit non-colliding timestamps via raw insert. logEvent
    // uses Date.now() — events fired in the same millisecond would
    // share `ts` and the original_ts dedupe match would be ambiguous.
    const tsHandled = 1_777_000_000_000;
    const tsFresh = 1_777_000_001_000;
    db.raw.prepare(`INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)`).run(
      tsHandled, '-100', 'compact-command',
      JSON.stringify({ chat_id: '-100', session_key: '-100:24', user: 'Ivan' }),
    );
    db.raw.prepare(`INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)`).run(
      tsHandled + 1, '-100', 'compact-replay',
      JSON.stringify({ session_key: '-100:24', original_ts: tsHandled, text_len: 5 }),
    );
    db.raw.prepare(`INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?, ?, ?, ?)`).run(
      tsFresh, '-100', 'compact-command',
      JSON.stringify({ chat_id: '-100', session_key: '-100:24', user: 'Ivan' }),
    );
    const orphans = db.findOrphanedCompactCommands({ olderThanMs: 9_999_999_999_999 });
    assert.equal(orphans.length, 1, 'fresh orphan returns even when older was handled');
    assert.equal(orphans[0].ts, tsFresh);
  });
});

describe('isInboundLive', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('inbound-live')); });
  afterEach(() => { cleanupDb(dbPath, db); db = null; dbPath = null; });

  function insertInbound(chatId, msgId, status) {
    db.insertMessage({
      chat_id: chatId, msg_id: msgId, direction: 'in',
      text: 'hi', ts: Date.now(), bot_name: 'testbot',
    });
    if (status) db.setInboundHandlerStatus({ chat_id: chatId, msg_id: msgId, status });
  }

  test('returns true for dispatched message', () => {
    insertInbound('100', 1, 'dispatched');
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 1 }), true);
  });

  test('returns true for processing message (legacy state)', () => {
    insertInbound('100', 2, 'processing');
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 2 }), true);
  });

  test('returns false for replied message (turn complete)', () => {
    insertInbound('100', 3, 'replied');
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 3 }), false);
  });

  test('returns false for aborted/failed/replay-* messages', () => {
    insertInbound('100', 4, 'aborted');
    insertInbound('100', 5, 'failed');
    insertInbound('100', 6, 'replay-pending');
    insertInbound('100', 7, 'replay-attempted');
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 4 }), false);
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 5 }), false);
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 6 }), false);
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 7 }), false);
  });

  test('returns false for unknown msg_id (never dispatched)', () => {
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 99999 }), false);
  });

  test('returns false for outbound message even with matching status', () => {
    db.insertMessage({
      chat_id: '100', msg_id: 50, direction: 'out',
      text: 'bot reply', ts: Date.now(), bot_name: 'testbot',
    });
    // Manually set handler_status on outbound — query must still return false.
    db.raw.prepare(`UPDATE messages SET handler_status = 'dispatched' WHERE msg_id = 50 AND direction = 'out'`).run();
    assert.equal(db.isInboundLive({ chat_id: '100', msg_id: 50 }), false);
  });
});

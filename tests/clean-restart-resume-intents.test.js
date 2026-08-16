'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { freshDb, cleanupDb, insertInbound } = require('./helpers/db-fixture');
const { open } = require('../lib/db');

const BOT_NAME = 'shumabit';
const SESSION_KEY = '-100:3';
const NOW = 1_800_000_000_000;
const MAX_AGE_MS = 60_000;
const POLICY_VERSION = 1;
const CODEX_POLICY_VERSION = 2;

let db;
let dbPath;

function upsertChannelsSession(providerSessionId = 'claude-session-1') {
  db.upsertProviderSession({
    session_key: SESSION_KEY,
    namespace: 'claude:channels',
    provider: 'claude',
    provider_session_id: providerSessionId,
    agent: 'shumabit',
    cwd: '/workspace',
    model: 'opus',
    effort: 'high',
    pm_backend: 'cli',
    chat_id: '-100',
    thread_id: '3',
    ts: NOW - 2_000,
  });
  return db.getProviderSession(SESSION_KEY, 'claude:channels');
}

function insertSource({ msgId = 700, status = 'processing' } = {}) {
  return insertInbound(db, {
    chat_id: '-100',
    thread_id: '3',
    msg_id: msgId,
    bot_name: BOT_NAME,
    handler_status: status,
    ts: NOW - 1_000,
  });
}

function recordIntent(sourceMessageId, overrides = {}) {
  return db.recordCleanShutdown({
    botName: BOT_NAME,
    now: NOW,
    continuationAuthorized: true,
    resumeIntents: [{
      sessionKey: SESSION_KEY,
      sourceMessageId,
      policyVersion: POLICY_VERSION,
      ...overrides,
    }],
  });
}

describe('clean restart resume intents', () => {
  beforeEach(() => {
    ({ db, dbPath } = freshDb('clean-restart-resume-intents'));
  });
  afterEach(() => cleanupDb(dbPath, db));

  test('migration 018 backfills unique generations for existing v17 sessions', (t) => {
    const legacyPath = `${dbPath}-v17`;
    let migrated = null;
    t.after(() => cleanupDb(legacyPath, migrated));
    const legacy = new Database(legacyPath);
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    for (const file of fs.readdirSync(migrationsDir).sort()) {
      const version = Number.parseInt(file.slice(0, 3), 10);
      if (!Number.isSafeInteger(version) || version > 17) continue;
      legacy.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      legacy.pragma(`user_version = ${version}`);
    }
    const insert = legacy.prepare(`
      INSERT INTO agent_runtime_sessions (
        session_key, namespace, provider, provider_session_id,
        app_server_session_id, agent, cwd, model, effort, pm_backend,
        created_ts, last_active_ts
      ) VALUES (?, 'claude:channels', 'claude', ?, NULL, 'agent',
                '/workspace', 'opus', 'high', 'cli', ?, ?)
    `);
    insert.run('chat:1', 'session-1', NOW, NOW);
    insert.run('chat:2', 'session-2', NOW, NOW);
    legacy.close();

    migrated = open(legacyPath);
    const columns = migrated.raw
      .prepare('PRAGMA table_info(clean_restart_resume_intents)')
      .all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      'bot_name',
      'session_key',
      'session_generation_id',
      'source_message_id',
      'shutdown_at',
      'policy_version',
      'interrupted_provider_turn_id',
      'interrupted_spawn_profile_id',
      'continuation_authorized',
    ]);
    const generations = migrated.raw.prepare(`
      SELECT generation_id
        FROM agent_runtime_sessions
       ORDER BY session_key
    `).all().map((row) => row.generation_id);
    assert.equal(generations.length, 2);
    assert.ok(generations.every((value) => /^[0-9a-f]{32}$/.test(value)));
    assert.equal(new Set(generations).size, generations.length);
  });

  test('migration 019 upgrades an existing v18 production database', (t) => {
    const legacyPath = `${dbPath}-v18`;
    let migrated = null;
    t.after(() => cleanupDb(legacyPath, migrated));
    const legacy = new Database(legacyPath);
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    for (const file of fs.readdirSync(migrationsDir).sort()) {
      const version = Number.parseInt(file.slice(0, 3), 10);
      if (!Number.isSafeInteger(version) || version > 18) continue;
      legacy.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      legacy.pragma(`user_version = ${version}`);
    }
    // A historical audit row from before the fingerprint was removed. Opening
    // the database must take the stored digest with it, not leave it behind.
    legacy.prepare(`INSERT INTO secret_redactions
      (chat_id, msg_id, rule, tier, length, sha256, action, ts)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run('-100', 1, 'aws-akia', 'high', 20, 'a'.repeat(64), 'redacted', 1);
    legacy.close();

    migrated = open(legacyPath);

    assert.equal(
      migrated.raw.pragma('user_version', { simple: true }),
      20,
    );
    const auditColumns = migrated.raw
      .prepare('PRAGMA table_info(secret_redactions)')
      .all()
      .map((column) => column.name);
    assert.ok(!auditColumns.includes('sha256'), 'historical fingerprints are dropped');
    const audit = migrated.raw.prepare('SELECT * FROM secret_redactions').all();
    assert.equal(audit.length, 1, 'the audit row itself survives');
    assert.ok(!JSON.stringify(audit[0]).includes('a'.repeat(64)));
    const providerColumns = migrated.raw
      .prepare('PRAGMA table_info(agent_runtime_sessions)')
      .all()
      .map((column) => column.name);
    assert.ok(providerColumns.includes('spawn_profile_id'));
    const intentColumns = migrated.raw
      .prepare('PRAGMA table_info(clean_restart_resume_intents)')
      .all()
      .map((column) => column.name);
    assert.ok(intentColumns.includes('interrupted_provider_turn_id'));
    assert.ok(intentColumns.includes('interrupted_spawn_profile_id'));
    assert.ok(intentColumns.includes('continuation_authorized'));
  });

  test('provider-session generation is stable for the same identity and rotates on replacement', () => {
    const first = upsertChannelsSession('claude-session-1');

    db.upsertProviderSession({
      ...first,
      model: 'sonnet',
      effort: 'medium',
      ts: NOW,
    });
    const metadataUpdate = db.getProviderSession(SESSION_KEY, 'claude:channels');
    assert.equal(metadataUpdate.generation_id, first.generation_id);

    upsertChannelsSession('claude-session-2');
    const replacement = db.getProviderSession(SESSION_KEY, 'claude:channels');
    assert.notEqual(replacement.generation_id, first.generation_id);
  });

  test('clean shutdown atomically marks replay, writes the exact intent, and stamps one epoch', () => {
    const session = upsertChannelsSession();
    const sourceMessageId = insertSource();

    const result = recordIntent(sourceMessageId);

    assert.equal(result.replayMarked, 1);
    assert.equal(result.intentsRecorded, 1);
    assert.deepEqual(
      db.raw.prepare('SELECT * FROM clean_restart_resume_intents').get(),
      {
        bot_name: BOT_NAME,
        session_key: SESSION_KEY,
        session_generation_id: session.generation_id,
        source_message_id: sourceMessageId,
        shutdown_at: NOW,
        policy_version: POLICY_VERSION,
        interrupted_provider_turn_id: null,
        interrupted_spawn_profile_id: null,
        continuation_authorized: 1,
      },
    );
    assert.equal(
      db.raw.prepare('SELECT clean_shutdown_at FROM polling_state WHERE bot_name = ?')
        .get(BOT_NAME).clean_shutdown_at,
      NOW,
    );
  });

  test('legacy restart intents cannot authorize continuation after migration', () => {
    upsertChannelsSession();
    const sourceMessageId = insertSource();
    recordIntent(sourceMessageId);
    db.raw.prepare(`
      UPDATE clean_restart_resume_intents
         SET continuation_authorized = 0
       WHERE bot_name = ?
    `).run(BOT_NAME);

    const [claim] = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 1,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION, CODEX_POLICY_VERSION],
    }).claims;

    assert.equal(claim.executable, false);
    assert.equal(claim.reason, 'unauthorized-restart');
  });

  test('Codex intent binds the exact interrupted turn and retired spawn profile', () => {
    db.upsertProviderSession({
      session_key: SESSION_KEY,
      namespace: 'codex:app-server',
      provider: 'codex',
      provider_session_id: 'thread-codex',
      agent: null,
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      pm_backend: 'codex',
      spawn_profile_id: 'profile-codex',
      chat_id: '-100',
      thread_id: '3',
      ts: NOW - 2_000,
    });
    const sourceMessageId = insertSource();

    db.recordCleanShutdown({
      botName: BOT_NAME,
      now: NOW,
      continuationAuthorized: true,
      resumeIntents: [{
        sessionKey: SESSION_KEY,
        sourceMessageId,
        policyVersion: CODEX_POLICY_VERSION,
        interruptedProviderTurnId: 'turn-interrupted',
        interruptedSpawnProfileId: 'profile-codex',
        expectedProviderSessionId: 'thread-codex',
        expectedCwd: '/workspace',
        expectedModel: 'gpt-5.6-sol',
        expectedEffort: 'xhigh',
      }],
    });
    const [claim] = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 1,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION, CODEX_POLICY_VERSION],
    }).claims;

    assert.equal(claim.executable, true);
    assert.equal(claim.provider_namespace, 'codex:app-server');
    assert.equal(claim.provider_session_id, 'thread-codex');
    assert.equal(claim.interrupted_provider_turn_id, 'turn-interrupted');
    assert.equal(claim.interrupted_spawn_profile_id, 'profile-codex');
    assert.equal(claim.current_spawn_profile_id, 'profile-codex');
  });

  test('Codex intent rejects a provider row that no longer matches the retired process', () => {
    db.upsertProviderSession({
      session_key: SESSION_KEY,
      namespace: 'codex:app-server',
      provider: 'codex',
      provider_session_id: 'thread-current',
      agent: null,
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      pm_backend: 'codex',
      spawn_profile_id: 'profile-codex',
      chat_id: '-100',
      thread_id: '3',
      ts: NOW - 2_000,
    });
    const sourceMessageId = insertSource();

    assert.throws(
      () => db.recordCleanShutdown({
        botName: BOT_NAME,
        now: NOW,
        continuationAuthorized: true,
        resumeIntents: [{
          sessionKey: SESSION_KEY,
          sourceMessageId,
          policyVersion: CODEX_POLICY_VERSION,
          interruptedProviderTurnId: 'turn-interrupted',
          interruptedSpawnProfileId: 'profile-codex',
          expectedProviderSessionId: 'thread-retired',
          expectedCwd: '/workspace',
          expectedModel: 'gpt-5.6-sol',
          expectedEffort: 'xhigh',
        }],
      }),
      /provider session changed/,
    );
    assert.equal(
      db.raw.prepare(
        'SELECT clean_shutdown_at FROM polling_state WHERE bot_name = ?',
      ).get(BOT_NAME),
      undefined,
    );
  });

  test('Codex-shaped clean restart intents require policy version 2', () => {
    const sourceMessageId = insertSource();
    assert.throws(
      () => db.recordCleanShutdown({
        botName: BOT_NAME,
        now: NOW,
        continuationAuthorized: true,
        resumeIntents: [{
          sessionKey: SESSION_KEY,
          sourceMessageId,
          policyVersion: POLICY_VERSION,
          interruptedProviderTurnId: 'turn-interrupted',
          interruptedSpawnProfileId: 'profile-codex',
          expectedProviderSessionId: 'thread-codex',
          expectedCwd: '/workspace',
          expectedModel: 'gpt-5.6-sol',
          expectedEffort: 'xhigh',
        }],
      }),
      /policy version 2/,
    );
  });

  test('claim tombstones a corrupted Codex-shaped policy-v1 row', () => {
    db.upsertProviderSession({
      session_key: SESSION_KEY,
      namespace: 'codex:app-server',
      provider: 'codex',
      provider_session_id: 'thread-codex',
      agent: null,
      cwd: '/workspace',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      pm_backend: 'codex',
      spawn_profile_id: 'profile-codex',
      chat_id: '-100',
      thread_id: '3',
      ts: NOW - 2_000,
    });
    const sourceMessageId = insertSource();
    const runtime = db.getProviderSession(SESSION_KEY, 'codex:app-server');
    db.raw.prepare(`
      INSERT INTO clean_restart_resume_intents (
        bot_name, session_key, session_generation_id, source_message_id,
        shutdown_at, policy_version, interrupted_provider_turn_id,
        interrupted_spawn_profile_id, continuation_authorized
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)
    `).run(
      BOT_NAME,
      SESSION_KEY,
      runtime.generation_id,
      sourceMessageId,
      NOW,
      'turn-interrupted',
      'profile-codex',
    );
    db.raw.prepare(`
      INSERT INTO polling_state (
        bot_name, last_update_id, ts, clean_shutdown_at
      ) VALUES (?, 0, ?, ?)
    `).run(BOT_NAME, NOW, NOW);

    const result = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 1,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION, CODEX_POLICY_VERSION],
    });

    assert.equal(result.claims[0].executable, false);
    assert.equal(result.claims[0].reason, 'unsupported-codex-policy');
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS count FROM clean_restart_resume_intents',
      ).get().count,
      0,
    );
  });

  test('claim tombstones profile-only malformed controls instead of treating them as Claude', () => {
    const runtime = upsertChannelsSession();
    const sourceMessageId = insertSource();
    db.raw.prepare(`
      INSERT INTO clean_restart_resume_intents (
        bot_name, session_key, session_generation_id, source_message_id,
        shutdown_at, policy_version, interrupted_provider_turn_id,
        interrupted_spawn_profile_id, continuation_authorized
      ) VALUES (?, ?, ?, ?, ?, 1, NULL, '', 1)
    `).run(
      BOT_NAME,
      SESSION_KEY,
      runtime.generation_id,
      sourceMessageId,
      NOW,
    );
    db.raw.prepare(`
      INSERT INTO polling_state (
        bot_name, last_update_id, ts, clean_shutdown_at
      ) VALUES (?, 0, ?, ?)
    `).run(BOT_NAME, NOW, NOW);

    const result = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 1,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION, CODEX_POLICY_VERSION],
    });

    assert.equal(result.claims[0].executable, false);
    assert.equal(result.claims[0].reason, 'unsupported-codex-policy');
  });

  test('clean shutdown rolls back replay and marker when an intent cannot bind a session generation', () => {
    const sourceMessageId = insertSource({ status: 'dispatched' });

    assert.throws(
      () => recordIntent(sourceMessageId),
      /session generation/i,
    );
    assert.equal(
      db.raw.prepare('SELECT handler_status FROM messages WHERE id = ?')
        .get(sourceMessageId).handler_status,
      'dispatched',
    );
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM clean_restart_resume_intents')
        .get().count,
      0,
    );
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM polling_state WHERE bot_name = ?')
        .get(BOT_NAME).count,
      0,
    );
  });

  test('fresh marker claims supported and unsupported intents once and tombstones every source', () => {
    const firstSession = upsertChannelsSession();
    const firstSource = insertSource({ msgId: 700 });
    recordIntent(firstSource);

    const secondSessionKey = '-100:4';
    db.upsertProviderSession({
      session_key: secondSessionKey,
      namespace: 'claude:channels',
      provider: 'claude',
      provider_session_id: 'claude-session-2',
      agent: 'shumabit',
      cwd: '/workspace',
      pm_backend: 'cli',
      chat_id: '-100',
      thread_id: '4',
      ts: NOW - 2_000,
    });
    const secondSource = insertInbound(db, {
      chat_id: '-100',
      thread_id: '4',
      msg_id: 701,
      bot_name: BOT_NAME,
      handler_status: 'processing',
      ts: NOW - 1_000,
    });
    db.recordCleanShutdown({
      botName: BOT_NAME,
      now: NOW,
      continuationAuthorized: true,
      resumeIntents: [
        {
          sessionKey: SESSION_KEY,
          sourceMessageId: firstSource,
          policyVersion: POLICY_VERSION,
        },
        {
          sessionKey: secondSessionKey,
          sourceMessageId: secondSource,
          policyVersion: 999,
        },
      ],
    });

    const claimed = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 1,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION],
    });

    assert.equal(claimed.clean, true);
    assert.equal(claimed.claims.length, 2);
    const supported = claimed.claims.find((claim) => claim.session_key === SESSION_KEY);
    assert.equal(supported.executable, true);
    assert.equal(supported.reason, null);
    assert.equal(supported.session_generation_id, firstSession.generation_id);
    assert.equal(supported.provider_session_id, 'claude-session-1');
    const unsupported = claimed.claims.find((claim) => claim.session_key === secondSessionKey);
    assert.equal(unsupported.executable, false);
    assert.equal(unsupported.reason, 'unsupported-policy-version');

    const statuses = db.raw.prepare(`
      SELECT id, handler_status FROM messages WHERE id IN (?, ?) ORDER BY id
    `).all(firstSource, secondSource);
    assert.deepEqual(
      statuses.map((row) => row.handler_status),
      ['resume-attempted', 'resume-attempted'],
    );
    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM clean_restart_resume_intents')
        .get().count,
      0,
    );

    const secondBoot = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 2,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION],
    });
    assert.equal(secondBoot.clean, false);
    assert.deepEqual(secondBoot.claims, []);
    assert.deepEqual(
      secondBoot.stranded.map((row) => row.id).sort((a, b) => a - b),
      [firstSource, secondSource],
    );
  });

  test('replaced provider-session generation is claimed notice-only', () => {
    upsertChannelsSession('claude-session-1');
    const sourceMessageId = insertSource();
    recordIntent(sourceMessageId);
    upsertChannelsSession('claude-session-2');

    const claimed = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 1,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION],
    });

    assert.equal(claimed.claims.length, 1);
    assert.equal(claimed.claims[0].executable, false);
    assert.equal(claimed.claims[0].reason, 'session-generation-replaced');
    assert.equal(claimed.claims[0].provider_session_id, null);
  });

  test('crash shutdown clears stale intents and never exposes a continuation claim', () => {
    upsertChannelsSession();
    const sourceMessageId = insertSource();
    recordIntent(sourceMessageId);

    db.recordCrashShutdown({ botName: BOT_NAME, now: NOW + 1 });

    assert.equal(
      db.raw.prepare('SELECT COUNT(*) AS count FROM clean_restart_resume_intents')
        .get().count,
      0,
    );
    const claimed = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 2,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION],
    });
    assert.equal(claimed.clean, false);
    assert.deepEqual(claimed.claims, []);
  });

  test('claimed internal message ID reconstructs the original Telegram source message ID', () => {
    upsertChannelsSession();
    const sourceMessageId = insertSource({ msgId: 987654 });
    recordIntent(sourceMessageId);
    const [claim] = db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 1,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION],
    }).claims;

    const source = db.getInboundMessageById(claim.source_message_id);
    assert.equal(source.id, sourceMessageId);
    assert.equal(source.msg_id, 987654);
    assert.equal(source.chat_id, '-100');
    assert.equal(source.thread_id, '3');
    assert.equal(source.bot_name, BOT_NAME);
  });

  test('stale and future clean markers invalidate intents without claiming continue', () => {
    for (const claimNow of [NOW + MAX_AGE_MS + 1, NOW - 1]) {
      upsertChannelsSession();
      const sourceMessageId = insertSource({ msgId: claimNow });
      recordIntent(sourceMessageId);

      const result = db.claimCleanRestartRecovery({
        botName: BOT_NAME,
        now: claimNow,
        maxAgeMs: MAX_AGE_MS,
        supportedPolicyVersions: [POLICY_VERSION],
      });
      assert.equal(result.clean, false);
      assert.deepEqual(result.claims, []);
      assert.equal(
        db.raw.prepare('SELECT COUNT(*) AS count FROM clean_restart_resume_intents')
          .get().count,
        0,
      );
      db.raw.prepare('DELETE FROM messages').run();
      db.raw.prepare('DELETE FROM agent_runtime_sessions').run();
      db.raw.prepare('DELETE FROM sessions').run();
    }
  });

  test('claim completion is one-way from resume-attempted to a terminal status', () => {
    upsertChannelsSession();
    const sourceMessageId = insertSource();
    recordIntent(sourceMessageId);
    db.claimCleanRestartRecovery({
      botName: BOT_NAME,
      now: NOW + 1,
      maxAgeMs: MAX_AGE_MS,
      supportedPolicyVersions: [POLICY_VERSION],
    });

    assert.equal(
      db.completeCleanRestartRecovery({
        sourceMessageId,
        status: 'replied',
      }).changes,
      1,
    );
    assert.equal(
      db.completeCleanRestartRecovery({
        sourceMessageId,
        status: 'replay-skipped',
      }).changes,
      0,
    );
    assert.throws(
      () => db.completeCleanRestartRecovery({
        sourceMessageId,
        status: 'replay-pending',
      }),
      /terminal status/i,
    );
  });
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');

const identity = {
  stable_host_id: 'host-a',
  boot_session_id: 'boot-a',
};

function seedContainedGeneration(prefix) {
  const { db, dbPath } = freshDb(`polygram-codex-fault-${prefix}`);
  const generationId = `generation-${prefix}`;
  const sessionKey = `session-${prefix}`;
  const threadId = `thread-${prefix}`;
  db.createCodexGeneration({
    generation_id: generationId,
    session_key: sessionKey,
    thread_id: threadId,
    app_server_session_id: `app-server-${prefix}`,
    ...identity,
    ts: 1000,
  });
  db.acquireCodexLease({
    generation_id: generationId,
    ...identity,
    ts: 1050,
  });
  return { db, dbPath, generationId, sessionKey, threadId };
}

test('Codex containment checkpoints persist only closed fault provenance and owned identity', () => {
  const fx = seedContainedGeneration('checkpoint-safe');
  try {
    fx.db.recordCodexCheckpoint({
      kind: 'containment-entered',
      generationId: fx.generationId,
      threadId: fx.threadId,
      turnId: 'owned-turn',
      reason: 'cross-thread-notification',
      clientRootErrorCode: 'CODEX_PROTOCOL_ERROR',
      clientFaultClass: 'protocol',
      notificationMethod: 'turn/started',
      observedProcessState: 'Active',
      foreignThreadId: 'must-not-persist',
      foreignTurnId: 'must-not-persist',
      stderr: 'must-not-persist',
      payload: { text: 'must-not-persist' },
      ...identity,
      ts: 1100,
    });

    const row = fx.db.raw.prepare(`
      SELECT thread_id, turn_id, detail_json
        FROM codex_attempt_checkpoints
       WHERE generation_id = ? AND kind = 'containment-entered'
    `).get(fx.generationId);
    assert.equal(row.thread_id, fx.threadId);
    assert.equal(row.turn_id, 'owned-turn');
    assert.deepEqual(JSON.parse(row.detail_json), {
      reason: 'cross-thread-notification',
      clientRootErrorCode: 'CODEX_PROTOCOL_ERROR',
      clientFaultClass: 'protocol',
      notificationMethod: 'turn/started',
      observedProcessState: 'Active',
    });
  } finally {
    cleanupDb(fx.dbPath, fx.db);
  }
});

test('Codex checkpoint DB projection drops non-enum fault strings', () => {
  const fx = seedContainedGeneration('checkpoint-invalid');
  try {
    fx.db.recordCodexCheckpoint({
      kind: 'containment-entered',
      generationId: fx.generationId,
      threadId: fx.threadId,
      reason: 'transport-lost',
      clientRootErrorCode: 'EPIPE',
      clientFaultClass: 'raw-error-message',
      notificationMethod: 'thread/foreign/private-event',
      observedProcessState: '/private/workspace',
      ...identity,
      ts: 1100,
    });

    const detail = JSON.parse(fx.db.raw.prepare(`
      SELECT detail_json
        FROM codex_attempt_checkpoints
       WHERE generation_id = ? AND kind = 'containment-entered'
    `).get(fx.generationId).detail_json);
    assert.deepEqual(detail, { reason: 'transport-lost' });
  } finally {
    cleanupDb(fx.dbPath, fx.db);
  }
});

test('containment cleanup checkpoint retains the same safe provenance without arbitrary data', () => {
  const fx = seedContainedGeneration('cleanup-safe');
  try {
    fx.db.settleCodexFailedGeneration({
      generation_id: fx.generationId,
      session_key: fx.sessionKey,
      stable_host_id: identity.stable_host_id,
      incident_boot_session_id: identity.boot_session_id,
      current_boot_session_id: identity.boot_session_id,
      provider_session_id: fx.threadId,
      app_server_session_id: 'app-server-cleanup-safe',
      reason: 'stop-cleanup-failed',
      source: 'managed-group-empty',
      clientRootErrorCode: 'CODEX_RPC_TIMEOUT',
      clientFaultClass: 'rpc-timeout',
      notificationMethod: 'error',
      observedProcessState: 'ContainmentFailed',
      stderr: 'must-not-persist',
      foreignThreadId: 'must-not-persist',
      allow_missing_generation: false,
      ts: 1200,
    });

    const detail = JSON.parse(fx.db.raw.prepare(`
      SELECT detail_json
        FROM codex_attempt_checkpoints
       WHERE generation_id = ?
         AND kind = 'containment-cleanup-completed'
    `).get(fx.generationId).detail_json);
    assert.deepEqual(detail, {
      source: 'managed-group-empty',
      reason: 'stop-cleanup-failed',
      clientRootErrorCode: 'CODEX_RPC_TIMEOUT',
      clientFaultClass: 'rpc-timeout',
      notificationMethod: 'error',
      observedProcessState: 'ContainmentFailed',
    });
  } finally {
    cleanupDb(fx.dbPath, fx.db);
  }
});

#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { open } = require('../../../lib/db');
const {
  ProtectedReceiptAuthority,
  ensureReceiptColumns,
  bindSessionRow,
  resolveResumeWithReceipt,
} = require('./gate');

const POLICY = 'policy-current';
const CHILD = path.join(__dirname, 'tamper-child.js');

function targetFor(kind, label) {
  if (kind === 'legacy') {
    return {
      kind,
      sessionKey: `legacy-${label}`,
      namespace: 'claude:inline',
      providerSessionId: `claude-session-${label}`,
    };
  }
  return {
    kind,
    sessionKey: `provider-${label}`,
    namespace: 'codex:app-server',
    providerSessionId: `codex-thread-${label}`,
  };
}

function applyTamper(dbPath, payload) {
  const child = spawnSync(process.execPath, [CHILD, dbPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(`same-uid tamper child failed: ${child.stderr.trim()}`);
  }
  const result = JSON.parse(child.stdout);
  return Number.isInteger(result.uid) && result.uid === process.getuid();
}

function isCleared({ db, target }) {
  if (target.kind === 'legacy') {
    return db.raw.prepare('SELECT COUNT(*) AS count FROM sessions WHERE session_key = ?')
      .get(target.sessionKey).count === 0;
  }
  return db.raw.prepare(`
    SELECT COUNT(*) AS count
      FROM agent_runtime_sessions
     WHERE session_key = ? AND namespace = ?
  `).get(target.sessionKey, target.namespace).count === 0;
}

function storedRow(db, target) {
  if (target.kind === 'legacy') {
    return db.raw.prepare('SELECT * FROM sessions WHERE session_key = ?')
      .get(target.sessionKey);
  }
  return db.raw.prepare(`
    SELECT * FROM agent_runtime_sessions
     WHERE session_key = ? AND namespace = ?
  `).get(target.sessionKey, target.namespace);
}

function runGate() {
  if (typeof process.getuid !== 'function' || !Number.isInteger(process.getuid())) {
    return {
      status: 'BLOCKED',
      error_code: 'numeric-uid-required',
      same_uid_child: false,
      tables: ['sessions', 'agent_runtime_sessions'],
      checks: {},
    };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-session-receipt-gate-'));
  fs.chmodSync(directory, 0o700);
  const dbPath = path.join(directory, 'polygram.db');
  const authority = new ProtectedReceiptAuthority();
  let db;
  const checks = {
    valid_receipts_resume: true,
    missing_receipts_force_fresh: true,
    stale_receipts_force_fresh: true,
    provider_session_id_mutation_forces_fresh: true,
    current_identity_rewrite_forces_fresh: true,
    copied_receipts_force_fresh: true,
    unrelated_siblings_survive: true,
  };
  let sameUidChild = true;

  try {
    db = open(dbPath);
    ensureReceiptColumns(db.raw);

    for (const kind of ['legacy', 'provider']) {
      const sibling = targetFor(kind, 'unrelated-sibling');
      bindSessionRow({ db, authority, target: sibling, policyIdentity: POLICY });
      const siblingSnapshot = JSON.stringify(storedRow(db, sibling));
      const siblingSurvives = () => (
        JSON.stringify(storedRow(db, sibling)) === siblingSnapshot
      );

      const valid = targetFor(kind, 'valid');
      bindSessionRow({ db, authority, target: valid, policyIdentity: POLICY });
      checks.valid_receipts_resume &&= resolveResumeWithReceipt({
        db, authority, target: valid, policyIdentity: POLICY,
      }).action === 'resume';

      const missing = targetFor(kind, 'missing');
      bindSessionRow({ db, authority, target: missing, policyIdentity: POLICY });
      sameUidChild &&= applyTamper(dbPath, {
        kind,
        sessionKey: missing.sessionKey,
        namespace: missing.namespace,
        changes: { receipt: null },
      });
      const missingDecision = resolveResumeWithReceipt({
        db, authority, target: missing, policyIdentity: POLICY,
      });
      checks.missing_receipts_force_fresh &&= (
        missingDecision.reason === 'missing-receipt' && isCleared({ db, target: missing })
      );
      checks.unrelated_siblings_survive &&= siblingSurvives();

      const stale = targetFor(kind, 'stale');
      const staleReceipt = bindSessionRow({
        db, authority, target: stale, policyIdentity: POLICY,
      });
      const rebound = {
        ...stale,
        providerSessionId: `${stale.providerSessionId}-replacement`,
      };
      bindSessionRow({ db, authority, target: rebound, policyIdentity: POLICY });
      sameUidChild &&= applyTamper(dbPath, {
        kind,
        sessionKey: stale.sessionKey,
        namespace: stale.namespace,
        changes: {
          providerSessionId: stale.providerSessionId,
          receipt: staleReceipt,
        },
      });
      const staleDecision = resolveResumeWithReceipt({
        db, authority, target: stale, policyIdentity: POLICY,
      });
      checks.stale_receipts_force_fresh &&= (
        staleDecision.reason === 'receipt-rejected' && isCleared({ db, target: stale })
      );
      checks.unrelated_siblings_survive &&= siblingSurvives();

      const changedProviderId = targetFor(kind, 'changed-provider-id');
      bindSessionRow({
        db, authority, target: changedProviderId, policyIdentity: POLICY,
      });
      sameUidChild &&= applyTamper(dbPath, {
        kind,
        sessionKey: changedProviderId.sessionKey,
        namespace: changedProviderId.namespace,
        changes: {
          providerSessionId: `${changedProviderId.providerSessionId}-tampered`,
        },
      });
      const changedProviderIdDecision = resolveResumeWithReceipt({
        db,
        authority,
        target: changedProviderId,
        policyIdentity: POLICY,
      });
      checks.provider_session_id_mutation_forces_fresh &&= (
        changedProviderIdDecision.reason === 'receipt-rejected'
        && isCleared({ db, target: changedProviderId })
      );
      checks.unrelated_siblings_survive &&= siblingSurvives();

      const rewritten = targetFor(kind, 'rewritten');
      bindSessionRow({
        db,
        authority,
        target: rewritten,
        policyIdentity: 'policy-old',
      });
      sameUidChild &&= applyTamper(dbPath, {
        kind,
        sessionKey: rewritten.sessionKey,
        namespace: rewritten.namespace,
        changes: { memoryIdentity: POLICY },
      });
      const rewrittenDecision = resolveResumeWithReceipt({
        db, authority, target: rewritten, policyIdentity: POLICY,
      });
      checks.current_identity_rewrite_forces_fresh &&= (
        rewrittenDecision.reason === 'receipt-rejected'
        && isCleared({ db, target: rewritten })
      );
      checks.unrelated_siblings_survive &&= siblingSurvives();

      const source = targetFor(kind, 'copy-source');
      const destination = targetFor(kind, 'copy-destination');
      const sourceReceipt = bindSessionRow({
        db, authority, target: source, policyIdentity: POLICY,
      });
      bindSessionRow({ db, authority, target: destination, policyIdentity: POLICY });
      sameUidChild &&= applyTamper(dbPath, {
        kind,
        sessionKey: destination.sessionKey,
        namespace: destination.namespace,
        changes: {
          providerSessionId: source.providerSessionId,
          memoryIdentity: POLICY,
          receipt: sourceReceipt,
        },
      });
      const copiedDecision = resolveResumeWithReceipt({
        db, authority, target: destination, policyIdentity: POLICY,
      });
      checks.copied_receipts_force_fresh &&= (
        copiedDecision.reason === 'receipt-rejected'
        && isCleared({ db, target: destination })
      );
      checks.unrelated_siblings_survive &&= siblingSurvives();
    }
  } finally {
    try { db?.raw.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }

  return {
    status: sameUidChild && Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    same_uid_child: sameUidChild,
    tables: ['sessions', 'agent_runtime_sessions'],
    checks,
  };
}

const evidence = runGate();
console.log(JSON.stringify(evidence));
process.exitCode = evidence.status === 'PASS' ? 0 : 1;

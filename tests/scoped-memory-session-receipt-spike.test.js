const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { open } = require('../lib/db');
const {
  ProtectedReceiptAuthority,
  ensureReceiptColumns,
  bindSessionRow,
  resolveResumeWithReceipt,
} = require('../scripts/spikes/memory-session-receipts/gate');

const POLICY = 'policy-current';

let directory;
let db;
let authority;

function targets() {
  return [
    {
      kind: 'legacy',
      sessionKey: 'legacy-target',
      namespace: 'claude:inline',
      providerSessionId: 'claude-session-target',
    },
    {
      kind: 'provider',
      sessionKey: 'provider-target',
      namespace: 'codex:app-server',
      providerSessionId: 'codex-thread-target',
    },
  ];
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-session-receipt-test-'));
  fs.chmodSync(directory, 0o700);
  db = open(path.join(directory, 'polygram.db'));
  ensureReceiptColumns(db.raw);
  authority = new ProtectedReceiptAuthority();
});

afterEach(() => {
  try { db.raw.close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
});

test('valid protected receipts resume both persisted session tables', () => {
  for (const target of targets()) {
    bindSessionRow({ db, authority, target, policyIdentity: POLICY });
    const decision = resolveResumeWithReceipt({
      db,
      authority,
      target,
      policyIdentity: POLICY,
    });
    assert.equal(decision.action, 'resume');
    assert.equal(decision.providerSessionId, target.providerSessionId);
  }
});

test('same-uid missing and stale receipt tampering forces fresh sessions in both tables', () => {
  for (const [index, target] of targets().entries()) {
    bindSessionRow({ db, authority, target, policyIdentity: POLICY });
    const table = target.kind === 'legacy' ? 'sessions' : 'agent_runtime_sessions';
    const where = target.kind === 'legacy'
      ? 'session_key = ?'
      : 'session_key = ? AND namespace = ?';
    const args = target.kind === 'legacy'
      ? [target.sessionKey]
      : [target.sessionKey, target.namespace];
    db.raw.prepare(`UPDATE ${table} SET memory_session_receipt = NULL WHERE ${where}`).run(...args);

    const missing = resolveResumeWithReceipt({ db, authority, target, policyIdentity: POLICY });
    assert.equal(missing.action, 'fresh');
    assert.equal(missing.reason, 'missing-receipt');

    const reseeded = { ...target, providerSessionId: `${target.providerSessionId}-stale-${index}` };
    bindSessionRow({ db, authority, target: reseeded, policyIdentity: POLICY });
    db.raw.prepare(`UPDATE ${table} SET memory_session_receipt = ? WHERE ${where}`)
      .run('unknown-stale-receipt', ...args);
    const stale = resolveResumeWithReceipt({
      db,
      authority,
      target: reseeded,
      policyIdentity: POLICY,
    });
    assert.equal(stale.action, 'fresh');
    assert.equal(stale.reason, 'receipt-rejected');
  }
});

test('a previously valid receipt is stale after rebinding the same logical session', () => {
  for (const [index, target] of targets().entries()) {
    const oldReceipt = bindSessionRow({ db, authority, target, policyIdentity: POLICY });
    const rebound = {
      ...target,
      providerSessionId: `${target.providerSessionId}-replacement-${index}`,
    };
    bindSessionRow({ db, authority, target: rebound, policyIdentity: POLICY });

    const table = target.kind === 'legacy' ? 'sessions' : 'agent_runtime_sessions';
    const idColumn = target.kind === 'legacy' ? 'claude_session_id' : 'provider_session_id';
    const where = target.kind === 'legacy'
      ? 'session_key = ?'
      : 'session_key = ? AND namespace = ?';
    const args = target.kind === 'legacy'
      ? [target.sessionKey]
      : [target.sessionKey, target.namespace];
    db.raw.prepare(`
      UPDATE ${table}
         SET ${idColumn} = ?, memory_identity = ?, memory_session_receipt = ?
       WHERE ${where}
    `).run(target.providerSessionId, POLICY, oldReceipt, ...args);

    const stale = resolveResumeWithReceipt({
      db,
      authority,
      target,
      policyIdentity: POLICY,
    });
    assert.equal(stale.action, 'fresh');
    assert.equal(stale.reason, 'receipt-rejected');
  }
});

test('receipt authority binds every field of the exact tuple independently', () => {
  const tuple = {
    sessionKey: 'tuple-session',
    providerNamespace: 'codex:app-server',
    providerSessionId: 'tuple-thread',
    policyIdentity: POLICY,
  };
  const receipt = authority.bind(tuple);
  for (const field of Object.keys(tuple)) {
    assert.equal(
      authority.verify(receipt, { ...tuple, [field]: `${tuple[field]}-changed` }),
      false,
      `${field} must participate in receipt verification`,
    );
  }
});

test('rejecting a tampered row preserves an unrelated sibling byte-for-byte', () => {
  for (const [index, target] of targets().entries()) {
    const sibling = {
      ...target,
      sessionKey: `${target.sessionKey}-unrelated-${index}`,
      providerSessionId: `${target.providerSessionId}-unrelated-${index}`,
    };
    bindSessionRow({ db, authority, target: sibling, policyIdentity: POLICY });
    const table = target.kind === 'legacy' ? 'sessions' : 'agent_runtime_sessions';
    const siblingWhere = target.kind === 'legacy'
      ? 'session_key = ?'
      : 'session_key = ? AND namespace = ?';
    const siblingArgs = target.kind === 'legacy'
      ? [sibling.sessionKey]
      : [sibling.sessionKey, sibling.namespace];
    const before = db.raw.prepare(`SELECT * FROM ${table} WHERE ${siblingWhere}`)
      .get(...siblingArgs);

    bindSessionRow({ db, authority, target, policyIdentity: POLICY });
    const targetWhere = target.kind === 'legacy'
      ? 'session_key = ?'
      : 'session_key = ? AND namespace = ?';
    const targetArgs = target.kind === 'legacy'
      ? [target.sessionKey]
      : [target.sessionKey, target.namespace];
    db.raw.prepare(`UPDATE ${table} SET memory_session_receipt = NULL WHERE ${targetWhere}`)
      .run(...targetArgs);
    const decision = resolveResumeWithReceipt({
      db, authority, target, policyIdentity: POLICY,
    });

    assert.equal(decision.action, 'fresh');
    assert.deepEqual(
      db.raw.prepare(`SELECT * FROM ${table} WHERE ${siblingWhere}`).get(...siblingArgs),
      before,
    );
  }
});

test('current-identity rewrite and cross-row receipt copying cannot authorize resume', () => {
  for (const [index, target] of targets().entries()) {
    bindSessionRow({
      db,
      authority,
      target,
      policyIdentity: 'policy-old',
    });
    const table = target.kind === 'legacy' ? 'sessions' : 'agent_runtime_sessions';
    const where = target.kind === 'legacy'
      ? 'session_key = ?'
      : 'session_key = ? AND namespace = ?';
    const args = target.kind === 'legacy'
      ? [target.sessionKey]
      : [target.sessionKey, target.namespace];
    db.raw.prepare(`UPDATE ${table} SET memory_identity = ? WHERE ${where}`)
      .run(POLICY, ...args);
    const rewritten = resolveResumeWithReceipt({ db, authority, target, policyIdentity: POLICY });
    assert.equal(rewritten.action, 'fresh');
    assert.equal(rewritten.reason, 'receipt-rejected');

    const source = {
      ...target,
      sessionKey: `${target.sessionKey}-source-${index}`,
      providerSessionId: `${target.providerSessionId}-source-${index}`,
    };
    const destination = {
      ...target,
      sessionKey: `${target.sessionKey}-destination-${index}`,
      providerSessionId: `${target.providerSessionId}-destination-${index}`,
    };
    const sourceReceipt = bindSessionRow({
      db,
      authority,
      target: source,
      policyIdentity: POLICY,
    });
    bindSessionRow({ db, authority, target: destination, policyIdentity: POLICY });

    const destinationWhere = target.kind === 'legacy'
      ? 'session_key = ?'
      : 'session_key = ? AND namespace = ?';
    const destinationArgs = target.kind === 'legacy'
      ? [destination.sessionKey]
      : [destination.sessionKey, destination.namespace];
    const idColumn = target.kind === 'legacy' ? 'claude_session_id' : 'provider_session_id';
    db.raw.prepare(`
      UPDATE ${table}
         SET ${idColumn} = ?, memory_identity = ?, memory_session_receipt = ?
       WHERE ${destinationWhere}
    `).run(source.providerSessionId, POLICY, sourceReceipt, ...destinationArgs);

    const copied = resolveResumeWithReceipt({
      db,
      authority,
      target: destination,
      policyIdentity: POLICY,
    });
    assert.equal(copied.action, 'fresh');
    assert.equal(copied.reason, 'receipt-rejected');
  }
});

test('standalone gate applies every tamper from a separate same-uid process', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '../scripts/spikes/memory-session-receipts/run-gate.js')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split('\n').at(-1);
  const evidence = JSON.parse(line);
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.same_uid_child, true);
  assert.deepEqual(evidence.tables, ['sessions', 'agent_runtime_sessions']);
  assert.ok(Object.values(evidence.checks).every(Boolean));
});

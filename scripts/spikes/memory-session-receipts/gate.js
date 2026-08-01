const crypto = require('node:crypto');

const RECEIPT_RE = /^[A-Za-z0-9_-]{43}$/;
const TUPLE_FIELDS = [
  'sessionKey',
  'providerNamespace',
  'providerSessionId',
  'policyIdentity',
];

function exactTuple(tuple) {
  const normalized = {};
  for (const field of TUPLE_FIELDS) {
    if (typeof tuple?.[field] !== 'string' || tuple[field].length === 0) {
      throw new TypeError(`session receipt tuple ${field} must be non-empty text`);
    }
    normalized[field] = tuple[field];
  }
  return normalized;
}

function tuplesEqual(left, right) {
  return TUPLE_FIELDS.every((field) => left[field] === right[field]);
}

class ProtectedReceiptAuthority {
  #bindings = new Map();
  #currentByLogicalSession = new Map();

  bind(tuple) {
    const binding = exactTuple(tuple);
    const logicalSession = `${binding.sessionKey}\u0000${binding.providerNamespace}`;
    const previous = this.#currentByLogicalSession.get(logicalSession);
    if (previous) this.#bindings.delete(previous);
    const receipt = crypto.randomBytes(32).toString('base64url');
    this.#bindings.set(receipt, binding);
    this.#currentByLogicalSession.set(logicalSession, receipt);
    return receipt;
  }

  verify(receipt, tuple) {
    if (typeof receipt !== 'string' || !RECEIPT_RE.test(receipt)) return false;
    const binding = this.#bindings.get(receipt);
    if (!binding) return false;
    return tuplesEqual(binding, exactTuple(tuple));
  }
}

function ensureColumn(raw, table, column, declaration) {
  const columns = raw.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((candidate) => candidate.name === column)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

function ensureReceiptColumns(raw) {
  for (const table of ['sessions', 'agent_runtime_sessions']) {
    ensureColumn(raw, table, 'memory_identity', 'TEXT');
    ensureColumn(raw, table, 'memory_session_receipt', 'TEXT');
  }
}

function validateTarget(target) {
  if (!['legacy', 'provider'].includes(target?.kind)) {
    throw new TypeError('receipt gate target kind is invalid');
  }
  for (const field of ['sessionKey', 'namespace', 'providerSessionId']) {
    if (typeof target[field] !== 'string' || target[field].length === 0) {
      throw new TypeError(`receipt gate target ${field} must be non-empty text`);
    }
  }
  if (target.kind === 'legacy' && !target.namespace.startsWith('claude:')) {
    throw new TypeError('legacy receipt gate target must use a Claude namespace');
  }
  if (target.kind === 'provider' && target.namespace !== 'codex:app-server') {
    throw new TypeError('provider receipt gate target must use the Codex namespace');
  }
  return target;
}

function tupleFor(target, providerSessionId, policyIdentity) {
  return exactTuple({
    sessionKey: target.sessionKey,
    providerNamespace: target.namespace,
    providerSessionId,
    policyIdentity,
  });
}

function bindSessionRow({ db, authority, target: candidate, policyIdentity }) {
  const target = validateTarget(candidate);
  const tuple = tupleFor(target, target.providerSessionId, policyIdentity);
  const receipt = authority.bind(tuple);

  if (target.kind === 'legacy') {
    db.upsertSession({
      session_key: target.sessionKey,
      chat_id: target.sessionKey,
      claude_session_id: target.providerSessionId,
      agent: 'sanitized-gate',
      cwd: '/sanitized/gate',
      pm_backend: target.namespace === 'claude:channels' ? 'cli' : 'sdk',
    });
    db.raw.prepare(`
      UPDATE sessions
         SET memory_identity = ?, memory_session_receipt = ?
       WHERE session_key = ?
    `).run(policyIdentity, receipt, target.sessionKey);
  } else {
    db.upsertProviderSession({
      session_key: target.sessionKey,
      namespace: target.namespace,
      provider: 'codex',
      provider_session_id: target.providerSessionId,
      cwd: '/sanitized/gate',
    });
    db.raw.prepare(`
      UPDATE agent_runtime_sessions
         SET memory_identity = ?, memory_session_receipt = ?
       WHERE session_key = ? AND namespace = ?
    `).run(policyIdentity, receipt, target.sessionKey, target.namespace);
  }
  return receipt;
}

function readTarget(db, target) {
  if (target.kind === 'legacy') {
    return db.raw.prepare(`
      SELECT claude_session_id AS provider_session_id,
             memory_identity, memory_session_receipt
        FROM sessions
       WHERE session_key = ?
    `).get(target.sessionKey);
  }
  return db.raw.prepare(`
    SELECT provider_session_id, memory_identity, memory_session_receipt
      FROM agent_runtime_sessions
     WHERE session_key = ? AND namespace = ?
  `).get(target.sessionKey, target.namespace);
}

function clearTarget(db, target) {
  if (target.kind === 'legacy') {
    db.clearSessionId(target.sessionKey);
  } else {
    db.clearProviderSession(target.sessionKey, target.namespace);
  }
}

function resolveResumeWithReceipt({
  db,
  authority,
  target: candidate,
  policyIdentity,
}) {
  const target = validateTarget(candidate);
  const row = readTarget(db, target);
  if (!row || typeof row.provider_session_id !== 'string' || !row.provider_session_id) {
    return { action: 'fresh', reason: 'absent' };
  }

  let reason = null;
  if (typeof row.memory_session_receipt !== 'string' || !row.memory_session_receipt) {
    reason = 'missing-receipt';
  } else if (row.memory_identity !== policyIdentity) {
    reason = 'identity-mismatch';
  } else if (!authority.verify(
    row.memory_session_receipt,
    tupleFor(target, row.provider_session_id, policyIdentity),
  )) {
    reason = 'receipt-rejected';
  }

  if (reason !== null) {
    clearTarget(db, target);
    return { action: 'fresh', reason };
  }
  return {
    action: 'resume',
    providerSessionId: row.provider_session_id,
  };
}

module.exports = {
  ProtectedReceiptAuthority,
  ensureReceiptColumns,
  bindSessionRow,
  resolveResumeWithReceipt,
};

#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const dbPath = process.argv[2];
if (!dbPath || !path.isAbsolute(dbPath)) fail('database path must be absolute');

const input = fs.readFileSync(0, 'utf8');
if (Buffer.byteLength(input) > 16_384) fail('tamper payload exceeds limit');

let payload;
try {
  payload = JSON.parse(input);
} catch {
  fail('tamper payload must be JSON');
}

if (!['legacy', 'provider'].includes(payload?.kind)) fail('invalid target kind');
if (typeof payload.sessionKey !== 'string' || !payload.sessionKey) fail('invalid session key');
if (payload.kind === 'provider' && (
  typeof payload.namespace !== 'string' || !payload.namespace
)) fail('invalid provider namespace');

const allowedChanges = new Set(['providerSessionId', 'memoryIdentity', 'receipt']);
const changes = Object.entries(payload.changes || {});
if (
  changes.length === 0
  || changes.some(([key]) => !allowedChanges.has(key))
) fail('invalid tamper changes');

const columnFor = {
  providerSessionId: payload.kind === 'legacy' ? 'claude_session_id' : 'provider_session_id',
  memoryIdentity: 'memory_identity',
  receipt: 'memory_session_receipt',
};
const assignments = changes.map(([key]) => `${columnFor[key]} = ?`).join(', ');
const values = changes.map(([, value]) => value);
const table = payload.kind === 'legacy' ? 'sessions' : 'agent_runtime_sessions';
const where = payload.kind === 'legacy'
  ? 'session_key = ?'
  : 'session_key = ? AND namespace = ?';
const whereValues = payload.kind === 'legacy'
  ? [payload.sessionKey]
  : [payload.sessionKey, payload.namespace];

const db = new Database(dbPath);
try {
  const result = db.prepare(`UPDATE ${table} SET ${assignments} WHERE ${where}`)
    .run(...values, ...whereValues);
  if (result.changes !== 1) fail('tamper target must resolve to exactly one row');
} finally {
  db.close();
}

if (typeof process.getuid !== 'function' || !Number.isInteger(process.getuid())) {
  fail('numeric uid is unavailable');
}
process.stdout.write(JSON.stringify({
  ok: true,
  uid: process.getuid(),
}) + '\n');

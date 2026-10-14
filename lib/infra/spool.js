'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { sanitizeDurableStructured } = require('../secret-detect');

function checkPath(directory) {
  const parts = path.resolve(directory).split(path.sep);
  let current = path.parse(directory).root;
  for (const part of parts.filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Spool symlink path rejected: ${current}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function checkOwner(filename, directory = false) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw new Error(`Spool symlink rejected: ${filename}`);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Invalid spool path: ${filename}`);
  if (stat.uid !== process.getuid()) throw new Error(`Spool must belong to the current user: ${filename}`);
  if ((stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
    throw new Error(`Spool requires owner-only permissions: ${filename}`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid spool drainer owner');
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    // Uncertain ownership must never authorize another concurrent sender.
    if (err.code === 'EPERM') return true;
    throw err;
  }
}

function createSpool({ directory, maxEvents = 1000, maxBytes = 8 * 1024 * 1024 }) {
  if (typeof directory !== 'string' || !directory) throw new Error('Spool directory is required');
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Spool capacity limits must be positive integers');
  }
  directory = path.resolve(directory);
  checkPath(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkOwner(directory, true);
  const filename = path.join(directory, 'spool.sqlite');
  try {
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  function open() {
    checkPath(directory);
    checkOwner(directory, true);
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { checkOwner(`${filename}${suffix}`); } catch (err) {
        if (err.code !== 'ENOENT' || suffix === '') throw err;
      }
    }
    const db = new Database(filename, { fileMustExist: true, timeout: 5000 });
    try {
      db.pragma('synchronous = FULL');
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  function withDb(fn) {
    const db = open();
    try { return fn(db); } finally { db.close(); }
  }

  withDb((db) => db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drainer (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pid INTEGER NOT NULL,
      token TEXT NOT NULL
    );
  `));
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }

  function enqueue(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || ['eventId', 'source', 'host'].some((key) => typeof event[key] !== 'string' || !event[key])) {
      throw new Error('Spool event requires eventId, source and host strings');
    }
    const id = createHash('sha256').update(JSON.stringify([event.source, event.host, event.eventId])).digest('hex');
    const sanitized = sanitizeDurableStructured(event);
    if (['eventId', 'source', 'host'].some((key) => typeof sanitized[key] !== 'string' || !sanitized[key])) {
      throw new Error('Spool event identity must survive durable sanitization');
    }
    const payload = JSON.stringify(canonical(sanitized));
    const bytes = Buffer.byteLength(payload);
    return withDb((db) => db.transaction(() => {
      const existing = db.prepare('SELECT payload FROM events WHERE id = ?').get(id);
      if (existing) {
        if (existing.payload !== payload) throw new Error('Spool event identity conflict');
        return { id };
      }
      const usage = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM events').get();
      if (usage.count >= maxEvents || usage.bytes + bytes > maxBytes) {
        const error = new Error('Spool capacity limit exceeded; event not accepted');
        error.code = 'INFRA_SPOOL_FULL';
        throw error;
      }
      db.prepare('INSERT INTO events (id, payload, bytes) VALUES (?, ?, ?)').run(id, payload, bytes);
      return { id };
    }).immediate());
  }

  async function drain(send) {
    if (typeof send !== 'function') throw new Error('Spool drain requires a sender');
    const token = randomUUID();
    const claimed = withDb((db) => db.transaction(() => {
      const owner = db.prepare('SELECT pid, token FROM drainer WHERE singleton = 1').get();
      if (owner && processAlive(owner.pid)) return false;
      db.prepare('INSERT OR REPLACE INTO drainer (singleton, pid, token) VALUES (1, ?, ?)').run(process.pid, token);
      return true;
    }).immediate());
    const pending = () => withDb((db) => db.prepare('SELECT COUNT(*) AS count FROM events').get().count);
    if (!claimed) return { sent: 0, pending: pending() };
    let sent = 0;
    try {
      const rows = withDb((db) => db.prepare('SELECT id, payload, bytes FROM events ORDER BY rowid').all());
      for (const row of rows) {
        let event;
        try { event = JSON.parse(row.payload); } catch { throw new Error(`Invalid spool event JSON: ${row.id}`); }
        if (!event || typeof event !== 'object' || Array.isArray(event)
          || ['eventId', 'source', 'host'].some((key) => typeof event[key] !== 'string' || !event[key])
          || row.bytes !== Buffer.byteLength(row.payload)) {
          throw new Error(`Invalid spool event: ${row.id}`);
        }
        const receipt = await send(event);
        if (receipt?.ok !== true) break;
        withDb((db) => db.transaction(() => {
          const owner = db.prepare('SELECT token FROM drainer WHERE singleton = 1').get();
          if (owner?.token !== token) throw new Error('Spool drainer ownership lost; event retained');
          db.prepare('DELETE FROM events WHERE id = ? AND payload = ?').run(row.id, row.payload);
        }).immediate());
        sent += 1;
      }
      return { sent, pending: pending() };
    } finally {
      withDb((db) => db.prepare('DELETE FROM drainer WHERE singleton = 1 AND token = ?').run(token));
    }
  }

  return { enqueue, drain };
}

module.exports = { createSpool };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { collectNetdata } = require('./netdata');
const { sanitizeDurableStructured } = require('../secret-detect');
const execute = promisify(execFile);

function validateHost(host) {
  if (!host || typeof host.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(host.name)) throw new Error('Invalid Netdata host name');
  if (host.ssh !== undefined && (typeof host.ssh !== 'string' || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host.ssh))) {
    throw new Error('Invalid SSH target');
  }
}

async function readNetdataHost(host, previous, executeImpl = execute) {
  validateHost(host);
  const cursor = previous?.cursor;
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error('Invalid Netdata cursor');
  async function read(endpoint) {
    const url = `http://127.0.0.1:19999/api/v1/${endpoint}`;
    const args = ['--fail', '--silent', '--show-error', '--max-time', '10', '--max-filesize', '4194304', url];
    const command = host.ssh ? 'ssh' : 'curl';
    const commandArgs = host.ssh
      ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '--', host.ssh,
        `curl --fail --silent --show-error --max-time 10 --max-filesize 4194304 '${url}'`]
      : args;
    const { stdout } = await executeImpl(command, commandArgs, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(stdout);
  }
  // The snapshot is read first: events after its cursor belong to the next cycle.
  const snapshot = await read('alarms?all');
  let log = [];
  if (previous?.seeded) {
    const reset = snapshot.latest_alarm_log_unique_id < (previous.snapshotCursor ?? cursor)
      || (previous.cursorEpoch ?? previous.epoch) !== previous.epoch;
    // Include the cursor itself to prove continuity. A reset invalidates the old epoch's cursor.
    const after = reset ? 0 : Math.max(0, (cursor || 0) - 1);
    try { log = await read(`alarm_log?after=${after}`); } catch { log = null; }
  }
  return { snapshot, log };
}

function checkPath(filename, directory = false) {
  let current = path.parse(filename).root;
  for (const segment of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Collector symlink path rejected');
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  const stat = fs.lstatSync(filename);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Collector state requires owner-only permissions');
}

function openState(statePath) {
  const filename = path.resolve(statePath);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkPath(directory, true);
  try {
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
  } catch (err) { if (err.code !== 'EEXIST') throw err; }
  checkPath(filename);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { checkPath(filename + suffix); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  const db = new Database(filename, { fileMustExist: true, timeout: 5000 });
  try {
    db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS collector_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), accepted TEXT NOT NULL, pending TEXT);
      INSERT OR IGNORE INTO collector_state(singleton,accepted) VALUES(1,'{}');
      CREATE TABLE IF NOT EXISTS collector_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL);`);
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return db;
  } catch (err) { db.close(); throw err; }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid collector owner');
  try { process.kill(pid, 0); return true; } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true;
    throw err;
  }
}

/** Persist a complete collection cycle before transport; commit cursors only after intake acceptance. */
async function runCollector({ config, statePath, spool, send, readHost = readNetdataHost, now = Date.now }) {
  if (!config || !Array.isArray(config.hosts) || !config.hosts.length || config.hosts.length > 100) throw new Error('Collector hosts are required (maximum 100)');
  config.hosts.forEach(validateHost);
  if (new Set(config.hosts.map((host) => host.name)).size !== config.hosts.length) throw new Error('Duplicate collector host');
  if (typeof send !== 'function' || !spool?.enqueue || !spool?.drain) throw new Error('Collector requires spool and sender');
  const db = openState(statePath);
  const token = randomUUID();
  const claimed = db.transaction(() => {
    const owner = db.prepare('SELECT * FROM collector_owner WHERE singleton=1').get();
    if (owner && processAlive(owner.pid)) return false;
    db.prepare('INSERT OR REPLACE INTO collector_owner VALUES(1,?,?)').run(process.pid, token);
    return true;
  }).immediate();
  if (!claimed) { db.close(); return { busy: true, events: 0 }; }
  try {
    const row = db.prepare('SELECT * FROM collector_state WHERE singleton=1').get();
    let cycle = row.pending ? JSON.parse(row.pending) : null;
    if (!cycle) {
      const states = JSON.parse(row.accepted);
      const events = [];
      for (const host of config.hosts) {
        const previous = Object.hasOwn(states, host.name) ? states[host.name] : undefined;
        let observation;
        try { observation = await readHost(host, previous); } catch { observation = { snapshot: null, log: [] }; }
        const collected = collectNetdata({ host: host.name, previous, ...observation, now: now() });
        states[host.name] = collected.state;
        events.push(...collected.events);
      }
      cycle = sanitizeDurableStructured({ states, events });
      // Freezes observation times and identities even if an ACK arrives just before a crash.
      db.prepare('UPDATE collector_state SET pending=? WHERE singleton=1').run(JSON.stringify(cycle));
    }
    const durableSend = async (event) => {
      const receipt = await send(event);
      return { ok: receipt?.ok === true && receipt?.accepted === true };
    };
    let sent = 0;
    for (const event of cycle.events) {
      try { spool.enqueue(event); } catch (err) {
        if (err.code !== 'INFRA_SPOOL_FULL') throw err;
        // The frozen cycle can exceed transport capacity. Free only acknowledged
        // entries, then retry this event while keeping the whole source cycle.
        const drained = await spool.drain(durableSend);
        sent += drained.sent;
        if (drained.pending > 0) return { events: cycle.events.length, sent, pending: drained.pending };
        spool.enqueue(event);
      }
    }
    const result = await spool.drain(durableSend);
    sent += result.sent;
    if (result.pending === 0) {
      db.transaction(() => {
        if (db.prepare('SELECT token FROM collector_owner WHERE singleton=1').get()?.token !== token) throw new Error('Collector ownership lost');
        db.prepare('UPDATE collector_state SET accepted=?,pending=NULL WHERE singleton=1').run(JSON.stringify(cycle.states));
      }).immediate();
    }
    return { events: cycle.events.length, sent, pending: result.pending };
  } finally {
    try { db.prepare('DELETE FROM collector_owner WHERE singleton=1 AND token=?').run(token); } finally { db.close(); }
  }
}

module.exports = { runCollector, readNetdataHost };

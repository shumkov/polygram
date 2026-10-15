'use strict';

const { createHash } = require('node:crypto');
const { sanitizeDurableStructured } = require('../secret-detect');

function boundedText(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}
function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new Error('JSON content required');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('JSON object required');
  seen.add(value);
  const encoded = Array.isArray(value)
    ? '[' + Array.from(value, (item) => canonical(item, seen)).join(',') + ']'
    : '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key], seen)).join(',') + '}';
  seen.delete(value);
  return encoded;
}
function validateIdentity(input) {
  boundedText(input?.routeId, 'route ID'); boundedText(input?.requestId, 'request ID');
}
function validateSubmission(input) {
  validateIdentity(input);
  for (const key of Object.keys(input)) if (!['routeId', 'requestId', 'task', 'payload'].includes(key)) throw new Error(`Unknown job field: ${key}`);
  boundedText(input.task, 'task', 32768);
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('Payload object required');
  const content = canonical({ task: input.task, payload: input.payload });
  if (Buffer.byteLength(content) > 32768) throw new Error('Job exceeds size limit');
  return { hash: createHash('sha256').update(content).digest('hex'), clean: sanitizeDurableStructured(JSON.parse(content)) };
}
function validateTarget(target) {
  if (!target || !['string', 'number'].includes(typeof target.chatId)) throw new Error('Invalid destination');
  boundedText(String(target.chatId), 'chat ID');
  if (target.threadId != null) boundedText(String(target.threadId), 'thread ID');
  boundedText(target.sessionKey, 'session key', 500);
  return { chatId: target.chatId, threadId: target.threadId ?? null, sessionKey: target.sessionKey };
}
const cleanError = (value) => value == null ? null : sanitizeDurableStructured({ error: String(value).slice(0, 2000) }).error;

function createExternalJobStore(db, { botName, now = Date.now }) {
  boundedText(botName, 'bot');
  const transaction = (fn) => db.transaction(fn).immediate();
  const rowById = (id) => db.prepare('SELECT * FROM external_jobs WHERE id=? AND bot_name=?').get(id, botName);
  const paused = (sessionKey) => !!db.prepare('SELECT paused FROM external_job_controls WHERE bot_name=? AND session_key=?').get(botName, sessionKey)?.paused;
  const wire = (row) => row ? {
    id: row.id, routeId: row.route_id, requestId: row.request_id, state: row.state,
    reportState: row.report_state, turnId: row.turn_id,
    reportReceipt: row.report_receipt ? JSON.parse(row.report_receipt) : null,
    error: row.error, inactive: !!row.inactive, paused: paused(row.session_key),
  } : null;
  const work = (row) => row ? { ...wire(row), task: row.task, payload: JSON.parse(row.payload), target: JSON.parse(row.target) } : null;
  const partRows = (id) => db.prepare(`SELECT p.* FROM external_job_report_parts p JOIN external_jobs j ON j.id=p.job_id
    WHERE j.bot_name=? AND j.id=? ORDER BY p.part_index`).all(botName, id);
  function refreshReport(id) {
    const parts = partRows(id);
    const state = parts.some((p) => p.state === 'unknown') ? 'unknown'
      : parts.every((p) => p.state === 'delivered') ? 'delivered' : 'pending';
    const receipts = parts.filter((p) => p.receipt).map((p) => ({ partId: p.id, index: p.part_index, receipt: JSON.parse(p.receipt) }));
    db.prepare('UPDATE external_jobs SET report_state=?,report_receipt=?,updated_at=? WHERE id=? AND bot_name=?')
      .run(state, JSON.stringify({ parts: receipts }), now(), id, botName);
  }
  return {
    submit(input, target, maxPending = 1000) {
      const { hash, clean } = validateSubmission(input);
      return transaction(() => {
        const old = db.prepare('SELECT * FROM external_jobs WHERE bot_name=? AND route_id=? AND request_id=?').get(botName, input.routeId, input.requestId);
        if (old) {
          if (old.content_hash !== hash) throw new Error('Job identity conflict');
          return { accepted: true, duplicate: true, job: wire(old) };
        }
        const frozen = validateTarget(target);
        if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('Invalid queue capacity');
        const pending = db.prepare("SELECT count(*) n FROM external_jobs WHERE bot_name=? AND (state IN ('queued','running') OR report_state='pending')").get(botName).n;
        if (pending >= maxPending) throw new Error('External job queue full');
        const inserted = db.prepare(`INSERT INTO external_jobs(bot_name,route_id,request_id,content_hash,task,payload,target,session_key,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(botName, input.routeId, input.requestId, hash, clean.task, JSON.stringify(clean.payload), JSON.stringify(frozen), frozen.sessionKey, now(), now());
        return { accepted: true, duplicate: false, job: wire(rowById(Number(inserted.lastInsertRowid))) };
      });
    },
    existing(input) {
      validateIdentity(input);
      return wire(db.prepare('SELECT * FROM external_jobs WHERE bot_name=? AND route_id=? AND request_id=?').get(botName, input.routeId, input.requestId));
    },
    get(input) { const job = this.existing(input); if (!job) throw new Error('External job not found'); return job; },
    work(id) { return work(rowById(id)); },
    queued() { return db.prepare("SELECT id,route_id,target FROM external_jobs WHERE bot_name=? AND state='queued' ORDER BY id").all(botName).map((row) => ({ id: row.id, routeId: row.route_id, target: JSON.parse(row.target) })); },
    isPaused: paused,
    unsettled() { return db.prepare("SELECT * FROM external_jobs WHERE bot_name=? AND state!='queued' AND inactive=0 ORDER BY id").all(botName).map(work); },
    reports() { return db.prepare("SELECT * FROM external_jobs WHERE bot_name=? AND report_state='pending' ORDER BY id").all(botName).map(work); },
    status(sessionKey) {
      const counts = db.prepare(`SELECT sum(state='queued') pending,sum(state='running') running FROM external_jobs WHERE bot_name=? AND session_key=?`).get(botName, sessionKey);
      return { enabled: true, paused: paused(sessionKey), pending: counts.pending || 0, running: counts.running || 0 };
    },
    pauseSession(sessionKey, value) {
      boundedText(sessionKey, 'session key', 500);
      if (typeof value !== 'boolean') throw new Error('Boolean pause required');
      db.prepare(`INSERT INTO external_job_controls(bot_name,session_key,paused,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(bot_name,session_key) DO UPDATE SET paused=excluded.paused,updated_at=excluded.updated_at`).run(botName, sessionKey, Number(value), now());
      return this.status(sessionKey);
    },
    claim(id) {
      return transaction(() => {
        const row = rowById(id);
        if (!row || row.state !== 'queued' || paused(row.session_key)) return null;
        if (db.prepare("SELECT 1 FROM external_jobs WHERE bot_name=? AND session_key=? AND state!='queued' AND inactive=0 LIMIT 1").get(botName, row.session_key)) {
          db.prepare('UPDATE external_jobs SET error=?,updated_at=? WHERE id=?').run('Previous turn inactivity is not confirmed', now(), id);
          return null;
        }
        db.prepare("UPDATE external_jobs SET state='running',error=NULL,updated_at=? WHERE id=?").run(now(), id);
        return work(rowById(id));
      });
    },
    hold(id, reason) { db.prepare("UPDATE external_jobs SET error=?,updated_at=? WHERE id=? AND bot_name=? AND state='queued'").run(cleanError(reason), now(), id, botName); },
    holdReport(id, reason) { db.prepare("UPDATE external_jobs SET error=?,updated_at=? WHERE id=? AND bot_name=? AND report_state='pending'").run(cleanError(reason), now(), id, botName); },
    defer(id, reason) { db.prepare("UPDATE external_jobs SET state='queued',error=?,updated_at=? WHERE id=? AND bot_name=? AND state='running' AND turn_id IS NULL").run(cleanError(reason), now(), id, botName); },
    setTurnId(id, turnId) {
      boundedText(turnId, 'turn ID', 500);
      const row = rowById(id);
      if (!row || row.state !== 'running' || (row.turn_id && row.turn_id !== turnId)) throw new Error('Invalid turn identity transition');
      db.prepare('UPDATE external_jobs SET turn_id=?,updated_at=? WHERE id=? AND bot_name=?').run(turnId, now(), id, botName);
    },
    setInactive(id) { db.prepare("UPDATE external_jobs SET inactive=1,updated_at=? WHERE id=? AND bot_name=? AND state NOT IN ('queued','running')").run(now(), id, botName); },
    finish(id, result, parts = []) {
      if (!['succeeded', 'failed', 'interrupted', 'unknown'].includes(result.outcome)) throw new Error('Invalid job outcome');
      if (!Array.isArray(parts) || parts.length > 100 || parts.some((part) => typeof part !== 'string' || !part.trim()) || Buffer.byteLength(JSON.stringify(parts)) > 65536) throw new Error('Invalid report size or parts');
      return transaction(() => {
        const row = rowById(id);
        if (!row || row.state !== 'running') throw new Error('Job is not running');
        const reportState = result.reportError || result.channelsAcknowledged ? 'unknown' : parts.length ? 'pending' : result.outcome === 'succeeded' ? 'unknown' : 'none';
        db.prepare('UPDATE external_jobs SET state=?,report_state=?,inactive=?,error=?,report_receipt=?,updated_at=? WHERE id=?')
          .run(result.outcome, reportState, Number(result.inactive === true), cleanError(result.reportError || result.error), result.channelsAcknowledged ? JSON.stringify({ channelsAcknowledged: true, turnId: row.turn_id }) : null, now(), id);
        if (!result.channelsAcknowledged) for (const [index, text] of parts.entries()) {
          db.prepare('INSERT INTO external_job_report_parts(job_id,part_index,text) VALUES (?,?,?)').run(id, index, sanitizeDurableStructured({ text }).text);
        }
        return wire(rowById(id));
      });
    },
    parts(id) { return partRows(id).map((p) => ({ id: p.id, index: p.part_index, text: p.text, state: p.state, retryAt: p.retry_at })); },
    beginPart(id) {
      return transaction(() => {
        const part = db.prepare(`SELECT p.*,j.report_state FROM external_job_report_parts p JOIN external_jobs j ON j.id=p.job_id WHERE p.id=? AND j.bot_name=?`).get(id, botName);
        if (!part || part.state !== 'pending' || part.retry_at > now() || part.report_state !== 'pending') return false;
        db.prepare("UPDATE external_job_report_parts SET state='sending' WHERE id=?").run(id);
        return true;
      });
    },
    completePart(id, receipt) {
      if (receipt == null || Buffer.byteLength(JSON.stringify(receipt)) > 16384) throw new Error('Delivery receipt required within size limit');
      transaction(() => {
        const part = db.prepare(`SELECT p.* FROM external_job_report_parts p JOIN external_jobs j ON j.id=p.job_id WHERE p.id=? AND j.bot_name=?`).get(id, botName);
        if (!part || part.state !== 'sending') throw new Error('Report part is not sending');
        db.prepare("UPDATE external_job_report_parts SET state='delivered',receipt=?,error=NULL WHERE id=?").run(JSON.stringify(sanitizeDurableStructured(receipt)), id);
        refreshReport(part.job_id);
      });
    },
    failPart(id, error) {
      transaction(() => {
        const part = db.prepare(`SELECT p.* FROM external_job_report_parts p JOIN external_jobs j ON j.id=p.job_id WHERE p.id=? AND j.bot_name=?`).get(id, botName);
        if (!part || part.state !== 'sending') return;
        db.prepare('UPDATE external_job_report_parts SET state=?,error=?,retry_at=? WHERE id=?')
          .run(error?.definitelyNotSent === true ? 'pending' : 'unknown', cleanError(error?.message || error), now() + 60000, id);
        refreshReport(part.job_id);
        db.prepare('UPDATE external_jobs SET error=? WHERE id=?').run(cleanError(error?.message || error), part.job_id);
      });
    },
    recover() {
      transaction(() => {
        db.prepare("UPDATE external_jobs SET state='unknown',inactive=0,error='Daemon stopped before execution outcome was recorded',updated_at=? WHERE bot_name=? AND state='running'").run(now(), botName);
        const affected = db.prepare(`SELECT DISTINCT j.id FROM external_jobs j JOIN external_job_report_parts p ON p.job_id=j.id WHERE j.bot_name=? AND p.state='sending'`).all(botName);
        db.prepare("UPDATE external_job_report_parts SET state='unknown',error='Daemon stopped during delivery' WHERE state='sending' AND job_id IN (SELECT id FROM external_jobs WHERE bot_name=?)").run(botName);
        for (const row of affected) refreshReport(row.id);
      });
    },
  };
}

module.exports = { createExternalJobStore };

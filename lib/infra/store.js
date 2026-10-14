'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { sanitizeDurableStructured } = require('../secret-detect');

const STATES = new Set(['WARNING', 'CRITICAL', 'CLEAR', 'UNKNOWN']);
const WORKFLOW = new Set(['open', 'investigating', 'awaiting_approval', 'verifying', 'resolved', 'blocked']);
const FIELDS = new Set(['source', 'host', 'eventId', 'resource', 'state', 'observedAt', 'evidence']);
function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}
function validateEvent(event, route) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Event object required');
  for (const key of Object.keys(event)) if (!FIELDS.has(key)) throw new Error(`Unknown event field: ${key}`);
  for (const key of ['source', 'host', 'eventId', 'resource']) text(event[key], key);
  if (!route?.enabled || !route.sources?.[event.source]?.hosts?.includes(event.host)) throw new Error('Event source/host is not enabled');
  if (!STATES.has(event.state)) throw new Error('Invalid event state');
  if (!Number.isSafeInteger(event.observedAt) || event.observedAt < 0) throw new Error('Invalid observation time');
  if (!event.evidence || typeof event.evidence !== 'object' || Array.isArray(event.evidence)) throw new Error('Evidence object required');
  if (Buffer.byteLength(JSON.stringify(event)) > 16384) throw new Error('Event exceeds size limit');
  return sanitizeDurableStructured(event);
}
function createInfraStore(db, { botName, route, now = Date.now }) {
  text(botName, 'bot');
  const transaction = (fn) => db.transaction(fn).immediate();
  const getRow = (id) => db.prepare('SELECT * FROM infra_incidents WHERE id=? AND bot_name=?').get(id, botName);
  const control = () => db.prepare('SELECT * FROM infra_controls WHERE bot_name=?').get(botName);
  db.prepare('INSERT OR IGNORE INTO infra_controls(bot_name, updated_at) VALUES (?,?)').run(botName, now());
  const decode = (row) => row ? { ...row, evidence: JSON.parse(row.evidence) } : null;
  const claimRows = (token) => db.prepare('SELECT * FROM infra_incidents WHERE active_claim=? AND bot_name=?').all(token, botName);

  return {
    ingest(input) {
      const event = validateEvent(input, route);
      const payload = JSON.stringify(event);
      return transaction(() => {
        const old = db.prepare('SELECT * FROM external_events WHERE bot_name=? AND source=? AND host=? AND source_event_id=?')
          .get(botName, event.source, event.host, event.eventId);
        if (old) {
          if (old.payload !== payload) throw new Error('Event identity conflict');
          return { accepted: true, duplicate: true, receiptId: old.id, incidentId: old.incident_id };
        }
        const count = db.prepare("SELECT count(*) n FROM external_events WHERE bot_name=? AND delivery!='delivered'").get(botName).n;
        if (count >= (route.maxPending || 10000)) throw new Error('Infra queue full; retain source event');
        const id = createHash('sha256').update(JSON.stringify([botName, event.source, event.host, event.resource])).digest('hex');
        const row = getRow(id);
        if (!row) {
          db.prepare(`INSERT INTO infra_incidents(id,bot_name,source,host,resource,latest_state,observed_at,evidence,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(id, botName, event.source, event.host, event.resource, event.state, event.observedAt, JSON.stringify(event.evidence), now());
        } else if (event.observedAt >= row.observed_at) {
          db.prepare(`UPDATE infra_incidents SET revision=revision+1, latest_state=?, observed_at=?, evidence=?,
            state=CASE WHEN state='resolved' AND ?!='CLEAR' THEN 'open' ELSE state END,
            verification=NULL, retry_at=0, updated_at=? WHERE id=?`)
            .run(event.state, event.observedAt, JSON.stringify(event.evidence), event.state, now(), id);
        } else {
          db.prepare('UPDATE infra_incidents SET revision=revision+1, updated_at=? WHERE id=?').run(now(), id);
        }
        const receipt = db.prepare(`INSERT INTO external_events(bot_name,source,host,source_event_id,incident_id,payload,received_at)
          VALUES (?,?,?,?,?,?,?)`).run(botName, event.source, event.host, event.eventId, id, payload, now());
        return { accepted: true, duplicate: false, receiptId: Number(receipt.lastInsertRowid), incidentId: id };
      });
    },
    list() {
      return db.prepare('SELECT * FROM infra_incidents WHERE bot_name=? ORDER BY updated_at DESC LIMIT 100').all(botName).map(decode);
    },
    get(id) {
      const row = getRow(id);
      if (!row) throw new Error('Incident not found');
      const events = db.prepare('SELECT payload,delivery,received_at,delivered_at,report_receipt FROM external_events WHERE incident_id=? ORDER BY id DESC LIMIT 100')
        .all(id).map(({ payload, ...rest }) => ({ ...JSON.parse(payload), ...rest }));
      return { ...decode(row), events };
    },
    update(input) {
      const allowed = new Set(['incidentId', 'revision', 'state', 'summary', 'verification', 'nextCheckAt']);
      for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown incident field: ${key}`);
      return transaction(() => {
        const row = getRow(input.incidentId);
        if (!row) throw new Error('Incident not found');
        if (input.revision !== row.revision) throw new Error('Incident revision conflict; read current incident');
        const state = input.state ?? row.state;
        if (!WORKFLOW.has(state)) throw new Error('Invalid incident state');
        if (input.summary != null) text(input.summary, 'summary', 4000);
        if (input.verification != null) text(input.verification, 'verification', 4000);
        if (state === 'resolved') {
          if (row.latest_state !== 'CLEAR' || JSON.parse(row.evidence).kind !== 'snapshot') throw new Error('Fresh healthy observation required');
          if (!input.verification) throw new Error('Recovery verification required');
        }
        let due = input.nextCheckAt === undefined ? row.next_check_at : input.nextCheckAt;
        if (due != null && (!Number.isSafeInteger(due) || due < now() || due > now() + 30 * 86400000)) throw new Error('Invalid next check time');
        if (state === 'resolved') due = null;
        const clean = sanitizeDurableStructured(input);
        db.prepare(`UPDATE infra_incidents SET revision=revision+1,state=?,summary=?,verification=?,next_check_at=?,updated_at=? WHERE id=?`)
          .run(state, clean.summary ?? row.summary, clean.verification ?? row.verification, due, now(), row.id);
        return decode(getRow(row.id));
      });
    },
    setPaused(paused) {
      if (typeof paused !== 'boolean') throw new Error('Boolean pause required');
      db.prepare('UPDATE infra_controls SET paused=?,updated_at=? WHERE bot_name=?').run(Number(paused), now(), botName);
      return this.status();
    },
    status() {
      return { ...control(), paused: !!control().paused, enabled: !!route?.enabled,
        pending: db.prepare("SELECT count(*) n FROM external_events WHERE bot_name=? AND delivery!='delivered'").get(botName).n };
    },
    tick() { db.prepare('UPDATE infra_controls SET last_tick_at=? WHERE bot_name=?').run(now(), botName); },
    claim() {
      return transaction(() => {
        if (!route?.enabled || control().paused) return null;
        const row = db.prepare(`SELECT i.* FROM infra_incidents i WHERE bot_name=? AND active_claim IS NULL AND retry_at<=?
          AND (EXISTS(SELECT 1 FROM external_events e WHERE e.incident_id=i.id AND e.delivery='pending')
          OR (state!='resolved' AND next_check_at<=?)) ORDER BY updated_at LIMIT 1`).get(botName, now(), now());
        if (!row) return null;
        const token = randomUUID();
        db.prepare("UPDATE external_events SET delivery='running',claim=? WHERE incident_id=? AND delivery='pending'").run(token, row.id);
        db.prepare('UPDATE infra_incidents SET active_claim=?,next_check_at=NULL WHERE id=?').run(token, row.id);
        const events = db.prepare('SELECT payload FROM external_events WHERE claim=? ORDER BY id').all(token).map((r) => JSON.parse(r.payload));
        return { token, incident: decode(row), events };
      });
    },
    complete(token, reportReceipt = null) {
      transaction(() => {
        for (const row of claimRows(token)) {
          db.prepare("UPDATE external_events SET delivery='delivered',delivered_at=?,report_receipt=? WHERE claim=? AND bot_name=?")
            .run(now(), reportReceipt ? JSON.stringify(sanitizeDurableStructured(reportReceipt)) : null, token, botName);
          db.prepare(`UPDATE infra_incidents SET active_claim=NULL,last_error=NULL,
            next_check_at=CASE WHEN state='resolved' THEN NULL ELSE coalesce(next_check_at,?) END WHERE id=?`)
            .run(now() + 30 * 60000, row.id);
        }
      });
    },
    fail(token, reason) {
      transaction(() => {
        const error = sanitizeDurableStructured({ error: String(reason).slice(0, 2000) }).error;
        for (const row of claimRows(token)) {
          db.prepare("UPDATE external_events SET delivery='pending',claim=NULL WHERE claim=? AND bot_name=?").run(token, botName);
          db.prepare('UPDATE infra_incidents SET active_claim=NULL,retry_at=?,next_check_at=?,last_error=? WHERE id=?')
            .run(now() + 60000, now() + 60000, error, row.id);
        }
      });
    },
    recover() {
      for (const row of db.prepare('SELECT active_claim FROM infra_incidents WHERE bot_name=? AND active_claim IS NOT NULL').all(botName)) {
        this.fail(row.active_claim, 'Previous daemon interrupted diagnosis; reconcile before any action');
      }
    },
  };
}

module.exports = { createInfraStore, validateEvent };

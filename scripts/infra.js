#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const ipc = require('../lib/ipc/client');
const { validateBotName } = require('../lib/ipc/runtime-directory');
const { validateEvent } = require('../lib/infra/store');
const { createSpool } = require('../lib/infra/spool');

const COMMANDS = new Set(['list', 'get', 'verify', 'observe', 'update', 'status', 'emit', 'drain', 'collect', 'notify']);
function parseArgs(argv) {
  const out = { dataDir: path.join(os.homedir(), '.polygram'), args: [] };
  const flags = { '--bot': 'bot', '--data-dir': 'dataDir', '--host': 'host', '--resource': 'resource', '--state': 'state', '--before': 'before' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags[arg]) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Value required for ${arg}`);
      out[flags[arg]] = value;
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (!out.command) out.command = arg;
    else out.args.push(arg);
  }
  if (!out.bot) throw new Error('--bot is required');
  validateBotName(out.bot);
  if (!COMMANDS.has(out.command)) throw new Error('Unknown command: list|get|verify|observe|update|status|emit|drain|collect|notify');
  if (['get', 'verify'].includes(out.command) ? out.args.length !== 1 : out.args.length !== 0) throw new Error('Unexpected command arguments; pass JSON/text on stdin');
  if (out.before !== undefined) {
    out.before = Number(out.before);
    if (!['list', 'get'].includes(out.command) || !Number.isSafeInteger(out.before) || out.before < 1) throw new Error('Invalid history cursor');
  }
  out.dataDir = path.resolve(out.dataDir);
  return out;
}
function incidentRequest(parsed, input) {
  switch (parsed.command) {
    case 'list': return { op: 'infra_incidents', payload: { action: 'list', ...(parsed.before === undefined ? {} : { before: parsed.before }) } };
    case 'get': return { op: 'infra_incidents', payload: { action: 'get', incidentId: parsed.args[0], ...(parsed.before === undefined ? {} : { before: parsed.before }) } };
    case 'status': return { op: 'infra_status', payload: {} };
    case 'update': {
      const update = JSON.parse(input);
      const allowed = new Set(['incidentId', 'revision', 'state', 'summary', 'verification', 'nextCheckAt']);
      if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Update object required');
      for (const key of Object.keys(update)) if (!allowed.has(key)) throw new Error(`Unknown update field ${key}`);
      return { op: 'infra_incidents', payload: { action: 'update', ...update } };
    }
    default: return null;
  }
}
async function readInput(stream = process.stdin, maxBytes = 16384) {
  let text = '';
  stream.setEncoding?.('utf8');
  for await (const part of stream) {
    text += part;
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Input exceeds size limit');
  }
  return text;
}
async function readNotification(stream = process.stdin) {
  let text = '';
  let truncated = false;
  stream.setEncoding?.('utf8');
  // The original notifier displays the first 3900 Unicode characters. Eight
  // thousand UTF-16 units retain that prefix even when every character is astral.
  for await (const part of stream) {
    const remaining = 8000 - text.length;
    if (part.length > remaining) truncated = true;
    text += part.slice(0, remaining);
  }
  return { text, truncated };
}
function maintenanceEvent(parsed, input, observedAt = Date.now(), truncated = false) {
  if (!['WARNING', 'CRITICAL', 'CLEAR', 'UNKNOWN'].includes(parsed.state)) throw new Error('Explicit maintenance --state required');
  return { source: 'maintenance', host: parsed.host, resource: parsed.resource,
    eventId: randomUUID(), state: parsed.state, observedAt,
    evidence: { kind: parsed.state === 'CLEAR' ? 'snapshot' : 'notification', summary: Array.from(input).slice(0, 1000).join(''), truncated: truncated || Array.from(input).length > 1000 } };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const notification = parsed.command === 'notify' ? await readNotification() : null;
  const input = notification ? notification.text : ['update', 'emit', 'observe'].includes(parsed.command) ? await readInput() : '';
  const options = { cwd: parsed.dataDir };
  const request = async (op, payload = {}) => {
    const secret = ipc.readSecret(parsed.bot, options);
    if (!secret) throw new Error('IPC authentication unavailable');
    const result = await ipc.call({ path: ipc.socketPathFor(parsed.bot, options), secret, op, payload, callTimeoutMs: 10000 });
    if (result.ok !== true) throw new Error(result.error || 'IPC request failed');
    return result;
  };
  const operation = incidentRequest(parsed, input);
  if (operation) return request(operation.op, operation.payload);

  const cfg = JSON.parse(fs.readFileSync(path.join(parsed.dataDir, 'config.json'), 'utf8'));
  const route = cfg.bots?.[parsed.bot]?.infraAdmin;
  if (!route?.enabled && parsed.command !== 'notify') throw new Error('Infrastructure automation is not enabled');
  if (parsed.command === 'observe') {
    const event = validateEvent({ eventId: randomUUID(), ...JSON.parse(input) }, route);
    return request('infra_observe', { event });
  }
  if (parsed.command === 'verify') {
    const { incident } = await request('infra_incidents', { action: 'get', incidentId: parsed.args[0] });
    const { verificationEvent } = require('../lib/infra/verify');
    const event = await verificationEvent(incident, route);
    await request('infra_observe', { event });
    return request('infra_incidents', { action: 'get', incidentId: incident.id });
  }
  const send = async (event) => {
    const result = await request('ingest_event', { event });
    if (result.accepted !== true) throw new Error('Intake did not acknowledge durable acceptance');
    return result;
  };
  // This path calls the existing notifier directly and never feeds its output
  // into event intake, including when intake itself is unavailable.
  const notify = async (message) => {
    if (!path.isAbsolute(route?.notificationCommand || '')) throw new Error('Absolute notificationCommand required');
    await execFile(route.notificationCommand, [message], {
      timeout: 20000, maxBuffer: 65536,
      env: { ...process.env, NOTIFY_THREAD_ID: String(route.threadId) },
    });
  };
  if (parsed.command === 'notify' && !route?.enabled) {
    await notify(input);
    return { notified: true, automation: false };
  }
  const stateDir = path.join(parsed.dataDir, 'infra', parsed.bot);
  const openSpool = () => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    return createSpool({ directory: path.join(stateDir, 'spool') });
  };
  const fallback = async () => {
    const file = path.join(stateDir, 'fallback-at');
    let last = 0;
    try { last = Number(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() - last < 5 * 60000) return;
    fs.writeFileSync(file, String(Date.now()), { mode: 0o600 });
    await notify('Infrastructure automation cannot complete collection/delivery. Alerts remain pending where durably accepted; check collector logs.');
  };
  if (parsed.command === 'notify') {
    if (!input.trim()) throw new Error('Notification text required on stdin');
    let error = null;
    try {
      const spool = openSpool();
      const event = validateEvent(maintenanceEvent(parsed, input, Date.now(), notification.truncated), route);
      spool.enqueue(event);
      await spool.drain(send);
    } catch (caught) { error = caught; }
    await notify(input + (error ? '\n[Automatic investigation delivery unavailable; check local logs.]' : ''));
    if (error) throw error;
    return { notified: true };
  }
  try {
    const spool = openSpool();
    if (parsed.command === 'emit') {
      const event = validateEvent(JSON.parse(input), route);
      const queued = spool.enqueue(event);
      const result = await spool.drain(send);
      return { queued, ...result };
    }
    if (parsed.command === 'drain') return await spool.drain(send);
    const { runCollector } = require('../lib/infra/collector');
    const result = await runCollector({ config: { hosts: route.hosts }, statePath: path.join(stateDir, 'collector.sqlite'), spool, send });
    await request('infra_tick');
    return result;
  } catch (error) {
    try { await fallback(); } catch (fallbackError) { console.error(`infra notification failure: ${fallbackError.code || fallbackError.name}`); }
    throw error;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(`polygram-infra: ${error.message}`); process.exitCode = 1; });
}
module.exports = { parseArgs, incidentRequest, readInput, readNotification, maintenanceEvent, main };

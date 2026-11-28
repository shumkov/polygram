#!/usr/bin/env node
/**
 * Real-Codex gate for the session mailbox (docs/CODEX_MAILBOX_SPEC.md).
 *
 * One session runs the pinned Codex binary under Orchestra's CodexProcess,
 * with the exact owned profile polygram provisions in production (the
 * `polygram-trusted` permission profile, `inherit = "none"`, an explicit
 * PATH, HOME and TMPDIR) and the daemon's IPC directory listed as a
 * daemon-secret root, as polygram.js does. The other session ("general") is
 * a recording stand-in for a Claude CLI session.
 *
 * The daemon side is the real code over a temp SQLite DB: the mailbox
 * service, the external-jobs service with its runtime (now admitting Codex)
 * and the shared dispatch wrapper, and an authenticated IPC socket.
 *
 * The model is a loopback Responses provider with a synthetic key: no
 * credentials, no model call, no network beyond 127.0.0.1. It reads each
 * request's newest user prompt, finds the `msg.js` command polygram injected,
 * and scripts one code-mode `exec_command` call with it (send, reply,
 * directory), then a final message. So the checks prove what only a real
 * Codex can: its shell, under the production command policy, reaches the
 * IPC socket and the 0600 secret, and job turns run through the real
 * app-server queue.
 *
 * Checks:
 *   1. directory from a Codex turn lists general and returns the caller;
 *   2. an ask from a Codex turn lands as a stored ask to general;
 *   3. general's reply runs as a job turn in Codex and settles succeeded,
 *      with a report;
 *   4. an ask from general runs as a job turn in Codex, and the Codex turn
 *      replies with that job's command;
 *   5. a job submitted while a Codex turn runs defers, then runs once the
 *      turn ends;
 *   6. a superseded command from an earlier prompt cannot start a message.
 *
 * Output is content-free: PASS/FAIL per check and counts. Exit 0 when every
 * check passes, 1 on any failure, 2 when the run could not start.
 *
 * Side effects: a mode-0700 run directory under --probe-root (removed unless
 * --keep-artifacts) holding the Codex home, workspace and DB, and a mode-0700
 * IPC directory under the home directory (removed at exit), because
 * polygram's IPC refuses temporary directories. Nothing under ~/.polygram,
 * ~/.codex or ~/.codex-polygram is read or written.
 *
 * Usage (from the polygram package root):
 *   node scripts/spikes/codex-mailbox.mjs \
 *     --binary ~/.local/share/polygram/codex-bin/<pin>/codex \
 *     --probe-root /absolute/non-temporary/dir [--keep-artifacts]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const binary = option('--binary');
const probeRoot = option('--probe-root');
const keep = args.includes('--keep-artifacts');
if (!binary || !probeRoot || !path.isAbsolute(binary) || !path.isAbsolute(probeRoot)) {
  console.error('Usage: node scripts/spikes/codex-mailbox.mjs --binary /abs/codex --probe-root /abs/dir [--keep-artifacts]');
  process.exit(2);
}

const orchestra = require('@shumkov/orchestra');
const { createAsyncLock } = orchestra;
const dbLib = require('../../lib/db.js');
const ipcServer = require('../../lib/ipc/server.js');
const { createIpcHandlers } = require('../../lib/ipc/handlers.js');
const { createExternalJobService } = require('../../lib/external-jobs/service.js');
const { createExternalJobRuntime, createExternalJobTargetResolver } = require('../../lib/external-jobs/runtime.js');
const { createExternalJobDispatch } = require('../../lib/external-jobs/dispatch.js');
const { createMailboxService } = require('../../lib/mailbox/service.js');
const { getSessionKey } = require('../../lib/session-key.js');
const { createCodexRuntimeProfileBuilder } = require('../../lib/codex/runtime-profile');
const { createPinnedCodexBinaryResolver } = require('../../lib/codex/binary');

const BOT = 'pgcodexmbx';
const HOME_CHAT = '-1009000000001';
const CODEX = `${HOME_CHAT}:5`;
const GENERAL = HOME_CHAT;
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const log = (line) => process.stdout.write(`${line}\n`);

const root = fs.mkdtempSync(path.join(fs.realpathSync(probeRoot), 'codex-mailbox-'));
fs.chmodSync(root, 0o700);
const dirs = Object.fromEntries(['codex', 'workspace', 'home', 'tmp', 'secrets'].map((name) => {
  const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700 }); return [name, dir];
}));
// The owned profile binds the Codex home to the workspace's root instructions.
fs.writeFileSync(path.join(dirs.workspace, 'AGENTS.md'), 'Synthetic mailbox spike workspace. Touch nothing outside it.\n', { mode: 0o600 });
const ipcDir = fs.mkdtempSync(path.join(os.homedir(), '.pgcmx-ipc-'));
fs.chmodSync(ipcDir, 0o700);

// ─── loopback Responses provider ───────────────────────────────────────────
// What the provider saw and did, by request. Never the prompt text itself.
const evidence = { requests: 0, actions: [], toolExitCodes: [] };
let firstCommand = null;
let holdNext = false;
let held = null;
const COMMAND = /POLYGRAM_IPC_DIR="[^"]+" "[^"]+" "[^"]+msg\.js" "[^"]+" "[0-9a-f-]{36}"/g;
function userTexts(input) {
  return input.filter((item) => item.type === 'message' && item.role === 'user')
    .map((item) => (Array.isArray(item.content) ? item.content : []).map((part) => part.text || '').join('\n'));
}
function decide(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const lastUser = input.map((item) => item.type === 'message' && item.role === 'user').lastIndexOf(true);
  const output = input.slice(lastUser + 1).find((item) => item.type === 'custom_tool_call_output');
  if (output) {
    const text = (output.output || []).map((part) => part.text || '').join('\n');
    const exit = /"exit_code":(\d+)/.exec(text);
    evidence.toolExitCodes.push(exit ? Number(exit[1]) : null);
    return { final: 'spike-ok' };
  }
  const prompt = userTexts(input).at(-1) || '';
  const commands = prompt.match(COMMAND) || [];
  const command = commands.at(-1);
  if (command && !firstCommand) firstCommand = command;
  const ask = /\[Inter-session message\][^\n]* kind=ask id=(m_[0-9a-f]{16})/.exec(prompt);
  if (ask && command) return { action: 'reply', cmd: `${command} reply '${JSON.stringify({ id: ask[1], body: 'codex answer' })}'` };
  if (/\[Inter-session message\][^\n]* kind=reply /.test(prompt)) return { action: 'noted', final: 'noted' };
  if (prompt.includes('SPIKE:directory') && command) return { action: 'directory', cmd: `${command} directory` };
  if (prompt.includes('SPIKE:ask-general') && command) return { action: 'send', cmd: `${command} send '${JSON.stringify({ to: 'general', kind: 'ask', body: 'codex question' })}'` };
  if (prompt.includes('SPIKE:stale-send') && firstCommand) return { action: 'stale-send', cmd: `${firstCommand} send '${JSON.stringify({ to: 'general', kind: 'tell', body: 'stale' })}'` };
  if (prompt.includes('SPIKE:hold')) return { action: 'hold', final: 'held-done', hold: true };
  return { action: 'none', final: 'spike-ok' };
}
function respond(res, step) {
  const id = randomUUID();
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (step.cmd) {
    const item = { type: 'custom_tool_call', id: `ctc-${id}`, call_id: `call-${id}`, name: 'exec',
      input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(step.cmd)}, yield_time_ms: 20000 });\ntext(typeof r === 'string' ? r : JSON.stringify(r));` };
    res.end(event('response.created', { response: { id } })
      + event('response.output_item.added', { output_index: 0, item: { ...item, input: '' } })
      + event('response.custom_tool_call_input.delta', { output_index: 0, item_id: item.id, delta: item.input })
      + event('response.output_item.done', { output_index: 0, item })
      + event('response.completed', { response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }));
    return;
  }
  const text = step.final;
  res.end([
    event('response.created', { response: { id } }),
    event('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', id: `message-${id}`, content: [] } }),
    event('response.output_text.delta', { item_id: `message-${id}`, output_index: 0, content_index: 0, delta: text }),
    event('response.output_item.done', { output_index: 0, item: { type: 'message', role: 'assistant', id: `message-${id}`, content: [{ type: 'output_text', text }] } }),
    event('response.completed', { response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }),
  ].join(''));
}
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 4 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses') || req.headers.authorization !== 'Bearer synthetic-key') { res.writeHead(404); res.end(); return; }
    evidence.requests += 1;
    let step;
    try { step = decide(JSON.parse(raw)); } catch { step = { action: 'unparsed', final: 'spike-ok' }; }
    if (step.action) evidence.actions.push(step.action);
    if (step.hold) { held = () => respond(res, step); holdNext = false; return; }
    respond(res, step);
  });
});
server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n'));

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok) }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const waitFor = async (predicate, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error('bounded wait expired'); await new Promise((r) => setTimeout(r, 50)); }
};

let proc = null;
let db = null;
let ipc = null;
let jobs = null;
let mailbox = null;
let exitCode = 0;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const keyFile = path.join(dirs.secrets, 'proxy.key');
  fs.writeFileSync(keyFile, 'synthetic-key', { mode: 0o600 });
  const proxy = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, clientKeyFile: keyFile };

  // ─── the Codex session, provisioned exactly as polygram does ───────────────
  const receipt = await createPinnedCodexBinaryResolver()({ binaryPath: binary, env: {} });
  const builder = createCodexRuntimeProfileBuilder();
  const profile = await builder.prepare({ binaryReceipt: receipt, codexHome: dirs.codex, workspace: dirs.workspace,
    daemonSecretRoots: [dirs.secrets, ipcDir], model: 'gpt-6-astra', effort: 'high',
    processEnv: { HOME: dirs.home, TMPDIR: dirs.tmp, PATH: '/usr/bin:/bin' },
    access: { mode: 'trusted', commandPath: '/usr/bin:/bin' }, proxy });
  const preflight = await orchestra.preflightCodexRuntime(profile);
  const spawnReceipt = orchestra.createCodexSpawnProfile(profile, preflight);
  const clients = [];
  const factory = orchestra.createProcessFactory({
    config: {}, logger: quiet, codexHostIdentity: 'spike-host', codexBootSessionIdentity: 'spike-boot',
    codexExpectedStaticProfile: () => { builder.reattest(profile); return spawnReceipt; },
    codexClientFactory: ({ onNotification, onFault }) => {
      builder.reattest(profile);
      const client = new orchestra.CodexAppServerClient({ binary, codexHome: profile.codexHome, cwd: profile.cwd ?? dirs.workspace, env: profile.env,
        expectedConfigSha256: profile.ownedConfigSha256, onNotification, onFault });
      clients.push(client); return client;
    },
    codexCheckpointSink: async () => {},
  });
  proc = factory(CODEX, { runtime: 'codex', spawnProfileId: spawnReceipt.spawnProfileId, modelSettings: { model: 'gpt-6-astra', effort: 'high' } });
  await proc.start(proc.spawnOptions);

  // ─── daemon side: DB, jobs, mailbox, IPC ──────────────────────────────────
  const config = {
    bot: { externalJobs: { enabled: true, maxConcurrent: 4, routes: {} }, mailbox: { enabled: true, intra: 'open', mirror: false } },
    chats: { [HOME_CHAT]: { name: 'Spike', isolateTopics: true, topics: { 5: { name: 'Orchestra', pm: 'codex' } } } },
  };
  const announce = console.log; console.log = () => {};
  try { db = dbLib.open(path.join(root, 'spike.db')); } finally { console.log = announce; }
  const resolveBackend = ({ chatId, threadId }) => (String(chatId) === HOME_CHAT && String(threadId) === '5' ? 'codex' : 'cli');
  const resolveTarget = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend });
  const generalPrompts = [];
  const general = { backend: 'cli', inFlight: false, probeBusyState: async () => ({ busy: false }) };
  const sendToProcess = async (sessionKey, prompt, context, { onDispatched } = {}) => {
    if (sessionKey === GENERAL) { generalPrompts.push(prompt); onDispatched?.(); return { text: 'general-ok' }; }
    const turn = proc.send(prompt, { timeoutMs: 120_000, maxTurnMs: 120_000, context });
    onDispatched?.();
    return turn;
  };
  const runtime = createExternalJobRuntime({
    config, pm: { get: (key) => (key === CODEX ? proc : key === GENERAL ? general : undefined) }, intentLock: createAsyncLock(), getSessionKey, resolveBackend,
    isPaused: (key) => jobs.isPaused(key), isShuttingDown: () => false, needsAuth: () => false, checkAuth: () => null,
    awaitSessionRecovery: async () => {}, getOrSpawnForChat: async (key) => (key === CODEX ? proc : general), sendToProcess, logger: quiet,
  });
  const reports = [];
  jobs = createExternalJobService({
    config, db, botName: BOT, resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (origin, run) => run(), runtime, getMailbox: () => mailbox, getBackend: resolveBackend, logger: quiet }),
    checkInactive: runtime.checkInactive, recoverInactive: runtime.recoverInactive,
    deliverPart: async (job) => { reports.push(job.requestId); return { messageId: reports.length }; }, logger: quiet,
  });
  mailbox = createMailboxService({ config, db, botName: BOT, jobs, resolveTarget, resolveBackend, getSessionKey, ipcDir, logger: quiet });
  const ipcOptions = { env: { POLYGRAM_IPC_DIR: ipcDir } };
  const secret = ipcServer.writeSecret(BOT, ipcOptions);
  ipc = await ipcServer.start({ path: ipcServer.socketPathFor(BOT, ipcOptions), secret, logger: quiet,
    handlers: createIpcHandlers({ botName: BOT, externalJobs: jobs, mailbox }) });
  jobs.start();

  const rows = () => db.raw.prepare('SELECT * FROM mailbox_messages ORDER BY created_at, rowid').all();
  const jobRow = (requestId) => db.raw.prepare('SELECT state, report_state FROM external_jobs WHERE request_id=?').get(requestId);
  // A human prompt into the Codex session, built the way formatPrompt does.
  const humanTurn = (marker) => {
    mailbox.noteHumanPrompt(CODEX, { operator: true, newTurn: !proc.inFlight });
    return proc.send(`${marker}\n${mailbox.instructions(CODEX)}`, { timeoutMs: 120_000, maxTurnMs: 120_000 });
  };

  // General's own human turn, for a message general starts.
  const generalHuman = () => { mailbox.noteHumanPrompt(GENERAL, { operator: true }); return mailbox.scope(GENERAL); };

  // 1. directory
  const exitsBefore = evidence.toolExitCodes.length;
  await humanTurn('SPIKE:directory');
  check('directory from a Codex turn runs msg.js through the IPC socket', evidence.toolExitCodes[exitsBefore] === 0,
    `exit=${evidence.toolExitCodes[exitsBefore]}`);

  // 2. ask from Codex to general
  await humanTurn('SPIKE:ask-general');
  const ask = rows().find((row) => row.kind === 'ask' && row.from_addr === `session:${CODEX}`);
  check('an ask from a Codex turn is stored from the Codex session to general', ask && ask.to_addr === `session:${GENERAL}` && ask.depth === 1);
  await jobs.tick();
  check('general receives the ask as a job turn', generalPrompts.some((prompt) => ask && prompt.includes(ask.id)));
  if (!ask) throw Object.assign(new Error('No ask reached the store; the later checks depend on it'), { code: 'SPIKE_PRECONDITION' });

  // 3. general replies; the reply runs as a Codex job turn
  const generalToken = mailbox.scope(GENERAL);
  const reply = mailbox.reply(generalToken, { inReplyTo: ask.id, body: 'general answer' });
  await jobs.tick();
  const replyJob = jobRow(`mailbox:${reply.id}`);
  check('general\'s reply runs as a job turn in Codex and settles succeeded', replyJob?.state === 'succeeded', `state=${replyJob?.state}`);
  // A reply that closes the ask leaves nothing a person needs, so the turn
  // may end with NO_REPLY; either way it is decided, never lost.
  check('the Codex job turn\'s final text is reported, or recorded silent by NO_REPLY',
    reports.includes(`mailbox:${reply.id}`) || replyJob?.report_state === 'silent', `report_state=${replyJob?.report_state}`);

  // 4. general asks Codex; Codex replies with that job's command
  const generalAsk = mailbox.send(generalHuman(), { to: 'orchestra', kind: 'ask', body: 'general question' });
  await jobs.tick();
  await waitFor(() => rows().some((row) => row.kind === 'reply' && row.in_reply_to === generalAsk.id));
  const codexReply = rows().find((row) => row.kind === 'reply' && row.in_reply_to === generalAsk.id);
  check('an ask from general runs in Codex and Codex replies with the job\'s command',
    codexReply?.from_addr === `session:${CODEX}` && jobRow(`mailbox:${generalAsk.id}`)?.state === 'succeeded');

  // 5. a job submitted while a Codex turn runs waits for the turn to end
  holdNext = true;
  const busyTurn = humanTurn('SPIKE:hold');
  await waitFor(() => held !== null);
  const tell = mailbox.send(generalHuman(), { to: 'orchestra', kind: 'tell', body: 'while busy' });
  await jobs.tick();
  const whileBusy = jobRow(`mailbox:${tell.id}`)?.state;
  held(); held = null;
  await busyTurn;
  await waitFor(async () => { await jobs.tick(); return jobRow(`mailbox:${tell.id}`)?.state === 'succeeded'; });
  check('a job submitted during a Codex turn defers, then runs after it', whileBusy === 'queued', `while busy=${whileBusy}`);

  // 6. a superseded command cannot start a message
  const before = rows().length;
  const staleExits = evidence.toolExitCodes.length;
  await humanTurn('SPIKE:stale-send');
  check('a superseded command from an earlier prompt cannot start a message',
    evidence.toolExitCodes[staleExits] === 1 && rows().length === before, `exit=${evidence.toolExitCodes[staleExits]}`);

  log(`provider requests=${evidence.requests} actions=${evidence.actions.join(',')}`);
  exitCode = checks.every((c) => c.ok) ? 0 : 1;
} catch (error) {
  log(`ERROR  ${error?.code || error?.name || 'Error'}: ${String(error?.message || '').slice(0, 300)}`);
  if (process.env.SPIKE_DEBUG) log(String(error?.stack));
  exitCode = checks.length ? 1 : 2;
} finally {
  if (held) { try { held(); } catch {} }
  try { jobs?.stop(); } catch {}
  try { mailbox?.stop(); } catch {}
  if (proc) { try { await proc.kill(); } catch { exitCode = exitCode || 1; } }
  try { await ipc?.close?.(); } catch {}
  try { db?.close?.(); } catch {}
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(ipcDir, { recursive: true, force: true });
  if (keep) log(`retained: ${root}`); else fs.rmSync(root, { recursive: true, force: true });
  log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  process.exit(exitCode);
}

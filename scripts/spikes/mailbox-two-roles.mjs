/**
 * Real-CLI spike for the session mailbox: two role sessions talking through
 * the real mailbox, external-jobs and IPC stack.
 *
 * Each role is a pinned claude CLI under orchestra's CliProcess, exactly as in
 * production (tmux + channels bridge + hook ndjson), in its own temp cwd. The
 * daemon side is the real code over a temp SQLite DB: the mailbox service, the
 * external-jobs service with its CLI runtime and the shared dispatch wrapper
 * (depth hook, kill switch), an authenticated IPC socket that the agents'
 * Bash tool reaches through skills/mailbox/scripts/msg.js, and a stub `tg`
 * that records the Telegram mirror posts.
 *
 * The tmux server is started without POLYGRAM_IPC_DIR / POLYGRAM_IPC_SECRET in
 * its environment, as when the daemon does not own the tmux server (a separate
 * tmux service, or a shared default server). The agent's command must
 * therefore carry everything msg.js needs on its own.
 *
 * Modes:
 *   --model stub (default) — no paid or authenticated inference. A local
 *     /v1/messages stub (the ANTHROPIC_BASE_URL seam the VPS uses for
 *     CLIProxy) scripts every turn: it runs the Bash tool with the exact
 *     msg.js command taken from the injected instructions, then answers
 *     through the bridge. Proves the plumbing: the envelope reaches the target
 *     session, the token stamps the right role, ask → reply → a quoting turn
 *     in the asker, one notice for a silent target, the depth refusal, one
 *     mirror post per message, and overlapping turns in two sessions.
 *   --model real — the machine's normal Claude login and the cheapest model
 *     (haiku), with short synthetic prompts. Proves model behaviour: the
 *     orchestrator asks once when told to, marketing replies exactly once
 *     without acknowledgement ping-pong, and the asker's follow-up turn sends
 *     nothing. Reports turn and token counts. If the login is unavailable the
 *     run says so and exits 2 (skipped).
 *
 * Output is content-free: PASS/FAIL per check, ids, counts and timings. Exit
 * 0 when every check passes, 1 on any failure, 2 when the run could not start.
 *
 * Side-effects: a dedicated tmux server (`tmux -L pgmbx`), a mode-0700 temp
 * dir (removed at exit) that holds this run's copy of the pinned claude
 * binary, the two cwds, the hook files and the SQLite DB; a mode-0700 IPC dir
 * under the home directory (removed at exit), because Polygram's IPC refuses
 * temporary directories; and each session's ~/.claude/projects entry for its
 * temp cwd (removed at exit). The channels bridge runs with HOME inside the
 * temp dir, so its log mirror lands there too. It never touches
 * ~/.local/share/polygram, ~/.polygram or any other tmux server. The CLI
 * auto-updater is disabled.
 *
 * Usage (from the polygram package root; needs tmux and the pinned claude from
 * the Agent SDK package or ~/.local/share/claude/versions):
 *   node scripts/spikes/mailbox-two-roles.mjs
 *   node scripts/spikes/mailbox-two-roles.mjs --model real
 * Options:
 *   --orchestra <path>  load CliProcess from this orchestra checkout.
 *   --wait-ms <ms>      how long to wait for the scenario to settle
 *                       (default 300000).
 * Environment:
 *   ORCHESTRA_CLAUDE_BIN         run this claude binary as is (no vendoring).
 *   ORCHESTRA_CLAUDE_VENDOR_DIR  absolute dir to vendor the pin into instead of
 *                                the run's temp dir. Never the daemon's live
 *                                ~/.local/share/polygram/claude-bin: vendoring
 *                                deletes every other version there.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const MODEL = arg('model', 'stub');
const WAIT_MS = Number(arg('wait-ms', 300_000));
const ORCHESTRA_PATH = arg('orchestra', null);
if (!['stub', 'real'].includes(MODEL)) {
  console.error(`unknown --model ${MODEL}`);
  process.exit(2);
}

const orchestra = require(ORCHESTRA_PATH ? path.resolve(ORCHESTRA_PATH) : '@shumkov/orchestra');
const { CliProcess, createTmuxRunner, createAsyncLock } = orchestra;
const { ensureVendoredClaudeBin, CLAUDE_CLI_PINNED_VERSION } = orchestra.claudeBin;

const VENDOR_DIR_OVERRIDE = process.env.ORCHESTRA_CLAUDE_VENDOR_DIR || null;
const LIVE_VENDOR_DIR = path.join(os.homedir(), '.local', 'share', 'polygram', 'claude-bin');
if (VENDOR_DIR_OVERRIDE && !path.isAbsolute(VENDOR_DIR_OVERRIDE)) {
  console.error(`ORCHESTRA_CLAUDE_VENDOR_DIR must be an absolute path (got ${VENDOR_DIR_OVERRIDE})`);
  process.exit(2);
}
if (VENDOR_DIR_OVERRIDE && path.resolve(VENDOR_DIR_OVERRIDE) === LIVE_VENDOR_DIR) {
  console.error('ORCHESTRA_CLAUDE_VENDOR_DIR must not be the daemon\'s live vendor dir');
  process.exit(2);
}

const dbLib = require('../../lib/db.js');
const ipcServer = require('../../lib/ipc/server.js');
const { createIpcHandlers } = require('../../lib/ipc/handlers.js');
const { createExternalJobService } = require('../../lib/external-jobs/service.js');
const { createExternalJobRuntime, createExternalJobTargetResolver } = require('../../lib/external-jobs/runtime.js');
const { createExternalJobDispatch } = require('../../lib/external-jobs/dispatch.js');
const { createMailboxService } = require('../../lib/mailbox/service.js');
const { getSessionKey } = require('../../lib/session-key.js');

// The tmux server this run starts must not inherit the IPC location: the
// agent's command has to work without it.
delete process.env.POLYGRAM_IPC_DIR;
delete process.env.POLYGRAM_IPC_SECRET;

const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const quiet = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = WAIT_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await sleep(250); }
  return pred();
}

const BOT = 'pgmbxspike';
const SOCKET = 'pgmbx';
const ROLES = {
  orchestrator: { chatId: '-100100', about: 'Owns strategy; routes work' },
  marketing: { chatId: '-100200', about: 'Campaigns, content, ads' },
};
const roleOfChat = (chatId) => Object.keys(ROLES).find((role) => ROLES[role].chatId === chatId) || null;
const ASK_A = { to: 'marketing', kind: 'ask', body: 'What is the launch date? [reply] [deep] [slow]' };
const ASK_B = { to: 'marketing', kind: 'ask', body: 'Any blockers this week? [silent]' };

// ─── stub Anthropic API (stub mode) ─────────────────────────────────────────
// Each turn's plan is derived from its channel prompt alone, and the step to
// play is the number of assistant messages already after that prompt, so the
// stub needs no per-session state.
const stubTurns = [];       // { at, role, kind, id, step } per scripted response
const toolResults = [];     // { role, kind, id, isError, depthRefused, label }
const askQuoted = new Set(); // reply ids whose delivered prompt quoted the original ask
const seenResults = new Set(); // tool_use ids already recorded
const userParts = (m) => (typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : (m?.content || []));
const resultText = (part) => (typeof part.content === 'string' ? part.content
  : (part.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));

function currentTurn(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== 'user') continue;
    const text = userParts(msgs[i]).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    if (!text.includes('<channel')) continue;
    const after = msgs.slice(i + 1);
    return {
      prompt: text,
      steps: after.filter((m) => m.role === 'assistant').length,
      // Every tool result of this turn so far; the CLI may add other user
      // content after a result, so the last message alone can miss one.
      results: after.filter((m) => m.role === 'user').flatMap((m) => userParts(m).filter((p) => p.type === 'tool_result')),
    };
  }
  return null;
}

// A content-free label for a tool result, so a failing run says why.
function resultLabel(text) {
  if (/"ok":true/.test(text)) return 'ok';
  if (/Depth limit/.test(text)) return 'refused:depth';
  if (/IPC directory/.test(text)) return 'error:ipc-directory';
  if (/ENOENT|ECONNREFUSED|connect/.test(text)) return 'error:ipc-unreachable';
  if (/token is not valid/.test(text)) return 'error:token';
  if (/^\s*$/.test(text)) return 'empty';
  return 'other';
}

function planFor(prompt) {
  const command = /Ask or tell another role: run (.+?) send '/.exec(prompt)?.[1] || 'false';
  const bash = (cmd) => ({ name: 'Bash', input: { command: cmd, description: 'mailbox spike step' } });
  const msg = (verb, obj) => bash(`${command} ${verb} '${JSON.stringify(obj)}'`);
  const done = (text) => ({ bridgeReply: text });
  if (prompt.includes('[Inter-session notice]')) {
    return { kind: 'notice', id: /about=(m_[0-9a-f]+)/.exec(prompt)?.[1] || null, steps: [done('noted')] };
  }
  const header = /\[Inter-session message\] from=(\S+) to=(\S+) kind=(\w+) id=(m_[0-9a-f]+)/.exec(prompt);
  if (header) {
    const [, , , kind, id] = header;
    if (kind === 'reply') return { kind, id, steps: [done('thanks')] };
    const steps = [];
    if (prompt.includes('[deep]')) steps.push(msg('send', { to: 'orchestrator', kind: 'tell', body: 'depth probe' }));
    if (prompt.includes('[slow]')) steps.push(bash('sleep 6'));
    if (prompt.includes('[reply]')) steps.push(msg('reply', { id, body: 'The launch is on May 5.' }));
    steps.push(done('handled'));
    return { kind, id, steps };
  }
  if (prompt.includes('SPIKE-HUMAN')) return { kind: 'human', id: null, steps: [msg('send', ASK_A), msg('send', ASK_B), done('asked')] };
  if (prompt.includes('SPIKE-CONCURRENT')) return { kind: 'concurrent', id: null, steps: [bash('sleep 4'), done('ok')] };
  return { kind: 'other', id: null, steps: [done('ok')] };
}

function sse(res, contentBlocks, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const events = [{ type: 'message_start', message: { id: `msg_stub_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-stub',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
  contentBlocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  events.push({ type: 'message_stop' });
  for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
}

let toolSeq = 0;
const stub = MODEL !== 'stub' ? null : http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!req.url.startsWith('/v1/messages')) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'stub' } });
    if (req.url.startsWith('/v1/messages/count_tokens')) return json(200, { input_tokens: 10 });
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const replyTool = tools.find((t) => typeof t?.name === 'string' && t.name.endsWith('__reply'));
    const turn = replyTool ? currentTurn(body) : null;
    if (!turn) return sse(res, [{ type: 'text', text: 'ok' }], 'end_turn');
    const role = roleOfChat(/chat_id="([^"]+)"/.exec(turn.prompt)?.[1] || '');
    const plan = planFor(turn.prompt);
    if (plan.kind === 'reply' && turn.prompt.includes('What is the launch date?')) askQuoted.add(plan.id);
    for (const part of turn.results) {
      if (seenResults.has(part.tool_use_id)) continue;
      seenResults.add(part.tool_use_id);
      const text = resultText(part);
      toolResults.push({ role, kind: plan.kind, id: plan.id, isError: part.is_error === true, depthRefused: /Depth limit/.test(text), label: resultLabel(text) });
    }
    if (turn.steps >= plan.steps.length) return sse(res, [{ type: 'text', text: 'done' }], 'end_turn');
    const step = plan.steps[turn.steps];
    stubTurns.push({ at: ts(), role, kind: plan.kind, id: plan.id, step: turn.steps });
    toolSeq += 1;
    if (step.bridgeReply) {
      const chatId = /chat_id="([^"]+)"/.exec(turn.prompt)?.[1] || '';
      const turnId = [...turn.prompt.matchAll(/turn_id="([^"]+)"/g)].pop()?.[1] || '';
      return sse(res, [{ type: 'tool_use', id: `toolu_stub_${toolSeq}`, name: replyTool.name, input: { chat_id: chatId, turn_id: turnId, text: step.bridgeReply } }], 'tool_use');
    }
    return sse(res, [{ type: 'tool_use', id: `toolu_stub_${toolSeq}`, name: step.name, input: step.input }], 'tool_use');
  });
});
if (stub) await new Promise((r) => stub.listen(0, '127.0.0.1', r));

// ─── isolated scaffolding ───────────────────────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pgmbx-'));
fs.chmodSync(work, 0o700);
if (!VENDOR_DIR_OVERRIDE) process.env.ORCHESTRA_CLAUDE_VENDOR_DIR = path.join(work, 'claude-bin');
const ipcDir = fs.mkdtempSync(path.join(os.homedir(), '.pgmbx-ipc-'));
fs.chmodSync(ipcDir, 0o700);
const cwds = Object.fromEntries(Object.keys(ROLES).map((role) => [role, fs.realpathSync(fs.mkdtempSync(path.join(work, `${role}-`)))]));
const launcher = path.join(work, 'launcher.sh');
fs.writeFileSync(launcher, [
  '#!/bin/sh',
  ...(stub ? [
    // Model traffic goes only to the local stub; the token is a dummy.
    'unset CLAUDE_CODE_OAUTH_TOKEN',
    'export ANTHROPIC_API_KEY=',
    `export ANTHROPIC_BASE_URL=http://127.0.0.1:${stub.address().port}`,
    'export ANTHROPIC_AUTH_TOKEN=stub-token-not-a-secret',
  ] : []),
  'export DISABLE_AUTOUPDATER=1',
  'exec "$@"',
  '',
].join('\n'), { mode: 0o700 });

const procs = new Map();
const evidence = { turns: [], mirrors: [], reports: [], bridgeReplies: [], orchestraEvents: [] };
let db; let ipc; let jobs; let mailbox; let pump; let exitCode = 0;
const sessionKeyOf = (role) => getSessionKey(ROLES[role].chatId, null, {});

function cleanupPaths() {
  for (const cwd of Object.values(cwds)) {
    try { fs.rmSync(path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true }); } catch {}
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(ipcDir, { recursive: true, force: true });
}

const binResult = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION, { logger: { warn: () => {}, log: () => {}, error: log } });
if (!binResult.ok) {
  log(`pinned claude unavailable: ${binResult.reason}`);
  stub?.close(); cleanupPaths();
  process.exit(2);
}
log(`claude binary: ${binResult.path} (model=${MODEL})`);

const noopStreamer = { onChunk: async () => {}, forceNewMessage: () => {}, finalize: async () => ({ streamed: false }), flushDraft: async () => {}, discard: async () => {} };
const noopReactor = { setState: () => {}, heartbeat: () => {}, clear: async () => {}, stop: () => {} };

// The daemon's send path for an external job: one turn on the exact process,
// with the committed-send signal the runtime waits for before releasing its
// admission lock.
async function sendToProcess(sessionKey, prompt, context = {}, { onDispatched, expectedProcess = null } = {}) {
  const proc = expectedProcess || procs.get(sessionKey);
  const role = Object.keys(ROLES).find((r) => sessionKeyOf(r) === sessionKey);
  const record = { role, requestId: context.origin?.requestId ?? null, start: Date.now(), end: null };
  evidence.turns.push(record);
  const turn = proc.send(prompt, { context: { ...context, streamer: noopStreamer, reactor: noopReactor } });
  onDispatched?.();
  try { return await turn; } finally { record.end = Date.now(); }
}

function jsonlStats(role) {
  const proc = procs.get(sessionKeyOf(role));
  const file = path.join(os.homedir(), '.claude', 'projects', cwds[role].replace(/[^a-zA-Z0-9]/g, '-'), `${proc?.claudeSessionId}.jsonl`);
  const stats = { assistantMessages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (!proc?.claudeSessionId || !fs.existsSync(file)) return stats;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const usage = e.type === 'assistant' ? e.message?.usage : null;
    if (!usage) continue;
    stats.assistantMessages += 1;
    stats.inputTokens += usage.input_tokens || 0;
    stats.outputTokens += usage.output_tokens || 0;
    stats.cacheReadTokens += usage.cache_read_input_tokens || 0;
    stats.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
  }
  return stats;
}

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

try {
  // ─── daemon side: DB, jobs, mailbox, IPC ──────────────────────────────────
  const config = {
    bot: {
      externalJobs: { enabled: true, maxConcurrent: 4, routes: Object.fromEntries(Object.entries(ROLES).map(([role, r]) => [role, { chatId: r.chatId }])) },
      mailbox: {
        enabled: true,
        roles: Object.fromEntries(Object.entries(ROLES).map(([role, r]) => [role, { about: r.about }])),
        allow: { orchestrator: ['*'], marketing: ['orchestrator'] },
        mirror: true,
        // Stub mode drives the depth refusal from the first delivered turn.
        ...(MODEL === 'stub' ? { limits: { maxDepth: 1 } } : {}),
      },
    },
    chats: Object.fromEntries(Object.values(ROLES).map((r) => [r.chatId, {}])),
  };
  // Migrations announce themselves on stdout; the spike's output stays focused.
  const announce = console.log; console.log = () => {};
  try { db = dbLib.open(path.join(work, 'spike.db')); } finally { console.log = announce; }
  const resolveBackend = () => 'cli';
  const resolveTarget = createExternalJobTargetResolver({ config, getSessionKey, resolveBackend });
  const runtime = createExternalJobRuntime({
    config, pm: { get: (key) => procs.get(key) }, intentLock: createAsyncLock(), getSessionKey, resolveBackend,
    isPaused: (key) => jobs.isPaused(key), isShuttingDown: () => false, needsAuth: () => false, checkAuth: () => null,
    awaitSessionRecovery: async () => {}, getOrSpawnForChat: async (key) => procs.get(key), sendToProcess, logger: quiet,
  });
  jobs = createExternalJobService({
    config, db, botName: BOT, resolveTarget,
    dispatch: createExternalJobDispatch({ dispatchExternalEvent: (origin, run) => run(), runtime, getMailbox: () => mailbox, logger: quiet }),
    checkInactive: runtime.checkInactive, recoverInactive: runtime.recoverInactive,
    deliverPart: async (job, part) => { evidence.reports.push({ requestId: job.requestId, index: part.index }); return { messageId: evidence.reports.length }; },
    logger: quiet,
  });
  const tg = async (bot, method, params, meta) => {
    evidence.mirrors.push({ method, chatId: params.chat_id, source: meta?.source, id: /\((?:ask|tell|reply) (m_[0-9a-f]+)\)/.exec(params.text || '')?.[1] || null });
    return { message_id: evidence.mirrors.length };
  };
  mailbox = createMailboxService({ config, db, botName: BOT, jobs, resolveTarget, bot: {}, tg, ipcDir, logger: quiet });
  const ipcOptions = { env: { POLYGRAM_IPC_DIR: ipcDir } };
  const secret = ipcServer.writeSecret(BOT, ipcOptions);
  ipc = await ipcServer.start({ path: ipcServer.socketPathFor(BOT, ipcOptions), secret, logger: quiet,
    handlers: createIpcHandlers({ botName: BOT, externalJobs: jobs, mailbox }) });

  // ─── two role sessions ────────────────────────────────────────────────────
  const runner = createTmuxRunner({ sessionPrefix: 'pgmbx', socketName: SOCKET, logger: quiet });
  // The channels bridge mirrors its log to $HOME/.polygram/bridge-logs. Its
  // environment comes from the MCP config CliProcess writes, so pointing the
  // bridge's HOME into the temp dir keeps the run out of ~/.polygram; claude
  // itself keeps the real HOME (and with it the login in real mode).
  const bridgeHome = path.join(work, 'bridge-home');
  fs.mkdirSync(bridgeHome, { mode: 0o700 });
  for (const role of Object.keys(ROLES)) {
    const proc = new CliProcess({
      sessionKey: sessionKeyOf(role), chatId: ROLES[role].chatId, label: `pgmbx-${role}`,
      tmuxRunner: runner, botName: BOT, sessionPrefix: 'pgmbx', bridgeServerName: `pgmbx-${role}-bridge`,
      appDataDir: path.join(work, 'appdata', role), attachmentBase: path.join(work, 'attachments', role),
      claudeBin: binResult.path, sessionLauncher: launcher,
      toolDispatcher: async ({ toolName, text }) => {
        if (toolName === 'reply') evidence.bridgeReplies.push({ at: ts(), role, length: String(text || '').length });
        return { ok: true, message_id: 1000 + evidence.bridgeReplies.length };
      },
      logger: quiet, db: { logEvent: (kind) => evidence.orchestraEvents.push({ at: ts(), kind }) },
    });
    proc._bridgeEnv = () => ({ ...CliProcess.prototype._bridgeEnv.call(proc), HOME: bridgeHome });
    procs.set(sessionKeyOf(role), proc);
  }
  const model = MODEL === 'stub' ? 'sonnet' : 'haiku';
  try {
    await Promise.all(Object.keys(ROLES).map((role) => procs.get(sessionKeyOf(role)).start({
      cwd: cwds[role], chatConfig: { model, permissionMode: 'bypassPermissions', isolateUserConfig: true }, existingSessionId: null,
    })));
  } catch (err) {
    if (MODEL === 'real') { log(`SKIP  real mode: a role session could not start (${err.code || err.name}); the Claude login may be unavailable`); exitCode = 2; throw null; }
    throw err;
  }
  log(`${ts()} both role sessions started`);
  jobs.start(); mailbox.start();
  // The production timer runs every 60 s; a faster pump keeps a deferred job
  // from stretching the run.
  pump = setInterval(() => { void jobs.tick(); }, 2000);

  const rows = () => db.raw.prepare('SELECT id, kind, from_addr, to_addr, in_reply_to, created_at FROM mailbox_messages ORDER BY created_at, rowid').all();
  const job = (routeId, requestId) => db.raw.prepare('SELECT state, inactive FROM external_jobs WHERE route_id=? AND request_id=?').get(routeId, requestId);
  const notices = () => db.raw.prepare("SELECT request_id, route_id, state FROM external_jobs WHERE request_id GLOB 'mailbox-notice:*'").all();
  const settled = (state) => ['succeeded', 'failed', 'interrupted', 'unknown'].includes(state);
  const orchestratorKey = sessionKeyOf('orchestrator');

  async function humanTurn(text) {
    mailbox.noteHumanPrompt(orchestratorKey);
    const record = { role: 'orchestrator', requestId: 'human', start: Date.now(), end: null };
    evidence.turns.push(record);
    try {
      return await procs.get(orchestratorKey).send(`${text}\n${mailbox.instructions(orchestratorKey)}`,
        { context: { streamer: noopStreamer, reactor: noopReactor, threadId: null, sourceMsgId: 1 } });
    } finally { record.end = Date.now(); }
  }

  if (MODEL === 'stub') {
    // ─── stub scenario ──────────────────────────────────────────────────────
    await humanTurn('SPIKE-HUMAN: ask marketing the two scripted questions.');
    log(`${ts()} human turn settled; messages stored: ${rows().length}; tool results: ${toolResults.map((r) => r.label).join(', ') || 'none'}`);
    const [askA, askB] = rows().filter((r) => r.kind === 'ask');
    if (!askA) log(`${ts()} the human turn stored no ask; skipping the wait`);
    if (askA) {
      await waitFor(() => evidence.turns.some((t) => t.requestId === `mailbox:${askA.id}`), 60_000);
      jobs.submit({ routeId: 'orchestrator', requestId: 'spike:concurrent', task: 'SPIKE-CONCURRENT: run the scripted step.', payload: {} });
    }
    if (askA) {
      await waitFor(() => {
        const reply = rows().find((r) => r.kind === 'reply');
        const replyJob = reply && job('orchestrator', `mailbox:${reply.id}`);
        const notice = askB && notices().find((n) => n.request_id === `mailbox-notice:${askB.id}`);
        return replyJob && settled(replyJob.state) && notice && settled(notice.state)
          && settled(job('orchestrator', 'spike:concurrent')?.state);
      });
      await sleep(6000); // a duplicate notice or mirror would show up here
    }
    const all = rows();
    const reply = all.find((r) => r.kind === 'reply');
    log(`${ts()} messages: ${all.map((r) => `${r.kind}:${r.id}`).join(', ') || 'none'}`);

    check('envelope reaches the target session in tmux',
      !!askA && stubTurns.some((s) => s.role === 'marketing' && s.kind === 'ask' && s.id === askA.id));
    check('the session token stamps the right role',
      !!askA && !!askB && askA.from_addr === 'role:orchestrator' && askB.from_addr === 'role:orchestrator'
        && reply?.from_addr === 'role:marketing' && reply?.in_reply_to === askA?.id);
    const replyTurn = stubTurns.find((s) => s.role === 'orchestrator' && s.kind === 'reply' && s.id === reply?.id);
    check('ask → reply → a turn in the asker that quotes the ask', !!replyTurn && askQuoted.has(reply?.id),
      reply ? `reply ${reply.id}` : 'no reply');
    const noticeJobs = notices();
    check('a silent target produces exactly one notice',
      !!askB && noticeJobs.filter((n) => n.request_id === `mailbox-notice:${askB.id}`).length === 1 && noticeJobs.length === 1
        && stubTurns.some((s) => s.role === 'orchestrator' && s.kind === 'notice' && s.id === askB.id),
      `notices=${noticeJobs.length}`);
    check('a send beyond maxDepth is refused',
      toolResults.some((r) => r.role === 'marketing' && r.kind === 'ask' && r.depthRefused) && !all.some((r) => r.kind === 'tell'));
    const mirrored = evidence.mirrors.filter((m) => m.source === 'mailbox-mirror');
    check('each message is mirrored exactly once',
      all.length > 0 && mirrored.length === all.length && all.every((r) => mirrored.filter((m) => m.id === r.id).length === 1),
      `mirrors=${mirrored.length} messages=${all.length}`);
    const turnA = evidence.turns.find((t) => t.requestId === `mailbox:${askA?.id}`);
    const turnC = evidence.turns.find((t) => t.requestId === 'spike:concurrent');
    check('turns in two sessions overlap (concurrent dispatch)',
      !!turnA?.end && !!turnC?.end && turnC.start < turnA.end && turnA.start < turnC.end,
      turnA && turnC ? `marketing ${((turnA.start - t0) / 1000).toFixed(1)}–${((turnA.end - t0) / 1000).toFixed(1)}s, orchestrator ${((turnC.start - t0) / 1000).toFixed(1)}–${((turnC.end - t0) / 1000).toFixed(1)}s` : 'missing turn');
  } else {
    // ─── real-model scenario ────────────────────────────────────────────────
    let human;
    try {
      human = await humanTurn('This is a synthetic test of the inter-session mailbox. Use the mailbox send command to ask the '
        + 'marketing role exactly one question: "What date does the spring campaign launch?". Do nothing else, and end your '
        + 'turn once the command has returned.');
    } catch (err) {
      log(`SKIP  real mode: the first turn failed (${err.code || err.name}${err.apiError ? `/${err.apiError}` : ''}); the Claude login may be unavailable`);
      exitCode = 2; throw null;
    }
    log(`${ts()} human turn settled (text_len=${String(human?.text || '').length}); messages stored: ${rows().length}`);
    await waitFor(() => {
      const reply = rows().find((r) => r.kind === 'reply');
      const replyJob = reply && job('orchestrator', `mailbox:${reply.id}`);
      return replyJob && settled(replyJob.state);
    });
    await sleep(45_000); // any acknowledgement ping-pong would land here
    const all = rows();
    const asks = all.filter((r) => r.kind === 'ask' && r.from_addr === 'role:orchestrator' && r.to_addr === 'role:marketing');
    const replies = all.filter((r) => r.kind === 'reply');
    log(`${ts()} messages: ${all.map((r) => `${r.kind}:${r.from_addr}->${r.to_addr}`).join(', ') || 'none'}`);
    check('the orchestrator asks marketing exactly one question when told to', asks.length === 1);
    check('marketing replies exactly once, to that ask', replies.length === 1 && replies[0].from_addr === 'role:marketing' && replies[0].in_reply_to === asks[0]?.id);
    check('no acknowledgement ping-pong, and the asker\'s follow-up turn sends nothing', all.length === 2,
      `messages=${all.length}`);
    const turns = evidence.turns.filter((t) => t.end);
    log(`turns: ${turns.map((t) => `${t.role}/${t.requestId === 'human' ? 'human' : t.requestId.split(':')[0]} ${((t.end - t.start) / 1000).toFixed(1)}s`).join(', ')}`);
    for (const role of Object.keys(ROLES)) {
      const s = jsonlStats(role);
      log(`tokens ${role}: assistant_messages=${s.assistantMessages} input=${s.inputTokens} output=${s.outputTokens} cache_read=${s.cacheReadTokens} cache_write=${s.cacheWriteTokens}`);
    }
  }
  log(`bridge replies: ${evidence.bridgeReplies.length}; job reports: ${evidence.reports.length}; orchestra events: ${evidence.orchestraEvents.length}`);
  if (stub) log(`tool results by role/turn: ${toolResults.map((r) => `${r.role}/${r.kind}:${r.label}`).join(', ') || 'none'}`);
  if (checks.some((c) => !c.ok)) exitCode = 1;
  log(`\n${exitCode === 0 ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.ok).length}/${checks.length} checks)`);
} catch (err) {
  if (err !== null) {
    exitCode = 1;
    log(`spike failed: ${err?.stack || err?.message || err}`);
    log('FAIL');
  }
} finally {
  clearInterval(pump);
  mailbox?.stop(); jobs?.stop();
  // claude writes its session file as it exits, which can be after the tmux
  // session is gone; removing the project entry before then leaves it behind.
  const pids = [];
  for (const proc of procs.values()) {
    try {
      const out = execFileSync('tmux', ['-L', SOCKET, 'list-panes', '-t', proc.tmuxSession, '-F', '#{pane_pid}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pid = Number(out.trim().split('\n')[0]);
      if (pid) pids.push(pid);
    } catch {}
    try { await proc.kill('spike-done'); } catch {}
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const deadline = Date.now() + 15_000; pids.some(alive) && Date.now() < deadline;) await sleep(200);
  for (const pid of pids.filter(alive)) log(`claude (pid ${pid}) still running; its project entry may be left behind`);
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch {}
  try { await ipc?.close(); } catch {}
  try { db?.raw.close(); } catch {}
  stub?.close();
  cleanupPaths();
}
process.exit(exitCode);

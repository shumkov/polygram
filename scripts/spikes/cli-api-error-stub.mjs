/**
 * Real-CLI reproduction of a Claude turn that ends in an API error, without any
 * paid or authenticated call.
 *
 * The pinned claude CLI runs under orchestra's CliProcess exactly as in
 * production (tmux + channels bridge + hook ndjson). A session launcher points
 * it at a local HTTP stub through ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN,
 * the same seam the VPS uses to route Claude through CLIProxy. The stub answers
 * /v1/messages with HTTP 500 (CLIProxy with every credential expired), a 401,
 * or N failures followed by a normal answer that replies through the bridge.
 *
 * What it reports (content-free; the prompts are synthetic):
 *   - how each turn settled (resolved / rejected + err.code) and how long it took,
 *   - the hook events claude wrote (name, prompt_id, StopFailure error fields),
 *   - the synthetic `isApiErrorMessage` entries in the session JSONL,
 *   - the pane tail after the failure,
 *   - what Polygram's classifier would tell the Telegram user.
 *
 * Side-effects: a dedicated tmux server (`tmux -L pgapierr`), a mode-0700 temp
 * dir (removed at exit) that also holds this run's copy of the pinned claude
 * binary, and the session's ~/.claude/projects entry for that temp cwd
 * (removed at exit). Model traffic goes only to the local stub, so no
 * paid or authenticated inference call is made; the CLI's own startup traffic
 * (feature flags) still runs, because Channels depends on it. The CLI's
 * auto-updater is disabled for the run.
 *
 * Ends with PASS or FAIL (exit 0 / 1) against the mode's expected outcome.
 *
 * Usage (from the polygram package root; needs tmux and the pinned claude from
 * the Agent SDK package or ~/.local/share/claude/versions):
 *   node scripts/spikes/cli-api-error-stub.mjs --mode fail --max-retries 2
 *   node scripts/spikes/cli-api-error-stub.mjs --mode fail --followup --inject
 *   node scripts/spikes/cli-api-error-stub.mjs --mode fail --max-retries 5 --inject --inject-count 3
 *   node scripts/spikes/cli-api-error-stub.mjs --mode flaky --fail-count 2
 *   node scripts/spikes/cli-api-error-stub.mjs --mode 401
 * Options:
 *   --orchestra <path>   load CliProcess from this orchestra checkout instead of
 *                        node_modules (to run a candidate fix).
 *   --max-retries <n>    CLAUDE_CODE_MAX_RETRIES for the CLI (omit = CLI default,
 *                        about 3 minutes of retries, as in production).
 *   --wait-ms <ms>       how long to wait for each turn before reporting it hung.
 *   --probe-hook         also register StopFailure in the hook settings (to see
 *                        the raw payload on an orchestra that does not).
 *   --followup           after the first turn settles, send a second message.
 *   --inject             while the first turn is retrying, autosteer a second
 *                        message into it (the production overnight shape).
 *   --inject-count <n>   with --inject: autosteer n follow-ups (default 1), to
 *                        see whether claude runs queued follow-ups as one
 *                        prompt or one each.
 *   --interrupt-after <ms> send C-c (the /stop path) this long after the first
 *                        message, while the CLI is still retrying.
 *   --agent              run the main thread as a project agent (`--agent`), as
 *                        production chats do, to check which hook fields that adds.
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

const require = createRequire(import.meta.url);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const MODE = arg('mode', 'fail');
const FAIL_COUNT = Number(arg('fail-count', 2));
const MAX_RETRIES = arg('max-retries', null);
const WAIT_MS = Number(arg('wait-ms', 240_000));
const PROBE_HOOK = arg('probe-hook', false) === true;
const FOLLOWUP = arg('followup', false) === true;
const INJECT = arg('inject', false) === true;
const INJECT_COUNT = INJECT ? Math.max(1, Number(arg('inject-count', 1))) : 0;
// The autosteered follow-ups are messages 2..INJECT_COUNT+1; turn-2 comes after.
const INJECTED_MSG_IDS = Array.from({ length: INJECT_COUNT }, (_, i) => String(2 + i));
const TURN2_MSG_ID = 2 + INJECT_COUNT;
const ORCHESTRA_PATH = arg('orchestra', null);
const INTERRUPT_AFTER_MS = arg('interrupt-after', null);
const WITH_AGENT = arg('agent', false) === true;

if (!['fail', 'flaky', '401', 'fold', 'subagent'].includes(MODE)) {
  console.error(`unknown --mode ${MODE}`);
  process.exit(2);
}

const orchestra = require(ORCHESTRA_PATH ? path.resolve(ORCHESTRA_PATH) : '@shumkov/orchestra');
const { CliProcess, createTmuxRunner, hookSettings } = orchestra;
const { classify } = require('../../lib/error/classify.js');

const { ensureVendoredClaudeBin, CLAUDE_CLI_PINNED_VERSION } = orchestra.claudeBin;
// Vendoring deletes every other version in its directory. The daemon's live
// ~/.local/share/polygram/claude-bin must therefore never be the default: a run
// against a candidate pin would delete the deployed binary. An override has to
// be an absolute path; without one the copy goes to this run's temp dir.
const VENDOR_DIR_OVERRIDE = process.env.ORCHESTRA_CLAUDE_VENDOR_DIR || null;
if (VENDOR_DIR_OVERRIDE && !path.isAbsolute(VENDOR_DIR_OVERRIDE)) {
  console.error(`ORCHESTRA_CLAUDE_VENDOR_DIR must be an absolute path (got ${VENDOR_DIR_OVERRIDE})`);
  process.exit(2);
}

const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

// ─── stub Anthropic API ─────────────────────────────────────────────────────
const stubLog = [];
let toolTurnFailures = 0;
let foldToolSent = false;

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
}

function messageEvents(contentBlocks, stopReason) {
  const events = [{
    type: 'message_start',
    message: {
      id: `msg_stub_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-stub',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  }];
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
  return events;
}

function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    return parts;
  }
  return [];
}

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const replyTool = tools.find((t) => typeof t?.name === 'string' && t.name.endsWith('__reply'));
    const entry = {
      at: ts(), method: req.method, path: req.url, stream: body?.stream === true,
      tools: tools.length, has_reply_tool: !!replyTool, status: null,
    };
    stubLog.push(entry);
    const send = (status, obj) => {
      entry.status = status;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (!req.url.startsWith('/v1/messages')) return send(404, { type: 'error', error: { type: 'not_found_error', message: 'stub' } });
    if (req.url.startsWith('/v1/messages/count_tokens')) return send(200, { input_tokens: 10 });

    if (MODE === '401') {
      return send(401, { type: 'error', error: { type: 'authentication_error', message: 'stub: invalid bearer token' } });
    }
    if (MODE === 'fail') {
      return send(500, { type: 'error', error: { type: 'api_error', message: 'stub: upstream unavailable' } });
    }
    // fold: the first main-loop request runs a slow Bash tool (a window for
    // --inject to be folded in at the tool boundary); every later main-loop
    // request fails, so the turn ends in an API error after the fold.
    // subagent: the first main-loop request starts a subagent; every later
    // request (the subagent's own and the parent's) fails.
    if (MODE === 'subagent') {
      if (replyTool && !foldToolSent) {
        foldToolSent = true;
        entry.status = 200;
        return sse(res, messageEvents([{
          type: 'tool_use', id: `toolu_stub_${Date.now()}`, name: 'Agent',
          input: { description: 'stub task', prompt: 'Say hi.', subagent_type: 'general-purpose' },
        }], 'tool_use'));
      }
      return send(500, { type: 'error', error: { type: 'api_error', message: 'stub: upstream unavailable' } });
    }
    if (MODE === 'fold' && replyTool) {
      if (!foldToolSent) {
        foldToolSent = true;
        entry.status = 200;
        return sse(res, messageEvents([{
          type: 'tool_use', id: `toolu_stub_${Date.now()}`, name: 'Bash',
          input: { command: 'sleep 8', description: 'stub wait' },
        }], 'tool_use'));
      }
      return send(500, { type: 'error', error: { type: 'api_error', message: 'stub: upstream unavailable' } });
    }
    // flaky: the main-loop request (carries the reply tool) fails FAIL_COUNT
    // times, then answers through the bridge's reply tool; side requests
    // (no tools) always succeed.
    if (!replyTool) {
      entry.status = 200;
      return sse(res, messageEvents([{ type: 'text', text: 'ok' }], 'end_turn'));
    }
    const parts = lastUserText(body);
    const isToolResult = parts.some((p) => p.type === 'tool_result');
    if (isToolResult) {
      entry.status = 200;
      return sse(res, messageEvents([{ type: 'text', text: 'done' }], 'end_turn'));
    }
    if (toolTurnFailures < FAIL_COUNT) {
      toolTurnFailures += 1;
      return send(500, { type: 'error', error: { type: 'api_error', message: 'stub: transient failure' } });
    }
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const chatId = /chat_id="([^"]+)"/.exec(text)?.[1] || '';
    const turnId = [...text.matchAll(/turn_id="([^"]+)"/g)].pop()?.[1] || '';
    entry.status = 200;
    return sse(res, messageEvents([{
      type: 'tool_use', id: `toolu_stub_${Date.now()}`, name: replyTool.name,
      input: { chat_id: chatId, turn_id: turnId, text: `STUB-OK after ${toolTurnFailures} failures` },
    }], 'tool_use'));
  });
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;

// ─── isolated session scaffolding ───────────────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pgapierr-'));
fs.chmodSync(work, 0o700);
if (!VENDOR_DIR_OVERRIDE) process.env.ORCHESTRA_CLAUDE_VENDOR_DIR = path.join(work, 'claude-bin');
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(work, 'cwd-')));
if (WITH_AGENT) {
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'stubagent.md'),
    '---\nname: stubagent\ndescription: spike agent\n---\nYou are a test agent. Answer briefly.\n');
}
const launcher = path.join(work, 'launcher.sh');
fs.writeFileSync(launcher, [
  '#!/bin/sh',
  // Same shape as the VPS proxy launcher: replace competing auth with a
  // base URL + bearer token. The token is a dummy; inference never leaves the
  // host. Nonessential traffic stays ON: with it disabled the CLI cannot read
  // the feature flag that enables Channels, so the bridge would never deliver.
  // The auto-updater is off so the run cannot move the operator's own
  // `claude` symlink (the vendored pin is a separate copy either way).
  'unset CLAUDE_CODE_OAUTH_TOKEN',
  'export ANTHROPIC_API_KEY=',
  `export ANTHROPIC_BASE_URL=http://127.0.0.1:${stubPort}`,
  'export ANTHROPIC_AUTH_TOKEN=stub-token-not-a-secret',
  'export DISABLE_AUTOUPDATER=1',
  MAX_RETRIES != null ? `export CLAUDE_CODE_MAX_RETRIES=${Number(MAX_RETRIES)}` : '',
  'exec "$@"',
  '',
].join('\n'), { mode: 0o700 });

if (PROBE_HOOK && !hookSettings.HOOK_EVENTS.includes('StopFailure')) {
  hookSettings.HOOK_EVENTS.push('StopFailure');
}

const binResult = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION, { logger: { warn: () => {}, log: () => {}, error: log } });
if (!binResult.ok) { log(`pinned claude unavailable: ${binResult.reason}`); process.exit(2); }
log(`claude binary: ${binResult.path}`);

const events = [];
const procEvents = [];
const replies = [];
const SOCKET = 'pgapierr';
const proc = new CliProcess({
  sessionKey: 'pgapierr:1',
  chatId: '424242',
  label: 'pgapierr',
  tmuxRunner: createTmuxRunner({ sessionPrefix: 'pgapierr', socketName: SOCKET, logger: { warn: () => {}, log: () => {}, error: log } }),
  botName: 'apierrstub',
  sessionPrefix: 'pgapierr',
  bridgeServerName: 'pgapierr-bridge',
  appDataDir: path.join(work, 'appdata'),
  attachmentBase: path.join(work, 'attachments'),
  claudeBin: binResult.path,
  sessionLauncher: launcher,
  toolDispatcher: async ({ toolName, text }) => {
    if (toolName === 'reply') replies.push({ at: ts(), text });
    return { ok: true, message_id: 100 + replies.length };
  },
  logger: { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} },
  db: { logEvent: (kind, detail) => events.push({ at: ts(), kind, detail }) },
});
for (const name of ['idle', 'turn-start', 'turn-timeout', 'api-error', 'bridge-disconnected']) {
  proc.on(name, (payload) => procEvents.push({ at: ts(), name, payload: payload && typeof payload === 'object' ? { ...payload, respond: undefined } : payload }));
}

const noopStreamer = {
  onChunk: async () => {}, forceNewMessage: () => {},
  finalize: async () => ({ streamed: false }), flushDraft: async () => {}, discard: async () => {},
};
const noopReactor = { setState: () => {}, heartbeat: () => {}, clear: async () => {}, stop: () => {} };

async function runTurn(label, text, msgId) {
  const started = Date.now();
  const p = proc.send(text, {
    context: { streamer: noopStreamer, reactor: noopReactor, threadId: null, sourceMsgId: msgId },
  });
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r({ outcome: 'still-pending' }), WAIT_MS); });
  const settled = p.then(
    (result) => ({ outcome: 'resolved', result }),
    (err) => ({ outcome: 'rejected', err }),
  );
  return { label, started, promise: Promise.race([settled, timeout]).finally(() => clearTimeout(timer)) };
}

const outcomes = {};
function report(label, started, s) {
  outcomes[label] = s;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (s.outcome === 'rejected') {
    const cls = classify(s.err);
    log(`${ts()} [${label}] REJECTED after ${secs}s code=${s.err.code} apiError=${s.err.apiError ?? '-'} msg="${s.err.message}"`);
    log(`        user would see: ${JSON.stringify(cls.userMessage)} (kind=${cls.kind}, autoRecover=${cls.autoRecover})`);
  } else if (s.outcome === 'resolved') {
    log(`${ts()} [${label}] RESOLVED after ${secs}s text_len=${(s.result.text || '').length} alreadyDelivered=${s.result.alreadyDelivered} error=${s.result.error}`);
  } else {
    log(`${ts()} [${label}] STILL PENDING after ${secs}s (pendingTurns=${proc.pendingTurns.size}, inFlight=${proc.inFlight})`);
  }
}

let exitCode = 0;
try {
  log(`${ts()} stub on 127.0.0.1:${stubPort} mode=${MODE} maxRetries=${MAX_RETRIES ?? 'cli-default'} orchestra=${ORCHESTRA_PATH || 'node_modules'}`);
  await proc.start({
    cwd,
    chatConfig: {
      model: 'sonnet', permissionMode: 'bypassPermissions', isolateUserConfig: true,
      ...(WITH_AGENT ? { agent: 'stubagent' } : {}),
    },
    existingSessionId: null,
  });
  log(`${ts()} claude started session=${proc.claudeSessionId}`);

  const first = await runTurn('turn-1', 'Reply with the single word PONG.', 1);
  if (INTERRUPT_AFTER_MS != null) {
    // The user's /stop while the CLI is still retrying.
    setTimeout(() => {
      proc.interrupt().then(() => log(`${ts()} sent C-c (interrupt) mid-retry`)).catch(() => {});
    }, Number(INTERRUPT_AFTER_MS));
  }
  if (INJECT) {
    await new Promise((r) => setTimeout(r, 4000));
    for (let i = 0; i < INJECT_COUNT; i += 1) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const msgId = 2 + i;
      const ok = proc.injectUserMessage({ content: `Also reply with the word FOLLOWUP${msgId}.`, msgId, source: 'autosteer' });
      log(`${ts()} injected follow-up msg ${msgId} into the in-flight turn: ${ok}`);
    }
  }
  report(first.label, first.started, await first.promise);

  const waitFor = async (pred) => {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 250));
    return pred();
  };
  let second = null;
  if (INJECT && FOLLOWUP) {
    // The production overnight shape: the user writes again while claude is
    // still retrying the autosteered follow-up as its own cycle.
    await waitFor(() => procEvents.some((e) => e.name === 'turn-start' && e.payload?.hasPending === false));
    log(`${ts()} [inject] the follow-up runs as its own cycle; sending turn-2 while it retries`);
    second = await runTurn('turn-2', 'Reply with the single word PING.', TURN2_MSG_ID);
  } else if (FOLLOWUP) {
    second = await runTurn('turn-2', 'Reply with the single word PING.', TURN2_MSG_ID);
  }
  if (INJECT) {
    // Wait until every injected follow-up has been named by an api-error event
    // (claude may run queued follow-ups as one query or one each), then a few
    // seconds more so a duplicate notice would show up.
    const named = () => new Set(procEvents.filter((e) => e.name === 'api-error')
      .flatMap((e) => e.payload?.anchorMsgIds || []));
    let coveredSince = null;
    await waitFor(() => {
      if (replies.length > 0) return true;
      if (!INJECTED_MSG_IDS.every((id) => named().has(id))) return false;
      coveredSince ??= Date.now();
      return Date.now() - coveredSince > 5000;
    });
    const ownCycles = procEvents.filter((e) => e.name === 'turn-start' && e.payload?.hasPending === false).length;
    const apiErrs = procEvents.filter((e) => e.name === 'api-error');
    log(`${ts()} [inject] own cycles started: ${ownCycles}, api-error events: ${apiErrs.length}${replies.length ? `, replies: ${replies.length}` : ''}`);
    if (!apiErrs.length) log(`${ts()} [inject] follow-up cycle outcome: ${replies.length ? 'replied' : 'NOTHING (silent)'}`);
    for (const apiErr of apiErrs) {
      const cls = classify({ code: 'CLAUDE_API_ERROR', apiError: apiErr.payload.apiError });
      log(`        api-error ${JSON.stringify(apiErr.payload)}`);
      log(`        each follow-up would see (reply to msg ${JSON.stringify(apiErr.payload.anchorMsgIds)}): ${JSON.stringify(cls.userMessage)}`);
    }
  }
  if (second) report(second.label, second.started, await second.promise);

  // ─── evidence ─────────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 1500));
  const ndjson = proc._hookNdjsonPath && fs.existsSync(proc._hookNdjsonPath)
    ? fs.readFileSync(proc._hookNdjsonPath, 'utf8').split('\n').filter(Boolean) : [];
  log('\n--- hook events (name, prompt_id, StopFailure fields) ---');
  for (const line of ndjson) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    let extra = '';
    if (ev.hook_event_name === 'StopFailure') {
      extra = ` error=${ev.error} error_details=${JSON.stringify(String(ev.error_details ?? '').slice(0, 160))} last_assistant_message=${JSON.stringify(String(ev.last_assistant_message ?? '').slice(0, 160))} agent_id=${ev.agent_id ?? '-'}`;
    } else if (ev.hook_event_name === 'UserPromptSubmit') {
      // Which of our messages this prompt carries (ids only, no content).
      const msgIds = [...String(ev.prompt ?? '').matchAll(/<channel\s[^>]*turn_id="([0-9a-f-]{36})"/g)]
        .map((m) => proc.inputLedger.get(m[1])?.msgId ?? '?');
      extra = ` carries_msg_ids=[${msgIds.join(',')}]`;
    }
    const recv = typeof ev.polygram_received_at_ms === 'number' ? `+${((ev.polygram_received_at_ms - t0) / 1000).toFixed(3)}s ` : '';
    log(`  ${recv}${ev.hook_event_name} prompt_id=${ev.prompt_id ?? '-'} agent_id=${ev.agent_id ?? '-'} agent_type=${ev.agent_type ?? '-'}${extra}`);
  }

  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', encoded, `${proc.claudeSessionId}.jsonl`);
  log(`\n--- session JSONL api-error entries (${fs.existsSync(jsonlPath) ? 'found' : 'MISSING'}) ---`);
  if (fs.existsSync(jsonlPath)) {
    for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.isApiErrorMessage || (e.type === 'system' && (e.subtype === 'turn_duration' || e.subtype === 'stop_hook_summary'))) {
        const textBlock = Array.isArray(e.message?.content) ? e.message.content.find((b) => b.type === 'text') : null;
        log(`  type=${e.type}${e.subtype ? `/${e.subtype}` : ''} model=${e.message?.model ?? '-'} stop_reason=${e.message?.stop_reason ?? '-'} isApiErrorMessage=${e.isApiErrorMessage ?? '-'} error=${e.error ?? '-'} text=${JSON.stringify(String(textBlock?.text ?? '').slice(0, 160))}`);
      }
    }
  }

  log('\n--- pane tail ---');
  try {
    const pane = await proc.runner.captureWide(proc.tmuxSession);
    log(pane.split('\n').filter((l) => l.trim()).slice(-14).map((l) => `  | ${l}`).join('\n'));
  } catch (err) { log(`  capture failed: ${err.message}`); }

  log('\n--- orchestra events (kind) ---');
  log(`  ${events.map((e) => `${e.at} ${e.kind}${e.detail?.code ? `:${e.detail.code}` : ''}${e.detail?.error ? `:${e.detail.error}` : ''}`).join('\n  ')}`);
  log('\n--- process events ---');
  log(`  ${procEvents.map((e) => `${e.at} ${e.name}${e.payload && Object.keys(e.payload).length ? ` ${JSON.stringify(e.payload)}` : ''}`).join('\n  ')}`);
  log(`\n--- bridge replies: ${replies.length} ---`);
  for (const r of replies) log(`  ${r.at} ${JSON.stringify(r.text.slice(0, 80))}`);
  log('\n--- stub requests ---');
  for (const r of stubLog) log(`  ${r.at} ${r.method} ${r.path} stream=${r.stream} tools=${r.tools} -> ${r.status}`);
  // ─── verdict ──────────────────────────────────────────────────────────────
  const failures = [];
  const expect = (ok, what) => { if (!ok) failures.push(what); };
  const t1 = outcomes['turn-1'];
  const rejectedWith = (o, kind) => o?.outcome === 'rejected' && o.err.code === 'CLAUDE_API_ERROR'
    && (kind == null || o.err.apiError === kind);
  if (INTERRUPT_AFTER_MS != null) {
    expect(t1?.outcome === 'resolved' && t1.result.metrics?.resultSubtype === 'interrupted',
      '/stop during retries resolves as interrupted (no API-error reply)');
  } else if (MODE === 'flaky') {
    expect(t1?.outcome === 'resolved' && replies.length > 0, 'a recovered retry is answered, not failed');
    expect(!events.some((e) => e.kind === 'cli-turn-api-error'), 'no API-error end for a recovered retry');
  } else {
    expect(rejectedWith(t1, MODE === '401' ? 'authentication_failed' : 'server_error'),
      'the failed turn rejects with CLAUDE_API_ERROR (not left pending)');
  }
  if (INJECT && MODE === 'fail') {
    const namedIds = procEvents.filter((e) => e.name === 'api-error').flatMap((e) => e.payload.anchorMsgIds || []);
    expect([...namedIds].sort().join(',') === [...INJECTED_MSG_IDS].sort().join(','),
      `every autosteered follow-up is named exactly once across api-error events (named ${JSON.stringify(namedIds)}, injected ${JSON.stringify(INJECTED_MSG_IDS)})`);
  }
  if (FOLLOWUP) {
    expect(rejectedWith(outcomes['turn-2']), 'a message after the failure runs as a fresh turn and fails on its own');
    expect(!events.some((e) => e.kind === 'cli-delivery-rewrite' || e.kind === 'cli-delivery-watchdog-escalate'),
      'no delivery-watchdog rewrite or bridge teardown while claude retries a queued cycle');
  }
  if (failures.length) {
    exitCode = 1;
    log(`\nFAIL\n  - ${failures.join('\n  - ')}`);
  } else {
    log('\nPASS');
  }
} catch (err) {
  exitCode = 1;
  log(`spike failed: ${err.stack || err.message}`);
  log('FAIL');
} finally {
  try { await proc.kill('spike-done'); } catch {}
  stub.close();
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    fs.rmSync(path.join(os.homedir(), '.claude', 'projects', encoded), { recursive: true, force: true });
  } catch {}
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);

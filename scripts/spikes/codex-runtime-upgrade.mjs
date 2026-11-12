// Isolated candidate runtime gate. Provider output is synthetic unless --live is set.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const orchestra = require('@shumkov/orchestra');
const { createCodexRuntimeProfileBuilder } = require('../../lib/codex/runtime-profile');
const { createPinnedCodexBinaryResolver } = require('../../lib/codex/binary');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const live = args.includes('--live');
const crash = args.includes('--fixture-crash');
const providerDenied = args.includes('--fixture-provider-denied');
assert(!(live && crash));
assert(!providerDenied || (!live && !crash));
const binary = option('--binary');
const base = option('--probe-root');
assert(binary && base, 'provide --binary and --probe-root');
const sha = text => createHash('sha256').update(text).digest('hex');
const root = fs.mkdtempSync(path.join(fs.realpathSync(base), live ? 'live-' : 'fixture-'));
fs.chmodSync(root, 0o700);
const dirs = Object.fromEntries(['codex', 'workspace', 'home', 'tmp', 'secrets'].map(name => {
  const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700 }); return [name, dir];
}));
const rootMarker = 'ROOT_' + randomUUID().replaceAll('-', '');
let memoryFact = 'MEMORY_' + randomUUID().replaceAll('-', '');
const skillNonce = 'SKILL_' + randomUUID().replaceAll('-', '');
fs.mkdirSync(path.join(dirs.workspace, 'memory'));
fs.writeFileSync(path.join(dirs.workspace, 'memory/shared.md'), `Calibration memory fact: ${memoryFact}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(dirs.workspace, 'AGENTS.md'), `Only work inside this synthetic workspace. Never inspect any other user/business files or credentials. For calibration requests, read memory/shared.md before answering, use the calibration-audit skill, and include the root instruction marker ${rootMarker} plus the memory fact and skill body nonce in the final answer. Do not invoke other agents or network tools.\n`, { mode: 0o600 });
fs.mkdirSync(path.join(dirs.workspace, 'skills/calibration-audit'), { recursive: true });
fs.writeFileSync(path.join(dirs.workspace, 'skills/calibration-audit/SKILL.md'), `---\nname: calibration-audit\ndescription: "Use for a calibration audit request."\n---\nRead this body, then include the skill body nonce ${skillNonce} in your final answer. Use a shell tool to write the exact text synthetic-tool-proof into tool-proof.txt in the current workspace; inspect no external paths.\n`, { mode: 0o600 });
fs.mkdirSync(path.join(dirs.workspace, '.agents'));
fs.symlinkSync('../skills', path.join(dirs.workspace, '.agents/skills'));
const externalAuth = !live || Boolean(option('--proxy-key-file'));
let authSource = null;
let originalAuthSha = null;
if (!externalAuth) {
  // Retain issued access credentials but remove shared refresh authority from the isolated clone.
  authSource = option('--auth-source') ?? path.join(os.homedir(), '.codex/auth.json');
  originalAuthSha = sha(fs.readFileSync(authSource));
  const auth = JSON.parse(fs.readFileSync(authSource, 'utf8'));
  assert(auth.tokens?.access_token && typeof auth.tokens.refresh_token === 'string');
  const access = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url'));
  assert(access.exp * 1000 > Date.now() + 15 * 60_000, 'access token must cover the bounded lane without refresh');
  auth.tokens.refresh_token = '';
  fs.writeFileSync(path.join(dirs.codex, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  fs.chmodSync(path.join(dirs.codex, 'auth.json'), 0o600);
}
const evidence = { os: { platform: process.platform, arch: process.arch, release: os.release() }, sessionLauncher: null, supervisor: 'Orchestra Node app-server supervisor', candidate: orchestra.codexProtocolSchema.cliVersion, live, root, logicalTurnsAttempted: 0, logicalTurnsCompleted: 0, fixtureHttpRequests: 0, fixtureWebSocketAttempts: 0, nativeTransportAttempts: live ? 'unknown' : 0, checkpoints: 0, checks: {} };
const clients = [];
const protocolTrace = [];
// Only source-backed field and item names may appear in diagnostics.
const traceKeys = new Set(['item', 'threadId', 'turnId', 'startedAtMs', 'completedAtMs', 'itemId', 'delta', 'name', 'status', 'error', 'failureReason', 'metadata']);
const traceItemTypes = new Set(['userMessage', 'hookPrompt', 'agentMessage', 'functionCallOutput', 'plan', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView', 'sleep', 'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction']);
function observeSpawn(...args) {
  const child = spawn(...args); let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > 1024 * 1024) { buffer = ''; return; }
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const message = JSON.parse(line); if (typeof message.method === 'string') {
        const shape = { method: [...orchestra.codexProtocolSchema.deliveredServerNotifications, ...orchestra.codexProtocolSchema.droppedServerNotifications, ...Object.keys(orchestra.codexProtocolSchema.deniedServerRequests)].includes(message.method) ? message.method : 'unknown', keys: Object.keys(message.params ?? {}).map(key => traceKeys.has(key) ? key : 'unknown'), itemType: traceItemTypes.has(message.params?.item?.type) ? message.params.item.type : typeof message.params?.item?.type, startedTimestampType: typeof message.params?.startedAtMs, completedTimestampType: typeof message.params?.completedAtMs };
        protocolTrace.push(shape);
        if (message.method === 'turn/moderationMetadata') evidence.moderationNotificationShape = shape;
        if (protocolTrace.length > 12) protocolTrace.shift();
      } } catch {}
    }
  }); return child;
}
const completedResults = [];
let server;
let held = null;
let holdNext = false;
function complete(response, text = 'fixture-ok') {
  const id = randomUUID();
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if ((args.includes('--fixture-tool') || crash) && evidence.fixtureHttpRequests === 1) {
    const item = { type: 'custom_tool_call', id: 'ctc-fixture', call_id: 'call-fixture', name: 'exec', input: 'text(await tools.exec_command({cmd:"printf synthetic-tool-proof > tool-proof.txt; cat memory/shared.md skills/calibration-audit/SKILL.md"}));' };
    if (crash) item.input = 'text(await tools.exec_command({cmd:"echo $$ > tool-pid.txt; exec /bin/sleep 30",yield_time_ms:1000}));';
    response.end(event('response.created', { response: { id } }) + event('response.output_item.added', { output_index: 0, item: { ...item, input: '' } }) + event('response.custom_tool_call_input.delta', { output_index: 0, item_id: item.id, delta: item.input }) + event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })); return;
  }
  response.end([
    event('response.created', { response: { id } }),
    event('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', id: 'message-' + id, content: [] } }),
    event('response.output_text.delta', { item_id: 'message-' + id, output_index: 0, content_index: 0, delta: text }),
    event('response.output_item.done', { output_index: 0, item: { type: 'message', role: 'assistant', id: 'message-' + id, content: [{ type: 'output_text', text }] } }),
    event('response.completed', { response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }),
  ].join(''));
}
async function waitFor(predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('bounded probe wait expired'); await new Promise(r => setTimeout(r, 25)); }
}
let proc;
try {
  let proxy;
  if (!live) {
    server = createServer((req, res) => {
      let bytes = 0;
      req.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
        const validBearer = req.headers.authorization === 'Bearer synthetic-key';
        evidence.checks.fixtureProviderBearer = evidence.checks.fixtureProviderBearer !== false && validBearer;
        evidence.fixtureHttpRequests++;
        if (providerDenied || !validBearer) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'synthetic provider denied', type: 'authentication_error', code: 'invalid_api_key' } })); return; }
        if (holdNext) { holdNext = false; held = res; } else complete(res);
      });
    });
    server.on('upgrade', (_req, socket) => { evidence.fixtureWebSocketAttempts++; socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const keyFile = path.join(dirs.secrets, 'proxy.key'); fs.writeFileSync(keyFile, 'synthetic-key', { mode: 0o600 });
    proxy = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, clientKeyFile: keyFile };
  } else if (option('--proxy-key-file')) {
    proxy = { baseUrl: option('--proxy-base-url'), clientKeyFile: option('--proxy-key-file') };
    evidence.provider = 'cliproxyapi';
  } else evidence.provider = 'openai';
  const receipt = await createPinnedCodexBinaryResolver()({ binaryPath: binary, env: {} });
  const builder = createCodexRuntimeProfileBuilder();
  const profile = await builder.prepare({ binaryReceipt: receipt, codexHome: dirs.codex, workspace: dirs.workspace, daemonSecretRoots: [dirs.secrets], model: 'gpt-6-astra', effort: 'high', processEnv: { HOME: dirs.home, TMPDIR: dirs.tmp, PATH: '/usr/bin:/bin' }, access: { mode: 'trusted', chatIds: ['1'], commandPath: '/usr/bin:/bin' }, ...(proxy ? { proxy } : {}) });
  builder.reattest(profile);
  evidence.checks.exactProfileBuilder = true;
  const preflight = await orchestra.preflightCodexRuntime(profile);
  evidence.auth = preflight.auth;
  assert.deepEqual(preflight.auth, externalAuth
    ? { authenticated: false, accountType: null, requiresOpenaiAuth: false }
    : { authenticated: true, accountType: 'chatgpt', requiresOpenaiAuth: true });
  evidence.checks.providerSpecificAuth = true;
  const spawnReceipt = orchestra.createCodexSpawnProfile(profile, preflight);
  const checkpointPath = path.join(root, 'checkpoints.jsonl');
  const notifications = [];
  const factory = orchestra.createProcessFactory({
    config: {}, logger: { info() {}, warn() {}, error() {} },
    codexHostIdentity: 'synthetic-host', codexBootSessionIdentity: 'synthetic-boot',
    codexExpectedStaticProfile: () => { builder.reattest(profile); return spawnReceipt; },
    codexClientFactory: ({ onNotification, onFault }) => {
      builder.reattest(profile);
      const client = new orchestra.CodexAppServerClient({ spawnFn: observeSpawn, binary, codexHome: dirs.codex, cwd: dirs.workspace, env: profile.env, expectedConfigSha256: profile.ownedConfigSha256, onNotification: async n => { notifications.push(n); await onNotification(n); }, onFault: error => { evidence.clientFault = { at: Date.now(), errorCode: error.errorCode, clientRootErrorCode: error.clientRootErrorCode, clientFaultClass: error.clientFaultClass, boundary: error.boundary, containment: error.containment, cleanup: error.cleanup, protocolTrace: [...protocolTrace] }; return onFault(error); } });
      clients.push(client); return client;
    },
    codexCheckpointSink: async checkpoint => {
      const fd = fs.openSync(checkpointPath, 'a', 0o600);
      try { fs.writeSync(fd, JSON.stringify(checkpoint) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      evidence.checkpoints++;
    },
  });
  const makeProcess = existingSessionId => factory('synthetic-session', { runtime: 'codex', spawnProfileId: spawnReceipt.spawnProfileId, modelSettings: { model: 'gpt-6-astra', effort: 'high' }, ...(existingSessionId ? { existingSessionId } : {}) });
  proc = makeProcess(); await proc.start(proc.spawnOptions);
  const thread = proc.providerSessionId;
  evidence.logicalTurnsAttempted++;
  const firstTurn = proc.send(live ? 'Perform the calibration audit and report the calibration result.' : 'Return fixture-ok.', { maxTurnMs: 120_000 });
  if (crash) {
    firstTurn.catch(() => {});
    const pidFile = path.join(dirs.workspace, 'tool-pid.txt');
    await waitFor(() => fs.existsSync(pidFile), 20_000);
    const table = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/); return m && { pid: Number(m[1]), parent: Number(m[2]), group: Number(m[3]), command: m[4] }; }).filter(Boolean);
    const supervisor = clients.at(-1).child.pid;
    const processes = table();
    const app = processes.find(p => p.parent === supervisor && p.command.includes('codex'));
    assert(app);
    const host = processes.find(p => p.parent === app.pid && p.command.includes('codex-code-mode-host'));
    const nested = processes.find(p => p.pid === Number(fs.readFileSync(pidFile, 'utf8').trim()));
    assert(host && nested && nested.command.includes('sleep'));
    assert.notEqual(host.group, app.group);
    evidence.crashIdentities = { app: { pid: app.pid, group: app.group }, host: { pid: host.pid, group: host.group }, nested: { pid: nested.pid, group: nested.group } };
    assert.equal(evidence.clientFault, undefined, 'no pre-existing client fault before crash injection');
    evidence.crashInjectedAt = Date.now();
    process.kill(app.pid, 'SIGKILL');
    try {
      await waitFor(() => { const now = table(); return !now.some(p => p.pid === host.pid || p.pid === nested.pid); }, 8_000);
    } finally {
      evidence.crashObservedAt = Date.now();
      evidence.crashSurvivors = table().filter(p => [app.pid, host.pid, nested.pid].includes(p.pid)).map(p => ({ role: p.pid === app.pid ? 'app-server' : p.pid === host.pid ? 'helper' : 'nested-command', pid: p.pid, parent: p.parent, group: p.group, command: p.command === '/bin/sleep' ? '/bin/sleep' : p.pid === host.pid ? 'codex-code-mode-host' : 'codex' }));
      for (const prior of [host, nested]) {
        const survivor = table().find(p => p.pid === prior.pid && p.group === prior.group && p.command === prior.command);
        if (survivor) { process.kill(survivor.pid, 'SIGKILL'); (evidence.ownedFixtureCleanup ??= []).push({ pid: survivor.pid, signal: 'SIGKILL' }); }
      }
      await waitFor(() => !table().some(p => [host.pid, nested.pid].includes(p.pid)), 5_000);
      evidence.checks.ownedFixtureProcessesAbsent = true;
    }
    await firstTurn.catch(() => {});
    evidence.checks.appServerSigkillHelperAndNestedCleanup = true;
    await proc.kill(); proc = null;
    evidence.outcome = 'passed';
  } else {
  const first = await firstTurn;
  if (!live) assert.equal(evidence.checks.fixtureProviderBearer, true);
  if (providerDenied) {
    assert.notEqual(first.error, null);
    assert.notEqual(first.metrics.resultSubtype, 'success');
    assert(evidence.fixtureHttpRequests > 0);
    evidence.providerDeniedHttpAttempts = evidence.fixtureHttpRequests;
    await proc.kill(); proc = null;
    evidence.checks.providerDeniedWithoutNativeFallback = true;
    evidence.outcome = 'passed';
  } else {
  assert.equal(first.error, null);
  assert.equal(first.metrics.resultSubtype, 'success');
  evidence.logicalTurnsCompleted++;
  completedResults.push(first);
  const answer = JSON.stringify(first);
  if (live) {
    evidence.checks.rootInstructionsConsumed = answer.includes(rootMarker);
    evidence.checks.unpromptedSyntheticMemory = answer.includes(memoryFact);
    evidence.checks.discoveredSkillBodyConsumed = answer.includes(skillNonce);
    evidence.checks.toolExecuted = fs.readFileSync(path.join(dirs.workspace, 'tool-proof.txt'), 'utf8').trim() === 'synthetic-tool-proof';
    assert(evidence.checks.rootInstructionsConsumed && evidence.checks.unpromptedSyntheticMemory && evidence.checks.discoveredSkillBodyConsumed && evidence.checks.toolExecuted);
  } else { assert(answer.includes('fixture-ok')); if (args.includes('--fixture-tool')) { assert.equal(fs.readFileSync(path.join(dirs.workspace, 'tool-proof.txt'), 'utf8'), 'synthetic-tool-proof'); evidence.checks.fixtureCodeModeTool = true; } }
  await proc.kill(); proc = null;
  const rollouts = fs.readdirSync(dirs.codex, { recursive: true }).filter(x => x.endsWith('.jsonl') && x.includes(thread));
  assert.equal(rollouts.length, 1);
  const rollout = fs.readFileSync(path.join(dirs.codex, rollouts[0]), 'utf8');
  assert(rollout.includes(live ? skillNonce : 'fixture-ok'));
  evidence.checks.authoritativeRollout = true;
  if (live && externalAuth) {
    memoryFact = 'MEMORY_UPDATED_' + randomUUID().replaceAll('-', '');
    fs.writeFileSync(path.join(dirs.workspace, 'memory/shared.md'), `Calibration memory fact: ${memoryFact}\n`, { mode: 0o600 });
  }
  proc = makeProcess(thread); await proc.start(proc.spawnOptions);
  assert.equal(proc.providerSessionId, thread);
  evidence.checks.freshProcessResume = true;
  if (!live) {
    holdNext = true;
    evidence.logicalTurnsAttempted++;
    const turn = proc.send('Hold a synthetic response for steering.', { maxTurnMs: 60_000 });
    turn.catch(() => {});
    await waitFor(() => held !== null && proc.state === 'Active');
    const steerOne = proc.steerTurn('first synthetic steer');
    const steerTwo = proc.steerTurn('second synthetic steer');
    const steers = await Promise.all([steerOne, steerTwo]);
    assert(steers.every(result => result.outcome === 'accepted' && result.turnId === proc.activeTurnId));
    evidence.checks.orderedSteerAccepted = true;
    complete(held, 'fixture-steered'); held = null;
    const result = await turn; assert.equal(result.error, null);
    assert.equal(result.metrics.resultSubtype, 'success');
    completedResults.push(result); evidence.logicalTurnsCompleted++;
    const steerClient = clients.at(-1);
    await assert.rejects(steerClient.request('turn/steer', { threadId: thread, expectedTurnId: 'stale', input: [{ type: 'text', text: 'stale synthetic steer' }] }, { onWriteAttempted: async checkpoint => fs.appendFileSync(checkpointPath, JSON.stringify(checkpoint) + '\n', { mode: 0o600 }), onResponseObserved: async checkpoint => fs.appendFileSync(checkpointPath, JSON.stringify(checkpoint) + '\n', { mode: 0o600 }) }), error => error.code === 'CODEX_RPC_ERROR' && error.rpcMessage === 'no active turn to steer');
    evidence.checks.staleSteerRejected = true;
    if (args.includes('--fixture-interrupt')) {
      holdNext = true;
      evidence.logicalTurnsAttempted++;
      const interrupted = proc.send('Hold a synthetic response for normal interruption.', { maxTurnMs: 60_000 });
      interrupted.catch(() => {});
      await waitFor(() => held !== null && proc.state === 'Active');
      const interruptedId = proc.activeTurnId;
      assert.equal(await proc.interrupt(), true);
      assert.equal((await interrupted).error, 'interrupted');
      const stop = fs.readFileSync(checkpointPath, 'utf8').trim().split('\n').map(JSON.parse).filter(c => ['stop-terminal-reconciled', 'stop-clean-accepted', 'stop-empty-registry-observed'].includes(c.kind));
      assert.deepEqual(stop.map(c => c.kind), ['stop-terminal-reconciled', 'stop-clean-accepted', 'stop-empty-registry-observed']);
      assert.equal(stop[0].turnId, interruptedId);
      assert(stop.every(c => c.threadId === thread));
      evidence.checks.normalInterruptAndDurableCleanup = true;
    }
  }
  else {
    const window = path.join(dirs.workspace, 'steer-window.txt');
    const semantic = 'STEER_' + randomUUID().replaceAll('-', '');
    evidence.logicalTurnsAttempted++;
    const turn = proc.send('For this synthetic resume check, use the shell tool to create steer-window.txt containing ready in this workspace, then run /bin/sleep 12 in the same shell command. After it completes, answer the root calibration request again. Do not inspect other paths.', { maxTurnMs: 120_000 });
    turn.catch(() => {});
    try { await waitFor(() => fs.existsSync(window) && proc.state === 'Active', 45_000); } catch { evidence.checks.liveSteerSetup = 'inconclusive'; throw Object.assign(new Error('live steer held-tool setup inconclusive'), { code: 'PROBE_SETUP_INCONCLUSIVE' }); }
    const target = proc.activeTurnId;
    const steered = await proc.steerTurn('Also include this exact synthetic marker in your final answer: ' + semantic);
    assert.equal(steered.outcome, 'accepted'); assert.equal(steered.turnId, target);
    const result = await turn;
    assert.equal(result.error, null); assert.equal(result.metrics.resultSubtype, 'success');
    completedResults.push(result); evidence.logicalTurnsCompleted++;
    assert.equal(result.providerTurnId, target); assert(result.text.includes(semantic));
    evidence.checks.liveResumeTurnAndSemanticSteer = true;
    if (externalAuth) {
      evidence.checks.freshResumeSharedMemoryEditConsumed = result.text.includes(memoryFact);
      assert(evidence.checks.freshResumeSharedMemoryEditConsumed);
    }
  }
  await proc.kill(); proc = null;
  const checkpoints = fs.readFileSync(checkpointPath, 'utf8').trim().split('\n').map(JSON.parse);
  for (const result of completedResults) {
    const own = checkpoints.filter(c => c.generationId === result.generationId);
    const write = own.findIndex(c => c.kind === 'request-write-attempted' && c.method === 'turn/start' && c.attemptId === result.attemptId);
    const started = own.findIndex(c => c.kind === 'turn-started' && c.turnId === result.providerTurnId && c.threadId === result.providerSessionId);
    const terminal = own.findIndex(c => c.kind === 'turn-terminal' && c.turnId === result.providerTurnId && c.threadId === result.providerSessionId && c.terminalStatus === 'completed');
    assert(write >= 0 && started > write && terminal > started);
    assert(own.some(c => c.kind === 'thread-initialized' && c.threadId === result.providerSessionId));
    assert(notifications.some(n => n.method === 'turn/completed' && n.params.threadId === result.providerSessionId && n.params.turn.id === result.providerTurnId && n.params.turn.status === 'completed'));
    assert(notifications.some(n => n.method === 'item/agentMessage/delta' && n.params.threadId === result.providerSessionId && n.params.turnId === result.providerTurnId));
  }
  evidence.checks.persistedCheckpointAndEventDelivery = true;
  if (authSource !== null) {
    assert.equal(sha(fs.readFileSync(authSource)), originalAuthSha);
    evidence.checks.sourceAuthUnchanged = true;
  }
  builder.reattest(profile);
  evidence.outcome = 'passed';
  }
  }
} catch (error) {
  evidence.outcome = 'failed';
  evidence.failure = { code: error.code ?? 'PROBE_ASSERTION', message: String(error.message).slice(0, 300) };
  process.exitCode = 1;
} finally {
  if (held) held.destroy();
  const cleanupErrors = [];
  if (proc) { try { await proc.kill(); } catch { cleanupErrors.push('process'); } }
  for (const client of clients) { try { await client.close(); } catch { cleanupErrors.push('client'); } }
  if (cleanupErrors.length) { evidence.outcome = 'failed'; evidence.cleanupErrors = cleanupErrors; process.exitCode = 1; }
  if (externalAuth) {
    evidence.checks.noNativeAuthFile = !fs.existsSync(path.join(dirs.codex, 'auth.json'));
    evidence.checks.nativeAuthSourceNotRead = authSource === null;
    if (!evidence.checks.noNativeAuthFile || !evidence.checks.nativeAuthSourceNotRead) { evidence.outcome = 'failed'; process.exitCode = 1; }
  } else {
    evidence.checks.sourceAuthUnchanged = sha(fs.readFileSync(authSource)) === originalAuthSha;
    evidence.checks.refreshAuthorityRemoved = JSON.parse(fs.readFileSync(path.join(dirs.codex, 'auth.json'), 'utf8')).tokens.refresh_token === '';
    if (!evidence.checks.sourceAuthUnchanged || !evidence.checks.refreshAuthorityRemoved) { evidence.outcome = 'failed'; process.exitCode = 1; }
  }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}

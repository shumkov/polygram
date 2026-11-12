import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudeGateSdkOptions, createClaudeGateSelection } from './claude-executable.mjs';
import { evaluatePendingAttribution, foregroundFixtureSleep, pendingAttributionFollowupReady } from './sdk-pending-attribution-oracle.mjs';
import { writeFixtureConsent } from './cli-fixture-prerequisites.mjs';

const require = createRequire(import.meta.url);
const { SdkProcess, makeInputController } = require('@shumkov/orchestra/lib/process/sdk-process');
const sdkVersion = globalThis[Symbol.for('polygram.gate.sdk')]?.version || JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')).version;
const gate = await createClaudeGateSelection();
writeFixtureConsent({ cwd: gate.sdkCwd, fixtureRoot: gate.artifactDir });
const privateDir = path.join(gate.artifactDir, 'raw-private');
fs.mkdirSync(privateDir, { mode: 0o700 });
const fd = fs.openSync(path.join(privateDir, 'sdk-stream.ndjson'), 'wx', 0o600);
const markers = [0, 1, 2].map((i) => `PENDING_${i}_${crypto.randomBytes(8).toString('hex')}`);
const inputController = makeInputController();
const q = query({
  prompt: inputController.iter,
  options: buildClaudeGateSdkOptions(gate, {
    permissionMode: 'auto', maxTurns: 12,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [async input => foregroundFixtureSleep(input)] }] },
    systemPrompt: 'This is a synthetic SDK compatibility fixture. Follow the requested bounded tasks exactly. Do not read credentials or access the network.',
  }),
});
const quiet = { error() {}, warn() {}, info() {} };
const proc = new SdkProcess({
  sessionKey: 'synthetic-pending-attribution', label: 'pending-attribution',
  spawnFn: () => ({ query: q, inputController }), logger: quiet,
});
const rawResults = [];
const resultErrors = new Map();
const taskIds = new Set();
const taskRuns = new Map();
const notifiedIds = new Set();
const completions = [];
let actualPermissionMode = null;
let followupsQueued = false;
let failure = null;
const context = (sourceMsgId) => ({
  sourceMsgId,
  streamer: { onChunk: async () => {}, finalize: async () => ({}), forceNewMessage() {}, flushDraft: async () => {}, discard: async () => {} },
  reactor: { setState() {}, heartbeat() {}, clear: async () => {}, stop() {} },
});
const sends = [];
function send(prompt, sourceMsgId) {
  const promise = proc.send(prompt, { timeoutMs: 150000, maxTurnMs: 180000, context: context(sourceMsgId) })
    .then((result) => {
      completions.push({ sourceMsgId, resultIsError: resultErrors.get(sourceMsgId) === true, markerMatches: markers.map((marker) => result.text.includes(marker)), error: result.error });
    }, (error) => {
      completions.push({ sourceMsgId, rejected: true, errorHash: crypto.createHash('sha256').update(String(error)).digest('hex') });
    });
  sends.push(promise);
}
const originalHandleEvent = proc._handleEvent;
proc._handleEvent = async function (message) {
  fs.writeSync(fd, `${JSON.stringify(message)}\n`);
  if (message.type === 'system' && message.subtype === 'init') actualPermissionMode = message.permissionMode;
  if (message.type === 'system' && message.subtype === 'task_started'
    && message.task_type === 'local_agent' && message.is_backgrounded === true
    && message.spawn_depth === 1) { taskIds.add(message.task_id); taskRuns.set(message.task_id, message.run_id || null); }
  if (message.type === 'system' && message.subtype === 'task_notification' && message.status === 'completed') notifiedIds.add(message.task_id);
  const before = this.pendingQueue.map((pending) => pending.context?.sourceMsgId);
  if (message.type === 'result') resultErrors.set(before[0], message.is_error === true);
  await originalHandleEvent.call(this, message);
  if (message.type === 'result') rawResults.push({
    originKind: message.origin?.kind || null, senderTaskId: message.origin?.senderTaskId || null, originRunId: message.origin?.runId || null,
    notificationTaskIds: [...notifiedIds].filter(id => taskIds.has(id)),
    subtype: message.subtype, isError: message.is_error === true, numTurns: message.num_turns,
    notificationCount: [...notifiedIds].filter((id) => taskIds.has(id)).length,
    textPresent: typeof message.result === 'string' && message.result.length > 0,
    before, after: this.pendingQueue.map((pending) => pending.context?.sourceMsgId),
  });
  if (!followupsQueued && pendingAttributionFollowupReady({ message, actualPermissionMode,
    firstUserCompleted: completions.some(c => c.sourceMsgId === 1 && !c.error && !c.rejected),
    pendingCount: this.pendingQueue.length, taskCount: taskIds.size, notificationCount: [...notifiedIds].filter(id => taskIds.has(id)).length })) {
    followupsQueued = true;
    send(`First run Bash sleep 30 in the foreground, then reply with exactly ${markers[1]}.`, 2);
    send(`Reply with exactly ${markers[2]}.`, 3);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outer = setTimeout(() => { failure = 'outer-deadline'; void proc.kill('outer-deadline'); }, 15 * 60 * 1000);
try {
  await proc.start(context(1));
  send(`Launch exactly two BACKGROUND subagents using the Task or Agent tool. Each must do only one Bash command: the first runs sleep 20 and the second sleep 22, then each reports its distinct name. After starting both, run one parent Bash sleep 30 so their reports can queue. Finally reply with exactly ${markers[0]}. Do not launch any other tasks.`, 1);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && evaluatePendingAttribution({ actualPermissionMode, failure, taskCount: taskIds.size, notificationCount: [...notifiedIds].filter(id => taskIds.has(id)).length, followupsQueued, rawResults, completions, tasks: [...taskRuns].map(([taskId, runId]) => ({ taskId, runId, notified: notifiedIds.has(taskId) })), requireEmptyWitness: sdkVersion === '0.3.322' }).status !== 'PASS') {
    if (proc.closed || (actualPermissionMode && actualPermissionMode !== 'auto')) break;
    await sleep(100);
  }
  if (Date.now() >= deadline) failure = 'observation-deadline';
} catch (error) {
  failure = crypto.createHash('sha256').update(String(error)).digest('hex');
} finally {
  clearTimeout(outer);
  await proc.kill('probe-complete');
  await Promise.allSettled(sends);
  gate.stopSdkProcessSampling();
  fs.closeSync(fd);
}
const evaluation = evaluatePendingAttribution({ actualPermissionMode, failure, taskCount: taskIds.size, notificationCount: [...notifiedIds].filter((id) => taskIds.has(id)).length, followupsQueued, rawResults, completions, tasks: [...taskRuns].map(([taskId, runId]) => ({ taskId, runId, notified: notifiedIds.has(taskId) })), requireEmptyWitness: sdkVersion === '0.3.322' });
const { status } = evaluation;
fs.writeFileSync(path.join(gate.artifactDir, 'focused-result.json'), `${JSON.stringify({
  status, attestation: gate.sanitizedAttestation, sdkVersion,
  actualPermissionMode, taskCount: taskIds.size, notificationCount: [...notifiedIds].filter((id) => taskIds.has(id)).length,
  followupsQueued, ...evaluation, rawResults, completions, failure,
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Focused pending attribution: ${status}`);
process.exitCode = status === 'FAIL' ? 1 : status === 'PASS' ? 0 : 2;

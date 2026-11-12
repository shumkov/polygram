
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const runtime = { sdkVersion: '0.3.322', cliVersion: '2.1.322' };
const marker = 'MCP-COMPLETE:synthetic';
function messages() {
  const task = { task_id: 'task', run_id: 'run', tool_use_id: 'tool', task_type: 'mcp_task', description: 'polygram-delayed-gate/delayed_marker' };
  const system = (subtype, fields = {}) => ({ type: 'system', subtype, session_id: 'session', ...fields });
  const terminal = fields => ({ type: 'result', subtype: 'success', is_error: false, session_id: 'session', ...fields });
  return [
    { type: 'assistant', session_id: 'session', message: { content: [{ type: 'tool_use', name: 'mcp__polygram-delayed-gate__delayed_marker', id: 'tool' }] } },
    system('background_tasks_changed', { tasks: [task] }), system('task_started', task),
    { type: 'user', session_id: 'session', message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] } },
    terminal({ result: 'waiting' }), system('task_updated', { ...task, patch: { status: 'completed' } }),
    system('task_notification', { ...task, status: 'completed' }), system('background_tasks_changed', { tasks: [] }),
    { type: 'assistant', session_id: 'session', message: { content: [{ type: 'text', text: marker }] } },
    terminal({ result: marker, origin: { kind: 'task-notification', producer: 'session-task', runId: 'run' } }),
  ];
}
async function moduleUnderTest() {
  return import(process.env.CLAUDE_GATE_DELAYED_MODULE || '../scripts/spikes/delayed-mcp-gate.mjs');
}
test('documented matched .322 completion-notification-clear order retains full native proof', async () => {
  const { createDelayedMcpLifecycleProof, evaluateDelayedMcpEvidence } = await moduleUnderTest();
  const evidence = { expectedMode: 'background', thresholdMs: 1000, handlerDurationMs: 5000, toolUseCount: 1,
    markerCount: 1, resultSubtype: 'success', toolResultBeforeHandlerCompletion: true,
    nativeLifecycleProof: createDelayedMcpLifecycleProof(messages(), { expectedMode: 'background', markerHash: hash(marker),
      asyncPlaceholder: true, timing: { asyncResultDelayMs: 1000, asyncResultLeadMs: 4000 } }) };
  assert.equal(evaluateDelayedMcpEvidence(evidence, runtime).pass, true);
  assert.equal(evaluateDelayedMcpEvidence(evidence).pass, false, 'legacy policy must not silently change');
  const reordered = structuredClone(evidence);
  reordered.nativeLifecycleProof.ordinals.membershipCleared = 6;
  assert.equal(evaluateDelayedMcpEvidence(reordered, runtime).pass, false);
});
test('matched task requires exact turn identities, statuses and final result marker', async () => {
  const { matchedDelayedMcpTurnsMatch } = await moduleUnderTest();
  const options = { ...runtime, expectedMode: 'background', markerHash: hash(marker) };
  assert.equal(matchedDelayedMcpTurnsMatch(messages(), options), true);
  const changes = [
    m => m.pop(), m => m.push(m.at(-1)), m => { m[9].is_error = true; }, m => { m[9].result = 'WRONG'; },
    m => { m[9].origin.runId = 'wrong'; }, m => { m[9].origin.producer = 'wrong'; }, m => { m[9].session_id = 'wrong'; },
    m => { m[5].patch.status = 'failed'; }, m => { m[6].status = 'failed'; }, m => { m[2].run_id = ''; },
    m => { m[1].tasks[0].run_id = 'wrong'; }, m => { m[5].run_id = 'wrong'; }, m => { m[6].tool_use_id = 'wrong'; },
    m => m.splice(5, 0, m[5]), m => { m[4].origin = { kind: 'peer' }; },
  ];
  for (const mutate of changes) { const m = messages(); mutate(m); assert.equal(matchedDelayedMcpTurnsMatch(m, options), false); }
  assert.equal(matchedDelayedMcpTurnsMatch(messages(), { ...options, sdkVersion: '0.3.283' }), false);
});
test('SDK preloader binds ESM and CJS to one exact loaded source and rejects drift before launch', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matched-sdk-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.322', claudeCodeVersion: '2.1.322' }));
  fs.writeFileSync(path.join(temp, 'sdk.mjs'), 'export function query() {} export const marker = "synthetic-sdk";');
  const { inspectSdkRuntime } = require('../scripts/spikes/gate-sdk-runtime.cjs');
  const expected = inspectSdkRuntime(temp).identity;
  const source = require.resolve('@shumkov/orchestra/lib/process/sdk-process');
  const proof = path.join(temp, 'proof.json');
  const env = { PATH: process.env.PATH, CLAUDE_GATE_SDK_ROOT: temp, CLAUDE_GATE_SDK_EXPECTED: JSON.stringify(expected),
    CLAUDE_GATE_EXPECTED_VERSION: '2.1.322', CLAUDE_GATE_RUN_ID: 'synthetic', CLAUDE_GATE_SDK_ATTESTATION_PATH: proof,
    CLAUDE_GATE_ORCHESTRA_SOURCE_SHA256: hash(fs.readFileSync(source)) };
  const loader = path.join(root, 'scripts/spikes/gate-sdk-runtime.cjs');
  const script = 'import sdk from "node:module"; import * as actual from "@anthropic-ai/claude-agent-sdk"; const cjs=sdk.createRequire(import.meta.url)("@anthropic-ai/claude-agent-sdk"); if(actual.query!==cjs.query || actual.marker!=="synthetic-sdk") throw Error("wrong source");';
  const result = spawnSync(process.execPath, ['--require', loader, '--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(proof)), { runId: 'synthetic', identity: expected, orchestraSourceSha256: env.CLAUDE_GATE_ORCHESTRA_SOURCE_SHA256, loaded: true });
  for (const broken of [{ ...expected, entrySha256: '0'.repeat(64) }, { ...expected, version: '0.3.283' }]) {
    const bad = spawnSync(process.execPath, ['--require', loader, '-e', 'throw Error("script must not launch")'], { env: { ...env, CLAUDE_GATE_SDK_EXPECTED: JSON.stringify(broken) }, encoding: 'utf8' });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /SDK identity does not match/);
  }
});


test('matched task rejects foreign-session tool, clear and marker frames', async () => {
  const { matchedDelayedMcpTurnsMatch } = await moduleUnderTest();
  for (const index of [0, 3, 7, 8]) {
    const m = messages(); m[index].session_id = 'foreign';
    assert.equal(matchedDelayedMcpTurnsMatch(m, { ...runtime, expectedMode: 'background', markerHash: hash(marker) }), false);
  }
});

test('matched old foreground distinguishes successful subtype from error completion', async () => {
  const { matchedDelayedMcpTurnsMatch } = await moduleUnderTest();
  const m = [{ type: 'result', subtype: 'success', is_error: false }];
  const old = { sdkVersion: '0.3.283', cliVersion: '2.1.283', expectedMode: 'foreground' };
  assert.equal(matchedDelayedMcpTurnsMatch(m, old), true);
  m[0].is_error = true;
  assert.equal(matchedDelayedMcpTurnsMatch(m, old), false);
});

test('persisted SDK load proof cannot hide a later Orchestra source change', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matched-source-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'sdk-process.js'); fs.writeFileSync(source, 'before');
  const sourceHash = hash('before'); const proof = path.join(temp, 'proof.json');
  const identity = { version: '0.3.322' };
  fs.writeFileSync(proof, JSON.stringify({ runId: 'synthetic', identity, orchestraSourceSha256: sourceHash, loaded: true }), { mode: 0o600 });
  const { assertSdkLoadProof } = require('../scripts/spikes/gate-sdk-runtime.cjs');
  const args = { proofPath: proof, identity, runId: 'synthetic', orchestraSourceSha256: sourceHash, orchestraSourcePath: source };
  assert.doesNotThrow(() => assertSdkLoadProof(args));
  fs.writeFileSync(source, 'changed');
  assert.throws(() => assertSdkLoadProof(args), /Orchestra source/);
});

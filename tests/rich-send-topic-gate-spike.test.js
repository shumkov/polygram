'use strict';

/**
 * Verdict logic for the live rich-send gate.
 *
 * The spike itself needs a real bot token and a real chat, so the part that
 * decides what the run MEANS is separated out and tested here. That decision
 * selects between shipping direct rich sends and falling back to the
 * plain-send-then-rich-edit contingency, so getting it wrong is expensive in
 * a way the network calls around it are not.
 *
 * The redactor is covered here too: this script is the one place in the tree
 * that handles a live token, and its output is explicitly meant to be pasted
 * elsewhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SPIKE = pathToFileURL(
  path.join(__dirname, '..', 'scripts', 'spikes', 'rich-send-topic-gate.mjs'),
).href;

const load = () => import(SPIKE);

const rows = (o) => Object.entries(o).map(([key, status]) => ({ key, status }));

test('importing the spike does not start a live run', async () => {
  // Guarding the entrypoint is what makes any of this testable; without it,
  // importing the module fires real Telegram sends from the operator's config.
  const mod = await load();
  assert.equal(typeof mod.classifyGateRun, 'function');
  assert.equal(typeof mod.redact, 'function');
});

test('both probes honored — direct send is safe', async () => {
  const { classifyGateRun } = await load();
  const out = classifyGateRun(rows({ control: 'pass', A: 'pass', B: 'pass', C: 'pass', D: 'pass' }));
  assert.equal(out.verdict, 'DIRECT_SEND');
  assert.equal(out.exitCode, 0);
});

test('a dropped topic selects the contingency', async () => {
  const { classifyGateRun } = await load();
  const out = classifyGateRun(rows({ control: 'pass', A: 'fail', B: 'pass' }));
  assert.equal(out.verdict, 'CONTINGENCY');
  assert.equal(out.exitCode, 1);
});

test('a dropped reply anchor selects the contingency', async () => {
  const { classifyGateRun } = await load();
  const out = classifyGateRun(rows({ control: 'pass', A: 'pass', B: 'fail' }));
  assert.equal(out.verdict, 'CONTINGENCY');
  assert.equal(out.exitCode, 1);
});

test('a failed control makes the run inconclusive, not a contingency verdict', async () => {
  // A and B are measured against that topic. If a plain send never reached
  // it, their results describe nothing, and reading them as "the verb drops
  // the thread id" would pick the contingency on no evidence.
  const { classifyGateRun } = await load();
  const out = classifyGateRun(rows({ control: 'fail', A: 'fail', B: 'fail' }));
  assert.equal(out.verdict, 'INCONCLUSIVE');
  assert.equal(out.exitCode, 1);
});

test('skipped probes are inconclusive rather than silently passing', async () => {
  const { classifyGateRun } = await load();
  const out = classifyGateRun(rows({ control: 'skip', A: 'skip', B: 'skip', C: 'pass' }));
  assert.equal(out.verdict, 'INCONCLUSIVE');
  assert.deepEqual(out.unanswered, ['control', 'A', 'B']);
  assert.equal(out.exitCode, 1);
});

test('a missing probe is treated as unanswered, not as a pass', async () => {
  const { classifyGateRun } = await load();
  const out = classifyGateRun(rows({ control: 'pass', A: 'pass' }));
  assert.equal(out.verdict, 'INCONCLUSIVE');
  assert.deepEqual(out.unanswered, ['B']);
});

test('the informational media probes never change the decision or the exit code', async () => {
  // Reporting DIRECT SEND IS SAFE and then exiting non-zero because an
  // optional media probe failed reads as a failed gate to anything scripting
  // this, and to whoever runs it.
  const { classifyGateRun } = await load();
  const out = classifyGateRun(rows({ control: 'pass', A: 'pass', B: 'pass', C: 'fail', D: 'fail' }));
  assert.equal(out.verdict, 'DIRECT_SEND');
  assert.equal(out.exitCode, 0, 'a decided gate must not exit non-zero on optional probes');
  assert.deepEqual(out.informationalFailures, ['C', 'D']);
});

// ─── Redaction ─────────────────────────────────────────────────────────────

test('bot tokens and URL credentials are removed from anything printed', async () => {
  const { redact } = await load();

  const token = redact('request to https://api.telegram.org/bot7712345678:AAHsecretXYZ/send failed');
  assert.ok(!token.includes('AAHsecretXYZ'), token);

  const creds = redact('http://svc:hunter2@bot-api.internal:8081/bot7712345678:AAHsec/send');
  assert.ok(!creds.includes('hunter2'), creds);
  assert.ok(!creds.includes('AAHsec'), creds);
});

test('a password containing an @ is removed whole', async () => {
  // The naive userinfo pattern cuts at the first '@' and leaves the rest of
  // the password in the output.
  const { redact } = await load();
  const out = redact('connect failed: https://alice:p@ss@example.com/x');
  assert.ok(!out.includes('ss@example') && !out.includes('p@ss'), out);
});

test('redaction survives non-string input', async () => {
  const { redact } = await load();
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
});

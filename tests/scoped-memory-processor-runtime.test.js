'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = '../scripts/spikes/memory-processor-gate';

function response({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: { cancel: async () => {} },
    text: async () => JSON.stringify(body),
  };
}

test('Anthropic direct processor normalizes the raw response handed to it by the shared harness', async () => {
  const { createDirectProcessor } = await import(`${ROOT}/anthropic-runtime/runtime.mjs`);
  const processor = createDirectProcessor({ apiKey: 'synthetic-test-key' });
  assert.match(processor.configHash, /^[a-f0-9]{64}$/);
  const normalized = processor.normalize({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"candidates":[]}' }],
    usage: { input_tokens: 3, output_tokens: 2 },
  });
  assert.equal(normalized.stopReason, 'end_turn');
  assert.equal(normalized.content, '{"candidates":[]}');
  assert.equal(normalized.usage.inputTokens, 3);
});

test('local dependency-injected runner cannot produce admissible G3 evidence', async () => {
  const { runBoundedLocalGate, runLocalGateTestCore } = await import(`${ROOT}/local-runtime/runner.mjs`);
  assert.equal(typeof runLocalGateTestCore, 'function');
  await assert.rejects(
    runBoundedLocalGate({ platform: 'linux' }),
    /LOCAL_RUNTIME_SEALED_COLLECTOR_REQUIRED/,
  );
});

test('Anthropic direct retry policy records attempts and retries only registered transient statuses', async () => {
  const { invokeDirectMessage, retryDelayMs } = await import(`${ROOT}/anthropic-runtime/runtime.mjs`);
  assert.notEqual(
    retryDelayMs({ retryAfter: null, retryIndex: 0, randomValue: 0 }),
    retryDelayMs({ retryAfter: null, retryIndex: 0, randomValue: 1 }),
  );
  const replies = [
    response({ status: 529 }),
    response({
      body: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"candidates":[]}' }],
      },
    }),
  ];
  const sleeps = [];
  const fetchOptions = [];
  const invocation = await invokeDirectMessage({ model: 'test' }, {
    apiKey: 'synthetic-test-key',
    fetchImpl: async (_url, options) => {
      fetchOptions.push(options);
      return replies.shift();
    },
    sleepImpl: async (delay) => sleeps.push(delay),
    monotonicMs: (() => { let now = 0; return () => { now += 5; return now; }; })(),
    random: () => 0.5,
  });
  assert.equal(invocation.attemptCount, 2);
  assert.deepEqual(invocation.retryStatuses, [529]);
  assert.deepEqual(sleeps, [1000]);
  assert.ok(fetchOptions.every((options) => options.redirect === 'error'));
});

test('Anthropic retries share one hard 60-second job deadline', async () => {
  const { invokeDirectMessage } = await import(`${ROOT}/anthropic-runtime/runtime.mjs`);
  let virtualMs = 0;
  const replies = [
    response({ status: 529, headers: { 'retry-after': '59' } }),
    response({ status: 529 }),
  ];
  await assert.rejects(
    invokeDirectMessage({ model: 'test' }, {
      apiKey: 'synthetic-test-key',
      fetchImpl: async () => replies.shift(),
      sleepImpl: async (delayMs) => { virtualMs += delayMs; },
      nowMs: () => 1_000_000 + virtualMs,
      monotonicMs: () => virtualMs,
    }),
    { code: 'ANTHROPIC_JOB_DEADLINE' },
  );
});

test('Anthropic non-2xx body cancellation cannot stall the job deadline', { timeout: 100 }, async () => {
  const { invokeDirectMessage } = await import(`${ROOT}/anthropic-runtime/runtime.mjs`);
  const stalled = response({ status: 400 });
  stalled.body.cancel = async () => new Promise(() => {});
  await assert.rejects(
    invokeDirectMessage({ model: 'test' }, {
      apiKey: 'synthetic-test-key',
      fetchImpl: async () => stalled,
    }),
    { code: 'ANTHROPIC_HTTP_FAILED' },
  );
});

test('Anthropic missing or unverified usage can never be exact zero-dollar evidence', async () => {
  const { exactDirectCost } = await import(`${ROOT}/anthropic-runtime/runtime.mjs`);
  assert.equal(exactDirectCost({}).exact, false);
  assert.equal(exactDirectCost({ inputTokens: 0, outputTokens: 0 }).exact, false);
  assert.equal(exactDirectCost({
    inputTokens: 10,
    outputTokens: 2,
    serviceTier: 'standard',
    inferenceGeo: 'global',
  }).exact, true);
});

test('Anthropic durable evidence keeps text-free per-fixture outcomes for auditability', async () => {
  const { buildDurableEvidence } = await import(`${ROOT}/anthropic-runtime/runtime.mjs`);
  const { hashFixtureManifest, loadFixtureCorpus } = await import(`${ROOT}/fixtures.mjs`);
  const canonicalManifestHash = hashFixtureManifest(loadFixtureCorpus().gate);
  const fixtureEvidence = {
    fixtureId: 'gate-001',
    status: 'ok',
    errorCode: null,
    attemptCount: 1,
    candidateCount: 1,
    responseHash: 'a'.repeat(64),
    elapsedMs: 20,
    usage: { inputTokens: 10, outputTokens: 4 },
    safety: { rawSecretHits: 0 },
  };
  const fixtureRows = Array.from({ length: 200 }, (_, index) => ({
    ...fixtureEvidence,
    fixtureId: `gate-${String(index + 1).padStart(3, '0')}`,
  }));
  const evidence = {
    runId: 'run-1', fixtureCount: 200,
    processorId: 'anthropic-test', processorConfigHash: 'a'.repeat(64),
    promptHash: 'b'.repeat(64), schemaHash: 'c'.repeat(64), fixtureManifestHash: canonicalManifestHash,
    passed: true,
    fixtures: fixtureRows,
    score: {
      extraction: { precision: 1 }, routing: { accuracy: 1, total: 170 },
      privateRecall: { recall: 1, total: 64 },
      criticalPrivateToGeneral: 0, instructionShapedWrites: 0,
      instructionRejection: { correct: 12, total: 12 },
    },
    safety: { rawSecretHits: 0 },
  };
  const durable = buildDurableEvidence({
    shapeCheck: { evidence: { ...evidence, runId: 'shape', fixtureCount: 1 } },
    runs: [{ evidence }, { evidence: { ...evidence, runId: 'run-2' } }, { evidence: { ...evidence, runId: 'run-3' } }],
    retentionMode: 'standard',
    approvedSyntheticEgress: true,
  });
  assert.equal(durable.processor.id, 'anthropic-test');
  assert.equal(durable.processor.configHash, 'a'.repeat(64));
  assert.deepEqual(durable.execution.runs[0].fixtures[0], fixtureEvidence);
  assert.equal(durable.execution.runs[0].fixtures.length, 200);
  assert.equal(Object.hasOwn(durable.execution.runs[0].fixtures[0], 'fact'), false);
});

test('local tokenizer preflight enforces the exact 8192-token reservation boundary', async () => {
  const { assertTokenBudget, preflightTokenBudget } = await import(`${ROOT}/local-runtime/token-budget.mjs`);
  assert.equal(assertTokenBudget({ inputTokens: 6144 }).remainingTokens, 0);
  assert.throws(
    () => assertTokenBudget({ inputTokens: 6145 }),
    /LOCAL_RUNTIME_CONTEXT_BUDGET_EXCEEDED/,
  );
  const endpoints = [];
  const preflight = await preflightTokenBudget({
    providerRequest: { messages: [{ role: 'user', content: '界'.repeat(16000) }] },
    postJson: async (endpoint) => {
      endpoints.push(endpoint);
      if (endpoint === '/apply-template') return { prompt: '<prompt>' };
      return { tokens: Array.from({ length: 6144 }, (_, index) => index) };
    },
    now: (() => { let now = 0; return () => { now += 1; return now; }; })(),
  });
  assert.equal(preflight.reservedTokens, 8192);
  assert.deepEqual(endpoints, ['/apply-template', '/tokenize']);
});

test('local runtime command is code-pinned and rejects missing isolation or no-log flags', async () => {
  const { LLAMA_SERVER_COMMAND } = await import(`${ROOT}/adapters/llama.mjs`);
  const { attestServerCommand } = await import(`${ROOT}/local-runtime/attestation.mjs`);
  assert.equal(attestServerCommand(LLAMA_SERVER_COMMAND).passed, true);
  for (const required of ['--offline', '--log-disable', '--no-webui', '--no-slots', '--no-cache-prompt']) {
    const index = LLAMA_SERVER_COMMAND.indexOf(required);
    assert.ok(index >= 0, required);
    const drifted = LLAMA_SERVER_COMMAND.filter((_, itemIndex) => itemIndex !== index);
    assert.throws(() => attestServerCommand(drifted), /LOCAL_RUNTIME_SERVER_COMMAND_DRIFT/, required);
  }
});

test('local runtime rejects entrypoint, environment, and extra-mount drift independently of caller expectations', async () => {
  const { LLAMA_SERVER_COMMAND } = await import(`${ROOT}/adapters/llama.mjs`);
  const { attestEntrypointEnvironment, attestMountInventory } = await import(`${ROOT}/local-runtime/attestation.mjs`);
  const imageInspect = {
    Config: { Entrypoint: ['/app/llama-server'], Env: ['PATH=/usr/bin'] },
  };
  const containerInspect = {
    Path: '/app/llama-server',
    Args: [...LLAMA_SERVER_COMMAND],
    Config: {
      Entrypoint: ['/app/llama-server'],
      Cmd: [...LLAMA_SERVER_COMMAND],
      Env: ['PATH=/usr/bin'],
    },
  };
  assert.equal(attestEntrypointEnvironment({ imageInspect, containerInspect }).passed, true);
  assert.throws(
    () => attestEntrypointEnvironment({
      imageInspect,
      containerInspect: { ...containerInspect, Path: '/bin/sh' },
    }),
    /LOCAL_RUNTIME_CONTAINER_ENTRYPOINT_INVALID/,
  );
  assert.throws(
    () => attestEntrypointEnvironment({
      imageInspect,
      containerInspect: {
        ...containerInspect,
        Config: { ...containerInspect.Config, Env: ['PATH=/usr/bin', 'LD_PRELOAD=/tmp/inject.so'] },
      },
    }),
    /LOCAL_RUNTIME_CONTAINER_ENVIRONMENT_INVALID/,
  );
  assert.throws(
    () => attestMountInventory([
      { Type: 'bind', Destination: '/models/Qwen3-4B-Q4_K_M.gguf', RW: false },
      { Type: 'bind', Destination: '/run/llama', RW: true },
      { Type: 'volume', Destination: '/unexpected', RW: true },
    ]),
    /LOCAL_RUNTIME_CONTAINER_EXTRA_MOUNT/,
  );
});

test('local worst-run selection always prefers a failed run and reports instruction rejection', async () => {
  const { summarizeGateRuns } = await import(`${ROOT}/local-runtime/runner.mjs`);
  const { hashFixtureManifest, loadFixtureCorpus } = await import(`${ROOT}/fixtures.mjs`);
  const canonicalManifestHash = hashFixtureManifest(loadFixtureCorpus().gate);
  const fixtureEvidence = Array.from({ length: 200 }, (_, index) => ({
    fixtureId: `gate-${String(index + 1).padStart(3, '0')}`,
    elapsedMs: 10,
  }));
  const run = (runIndex, passed) => ({
    runIndex,
    passed,
    evaluation: {
      fixtureCount: 200,
      fixtures: fixtureEvidence,
      processorId: 'local-test',
      processorConfigHash: 'a'.repeat(64),
      promptHash: 'b'.repeat(64),
      schemaHash: 'c'.repeat(64),
      fixtureManifestHash: canonicalManifestHash,
      score: {
        extraction: { precision: 1 }, routing: { accuracy: 1, total: 170 },
        privateRecall: { recall: 1, total: 64 },
        criticalPrivateToGeneral: 0, instructionShapedWrites: 0,
        instructionRejection: { correct: passed ? 12 : 11, total: 12 },
      },
      safety: { rawSecretHits: 0 },
    },
    runtime: { failureCount: 0, timeoutCount: 0, latencyMs: { p95: 10 } },
    resources: { passed: true, memoryPeakBytes: 1, swapCurrentBytes: 0, oomDelta: 0, oomKillDelta: 0 },
  });
  const summary = summarizeGateRuns([run(1, true), run(2, false), run(3, true)]);
  assert.equal(summary.passed, false);
  assert.equal(summary.worstRunIndex, 2);
  assert.deepEqual(summary.worstRun.instructionRejection, { correct: 11, total: 12 });
});

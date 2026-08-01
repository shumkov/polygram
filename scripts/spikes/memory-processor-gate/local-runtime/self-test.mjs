#!/usr/bin/env node

import assert from 'node:assert/strict';

import { LLAMA_RUNTIME, LLAMA_SERVER_COMMAND } from '../adapters/llama.mjs';
import { hashFixtureManifest, loadFixtureCorpus } from '../fixtures.mjs';
import { attestDockerRuntime } from './attestation.mjs';
import { runBoundedLocalGate, runLocalGateTestCore } from './runner.mjs';
import { assertTokenBudget } from './token-budget.mjs';

const modelPath = `/tmp/${LLAMA_RUNTIME.modelFile}`;
const socketDirectory = '/tmp/scoped-memory-local-gate';
const hostSocketPath = `${socketDirectory}/extractor.sock`;
const imageId = `sha256:${'a'.repeat(64)}`;
const command = [...LLAMA_SERVER_COMMAND];
const environment = ['PATH=/usr/bin'];
const entrypoint = ['/app/llama-server'];
const expectedContainer = {
  command,
  environment,
  user: '65532:65532',
  workingDirectory: '',
  mounts: [
    {
      source: modelPath,
      destination: `/models/${LLAMA_RUNTIME.modelFile}`,
      readWrite: false,
    },
    {
      source: socketDirectory,
      destination: '/run/llama',
      readWrite: true,
    },
  ],
};
const imageInspect = {
  Id: imageId,
  RepoDigests: [LLAMA_RUNTIME.imageReference],
  Os: 'linux',
  Architecture: 'amd64',
  Config: { Entrypoint: entrypoint, Env: environment },
};
const containerInspect = {
  Image: imageId,
  Path: entrypoint[0],
  Args: command,
  State: { Running: true, OOMKilled: false },
  Config: {
    Image: LLAMA_RUNTIME.imageReference,
    Entrypoint: entrypoint,
    Cmd: command,
    Env: environment,
    User: '65532:65532',
    WorkingDir: '',
  },
  HostConfig: {
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    Privileged: false,
    CapDrop: ['ALL'],
    CapAdd: [],
    SecurityOpt: ['no-new-privileges:true', 'seccomp=builtin'],
    Memory: LLAMA_RUNTIME.memoryLimitBytes,
    MemorySwap: LLAMA_RUNTIME.memoryLimitBytes,
    MemorySwappiness: 0,
    RestartPolicy: { Name: 'no' },
    AutoRemove: true,
    PidsLimit: LLAMA_RUNTIME.pidsLimit,
    NanoCpus: LLAMA_RUNTIME.nanoCpus,
    Tmpfs: {
      '/tmp': `rw,noexec,nosuid,nodev,size=${LLAMA_RUNTIME.tmpfs.sizeBytes}`,
    },
    Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
    PortBindings: {},
    Devices: [],
    DeviceRequests: [],
  },
  NetworkSettings: { Ports: {} },
  Mounts: expectedContainer.mounts.map((mount) => ({
    Type: 'bind',
    Source: mount.source,
    Destination: mount.destination,
    RW: mount.readWrite,
    Propagation: 'rprivate',
  })),
};
const fixtures = loadFixtureCorpus().gate;
const fixtureEvidence = fixtures.map((fixture) => ({
  fixtureId: fixture.id,
  elapsedMs: 1,
}));
const resourceSnapshot = {
  memoryPeakBytes: 3 * 1024 ** 3,
  swapCurrentBytes: 0,
  oomCount: 0,
  oomKillCount: 0,
  cpuUsageUsec: 1,
  cpuThrottledUsec: 0,
};
const completion = {
  choices: [{
    finish_reason: 'stop',
    message: { content: '{"candidates":[]}' },
  }],
  usage: {
    prompt_tokens: 2,
    completion_tokens: 4,
    total_tokens: 6,
  },
};
const transport = {
  kind: 'unix-domain-socket',
  socketPath: hostSocketPath,
  async postJson(endpoint) {
    if (endpoint === '/apply-template') return { prompt: 'applied prompt' };
    if (endpoint === '/tokenize') return { tokens: [1, 2] };
    if (endpoint === LLAMA_RUNTIME.apiPath) return structuredClone(completion);
    throw new Error('unexpected endpoint');
  },
};

assert.equal(assertTokenBudget({ inputTokens: 6_144 }).remainingTokens, 0);
assert.throws(
  () => assertTokenBudget({ inputTokens: 6_145 }),
  { code: 'LOCAL_RUNTIME_CONTEXT_BUDGET_EXCEEDED' },
);
assert.throws(
  () => attestDockerRuntime({
    imageInspect,
    containerInspect: {
      ...containerInspect,
      HostConfig: { ...containerInspect.HostConfig, NetworkMode: 'bridge' },
    },
    expectedContainer,
  }),
  { code: 'LOCAL_RUNTIME_CONTAINER_NETWORK_INVALID' },
);

await assert.rejects(
  runBoundedLocalGate({ platform: 'linux' }),
  { code: 'LOCAL_RUNTIME_SEALED_COLLECTOR_REQUIRED' },
);

const result = await runLocalGateTestCore({
  fixtures,
  modelPath,
  imageInspect,
  containerInspect,
  expectedContainer,
  hostSocketPath,
  transport,
  resourceSampler: async () => resourceSnapshot,
  platform: 'linux',
  inspectModel: async () => ({
    bytes: LLAMA_RUNTIME.modelBytes,
    sha256: LLAMA_RUNTIME.modelSha256,
  }),
  evaluateRun: async ({ processor }) => {
    const request = processor.buildRequest({
      contract_version: 'memory-extraction/v1',
      routing_mode: 'extract-only',
      consumed_inbound_text: [],
      delivered_outbound_text: [],
    });
    const response = await processor.invoke(request);
    assert.equal(processor.normalize(response).content, '{"candidates":[]}');
    return {
      evidence: {
        passed: true,
        fixtureCount: 200,
        fixtures: fixtureEvidence,
        processorId: processor.id,
        processorConfigHash: processor.configHash,
        promptHash: 'b'.repeat(64),
        schemaHash: 'c'.repeat(64),
        fixtureManifestHash: hashFixtureManifest(fixtures),
        score: {
          extraction: { precision: 1 },
          routing: { accuracy: 1, total: 170 },
          privateRecall: { recall: 1, total: 64 },
          criticalPrivateToGeneral: 0,
          instructionShapedWrites: 0,
          instructionRejection: { correct: 12, total: 12 },
        },
        safety: { rawSecretHits: 0 },
      },
    };
  },
});

assert.equal(result.admissible, false);
assert.equal(result.passed, false);
assert.equal(result.evaluationPassed, true);
assert.equal(result.runs.length, 3);
assert.ok(result.summary.worstRunIndex >= 1 && result.summary.worstRunIndex <= 3);
assert.equal(JSON.stringify(result).includes('applied prompt'), false);
assert.equal(JSON.stringify(result).includes(modelPath), false);

await assert.rejects(
  runLocalGateTestCore({
    fixtures,
    modelPath,
    imageInspect,
    containerInspect,
    expectedContainer,
    hostSocketPath,
    transport: {
      kind: 'unix-domain-socket',
      socketPath: hostSocketPath,
      postJson: async () => new Promise(() => {}),
    },
    resourceSampler: async () => resourceSnapshot,
    platform: 'linux',
    inspectModel: async () => ({
      bytes: LLAMA_RUNTIME.modelBytes,
      sha256: LLAMA_RUNTIME.modelSha256,
    }),
    timers: {
      setTimer(callback) {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer() {},
    },
  }),
  { code: 'LOCAL_RUNTIME_JOB_DEADLINE' },
);
process.stdout.write('local-runtime self-test: PASS\n');

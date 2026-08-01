import crypto from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildLlamaRequest, LLAMA_RUNTIME, normalizeLlamaResponse } from '../adapters/llama.mjs';
import {
  PROCESSOR_JSON_SCHEMA,
  validateProcessorOutput,
} from '../contract.mjs';
import { evaluateProcessorRun } from '../harness.mjs';
import { summarizeGateRuns as summarizeQualityGateRuns } from '../multi-run.mjs';
import {
  attestDockerRuntime,
  attestModelArtifact,
  inspectModelFile,
  sha256Json,
  stableJson,
} from './attestation.mjs';
import { summarizeResourceWindow } from './resources.mjs';
import { preflightTokenBudget } from './token-budget.mjs';
import { assertUnixTransport, createUnixJsonTransport } from './uds-client.mjs';

export const LOCAL_GATE_RUN_COUNT = 3;
export const LOCAL_JOB_DEADLINE_MS = 60_000;

export class LocalRuntimeGateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalRuntimeGateError';
    this.code = code;
  }
}

function fail(code) {
  throw new LocalRuntimeGateError(code);
}

function finiteDuration(value) {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^LOCAL_RUNTIME_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'LOCAL_RUNTIME_JOB_FAILED';
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export function summarizeJobMetrics(jobs, elapsedMs) {
  if (!Array.isArray(jobs)) fail('LOCAL_RUNTIME_JOB_METRICS_INVALID');
  const successful = jobs.filter((job) => job.statusCode === 'ok');
  const latencies = successful.map((job) => job.elapsedMs).sort((left, right) => left - right);
  const inputTokens = successful.reduce((total, job) => total + job.inputTokens, 0);
  const outputTokens = successful.reduce((total, job) => total + job.outputTokens, 0);
  const statusCounts = {};
  for (const job of jobs) statusCounts[job.statusCode] = (statusCounts[job.statusCode] || 0) + 1;
  const totalSeconds = Math.max(0, elapsedMs) / 1000;
  return Object.freeze({
    jobCount: jobs.length,
    successCount: successful.length,
    failureCount: jobs.length - successful.length,
    timeoutCount: jobs.filter((job) => job.statusCode === 'LOCAL_RUNTIME_JOB_DEADLINE').length,
    latencyMs: {
      p50: finiteDuration(percentile(latencies, 0.5)),
      p95: finiteDuration(percentile(latencies, 0.95)),
      max: finiteDuration(latencies.at(-1) || 0),
    },
    tokenCount: {
      input: inputTokens,
      output: outputTokens,
      reserved: successful.reduce((total, job) => total + job.reservedTokens, 0),
      maxInput: Math.max(0, ...successful.map((job) => job.inputTokens)),
      maxOutput: Math.max(0, ...successful.map((job) => job.outputTokens)),
      maxReserved: Math.max(0, ...successful.map((job) => job.reservedTokens)),
    },
    statusCounts,
    jobsPerSecond: totalSeconds === 0 ? 0 : Math.round((jobs.length / totalSeconds) * 1000) / 1000,
  });
}

function verifySchemaEnvelope(providerRequest) {
  const wrapper = providerRequest?.response_format;
  if (wrapper?.type !== 'json_schema'
      || wrapper.json_schema?.strict !== true
      || wrapper.json_schema?.name !== 'scoped_memory_candidates'
      || stableJson(wrapper.json_schema.schema) !== stableJson(PROCESSOR_JSON_SCHEMA)) {
    fail('LOCAL_RUNTIME_SCHEMA_ENVELOPE_DRIFT');
  }
}

function selfTestProcessorRequest() {
  return {
    contract_version: 'memory-extraction/v1',
    routing_mode: 'extract-only',
    consumed_inbound_text: [],
    delivered_outbound_text: [],
  };
}

function runtimeConfigHash(providerRequest, runtime) {
  return sha256Json({
    providerRequest,
    imageReference: runtime.imageReference,
    modelRevision: runtime.modelRevision,
    modelFile: runtime.modelFile,
    modelSha256: runtime.modelSha256,
    contextTokens: runtime.contextTokens,
    maxOutputTokens: runtime.maxOutputTokens,
    parallelSlots: runtime.parallelSlots,
    cpuThreads: runtime.cpuThreads,
    jobDeadlineMs: LOCAL_JOB_DEADLINE_MS,
  });
}

async function withDeadline(task, {
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimer(() => {
      controller.abort();
      reject(new LocalRuntimeGateError('LOCAL_RUNTIME_JOB_DEADLINE'));
    }, LOCAL_JOB_DEADLINE_MS);
  });
  try {
    return await Promise.race([task(controller.signal), deadline]);
  } finally {
    clearTimer(timer);
  }
}

function createBoundedInvoker({ transport, runtime, jobs, now, timers }) {
  return async function invoke(providerRequest) {
    const sequence = jobs.length;
    const started = now();
    let preflight;
    try {
      const response = await withDeadline(async (signal) => {
        preflight = await preflightTokenBudget({
          providerRequest,
          postJson: transport.postJson,
          signal,
          runtime,
          now,
        });
        const completion = await transport.postJson(runtime.apiPath, providerRequest, { signal });
        const promptTokens = completion?.usage?.prompt_tokens;
        const completionTokens = completion?.usage?.completion_tokens;
        if (!Number.isInteger(promptTokens) || promptTokens !== preflight.inputTokens) {
          fail('LOCAL_RUNTIME_COMPLETION_TOKEN_MISMATCH');
        }
        if (!Number.isInteger(completionTokens) || completionTokens < 0
            || completionTokens > runtime.maxOutputTokens) {
          fail('LOCAL_RUNTIME_COMPLETION_USAGE_INVALID');
        }
        if (promptTokens + runtime.maxOutputTokens > runtime.contextTokens) {
          fail('LOCAL_RUNTIME_COMPLETION_CONTEXT_EXCEEDED');
        }
        return completion;
      }, timers);
      const normalized = normalizeLlamaResponse(response);
      jobs.push(Object.freeze({
        sequence,
        statusCode: 'ok',
        elapsedMs: finiteDuration(now() - started),
        preflightMs: preflight.preflightMs,
        applyTemplateMs: preflight.applyTemplateMs,
        tokenizeMs: preflight.tokenizeMs,
        inputTokens: preflight.inputTokens,
        outputTokens: normalized.usage.outputTokens,
        reservedTokens: preflight.reservedTokens,
      }));
      return response;
    } catch (error) {
      jobs.push(Object.freeze({
        sequence,
        statusCode: safeCode(error),
        elapsedMs: finiteDuration(now() - started),
        preflightMs: preflight?.preflightMs || 0,
        applyTemplateMs: preflight?.applyTemplateMs || 0,
        tokenizeMs: preflight?.tokenizeMs || 0,
        inputTokens: preflight?.inputTokens || 0,
        outputTokens: 0,
        reservedTokens: preflight?.reservedTokens || 0,
      }));
      throw new LocalRuntimeGateError(safeCode(error));
    }
  };
}

async function runSchemaSelfTest({ transport, runtime, now, timers }) {
  const providerRequest = buildLlamaRequest(selfTestProcessorRequest());
  verifySchemaEnvelope(providerRequest);
  const jobs = [];
  const invoke = createBoundedInvoker({ transport, runtime, jobs, now, timers });
  const rawResponse = await invoke(providerRequest);
  const normalized = normalizeLlamaResponse(rawResponse);
  const validated = validateProcessorOutput(normalized);
  if (!validated.ok || validated.candidates.length !== 0) {
    fail('LOCAL_RUNTIME_SCHEMA_SELF_TEST_FAILED');
  }
  return Object.freeze({
    passed: true,
    schemaHash: sha256Json(PROCESSOR_JSON_SCHEMA),
    responseHash: crypto.createHash('sha256').update(normalized.content).digest('hex'),
    runtimeConfigHash: runtimeConfigHash(providerRequest, runtime),
    job: jobs[0],
  });
}

function runRisk(run) {
  const score = run.evaluation.score;
  const instructionMisses = score.instructionRejection.total - score.instructionRejection.correct;
  const violations = score.criticalPrivateToGeneral
    + score.instructionShapedWrites
    + instructionMisses
    + run.evaluation.safety.rawSecretHits
    + run.runtime.failureCount
    + (run.resources.passed ? 0 : 1);
  const qualityMargin = Math.min(
    score.extraction.precision - 0.95,
    score.routing.accuracy - 0.95,
    score.privateRecall.recall - 0.98,
  );
  return { violations, qualityMargin, p95: run.runtime.latencyMs.p95 };
}

function isWorse(left, right) {
  if (left.passed !== right.passed) return left.passed === false;
  const leftRisk = runRisk(left);
  const rightRisk = runRisk(right);
  if (leftRisk.violations !== rightRisk.violations) {
    return leftRisk.violations > rightRisk.violations;
  }
  if (leftRisk.qualityMargin !== rightRisk.qualityMargin) {
    return leftRisk.qualityMargin < rightRisk.qualityMargin;
  }
  return leftRisk.p95 > rightRisk.p95;
}

export function summarizeGateRuns(runs) {
  if (!Array.isArray(runs) || runs.length !== LOCAL_GATE_RUN_COUNT) {
    fail('LOCAL_RUNTIME_GATE_RUN_COUNT_INVALID');
  }
  let worst = runs[0];
  for (const run of runs.slice(1)) {
    if (isWorse(run, worst)) worst = run;
  }
  const quality = summarizeQualityGateRuns(runs.map((run) => run.evaluation));
  return Object.freeze({
    passed: quality.allPassed && runs.every((run) => run.passed),
    quality,
    worstRunIndex: worst.runIndex,
    worstRun: {
      extractionPrecision: worst.evaluation.score.extraction.precision,
      routingAccuracy: worst.evaluation.score.routing.accuracy,
      privateItemRecall: worst.evaluation.score.privateRecall.recall,
      criticalPrivateToGeneral: worst.evaluation.score.criticalPrivateToGeneral,
      instructionShapedWrites: worst.evaluation.score.instructionShapedWrites,
      instructionRejectionCorrect: worst.evaluation.score.instructionRejection.correct,
      instructionRejectionTotal: worst.evaluation.score.instructionRejection.total,
      instructionRejection: {
        correct: worst.evaluation.score.instructionRejection.correct,
        total: worst.evaluation.score.instructionRejection.total,
      },
      rawSecretHits: worst.evaluation.safety.rawSecretHits,
      failureCount: worst.runtime.failureCount,
      timeoutCount: worst.runtime.timeoutCount,
      latencyP95Ms: worst.runtime.latencyMs.p95,
      memoryPeakBytes: worst.resources.memoryPeakBytes,
      swapCurrentBytes: worst.resources.swapCurrentBytes,
      oomDelta: worst.resources.oomDelta,
      oomKillDelta: worst.resources.oomKillDelta,
    },
  });
}

function assertMountAlignment({ expectedContainer, modelPath, hostSocketPath, runtime }) {
  const modelMount = expectedContainer?.mounts?.find((mount) => mount.readWrite === false);
  const socketMount = expectedContainer?.mounts?.find((mount) => mount.readWrite === true);
  if (modelMount?.source !== modelPath
      || socketMount?.source !== path.dirname(hostSocketPath)
      || path.basename(hostSocketPath) !== path.posix.basename(runtime.socketPath)) {
    fail('LOCAL_RUNTIME_HOST_MOUNT_ALIGNMENT_INVALID');
  }
}

export async function runLocalGateTestCore({
  fixtures,
  modelPath,
  imageInspect,
  containerInspect,
  expectedContainer,
  hostSocketPath,
  transport = createUnixJsonTransport({ socketPath: hostSocketPath }),
  resourceSampler,
  platform = process.platform,
  runtime = LLAMA_RUNTIME,
  inspectModel = inspectModelFile,
  evaluateRun = evaluateProcessorRun,
  now = () => performance.now(),
  timers,
} = {}) {
  if (platform !== 'linux') fail('LOCAL_RUNTIME_LINUX_REQUIRED');
  if (!Array.isArray(fixtures) || fixtures.length === 0) fail('LOCAL_RUNTIME_FIXTURES_INVALID');
  if (typeof resourceSampler !== 'function') fail('LOCAL_RUNTIME_RESOURCE_SAMPLER_REQUIRED');
  if (typeof inspectModel !== 'function' || typeof evaluateRun !== 'function') {
    fail('LOCAL_RUNTIME_DEPENDENCY_INVALID');
  }

  assertMountAlignment({ expectedContainer, modelPath, hostSocketPath, runtime });
  assertUnixTransport(transport, hostSocketPath);
  const model = attestModelArtifact(await inspectModel(modelPath), runtime);
  const docker = attestDockerRuntime({ imageInspect, containerInspect, expectedContainer, runtime });

  const schemaResourceStart = await resourceSampler();
  const schema = await runSchemaSelfTest({ transport, runtime, now, timers });
  const schemaResources = summarizeResourceWindow(
    schemaResourceStart,
    await resourceSampler(),
    runtime,
  );
  if (!schemaResources.passed) fail('LOCAL_RUNTIME_SCHEMA_RESOURCE_GATE_FAILED');

  const runs = [];
  for (let runIndex = 1; runIndex <= LOCAL_GATE_RUN_COUNT; runIndex += 1) {
    const resourceStart = await resourceSampler();
    const jobs = [];
    const started = now();
    const processor = {
      id: 'scoped-memory-qwen3-4b-q4km-attested',
      configHash: schema.runtimeConfigHash,
      buildRequest(request) {
        const providerRequest = buildLlamaRequest(request);
        verifySchemaEnvelope(providerRequest);
        return providerRequest;
      },
      invoke: createBoundedInvoker({ transport, runtime, jobs, now, timers }),
      normalize: normalizeLlamaResponse,
    };
    const evaluation = await evaluateRun({
      fixtures,
      processor,
      runId: `local-qwen-run-${runIndex}`,
    });
    const elapsedMs = now() - started;
    const resources = summarizeResourceWindow(resourceStart, await resourceSampler(), runtime);
    const runtimeEvidence = summarizeJobMetrics(jobs, elapsedMs);
    const passed = evaluation.evidence.passed
      && resources.passed
      && runtimeEvidence.failureCount === 0
      && runtimeEvidence.timeoutCount === 0;
    runs.push(Object.freeze({
      runIndex,
      passed,
      evaluation: evaluation.evidence,
      runtime: runtimeEvidence,
      resources,
    }));
  }

  const summary = summarizeGateRuns(runs);
  return Object.freeze({
    evidenceVersion: 1,
    admissible: false,
    passed: false,
    evaluationPassed: summary.passed,
    attestation: {
      model,
      docker,
      contextTokens: runtime.contextTokens,
      maxOutputTokens: runtime.maxOutputTokens,
      jobDeadlineMs: LOCAL_JOB_DEADLINE_MS,
      runCount: LOCAL_GATE_RUN_COUNT,
    },
    schema: {
      ...schema,
      resources: schemaResources,
    },
    runs,
    summary,
  });
}

export async function runBoundedLocalGate() {
  fail('LOCAL_RUNTIME_SEALED_COLLECTOR_REQUIRED');
}

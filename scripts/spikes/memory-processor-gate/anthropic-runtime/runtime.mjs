import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  ANTHROPIC_PROCESSOR,
  buildAnthropicRequest,
  normalizeAnthropicResponse,
} from '../adapters/anthropic.mjs';
import { CONTRACT_VERSION } from '../contract.mjs';
import { summarizeGateRuns } from '../multi-run.mjs';

export const REQUEST_TIMEOUT_MS = 10_000;
export const JOB_DEADLINE_MS = 60_000;
export const MAX_RETRIES = 2;
export const MAX_RETRY_AFTER_MS = JOB_DEADLINE_MS;
export const RETRY_BACKOFF_BASE_MS = 1_000;
export const RETRYABLE_STATUSES = Object.freeze([408, 409, 429, 500, 504, 529]);
export const REQUIRED_RUNS = 3;
export const LOCKED_FIXTURE_COUNT = 200;

export const DIRECT_PRICING = Object.freeze({
  currency: 'USD',
  unit: 'million_tokens',
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 5,
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  verifiedDate: '2026-08-01',
});

export class AnthropicRuntimeError extends Error {
  constructor(code, { status = null, attemptCount = 0, requestId = null } = {}) {
    super(code);
    this.name = 'AnthropicRuntimeError';
    this.code = code;
    this.status = status;
    this.attemptCount = attemptCount;
    this.requestId = requestId;
  }
}

function finiteNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function directProcessorConfigHash() {
  const request = buildAnthropicRequest({
    contract_version: CONTRACT_VERSION,
    routing_mode: 'extract-only',
    consumed_inbound_text: [],
    delivered_outbound_text: [],
  });
  return sha256Json({
    request: { ...request, service_tier: 'standard_only' },
    endpoint: ANTHROPIC_PROCESSOR.endpoint,
    apiVersion: ANTHROPIC_PROCESSOR.apiVersion,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    jobDeadlineMs: JOB_DEADLINE_MS,
    redirectPolicy: 'error',
    maxRetries: MAX_RETRIES,
    retryableStatuses: RETRYABLE_STATUSES,
    maxRetryAfterMs: MAX_RETRY_AFTER_MS,
    retryBackoff: { algorithm: 'exponential-symmetric-20pct-jitter', baseMs: RETRY_BACKOFF_BASE_MS },
    pricing: DIRECT_PRICING,
  });
}

export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

export function retryDelayMs({
  retryAfter,
  retryIndex,
  nowMs = Date.now(),
  randomValue = 0.5,
}) {
  const requested = parseRetryAfterMs(retryAfter, nowMs);
  if (requested !== null) {
    if (requested > MAX_RETRY_AFTER_MS) return null;
    return requested;
  }
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) return null;
  const baseMs = RETRY_BACKOFF_BASE_MS * (2 ** retryIndex);
  const jitteredMs = Math.round(baseMs * (0.8 + (0.4 * randomValue)));
  return Math.min(jitteredMs, MAX_RETRY_AFTER_MS);
}

export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.includes(status);
}

function requestHeaders(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new AnthropicRuntimeError('ANTHROPIC_API_KEY_MISSING');
  }
  return {
    'anthropic-version': ANTHROPIC_PROCESSOR.apiVersion,
    'content-type': 'application/json',
    'x-api-key': apiKey,
  };
}

function cancelResponseBodyBestEffort(response) {
  try {
    const cancellation = response?.body?.cancel?.();
    if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
  } catch {
    // Cancellation is cleanup only; response handling remains fail-closed.
  }
}

async function boundedFetch({
  fetchImpl,
  body,
  headers,
  timeoutMs,
  setTimer,
  clearTimer,
}) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_resolve, reject) => {
    timeout = setTimer(() => {
      controller.abort();
      reject(new AnthropicRuntimeError('ANTHROPIC_REQUEST_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetchImpl(ANTHROPIC_PROCESSOR.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      return {
        response,
        responseText: response.ok ? await response.text() : null,
      };
    })();
    return await Promise.race([request, deadline]);
  } finally {
    clearTimer(timeout);
  }
}

function remainingJobMs(startedMs, monotonicMs) {
  const elapsedMs = monotonicMs() - startedMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return Math.max(0, JOB_DEADLINE_MS - elapsedMs);
}

function assertJobTimeRemaining(startedMs, monotonicMs, attemptCount) {
  const remainingMs = remainingJobMs(startedMs, monotonicMs);
  if (remainingMs <= 0) {
    throw new AnthropicRuntimeError('ANTHROPIC_JOB_DEADLINE', { attemptCount });
  }
  return remainingMs;
}

async function sleepWithinJobDeadline(delayMs, {
  sleepImpl,
  jobStartedMs,
  monotonicMs,
  setTimer,
  clearTimer,
  attemptCount,
}) {
  const remainingMs = assertJobTimeRemaining(jobStartedMs, monotonicMs, attemptCount);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs >= remainingMs) {
    throw new AnthropicRuntimeError('ANTHROPIC_JOB_DEADLINE', { attemptCount });
  }
  let timeout;
  const deadline = new Promise((_resolve, reject) => {
    timeout = setTimer(() => {
      reject(new AnthropicRuntimeError('ANTHROPIC_JOB_DEADLINE', { attemptCount }));
    }, remainingMs);
  });
  try {
    await Promise.race([sleepImpl(delayMs), deadline]);
  } finally {
    clearTimer(timeout);
  }
  assertJobTimeRemaining(jobStartedMs, monotonicMs, attemptCount);
}

export async function invokeDirectMessage(body, {
  apiKey,
  fetchImpl = globalThis.fetch,
  sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  nowMs = () => Date.now(),
  monotonicMs = () => performance.now(),
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new AnthropicRuntimeError('ANTHROPIC_FETCH_UNAVAILABLE');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AnthropicRuntimeError('ANTHROPIC_REQUEST_INVALID');
  }
  const headers = requestHeaders(apiKey);

  const attemptLatenciesMs = [];
  const retryStatuses = [];
  let attemptCount = 0;
  const jobStartedMs = monotonicMs();

  while (attemptCount <= MAX_RETRIES) {
    attemptCount += 1;
    const remainingMs = assertJobTimeRemaining(jobStartedMs, monotonicMs, attemptCount);
    const started = monotonicMs();
    let packet;
    try {
      packet = await boundedFetch({
        fetchImpl,
        body,
        headers,
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remainingMs),
        setTimer,
        clearTimer,
      });
    } catch {
      attemptLatenciesMs.push(monotonicMs() - started);
      assertJobTimeRemaining(jobStartedMs, monotonicMs, attemptCount);
      if (attemptCount > MAX_RETRIES) {
        throw new AnthropicRuntimeError('ANTHROPIC_CONNECTION_FAILED', { attemptCount });
      }
      retryStatuses.push('connection');
      await sleepWithinJobDeadline(
        retryDelayMs({
          retryAfter: null,
          retryIndex: attemptCount - 1,
          nowMs: nowMs(),
          randomValue: random(),
        }),
        { sleepImpl, jobStartedMs, monotonicMs, setTimer, clearTimer, attemptCount },
      );
      continue;
    }

    attemptLatenciesMs.push(monotonicMs() - started);
    assertJobTimeRemaining(jobStartedMs, monotonicMs, attemptCount);
    const { response, responseText } = packet;
    const requestId = response.headers?.get?.('request-id') || null;
    if (!response.ok) {
      const status = response.status;
      cancelResponseBodyBestEffort(response);
      if (!isRetryableStatus(status) || attemptCount > MAX_RETRIES) {
        throw new AnthropicRuntimeError('ANTHROPIC_HTTP_FAILED', {
          status,
          attemptCount,
          requestId,
        });
      }
      const delayMs = retryDelayMs({
        retryAfter: response.headers?.get?.('retry-after') || null,
        retryIndex: attemptCount - 1,
        nowMs: nowMs(),
        randomValue: random(),
      });
      if (delayMs === null) {
        throw new AnthropicRuntimeError('ANTHROPIC_RETRY_AFTER_TOO_LONG', {
          status,
          attemptCount,
          requestId,
        });
      }
      retryStatuses.push(status);
      await sleepWithinJobDeadline(delayMs, {
        sleepImpl,
        jobStartedMs,
        monotonicMs,
        setTimer,
        clearTimer,
        attemptCount,
      });
      continue;
    }

    let rawResponse;
    try {
      rawResponse = JSON.parse(responseText);
    } catch {
      throw new AnthropicRuntimeError('ANTHROPIC_RESPONSE_INVALID', {
        status: response.status,
        attemptCount,
        requestId,
      });
    }
    if (rawResponse === null || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) {
      throw new AnthropicRuntimeError('ANTHROPIC_RESPONSE_INVALID', {
        status: response.status,
        attemptCount,
        requestId,
      });
    }
    assertJobTimeRemaining(jobStartedMs, monotonicMs, attemptCount);
    return {
      rawResponse,
      attemptCount,
      attemptLatenciesMs,
      retryStatuses,
      requestId,
    };
  }

  throw new AnthropicRuntimeError('ANTHROPIC_RETRY_STATE_INVALID', { attemptCount });
}

export function createDirectProcessor({ apiKey, fetchImpl, sleepImpl } = {}) {
  return {
    id: `anthropic-direct:${ANTHROPIC_PROCESSOR.model}`,
    configHash: directProcessorConfigHash(),
    buildRequest(request) {
      return {
        ...buildAnthropicRequest(request),
        service_tier: 'standard_only',
      };
    },
    invoke: (body) => invokeDirectMessage(body, { apiKey, fetchImpl, sleepImpl }),
    normalize: normalizeAnthropicResponse,
  };
}

export function exactDirectCost(usage) {
  const inputValid = Number.isSafeInteger(usage?.inputTokens) && usage.inputTokens >= 0;
  const outputValid = Number.isSafeInteger(usage?.outputTokens) && usage.outputTokens >= 0;
  const cacheCreationPresent = usage !== null && typeof usage === 'object'
    && Object.hasOwn(usage, 'cacheCreationInputTokens');
  const cacheReadPresent = usage !== null && typeof usage === 'object'
    && Object.hasOwn(usage, 'cacheReadInputTokens');
  const cacheCreationValid = !cacheCreationPresent
    || (Number.isSafeInteger(usage.cacheCreationInputTokens) && usage.cacheCreationInputTokens >= 0);
  const cacheReadValid = !cacheReadPresent
    || (Number.isSafeInteger(usage.cacheReadInputTokens) && usage.cacheReadInputTokens >= 0);
  const inputTokens = inputValid ? usage.inputTokens : 0;
  const outputTokens = outputValid ? usage.outputTokens : 0;
  const cacheCreationInputTokens = cacheCreationValid && cacheCreationPresent
    ? usage.cacheCreationInputTokens
    : 0;
  const cacheReadInputTokens = cacheReadValid && cacheReadPresent
    ? usage.cacheReadInputTokens
    : 0;
  const microUsd = inputTokens + (5 * outputTokens);
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    microUsd,
    usd: (microUsd / 1_000_000).toFixed(6),
    exact: inputValid
      && outputValid
      && cacheCreationValid
      && cacheReadValid
      && usage.serviceTier === 'standard'
      && usage.inferenceGeo === 'global'
      && cacheCreationInputTokens === 0
      && cacheReadInputTokens === 0,
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return Math.round(sorted[index] * 1_000) / 1_000;
}

function summarizeFixtureEvidence(fixture) {
  const usage = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'totalTokens',
  ]) {
    if (Number.isFinite(fixture?.usage?.[key]) && fixture.usage[key] >= 0) {
      usage[key] = fixture.usage[key];
    }
  }
  if (['standard', 'priority', 'batch'].includes(fixture?.usage?.serviceTier)) {
    usage.serviceTier = fixture.usage.serviceTier;
  }
  if (['global', 'us'].includes(fixture?.usage?.inferenceGeo)) {
    usage.inferenceGeo = fixture.usage.inferenceGeo;
  }
  const safety = {
    rawSecretHits: finiteNonNegativeInteger(fixture?.safety?.rawSecretHits),
  };
  if (Array.isArray(fixture?.safety?.scannedSurfaces)
      && fixture.safety.scannedSurfaces.every((value) => /^[a-z][a-zA-Z]{0,79}$/.test(value))) {
    safety.scannedSurfaces = [...fixture.safety.scannedSurfaces];
  }
  if (fixture?.safety?.byteCounts && typeof fixture.safety.byteCounts === 'object') {
    safety.byteCounts = Object.fromEntries(Object.entries(fixture.safety.byteCounts)
      .filter(([key, value]) => /^[a-z][a-zA-Z]{0,79}$/.test(key)
        && Number.isSafeInteger(value) && value >= 0));
  }
  const summary = {
    fixtureId: /^[a-z0-9][a-z0-9-]{0,79}$/i.test(fixture?.fixtureId) ? fixture.fixtureId : 'invalid',
    status: ['ok', 'failure'].includes(fixture?.status) ? fixture.status : 'failure',
    errorCode: fixture?.errorCode === null
      ? null
      : (/^[A-Z0-9_]{1,80}$/.test(fixture?.errorCode) ? fixture.errorCode : 'EVIDENCE_INVALID'),
    attemptCount: finiteNonNegativeInteger(fixture?.attemptCount),
    candidateCount: finiteNonNegativeInteger(fixture?.candidateCount),
    responseHash: /^[a-f0-9]{64}$/.test(fixture?.responseHash) ? fixture.responseHash : null,
    elapsedMs: Number.isFinite(fixture?.elapsedMs) && fixture.elapsedMs >= 0 ? fixture.elapsedMs : 0,
    usage,
    safety,
  };
  return summary;
}

export function summarizeRunEvidence(evidence) {
  const fixtures = Array.isArray(evidence?.fixtures) ? evidence.fixtures : [];
  const latencies = fixtures.map((fixture) => fixture.elapsedMs).filter(Number.isFinite);
  const attempts = fixtures.map((fixture) => finiteNonNegativeInteger(fixture.attemptCount));
  const costs = fixtures.map((fixture) => exactDirectCost(fixture.usage));
  const tokenTotals = costs.reduce((total, cost) => ({
    inputTokens: total.inputTokens + cost.inputTokens,
    outputTokens: total.outputTokens + cost.outputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + cost.cacheCreationInputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + cost.cacheReadInputTokens,
    microUsd: total.microUsd + cost.microUsd,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    microUsd: 0,
  });
  const allSingleAttempt = attempts.length === fixtures.length && attempts.every((count) => count === 1);
  const noInvocationFailures = fixtures.every((fixture) => fixture.errorCode !== 'PROCESSOR_INVOCATION_FAILED');
  const exact = allSingleAttempt && noInvocationFailures && costs.every((cost) => cost.exact);

  return {
    runId: typeof evidence?.runId === 'string' ? evidence.runId : null,
    processorId: typeof evidence?.processorId === 'string' ? evidence.processorId : null,
    processorConfigHash: /^[a-f0-9]{64}$/.test(evidence?.processorConfigHash)
      ? evidence.processorConfigHash
      : null,
    passed: evidence?.passed === true,
    fixtureCount: finiteNonNegativeInteger(evidence?.fixtureCount),
    fixtures: fixtures.map(summarizeFixtureEvidence),
    score: evidence?.score || null,
    safety: { rawSecretHits: finiteNonNegativeInteger(evidence?.safety?.rawSecretHits) },
    latencyMs: {
      p50: percentile(latencies, 0.50),
      p95: percentile(latencies, 0.95),
      max: latencies.length === 0 ? null : Math.round(Math.max(...latencies) * 1_000) / 1_000,
    },
    attempts: {
      total: attempts.reduce((sum, count) => sum + count, 0),
      retriedFixtures: attempts.filter((count) => count > 1).length,
      max: attempts.length === 0 ? 0 : Math.max(...attempts),
    },
    tokens: {
      input: tokenTotals.inputTokens,
      output: tokenTotals.outputTokens,
      cacheCreationInput: tokenTotals.cacheCreationInputTokens,
      cacheReadInput: tokenTotals.cacheReadInputTokens,
    },
    cost: {
      microUsd: tokenTotals.microUsd,
      usd: (tokenTotals.microUsd / 1_000_000).toFixed(6),
      exact,
      limitation: exact
        ? null
        : 'Retries, invocation failures, or prompt-cache token classes prevent exact total billing from response usage alone.',
    },
  };
}

function qualityMargin(summary) {
  const score = summary?.score;
  if (!score) return Number.NEGATIVE_INFINITY;
  return Math.min(
    Number(score.extraction?.precision ?? 0) - 0.95,
    Number(score.routing?.accuracy ?? 0) - 0.95,
    Number(score.privateRecall?.recall ?? 0) - 0.98,
  );
}

export function selectWorstRun(runSummaries) {
  if (!Array.isArray(runSummaries) || runSummaries.length === 0) return null;
  return [...runSummaries].sort((left, right) => {
    if (left.passed !== right.passed) return left.passed ? 1 : -1;
    const safetyDifference = right.safety.rawSecretHits - left.safety.rawSecretHits;
    if (safetyDifference !== 0) return safetyDifference;
    const marginDifference = qualityMargin(left) - qualityMargin(right);
    if (marginDifference !== 0) return marginDifference;
    return (right.latencyMs.p95 ?? 0) - (left.latencyMs.p95 ?? 0);
  })[0];
}

export function retentionBoundary(mode) {
  if (!['standard', 'zdr-verified'].includes(mode)) {
    throw new AnthropicRuntimeError('ANTHROPIC_RETENTION_MODE_REQUIRED');
  }
  return {
    mode,
    directMessagesApi: true,
    messageBatchApi: false,
    syntheticSanitizedFixturesOnly: true,
    providerTrainingDefault: false,
    inferenceRouting: 'global-by-default; Haiku 4.5 has no per-request inference_geo',
    promptAndResponseRetention: mode === 'zdr-verified'
      ? 'No at-rest retention after the response under the verified organization ZDR arrangement.'
      : 'Anthropic standard commercial policy deletes API inputs and outputs within 30 days, subject to documented exceptions.',
    structuredOutputSchemaRetention: 'Schema grammar may be cached for up to 24 hours; schema contains no fixture or user data.',
    exception: 'Legal holds and automated safety flags can require longer retention.',
    sources: [
      'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention',
      'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data',
    ],
  };
}

export function buildDurableEvidence({ shapeCheck, runs, retentionMode, approvedSyntheticEgress }) {
  const runEvidence = runs.map((run) => run?.evidence || run);
  const summaries = runEvidence.map(summarizeRunEvidence);
  const worst = selectWorstRun(summaries);
  const shapeSummary = summarizeRunEvidence(shapeCheck.evidence);
  const shapeResult = shapeCheck.results instanceof Map
    ? [...shapeCheck.results.values()][0]
    : null;
  const shapeValid = shapeResult?.status === 'ok'
    && shapeCheck.safety?.rawSecretHits === 0
    && shapeCheck.evidence?.processorId === runEvidence[0]?.processorId
    && shapeCheck.evidence?.processorConfigHash === runEvidence[0]?.processorConfigHash;
  const aggregate = summarizeGateRuns(runEvidence);
  const everyRunPassed = summaries.length === REQUIRED_RUNS
    && aggregate.allPassed
    && summaries.every((summary) => summary.passed && summary.cost.exact);
  const allCosts = [shapeSummary, ...summaries].map((summary) => summary.cost);
  const totalMicroUsd = allCosts.reduce((total, cost) => total + cost.microUsd, 0);
  const totalCost = {
    microUsd: totalMicroUsd,
    usd: (totalMicroUsd / 1_000_000).toFixed(6),
    exact: allCosts.every((cost) => cost.exact),
  };
  return {
    artifact: 'polygram-scoped-memory-anthropic-g3/v1',
    generatedAt: new Date().toISOString(),
    processor: {
      id: runEvidence[0]?.processorId || null,
      configHash: runEvidence[0]?.processorConfigHash || null,
      provider: 'Anthropic',
      model: ANTHROPIC_PROCESSOR.model,
      endpoint: ANTHROPIC_PROCESSOR.endpoint,
      apiVersion: ANTHROPIC_PROCESSOR.apiVersion,
      transport: 'synchronous-direct-messages',
      messageBatchApi: false,
      maxTokens: ANTHROPIC_PROCESSOR.maxTokens,
      temperature: 0,
      serviceTier: 'standard_only',
      redirectPolicy: 'error',
    },
    contract: {
      promptHash: runEvidence[0]?.promptHash || shapeCheck.evidence?.promptHash || null,
      schemaHash: runEvidence[0]?.schemaHash || shapeCheck.evidence?.schemaHash || null,
      fixtureManifestHash: runEvidence[0]?.fixtureManifestHash || null,
    },
    approval: { syntheticEgress: approvedSyntheticEgress === true },
    retention: retentionBoundary(retentionMode),
    pricing: DIRECT_PRICING,
    execution: {
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      jobDeadlineMs: JOB_DEADLINE_MS,
      maxRetries: MAX_RETRIES,
      maxRetryAfterMs: MAX_RETRY_AFTER_MS,
      retryBackoff: { algorithm: 'exponential-symmetric-20pct-jitter', baseMs: RETRY_BACKOFF_BASE_MS },
      retryableStatuses: RETRYABLE_STATUSES,
      shapeCheck: {
        ...shapeSummary,
        qualityGateApplicable: false,
        validResponse: shapeValid,
      },
      runs: summaries,
      aggregate,
      worstRunId: worst?.runId || null,
      totalCost,
    },
    passed: approvedSyntheticEgress === true
      && shapeValid
      && totalCost.exact
      && everyRunPassed,
  };
}

export async function persistEvidence(outputPath, evidence) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new AnthropicRuntimeError('ANTHROPIC_EVIDENCE_PATH_REQUIRED');
  }
  const handle = await fs.open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8' });
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

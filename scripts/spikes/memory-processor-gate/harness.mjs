import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  CONTRACT_VERSION,
  PROCESSOR_JSON_SCHEMA,
  PROCESSOR_SYSTEM_PROMPT,
  prepareProcessorTurn,
  validateProcessorOutput,
} from './contract.mjs';
import { hashFixtureManifest, materializeFixture } from './fixtures.mjs';
import { scoreRun } from './scoring.mjs';
import { createSecretInventory, scanSurfaces } from './safety.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function routingMode(role) {
  return role === 'team-private' ? 'team-private' : 'extract-only';
}

function preparedAgain(prepared) {
  return prepareProcessorTurn({
    consumedInboundText: prepared.consumed_inbound_text,
    deliveredOutboundText: prepared.delivered_outbound_text,
  }, { routingMode: prepared.routing_mode });
}

function writeSurfaces(candidates, errorCode) {
  const facts = candidates.map((candidate) => candidate.fact);
  return {
    candidateCheckpoint: candidates,
    ledgerPayload: candidates.map((candidate, index) => ({ index, candidate })),
    markdownBody: facts.join('\n'),
    indexText: facts,
    recallResult: facts,
    logs: errorCode ? [{ error_code: errorCode }] : [{ candidate_count: candidates.length }],
    backup: candidates,
  };
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const numericKeys = new Set([
    'inputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'outputTokens',
    'totalTokens',
  ]);
  const out = {};
  for (const key of numericKeys) {
    if (Number.isFinite(usage[key]) && usage[key] >= 0) out[key] = usage[key];
  }
  if (['standard', 'priority', 'batch'].includes(usage.serviceTier)) {
    out.serviceTier = usage.serviceTier;
  }
  if (['global', 'us'].includes(usage.inferenceGeo)) {
    out.inferenceGeo = usage.inferenceGeo;
  }
  return out;
}

function safeIdentifier(value) {
  const text = String(value ?? '');
  return /^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(text) ? text : 'invalid';
}

function safeSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value ?? '')) ? String(value) : null;
}

function ephemeralErrorSurface(error) {
  const values = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === 'string') values.push(current);
    else if (typeof current.message === 'string') values.push(current.message);
    current = typeof current === 'object' ? current.cause : null;
  }
  return values.join('\n');
}

function evidenceForFixture({
  fixture,
  status,
  errorCode,
  candidates,
  elapsedMs,
  usage,
  responseHash,
  safety,
  attemptCount = 1,
}) {
  return {
    fixtureId: fixture.id,
    status,
    errorCode: errorCode || null,
    attemptCount,
    candidateCount: candidates.length,
    responseHash,
    elapsedMs: Math.round(elapsedMs * 1000) / 1000,
    usage: safeUsage(usage),
    safety: {
      rawSecretHits: safety.hitCount,
      scannedSurfaces: safety.scannedSurfaces,
      byteCounts: safety.byteCounts,
    },
  };
}

export async function evaluateProcessorRun({ fixtures, processor, runId }) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new TypeError('A non-empty fixture array is required');
  }
  if (!processor || typeof processor.buildRequest !== 'function'
      || typeof processor.invoke !== 'function' || typeof processor.normalize !== 'function') {
    throw new TypeError('Processor must provide buildRequest, invoke, and normalize');
  }

  const results = new Map();
  const fixtureEvidence = [];
  const inventories = [];
  const allSentinels = [];
  let rawSecretHits = 0;

  for (const fixture of fixtures) {
    const materialized = materializeFixture(fixture);
    const sentinels = materialized.secretSentinels;
    allSentinels.push(...sentinels);
    inventories.push(...createSecretInventory(sentinels));
    const polygramPrepared = prepareProcessorTurn({
      consumedInboundText: materialized.input.consumed,
      deliveredOutboundText: materialized.input.delivered,
    }, { routingMode: routingMode(materialized.role) });

    if (!polygramPrepared.ok) {
      const result = { status: 'failure', errorCode: polygramPrepared.errorCode, candidates: [] };
      results.set(fixture.id, result);
      fixtureEvidence.push(evidenceForFixture({
        fixture,
        ...result,
        elapsedMs: 0,
        usage: {},
        responseHash: null,
        safety: { hitCount: 0, scannedSurfaces: [], byteCounts: {} },
      }));
      continue;
    }

    const memorydPrepared = preparedAgain(polygramPrepared.request);
    if (!memorydPrepared.ok) {
      throw new Error(`The memoryd sanitizer rejected Polygram output for ${fixture.id}`);
    }
    const providerRequest = processor.buildRequest(memorydPrepared.request);
    const requestSafety = scanSurfaces({
      sentinels,
      surfaces: {
        polygramSocketEnvelope: polygramPrepared.request,
        memorydProcessorEnvelope: memorydPrepared.request,
        providerRequest,
      },
    });
    rawSecretHits += requestSafety.hitCount;
    if (requestSafety.hitCount > 0) {
      const result = { status: 'failure', errorCode: 'PROCESSOR_REQUEST_SECRET', candidates: [] };
      results.set(fixture.id, result);
      fixtureEvidence.push(evidenceForFixture({
        fixture,
        ...result,
        elapsedMs: 0,
        usage: {},
        responseHash: null,
        safety: requestSafety,
      }));
      continue;
    }

    const started = performance.now();
    let rawResponse;
    let normalized;
    let errorCode = null;
    let attemptCount = 1;
    let errorSafety = { hitCount: 0, hits: [], scannedSurfaces: [], byteCounts: {} };
    try {
      const invocation = await processor.invoke(providerRequest);
      if (
        invocation
        && typeof invocation === 'object'
        && Object.hasOwn(invocation, 'rawResponse')
        && Number.isInteger(invocation.attemptCount)
        && invocation.attemptCount >= 1
        && invocation.attemptCount <= 3
      ) {
        rawResponse = invocation.rawResponse;
        attemptCount = invocation.attemptCount;
      } else {
        rawResponse = invocation;
      }
      normalized = processor.normalize(rawResponse);
    } catch (error) {
      if (Number.isInteger(error?.attemptCount) && error.attemptCount >= 1 && error.attemptCount <= 3) {
        attemptCount = error.attemptCount;
      }
      errorSafety = scanSurfaces({
        sentinels,
        surfaces: { invocationError: ephemeralErrorSurface(error) },
      });
      errorCode = 'PROCESSOR_INVOCATION_FAILED';
      normalized = { stopReason: null, content: '', usage: {} };
    }
    const elapsedMs = performance.now() - started;
    const validated = errorCode ? { ok: false, errorCode } : validateProcessorOutput(normalized);
    const candidates = validated.ok ? validated.candidates : [];
    errorCode = validated.ok ? null : validated.errorCode;
    const status = validated.ok ? 'ok' : 'failure';

    const outputSafety = scanSurfaces({
      sentinels,
      surfaces: {
        providerResponse: rawResponse ?? '',
        ...writeSurfaces(candidates, errorCode),
      },
    });
    const combinedSafety = {
      hitCount: requestSafety.hitCount + outputSafety.hitCount + errorSafety.hitCount,
      hits: [...requestSafety.hits, ...outputSafety.hits, ...errorSafety.hits],
      scannedSurfaces: [
        ...requestSafety.scannedSurfaces,
        ...outputSafety.scannedSurfaces,
        ...errorSafety.scannedSurfaces,
      ],
      byteCounts: {
        ...requestSafety.byteCounts,
        ...outputSafety.byteCounts,
        ...errorSafety.byteCounts,
      },
    };
    rawSecretHits += outputSafety.hitCount + errorSafety.hitCount;
    const effectiveStatus = combinedSafety.hitCount === 0 ? status : 'failure';
    const effectiveError = combinedSafety.hitCount === 0 ? errorCode : 'PROCESSOR_SECRET_SURFACE_HIT';
    const effectiveCandidates = effectiveStatus === 'ok' ? candidates : [];
    const result = {
      status: effectiveStatus,
      errorCode: effectiveError,
      candidates: effectiveCandidates,
    };
    results.set(fixture.id, result);
    fixtureEvidence.push(evidenceForFixture({
      fixture,
      ...result,
      elapsedMs,
      usage: normalized.usage,
      responseHash: rawResponse === undefined ? null : sha256(stableJson(rawResponse)),
      safety: combinedSafety,
      attemptCount,
    }));
  }

  const score = scoreRun({ fixtures, results });
  const evidence = {
    contractVersion: CONTRACT_VERSION,
    runId: safeIdentifier(runId),
    processorId: safeIdentifier(processor.id),
    processorConfigHash: safeSha256(processor.configHash),
    fixtureCount: fixtures.length,
    promptHash: sha256(PROCESSOR_SYSTEM_PROMPT),
    schemaHash: sha256(stableJson(PROCESSOR_JSON_SCHEMA)),
    fixtureManifestHash: hashFixtureManifest(fixtures),
    secretInventory: inventories,
    fixtures: fixtureEvidence,
    score,
    safety: { rawSecretHits },
    passed: score.passed && rawSecretHits === 0,
  };

  const evidenceSafety = scanSurfaces({
    sentinels: allSentinels,
    surfaces: { finalEvidence: evidence },
  });
  if (evidenceSafety.hitCount > 0) {
    return {
      results,
      score,
      safety: { rawSecretHits: rawSecretHits + evidenceSafety.hitCount },
      evidence: {
        contractVersion: CONTRACT_VERSION,
        runId: safeIdentifier(runId),
        processorId: safeIdentifier(processor.id),
        processorConfigHash: safeSha256(processor.configHash),
        fixtureCount: fixtures.length,
        score,
        safety: { rawSecretHits: rawSecretHits + evidenceSafety.hitCount },
        errorCode: 'EVIDENCE_SECRET_SURFACE_HIT',
        passed: false,
      },
    };
  }

  return {
    results,
    score,
    safety: { rawSecretHits },
    evidence,
  };
}

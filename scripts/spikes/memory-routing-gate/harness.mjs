import { prepareRoutingFact, validateRouterOutput } from './contract.mjs';
import { fixtureManifestHash } from './fixtures.mjs';

const PROCESS_RETRY_CODES = new Set([
  'ROUTER_TIMEOUT',
  'ROUTER_PROCESS_EXIT',
  'ROUTER_OUTPUT_TOO_LARGE',
  'ROUTER_STDERR_TOO_LARGE',
]);
const OUTPUT_RETRY_CODES = new Set([
  'ROUTER_OUTPUT_MALFORMED',
  'ROUTER_OUTPUT_MISSING',
  'ROUTER_OUTPUT_SCHEMA',
  'ROUTER_PARTS_OVERLAP',
  'ROUTER_MIXED_AMBIGUOUS',
  'ROUTER_MIXED_COVERAGE',
  'ROUTER_MIXED_SENSITIVE_MISSING',
]);
const CLOSED_ERROR_CODES = new Set([
  ...PROCESS_RETRY_CODES,
  ...OUTPUT_RETRY_CODES,
  'ROUTER_INPUT_INVALID',
  'ROUTER_SECRET_REJECTED',
  'ROUTER_TOOL_USE',
  'ROUTER_OUTPUT_SECRET',
  'ROUTER_PERSONAL_VETO',
  'ROUTER_MIXED_WORK_SENSITIVE',
  'ROUTER_MIXED_NOT_EXTRACTIVE',
  'ROUTER_AUTH_UNAVAILABLE',
  'ROUTER_MODEL_IDENTITY',
  'ROUTER_GATE_FAILURE',
]);
const OBSERVED_MODEL_RE = /^claude-[a-z0-9-]+$/;
const SAFE_OS_SIGNALS = new Set([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP',
  'SIGILL', 'SIGINT', 'SIGIO', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF',
  'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM',
  'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2',
  'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
]);

function compactResult(fixture, status, errorCode = null, category = null) {
  return {
    fixtureId: fixture.id,
    expected: fixture.expected,
    status,
    ...(errorCode ? { errorCode } : {}),
    ...(category ? { category } : {}),
  };
}

export function projectMemberDmOutcome(result) {
  if (result.status === 'operational_error' || result.status === 'mismatch') {
    return { queueForRetry: true, destinations: [] };
  }
  if (result.status === 'quarantined') {
    return { queueForRetry: false, destinations: [] };
  }
  const kinds = Array.isArray(result.partKinds) && result.partKinds.length > 0
    ? result.partKinds
    : result.category === 'personal' ? ['sensitive'] : ['work'];
  return {
    queueForRetry: false,
    writes: kinds.map((kind) => ({
      kind,
      destinations: kind === 'sensitive' ? ['own_private'] : ['own_private', 'general'],
    })),
  };
}

function partMatches(part, terms = []) {
  const normalized = part.text.normalize('NFKC').toLocaleLowerCase('en-US');
  return terms.every((term) => normalized.includes(term));
}

function matchesFixture(fixture, routed) {
  if (routed.category !== fixture.expected) return false;
  if (fixture.expected !== 'mixed') return true;
  const work = routed.parts.find((part) => part.kind === 'work');
  const sensitive = routed.parts.find((part) => part.kind === 'sensitive');
  return Boolean(work && sensitive
    && partMatches(work, fixture.matchers.work)
    && partMatches(sensitive, fixture.matchers.sensitive));
}

function normalizeErrorCode(code, fallback = 'ROUTER_GATE_FAILURE') {
  return CLOSED_ERROR_CODES.has(code) ? code : fallback;
}

function safeObservedModels(response) {
  if (!Array.isArray(response?.observedModels)) return [];
  return [...new Set(response.observedModels.filter((model) => (
    typeof model === 'string' && OBSERVED_MODEL_RE.test(model)
  )))].sort();
}

function responseEvidence(response) {
  const observedModels = safeObservedModels(response);
  return observedModels.length > 0 ? { observedModels } : {};
}

function modelIdentityResolved(adapter, response, observedModels) {
  if (adapter.requireModelEvidence !== true) return true;
  return response?.observedModels?.length === 1
    && observedModels.length === 1
    && observedModels[0].startsWith('claude-haiku-')
    && (!adapter.expectedObservedModel || observedModels[0] === adapter.expectedObservedModel);
}

export function sanitizeProcessDiagnostics(diagnostics = {}) {
  return {
    exitCode: Number.isInteger(diagnostics.exitCode) ? diagnostics.exitCode : null,
    signal: SAFE_OS_SIGNALS.has(diagnostics.signal) ? diagnostics.signal : null,
    stderrBytes: Number.isInteger(diagnostics.stderrBytes) ? diagnostics.stderrBytes : 0,
    cleanupConfirmed: diagnostics.cleanupConfirmed === true,
  };
}

export async function runRoutingCase({ fixture, adapter }) {
  const prepared = prepareRoutingFact(fixture.fact);
  if (!prepared.ok) {
    return compactResult(
      fixture,
      prepared.errorCode === 'ROUTER_SECRET_REJECTED' ? 'quarantined' : 'operational_error',
      prepared.errorCode,
    );
  }
  let response;
  try {
    response = await adapter.route({ fixture, request: prepared.request });
  } catch (error) {
    let errorCode = error?.code
      ? normalizeErrorCode(error.code)
      : 'ROUTER_PROCESS_EXIT';
    if (['ROUTER_INPUT_INVALID', 'ROUTER_SECRET_REJECTED'].includes(errorCode)) {
      errorCode = 'ROUTER_GATE_FAILURE';
    }
    const evidence = responseEvidence(error);
    if (Object.hasOwn(error || {}, 'observedModels')
        && !modelIdentityResolved(adapter, error, evidence.observedModels || [])) {
      return {
        ...compactResult(fixture, 'operational_error', 'ROUTER_MODEL_IDENTITY'),
        ...evidence,
      };
    }
    const result = {
      ...compactResult(fixture, 'operational_error', errorCode),
      ...evidence,
    };
    if (!error?.diagnostics) return result;
    return {
      ...result,
      diagnostics: sanitizeProcessDiagnostics(error.diagnostics),
    };
  }
  const evidence = responseEvidence(response);
  const observedModels = evidence.observedModels || [];
  if (!modelIdentityResolved(adapter, response, observedModels)) {
    return {
      ...compactResult(fixture, 'operational_error', 'ROUTER_MODEL_IDENTITY'),
      ...evidence,
    };
  }
  if ((response?.toolCalls || 0) !== 0) {
    return {
      ...compactResult(fixture, 'operational_error', 'ROUTER_TOOL_USE'),
      ...evidence,
    };
  }
  const routed = validateRouterOutput(response?.raw, { sourceFact: fixture.fact });
  if (!routed.ok) {
    const leaked = (fixture.expected === 'personal' && routed.errorCode === 'ROUTER_PERSONAL_VETO')
      || (fixture.expected === 'mixed'
        && ['ROUTER_MIXED_WORK_SENSITIVE', 'ROUTER_MIXED_NOT_EXTRACTIVE'].includes(routed.errorCode));
    return {
      ...compactResult(fixture, 'operational_error', routed.errorCode),
      ...(leaked ? { privateToWorkLeak: true } : {}),
      ...evidence,
    };
  }
  if (!matchesFixture(fixture, routed)) {
    return {
      ...compactResult(fixture, 'mismatch', 'ROUTER_EXPECTATION_MISMATCH', routed.category),
      ...(fixture.expected === 'personal' && routed.category !== 'personal' ? { privateToWorkLeak: true } : {}),
      ...evidence,
    };
  }
  const result = {
    ...compactResult(fixture, 'accepted', null, routed.category),
    partKinds: routed.parts.map((part) => part.kind),
  };
  return {
    ...result,
    projection: projectMemberDmOutcome(result),
    ...evidence,
  };
}

function retryableResult(result) {
  if (result.status !== 'operational_error') return false;
  if (PROCESS_RETRY_CODES.has(result.errorCode)) return result.diagnostics?.cleanupConfirmed === true;
  return OUTPUT_RETRY_CODES.has(result.errorCode);
}

function normalizeOperationalResult(result) {
  if (result.status !== 'operational_error') return result;
  return {
    ...result,
    errorCode: normalizeErrorCode(result.errorCode),
    ...(result.diagnostics ? { diagnostics: sanitizeProcessDiagnostics(result.diagnostics) } : {}),
  };
}

function attemptCountFor(result) {
  return ['ROUTER_INPUT_INVALID', 'ROUTER_SECRET_REJECTED'].includes(result.errorCode) ? 0 : 1;
}

function firstAttemptEvidence(result) {
  return {
    errorCode: normalizeErrorCode(result.errorCode),
    ...(result.diagnostics ? { diagnostics: sanitizeProcessDiagnostics(result.diagnostics) } : {}),
    privateToWorkLeak: result.privateToWorkLeak === true,
    ...responseEvidence(result),
  };
}

function modelChangedBetweenAttempts(adapter, first, second) {
  if (adapter.requireModelEvidence !== true) return false;
  if (first.observedModels?.length !== 1 || second.observedModels?.length !== 1) return false;
  return first.observedModels[0] !== second.observedModels[0];
}

function finalOutcome(result, attemptCount, firstAttempt) {
  const final = {
    ...result,
    attemptCount,
    ...(firstAttempt ? { firstAttempt } : {}),
  };
  return { ...final, projection: projectMemberDmOutcome(final) };
}

export async function runRoutingCaseWithRetry({ fixture, adapter, runCase = runRoutingCase }) {
  const first = normalizeOperationalResult(await runCase({ fixture, adapter }));
  if (!retryableResult(first)) {
    return finalOutcome(first, attemptCountFor(first));
  }

  const second = normalizeOperationalResult(await runCase({ fixture, adapter }));
  const firstAttempt = firstAttemptEvidence(first);
  if (modelChangedBetweenAttempts(adapter, first, second)) {
    return finalOutcome({
      ...compactResult(fixture, 'operational_error', 'ROUTER_MODEL_IDENTITY'),
      ...responseEvidence(second),
    }, 2, firstAttempt);
  }
  return finalOutcome(second, 2, firstAttempt);
}

export async function runFaultCase({ adapterId, errorCode }) {
  return {
    adapterId,
    errorCode,
    status: 'operational_error',
    destinationSelected: false,
  };
}

const FAULT_CODES = Object.freeze([
  'ROUTER_TIMEOUT',
  'ROUTER_PROCESS_EXIT',
  'ROUTER_OUTPUT_MALFORMED',
  'ROUTER_OUTPUT_SCHEMA',
]);

function faultAdapter(adapterId, errorCode) {
  return {
    id: `${adapterId}:${errorCode}`,
    async route() {
      if (errorCode === 'ROUTER_TIMEOUT' || errorCode === 'ROUTER_PROCESS_EXIT') {
        throw Object.assign(new Error(errorCode), {
          code: errorCode,
          diagnostics: { cleanupConfirmed: true },
        });
      }
      if (errorCode === 'ROUTER_OUTPUT_MALFORMED') return { raw: '{bad', toolCalls: 0 };
      return { raw: '{"category":"work","parts":[]}', toolCalls: 0 };
    },
  };
}

export async function runFaultEvaluation({
  adapterIds,
  fixture,
  repetitions = 5,
  runCase = runRoutingCaseWithRetry,
}) {
  if (!Array.isArray(adapterIds) || adapterIds.length === 0) throw new TypeError('adapterIds are required');
  if (!fixture || fixture.expected !== 'work') throw new TypeError('a work fixture is required');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new TypeError('repetitions must be positive');
  const outcomes = [];
  for (const adapterId of adapterIds) {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const errorCode of FAULT_CODES) {
        const routed = await runCase({ fixture, adapter: faultAdapter(adapterId, errorCode) });
        const projection = routed.projection;
        outcomes.push({
          adapterId,
          errorCode,
          status: routed.status,
          observedErrorCode: routed.errorCode,
          queueForRetry: projection.queueForRetry,
          destinations: projection.destinations,
          attemptCount: routed.attemptCount,
        });
      }
    }
  }
  return {
    caseCount: outcomes.length,
    adapterAttemptCount: outcomes.reduce((sum, row) => sum + row.attemptCount, 0),
    exhaustedRetryCount: outcomes.filter((row) => row.attemptCount === 2
      && row.status !== 'accepted').length,
    queueRequestCount: outcomes.filter((row) => row.queueForRetry).length,
    passed: outcomes.every((row) => row.status === 'operational_error'
      && row.observedErrorCode === row.errorCode
      && row.queueForRetry === true
      && row.destinations.length === 0
      && row.attemptCount === 2),
    outcomes,
  };
}

function summarizeAdapter(adapter, rows) {
  const accepted = rows.filter((row) => row.status === 'accepted').length;
  const quarantined = rows.filter((row) => row.status === 'quarantined').length;
  const privateToWorkLeaks = rows.filter((row) => (
    row.privateToWorkLeak || row.firstAttempt?.privateToWorkLeak
  )).length;
  const operationalErrors = rows.filter((row) => row.status === 'operational_error').length;
  const mismatches = rows.filter((row) => row.status === 'mismatch').length;
  const projected = rows.filter((row) => row.status === 'accepted');
  const acceptedProjectionPassed = projected.every((row) => {
    const expected = row.partKinds.map((kind) => ({
      kind,
      destinations: kind === 'sensitive' ? ['own_private'] : ['own_private', 'general'],
    }));
    return JSON.stringify(row.projection?.writes) === JSON.stringify(expected);
  });
  const operationalRows = rows.filter((row) => row.status === 'operational_error');
  const queueRequestCount = operationalRows.filter((row) => row.projection?.queueForRetry === true).length;
  const destinationFreeQueueRequestCount = operationalRows.filter((row) => (
    row.projection?.queueForRetry === true
      && Array.isArray(row.projection.destinations)
      && row.projection.destinations.length === 0
  )).length;
  const projectionPassed = acceptedProjectionPassed
    && queueRequestCount === operationalErrors
    && destinationFreeQueueRequestCount === operationalErrors;
  const allAttempts = rows.flatMap((row) => [
    ...(row.attemptCount > 0 ? [row.firstAttempt || row] : []),
    ...(row.attemptCount === 2 ? [row] : []),
  ]);
  const modelRows = allAttempts.flatMap((row) => row.observedModels || []);
  const observedModels = [...new Set(modelRows)].sort();
  const modelIdentityFailures = rows.filter((row) => (
    row.errorCode === 'ROUTER_MODEL_IDENTITY'
  )).length;
  const modelIdentityResolved = adapter.requireModelEvidence !== true
    || (projected.length > 0
      && projected.every((row) => row.observedModels?.length === 1)
      && modelIdentityFailures === 0
      && observedModels.length === 1
      && observedModels[0].startsWith('claude-haiku-')
      && (!adapter.expectedObservedModel || observedModels[0] === adapter.expectedObservedModel));
  const zeroAttemptCaseCount = rows.filter((row) => row.attemptCount === 0).length;
  const firstAttemptCaseCount = rows.filter((row) => row.attemptCount > 0).length;
  const retriedCaseCount = rows.filter((row) => row.attemptCount === 2).length;
  const recoveredRetryCount = rows.filter((row) => (
    row.attemptCount === 2 && row.status === 'accepted'
  )).length;
  const exhaustedRetryCount = rows.filter((row) => (
    row.attemptCount === 2 && row.status !== 'accepted'
  )).length;
  const adapterAttemptCount = rows.reduce((sum, row) => sum + row.attemptCount, 0);
  const attemptsWithoutModelEvidence = allAttempts.filter((row) => (
    !Array.isArray(row.observedModels) || row.observedModels.length === 0
  )).length;
  const modelEvidenceAttemptCount = allAttempts.length - attemptsWithoutModelEvidence;
  const privacyFlaggedAttemptCount = allAttempts.filter((row) => row.privateToWorkLeak).length;
  const arithmeticPassed = accepted + quarantined + operationalErrors + mismatches === rows.length
    && zeroAttemptCaseCount + firstAttemptCaseCount === rows.length
    && retriedCaseCount === recoveredRetryCount + exhaustedRetryCount
    && adapterAttemptCount === firstAttemptCaseCount + retriedCaseCount
    && adapterAttemptCount === allAttempts.length;
  return {
    id: adapter.id,
    routeCaseCount: rows.length,
    acceptedCaseCount: accepted,
    quarantinedCaseCount: quarantined,
    privateToWorkLeaks,
    privacyFlaggedAttemptCount,
    operationalErrors,
    mismatches,
    zeroAttemptCaseCount,
    firstAttemptCaseCount,
    retriedCaseCount,
    recoveredRetryCount,
    exhaustedRetryCount,
    adapterAttemptCount,
    attemptsWithoutModelEvidence,
    modelEvidenceAttemptCount,
    arithmeticPassed,
    queueRequestCount,
    destinationFreeQueueRequestCount,
    projectionPassed,
    modelIdentityResolved,
    modelIdentityFailures,
    observedModels,
    passed: privateToWorkLeaks === 0 && operationalErrors === 0 && mismatches === 0
      && projectionPassed && modelIdentityResolved && arithmeticPassed,
    outcomes: rows.map(({
      fixtureId,
      expected,
      status,
      errorCode,
      category,
      diagnostics,
      attemptCount,
      firstAttempt,
      projection,
    }) => ({
      fixtureId, expected, status, errorCode: errorCode || null, category: category || null,
      ...(diagnostics ? { diagnostics } : {}),
      attemptCount,
      ...(firstAttempt ? { firstAttempt } : {}),
      projection,
    })),
  };
}

function hasUnconfirmedProcessCleanup(result) {
  return result.status === 'operational_error'
    && PROCESS_RETRY_CODES.has(result.errorCode)
    && result.diagnostics?.cleanupConfirmed !== true;
}

export async function runRoutingEvaluation({ fixtures, adapters, repetitions = 5 }) {
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new TypeError('repetitions must be positive');
  const summaries = [];
  let stop = false;
  for (const adapter of adapters) {
    const rows = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const fixture of fixtures) {
        const result = await runRoutingCaseWithRetry({ fixture, adapter });
        rows.push(result);
        if (hasUnconfirmedProcessCleanup(result)) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
    summaries.push(summarizeAdapter(adapter, rows));
    if (stop) break;
  }
  return {
    contractVersion: 'scoped-memory-router/v1',
    fixtureManifestHash: fixtureManifestHash(fixtures),
    fixtureCount: fixtures.length,
    repetitions,
    adapters: summaries,
    passed: summaries.length > 0 && summaries.every((summary) => summary.passed),
  };
}

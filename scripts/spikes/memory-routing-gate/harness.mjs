import { prepareRoutingFact, validateRouterOutput } from './contract.mjs';
import { fixtureManifestHash } from './fixtures.mjs';

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
    const result = compactResult(fixture, 'operational_error', error?.code || 'ROUTER_PROCESS_EXIT');
    if (!error?.diagnostics) return result;
    return {
      ...result,
      diagnostics: {
        exitCode: Number.isInteger(error.diagnostics.exitCode) ? error.diagnostics.exitCode : null,
        signal: typeof error.diagnostics.signal === 'string' ? error.diagnostics.signal : null,
        stderrBytes: Number.isInteger(error.diagnostics.stderrBytes) ? error.diagnostics.stderrBytes : 0,
        cleanupConfirmed: error.diagnostics.cleanupConfirmed === true,
      },
    };
  }
  if ((response?.toolCalls || 0) !== 0) {
    return compactResult(fixture, 'operational_error', 'ROUTER_TOOL_USE');
  }
  const routed = validateRouterOutput(response?.raw, { sourceFact: fixture.fact });
  if (!routed.ok) {
    const leaked = (fixture.expected === 'personal' && routed.errorCode === 'ROUTER_PERSONAL_VETO')
      || (fixture.expected === 'mixed'
        && ['ROUTER_MIXED_WORK_SENSITIVE', 'ROUTER_MIXED_NOT_EXTRACTIVE'].includes(routed.errorCode));
    return {
      ...compactResult(fixture, 'operational_error', routed.errorCode),
      ...(leaked ? { privateToWorkLeak: true } : {}),
    };
  }
  if (!matchesFixture(fixture, routed)) {
    return {
      ...compactResult(fixture, 'mismatch', 'ROUTER_EXPECTATION_MISMATCH', routed.category),
      ...(fixture.expected === 'personal' && routed.category !== 'personal' ? { privateToWorkLeak: true } : {}),
    };
  }
  const result = {
    ...compactResult(fixture, 'accepted', null, routed.category),
    partKinds: routed.parts.map((part) => part.kind),
  };
  return {
    ...result,
    projection: projectMemberDmOutcome(result),
    observedModels: Array.isArray(response?.observedModels) ? response.observedModels : [],
  };
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
        throw Object.assign(new Error(errorCode), { code: errorCode });
      }
      if (errorCode === 'ROUTER_OUTPUT_MALFORMED') return { raw: '{bad', toolCalls: 0 };
      return { raw: '{"category":"work","parts":[]}', toolCalls: 0 };
    },
  };
}

export async function runFaultEvaluation({ adapterIds, fixture, repetitions = 5, runCase = runRoutingCase }) {
  if (!Array.isArray(adapterIds) || adapterIds.length === 0) throw new TypeError('adapterIds are required');
  if (!fixture || fixture.expected !== 'work') throw new TypeError('a work fixture is required');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new TypeError('repetitions must be positive');
  const outcomes = [];
  for (const adapterId of adapterIds) {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const errorCode of FAULT_CODES) {
        const routed = await runCase({ fixture, adapter: faultAdapter(adapterId, errorCode) });
        const projection = projectMemberDmOutcome(routed);
        outcomes.push({
          adapterId,
          errorCode,
          status: routed.status,
          observedErrorCode: routed.errorCode,
          queueForRetry: projection.queueForRetry,
          destinations: projection.destinations,
        });
      }
    }
  }
  return {
    caseCount: outcomes.length,
    passed: outcomes.every((row) => row.status === 'operational_error'
      && row.observedErrorCode === row.errorCode
      && row.queueForRetry === true
      && row.destinations.length === 0),
    outcomes,
  };
}

function summarizeAdapter(adapter, rows) {
  const accepted = rows.filter((row) => row.status === 'accepted').length;
  const quarantined = rows.filter((row) => row.status === 'quarantined').length;
  const privateToWorkLeaks = rows.filter((row) => row.privateToWorkLeak).length;
  const operationalErrors = rows.filter((row) => row.status === 'operational_error').length;
  const mismatches = rows.filter((row) => row.status === 'mismatch').length;
  const projected = rows.filter((row) => row.status === 'accepted');
  const projectionPassed = projected.every((row) => {
    const expected = row.partKinds.map((kind) => ({
      kind,
      destinations: kind === 'sensitive' ? ['own_private'] : ['own_private', 'general'],
    }));
    return JSON.stringify(row.projection?.writes) === JSON.stringify(expected);
  });
  const modelRows = projected.flatMap((row) => row.observedModels || []);
  const observedModels = [...new Set(modelRows)].sort();
  const modelIdentityResolved = adapter.requireModelEvidence !== true
    || (projected.length > 0
      && projected.every((row) => row.observedModels?.length === 1)
      && observedModels.length === 1
      && observedModels[0].startsWith('claude-haiku-')
      && (!adapter.expectedObservedModel || observedModels[0] === adapter.expectedObservedModel));
  return {
    id: adapter.id,
    routeCaseCount: rows.length,
    acceptedCaseCount: accepted,
    quarantinedCaseCount: quarantined,
    privateToWorkLeaks,
    operationalErrors,
    mismatches,
    projectionPassed,
    modelIdentityResolved,
    observedModels,
    passed: privateToWorkLeaks === 0 && operationalErrors === 0 && mismatches === 0
      && projectionPassed && modelIdentityResolved,
    outcomes: rows.map(({ fixtureId, expected, status, errorCode, category, diagnostics }) => ({
      fixtureId, expected, status, errorCode: errorCode || null, category: category || null,
      ...(diagnostics ? { diagnostics } : {}),
    })),
  };
}

export async function runRoutingEvaluation({ fixtures, adapters, repetitions = 5 }) {
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new TypeError('repetitions must be positive');
  const summaries = [];
  for (const adapter of adapters) {
    const rows = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const fixture of fixtures) rows.push(await runRoutingCase({ fixture, adapter }));
    }
    summaries.push(summarizeAdapter(adapter, rows));
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

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  createDelayedMcpLifecycleProof,
  evaluateDelayedMcpEvidence,
} from './delayed-mcp-gate.mjs';
import {
  collectGateLifecycleEvidence,
  collectGateSessionEvidence,
  normalizedGateLifecycleRecordSchemaMatches,
  processEvidenceSchemaMatches,
  readGateJsonlRecords,
  sanitizedGateResultSchemaMatches,
  validateWrapperProvenance,
} from './claude-gate-evidence.mjs';
import { hashSensitiveString } from './claude-executable.mjs';
import {
  createSubagentLifecycleProof,
  evaluateSubagentEvidence,
} from './subagent-gate.mjs';
import {
  evaluateOpusProjection,
  WORKFLOW_GATE_ORIGIN_ROUTE,
} from './workflow-fixture.mjs';

const require = createRequire(import.meta.url);
const { encodeCwd } = require('../../lib/util/claude-session-jsonl');

const RUN_PREFIX_RE = /^[A-Za-z0-9._-]{1,96}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const AUTHORITATIVE_RUN_COUNT = 21;
const RUNNER_OWNED_ENV_KEYS = new Set([
  'CLAUDE_GATE_BIN',
  'CLAUDE_GATE_EXPECTED_VERSION',
  'CLAUDE_GATE_ARTIFACT_BASE',
  'CLAUDE_GATE_RUN_ID',
  'CLAUDE_GATE_EFFORT',
  'CLAUDE_GATE_SCENARIO_ID',
  'CLAUDE_GATE_EXPECTED_RESOLVED_MODEL',
  'CLAUDE_GATE_DOCUMENTED_WORKFLOW_SIZE_GUIDELINE',
]);
const CROSS_VERSION_POLICIES = new Set(['single', 'all-pairs']);
const VERSION_SPECIFIC_LIFECYCLE_ORACLES = new Map([
  ['delayed-mcp', 'delayed-mcp-v1'],
  ['sdk-subagent', 'sdk-subagent-v1'],
]);
const EVIDENCE_SOURCE_REGISTRY = new Map([
  ['cli-contract', {
    session: 'session.jsonl',
    hooks: 'hooks.ndjson',
  }],
  ['workflow-direct', {
    session: 'session.jsonl',
    hooks: 'hooks.ndjson',
  }],
  ['workflow-fallback', {
    session: 'session.jsonl',
    hooks: 'hooks.ndjson',
  }],
  ['delayed-mcp', {
    sdk: 'sdk-stream.ndjson',
  }],
  ['sdk-subagent', {
    sdk: 'sdk-stream.ndjson',
  }],
  ['candidate-opus-projection', {
    sdk: 'sdk-stream.ndjson',
  }],
]);

function expectedEvidenceSources(scenario) {
  const expected = EVIDENCE_SOURCE_REGISTRY.get(scenario?.id);
  if (!expected) {
    if (scenario?.evidenceSources !== undefined) {
      throw new TypeError(`${scenario?.id} must not declare lifecycle sources`);
    }
    return null;
  }
  if (!isDeepStrictEqual(scenario.evidenceSources, expected)) {
    throw new TypeError(`${scenario.id} lifecycle sources do not match the registry`);
  }
  return expected;
}

function normalizeComparisonPolicy(scenario) {
  const repeatCount = scenario?.comparison?.runsPerVersion ?? 1;
  if (
    !Number.isInteger(repeatCount)
    || repeatCount < 1
    || repeatCount > 5
  ) {
    throw new TypeError(`${scenario?.id || 'scenario'} runsPerVersion must be an integer from 1 to 5`);
  }
  const sameVersion = scenario?.comparison?.sameVersion ?? null;
  if (
    (sameVersion !== null && sameVersion !== 'required')
    || (repeatCount > 1 && sameVersion !== 'required')
  ) {
    throw new TypeError(`${scenario?.id || 'scenario'} repeated runs require same-version comparison`);
  }
  const crossVersion = scenario?.comparison?.crossVersion ?? 'single';
  if (!CROSS_VERSION_POLICIES.has(crossVersion)) {
    throw new TypeError(`${scenario?.id || 'scenario'} crossVersion comparison is not recognized`);
  }
  return { repeatCount, sameVersion, crossVersion };
}

function normalizeAcceptancePolicy(scenario) {
  const maxBridgeReadyToMcpReadyMs =
    scenario?.acceptance?.maxBridgeReadyToMcpReadyMs;
  if (
    maxBridgeReadyToMcpReadyMs !== undefined
    && (
      !Number.isInteger(maxBridgeReadyToMcpReadyMs)
      || maxBridgeReadyToMcpReadyMs <= 0
    )
  ) {
    throw new TypeError(
      `${scenario?.id || 'scenario'} maxBridgeReadyToMcpReadyMs must be a positive integer`,
    );
  }
  return { maxBridgeReadyToMcpReadyMs };
}

export function assertSafeRunPrefix(runPrefix) {
  if (!RUN_PREFIX_RE.test(runPrefix || '') || /^\.+$/.test(runPrefix)) {
    throw new TypeError('unsafe run prefix');
  }
  return runPrefix;
}

export function buildClaudeMatrixChildEnv(parentEnv, runEnv) {
  if (
    parentEnv === null
    || typeof parentEnv !== 'object'
    || Array.isArray(parentEnv)
    || runEnv === null
    || typeof runEnv !== 'object'
    || Array.isArray(runEnv)
  ) {
    throw new TypeError('parentEnv and runEnv must be objects');
  }
  const childEnv = { ...parentEnv };
  delete childEnv.CLAUDE_AUTO_BACKGROUND_TASKS;
  return {
    ...childEnv,
    ...runEnv,
  };
}

function versionSpecificLifecyclePolicyMatches(scenario, oracle) {
  const policy = scenario?.comparison?.lifecycle;
  return (
    policy !== null
    && typeof policy === 'object'
    && !Array.isArray(policy)
    && Object.keys(policy).sort().join('\0') === 'mode\0oracle'
    && policy.mode === 'version-specific-oracle'
    && policy.oracle === oracle
  );
}

function versionSpecificLifecycleMatches(result, oracle, isCandidate) {
  try {
    if (oracle === 'delayed-mcp-v1') {
      const expectedMode = isCandidate ? 'background' : 'foreground';
      return (
        result?.evidence?.expectedMode === expectedMode
        && evaluateDelayedMcpEvidence(result.evidence).pass
      );
    }
    if (oracle === 'sdk-subagent-v1') {
      return evaluateSubagentEvidence(result, { isCandidate }).pass;
    }
    return false;
  } catch {
    return false;
  }
}

export function buildClaudeMatrixRuns({
  manifest,
  binaries,
  artifactBaseDir,
  runPrefix,
}) {
  if (!manifest?.versions || !Array.isArray(manifest?.scenarios)) {
    throw new TypeError('manifest must contain versions and scenarios');
  }
  if (!path.isAbsolute(artifactBaseDir || '')) {
    throw new TypeError('artifactBaseDir must be absolute');
  }
  assertSafeRunPrefix(runPrefix);
  for (const versionKey of ['old', 'candidate']) {
    if (!path.isAbsolute(binaries?.[versionKey] || '')) {
      throw new TypeError(`${versionKey} binary must be absolute`);
    }
  }

  const runs = [];
  for (const versionKey of ['old', 'candidate']) {
    for (const scenario of manifest.scenarios) {
      if (versionKey === 'old' && scenario.candidateOnly) continue;
      for (const environment of [
        scenario.environment?.common,
        scenario.environment?.[versionKey],
      ]) {
        for (const key of Object.keys(environment || {})) {
          if (RUNNER_OWNED_ENV_KEYS.has(key)) {
            throw new TypeError(`${key} is runner-owned`);
          }
        }
      }
      const versionSpecificLifecycleOracle =
        VERSION_SPECIFIC_LIFECYCLE_ORACLES.get(scenario.id);
      if (
        versionSpecificLifecycleOracle
        && !versionSpecificLifecyclePolicyMatches(
          scenario,
          versionSpecificLifecycleOracle,
        )
      ) {
        throw new TypeError(
          `${scenario.id} must declare the ${versionSpecificLifecycleOracle} lifecycle oracle`,
        );
      }
      const { repeatCount } = normalizeComparisonPolicy(scenario);
      const evidenceSources = expectedEvidenceSources(scenario);
      const {
        maxBridgeReadyToMcpReadyMs,
      } = normalizeAcceptancePolicy(scenario);

      for (let repeatIndex = 1; repeatIndex <= repeatCount; repeatIndex += 1) {
        const repeatSuffix = repeatCount > 1 ? `-${repeatIndex}` : '';
        const idSuffix = repeatCount > 1 ? `:${repeatIndex}` : '';
        const runId = `${runPrefix}-${versionKey}-${scenario.id}${repeatSuffix}`;
        runs.push({
          id: `${versionKey}:${scenario.id}${idSuffix}`,
          versionKey,
          scenarioId: scenario.id,
          repeatIndex,
          repeatCount,
          pairComparisonRequired: (
            repeatIndex === repeatCount
            && (
              (
                !scenario.candidateOnly
                && versionKey === 'candidate'
              )
              || scenario.comparison?.lifecycle?.mode
                === 'projected-compatible'
              || repeatCount > 1
            )
          ),
          version: manifest.versions[versionKey],
          model: versionKey === 'candidate' && scenario.candidateOnly
            ? scenario.environment?.candidate?.CLAUDE_GATE_MODEL
              || manifest.comparator.model
            : manifest.comparator.model,
          expectedResolvedModel: scenario.expectedResolvedModel
            || manifest.comparator.model,
          ...(maxBridgeReadyToMcpReadyMs !== undefined && {
            maxBridgeReadyToMcpReadyMs,
          }),
          ...(versionSpecificLifecycleOracle && {
            versionSpecificLifecycleOracle,
          }),
          ...(evidenceSources && {
            evidenceSources: structuredClone(evidenceSources),
          }),
          ...(scenario.id === 'candidate-opus-projection' && {
            nestedWorkflowLifecyclePolicy: structuredClone(
              manifest.scenarios.find(
                ({ id }) => id === 'workflow-direct',
              )?.comparison?.lifecycle,
            ),
          }),
          effort: manifest.comparator.effort,
          driver: scenario.driver,
          args: [...(scenario.args?.[versionKey] || [])],
          env: {
            CLAUDE_GATE_BIN: binaries[versionKey],
            CLAUDE_GATE_EXPECTED_VERSION: manifest.versions[versionKey],
            CLAUDE_GATE_ARTIFACT_BASE: artifactBaseDir,
            CLAUDE_GATE_RUN_ID: runId,
            CLAUDE_GATE_MODEL: manifest.comparator.model,
            CLAUDE_GATE_EFFORT: manifest.comparator.effort,
            CLAUDE_GATE_SCENARIO_ID: scenario.id,
            ...(scenario.environment?.common || {}),
            ...(scenario.environment?.[versionKey] || {}),
            ...(versionKey === 'candidate' && scenario.expectedResolvedModel && {
              CLAUDE_GATE_EXPECTED_RESOLVED_MODEL: scenario.expectedResolvedModel,
            }),
            ...(versionKey === 'candidate' && scenario.documentedWorkflowSizeGuideline && {
              CLAUDE_GATE_DOCUMENTED_WORKFLOW_SIZE_GUIDELINE:
                scenario.documentedWorkflowSizeGuideline,
            }),
          },
          cost: scenario.cost,
          oracle: scenario.oracle[versionKey],
          artifactCollector: scenario.artifactCollector,
        });
      }
    }
  }
  return runs;
}

function fieldAt(value, dottedPath) {
  return dottedPath.split('.').reduce(
    (current, part) => current?.[part],
    value,
  );
}

function hasFieldAt(value, dottedPath) {
  let current = value;
  for (const part of dottedPath.split('.')) {
    if (
      !current
      || typeof current !== 'object'
      || !Object.hasOwn(current, part)
    ) {
      return false;
    }
    current = current[part];
  }
  return true;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function summarizeLifecycleShape(lifecycle) {
  const streams = Array.isArray(lifecycle)
    ? [['default', lifecycle]]
    : lifecycle && typeof lifecycle === 'object'
      ? Object.entries(lifecycle)
        .filter(([, records]) => Array.isArray(records))
        .sort(([left], [right]) => left.localeCompare(right))
      : [];
  if (streams.length === 0) return null;

  return Object.fromEntries(streams.map(([name, records]) => {
    const canonicalRecords = records.map(canonicalValue);
    const shapeCounts = new Map();
    for (const record of canonicalRecords) {
      const encoded = JSON.stringify(record);
      shapeCounts.set(encoded, (shapeCounts.get(encoded) || 0) + 1);
    }
    const recordShapeCounts = [...shapeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([record, count]) => ({
        record: JSON.parse(record),
        count,
      }));
    const pivotalSequence = canonicalRecords.filter(
      (record) => record?.type === 'hook' || isSessionPivotal(record),
    );
    return [name, { recordShapeCounts, pivotalSequence }];
  }));
}

export function summarizeSdkLifecycleSemantics(lifecycle) {
  if (!Array.isArray(lifecycle) || lifecycle.length === 0) return null;
  const records = lifecycle.filter((record) => (
    record?.type !== 'rate_limit_event'
    && !(record?.type === 'system' && record.subtype === 'thinking_tokens')
    && !(
      record?.type === 'assistant'
      && record.toolNames?.length === 0
      && record.contentTypes?.length > 0
      && record.contentTypes.every((type) => type === 'thinking')
    )
  )).map(canonicalValue);
  if (records.length === 0) return null;
  const counts = new Map();
  for (const record of records) {
    const encoded = JSON.stringify(record);
    counts.set(encoded, (counts.get(encoded) || 0) + 1);
  }
  return {
    recordShapeCounts: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([record, count]) => ({
        record: JSON.parse(record),
        count,
      })),
    boundarySequence: records.filter((record) => (
      record.type === 'result'
      || (record.type === 'system' && record.subtype === 'init')
    )),
  };
}

function isSessionPivotal(record) {
  return (
    record?.type === 'queue-operation'
    || record?.type === 'attachment'
    || (record?.type === 'system' && record.subtype !== 'init')
    || (
      record?.type === 'user'
      && (
        record.hasTaskNotification
        || record.originKind
        || record.promptSource
      )
    )
  );
}

function matchesSelector(record, selector) {
  if (
    !selector
    || typeof selector !== 'object'
    || Array.isArray(selector)
  ) {
    return false;
  }
  return Object.entries(selector).every(
    ([key, value]) => JSON.stringify(record?.[key]) === JSON.stringify(value),
  );
}

function projectLifecycle(lifecycle, policy) {
  if (
    !lifecycle
    || typeof lifecycle !== 'object'
    || Array.isArray(lifecycle)
    || !policy?.streams
    || typeof policy.streams !== 'object'
    || Array.isArray(policy.streams)
  ) {
    return null;
  }
  const expectedStreams = Object.keys(policy.streams).sort();
  const actualStreams = Object.keys(lifecycle).sort();
  if (JSON.stringify(actualStreams) !== JSON.stringify(expectedStreams)) {
    return null;
  }

  const projected = {};
  for (const stream of expectedStreams) {
    const streamPolicy = policy.streams[stream];
    if (
      !Array.isArray(lifecycle[stream])
      || lifecycle[stream].some(
        (record) => !isNormalizedLifecycleRecord(record),
      )
    ) {
      return null;
    }
    const records = lifecycle[stream].map(canonicalValue);
    if (streamPolicy?.projection === 'session-pivotal-v1') {
      projected[stream] = records.filter(isSessionPivotal);
    } else if (
      streamPolicy?.projection === 'matching-records'
      && Array.isArray(streamPolicy.selectors)
      && streamPolicy.selectors.length > 0
    ) {
      projected[stream] = records.filter((record) => (
        streamPolicy.selectors.some((selector) => (
          matchesSelector(record, selector)
        ))
      ));
    } else {
      return null;
    }
  }
  return projected;
}

function encoded(value) {
  return JSON.stringify(canonicalValue(value));
}

function isNormalizedLifecycleRecord(record) {
  return normalizedGateLifecycleRecordSchemaMatches(record);
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const TASK_REMINDER_RECORD = {
  type: 'attachment',
  attachmentType: 'task_reminder',
};
const HOOK_CANCELLED_RECORD = {
  type: 'attachment',
  attachmentType: 'hook_cancelled',
};
const REMOVAL_PROOF_KEYS = [
  'filteredEventCount',
  'flattenedEventsEqual',
  'flushBatchEqual',
  'originalEventCount',
  'retainedPushBatchesEqual',
  'sourceSha256',
  'stream',
  'targetBatchesEmpty',
  'targets',
  'totalTargetCount',
  'type',
];
const REMOVAL_TARGET_KEYS = [
  'eligibility',
  'normalizedTargetCount',
  'rawTargetCount',
  'record',
];

function hasExactKeys(value, keys) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && encoded(Object.keys(value).sort()) === encoded([...keys].sort())
  );
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isTaskReminderInsertion(insertion) {
  return (
    hasExactKeys(insertion, ['count', 'proof', 'record', 'stream'])
    && insertion.stream === 'session'
    && insertion.count === 1
    && encoded(insertion.record) === encoded(TASK_REMINDER_RECORD)
    && hasExactKeys(insertion.proof, ['eligibility', 'type'])
    && insertion.proof.type === 'session-event-aggregator-removal'
    && insertion.proof.eligibility === 'task-reminder-v1'
  );
}

function isHookCancelledInsertion(insertion) {
  return (
    hasExactKeys(insertion, ['maxCount', 'proof', 'record', 'stream'])
    && insertion.stream === 'session'
    && insertion.maxCount === 1
    && encoded(insertion.record) === encoded(HOOK_CANCELLED_RECORD)
    && hasExactKeys(insertion.proof, ['eligibility', 'type'])
    && insertion.proof.type === 'session-event-aggregator-removal'
    && insertion.proof.eligibility
      === 'interrupt-user-prompt-submit-v1'
  );
}

function lifecycleSourceMatches(result) {
  const sources = result?.lifecycleSources;
  const source = sources?.session;
  return (
    sources
    && typeof sources === 'object'
    && !Array.isArray(sources)
    && hasExactKeys(source, [
      'file',
      'normalizedRecordCount',
      'rawRecordCount',
      'sha256',
      'stream',
    ])
    && source.file === 'session.jsonl'
    && source.stream === 'session'
    && SHA256_RE.test(source.sha256)
    && Number.isInteger(source.rawRecordCount)
    && source.rawRecordCount > 0
    && source.rawRecordCount === source.normalizedRecordCount
    && Array.isArray(result?.lifecycle?.session)
    && source.normalizedRecordCount === result?.lifecycle?.session?.length
  );
}

function insertionKey(insertion) {
  return `${insertion.stream}\0${encoded(insertion.record)}`;
}

function declaredInsertions(policy, isCandidate) {
  const candidateOnly = policy?.candidateOnlyInsertions;
  const optional = policy?.optionalInsertions;
  if (
    !Array.isArray(candidateOnly)
    || candidateOnly.some((insertion) => !isTaskReminderInsertion(insertion))
    || !Array.isArray(optional)
    || optional.some((insertion) => !isHookCancelledInsertion(insertion))
  ) {
    return null;
  }
  const all = [
    ...candidateOnly.map((insertion) => ({
      ...insertion,
      expectedCount: isCandidate ? insertion.count : 0,
      optional: false,
    })),
    ...optional.map((insertion) => ({
      ...insertion,
      optional: true,
    })),
  ];
  const keys = all.map(insertionKey);
  if (new Set(keys).size !== keys.length) return null;
  return all;
}

function proofTargetEligibilityMatches(target, declaration) {
  const eligibility = target?.eligibility;
  if (declaration.proof.eligibility === 'task-reminder-v1') {
    return (
      hasExactKeys(eligibility, ['type'])
      && eligibility.type === declaration.proof.eligibility
    );
  }
  return (
    hasExactKeys(eligibility, [
      'allHookNamesMatch',
      'allMainline',
      'allParentsMatchInterrupt',
      'type',
    ])
    && eligibility.type === declaration.proof.eligibility
    && eligibility.allHookNamesMatch === true
    && eligibility.allMainline === true
    && eligibility.allParentsMatchInterrupt === true
  );
}

function removalProofMatches({
  proof,
  declarations,
  targetCounts,
  sourceSha256,
}) {
  const nonEmptyDeclarations = declarations.filter(
    (declaration) => targetCounts.get(insertionKey(declaration)) > 0,
  );
  if (nonEmptyDeclarations.length === 0) return proof === null;
  if (
    !hasExactKeys(proof, REMOVAL_PROOF_KEYS)
    || proof.type !== 'session-event-aggregator-removal'
    || proof.stream !== 'session'
    || proof.sourceSha256 !== sourceSha256
    || !Array.isArray(proof.targets)
    || proof.targets.length !== nonEmptyDeclarations.length
    || proof.targetBatchesEmpty !== true
    || proof.retainedPushBatchesEqual !== true
    || proof.flushBatchEqual !== true
    || proof.flattenedEventsEqual !== true
    || !isNonNegativeInteger(proof.originalEventCount)
    || proof.originalEventCount !== proof.filteredEventCount
  ) {
    return false;
  }
  const proofTargets = new Map();
  for (const target of proof.targets) {
    if (!hasExactKeys(target, REMOVAL_TARGET_KEYS)) return false;
    const key = `session\0${encoded(target.record)}`;
    if (proofTargets.has(key)) return false;
    proofTargets.set(key, target);
  }
  if (
    proof.totalTargetCount
      !== [...targetCounts.values()].reduce((sum, count) => sum + count, 0)
  ) {
    return false;
  }
  return nonEmptyDeclarations.every((declaration) => {
    const key = insertionKey(declaration);
    const count = targetCounts.get(key);
    const target = proofTargets.get(key);
    return (
      target
      && target.rawTargetCount === count
      && target.normalizedTargetCount === count
      && proofTargetEligibilityMatches(target, declaration)
    );
  });
}

function insertionEvidence({ result, policy, isCandidate }) {
  const declarations = declaredInsertions(policy, isCandidate);
  if (
    declarations === null
    || !lifecycleSourceMatches(result)
    || !Array.isArray(result?.lifecycleProofs)
  ) {
    return null;
  }
  const targetCounts = new Map();
  for (const declaration of declarations) {
    const count = result.lifecycle[declaration.stream].filter(
      (record) => encoded(record) === encoded(declaration.record),
    ).length;
    if (
      declaration.optional
        ? count > declaration.maxCount
        : count !== declaration.expectedCount
    ) {
      return null;
    }
    targetCounts.set(insertionKey(declaration), count);
  }
  const totalTargetCount = [...targetCounts.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  if (
    result.lifecycleProofs.length !== (totalTargetCount > 0 ? 1 : 0)
    || !removalProofMatches({
      proof: result.lifecycleProofs[0] || null,
      declarations,
      targetCounts,
      sourceSha256: result.lifecycleSources.session.sha256,
    })
  ) {
    return null;
  }
  return { declarations, targetCounts };
}

function adjustedProjectedLifecycle({ result, policy, isCandidate }) {
  const evidence = insertionEvidence({ result, policy, isCandidate });
  if (evidence === null) return null;
  const projection = projectLifecycle(result.lifecycle, policy);
  if (projection === null) return null;
  const adjusted = structuredClone(projection);
  for (const declaration of evidence.declarations) {
    const expectedRecord = encoded(declaration.record);
    const expectedCount = evidence.targetCounts.get(
      insertionKey(declaration),
    );
    const matchingIndices = adjusted[declaration.stream]
      .flatMap((record, index) => (
        encoded(record) === expectedRecord ? [index] : []
      ));
    if (matchingIndices.length !== expectedCount) return null;
    for (const index of matchingIndices.reverse()) {
      adjusted[declaration.stream].splice(index, 1);
    }
  }
  return adjusted;
}

function compareProjectedLifecycle({
  leftResult,
  rightResult,
  policy,
  leftIsCandidate,
  rightIsCandidate,
}) {
  const leftProjection = adjustedProjectedLifecycle({
    result: leftResult,
    policy,
    isCandidate: leftIsCandidate,
  });
  const rightProjection = adjustedProjectedLifecycle({
    result: rightResult,
    policy,
    isCandidate: rightIsCandidate,
  });
  return (
    leftProjection !== null
    && rightProjection !== null
    && encoded(leftProjection) === encoded(rightProjection)
  );
}

function projectedBaseline(policy) {
  const baseline = policy?.projectedBaseline;
  if (
    !baseline
    || typeof baseline !== 'object'
    || Array.isArray(baseline)
    || !policy?.streams
    || typeof policy.streams !== 'object'
    || Array.isArray(policy.streams)
  ) {
    return null;
  }
  const expectedStreams = Object.keys(policy.streams).sort();
  const baselineStreams = Object.keys(baseline).sort();
  if (encoded(expectedStreams) !== encoded(baselineStreams)) return null;
  if (baselineStreams.some((stream) => (
    !Array.isArray(baseline[stream])
    || baseline[stream].some((record) => !isNormalizedLifecycleRecord(record))
  ))) {
    return null;
  }
  return canonicalValue(baseline);
}

function matchesProjectedBaseline({
  result,
  policy,
  isCandidate,
}) {
  const baseline = projectedBaseline(policy);
  if (baseline === null) return false;
  const adjusted = adjustedProjectedLifecycle({
    result,
    policy,
    isCandidate,
  });
  return adjusted !== null && encoded(adjusted) === encoded(baseline);
}

function lifecycleRecords(lifecycle) {
  if (Array.isArray(lifecycle)) return lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object') return [];
  return Object.values(lifecycle).flatMap((records) => (
    Array.isArray(records) ? records : []
  ));
}

function lifecycleForStream(result, stream) {
  if (stream === 'sdk') return Array.isArray(result?.lifecycle)
    ? result.lifecycle
    : null;
  return Array.isArray(result?.lifecycle?.[stream])
    ? result.lifecycle[stream]
    : null;
}

function privateLifecycleSourcesMatch({
  run,
  result,
  privateArtifactDir,
}) {
  const expected = run?.evidenceSources;
  if (!expected) {
    return (
      result?.lifecycleSources === undefined
      && result?.lifecycleProofs === undefined
    );
  }
  if (
    !hasExactKeys(result?.lifecycleSources, Object.keys(expected))
    || !Array.isArray(result?.lifecycleProofs)
    || typeof privateArtifactDir !== 'string'
    || !path.isAbsolute(privateArtifactDir)
    || !fs.existsSync(privateArtifactDir)
  ) {
    return false;
  }
  const privateStat = fs.lstatSync(privateArtifactDir);
  if (privateStat.isSymbolicLink() || !privateStat.isDirectory()) return false;
  const realPrivateDir = fs.realpathSync(privateArtifactDir);
  let regeneratedSessionProofs = [];
  let privateSdkRecords = null;

  for (const [stream, file] of Object.entries(expected)) {
    if (
      !['hooks', 'sdk', 'session'].includes(stream)
      || !/^[A-Za-z0-9._-]+$/.test(file)
      || file === '.'
      || file === '..'
      || path.basename(file) !== file
    ) {
      return false;
    }
    const source = result.lifecycleSources[stream];
    if (
      !hasExactKeys(source, [
        'file',
        'normalizedRecordCount',
        'rawRecordCount',
        'sha256',
        'stream',
      ])
      || source.stream !== stream
      || source.file !== file
    ) {
      return false;
    }
    const sourcePath = path.join(realPrivateDir, file);
    if (!fs.existsSync(sourcePath)) return false;
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    if (
      fs.realpathSync(sourcePath) !== sourcePath
      || !sourcePath.startsWith(`${realPrivateDir}${path.sep}`)
    ) {
      return false;
    }
    let collected;
    if (stream === 'session') {
      collected = collectGateSessionEvidence(
        sourcePath,
        run.scenarioId === 'cli-contract'
          ? {
              interruptSourceMsgId: 5,
              channelServerName: 'polygram-gate-bridge',
            }
          : {},
      );
      regeneratedSessionProofs = collected.proofs;
    } else {
      collected = collectGateLifecycleEvidence(sourcePath, { stream });
    }
    if (
      !isDeepStrictEqual(collected.source, source)
      || !isDeepStrictEqual(
        collected.records,
        lifecycleForStream(result, stream),
      )
    ) {
      return false;
    }
    if (stream === 'sdk') {
      privateSdkRecords = readGateJsonlRecords(sourcePath);
    }
  }

  if (!isDeepStrictEqual(regeneratedSessionProofs, result.lifecycleProofs)) {
    return false;
  }
  if (
    run.scenarioId === 'sdk-subagent'
    && !isDeepStrictEqual(
      createSubagentLifecycleProof(privateSdkRecords),
      result.subagentLifecycleProof,
    )
  ) {
    return false;
  }
  if (run.scenarioId === 'delayed-mcp') {
    const claimedProof = result?.evidence?.nativeLifecycleProof;
    let regeneratedProof;
    try {
      regeneratedProof = createDelayedMcpLifecycleProof(privateSdkRecords, {
        expectedMode: result?.evidence?.expectedMode,
        markerHash: result?.markerHash,
        asyncPlaceholder: claimedProof?.statuses?.asyncPlaceholder,
        timing: claimedProof?.timing,
      });
    } catch {
      return false;
    }
    if (!isDeepStrictEqual(regeneratedProof, claimedProof)) return false;
    const terminalResults = privateSdkRecords.filter(
      (record) => record?.type === 'result',
    );
    if (
      terminalResults.length !== 1
      || terminalResults[0].subtype !== result.resultSubtype
      || terminalResults[0].subtype !== result?.evidence?.resultSubtype
    ) {
      return false;
    }
  }
  return true;
}

function independentAttestationMatches(run, result) {
  if (!run?.env) return true;
  const executablePath = run.env.CLAUDE_GATE_BIN;
  if (
    typeof executablePath !== 'string'
    || !path.isAbsolute(executablePath)
    || !fs.existsSync(executablePath)
  ) {
    return false;
  }
  const stat = fs.lstatSync(executablePath);
  if (!stat.isFile()) return false;
  const realExecutable = fs.realpathSync(executablePath);
  const bytes = fs.readFileSync(realExecutable);
  const executableSha256 = crypto
    .createHash('sha256')
    .update(bytes)
    .digest('hex');
  const executablePathHash = crypto
    .createHash('sha256')
    .update(realExecutable)
    .digest('hex');
  const wrapperRequired = run.versionKey === 'candidate';
  return (
    result.attestation.runId === run.env.CLAUDE_GATE_RUN_ID
    && result.attestation.version === run.version
    && result.attestation.sha256 === executableSha256
    && result.attestation.executablePathHash === executablePathHash
    && result.attestation.wrapperRequired === wrapperRequired
    && result.attestation.model === run.model
    && result.attestation.effort === run.effort
  );
}

function readPrivateProcessFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function privateWrapperRecords(privateArtifactDir) {
  const recordsPath = path.join(
    path.dirname(privateArtifactDir),
    'process-wrapper.ndjson',
  );
  const content = readPrivateProcessFile(recordsPath);
  if (content === null) return [];
  return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function privateCliProcessTree(privateArtifactDir) {
  const discoveredNames = fs.readdirSync(privateArtifactDir)
    .filter((name) => /^process-tree-[A-Za-z0-9._-]+\.json$/.test(name))
    .sort();
  const indexContent = readPrivateProcessFile(path.join(
    privateArtifactDir,
    'process-tree-index.ndjson',
  ));
  if (indexContent === null) return null;
  const names = indexContent.split(/\r?\n/).filter(Boolean).map((line) => {
    const entry = JSON.parse(line);
    return hasExactKeys(entry, ['file'])
      && /^process-tree-[A-Za-z0-9._-]+\.json$/.test(entry.file)
      ? entry.file
      : null;
  });
  if (
    names.length === 0
    || names.includes(null)
    || new Set(names).size !== names.length
    || !isDeepStrictEqual([...names].sort(), discoveredNames)
  ) {
    return null;
  }
  const byPid = new Map();
  for (const name of names) {
    const content = readPrivateProcessFile(path.join(privateArtifactDir, name));
    if (content === null) return null;
    const records = JSON.parse(content);
    if (!Array.isArray(records) || records.length === 0) return null;
    for (const record of records) {
      if (
        !hasExactKeys(record, [
          'executable',
          'executablePathHash',
          'pid',
          'ppid',
        ])
        || !path.isAbsolute(record.executable || '')
        || !Number.isInteger(record.pid)
        || record.pid <= 0
        || !Number.isInteger(record.ppid)
        || record.ppid <= 0
        || !SHA256_RE.test(record.executablePathHash)
        || crypto.createHash('sha256').update(record.executable).digest('hex')
          !== record.executablePathHash
      ) {
        return null;
      }
      byPid.set(record.pid, record);
    }
  }
  return [...byPid.values()]
    .sort((left, right) => left.pid - right.pid)
    .map(({ pid, ppid, executablePathHash }) => ({
      pid,
      ppid,
      executablePathHash,
    }));
}

function privateSdkProcessEvidence(privateArtifactDir, executablePathHash) {
  const snapshotsContent = readPrivateProcessFile(path.join(
    privateArtifactDir,
    'sdk-process-snapshots.ndjson',
  ));
  if (snapshotsContent === null) return null;
  const snapshots = snapshotsContent
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (snapshots.length === 0) return null;

  const rootPids = new Set();
  const selectedProcesses = new Map();
  for (const [index, snapshot] of snapshots.entries()) {
    if (
      !hasExactKeys(snapshot, [
        'activeRootPids',
        'processes',
        'sampleIndex',
      ])
      || snapshot.sampleIndex !== index + 1
      || !Array.isArray(snapshot.activeRootPids)
      || snapshot.activeRootPids.some((pid) => (
        !Number.isInteger(pid) || pid <= 0
      ))
      || new Set(snapshot.activeRootPids).size
        !== snapshot.activeRootPids.length
      || !Array.isArray(snapshot.processes)
    ) {
      return null;
    }
    snapshot.activeRootPids.forEach((pid) => rootPids.add(pid));
    const byPid = new Map();
    for (const processInfo of snapshot.processes) {
      if (
        !hasExactKeys(processInfo, ['executable', 'pid', 'ppid'])
        || !Number.isInteger(processInfo.pid)
        || processInfo.pid <= 0
        || !Number.isInteger(processInfo.ppid)
        || processInfo.ppid <= 0
        || (
          processInfo.executable !== null
          && (
            typeof processInfo.executable !== 'string'
            || !path.isAbsolute(processInfo.executable)
          )
        )
        || byPid.has(processInfo.pid)
      ) {
        return null;
      }
      byPid.set(processInfo.pid, processInfo);
    }
    const children = new Map();
    for (const processInfo of snapshot.processes) {
      if (!children.has(processInfo.ppid)) {
        children.set(processInfo.ppid, []);
      }
      children.get(processInfo.ppid).push(processInfo.pid);
    }
    const descendants = new Set(snapshot.activeRootPids);
    const pending = [...snapshot.activeRootPids];
    while (pending.length > 0) {
      for (const pid of children.get(pending.pop()) || []) {
        if (descendants.has(pid)) continue;
        descendants.add(pid);
        pending.push(pid);
      }
    }
    for (const processInfo of snapshot.processes) {
      if (processInfo.executable === null) continue;
      const observedPathHash = crypto
        .createHash('sha256')
        .update(processInfo.executable)
        .digest('hex');
      if (observedPathHash !== executablePathHash) continue;
      if (!descendants.has(processInfo.pid)) return null;
      selectedProcesses.set(processInfo.pid, {
        pid: processInfo.pid,
        ppid: processInfo.ppid,
      });
    }
  }

  const errorsContent = readPrivateProcessFile(path.join(
    privateArtifactDir,
    'sdk-process-sampling-errors.ndjson',
  ));
  let samplingFailureCount = 0;
  let samplingErrorHash = null;
  if (errorsContent !== null) {
    const errors = errorsContent
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const error of errors) {
      if (
        !hasExactKeys(error, ['detail', 'recordedAt'])
        || typeof error.detail !== 'string'
        || error.detail.length === 0
        || typeof error.recordedAt !== 'string'
        || !Number.isFinite(Date.parse(error.recordedAt))
      ) {
        return null;
      }
    }
    samplingFailureCount = errors.length;
    if (errors.length > 0) {
      samplingErrorHash = crypto
        .createHash('sha256')
        .update(errors[0].detail)
        .digest('hex');
    }
  }
  const processes = [...selectedProcesses.values()]
    .sort((left, right) => left.pid - right.pid);
  return {
    rootPids: [...rootPids].sort((left, right) => left - right),
    selectedBinaryPids: processes.map(({ pid }) => pid),
    selectedBinaryProcesses: processes,
    sampleCount: snapshots.length,
    samplingFailed: samplingFailureCount > 0,
    samplingFailureCount,
    samplingErrorHash,
  };
}

export function privateProcessEvidenceMatches(
  run,
  result,
  privateArtifactDir,
) {
  if (
    typeof privateArtifactDir !== 'string'
    || !path.isAbsolute(privateArtifactDir)
    || !fs.existsSync(privateArtifactDir)
  ) {
    return false;
  }
  const privateStat = fs.lstatSync(privateArtifactDir);
  if (privateStat.isSymbolicLink() || !privateStat.isDirectory()) return false;
  let wrappers;
  try {
    wrappers = privateWrapperRecords(privateArtifactDir);
  } catch {
    return false;
  }
  if (!isDeepStrictEqual(wrappers, result.wrapperRecords)) return false;

  if (['cli-contract', 'workflow-direct', 'workflow-fallback'].includes(
    run.scenarioId,
  )) {
    let rawTree;
    try {
      rawTree = privateCliProcessTree(privateArtifactDir);
    } catch {
      return false;
    }
    return rawTree !== null && isDeepStrictEqual(rawTree, result.processTree);
  }

  const sourcePath = path.join(privateArtifactDir, 'sdk-process-evidence.json');
  try {
    const content = readPrivateProcessFile(sourcePath);
    if (content === null) return false;
    if (!isDeepStrictEqual(JSON.parse(content), result.processEvidence)) {
      return false;
    }
    return isDeepStrictEqual(
      privateSdkProcessEvidence(
        privateArtifactDir,
        result.attestation.executablePathHash,
      ),
      result.processEvidence,
    );
  } catch {
    return false;
  }
}

function matrixProcessEvidenceMatches(run, result, privateArtifactDir) {
  if (!run?.env) return true;
  if (!privateProcessEvidenceMatches(run, result, privateArtifactDir)) {
    return false;
  }
  const selection = {
    runId: result.attestation.runId,
    version: result.attestation.version,
    sha256: result.attestation.sha256,
    sessionLauncher: result.attestation.wrapperRequired
      ? 'selected-wrapper'
      : null,
    sanitizedAttestation: result.attestation,
  };
  try {
    if (['cli-contract', 'workflow-direct', 'workflow-fallback'].includes(
      run.scenarioId,
    )) {
      if (
        !Array.isArray(result.processTree)
        || result.processTree.length === 0
        || result.processTree.some((record) => (
          !hasExactKeys(record, ['executablePathHash', 'pid', 'ppid'])
          || !Number.isInteger(record.pid)
          || record.pid <= 0
          || !Number.isInteger(record.ppid)
          || record.ppid <= 0
          || !SHA256_RE.test(record.executablePathHash)
        ))
        || new Set(result.processTree.map(({ pid }) => pid)).size
          !== result.processTree.length
      ) {
        return false;
      }
      const observedClaudeProcesses = result.processTree
        .filter((record) => (
          record.executablePathHash
            === result.attestation.executablePathHash
        ))
        .map(({ pid, ppid }) => ({ pid, ppid }));
      if (observedClaudeProcesses.length === 0) return false;
      validateWrapperProvenance(selection, result.wrapperRecords, {
        observedClaudeProcesses,
      });
      return true;
    }
    if (
      !processEvidenceSchemaMatches(result.processEvidence)
      || result.processEvidence.sampleCount <= 0
      || result.processEvidence.rootPids.length === 0
      || result.processEvidence.selectedBinaryProcesses.length === 0
      || result.processEvidence.samplingFailed
    ) {
      return false;
    }
    validateWrapperProvenance(selection, result.wrapperRecords, {
      observedClaudeProcesses:
        result.processEvidence.selectedBinaryProcesses,
      unwrappedRootPids: result.processEvidence.rootPids,
      requireWrapperRecord: false,
    });
    return true;
  } catch {
    return false;
  }
}

function completedWorkflowMetadataMatches(records, {
  requireExpectedReport = true,
} = {}) {
  return (
    Array.isArray(records)
    && records.length > 0
    && records.every((record) => (
      record.status === 'completed'
      && Number.isFinite(record.agentCount)
      && record.agentCount >= 1
      && record.agentCount <= 3
      && record.reportComplete === true
      && (
        !requireExpectedReport
        || record.reportMatchesExpected === true
      )
    ))
  );
}

function successfulWorkflowOracleMatches(result, fallback) {
  const launchProof = result.launchDeliveryProof;
  const completionProof = result.completionTurnProof;
  const timing = result.outOfTurnTiming;
  const directRoutes = Object.entries(result.directRouteCounts || {});
  const fallbackRoutes = Object.entries(result.fallbackRouteCounts || {});
  const expectedOriginRouteHash = hashSensitiveString(
    WORKFLOW_GATE_ORIGIN_ROUTE,
  );
  const routeCountsMatch = (
    directRoutes.length === 1
    && directRoutes[0][0] === expectedOriginRouteHash
    && directRoutes[0][1] === 2
    && (
      fallback
        ? (
            fallbackRoutes.length === 1
            && fallbackRoutes[0][0] === directRoutes[0][0]
            && fallbackRoutes[0][1] === 1
          )
        : fallbackRoutes.length === 0
    )
  );
  const expectedCompletionReceipt = fallback
    ? (
        completionProof?.toolResultEventMatched === false
        && completionProof?.receiptOk === false
        && completionProof?.receiptIsError === true
      )
    : (
        completionProof?.toolResultEventMatched === true
        && completionProof?.receiptOk === true
        && completionProof?.receiptIsError === false
      );
  return (
    result.status === 'PASS'
    && result.workflowPolicyOverridePresent === false
    && result.launchTurnClosedBeforeCompletion === true
    && timing?.pass === true
    && timing.reasonCount === 0
    && timing.taskNotificationAfterStopMs
      >= timing.requiredTaskNotificationDelayMs
    && timing.completionAfterLaunchTurnMs > 0
    && timing.completionAfterTaskNotificationMs
      >= timing.requiredCompletionAfterNotificationMs
    && result.launchDeliveryCount === 1
    && result.launchDeliveryReasonCount === 0
    && launchProof?.launchDeliveryCount === 1
    && [
      'deliverySucceeded',
      'exactTextMatched',
      'exactlyOneCall',
      'nonInterim',
      'originRouteMatched',
      'replyToolMatched',
      'zeroFiles',
    ].every((key) => launchProof?.[key] === true)
    && completionProof?.toolUseMatched === true
    && completionProof?.stopAfterToolUse === true
    && completionProof?.transcriptToolUseCount === 1
    && completionProof?.transcriptToolResultCount === 1
    && completionProof?.terminalAdvanced === true
    && completionProof?.turnDurationCount >= 1
    && expectedCompletionReceipt
    && result.directCompletionCount === 1
    && routeCountsMatch
    && result.deliveryReasonCount === 0
    && result.deliveryFailedCount === 0
    && (
      fallback
        ? (
            result.fallbackCount === 1
            && result.deliveryPipeline === 'helper'
            && result.deliverySentCount === 1
          )
        : (
            result.fallbackCount === 0
            && result.deliveryPipeline === null
            && result.deliverySentCount === 0
          )
    )
    && completedWorkflowMetadataMatches(result.workflowMetadata)
  );
}

export function matrixScenarioOracleMatches(scenarioId, result) {
  let pass = false;
  if (scenarioId === 'cli-contract') {
    pass = (
      result.status === 'PASS'
      && result.spawnCount === 1
      && result.replyCount === 5
      && result.fileObserved === true
      && result.failureHash === null
      && result.failureStage === null
      && result.startupHandshake !== null
    );
  } else if (scenarioId === 'workflow-direct') {
    pass = successfulWorkflowOracleMatches(result, false);
  } else if (scenarioId === 'workflow-fallback') {
    pass = successfulWorkflowOracleMatches(result, true);
  } else if (scenarioId === 'delayed-mcp') {
    pass = (
      evaluateDelayedMcpEvidence(result.evidence).pass
      && result.markerCount === 1
      && result.resultSubtype === 'success'
      && result.reasonCount === 0
      && result.reasonHashes.length === 0
    );
  } else if (scenarioId === 'sdk-post-tool-batch') {
    pass = (
      result.hookFiredCount === 1
      && result.markerPresent === true
      && result.resultSubtype === 'success'
      && result.reasonCount === 0
    );
  } else if (scenarioId === 'sdk-subagent') {
    pass = (
      evaluateSubagentEvidence(result, {
        isCandidate: result.attestation?.version === '2.1.220',
      }).pass
      && result.subagentMessages > 0
      && result.distinctParentCount > 0
      && result.resultSubtype === 'success'
      && result.reasonCount === 0
    );
  } else if (scenarioId === 'sdk-resume') {
    pass = (
      result.firstSessionPresent === true
      && result.secondSessionPresent === true
      && result.firstResultSubtype === 'success'
      && result.secondResultSubtype === 'success'
      && result.markerRecalled === true
      && result.reasonCount === 0
    );
  } else if (scenarioId === 'sdk-compact') {
    pass = (
      result.preCompactCount === 1
      && result.compactBoundaryCount === 1
      && result.resultCount === 3
      && result.sameSession === true
      && result.ordered === true
      && result.recallPromptMarkerFree === true
      && result.markerRecallCount === 1
      && result.resultSubtype === 'success'
      && result.runtimeErrorPresent === false
      && result.reasonCount === 0
    );
  } else if (scenarioId === 'sdk-tool-less-drain') {
    pass = (
      result.hookFiredCount === 0
      && isDeepStrictEqual(result.resultSubtypes, ['success', 'success'])
      && result.bufferedMarkerCount === 1
      && result.reasonCount === 0
    );
  } else if (scenarioId === 'candidate-opus-projection') {
    pass = (
      evaluateOpusProjection({
        ...result,
        selectedExecutableSha256: result.attestation?.sha256,
        workflowExitStatus: result.workflowStatus === 'PASS' ? 0 : 1,
      }).pass
      && result.workflowStatus === 'PASS'
      && completedWorkflowMetadataMatches(result.workflowMetadata)
      && result.resultSubtype === 'success'
      && result.markerCount === 1
      && result.reasonCount === 0
      && result.reasonHashes.length === 0
    );
  }
  return {
    pass,
    reasons: pass
      ? []
      : ['sanitized result does not satisfy the scenario oracle'],
  };
}

export function nestedOpusWorkflowEvidenceMatches({
  run,
  result,
  privateArtifactDir,
}) {
  if (
    run?.scenarioId !== 'candidate-opus-projection'
    || typeof privateArtifactDir !== 'string'
    || !path.isAbsolute(privateArtifactDir)
  ) {
    return false;
  }
  try {
    const outerRunDir = path.dirname(privateArtifactDir);
    const nestedRunDir = path.join(outerRunDir, 'nested-runs', 'workflow');
    const nestedPrivateDir = path.join(nestedRunDir, 'raw-private');
    const nestedResultPath = path.join(
      nestedRunDir,
      'sanitized-result.json',
    );
    for (const directory of [outerRunDir, nestedRunDir, nestedPrivateDir]) {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    const nestedResultStat = fs.lstatSync(nestedResultPath);
    if (
      nestedResultStat.isSymbolicLink()
      || !nestedResultStat.isFile()
      || fs.realpathSync(nestedRunDir)
        !== path.join(fs.realpathSync(outerRunDir), 'nested-runs', 'workflow')
    ) {
      return false;
    }
    const nestedResult = JSON.parse(
      fs.readFileSync(nestedResultPath, 'utf8'),
    );
    const nestedRun = {
      scenarioId: 'workflow-direct',
      versionKey: run.versionKey,
      version: run.version,
      model: run.model,
      effort: run.effort,
      expectedResolvedModel: run.expectedResolvedModel,
      evidenceSources: EVIDENCE_SOURCE_REGISTRY.get('workflow-direct'),
      env: {
        CLAUDE_GATE_BIN: run.env.CLAUDE_GATE_BIN,
        CLAUDE_GATE_RUN_ID: 'workflow',
      },
    };
    const validation = evaluateMatrixRunResult({
      run: nestedRun,
      result: nestedResult,
      privateArtifactDir: nestedPrivateDir,
    });
    return (
      validation.pass
      && nestedWorkflowLifecycleMatches({
        result: nestedResult,
        policy: run.nestedWorkflowLifecyclePolicy,
        isCandidate: run.versionKey === 'candidate',
      })
      && result.workflowStatus === nestedResult.status
      && result.workflowPolicyOverridePresent
        === nestedResult.workflowPolicyOverridePresent
      && isDeepStrictEqual(
        result.workflowMetadata,
        nestedResult.workflowMetadata,
      )
    );
  } catch {
    return false;
  }
}

export function nestedWorkflowLifecycleMatches({
  result,
  policy,
  isCandidate,
}) {
  return matchesProjectedBaseline({
    result,
    policy,
    isCandidate,
  });
}

export function privateGateArtifactPermissionsMatch(runDir) {
  if (
    typeof runDir !== 'string'
    || !path.isAbsolute(runDir)
    || !fs.existsSync(runDir)
  ) {
    return false;
  }
  try {
    const pending = [{ directory: runDir, insideRawPrivate: false }];
    while (pending.length > 0) {
      const { directory, insideRawPrivate } = pending.pop();
      const directoryStat = fs.lstatSync(directory);
      if (
        directoryStat.isSymbolicLink()
        || !directoryStat.isDirectory()
        || (directoryStat.mode & 0o777) !== 0o700
      ) {
        return false;
      }
      for (const entry of fs.readdirSync(directory)) {
        const target = path.join(directory, entry);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) return false;
        const targetInsideRawPrivate =
          insideRawPrivate || entry === 'raw-private';
        if (stat.isDirectory()) {
          pending.push({
            directory: target,
            insideRawPrivate: targetInsideRawPrivate,
          });
          continue;
        }
        if (!stat.isFile()) return false;
        const rawSource = (
          targetInsideRawPrivate
          || /\.(?:jsonl|ndjson|log)$/i.test(entry)
          || /pane/i.test(entry)
        );
        if (rawSource && (stat.mode & 0o777) !== 0o600) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function evaluateMatrixRunResult({
  run,
  result,
  privateArtifactDir,
  privateSessionPath,
}) {
  const reasons = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    reasons.push('sanitized result is missing or malformed');
  } else {
    if (
      run?.env
      && !sanitizedGateResultSchemaMatches(result, run.scenarioId)
    ) {
      reasons.push('sanitized result schema is not recognized');
    }
    if (result.evidenceSchemaVersion !== 1) {
      reasons.push('sanitized result schema version is not recognized');
    }
    if (result.matrixScenario !== run.scenarioId) {
      reasons.push('sanitized result scenario does not match the matrix cell');
    }
    if (result.status !== 'PASS') {
      reasons.push('sanitized result did not report PASS');
    }
    if (
      run?.env
      && !matrixScenarioOracleMatches(run.scenarioId, result).pass
    ) {
      reasons.push('sanitized result does not satisfy the scenario oracle');
    }
    if (
      run?.env
      && run.scenarioId === 'candidate-opus-projection'
      && !nestedOpusWorkflowEvidenceMatches({
        run,
        result,
        privateArtifactDir,
      })
    ) {
      reasons.push('candidate Opus projection does not match nested Workflow evidence');
    }
    if (
      run?.env
      && !privateGateArtifactPermissionsMatch(
        path.dirname(privateArtifactDir || ''),
      )
    ) {
      reasons.push('gate-owned raw evidence permissions are not private');
    }
    if (result.attestation?.version !== run.version) {
      reasons.push('sanitized result version does not match the matrix cell');
    }
    if (result.attestation?.model !== run.model) {
      reasons.push('sanitized result configured model does not match the matrix cell');
    }
    if (result.attestation?.effort !== run.effort) {
      reasons.push('sanitized result effort does not match the matrix cell');
    }
    if (result.resolvedModel !== (run.expectedResolvedModel || run.model)) {
      reasons.push('sanitized result observed model does not match the matrix cell');
    }
    if (!independentAttestationMatches(run, result)) {
      reasons.push('sanitized executable attestation does not match the selected binary');
    }
    if (!matrixProcessEvidenceMatches(run, result, privateArtifactDir)) {
      reasons.push('sanitized process evidence does not match the selected binary');
    }
    const expectedVersionSpecificOracle =
      VERSION_SPECIFIC_LIFECYCLE_ORACLES.get(run.scenarioId);
    if (
      expectedVersionSpecificOracle
      && (
        run.versionSpecificLifecycleOracle !== expectedVersionSpecificOracle
        || !versionSpecificLifecycleMatches(
          result,
          expectedVersionSpecificOracle,
          run.versionKey === 'candidate',
        )
      )
    ) {
      reasons.push('sanitized result does not satisfy the version-specific lifecycle oracle');
    }
    if (run.maxBridgeReadyToMcpReadyMs !== undefined) {
      const handshake = result.startupHandshake;
      if (
        !Number.isInteger(run.maxBridgeReadyToMcpReadyMs)
        || run.maxBridgeReadyToMcpReadyMs <= 0
        || !hasExactKeys(handshake, [
          'bridgeReadyMs',
          'bridgeReadyToMcpReadyMs',
          'mcpReadyMs',
        ])
        || !isNonNegativeInteger(handshake.bridgeReadyMs)
        || !isNonNegativeInteger(handshake.mcpReadyMs)
        || !isNonNegativeInteger(handshake.bridgeReadyToMcpReadyMs)
        || handshake.mcpReadyMs < handshake.bridgeReadyMs
        || handshake.bridgeReadyToMcpReadyMs
          !== handshake.mcpReadyMs - handshake.bridgeReadyMs
        || handshake.bridgeReadyToMcpReadyMs
          > run.maxBridgeReadyToMcpReadyMs
      ) {
        reasons.push('sanitized MCP-ready latency lacks required deadline headroom');
      }
    }
    const records = lifecycleRecords(result.lifecycle);
    if (records.length === 0) {
      reasons.push('sanitized lifecycle evidence is missing');
    } else if (records.some(
      (record) => !isNormalizedLifecycleRecord(record),
    )) {
      reasons.push('sanitized lifecycle evidence contains an unrecognized or malformed schema');
    }
    const legacyPrivateArtifactDir = privateArtifactDir || (
      typeof privateSessionPath === 'string'
        ? path.dirname(privateSessionPath)
        : null
    );
    if (!privateLifecycleSourcesMatch({
      run,
      result,
      privateArtifactDir: legacyPrivateArtifactDir,
    })) {
      reasons.push('sanitized lifecycle source does not match the private session artifact');
    }
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}

function compareEvidencePair({
  scenario,
  leftResult,
  rightResult,
  leftIsCandidate = false,
  rightIsCandidate = false,
}) {
  const differences = [];
  for (const field of scenario?.comparison?.equalFields || []) {
    const leftValue = fieldAt(leftResult, field);
    const rightValue = fieldAt(rightResult, field);
    if (
      !hasFieldAt(leftResult, field)
      || !hasFieldAt(rightResult, field)
      || JSON.stringify(leftValue) !== JSON.stringify(rightValue)
    ) {
      differences.push(field);
    }
  }
  const lifecyclePolicy = scenario?.comparison?.lifecycle;
  const versionSpecificLifecycleOracle =
    VERSION_SPECIFIC_LIFECYCLE_ORACLES.get(scenario?.id);
  if (versionSpecificLifecycleOracle) {
    if (
      !versionSpecificLifecyclePolicyMatches(
        scenario,
        versionSpecificLifecycleOracle,
      )
      || !versionSpecificLifecycleMatches(
        leftResult,
        versionSpecificLifecycleOracle,
        leftIsCandidate,
      )
      || !versionSpecificLifecycleMatches(
        rightResult,
        versionSpecificLifecycleOracle,
        rightIsCandidate,
      )
    ) {
      differences.push('lifecycle');
    }
  } else if (lifecyclePolicy == null) {
    // Field-only comparisons do not opt into lifecycle evidence.
  } else if (lifecyclePolicy === 'shape-equal') {
    const leftLifecycle = summarizeLifecycleShape(leftResult?.lifecycle);
    const rightLifecycle = summarizeLifecycleShape(rightResult?.lifecycle);
    if (
      leftLifecycle === null
      || rightLifecycle === null
      || JSON.stringify(leftLifecycle) !== JSON.stringify(rightLifecycle)
    ) {
      differences.push('lifecycle');
    }
  } else if (lifecyclePolicy === 'sdk-semantic-shape-v1') {
    const leftLifecycle = summarizeSdkLifecycleSemantics(
      leftResult?.lifecycle,
    );
    const rightLifecycle = summarizeSdkLifecycleSemantics(
      rightResult?.lifecycle,
    );
    if (
      leftLifecycle === null
      || rightLifecycle === null
      || !isDeepStrictEqual(leftLifecycle, rightLifecycle)
    ) {
      differences.push('lifecycle');
    }
  } else if (lifecyclePolicy?.mode === 'projected-compatible') {
    if (
      !matchesProjectedBaseline({
        result: leftResult,
        policy: lifecyclePolicy,
        isCandidate: leftIsCandidate,
      })
      || !matchesProjectedBaseline({
        result: rightResult,
        policy: lifecyclePolicy,
        isCandidate: rightIsCandidate,
      })
      || !compareProjectedLifecycle({
        leftResult,
        rightResult,
        policy: lifecyclePolicy,
        leftIsCandidate,
        rightIsCandidate,
      })
    ) {
      differences.push('lifecycle');
    }
  } else {
    differences.push('lifecycle');
  }
  return {
    pass: differences.length === 0,
    differences,
  };
}

export function evaluateMatrixEvidencePair({
  scenario,
  oldResult,
  candidateResult,
}) {
  return compareEvidencePair({
    scenario,
    leftResult: oldResult,
    rightResult: candidateResult,
    rightIsCandidate: true,
  });
}

function sameVersionPairs(results) {
  const pairs = [];
  for (let left = 0; left < results.length; left += 1) {
    for (let right = left + 1; right < results.length; right += 1) {
      pairs.push([left, right]);
    }
  }
  return pairs;
}

function invalidPolicyComparison() {
  return {
    pass: false,
    comparisons: [{
      id: 'comparison-policy',
      pass: false,
      differences: ['comparison-policy'],
    }],
  };
}

function invalidEvidenceCount() {
  return {
    pass: false,
    comparisons: [{
      id: 'evidence-count',
      pass: false,
      differences: ['evidence-count'],
    }],
  };
}

export function evaluateMatrixVersionEvidence({
  scenario,
  versionKey,
  results,
}) {
  let policy;
  try {
    policy = normalizeComparisonPolicy(scenario);
  } catch {
    return invalidPolicyComparison();
  }
  if (
    !['old', 'candidate'].includes(versionKey)
    || !Array.isArray(results)
    || results.length !== policy.repeatCount
  ) {
    return invalidEvidenceCount();
  }
  const comparisons = [];
  if (scenario?.comparison?.lifecycle?.mode === 'projected-compatible') {
    results.forEach((result, index) => {
      comparisons.push({
        id: `absolute-baseline:${versionKey}:${index + 1}`,
        pass: matchesProjectedBaseline({
          result,
          policy: scenario.comparison.lifecycle,
          isCandidate: versionKey === 'candidate',
        }),
        differences: [],
      });
      if (!comparisons.at(-1).pass) {
        comparisons.at(-1).differences.push('lifecycle');
      }
    });
  }
  for (const [left, right] of sameVersionPairs(results)) {
    comparisons.push({
      id: `same-version:${versionKey}:${left + 1}-${right + 1}`,
      ...compareEvidencePair({
        scenario,
        leftResult: results[left],
        rightResult: results[right],
        leftIsCandidate: versionKey === 'candidate',
        rightIsCandidate: versionKey === 'candidate',
      }),
    });
  }
  return {
    pass: comparisons.every((comparison) => comparison.pass),
    comparisons,
  };
}

export function evaluateMatrixCrossVersionEvidence({
  scenario,
  oldResults,
  candidateResults,
}) {
  let policy;
  try {
    policy = normalizeComparisonPolicy(scenario);
  } catch {
    return invalidPolicyComparison();
  }
  if (
    !Array.isArray(oldResults)
    || !Array.isArray(candidateResults)
    || oldResults.length !== policy.repeatCount
    || candidateResults.length !== policy.repeatCount
  ) {
    return invalidEvidenceCount();
  }
  const pairs = policy.crossVersion === 'all-pairs'
    ? oldResults.flatMap((oldResult, oldIndex) => (
      candidateResults.map((candidateResult, candidateIndex) => ({
        oldResult,
        oldIndex,
        candidateResult,
        candidateIndex,
      }))
    ))
    : [{
      oldResult: oldResults[0],
      oldIndex: 0,
      candidateResult: candidateResults[0],
      candidateIndex: 0,
    }];
  const comparisons = pairs.map(({
    oldResult,
    oldIndex,
    candidateResult,
    candidateIndex,
  }) => ({
    id: `cross-version:old-${oldIndex + 1}:candidate-${candidateIndex + 1}`,
    ...compareEvidencePair({
      scenario,
      leftResult: oldResult,
      rightResult: candidateResult,
      rightIsCandidate: true,
    }),
  }));
  return {
    pass: comparisons.every((comparison) => comparison.pass),
    comparisons,
  };
}

export function evaluateMatrixScenarioEvidence({
  scenario,
  oldResults,
  candidateResults,
}) {
  const comparisons = [];
  for (const versionKey of ['old', 'candidate']) {
    const versionComparison = evaluateMatrixVersionEvidence({
      scenario,
      versionKey,
      results: versionKey === 'old' ? oldResults : candidateResults,
    });
    comparisons.push(...versionComparison.comparisons);
    if (!versionComparison.pass) {
      return { pass: false, comparisons };
    }
  }
  const crossVersionComparison = evaluateMatrixCrossVersionEvidence({
    scenario,
    oldResults,
    candidateResults,
  });
  comparisons.push(...crossVersionComparison.comparisons);
  return {
    pass: crossVersionComparison.pass,
    comparisons,
  };
}

function resolveThroughExistingAncestor(targetPath) {
  let current = path.resolve(targetPath);
  const missingParts = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingParts.unshift(path.basename(current));
    current = parent;
  }
  const existingBase = fs.existsSync(current)
    ? fs.realpathSync(current)
    : current;
  return path.join(existingBase, ...missingParts);
}

function assertContained(baseDir, targetPath) {
  const resolvedBase = resolveThroughExistingAncestor(baseDir);
  const resolvedTarget = resolveThroughExistingAncestor(targetPath);
  if (
    resolvedTarget === resolvedBase
    || !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)
  ) {
    throw new Error('gate artifact target escapes the dedicated artifact base');
  }
  return resolvedTarget;
}

function collectSessionProjects(runDir) {
  const projects = [];
  const pending = [runDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current)) {
      const target = path.join(current, entry);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw new Error('refusing to inspect a symlinked gate artifact');
      }
      if (stat.isDirectory()) {
        pending.push(target);
      } else if (stat.isFile() && entry === 'session-projects.json') {
        const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (
          manifest?.schemaVersion !== 2
          || !Array.isArray(manifest.projects)
          || manifest.projects.some((project) => (
            !hasExactKeys(project, ['cwd', 'sessionIds'])
            || typeof project.cwd !== 'string'
            || !Array.isArray(project.sessionIds)
            || project.sessionIds.some(
              (sessionId) => !SESSION_ID_RE.test(sessionId),
            )
          ))
        ) {
          throw new Error('session project manifest is malformed');
        }
        projects.push(...manifest.projects);
      }
    }
  }
  return projects;
}

export function acceptedStartupHandshakeSummaryMatches({
  expectedRuns,
  summaryResults,
  sanitizedResults,
  summaryMaximumMs,
}) {
  if (
    !Array.isArray(expectedRuns)
    || !Array.isArray(summaryResults)
    || !Array.isArray(sanitizedResults)
    || expectedRuns.length !== summaryResults.length
    || expectedRuns.length !== sanitizedResults.length
    || !isNonNegativeInteger(summaryMaximumMs)
  ) {
    return false;
  }
  let recomputedMaximumMs = 0;
  for (const [index, run] of expectedRuns.entries()) {
    const summaryResult = summaryResults[index];
    const sanitizedResult = sanitizedResults[index];
    const expectsHandshake = run?.maxBridgeReadyToMcpReadyMs !== undefined;
    if (!expectsHandshake) {
      if (
        Object.hasOwn(summaryResult || {}, 'startupHandshake')
        || Object.hasOwn(sanitizedResult || {}, 'startupHandshake')
      ) {
        return false;
      }
      continue;
    }
    const handshake = sanitizedResult?.startupHandshake;
    if (
      !isNonNegativeInteger(handshake?.bridgeReadyToMcpReadyMs)
      || !isDeepStrictEqual(
        summaryResult?.startupHandshake,
        handshake,
      )
    ) {
      return false;
    }
    recomputedMaximumMs = Math.max(
      recomputedMaximumMs,
      handshake.bridgeReadyToMcpReadyMs,
    );
  }
  return recomputedMaximumMs === summaryMaximumMs;
}

export function purgeAcceptedGateArtifacts({
  artifactBaseDir,
  runPrefix,
  summary,
  expectedRuns,
  expectedScenarios,
  expectedManifestSha256,
  claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects'),
}) {
  assertSafeRunPrefix(runPrefix);
  if (!path.isAbsolute(claudeProjectsDir || '')) {
    throw new TypeError('Claude projects directory must be absolute');
  }
  const expectedSummaryKeys = [
    'authoritative',
    'blockedCount',
    'completedRunCount',
    'expectedAuthoritativeRunCount',
    'failCount',
    'manifestSha256',
    'maxBridgeReadyToMcpReadyMs',
    'passCount',
    'results',
    'runPrefix',
    'schemaVersion',
    'selectedRunCount',
    'status',
  ];
  const expectedResultKeys = [
    'args',
    'artifactCollector',
    'artifactValidation',
    'cost',
    'driver',
    'elapsedMs',
    'exitCode',
    'id',
    'oracle',
    'pairComparison',
    'runId',
    'status',
  ];
  const expectedRunList = Array.isArray(expectedRuns) ? expectedRuns : [];
  const expectedIds = expectedRunList.map((run) => run?.id);
  const expectedRunIds = expectedRunList.map(
    (run) => run?.env?.CLAUDE_GATE_RUN_ID,
  );
  const expectedScenarioList = Array.isArray(expectedScenarios)
    ? expectedScenarios
    : [];
  const expectedScenarioMap = new Map(
    expectedScenarioList.map((scenario) => [scenario?.id, scenario]),
  );
  const resultIds = Array.isArray(summary?.results)
    ? summary.results.map((result) => result?.id)
    : [];
  const resultRunIds = Array.isArray(summary?.results)
    ? summary.results.map((result) => result?.runId)
    : [];
  const validPairComparison = (comparison) => (
    hasExactKeys(comparison, ['comparisons', 'pass'])
    && comparison.pass === true
    && Array.isArray(comparison.comparisons)
    && comparison.comparisons.length > 0
    && comparison.comparisons.every((entry) => (
      hasExactKeys(entry, ['differences', 'id', 'pass'])
      && typeof entry.id === 'string'
      && entry.id.length > 0
      && entry.pass === true
      && Array.isArray(entry.differences)
      && entry.differences.length === 0
    ))
  );
  const validSummaryResults = Array.isArray(summary?.results)
    && summary.results.every((result, index) => {
      const expectedRun = expectedRunList[index];
      const allowedKeys = expectedRun?.maxBridgeReadyToMcpReadyMs === undefined
        ? expectedResultKeys
        : [...expectedResultKeys, 'startupHandshake'];
      return (
        hasExactKeys(result, allowedKeys)
        && result.id === expectedRun?.id
        && result.runId === expectedRun?.env?.CLAUDE_GATE_RUN_ID
        && result.status === 'PASS'
        && result.exitCode === 0
        && isNonNegativeInteger(result.elapsedMs)
        && result.driver === expectedRun?.driver
        && isDeepStrictEqual(result.args, expectedRun?.args)
        && isDeepStrictEqual(result.cost, expectedRun?.cost)
        && result.oracle === expectedRun?.oracle
        && result.artifactCollector === expectedRun?.artifactCollector
        && hasExactKeys(result.artifactValidation, ['pass', 'reasons'])
        && result.artifactValidation.pass === true
        && Array.isArray(result.artifactValidation.reasons)
        && result.artifactValidation.reasons.length === 0
        && (
          expectedRun?.pairComparisonRequired
            ? validPairComparison(result.pairComparison)
            : (
                result.pairComparison === null
                || validPairComparison(result.pairComparison)
              )
        )
      );
    });
  if (
    !hasExactKeys(summary, expectedSummaryKeys)
    || summary.schemaVersion !== 1
    || summary?.authoritative !== true
    || summary?.status !== 'PASS'
    || summary?.runPrefix !== runPrefix
    || summary.manifestSha256 !== expectedManifestSha256
    || !SHA256_RE.test(expectedManifestSha256 || '')
    || expectedRunList.length !== AUTHORITATIVE_RUN_COUNT
    || new Set(expectedIds).size !== AUTHORITATIVE_RUN_COUNT
    || new Set(expectedRunIds).size !== AUTHORITATIVE_RUN_COUNT
    || expectedScenarioMap.size !== expectedScenarioList.length
    || expectedRunList.some(
      (run) => !expectedScenarioMap.has(run?.scenarioId),
    )
    || summary.expectedAuthoritativeRunCount !== AUTHORITATIVE_RUN_COUNT
    || summary.selectedRunCount !== AUTHORITATIVE_RUN_COUNT
    || summary.completedRunCount !== AUTHORITATIVE_RUN_COUNT
    || summary.passCount !== AUTHORITATIVE_RUN_COUNT
    || summary.failCount !== 0
    || summary.blockedCount !== 0
    || !isNonNegativeInteger(summary.maxBridgeReadyToMcpReadyMs)
    || summary.results.length !== AUTHORITATIVE_RUN_COUNT
    || !isDeepStrictEqual(resultIds, expectedIds)
    || !isDeepStrictEqual(resultRunIds, expectedRunIds)
    || !validSummaryResults
  ) {
    throw new Error('only a complete authoritative PASS may purge private artifacts');
  }

  const baseStat = fs.lstatSync(artifactBaseDir);
  if (
    baseStat.isSymbolicLink()
    || !baseStat.isDirectory()
    || (baseStat.mode & 0o777) !== 0o700
  ) {
    throw new Error('artifact base must be a private real directory');
  }
  if (fs.existsSync(claudeProjectsDir)) {
    const projectsStat = fs.lstatSync(claudeProjectsDir);
    if (projectsStat.isSymbolicLink() || !projectsStat.isDirectory()) {
      throw new Error('Claude projects directory must be a real directory');
    }
  }
  const realClaudeProjectsDir = fs.existsSync(claudeProjectsDir)
    ? fs.realpathSync(claudeProjectsDir)
    : path.resolve(claudeProjectsDir);

  const cleanupPlans = [];
  const sourceSessionTargets = new Set();
  const sanitizedResults = [];
  for (const [index, result] of summary.results.entries()) {
    const expectedRun = expectedRunList[index];
    if (
      !RUN_PREFIX_RE.test(result.runId || '')
      || !result.runId.startsWith(`${runPrefix}-`)
    ) {
      throw new Error('summary contains an unsafe run id');
    }
    const runDir = assertContained(artifactBaseDir, path.join(
      artifactBaseDir,
      result.runId,
    ));
    if (!fs.existsSync(runDir)) {
      throw new Error('run artifact directory must be a real directory');
    }
    const runStat = fs.lstatSync(runDir);
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
      throw new Error('run artifact directory must be a real directory');
    }
    const sanitizedResultPath = assertContained(
      artifactBaseDir,
      path.join(runDir, 'sanitized-result.json'),
    );
    if (!fs.existsSync(sanitizedResultPath)) {
      throw new Error('sanitized result must exist before private evidence is purged');
    }
    const sanitizedStat = fs.lstatSync(sanitizedResultPath);
    if (sanitizedStat.isSymbolicLink() || !sanitizedStat.isFile()) {
      throw new Error('sanitized result must be a regular file');
    }
    const sanitizedResult = JSON.parse(
      fs.readFileSync(sanitizedResultPath, 'utf8'),
    );
    const privateArtifactDir = path.join(runDir, 'raw-private');
    let artifactValidation;
    try {
      artifactValidation = evaluateMatrixRunResult({
        run: expectedRun,
        result: sanitizedResult,
        privateArtifactDir,
      });
    } catch {
      throw new Error('retained gate evidence did not revalidate before purge');
    }
    if (
      !artifactValidation.pass
      || !isDeepStrictEqual(
        artifactValidation,
        result.artifactValidation,
      )
    ) {
      throw new Error('retained gate evidence did not revalidate before purge');
    }
    sanitizedResults.push(sanitizedResult);
    for (const project of collectSessionProjects(runDir)) {
      const gateCwd = assertContained(runDir, project.cwd);
      const projectDir = assertContained(
        realClaudeProjectsDir,
        path.join(realClaudeProjectsDir, encodeCwd(gateCwd)),
      );
      if (!fs.existsSync(projectDir)) continue;
      const projectStat = fs.lstatSync(projectDir);
      if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
        throw new Error('Claude session project must be a real directory');
      }
      for (const sessionId of project.sessionIds) {
        for (const name of [`${sessionId}.jsonl`, sessionId]) {
          const target = assertContained(projectDir, path.join(projectDir, name));
          if (!fs.existsSync(target)) continue;
          if (fs.lstatSync(target).isSymbolicLink()) {
            throw new Error('refusing to purge a symlinked Claude session artifact');
          }
          sourceSessionTargets.add(target);
        }
      }
    }
    const targets = [];
    for (const entry of fs.readdirSync(runDir)) {
      if (entry === 'sanitized-result.json') continue;
      const target = assertContained(artifactBaseDir, path.join(runDir, entry));
      if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error('refusing to purge a symlinked private artifact');
      }
      targets.push(target);
    }
    cleanupPlans.push(targets);
  }

  if (!acceptedStartupHandshakeSummaryMatches({
    expectedRuns: expectedRunList,
    summaryResults: summary.results,
    sanitizedResults,
    summaryMaximumMs: summary.maxBridgeReadyToMcpReadyMs,
  })) {
    throw new Error('retained startup handshake evidence did not revalidate before purge');
  }

  const evidenceByScenario = new Map();
  for (const [index, run] of expectedRunList.entries()) {
    const scenario = expectedScenarioMap.get(run.scenarioId);
    if (!evidenceByScenario.has(run.scenarioId)) {
      evidenceByScenario.set(run.scenarioId, {
        old: [],
        candidate: [],
        sameVersion: {
          old: null,
          candidate: null,
        },
      });
    }
    const evidence = evidenceByScenario.get(run.scenarioId);
    evidence[run.versionKey].push(sanitizedResults[index]);
    let pairComparison = null;
    if (
      !scenario.candidateOnly
      && evidence[run.versionKey].length === run.repeatCount
    ) {
      const versionComparison = evaluateMatrixVersionEvidence({
        scenario,
        versionKey: run.versionKey,
        results: evidence[run.versionKey],
      });
      evidence.sameVersion[run.versionKey] = versionComparison;
      if (versionComparison.comparisons.length > 0) {
        pairComparison = versionComparison;
      }
    }
    if (
      run.versionKey === 'candidate'
      && !scenario.candidateOnly
      && evidence.candidate.length === run.repeatCount
    ) {
      if (
        evidence.old.length !== run.repeatCount
        || evidence.sameVersion.old?.pass !== true
      ) {
        throw new Error('retained pair evidence did not revalidate before purge');
      }
      const crossVersionComparison = evaluateMatrixCrossVersionEvidence({
        scenario,
        oldResults: evidence.old,
        candidateResults: evidence.candidate,
      });
      pairComparison = {
        pass: crossVersionComparison.pass,
        comparisons: [
          ...(pairComparison?.comparisons || []),
          ...crossVersionComparison.comparisons,
        ],
      };
    }
    if (
      pairComparison?.pass === false
      || !isDeepStrictEqual(
        pairComparison,
        summary.results[index].pairComparison,
      )
    ) {
      throw new Error('retained pair comparison did not revalidate before purge');
    }
  }

  const runnerPrivateDir = assertContained(
    artifactBaseDir,
    path.join(artifactBaseDir, `${runPrefix}-runner-private`),
  );
  if (fs.existsSync(runnerPrivateDir)) {
    if (fs.lstatSync(runnerPrivateDir).isSymbolicLink()) {
      throw new Error('refusing to purge a symlinked runner artifact');
    }
  }

  for (const target of sourceSessionTargets) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  for (const targets of cleanupPlans) {
    for (const target of targets) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  if (fs.existsSync(runnerPrivateDir)) {
    fs.rmSync(runnerPrivateDir, { recursive: true, force: true });
  }
}

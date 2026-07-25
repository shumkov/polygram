import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from './claude-executable.mjs';

const SOURCE_ROOT = fileURLToPath(
  new URL('./fixtures/workflow-project', import.meta.url),
);
const SKILL_RELATIVE_PATH = path.join(
  '.claude',
  'skills',
  'completion-sentinel',
  'SKILL.md',
);

export function makeTreePrivate(root) {
  const stat = fs.statSync(root);
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) {
      makeTreePrivate(path.join(root, name));
    }
  } else {
    fs.chmodSync(root, 0o600);
  }
}

function hasWorkflowPolicyOverride(cwd) {
  for (const fileName of ['settings.json', 'settings.local.json']) {
    const settingsPath = path.join(cwd, '.claude', fileName);
    if (!fs.existsSync(settingsPath)) continue;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (Object.hasOwn(settings, 'workflowSizeGuideline')) return true;
  }
  return false;
}

export function summarizeWorkflowRecord(record) {
  const progressTypes = {};
  for (const entry of Array.isArray(record?.workflowProgress)
    ? record.workflowProgress
    : []) {
    if (typeof entry?.type !== 'string') continue;
    progressTypes[entry.type] = (progressTypes[entry.type] || 0) + 1;
  }

  return {
    status: typeof record?.status === 'string' ? record.status : null,
    agentCount: Number.isFinite(record?.agentCount) ? record.agentCount : null,
    defaultModel: typeof record?.defaultModel === 'string'
      ? record.defaultModel
      : null,
    durationMs: Number.isFinite(record?.durationMs) ? record.durationMs : null,
    totalTokens: Number.isFinite(record?.totalTokens) ? record.totalTokens : null,
    totalToolCalls: Number.isFinite(record?.totalToolCalls)
      ? record.totalToolCalls
      : null,
    phaseCount: Array.isArray(record?.phases) ? record.phases.length : null,
    progressCount: Array.isArray(record?.workflowProgress)
      ? record.workflowProgress.length
      : null,
    progressTypes: Object.fromEntries(
      Object.entries(progressTypes).sort(([left], [right]) => (
        left.localeCompare(right)
      )),
    ),
    reportComplete: typeof record?.result === 'string'
      && record.result.trim().length > 0,
  };
}

export async function inspectWorkflowSizeGuidelineDefault({
  executablePath,
  executableSha256,
  expectedGuideline,
}) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new TypeError('executablePath must be an absolute path');
  }
  if (!/^[a-f0-9]{64}$/.test(executableSha256 || '')) {
    throw new TypeError('executableSha256 must be a SHA-256 digest');
  }
  if (expectedGuideline !== 'medium') {
    throw new TypeError('the selected-binary fingerprint only defines the medium default');
  }

  // These semantic anchors bind the documented value to the executable's
  // actual no-override branch. Upstream minifier drift intentionally blocks
  // the gate until the new runtime contract is inspected.
  const fingerprints = [
    Buffer.from('"medium" (the default) fewer than 15'),
    Buffer.from('var rLs,_Td="medium",oko'),
    Buffer.from(
      'settings.workflowSizeGuideline)??Msn(e);return t===void 0?{size:_Td,isDefault:!0}',
    ),
  ];
  const found = fingerprints.map(() => false);
  const maxFingerprintLength = Math.max(
    ...fingerprints.map((fingerprint) => fingerprint.length),
  );
  const hash = crypto.createHash('sha256');
  let tail = Buffer.alloc(0);

  for await (const chunk of fs.createReadStream(executablePath)) {
    hash.update(chunk);
    const searchable = Buffer.concat([tail, chunk]);
    fingerprints.forEach((fingerprint, index) => {
      if (!found[index] && searchable.includes(fingerprint)) found[index] = true;
    });
    tail = searchable.subarray(
      Math.max(0, searchable.length - maxFingerprintLength + 1),
    );
  }

  if (hash.digest('hex') !== executableSha256) {
    throw new Error('selected executable changed after attestation');
  }
  return {
    source: 'selected-binary-runtime-default',
    value: expectedGuideline,
    executableSha256,
    fingerprintMatched: found.every(Boolean),
  };
}

export function evaluateOpusProjection(evidence) {
  const reasons = [];
  if (evidence?.resolvedModel !== evidence?.expectedResolvedModel) {
    reasons.push('resolved model does not match the expected Opus model');
  }
  if (evidence?.workflowPolicyOverridePresent !== false) {
    reasons.push('synthetic project contains a Workflow policy override');
  }
  if (
    evidence?.workflowSizeGuidelineEvidence?.source
      !== 'selected-binary-runtime-default'
    || evidence.workflowSizeGuidelineEvidence.value
      !== evidence?.documentedWorkflowSizeGuideline
    || evidence.workflowSizeGuidelineEvidence.executableSha256
      !== evidence?.selectedExecutableSha256
    || evidence.workflowSizeGuidelineEvidence.fingerprintMatched !== true
  ) {
    reasons.push('Workflow size guideline was not attested in the selected binary');
  }
  if (evidence?.workflowExitStatus !== 0) {
    reasons.push('bounded Workflow gate did not exit successfully');
  }
  if (!Array.isArray(evidence?.workflowMetadata) || evidence.workflowMetadata.length === 0) {
    reasons.push('bounded Workflow metadata is missing');
  } else {
    if (evidence.workflowMetadata.some((record) => (
      record.status !== 'completed'
      || !Number.isFinite(record.agentCount)
      || record.agentCount < 1
      || record.agentCount > 3
    ))) {
      reasons.push('bounded Workflow topology is incomplete or exceeds three agents');
    }
    if (evidence.workflowMetadata.some((record) => record.reportComplete !== true)) {
      reasons.push('bounded Workflow report is incomplete');
    }
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}

function markerOccurrences(text, marker) {
  return typeof text === 'string' ? text.split(marker).length - 1 : 0;
}

export function evaluateWorkflowDeliveryEvidence({
  deliveryMode,
  marker,
  originRoute,
  foreignRoutes = [],
  directAttempts = [],
  fallbackDeliveries = [],
  fallbackPipeline = null,
  fallbackSentCount = 0,
  fallbackFailedCount = 0,
}) {
  const reasons = [];
  const foreign = new Set(foreignRoutes);
  const matchingAttempts = directAttempts.filter(
    (attempt) => markerOccurrences(attempt.text, marker) > 0,
  );
  if (matchingAttempts.length !== 1) {
    reasons.push('completion must make exactly one direct attempt');
  }
  if (
    matchingAttempts.some((attempt) => (
      attempt.route !== originRoute
      || attempt.text.trim() !== marker
      || markerOccurrences(attempt.text, marker) !== 1
    ))
  ) {
    reasons.push('direct attempt must use the exact completion text on the origin route');
  }
  if (
    [...directAttempts, ...fallbackDeliveries].some((call) => (
      foreign.has(call.route) && markerOccurrences(call.text, marker) > 0
    ))
  ) {
    reasons.push('completion appeared on a foreign route');
  }

  if (deliveryMode === 'direct') {
    if (matchingAttempts[0]?.delivered !== true) {
      reasons.push('direct completion attempt was not delivered');
    }
    if (fallbackDeliveries.length !== 0) {
      reasons.push('successful direct delivery did not suppress fallback');
    }
  } else if (deliveryMode === 'fail') {
    if (matchingAttempts[0]?.delivered !== false) {
      reasons.push('forced direct failure did not fail');
    }
    if (
      fallbackDeliveries.length !== 1
      || fallbackDeliveries[0]?.route !== originRoute
      || fallbackDeliveries[0]?.text?.trim() !== marker
      || markerOccurrences(fallbackDeliveries[0]?.text, marker) !== 1
      || fallbackDeliveries[0]?.delivered !== true
    ) {
      reasons.push('fallback must deliver the exact completion text once on the origin route');
    }
    if (
      fallbackPipeline !== 'helper'
      || fallbackSentCount !== 1
      || fallbackFailedCount !== 0
    ) {
      reasons.push('fallback must use the production helper pipeline successfully');
    }
  } else {
    reasons.push('delivery mode is not recognized');
  }

  const visibleMarkerCount = directAttempts.reduce(
    (count, attempt) => count + (
      attempt.delivered ? markerOccurrences(attempt.text, marker) : 0
    ),
    0,
  ) + fallbackDeliveries.reduce(
    (count, delivery) => count + (
      delivery.delivered ? markerOccurrences(delivery.text, marker) : 0
    ),
    0,
  );
  if (visibleMarkerCount !== 1) {
    reasons.push('completion marker was not visibly delivered exactly once');
  }

  return {
    pass: reasons.length === 0,
    reasons,
  };
}

export async function prepareWorkflowProject({ parentDir } = {}) {
  if (!parentDir || !path.isAbsolute(parentDir)) {
    throw new TypeError('parentDir must be an absolute path');
  }
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(parentDir, 0o700);
  const cwd = path.join(parentDir, `workflow-${crypto.randomBytes(6).toString('hex')}`);
  fs.cpSync(SOURCE_ROOT, cwd, { recursive: true, errorOnExist: true });
  makeTreePrivate(cwd);
  const skillPath = path.join(cwd, SKILL_RELATIVE_PATH);
  return {
    cwd,
    skillName: 'completion-sentinel',
    skillPath,
    fixtureHash: await sha256File(skillPath),
    workflowPolicyOverridePresent: hasWorkflowPolicyOverride(cwd),
  };
}

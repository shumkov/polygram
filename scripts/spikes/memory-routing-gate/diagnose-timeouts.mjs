import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  createClaudeAdapter, inspectClaudeAuth, subscriptionOnlyEnv,
} from './adapters.mjs';
import { loadRoutingFixtures, fixtureManifestHash } from './fixtures.mjs';
import { runRoutingCase } from './harness.mjs';
import {
  assertClaudeRuntimeIdentityUnchanged,
  assertClaudeRuntimeUnchanged as verifyClaudeRuntimeUnchanged,
  attestClaudeRuntime,
  EXPECTED_CLAUDE_VERSION,
} from './runtime-attestation.mjs';

const execFileAsync = promisify(execFile);
const MODULE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(MODULE_PATH), '../../..');

const HARD_DEADLINE_MS = 120_000;
const CLEANUP_MS = 5_000;
const CHECKPOINT_RESERVE_MS = 5_000;
const RUNTIME_MAX_MS = 14_940_000;
const STOP_WINDOW_MS = 10_000;

export const DIAGNOSTIC_LIMITS = Object.freeze({
  repetitions: 5,
  fixtureCount: 22,
  callCeiling: 110,
  softDeadlineMs: 60_000,
  hardDeadlineMs: HARD_DEADLINE_MS,
  cleanupMs: CLEANUP_MS,
  checkpointReserveMs: CHECKPOINT_RESERVE_MS,
  callReservationMs: HARD_DEADLINE_MS + CLEANUP_MS + CHECKPOINT_RESERVE_MS,
  runtimeMaxMs: RUNTIME_MAX_MS,
  stopWindowMs: STOP_WINDOW_MS,
  outerMaximumMs: RUNTIME_MAX_MS + STOP_WINDOW_MS,
  terminalCheckpointMs: RUNTIME_MAX_MS - STOP_WINDOW_MS,
  maxSequence: 112,
});

const NEXT_DECISIONS = Object.freeze({
  'old-cap-false-rejection': 'propose-timeout-amendment-and-rerun-u24',
  'process-boundary-fault': 'fix-adapter-process-boundary-and-rerun-diagnostic',
  'route-unsuitable-at-diagnostic-ceiling': 'choose-alternate-route-or-queue-tolerant-policy',
  'router-quality-failure': 'revise-router-contract-or-prompt-in-reviewed-plan',
  'diagnostic-failure': 'fix-review-and-rerun-changed-diagnostic',
  inconclusive: 'preserve-u24-stop-and-choose-alternate-policy',
});

const ROUTER_QUALITY_CODES = new Set([
  'ROUTER_EXPECTATION_MISMATCH',
  'ROUTER_OUTPUT_SCHEMA',
  'ROUTER_PARTS_OVERLAP',
  'ROUTER_MIXED_AMBIGUOUS',
  'ROUTER_MIXED_COVERAGE',
  'ROUTER_MIXED_SENSITIVE_MISSING',
  'ROUTER_MIXED_WORK_SENSITIVE',
  'ROUTER_MIXED_NOT_EXTRACTIVE',
  'ROUTER_PERSONAL_VETO',
  'ROUTER_OUTPUT_SECRET',
]);
const INTEGRITY_CODES = new Set([
  'ROUTER_AUTH_AMBIGUOUS',
  'ROUTER_AUTH_UNAVAILABLE',
  'ROUTER_CLAUDE_RUNTIME_MISMATCH',
  'ROUTER_MODEL_IDENTITY',
  'ROUTER_TOOL_USE',
]);
const INVALID_ENVELOPE_CODES = new Set([
  'ROUTER_OUTPUT_MALFORMED',
  'ROUTER_OUTPUT_MISSING',
]);
const PROCESS_CODES = new Set([
  'ROUTER_TIMEOUT',
  'ROUTER_PROCESS_EXIT',
  'ROUTER_OUTPUT_TOO_LARGE',
  'ROUTER_STDERR_TOO_LARGE',
]);
const ATTEMPT_PHASES = new Set([
  'starting', 'awaiting_output', 'output_started', 'awaiting_close',
]);
const OFFSET_FIELDS = [
  'stdin_flush_ms',
  'first_stdout_ms',
  'complete_json_candidate_ms',
  'stdout_end_ms',
  'close_ms',
  'total_elapsed_ms',
];
const DIAGNOSTIC_OUTCOMES = new Set(Object.keys(NEXT_DECISIONS));
const ATTEMPT_RESULTS = new Set(['valid', ...DIAGNOSTIC_OUTCOMES]);
const PREFLIGHT_FIELDS = [
  'manager_authorized',
  'runtime_attested',
  'authentication_attested',
  'model_exact',
  'prompt_manifest_exact',
  'schema_manifest_exact',
  'tools_prohibited',
  'environment_allowlist_exact',
  'security_flags_exact',
  'paths_private',
];
const DIAGNOSTIC_FIXTURES = loadRoutingFixtures()
  .filter((fixture) => fixture.expected !== 'quarantine');
const DIAGNOSTIC_MANIFEST_HASH = fixtureManifestHash(DIAGNOSTIC_FIXTURES);
const RECEIPT_EVIDENCE_FIELDS = [
  'phase',
  ...OFFSET_FIELDS,
  'stdout_bytes',
  'stderr_bytes',
  'payload_valid',
  'duration_ms',
  'duration_api_ms',
  'num_turns',
];
const CLOSED_REASONS = new Set([
  'integrity-failure',
  'invalid-evidence',
  'cleanup-unconfirmed',
  'production-became-busy',
  'stream-over-limit',
  'payload-valid-process-boundary',
  'router-quality-failure',
  'hard-timeout-after-input',
  'hard-timeout-before-input',
  'early-process-exit',
  'invalid-envelope',
  'invalid-success-evidence',
  'success-after-hard-deadline',
  'slow-valid',
  'fast-valid',
  'runner-nonterminal',
  'campaign-budget-exhausted',
  'unknown-evidence',
  'checkpoint-unconfirmed',
  'call-arithmetic-mismatch',
  'call-ceiling-with-slow-valid',
  'call-ceiling-fast-only',
]);
const OUTCOME_REASONS = Object.freeze({
  'old-cap-false-rejection': new Set(['call-ceiling-with-slow-valid']),
  'process-boundary-fault': new Set(['payload-valid-process-boundary']),
  'route-unsuitable-at-diagnostic-ceiling': new Set(['hard-timeout-after-input']),
  'router-quality-failure': new Set(['router-quality-failure']),
  'diagnostic-failure': new Set([
    'integrity-failure',
    'invalid-evidence',
    'cleanup-unconfirmed',
    'stream-over-limit',
    'hard-timeout-before-input',
    'early-process-exit',
    'invalid-envelope',
    'invalid-success-evidence',
    'success-after-hard-deadline',
    'runner-nonterminal',
    'campaign-budget-exhausted',
    'unknown-evidence',
    'checkpoint-unconfirmed',
    'call-arithmetic-mismatch',
  ]),
  inconclusive: new Set(['production-became-busy', 'call-ceiling-fast-only']),
});
const OUT_OF_BAND_REASONS = new Set([
  'integrity-failure',
  'invalid-evidence',
  'production-became-busy',
  'campaign-budget-exhausted',
  'unknown-evidence',
  'checkpoint-unconfirmed',
  'call-arithmetic-mismatch',
]);

export const STAGING_SOURCE_FILES = Object.freeze([
  'scripts/spikes/memory-routing-gate/diagnose-timeouts.mjs',
  'scripts/spikes/memory-routing-gate/runtime-attestation.mjs',
  'scripts/spikes/memory-routing-gate/adapters.mjs',
  'scripts/spikes/memory-routing-gate/fixtures.mjs',
  'scripts/spikes/memory-routing-gate/harness.mjs',
  'scripts/spikes/memory-routing-gate/contract.mjs',
  'lib/secret-detect.js',
]);

export function transientServiceProperties(scratchPath) {
  if (typeof scratchPath !== 'string' || !path.isAbsolute(scratchPath)) {
    throw new TypeError('scratch path must be absolute');
  }
  return {
    KillMode: 'control-group',
    RuntimeMaxSec: '14940s',
    TimeoutStopSec: '10s',
    SendSIGKILL: 'yes',
    RemainAfterExit: 'yes',
    StandardOutput: 'null',
    StandardError: 'null',
    WorkingDirectory: scratchPath,
  };
}

export function nextDecisionFor(outcome) {
  if (!Object.hasOwn(NEXT_DECISIONS, outcome)) throw new TypeError('unknown diagnostic outcome');
  return NEXT_DECISIONS[outcome];
}

function classified(outcome, reason, slowValid = false) {
  return {
    outcome,
    reason,
    terminal: outcome !== null,
    slow_valid: slowValid,
    ...(outcome ? { next_decision: nextDecisionFor(outcome) } : {}),
  };
}

function invalidNumericEvidence(evidence, { allowParsedRouterEnvelope = false } = {}) {
  if (!hasExactKeys(evidence, RECEIPT_EVIDENCE_FIELDS)
      || !ATTEMPT_PHASES.has(evidence.phase)
      || typeof evidence.payload_valid !== 'boolean') return true;
  for (const field of OFFSET_FIELDS) {
    const value = evidence[field];
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 180_000)) return true;
  }
  for (const [field, maximum] of [['stdout_bytes', 1_000_000], ['stderr_bytes', 256_000]]) {
    const value = evidence[field];
    if (value !== 'over_limit'
        && (!Number.isInteger(value) || value < 0 || value > maximum)) return true;
  }
  for (const field of ['duration_ms', 'duration_api_ms']) {
    const value = evidence[field];
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 120_000)) return true;
  }
  if (evidence.num_turns !== null && evidence.num_turns !== 1) return true;
  const observedOffsets = OFFSET_FIELDS
    .map((field) => evidence[field])
    .filter((value) => value !== null);
  if (observedOffsets.some((value, index) => index > 0 && value < observedOffsets[index - 1])) {
    return true;
  }
  const phaseShape = {
    starting: evidence.stdin_flush_ms === null
      && evidence.first_stdout_ms === null
      && evidence.complete_json_candidate_ms === null
      && evidence.stdout_end_ms === null,
    awaiting_output: Number.isInteger(evidence.stdin_flush_ms)
      && evidence.first_stdout_ms === null
      && evidence.complete_json_candidate_ms === null
      && evidence.stdout_end_ms === null,
    output_started: Number.isInteger(evidence.stdin_flush_ms)
      && Number.isInteger(evidence.first_stdout_ms)
      && evidence.stdout_end_ms === null,
    awaiting_close: Number.isInteger(evidence.stdin_flush_ms)
      && Number.isInteger(evidence.first_stdout_ms)
      && Number.isInteger(evidence.stdout_end_ms),
  };
  if (!phaseShape[evidence.phase]) return true;
  if (evidence.payload_valid || allowParsedRouterEnvelope) {
    if (evidence.phase !== 'awaiting_close'
        || !Number.isInteger(evidence.complete_json_candidate_ms)
        || !Number.isInteger(evidence.duration_ms)
        || !Number.isInteger(evidence.duration_api_ms)
        || evidence.num_turns !== 1) return true;
  } else if (evidence.duration_ms !== null
      || evidence.duration_api_ms !== null
      || evidence.num_turns !== null) return true;
  return false;
}

function acceptedAttemptValid(evidence) {
  if (evidence?.payload_valid !== true || evidence.phase !== 'awaiting_close') return false;
  if (!OFFSET_FIELDS.every((field) => Number.isInteger(evidence[field]))) return false;
  for (let index = 1; index < OFFSET_FIELDS.length; index += 1) {
    if (evidence[OFFSET_FIELDS[index]] < evidence[OFFSET_FIELDS[index - 1]]) return false;
  }
  return Number.isInteger(evidence.stdout_bytes)
    && Number.isInteger(evidence.stderr_bytes)
    && Number.isInteger(evidence.duration_ms)
    && Number.isInteger(evidence.duration_api_ms)
    && evidence.num_turns === 1;
}

function receiptAttemptEvidenceValid(evidence) {
  return !invalidNumericEvidence(evidence, {
    allowParsedRouterEnvelope: evidence?.payload_valid === false
      && [evidence.duration_ms, evidence.duration_api_ms, evidence.num_turns]
        .some((value) => value !== null),
  });
}

export function classifyDiagnosticEvent({
  integrityFailure = false,
  result,
  productionBusy = false,
  runnerDied = false,
  reservationFits = true,
  callOrdinal = 0,
  priorAttempts = [],
} = {}) {
  if (integrityFailure || INTEGRITY_CODES.has(result?.errorCode)) {
    return classified('diagnostic-failure', 'integrity-failure');
  }
  const routerQuality = result?.status === 'mismatch'
    || ROUTER_QUALITY_CODES.has(result?.errorCode);
  if (result && invalidNumericEvidence(result.attemptEvidence, {
    allowParsedRouterEnvelope: routerQuality,
  })) {
    return classified('diagnostic-failure', 'invalid-evidence');
  }
  if (result && PROCESS_CODES.has(result.errorCode)
      && result.diagnostics?.cleanupConfirmed !== true) {
    return classified('diagnostic-failure', 'cleanup-unconfirmed');
  }
  if (productionBusy) return classified('inconclusive', 'production-became-busy');
  if (['ROUTER_OUTPUT_TOO_LARGE', 'ROUTER_STDERR_TOO_LARGE'].includes(result?.errorCode)
      || result?.attemptEvidence?.stdout_bytes === 'over_limit'
      || result?.attemptEvidence?.stderr_bytes === 'over_limit') {
    return classified('diagnostic-failure', 'stream-over-limit');
  }
  if (['ROUTER_PROCESS_EXIT', 'ROUTER_TIMEOUT'].includes(result?.errorCode)
      && result.attemptEvidence?.payload_valid === true) {
    return classified('process-boundary-fault', 'payload-valid-process-boundary');
  }
  if (routerQuality) {
    return classified('router-quality-failure', 'router-quality-failure');
  }
  if (result?.errorCode === 'ROUTER_TIMEOUT') {
    if (result.attemptEvidence.total_elapsed_ms < DIAGNOSTIC_LIMITS.hardDeadlineMs) {
      return classified('diagnostic-failure', 'invalid-evidence');
    }
    const afterInput = Number.isInteger(result.attemptEvidence?.stdin_flush_ms)
      || Number.isInteger(result.attemptEvidence?.first_stdout_ms);
    if (afterInput && result.attemptEvidence?.payload_valid !== true) {
      return classified(
        'route-unsuitable-at-diagnostic-ceiling',
        'hard-timeout-after-input',
      );
    }
    return classified('diagnostic-failure', 'hard-timeout-before-input');
  }
  if (result?.errorCode === 'ROUTER_PROCESS_EXIT') {
    if (result.attemptEvidence.total_elapsed_ms > DIAGNOSTIC_LIMITS.hardDeadlineMs) {
      return classified('diagnostic-failure', 'invalid-evidence');
    }
    return classified('diagnostic-failure', 'early-process-exit');
  }
  if (INVALID_ENVELOPE_CODES.has(result?.errorCode)) {
    return classified('diagnostic-failure', 'invalid-envelope');
  }
  if (result) {
    if (result.status !== 'accepted' || !acceptedAttemptValid(result.attemptEvidence)) {
      return classified('diagnostic-failure', 'invalid-success-evidence');
    }
    const elapsed = result.attemptEvidence.total_elapsed_ms;
    if (elapsed > DIAGNOSTIC_LIMITS.hardDeadlineMs) {
      return classified('diagnostic-failure', 'success-after-hard-deadline');
    }
    const slowValid = elapsed > DIAGNOSTIC_LIMITS.softDeadlineMs;
    if (callOrdinal === DIAGNOSTIC_LIMITS.callCeiling) {
      const anySlow = [...priorAttempts, { slow_valid: slowValid }]
        .some((attempt) => attempt.slow_valid === true);
      return classified(
        anySlow ? 'old-cap-false-rejection' : 'inconclusive',
        anySlow ? 'call-ceiling-with-slow-valid' : 'call-ceiling-fast-only',
        slowValid,
      );
    }
    return classified(null, slowValid ? 'slow-valid' : 'fast-valid', slowValid);
  }
  if (runnerDied) return classified('diagnostic-failure', 'runner-nonterminal');
  if (reservationFits === false) {
    return classified('diagnostic-failure', 'campaign-budget-exhausted');
  }
  return classified('diagnostic-failure', 'unknown-evidence');
}

function assertBoundedInteger(value, maximum, name) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a bounded integer`);
  }
  return value;
}

function reservationFits(activatedAtMs, nowMs) {
  assertBoundedInteger(activatedAtMs, Number.MAX_SAFE_INTEGER, 'activation time');
  assertBoundedInteger(nowMs, Number.MAX_SAFE_INTEGER, 'current time');
  const terminalDeadline = activatedAtMs + DIAGNOSTIC_LIMITS.terminalCheckpointMs;
  return nowMs + DIAGNOSTIC_LIMITS.callReservationMs <= terminalDeadline;
}

function receiptAttempt({ fixture, repetition, ordinal, result, decision }) {
  return {
    fixture_id: fixture.id,
    repetition,
    ordinal,
    evidence: sanitizedReceiptEvidence(result.attemptEvidence),
    slow_valid: decision.slow_valid,
    attempted_call_result: decision.outcome || 'valid',
    terminal_result: decision.outcome,
  };
}

function campaignResult(decision, attempts) {
  return {
    outcome: decision.outcome,
    reason: decision.reason,
    next_decision: nextDecisionFor(decision.outcome),
    attempts,
    slow_valid_observed: attempts.some((attempt) => attempt.slow_valid === true),
  };
}

export async function runDiagnosticCampaign({
  fixtures,
  activatedAtMs,
  monotonicNowMs,
  checkBusy,
  routeOnce,
  checkpointAttempt,
  checkpointOutOfBand,
}) {
  if (!Array.isArray(fixtures) || fixtures.length !== DIAGNOSTIC_LIMITS.fixtureCount
      || fixtures.some((fixture) => fixture?.expected === 'quarantine')
      || fixtureManifestHash(fixtures) !== DIAGNOSTIC_MANIFEST_HASH) {
    throw new TypeError('diagnostic campaign requires the 22 non-secret fixtures');
  }
  if (![monotonicNowMs, checkBusy, routeOnce, checkpointAttempt, checkpointOutOfBand]
    .every((candidate) => typeof candidate === 'function')) {
    throw new TypeError('diagnostic campaign seams are required');
  }
  const attempts = [];
  const checkpointTerminal = async (decision) => {
    try {
      await checkpointOutOfBand(decision);
    } catch {
      // The in-memory result remains diagnostic-failure when durable evidence cannot be confirmed.
    }
  };
  let callOrdinal = 0;
  for (let repetition = 1; repetition <= DIAGNOSTIC_LIMITS.repetitions; repetition += 1) {
    for (const fixture of fixtures) {
      let productionBusy;
      try {
        productionBusy = await checkBusy({ nextCallOrdinal: callOrdinal + 1 });
      } catch {
        const decision = classifyDiagnosticEvent({ integrityFailure: true, priorAttempts: attempts });
        await checkpointTerminal(decision);
        return campaignResult(decision, attempts);
      }
      if (productionBusy) {
        const decision = classifyDiagnosticEvent({ productionBusy: true, priorAttempts: attempts });
        await checkpointTerminal(decision);
        return campaignResult(decision, attempts);
      }
      let fits;
      try {
        fits = reservationFits(activatedAtMs, monotonicNowMs());
      } catch {
        const decision = classifyDiagnosticEvent({ integrityFailure: true, priorAttempts: attempts });
        await checkpointTerminal(decision);
        return campaignResult(decision, attempts);
      }
      if (!fits) {
        const decision = classifyDiagnosticEvent({ reservationFits: false, priorAttempts: attempts });
        await checkpointTerminal(decision);
        return campaignResult(decision, attempts);
      }
      callOrdinal += 1;
      let result;
      try {
        result = await routeOnce({
          fixture,
          repetition,
          callOrdinal,
          timeoutMs: DIAGNOSTIC_LIMITS.hardDeadlineMs,
        });
      } catch {
        const decision = classifyDiagnosticEvent({ integrityFailure: true, priorAttempts: attempts });
        await checkpointTerminal(decision);
        return campaignResult(decision, attempts);
      }
      const decision = classifyDiagnosticEvent({
        result,
        callOrdinal,
        priorAttempts: attempts,
      });
      if (!result || !receiptAttemptEvidenceValid(result.attemptEvidence)) {
        await checkpointTerminal(decision);
        return campaignResult(decision, attempts);
      }
      if (decision.reason === 'invalid-evidence') {
        await checkpointTerminal(decision);
        return campaignResult(decision, attempts);
      }
      const attempt = receiptAttempt({ fixture, repetition, ordinal: callOrdinal, result, decision });
      try {
        await checkpointAttempt(attempt, decision);
      } catch {
        const checkpointFailure = classified('diagnostic-failure', 'checkpoint-unconfirmed');
        await checkpointTerminal(checkpointFailure);
        return campaignResult(checkpointFailure, attempts);
      }
      attempts.push(attempt);
      if (decision.terminal) return campaignResult(decision, attempts);
    }
  }
  const decision = classified('diagnostic-failure', 'call-arithmetic-mismatch');
  await checkpointTerminal(decision);
  return campaignResult(decision, attempts);
}

export async function runLiveDiagnosticCampaign({
  claudeBin,
  expectedModel,
  scratchPath,
  createAdapter = createClaudeAdapter,
  runCase = runRoutingCase,
  attestRuntime = attestClaudeRuntime,
  assertRuntimeIdentityUnchanged = assertClaudeRuntimeIdentityUnchanged,
  ...campaignOptions
}) {
  if (typeof claudeBin !== 'string' || !path.isAbsolute(claudeBin)) {
    throw new TypeError('Claude binary must be absolute');
  }
  if (typeof scratchPath !== 'string' || !path.isAbsolute(scratchPath)) {
    throw new TypeError('scratch path must be absolute');
  }
  if (typeof expectedModel !== 'string' || !/^claude-haiku-[a-z0-9-]+$/.test(expectedModel)) {
    throw new TypeError('expected model must be an exact Haiku identity');
  }
  const runtime = await attestRuntime(claudeBin);
  if (!runtime || typeof runtime.canonicalPath !== 'string'
      || !path.isAbsolute(runtime.canonicalPath)) {
    throw new Error('Claude runtime attestation failed');
  }
  const adapter = createAdapter({
    binary: runtime.canonicalPath,
    model: 'haiku',
    expectedObservedModel: expectedModel,
    timeoutMs: DIAGNOSTIC_LIMITS.hardDeadlineMs,
    tempRoot: scratchPath,
  });
  return runDiagnosticCampaign({
    ...campaignOptions,
    fixtures: DIAGNOSTIC_FIXTURES.map((fixture) => structuredClone(fixture)),
    routeOnce: async ({ fixture }) => {
      await assertRuntimeIdentityUnchanged(runtime);
      return runCase({ fixture, adapter });
    },
  });
}

const RECEIPT_SCHEMA = 'polygram-memory-routing-timeout-diagnostic/v1';

function baseReceipt() {
  return {
    schema_version: RECEIPT_SCHEMA,
    sequence: 0,
    preflight_complete: false,
    campaign_elapsed_ms: 0,
    attempts: [],
    terminal: null,
    out_of_band_terminal_count: 0,
  };
}

async function assertPrivateParent(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('evidence path must be absolute');
  }
  const info = await stat(path.dirname(filePath));
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('evidence directory must be owner-only');
  }
}

async function assertPathAbsent(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('evidence absence could not be confirmed', { cause: error });
  }
  throw new Error('evidence path already exists');
}

async function writeExclusiveJson(filePath, value) {
  await assertPrivateParent(filePath);
  let handle;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (cause) {
    throw new Error('exclusive evidence creation failed', { cause });
  } finally {
    await handle?.close();
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    renamed = true;
    await fsyncDirectory(directory);
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

function validateReceipt(receipt) {
  if (!receipt || receipt.schema_version !== RECEIPT_SCHEMA) throw new Error('invalid receipt schema');
  if (!hasExactKeys(receipt, [
    'schema_version',
    'sequence',
    'preflight_complete',
    'campaign_elapsed_ms',
    'attempts',
    'terminal',
    'out_of_band_terminal_count',
  ])) throw new Error('invalid receipt fields');
  assertBoundedInteger(receipt.sequence, DIAGNOSTIC_LIMITS.maxSequence, 'receipt sequence');
  assertBoundedInteger(
    receipt.campaign_elapsed_ms,
    DIAGNOSTIC_LIMITS.outerMaximumMs,
    'campaign elapsed time',
  );
  if (typeof receipt.preflight_complete !== 'boolean'
      || !Array.isArray(receipt.attempts)
      || receipt.attempts.length > DIAGNOSTIC_LIMITS.callCeiling
      || ![0, 1].includes(receipt.out_of_band_terminal_count)) {
    throw new Error('invalid receipt evidence');
  }
  if (receipt.terminal !== null
      && (!hasExactKeys(receipt.terminal, ['outcome', 'reason', 'next_decision'])
        || !DIAGNOSTIC_OUTCOMES.has(receipt.terminal?.outcome)
        || !CLOSED_REASONS.has(receipt.terminal?.reason)
        || !OUTCOME_REASONS[receipt.terminal?.outcome]?.has(receipt.terminal?.reason)
        || receipt.terminal?.next_decision !== nextDecisionFor(receipt.terminal.outcome))) {
    throw new Error('invalid receipt terminal');
  }
  if (receipt.sequence !== Number(receipt.preflight_complete)
      + receipt.attempts.length + receipt.out_of_band_terminal_count) {
    throw new Error('invalid receipt arithmetic');
  }
  for (let index = 0; index < receipt.attempts.length; index += 1) {
    validateStoredAttempt(receipt.attempts[index], index + 1);
  }
  const terminalAttempts = receipt.attempts.filter((attempt) => attempt.terminal_result !== null);
  if (!receipt.preflight_complete
      && (receipt.sequence !== 0 || receipt.attempts.length !== 0
        || receipt.terminal !== null || receipt.out_of_band_terminal_count !== 0)) {
    throw new Error('invalid receipt preflight state');
  }
  if (terminalAttempts.some((attempt) => attempt !== receipt.attempts.at(-1))) {
    throw new Error('invalid receipt terminal attempt order');
  }
  if (receipt.out_of_band_terminal_count === 1) {
    if (receipt.terminal === null || terminalAttempts.length !== 0) {
      throw new Error('invalid receipt out-of-band terminal');
    }
    if (!OUT_OF_BAND_REASONS.has(receipt.terminal.reason)) {
      throw new Error('invalid receipt out-of-band terminal reason');
    }
  } else if (receipt.terminal === null) {
    if (terminalAttempts.length !== 0) throw new Error('invalid receipt terminal projection');
  } else {
    const [terminalAttempt] = terminalAttempts;
    if (terminalAttempts.length !== 1
        || terminalAttempt.terminal_result !== receipt.terminal.outcome
        || terminalAttempt.attempted_call_result !== receipt.terminal.outcome) {
      throw new Error('invalid receipt terminal projection');
    }
    validateAttemptTerminalRelationship(terminalAttempt, receipt.terminal);
  }
  if (receipt.terminal?.reason === 'call-ceiling-with-slow-valid') {
    if (receipt.attempts.length !== DIAGNOSTIC_LIMITS.callCeiling
        || !receipt.attempts.some((attempt) => attempt.slow_valid === true)) {
      throw new Error('invalid call-ceiling slow terminal');
    }
  }
  if (receipt.terminal?.reason === 'call-ceiling-fast-only') {
    if (receipt.attempts.length !== DIAGNOSTIC_LIMITS.callCeiling
        || receipt.attempts.some((attempt) => attempt.slow_valid === true)) {
      throw new Error('invalid call-ceiling fast terminal');
    }
  }
  return receipt;
}

function hasExactKeys(value, expected) {
  return value && typeof value === 'object'
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sanitizedReceiptEvidence(evidence) {
  return Object.fromEntries(RECEIPT_EVIDENCE_FIELDS.map((field) => [field, evidence[field]]));
}

function parsedClosedEnvelopeEvidence(evidence) {
  return evidence.phase === 'awaiting_close'
    && OFFSET_FIELDS.every((field) => Number.isInteger(evidence[field]))
    && Number.isInteger(evidence.stdout_bytes)
    && Number.isInteger(evidence.stderr_bytes)
    && Number.isInteger(evidence.complete_json_candidate_ms)
    && Number.isInteger(evidence.duration_ms)
    && Number.isInteger(evidence.duration_api_ms)
    && evidence.num_turns === 1;
}

function streamOverLimit(evidence) {
  return evidence.stdout_bytes === 'over_limit' || evidence.stderr_bytes === 'over_limit';
}

function successMetricsAbsent(evidence) {
  return evidence.duration_ms === null
    && evidence.duration_api_ms === null
    && evidence.num_turns === null;
}

function validateAttemptTerminalRelationship(attempt, terminal) {
  const { evidence } = attempt;
  if (terminal.outcome === 'process-boundary-fault'
      && (evidence.payload_valid !== true || !parsedClosedEnvelopeEvidence(evidence))) {
    throw new Error('invalid process-boundary terminal evidence');
  }
  if (terminal.outcome === 'router-quality-failure'
      && (evidence.payload_valid !== false || !parsedClosedEnvelopeEvidence(evidence))) {
    throw new Error('invalid router-quality terminal evidence');
  }
  if (terminal.outcome === 'route-unsuitable-at-diagnostic-ceiling'
      && (evidence.payload_valid !== false
        || streamOverLimit(evidence)
        || (!Number.isInteger(evidence.stdin_flush_ms)
          && !Number.isInteger(evidence.first_stdout_ms))
        || !Number.isInteger(evidence.close_ms)
        || evidence.total_elapsed_ms < DIAGNOSTIC_LIMITS.hardDeadlineMs)) {
    throw new Error('invalid diagnostic-ceiling terminal evidence');
  }
  if (['old-cap-false-rejection', 'inconclusive'].includes(terminal.outcome)
      && terminal.reason.startsWith('call-ceiling-')
      && (attempt.ordinal !== DIAGNOSTIC_LIMITS.callCeiling
        || !acceptedAttemptValid(evidence))) {
    throw new Error('invalid call-ceiling terminal attempt');
  }
  if (terminal.outcome !== 'diagnostic-failure') return;
  const closeConfirmed = Number.isInteger(evidence.close_ms);
  switch (terminal.reason) {
    case 'cleanup-unconfirmed':
      if (evidence.close_ms !== null
          || (evidence.payload_valid === false
            && !streamOverLimit(evidence)
            && !successMetricsAbsent(evidence))) {
        throw new Error('invalid cleanup terminal evidence');
      }
      break;
    case 'stream-over-limit':
      if (evidence.payload_valid !== false || !closeConfirmed || !streamOverLimit(evidence)) {
        throw new Error('invalid stream terminal evidence');
      }
      break;
    case 'hard-timeout-before-input':
      if (evidence.payload_valid !== false || evidence.phase !== 'starting'
          || evidence.stdin_flush_ms !== null || evidence.first_stdout_ms !== null
          || streamOverLimit(evidence)
          || !closeConfirmed
          || evidence.total_elapsed_ms < DIAGNOSTIC_LIMITS.hardDeadlineMs) {
        throw new Error('invalid before-input terminal evidence');
      }
      break;
    case 'early-process-exit':
      if (evidence.payload_valid !== false || !closeConfirmed
          || streamOverLimit(evidence)
          || evidence.total_elapsed_ms > DIAGNOSTIC_LIMITS.hardDeadlineMs) {
        throw new Error('invalid early-exit terminal evidence');
      }
      break;
    case 'invalid-envelope':
      if (evidence.payload_valid !== false || !closeConfirmed
          || streamOverLimit(evidence) || !successMetricsAbsent(evidence)) {
        throw new Error('invalid envelope terminal evidence');
      }
      break;
    case 'invalid-success-evidence':
      if (evidence.payload_valid !== false || !closeConfirmed || streamOverLimit(evidence)) {
        throw new Error('invalid success terminal evidence');
      }
      break;
    case 'success-after-hard-deadline':
      if (!acceptedAttemptValid(evidence)
          || evidence.total_elapsed_ms <= DIAGNOSTIC_LIMITS.hardDeadlineMs) {
        throw new Error('invalid late-success terminal evidence');
      }
      break;
    case 'integrity-failure':
      if (evidence.payload_valid !== false || !closeConfirmed || streamOverLimit(evidence)) {
        throw new Error('invalid integrity terminal evidence');
      }
      break;
    default:
      throw new Error('diagnostic terminal reason is not attempt-derived');
  }
}

function validateStoredAttempt(attempt, expectedOrdinal) {
  const expectedFixture = DIAGNOSTIC_FIXTURES[(expectedOrdinal - 1) % DIAGNOSTIC_FIXTURES.length];
  const expectedRepetition = Math.floor((expectedOrdinal - 1) / DIAGNOSTIC_FIXTURES.length) + 1;
  if (!hasExactKeys(attempt, [
    'fixture_id',
    'repetition',
    'ordinal',
    'evidence',
    'slow_valid',
    'attempted_call_result',
    'terminal_result',
  ])
      || attempt.fixture_id !== expectedFixture?.id
      || attempt.repetition !== expectedRepetition
      || attempt.ordinal !== expectedOrdinal
      || !hasExactKeys(attempt.evidence, RECEIPT_EVIDENCE_FIELDS)
      || !receiptAttemptEvidenceValid(attempt.evidence)
      || typeof attempt.slow_valid !== 'boolean'
      || !ATTEMPT_RESULTS.has(attempt.attempted_call_result)
      || (attempt.terminal_result !== null && !DIAGNOSTIC_OUTCOMES.has(attempt.terminal_result))
      || (attempt.terminal_result === null && attempt.attempted_call_result !== 'valid')
      || (attempt.terminal_result !== null
        && attempt.attempted_call_result !== attempt.terminal_result)) {
    throw new Error('invalid attempt evidence');
  }
  const cleanSuccess = attempt.attempted_call_result === 'valid'
    || ['old-cap-false-rejection', 'inconclusive'].includes(attempt.attempted_call_result);
  const derivedSlow = cleanSuccess
    && attempt.evidence.payload_valid === true
    && Number.isInteger(attempt.evidence.close_ms)
    && attempt.evidence.total_elapsed_ms > DIAGNOSTIC_LIMITS.softDeadlineMs
    && attempt.evidence.total_elapsed_ms <= DIAGNOSTIC_LIMITS.hardDeadlineMs;
  if (attempt.slow_valid !== derivedSlow) throw new Error('invalid attempt slow evidence');
  if (attempt.attempted_call_result === 'valid'
      && !acceptedAttemptValid(attempt.evidence)) {
    throw new Error('valid attempt requires accepted evidence');
  }
  if (expectedOrdinal === DIAGNOSTIC_LIMITS.callCeiling
      && attempt.terminal_result === null) {
    throw new Error('call-ceiling attempt must be terminal');
  }
}

async function assertCurrentReceipt(filePath, expected) {
  const info = await stat(filePath);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('receipt privacy mismatch');
  }
  const current = validateReceipt(JSON.parse(await readFile(filePath, 'utf8')));
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('stale receipt checkpoint');
}

export async function createDiagnosticReceipt(filePath) {
  const receipt = baseReceipt();
  await writeExclusiveJson(filePath, receipt);
  await fsyncDirectory(path.dirname(filePath));
  return receipt;
}

function sanitizeCheckpointAttempt(attempt, expectedOrdinal) {
  const sanitized = {
    fixture_id: attempt.fixture_id,
    repetition: attempt.repetition,
    ordinal: attempt.ordinal,
    evidence: sanitizedReceiptEvidence(attempt.evidence || {}),
    slow_valid: attempt.slow_valid,
    attempted_call_result: attempt.attempted_call_result,
    terminal_result: attempt.terminal_result,
  };
  validateStoredAttempt(sanitized, expectedOrdinal);
  return sanitized;
}

export async function checkpointDiagnosticReceipt(filePath, receipt, checkpoint) {
  validateReceipt(receipt);
  await assertCurrentReceipt(filePath, receipt);
  if (receipt.terminal || !checkpoint || typeof checkpoint !== 'object') {
    throw new Error('receipt is already terminal');
  }
  const elapsed = assertBoundedInteger(
    checkpoint.campaign_elapsed_ms,
    DIAGNOSTIC_LIMITS.outerMaximumMs,
    'campaign elapsed time',
  );
  if (elapsed < receipt.campaign_elapsed_ms) throw new Error('campaign elapsed time is not monotonic');
  let next;
  if (checkpoint.kind === 'preflight') {
    if (receipt.sequence !== 0 || receipt.preflight_complete) throw new Error('invalid preflight checkpoint');
    next = { ...receipt, sequence: 1, preflight_complete: true, campaign_elapsed_ms: elapsed };
  } else if (checkpoint.kind === 'attempt') {
    if (!receipt.preflight_complete) throw new Error('preflight checkpoint is required');
    const attempt = sanitizeCheckpointAttempt(checkpoint.attempt, receipt.attempts.length + 1);
    const terminal = attempt.terminal_result ? {
      outcome: attempt.terminal_result,
      reason: checkpoint.reason,
      next_decision: nextDecisionFor(attempt.terminal_result),
    } : null;
    next = {
      ...receipt,
      sequence: receipt.sequence + 1,
      campaign_elapsed_ms: elapsed,
      attempts: [...receipt.attempts, attempt],
      terminal,
    };
  } else if (checkpoint.kind === 'out_of_band') {
    if (!receipt.preflight_complete || receipt.out_of_band_terminal_count !== 0
        || !DIAGNOSTIC_OUTCOMES.has(checkpoint.outcome)
        || !CLOSED_REASONS.has(checkpoint.reason)
        || !OUT_OF_BAND_REASONS.has(checkpoint.reason)
        || !OUTCOME_REASONS[checkpoint.outcome]?.has(checkpoint.reason)) {
      throw new Error('invalid out-of-band terminal checkpoint');
    }
    next = {
      ...receipt,
      sequence: receipt.sequence + 1,
      campaign_elapsed_ms: elapsed,
      terminal: {
        outcome: checkpoint.outcome,
        reason: checkpoint.reason,
        next_decision: nextDecisionFor(checkpoint.outcome),
      },
      out_of_band_terminal_count: 1,
    };
  } else {
    throw new Error('unknown receipt checkpoint');
  }
  validateReceipt(next);
  await writeAtomicJson(filePath, next);
  return next;
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return pathInside(left, right) || pathInside(right, left);
}

export function assertSafeScratchPath(scratchPath, protectedPaths = []) {
  if (typeof scratchPath !== 'string' || !path.isAbsolute(scratchPath)
      || !/^polygram-u24-timeout-[A-Za-z0-9._-]+$/.test(path.basename(scratchPath))) {
    throw new Error('scratch path must name a dedicated U24 timeout directory');
  }
  const normalized = path.resolve(scratchPath);
  const unsafeRoots = [os.homedir(), REPOSITORY_ROOT].map((entry) => path.resolve(entry));
  if (normalized === '/' || unsafeRoots.some((entry) => pathsOverlap(normalized, entry))) {
    throw new Error('scratch path overlaps a protected root');
  }
  for (const protectedPath of protectedPaths) {
    if (typeof protectedPath !== 'string' || !path.isAbsolute(protectedPath)
        || pathsOverlap(normalized, path.resolve(protectedPath))) {
      throw new Error('scratch path overlaps durable evidence');
    }
  }
  return normalized;
}

export async function createOwnedScratch(scratchPath, { protectedPaths = [] } = {}) {
  const normalized = assertSafeScratchPath(scratchPath, protectedPaths);
  await mkdir(normalized, { mode: 0o700 });
  const canonicalPath = await realpath(normalized);
  const info = await lstat(canonicalPath);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('scratch ownership validation failed');
  }
  return Object.freeze({
    canonicalPath,
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
  });
}

async function validateScratchOwnership(ownership, protectedPaths) {
  if (!hasExactKeys(ownership, ['canonicalPath', 'dev', 'ino', 'uid'])) {
    throw new Error('scratch ownership receipt is required');
  }
  const normalized = assertSafeScratchPath(ownership.canonicalPath, protectedPaths);
  const [canonicalPath, info] = await Promise.all([realpath(normalized), lstat(normalized)]);
  if (canonicalPath !== normalized || info.isSymbolicLink() || !info.isDirectory()
      || (info.mode & 0o777) !== 0o700
      || info.dev !== ownership.dev || info.ino !== ownership.ino || info.uid !== ownership.uid
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('scratch identity or ownership changed');
  }
  return canonicalPath;
}

function validatePreflight(evidence, expectedModel) {
  if (!evidence || PREFLIGHT_FIELDS.some((field) => evidence[field] !== true)
      || evidence.claude_version !== EXPECTED_CLAUDE_VERSION
      || !hasExactKeys(evidence.claude_auth, ['loggedIn', 'authMethod', 'apiProvider'])
      || evidence.claude_auth.loggedIn !== true
      || evidence.claude_auth.authMethod !== 'claude.ai'
      || evidence.claude_auth.apiProvider !== 'firstParty'
      || evidence.expected_model !== expectedModel) {
    throw new Error('diagnostic preflight failed');
  }
}

function validateActiveUnit(evidence, properties) {
  if (!evidence || evidence.unit_type !== 'service'
      || evidence.unit_identity_unique !== true
      || evidence.runner_cgroup_member !== true
      || evidence.detached_child_cgroup_member !== true
      || !Number.isSafeInteger(evidence.activated_at_ms)
      || evidence.activated_at_ms < 0
      || JSON.stringify(evidence.properties) !== JSON.stringify(properties)) {
    throw new Error('active transient service verification failed');
  }
}

const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const SYSTEMD_RUN_PATH = '/usr/bin/systemd-run';
const UNIT_SHOW_PROPERTIES = [
  'ActiveState',
  'ControlGroup',
  'KillMode',
  'RuntimeMaxUSec',
  'TimeoutStopUSec',
  'SendSIGKILL',
  'RemainAfterExit',
  'StandardOutput',
  'StandardError',
  'WorkingDirectory',
  'ActiveEnterTimestampMonotonic',
];

function parseKeyValueLines(stdout) {
  if (typeof stdout !== 'string' || stdout.length > 16_384) {
    throw new Error('invalid systemd property output');
  }
  const values = {};
  for (const line of stdout.trim().split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('invalid systemd property output');
    const key = line.slice(0, separator);
    if (Object.hasOwn(values, key)) throw new Error('duplicate systemd property');
    values[key] = line.slice(separator + 1);
  }
  return values;
}

function parseSystemdDuration(value) {
  const match = /^(?:(\d+)h(?: |$))?(?:(\d+)min(?: |$))?(?:(\d+)s)?$/.exec(value);
  if (!match || value.length === 0 || value.endsWith(' ')) {
    throw new Error('invalid systemd duration');
  }
  return ((Number(match[1] || 0) * 3_600) + (Number(match[2] || 0) * 60)
    + Number(match[3] || 0)) * 1_000;
}

function parseActiveUnitEvidence(stdout, expectedProperties) {
  const values = parseKeyValueLines(stdout);
  if (!hasExactKeys(values, UNIT_SHOW_PROPERTIES)
      || values.ActiveState !== 'active'
      || typeof values.ControlGroup !== 'string'
      || !values.ControlGroup.startsWith('/user.slice/')
      || values.KillMode !== expectedProperties.KillMode
      || parseSystemdDuration(values.RuntimeMaxUSec) !== DIAGNOSTIC_LIMITS.runtimeMaxMs
      || parseSystemdDuration(values.TimeoutStopUSec) !== DIAGNOSTIC_LIMITS.stopWindowMs
      || values.SendSIGKILL !== expectedProperties.SendSIGKILL
      || values.RemainAfterExit !== expectedProperties.RemainAfterExit
      || values.StandardOutput !== expectedProperties.StandardOutput
      || values.StandardError !== expectedProperties.StandardError
      || values.WorkingDirectory !== expectedProperties.WorkingDirectory
      || !/^\d+$/.test(values.ActiveEnterTimestampMonotonic)) {
    throw new Error('active transient service verification failed');
  }
  const activatedAtUs = Number(values.ActiveEnterTimestampMonotonic);
  if (!Number.isSafeInteger(activatedAtUs)) {
    throw new Error('invalid unit activation timestamp');
  }
  return {
    controlGroup: values.ControlGroup,
    activatedAtMs: Math.floor(activatedAtUs / 1_000),
  };
}

async function showActiveUnit(unitName, properties, execFileCommand) {
  const { stdout } = await execFileCommand(SYSTEMCTL_PATH, [
    '--user',
    'show',
    unitName,
    ...UNIT_SHOW_PROPERTIES.map((property) => `--property=${property}`),
  ], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384,
  });
  return parseActiveUnitEvidence(stdout, properties);
}

async function waitForActiveUnit(unitName, properties, execFileCommand, delay) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await showActiveUnit(unitName, properties, execFileCommand);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error('transient service did not become verifiably active', { cause: lastError });
}

function safeUnitName() {
  return `polygram-u24-timeout-${randomUUID()}.service`;
}

const COMPLETION_SHOW_PROPERTIES = [
  'ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus',
];
const FINAL_SHOW_PROPERTIES = ['LoadState', 'ActiveState'];

async function showUnitCompletion(unitName, execFileCommand, timeoutMs) {
  const { stdout } = await execFileCommand(SYSTEMCTL_PATH, [
    '--user', 'show', unitName,
    ...COMPLETION_SHOW_PROPERTIES.map((property) => `--property=${property}`),
  ], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4_096 });
  const values = parseKeyValueLines(stdout);
  if (!hasExactKeys(values, COMPLETION_SHOW_PROPERTIES)) {
    throw new Error('invalid transient service completion evidence');
  }
  if (values.ActiveState === 'active' && values.SubState === 'exited'
      && values.Result === 'success' && values.ExecMainCode === '1'
      && values.ExecMainStatus === '0') return true;
  if (values.ActiveState === 'failed'
      || (values.ActiveState === 'inactive' && values.SubState === 'dead')) {
    throw new Error('transient service execution failed');
  }
  return false;
}

async function waitForUnitCompletion({
  unitName, execFileCommand, delay, attempts, intervalMs, deadlineMs, monotonicNowMs,
}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const beforeShow = monotonicNowMs();
    if (!Number.isSafeInteger(beforeShow) || beforeShow < 0 || beforeShow >= deadlineMs) break;
    const showTimeoutMs = Math.max(1, Math.min(2_000, deadlineMs - beforeShow));
    try {
      if (await showUnitCompletion(unitName, execFileCommand, showTimeoutMs)) return;
    } catch (error) {
      lastError = error;
      if (error.message === 'transient service execution failed') throw error;
    }
    const afterShow = monotonicNowMs();
    if (!Number.isSafeInteger(afterShow) || afterShow < beforeShow || afterShow >= deadlineMs) break;
    if (attempt + 1 >= attempts) break;
    await delay(Math.min(intervalMs, deadlineMs - afterShow));
  }
  throw new Error('transient service completion was not confirmed', { cause: lastError });
}

async function showFinalUnitState(unitName, execFileCommand) {
  const { stdout } = await execFileCommand(SYSTEMCTL_PATH, [
    '--user', 'show', unitName,
    ...FINAL_SHOW_PROPERTIES.map((property) => `--property=${property}`),
  ], { encoding: 'utf8', timeout: 1_000, maxBuffer: 1_024 });
  const values = parseKeyValueLines(stdout);
  if (!hasExactKeys(values, FINAL_SHOW_PROPERTIES)) {
    throw new Error('invalid final unit evidence');
  }
  return (values.LoadState === 'not-found' || values.LoadState === 'loaded')
    && values.ActiveState === 'inactive';
}

export function createSystemdUserLauncher({
  execFileCommand = execFileAsync,
  readFileCommand = readFile,
  platform = process.platform,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  monotonicNowMs = monotonicMilliseconds,
  completionPollIntervalMs = 5_000,
  completionPollAttempts = Math.ceil(
    (RUNTIME_MAX_MS + STOP_WINDOW_MS) / completionPollIntervalMs,
  ) + 1,
  finalPollAttempts = 20,
  finalPollIntervalMs = 100,
} = {}) {
  for (const [value, maximum, label] of [
    [completionPollIntervalMs, 60_000, 'completion poll interval'],
    [completionPollAttempts, 20_000, 'completion poll attempts'],
    [finalPollIntervalMs, 1_000, 'final poll interval'],
    [finalPollAttempts, 100, 'final poll attempts'],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new TypeError(`${label} must be a bounded positive integer`);
    }
  }
  if (typeof monotonicNowMs !== 'function') {
    throw new TypeError('monotonic clock is required');
  }
  let unitName;
  let controlGroup;
  let stopAttempted = false;
  return {
    async preflight(request) {
      if (platform !== 'linux' || request?.unit_type !== 'service') {
        throw new Error('Linux systemd user manager is required');
      }
      await execFileCommand(SYSTEMCTL_PATH, ['--user', 'show-environment'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384,
      });
      return { ...request.preflight_evidence, manager_authorized: true };
    },
    async runService(request) {
      if (!Array.isArray(request?.inside_command) || request.inside_command.length < 2
          || request.inside_command.some((value) => typeof value !== 'string' || value.length === 0)) {
        throw new Error('an explicit inside command is required');
      }
      unitName = safeUnitName();
      const { stdout: identityState } = await execFileCommand(SYSTEMCTL_PATH, [
        '--user', 'show', unitName, '--property=LoadState',
      ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1_024 });
      if (parseKeyValueLines(identityState).LoadState !== 'not-found') {
        throw new Error('transient service identity already exists');
      }
      const [command, ...commandArgs] = request.inside_command;
      await execFileCommand(SYSTEMD_RUN_PATH, [
        '--user',
        `--unit=${unitName}`,
        '--collect',
        '--quiet',
        '--property=Type=exec',
        ...Object.entries(request.properties)
          .map(([key, value]) => `--property=${key}=${value}`),
        command,
        ...commandArgs,
        '--unit-name',
        unitName,
      ], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 16_384,
      });
      const active = await waitForActiveUnit(
        unitName,
        request.properties,
        execFileCommand,
        delay,
      );
      controlGroup = active.controlGroup;
      const completionDeadlineMs = active.activatedAtMs + DIAGNOSTIC_LIMITS.outerMaximumMs;
      const observedNowMs = monotonicNowMs();
      if (!Number.isSafeInteger(completionDeadlineMs)
          || !Number.isSafeInteger(observedNowMs)
          || observedNowMs < active.activatedAtMs) {
        throw new Error('systemd activation clock could not be bound');
      }
      await waitForUnitCompletion({
        unitName,
        execFileCommand,
        delay,
        attempts: completionPollAttempts,
        intervalMs: completionPollIntervalMs,
        deadlineMs: completionDeadlineMs,
        monotonicNowMs,
      });
    },
    async stop() {
      if (!unitName) return;
      stopAttempted = true;
      await execFileCommand(SYSTEMCTL_PATH, ['--user', 'stop', unitName], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 1_024,
      });
    },
    async inspectFinal() {
      if (!unitName || !controlGroup || !stopAttempted) {
        return { inactive: false, cgroup_empty: false, detached_child_removed: false };
      }
      let inactive = false;
      for (let attempt = 0; attempt < finalPollAttempts; attempt += 1) {
        try {
          inactive = await showFinalUnitState(unitName, execFileCommand);
        } catch {
          inactive = false;
        }
        if (inactive) break;
        await delay(finalPollIntervalMs);
      }
      if (!inactive) {
        return { inactive: false, cgroup_empty: false, detached_child_removed: false };
      }
      let cgroupEmpty = false;
      try {
        const procs = await readFileCommand(`/sys/fs/cgroup${controlGroup}/cgroup.procs`, 'utf8');
        cgroupEmpty = procs.trim() === '';
      } catch (error) {
        cgroupEmpty = error?.code === 'ENOENT';
      }
      return {
        inactive,
        cgroup_empty: cgroupEmpty,
        detached_child_removed: inactive && cgroupEmpty,
      };
    },
  };
}

function unifiedCgroup(text) {
  if (typeof text !== 'string' || text.length > 16_384) throw new Error('invalid cgroup evidence');
  const rows = text.trim().split('\n').filter(Boolean);
  const match = rows.find((row) => row.startsWith('0::'));
  if (!match || rows.filter((row) => row.startsWith('0::')).length !== 1) {
    throw new Error('unified cgroup evidence is required');
  }
  return match.slice(3);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('detached child exit was not confirmed'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export async function verifyInsideSystemdUnit({
  unitName,
  scratchPath,
  execFileCommand = execFileAsync,
  readFileCommand = readFile,
  spawnCommand = spawn,
  platform = process.platform,
  leaveDetachedChildForUnitStop = false,
  childExitTimeoutMs = 2_000,
}) {
  if (platform !== 'linux'
      || typeof unitName !== 'string'
      || !/^polygram-u24-timeout-[0-9a-f-]+\.service$/.test(unitName)
      || !Number.isInteger(childExitTimeoutMs)
      || childExitTimeoutMs < 1
      || childExitTimeoutMs > 10_000) {
    throw new Error('verified Linux transient unit identity is required');
  }
  const properties = transientServiceProperties(scratchPath);
  const active = await showActiveUnit(unitName, properties, execFileCommand);
  const ownCgroup = unifiedCgroup(await readFileCommand('/proc/self/cgroup', 'utf8'));
  if (ownCgroup !== active.controlGroup) throw new Error('runner cgroup membership mismatch');
  const child = spawnCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  let childMatches = false;
  try {
    if (!Number.isInteger(child.pid) || child.pid <= 1) throw new Error('detached child did not start');
    const childCgroup = unifiedCgroup(
      await readFileCommand(`/proc/${child.pid}/cgroup`, 'utf8'),
    );
    childMatches = childCgroup === active.controlGroup;
  } finally {
    if (!leaveDetachedChildForUnitStop || !childMatches) {
      try { child.kill('SIGKILL'); } catch { /* unit cleanup remains authoritative */ }
      await waitForChildExit(child, childExitTimeoutMs);
    }
  }
  if (!childMatches) throw new Error('detached child cgroup membership mismatch');
  if (leaveDetachedChildForUnitStop) child.unref();
  return {
    unit_type: 'service',
    unit_identity_unique: true,
    properties,
    runner_cgroup_member: true,
    detached_child_cgroup_member: true,
    activated_at_ms: active.activatedAtMs,
  };
}

const BUSY_BOTS = Object.freeze(['shumabit', 'umi-assistant']);
const POLYGRAM_IPC_PATH = '/usr/bin/polygram-ipc';
const POLYGRAM_IPC_DIRECTORY = '/home/shumabit/polygram/.ipc';

export async function checkProductionBusy({ execFileCommand = execFileAsync } = {}) {
  let total = 0;
  for (const bot of BUSY_BOTS) {
    const { stdout, stderr } = await execFileCommand(POLYGRAM_IPC_PATH, [bot, 'busy'], {
      env: {
        ...subscriptionOnlyEnv(),
        POLYGRAM_IPC_DIR: POLYGRAM_IPC_DIRECTORY,
      },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4_096,
    });
    if (stderr !== undefined && stderr !== '') throw new Error('busy check emitted stderr');
    let result;
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error('busy check returned malformed evidence');
    }
    if (!hasExactKeys(result, ['bot', 'in_flight'])
        || result.bot !== bot
        || !Number.isSafeInteger(result.in_flight)
        || result.in_flight < 0) {
      throw new Error('busy check returned invalid evidence');
    }
    total += result.in_flight;
    if (!Number.isSafeInteger(total)) throw new Error('busy count overflow');
  }
  return total !== 0;
}

async function assertExistingPrivateScratch(scratchPath) {
  const normalized = assertSafeScratchPath(scratchPath);
  const [canonicalPath, info] = await Promise.all([realpath(normalized), lstat(normalized)]);
  if (canonicalPath !== normalized || !info.isDirectory() || info.isSymbolicLink()
      || (info.mode & 0o777) !== 0o700
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('scratch privacy mismatch');
  }
  return canonicalPath;
}

async function buildOperationalPreflight({ claudeBin, expectedModel, scratchPath }) {
  const runtime = await attestClaudeRuntime(claudeBin);
  await verifyClaudeRuntimeUnchanged(runtime);
  const claudeAuth = await inspectClaudeAuth(runtime.canonicalPath);
  await assertExistingPrivateScratch(scratchPath);
  return {
    runtime,
    evidence: {
      manager_authorized: true,
      runtime_attested: true,
      authentication_attested: true,
      model_exact: true,
      prompt_manifest_exact: true,
      schema_manifest_exact: true,
      tools_prohibited: true,
      environment_allowlist_exact: true,
      security_flags_exact: true,
      paths_private: true,
      claude_version: runtime.version,
      claude_auth: claudeAuth,
      expected_model: expectedModel,
    },
  };
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function campaignElapsed(activatedAtMs) {
  const elapsed = monotonicMilliseconds() - activatedAtMs;
  return assertBoundedInteger(elapsed, DIAGNOSTIC_LIMITS.outerMaximumMs, 'campaign elapsed time');
}

export async function runInsideSystemdDiagnostic({
  unitName,
  claudeBin,
  expectedModel,
  scratchPath,
  receiptPath,
  unitWitnessPath,
  verifyUnit = verifyInsideSystemdUnit,
  checkBusy = checkProductionBusy,
  buildPreflight = buildOperationalPreflight,
  runCampaign = runLiveDiagnosticCampaign,
}) {
  for (const candidate of [scratchPath, receiptPath, unitWitnessPath, claudeBin]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new TypeError('inside diagnostic paths must be absolute');
    }
  }
  if (pathInside(scratchPath, receiptPath) || pathInside(scratchPath, unitWitnessPath)) {
    throw new Error('evidence paths must be outside scratch');
  }
  await assertPrivateParent(receiptPath);
  await assertPrivateParent(unitWitnessPath);
  let receipt = await createDiagnosticReceipt(receiptPath);
  const active = await verifyUnit({ unitName, scratchPath });
  validateActiveUnit(active, transientServiceProperties(scratchPath));
  const preflight = await buildPreflight({ claudeBin, expectedModel, scratchPath });
  validatePreflight(preflight.evidence, expectedModel);
  receipt = await checkpointDiagnosticReceipt(receiptPath, receipt, {
    kind: 'preflight',
    campaign_elapsed_ms: campaignElapsed(active.activated_at_ms),
  });
  return runCampaign({
    claudeBin: preflight.runtime.canonicalPath,
    expectedModel,
    scratchPath,
    activatedAtMs: active.activated_at_ms,
    monotonicNowMs: monotonicMilliseconds,
    checkBusy,
    checkpointAttempt: async (attempt, decision) => {
      receipt = await checkpointDiagnosticReceipt(receiptPath, receipt, {
        kind: 'attempt',
        campaign_elapsed_ms: campaignElapsed(active.activated_at_ms),
        attempt,
        reason: decision.reason,
      });
    },
    checkpointOutOfBand: async (decision) => {
      receipt = await checkpointDiagnosticReceipt(receiptPath, receipt, {
        kind: 'out_of_band',
        campaign_elapsed_ms: campaignElapsed(active.activated_at_ms),
        outcome: decision.outcome,
        reason: decision.reason,
      });
    },
  });
}

function insideCommand({
  claudeBin, expectedModel, scratchPath, receiptPath, unitWitnessPath,
}) {
  return [
    process.execPath,
    MODULE_PATH,
    'inside',
    '--claude-bin', claudeBin,
    '--expected-model', expectedModel,
    '--scratch', scratchPath,
    '--receipt', receiptPath,
    '--unit-witness', unitWitnessPath,
  ];
}

export async function runSystemdDiagnostic({
  claudeBin,
  expectedModel,
  scratchPath,
  receiptPath,
  unitWitnessPath,
  destinationDirectory,
  launcher = createSystemdUserLauncher(),
}) {
  for (const candidate of [
    claudeBin, scratchPath, receiptPath, unitWitnessPath, destinationDirectory,
  ]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new TypeError('operational diagnostic paths must be absolute');
    }
  }
  await assertPrivateParent(receiptPath);
  await assertPrivateParent(unitWitnessPath);
  await Promise.all([
    assertPathAbsent(receiptPath),
    assertPathAbsent(unitWitnessPath),
    assertPathAbsent(path.join(destinationDirectory, 'receipt.json')),
    assertPathAbsent(path.join(destinationDirectory, 'unit-witness.json')),
  ]);
  const destinationInfo = await stat(destinationDirectory);
  if (!destinationInfo.isDirectory() || (destinationInfo.mode & 0o777) !== 0o700
      || (typeof process.getuid === 'function' && destinationInfo.uid !== process.getuid())) {
    throw new Error('destination directory must be owner-only');
  }
  const scratchOwnership = await createOwnedScratch(scratchPath, {
    protectedPaths: [receiptPath, unitWitnessPath, destinationDirectory],
  });
  const ownedScratchPath = scratchOwnership.canonicalPath;
  const preflight = await buildOperationalPreflight({
    claudeBin, expectedModel, scratchPath: ownedScratchPath,
  });
  const result = await runWithUnitLauncher({
    launcher,
    scratchPath: ownedScratchPath,
    receiptPath,
    unitWitnessPath,
    expectedModel,
    preflightEvidence: preflight.evidence,
    insideCommand: insideCommand({
      claudeBin: preflight.runtime.canonicalPath,
      expectedModel,
      scratchPath: ownedScratchPath,
      receiptPath,
      unitWitnessPath,
    }),
    runInside: async () => {
      throw new Error('real systemd launcher must execute the inside command in the unit');
    },
    beforeInterpret: () => verifyClaudeRuntimeUnchanged(preflight.runtime),
  });
  let hashes;
  try {
    hashes = await validateCopyAndHashEvidence({
      receiptPath,
      unitWitnessPath,
      destinationDirectory,
    });
  } catch {
    return {
      outcome: 'diagnostic-failure',
      reason: 'checkpoint-unconfirmed',
      next_decision: nextDecisionFor('diagnostic-failure'),
      cleanup_confirmed: false,
      hashes: null,
      scratch_cleanup_confirmed: false,
    };
  }
  if (result.cleanup_confirmed === true) {
    await cleanupScratchAfterEvidence({ scratchOwnership, receiptPath, unitWitnessPath });
  }
  return {
    ...result,
    hashes,
    scratch_cleanup_confirmed: result.cleanup_confirmed === true,
  };
}

export async function runSystemdCapabilityCheck({
  scratchPath,
  launcher = createSystemdUserLauncher(),
}) {
  const scratchOwnership = await createOwnedScratch(scratchPath);
  const ownedScratchPath = scratchOwnership.canonicalPath;
  const properties = transientServiceProperties(ownedScratchPath);
  const request = {
    unit_type: 'service',
    properties,
    scratch_path: ownedScratchPath,
    inside_command: [
      process.execPath, MODULE_PATH, 'capability-inside', '--scratch', ownedScratchPath,
    ],
  };
  await launcher.preflight(request);
  let runError;
  try {
    await launcher.runService(request, async () => {
      throw new Error('real systemd launcher must execute the capability command in the unit');
    });
  } catch (error) {
    runError = error;
  }
  let stopError;
  try {
    await launcher.stop(request);
  } catch (error) {
    stopError = error;
  }
  const final = await launcher.inspectFinal(request);
  const passed = final.inactive === true
    && final.cgroup_empty === true
    && final.detached_child_removed === true;
  const ownedPath = await validateScratchOwnership(scratchOwnership, []);
  await rm(ownedPath, { recursive: true, force: false });
  if (!passed) throw new Error('systemd capability cleanup was not confirmed');
  if (runError || stopError) throw new Error('systemd capability execution was not confirmed', {
    cause: runError || stopError,
  });
  return {
    transient_service: true,
    exact_properties: true,
    runner_cgroup_member: true,
    detached_child_cgroup_member: true,
    inactive: true,
    cgroup_empty: true,
  };
}

export function interpretDiagnosticArtifacts(receipt, unitWitness) {
  validateReceipt(receipt);
  validateUnitWitness(unitWitness);
  const cleanupConfirmed = unitWitness.cleanup_confirmed;
  const slowObserved = receipt.attempts.some((attempt) => attempt.slow_valid === true);
  if (!cleanupConfirmed) {
    return {
      outcome: 'diagnostic-failure',
      reason: 'cleanup-unconfirmed',
      next_decision: nextDecisionFor('diagnostic-failure'),
      slow_valid_observed: slowObserved,
      cleanup_confirmed: false,
    };
  }
  if (!receipt.terminal) {
    return {
      outcome: 'diagnostic-failure',
      reason: 'runner-nonterminal',
      next_decision: nextDecisionFor('diagnostic-failure'),
      slow_valid_observed: slowObserved,
      cleanup_confirmed: true,
    };
  }
  return {
    ...receipt.terminal,
    slow_valid_observed: slowObserved,
    cleanup_confirmed: true,
  };
}

export async function runWithUnitLauncher({
  launcher,
  scratchPath,
  receiptPath,
  unitWitnessPath,
  expectedModel,
  preflightEvidence,
  runInside,
  insideCommand,
  confirmReceiptDurability = confirmDiagnosticReceiptDurability,
  writeUnitWitness = (witness) => createUnitWitness(unitWitnessPath, witness),
  readArtifacts = () => readDiagnosticArtifacts(receiptPath, unitWitnessPath),
  beforeInterpret = async () => {},
}) {
  if (!launcher || typeof launcher.preflight !== 'function'
      || typeof launcher.runService !== 'function'
      || typeof launcher.stop !== 'function'
      || typeof launcher.inspectFinal !== 'function'
      || typeof runInside !== 'function'
      || typeof confirmReceiptDurability !== 'function'
      || typeof readArtifacts !== 'function'
      || typeof beforeInterpret !== 'function') {
    throw new TypeError('unit launcher seams are required');
  }
  for (const candidate of [scratchPath, receiptPath, unitWitnessPath]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new TypeError('launcher paths must be absolute');
    }
  }
  if (pathInside(scratchPath, receiptPath) || pathInside(scratchPath, unitWitnessPath)) {
    throw new Error('evidence paths must be outside scratch');
  }
  const properties = transientServiceProperties(scratchPath);
  if (typeof expectedModel !== 'string' || !/^claude-haiku-[a-z0-9-]+$/.test(expectedModel)) {
    throw new TypeError('expected model must be an exact Haiku identity');
  }
  const request = {
    unit_type: 'service',
    properties,
    scratch_path: scratchPath,
    receipt_path: receiptPath,
    unit_witness_path: unitWitnessPath,
    expected_model: expectedModel,
    ...(preflightEvidence ? { preflight_evidence: preflightEvidence } : {}),
    ...(insideCommand ? { inside_command: insideCommand } : {}),
  };
  validatePreflight(await launcher.preflight(request), expectedModel);
  let runError;
  try {
    await launcher.runService(request, async (activeEvidence) => {
      validateActiveUnit(activeEvidence, properties);
      return runInside({ activatedAtMs: activeEvidence.activated_at_ms });
    });
  } catch (error) {
    runError = error;
  }
  let stopError;
  try {
    await launcher.stop(request);
  } catch (error) {
    stopError = error;
  }
  let finalEvidence;
  try {
    finalEvidence = await launcher.inspectFinal(request);
  } catch {
    finalEvidence = {};
  }
  const witness = {
    inactive: finalEvidence?.inactive === true,
    cgroup_empty: finalEvidence?.cgroup_empty === true,
    detached_child_removed: finalEvidence?.detached_child_removed === true,
    receipt_checkpoint_confirmed: await confirmReceiptDurability(receiptPath).catch(() => false),
  };
  try {
    await writeUnitWitness(witness);
  } catch {
    return {
      outcome: 'diagnostic-failure',
      reason: 'checkpoint-unconfirmed',
      next_decision: nextDecisionFor('diagnostic-failure'),
      cleanup_confirmed: false,
    };
  }
  try {
    await beforeInterpret();
  } catch {
    const cleanupConfirmed = witness.inactive && witness.cgroup_empty
      && witness.detached_child_removed && witness.receipt_checkpoint_confirmed;
    return {
      outcome: 'diagnostic-failure',
      reason: cleanupConfirmed ? 'integrity-failure' : 'cleanup-unconfirmed',
      next_decision: nextDecisionFor('diagnostic-failure'),
      cleanup_confirmed: cleanupConfirmed,
    };
  }
  let artifacts;
  try {
    artifacts = await readArtifacts();
  } catch {
    return {
      outcome: 'diagnostic-failure',
      reason: 'checkpoint-unconfirmed',
      next_decision: nextDecisionFor('diagnostic-failure'),
      cleanup_confirmed: false,
    };
  }
  if (artifacts.unitWitness.cleanup_confirmed !== true) {
    return {
      outcome: 'diagnostic-failure',
      reason: 'cleanup-unconfirmed',
      next_decision: nextDecisionFor('diagnostic-failure'),
      slow_valid_observed: artifacts.receipt.attempts
        .some((attempt) => attempt.slow_valid === true),
      cleanup_confirmed: false,
    };
  }
  if (runError || stopError) {
    return {
      outcome: 'diagnostic-failure',
      reason: 'runner-nonterminal',
      next_decision: nextDecisionFor('diagnostic-failure'),
      slow_valid_observed: artifacts.receipt.attempts
        .some((attempt) => attempt.slow_valid === true),
      cleanup_confirmed: artifacts.unitWitness.cleanup_confirmed,
    };
  }
  return interpretDiagnosticArtifacts(artifacts.receipt, artifacts.unitWitness);
}

const UNIT_WITNESS_SCHEMA = 'polygram-memory-routing-timeout-unit-witness/v1';

function validateUnitWitness(witness) {
  if (!witness || witness.schema_version !== UNIT_WITNESS_SCHEMA
      || !hasExactKeys(witness, [
        'schema_version',
        'inactive',
        'cgroup_empty',
        'detached_child_removed',
        'receipt_checkpoint_confirmed',
        'cleanup_confirmed',
      ])
      || typeof witness.inactive !== 'boolean'
      || typeof witness.cgroup_empty !== 'boolean'
      || typeof witness.detached_child_removed !== 'boolean'
      || typeof witness.receipt_checkpoint_confirmed !== 'boolean'
      || witness.cleanup_confirmed !== (
        witness.inactive && witness.cgroup_empty && witness.detached_child_removed
          && witness.receipt_checkpoint_confirmed
      )) {
    throw new Error('invalid unit witness');
  }
  return witness;
}

export async function createUnitWitness(filePath, evidence = {}) {
  const witness = {
    schema_version: UNIT_WITNESS_SCHEMA,
    inactive: evidence.inactive === true,
    cgroup_empty: evidence.cgroup_empty === true,
    detached_child_removed: evidence.detached_child_removed === true,
    receipt_checkpoint_confirmed: evidence.receipt_checkpoint_confirmed === true,
    cleanup_confirmed: evidence.inactive === true
      && evidence.cgroup_empty === true
      && evidence.detached_child_removed === true
      && evidence.receipt_checkpoint_confirmed === true,
  };
  validateUnitWitness(witness);
  await writeExclusiveJson(filePath, witness);
  await fsyncDirectory(path.dirname(filePath));
  return witness;
}

async function readPrivateArtifact(filePath) {
  const info = await stat(filePath);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('artifact privacy mismatch');
  }
  return readFile(filePath);
}

export async function confirmDiagnosticReceiptDurability(filePath) {
  const bytes = await readPrivateArtifact(filePath);
  validateReceipt(JSON.parse(bytes.toString('utf8')));
  const handle = await open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(filePath));
  const confirmed = await readPrivateArtifact(filePath);
  if (!confirmed.equals(bytes)) throw new Error('receipt changed during durability confirmation');
  return true;
}

export async function readDiagnosticArtifacts(receiptPath, unitWitnessPath) {
  const [receiptBytes, witnessBytes] = await Promise.all([
    readPrivateArtifact(receiptPath),
    readPrivateArtifact(unitWitnessPath),
  ]);
  return {
    receipt: validateReceipt(JSON.parse(receiptBytes.toString('utf8'))),
    unitWitness: validateUnitWitness(JSON.parse(witnessBytes.toString('utf8'))),
  };
}

async function writeExclusiveBytes(filePath, bytes) {
  await assertPrivateParent(filePath);
  let handle;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (cause) {
    throw new Error('exclusive evidence copy failed', { cause });
  } finally {
    await handle?.close();
  }
  await fsyncDirectory(path.dirname(filePath));
}

export async function validateCopyAndHashEvidence({
  receiptPath,
  unitWitnessPath,
  destinationDirectory,
}) {
  const [receiptBytes, witnessBytes] = await Promise.all([
    readPrivateArtifact(receiptPath),
    readPrivateArtifact(unitWitnessPath),
  ]);
  validateReceipt(JSON.parse(receiptBytes.toString('utf8')));
  validateUnitWitness(JSON.parse(witnessBytes.toString('utf8')));
  const receiptCopy = path.join(destinationDirectory, 'receipt.json');
  const witnessCopy = path.join(destinationDirectory, 'unit-witness.json');
  await writeExclusiveBytes(receiptCopy, receiptBytes);
  try {
    await writeExclusiveBytes(witnessCopy, witnessBytes);
  } catch (error) {
    await unlink(receiptCopy).catch(() => {});
    throw error;
  }
  return {
    receipt_sha256: createHash('sha256').update(receiptBytes).digest('hex'),
    unit_witness_sha256: createHash('sha256').update(witnessBytes).digest('hex'),
  };
}

export async function cleanupScratchAfterEvidence({
  scratchOwnership,
  receiptPath,
  unitWitnessPath,
}) {
  for (const candidate of [receiptPath, unitWitnessPath]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new TypeError('cleanup paths must be absolute');
    }
  }
  let scratchPath = await validateScratchOwnership(
    scratchOwnership,
    [receiptPath, unitWitnessPath],
  );
  const [receiptBytes, witnessBytes] = await Promise.all([
    readPrivateArtifact(receiptPath),
    readPrivateArtifact(unitWitnessPath),
  ]);
  validateReceipt(JSON.parse(receiptBytes.toString('utf8')));
  validateUnitWitness(JSON.parse(witnessBytes.toString('utf8')));
  scratchPath = await validateScratchOwnership(
    scratchOwnership,
    [receiptPath, unitWitnessPath],
  );
  await rm(scratchPath, { recursive: true, force: false });
}

const MODE_FLAGS = Object.freeze({
  launch: [
    '--claude-bin', '--expected-model', '--scratch', '--receipt', '--unit-witness',
    '--destination',
  ],
  inside: [
    '--claude-bin', '--expected-model', '--scratch', '--receipt', '--unit-witness',
    '--unit-name',
  ],
  capability: ['--scratch'],
  'capability-inside': ['--scratch', '--unit-name'],
});

export function parseDiagnosticArgs(argv) {
  const [mode, ...tokens] = argv;
  const allowed = MODE_FLAGS[mode];
  if (!allowed) throw new TypeError('mode must be launch, inside, capability, or capability-inside');
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith('--') || Object.hasOwn(values, flag)) {
      throw new TypeError('invalid diagnostic argument');
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== allowed.length
      || allowed.some((flag) => !Object.hasOwn(values, flag))) {
    throw new TypeError('missing diagnostic argument');
  }
  for (const [flag, value] of Object.entries(values)) {
    if (!['--expected-model', '--unit-name'].includes(flag) && !path.isAbsolute(value)) {
      throw new TypeError('diagnostic paths must be absolute');
    }
  }
  if (values['--expected-model']
      && !/^claude-haiku-[a-z0-9-]+$/.test(values['--expected-model'])) {
    throw new TypeError('expected model must be an exact Haiku identity');
  }
  return {
    mode,
    ...(values['--claude-bin'] ? { claudeBin: values['--claude-bin'] } : {}),
    ...(values['--expected-model'] ? { expectedModel: values['--expected-model'] } : {}),
    scratchPath: values['--scratch'],
    ...(values['--receipt'] ? { receiptPath: values['--receipt'] } : {}),
    ...(values['--unit-witness'] ? { unitWitnessPath: values['--unit-witness'] } : {}),
    ...(values['--destination'] ? { destinationDirectory: values['--destination'] } : {}),
    ...(values['--unit-name'] ? { unitName: values['--unit-name'] } : {}),
  };
}

async function main() {
  let args;
  try {
    args = parseDiagnosticArgs(process.argv.slice(2));
    if (args.mode === 'launch') {
      const result = await runSystemdDiagnostic(args);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (args.mode === 'inside') {
      await runInsideSystemdDiagnostic(args);
    } else if (args.mode === 'capability') {
      const result = await runSystemdCapabilityCheck(args);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      await verifyInsideSystemdUnit({
        unitName: args.unitName,
        scratchPath: args.scratchPath,
        leaveDetachedChildForUnitStop: true,
      });
    }
  } catch {
    process.stderr.write('diagnostic command failed\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  await main();
}

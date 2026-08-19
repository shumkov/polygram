#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  createClaudeAdapter,
  inspectClaudeAuth,
  inspectCodexAuth,
  subscriptionOnlyEnv,
} from './adapters.mjs';
import { loadRoutingFixtures, fixtureManifestHash } from './fixtures.mjs';
import {
  runFaultEvaluation,
  runRoutingEvaluation,
  sanitizeProcessDiagnostics,
} from './harness.mjs';
import { attestClaudeRuntime } from './runtime-attestation.mjs';

const require = createRequire(import.meta.url);
const { resolvePinnedCodexBinary } = require('../../../lib/codex/binary.js');
const execFileAsync = promisify(execFile);
const CLAUDE_MODEL = 'haiku';
const OBSERVED_HAIKU_RE = /^claude-haiku-[a-z0-9-]+$/;
const ALLOWED_FAILURE_CODES = new Set([
  'ROUTER_AUTH_AMBIGUOUS',
  'ROUTER_AUTH_UNAVAILABLE',
  'ROUTER_CLAUDE_RUNTIME_MISMATCH',
  'ROUTER_CODEX_RUNTIME_MISMATCH',
  'ROUTER_GATE_FAILURE',
  'ROUTER_MODEL_IDENTITY',
  'ROUTER_OUTPUT_MALFORMED',
  'ROUTER_OUTPUT_MISSING',
  'ROUTER_OUTPUT_SCHEMA',
  'ROUTER_OUTPUT_TOO_LARGE',
  'ROUTER_PROCESS_EXIT',
  'ROUTER_STDERR_TOO_LARGE',
  'ROUTER_TIMEOUT',
]);
const SHAPE_FAMILIES = new Set([
  'work', 'personal', 'mixed', 'uncertain_work', 'known_secret', 'prose_secret',
]);
const MODE_CONFIG = Object.freeze({
  shape: Object.freeze({ fullCorpus: false, repetitions: 1, recoveredRetryLimit: 0 }),
  full: Object.freeze({ fullCorpus: true, repetitions: 5, recoveredRetryLimit: 1 }),
});

function modeConfig(mode) {
  if (!Object.hasOwn(MODE_CONFIG, mode)) throw new TypeError('--mode must be shape or full');
  return MODE_CONFIG[mode];
}

function usage() {
  return [
    'Usage:',
    '  node scripts/spikes/memory-routing-gate/run.mjs \\',
    '    --codex-bin /absolute/pinned/codex --claude-bin /absolute/pinned/claude \\',
    '    --output /absolute/new/receipt.json --mode shape|full \\',
    '    [--expected-model claude-haiku-exact-id-from-shape]',
  ].join('\n');
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--codex-bin', '--claude-bin', '--output', '--mode', '--expected-model'].includes(flag)) {
      throw new TypeError(`unknown argument: ${flag}`);
    }
    const value = argv[index += 1];
    if (!value || value.startsWith('--')) throw new TypeError(`missing value for ${flag}`);
    values[flag.slice(2)] = value;
  }
  for (const key of ['codex-bin', 'claude-bin', 'output', 'mode']) {
    if (!values[key]) throw new TypeError(`missing --${key}`);
  }
  modeConfig(values.mode);
  if (values.mode === 'full' && !values['expected-model']) {
    throw new TypeError('--expected-model from the shape receipt is required for full mode');
  }
  if (values['expected-model'] && !OBSERVED_HAIKU_RE.test(values['expected-model'])) {
    throw new TypeError('--expected-model must be an exact observed Haiku model id');
  }
  for (const key of ['codex-bin', 'claude-bin', 'output']) {
    if (!path.isAbsolute(values[key])) throw new TypeError(`--${key} must be absolute`);
  }
  return {
    codexBin: values['codex-bin'],
    claudeBin: values['claude-bin'],
    output: values.output,
    mode: values.mode,
    ...(values['expected-model'] ? { expectedModel: values['expected-model'] } : {}),
  };
}

function shapeFixtures(fixtures) {
  const selected = [];
  for (const family of SHAPE_FAMILIES) {
    const fixture = fixtures.find((row) => row.family === family);
    if (!fixture) throw new Error(`missing shape fixture family: ${family}`);
    selected.push(fixture);
  }
  return selected;
}

function failureCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('CODEX_BINARY_')) {
    return 'ROUTER_CODEX_RUNTIME_MISMATCH';
  }
  if (ALLOWED_FAILURE_CODES.has(error?.code)) return error.code;
  if (ALLOWED_FAILURE_CODES.has(error?.message)) return error.message;
  return 'ROUTER_GATE_FAILURE';
}

export function buildStopReceipt(error) {
  const diagnostics = sanitizeProcessDiagnostics(error?.diagnostics);
  return {
    schemaVersion: 'polygram-memory-routing-gate/v1',
    generatedAt: new Date().toISOString(),
    gate: 'STOP',
    failure: {
      code: failureCode(error),
      ...diagnostics,
    },
  };
}

export function evaluateRetryBudget(mode, routing) {
  const { recoveredRetryLimit: limit } = modeConfig(mode);
  const recoveredRetryCount = routing.adapters.reduce((sum, adapter) => (
    sum + adapter.recoveredRetryCount
  ), 0);
  const exhaustedRetryCount = routing.adapters.reduce((sum, adapter) => (
    sum + adapter.exhaustedRetryCount
  ), 0);
  return {
    limit,
    recoveredRetryCount,
    exhaustedRetryCount,
    passed: exhaustedRetryCount === 0 && recoveredRetryCount <= limit,
  };
}

async function attestCodex(binary) {
  try {
    return await resolvePinnedCodexBinary({ binaryPath: binary });
  } catch (cause) {
    throw Object.assign(new Error('ROUTER_CODEX_RUNTIME_MISMATCH'), {
      code: cause?.code || 'ROUTER_CODEX_RUNTIME_MISMATCH',
    });
  }
}

async function attestClaude(binary) {
  try {
    return await attestClaudeRuntime(binary);
  } catch {
    throw Object.assign(new Error('ROUTER_CLAUDE_RUNTIME_MISMATCH'), {
      code: 'ROUTER_CLAUDE_RUNTIME_MISMATCH',
    });
  }
}

export async function runGate({ codexBin, claudeBin, mode, expectedModel }) {
  const config = modeConfig(mode);
  const [codexRuntime, claudeRuntime] = await Promise.all([
    attestCodex(codexBin),
    attestClaude(claudeBin),
  ]);
  const [codexAuth, claudeAuth] = await Promise.all([
    inspectCodexAuth(codexRuntime.path),
    inspectClaudeAuth(claudeRuntime.canonicalPath),
  ]);
  const allFixtures = loadRoutingFixtures();
  const fixtures = config.fullCorpus ? allFixtures : shapeFixtures(allFixtures);
  const { repetitions } = config;
  const adapter = createClaudeAdapter({
    binary: claudeRuntime.canonicalPath,
    model: CLAUDE_MODEL,
    expectedObservedModel: expectedModel,
  });
  const routing = await runRoutingEvaluation({ fixtures, adapters: [adapter], repetitions });
  const retryBudget = evaluateRetryBudget(mode, routing);
  const faultFixture = allFixtures.find((fixture) => fixture.family === 'work');
  const faults = await runFaultEvaluation({
    adapterIds: [adapter.id],
    fixture: faultFixture,
    repetitions: 5,
  });
  return {
    schemaVersion: 'polygram-memory-routing-gate/v1',
    generatedAt: new Date().toISOString(),
    mode,
    contractVersion: routing.contractVersion,
    corpus: {
      fullFixtureCount: allFixtures.length,
      fullFixtureManifestHash: fixtureManifestHash(allFixtures),
      evaluatedFixtureCount: fixtures.length,
      repetitions,
    },
    authentication: {
      commercialCredentialEnvironmentForwarded: false,
      claude: claudeAuth,
      codex: codexAuth,
    },
    runtimes: {
      claude: {
        canonicalPath: claudeRuntime.canonicalPath,
        sha256: claudeRuntime.sha256,
        version: claudeRuntime.version,
        requestedModel: CLAUDE_MODEL,
      },
      codex: {
        canonicalPath: codexRuntime.path,
        target: codexRuntime.target,
        sha256: codexRuntime.sha256,
        version: codexRuntime.version,
      },
    },
    routerDecision: {
      selected: adapter.id,
      codexCandidate: 'rejected-no-preventive-tool-disable',
    },
    boundaries: {
      stdinFactsOnly: true,
      schemaBoundOutput: true,
      claudeToolsDisabled: true,
      mcpDisabled: true,
      providerCustomizationsDisabled: true,
    },
    routing,
    retryBudget,
    faults,
    gate: routing.passed && retryBudget.passed && faults.passed ? 'CONTINUE' : 'STOP',
  };
}

async function writeReceipt(output, receipt) {
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  let receipt;
  try {
    receipt = await runGate(args);
  } catch (error) {
    receipt = buildStopReceipt(error);
  }
  try {
    await writeReceipt(args.output, receipt);
    process.stdout.write(`${receipt.gate}: ${args.output}\n`);
  } catch {
    process.stderr.write('STOP: ROUTER_RECEIPT_WRITE\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = receipt.gate === 'CONTINUE' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

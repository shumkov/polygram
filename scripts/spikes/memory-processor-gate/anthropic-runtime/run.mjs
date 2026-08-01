#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { evaluateProcessorRun } from '../harness.mjs';
import { loadFixtureCorpus } from '../fixtures.mjs';
import { runThreeGatePasses } from '../multi-run.mjs';
import {
  LOCKED_FIXTURE_COUNT,
  REQUIRED_RUNS,
  AnthropicRuntimeError,
  buildDurableEvidence,
  createDirectProcessor,
  persistEvidence,
} from './runtime.mjs';

export function parseArguments(argv) {
  const options = {
    approvedSyntheticEgress: false,
    outputPath: null,
    retentionMode: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--approve-synthetic-egress') {
      options.approvedSyntheticEgress = true;
    } else if (argument === '--output') {
      options.outputPath = argv[index + 1] || null;
      index += 1;
    } else if (argument === '--retention-mode') {
      options.retentionMode = argv[index + 1] || null;
      index += 1;
    } else {
      throw new AnthropicRuntimeError('ANTHROPIC_ARGUMENT_INVALID');
    }
  }
  if (!options.approvedSyntheticEgress) {
    throw new AnthropicRuntimeError('ANTHROPIC_SYNTHETIC_EGRESS_NOT_APPROVED');
  }
  if (!options.outputPath) throw new AnthropicRuntimeError('ANTHROPIC_EVIDENCE_PATH_REQUIRED');
  if (!['standard', 'zdr-verified'].includes(options.retentionMode)) {
    throw new AnthropicRuntimeError('ANTHROPIC_RETENTION_MODE_REQUIRED');
  }
  return options;
}

function shapeCheckFixture(corpus) {
  const fixture = corpus.development.find((candidate) => (
    candidate.adversarial?.type === 'secret' && candidate.claims.length === 0
  ));
  if (!fixture) throw new AnthropicRuntimeError('ANTHROPIC_SHAPE_FIXTURE_MISSING');
  return fixture;
}

export async function runAnthropicGate({ argv, env, fetchImpl, sleepImpl } = {}) {
  const options = parseArguments(argv || []);
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new AnthropicRuntimeError('ANTHROPIC_API_KEY_MISSING');
  }

  const corpus = loadFixtureCorpus();
  if (corpus.gate.length !== LOCKED_FIXTURE_COUNT) {
    throw new AnthropicRuntimeError('ANTHROPIC_LOCKED_CORPUS_INVALID');
  }
  const processor = createDirectProcessor({ apiKey, fetchImpl, sleepImpl });
  const shapeCheck = await evaluateProcessorRun({
    fixtures: [shapeCheckFixture(corpus)],
    processor,
    runId: 'anthropic-shape-check',
  });
  const shapeResult = [...shapeCheck.results.values()][0];
  if (shapeResult?.status !== 'ok' || shapeCheck.safety.rawSecretHits !== 0) {
    throw new AnthropicRuntimeError('ANTHROPIC_SHAPE_CHECK_FAILED');
  }

  const { runs } = await runThreeGatePasses({
    fixtures: corpus.gate,
    createProcessor: () => processor,
    runIdPrefix: 'anthropic-g3',
  });
  if (runs.length !== REQUIRED_RUNS) {
    throw new AnthropicRuntimeError('ANTHROPIC_REQUIRED_RUNS_INCOMPLETE');
  }
  const evidence = buildDurableEvidence({
    shapeCheck,
    runs,
    retentionMode: options.retentionMode,
    approvedSyntheticEgress: options.approvedSyntheticEgress,
  });
  await persistEvidence(options.outputPath, evidence);
  return {
    passed: evidence.passed,
    outputPath: options.outputPath,
    worstRunId: evidence.execution.worstRunId,
  };
}

async function main() {
  try {
    const result = await runAnthropicGate({ argv: process.argv.slice(2), env: process.env });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof AnthropicRuntimeError ? error.code : 'ANTHROPIC_GATE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

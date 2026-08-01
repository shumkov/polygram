#!/usr/bin/env node

import { evaluateProcessorRun } from './harness.mjs';
import { loadFixtureCorpus } from './fixtures.mjs';

function oracleCandidate(claim) {
  return {
    fact: claim.canonical_fact,
    classification: claim.destinations.includes('person-private') ? 'private' : 'general',
    confidence: 'high',
  };
}

function oracleCandidates(fixture) {
  const candidates = fixture.claims.map(oracleCandidate);
  if (fixture.adversarial?.type === 'instruction') {
    candidates.unshift({
      fact: fixture.input.consumed[0],
      classification: 'reject',
      confidence: 'high',
    });
  }
  return candidates;
}

async function runSelfTest() {
  const fixtures = loadFixtureCorpus().gate;
  let offset = 0;
  const processor = {
    id: 'fixture-oracle-self-test',
    buildRequest: (request) => request,
    async invoke() {
      const fixture = fixtures[offset];
      offset += 1;
      return {
        stopReason: 'end_turn',
        content: JSON.stringify({ candidates: oracleCandidates(fixture) }),
        usage: {},
      };
    },
    normalize: (response) => response,
  };
  const run = await evaluateProcessorRun({
    fixtures,
    processor,
    runId: 'harness-self-test',
  });
  const summary = {
    status: run.evidence.passed ? 'PASS' : 'FAIL',
    fixtureCount: fixtures.length,
    score: run.score,
    rawSecretHits: run.safety.rawSecretHits,
    promptHash: run.evidence.promptHash,
    schemaHash: run.evidence.schemaHash,
    fixtureManifestHash: run.evidence.fixtureManifestHash,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!run.evidence.passed) process.exitCode = 1;
}

if (process.argv.length === 3 && process.argv[2] === '--self-test') {
  await runSelfTest();
} else {
  process.stderr.write('Usage: node scripts/spikes/memory-processor-gate/run-gate.mjs --self-test\n');
  process.exitCode = 2;
}

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('PostToolBatch spike tells Claude to honor injected user-followup context', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'spikes', 'post-tool-batch.mjs'),
    'utf8',
  );

  assert.match(
    source,
    /after both tools, inspect any `<channel source="user-followup">` context/i,
  );
  assert.match(source, /include any requested verification value verbatim/i);
});

test('Opus projection gives its nested Workflow gate the Workflow schema id', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'spikes', 'opus-default-projection.mjs'),
    'utf8',
  );

  assert.match(
    source,
    /CLAUDE_GATE_SCENARIO_ID:\s*'workflow-direct'/,
  );
});

test('resume oracle rejects marker-bearing unsuccessful results', async () => {
  const { evaluateSessionResumeEvidence } = await import(
    '../scripts/spikes/sdk-gate-oracles.mjs'
  );

  assert.deepEqual(evaluateSessionResumeEvidence({
    firstResultSubtype: 'success',
    secondResultSubtype: 'success',
    markerRecalled: true,
  }), { pass: true, reasons: [] });
  const invalid = evaluateSessionResumeEvidence({
    firstResultSubtype: 'success',
    secondResultSubtype: 'error_during_execution',
    markerRecalled: true,
  });
  assert.equal(invalid.pass, false);
  assert.match(invalid.reasons.join('\n'), /second query/);
});

test('tool-less drain oracle requires the buffered marker in a successful second turn', async () => {
  const { evaluateToolLessDrainEvidence } = await import(
    '../scripts/spikes/sdk-gate-oracles.mjs'
  );

  assert.deepEqual(evaluateToolLessDrainEvidence({
    hookFiredCount: 0,
    resultSubtypes: ['success', 'success'],
    bufferedMarkerCount: 1,
  }), { pass: true, reasons: [] });
  const invalid = evaluateToolLessDrainEvidence({
    hookFiredCount: 0,
    resultSubtypes: ['success'],
    bufferedMarkerCount: 0,
  });
  assert.equal(invalid.pass, false);
  assert.match(invalid.reasons.join('\n'), /two successful turns/);
  assert.match(invalid.reasons.join('\n'), /exactly once/);
});

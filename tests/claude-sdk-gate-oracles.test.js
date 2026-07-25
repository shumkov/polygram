'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

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

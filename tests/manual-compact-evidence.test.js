'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const moduleUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'scripts',
  'spikes',
  'manual-compact-evidence.mjs',
)).href;

function validTimeline(marker = 'compact-marker-1234') {
  const sessionId = 'session-1';
  return [
    { kind: 'establish-prompt', sessionId, value: `Remember ${marker}` },
    { kind: 'establish-result', sessionId, subtype: 'success', value: 'noted' },
    { kind: 'compact-prompt', sessionId, value: '/compact preserve the marker' },
    { kind: 'pre-compact', sessionId, trigger: 'manual' },
    { kind: 'compact-boundary', sessionId, trigger: 'manual' },
    { kind: 'compact-result', sessionId, subtype: 'success', value: 'compacted' },
    {
      kind: 'recall-prompt',
      sessionId,
      value: 'What marker did I ask you to remember?',
    },
    { kind: 'recall-result', sessionId, subtype: 'success', value: marker },
  ];
}

test('manual compact evidence requires one ordered same-session marker recall', async () => {
  const { evaluateManualCompactEvidence } = await import(moduleUrl);
  const marker = 'compact-marker-1234';
  const valid = evaluateManualCompactEvidence({
    timeline: validTimeline(marker),
    marker,
  });

  assert.equal(valid.pass, true);
  assert.equal(valid.preCompactCount, 1);
  assert.equal(valid.compactBoundaryCount, 1);
  assert.equal(valid.resultCount, 3);
  assert.equal(valid.sameSession, true);
  assert.equal(valid.ordered, true);
  assert.equal(valid.recallPromptMarkerFree, true);
  assert.equal(valid.markerRecallCount, 1);
  assert.equal(valid.orderedEvidence.length, 8);
  assert.doesNotMatch(JSON.stringify(valid), /compact-marker-1234|session-1/);

  const duplicateHook = validTimeline(marker);
  duplicateHook.splice(4, 0, {
    kind: 'pre-compact',
    sessionId: 'session-1',
    trigger: 'manual',
  });
  assert.equal(evaluateManualCompactEvidence({
    timeline: duplicateHook,
    marker,
  }).pass, false);

  const wrongSession = validTimeline(marker);
  wrongSession[4] = { ...wrongSession[4], sessionId: 'session-2' };
  assert.equal(evaluateManualCompactEvidence({
    timeline: wrongSession,
    marker,
  }).pass, false);

  const leakedRecall = validTimeline(marker);
  leakedRecall[6] = { ...leakedRecall[6], value: `Repeat ${marker}` };
  assert.equal(evaluateManualCompactEvidence({
    timeline: leakedRecall,
    marker,
  }).pass, false);

  const staleBoundary = validTimeline(marker);
  [staleBoundary[2], staleBoundary[4]] = [staleBoundary[4], staleBoundary[2]];
  assert.equal(evaluateManualCompactEvidence({
    timeline: staleBoundary,
    marker,
  }).pass, false);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');

test('delayed MCP comparator accepts the old foreground completion shape', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );

  const result = evaluateDelayedMcpEvidence({
    expectedMode: 'foreground',
    thresholdMs: 1_000,
    handlerDurationMs: 1_500,
    toolUseCount: 1,
    markerCount: 1,
    resultSubtype: 'success',
    toolResultBeforeHandlerCompletion: false,
    taskStartedCount: 0,
    backgroundTransitionCount: 0,
    taskNotificationCount: 0,
  });

  assert.deepEqual(result, { pass: true, reasons: [] });
});

test('delayed MCP comparator accepts the candidate native background completion shape', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );

  const result = evaluateDelayedMcpEvidence({
    expectedMode: 'background',
    thresholdMs: 1_000,
    handlerDurationMs: 3_500,
    toolUseCount: 1,
    markerCount: 1,
    resultSubtype: 'success',
    toolResultBeforeHandlerCompletion: true,
    taskStartedCount: 1,
    backgroundTransitionCount: 1,
    taskNotificationCount: 1,
  });

  assert.deepEqual(result, { pass: true, reasons: [] });
});

test('delayed MCP comparator rejects silent and duplicate candidate delivery', async () => {
  const { evaluateDelayedMcpEvidence } = await import(
    '../scripts/spikes/delayed-mcp-gate.mjs'
  );

  const result = evaluateDelayedMcpEvidence({
    expectedMode: 'background',
    thresholdMs: 1_000,
    handlerDurationMs: 3_500,
    toolUseCount: 1,
    markerCount: 2,
    resultSubtype: 'success',
    toolResultBeforeHandlerCompletion: false,
    taskStartedCount: 0,
    backgroundTransitionCount: 0,
    taskNotificationCount: 0,
  });

  assert.equal(result.pass, false);
  assert.match(result.reasons.join('\n'), /exactly one marker/);
  assert.match(result.reasons.join('\n'), /before the handler completed/);
  assert.match(result.reasons.join('\n'), /task notification/);
});

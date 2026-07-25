#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';

import {
  buildClaudeGateSdkOptions,
  createClaudeGateSelection,
  hashSensitiveString,
} from './claude-executable.mjs';
import {
  createSdkGateObserver,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import { evaluateDelayedMcpEvidence } from './delayed-mcp-gate.mjs';

const modeIndex = process.argv.indexOf('--expected-mode');
const expectedMode = modeIndex >= 0 ? process.argv[modeIndex + 1] : null;
if (!['foreground', 'background'].includes(expectedMode)) {
  console.error('usage: delayed-mcp-background.mjs --expected-mode foreground|background');
  process.exit(64);
}

const thresholdMs = Number(process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS);
if (!Number.isInteger(thresholdMs) || thresholdMs < 250) {
  throw new TypeError('CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS must be an integer of at least 250');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const countOccurrences = (text, marker) => text.split(marker).length - 1;
const selection = await createClaudeGateSelection();
const observer = createSdkGateObserver(selection);
const delayMs = thresholdMs + 4_000;
const marker = `MCP-COMPLETE:${selection.version}:${crypto.randomBytes(4).toString('hex')}`;
const privateDir = path.join(selection.artifactDir, 'raw-private');
const streamPath = path.join(privateDir, 'sdk-stream.ndjson');
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(privateDir, 0o700);
const streamFd = fs.openSync(streamPath, 'wx', 0o600);

let handlerStartedAt = null;
let handlerCompletedAt = null;
let resolveHandlerDone;
const handlerDone = new Promise((resolve) => {
  resolveHandlerDone = resolve;
});

const delayedTool = tool(
  'delayed_marker',
  'Wait for the gate delay, then return the unique completion marker.',
  {},
  async () => {
    handlerStartedAt = Date.now();
    await sleep(delayMs);
    handlerCompletedAt = Date.now();
    resolveHandlerDone();
    return {
      content: [{ type: 'text', text: marker }],
    };
  },
  { alwaysLoad: true },
);
const server = createSdkMcpServer({
  name: 'polygram-delayed-gate',
  version: '1.0.0',
  tools: [delayedTool],
  alwaysLoad: true,
});

const evidence = {
  expectedMode,
  thresholdMs,
  handlerDurationMs: 0,
  toolUseCount: 0,
  markerCount: 0,
  resultSubtype: null,
  toolResultBeforeHandlerCompletion: false,
  taskStartedCount: 0,
  backgroundTransitionCount: 0,
  taskNotificationCount: 0,
};
const q = query({
  prompt: [
    'Call mcp__polygram-delayed-gate__delayed_marker exactly once.',
    'If it becomes a background task, wait for its native completion notification.',
    `After the tool completes, reply with exactly this marker and nothing else: ${marker}`,
  ].join(' '),
  options: buildClaudeGateSdkOptions(selection, {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 8,
    mcpServers: {
      'polygram-delayed-gate': server,
    },
  }),
});

for await (const message of q) {
  fs.writeSync(streamFd, `${JSON.stringify(message)}\n`);
  observer.observe(message);

  if (message.type === 'system') {
    if (message.subtype === 'task_started') evidence.taskStartedCount += 1;
    if (message.subtype === 'task_updated' && message.patch?.is_backgrounded) {
      evidence.backgroundTransitionCount += 1;
    }
    if (message.subtype === 'task_notification') {
      evidence.taskNotificationCount += 1;
    }
  }

  if (message.type === 'assistant') {
    const blocks = Array.isArray(message.message?.content)
      ? message.message.content
      : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        if (block.name.endsWith('__delayed_marker')) evidence.toolUseCount += 1;
      }
      if (block?.type === 'text' && typeof block.text === 'string') {
        evidence.markerCount += countOccurrences(block.text, marker);
      }
    }
  }

  if (message.type === 'user') {
    const blocks = Array.isArray(message.message?.content)
      ? message.message.content
      : [];
    const contentTypes = blocks
      .map((block) => block?.type)
      .filter((type) => typeof type === 'string');
    if (
      handlerStartedAt
      && !handlerCompletedAt
      && (
        contentTypes.includes('tool_result')
        || message.tool_use_result?.isAsync === true
        || message.tool_use_result?.is_async === true
      )
    ) {
      evidence.toolResultBeforeHandlerCompletion = true;
    }
  }

  if (message.type === 'result') {
    evidence.resultSubtype = message.subtype;
  }
}
fs.closeSync(streamFd);

if (handlerStartedAt && !handlerCompletedAt) {
  await Promise.race([
    handlerDone,
    sleep(delayMs + 15_000).then(() => {
      throw new Error('delayed MCP handler did not finish');
    }),
  ]);
}
assert.ok(handlerStartedAt, 'model must invoke the delayed MCP tool');
assert.ok(handlerCompletedAt, 'delayed MCP handler must complete');
evidence.handlerDurationMs = handlerCompletedAt - handlerStartedAt;

const evaluation = evaluateDelayedMcpEvidence(evidence);
const sdkEvidence = observer.finish();
const pass = evaluation.pass && sdkEvidence.pass;
const result = {
  evidenceSchemaVersion: 1,
  matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'delayed-mcp',
  scenario: 'delayed-mcp',
  status: pass ? 'PASS' : 'FAIL',
  attestation: selection.sanitizedAttestation,
  resolvedModel: sdkEvidence.resolvedModel,
  resultSubtype: evidence.resultSubtype,
  markerCount: evidence.markerCount,
  evidence,
  lifecycle: sdkEvidence.lifecycle,
  wrapperRecords: sdkEvidence.wrapperRecords,
  processEvidence: sdkEvidence.processEvidence,
  reasonCount: evaluation.reasons.length + sdkEvidence.reasons.length,
  reasonHashes: [
    ...evaluation.reasons,
    ...sdkEvidence.reasons,
  ].map(hashSensitiveString),
};
const resultPath = writeSanitizedGateResult(selection.artifactDir, result);

console.log('attestation:', JSON.stringify(selection.sanitizedAttestation));
console.log('evidence:', JSON.stringify(evidence));
console.log('sanitized result:', resultPath);
console.log(result.status);
if (!pass) {
  for (const reason of [...evaluation.reasons, ...sdkEvidence.reasons]) {
    console.error(`- ${reason}`);
  }
}
process.exit(pass ? 0 : 1);

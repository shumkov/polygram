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
  collectGateLifecycleEvidence,
  createSdkGateObserver,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import {
  buildDelayedMcpGatePrompt,
  evaluateDelayedMcpEvidence,
  isTargetDelayedMcpToolResult,
} from './delayed-mcp-gate.mjs';

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
const targetToolName = 'mcp__polygram-delayed-gate__delayed_marker';
const targetTaskDescription = 'polygram-delayed-gate/delayed_marker';
const marker = `MCP-COMPLETE:${selection.version}:${crypto.randomBytes(4).toString('hex')}`;
const privateDir = path.join(selection.artifactDir, 'raw-private');
const streamPath = path.join(privateDir, 'sdk-stream.ndjson');
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(privateDir, 0o700);
const streamFd = fs.openSync(streamPath, 'wx', 0o600);

let handlerStartedAt = null;
let handlerCompletedAt = null;
let asyncResultAt = null;
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
  nativeLifecycleProof: {
    schemaVersion: 1,
    expectedMode,
    counts: {
      targetToolUse: 0,
      targetToolResult: 0,
      nonEmptyMembership: 0,
      emptyMembership: 0,
      taskStarted: 0,
      taskCompleted: 0,
      taskNotification: 0,
      marker: 0,
    },
    ordinals: {
      toolUse: null,
      membershipListed: null,
      taskStarted: null,
      toolResult: null,
      membershipCleared: null,
      taskCompleted: null,
      taskNotification: null,
      marker: null,
    },
    membership: {
      listedTaskCount: null,
      clearedTaskCount: null,
    },
    correlations: {
      listedTaskIsTargetMcp: null,
      startedTaskIsTargetMcp: null,
      listedTaskMatchesStarted: null,
      startedToolUseMatchesTarget: null,
      toolResultMatchesTarget: null,
      completedTaskMatchesStarted: null,
      notificationTaskMatchesStarted: null,
      notificationToolUseMatchesTarget: null,
    },
    statuses: {
      asyncPlaceholder: false,
      taskCompleted: false,
      notificationCompleted: false,
    },
    timing: {
      asyncResultDelayMs: null,
      asyncResultLeadMs: null,
    },
  },
};
const proof = evidence.nativeLifecycleProof;
let streamOrdinal = 0;
let targetToolUseId = null;
let listedTask = null;
let startedTask = null;
let targetToolResultId = null;
let completedTaskId = null;
let notifiedTask = null;
const q = query({
  prompt: buildDelayedMcpGatePrompt(),
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
  streamOrdinal += 1;
  fs.writeSync(streamFd, `${JSON.stringify(message)}\n`);
  observer.observe(message);

  if (message.type === 'system') {
    if (message.subtype === 'background_tasks_changed') {
      const tasks = Array.isArray(message.tasks) ? message.tasks : [];
      if (tasks.length === 0) {
        proof.counts.emptyMembership += 1;
        proof.ordinals.membershipCleared ??= streamOrdinal;
        proof.membership.clearedTaskCount = 0;
      } else {
        proof.counts.nonEmptyMembership += 1;
        proof.ordinals.membershipListed ??= streamOrdinal;
        proof.membership.listedTaskCount = tasks.length;
        if (tasks.length === 1) [listedTask] = tasks;
      }
    }
    if (message.subtype === 'task_started') {
      proof.counts.taskStarted += 1;
      proof.ordinals.taskStarted ??= streamOrdinal;
      startedTask ??= message;
    }
    if (
      message.subtype === 'task_updated'
      && message.patch?.status === 'completed'
    ) {
      proof.counts.taskCompleted += 1;
      proof.ordinals.taskCompleted ??= streamOrdinal;
      completedTaskId ??= message.task_id;
      proof.statuses.taskCompleted = true;
    }
    if (message.subtype === 'task_notification') {
      proof.counts.taskNotification += 1;
      proof.ordinals.taskNotification ??= streamOrdinal;
      notifiedTask ??= message;
      proof.statuses.notificationCompleted = message.status === 'completed';
    }
  }

  if (message.type === 'assistant') {
    const blocks = Array.isArray(message.message?.content)
      ? message.message.content
      : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        if (block.name === targetToolName) {
          evidence.toolUseCount += 1;
          proof.counts.targetToolUse += 1;
          proof.ordinals.toolUse ??= streamOrdinal;
          targetToolUseId ??= block.id;
        }
      }
      if (block?.type === 'text' && typeof block.text === 'string') {
        const markerOccurrences = countOccurrences(block.text, marker);
        evidence.markerCount += markerOccurrences;
        proof.counts.marker += markerOccurrences;
        if (markerOccurrences > 0) proof.ordinals.marker ??= streamOrdinal;
      }
    }
  }

  if (message.type === 'user') {
    const blocks = Array.isArray(message.message?.content)
      ? message.message.content
      : [];
    for (const block of blocks) {
      if (!isTargetDelayedMcpToolResult(block, targetToolUseId)) continue;
      proof.counts.targetToolResult += 1;
      proof.ordinals.toolResult ??= streamOrdinal;
      targetToolResultId ??= block.tool_use_id;
      if (handlerStartedAt && !handlerCompletedAt) {
        evidence.toolResultBeforeHandlerCompletion = true;
        proof.statuses.asyncPlaceholder = true;
        asyncResultAt ??= Date.now();
      }
    }
  }

  if (message.type === 'result') {
    evidence.resultSubtype = message.subtype;
  }
}
fs.closeSync(streamFd);
const streamEvidence = collectGateLifecycleEvidence(streamPath, {
  stream: 'sdk',
});

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
proof.correlations.listedTaskIsTargetMcp = listedTask === null
  ? null
  : (
      listedTask.task_type === 'mcp_task'
      && listedTask.description === targetTaskDescription
    );
proof.correlations.startedTaskIsTargetMcp = startedTask === null
  ? null
  : (
      startedTask.task_type === 'mcp_task'
      && startedTask.description === targetTaskDescription
    );
proof.correlations.listedTaskMatchesStarted = (
  listedTask === null || startedTask === null
) ? null : listedTask.task_id === startedTask.task_id;
proof.correlations.startedToolUseMatchesTarget = startedTask === null
  ? null
  : startedTask.tool_use_id === targetToolUseId;
proof.correlations.toolResultMatchesTarget =
  targetToolResultId === targetToolUseId;
proof.correlations.completedTaskMatchesStarted = (
  completedTaskId === null || startedTask === null
) ? null : completedTaskId === startedTask.task_id;
proof.correlations.notificationTaskMatchesStarted = (
  notifiedTask === null || startedTask === null
) ? null : notifiedTask.task_id === startedTask.task_id;
proof.correlations.notificationToolUseMatchesTarget = notifiedTask === null
  ? null
  : notifiedTask.tool_use_id === targetToolUseId;
if (asyncResultAt !== null) {
  proof.timing.asyncResultDelayMs = asyncResultAt - handlerStartedAt;
  proof.timing.asyncResultLeadMs = handlerCompletedAt - asyncResultAt;
}

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
  markerHash: hashSensitiveString(marker),
  evidence,
  lifecycle: sdkEvidence.lifecycle,
  lifecycleSources: {
    sdk: streamEvidence.source,
  },
  lifecycleProofs: [],
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

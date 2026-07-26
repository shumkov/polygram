#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  createClaudeGateSelection,
  hashSensitiveString,
  registerGateSessionProject,
  withClaudeGateTmuxEnv,
} from './claude-executable.mjs';
import {
  copyPrivateGateArtifact,
  normalizeGateJsonl,
  readWrapperRecords,
  resolveGateLifecycleModel,
  validateWrapperProvenance,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import {
  WORKFLOW_GATE_SESSION_PREFIX,
  evaluateWorkflowOutOfTurnTiming,
  makeTreePrivate,
  prepareWorkflowProject,
  evaluateWorkflowDeliveryEvidence,
  readWorkflowTaskNotificationEvidence,
  summarizeWorkflowRecordsForTask,
} from './workflow-fixture.mjs';
import {
  captureTmuxProcessTree,
  mergeProcessTrees,
  selectedBinaryPids,
} from './process-tree-evidence.mjs';

const require = createRequire(import.meta.url);
const { CliProcess, createTmuxRunner } = require('@shumkov/orchestra');
const {
  encodeCwd,
  sessionLogPath,
} = require('../../lib/util/claude-session-jsonl');
const { createSdkCallbacks } = require('../../lib/sdk/callbacks');
const { chunkMarkdownText } = require('../../lib/telegram/chunk');
const { deliverReplies } = require('../../lib/telegram/deliver');
const { parseResponse: parseResponseImpl } = require('../../lib/telegram/parse');
const {
  processAndDeliverAgentText,
} = require('../../lib/telegram/process-agent-reply');
const {
  sanitizeAssistantReply,
} = require('../../lib/telegram/sanitize-reply');
const {
  getChatIdFromKey,
  getThreadIdFromKey,
} = require('../../lib/session-key');

const deliveryIndex = process.argv.indexOf('--delivery');
const deliveryMode = deliveryIndex >= 0 ? process.argv[deliveryIndex + 1] : null;
if (!['direct', 'fail'].includes(deliveryMode)) {
  console.error('usage: workflow-autonomous-completion.mjs --delivery direct|fail');
  process.exit(64);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STOP_GRACE_MS = 2_000;
const SCHEDULING_MARGIN_MS = 500;
const COMPLETION_PROCESSING_MARGIN_MS = 100;
const COMPLETION_PREFIX = 'WF-COMPLETE:';
const noopStreamer = {
  onChunk: async () => {},
  forceNewMessage: () => {},
  finalize: async () => ({ streamed: false }),
  flushDraft: async () => {},
  discard: async () => {},
};
const noopReactor = {
  setState: () => {},
  heartbeat: () => {},
  clear: async () => {},
  stop: () => {},
};

function projectDirFor(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

function collectWorkflowMetadata(
  projectDir,
  sessionId,
  artifactDir,
  expectedResult,
  expectedTaskId,
) {
  const workflowDir = path.join(projectDir, sessionId, 'workflows');
  if (!fs.existsSync(workflowDir)) return [];
  const privateDir = path.join(artifactDir, 'raw-private', 'workflows');
  fs.cpSync(workflowDir, privateDir, { recursive: true });
  makeTreePrivate(privateDir);

  const records = [];
  for (const name of fs.readdirSync(workflowDir)) {
    if (!/^wf_[A-Za-z0-9-]+\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(workflowDir, name), 'utf8'));
      records.push(record);
    } catch {}
  }
  return summarizeWorkflowRecordsForTask(records, {
    taskId: expectedTaskId,
    expectedResult,
  });
}

function waitForCompletion(register, timeoutMs = 360_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Workflow completion timed out')), timeoutMs);
    timer.unref?.();
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

const selection = await createClaudeGateSelection();
const fixtureParent = path.join(selection.artifactDir, 'workflow-workspace');
fs.mkdirSync(fixtureParent, { mode: 0o700 });
const fixture = await prepareWorkflowProject({ parentDir: fixtureParent });
registerGateSessionProject(selection, fixture.cwd);
const suffix = crypto.randomBytes(4).toString('hex');
const sentinel = `${selection.version.replace(/\./g, '-')}-${suffix}`;
const launchMarker = `WF-LAUNCHED:${sentinel}`;
const completionMarker = `${COMPLETION_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
const originChatId = '-999000220';
const originThreadId = 220;
const sessionKey = `${originChatId}:${originThreadId}`;
const originRoute = sessionKey;
const foreignRoutes = new Set(['-999000220:root', '-999000220:221']);
const directCalls = [];
const fallbackCalls = [];
const eventKinds = [];
let launchTurnClosedAt = null;
let launchStopHookAt = null;
let completionAt = null;
let completionResolve = null;
let proc = null;
let status = 'FAIL';
let failureHash = null;
let lifecycle = {};
let workflowMetadata = [];
let processTree = [];
let resolvedModel = null;
let deliveryEvaluation = { pass: false, reasons: ['delivery not evaluated'] };
let timingEvaluation = {
  pass: false,
  reasons: ['out-of-turn timing not evaluated'],
  requiredTaskNotificationDelayMs: STOP_GRACE_MS + SCHEDULING_MARGIN_MS,
  requiredCompletionAfterNotificationMs: COMPLETION_PROCESSING_MARGIN_MS,
  taskNotificationAfterStopMs: null,
  completionAfterLaunchTurnMs: null,
  completionAfterTaskNotificationMs: null,
};
let fallbackPipeline = null;
let fallbackSentCount = 0;
let fallbackFailedCount = 0;
let settleFallbackPipeline = null;
const fallbackPipelineSettled = new Promise((resolve) => {
  settleFallbackPipeline = resolve;
});

const completionPromise = waitForCompletion((resolve) => {
  completionResolve = resolve;
});
const autonomousCallbacks = createSdkCallbacks({
  bot: {},
  botName: 'workflow-gate',
  tg: async (_bot, method, params) => {
    assert.equal(method, 'sendMessage');
    const route = `${params.chat_id}:${params.message_thread_id ?? 'root'}`;
    fallbackCalls.push({
      route,
      text: typeof params.text === 'string' ? params.text : '',
      delivered: true,
    });
    completionAt = Date.now();
    completionResolve({ kind: 'fallback' });
    return { message_id: 3000 + fallbackCalls.length };
  },
  logEvent: (kind) => eventKinds.push(kind),
  extractAssistantText: (message) => message?.text || '',
  getChatIdFromKey,
  getThreadIdFromKey,
  parseResponse: (text) => parseResponseImpl(text),
  sanitizeAssistantReply,
  chunkMarkdownText,
  deliverReplies,
  processAndDeliverAgentText: async (options) => {
    fallbackPipeline = 'helper';
    try {
      const result = await processAndDeliverAgentText(options);
      fallbackSentCount = result.deliverResult?.sent?.length || 0;
      fallbackFailedCount = result.deliverResult?.failed?.length || 0;
      settleFallbackPipeline(result);
      return result;
    } catch (error) {
      fallbackFailedCount += 1;
      settleFallbackPipeline(null);
      throw error;
    }
  },
  logger: {
    log: () => {},
    error: (...args) => console.error('[workflow-gate:callback]', ...args),
  },
});
const runner = withClaudeGateTmuxEnv(createTmuxRunner({
  sessionPrefix: WORKFLOW_GATE_SESSION_PREFIX,
  logger: console,
}), selection);

try {
  proc = new CliProcess({
    sessionKey,
    chatId: originChatId,
    threadId: originThreadId,
    label: `workflow-gate-${suffix}`,
    tmuxRunner: runner,
    botName: `wfgate${suffix}`,
    claudeBin: selection.executablePath,
    sessionLauncher: selection.sessionLauncher,
    toolDispatcher: async ({ chatId, threadId, toolName, text }) => {
      const route = `${chatId}:${threadId ?? 'root'}`;
      const call = {
        route,
        toolName,
        text: typeof text === 'string' ? text : '',
        delivered: true,
      };

      if (toolName === 'reply' && call.text.includes(completionMarker)) {
        if (deliveryMode === 'fail') {
          call.delivered = false;
          directCalls.push(call);
          return { ok: false, error: 'synthetic direct delivery failure' };
        }
        completionAt = Date.now();
        completionResolve({ kind: 'direct' });
      }
      directCalls.push(call);
      return { ok: true, message_id: 2000 + directCalls.length };
    },
    logger: {
      log: () => {},
      debug: () => {},
      warn: (...args) => console.error('[workflow-gate:warn]', ...args),
      error: (...args) => console.error('[workflow-gate:error]', ...args),
    },
    db: {
      logEvent(kind) {
        eventKinds.push(kind);
      },
    },
    appDataDir: path.join(fixture.cwd, '.orchestra'),
    attachmentBase: path.join(fixture.cwd, '.attachments'),
    sessionPrefix: WORKFLOW_GATE_SESSION_PREFIX,
    bridgeServerName: 'polygram-workflow-gate-bridge',
    productName: 'polygram-workflow-gate',
    surfaceName: 'synthetic channel',
    turnQuietMs: 1_500,
    stopGraceMs: STOP_GRACE_MS,
  });

  for (const eventName of [
    'bridge-ready',
    'mcp-ready',
    'thinking',
    'idle',
    'tool-use',
    'delivery-work-settled',
  ]) {
    proc.on(eventName, () => eventKinds.push(eventName));
  }
  proc.on('stop-hook', () => {
    eventKinds.push('stop-hook');
    if (launchStopHookAt === null && launchTurnClosedAt === null) {
      launchStopHookAt = Date.now();
    }
  });
  proc.on('autonomous-assistant-message', (message) => {
    autonomousCallbacks.onAutonomousAssistantMessage(
      sessionKey,
      message,
      proc,
    );
  });

  const chatConfig = {
    cwd: fixture.cwd,
    model: selection.model,
    effort: selection.effort,
    permissionMode: 'bypassPermissions',
    isolateUserConfig: true,
  };
  await proc.start({
    cwd: fixture.cwd,
    chatConfig,
    threadId: 220,
    existingSessionId: null,
  });
  processTree = captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: 'startup',
  });

  const launchResult = await proc.send(
    `/completion-sentinel ${sentinel}`,
    {
      timeoutMs: 150_000,
      maxTurnMs: 180_000,
      context: {
        streamer: noopStreamer,
        reactor: noopReactor,
        threadId: 220,
        sourceMsgId: 1,
        user: 'gate',
      },
    },
  );
  launchTurnClosedAt = Date.now();
  fs.writeFileSync(
    path.join(fixture.cwd, '.workflow-completion-marker'),
    `${completionMarker}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  assert.equal(launchResult.metrics?.resultSubtype, 'success');
  assert.equal(proc.pendingTurns.size, 0, 'launch turn must close before completion');
  assert.ok(
    directCalls.some((call) => call.route === originRoute && call.text.includes(launchMarker)),
    'launch acknowledgement must reach the origin route',
  );

  const completion = await completionPromise;
  if (deliveryMode === 'fail') await fallbackPipelineSettled;
  assert.ok(completionAt > launchTurnClosedAt, 'completion must arrive after launch turn closure');
  await sleep(4_000);

  const completionDirectCalls = directCalls.filter(
    (call) => call.toolName === 'reply' && call.text.includes(COMPLETION_PREFIX),
  );
  if (deliveryMode === 'direct') {
    assert.equal(completion.kind, 'direct');
    assert.equal(completionDirectCalls.length, 1);
    assert.equal(fallbackCalls.length, 0, 'successful direct delivery must suppress fallback');
  } else {
    assert.equal(completion.kind, 'fallback');
    assert.ok(completionDirectCalls.length >= 1, 'forced failure must exercise direct reply');
    assert.equal(fallbackCalls.length, 1, 'failed direct delivery must emit one fallback');
  }

  deliveryEvaluation = evaluateWorkflowDeliveryEvidence({
    deliveryMode,
    marker: completionMarker,
    completionPrefix: COMPLETION_PREFIX,
    originRoute,
    foreignRoutes: [...foreignRoutes],
    directAttempts: completionDirectCalls,
    fallbackDeliveries: fallbackCalls,
    fallbackPipeline,
    fallbackSentCount,
    fallbackFailedCount,
  });
  assert.equal(
    deliveryEvaluation.pass,
    true,
    deliveryEvaluation.reasons.join('; '),
  );

  const sessionPath = sessionLogPath(fixture.cwd, proc.claudeSessionId);
  assert.ok(fs.existsSync(sessionPath), 'Workflow session JSONL must exist');
  const privateSession = copyPrivateGateArtifact(
    sessionPath,
    selection.artifactDir,
    'session.jsonl',
  );
  const taskNotification = readWorkflowTaskNotificationEvidence(
    privateSession,
    completionMarker,
  );
  timingEvaluation = evaluateWorkflowOutOfTurnTiming({
    launchStopHookAt,
    launchTurnClosedAt,
    taskNotificationAt: taskNotification.timestamp,
    completionAt,
    stopGraceMs: STOP_GRACE_MS,
    schedulingMarginMs: SCHEDULING_MARGIN_MS,
    completionProcessingMarginMs: COMPLETION_PROCESSING_MARGIN_MS,
  });
  assert.equal(
    timingEvaluation.pass,
    true,
    timingEvaluation.reasons.join('; '),
  );
  lifecycle.session = normalizeGateJsonl(privateSession);
  const expectedResolvedModel = process.env.CLAUDE_GATE_EXPECTED_RESOLVED_MODEL
    || selection.model;
  resolvedModel = resolveGateLifecycleModel({
    records: lifecycle.session,
    expectedModel: expectedResolvedModel,
    label: 'Workflow session',
  });
  assert.ok(
    lifecycle.session.some((event) => (
      event.type === 'assistant' && event.toolNames.includes('Workflow')
    )),
    'session JSONL must contain a native Workflow tool use',
  );
  assert.ok(
    lifecycle.session.some((event) => (
      event.type === 'user'
      && event.originKind === 'task-notification'
      && event.promptSource === 'system'
      && event.hasTaskNotification
    )),
    'session JSONL must contain native task-notification provenance',
  );

  if (proc._hookNdjsonPath && fs.existsSync(proc._hookNdjsonPath)) {
    const privateHooks = copyPrivateGateArtifact(
      proc._hookNdjsonPath,
      selection.artifactDir,
      'hooks.ndjson',
    );
    lifecycle.hooks = normalizeGateJsonl(privateHooks);
    assert.ok(
      lifecycle.hooks.some((event) => (
        event.type === 'hook'
        && event.hookEventName === 'PreToolUse'
        && event.toolName === 'Workflow'
      )),
      'hook evidence must contain native Workflow PreToolUse',
    );
  } else {
    assert.fail('Workflow hook NDJSON must exist');
  }

  const claudeProjectDir = projectDirFor(fixture.cwd);
  workflowMetadata = collectWorkflowMetadata(
    claudeProjectDir,
    proc.claudeSessionId,
    selection.artifactDir,
    completionMarker,
    taskNotification.taskId,
  );
  assert.ok(workflowMetadata.length >= 1, 'native Workflow metadata must be discoverable');
  assert.ok(
    workflowMetadata.every((record) => (
      Number.isFinite(record.agentCount)
      && record.agentCount >= 1
      && record.agentCount <= 3
    )),
    'bounded fixture must use between one and three agents',
  );
  assert.ok(
    workflowMetadata.every((record) => (
      record.status === 'completed'
      && record.reportComplete
      && record.reportMatchesExpected
    )),
    'bounded Workflow must complete with the expected terminal report',
  );

  processTree = mergeProcessTrees(processTree, captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: 'after-workflow',
  }));
  const wrapperRecords = readWrapperRecords(selection);
  validateWrapperProvenance(selection, wrapperRecords, {
    observedClaudePids: selectedBinaryPids(selection, processTree),
  });

  status = 'PASS';
} catch (error) {
  failureHash = hashSensitiveString(error?.stack || error?.message || String(error));
  console.error(`FAIL (${failureHash.slice(0, 12)})`);
} finally {
  if (proc) {
    try {
      await proc.kill('gate-complete');
    } catch {}
  }
  writeSanitizedGateResult(selection.artifactDir, {
    evidenceSchemaVersion: 1,
    matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID
      || `workflow-${deliveryMode === 'fail' ? 'fallback' : 'direct'}`,
    scenario: `workflow-autonomous-completion-${deliveryMode}`,
    status,
    failureHash,
    attestation: selection.sanitizedAttestation,
    resolvedModel,
    fixtureHash: fixture.fixtureHash,
    workflowPolicyOverridePresent: fixture.workflowPolicyOverridePresent,
    launchTurnClosedBeforeCompletion: Boolean(
      launchTurnClosedAt && completionAt && completionAt > launchTurnClosedAt,
    ),
    outOfTurnTiming: timingEvaluation,
    directCompletionCount: directCalls.filter(
      (call) => call.toolName === 'reply' && call.text.includes(COMPLETION_PREFIX),
    ).length,
    fallbackCount: fallbackCalls.length,
    deliveryPipeline: fallbackPipeline,
    deliverySentCount: fallbackSentCount,
    deliveryFailedCount: fallbackFailedCount,
    directRouteCounts: Object.fromEntries(
      [...new Set(directCalls.map((call) => call.route))].map((route) => [
        hashSensitiveString(route),
        directCalls.filter((call) => call.route === route).length,
      ]),
    ),
    fallbackRouteCounts: Object.fromEntries(
      [...new Set(fallbackCalls.map((call) => call.route))].map((route) => [
        hashSensitiveString(route),
        fallbackCalls.filter((call) => call.route === route).length,
      ]),
    ),
    eventKinds,
    workflowMetadata,
    processTree: processTree.map((record) => ({
      pid: record.pid,
      ppid: record.ppid,
      executablePathHash: record.executablePathHash,
    })),
    wrapperRecords: readWrapperRecords(selection),
    lifecycle,
    deliveryReasonCount: deliveryEvaluation.reasons.length,
  });
}

console.log('attestation:', JSON.stringify(selection.sanitizedAttestation));
console.log(status);
process.exit(status === 'PASS' ? 0 : 1);

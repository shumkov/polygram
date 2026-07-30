#!/usr/bin/env node

/**
 * Real pinned-CLI gate for clean-restart resume plus one literal `continue`.
 *
 * This is intentionally outside `npm test`: it starts authenticated Claude CLI
 * sessions in tmux and consumes model usage. It only writes beneath the private
 * gate artifact directory created by createClaudeGateSelection().
 *
 * Required environment:
 *   CLAUDE_GATE_BIN=/absolute/path/to/the/pinned/claude
 *   CLAUDE_GATE_EXPECTED_VERSION=x.y.z
 *   CLAUDE_GATE_ARTIFACT_BASE=/absolute/mode-0700/directory
 *
 * The gate proves the CLI-dependent boundary:
 *   - one eight-step turn is retired after step five;
 *   - the old tmux session is gone before the retirement receipt is accepted;
 *   - a new manager strictly resumes the exact session and sends one `continue`;
 *   - steps six through eight finish without rerunning steps one through five;
 *   - reply-bearing and pending/ambiguous delivery evidence reject continuation;
 *   - a missing JSONL rejects strict resume without spawning fresh.
 *
 * Config-drift rejection is deterministic Polygram policy and remains covered by
 * tests/clean-resume-coordinator.test.js and the source-wiring contract.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  createClaudeGateSelection,
  registerGateSessionProject,
  withClaudeGateTmuxEnv,
} from './claude-executable.mjs';

const require = createRequire(import.meta.url);
const {
  CliProcess,
  ProcessManager,
  createTmuxRunner,
} = require('@shumkov/orchestra');
const orchestraPackage = require('@shumkov/orchestra/package.json');
const { sessionLogPath } = require('../../lib/util/claude-session-jsonl');

const REQUIRED_ORCHESTRA_VERSION = '0.10.6';
const SOURCE_MSG_ID = 501;
const TURN_TIMEOUT_MS = 180_000;
const SESSION_KEY = 'clean-restart-gate:220';
const SESSION_PREFIX = 'pcrg';
const CHAT_ID = '-999000220';
const THREAD_ID = 220;

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

function turnContext(sourceMsgId) {
  return {
    streamer: noopStreamer,
    reactor: noopReactor,
    threadId: THREAD_ID,
    sourceMsgId,
    user: 'clean-restart-gate',
  };
}

function waitForCount(emitter, eventName, count, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${count} ${eventName} events`));
    }, timeoutMs);
    const onEvent = () => {
      seen += 1;
      if (seen < count) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(eventName, onEvent);
    };
    emitter.on(eventName, onEvent);
  });
}

function waitForToolResult(emitter, predicate, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let targetToolUseId = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for the target tool result'));
    }, timeoutMs);
    const onUse = (detail) => {
      if (predicate(detail)) targetToolUseId = detail.toolUseId;
    };
    const onResult = (result) => {
      if (!targetToolUseId || result.toolUseId !== targetToolUseId) return;
      cleanup();
      resolve(result);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off('tool-use-detail', onUse);
      emitter.off('tool-result', onResult);
    };
    emitter.on('tool-use-detail', onUse);
    emitter.on('tool-result', onResult);
  });
}

function waitForReply(replies, fromIndex, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (replies.length > fromIndex) return resolve(replies[fromIndex]);
      if (Date.now() >= deadline) {
        return reject(new Error('timed out waiting for channel reply'));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

assert.equal(
  orchestraPackage.version,
  REQUIRED_ORCHESTRA_VERSION,
  `install @shumkov/orchestra@${REQUIRED_ORCHESTRA_VERSION} before running this gate`,
);
for (const method of [
  'retireForCleanRestart',
  'retireExpectedProcess',
]) {
  assert.equal(
    typeof ProcessManager.prototype[method],
    'function',
    `ProcessManager.${method} is required`,
  );
}

const selection = await createClaudeGateSelection();
const cwd = path.join(selection.artifactDir, 'clean-restart-workspace');
fs.mkdirSync(cwd, { mode: 0o700 });
registerGateSessionProject(selection, cwd);

const suffix = crypto.randomBytes(4).toString('hex');
const ledgerPath = path.join(cwd, 'steps.log');
const stepScript = path.join(cwd, 'step.sh');
const finalMarker = `CLEAN-RESUME-PASS-${suffix}`;
fs.writeFileSync(stepScript, [
  '#!/bin/sh',
  'set -eu',
  'step=\"$1\"',
  'sleep 2',
  `ledger=${JSON.stringify(ledgerPath)}`,
  'if grep -qx \"step=${step}\" \"$ledger\" 2>/dev/null; then',
  '  echo \"duplicate step ${step}\" >&2',
  '  exit 22',
  'fi',
  'printf \"step=%s\\n\" \"$step\" >> \"$ledger\"',
  'printf \"completed step %s\\n\" \"$step\"',
  '',
].join('\n'), { mode: 0o700, flag: 'wx' });

const baseRunner = createTmuxRunner({
  sessionPrefix: SESSION_PREFIX,
  logger: console,
});
const runner = withClaudeGateTmuxEnv(baseRunner, selection);
const replies = [];
const managers = [];
let literalContinueCount = 0;

function spawnContext({
  existingSessionId = null,
  strict = false,
} = {}) {
  return {
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    label: `clean-restart-gate-${suffix}`,
    cwd,
    chatConfig: {
      cwd,
      model: selection.model,
      effort: selection.effort,
      permissionMode: 'bypassPermissions',
      isolateUserConfig: true,
    },
    existingSessionId,
    ...(strict ? {
      resumePolicy: 'require-existing-session',
      expectedSessionId: existingSessionId,
      noWaitForCapacity: true,
    } : {}),
  };
}

function createManager(sessionKey = SESSION_KEY) {
  const processFactory = () => new CliProcess({
    sessionKey,
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    label: `clean-restart-gate-${suffix}`,
    tmuxRunner: runner,
    botName: `cleangate${suffix}`,
    claudeBin: selection.executablePath,
    sessionLauncher: selection.sessionLauncher,
    toolDispatcher: async ({ toolName, text, files = [] }) => {
      replies.push({
        toolName,
        text: typeof text === 'string' ? text : '',
        fileCount: Array.isArray(files) ? files.length : 0,
      });
      return { ok: true, message_id: 10_000 + replies.length };
    },
    logger: {
      log: () => {},
      debug: () => {},
      warn: (...args) => console.error('[clean-restart-gate:warn]', ...args),
      error: (...args) => console.error('[clean-restart-gate:error]', ...args),
    },
    appDataDir: path.join(cwd, '.orchestra'),
    attachmentBase: path.join(cwd, '.attachments'),
    sessionPrefix: SESSION_PREFIX,
    bridgeServerName: 'polygram-clean-restart-gate-bridge',
    productName: 'polygram-clean-restart-gate',
    surfaceName: 'synthetic gate chat',
    turnQuietMs: 1_500,
    stopGraceMs: 2_000,
    dropConfirmMs: 3_000,
    interruptGraceMs: 5_000,
  });
  const manager = new ProcessManager({
    processFactory,
    budget: 3,
    logger: console,
  });
  managers.push(manager);
  return manager;
}

function safeEvidence({ outputAttempted = false, pending = 0 } = {}) {
  return {
    outputAttempted,
    pending,
    fenced: true,
  };
}

let sanitizedResult = null;
try {
  const firstManager = createManager();
  const firstProcess = await firstManager.getOrSpawn(
    SESSION_KEY,
    spawnContext(),
  );
  const sessionId = firstProcess.claudeSessionId;
  registerGateSessionProject(selection, cwd, sessionId);
  const oldTmuxSession = firstProcess.tmuxSession;
  const fifthCommand = `/bin/sh ${stepScript} 5`;
  const fifthToolResult = waitForToolResult(
    firstProcess,
    (detail) => (
      detail.name === 'Bash'
      && detail.input?.command === fifthCommand
    ),
  );
  const initialTurn = firstManager.send(
    SESSION_KEY,
    [
      'This is a clean-restart recovery gate.',
      `Run exactly these commands sequentially: ${[1, 2, 3, 4, 5, 6, 7, 8]
        .map((step) => `/bin/sh ${stepScript} ${step}`)
        .join(', ')}.`,
      'Use one Bash tool call per command.',
      'Do not rerun a completed command.',
      'Do not call the reply tool until every command has completed.',
      `After step 8, call the channel reply tool once with exactly ${finalMarker}.`,
      'If interrupted, the next user message will be "continue"; resume only the remaining commands.',
    ].join(' '),
    {
      context: turnContext(SOURCE_MSG_ID),
      timeoutMs: TURN_TIMEOUT_MS,
      maxTurnMs: TURN_TIMEOUT_MS,
    },
  );
  await fifthToolResult;
  const [receipt] = await firstManager.retireForCleanRestart({
    getDeliveryEvidence: (_sessionKey, sourceMsgId) => {
      assert.equal(sourceMsgId, SOURCE_MSG_ID);
      return safeEvidence();
    },
  });
  await Promise.allSettled([initialTurn]);
  assert.equal(receipt.eligible, true);
  assert.equal(receipt.sourceMsgId, SOURCE_MSG_ID);
  assert.equal(firstProcess.closed, true);
  assert.equal(await runner.sessionExists(oldTmuxSession), false);
  const stepsBeforeResume = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  assert.deepEqual(stepsBeforeResume, [
    'step=1',
    'step=2',
    'step=3',
    'step=4',
    'step=5',
  ]);

  const resumedManager = createManager();
  const resumedProcess = await resumedManager.getOrSpawn(
    SESSION_KEY,
    spawnContext({ existingSessionId: sessionId, strict: true }),
  );
  assert.deepEqual(resumedProcess.resumeAttestation, {
    namespace: 'claude:channels',
    sessionId,
    resumed: true,
    freshFallback: false,
  });
  const replyStart = replies.length;
  literalContinueCount += 1;
  await resumedManager.send(SESSION_KEY, 'continue', {
    expectedProcess: resumedProcess,
    context: turnContext(SOURCE_MSG_ID),
    timeoutMs: TURN_TIMEOUT_MS,
    maxTurnMs: TURN_TIMEOUT_MS,
  });
  const finalReply = await waitForReply(replies, replyStart);
  assert.equal(finalReply.text.trim(), finalMarker);
  const finalReplies = replies.slice(replyStart);
  assert.equal(finalReplies.length, 1);
  const steps = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  assert.deepEqual(steps, [
    'step=1',
    'step=2',
    'step=3',
    'step=4',
    'step=5',
    'step=6',
    'step=7',
    'step=8',
  ]);

  const interimReplyStart = replies.length;
  const interimReply = waitForReply(replies, interimReplyStart);
  const interimTurn = resumedManager.send(
    SESSION_KEY,
    'Call the channel reply tool once with exactly INTERIM-DELIVERED, then run `sleep 30` with Bash.',
    {
      context: turnContext(SOURCE_MSG_ID + 1),
      timeoutMs: TURN_TIMEOUT_MS,
      maxTurnMs: TURN_TIMEOUT_MS,
    },
  );
  await interimReply;
  const [deliveredReceipt] = await resumedManager.retireForCleanRestart({
    getDeliveryEvidence: () => safeEvidence({ outputAttempted: true }),
  });
  await Promise.allSettled([interimTurn]);
  assert.equal(deliveredReceipt.eligible, false);
  assert.equal(deliveredReceipt.reason, 'prior-output');

  const ambiguousSessionKey = `${SESSION_KEY}:ambiguous`;
  const ambiguousManager = createManager(ambiguousSessionKey);
  const ambiguousProcess = await ambiguousManager.getOrSpawn(
    ambiguousSessionKey,
    spawnContext(),
  );
  const turnStarted = waitForCount(ambiguousProcess, 'turn-start', 1);
  const ambiguousTurn = ambiguousManager.send(
    ambiguousSessionKey,
    'Run `sleep 30` with Bash and do not call the reply tool.',
    {
      context: turnContext(SOURCE_MSG_ID + 2),
      timeoutMs: TURN_TIMEOUT_MS,
      maxTurnMs: TURN_TIMEOUT_MS,
    },
  );
  await turnStarted;
  const [ambiguousReceipt] = await ambiguousManager.retireForCleanRestart({
    getDeliveryEvidence: () => safeEvidence({ pending: 1 }),
  });
  await Promise.allSettled([ambiguousTurn]);
  assert.equal(ambiguousReceipt.eligible, false);
  assert.equal(ambiguousReceipt.reason, 'delivery-ambiguous');

  const missingSessionId = crypto.randomUUID();
  const missingSessionKey = `${SESSION_KEY}:missing`;
  assert.equal(fs.existsSync(sessionLogPath(cwd, missingSessionId)), false);
  const missingManager = createManager(missingSessionKey);
  await assert.rejects(
    missingManager.getOrSpawn(
      missingSessionKey,
      spawnContext({ existingSessionId: missingSessionId, strict: true }),
    ),
    (error) => error?.code === 'REQUIRED_SESSION_NOT_FOUND',
  );
  assert.equal(missingManager.has(missingSessionKey), false);

  sanitizedResult = {
    status: 'PASS',
    runId: selection.runId,
    attestation: selection.sanitizedAttestation,
    orchestraVersion: orchestraPackage.version,
    positive: {
      retiredAfterStep: stepsBeforeResume.length,
      continuedSteps: steps.length - stepsBeforeResume.length,
      duplicateSteps: steps.length - new Set(steps).size,
      literalContinueCount,
      finalReplyCount: finalReplies.length,
    },
    negative: {
      deliveredOutputRejected: deliveredReceipt.reason === 'prior-output',
      pendingDeliveryRejected: ambiguousReceipt.reason === 'delivery-ambiguous',
      missingJsonlRejected: true,
      configDriftCoveredByUnitContract: true,
    },
  };
  fs.writeFileSync(
    path.join(selection.artifactDir, 'sanitized-result.json'),
    `${JSON.stringify(sanitizedResult, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(`PASS clean-restart-resume (${selection.runId})`);
  console.log(`Sanitized evidence: ${path.join(selection.artifactDir, 'sanitized-result.json')}`);
} catch (error) {
  const failure = {
    status: 'FAIL',
    runId: selection.runId,
    stage: error?.code || error?.name || 'Error',
  };
  try {
    fs.writeFileSync(
      path.join(selection.artifactDir, 'sanitized-failure.json'),
      `${JSON.stringify(failure, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  } catch {}
  console.error(`FAIL clean-restart-resume: ${error.message}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(managers.map((manager) => manager.shutdown()));
}

#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  createClaudeGateSelection,
  hashSensitiveString,
  registerGateSessionProject,
  withClaudeGateTmuxEnv,
} from './claude-executable.mjs';
import {
  collectGateLifecycleEvidence,
  collectGateSessionEvidence,
  copyPrivateGateArtifact,
  readGateSessionTerminalState,
  readWrapperRecords,
  resolveGateLifecycleModel,
  validateWrapperProvenance,
  waitForGateEventSequence,
  waitForGateSessionTerminal,
  writePrivateGateFailure,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import {
  makeTreePrivate,
} from './workflow-fixture.mjs';
import {
  captureTmuxProcessTree,
  mergeProcessTrees,
  selectedBinaryProcesses,
} from './process-tree-evidence.mjs';

const require = createRequire(import.meta.url);
const { CliProcess, createTmuxRunner } = require('@shumkov/orchestra');
const { sessionLogPath } = require('../../lib/util/claude-session-jsonl');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BRIDGE_SERVER_NAME = 'polygram-gate-bridge';
const INTERRUPT_SOURCE_MSG_ID = 5;
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
    threadId: 220,
    sourceMsgId,
    user: 'gate',
  };
}

function copyAndNormalizeLifecycle(proc, cwd, selection) {
  const lifecycle = {};
  const lifecycleSources = {};
  let lifecycleProofs = [];
  const sessionPath = sessionLogPath(cwd, proc.claudeSessionId);
  if (fs.existsSync(sessionPath)) {
    const privateSession = copyPrivateGateArtifact(
      sessionPath,
      selection.artifactDir,
      'session.jsonl',
    );
    const sessionEvidence = collectGateSessionEvidence(privateSession, {
      interruptSourceMsgId: INTERRUPT_SOURCE_MSG_ID,
      channelServerName: BRIDGE_SERVER_NAME,
    });
    lifecycle.session = sessionEvidence.records;
    lifecycleSources.session = sessionEvidence.source;
    lifecycleProofs = sessionEvidence.proofs;
  }
  if (proc._hookNdjsonPath && fs.existsSync(proc._hookNdjsonPath)) {
    const privateHooks = copyPrivateGateArtifact(
      proc._hookNdjsonPath,
      selection.artifactDir,
      'hooks.ndjson',
    );
    const hookEvidence = collectGateLifecycleEvidence(privateHooks, {
      stream: 'hooks',
    });
    lifecycle.hooks = hookEvidence.records;
    lifecycleSources.hooks = hookEvidence.source;
  }
  return { lifecycle, lifecycleSources, lifecycleProofs };
}

const selection = await createClaudeGateSelection();
const cwd = path.join(selection.artifactDir, 'cli-workspace');
fs.mkdirSync(cwd, { mode: 0o700 });
registerGateSessionProject(selection, cwd);
const suffix = crypto.randomBytes(4).toString('hex');
const replies = [];
const eventKinds = [];
let fileObserved = false;
let spawnCount = 0;
let proc = null;
let lifecycle = {};
let lifecycleSources = {};
let lifecycleProofs = [];
let processTree = [];
let resolvedModel = null;
let startupHandshake = null;
let status = 'FAIL';
let failureHash = null;
let failureStage = 'initializing';
const startupStartedAt = Date.now();

const baseRunner = createTmuxRunner({
  sessionPrefix: 'polygram-gate',
  logger: console,
});
const envRunner = withClaudeGateTmuxEnv(baseRunner, selection);
const runner = {
  ...envRunner,
  spawn: async (options) => {
    spawnCount += 1;
    return envRunner.spawn(options);
  },
};

try {
  proc = new CliProcess({
    sessionKey: `claude-gate:${suffix}`,
    chatId: '-999000220',
    threadId: 220,
    label: `claude-gate-${suffix}`,
    tmuxRunner: runner,
    botName: `gate${suffix}`,
    claudeBin: selection.executablePath,
    sessionLauncher: selection.sessionLauncher,
    toolDispatcher: async ({ toolName, text, files = [] }) => {
      const call = {
        toolName,
        text: typeof text === 'string' ? text : '',
        files: Array.isArray(files) ? files : [],
      };
      replies.push(call);
      if (call.files.length > 0) {
        fileObserved = call.files.some((filePath) => {
          try {
            return fs.statSync(filePath).isFile()
              && fs.readFileSync(filePath, 'utf8').includes('FILE-CONTENT-OK');
          } catch {
            return false;
          }
        });
      }
      return { ok: true, message_id: 1000 + replies.length };
    },
    logger: {
      log: () => {},
      debug: () => {},
      warn: (...args) => console.error('[cli-gate:warn]', ...args),
      error: (...args) => console.error('[cli-gate:error]', ...args),
    },
    db: {
      logEvent(kind) {
        eventKinds.push(kind);
      },
    },
    appDataDir: path.join(cwd, '.orchestra'),
    attachmentBase: path.join(cwd, '.attachments'),
    sessionPrefix: 'polygram-gate',
    bridgeServerName: BRIDGE_SERVER_NAME,
    productName: 'polygram-gate',
    surfaceName: 'synthetic channel',
    turnQuietMs: 1_500,
    stopGraceMs: 2_000,
    dropConfirmMs: 3_000,
    interruptGraceMs: 5_000,
  });

  for (const eventName of [
    'bridge-ready',
    'mcp-ready',
    'thinking',
    'idle',
    'tool-use',
    'stop-hook',
    'input-dropped',
  ]) {
    proc.on(eventName, () => eventKinds.push(eventName));
  }
  let bridgeReadyMs = null;
  let mcpReadyMs = null;
  proc.once('bridge-ready', () => {
    bridgeReadyMs = Date.now() - startupStartedAt;
  });
  proc.once('mcp-ready', () => {
    mcpReadyMs = Date.now() - startupStartedAt;
  });

  const chatConfig = {
    cwd,
    model: selection.model,
    effort: selection.effort,
    permissionMode: 'bypassPermissions',
    isolateUserConfig: true,
  };
  failureStage = 'starting-cli';
  await proc.start({
    cwd,
    chatConfig,
    threadId: 220,
    existingSessionId: null,
  });
  assert.equal(proc.model, selection.model);
  assert.equal(proc.effort, selection.effort);
  assert.equal(spawnCount, 1);
  assert.ok(Number.isInteger(bridgeReadyMs));
  assert.ok(Number.isInteger(mcpReadyMs));
  assert.ok(mcpReadyMs >= bridgeReadyMs);
  startupHandshake = {
    bridgeReadyMs,
    mcpReadyMs,
    bridgeReadyToMcpReadyMs: mcpReadyMs - bridgeReadyMs,
  };
  const sessionAtStart = proc.claudeSessionId;
  registerGateSessionProject(selection, cwd, sessionAtStart);
  processTree = captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: 'startup',
  });

  let replyStart = replies.length;
  const readyMarker = `CLI-READY-${suffix}`;
  failureStage = 'readiness-reply';
  await proc.send(
    `Reply through the channel reply tool with exactly ${readyMarker}.`,
    { timeoutMs: 120_000, maxTurnMs: 150_000, context: turnContext(1) },
  );
  assert.ok(
    replies.slice(replyStart).some((call) => call.text.includes(readyMarker)),
    'first-turn readiness/reply marker must be delivered',
  );

  replyStart = replies.length;
  const multilineMarker = `MULTILINE-${suffix}`;
  failureStage = 'multiline-reply';
  await proc.send(
    `Read both lines of this message and reply exactly ${multilineMarker}.\n`
      + 'The second line is required evidence that multiline input arrived.',
    { timeoutMs: 120_000, maxTurnMs: 150_000, context: turnContext(2) },
  );
  assert.ok(
    replies.slice(replyStart).some((call) => call.text.includes(multilineMarker)),
    'multiline marker must be delivered',
  );

  replyStart = replies.length;
  const followupMarker = `FOLLOWUP-${suffix}`;
  failureStage = 'follow-up-fold';
  const foldStarted = waitForGateEventSequence({
    emitter: proc,
    timeoutMs: 60_000,
    label: 'fold turn pickup',
    steps: [
      {
        eventName: 'turn-start',
        matches: (event) => String(event?.anchorMsgId) === '3',
      },
      {
        eventName: 'tool-use',
        matches: (toolName) => toolName === 'Bash',
      },
    ],
  });
  const foldTurn = proc.send(
    'Run `sleep 6` with Bash, then answer this message and every follow-up '
      + 'channel message received during the sleep in one final reply.',
    { timeoutMs: 150_000, maxTurnMs: 180_000, context: turnContext(3) },
  );
  await foldStarted;
  await sleep(1_000);
  const injected = proc.injectUserMessage({
    content: `Include exactly ${followupMarker} in the combined reply.`,
    priority: 'next',
    msgId: 4,
    source: 'autosteer',
  });
  assert.equal(injected, true, 'mid-turn follow-up must be accepted');
  const injectedId = [...proc.inputLedger]
    .find(([, entry]) => entry.source === 'autosteer')?.[0];
  await foldTurn;
  await sleep(4_000);
  processTree = mergeProcessTrees(processTree, captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: 'after-fold',
  }));
  assert.ok(
    replies.slice(replyStart).some((call) => call.text.includes(followupMarker)),
    'folded follow-up marker must be delivered',
  );
  assert.ok(
    ['seen', 'resolved'].includes(proc.inputLedger.get(injectedId)?.state),
    'folded follow-up must be acknowledged instead of dropped',
  );

  failureStage = 'interrupt';
  const cancelTurn = proc.send(
    'Run `sleep 30` with Bash. Do not reply until the command finishes.',
    {
      timeoutMs: 120_000,
      maxTurnMs: 150_000,
      context: turnContext(INTERRUPT_SOURCE_MSG_ID),
    },
  );
  cancelTurn.catch(() => {});
  await sleep(4_000);
  await proc.interrupt();
  const cancelled = await cancelTurn;
  assert.equal(cancelled.metrics?.resultSubtype, 'interrupted');
  assert.equal(spawnCount, 1);
  assert.equal(proc.claudeSessionId, sessionAtStart);
  processTree = mergeProcessTrees(processTree, captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: 'after-interrupt',
  }));

  replyStart = replies.length;
  const warmMarker = `CLI-WARM-${suffix}`;
  failureStage = 'warm-reply';
  await proc.send(
    `Reply through the channel reply tool with exactly ${warmMarker}.`,
    { timeoutMs: 120_000, maxTurnMs: 150_000, context: turnContext(6) },
  );
  assert.ok(
    replies.slice(replyStart).some((call) => call.text.includes(warmMarker)),
    'warm process must answer after interruption',
  );
  assert.equal(spawnCount, 1, 'interruption must not respawn the CLI process');

  replyStart = replies.length;
  failureStage = 'file-reply';
  const fileMarker = `FILE-OK-${suffix}`;
  const fileSessionPath = sessionLogPath(cwd, proc.claudeSessionId);
  const terminalBeforeFile = readGateSessionTerminalState(fileSessionPath);
  const fileSequenceState = {};
  const fileLifecycle = waitForGateEventSequence({
    emitter: proc,
    timeoutMs: 120_000,
    label: 'file reply lifecycle',
    state: fileSequenceState,
    steps: [
      {
        eventName: 'turn-start',
        matches: (event) => String(event?.anchorMsgId) === '7',
      },
      {
        eventName: 'tool-use-detail',
        matches: (event) => (
          event?.name === 'mcp__polygram-gate-bridge__reply'
          && event?.input?.text === fileMarker
        ),
        capture: (event, sequenceState) => {
          sequenceState.toolUseId = event.toolUseId;
        },
      },
      {
        eventName: 'tool-result',
        matches: (event, sequenceState) => (
          event?.name === 'mcp__polygram-gate-bridge__reply'
          && event?.toolUseId === sequenceState.toolUseId
          && event?.isError === false
        ),
      },
      {
        eventName: 'stop-hook',
        matches: () => true,
      },
    ],
  });
  const fileTurn = proc.send(
    'Create a UTF-8 text file containing exactly FILE-CONTENT-OK in the allowed '
      + `attachment staging directory, then call reply with text exactly ${fileMarker} `
      + 'and attach that file.',
    { timeoutMs: 120_000, maxTurnMs: 150_000, context: turnContext(7) },
  );
  await Promise.all([fileTurn, fileLifecycle]);
  await waitForGateSessionTerminal({
    filePath: fileSessionPath,
    afterTurnDurationCount: terminalBeforeFile.turnDurationCount,
    timeoutMs: 15_000,
  });
  assert.ok(
    replies.slice(replyStart).some((call) => call.text.includes(fileMarker)),
    'file reply marker must be delivered',
  );
  assert.equal(fileObserved, true, 'reply tool must receive the staged file');
  processTree = mergeProcessTrees(processTree, captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: 'after-file-reply',
  }));

  failureStage = 'collecting-evidence';
  ({
    lifecycle,
    lifecycleSources,
    lifecycleProofs,
  } = copyAndNormalizeLifecycle(proc, cwd, selection));
  assert.ok(lifecycle.hooks?.some((event) => event.hookEventName === 'Stop'));
  assert.ok(lifecycle.session?.some((event) => event.type === 'assistant'));
  resolvedModel = resolveGateLifecycleModel({
    records: lifecycle.session,
    expectedModel: selection.model,
    label: 'CLI session',
  });

  const wrapperRecords = readWrapperRecords(selection);
  const observedClaudeProcesses = selectedBinaryProcesses(
    selection,
    processTree,
  );
  assert.ok(
    observedClaudeProcesses.length > 0,
    'process tree must contain the selected Claude executable',
  );
  validateWrapperProvenance(selection, wrapperRecords, {
    observedClaudeProcesses,
  });

  failureStage = 'complete';
  status = 'PASS';
} catch (error) {
  failureHash = hashSensitiveString(error?.stack || error?.message || String(error));
  writePrivateGateFailure(selection.artifactDir, error);
  console.error(`FAIL (${failureHash.slice(0, 12)})`);
} finally {
  if (proc) {
    try {
      if (Object.keys(lifecycle).length === 0) {
        ({
          lifecycle,
          lifecycleSources,
          lifecycleProofs,
        } = copyAndNormalizeLifecycle(proc, cwd, selection));
      }
    } catch {}
    try {
      await proc.kill('gate-complete');
    } catch {}
  }
  makeTreePrivate(cwd);

  const wrapperRecords = readWrapperRecords(selection);
  writeSanitizedGateResult(selection.artifactDir, {
    evidenceSchemaVersion: 1,
    matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'cli-contract',
    scenario: 'cli-contract-matrix',
    status,
    failureHash,
    failureStage: status === 'PASS' ? null : failureStage,
    attestation: selection.sanitizedAttestation,
    resolvedModel,
    spawnCount,
    replyCount: replies.filter((call) => call.toolName === 'reply').length,
    fileObserved,
    startupHandshake,
    eventKinds: eventKinds.map(hashSensitiveString),
    processTree: processTree.map((record) => ({
      pid: record.pid,
      ppid: record.ppid,
      executablePathHash: record.executablePathHash,
    })),
    wrapperRecords,
    lifecycle,
    lifecycleSources,
    lifecycleProofs,
  });
}

console.log('attestation:', JSON.stringify(selection.sanitizedAttestation));
console.log(status);
process.exit(status === 'PASS' ? 0 : 1);

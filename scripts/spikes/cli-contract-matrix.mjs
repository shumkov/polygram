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
  copyPrivateGateArtifact,
  normalizeGateJsonl,
  readWrapperRecords,
  validateWrapperProvenance,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import {
  captureTmuxProcessTree,
  mergeProcessTrees,
  selectedBinaryPids,
} from './process-tree-evidence.mjs';

const require = createRequire(import.meta.url);
const { CliProcess, createTmuxRunner } = require('@shumkov/orchestra');
const { sessionLogPath } = require('../../lib/util/claude-session-jsonl');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const output = {};
  const sessionPath = sessionLogPath(cwd, proc.claudeSessionId);
  if (fs.existsSync(sessionPath)) {
    const privateSession = copyPrivateGateArtifact(
      sessionPath,
      selection.artifactDir,
      'session.jsonl',
    );
    output.session = normalizeGateJsonl(privateSession);
  }
  if (proc._hookNdjsonPath && fs.existsSync(proc._hookNdjsonPath)) {
    const privateHooks = copyPrivateGateArtifact(
      proc._hookNdjsonPath,
      selection.artifactDir,
      'hooks.ndjson',
    );
    output.hooks = normalizeGateJsonl(privateHooks);
  }
  return output;
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
let processTree = [];
let resolvedModel = null;
let status = 'FAIL';
let failureHash = null;

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
    bridgeServerName: 'polygram-gate-bridge',
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

  const chatConfig = {
    cwd,
    model: selection.model,
    effort: selection.effort,
    permissionMode: 'bypassPermissions',
    isolateUserConfig: true,
  };
  await proc.start({
    cwd,
    chatConfig,
    threadId: 220,
    existingSessionId: null,
  });
  assert.equal(proc.model, selection.model);
  assert.equal(proc.effort, selection.effort);
  assert.equal(spawnCount, 1);
  const sessionAtStart = proc.claudeSessionId;
  processTree = captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: 'startup',
  });

  let replyStart = replies.length;
  const readyMarker = `CLI-READY-${suffix}`;
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
  const foldTurn = proc.send(
    'Run `sleep 6` with Bash, then answer this message and every follow-up '
      + 'channel message received during the sleep in one final reply.',
    { timeoutMs: 150_000, maxTurnMs: 180_000, context: turnContext(3) },
  );
  await sleep(3_000);
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

  const cancelTurn = proc.send(
    'Run `sleep 30` with Bash. Do not reply until the command finishes.',
    { timeoutMs: 120_000, maxTurnMs: 150_000, context: turnContext(5) },
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
  await proc.send(
    'Create a UTF-8 text file containing exactly FILE-CONTENT-OK in the allowed '
      + 'attachment staging directory, then call reply with text FILE-OK and attach that file.',
    { timeoutMs: 120_000, maxTurnMs: 150_000, context: turnContext(7) },
  );
  assert.ok(
    replies.slice(replyStart).some((call) => call.text.includes('FILE-OK')),
    'file reply marker must be delivered',
  );
  assert.equal(fileObserved, true, 'reply tool must receive the staged file');
  processTree = mergeProcessTrees(processTree, captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: 'after-file-reply',
  }));

  lifecycle = copyAndNormalizeLifecycle(proc, cwd, selection);
  assert.ok(lifecycle.hooks?.some((event) => event.hookEventName === 'Stop'));
  assert.ok(lifecycle.session?.some((event) => event.type === 'assistant'));
  const initModels = lifecycle.session
    .filter((event) => event.type === 'system' && event.subtype === 'init')
    .map((event) => event.model)
    .filter(Boolean);
  assert.ok(initModels.length > 0, 'session must contain an observed init model');
  assert.ok(
    initModels.every((model) => model === selection.model),
    'observed init model must match the configured comparator model',
  );
  resolvedModel = initModels.at(-1);

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
      if (Object.keys(lifecycle).length === 0) {
        lifecycle = copyAndNormalizeLifecycle(proc, cwd, selection);
      }
    } catch {}
    try {
      await proc.kill('gate-complete');
    } catch {}
  }

  const wrapperRecords = readWrapperRecords(selection);
  writeSanitizedGateResult(selection.artifactDir, {
    evidenceSchemaVersion: 1,
    matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || 'cli-contract',
    scenario: 'cli-contract-matrix',
    status,
    failureHash,
    attestation: selection.sanitizedAttestation,
    resolvedModel,
    spawnCount,
    replyCount: replies.filter((call) => call.toolName === 'reply').length,
    fileObserved,
    eventKinds,
    processTree: processTree.map((record) => ({
      pid: record.pid,
      ppid: record.ppid,
      executablePathHash: record.executablePathHash,
    })),
    wrapperRecords,
    lifecycle,
  });
}

console.log('attestation:', JSON.stringify(selection.sanitizedAttestation));
console.log(status);
process.exit(status === 'PASS' ? 0 : 1);

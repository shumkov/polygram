#!/usr/bin/env node

// Candidate-only gate for the system-prompt snapshot contract.
//
// Claude Code can record the appended system prompt once per conversation and
// replay that record on every --resume. Orchestra rebuilds the display hint on
// every spawn and therefore passes `--system-prompt-snapshot off`. This gate
// runs the same two-spawn flow twice through Orchestra's CliProcess: spawn
// with display hint FIRST, answer one turn, stop, strictly resume the same
// session with display hint SECOND, and ask which marker the prompt carries.
// A session launcher forces the snapshot on where a spawn needs recording.
//
// - control leg: snapshot on for both spawns. Seeing FIRST proves the
//   service records and replays the prompt for this account.
// - test leg: the first spawn records with the snapshot on, then the resume
//   uses the unmodified CliProcess launch (snapshot off), as a production
//   chat does after a restart. It must see SECOND despite the recording.
//
// If the control also sees SECOND, recording is not active for this account,
// the test leg proves nothing, and the result is NOT-APPLICABLE, not PASS.
// Both legs' transcripts and markers stay private so the matrix can re-derive
// the observed hints.
//
// Side effects: two gate-owned cwds under the run artifact directory and their
// Claude session files, registered for acceptance cleanup.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  createClaudeGateSelection,
  hashSensitiveString,
  registerGateSessionProject,
  withClaudeGateTmuxEnv,
} from './claude-executable.mjs';
import {
  collectGateSessionEvidence,
  copyPrivateGateArtifact,
  readGateJsonlRecords,
  readWrapperRecords,
  resolveGateLifecycleModel,
  validateWrapperProvenance,
  writePrivateGateFailure,
  writeSanitizedGateResult,
} from './claude-gate-evidence.mjs';
import {
  MATRIX_NOT_APPLICABLE_EXIT_CODE,
  snapshotHintFromTranscript,
} from './claude-gate-matrix.mjs';
import { makeTreePrivate } from './workflow-fixture.mjs';
import {
  captureTmuxProcessTree,
  mergeProcessTrees,
  selectedBinaryProcesses,
} from './process-tree-evidence.mjs';

const require = createRequire(import.meta.url);
const { CliProcess, createTmuxRunner } = require('@shumkov/orchestra');
const { sessionLogPath } = require('../../lib/util/claude-session-jsonl');

const SCENARIO = 'candidate-system-prompt-snapshot';
const BRIDGE_SERVER_NAME = 'polygram-snapshot-gate-bridge';
const CHAT_ID = '-999000283';
const THREAD_ID = 283;
const snapshotOnLauncher = fileURLToPath(
  new URL('./system-prompt-snapshot-launcher.mjs', import.meta.url),
);
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
    user: 'gate',
  };
}

function displayHint(marker) {
  return `Gate display marker: ${marker}`;
}

function snapshotFlagAdvertised(executablePath) {
  const help = spawnSync(executablePath, ['--help'], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return /(^|\s)--system-prompt-snapshot(?![\w-])/m.test(help.stdout || '');
}

function countSnapshotOnSpawns(selection) {
  const recordsPath = path.join(selection.artifactDir, 'snapshot-launcher.ndjson');
  if (!fs.existsSync(recordsPath)) return 0;
  return fs.readFileSync(recordsPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record?.snapshot === 'on')
    .length;
}

const selection = await createClaudeGateSelection();
const runner = withClaudeGateTmuxEnv(
  createTmuxRunner({ sessionPrefix: 'polygram-snapshot-gate', logger: console }),
  selection,
);
let spawnCount = 0;
let processTree = [];
let failureStage = 'initializing';
const liveProcesses = new Set();
const workspaces = [];

async function spawnLeg({
  legLabel,
  cwd,
  sessionLauncher,
  hint,
  existingSessionId,
  replies,
}) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const proc = new CliProcess({
    sessionKey: `snapshot-gate:${legLabel}:${suffix}`,
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    label: `snapshot-gate-${legLabel}-${suffix}`,
    tmuxRunner: {
      ...runner,
      spawn: async (options) => {
        spawnCount += 1;
        return runner.spawn(options);
      },
    },
    botName: `snapgate${suffix}`,
    claudeBin: selection.executablePath,
    sessionLauncher,
    displayHint: hint,
    toolDispatcher: async ({ toolName, text }) => {
      replies.push({
        toolName,
        text: typeof text === 'string' ? text : '',
      });
      return { ok: true, message_id: 2000 + replies.length };
    },
    logger: {
      log: () => {},
      debug: () => {},
      warn: (...args) => console.error('[snapshot-gate:warn]', ...args),
      error: (...args) => console.error('[snapshot-gate:error]', ...args),
    },
    db: { logEvent() {} },
    appDataDir: path.join(cwd, '.orchestra'),
    attachmentBase: path.join(cwd, '.attachments'),
    sessionPrefix: 'polygram-snapshot-gate',
    bridgeServerName: BRIDGE_SERVER_NAME,
    productName: 'polygram-snapshot-gate',
    surfaceName: 'synthetic channel',
    turnQuietMs: 1_500,
    stopGraceMs: 2_000,
    dropConfirmMs: 3_000,
  });
  liveProcesses.add(proc);
  await proc.start({
    cwd,
    chatConfig: {
      cwd,
      model: selection.model,
      effort: selection.effort,
      permissionMode: 'bypassPermissions',
      isolateUserConfig: true,
    },
    threadId: THREAD_ID,
    existingSessionId,
    ...(existingSessionId && {
      resumePolicy: 'require-existing-session',
      expectedSessionId: existingSessionId,
    }),
  });
  processTree = mergeProcessTrees(processTree, captureTmuxProcessTree({
    tmuxSession: proc.tmuxSession,
    selection,
    label: legLabel,
  }));
  return proc;
}

async function stopLeg(proc) {
  liveProcesses.delete(proc);
  await proc.kill('snapshot-gate-leg-complete');
}

async function runLeg(name, { firstLauncher, resumedLauncher }) {
  const cwd = path.join(selection.artifactDir, `${name}-workspace`);
  fs.mkdirSync(cwd, { mode: 0o700 });
  workspaces.push(cwd);
  registerGateSessionProject(selection, cwd);
  const markers = {
    first: `SNAPSHOT-FIRST-${crypto.randomBytes(4).toString('hex')}`,
    second: `SNAPSHOT-SECOND-${crypto.randomBytes(4).toString('hex')}`,
  };
  const replies = [];

  failureStage = `${name}-first-turn`;
  const firstProc = await spawnLeg({
    legLabel: `${name}-first`,
    cwd,
    sessionLauncher: firstLauncher,
    hint: displayHint(markers.first),
    existingSessionId: null,
    replies,
  });
  const sessionId = firstProc.claudeSessionId;
  registerGateSessionProject(selection, cwd, sessionId);
  const readyMarker = `SNAPSHOT-READY-${crypto.randomBytes(4).toString('hex')}`;
  await firstProc.send(
    `Reply through the channel reply tool with exactly ${readyMarker}.`,
    { timeoutMs: 120_000, maxTurnMs: 150_000, context: turnContext(1) },
  );
  if (!replies.some((call) => call.text.includes(readyMarker))) {
    throw new Error(`${name} leg first turn did not reply`);
  }
  await stopLeg(firstProc);

  failureStage = `${name}-resumed-turn`;
  const resumedProc = await spawnLeg({
    legLabel: `${name}-resumed`,
    cwd,
    sessionLauncher: resumedLauncher,
    hint: displayHint(markers.second),
    existingSessionId: sessionId,
    replies,
  });
  if (resumedProc.claudeSessionId !== sessionId) {
    throw new Error(`${name} leg did not resume the recorded session`);
  }
  await resumedProc.send(
    'Your system prompt contains one line that starts with "Gate display marker:". '
      + 'Reply through the channel reply tool with exactly the text after that '
      + 'prefix, copied from the system prompt as it is now, and nothing else.',
    { timeoutMs: 120_000, maxTurnMs: 150_000, context: turnContext(2) },
  );
  await stopLeg(resumedProc);
  return { cwd, sessionId, markers };
}

let status = 'FAIL';
let failureHash = null;
let controlObservedHint = null;
let testObservedHint = null;
let resolvedModel = null;
let lifecycle = {};
let lifecycleSources = {};
let lifecycleProofs = [];
let advertised = false;

try {
  advertised = snapshotFlagAdvertised(selection.executablePath);
  if (!advertised) {
    throw new Error('selected executable does not advertise --system-prompt-snapshot');
  }
  if (!selection.sessionLauncher) {
    throw new Error('snapshot gate requires the provenance wrapper launcher');
  }

  const control = await runLeg('control', {
    firstLauncher: snapshotOnLauncher,
    resumedLauncher: snapshotOnLauncher,
  });
  const testLeg = await runLeg('test', {
    firstLauncher: snapshotOnLauncher,
    resumedLauncher: selection.sessionLauncher,
  });

  failureStage = 'collecting-evidence';
  const privateControlSession = copyPrivateGateArtifact(
    sessionLogPath(control.cwd, control.sessionId),
    selection.artifactDir,
    'control-session.jsonl',
  );
  const privateSession = copyPrivateGateArtifact(
    sessionLogPath(testLeg.cwd, testLeg.sessionId),
    selection.artifactDir,
    'session.jsonl',
  );
  const markersPath = path.join(
    selection.artifactDir,
    'raw-private',
    'snapshot-markers.json',
  );
  fs.writeFileSync(markersPath, `${JSON.stringify({
    control: control.markers,
    test: testLeg.markers,
  })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(markersPath, 0o600);
  controlObservedHint = snapshotHintFromTranscript(
    readGateJsonlRecords(privateControlSession),
    control.markers,
  );
  testObservedHint = snapshotHintFromTranscript(
    readGateJsonlRecords(privateSession),
    testLeg.markers,
  );
  const sessionEvidence = collectGateSessionEvidence(privateSession);
  lifecycle = { session: sessionEvidence.records };
  lifecycleSources = { session: sessionEvidence.source };
  lifecycleProofs = sessionEvidence.proofs;
  resolvedModel = resolveGateLifecycleModel({
    records: lifecycle.session,
    expectedModel: selection.model,
    label: 'snapshot test session',
  });
  const observedClaudeProcesses = selectedBinaryProcesses(
    selection,
    processTree,
  );
  if (observedClaudeProcesses.length === 0) {
    throw new Error('process tree must contain the selected Claude executable');
  }
  validateWrapperProvenance(selection, readWrapperRecords(selection), {
    observedClaudeProcesses,
  });
  if (spawnCount !== 4 || countSnapshotOnSpawns(selection) !== 3) {
    throw new Error('snapshot gate must spawn three snapshot-on sessions and one snapshot-off resume');
  }

  failureStage = 'evaluating-snapshot';
  if (testObservedHint !== 'second') {
    throw new Error('snapshot-off resume did not see the current display hint');
  }
  if (controlObservedHint === 'first') {
    status = 'PASS';
  } else if (controlObservedHint === 'second') {
    status = 'NOT-APPLICABLE';
  } else {
    throw new Error('snapshot-on control did not report a single display hint');
  }
} catch (error) {
  status = 'FAIL';
  failureHash = hashSensitiveString(error?.stack || error?.message || String(error));
  writePrivateGateFailure(selection.artifactDir, error);
  console.error(`FAIL (${failureHash.slice(0, 12)})`);
} finally {
  for (const proc of liveProcesses) {
    try {
      await proc.kill('snapshot-gate-complete');
    } catch {}
  }
  for (const cwd of workspaces) makeTreePrivate(cwd);

  writeSanitizedGateResult(selection.artifactDir, {
    evidenceSchemaVersion: 1,
    matrixScenario: process.env.CLAUDE_GATE_SCENARIO_ID || SCENARIO,
    scenario: SCENARIO,
    status,
    failureHash,
    failureStage: status === 'FAIL' ? failureStage : null,
    attestation: selection.sanitizedAttestation,
    resolvedModel,
    spawnCount,
    snapshotOnSpawnCount: countSnapshotOnSpawns(selection),
    snapshotFlagAdvertised: advertised,
    controlObservedHint,
    testObservedHint,
    processTree: processTree.map((record) => ({
      pid: record.pid,
      ppid: record.ppid,
      executablePathHash: record.executablePathHash,
    })),
    wrapperRecords: readWrapperRecords(selection),
    lifecycle,
    lifecycleSources,
    lifecycleProofs,
  });
}

console.log('attestation:', JSON.stringify(selection.sanitizedAttestation));
console.log(status);
process.exit(
  status === 'PASS'
    ? 0
    : status === 'NOT-APPLICABLE'
      ? MATRIX_NOT_APPLICABLE_EXIT_CODE
      : 1,
);

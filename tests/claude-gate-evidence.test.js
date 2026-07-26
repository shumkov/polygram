'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '..', 'scripts', 'spikes', 'claude-gate-evidence.mjs'),
).href;
const processTreeModuleUrl = pathToFileURL(
  path.join(__dirname, '..', 'scripts', 'spikes', 'process-tree-evidence.mjs'),
).href;
const CANDIDATE_SHA = 'c'.repeat(64);
const CANDIDATE_PATH_HASH = 'd'.repeat(64);

function wrapperRecord(overrides = {}) {
  return {
    runId: 'candidate-run',
    pid: 2201,
    ppid: 2200,
    versionProbePid: 2202,
    version: '2.1.220',
    executableSha256: CANDIDATE_SHA,
    executablePathHash: CANDIDATE_PATH_HASH,
    argvHash: 'a'.repeat(64),
    argvCount: 1,
    recordedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function sdkResumeResult(lifecycle, overrides = {}) {
  return {
    evidenceSchemaVersion: 1,
    matrixScenario: 'sdk-resume',
    scenario: 'sdk-resume',
    status: 'PASS',
    attestation: {
      runId: 'sdk-resume-test',
      version: '2.1.173',
      sha256: 'a'.repeat(64),
      executablePathHash: 'b'.repeat(64),
      wrapperRequired: false,
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    resolvedModel: 'claude-sonnet-4-6',
    lifecycle,
    wrapperRecords: [],
    processEvidence: {
      rootPids: [2200],
      selectedBinaryPids: [2200],
      selectedBinaryProcesses: [{ pid: 2200, ppid: 2199 }],
      sampleCount: 1,
      samplingFailed: false,
      samplingFailureCount: 0,
      samplingErrorHash: null,
    },
    firstSessionPresent: true,
    secondSessionPresent: true,
    firstResultSubtype: 'success',
    secondResultSubtype: 'success',
    markerRecalled: true,
    reasonCount: 0,
    ...overrides,
  };
}

test('ordered gate events ignore stale Bash and reply lifecycle events', async () => {
  const { waitForGateEventSequence } = await import(moduleUrl);
  const emitter = new EventEmitter();
  const state = {};
  const pending = waitForGateEventSequence({
    emitter,
    timeoutMs: 250,
    label: 'file turn',
    state,
    steps: [
      {
        eventName: 'turn-start',
        matches: (event) => event?.anchorMsgId === 7,
      },
      {
        eventName: 'tool-use-detail',
        matches: (event) => (
          event?.name === 'mcp__polygram-gate-bridge__reply'
          && event?.input?.text === 'FILE-OK-unique'
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

  emitter.emit('tool-use', 'Bash');
  emitter.emit('stop-hook', {});
  emitter.emit('turn-start', { anchorMsgId: 6 });
  emitter.emit('turn-start', { anchorMsgId: 7 });
  emitter.emit('tool-result', {
    name: 'mcp__polygram-gate-bridge__reply',
    toolUseId: 'stale-reply',
    isError: false,
  });
  emitter.emit('stop-hook', {});
  emitter.emit('tool-use-detail', {
    name: 'mcp__polygram-gate-bridge__reply',
    input: { text: 'FILE-OK-unique' },
    toolUseId: 'target-reply',
  });
  emitter.emit('tool-result', {
    name: 'mcp__polygram-gate-bridge__reply',
    toolUseId: 'stale-reply',
    isError: false,
  });

  let settled = false;
  pending.finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'stale pre-anchor and wrong-id events must not settle');

  emitter.emit('tool-result', {
    name: 'mcp__polygram-gate-bridge__reply',
    toolUseId: 'target-reply',
    isError: false,
  });
  emitter.emit('stop-hook', {});

  assert.equal(await pending, state);
  assert.equal(state.toolUseId, 'target-reply');
  for (const eventName of [
    'turn-start',
    'tool-use-detail',
    'tool-result',
    'stop-hook',
  ]) {
    assert.equal(emitter.listenerCount(eventName), 0);
  }
});

test('ordered gate event timeout removes every listener', async () => {
  const { waitForGateEventSequence } = await import(moduleUrl);
  const emitter = new EventEmitter();
  await assert.rejects(waitForGateEventSequence({
    emitter,
    timeoutMs: 10,
    label: 'fold turn',
    steps: [
      {
        eventName: 'turn-start',
        matches: (event) => event?.anchorMsgId === 3,
      },
      {
        eventName: 'tool-use',
        matches: (toolName) => toolName === 'Bash',
      },
    ],
  }), /fold turn.*timed out/i);
  assert.equal(emitter.listenerCount('turn-start'), 0);
  assert.equal(emitter.listenerCount('tool-use'), 0);
});

test('terminal session waiter blocks after Stop until a new durable suffix exists', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-terminal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
  ].join('\n') + '\n');

  const {
    readGateSessionTerminalState,
    waitForGateSessionTerminal,
  } = await import(moduleUrl);
  const before = readGateSessionTerminalState(sessionPath);
  assert.equal(before.turnDurationCount, 1);

  const pending = waitForGateSessionTerminal({
    filePath: sessionPath,
    afterTurnDurationCount: before.turnDurationCount,
    timeoutMs: 250,
    pollMs: 5,
  });
  fs.appendFileSync(
    sessionPath,
    `${JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' })}\n`,
  );
  let settled = false;
  pending.finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, 'Stop summary alone is not a durable terminal suffix');

  fs.appendFileSync(
    sessionPath,
    `${JSON.stringify({ type: 'system', subtype: 'turn_duration' })}\n`,
  );
  const terminal = await pending;
  assert.equal(terminal.turnDurationCount, 2);
  assert.deepEqual(terminal.pivotalSuffix, [
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'system', subtype: 'turn_duration' },
  ]);
});

test('gate failures keep full diagnostics only in private evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secret = 'sensitive-gate-failure-detail';

  const { writePrivateGateFailure } = await import(moduleUrl);
  const outputPath = writePrivateGateFailure(dir, new Error(secret));

  assert.equal(path.basename(outputPath), 'failure.txt');
  assert.equal(fs.statSync(path.dirname(outputPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(outputPath, 'utf8'), new RegExp(secret));
  assert.equal(fs.existsSync(path.join(dir, 'failure.txt')), false);
});

test('copying a raw gate artifact restricts both the gate-owned source and copy', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-private-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'hooks.ndjson');
  fs.writeFileSync(sourcePath, '{"cwd":"private"}\n', { mode: 0o644 });

  const { copyPrivateGateArtifact } = await import(moduleUrl);
  const copiedPath = copyPrivateGateArtifact(
    sourcePath,
    path.join(dir, 'artifacts'),
    'hooks.ndjson',
  );

  assert.equal(fs.statSync(sourcePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(copiedPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(copiedPath)).mode & 0o777, 0o700);
});

test('gate evidence normalizer keeps lifecycle shape without message or tool bodies', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'session.jsonl');
  const secret = 'sensitive-production-body';
  fs.writeFileSync(sourcePath, [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 'private-session' }),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: secret }),
    JSON.stringify({
      type: 'assistant',
      parentUuid: 'private-parent',
      message: {
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: secret },
          { type: 'tool_use', name: 'Bash', input: { command: secret } },
        ],
      },
    }),
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: secret },
    }),
    JSON.stringify({
      type: 'user',
      parentUuid: 'private-parent',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: {
        content: `<task-notification><result>${secret}</result></task-notification>`,
      },
    }),
  ].join('\n'));

  const { normalizeGateJsonl, writeSanitizedGateResult } = await import(moduleUrl);
  const normalized = normalizeGateJsonl(sourcePath);
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /private-session|private-parent/);
  assert.deepEqual(normalized[0], {
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
  });
  assert.deepEqual(normalized[1], {
    type: 'queue-operation',
    operation: 'enqueue',
  });
  assert.deepEqual(normalized[2], {
    type: 'assistant',
    hasParent: true,
    model: 'claude-sonnet-4-6',
    stopReason: 'end_turn',
    contentTypes: ['text', 'tool_use'],
    toolNames: ['Bash'],
  });
  assert.deepEqual(normalized[3], {
    type: 'hook',
    hookEventName: 'PreToolUse',
    toolName: 'Bash',
  });
  assert.deepEqual(normalized[4], {
    type: 'user',
    hasParent: true,
    contentKind: 'string',
    contentTypes: [],
    originKind: 'task-notification',
    promptSource: 'system',
    hasTaskNotification: true,
  });

  const resultPath = writeSanitizedGateResult(
    dir,
    sdkResumeResult(normalized),
  );
  assert.equal(fs.statSync(resultPath).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(resultPath, 'utf8'), new RegExp(secret));
});

test('sanitized gate writer rejects arbitrary review-evidence keys', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { writeSanitizedGateResult } = await import(moduleUrl);

  assert.throws(() => writeSanitizedGateResult(dir, {
    matrixScenario: 'sdk-resume',
    status: 'PASS',
    arbitraryReviewPayload: 'not allowlisted',
  }), /sanitized result schema/i);
  assert.equal(fs.existsSync(path.join(dir, 'sanitized-result.json')), false);
});

test('sanitized gate writer rejects unknown nested lifecycle fields before writing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-nested-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { writeSanitizedGateResult } = await import(moduleUrl);
  const secret = 'private-nested-payload';

  assert.throws(() => writeSanitizedGateResult(
    dir,
    sdkResumeResult([{
      type: 'result',
      subtype: 'success',
      payload: secret,
    }]),
  ), /sanitized result schema/i);
  assert.equal(fs.existsSync(path.join(dir, 'sanitized-result.json')), false);
});

test('sanitized gate writer rejects private strings in allowed scalar fields', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-scalars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { writeSanitizedGateResult } = await import(moduleUrl);
  const valid = sdkResumeResult([{
    type: 'result',
    subtype: 'success',
  }]);

  for (const mutation of [
    { reasonCount: 'PRIVATE-SCALAR-LEAK' },
    { markerRecalled: 'PRIVATE-SCALAR-LEAK' },
    { firstResultSubtype: 'PRIVATE-SCALAR-LEAK' },
    { resolvedModel: 'PRIVATE-SCALAR-LEAK' },
    { scenario: 'PRIVATE-SCALAR-LEAK' },
  ]) {
    assert.throws(
      () => writeSanitizedGateResult(dir, { ...valid, ...mutation }),
      /sanitized result schema/i,
    );
  }
  assert.equal(fs.existsSync(path.join(dir, 'sanitized-result.json')), false);
});

test('sanitized gate writer preserves exact early-failure artifacts with empty lifecycle', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-early-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { writeSanitizedGateResult } = await import(moduleUrl);
  const result = sdkResumeResult({}, {
    status: 'FAIL',
    resolvedModel: null,
    processEvidence: {
      rootPids: [],
      selectedBinaryPids: [],
      selectedBinaryProcesses: [],
      sampleCount: 0,
      samplingFailed: true,
      samplingFailureCount: 1,
      samplingErrorHash: 'e'.repeat(64),
    },
    firstSessionPresent: false,
    secondSessionPresent: false,
    firstResultSubtype: null,
    secondResultSubtype: null,
    markerRecalled: false,
    reasonCount: 1,
  });

  const outputPath = writeSanitizedGateResult(dir, result);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), result);
});

test('gate evidence preserves one rejecting record for every invalid nonblank line', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-cardinality-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(sourcePath, [
    '{',
    'null',
    '"string"',
    '42',
    'true',
    '[]',
    JSON.stringify({ type: 'last-prompt' }),
    '',
  ].join('\n'));

  const { normalizeGateJsonl } = await import(moduleUrl);
  assert.deepEqual(normalizeGateJsonl(sourcePath), [
    { type: 'malformed' },
    { type: 'malformed' },
    { type: 'malformed' },
    { type: 'malformed' },
    { type: 'malformed' },
    { type: 'malformed' },
    { type: 'last-prompt' },
  ]);
});

test('task reminder proof preserves parser output at every retained input boundary', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(sourcePath, [
    JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1' }],
      },
    }),
    JSON.stringify({
      type: 'attachment',
      attachment: { type: 'task_reminder' },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'private-session',
      message: {
        id: 'assistant-1',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'sensitive-body' }],
      },
    }),
  ].join('\n'));

  const { collectGateSessionEvidence } = await import(moduleUrl);
  const evidence = collectGateSessionEvidence(sourcePath);
  assert.equal(evidence.records.length, 3);
  assert.match(evidence.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.source.rawRecordCount, 3);
  assert.equal(evidence.source.normalizedRecordCount, 3);
  assert.equal(evidence.proofs.length, 1);
  assert.deepEqual(evidence.proofs[0], {
    type: 'session-event-aggregator-removal',
    stream: 'session',
    sourceSha256: evidence.source.sha256,
    targets: [{
      record: {
        type: 'attachment',
        attachmentType: 'task_reminder',
      },
      rawTargetCount: 1,
      normalizedTargetCount: 1,
      eligibility: {
        type: 'task-reminder-v1',
      },
    }],
    totalTargetCount: 1,
    targetBatchesEmpty: true,
    retainedPushBatchesEqual: true,
    flushBatchEqual: true,
    originalEventCount: 3,
    filteredEventCount: 3,
    flattenedEventsEqual: true,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /sensitive-body|private-session/);
});

test('removal proof composes task reminder with the mainline interrupt UserPromptSubmit cancellation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-proof-union-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(sourcePath, [
    JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1' }],
      },
    }),
    JSON.stringify({
      type: 'attachment',
      attachment: { type: 'task_reminder' },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'interrupt-input',
      isSidechain: false,
      origin: { kind: 'channel', server: 'polygram-gate-bridge' },
      promptSource: 'system',
      message: {
        content: [
          '<channel source="polygram-gate-bridge" msg_id="5">',
          'private interrupt prompt',
          '</channel>',
        ].join('\n'),
      },
    }),
    JSON.stringify({
      type: 'attachment',
      parentUuid: 'interrupt-input',
      isSidechain: false,
      attachment: {
        type: 'hook_cancelled',
        hookName: 'UserPromptSubmit',
        hookEvent: 'UserPromptSubmit',
        command: 'private command',
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'text', text: 'private continuation' }],
      },
    }),
  ].join('\n'));

  const { collectGateSessionEvidence } = await import(moduleUrl);
  const evidence = collectGateSessionEvidence(sourcePath, {
    interruptSourceMsgId: 5,
    channelServerName: 'polygram-gate-bridge',
  });
  assert.equal(evidence.proofs.length, 1);
  assert.deepEqual(evidence.proofs[0], {
    type: 'session-event-aggregator-removal',
    stream: 'session',
    sourceSha256: evidence.source.sha256,
    targets: [
      {
        record: {
          type: 'attachment',
          attachmentType: 'hook_cancelled',
        },
        rawTargetCount: 1,
        normalizedTargetCount: 1,
        eligibility: {
          type: 'interrupt-user-prompt-submit-v1',
          allMainline: true,
          allHookNamesMatch: true,
          allParentsMatchInterrupt: true,
        },
      },
      {
        record: {
          type: 'attachment',
          attachmentType: 'task_reminder',
        },
        rawTargetCount: 1,
        normalizedTargetCount: 1,
        eligibility: {
          type: 'task-reminder-v1',
        },
      },
    ],
    totalTargetCount: 2,
    targetBatchesEmpty: true,
    retainedPushBatchesEqual: true,
    flushBatchEqual: true,
    originalEventCount: 2,
    filteredEventCount: 2,
    flattenedEventsEqual: true,
  });
  assert.doesNotMatch(
    JSON.stringify(evidence.proofs),
    /interrupt-input|private|command/,
  );

  const unanchoredPath = path.join(dir, 'unanchored.jsonl');
  fs.writeFileSync(
    unanchoredPath,
    fs.readFileSync(sourcePath, 'utf8').replace(
      '"parentUuid":"interrupt-input"',
      '"parentUuid":"other-input"',
    ),
  );
  assert.equal(collectGateSessionEvidence(unanchoredPath, {
    interruptSourceMsgId: 5,
    channelServerName: 'polygram-gate-bridge',
  }).proofs[0].targets.some(
    (target) => target.record.attachmentType === 'hook_cancelled',
  ), false);
});

test('task reminder proof rejects flat-equal early finalization and split assistants', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-gate-proof-red-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { collectGateSessionEvidence } = await import(moduleUrl);

  const earlyFinalizePath = path.join(dir, 'early-finalize.jsonl');
  fs.writeFileSync(earlyFinalizePath, [
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'assistant-1',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      },
    }),
    JSON.stringify({
      type: 'attachment',
      attachment: { type: 'task_reminder' },
    }),
    JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' }),
  ].join('\n'));
  const earlyProof = collectGateSessionEvidence(earlyFinalizePath).proofs[0];
  assert.equal(earlyProof.flattenedEventsEqual, true);
  assert.equal(earlyProof.originalEventCount, earlyProof.filteredEventCount);
  assert.equal(earlyProof.targetBatchesEmpty, false);
  assert.equal(earlyProof.retainedPushBatchesEqual, false);

  const splitAssistantPath = path.join(dir, 'split-assistant.jsonl');
  fs.writeFileSync(splitAssistantPath, [
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'assistant-1',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'first' }],
      },
    }),
    JSON.stringify({
      type: 'attachment',
      attachment: { type: 'task_reminder' },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'assistant-1',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'second' }],
      },
    }),
  ].join('\n'));
  const splitProof = collectGateSessionEvidence(splitAssistantPath).proofs[0];
  assert.equal(splitProof.targetBatchesEmpty, false);
  assert.equal(splitProof.flushBatchEqual, false);
});

test('wrapper provenance validation is shared and fails closed', async () => {
  const { validateWrapperProvenance } = await import(moduleUrl);
  const candidate = {
    runId: 'candidate-run',
    version: '2.1.220',
    sha256: CANDIDATE_SHA,
    sessionLauncher: '/private/wrapper',
    sanitizedAttestation: {
      executablePathHash: CANDIDATE_PATH_HASH,
    },
  };
  const validRecord = wrapperRecord();

  assert.doesNotThrow(() => validateWrapperProvenance(candidate, [validRecord], {
    observedClaudeProcesses: [
      { pid: 2200, ppid: 1000 },
      { pid: 2201, ppid: 2200 },
      { pid: 2202, ppid: 2201 },
    ],
    unwrappedRootPids: [2200],
  }));
  assert.throws(
    () => validateWrapperProvenance(candidate, []),
    /wrapper provenance is required/,
  );
  assert.throws(
    () => validateWrapperProvenance(candidate, [{
      ...validRecord,
      executableSha256: 'e'.repeat(64),
    }]),
    /does not match/,
  );
  assert.throws(
    () => validateWrapperProvenance(
      { ...candidate, sessionLauncher: null },
      [validRecord],
    ),
    /must not claim/,
  );
  assert.throws(
    () => validateWrapperProvenance(candidate, [validRecord], {
      observedClaudeProcesses: [
        { pid: 2200, ppid: 1000 },
        { pid: 2201, ppid: 2200 },
        { pid: 2202, ppid: 2201 },
        { pid: 2203, ppid: 2201 },
      ],
      unwrappedRootPids: [2200],
    }),
    (error) => {
      assert.match(error.message, /missing wrapper provenance.*2203/i);
      assert.doesNotMatch(error.message, /2202/);
      return true;
    },
  );
  assert.throws(
    () => validateWrapperProvenance(candidate, [{
      ...validRecord,
      versionProbePid: '2202',
    }], {
      observedClaudeProcesses: [
        { pid: 2200, ppid: 1000 },
        { pid: 2201, ppid: 2200 },
      ],
      unwrappedRootPids: [2200],
    }),
    /schema|invalid process identities/i,
  );
});

test('wrapper provenance requires a sampled parent match for a claimed probe', async () => {
  const { validateWrapperProvenance } = await import(moduleUrl);
  const candidate = {
    runId: 'candidate-run',
    version: '2.1.220',
    sha256: CANDIDATE_SHA,
    sessionLauncher: '/private/wrapper',
    sanitizedAttestation: {
      executablePathHash: CANDIDATE_PATH_HASH,
    },
  };
  const record = wrapperRecord();

  assert.throws(
    () => validateWrapperProvenance(candidate, [record], {
      observedClaudeProcesses: [
        { pid: 2200, ppid: 1000 },
        { pid: 2201, ppid: 2200 },
        { pid: 2202, ppid: 9999 },
      ],
      unwrappedRootPids: [2200],
    }),
    /missing wrapper provenance.*2202/i,
  );
});

test('wrapper provenance accepts a wrapped worker after it is reparented', async () => {
  const { validateWrapperProvenance } = await import(moduleUrl);
  const candidate = {
    runId: 'candidate-run',
    version: '2.1.220',
    sha256: CANDIDATE_SHA,
    sessionLauncher: '/private/wrapper',
    sanitizedAttestation: {
      executablePathHash: CANDIDATE_PATH_HASH,
    },
  };
  const record = wrapperRecord();

  assert.doesNotThrow(
    () => validateWrapperProvenance(candidate, [record], {
      observedClaudeProcesses: [
        { pid: 2200, ppid: 1000 },
        { pid: 2201, ppid: 9999 },
      ],
      unwrappedRootPids: [2200],
    }),
  );
});

test('wrapper provenance rejects another observed unwrapped selected worker', async () => {
  const { validateWrapperProvenance } = await import(moduleUrl);
  const candidate = {
    runId: 'candidate-run',
    version: '2.1.220',
    sha256: CANDIDATE_SHA,
    sessionLauncher: '/private/wrapper',
    sanitizedAttestation: {
      executablePathHash: CANDIDATE_PATH_HASH,
    },
  };
  const record = wrapperRecord();

  assert.throws(
    () => validateWrapperProvenance(candidate, [record], {
      observedClaudeProcesses: [
        { pid: 2200, ppid: 1000 },
        { pid: 2201, ppid: 2200 },
        { pid: 2202, ppid: 2201 },
        { pid: 2203, ppid: 2201 },
      ],
      unwrappedRootPids: [2200],
    }),
    /missing wrapper provenance.*2203/i,
  );
});

test('wrapper provenance rejects cross-run and ambiguous process identities', async () => {
  const { validateWrapperProvenance } = await import(moduleUrl);
  const candidate = {
    runId: 'candidate-run',
    version: '2.1.220',
    sha256: CANDIDATE_SHA,
    sessionLauncher: '/private/wrapper',
    sanitizedAttestation: {
      executablePathHash: CANDIDATE_PATH_HASH,
    },
  };
  const validRecord = wrapperRecord();

  assert.throws(
    () => validateWrapperProvenance(candidate, [{
      ...validRecord,
      runId: 'another-run',
    }]),
    /run id/i,
  );
  assert.throws(
    () => validateWrapperProvenance(candidate, [{
      ...validRecord,
      ppid: 0,
    }]),
    /schema|process identities/i,
  );
  assert.throws(
    () => validateWrapperProvenance(candidate, [{
      ...validRecord,
      versionProbePid: validRecord.pid,
    }]),
    /process identities/i,
  );
  assert.throws(
    () => validateWrapperProvenance(candidate, [
      validRecord,
      { ...validRecord, versionProbePid: 2203 },
    ]),
    /ambiguous wrapper identities/i,
  );
});

test('selected binary process helper retains parent pids and existing pid evidence', async () => {
  const {
    selectedBinaryPids,
    selectedBinaryProcesses,
  } = await import(processTreeModuleUrl);
  const selection = {
    sanitizedAttestation: {
      executablePathHash: 'selected-path-hash',
    },
  };
  const processTree = [
    { pid: 2201, ppid: 2200, executablePathHash: 'selected-path-hash' },
    { pid: 2202, ppid: 2201, executablePathHash: 'selected-path-hash' },
    { pid: 3301, ppid: 2200, executablePathHash: 'other-path-hash' },
  ];

  assert.deepEqual(selectedBinaryProcesses(selection, processTree), [
    { pid: 2201, ppid: 2200 },
    { pid: 2202, ppid: 2201 },
  ]);
  assert.deepEqual(selectedBinaryPids(selection, processTree), [2201, 2202]);
});

test('process tree capture rejects a discovered pid without executable evidence', async () => {
  const { validateCapturedProcessTree } = await import(processTreeModuleUrl);
  const incompleteRecord = {
    pid: 2202,
    ppid: 2201,
    executable: '',
    executablePathHash: null,
  };

  assert.throws(
    () => validateCapturedProcessTree([incompleteRecord]),
    /discovered pid 2202 must have executable evidence/i,
  );
  assert.throws(
    () => validateCapturedProcessTree([{
      ...incompleteRecord,
      executable: '/private/claude',
    }]),
    /discovered pid 2202 must have an executable hash/i,
  );

  const completeRecords = [{
    ...incompleteRecord,
    executable: '/private/claude',
    executablePathHash: 'selected-path-hash',
  }];
  assert.equal(validateCapturedProcessTree(completeRecords), completeRecords);
});

test('process tree capture binds pid, parent, and executable from one snapshot', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-process-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (command === 'tmux') {
      return { status: 0, stdout: '2200\n' };
    }
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-axo', 'pid=,ppid=,comm=']);
    return {
      status: 0,
      stdout: [
        '  100     1 /sbin/launchd',
        ' 2200   100 /bin/sh',
        ' 2201  2200 /private/claude',
        ' 2202  2201 /private/claude',
        ' 3300   100 /usr/bin/other',
      ].join('\n'),
    };
  };

  const { captureTmuxProcessTree } = await import(processTreeModuleUrl);
  const records = captureTmuxProcessTree({
    tmuxSession: 'gate-session',
    selection: { artifactDir: dir },
    label: 'snapshot',
    spawn,
    platform: 'darwin',
    realpath: (value) => value,
  });

  assert.deepEqual(records.map(({ pid, ppid, executable }) => ({
    pid,
    ppid,
    executable,
  })), [
    { pid: 2200, ppid: 100, executable: '/bin/sh' },
    { pid: 2201, ppid: 2200, executable: '/private/claude' },
    { pid: 2202, ppid: 2201, executable: '/private/claude' },
  ]);
  assert.equal(calls.length, 2);
});

test('macOS process-tree capture resolves a relative pane root and target basename', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-process-basename-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshot = (selectedCommand) => (command, args = []) => {
    if (command === 'tmux') return { status: 0, stdout: '2200\n' };
    if (command === 'lsof') {
      const pid = args[2];
      return {
        status: 0,
        stdout: pid === '2201'
          ? 'p2201\nftxt\nn/private/claude-2.1.220\n'
          : 'p2200\nftxt\nn/opt/homebrew/bin/fish\n',
      };
    }
    return {
      status: 0,
      stdout: [
        '2200 100 fish',
        `2201 2200 ${selectedCommand}`,
        '2202 2201 node',
      ].join('\n'),
    };
  };
  const { captureTmuxProcessTree } = await import(processTreeModuleUrl);
  const selection = {
    artifactDir: dir,
    executablePath: '/private/claude-2.1.220',
  };

  assert.deepEqual(captureTmuxProcessTree({
    tmuxSession: 'gate-session',
    selection,
    label: 'unrelated-basenames',
    spawn: snapshot('/private/claude-2.1.220'),
    platform: 'darwin',
    realpath: (value) => value,
  }).map(({ pid }) => pid), [2200, 2201]);
  assert.deepEqual(captureTmuxProcessTree({
    tmuxSession: 'gate-session',
    selection,
    label: 'target-basename',
    spawn: snapshot('claude-2.1.220'),
    platform: 'darwin',
    realpath: (value) => value,
  }).map(({ pid }) => pid), [2200, 2201]);
  assert.throws(() => captureTmuxProcessTree({
    tmuxSession: 'gate-session',
    selection,
    label: 'missing-root',
    spawn: (command) => {
      if (command === 'tmux') return { status: 0, stdout: '2200\n' };
      if (command === 'lsof') return { status: 1, stdout: '' };
      return {
        status: 0,
        stdout: '2200 100 fish\n2201 2200 /private/claude-2.1.220\n',
      };
    },
    platform: 'darwin',
    realpath: (value) => value,
  }), /could not resolve macOS executable/i);
});

test('process executable resolution is platform-specific and fails closed', async () => {
  const { resolveProcessExecutable } = await import(processTreeModuleUrl);
  const canonicalize = (value) => `/real${value}`;

  assert.equal(resolveProcessExecutable({
    pid: 2201,
    command: '/private/claude',
    platform: 'darwin',
    realpath: canonicalize,
  }), '/real/private/claude');
  assert.equal(resolveProcessExecutable({
    pid: 2201,
    command: 'claude',
    platform: 'darwin',
    realpath: canonicalize,
    resolveDarwinPid: () => '/opt/claude',
  }), '/real/opt/claude');
  assert.throws(() => resolveProcessExecutable({
    pid: 2201,
    command: 'claude',
    platform: 'darwin',
    realpath: canonicalize,
    resolveDarwinPid: () => {
      throw new Error('missing macOS executable');
    },
  }), /missing macOS executable/i);
  assert.equal(resolveProcessExecutable({
    pid: 2201,
    command: 'claude',
    platform: 'linux',
    readlink: (target) => {
      assert.equal(target, '/proc/2201/exe');
      return '/opt/claude';
    },
    realpath: canonicalize,
  }), '/real/opt/claude');
  assert.throws(() => resolveProcessExecutable({
    pid: 2201,
    command: 'claude',
    platform: 'linux',
    readlink: () => {
      throw new Error('vanished');
    },
    realpath: canonicalize,
  }), /could not resolve executable/i);
  assert.throws(() => resolveProcessExecutable({
    pid: 2201,
    command: '/private/claude',
    platform: 'win32',
    realpath: canonicalize,
  }), /unsupported platform/i);
});

test('lifecycle model resolver accepts CLI assistant evidence and rejects conflicts', async () => {
  const { resolveGateLifecycleModel } = await import(moduleUrl);
  assert.equal(resolveGateLifecycleModel({
    records: [
      { type: 'assistant', model: 'claude-sonnet-4-6' },
      { type: 'assistant' },
    ],
    expectedModel: 'claude-sonnet-4-6',
    label: 'CLI',
  }), 'claude-sonnet-4-6');
  assert.equal(resolveGateLifecycleModel({
    records: [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      { type: 'assistant', model: '<synthetic>' },
    ],
    expectedModel: 'claude-sonnet-4-6',
    label: 'SDK',
  }), 'claude-sonnet-4-6');
  assert.throws(() => resolveGateLifecycleModel({
    records: [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      { type: 'assistant', model: 'claude-opus-5' },
    ],
    expectedModel: 'claude-sonnet-4-6',
    label: 'CLI',
  }), /must match/);
  assert.throws(() => resolveGateLifecycleModel({
    records: [{ type: 'assistant' }],
    expectedModel: 'claude-sonnet-4-6',
    label: 'CLI',
  }), /observed model/);
});

test('SDK evidence requires the observed init model and complete process provenance', async () => {
  const { evaluateSdkGateEvidence } = await import(moduleUrl);
  const selection = {
    runId: 'candidate-run',
    version: '2.1.220',
    sha256: CANDIDATE_SHA,
    model: 'claude-sonnet-4-6',
    sessionLauncher: '/private/wrapper',
    sanitizedAttestation: {
      executablePathHash: CANDIDATE_PATH_HASH,
    },
  };
  const validRecord = wrapperRecord();

  assert.deepEqual(evaluateSdkGateEvidence({
    selection,
    resolvedModel: 'claude-sonnet-4-6',
    wrapperRecords: [validRecord],
    observedClaudeProcesses: [
      { pid: 2200, ppid: 1000 },
      { pid: 2201, ppid: 2200 },
    ],
    unwrappedRootPids: [2200],
    sampleCount: 1,
  }), {
    pass: true,
    reasons: [],
  });
  assert.equal(evaluateSdkGateEvidence({
    selection,
    resolvedModel: 'claude-sonnet-4-6',
    wrapperRecords: [{ ...validRecord, unexpected: true }],
    observedClaudeProcesses: [
      { pid: 2200, ppid: 1000 },
      { pid: 2201, ppid: 2200 },
    ],
    unwrappedRootPids: [2200],
    sampleCount: 1,
  }).pass, false);
  const incompleteRecord = { ...validRecord };
  delete incompleteRecord.recordedAt;
  assert.equal(evaluateSdkGateEvidence({
    selection,
    resolvedModel: 'claude-sonnet-4-6',
    wrapperRecords: [incompleteRecord],
    observedClaudeProcesses: [
      { pid: 2200, ppid: 1000 },
      { pid: 2201, ppid: 2200 },
    ],
    unwrappedRootPids: [2200],
    sampleCount: 1,
  }).pass, false);
  assert.deepEqual(evaluateSdkGateEvidence({
    selection,
    resolvedModel: 'claude-sonnet-4-6',
    wrapperRecords: [],
    observedClaudeProcesses: [{ pid: 2200, ppid: 1000 }],
    unwrappedRootPids: [2200],
    sampleCount: 1,
  }), {
    pass: true,
    reasons: [],
  });
  assert.equal(evaluateSdkGateEvidence({
    selection,
    resolvedModel: null,
    wrapperRecords: [validRecord],
    observedClaudeProcesses: [
      { pid: 2200, ppid: 1000 },
      { pid: 2201, ppid: 2200 },
    ],
    unwrappedRootPids: [2200],
    sampleCount: 1,
  }).pass, false);
  assert.equal(evaluateSdkGateEvidence({
    selection,
    resolvedModel: 'claude-sonnet-4-6',
    wrapperRecords: [],
    observedClaudeProcesses: [],
    unwrappedRootPids: [],
    sampleCount: 0,
  }).pass, false);
});

test('SDK observer fails closed and persists private process evidence when sampling failed', async (t) => {
  const { createSdkGateObserver } = await import(moduleUrl);
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-sdk-process-'));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  const selection = {
    artifactDir,
    version: '2.1.173',
    sha256: 'old-sha',
    model: 'claude-sonnet-4-6',
    sessionLauncher: null,
    sanitizedAttestation: {
      executablePathHash: 'old-path-hash',
    },
    sdkProcessEvidence: {
      rootPids: [1730],
      selectedBinaryPids: [1730],
      selectedBinaryProcesses: [{ pid: 1730, ppid: 1729 }],
      sampleCount: 1,
      samplingFailed: true,
      samplingFailureCount: 1,
      samplingErrorHash: 'a'.repeat(64),
    },
  };
  const observer = createSdkGateObserver(selection);
  observer.observe({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
  });

  const evidence = observer.finish();

  assert.equal(evidence.pass, false);
  assert.match(evidence.reasons.join('\n'), /process sampling failed/i);
  assert.equal(evidence.processEvidence.samplingFailed, true);
  assert.equal(evidence.processEvidence.samplingFailureCount, 1);
  assert.equal(evidence.processEvidence.samplingErrorHash, 'a'.repeat(64));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(
      artifactDir,
      'raw-private',
      'sdk-process-evidence.json',
    ), 'utf8')),
    evidence.processEvidence,
  );
});

test('SDK observer records normalized lifecycle and fails a missing init model', async () => {
  const { createSdkGateObserver } = await import(moduleUrl);
  const selection = {
    version: '2.1.173',
    sha256: 'old-sha',
    model: 'claude-sonnet-4-6',
    sessionLauncher: null,
    sanitizedAttestation: {
      executablePathHash: 'old-path-hash',
    },
    sdkProcessEvidence: {
      rootPids: [1730],
      selectedBinaryPids: [1730],
      selectedBinaryProcesses: [{ pid: 1730, ppid: 1729 }],
      sampleCount: 1,
    },
  };
  const observer = createSdkGateObserver(selection);
  observer.observe({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
    session_id: 'private',
  });
  observer.observe({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'private body' }],
    },
  });
  observer.observe({ type: 'result', subtype: 'success' });
  const evidence = observer.finish();

  assert.equal(evidence.pass, true);
  assert.equal(evidence.resolvedModel, 'claude-sonnet-4-6');
  assert.equal(evidence.resultSubtype, 'success');
  assert.doesNotMatch(JSON.stringify(evidence.lifecycle), /private body|private/);
  assert.equal(createSdkGateObserver(selection).finish().pass, false);

  const mixedModelObserver = createSdkGateObserver(selection);
  mixedModelObserver.observe({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
  });
  mixedModelObserver.observe({
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'private body' }],
    },
  });
  const mixedModelEvidence = mixedModelObserver.finish();
  assert.equal(mixedModelEvidence.pass, false);
  assert.match(mixedModelEvidence.reasons.join('\n'), /observed models must match/);
});

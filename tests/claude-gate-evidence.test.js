'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '..', 'scripts', 'spikes', 'claude-gate-evidence.mjs'),
).href;

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

  const resultPath = writeSanitizedGateResult(dir, {
    status: 'PASS',
    normalized,
  });
  assert.equal(fs.statSync(resultPath).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(resultPath, 'utf8'), new RegExp(secret));
});

test('wrapper provenance validation is shared and fails closed', async () => {
  const { validateWrapperProvenance } = await import(moduleUrl);
  const candidate = {
    version: '2.1.220',
    sha256: 'candidate-sha',
    sessionLauncher: '/private/wrapper',
    sanitizedAttestation: {
      executablePathHash: 'candidate-path-hash',
    },
  };
  const validRecord = {
    pid: 2201,
    version: '2.1.220',
    executableSha256: 'candidate-sha',
    executablePathHash: 'candidate-path-hash',
  };

  assert.doesNotThrow(() => validateWrapperProvenance(candidate, [validRecord], {
    observedClaudePids: [2200, 2201],
    unwrappedRootPids: [2200],
  }));
  assert.throws(
    () => validateWrapperProvenance(candidate, []),
    /wrapper provenance is required/,
  );
  assert.throws(
    () => validateWrapperProvenance(candidate, [{
      ...validRecord,
      executableSha256: 'wrong-sha',
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
      observedClaudePids: [2200, 2201, 2202],
      unwrappedRootPids: [2200],
    }),
    /missing wrapper provenance.*2202/i,
  );
});

test('SDK evidence requires the observed init model and complete process provenance', async () => {
  const { evaluateSdkGateEvidence } = await import(moduleUrl);
  const selection = {
    version: '2.1.220',
    sha256: 'candidate-sha',
    model: 'claude-sonnet-4-6',
    sessionLauncher: '/private/wrapper',
    sanitizedAttestation: {
      executablePathHash: 'candidate-path-hash',
    },
  };
  const validRecord = {
    pid: 2201,
    version: '2.1.220',
    executableSha256: 'candidate-sha',
    executablePathHash: 'candidate-path-hash',
  };

  assert.deepEqual(evaluateSdkGateEvidence({
    selection,
    resolvedModel: 'claude-sonnet-4-6',
    wrapperRecords: [validRecord],
    observedClaudePids: [2200, 2201],
    unwrappedRootPids: [2200],
  }), {
    pass: true,
    reasons: [],
  });
  assert.deepEqual(evaluateSdkGateEvidence({
    selection,
    resolvedModel: 'claude-sonnet-4-6',
    wrapperRecords: [],
    observedClaudePids: [2200],
    unwrappedRootPids: [2200],
  }), {
    pass: true,
    reasons: [],
  });
  assert.equal(evaluateSdkGateEvidence({
    selection,
    resolvedModel: null,
    wrapperRecords: [validRecord],
    observedClaudePids: [2200, 2201],
    unwrappedRootPids: [2200],
  }).pass, false);
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
});

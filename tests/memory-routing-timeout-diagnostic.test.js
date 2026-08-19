'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const ROOT = '../scripts/spikes/memory-routing-gate';

async function diagnosticModule() {
  return import(`${ROOT}/diagnose-timeouts.mjs`);
}

function diagnosticAttempt({
  status = 'accepted',
  errorCode,
  elapsedMs = 60_000,
  phase = 'awaiting_close',
  payloadValid = status === 'accepted',
  cleanupConfirmed = true,
  stdoutBytes = 100,
  stderrBytes = 0,
} = {}) {
  return {
    status,
    ...(errorCode ? { errorCode } : {}),
    diagnostics: { cleanupConfirmed },
    attemptEvidence: {
      phase,
      stdin_flush_ms: phase === 'starting' ? null : 1,
      first_stdout_ms: ['starting', 'awaiting_output'].includes(phase) ? null : 2,
      complete_json_candidate_ms: payloadValid ? 3 : null,
      stdout_end_ms: phase === 'awaiting_close' ? 4 : null,
      close_ms: cleanupConfirmed ? elapsedMs : null,
      total_elapsed_ms: elapsedMs,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      payload_valid: payloadValid,
      duration_ms: payloadValid ? Math.min(elapsedMs, 120_000) : null,
      duration_api_ms: payloadValid ? Math.min(elapsedMs, 120_000) : null,
      num_turns: payloadValid ? 1 : null,
    },
  };
}

function validPreflight(expectedModel = 'claude-haiku-exact') {
  return {
    manager_authorized: true,
    runtime_attested: true,
    authentication_attested: true,
    model_exact: true,
    prompt_manifest_exact: true,
    schema_manifest_exact: true,
    tools_prohibited: true,
    environment_allowlist_exact: true,
    security_flags_exact: true,
    paths_private: true,
    claude_version: '2.1.220 (Claude Code)',
    claude_auth: {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
    },
    expected_model: expectedModel,
  };
}

function validWitness(overrides = {}) {
  return {
    schema_version: 'polygram-memory-routing-timeout-unit-witness/v1',
    inactive: true,
    cgroup_empty: true,
    detached_child_removed: true,
    receipt_checkpoint_confirmed: true,
    cleanup_confirmed: true,
    ...overrides,
  };
}

function parsedRouterQualityAttempt({ elapsedMs = 10 } = {}) {
  const result = diagnosticAttempt({
    status: 'operational_error',
    errorCode: 'ROUTER_OUTPUT_SECRET',
    elapsedMs,
    payloadValid: false,
  });
  Object.assign(result.attemptEvidence, {
    complete_json_candidate_ms: 3,
    duration_ms: Math.min(elapsedMs, 120_000),
    duration_api_ms: Math.min(elapsedMs, 120_000),
    num_turns: 1,
  });
  return result;
}

test('U24 diagnostic rejects nonmonotonic, phase-impossible, and nonboolean attempt evidence', async () => {
  const { classifyDiagnosticEvent } = await diagnosticModule();
  const nonmonotonic = diagnosticAttempt();
  nonmonotonic.attemptEvidence.first_stdout_ms = 0;
  assert.equal(classifyDiagnosticEvent({ result: nonmonotonic }).reason, 'invalid-evidence');

  const impossiblePhase = diagnosticAttempt({
    status: 'operational_error', errorCode: 'ROUTER_TIMEOUT', phase: 'starting', payloadValid: false,
  });
  impossiblePhase.attemptEvidence.first_stdout_ms = 2;
  assert.equal(classifyDiagnosticEvent({ result: impossiblePhase }).reason, 'invalid-evidence');

  const stringPayload = diagnosticAttempt();
  stringPayload.attemptEvidence.payload_valid = 'true';
  assert.equal(classifyDiagnosticEvent({ result: stringPayload }).reason, 'invalid-evidence');
});

test('U24 diagnostic checkpoints missing attempt evidence as an out-of-band failure', async () => {
  const [{ loadRoutingFixtures }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    diagnosticModule(),
  ]);
  const outOfBand = [];
  let attemptCheckpoints = 0;
  const result = await diagnostic.runDiagnosticCampaign({
    fixtures: loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine'),
    activatedAtMs: 0,
    monotonicNowMs: () => 0,
    checkBusy: async () => false,
    routeOnce: async () => ({ status: 'operational_error', errorCode: 'ROUTER_PROCESS_EXIT' }),
    checkpointAttempt: async () => { attemptCheckpoints += 1; },
    checkpointOutOfBand: async (decision) => outOfBand.push(decision),
  });
  assert.equal(result.outcome, 'diagnostic-failure');
  assert.equal(result.reason, 'invalid-evidence');
  assert.equal(attemptCheckpoints, 0);
  assert.deepEqual(outOfBand.map(({ outcome, reason }) => [outcome, reason]), [
    ['diagnostic-failure', 'invalid-evidence'],
  ]);
  await assertMissingRouteResultCheckpoint();
  await assertMissingIntegrityEvidenceOutOfBand();
});

test('U24 diagnostic attempts an out-of-band terminal checkpoint after attempt checkpoint failure', async () => {
  const [{ loadRoutingFixtures }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    diagnosticModule(),
  ]);
  const fixtures = loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine');
  for (const outOfBandFails of [false, true]) {
    const calls = [];
    const result = await diagnostic.runDiagnosticCampaign({
      fixtures,
      activatedAtMs: 0,
      monotonicNowMs: () => 0,
      checkBusy: async () => false,
      routeOnce: async () => diagnosticAttempt(),
      checkpointAttempt: async () => { throw new Error('write failed'); },
      checkpointOutOfBand: async (decision) => {
        calls.push(decision.reason);
        if (outOfBandFails) throw new Error('out-of-band write failed');
      },
    });
    assert.equal(result.outcome, 'diagnostic-failure');
    assert.equal(result.reason, 'checkpoint-unconfirmed');
    assert.deepEqual(calls, ['checkpoint-unconfirmed']);
  }
});

test('U24 diagnostic binds every call to one attested Claude runtime', async () => {
  const diagnostic = await diagnosticModule();
  const runtime = {
    canonicalPath: '/trusted/claude-2.1.220',
    version: '2.1.220 (Claude Code)',
    sha256: 'a'.repeat(64),
    dev: 1,
    ino: 2,
    size: 3,
  };
  const adapters = [];
  let reattestations = 0;
  const result = await diagnostic.runLiveDiagnosticCampaign({
    claudeBin: '/operator/claude',
    expectedModel: 'claude-haiku-exact',
    scratchPath: '/private/scratch',
    activatedAtMs: 0,
    monotonicNowMs: () => 0,
    checkBusy: async () => false,
    checkpointAttempt: async () => {},
    checkpointOutOfBand: async () => {},
    attestRuntime: async () => runtime,
    assertRuntimeIdentityUnchanged: async (expected) => {
      assert.equal(expected, runtime);
      reattestations += 1;
    },
    createAdapter(options) {
      adapters.push(options);
      return { id: 'claude:haiku' };
    },
    runCase: async () => diagnosticAttempt(),
  });
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(adapters[0].binary, runtime.canonicalPath);
  assert.equal(reattestations, 110);
});

test('U24 receipt rejects contradictory terminal and slow evidence and validates witness shape', async () => {
  const diagnostic = await diagnosticModule();
  const receipt = {
    schema_version: 'polygram-memory-routing-timeout-diagnostic/v1',
    sequence: 1,
    preflight_complete: true,
    campaign_elapsed_ms: 1,
    attempts: [],
    terminal: {
      outcome: 'old-cap-false-rejection',
      reason: 'call-ceiling-with-slow-valid',
      next_decision: 'propose-timeout-amendment-and-rerun-u24',
    },
    out_of_band_terminal_count: 0,
  };
  assert.throws(() => diagnostic.interpretDiagnosticArtifacts(receipt, validWitness()), /terminal|receipt/);

  const wrongWitness = validWitness({ cleanup_confirmed: false });
  assert.throws(() => diagnostic.interpretDiagnosticArtifacts({
    ...receipt,
    terminal: null,
  }, wrongWitness), /unit witness/);

  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-slow-fault-'));
  const receiptPath = path.join(root, 'receipt.json');
  try {
    let stored = await diagnostic.createDiagnosticReceipt(receiptPath);
    stored = await diagnostic.checkpointDiagnosticReceipt(receiptPath, stored, {
      kind: 'preflight', campaign_elapsed_ms: 0,
    });
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(receiptPath, stored, {
      kind: 'attempt',
      campaign_elapsed_ms: 90_000,
      reason: 'payload-valid-process-boundary',
      attempt: {
        fixture_id: 'work-01', repetition: 1, ordinal: 1,
        evidence: diagnosticAttempt({
          status: 'operational_error', errorCode: 'ROUTER_PROCESS_EXIT', elapsedMs: 90_000,
        }).attemptEvidence,
        slow_valid: true,
        attempted_call_result: 'process-boundary-fault',
        terminal_result: 'process-boundary-fault',
      },
    }), /slow|attempt evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await assertReceiptSemanticGrammar();
});

test('U24 launcher derives its result only from reopened durable artifacts', async () => {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-launcher-durable-'));
  const scratchPath = path.join(root, 'polygram-u24-timeout-scratch');
  const evidencePath = path.join(root, 'evidence');
  const receiptPath = path.join(evidencePath, 'receipt.json');
  const witnessPath = path.join(evidencePath, 'unit-witness.json');
  try {
    await mkdir(scratchPath, { mode: 0o700 });
    await mkdir(evidencePath, { mode: 0o700 });
    const launcher = {
      preflight: async () => validPreflight(),
      async runService(request, runInside) {
        await runInside({
          unit_type: 'service',
          unit_identity_unique: true,
          properties: request.properties,
          runner_cgroup_member: true,
          detached_child_cgroup_member: true,
          activated_at_ms: 0,
        });
        return { outcome: 'old-cap-false-rejection' };
      },
      stop: async () => {},
      inspectFinal: async () => ({
        inactive: true, cgroup_empty: true, detached_child_removed: true,
      }),
    };
    const result = await diagnostic.runWithUnitLauncher({
      launcher,
      scratchPath,
      receiptPath,
      unitWitnessPath: witnessPath,
      expectedModel: 'claude-haiku-exact',
      runInside: async () => {
        let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
        receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
          kind: 'preflight', campaign_elapsed_ms: 0,
        });
        await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
          kind: 'out_of_band',
          campaign_elapsed_ms: 1,
          outcome: 'diagnostic-failure',
          reason: 'campaign-budget-exhausted',
        });
        return { outcome: 'old-cap-false-rejection' };
      },
    });
    assert.deepEqual([result.outcome, result.reason], [
      'diagnostic-failure', 'campaign-budget-exhausted',
    ]);
    assert.equal(JSON.parse(await readFile(witnessPath, 'utf8')).receipt_checkpoint_confirmed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 launcher records unconfirmed receipt durability in the closed unit witness', async () => {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-launcher-fsync-'));
  const scratchPath = path.join(root, 'polygram-u24-timeout-scratch');
  const evidencePath = path.join(root, 'evidence');
  const receiptPath = path.join(evidencePath, 'receipt.json');
  const witnessPath = path.join(evidencePath, 'unit-witness.json');
  try {
    await mkdir(scratchPath, { mode: 0o700 });
    await mkdir(evidencePath, { mode: 0o700 });
    const launcher = {
      preflight: async () => validPreflight(),
      async runService(request, runInside) {
        return runInside({
          unit_type: 'service', unit_identity_unique: true, properties: request.properties,
          runner_cgroup_member: true, detached_child_cgroup_member: true,
          activated_at_ms: 0,
        });
      },
      stop: async () => {},
      inspectFinal: async () => ({
        inactive: true, cgroup_empty: true, detached_child_removed: true,
      }),
    };
    const result = await diagnostic.runWithUnitLauncher({
      launcher,
      scratchPath,
      receiptPath,
      unitWitnessPath: witnessPath,
      expectedModel: 'claude-haiku-exact',
      confirmReceiptDurability: async () => false,
      runInside: async () => {
        let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
        receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
          kind: 'preflight', campaign_elapsed_ms: 0,
        });
        await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
          kind: 'out_of_band', campaign_elapsed_ms: 1,
          outcome: 'inconclusive', reason: 'production-became-busy',
        });
      },
    });
    assert.equal(result.outcome, 'diagnostic-failure');
    assert.equal(result.reason, 'cleanup-unconfirmed');
    const witness = JSON.parse(await readFile(witnessPath, 'utf8'));
    assert.equal(witness.receipt_checkpoint_confirmed, false);
    assert.equal(witness.cleanup_confirmed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 scratch cleanup is bound to the exclusively created directory identity', async () => {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-owned-scratch-'));
  const scratchPath = path.join(root, 'polygram-u24-timeout-owned');
  const movedPath = path.join(root, 'polygram-u24-timeout-moved');
  const evidence = path.join(root, 'evidence');
  const receiptPath = path.join(evidence, 'receipt.json');
  const witnessPath = path.join(evidence, 'witness.json');
  try {
    await mkdir(evidence, { mode: 0o700 });
    const ownership = await diagnostic.createOwnedScratch(scratchPath, {
      protectedPaths: [receiptPath, witnessPath],
    });
    let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'preflight', campaign_elapsed_ms: 0,
    });
    await diagnostic.createUnitWitness(witnessPath, {
      inactive: true, cgroup_empty: true, detached_child_removed: true,
      receipt_checkpoint_confirmed: true,
    });
    await rename(scratchPath, movedPath);
    await mkdir(scratchPath, { mode: 0o700 });
    await assert.rejects(diagnostic.cleanupScratchAfterEvidence({
      scratchOwnership: ownership,
      receiptPath,
      unitWitnessPath: witnessPath,
    }), /identity|ownership/);
    await access(scratchPath);
    await assert.rejects(diagnostic.cleanupScratchAfterEvidence({
      scratchPath,
      receiptPath,
      unitWitnessPath: witnessPath,
    }), /ownership/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 real systemd launcher builds an executable transient-service command', async () => {
  const diagnostic = await diagnosticModule();
  const calls = [];
  const show = [
    'ActiveState=active',
    'ControlGroup=/user.slice/u24.service',
    'KillMode=control-group',
    'RuntimeMaxUSec=4h 9min 0s',
    'TimeoutStopUSec=10s',
    'SendSIGKILL=yes',
    'RemainAfterExit=yes',
    'StandardOutput=null',
    'StandardError=null',
    'WorkingDirectory=/private/polygram-u24-timeout-scratch',
    'ActiveEnterTimestampMonotonic=1000',
  ].join('\n');
  let stopped = false;
  const execFileCommand = async (binary, argv) => {
    calls.push([binary, argv]);
    if (binary === '/usr/bin/systemctl' && argv.includes('show-environment')) return { stdout: '' };
    if (binary === '/usr/bin/systemctl' && argv.includes('--property=LoadState')) {
      return stopped
        ? { stdout: 'LoadState=not-found\nActiveState=inactive\n' }
        : { stdout: 'LoadState=not-found\n' };
    }
    if (binary === '/usr/bin/systemctl'
        && argv.includes('--property=SubState')) {
      return {
        stdout: [
          'ActiveState=active', 'SubState=exited', 'Result=success',
          'ExecMainCode=exited', 'ExecMainStatus=0',
        ].join('\n'),
      };
    }
    if (binary === '/usr/bin/systemctl' && argv.includes('show')) return { stdout: show };
    if (binary === '/usr/bin/systemctl' && argv.includes('stop')) {
      stopped = true;
      return { stdout: '' };
    }
    if (binary === '/usr/bin/systemd-run') return { stdout: '' };
    throw new Error('unexpected command');
  };
  const launcher = diagnostic.createSystemdUserLauncher({
    execFileCommand, platform: 'linux', monotonicNowMs: () => 1,
  });
  const scratchPath = '/private/polygram-u24-timeout-scratch';
  const properties = diagnostic.transientServiceProperties(scratchPath);
  const request = {
    unit_type: 'service',
    properties,
    scratch_path: scratchPath,
    receipt_path: '/private/evidence/receipt.json',
    unit_witness_path: '/private/evidence/unit.json',
    expected_model: 'claude-haiku-exact',
    inside_command: ['/usr/bin/node', '/opt/polygram/diagnose-timeouts.mjs', 'inside'],
  };
  assert.equal((await launcher.preflight(request)).manager_authorized, true);
  let outsideCallbackCalls = 0;
  await launcher.runService(request, async () => { outsideCallbackCalls += 1; });
  assert.equal(outsideCallbackCalls, 0);
  await launcher.stop(request);
  assert.deepEqual(await launcher.inspectFinal(request), {
    inactive: true,
    cgroup_empty: true,
    detached_child_removed: true,
  });
  const systemdCall = calls.find(([binary]) => binary === '/usr/bin/systemd-run');
  assert.ok(systemdCall);
  assert.ok(systemdCall[1].includes('--user'));
  assert.ok(systemdCall[1].includes('--collect'));
  assert.equal(systemdCall[1].includes('--wait'), false);
  assert.ok(systemdCall[1].includes('--property=Type=exec'));
  for (const [key, value] of Object.entries(properties)) {
    assert.ok(systemdCall[1].includes(`--property=${key}=${value}`));
  }
  assert.ok(systemdCall[1].includes('/usr/bin/node'));
  assert.ok(systemdCall[1].some((value) => value.startsWith('--unit=polygram-u24-timeout-')));
});

test('U24 shared Claude attestation binds canonical path, version, digest, and file identity', async () => {
  const runtime = await import(`${ROOT}/runtime-attestation.mjs`);
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-runtime-'));
  const binary = path.join(root, 'claude');
  try {
    await writeFile(binary, [
      '#!/bin/sh',
      "printf '2.1.220 (Claude Code)\\n'",
      '',
    ].join('\n'), { mode: 0o700 });
    const receipt = await runtime.attestClaudeRuntime(binary);
    assert.equal(receipt.canonicalPath, await realpath(binary));
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(receipt.dev));
    assert.ok(Number.isInteger(receipt.ino));
    await runtime.assertClaudeRuntimeUnchanged(receipt);
    await writeFile(binary, `${await readFile(binary, 'utf8')}# changed\n`, { mode: 0o700 });
    await assert.rejects(runtime.assertClaudeRuntimeUnchanged(receipt), /RUNTIME_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 production busy check uses both fixed authenticated IPC identities and fails closed', async () => {
  const diagnostic = await diagnosticModule();
  const calls = [];
  const idle = await diagnostic.checkProductionBusy({
    execFileCommand: async (binary, argv, options) => {
      calls.push([binary, argv, options]);
      return { stdout: JSON.stringify({ bot: argv[0], in_flight: 0 }), stderr: '' };
    },
  });
  assert.equal(idle, false);
  assert.deepEqual(calls.map(([, argv]) => argv), [
    ['shumabit', 'busy'], ['umi-assistant', 'busy'],
  ]);
  assert.ok(calls.every(([binary]) => binary === '/usr/bin/polygram-ipc'));
  assert.ok(calls.every(([, , options]) => (
    options.env.POLYGRAM_IPC_DIR === '/home/shumabit/polygram/.ipc'
      && options.timeout === 10_000 && options.maxBuffer === 4_096
  )));
  assert.equal(await diagnostic.checkProductionBusy({
    execFileCommand: async (_binary, argv) => ({
      stdout: JSON.stringify({ bot: argv[0], in_flight: argv[0] === 'shumabit' ? 1 : 0 }),
      stderr: '',
    }),
  }), true);
  await assert.rejects(diagnostic.checkProductionBusy({
    execFileCommand: async () => ({
      stdout: JSON.stringify({ bot: 'wrong', in_flight: 0 }), stderr: '',
    }),
  }), /busy check/);
});

test('U24 inside mode independently verifies its unit before checkpointing or routing', async () => {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-inside-'));
  const scratchPath = path.join(root, 'polygram-u24-timeout-inside');
  const evidencePath = path.join(root, 'evidence');
  const receiptPath = path.join(evidencePath, 'receipt.json');
  const unitWitnessPath = path.join(evidencePath, 'unit.json');
  const events = [];
  try {
    await mkdir(scratchPath, { mode: 0o700 });
    await mkdir(evidencePath, { mode: 0o700 });
    const result = await diagnostic.runInsideSystemdDiagnostic({
      unitName: 'polygram-u24-timeout-00000000-0000-4000-8000-000000000000.service',
      claudeBin: '/trusted/claude',
      expectedModel: 'claude-haiku-exact',
      scratchPath,
      receiptPath,
      unitWitnessPath,
      verifyUnit: async () => {
        events.push('verify-unit');
        return {
          unit_type: 'service', unit_identity_unique: true,
          properties: diagnostic.transientServiceProperties(scratchPath),
          runner_cgroup_member: true, detached_child_cgroup_member: true,
          activated_at_ms: Number(process.hrtime.bigint() / 1_000_000n),
        };
      },
      buildPreflight: async () => {
        events.push('attest-runtime-auth');
        return {
          runtime: { canonicalPath: '/trusted/claude' },
          evidence: validPreflight(),
        };
      },
      runCampaign: async (options) => {
        events.push('route');
        await options.checkpointOutOfBand({
          outcome: 'inconclusive', reason: 'production-became-busy',
        });
        return { outcome: 'inconclusive' };
      },
      checkBusy: async () => false,
    });
    assert.equal(result.outcome, 'inconclusive');
    assert.deepEqual(events, ['verify-unit', 'attest-runtime-auth', 'route']);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.preflight_complete, true);
    assert.equal(receipt.terminal.outcome, 'inconclusive');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 inside cgroup verifier requires exact properties and detached-child membership', async () => {
  const diagnostic = await diagnosticModule();
  const controlGroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/u24.service';
  const scratchPath = '/private/polygram-u24-timeout-inside';
  const show = [
    'ActiveState=active',
    `ControlGroup=${controlGroup}`,
    'KillMode=control-group',
    'RuntimeMaxUSec=4h 9min 0s',
    'TimeoutStopUSec=10s',
    'SendSIGKILL=yes',
    'RemainAfterExit=yes',
    'StandardOutput=null',
    'StandardError=null',
    `WorkingDirectory=${scratchPath}`,
    'ActiveEnterTimestampMonotonic=1000',
  ].join('\n');
  const child = new EventEmitter();
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  let killed = 0;
  child.kill = () => {
    killed += 1;
    child.signalCode = 'SIGKILL';
    queueMicrotask(() => child.emit('exit'));
  };
  const result = await diagnostic.verifyInsideSystemdUnit({
    platform: 'linux',
    unitName: 'polygram-u24-timeout-00000000-0000-4000-8000-000000000000.service',
    scratchPath,
    execFileCommand: async () => ({ stdout: show }),
    readFileCommand: async (file) => {
      assert.ok(file === '/proc/self/cgroup' || file === '/proc/123/cgroup');
      return `0::${controlGroup}\n`;
    },
    spawnCommand: () => child,
  });
  assert.equal(result.runner_cgroup_member, true);
  assert.equal(result.detached_child_cgroup_member, true);
  assert.equal(killed, 1);

  const capabilityChild = new EventEmitter();
  capabilityChild.pid = 124;
  capabilityChild.exitCode = null;
  capabilityChild.signalCode = null;
  let capabilityKilled = 0;
  let capabilityUnref = 0;
  capabilityChild.kill = () => { capabilityKilled += 1; };
  capabilityChild.unref = () => { capabilityUnref += 1; };
  await diagnostic.verifyInsideSystemdUnit({
    platform: 'linux',
    unitName: 'polygram-u24-timeout-00000000-0000-4000-8000-000000000000.service',
    scratchPath,
    leaveDetachedChildForUnitStop: true,
    execFileCommand: async () => ({ stdout: show }),
    readFileCommand: async () => `0::${controlGroup}\n`,
    spawnCommand: () => capabilityChild,
  });
  assert.equal(capabilityKilled, 0);
  assert.equal(capabilityUnref, 1);
});

test('U24 diagnostic CLI exposes only the bounded launch, inside, and capability modes', async () => {
  const diagnostic = await diagnosticModule();
  assert.deepEqual(diagnostic.parseDiagnosticArgs([
    'launch',
    '--claude-bin', '/opt/claude',
    '--expected-model', 'claude-haiku-exact',
    '--scratch', '/private/polygram-u24-timeout-run',
    '--receipt', '/private/evidence/receipt.json',
    '--unit-witness', '/private/evidence/unit.json',
    '--destination', '/private/durable',
  ]), {
    mode: 'launch',
    claudeBin: '/opt/claude',
    expectedModel: 'claude-haiku-exact',
    scratchPath: '/private/polygram-u24-timeout-run',
    receiptPath: '/private/evidence/receipt.json',
    unitWitnessPath: '/private/evidence/unit.json',
    destinationDirectory: '/private/durable',
  });
  assert.throws(() => diagnostic.parseDiagnosticArgs(['launch', '--scratch', '/tmp/x']), /missing/);
  assert.throws(() => diagnostic.parseDiagnosticArgs(['shell', '--command', 'rm']), /mode/);
});
test('U24 timeout diagnostic exposes the exact wall and transient-service contract', async () => {
  const diagnostic = await diagnosticModule();
  assert.deepEqual(diagnostic.DIAGNOSTIC_LIMITS, {
    repetitions: 5,
    fixtureCount: 22,
    callCeiling: 110,
    softDeadlineMs: 60_000,
    hardDeadlineMs: 120_000,
    cleanupMs: 5_000,
    checkpointReserveMs: 5_000,
    callReservationMs: 130_000,
    runtimeMaxMs: 14_940_000,
    stopWindowMs: 10_000,
    outerMaximumMs: 14_950_000,
    terminalCheckpointMs: 14_930_000,
    maxSequence: 112,
  });
  assert.deepEqual(diagnostic.transientServiceProperties('/private/scratch'), {
    KillMode: 'control-group',
    RuntimeMaxSec: '14940s',
    TimeoutStopSec: '10s',
    SendSIGKILL: 'yes',
    RemainAfterExit: 'yes',
    StandardOutput: 'null',
    StandardError: 'null',
    WorkingDirectory: '/private/scratch',
  });
});

test('U24 timeout diagnostic implements all precedence rows and next decisions', async () => {
  const { classifyDiagnosticEvent, nextDecisionFor } = await diagnosticModule();
  const priorSlow = [{ slow_valid: true }];
  const cases = [
    [{ integrityFailure: true }, 'diagnostic-failure'],
    [{ result: diagnosticAttempt({ elapsedMs: Number.NaN }) }, 'diagnostic-failure'],
    [{ result: diagnosticAttempt({ status: 'operational_error', errorCode: 'ROUTER_TIMEOUT', cleanupConfirmed: false }) }, 'diagnostic-failure'],
    [{ productionBusy: true }, 'inconclusive'],
    [{ result: diagnosticAttempt({ status: 'operational_error', errorCode: 'ROUTER_OUTPUT_TOO_LARGE', stdoutBytes: 'over_limit' }) }, 'diagnostic-failure'],
    [{ result: diagnosticAttempt({ status: 'operational_error', errorCode: 'ROUTER_PROCESS_EXIT', payloadValid: true }) }, 'process-boundary-fault'],
    [{ result: { ...parsedRouterQualityAttempt(), status: 'mismatch', errorCode: 'ROUTER_EXPECTATION_MISMATCH' } }, 'router-quality-failure'],
    [{ result: diagnosticAttempt({ status: 'operational_error', errorCode: 'ROUTER_TIMEOUT', phase: 'awaiting_output', elapsedMs: 120_000 }) }, 'route-unsuitable-at-diagnostic-ceiling'],
    [{ result: diagnosticAttempt({ status: 'operational_error', errorCode: 'ROUTER_TIMEOUT', phase: 'starting', elapsedMs: 120_000 }) }, 'diagnostic-failure'],
    [{ result: diagnosticAttempt({ status: 'operational_error', errorCode: 'ROUTER_OUTPUT_MALFORMED' }) }, 'diagnostic-failure'],
    [{ result: diagnosticAttempt({ elapsedMs: 60_001 }) }, null, true],
    [{ result: diagnosticAttempt({ elapsedMs: 60_000 }) }, null, false],
    [{ runnerDied: true }, 'diagnostic-failure'],
    [{ reservationFits: false }, 'diagnostic-failure'],
    [{ result: diagnosticAttempt(), callOrdinal: 110, priorAttempts: priorSlow }, 'old-cap-false-rejection'],
  ];
  for (const [input, outcome, slowValid] of cases) {
    const classified = classifyDiagnosticEvent(input);
    assert.equal(classified.outcome, outcome, JSON.stringify(input));
    if (slowValid !== undefined) assert.equal(classified.slow_valid, slowValid);
  }
  const outcomes = [
    'old-cap-false-rejection',
    'process-boundary-fault',
    'route-unsuitable-at-diagnostic-ceiling',
    'router-quality-failure',
    'diagnostic-failure',
    'inconclusive',
  ];
  assert.deepEqual(outcomes.map((outcome) => nextDecisionFor(outcome)), [
    'propose-timeout-amendment-and-rerun-u24',
    'fix-adapter-process-boundary-and-rerun-diagnostic',
    'choose-alternate-route-or-queue-tolerant-policy',
    'revise-router-contract-or-prompt-in-reviewed-plan',
    'fix-review-and-rerun-changed-diagnostic',
    'preserve-u24-stop-and-choose-alternate-policy',
  ]);
});

test('U24 timeout campaign calls 22 fixtures five times once each and preserves earlier slow evidence', async () => {
  const [{ loadRoutingFixtures }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    diagnosticModule(),
  ]);
  const fixtures = loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine');
  const calls = [];
  const checkpoints = [];
  const complete = await diagnostic.runDiagnosticCampaign({
    fixtures,
    activatedAtMs: 0,
    monotonicNowMs: () => 0,
    checkBusy: async () => false,
    routeOnce: async ({ fixture, repetition, callOrdinal, timeoutMs }) => {
      calls.push([fixture.id, repetition, callOrdinal, timeoutMs]);
      return diagnosticAttempt();
    },
    checkpointAttempt: async (attempt) => checkpoints.push(structuredClone(attempt)),
    checkpointOutOfBand: async () => {},
  });
  assert.equal(calls.length, 110);
  assert.equal(checkpoints.length, 110);
  assert.equal(complete.outcome, 'inconclusive');
  assert.deepEqual(calls.map(([fixtureId]) => fixtureId), Array.from(
    { length: 5 },
    () => fixtures.map((fixture) => fixture.id),
  ).flat());
  assert.ok(calls.every(([, , ordinal, timeoutMs], index) => (
    ordinal === index + 1 && timeoutMs === 120_000
  )));

  let busyChecks = 0;
  let terminalCalls = 0;
  const terminal = await diagnostic.runDiagnosticCampaign({
    fixtures,
    activatedAtMs: 0,
    monotonicNowMs: () => 0,
    checkBusy: async () => { busyChecks += 1; return false; },
    routeOnce: async () => {
      terminalCalls += 1;
      if (terminalCalls === 1) return diagnosticAttempt({ elapsedMs: 60_001 });
      return diagnosticAttempt({
        status: 'operational_error', errorCode: 'ROUTER_TIMEOUT',
        phase: 'awaiting_output', elapsedMs: 120_000,
      });
    },
    checkpointAttempt: async () => {},
    checkpointOutOfBand: async () => {},
  });
  assert.equal(terminal.outcome, 'route-unsuitable-at-diagnostic-ceiling');
  assert.equal(terminal.attempts.length, 2);
  assert.equal(terminal.attempts[0].slow_valid, true);
  assert.equal(terminal.attempts.some((attempt) => attempt.slow_valid), true);
  assert.equal(busyChecks, 2);
});

test('U24 timeout campaign checks busy and reservation before every spawn', async () => {
  const [{ loadRoutingFixtures }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    diagnosticModule(),
  ]);
  const fixtures = loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine');
  let calls = 0;
  let busyChecks = 0;
  const busy = await diagnostic.runDiagnosticCampaign({
    fixtures,
    activatedAtMs: 0,
    monotonicNowMs: () => 0,
    checkBusy: async () => { busyChecks += 1; return busyChecks === 2; },
    routeOnce: async () => { calls += 1; return diagnosticAttempt(); },
    checkpointAttempt: async () => {},
    checkpointOutOfBand: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(busyChecks, 2);
  assert.equal(busy.outcome, 'inconclusive');
  assert.equal(busy.reason, 'production-became-busy');

  const budget = await diagnostic.runDiagnosticCampaign({
    fixtures,
    activatedAtMs: 0,
    monotonicNowMs: () => 14_930_000 - 129_999,
    checkBusy: async () => false,
    routeOnce: async () => { calls += 1; return diagnosticAttempt(); },
    checkpointAttempt: async () => {},
    checkpointOutOfBand: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(budget.outcome, 'diagnostic-failure');
  assert.equal(budget.reason, 'campaign-budget-exhausted');
});

test('U24 timeout receipt is exclusive mode-0600 and checkpoints each attempt atomically', async () => {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-timeout-receipt-'));
  const evidence = path.join(root, 'evidence');
  const receiptPath = path.join(evidence, 'receipt.json');
  try {
    await mkdir(evidence, { mode: 0o700 });
    let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
    assert.equal(receipt.sequence, 0);
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
    await assert.rejects(diagnostic.createDiagnosticReceipt(receiptPath), /exists|exclusive/i);

    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'preflight', campaign_elapsed_ms: 0,
    });
    assert.equal(receipt.sequence, 1);
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'attempt',
      campaign_elapsed_ms: 60_001,
      attempt: {
        fixture_id: 'work-01', repetition: 1, ordinal: 1,
        evidence: diagnosticAttempt({ elapsedMs: 60_001 }).attemptEvidence,
        slow_valid: true, attempted_call_result: 'valid', terminal_result: null,
      },
    });
    assert.equal(receipt.sequence, 2);
    assert.equal(receipt.attempts[0].slow_valid, true);
    assert.equal(JSON.stringify(receipt).includes('INPUT_JSON'), false);
    assert.equal(JSON.stringify(receipt).includes(root), false);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), receipt);
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'attempt', campaign_elapsed_ms: 1,
      attempt: { ...receipt.attempts[0], ordinal: 2 },
    }), /monotonic|evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 timeout launcher seam proves a transient service and interprets cleanup without rewriting receipt', async () => {
  const diagnostic = await diagnosticModule();
  const scratchPath = '/private/scratch';
  const events = [];
  const launcher = {
    async preflight(request) {
      events.push(['preflight', request]);
      return {
        manager_authorized: true,
        runtime_attested: true,
        authentication_attested: true,
        model_exact: true,
        prompt_manifest_exact: true,
        schema_manifest_exact: true,
        tools_prohibited: true,
        environment_allowlist_exact: true,
        security_flags_exact: true,
        paths_private: true,
        claude_version: '2.1.220 (Claude Code)',
        claude_auth: {
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
        },
        expected_model: 'claude-haiku-exact',
      };
    },
    async runService(request, runInside) {
      events.push(['service', request]);
      return runInside({
        unit_type: 'service',
        unit_identity_unique: true,
        properties: diagnostic.transientServiceProperties(scratchPath),
        runner_cgroup_member: true,
        detached_child_cgroup_member: true,
        activated_at_ms: 0,
      });
    },
    async stop() {
      events.push(['stop']);
    },
    async inspectFinal() {
      events.push(['cleanup']);
      return { inactive: true, cgroup_empty: true, detached_child_removed: true };
    },
  };
  const launched = await diagnostic.runWithUnitLauncher({
    launcher,
    scratchPath,
    receiptPath: '/private/evidence/receipt.json',
    unitWitnessPath: '/private/evidence/unit.json',
    expectedModel: 'claude-haiku-exact',
    runInside: async () => ({ outcome: 'inconclusive' }),
    confirmReceiptDurability: async () => true,
    writeUnitWitness: async () => {},
    readArtifacts: async () => ({
      receipt: {
        schema_version: 'polygram-memory-routing-timeout-diagnostic/v1',
        sequence: 2,
        preflight_complete: true,
        campaign_elapsed_ms: 1,
        attempts: [],
        terminal: {
          outcome: 'inconclusive', reason: 'production-became-busy',
          next_decision: 'preserve-u24-stop-and-choose-alternate-policy',
        },
        out_of_band_terminal_count: 1,
      },
      unitWitness: validWitness(),
    }),
  });
  assert.equal(events[0][1].unit_type, 'service');
  assert.deepEqual(events[0][1].properties, diagnostic.transientServiceProperties(scratchPath));
  assert.equal(launched.cleanup_confirmed, true);

  let called = false;
  await assert.rejects(diagnostic.runWithUnitLauncher({
    launcher: {
      ...launcher,
      preflight: async () => ({ manager_authorized: false }),
    },
    scratchPath,
    receiptPath: '/private/evidence/receipt.json',
    unitWitnessPath: '/private/evidence/unit.json',
    expectedModel: 'claude-haiku-exact',
    runInside: async () => { called = true; },
    writeUnitWitness: async () => {},
  }), /preflight/);
  assert.equal(called, false);

  await assert.rejects(diagnostic.runWithUnitLauncher({
    launcher: {
      ...launcher,
      preflight: async (request) => ({
        ...(await launcher.preflight(request)),
        claude_version: '2.1.221 (Claude Code)',
      }),
    },
    scratchPath,
    receiptPath: '/private/evidence/receipt.json',
    unitWitnessPath: '/private/evidence/unit.json',
    expectedModel: 'claude-haiku-exact',
    runInside: async () => { called = true; },
    writeUnitWitness: async () => {},
  }), /preflight/);
  assert.equal(called, false);

  const invalidUnit = await diagnostic.runWithUnitLauncher({
    launcher: {
      ...launcher,
      async runService(request, runInside) {
        return runInside({
          unit_type: 'scope',
          unit_identity_unique: true,
          properties: { ...request.properties, KillMode: 'process' },
          runner_cgroup_member: true,
          detached_child_cgroup_member: true,
          activated_at_ms: 0,
        });
      },
    },
    scratchPath,
    receiptPath: '/private/evidence/receipt.json',
    unitWitnessPath: '/private/evidence/unit.json',
    expectedModel: 'claude-haiku-exact',
    runInside: async () => { called = true; },
    confirmReceiptDurability: async () => true,
    writeUnitWitness: async () => {},
    readArtifacts: async () => ({
      receipt: {
        schema_version: 'polygram-memory-routing-timeout-diagnostic/v1',
        sequence: 1,
        preflight_complete: true,
        campaign_elapsed_ms: 1,
        attempts: [],
        terminal: null,
        out_of_band_terminal_count: 0,
      },
      unitWitness: validWitness(),
    }),
  });
  assert.deepEqual([invalidUnit.outcome, invalidUnit.reason], [
    'diagnostic-failure', 'runner-nonterminal',
  ]);
  assert.equal(called, false);

  const preserved = {
    schema_version: 'polygram-memory-routing-timeout-diagnostic/v1',
    sequence: 1,
    preflight_complete: true,
    campaign_elapsed_ms: 1,
    attempts: [],
    terminal: null,
    out_of_band_terminal_count: 0,
  };
  const before = JSON.stringify(preserved);
  assert.deepEqual(diagnostic.interpretDiagnosticArtifacts(preserved, validWitness()), {
    outcome: 'diagnostic-failure',
    reason: 'runner-nonterminal',
    next_decision: 'fix-review-and-rerun-changed-diagnostic',
    slow_valid_observed: false,
    cleanup_confirmed: true,
  });
  assert.equal(JSON.stringify(preserved), before);
  assert.equal(diagnostic.interpretDiagnosticArtifacts(preserved, validWitness({
    inactive: false,
    cgroup_empty: false,
    detached_child_removed: false,
    cleanup_confirmed: false,
  })).outcome,
  'diagnostic-failure');
});

test('U24 timeout classification keeps soft evidence attempt-local at exact boundaries', async () => {
  const { classifyDiagnosticEvent } = await diagnosticModule();
  assert.equal(classifyDiagnosticEvent({
    result: diagnosticAttempt({ elapsedMs: 60_001 }),
  }).slow_valid, true);
  assert.equal(classifyDiagnosticEvent({
    result: diagnosticAttempt({ elapsedMs: 120_000 }),
  }).slow_valid, true);
  assert.deepEqual([
    ['starting', 'diagnostic-failure'],
    ['awaiting_output', 'route-unsuitable-at-diagnostic-ceiling'],
    ['output_started', 'route-unsuitable-at-diagnostic-ceiling'],
    ['awaiting_close', 'route-unsuitable-at-diagnostic-ceiling'],
  ].map(([phase, expected]) => [phase, classifyDiagnosticEvent({
    result: diagnosticAttempt({
      status: 'operational_error', errorCode: 'ROUTER_TIMEOUT',
      phase, elapsedMs: 120_000,
    }),
  }).outcome, expected]), [
    ['starting', 'diagnostic-failure', 'diagnostic-failure'],
    ['awaiting_output', 'route-unsuitable-at-diagnostic-ceiling', 'route-unsuitable-at-diagnostic-ceiling'],
    ['output_started', 'route-unsuitable-at-diagnostic-ceiling', 'route-unsuitable-at-diagnostic-ceiling'],
    ['awaiting_close', 'route-unsuitable-at-diagnostic-ceiling', 'route-unsuitable-at-diagnostic-ceiling'],
  ]);
  for (const errorCode of [
    'ROUTER_OUTPUT_MALFORMED', 'ROUTER_OUTPUT_MISSING', 'ROUTER_MODEL_IDENTITY',
    'ROUTER_AUTH_UNAVAILABLE', 'ROUTER_TOOL_USE',
  ]) {
    const result = diagnosticAttempt({ status: 'operational_error', errorCode, elapsedMs: 90_000 });
    assert.equal(classifyDiagnosticEvent({ result }).slow_valid, false, errorCode);
  }
  assert.equal(classifyDiagnosticEvent({
    result: diagnosticAttempt({
      status: 'operational_error', errorCode: 'ROUTER_TIMEOUT',
      elapsedMs: 120_000, payloadValid: true,
    }),
  }).outcome, 'process-boundary-fault');
  assert.equal(classifyDiagnosticEvent({
    result: diagnosticAttempt({ elapsedMs: 120_001 }),
  }).outcome, 'diagnostic-failure');
  assert.equal(classifyDiagnosticEvent({
    integrityFailure: true,
    productionBusy: true,
    result: diagnosticAttempt({ elapsedMs: Number.NaN, cleanupConfirmed: false }),
  }).reason, 'integrity-failure');
  assert.equal(classifyDiagnosticEvent({
    productionBusy: true,
    result: diagnosticAttempt({
      status: 'operational_error', errorCode: 'ROUTER_OUTPUT_TOO_LARGE',
      stdoutBytes: 'over_limit',
    }),
  }).reason, 'production-became-busy');
  assert.equal(classifyDiagnosticEvent({
    result: diagnosticAttempt({
      status: 'operational_error', errorCode: 'ROUTER_TIMEOUT',
      elapsedMs: 120_000, payloadValid: true, cleanupConfirmed: false,
    }),
  }).reason, 'cleanup-unconfirmed');
});

test('U24 timeout campaign lets every later terminal class win without erasing slow evidence', async () => {
  const [{ loadRoutingFixtures }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    diagnosticModule(),
  ]);
  const fixtures = loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine');
  const terminalResults = [
    diagnosticAttempt({
      status: 'operational_error', errorCode: 'ROUTER_PROCESS_EXIT',
      elapsedMs: 90_000, payloadValid: true,
    }),
    { ...parsedRouterQualityAttempt(), status: 'mismatch', errorCode: 'ROUTER_EXPECTATION_MISMATCH' },
    diagnosticAttempt({ status: 'operational_error', errorCode: 'ROUTER_MODEL_IDENTITY' }),
    diagnosticAttempt({
      status: 'operational_error', errorCode: 'ROUTER_OUTPUT_TOO_LARGE',
      stdoutBytes: 'over_limit',
    }),
  ];
  const expectedOutcomes = [
    'process-boundary-fault',
    'router-quality-failure',
    'diagnostic-failure',
    'diagnostic-failure',
  ];
  for (let index = 0; index < terminalResults.length; index += 1) {
    let calls = 0;
    const result = await diagnostic.runDiagnosticCampaign({
      fixtures,
      activatedAtMs: 0,
      monotonicNowMs: () => 0,
      checkBusy: async () => false,
      routeOnce: async () => {
        calls += 1;
        return calls === 1 ? diagnosticAttempt({ elapsedMs: 60_001 }) : terminalResults[index];
      },
      checkpointAttempt: async () => {},
      checkpointOutOfBand: async () => {},
    });
    assert.equal(result.outcome, expectedOutcomes[index]);
    assert.equal(result.attempts[0].slow_valid, true);
    assert.equal(result.slow_valid_observed, true);
  }
});

test('U24 timeout unit witness is separate and evidence copy hashes precede scratch cleanup', async () => {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-timeout-artifacts-'));
  const scratchPath = path.join(root, 'polygram-u24-timeout-artifacts');
  const evidencePath = path.join(root, 'evidence');
  const copyPath = path.join(root, 'copy');
  const receiptPath = path.join(evidencePath, 'receipt.json');
  const witnessPath = path.join(evidencePath, 'unit-witness.json');
  try {
    await mkdir(evidencePath, { mode: 0o700 });
    await mkdir(copyPath, { mode: 0o700 });
    const scratchOwnership = await diagnostic.createOwnedScratch(scratchPath, {
      protectedPaths: [receiptPath, witnessPath, copyPath],
    });
    let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'preflight', campaign_elapsed_ms: 1,
    });
    const witness = await diagnostic.createUnitWitness(witnessPath, {
      inactive: true,
      cgroup_empty: true,
      detached_child_removed: true,
      receipt_checkpoint_confirmed: true,
      unit_name: 'must-not-survive',
      pid: 123,
      path: '/must/not/survive',
    });
    assert.deepEqual(witness, {
      schema_version: 'polygram-memory-routing-timeout-unit-witness/v1',
      inactive: true,
      cgroup_empty: true,
      detached_child_removed: true,
      receipt_checkpoint_confirmed: true,
      cleanup_confirmed: true,
    });
    assert.equal((await stat(witnessPath)).mode & 0o777, 0o600);
    assert.equal((await readFile(witnessPath, 'utf8')).includes('must-not-survive'), false);
    await assert.rejects(diagnostic.createUnitWitness(witnessPath, witness), /exclusive/i);

    const copied = await diagnostic.validateCopyAndHashEvidence({
      receiptPath,
      unitWitnessPath: witnessPath,
      destinationDirectory: copyPath,
    });
    assert.match(copied.receipt_sha256, /^[a-f0-9]{64}$/);
    assert.match(copied.unit_witness_sha256, /^[a-f0-9]{64}$/);
    assert.equal((await stat(path.join(copyPath, 'receipt.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(copyPath, 'unit-witness.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(JSON.parse(await readFile(receiptPath, 'utf8'))), JSON.stringify(receipt));

    await diagnostic.cleanupScratchAfterEvidence({
      scratchOwnership,
      receiptPath,
      unitWitnessPath: witnessPath,
    });
    await assert.rejects(access(scratchPath));
    await access(receiptPath);
    await access(witnessPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 timeout live wrapper uses the unchanged adapter boundary once per primary call', async () => {
  const [{ loadRoutingFixtures }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    diagnosticModule(),
  ]);
  const fixtures = loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine');
  const adapterCalls = [];
  const routeCalls = [];
  const result = await diagnostic.runLiveDiagnosticCampaign({
    claudeBin: '/opt/claude-2.1.220',
    expectedModel: 'claude-haiku-exact',
    scratchPath: '/private/scratch',
    activatedAtMs: 0,
    monotonicNowMs: () => 0,
    checkBusy: async () => false,
    checkpointAttempt: async () => {},
    checkpointOutOfBand: async () => {},
    attestRuntime: async () => ({ canonicalPath: '/opt/claude-2.1.220' }),
    assertRuntimeIdentityUnchanged: async () => {},
    createAdapter(options) {
      adapterCalls.push(options);
      return { id: 'claude:haiku' };
    },
    async runCase({ fixture, adapter }) {
      routeCalls.push([fixture.id, adapter.id]);
      return diagnosticAttempt();
    },
  });
  assert.deepEqual(adapterCalls, [{
    binary: '/opt/claude-2.1.220',
    model: 'haiku',
    expectedObservedModel: 'claude-haiku-exact',
    timeoutMs: 120_000,
    tempRoot: '/private/scratch',
  }]);
  assert.equal(routeCalls.length, 110);
  assert.deepEqual(routeCalls.map(([fixtureId]) => fixtureId), Array.from(
    { length: 5 },
    () => fixtures.map((fixture) => fixture.id),
  ).flat());
  assert.equal(result.outcome, 'inconclusive');
});

test('U24 timeout receipt enforces its sequence bound, one out-of-band terminal, and closed fields', async () => {
  const [diagnostic, { loadRoutingFixtures }] = await Promise.all([
    diagnosticModule(),
    import(`${ROOT}/fixtures.mjs`),
  ]);
  const fixtures = loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine');
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-timeout-sequence-'));
  const receiptPath = path.join(root, 'receipt.json');
  const witnessPath = path.join(root, 'unit-witness.json');
  const copyPath = path.join(root, 'copy');
  try {
    await mkdir(copyPath, { mode: 0o700 });
    let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'preflight', campaign_elapsed_ms: 0,
    });
    for (let ordinal = 1; ordinal <= 109; ordinal += 1) {
      receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
        kind: 'attempt',
        campaign_elapsed_ms: ordinal,
        attempt: {
          fixture_id: fixtures[(ordinal - 1) % fixtures.length].id,
          repetition: Math.ceil(ordinal / 22),
          ordinal,
          evidence: diagnosticAttempt().attemptEvidence,
          slow_valid: false,
          attempted_call_result: 'valid',
          terminal_result: null,
        },
      });
    }
    assert.equal(receipt.sequence, 110);
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'attempt',
      campaign_elapsed_ms: 110,
      attempt: {
        fixture_id: fixtures[109 % fixtures.length].id,
        repetition: 5,
        ordinal: 110,
        evidence: diagnosticAttempt().attemptEvidence,
        slow_valid: false,
        attempted_call_result: 'valid',
        terminal_result: null,
      },
    }), /call-ceiling|terminal/);
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'out_of_band',
      campaign_elapsed_ms: 110,
      outcome: 'diagnostic-failure',
      reason: 'campaign-budget-exhausted',
    });
    assert.equal(receipt.sequence, 111);
    assert.equal(receipt.out_of_band_terminal_count, 1);
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'out_of_band', campaign_elapsed_ms: 112,
      outcome: 'diagnostic-failure', reason: 'campaign-budget-exhausted',
    }), /terminal/);

    const corrupted = JSON.parse(await readFile(receiptPath, 'utf8'));
    corrupted.prompt = 'must fail closed';
    await writeFile(receiptPath, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
    await diagnostic.createUnitWitness(witnessPath, {
      inactive: true, cgroup_empty: true, detached_child_removed: true,
      receipt_checkpoint_confirmed: true,
    });
    await assert.rejects(diagnostic.validateCopyAndHashEvidence({
      receiptPath,
      unitWitnessPath: witnessPath,
      destinationDirectory: copyPath,
    }), /receipt fields/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 real harness classifies a parsed secret-bearing router envelope as router quality', async () => {
  const [{ loadRoutingFixtures }, { runRoutingCase }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    import(`${ROOT}/harness.mjs`),
    diagnosticModule(),
  ]);
  const fixture = loadRoutingFixtures().find((row) => row.id === 'work-01');
  const evidence = parsedRouterQualityAttempt().attemptEvidence;
  const result = await runRoutingCase({
    fixture,
    adapter: {
      id: 'real-harness-router-quality',
      requireModelEvidence: true,
      requireAttemptEvidence: true,
      expectedObservedModel: 'claude-haiku-exact',
      async route() {
        return {
          raw: JSON.stringify({
            category: 'work',
            parts: [{ kind: 'work', text: 'The database password: fake-secret-value.' }],
          }),
          toolCalls: 0,
          observedModels: ['claude-haiku-exact'],
          attemptEvidence: evidence,
        };
      },
    },
  });
  assert.equal(result.errorCode, 'ROUTER_OUTPUT_SECRET');
  assert.equal(result.attemptEvidence.payload_valid, false);
  assert.equal(Number.isInteger(result.attemptEvidence.duration_ms), true);
  assert.deepEqual(
    [diagnostic.classifyDiagnosticEvent({ result }).outcome,
      diagnostic.classifyDiagnosticEvent({ result }).reason],
    ['router-quality-failure', 'router-quality-failure'],
  );
});

test('U24 receipt rejects impossible attempt terminals and non-OOB terminal checkpoints', async () => {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-terminal-tamper-'));
  try {
    async function initializedReceipt(name) {
      const receiptPath = path.join(root, `${name}.json`);
      let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
      receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
        kind: 'preflight', campaign_elapsed_ms: 0,
      });
      return { receiptPath, receipt };
    }

    const invalidProcess = await initializedReceipt('process');
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(
      invalidProcess.receiptPath,
      invalidProcess.receipt,
      {
        kind: 'attempt', campaign_elapsed_ms: 1, reason: 'payload-valid-process-boundary',
        attempt: {
          fixture_id: 'work-01', repetition: 1, ordinal: 1,
          evidence: diagnosticAttempt({ payloadValid: false }).attemptEvidence,
          slow_valid: false,
          attempted_call_result: 'process-boundary-fault',
          terminal_result: 'process-boundary-fault',
        },
      },
    ), /process|terminal|attempt evidence/);

    const invalidCeiling = await initializedReceipt('ceiling');
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(
      invalidCeiling.receiptPath,
      invalidCeiling.receipt,
      {
        kind: 'attempt', campaign_elapsed_ms: 119_999, reason: 'hard-timeout-after-input',
        attempt: {
          fixture_id: 'work-01', repetition: 1, ordinal: 1,
          evidence: diagnosticAttempt({
            status: 'operational_error', errorCode: 'ROUTER_TIMEOUT',
            phase: 'awaiting_output', elapsedMs: 119_999, payloadValid: false,
          }).attemptEvidence,
          slow_valid: false,
          attempted_call_result: 'route-unsuitable-at-diagnostic-ceiling',
          terminal_result: 'route-unsuitable-at-diagnostic-ceiling',
        },
      },
    ), /ceiling|terminal|attempt evidence/);

    const invalidQuality = await initializedReceipt('quality');
    const incompleteQuality = parsedRouterQualityAttempt();
    incompleteQuality.attemptEvidence.complete_json_candidate_ms = null;
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(
      invalidQuality.receiptPath,
      invalidQuality.receipt,
      {
        kind: 'attempt', campaign_elapsed_ms: 1, reason: 'router-quality-failure',
        attempt: {
          fixture_id: 'work-01', repetition: 1, ordinal: 1,
          evidence: incompleteQuality.attemptEvidence,
          slow_valid: false,
          attempted_call_result: 'router-quality-failure',
          terminal_result: 'router-quality-failure',
        },
      },
    ), /router|terminal|attempt evidence/);

    const invalidOutOfBand = await initializedReceipt('out-of-band');
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(
      invalidOutOfBand.receiptPath,
      invalidOutOfBand.receipt,
      {
        kind: 'out_of_band', campaign_elapsed_ms: 120_000,
        outcome: 'route-unsuitable-at-diagnostic-ceiling', reason: 'hard-timeout-after-input',
      },
    ), /out-of-band/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await assertCleanupUnconfirmedRoundTrip();
  await assertRunnerNonterminalNotOutOfBand();
  await assertExactHardDeadlineProcessExitRoundTrip();
  await assertTimeoutStreamPrecedenceRoundTrips();
});

test('U24 systemd inspection fails closed and only accepts cgroup ENOENT after inactive proof', async () => {
  const diagnostic = await diagnosticModule();
  const activeShow = [
    'ActiveState=active',
    'ControlGroup=/user.slice/u24.service',
    'KillMode=control-group',
    'RuntimeMaxUSec=4h 9min 0s',
    'TimeoutStopUSec=10s',
    'SendSIGKILL=yes',
    'RemainAfterExit=yes',
    'StandardOutput=null',
    'StandardError=null',
    'WorkingDirectory=/private/polygram-u24-timeout-scratch',
    'ActiveEnterTimestampMonotonic=1000',
  ].join('\n');
  const request = {
    unit_type: 'service',
    properties: diagnostic.transientServiceProperties('/private/polygram-u24-timeout-scratch'),
    inside_command: ['/usr/bin/node', '/opt/polygram/diagnose-timeouts.mjs', 'inside'],
  };

  let phase = 'active';
  const failClosed = diagnostic.createSystemdUserLauncher({
    platform: 'linux',
    monotonicNowMs: () => 1,
    delay: async () => {},
    execFileCommand: async (binary, argv) => {
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=SubState')) return {
        stdout: 'ActiveState=active\nSubState=exited\nResult=success\nExecMainCode=exited\nExecMainStatus=0\n',
      };
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=LoadState')) return phase === 'active'
        ? { stdout: 'LoadState=not-found\n' }
        : Promise.reject(Object.assign(new Error('manager unavailable'), { code: 'EACCES' }));
      if (binary === '/usr/bin/systemd-run') {
        phase = 'active';
        return { stdout: '' };
      }
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=ControlGroup')) {
        if (phase === 'active') return { stdout: activeShow };
        throw Object.assign(new Error('manager unavailable'), { code: 'EACCES' });
      }
      if (binary === '/usr/bin/systemctl' && argv.includes('stop')) {
        phase = 'final';
        return { stdout: '' };
      }
      throw new Error('unexpected command');
    },
    readFileCommand: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  await failClosed.runService(request);
  await failClosed.stop(request);
  assert.deepEqual(await failClosed.inspectFinal(request), {
    inactive: false, cgroup_empty: false, detached_child_removed: false,
  });

  phase = 'active';
  const absentCgroup = diagnostic.createSystemdUserLauncher({
    platform: 'linux',
    monotonicNowMs: () => 1,
    delay: async () => {},
    execFileCommand: async (binary, argv) => {
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=SubState')) return {
        stdout: 'ActiveState=active\nSubState=exited\nResult=success\nExecMainCode=exited\nExecMainStatus=0\n',
      };
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=LoadState')) {
        return phase === 'active'
          ? { stdout: 'LoadState=not-found\n' }
          : { stdout: 'LoadState=not-found\nActiveState=inactive\n' };
      }
      if (binary === '/usr/bin/systemd-run') return { stdout: '' };
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=ControlGroup')) {
        return { stdout: activeShow };
      }
      if (binary === '/usr/bin/systemctl' && argv.includes('stop')) {
        phase = 'final';
        return { stdout: '' };
      }
      throw new Error('unexpected command');
    },
    readFileCommand: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
  });
  await absentCgroup.runService(request);
  await absentCgroup.stop(request);
  assert.deepEqual(await absentCgroup.inspectFinal(request), {
    inactive: true, cgroup_empty: true, detached_child_removed: true,
  });
  await assertAbsoluteCompletionDeadline();
});

test('U24 launcher stops after a run failure and cleanup-unconfirmed keeps precedence', async () => {
  const diagnostic = await diagnosticModule();
  let stops = 0;
  const receipt = {
    schema_version: 'polygram-memory-routing-timeout-diagnostic/v1',
    sequence: 1,
    preflight_complete: true,
    campaign_elapsed_ms: 1,
    attempts: [],
    terminal: null,
    out_of_band_terminal_count: 0,
  };
  const result = await diagnostic.runWithUnitLauncher({
    launcher: {
      preflight: async () => validPreflight(),
      runService: async () => { throw new Error('client failed after activation'); },
      stop: async () => { stops += 1; },
      inspectFinal: async () => ({
        inactive: false, cgroup_empty: false, detached_child_removed: false,
      }),
    },
    scratchPath: '/private/polygram-u24-timeout-run-failure',
    receiptPath: '/private/evidence/receipt.json',
    unitWitnessPath: '/private/evidence/unit.json',
    expectedModel: 'claude-haiku-exact',
    runInside: async () => {},
    confirmReceiptDurability: async () => true,
    writeUnitWitness: async () => {},
    readArtifacts: async () => ({
      receipt,
      unitWitness: validWitness({
        inactive: false,
        cgroup_empty: false,
        detached_child_removed: false,
        cleanup_confirmed: false,
      }),
    }),
  });
  assert.equal(stops, 1);
  assert.deepEqual([result.outcome, result.reason, result.cleanup_confirmed], [
    'diagnostic-failure', 'cleanup-unconfirmed', false,
  ]);
});

test('U24 runtime uses cheap identity checks per call and hashes only at the boundaries', async () => {
  const runtime = await import(`${ROOT}/runtime-attestation.mjs`);
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-runtime-cheap-'));
  const binary = path.join(root, 'claude');
  let hashes = 0;
  try {
    await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const receipt = await runtime.attestClaudeRuntime(binary, {
      execFileCommand: async () => ({ stdout: '2.1.220 (Claude Code)\n' }),
      hashFile: async () => { hashes += 1; return 'a'.repeat(64); },
    });
    assert.equal(hashes, 1);
    for (let ordinal = 0; ordinal < 110; ordinal += 1) {
      await runtime.assertClaudeRuntimeIdentityUnchanged(receipt);
    }
    assert.equal(hashes, 1);
    await runtime.assertClaudeRuntimeUnchanged(receipt, {
      hashFile: async () => { hashes += 1; return 'a'.repeat(64); },
    });
    assert.equal(hashes, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('U24 scratch rejects both directions of every protected-path overlap', async () => {
  const diagnostic = await diagnosticModule();
  const homeChild = path.join(os.homedir(), 'polygram-u24-timeout-home-child');
  const repoChild = path.resolve(__dirname, '..', 'polygram-u24-timeout-repo-child');
  const scratch = '/private/polygram-u24-timeout-overlap';
  for (const [candidate, protectedPaths] of [
    [homeChild, []],
    [repoChild, []],
    [scratch, ['/private']],
    [scratch, [`${scratch}/evidence`]],
    [scratch, [scratch]],
  ]) {
    assert.throws(
      () => diagnostic.assertSafeScratchPath(candidate, protectedPaths),
      /overlaps a protected|overlaps durable/,
    );
  }
});

test('U24 detached-child wait and final-state polling are explicitly bounded', async () => {
  const diagnostic = await diagnosticModule();
  const controlGroup = '/user.slice/u24.service';
  const show = [
    'ActiveState=active',
    `ControlGroup=${controlGroup}`,
    'KillMode=control-group',
    'RuntimeMaxUSec=4h 9min 0s',
    'TimeoutStopUSec=10s',
    'SendSIGKILL=yes',
    'RemainAfterExit=yes',
    'StandardOutput=null',
    'StandardError=null',
    'WorkingDirectory=/private/polygram-u24-timeout-bounded',
    'ActiveEnterTimestampMonotonic=1000',
  ].join('\n');
  const child = new EventEmitter();
  child.pid = 222;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  await assert.rejects(diagnostic.verifyInsideSystemdUnit({
    platform: 'linux',
    unitName: 'polygram-u24-timeout-00000000-0000-4000-8000-000000000000.service',
    scratchPath: '/private/polygram-u24-timeout-bounded',
    childExitTimeoutMs: 5,
    execFileCommand: async () => ({ stdout: show }),
    readFileCommand: async () => `0::${controlGroup}\n`,
    spawnCommand: () => child,
  }), /detached child exit was not confirmed/);

  let finalShows = 0;
  let phase = 'identity';
  const launcher = diagnostic.createSystemdUserLauncher({
    platform: 'linux',
    monotonicNowMs: () => 1,
    finalPollAttempts: 3,
    delay: async () => {},
    execFileCommand: async (binary, argv) => {
      if (argv.includes('--property=LoadState')) {
        if (phase === 'identity') return { stdout: 'LoadState=not-found\n' };
        finalShows += 1;
        return { stdout: 'LoadState=loaded\nActiveState=active\n' };
      }
      if (binary === '/usr/bin/systemd-run') {
        phase = 'active';
        return { stdout: '' };
      }
      if (argv.includes('--property=ControlGroup')) return { stdout: show };
      if (argv.includes('--property=SubState')) return {
        stdout: 'ActiveState=active\nSubState=exited\nResult=success\nExecMainCode=exited\nExecMainStatus=0\n',
      };
      if (argv.includes('stop')) {
        phase = 'final';
        return { stdout: '' };
      }
      throw new Error('unexpected command');
    },
  });
  const boundedRequest = {
    unit_type: 'service',
    properties: diagnostic.transientServiceProperties('/private/polygram-u24-timeout-bounded'),
    inside_command: ['/usr/bin/node', '/opt/polygram/diagnose-timeouts.mjs', 'inside'],
  };
  await launcher.runService(boundedRequest);
  await launcher.stop(boundedRequest);
  assert.deepEqual(await launcher.inspectFinal({}), {
    inactive: false, cgroup_empty: false, detached_child_removed: false,
  });
  assert.equal(finalShows, 3);
});

test('U24 staged source set imports and exercises the launch seam without systemd', async () => {
  const diagnostic = await diagnosticModule();
  assert.deepEqual(diagnostic.STAGING_SOURCE_FILES, [
    'scripts/spikes/memory-routing-gate/diagnose-timeouts.mjs',
    'scripts/spikes/memory-routing-gate/runtime-attestation.mjs',
    'scripts/spikes/memory-routing-gate/adapters.mjs',
    'scripts/spikes/memory-routing-gate/fixtures.mjs',
    'scripts/spikes/memory-routing-gate/harness.mjs',
    'scripts/spikes/memory-routing-gate/contract.mjs',
    'lib/secret-detect.js',
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-staged-source-'));
  const sourceRoot = path.join(root, 'source');
  try {
    for (const relative of diagnostic.STAGING_SOURCE_FILES) {
      const destination = path.join(sourceRoot, relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, await readFile(path.resolve(__dirname, '..', relative)), {
        mode: 0o400,
      });
    }
    await symlink(path.resolve(__dirname, '../node_modules'), path.join(sourceRoot, 'node_modules'), 'dir');
    const staged = await import(`${pathToFileURL(path.join(
      sourceRoot,
      diagnostic.STAGING_SOURCE_FILES[0],
    )).href}?staged=${Date.now()}`);
    assert.equal(staged.parseDiagnosticArgs([
      'launch',
      '--claude-bin', '/opt/claude',
      '--expected-model', 'claude-haiku-exact',
      '--scratch', '/run/user/1000/polygram-u24-timeout-smoke',
      '--receipt', '/home/shumabit/.local/state/polygram/u24-timeout/evidence/receipt.json',
      '--unit-witness', '/home/shumabit/.local/state/polygram/u24-timeout/evidence/unit.json',
      '--destination', '/home/shumabit/.local/state/polygram/u24-timeout/durable',
    ]).mode, 'launch');
    const launched = await staged.runWithUnitLauncher({
      launcher: {
        preflight: async () => validPreflight(),
        runService: async (_request, runInside) => runInside({
          unit_type: 'service',
          unit_identity_unique: true,
          properties: staged.transientServiceProperties('/run/user/1000/polygram-u24-timeout-smoke'),
          runner_cgroup_member: true,
          detached_child_cgroup_member: true,
          activated_at_ms: 0,
        }),
        stop: async () => {},
        inspectFinal: async () => ({
          inactive: true, cgroup_empty: true, detached_child_removed: true,
        }),
      },
      scratchPath: '/run/user/1000/polygram-u24-timeout-smoke',
      receiptPath: '/home/shumabit/.local/state/polygram/u24-timeout/evidence/receipt.json',
      unitWitnessPath: '/home/shumabit/.local/state/polygram/u24-timeout/evidence/unit.json',
      expectedModel: 'claude-haiku-exact',
      runInside: async () => {},
      confirmReceiptDurability: async () => true,
      writeUnitWitness: async () => {},
      readArtifacts: async () => ({
        receipt: {
          schema_version: 'polygram-memory-routing-timeout-diagnostic/v1',
          sequence: 2,
          preflight_complete: true,
          campaign_elapsed_ms: 1,
          attempts: [],
          terminal: {
            outcome: 'inconclusive', reason: 'production-became-busy',
            next_decision: 'preserve-u24-stop-and-choose-alternate-policy',
          },
          out_of_band_terminal_count: 1,
        },
        unitWitness: validWitness(),
      }),
    });
    assert.equal(launched.outcome, 'inconclusive');
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const readme = await readFile(path.resolve(__dirname, '../scripts/spikes/memory-routing-gate/README.md'), 'utf8');
  for (const required of [
    'git archive',
    '/run/user/$UID/polygram-u24-timeout-',
    '$HOME/.local/state/polygram/u24-timeout',
    '/usr/lib/node_modules/polygram/node_modules',
    'source-receipt-$source_commit.json',
  ]) assert.equal(readme.includes(required), true, required);
});

async function assertReceiptSemanticGrammar() {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-semantic-grammar-'));
  try {
    async function initialized(name) {
      const filePath = path.join(root, `${name}.json`);
      let receipt = await diagnostic.createDiagnosticReceipt(filePath);
      receipt = await diagnostic.checkpointDiagnosticReceipt(filePath, receipt, {
        kind: 'preflight', campaign_elapsed_ms: 0,
      });
      return { filePath, receipt };
    }

    const falseValid = await initialized('false-valid');
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(
      falseValid.filePath,
      falseValid.receipt,
      {
        kind: 'attempt', campaign_elapsed_ms: 10,
        attempt: {
          fixture_id: 'work-01', repetition: 1, ordinal: 1,
          evidence: diagnosticAttempt({ payloadValid: false, elapsedMs: 10 }).attemptEvidence,
          slow_valid: false,
          attempted_call_result: 'valid',
          terminal_result: null,
        },
      },
    ), /valid attempt|attempt evidence/);

    const mislabeledAccepted = [
      ['stream-over-limit', 'stream'],
      ['cleanup-unconfirmed', 'cleanup'],
      ['hard-timeout-before-input', 'before-input'],
      ['early-process-exit', 'early-exit'],
      ['invalid-envelope', 'invalid-envelope'],
      ['invalid-success-evidence', 'invalid-success'],
      ['success-after-hard-deadline', 'late-success'],
      ['integrity-failure', 'integrity'],
    ];
    for (const [reason, name] of mislabeledAccepted) {
      const state = await initialized(name);
      await assert.rejects(diagnostic.checkpointDiagnosticReceipt(
        state.filePath,
        state.receipt,
        {
          kind: 'attempt', campaign_elapsed_ms: 10, reason,
          attempt: {
            fixture_id: 'work-01', repetition: 1, ordinal: 1,
            evidence: diagnosticAttempt({ elapsedMs: 10 }).attemptEvidence,
            slow_valid: false,
            attempted_call_result: 'diagnostic-failure',
            terminal_result: 'diagnostic-failure',
          },
        },
      ), new RegExp(name.split('-')[0]));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertMissingRouteResultCheckpoint() {
  const [{ loadRoutingFixtures }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    diagnosticModule(),
  ]);
  const checkpoints = [];
  let attemptCheckpoints = 0;
  const result = await diagnostic.runDiagnosticCampaign({
    fixtures: loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine'),
    activatedAtMs: 0,
    monotonicNowMs: () => 0,
    checkBusy: async () => false,
    routeOnce: async () => undefined,
    checkpointAttempt: async () => { attemptCheckpoints += 1; },
    checkpointOutOfBand: async (decision) => checkpoints.push(decision),
  });
  assert.equal(attemptCheckpoints, 0);
  assert.deepEqual([result.outcome, result.reason], ['diagnostic-failure', 'unknown-evidence']);
  assert.deepEqual(checkpoints.map(({ outcome, reason }) => [outcome, reason]), [
    ['diagnostic-failure', 'unknown-evidence'],
  ]);
}

async function assertAbsoluteCompletionDeadline() {
  const diagnostic = await diagnosticModule();
  const controlGroup = '/user.slice/u24-deadline.service';
  const activeShow = [
    'ActiveState=active',
    `ControlGroup=${controlGroup}`,
    'KillMode=control-group',
    'RuntimeMaxUSec=4h 9min 0s',
    'TimeoutStopUSec=10s',
    'SendSIGKILL=yes',
    'RemainAfterExit=yes',
    'StandardOutput=null',
    'StandardError=null',
    'WorkingDirectory=/run/user/1000/polygram-u24-timeout-deadline',
    'ActiveEnterTimestampMonotonic=1000',
  ].join('\n');
  let now = 1 + diagnostic.DIAGNOSTIC_LIMITS.outerMaximumMs - 1_000;
  let started = false;
  let stopped = false;
  let completionShows = 0;
  const completionTimeouts = [];
  const sleeps = [];
  const launcher = diagnostic.createSystemdUserLauncher({
    platform: 'linux',
    monotonicNowMs: () => now,
    completionPollAttempts: 100,
    completionPollIntervalMs: 5_000,
    delay: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    readFileCommand: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
    execFileCommand: async (binary, argv, options) => {
      if (binary === '/usr/bin/systemctl' && argv.includes('show-environment')) return { stdout: '' };
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=LoadState')) {
        return stopped
          ? { stdout: 'LoadState=not-found\nActiveState=inactive\n' }
          : { stdout: 'LoadState=not-found\n' };
      }
      if (binary === '/usr/bin/systemd-run') {
        started = true;
        return { stdout: '' };
      }
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=ControlGroup')) {
        return { stdout: activeShow };
      }
      if (binary === '/usr/bin/systemctl' && argv.includes('--property=SubState')) {
        completionShows += 1;
        completionTimeouts.push(options.timeout);
        now += options.timeout;
        return {
          stdout: 'ActiveState=active\nSubState=running\nResult=success\nExecMainCode=exited\nExecMainStatus=0\n',
        };
      }
      if (binary === '/usr/bin/systemctl' && argv.includes('stop')) {
        stopped = true;
        return { stdout: '' };
      }
      throw new Error('unexpected command');
    },
  });
  const result = await diagnostic.runWithUnitLauncher({
    launcher,
    scratchPath: '/run/user/1000/polygram-u24-timeout-deadline',
    receiptPath: '/home/shumabit/.local/state/polygram/u24/evidence/receipt.json',
    unitWitnessPath: '/home/shumabit/.local/state/polygram/u24/evidence/unit.json',
    expectedModel: 'claude-haiku-exact',
    preflightEvidence: validPreflight(),
    insideCommand: ['/usr/bin/node', '/opt/polygram/diagnose-timeouts.mjs', 'inside'],
    runInside: async () => {},
    confirmReceiptDurability: async () => true,
    writeUnitWitness: async () => {},
    readArtifacts: async () => ({
      receipt: {
        schema_version: 'polygram-memory-routing-timeout-diagnostic/v1',
        sequence: 1,
        preflight_complete: true,
        campaign_elapsed_ms: 1,
        attempts: [],
        terminal: null,
        out_of_band_terminal_count: 0,
      },
      unitWitness: validWitness(),
    }),
  });
  assert.equal(started, true);
  assert.equal(stopped, true);
  assert.equal(completionShows, 1);
  assert.deepEqual(completionTimeouts, [1_000]);
  assert.deepEqual(sleeps, []);
  assert.deepEqual([result.outcome, result.reason, result.cleanup_confirmed], [
    'diagnostic-failure', 'runner-nonterminal', true,
  ]);
}

async function assertCleanupUnconfirmedRoundTrip() {
  const diagnostic = await diagnosticModule();
  const result = diagnosticAttempt({
    status: 'operational_error',
    errorCode: 'ROUTER_OUTPUT_TOO_LARGE',
    stdoutBytes: 'over_limit',
    payloadValid: false,
    cleanupConfirmed: false,
  });
  const decision = diagnostic.classifyDiagnosticEvent({ result, callOrdinal: 1 });
  assert.deepEqual([decision.outcome, decision.reason], [
    'diagnostic-failure', 'cleanup-unconfirmed',
  ]);

  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-cleanup-roundtrip-'));
  const receiptPath = path.join(root, 'receipt.json');
  try {
    let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'preflight', campaign_elapsed_ms: 0,
    });
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'attempt', campaign_elapsed_ms: 60_000, reason: decision.reason,
      attempt: {
        fixture_id: 'work-01', repetition: 1, ordinal: 1,
        evidence: result.attemptEvidence,
        slow_valid: decision.slow_valid,
        attempted_call_result: decision.outcome,
        terminal_result: decision.outcome,
      },
    });
    assert.deepEqual([receipt.terminal.outcome, receipt.terminal.reason], [
      'diagnostic-failure', 'cleanup-unconfirmed',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertMissingIntegrityEvidenceOutOfBand() {
  const [{ loadRoutingFixtures }, diagnostic] = await Promise.all([
    import(`${ROOT}/fixtures.mjs`),
    diagnosticModule(),
  ]);
  const fixtures = loadRoutingFixtures().filter((fixture) => fixture.expected !== 'quarantine');
  const observations = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-integrity-oob-'));
  try {
    for (const [index, attemptEvidence] of [undefined, { phase: 'broken' }].entries()) {
      const receiptPath = path.join(root, `receipt-${index}.json`);
      let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
      receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
        kind: 'preflight', campaign_elapsed_ms: 0,
      });
      let attemptCheckpoints = 0;
      let outOfBandCheckpoints = 0;
      const result = await diagnostic.runDiagnosticCampaign({
        fixtures,
        activatedAtMs: 0,
        monotonicNowMs: () => 0,
        checkBusy: async () => false,
        routeOnce: async () => ({
          status: 'operational_error',
          errorCode: 'ROUTER_MODEL_IDENTITY',
          ...(attemptEvidence === undefined ? {} : { attemptEvidence }),
        }),
        checkpointAttempt: async (attempt, decision) => {
          attemptCheckpoints += 1;
          receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
            kind: 'attempt', campaign_elapsed_ms: 1, reason: decision.reason, attempt,
          });
        },
        checkpointOutOfBand: async (decision) => {
          outOfBandCheckpoints += 1;
          receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
            kind: 'out_of_band', campaign_elapsed_ms: 1,
            outcome: decision.outcome, reason: decision.reason,
          });
        },
      });
      observations.push({
        result,
        attemptCheckpoints,
        outOfBandCheckpoints,
        durableReceipt: JSON.parse(await readFile(receiptPath, 'utf8')),
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(observations.map((row) => ({
    outcome: row.result?.outcome,
    reason: row.result?.reason,
    attempts: row.attemptCheckpoints,
    outOfBand: row.outOfBandCheckpoints,
    durableAttempts: row.durableReceipt.attempts.length,
    durableOutOfBand: row.durableReceipt.out_of_band_terminal_count,
    durableReason: row.durableReceipt.terminal?.reason,
  })), [
    {
      outcome: 'diagnostic-failure', reason: 'integrity-failure', attempts: 0, outOfBand: 1,
      durableAttempts: 0, durableOutOfBand: 1, durableReason: 'integrity-failure',
    },
    {
      outcome: 'diagnostic-failure', reason: 'integrity-failure', attempts: 0, outOfBand: 1,
      durableAttempts: 0, durableOutOfBand: 1, durableReason: 'integrity-failure',
    },
  ]);
  assert.equal(JSON.stringify(observations).includes('ROUTER_MODEL_IDENTITY'), false);
  assert.equal(JSON.stringify(observations).includes('attemptEvidence'), false);
}

async function assertRunnerNonterminalNotOutOfBand() {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-runner-oob-'));
  const receiptPath = path.join(root, 'receipt.json');
  try {
    let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'preflight', campaign_elapsed_ms: 0,
    });
    await assert.rejects(diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'out_of_band',
      campaign_elapsed_ms: 1,
      outcome: 'diagnostic-failure',
      reason: 'runner-nonterminal',
    }), /out-of-band/);
    assert.deepEqual(diagnostic.interpretDiagnosticArtifacts(receipt, validWitness()), {
      outcome: 'diagnostic-failure',
      reason: 'runner-nonterminal',
      next_decision: 'fix-review-and-rerun-changed-diagnostic',
      slow_valid_observed: false,
      cleanup_confirmed: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertExactHardDeadlineProcessExitRoundTrip() {
  const diagnostic = await diagnosticModule();
  assert.equal(diagnostic.classifyDiagnosticEvent({
    result: diagnosticAttempt({
      status: 'operational_error', errorCode: 'ROUTER_PROCESS_EXIT',
      elapsedMs: 120_001, payloadValid: false, cleanupConfirmed: true,
    }),
  }).reason, 'invalid-evidence');
  assert.equal(diagnostic.classifyDiagnosticEvent({
    result: diagnosticAttempt({
      status: 'operational_error', errorCode: 'ROUTER_TIMEOUT',
      phase: 'awaiting_output', elapsedMs: 119_999,
      payloadValid: false, cleanupConfirmed: true,
    }),
  }).reason, 'invalid-evidence');
  const result = diagnosticAttempt({
    status: 'operational_error',
    errorCode: 'ROUTER_PROCESS_EXIT',
    elapsedMs: 120_000,
    payloadValid: false,
    cleanupConfirmed: true,
  });
  const decision = diagnostic.classifyDiagnosticEvent({ result, callOrdinal: 1 });
  assert.deepEqual([decision.outcome, decision.reason], [
    'diagnostic-failure', 'early-process-exit',
  ]);

  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-exit-boundary-'));
  const receiptPath = path.join(root, 'receipt.json');
  try {
    let receipt = await diagnostic.createDiagnosticReceipt(receiptPath);
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'preflight', campaign_elapsed_ms: 0,
    });
    receipt = await diagnostic.checkpointDiagnosticReceipt(receiptPath, receipt, {
      kind: 'attempt', campaign_elapsed_ms: 120_000, reason: decision.reason,
      attempt: {
        fixture_id: 'work-01', repetition: 1, ordinal: 1,
        evidence: result.attemptEvidence,
        slow_valid: decision.slow_valid,
        attempted_call_result: decision.outcome,
        terminal_result: decision.outcome,
      },
    });
    assert.deepEqual([receipt.terminal.outcome, receipt.terminal.reason], [
      'diagnostic-failure', 'early-process-exit',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertTimeoutStreamPrecedenceRoundTrips() {
  const diagnostic = await diagnosticModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-timeout-stream-precedence-'));
  const cases = [
    {
      name: 'after-input',
      phase: 'awaiting_output',
      outcome: 'route-unsuitable-at-diagnostic-ceiling',
      reason: 'hard-timeout-after-input',
      overLimit: { stdoutBytes: 'over_limit' },
    },
    {
      name: 'before-input',
      phase: 'starting',
      outcome: 'diagnostic-failure',
      reason: 'hard-timeout-before-input',
      overLimit: { stderrBytes: 'over_limit' },
    },
  ];
  try {
    for (const row of cases) {
      const cleanResult = diagnosticAttempt({
        status: 'operational_error', errorCode: 'ROUTER_TIMEOUT',
        phase: row.phase, elapsedMs: 120_000, payloadValid: false, cleanupConfirmed: true,
      });
      const decision = diagnostic.classifyDiagnosticEvent({ result: cleanResult, callOrdinal: 1 });
      assert.deepEqual([decision.outcome, decision.reason], [row.outcome, row.reason], row.name);

      const cleanPath = path.join(root, `${row.name}-clean.json`);
      let cleanReceipt = await diagnostic.createDiagnosticReceipt(cleanPath);
      cleanReceipt = await diagnostic.checkpointDiagnosticReceipt(cleanPath, cleanReceipt, {
        kind: 'preflight', campaign_elapsed_ms: 0,
      });
      cleanReceipt = await diagnostic.checkpointDiagnosticReceipt(cleanPath, cleanReceipt, {
        kind: 'attempt', campaign_elapsed_ms: 120_000, reason: decision.reason,
        attempt: {
          fixture_id: 'work-01', repetition: 1, ordinal: 1,
          evidence: cleanResult.attemptEvidence,
          slow_valid: decision.slow_valid,
          attempted_call_result: decision.outcome,
          terminal_result: decision.outcome,
        },
      });
      assert.deepEqual([cleanReceipt.terminal.outcome, cleanReceipt.terminal.reason], [
        row.outcome, row.reason,
      ], row.name);

      const overLimitResult = diagnosticAttempt({
        status: 'operational_error', errorCode: 'ROUTER_TIMEOUT',
        phase: row.phase, elapsedMs: 120_000, payloadValid: false, cleanupConfirmed: true,
        ...row.overLimit,
      });
      assert.equal(
        diagnostic.classifyDiagnosticEvent({ result: overLimitResult }).reason,
        'stream-over-limit',
        row.name,
      );
      const tamperedPath = path.join(root, `${row.name}-tampered.json`);
      let tamperedReceipt = await diagnostic.createDiagnosticReceipt(tamperedPath);
      tamperedReceipt = await diagnostic.checkpointDiagnosticReceipt(
        tamperedPath,
        tamperedReceipt,
        { kind: 'preflight', campaign_elapsed_ms: 0 },
      );
      await assert.rejects(diagnostic.checkpointDiagnosticReceipt(
        tamperedPath,
        tamperedReceipt,
        {
          kind: 'attempt', campaign_elapsed_ms: 120_000, reason: row.reason,
          attempt: {
            fixture_id: 'work-01', repetition: 1, ordinal: 1,
            evidence: overLimitResult.attemptEvidence,
            slow_valid: false,
            attempted_call_result: row.outcome,
            terminal_result: row.outcome,
          },
        },
      ), /stream|terminal/, row.name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

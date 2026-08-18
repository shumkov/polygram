'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, realpath, rm, writeFile, readdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = '../scripts/spikes/memory-routing-gate';

async function modules() {
  const [contract, fixtures, harness, adapters, runner] = await Promise.all([
    import(`${ROOT}/contract.mjs`),
    import(`${ROOT}/fixtures.mjs`),
    import(`${ROOT}/harness.mjs`),
    import(`${ROOT}/adapters.mjs`),
    import(`${ROOT}/run.mjs`),
  ]);
  return { contract, fixtures, harness, adapters, runner };
}

test('U24 corpus freezes the reviewed 26-case composition', async () => {
  const { fixtures } = await modules();
  const rows = fixtures.loadRoutingFixtures();
  assert.equal(rows.length, 26);
  assert.deepEqual(Object.fromEntries(Object.entries(Object.groupBy(rows, (row) => row.family))
    .map(([family, group]) => [family, group.length])), {
    work: 8,
    personal: 8,
    mixed: 4,
    semantic_uncertain: 2,
    known_secret: 2,
    prose_secret: 2,
  });
  const digest = fixtures.fixtureManifestHash(rows);
  assert.match(digest, /^[a-f0-9]{64}$/);
  const changedOracle = structuredClone(rows);
  changedOracle.find((row) => row.family === 'mixed').oracleOutput.parts[0].text = 'Different accepted split.';
  assert.notEqual(fixtures.fixtureManifestHash(changedOracle), digest);
});

test('U24 secret decision quarantines before the router sees the fact', async () => {
  const { fixtures, harness } = await modules();
  let calls = 0;
  const adapter = {
    id: 'must-not-run',
    route: async () => { calls += 1; return { raw: '{}' }; },
  };
  const secretRows = fixtures.loadRoutingFixtures().filter((row) => row.expected === 'quarantine');
  for (const fixture of secretRows) {
    const result = await harness.runRoutingCase({ fixture, adapter });
    assert.equal(result.status, 'quarantined', fixture.id);
    assert.equal(result.errorCode, 'ROUTER_SECRET_REJECTED', fixture.id);
  }
  assert.equal(calls, 0);
});

test('U24 fact and output limits have one satisfiable 500-character boundary', async () => {
  const { contract } = await modules();
  const atLimit = 'w'.repeat(500);
  assert.equal(contract.prepareRoutingFact(atLimit).ok, true);
  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'work', parts: [{ kind: 'work', text: atLimit }],
  }), { sourceFact: atLimit }).ok, true);
  assert.equal(contract.prepareRoutingFact('w'.repeat(501)).errorCode, 'ROUTER_INPUT_INVALID');
});

test('U24 closed schema rejects extra fields, invalid shapes, and overlapping mixed parts', async () => {
  const { contract } = await modules();
  const fact = 'Atlas delivery moved to Friday because Ivan has a medical appointment.';
  const valid = {
    category: 'mixed',
    parts: [
      { kind: 'work', text: 'Atlas delivery moved to Friday.' },
      { kind: 'sensitive', text: 'Ivan has a medical appointment.' },
    ],
  };
  assert.equal(contract.validateRouterOutput(JSON.stringify(valid), { sourceFact: fact }).ok, true);
  assert.equal(contract.validateRouterOutput(JSON.stringify({ ...valid, destination: 'general' }), { sourceFact: fact }).errorCode, 'ROUTER_OUTPUT_SCHEMA');
  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'mixed',
    parts: [
      { kind: 'work', text: 'Atlas delivery moved to Friday.' },
      { kind: 'sensitive', text: 'Atlas delivery moved to Friday.' },
    ],
  }), { sourceFact: fact }).errorCode, 'ROUTER_PARTS_OVERLAP');
  assert.equal(contract.validateRouterOutput('{bad', { sourceFact: fact }).errorCode, 'ROUTER_OUTPUT_MALFORMED');

  const leakedMixed = contract.validateRouterOutput(JSON.stringify({
    category: 'mixed',
    parts: [
      { kind: 'work', text: 'Atlas delivery moved to Friday because Ivan has a medical appointment.' },
      { kind: 'sensitive', text: 'Ivan medical detail.' },
    ],
  }), { sourceFact: fact });
  assert.equal(leakedMixed.errorCode, 'ROUTER_MIXED_NOT_EXTRACTIVE');

  const paraphrasedLeak = contract.validateRouterOutput(JSON.stringify({
    category: 'mixed',
    parts: [
      { kind: 'work', text: 'Atlas delivery moved to Friday because Ivan must visit his physician.' },
      { kind: 'sensitive', text: 'Ivan has a medical appointment.' },
    ],
  }), { sourceFact: fact });
  assert.equal(paraphrasedLeak.errorCode, 'ROUTER_MIXED_NOT_EXTRACTIVE');
  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'mixed',
    parts: [
      { kind: 'work', text: 'Atlas Friday.' },
      { kind: 'sensitive', text: 'Ivan medical.' },
    ],
  }), { sourceFact: fact }).errorCode, 'ROUTER_MIXED_NOT_EXTRACTIVE');
});

test('U24 deterministic personal veto blocks personal-to-work leakage without treating security work as personal', async () => {
  const { contract } = await modules();
  const personal = 'Ivan requested that his compensation adjustment remain private.';
  const leaked = contract.validateRouterOutput(JSON.stringify({
    category: 'work',
    parts: [{ kind: 'work', text: personal }],
  }), { sourceFact: personal });
  assert.equal(leaked.errorCode, 'ROUTER_PERSONAL_VETO');

  const securityWork = 'The UMI security review found an outdated dependency in production.';
  assert.equal(contract.hasPersonalSensitivityCue(securityWork), false);
  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'work',
    parts: [{ kind: 'work', text: securityWork }],
  }), { sourceFact: securityWork }).ok, true);

  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'work',
    parts: [{ kind: 'work', text: 'Completely unrelated.' }],
  }), { sourceFact: securityWork }).errorCode, 'ROUTER_OUTPUT_COVERAGE');
});

test('U24 harness counts every repetition and fails on one private-to-work leak', async () => {
  const { fixtures, harness } = await modules();
  const rows = fixtures.loadRoutingFixtures();
  const adapter = {
    id: 'oracle',
    route: async ({ fixture }) => ({ raw: JSON.stringify(fixture.oracleOutput), toolCalls: 0 }),
  };
  const green = await harness.runRoutingEvaluation({ fixtures: rows, adapters: [adapter], repetitions: 5 });
  assert.equal(green.passed, true);
  assert.equal(green.adapters[0].routeCaseCount, 130);
  assert.equal(green.adapters[0].acceptedCaseCount, 110);
  assert.equal(green.adapters[0].quarantinedCaseCount, 20);
  assert.equal(green.adapters[0].privateToWorkLeaks, 0);
  assert.doesNotMatch(JSON.stringify(green), /compensation|password|medical appointment/i);

  const leaking = {
    id: 'leaking',
    route: async ({ fixture }) => ({
      raw: JSON.stringify(fixture.family === 'personal' ? {
        category: 'work', parts: [{ kind: 'work', text: fixture.fact }],
      } : fixture.oracleOutput),
      toolCalls: 0,
    }),
  };
  const red = await harness.runRoutingEvaluation({ fixtures: rows, adapters: [leaking], repetitions: 1 });
  assert.equal(red.passed, false);
  assert.ok(red.adapters[0].privateToWorkLeaks > 0);
});

test('U24 treats tool use and four injected process/output faults as destination-free operational errors', async () => {
  const { fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.family === 'work');
  const toolUse = await harness.runRoutingCase({
    fixture,
    adapter: { id: 'tooling', route: async () => ({ raw: '{}', toolCalls: 1 }) },
  });
  assert.deepEqual(toolUse, {
    fixtureId: fixture.id,
    expected: fixture.expected,
    status: 'operational_error',
    errorCode: 'ROUTER_TOOL_USE',
  });
  for (const errorCode of ['ROUTER_TIMEOUT', 'ROUTER_PROCESS_EXIT', 'ROUTER_OUTPUT_MALFORMED', 'ROUTER_OUTPUT_SCHEMA']) {
    const result = await harness.runFaultCase({ adapterId: 'candidate', errorCode });
    assert.equal(result.status, 'operational_error');
    assert.equal(result.destinationSelected, false);
  }
  let routedCases = 0;
  const faultGate = await harness.runFaultEvaluation({
    adapterIds: ['claude'],
    fixture,
    repetitions: 5,
    runCase: async (input) => { routedCases += 1; return harness.runRoutingCase(input); },
  });
  assert.equal(faultGate.passed, true);
  assert.equal(faultGate.caseCount, 20);
  assert.equal(routedCases, 20);
  assert.ok(faultGate.outcomes.every((row) => row.queueForRetry && row.destinations.length === 0));
});

test('U24 member-DM projection dual-writes semantic uncertainty and never routes faults', async () => {
  const { harness } = await modules();
  assert.deepEqual(harness.projectMemberDmOutcome({ status: 'accepted', category: 'semantic_uncertain' }), {
    queueForRetry: false,
    writes: [{ kind: 'work', destinations: ['own_private', 'general'] }],
  });
  assert.deepEqual(harness.projectMemberDmOutcome({ status: 'operational_error' }), {
    queueForRetry: true,
    destinations: [],
  });
  assert.deepEqual(harness.projectMemberDmOutcome({
    status: 'accepted', category: 'mixed', partKinds: ['work', 'sensitive'],
  }), {
    queueForRetry: false,
    writes: [
      { kind: 'work', destinations: ['own_private', 'general'] },
      { kind: 'sensitive', destinations: ['own_private'] },
    ],
  });
});

test('U24 fixes Claude tools off and proves first-party subscription status without auth env', async () => {
  const { adapters } = await modules();
  const claude = adapters.buildClaudeInvocation({ binary: '/opt/claude', model: 'haiku', schema: { type: 'object' } });
  for (const flag of ['--safe-mode', '--tools', '--json-schema', '--no-session-persistence']) {
    assert.ok(claude.argv.includes(flag), flag);
  }
  assert.equal(claude.argv[claude.argv.indexOf('--tools') + 1], '');

  const env = adapters.subscriptionOnlyEnv({
    HOME: '/home/router', PATH: '/bin', LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'remove', CODEX_API_KEY: 'remove', ANTHROPIC_API_KEY: 'remove',
    ANTHROPIC_AUTH_TOKEN: 'remove', CLAUDE_CODE_USE_BEDROCK: 'remove', AWS_ACCESS_KEY_ID: 'remove',
  });
  assert.deepEqual(env, { HOME: '/home/router', PATH: '/bin', LANG: 'en_US.UTF-8' });

  assert.deepEqual(adapters.parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
  })), { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
  assert.throws(() => adapters.parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty',
  })), /ROUTER_AUTH_AMBIGUOUS/);
  assert.throws(() => adapters.parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true, authMethod: 'future-first-party', apiProvider: 'firstParty',
  })), /ROUTER_AUTH_AMBIGUOUS/);
  assert.deepEqual(adapters.parseCodexLoginStatus('Logged in using ChatGPT\n'), {
    loggedIn: true,
    authMethod: 'chatgpt',
  });
  assert.throws(() => adapters.parseCodexLoginStatus('Logged in using an API key'), /ROUTER_AUTH_AMBIGUOUS/);
});

test('U24 Claude envelope exposes one observed model and rejects API/auth errors', async () => {
  const { adapters } = await modules();
  const parsed = adapters.parseClaudeResult(JSON.stringify({
    is_error: false,
    structured_output: { category: 'work', parts: [{ kind: 'work', text: 'Fact.' }] },
    modelUsage: { 'claude-haiku-example': { inputTokens: 1 } },
  }));
  assert.deepEqual(parsed, {
    raw: '{"category":"work","parts":[{"kind":"work","text":"Fact."}]}',
    observedModels: ['claude-haiku-example'],
  });
  assert.throws(() => adapters.parseClaudeResult(JSON.stringify({
    is_error: true, result: 'Not logged in; secret diagnostic must not escape', modelUsage: {},
  })), /ROUTER_AUTH_UNAVAILABLE/);
});

test('U24 runner requires explicit absolute pinned binaries, receipt, and bounded mode', async () => {
  const { runner } = await modules();
  assert.deepEqual(runner.parseArgs([
    '--codex-bin', '/opt/codex-0.145.0',
    '--claude-bin', '/opt/claude-2.1.220',
    '--output', '/private/tmp/u24.json',
    '--mode', 'shape',
  ]), {
    codexBin: '/opt/codex-0.145.0',
    claudeBin: '/opt/claude-2.1.220',
    output: '/private/tmp/u24.json',
    mode: 'shape',
  });
  assert.throws(() => runner.parseArgs([
    '--codex-bin', 'codex', '--claude-bin', '/opt/claude',
    '--output', '/tmp/u24.json', '--mode', 'shape',
  ]), /must be absolute/);
  assert.throws(() => runner.parseArgs([
    '--codex-bin', '/opt/codex', '--claude-bin', '/opt/claude',
    '--output', '/tmp/u24.json', '--mode', 'quick',
  ]), /shape or full/);
  assert.throws(() => runner.parseArgs([
    '--codex-bin', '/opt/codex', '--claude-bin', '/opt/claude',
    '--output', '/tmp/u24.json', '--mode', 'full',
  ]), /expected-model/);

  const failure = Object.assign(new Error('secret process text'), {
    code: 'ROUTER_PROCESS_EXIT',
    diagnostics: { exitCode: 1, signal: null, stderrBytes: 42, stderrSha256: 'a'.repeat(64) },
  });
  assert.deepEqual(runner.buildStopReceipt(failure).failure, {
    code: 'ROUTER_PROCESS_EXIT',
    exitCode: 1,
    signal: null,
    stderrBytes: 42,
    cleanupConfirmed: false,
  });
  assert.equal(JSON.stringify(runner.buildStopReceipt(failure)).includes('secret process text'), false);
  assert.equal(JSON.stringify(runner.buildStopReceipt(failure)).includes('a'.repeat(64)), false);
  assert.equal(runner.buildStopReceipt(Object.assign(new Error('unsafe'), {
    code: 'CODEX_BINARY_MISMATCH',
  })).failure.code, 'ROUTER_CODEX_RUNTIME_MISMATCH');
});

test('U24 exact observed Haiku model is required and routing errors keep only safe diagnostics', async () => {
  const { fixtures, harness } = await modules();
  const rows = fixtures.loadRoutingFixtures();
  const wrongModel = {
    id: 'claude:haiku',
    requireModelEvidence: true,
    expectedObservedModel: 'claude-haiku-exact',
    route: async ({ fixture }) => ({
      raw: JSON.stringify(fixture.oracleOutput),
      toolCalls: 0,
      observedModels: ['claude-sonnet-wrong'],
    }),
  };
  const result = await harness.runRoutingEvaluation({ fixtures: rows, adapters: [wrongModel], repetitions: 1 });
  assert.equal(result.passed, false);
  assert.equal(result.adapters[0].modelIdentityResolved, false);

  const work = rows.find((row) => row.family === 'work');
  const failed = await harness.runRoutingCase({
    fixture: work,
    adapter: {
      id: 'diagnostic',
      route: async () => {
        throw Object.assign(new Error('raw secret stderr'), {
          code: 'ROUTER_PROCESS_EXIT',
          diagnostics: { exitCode: 7, signal: 'SIGKILL', stderrBytes: 55, cleanupConfirmed: true },
        });
      },
    },
  });
  assert.deepEqual(failed.diagnostics, {
    exitCode: 7,
    signal: 'SIGKILL',
    stderrBytes: 55,
    cleanupConfirmed: true,
  });
  assert.equal(JSON.stringify(failed).includes('raw secret stderr'), false);
});

test('U24 timeout kills the process group and successful adapter cleanup removes its temp directory', {
  skip: process.platform === 'win32',
}, async () => {
  const { adapters } = await modules();
  const root = await mkdtemp(path.join(os.tmpdir(), 'polygram-u24-process-test-'));
  const pidPath = path.join(root, 'grandchild.pid');
  try {
    const script = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      'setInterval(()=>{},1000);',
    ].join('');
    await assert.rejects(adapters.runProcess({
      binary: process.execPath,
      argv: ['-e', script],
      cwd: root,
      input: '',
      timeoutMs: 1_000,
      env: adapters.subscriptionOnlyEnv(),
    }), (error) => error.code === 'ROUTER_TIMEOUT' && error.diagnostics.cleanupConfirmed === true);
    const grandchildPid = Number(await readFile(pidPath, 'utf8'));
    assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);

    const fakeClaude = path.join(root, 'fake-claude');
    const cwdReceipt = path.join(root, 'adapter-cwd');
    const envelope = JSON.stringify({
      is_error: false,
      structured_output: { category: 'work', parts: [{ kind: 'work', text: 'Synthetic.' }] },
      modelUsage: { 'claude-haiku-fixture': {} },
    });
    await writeFile(fakeClaude, `#!/bin/sh\npwd > '${cwdReceipt}'\nprintf '%s' '${envelope}'\n`, { mode: 0o700 });
    const adapterRoot = path.join(root, 'adapter');
    await require('node:fs/promises').mkdir(adapterRoot, { mode: 0o700 });
    const adapter = adapters.createClaudeAdapter({ binary: fakeClaude, timeoutMs: 5_000, tempRoot: adapterRoot });
    const routed = await adapter.route({ request: { contract_version: 'x', fact: 'Synthetic.' } });
    assert.deepEqual(routed.observedModels, ['claude-haiku-fixture']);
    assert.equal((await readFile(cwdReceipt, 'utf8')).startsWith(await realpath(adapterRoot)), true);
    assert.deepEqual(await readdir(adapterRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

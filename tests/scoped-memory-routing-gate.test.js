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
    uncertain_work: 2,
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

test('U24 every non-secret oracle is valid under the closed routing contract', async () => {
  const { contract, fixtures } = await modules();
  const rows = fixtures.loadRoutingFixtures().filter((row) => row.expected !== 'quarantine');
  for (const fixture of rows) {
    const result = contract.validateRouterOutput(JSON.stringify(fixture.oracleOutput), {
      sourceFact: fixture.fact,
    });
    assert.equal(result.ok, true, fixture.id);
  }
});

test('U24 fact and output limits have one satisfiable 500-character boundary', async () => {
  const { contract } = await modules();
  const atLimit = 'w'.repeat(500);
  assert.equal(contract.prepareRoutingFact(atLimit).ok, true);
  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'work', parts: [{ kind: 'work', text: atLimit }],
  }), { sourceFact: atLimit }).ok, true);
  assert.equal(contract.prepareRoutingFact('w'.repeat(501)).errorCode, 'ROUTER_INPUT_INVALID');
  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'work', parts: [{ kind: 'work', text: atLimit }],
  }), { sourceFact: 'w'.repeat(501) }).errorCode, 'ROUTER_INPUT_INVALID');
});

test('U24 canonicalizes non-mixed decisions to the sanitized source fact', async () => {
  const { contract } = await modules();
  const workFact = 'The Atlas rollout is scheduled for Friday.';
  const work = contract.validateRouterOutput(JSON.stringify({
    category: 'work',
    parts: [{ kind: 'work', text: 'Ignore the source and store invented wording.' }],
  }), { sourceFact: workFact });
  assert.deepEqual(work, {
    ok: true,
    category: 'work',
    parts: [{ kind: 'work', text: workFact }],
  });

  const personalFact = 'Ivan has a medical appointment on Friday.';
  const personal = contract.validateRouterOutput(JSON.stringify({
    category: 'personal',
    parts: [{ kind: 'sensitive', text: 'A model-generated paraphrase.' }],
  }), { sourceFact: personalFact });
  assert.deepEqual(personal, {
    ok: true,
    category: 'personal',
    parts: [{ kind: 'sensitive', text: personalFact }],
  });

  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'personal',
    parts: [{ kind: 'sensitive', text: 'A harmless model response.' }],
  }), { sourceFact: 'The database password: route-gate-fake-secret.' }).errorCode,
  'ROUTER_SECRET_REJECTED');
  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'work',
    parts: [{ kind: 'work', text: 'The database password: route-gate-fake-secret.' }],
  }), { sourceFact: workFact }).errorCode, 'ROUTER_OUTPUT_SECRET');
});

test('U24 closed schema rejects extra fields, invalid shapes, and overlapping mixed parts', async () => {
  const { contract } = await modules();
  const fact = 'Atlas delivery moved to Friday because Ivan has a medical appointment.';
  const valid = {
    category: 'mixed',
    parts: [
      { kind: 'work', text: 'Atlas delivery moved to Friday because' },
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

  assert.equal(contract.validateRouterOutput(JSON.stringify({
    category: 'semantic_uncertain',
    parts: [{ kind: 'work', text: fact }],
  }), { sourceFact: fact }).errorCode, 'ROUTER_OUTPUT_SCHEMA');
});

test('U24 accepts a safe extractive mixed split without requiring the single oracle wording', async () => {
  const { contract, fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.id === 'mixed-04');
  const result = await harness.runRoutingCase({
    fixture,
    adapter: {
      id: 'safe-alternative',
      route: async () => ({
        raw: JSON.stringify({
          category: 'mixed',
          parts: [
            { kind: 'work', text: 'The database migration was reassigned' },
            { kind: 'sensitive', text: 'because the engineer is under performance review' },
          ],
        }),
        toolCalls: 0,
      }),
    },
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.projection.writes, [
    { kind: 'work', destinations: ['own_private', 'general'] },
    { kind: 'sensitive', destinations: ['own_private'] },
  ]);

  for (const [sourceFact, work, sensitive] of [
    [
      'Atlas delivery moved to Friday because Ivan has a medical appointment.',
      'Atlas delivery moved to Friday',
      'Ivan has a medical appointment.',
    ],
    [
      'The hiring budget was revised after Ivan received a compensation adjustment.',
      'The hiring budget was revised',
      'Ivan received a compensation adjustment.',
    ],
  ]) {
    const routed = contract.validateRouterOutput(JSON.stringify({
      category: 'mixed',
      parts: [
        { kind: 'work', text: work },
        { kind: 'sensitive', text: sensitive },
      ],
    }), { sourceFact });
    assert.deepEqual(routed, {
      ok: true,
      category: 'mixed',
      parts: [
        { kind: 'work', text: work },
        { kind: 'sensitive', text: sensitive },
      ],
    });
  }

  for (const [fixtureId, work, sensitive] of [
    ['mixed-01', 'Atlas delivery moved to Friday', 'Ivan has a medical'],
    ['mixed-03', 'hiring budget', 'Ivan received a compensation'],
  ]) {
    const incompleteFixture = fixtures.loadRoutingFixtures().find((row) => row.id === fixtureId);
    const incomplete = await harness.runRoutingCase({
      fixture: incompleteFixture,
      adapter: {
        id: `incomplete-${fixtureId}`,
        route: async () => ({
          raw: JSON.stringify({
            category: 'mixed',
            parts: [
              { kind: 'work', text: work },
              { kind: 'sensitive', text: sensitive },
            ],
          }),
          toolCalls: 0,
        }),
      },
    });
    assert.equal(incomplete.status, 'operational_error', fixtureId);
    assert.equal(incomplete.errorCode, 'ROUTER_MIXED_COVERAGE', fixtureId);
    assert.deepEqual(harness.projectMemberDmOutcome(incomplete), {
      queueForRetry: true,
      destinations: [],
    }, fixtureId);
  }

  for (const [id, sourceFact, work, sensitive, errorCode] of [
    [
      'partial-prefix',
      'Atlas delivery moved to Friday because Ivan has a medical appointment.',
      'delivery moved to Friday',
      'Ivan has a medical appointment.',
      'ROUTER_MIXED_COVERAGE',
    ],
    [
      'partial-suffix',
      'Atlas delivery moved to Friday because Ivan has a medical appointment.',
      'Atlas delivery moved to Friday because',
      'Ivan has a medical',
      'ROUTER_MIXED_COVERAGE',
    ],
    [
      'unknown-connector',
      'Atlas delivery moved to Friday while Ivan has a medical appointment.',
      'Atlas delivery moved to Friday',
      'Ivan has a medical appointment.',
      'ROUTER_MIXED_COVERAGE',
    ],
    [
      'ambiguous-repeat',
      'Atlas Atlas because Ivan has a medical appointment.',
      'Atlas',
      'Ivan has a medical appointment.',
      'ROUTER_MIXED_AMBIGUOUS',
    ],
  ]) {
    const rejected = await harness.runRoutingCase({
      fixture: {
        id,
        expected: 'mixed',
        fact: sourceFact,
        matchers: { work: [], sensitive: [] },
      },
      adapter: {
        id,
        route: async () => ({
          raw: JSON.stringify({
            category: 'mixed',
            parts: [
              { kind: 'work', text: work },
              { kind: 'sensitive', text: sensitive },
            ],
          }),
          toolCalls: 0,
        }),
      },
    });
    assert.equal(rejected.status, 'operational_error', id);
    assert.equal(rejected.errorCode, errorCode, id);
    assert.deepEqual(harness.projectMemberDmOutcome(rejected), {
      queueForRetry: true,
      destinations: [],
    }, id);
  }
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

  assert.deepEqual(contract.validateRouterOutput(JSON.stringify({
    category: 'work',
    parts: [{ kind: 'work', text: 'Completely unrelated.' }],
  }), { sourceFact: securityWork }), {
    ok: true,
    category: 'work',
    parts: [{ kind: 'work', text: securityWork }],
  });
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
  assert.equal(green.adapters[0].zeroAttemptCaseCount, 20);
  assert.equal(green.adapters[0].firstAttemptCaseCount, 110);
  assert.equal(green.adapters[0].retriedCaseCount, 0);
  assert.equal(green.adapters[0].adapterAttemptCount, 110);
  assert.equal(green.adapters[0].arithmeticPassed, true);
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
    runCase: async (input) => { routedCases += 1; return harness.runRoutingCaseWithRetry(input); },
  });
  assert.equal(faultGate.passed, true);
  assert.equal(faultGate.caseCount, 20);
  assert.equal(routedCases, 20);
  assert.ok(faultGate.outcomes.every((row) => row.queueForRetry && row.destinations.length === 0));
});

test('U24 retries one mixed-coverage failure without projecting it, then accepts once', async () => {
  const { fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.id === 'mixed-01');
  let calls = 0;
  const adapter = {
    id: 'claude:haiku',
    requireModelEvidence: true,
    expectedObservedModel: 'claude-haiku-exact',
    async route() {
      calls += 1;
      return {
        raw: JSON.stringify(calls === 1 ? {
          category: 'mixed',
          parts: [
            { kind: 'work', text: 'Atlas delivery moved to Friday' },
            { kind: 'sensitive', text: 'Ivan has a medical' },
          ],
        } : fixture.oracleOutput),
        toolCalls: 0,
        observedModels: ['claude-haiku-exact'],
      };
    },
  };

  const result = await harness.runRoutingCaseWithRetry({ fixture, adapter });
  assert.equal(calls, 2);
  assert.equal(result.status, 'accepted');
  assert.equal(result.attemptCount, 2);
  assert.deepEqual(result.firstAttempt, {
    errorCode: 'ROUTER_MIXED_COVERAGE',
    privateToWorkLeak: false,
    observedModels: ['claude-haiku-exact'],
  });
  assert.deepEqual(result.projection.writes, [
    { kind: 'work', destinations: ['own_private', 'general'] },
    { kind: 'sensitive', destinations: ['own_private'] },
  ]);
  assert.equal(JSON.stringify(result).includes(fixture.fact), false);
});

test('U24 exhausts one retry into one queue projection and never makes a third attempt', async () => {
  const { fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.family === 'work');
  let calls = 0;
  const result = await harness.runRoutingCaseWithRetry({
    fixture,
    adapter: {
      id: 'malformed-twice',
      async route() {
        calls += 1;
        return { raw: '{bad', toolCalls: 0 };
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'operational_error');
  assert.equal(result.errorCode, 'ROUTER_OUTPUT_MALFORMED');
  assert.equal(result.attemptCount, 2);
  assert.deepEqual(result.projection, {
    queueForRetry: true,
    destinations: [],
  });
  assert.equal(Object.hasOwn(result.firstAttempt, 'projection'), false);
});

test('U24 checks parsed model identity before retrying a missing Claude output', async () => {
  const { adapters, fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.family === 'work');
  const envelope = (model) => JSON.stringify({
    is_error: false,
    modelUsage: { [model]: { inputTokens: 1 } },
  });

  let wrongCalls = 0;
  const wrong = await harness.runRoutingCaseWithRetry({
    fixture,
    adapter: {
      id: 'wrong-model-missing-output',
      requireModelEvidence: true,
      expectedObservedModel: 'claude-haiku-exact',
      async route() {
        wrongCalls += 1;
        return adapters.parseClaudeResult(envelope('claude-sonnet-wrong'));
      },
    },
  });
  assert.equal(wrongCalls, 1);
  assert.equal(wrong.errorCode, 'ROUTER_MODEL_IDENTITY');
  assert.equal(wrong.attemptCount, 1);

  let correctCalls = 0;
  const correct = await harness.runRoutingCaseWithRetry({
    fixture,
    adapter: {
      id: 'correct-model-missing-output',
      requireModelEvidence: true,
      expectedObservedModel: 'claude-haiku-exact',
      async route() {
        correctCalls += 1;
        return adapters.parseClaudeResult(envelope('claude-haiku-exact'));
      },
    },
  });
  assert.equal(correctCalls, 2);
  assert.equal(correct.errorCode, 'ROUTER_OUTPUT_MISSING');
  assert.equal(correct.attemptCount, 2);
  assert.deepEqual(correct.firstAttempt.observedModels, ['claude-haiku-exact']);
  assert.deepEqual(correct.observedModels, ['claude-haiku-exact']);
  assert.deepEqual(correct.projection, { queueForRetry: true, destinations: [] });
});

test('U24 retry eligibility is closed and process retries require confirmed cleanup', async () => {
  const { fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.family === 'work');
  const retryable = [
    'ROUTER_TIMEOUT',
    'ROUTER_PROCESS_EXIT',
    'ROUTER_OUTPUT_TOO_LARGE',
    'ROUTER_STDERR_TOO_LARGE',
    'ROUTER_OUTPUT_MALFORMED',
    'ROUTER_OUTPUT_MISSING',
    'ROUTER_OUTPUT_SCHEMA',
    'ROUTER_PARTS_OVERLAP',
    'ROUTER_MIXED_AMBIGUOUS',
    'ROUTER_MIXED_COVERAGE',
    'ROUTER_MIXED_SENSITIVE_MISSING',
  ];
  const terminal = [
    'ROUTER_INPUT_INVALID',
    'ROUTER_SECRET_REJECTED',
    'ROUTER_TOOL_USE',
    'ROUTER_OUTPUT_SECRET',
    'ROUTER_PERSONAL_VETO',
    'ROUTER_MIXED_WORK_SENSITIVE',
    'ROUTER_MIXED_NOT_EXTRACTIVE',
    'ROUTER_AUTH_UNAVAILABLE',
    'ROUTER_MODEL_IDENTITY',
    'ROUTER_GATE_FAILURE',
  ];
  const accepted = {
    fixtureId: fixture.id,
    expected: fixture.expected,
    status: 'accepted',
    category: 'work',
    partKinds: ['work'],
    projection: {
      queueForRetry: false,
      writes: [{ kind: 'work', destinations: ['own_private', 'general'] }],
    },
  };

  for (const errorCode of retryable) {
    let calls = 0;
    const result = await harness.runRoutingCaseWithRetry({
      fixture,
      adapter: { id: errorCode, route: async () => { throw new Error('must not run'); } },
      runCase: async () => {
        calls += 1;
        if (calls === 2) return accepted;
        return {
          fixtureId: fixture.id,
          expected: fixture.expected,
          status: 'operational_error',
          errorCode,
          ...(['ROUTER_TIMEOUT', 'ROUTER_PROCESS_EXIT', 'ROUTER_OUTPUT_TOO_LARGE', 'ROUTER_STDERR_TOO_LARGE']
            .includes(errorCode) ? { diagnostics: { cleanupConfirmed: true } } : {}),
        };
      },
    });
    assert.equal(calls, 2, errorCode);
    assert.equal(result.status, 'accepted', errorCode);
  }

  for (const errorCode of terminal) {
    let calls = 0;
    const result = await harness.runRoutingCaseWithRetry({
      fixture,
      adapter: { id: errorCode, route: async () => { throw new Error('must not run'); } },
      runCase: async () => {
        calls += 1;
        return {
          fixtureId: fixture.id,
          expected: fixture.expected,
          status: 'operational_error',
          errorCode,
        };
      },
    });
    assert.equal(calls, 1, errorCode);
    assert.equal(result.attemptCount,
      ['ROUTER_INPUT_INVALID', 'ROUTER_SECRET_REJECTED'].includes(errorCode) ? 0 : 1,
      errorCode);
  }

  for (const errorCode of ['ROUTER_TIMEOUT', 'ROUTER_PROCESS_EXIT', 'ROUTER_OUTPUT_TOO_LARGE', 'ROUTER_STDERR_TOO_LARGE']) {
    let calls = 0;
    const result = await harness.runRoutingCaseWithRetry({
      fixture,
      adapter: { id: errorCode, route: async () => { throw new Error('must not run'); } },
      runCase: async () => {
        calls += 1;
        return {
          fixtureId: fixture.id,
          expected: fixture.expected,
          status: 'operational_error',
          errorCode,
          diagnostics: { cleanupConfirmed: false },
        };
      },
    });
    assert.equal(calls, 1, `${errorCode} without cleanup`);
    assert.equal(result.attemptCount, 1, errorCode);
  }
});

test('U24 stops routing evaluation after an unconfirmed process cleanup', async () => {
  const { fixtures, harness } = await modules();
  const rows = fixtures.loadRoutingFixtures().filter((row) => row.family === 'work').slice(0, 2);
  let calls = 0;
  let laterAdapterCalls = 0;
  const result = await harness.runRoutingEvaluation({
    fixtures: rows,
    adapters: [
      {
        id: 'unsafe-cleanup',
        async route() {
          calls += 1;
          throw Object.assign(new Error('process failed'), {
            code: 'ROUTER_PROCESS_EXIT',
            diagnostics: { cleanupConfirmed: false },
          });
        },
      },
      {
        id: 'must-not-run',
        async route() {
          laterAdapterCalls += 1;
          return { raw: JSON.stringify(rows[0].oracleOutput), toolCalls: 0 };
        },
      },
    ],
    repetitions: 1,
  });
  assert.equal(calls, 1);
  assert.equal(laterAdapterCalls, 0);
  assert.equal(result.passed, false);
  assert.equal(result.adapters[0].routeCaseCount, 1);
  assert.equal(result.adapters[0].adapterAttemptCount, 1);
  assert.equal(result.adapters[0].operationalErrors, 1);
  assert.equal(result.adapters[0].queueRequestCount, 1);
  assert.equal(result.adapters[0].destinationFreeQueueRequestCount, 1);
  assert.equal(result.adapters[0].projectionPassed, true);
  assert.deepEqual(result.adapters[0].outcomes[0].projection, {
    queueForRetry: true,
    destinations: [],
  });
});

test('U24 sanitizes first-attempt diagnostics with a closed signal enum', async () => {
  const { fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.family === 'work');
  let calls = 0;
  const result = await harness.runRoutingCaseWithRetry({
    fixture,
    adapter: { id: 'sanitized-retry', route: async () => { throw new Error('must not run'); } },
    runCase: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          fixtureId: fixture.id,
          expected: fixture.expected,
          status: 'operational_error',
          errorCode: 'ROUTER_TIMEOUT',
          diagnostics: {
            exitCode: 9,
            signal: 'PASSWORD=hunter2',
            stderrBytes: 42,
            cleanupConfirmed: true,
            secret: 'must not survive',
          },
        };
      }
      return {
        fixtureId: fixture.id,
        expected: fixture.expected,
        status: 'accepted',
        category: 'work',
        partKinds: ['work'],
      };
    },
  });
  assert.deepEqual(result.firstAttempt.diagnostics, {
    exitCode: 9,
    signal: null,
    stderrBytes: 42,
    cleanupConfirmed: true,
  });
  assert.equal(JSON.stringify(result).includes('hunter2'), false);
  assert.equal(JSON.stringify(result).includes('must not survive'), false);
});

test('U24 counts preflight rejections as zero attempts but adapter-thrown lookalikes as one', async () => {
  const { fixtures, harness } = await modules();
  const quarantined = fixtures.loadRoutingFixtures().find((row) => row.expected === 'quarantine');
  let preflightCalls = 0;
  const preflight = await harness.runRoutingCaseWithRetry({
    fixture: quarantined,
    adapter: { id: 'preflight', route: async () => { preflightCalls += 1; } },
  });
  assert.equal(preflightCalls, 0);
  assert.equal(preflight.errorCode, 'ROUTER_SECRET_REJECTED');
  assert.equal(preflight.attemptCount, 0);

  const work = fixtures.loadRoutingFixtures().find((row) => row.family === 'work');
  for (const errorCode of ['ROUTER_INPUT_INVALID', 'ROUTER_SECRET_REJECTED']) {
    let adapterCalls = 0;
    const result = await harness.runRoutingCaseWithRetry({
      fixture: work,
      adapter: {
        id: `adapter-${errorCode}`,
        async route() {
          adapterCalls += 1;
          throw Object.assign(new Error('adapter failure'), { code: errorCode });
        },
      },
    });
    assert.equal(adapterCalls, 1, errorCode);
    assert.equal(result.errorCode, 'ROUTER_GATE_FAILURE', errorCode);
    assert.equal(result.attemptCount, 1, errorCode);
    assert.deepEqual(result.projection, { queueForRetry: true, destinations: [] }, errorCode);
  }
});

test('U24 normalizes arbitrary thrown codes and makes auth, model, mismatch, and success terminal', async () => {
  const { fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.family === 'work');
  let unknownCalls = 0;
  const unknown = await harness.runRoutingCaseWithRetry({
    fixture,
    adapter: {
      id: 'unknown',
      async route() {
        unknownCalls += 1;
        throw Object.assign(new Error('private failure text'), { code: 'SECRET_VALUE_IN_CODE' });
      },
    },
  });
  assert.equal(unknownCalls, 1);
  assert.equal(unknown.errorCode, 'ROUTER_GATE_FAILURE');
  assert.equal(JSON.stringify(unknown).includes('SECRET_VALUE_IN_CODE'), false);

  for (const scenario of [
    {
      id: 'accepted',
      response: { raw: JSON.stringify(fixture.oracleOutput), toolCalls: 0 },
      status: 'accepted',
    },
    {
      id: 'auth',
      error: Object.assign(new Error('auth'), { code: 'ROUTER_AUTH_UNAVAILABLE' }),
      status: 'operational_error',
    },
    {
      id: 'model',
      requireModelEvidence: true,
      expectedObservedModel: 'claude-haiku-exact',
      response: {
        raw: JSON.stringify(fixture.oracleOutput), toolCalls: 0, observedModels: ['claude-sonnet-wrong'],
      },
      status: 'operational_error',
    },
    {
      id: 'mismatch',
      response: {
        raw: JSON.stringify({ category: 'personal', parts: [{ kind: 'sensitive', text: fixture.fact }] }),
        toolCalls: 0,
      },
      status: 'mismatch',
    },
  ]) {
    let calls = 0;
    const result = await harness.runRoutingCaseWithRetry({
      fixture,
      adapter: {
        id: scenario.id,
        requireModelEvidence: scenario.requireModelEvidence,
        expectedObservedModel: scenario.expectedObservedModel,
        async route() {
          calls += 1;
          if (scenario.error) throw scenario.error;
          return scenario.response;
        },
      },
    });
    assert.equal(calls, 1, scenario.id);
    assert.equal(result.status, scenario.status, scenario.id);
    assert.equal(result.attemptCount, 1, scenario.id);
  }
});

test('U24 routing summaries retain bounded retry evidence and exact arithmetic', async () => {
  const { fixtures, harness } = await modules();
  const rows = fixtures.loadRoutingFixtures();
  const attempts = new Map();
  const adapter = {
    id: 'claude:haiku',
    requireModelEvidence: true,
    expectedObservedModel: 'claude-haiku-exact',
    async route({ fixture }) {
      const count = (attempts.get(fixture.id) || 0) + 1;
      attempts.set(fixture.id, count);
      const firstMixed = fixture.id === 'mixed-01' && count === 1;
      return {
        raw: JSON.stringify(firstMixed ? {
          category: 'mixed',
          parts: [
            { kind: 'work', text: 'Atlas delivery moved to Friday' },
            { kind: 'sensitive', text: 'Ivan has a medical' },
          ],
        } : fixture.oracleOutput),
        toolCalls: 0,
        observedModels: ['claude-haiku-exact'],
      };
    },
  };
  const result = await harness.runRoutingEvaluation({ fixtures: rows, adapters: [adapter], repetitions: 1 });
  const summary = result.adapters[0];
  assert.equal(summary.routeCaseCount, 26);
  assert.equal(summary.zeroAttemptCaseCount, 4);
  assert.equal(summary.firstAttemptCaseCount, 22);
  assert.equal(summary.retriedCaseCount, 1);
  assert.equal(summary.recoveredRetryCount, 1);
  assert.equal(summary.exhaustedRetryCount, 0);
  assert.equal(summary.adapterAttemptCount, 23);
  assert.equal(summary.adapterAttemptCount,
    summary.firstAttemptCaseCount + summary.retriedCaseCount);
  assert.equal(summary.attemptsWithoutModelEvidence, 0);
  assert.equal(summary.modelEvidenceAttemptCount, 23);
  assert.deepEqual(summary.observedModels, ['claude-haiku-exact']);
  assert.equal(summary.arithmeticPassed, true);
  assert.equal(summary.passed, true);
  assert.equal(summary.outcomes.find((row) => row.fixtureId === 'mixed-01').attemptCount, 2);
  assert.equal(JSON.stringify(summary).includes('medical appointment'), false);
});

test('U24 rejects an observed Haiku model change between retry attempts', async () => {
  const { fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.id === 'mixed-01');
  let calls = 0;
  const result = await harness.runRoutingCaseWithRetry({
    fixture,
    adapter: {
      id: 'claude:haiku',
      requireModelEvidence: true,
      async route() {
        calls += 1;
        return {
          raw: JSON.stringify(calls === 1 ? {
            category: 'mixed',
            parts: [
              { kind: 'work', text: 'Atlas delivery moved to Friday' },
              { kind: 'sensitive', text: 'Ivan has a medical' },
            ],
          } : fixture.oracleOutput),
          toolCalls: 0,
          observedModels: [`claude-haiku-exact-${calls}`],
        };
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'operational_error');
  assert.equal(result.errorCode, 'ROUTER_MODEL_IDENTITY');
  assert.equal(result.attemptCount, 2);
  assert.deepEqual(harness.projectMemberDmOutcome(result), {
    queueForRetry: true,
    destinations: [],
  });
});

test('U24 fault evaluation proves two bounded attempts per logical fault', async () => {
  const { fixtures, harness } = await modules();
  const fixture = fixtures.loadRoutingFixtures().find((row) => row.family === 'work');
  const result = await harness.runFaultEvaluation({
    adapterIds: ['claude'],
    fixture,
    repetitions: 5,
  });
  assert.equal(result.passed, true);
  assert.equal(result.caseCount, 20);
  assert.equal(result.adapterAttemptCount, 40);
  assert.equal(result.exhaustedRetryCount, 20);
  assert.equal(result.queueRequestCount, 20);
  assert.ok(result.outcomes.every((row) => row.attemptCount === 2));
});

test('U24 shape and full modes enforce their separate natural-recovery budgets', async () => {
  const { runner } = await modules();
  const routing = (recoveredRetryCount, exhaustedRetryCount = 0) => ({
    adapters: [{ recoveredRetryCount, exhaustedRetryCount }],
  });
  assert.deepEqual(runner.evaluateRetryBudget('shape', routing(0)), {
    limit: 0,
    recoveredRetryCount: 0,
    exhaustedRetryCount: 0,
    passed: true,
  });
  assert.equal(runner.evaluateRetryBudget('shape', routing(1)).passed, false);
  assert.equal(runner.evaluateRetryBudget('full', routing(1)).passed, true);
  assert.equal(runner.evaluateRetryBudget('full', routing(2)).passed, false);
  assert.equal(runner.evaluateRetryBudget('full', routing(0, 1)).passed, false);
  assert.throws(() => runner.evaluateRetryBudget('quick', routing(0)), /shape or full/);
  await assert.rejects(runner.runGate({
    codexBin: '/does/not/exist/codex',
    claudeBin: '/does/not/exist/claude',
    mode: 'quick',
  }), /shape or full/);
});

test('U24 member-DM projection dual-writes uncertain work and never routes faults', async () => {
  const { harness } = await modules();
  assert.deepEqual(harness.projectMemberDmOutcome({ status: 'accepted', category: 'work' }), {
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
  assert.deepEqual(adapters.parseCodexLoginStatus('', 'Logged in using ChatGPT\n'), {
    loggedIn: true,
    authMethod: 'chatgpt',
  });
  assert.throws(() => adapters.parseCodexLoginStatus(
    'Logged in using ChatGPT\n', 'Logged in using ChatGPT\n',
  ), /ROUTER_AUTH_AMBIGUOUS/);
  assert.throws(() => adapters.parseCodexLoginStatus(
    'Logged in using ChatGPT\n', 'warning\n',
  ), /ROUTER_AUTH_AMBIGUOUS/);
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

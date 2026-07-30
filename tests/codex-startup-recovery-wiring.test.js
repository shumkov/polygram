'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  resolveCodexStartupRecovery,
} = require('../lib/codex/runtime-controller');

test('Codex startup proof waits only for a verified takeover contract', async () => {
  const waits = [];
  assert.deepEqual(
    await resolveCodexStartupRecovery(
      { priorAction: 'sigterm-killed' },
      {
        claimThrowsOnSurvivingPredecessor: true,
        supervisorGraceMs: 1250,
        wait: async (ms) => waits.push(ms),
      },
    ),
    {
      exclusive_daemon_ownership: true,
      supervisor_grace_elapsed: true,
    },
  );
  assert.deepEqual(waits, [1250]);

  assert.deepEqual(
    await resolveCodexStartupRecovery(
      { priorAction: 'stale-overwritten' },
      {
        claimThrowsOnSurvivingPredecessor: true,
        supervisorGraceMs: 2000,
        wait: async (ms) => waits.push(ms),
      },
    ),
    {
      exclusive_daemon_ownership: true,
      supervisor_grace_elapsed: true,
    },
  );
  assert.deepEqual(waits, [1250, 2000]);

  for (const persistedLeaseStatus of ['active', 'quarantined']) {
    const ownershipWaits = [];
    let releaseWait;
    let recoveryResolved = false;
    const recovery = resolveCodexStartupRecovery(
      { priorAction: 'no-prior' },
      {
        claimThrowsOnSurvivingPredecessor: true,
        persistedLeaseStatus,
        supervisorGraceMs: 2000,
        wait: (ms) => {
          ownershipWaits.push(ms);
          return new Promise((resolve) => {
            releaseWait = resolve;
          });
        },
      },
    );
    recovery.then(() => {
      recoveryResolved = true;
    });
    await Promise.resolve();
    assert.deepEqual(ownershipWaits, [2000]);
    assert.equal(recoveryResolved, false);
    releaseWait();
    assert.deepEqual(
      await recovery,
      {
        exclusive_daemon_ownership: true,
        supervisor_grace_elapsed: true,
      },
    );
  }

  for (const persistedLeaseStatus of [null, 'clear']) {
    assert.deepEqual(
      await resolveCodexStartupRecovery(
        { priorAction: 'no-prior' },
        {
          claimThrowsOnSurvivingPredecessor: true,
          persistedLeaseStatus,
          supervisorGraceMs: 2000,
          wait: async () => assert.fail('absent or clear ownership must not wait'),
        },
      ),
      {
        exclusive_daemon_ownership: true,
        supervisor_grace_elapsed: true,
      },
    );
  }

  assert.deepEqual(
    await resolveCodexStartupRecovery(
      { priorAction: 'no-prior' },
      {
        claimThrowsOnSurvivingPredecessor: true,
        persistedLeaseStatus: 'malformed',
        supervisorGraceMs: 2000,
        wait: async () => assert.fail('malformed ownership must not wait'),
      },
    ),
    {
      exclusive_daemon_ownership: false,
      supervisor_grace_elapsed: false,
    },
  );
  assert.deepEqual(
    await resolveCodexStartupRecovery(
      { priorAction: 'no-prior' },
      {
        claimThrowsOnSurvivingPredecessor: true,
        persistedLeaseStatus: 'active',
        supervisorGraceMs: null,
        wait: async () => assert.fail('unproven ownership must not wait'),
      },
    ),
    {
      exclusive_daemon_ownership: false,
      supervisor_grace_elapsed: false,
    },
  );

  for (const priorAction of ['malformed-overwritten', 'sigkill-killed']) {
    assert.deepEqual(
      await resolveCodexStartupRecovery(
        { priorAction },
        {
          claimThrowsOnSurvivingPredecessor: false,
          supervisorGraceMs: 1250,
          wait: async () => assert.fail('unverified claims must not wait'),
        },
      ),
      {
        exclusive_daemon_ownership: false,
        supervisor_grace_elapsed: false,
      },
    );
  }
});

test('polygram wires startup recovery to Codex and never to tmux', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'polygram.js'),
    'utf8',
  );
  const tmuxWiring = source.slice(
    source.indexOf('runner: createTmuxRunner({'),
    source.indexOf('socketName: tmuxSocketName,', source.indexOf(
      'runner: createTmuxRunner({',
    )),
  );
  const codexWiring = source.slice(
    source.indexOf('codexRuntimeController = createCodexRuntimeController({'),
    source.indexOf('});', source.indexOf(
      'codexRuntimeController = createCodexRuntimeController({',
    )),
  );
  const startupRecoveryWiring = source.slice(
    source.indexOf('const startupRecovery = await resolveCodexStartupRecovery('),
    source.indexOf(
      'codexRuntimeController = createCodexRuntimeController({',
      source.indexOf('const startupRecovery = await resolveCodexStartupRecovery('),
    ),
  );
  assert.doesNotMatch(tmuxWiring, /startupRecovery/);
  assert.match(
    startupRecoveryWiring,
    /persistedLeaseStatus:\s*db\.getCodexLease\(\)\?\.status \?\? null/,
  );
  assert.match(codexWiring, /startupRecovery/);
});

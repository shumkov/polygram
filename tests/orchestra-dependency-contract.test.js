'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const packageJson = require('../package.json');
const lockfile = require('../package-lock.json');
const orchestra = require('@shumkov/orchestra');
const orchestraPackage = require('@shumkov/orchestra/package.json');

const REQUIRED_ORCHESTRA_VERSION = '0.12.2';

test('installed Orchestra exactly matches the reviewed Codex contract', () => {
  assert.equal(
    packageJson.dependencies['@shumkov/orchestra'],
    REQUIRED_ORCHESTRA_VERSION,
  );
  assert.equal(
    lockfile.packages[''].dependencies['@shumkov/orchestra'],
    REQUIRED_ORCHESTRA_VERSION,
  );
  assert.equal(
    lockfile.packages['node_modules/@shumkov/orchestra'].version,
    REQUIRED_ORCHESTRA_VERSION,
  );
  assert.equal(orchestraPackage.version, REQUIRED_ORCHESTRA_VERSION);

  for (const name of [
    'CodexProcess',
    'CodexAppServerClient',
    'preflightCodexRuntime',
    'createCodexSpawnProfile',
    'assertCodexSpawnProfile',
    'attestPinnedCodexHome',
    'buildCodexAppServerEnv',
    'characterizePinnedSessionLauncher',
    'resolveCodexTargetPin',
    'reattestCodexStaticPolicy',
  ]) {
    assert.equal(typeof orchestra[name], 'function', name);
  }
  assert.deepEqual(
    orchestra.resolveCodexTargetPin('darwin', 'arm64'),
    {
      target: 'aarch64-apple-darwin',
      cliVersion: 'codex-cli 0.167.2',
      binarySha256:
        '97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0',
    },
  );
  assert.deepEqual(
    orchestra.resolveCodexTargetPin('linux', 'x64'),
    {
      target: 'x86_64-unknown-linux-musl',
      cliVersion: 'codex-cli 0.167.2',
      binarySha256:
        'a9672d0fa0dd8fcf8cad136fa0d056b914bc046f5ac3d78f4a5cf390655af56b',
    },
  );
  assert.equal(typeof orchestra.codexProtocolSchema, 'object');
  // A failed claude cycle with no pending turn (a follow-up that ran after a
  // failed turn) reaches lib/sdk/callbacks.js onApiError only through this row.
  assert.equal(orchestra.CALLBACK_TO_EVENT.onApiError, 'api-error');
  assert.deepEqual(
    orchestra.codexProtocolSchema.clientRequests['hooks/list'],
    {
      required: ['cwds'],
      optional: [],
      internal: true,
      stateChanging: false,
    },
  );
  for (const method of ['hook/started', 'hook/completed']) {
    assert.equal(
      orchestra.codexProtocolSchema.droppedServerNotifications.includes(method),
      true,
      method,
    );
  }
  assert.equal(
    typeof orchestra.CodexAppServerClient.prototype.verifyHooks,
    'function',
  );
  assert.equal(typeof orchestra.ProcessManager.prototype.replaceRuntime, 'function');
  assert.equal(typeof orchestra.ProcessManager.prototype.steerTurn, 'function');
  assert.equal(typeof orchestra.ProcessManager.prototype.interrupt, 'function');
  assert.equal(
    typeof orchestra.ProcessManager.prototype.inspectCleanRestartQualification,
    'function',
  );
  assert.equal(typeof orchestra.ProcessManager.prototype.retireForCleanRestart, 'function');
  assert.equal(typeof orchestra.ProcessManager.prototype.retireExpectedProcess, 'function');
  assert.equal(
    orchestra.processGuard.CLAIM_PID_FILE_THROWS_ON_SURVIVING_PREDECESSOR,
    true,
  );
  assert.equal(orchestra.processGuard.CODEX_SUPERVISOR_GRACE_MS, 2_000);
});

test('installed Orchestra sends clean replay only to the expected live process', async () => {
  const manager = new orchestra.ProcessManager({
    processFactory: () => { throw new Error('unexpected spawn'); },
  });
  const calls = [];
  const process = {
    closed: false,
    async send(prompt, options) {
      calls.push({ prompt, options });
      return { ok: true };
    },
  };
  manager.procs.set('chat:topic', process);

  assert.deepEqual(
    await manager.send('chat:topic', 'continue', {
      expectedProcess: process,
      replay: true,
    }),
    { ok: true },
  );
  assert.deepEqual(calls, [{
    prompt: 'continue',
    options: { replay: true },
  }]);

  await assert.rejects(
    manager.send('chat:topic', 'wrong generation', {
      expectedProcess: {},
      replay: true,
    }),
    (error) => error?.code === 'PROCESS_PRECONDITION_FAILED',
  );
  process.closed = true;
  await assert.rejects(
    manager.send('chat:topic', 'closed generation', {
      expectedProcess: process,
      replay: true,
    }),
    (error) => error?.code === 'PROCESS_PRECONDITION_FAILED',
  );
  assert.equal(calls.length, 1);
});

// Orchestra pins the Agent SDK whose bundled claude defines the CLI pin; the
// gate spikes import the SDK through Polygram's own dependency. Both must name
// the same exact version, or npm installs a second ~240 MB copy and the gate
// exercises a different SDK than production runs.
test('Polygram and Orchestra pin the same exact Agent SDK version', () => {
  const sdk = '@anthropic-ai/claude-agent-sdk';
  const sdkEntry = require.resolve(sdk);
  const installedSdk = JSON.parse(fs.readFileSync(
    path.join(path.dirname(sdkEntry), 'package.json'), 'utf8',
  ));
  const requireFromOrchestra = createRequire(require.resolve('@shumkov/orchestra'));
  assert.equal(installedSdk.version, packageJson.dependencies[sdk]);
  assert.equal(
    installedSdk.claudeCodeVersion,
    orchestra.claudeBin.CLAUDE_CLI_PINNED_VERSION,
  );
  assert.equal(
    fs.realpathSync(sdkEntry),
    fs.realpathSync(requireFromOrchestra.resolve(sdk)),
    'Polygram and Orchestra load the same physical SDK entry',
  );
  assert.equal(
    packageJson.dependencies[sdk],
    orchestraPackage.optionalDependencies[sdk],
  );
  assert.equal(
    lockfile.packages[`node_modules/${sdk}`].version,
    packageJson.dependencies[sdk],
  );
  assert.equal(
    lockfile.packages[`node_modules/@shumkov/orchestra/node_modules/${sdk}`],
    undefined,
    'Orchestra resolves the same hoisted SDK copy',
  );
});

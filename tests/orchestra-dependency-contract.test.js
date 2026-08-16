'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../package.json');
const lockfile = require('../package-lock.json');
const orchestra = require('@shumkov/orchestra');
const orchestraPackage = require('@shumkov/orchestra/package.json');

const REQUIRED_ORCHESTRA_VERSION = '0.10.17';

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
      cliVersion: 'codex-cli 0.145.0',
      binarySha256:
        '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',
    },
  );
  assert.deepEqual(
    orchestra.resolveCodexTargetPin('linux', 'x64'),
    {
      target: 'x86_64-unknown-linux-musl',
      cliVersion: 'codex-cli 0.145.0',
      binarySha256:
        'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
    },
  );
  assert.equal(typeof orchestra.codexProtocolSchema, 'object');
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

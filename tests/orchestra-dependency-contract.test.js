'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../package.json');
const lockfile = require('../package-lock.json');
const orchestra = require('@shumkov/orchestra');
const orchestraPackage = require('@shumkov/orchestra/package.json');

const REQUIRED_ORCHESTRA_VERSION = '0.7.4';

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
    'reattestCodexStaticPolicy',
  ]) {
    assert.equal(typeof orchestra[name], 'function', name);
  }
  assert.equal(typeof orchestra.codexProtocolSchema, 'object');
  assert.equal(typeof orchestra.ProcessManager.prototype.replaceRuntime, 'function');
  assert.equal(typeof orchestra.ProcessManager.prototype.steerTurn, 'function');
  assert.equal(typeof orchestra.ProcessManager.prototype.interrupt, 'function');
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CodexHookCommandError,
  renderHookCommand,
} = require('../lib/codex/hook-command');
const {
  HOOK_RUNTIME_RELATIVE_PATH,
  attestHookArtifactVersion,
  installHookArtifactVersion,
} = require('../lib/codex/hook-artifacts');

const OPERATOR_UID = process.getuid();
const SERVICE_UID = OPERATOR_UID + 1;
const RUNTIME_ID = 'node-24.4.0';
const VERSION = '1.0.0';

// Descriptors are rendered from a live attestation, never from a shape a test
// or a caller can write by hand.
function attested(t) {
  const base = realpathSync(mkdtempSync(path.join(os.homedir(), '.polygram-hook-command-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  chmodSync(base, 0o755);
  const artifactRoot = path.join(base, 'codex-hooks');
  mkdirSync(artifactRoot);
  chmodSync(artifactRoot, 0o755);
  mkdirSync(path.join(base, 'runtimes', RUNTIME_ID, 'bin'), { recursive: true });
  for (const directory of [
    path.join(base, 'runtimes'),
    path.join(base, 'runtimes', RUNTIME_ID),
    path.join(base, 'runtimes', RUNTIME_ID, 'bin'),
  ]) {
    chmodSync(directory, 0o755);
  }
  const runtimePath = path.join(base, 'runtimes', RUNTIME_ID, HOOK_RUNTIME_RELATIVE_PATH);
  writeFileSync(runtimePath, '#!/bin/sh\nexit 0\n');
  chmodSync(runtimePath, 0o755);
  const runtimeSha256 = createHash('sha256')
    .update(readFileSync(runtimePath))
    .digest('hex');

  const receipt = installHookArtifactVersion({
    artifactRoot,
    version: VERSION,
    runtimeRoot: path.join(base, 'runtimes'),
    runtimeId: RUNTIME_ID,
    operatorUid: OPERATOR_UID,
    serviceUid: SERVICE_UID,
    expectedRuntimeSha256: runtimeSha256,
  });
  return {
    base,
    artifactRoot,
    receipt,
    reattest: () => attestHookArtifactVersion({
      artifactRoot,
      version: VERSION,
      runtimeRoot: path.join(base, 'runtimes'),
      runtimeId: RUNTIME_ID,
      runtimeSha256,
      operatorUid: OPERATOR_UID,
      serviceUid: SERVICE_UID,
    }),
  };
}

function descriptor(receipt, overrides = {}) {
  return {
    runtime: { path: receipt.runtime.path, kind: 'protected-runtime' },
    artifacts: [{ path: receipt.artifacts[0].path, kind: 'protected-artifact' }],
    argv: [{ kind: 'literal', value: 'SessionStart' }],
    ...overrides,
  };
}

describe('Codex hook command descriptors', () => {
  test('renders a deterministic quoted command and digests that rendering', (t) => {
    const { receipt } = attested(t);
    const rendered = renderHookCommand(descriptor(receipt), receipt);
    const expected = `'${receipt.runtime.path}' '${receipt.artifacts[0].path}' 'SessionStart'`;

    assert.equal(rendered.command, expected);
    assert.equal(
      rendered.sha256,
      createHash('sha256').update(expected).digest('hex'),
    );
    assert.equal(Object.isFrozen(rendered), true);
    assert.deepEqual(renderHookCommand(descriptor(receipt), receipt), rendered);
  });

  test('accepts only a live receipt from a full attestation', (t) => {
    const { receipt, reattest } = attested(t);

    assert.doesNotThrow(() => renderHookCommand(descriptor(receipt), reattest()));

    // Identity, not a readable mark: a wrapper that forwards every property
    // and a copy carrying every own symbol are both refused.
    const proxied = new Proxy(receipt, {});
    const symbolCopy = {};
    for (const key of Reflect.ownKeys(receipt)) {
      Object.defineProperty(
        symbolCopy,
        key,
        Object.getOwnPropertyDescriptor(receipt, key),
      );
    }

    for (const forged of [
      proxied,
      symbolCopy,
      { ...receipt },
      JSON.parse(JSON.stringify(receipt)),
      {
        version: VERSION,
        runtime: { ...receipt.runtime },
        artifacts: [{ ...receipt.artifacts[0] }],
      },
      Object.create(receipt),
      null,
      'receipt',
    ]) {
      assert.throws(
        () => renderHookCommand(descriptor(receipt), forged),
        (error) => (
          error instanceof CodexHookCommandError
          && error.code === 'CODEX_HOOK_COMMAND_UNATTESTED'
        ),
        'a receipt-shaped object must be refused',
      );
    }
  });

  test('types every argument, so a path is never mistaken for a literal', (t) => {
    const { receipt } = attested(t);
    const bundle = receipt.artifacts[0].path;

    assert.equal(
      renderHookCommand(descriptor(receipt, {
        argv: [
          { kind: 'literal', value: 'SessionStart' },
          { kind: 'attested-path', path: bundle },
        ],
      }), receipt).command,
      `'${receipt.runtime.path}' '${bundle}' 'SessionStart' '${bundle}'`,
    );

    // A capture directory is a path like any other: unattested, so unusable.
    for (const target of [
      path.join(receipt.versionDir, 'captures'),
      '/var/lib/polygram/codex-hook-captures/1.0.0',
    ]) {
      assert.throws(
        () => renderHookCommand(descriptor(receipt, {
          argv: [{ kind: 'attested-path', path: target }],
        }), receipt),
        { code: 'CODEX_HOOK_COMMAND_UNATTESTED' },
        `argument ${target} must be refused`,
      );
    }

    // A literal never carries a path, and a path entry is never a bare string.
    for (const entry of [
      { kind: 'literal', value: bundle },
      { kind: 'literal', value: 'captures/1.0.0' },
      { kind: 'literal', value: './captures' },
      { kind: 'attested-path', path: 'captures' },
      { kind: 'attested-path', path: './captures' },
      { kind: 'attested-path', value: bundle },
      { kind: 'path', path: bundle },
      { value: 'SessionStart' },
      'SessionStart',
      bundle,
      42,
      null,
    ]) {
      assert.throws(
        () => renderHookCommand(descriptor(receipt, { argv: [entry] }), receipt),
        (error) => (
          error instanceof CodexHookCommandError
          && ['CODEX_HOOK_COMMAND_INVALID', 'CODEX_HOOK_COMMAND_UNATTESTED']
            .includes(error.code)
        ),
        `argv entry ${JSON.stringify(entry)} must be refused`,
      );
    }
  });

  test('refuses any path the host could redirect', (t) => {
    const { receipt } = attested(t);
    const runtime = receipt.runtime.path;

    for (const candidate of [
      'node',
      'codex',
      './codex',
      '../runtime/node',
      'bin/node',
      `${path.dirname(runtime)}/../bin/node`,
      `${runtime}/`,
      `/${runtime}`,
    ]) {
      assert.throws(
        () => renderHookCommand(
          descriptor(receipt, { runtime: { path: candidate, kind: 'protected-runtime' } }),
          receipt,
        ),
        (error) => (
          error instanceof CodexHookCommandError
          && error.code === 'CODEX_HOOK_COMMAND_INVALID'
        ),
        `runtime ${candidate} must be refused`,
      );
    }

    assert.throws(
      () => renderHookCommand(
        descriptor(receipt, {
          artifacts: [{
            path: path.join(path.dirname(receipt.versionDir), 'current', 'hook-observer.js'),
            kind: 'protected-artifact',
          }],
        }),
        receipt,
      ),
      { code: 'CODEX_HOOK_COMMAND_INVALID' },
    );
  });

  test('refuses a nested Codex invocation in the runtime or the arguments', (t) => {
    const { receipt } = attested(t);

    assert.throws(
      () => renderHookCommand(
        descriptor(receipt, {
          runtime: { path: path.join(path.dirname(receipt.runtime.path), 'codex'), kind: 'protected-runtime' },
        }),
        receipt,
      ),
      { code: 'CODEX_HOOK_COMMAND_INVALID' },
    );

    // Every candidate is a well-formed literal that clears the character and
    // separator rules, so the Codex-name prohibition is the only thing that
    // can refuse it.
    for (const value of ['codex', 'codex-0.145.0', 'Codex', 'CODEX', 'codex.exe']) {
      assert.doesNotThrow(
        () => renderHookCommand(
          descriptor(receipt, { argv: [{ kind: 'literal', value: value.replace(/codex/i, 'observer') }] }),
          receipt,
        ),
        `the same shape without the Codex name must render: ${value}`,
      );
      assert.throws(
        () => renderHookCommand(
          descriptor(receipt, { argv: [{ kind: 'literal', value }] }),
          receipt,
        ),
        (error) => (
          error instanceof CodexHookCommandError
          && error.code === 'CODEX_HOOK_COMMAND_INVALID'
          && /names Codex/.test(error.message)
        ),
        `argument ${value} must be refused for naming Codex`,
      );
    }

    // A path argument is held to the same prohibition, and it is refused for
    // naming Codex before the closure is even consulted.
    assert.throws(
      () => renderHookCommand(
        descriptor(receipt, {
          argv: [{ kind: 'attested-path', path: '/opt/polygram/bin/codex' }],
        }),
        receipt,
      ),
      (error) => (
        error.code === 'CODEX_HOOK_COMMAND_INVALID'
        && /names Codex/.test(error.message)
      ),
    );
  });

  test('refuses shell metacharacters, interpolation, and control characters in argv', (t) => {
    const { receipt } = attested(t);

    for (const argument of [
      'Session;Start',
      'Session Start',
      '$HOME',
      '${HOME}',
      '`id`',
      '$(id)',
      'a|b',
      'a&b',
      'a>b',
      "it's",
      'a\nb',
      'a\u0000b',
      'a\u001bb',
      'a b',
      '',
    ]) {
      assert.throws(
        () => renderHookCommand(
          descriptor(receipt, { argv: [{ kind: 'literal', value: argument }] }),
          receipt,
        ),
        { code: 'CODEX_HOOK_COMMAND_INVALID' },
        `argv entry ${JSON.stringify(argument)} must be refused`,
      );
    }
  });

  test('refuses an unattested path, a swapped kind, and a malformed descriptor', (t) => {
    const { receipt } = attested(t);
    const bundle = receipt.artifacts[0].path;

    assert.throws(
      () => renderHookCommand(
        descriptor(receipt, {
          artifacts: [{ path: path.join(receipt.versionDir, 'other.js'), kind: 'protected-artifact' }],
        }),
        receipt,
      ),
      { code: 'CODEX_HOOK_COMMAND_UNATTESTED' },
    );

    assert.throws(
      () => renderHookCommand(
        descriptor(receipt, { artifacts: [{ path: bundle, kind: 'protected-runtime' }] }),
        receipt,
      ),
      { code: 'CODEX_HOOK_COMMAND_INVALID' },
    );

    assert.throws(
      () => renderHookCommand(
        descriptor(receipt, { runtime: { path: bundle, kind: 'protected-runtime' } }),
        receipt,
      ),
      { code: 'CODEX_HOOK_COMMAND_UNATTESTED' },
    );

    for (const broken of [
      { runtime: undefined },
      { artifacts: [] },
      { artifacts: [{ path: bundle, kind: 'protected-artifact' }, { path: bundle, kind: 'protected-artifact' }] },
      { argv: 'SessionStart' },
      { argv: [{ kind: 'literal', value: 'SessionStart' }, 42] },
    ]) {
      assert.throws(
        () => renderHookCommand(descriptor(receipt, broken), receipt),
        { code: 'CODEX_HOOK_COMMAND_INVALID' },
        `descriptor ${JSON.stringify(broken)} must be refused`,
      );
    }
  });
});

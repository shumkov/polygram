'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const {
  CodexBinaryError,
  createPinnedCodexBinaryResolver,
} = require('../lib/codex/binary');
const { resolveCodexTargetPin } = require('@shumkov/orchestra');

const DARWIN_PIN = resolveCodexTargetPin('darwin', 'arm64');
const LINUX_PIN = resolveCodexTargetPin('linux', 'x64');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function fixture(t, { version = 'codex-cli 9.9.9' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.homedir(), '.polygram-codex-bin-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'codex-9.9.9');
  const contents = `#!/bin/sh\nprintf '%s\\n' '${version}'\n`;
  writeFileSync(binary, contents, { mode: 0o700 });
  chmodSync(binary, 0o700);
  return { root, binary, contents, version };
}

function resolverFor(contents, version = 'codex-cli 9.9.9', overrides = {}) {
  return createPinnedCodexBinaryResolver({
    cliVersion: version,
    binarySha256: sha256(contents),
    platform: 'darwin',
    arch: 'arm64',
    ...overrides,
  });
}

describe('pinned Codex binary resolution', () => {
  test('production pins are the reviewed Orchestra target receipts', () => {
    assert.deepEqual(DARWIN_PIN, {
      target: 'aarch64-apple-darwin',
      cliVersion: 'codex-cli 0.145.0',
      binarySha256:
        '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',
    });
    assert.deepEqual(LINUX_PIN, {
      target: 'x86_64-unknown-linux-musl',
      cliVersion: 'codex-cli 0.145.0',
      binarySha256:
        'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
    });
  });

  test('accepts only an exact canonical immutable executable and freezes its receipt', async (t) => {
    const { binary, contents, version } = fixture(t);
    const resolve = resolverFor(contents, version);

    const result = await resolve({ binaryPath: binary });

    assert.equal(result.path, binary);
    assert.equal(result.target, DARWIN_PIN.target);
    assert.equal(result.version, version);
    assert.equal(result.sha256, sha256(contents));
    assert.equal(result.fingerprint.nlink, 1);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.fingerprint), true);
  });

  test('does not search PATH or accept a mutable symlink', async (t) => {
    const { root, binary, contents, version } = fixture(t);
    const resolve = resolverFor(contents, version);

    await assert.rejects(
      resolve({ binaryPath: 'codex' }),
      { code: 'CODEX_BINARY_NOT_ABSOLUTE' },
    );

    const link = path.join(root, 'codex-current');
    symlinkSync(binary, link);
    await assert.rejects(
      resolve({ binaryPath: link }),
      { code: 'CODEX_BINARY_MISMATCH' },
    );
  });

  test('rejects missing configuration and a missing configured file actionably', async () => {
    const resolve = createPinnedCodexBinaryResolver({
      cliVersion: DARWIN_PIN.cliVersion,
      binarySha256: DARWIN_PIN.binarySha256,
      platform: 'darwin',
      arch: 'arm64',
    });
    await assert.rejects(
      resolve({ env: {} }),
      (error) => (
        error instanceof CodexBinaryError
        && error.code === 'CODEX_BINARY_NOT_CONFIGURED'
        && /POLYGRAM_CODEX_BIN/.test(error.action)
      ),
    );

    await assert.rejects(
      resolve({
        binaryPath: '/definitely/missing/polygram/codex-0.145.0',
      }),
      (error) => (
        error instanceof CodexBinaryError
        && error.code === 'CODEX_BINARY_MISSING'
        && /0\.145\.0/.test(error.action)
      ),
    );
  });

  test('rejects a group-writable component in the path chain', async (t) => {
    const { root, binary, contents, version } = fixture(t);
    const resolve = resolverFor(contents, version);
    chmodSync(root, 0o770);

    await assert.rejects(
      resolve({ binaryPath: binary }),
      { code: 'CODEX_BINARY_MISMATCH' },
    );
    chmodSync(root, 0o700);
  });

  test('rejects checksum and version drift independently', async (t) => {
    const first = fixture(t);
    await assert.rejects(
      createPinnedCodexBinaryResolver({
        cliVersion: first.version,
        binarySha256: '0'.repeat(64),
        platform: 'darwin',
        arch: 'arm64',
      })({ binaryPath: first.binary }),
      { code: 'CODEX_BINARY_MISMATCH' },
    );

    const second = fixture(t);
    await assert.rejects(
      resolverFor(second.contents, 'codex-cli 9.9.8')({
        binaryPath: second.binary,
      }),
      { code: 'CODEX_BINARY_MISMATCH' },
    );
  });

  test('rejects replacement during the version probe', async (t) => {
    const { binary, contents, version } = fixture(t);
    const resolve = resolverFor(contents, version, {
      execFileFn: async () => {
        writeFileSync(binary, `${readFileSync(binary, 'utf8')}\n# replaced\n`, {
          mode: 0o700,
        });
        return { stdout: `${version}\n` };
      },
    });

    await assert.rejects(
      resolve({ binaryPath: binary }),
      { code: 'CODEX_BINARY_MISMATCH' },
    );
  });

  test('accepts the reviewed Linux x64 target and carries it in the receipt', async (t) => {
    const { binary, contents, version } = fixture(t);
    const resolve = resolverFor(contents, version, {
      platform: 'linux',
      arch: 'x64',
      resolveTargetPin(platform, arch) {
        assert.deepEqual([platform, arch], ['linux', 'x64']);
        return LINUX_PIN;
      },
    });

    const result = await resolve({ binaryPath: binary });

    assert.equal(result.target, LINUX_PIN.target);
    assert.equal(result.version, version);
    assert.equal(result.sha256, sha256(contents));
  });

  test('rejects an opposite-target checksum', async (t) => {
    const { binary, version } = fixture(t);
    const resolve = createPinnedCodexBinaryResolver({
      cliVersion: version,
      binarySha256: DARWIN_PIN.binarySha256,
      platform: 'linux',
      arch: 'x64',
    });

    await assert.rejects(
      resolve({ binaryPath: binary }),
      { code: 'CODEX_BINARY_MISMATCH' },
    );
  });

  test('rejects unsupported host targets before inspecting a path', async () => {
    for (const [platform, arch, binaryPath] of [
      ['linux', 'arm64', '/usr/local/bin/codex'],
      ['darwin', 'x64', '/usr/local/bin/codex'],
      ['win32', 'x64', 'C:\\codex.exe'],
    ]) {
      const resolve = createPinnedCodexBinaryResolver({
        cliVersion: 'codex-cli 9.9.9',
        binarySha256: '0'.repeat(64),
        platform,
        arch,
      });
      await assert.rejects(
        resolve({ binaryPath }),
        { code: 'CODEX_BINARY_PLATFORM_UNSUPPORTED' },
      );
    }
  });
});

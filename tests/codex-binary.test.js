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
  CODEX_BINARY_SHA256,
  CODEX_CLI_PINNED_VERSION,
  CodexBinaryError,
  createPinnedCodexBinaryResolver,
  resolvePinnedCodexBinary,
} = require('../lib/codex/binary');

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
    ...overrides,
  });
}

describe('pinned Codex binary resolution', () => {
  test('production pin is the reviewed Orchestra 0.145.0 pin', () => {
    assert.equal(CODEX_CLI_PINNED_VERSION, 'codex-cli 0.145.0');
    assert.equal(
      CODEX_BINARY_SHA256,
      '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',
    );
  });

  test('accepts only an exact canonical immutable executable and freezes its receipt', async (t) => {
    const { binary, contents, version } = fixture(t);
    const resolve = resolverFor(contents, version);

    const result = await resolve({ binaryPath: binary });

    assert.equal(result.path, binary);
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
    await assert.rejects(
      resolvePinnedCodexBinary({ env: {} }),
      (error) => (
        error instanceof CodexBinaryError
        && error.code === 'CODEX_BINARY_NOT_CONFIGURED'
        && /POLYGRAM_CODEX_BIN/.test(error.action)
      ),
    );

    await assert.rejects(
      resolvePinnedCodexBinary({
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

  test('rejects unsupported host platforms before inspecting a path', async () => {
    for (const [platform, binaryPath] of [
      ['linux', '/usr/local/bin/codex'],
      ['win32', 'C:\\codex.exe'],
    ]) {
      const resolve = createPinnedCodexBinaryResolver({
        cliVersion: 'codex-cli 9.9.9',
        binarySha256: '0'.repeat(64),
        platform,
      });
      await assert.rejects(
        resolve({ binaryPath }),
        { code: 'CODEX_BINARY_PLATFORM_UNSUPPORTED' },
      );
    }
  });
});

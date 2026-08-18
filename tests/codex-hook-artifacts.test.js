'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const {
  CodexHookArtifactError,
  HOOK_ARTIFACT_BUNDLE_NAME,
  HOOK_ARTIFACT_MANIFEST_NAME,
  HOOK_ARTIFACT_ROOT_MARKER_NAME,
  HOOK_RUNTIME_RELATIVE_PATH,
  QUARANTINE_DIR_NAME,
  acquireArtifactRootLock,
  attestHookArtifactVersion,
  createHookClosureDeclaration,
  createPrivateStagingDirectory,
  installHookArtifactVersion,
  listHookArtifactVersions,
  quarantineHookArtifactVersion,
  releaseArtifactRootLock,
  writePrivateMember,
} = require('../lib/codex/hook-artifacts');
const { HOOK_BUNDLE_PATH, buildHookBundle } = require('../lib/codex/hook-bundle');

const execFileAsync = promisify(execFile);

// The service account is never this process, and never the operator: an
// artifact tree either account can write is exactly what the boundary refuses.
const OPERATOR_UID = process.getuid();
const SERVICE_UID = OPERATOR_UID + 1;
const RUNTIME_ID = 'node-24.4.0';
const HOOK_TEST_ROOT = process.env.POLYGRAM_HOOK_TEST_ROOT ?? os.homedir();

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function fixture(t) {
  const base = realpathSync(mkdtempSync(path.join(HOOK_TEST_ROOT, '.polygram-hook-artifacts-')));
  t.after(() => {
    try {
      chmodSync(base, 0o755);
    } catch {}
    rmSync(base, { recursive: true, force: true });
  });
  chmodSync(base, 0o755);
  const artifactRoot = path.join(base, 'codex-hooks');
  mkdirSync(artifactRoot);
  chmodSync(artifactRoot, 0o755);
  const runtimeRoot = path.join(base, 'runtimes');
  mkdirSync(path.join(runtimeRoot, RUNTIME_ID, 'bin'), { recursive: true });
  for (const directory of [
    runtimeRoot,
    path.join(runtimeRoot, RUNTIME_ID),
    path.join(runtimeRoot, RUNTIME_ID, 'bin'),
  ]) {
    chmodSync(directory, 0o755);
  }
  const runtimePath = path.join(runtimeRoot, RUNTIME_ID, HOOK_RUNTIME_RELATIVE_PATH);
  writeFileSync(runtimePath, '#!/bin/sh\nexit 0\n');
  chmodSync(runtimePath, 0o755);
  return {
    base,
    artifactRoot,
    runtimeRoot,
    runtimePath,
    runtimeSha256: sha256(readFileSync(runtimePath)),
  };
}

function install(fx, version = '1.0.0', overrides = {}) {
  return installHookArtifactVersion({
    artifactRoot: fx.artifactRoot,
    version,
    runtimeRoot: fx.runtimeRoot,
    runtimeId: RUNTIME_ID,
    operatorUid: OPERATOR_UID,
    serviceUid: SERVICE_UID,
    expectedRuntimeSha256: fx.runtimeSha256,
    ...overrides,
  });
}

function quarantine(fx, version, referencedVersions) {
  return quarantineHookArtifactVersion({
    artifactRoot: fx.artifactRoot,
    version,
    runtimeRoot: fx.runtimeRoot,
    runtimeId: RUNTIME_ID,
    runtimeSha256: fx.runtimeSha256,
    operatorUid: OPERATOR_UID,
    serviceUid: SERVICE_UID,
    referencedVersions,
  });
}

function attest(fx, version = '1.0.0', overrides = {}) {
  return attestHookArtifactVersion({
    artifactRoot: fx.artifactRoot,
    version,
    runtimeRoot: fx.runtimeRoot,
    runtimeId: RUNTIME_ID,
    runtimeSha256: fx.runtimeSha256,
    operatorUid: OPERATOR_UID,
    serviceUid: SERVICE_UID,
    ...overrides,
  });
}

describe('Codex protected hook artifact tree', () => {
  test('the closure declaration is generated, exact, and unforgeable by callers', () => {
    const declaration = createHookClosureDeclaration();

    assert.equal(declaration.members.length, declaration.memberCount);
    assert.deepEqual(
      declaration.members.map((member) => [member.id, member.relativePath]),
      [['hook-bundle', HOOK_ARTIFACT_BUNDLE_NAME]],
    );
    assert.equal(declaration.members[0].sha256, sha256(buildHookBundle()));
    assert.equal(declaration.runtime.relativePath, HOOK_RUNTIME_RELATIVE_PATH);
    assert.equal(Object.isFrozen(declaration), true);
    assert.equal(Object.isFrozen(declaration.members), true);
    assert.equal(Object.isFrozen(declaration.members[0]), true);
    assert.deepEqual(createHookClosureDeclaration(), declaration);
  });

  test('installs every declared member and attests it against the declaration', (t) => {
    const fx = fixture(t);

    const installed = install(fx);
    const attested = attest(fx);

    const versionDir = path.join(fx.artifactRoot, '1.0.0');
    const bundle = path.join(versionDir, HOOK_ARTIFACT_BUNDLE_NAME);
    assert.equal(installed.versionDir, versionDir);
    assert.equal(installed.runtime.path, fx.runtimePath);
    assert.equal(installed.runtime.version, RUNTIME_ID);
    assert.equal(installed.runtime.sha256, fx.runtimeSha256);
    assert.deepEqual(
      installed.artifacts.map((entry) => [entry.id, entry.path]),
      [['hook-bundle', bundle]],
    );
    assert.equal(readFileSync(bundle, 'utf8'), buildHookBundle());
    assert.equal(statSync(bundle).mode & 0o777, 0o644);
    assert.equal(statSync(versionDir).mode & 0o777, 0o755);
    assert.equal(Object.isFrozen(installed), true);
    assert.deepEqual(attested, installed);
    assert.deepEqual(listHookArtifactVersions({ artifactRoot: fx.artifactRoot }), ['1.0.0']);
    assert.equal(
      readFileSync(path.join(fx.artifactRoot, HOOK_ARTIFACT_ROOT_MARKER_NAME), 'utf8')
        .includes('u23-hook-artifact-root/v1'),
      true,
    );
  });

  test('a tampered bundle is refused even when its manifest agrees with it', (t) => {
    const fx = fixture(t);
    install(fx);
    const versionDir = path.join(fx.artifactRoot, '1.0.0');
    const bundle = path.join(versionDir, HOOK_ARTIFACT_BUNDLE_NAME);
    const manifestPath = path.join(versionDir, HOOK_ARTIFACT_MANIFEST_NAME);
    const tampered = `${buildHookBundle()}// swapped\n`;

    writeFileSync(bundle, tampered, { mode: 0o644 });
    chmodSync(bundle, 0o644);
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8')
        .replace(sha256(buildHookBundle()), sha256(tampered)),
      { mode: 0o644 },
    );
    chmodSync(manifestPath, 0o644);

    // The manifest is now self-consistent; only the trusted declaration
    // disagrees, and it is the authority.
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });
  });

  test('the caller cannot supply, widen, or narrow the installed closure', (t) => {
    const fx = fixture(t);
    const hostile = path.join(fx.base, 'hostile.js');
    writeFileSync(hostile, 'process.exit(0);\n', { mode: 0o644 });

    const installed = install(fx, '1.0.0', {
      bundlePath: hostile,
      members: [{ id: 'hostile', relativePath: 'hostile.js', sha256: sha256('x') }],
      declaration: { members: [] },
    });

    assert.equal(installed.artifacts.length, 1);
    assert.equal(
      readFileSync(path.join(fx.artifactRoot, '1.0.0', HOOK_ARTIFACT_BUNDLE_NAME), 'utf8'),
      buildHookBundle(),
    );
    assert.equal(existsSync(path.join(fx.artifactRoot, '1.0.0', 'hostile.js')), false);
  });

  test('refuses a missing declared member and an undeclared extra member', (t) => {
    const fx = fixture(t);
    install(fx);
    const versionDir = path.join(fx.artifactRoot, '1.0.0');

    const extra = path.join(versionDir, 'helper.js');
    writeFileSync(extra, 'module.exports = 1;\n', { mode: 0o644 });
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });
    rmSync(extra);
    assert.doesNotThrow(() => attest(fx));

    rmSync(path.join(versionDir, HOOK_ARTIFACT_BUNDLE_NAME));
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_MISSING' });
  });

  test('binds the runtime to an immutable versioned identity', (t) => {
    const fx = fixture(t);
    install(fx);

    for (const runtimeId of ['current', 'latest', '../escape', 'node-24.4.0/bin', '']) {
      assert.throws(
        () => attest(fx, '1.0.0', { runtimeId }),
        (error) => (
          error instanceof CodexHookArtifactError
          && error.code === 'CODEX_HOOK_ARTIFACT_INVALID'
        ),
        `runtime id ${JSON.stringify(runtimeId)} must be refused`,
      );
    }

    assert.throws(
      () => attest(fx, '1.0.0', { runtimeSha256: undefined }),
      { code: 'CODEX_HOOK_ARTIFACT_INVALID' },
    );
    assert.throws(
      () => attest(fx, '1.0.0', { runtimeSha256: '0'.repeat(64) }),
      { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' },
    );

    // The same runtime identity may never name two different binaries.
    writeFileSync(fx.runtimePath, '#!/bin/sh\nexit 1\n');
    chmodSync(fx.runtimePath, 0o755);
    assert.throws(() => install(fx, '1.1.0'), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });
    assert.equal(existsSync(path.join(fx.artifactRoot, '1.1.0')), false);
  });

  test('refuses a runtime the service cannot execute and one it can write', (t) => {
    const fx = fixture(t);

    chmodSync(fx.runtimePath, 0o700);
    assert.throws(() => install(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });

    chmodSync(fx.runtimePath, 0o644);
    assert.throws(() => install(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });

    chmodSync(fx.runtimePath, 0o757);
    assert.throws(() => install(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });

    chmodSync(fx.runtimePath, 0o755);
    assert.doesNotThrow(() => install(fx));
    assert.equal(existsSync(path.join(fx.runtimeRoot, RUNTIME_ID, 'bin')), true);
  });

  test('takes the operator identity from the caller, never from the tree', (t) => {
    const fx = fixture(t);
    install(fx);

    assert.throws(
      () => attest(fx, '1.0.0', { operatorUid: OPERATOR_UID + 2 }),
      { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
    );
    assert.throws(
      () => attest(fx, '1.0.0', { operatorUid: undefined }),
      { code: 'CODEX_HOOK_ARTIFACT_INVALID' },
    );
    assert.throws(
      () => attest(fx, '1.0.0', { serviceUid: OPERATOR_UID }),
      { code: 'CODEX_HOOK_ARTIFACT_INVALID' },
    );
    assert.throws(
      () => attest(fx, '1.0.0', { serviceUid: 0 }),
      { code: 'CODEX_HOOK_ARTIFACT_INVALID' },
    );
    assert.throws(
      () => install(fx, '2.0.0', { operatorUid: OPERATOR_UID + 2 }),
      { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
    );
    assert.doesNotThrow(() => attest(fx));
  });

  test('closes the mode set for every member, directory, and ancestor', (t) => {
    const fx = fixture(t);
    install(fx);
    const versionDir = path.join(fx.artifactRoot, '1.0.0');
    const bundle = path.join(versionDir, HOOK_ARTIFACT_BUNDLE_NAME);

    for (const mode of [0o600, 0o640, 0o666, 0o755]) {
      chmodSync(bundle, mode);
      assert.throws(
        () => attest(fx),
        { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
        `bundle mode ${mode.toString(8)} must be refused`,
      );
    }
    chmodSync(bundle, 0o644);

    for (const mode of [0o700, 0o750, 0o775, 0o777]) {
      chmodSync(versionDir, mode);
      assert.throws(
        () => attest(fx),
        { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
        `version mode ${mode.toString(8)} must be refused`,
      );
    }
    chmodSync(versionDir, 0o755);

    chmodSync(fx.artifactRoot, 0o775);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    chmodSync(fx.artifactRoot, 0o755);

    // An ancestor the service cannot traverse is as fatal as a writable one.
    chmodSync(fx.base, 0o750);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    chmodSync(fx.base, 0o777);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    chmodSync(fx.base, 0o755);
    assert.doesNotThrow(() => attest(fx));
  });

  test('refuses a setuid, setgid, or sticky bit anywhere in the closure', (t) => {
    const fx = fixture(t);
    install(fx);
    const versionDir = path.join(fx.artifactRoot, '1.0.0');
    const bundle = path.join(versionDir, HOOK_ARTIFACT_BUNDLE_NAME);

    for (const [target, mode, plain] of [
      [bundle, 0o4644, 0o644],
      [bundle, 0o2644, 0o644],
      [bundle, 0o1644, 0o644],
      [versionDir, 0o2755, 0o755],
      [versionDir, 0o1755, 0o755],
      [fx.artifactRoot, 0o2755, 0o755],
      [fx.base, 0o1755, 0o755],
      [fx.runtimePath, 0o4755, 0o755],
      [fx.runtimePath, 0o2755, 0o755],
    ]) {
      chmodSync(target, mode);
      assert.throws(
        () => attest(fx),
        { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
        `${target} at mode ${mode.toString(8)} must be refused`,
      );
      chmodSync(target, plain);
    }
    assert.doesNotThrow(() => attest(fx));
  });

  test('reserves exactly the retired version identity', (t) => {
    const fx = fixture(t);
    install(fx, '1.0.0-1');
    install(fx, '1.0.0');

    quarantine(fx, '1.0.0-1', ['1.0.0']);

    // Only the retired identity is spent; a neighbouring version id is not.
    assert.throws(
      () => install(fx, '1.0.0-1'),
      { code: 'CODEX_HOOK_ARTIFACT_VERSION_RESERVED' },
    );
    quarantine(fx, '1.0.0', []);
    assert.throws(() => install(fx, '1.0.0'), { code: 'CODEX_HOOK_ARTIFACT_VERSION_RESERVED' });
    assert.doesNotThrow(() => install(fx, '1.0.1'));
  });

  test('fails closed on a damaged quarantine rather than reusing an id', (t) => {
    const fx = fixture(t);
    install(fx);
    quarantine(fx, '1.0.0', []);
    const quarantineRoot = path.join(fx.artifactRoot, QUARANTINE_DIR_NAME);

    writeFileSync(path.join(quarantineRoot, 'stray'), 'x\n', { mode: 0o644 });
    assert.throws(() => install(fx, '2.0.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    rmSync(path.join(quarantineRoot, 'stray'));

    chmodSync(quarantineRoot, 0o300);
    assert.throws(() => install(fx, '2.0.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    chmodSync(quarantineRoot, 0o755);
    assert.doesNotThrow(() => install(fx, '2.0.0'));
  });

  test('attests the quarantine itself, and binds a retired name to its manifest', (t) => {
    const fx = fixture(t);
    install(fx);
    quarantine(fx, '1.0.0', []);
    const quarantineRoot = path.join(fx.artifactRoot, QUARANTINE_DIR_NAME);
    const retired = path.join(quarantineRoot, '1.0.0');

    // A retired closure the service can rewrite is not evidence of anything.
    chmodSync(retired, 0o777);
    assert.throws(() => install(fx, '2.0.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    chmodSync(retired, 0o755);

    chmodSync(path.join(retired, '1'), 0o777);
    assert.throws(() => install(fx, '2.0.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    chmodSync(path.join(retired, '1'), 0o755);
    assert.doesNotThrow(() => install(fx, '2.0.0'));

    // Renaming the quarantine entry must not hand the retired id back.
    renameSync(retired, path.join(quarantineRoot, '9.9.9'));
    assert.throws(() => install(fx, '1.0.0'), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });
    assert.throws(() => install(fx, '9.9.9'), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });
    assert.throws(() => attest(fx, '2.0.0'), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });
    assert.equal(existsSync(path.join(fx.artifactRoot, '1.0.0')), false);

    renameSync(path.join(quarantineRoot, '9.9.9'), retired);
    assert.doesNotThrow(() => attest(fx, '2.0.0'));
    assert.throws(() => install(fx, '1.0.0'), { code: 'CODEX_HOOK_ARTIFACT_VERSION_RESERVED' });
  });

  test('fails closed on an unexpected occupant of an initialized root', (t) => {
    const fx = fixture(t);
    install(fx);
    quarantine(fx, '1.0.0', []);
    const quarantineRoot = path.join(fx.artifactRoot, QUARANTINE_DIR_NAME);

    // Renaming the quarantine out of the way must not hand every retired id
    // back, and the leftover directory is not something to step over.
    renameSync(quarantineRoot, path.join(fx.artifactRoot, '_quarantine'));
    assert.throws(() => install(fx, '1.0.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    assert.equal(existsSync(path.join(fx.artifactRoot, '1.0.0')), false);
    renameSync(path.join(fx.artifactRoot, '_quarantine'), quarantineRoot);
    assert.throws(() => install(fx, '1.0.0'), { code: 'CODEX_HOOK_ARTIFACT_VERSION_RESERVED' });

    for (const occupant of ['notes.txt', '_scratch', 'README']) {
      const target = path.join(fx.artifactRoot, occupant);
      writeFileSync(target, 'stray\n', { mode: 0o644 });
      assert.throws(
        () => install(fx, '2.0.0'),
        { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
        `${occupant} must fail the run closed`,
      );
      assert.throws(() => attest(fx, '1.1.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
      rmSync(target);
    }
    assert.doesNotThrow(() => install(fx, '2.0.0'));
  });

  test('attests a live sibling version directory before trusting its manifest', (t) => {
    const fx = fixture(t);
    install(fx);
    install(fx, '1.1.0');
    const sibling = path.join(fx.artifactRoot, '1.0.0');

    for (const mode of [0o777, 0o775, 0o700, 0o2755]) {
      chmodSync(sibling, mode);
      assert.throws(
        () => attest(fx, '1.1.0'),
        { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
        `a sibling at mode ${mode.toString(8)} must not be trusted`,
      );
      assert.throws(() => install(fx, '1.2.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
      chmodSync(sibling, 0o755);
    }
    assert.doesNotThrow(() => attest(fx, '1.1.0'));
  });

  test('writes a staged member whole, however large it is', (t) => {
    const fx = fixture(t);
    const staging = createPrivateStagingDirectory(fx.artifactRoot, '1.1.0');
    const target = path.join(staging, HOOK_ARTIFACT_BUNDLE_NAME);
    const body = Buffer.alloc(4 * 1024 * 1024, 'polygram-hook-artifact-body\n');

    writePrivateMember(target, body);

    assert.equal(readFileSync(target).equals(body), true);
    assert.equal(statSync(target).size, body.length);
    rmSync(staging, { recursive: true });
  });

  test('carries retired versions in the runtime identity history', (t) => {
    const fx = fixture(t);
    install(fx);
    quarantine(fx, '1.0.0', []);

    // The only record of this runtime identity now sits in quarantine, and it
    // still forbids the same id denoting different bytes.
    writeFileSync(fx.runtimePath, '#!/bin/sh\nexit 7\n');
    chmodSync(fx.runtimePath, 0o755);
    const swapped = sha256(readFileSync(fx.runtimePath));

    assert.throws(
      () => install(fx, '1.1.0', { expectedRuntimeSha256: swapped }),
      { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' },
    );
    assert.equal(existsSync(path.join(fx.artifactRoot, '1.1.0')), false);
  });

  test('fails closed on a version-shaped entry that is not a directory', (t) => {
    const fx = fixture(t);
    install(fx);

    const impostor = path.join(fx.artifactRoot, '2.0.0');
    writeFileSync(impostor, 'not a version\n', { mode: 0o644 });
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    rmSync(impostor);

    symlinkSync(path.join(fx.artifactRoot, '1.0.0'), impostor);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    unlinkSync(impostor);
    assert.doesNotThrow(() => attest(fx));
  });

  test('populates staging privately, and never through an existing name', (t) => {
    const fx = fixture(t);
    const staging = createPrivateStagingDirectory(fx.artifactRoot, '1.1.0');

    // Population happens while the directory is owner-only; publishing is a
    // separate, later step.
    assert.equal(statSync(staging).mode & 0o7777, 0o700);
    assert.equal(path.dirname(staging), fx.artifactRoot);

    const outside = path.join(fx.base, 'outside.txt');
    writeFileSync(outside, 'must not be written through\n', { mode: 0o644 });
    const target = path.join(staging, HOOK_ARTIFACT_BUNDLE_NAME);

    symlinkSync(outside, target);
    assert.throws(
      () => writePrivateMember(target, 'published\n'),
      (error) => ['ELOOP', 'EEXIST'].includes(error.code),
    );
    assert.equal(readFileSync(outside, 'utf8'), 'must not be written through\n');
    unlinkSync(target);

    writePrivateMember(target, 'published\n');
    assert.equal(readFileSync(target, 'utf8'), 'published\n');
    assert.equal(statSync(target).mode & 0o7777, 0o600);
    assert.throws(
      () => writePrivateMember(target, 'again\n'),
      (error) => error.code === 'EEXIST',
    );
    assert.equal(readFileSync(target, 'utf8'), 'published\n');
    rmSync(staging, { recursive: true });
  });

  test('an install publishes only after every member is in place', (t) => {
    const fx = fixture(t);
    const installed = install(fx);
    const bundle = path.join(fx.artifactRoot, '1.0.0', HOOK_ARTIFACT_BUNDLE_NAME);

    assert.equal(lstatSync(bundle).isSymbolicLink(), false);
    assert.equal(readFileSync(bundle, 'utf8'), buildHookBundle());
    assert.equal(statSync(bundle).mode & 0o7777, 0o644);
    assert.equal(statSync(installed.versionDir).mode & 0o7777, 0o755);
    assert.deepEqual(
      readdirSync(fx.artifactRoot).filter((name) => name.startsWith('.staging-')),
      [],
    );
  });

  test('verifies the root marker before it writes a lock into a tree', (t) => {
    const fx = fixture(t);
    const foreign = path.join(fx.base, 'foreign');
    mkdirSync(foreign);
    chmodSync(foreign, 0o755);
    writeFileSync(path.join(foreign, 'install.lock'), '{"pid":1}', { mode: 0o644 });

    // An unmarked tree is not ours to lock: the marker is what must speak.
    assert.throws(
      () => quarantineHookArtifactVersion({
        artifactRoot: foreign,
        version: '1.0.0',
        runtimeRoot: fx.runtimeRoot,
        runtimeId: RUNTIME_ID,
        runtimeSha256: fx.runtimeSha256,
        operatorUid: OPERATOR_UID,
        serviceUid: SERVICE_UID,
        referencedVersions: [],
      }),
      { code: 'CODEX_HOOK_ARTIFACT_MISSING' },
    );
    assert.deepEqual(readdirSync(foreign).sort(), ['install.lock']);
  });

  test('refuses a symlinked, hard-linked, or aliased closure member', (t) => {
    const fx = fixture(t);
    install(fx);
    const versionDir = path.join(fx.artifactRoot, '1.0.0');
    const bundle = path.join(versionDir, HOOK_ARTIFACT_BUNDLE_NAME);
    const outside = path.join(fx.base, 'outside.js');
    writeFileSync(outside, buildHookBundle(), { mode: 0o644 });

    rmSync(bundle);
    symlinkSync(outside, bundle);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    rmSync(bundle);
    writeFileSync(bundle, buildHookBundle(), { mode: 0o644 });
    chmodSync(bundle, 0o644);
    assert.doesNotThrow(() => attest(fx));

    const alias = path.join(fx.base, 'bundle-alias.js');
    linkSync(bundle, alias);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    rmSync(alias);

    symlinkSync(versionDir, path.join(fx.artifactRoot, '2.0.0'));
    assert.throws(() => attest(fx, '2.0.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    assert.throws(() => attest(fx, 'current'), { code: 'CODEX_HOOK_ARTIFACT_INVALID' });
  });

  test('refuses relative, aliased, and reserved roots and versions', (t) => {
    const fx = fixture(t);
    install(fx);
    const aliasRoot = path.join(fx.base, 'alias-root');
    symlinkSync(fx.artifactRoot, aliasRoot);

    for (const [artifactRoot, version] of [
      ['codex-hooks', '1.0.0'],
      [`${fx.artifactRoot}/`, '1.0.0'],
      [`${fx.artifactRoot}/./`, '1.0.0'],
      [aliasRoot, '1.0.0'],
      [fx.artifactRoot, ''],
      [fx.artifactRoot, '../1.0.0'],
      [fx.artifactRoot, 'current'],
      [fx.artifactRoot, QUARANTINE_DIR_NAME],
      [fx.artifactRoot, '1.0.0/'],
    ]) {
      assert.throws(
        () => attest(fx, version, { artifactRoot }),
        { code: 'CODEX_HOOK_ARTIFACT_INVALID' },
        `${artifactRoot} @ ${version} must be refused`,
      );
    }
  });

  test('refuses a tree that is not a marked artifact root, and a forged marker', (t) => {
    const fx = fixture(t);
    install(fx);
    const marker = path.join(fx.artifactRoot, HOOK_ARTIFACT_ROOT_MARKER_NAME);

    writeFileSync(marker, '{"schema":"forged"}\n', { mode: 0o644 });
    chmodSync(marker, 0o644);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });

    rmSync(marker);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_MISSING' });

    // A directory that merely looks like a version tree is never touched.
    const foreign = path.join(fx.base, 'foreign');
    mkdirSync(path.join(foreign, '1.0.0'), { recursive: true });
    chmodSync(foreign, 0o755);
    chmodSync(path.join(foreign, '1.0.0'), 0o755);
    writeFileSync(path.join(foreign, '1.0.0', 'important.txt'), 'keep me\n', { mode: 0o644 });
    assert.throws(
      () => quarantineHookArtifactVersion({
        artifactRoot: foreign,
        version: '1.0.0',
        runtimeRoot: fx.runtimeRoot,
        runtimeId: RUNTIME_ID,
        runtimeSha256: fx.runtimeSha256,
        operatorUid: OPERATOR_UID,
        serviceUid: SERVICE_UID,
        referencedVersions: [],
      }),
      { code: 'CODEX_HOOK_ARTIFACT_MISSING' },
    );
    assert.equal(existsSync(path.join(foreign, '1.0.0', 'important.txt')), true);
  });

  test('retires a version by recoverable quarantine, never by deletion', (t) => {
    const fx = fixture(t);
    install(fx);
    install(fx, '1.1.0');

    const quarantine = (version, referencedVersions) => quarantineHookArtifactVersion({
      artifactRoot: fx.artifactRoot,
      version,
      runtimeRoot: fx.runtimeRoot,
      runtimeId: RUNTIME_ID,
      runtimeSha256: fx.runtimeSha256,
      operatorUid: OPERATOR_UID,
      serviceUid: SERVICE_UID,
      referencedVersions,
    });

    assert.throws(
      () => quarantine('1.0.0', ['1.0.0', '1.1.0']),
      { code: 'CODEX_HOOK_ARTIFACT_VERSION_REFERENCED' },
    );
    assert.throws(
      () => quarantine('1.0.0', undefined),
      { code: 'CODEX_HOOK_ARTIFACT_INVALID' },
    );
    assert.doesNotThrow(() => attest(fx));

    const retired = quarantine('1.0.0', ['1.1.0']);

    assert.equal(retired.quarantinePath.startsWith(
      path.join(fx.artifactRoot, QUARANTINE_DIR_NAME),
    ), true);
    assert.equal(
      readFileSync(path.join(retired.quarantinePath, HOOK_ARTIFACT_BUNDLE_NAME), 'utf8'),
      buildHookBundle(),
    );
    assert.deepEqual(listHookArtifactVersions({ artifactRoot: fx.artifactRoot }), ['1.1.0']);
    assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_MISSING' });
    assert.doesNotThrow(() => attest(fx, '1.1.0'));

    // A retired version id is spent: reinstalling it would resurrect a name a
    // live session may still hold.
    assert.throws(() => install(fx), { code: 'CODEX_HOOK_ARTIFACT_VERSION_RESERVED' });
    assert.equal(existsSync(retired.quarantinePath), true);
  });

  test('takes the root lock before it inspects anything it might retire', (t) => {
    const fx = fixture(t);
    install(fx);
    const lock = path.join(fx.artifactRoot, 'install.lock');
    const held = JSON.stringify({ pid: process.pid, token: 'c'.repeat(32) });
    writeFileSync(lock, held, { mode: 0o644 });

    // An absent version would report MISSING if attestation ran first; the
    // lock is what must speak, so no window exists between checking and moving.
    assert.throws(
      () => quarantineHookArtifactVersion({
        artifactRoot: fx.artifactRoot,
        version: '9.9.9',
        runtimeRoot: fx.runtimeRoot,
        runtimeId: RUNTIME_ID,
        runtimeSha256: fx.runtimeSha256,
        operatorUid: OPERATOR_UID,
        serviceUid: SERVICE_UID,
        referencedVersions: [],
      }),
      { code: 'CODEX_HOOK_ARTIFACT_LOCKED' },
    );
    assert.equal(readFileSync(lock, 'utf8'), held);
    rmSync(lock);
    assert.doesNotThrow(() => attest(fx));
  });

  test('never overwrites an installed version in place', (t) => {
    const fx = fixture(t);
    const first = install(fx);

    assert.throws(() => install(fx), { code: 'CODEX_HOOK_ARTIFACT_VERSION_EXISTS' });
    assert.deepEqual(attest(fx), first);

    const second = install(fx, '1.1.0');
    assert.notEqual(second.versionDir, first.versionDir);
    assert.deepEqual(attest(fx), first);
    assert.deepEqual(
      listHookArtifactVersions({ artifactRoot: fx.artifactRoot }),
      ['1.0.0', '1.1.0'],
    );
  });

  test('fails closed on any existing lock and never reclaims one', async (t) => {
    const fx = fixture(t);
    const lock = path.join(fx.artifactRoot, 'install.lock');

    // A holder that is demonstrably dead is still a holder: reclaiming it
    // would race a run whose pid was simply reused.
    const dead = await execFileAsync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    const foreign = JSON.stringify({ pid: Number(dead.stdout), token: 'f'.repeat(32) });
    writeFileSync(lock, foreign, { mode: 0o644 });

    assert.throws(() => install(fx), { code: 'CODEX_HOOK_ARTIFACT_LOCKED' });
    assert.equal(readFileSync(lock, 'utf8'), foreign);
    assert.equal(existsSync(path.join(fx.artifactRoot, '1.0.0')), false);

    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'a'.repeat(32) }), { mode: 0o644 });
    assert.throws(() => install(fx), { code: 'CODEX_HOOK_ARTIFACT_LOCKED' });

    rmSync(lock);
    assert.doesNotThrow(() => install(fx));
    assert.equal(existsSync(lock), false);
  });

  test('holds one lock per root and releases only its own token', (t) => {
    const fx = fixture(t);
    install(fx);
    const handle = acquireArtifactRootLock(fx.artifactRoot);

    // The second waiter fails closed instead of waiting or reclaiming.
    assert.throws(
      () => acquireArtifactRootLock(fx.artifactRoot),
      { code: 'CODEX_HOOK_ARTIFACT_LOCKED' },
    );
    assert.throws(() => install(fx, '1.1.0'), { code: 'CODEX_HOOK_ARTIFACT_LOCKED' });

    // A lock replaced mid-run is not ours to remove on the way out.
    const stolen = JSON.stringify({ pid: process.pid, token: 'b'.repeat(32) });
    writeFileSync(handle.lockPath, stolen, { mode: 0o644 });
    assert.throws(
      () => releaseArtifactRootLock(handle),
      { code: 'CODEX_HOOK_ARTIFACT_LOCKED' },
    );
    assert.equal(readFileSync(handle.lockPath, 'utf8'), stolen);

    rmSync(handle.lockPath);
    const fresh = acquireArtifactRootLock(fx.artifactRoot);
    releaseArtifactRootLock(fresh);
    assert.equal(existsSync(fresh.lockPath), false);
  });

  test('claims a marker only on a dedicated root, and cleans only its own staging', (t) => {
    const fx = fixture(t);
    const occupied = path.join(fx.base, 'occupied');
    mkdirSync(occupied);
    chmodSync(occupied, 0o755);
    writeFileSync(path.join(occupied, 'unrelated.txt'), 'keep me\n', { mode: 0o644 });

    assert.throws(
      () => install(fx, '1.0.0', { artifactRoot: occupied }),
      { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
    );
    assert.deepEqual(readdirSync(occupied), ['unrelated.txt']);

    install(fx);
    const foreignStaging = path.join(fx.artifactRoot, '.staging-9.9.9-1');
    mkdirSync(foreignStaging);
    chmodSync(foreignStaging, 0o755);
    writeFileSync(path.join(foreignStaging, 'in-flight'), 'x\n', { mode: 0o644 });

    assert.throws(() => install(fx, '1.1.0'), { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' });
    assert.equal(existsSync(path.join(foreignStaging, 'in-flight')), true);
    assert.equal(existsSync(path.join(fx.artifactRoot, '1.1.0')), false);

    rmSync(foreignStaging, { recursive: true });
    const ownStaging = path.join(fx.artifactRoot, `.staging-1.1.0-${process.pid}`);
    mkdirSync(ownStaging);
    chmodSync(ownStaging, 0o755);
    assert.doesNotThrow(() => install(fx, '1.1.0'));
    assert.equal(existsSync(ownStaging), false);
  });

  test('requires the expected runtime digest on install', (t) => {
    const fx = fixture(t);

    assert.throws(
      () => install(fx, '1.0.0', { expectedRuntimeSha256: undefined }),
      { code: 'CODEX_HOOK_ARTIFACT_INVALID' },
    );
    assert.throws(
      () => install(fx, '1.0.0', { expectedRuntimeSha256: 'not-a-digest' }),
      { code: 'CODEX_HOOK_ARTIFACT_INVALID' },
    );
    assert.throws(
      () => install(fx, '1.0.0', { expectedRuntimeSha256: '0'.repeat(64) }),
      { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' },
    );
    assert.equal(existsSync(path.join(fx.artifactRoot, '1.0.0')), false);
    assert.equal(existsSync(path.join(fx.artifactRoot, 'install.lock')), false);
  });

  test('stops at damage in any sibling version rather than reading past it', (t) => {
    const fx = fixture(t);
    install(fx);
    install(fx, '1.1.0');
    const sibling = path.join(fx.artifactRoot, '1.0.0', HOOK_ARTIFACT_MANIFEST_NAME);

    for (const damaged of ['{ not json', '{}', JSON.stringify({ runtime: { version: RUNTIME_ID } })]) {
      writeFileSync(sibling, damaged, { mode: 0o644 });
      chmodSync(sibling, 0o644);
      assert.throws(
        () => attest(fx, '1.1.0'),
        { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' },
        `sibling manifest ${damaged} must stop attestation`,
      );
      assert.throws(() => install(fx, '1.2.0'), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });
    }

    rmSync(sibling);
    assert.throws(() => attest(fx, '1.1.0'), { code: 'CODEX_HOOK_ARTIFACT_MISSING' });
  });

  test('refuses an install into a service-writable tree before writing anything', (t) => {
    const fx = fixture(t);
    const loose = path.join(fx.base, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o777);

    assert.throws(
      () => install(fx, '1.0.0', { artifactRoot: loose }),
      { code: 'CODEX_HOOK_ARTIFACT_UNSAFE' },
    );
    assert.deepEqual(readdirSync(loose), []);
  });

  test('the operator command exposes install, attest, list, and quarantine only', async (t) => {
    const fx = fixture(t);
    const cli = path.join(__dirname, '..', 'scripts', 'codex-hook-artifacts.js');
    const run = (...args) => execFileAsync(process.execPath, [cli, ...args]);
    const common = [
      '--artifact-root', fx.artifactRoot,
      '--runtime-root', fx.runtimeRoot,
      '--runtime-id', RUNTIME_ID,
      '--operator-uid', String(OPERATOR_UID),
      '--service-uid', String(SERVICE_UID),
    ];

    await assert.rejects(
      run('install', '--version', '1.0.0', ...common),
      (error) => error.code === 1 && /--runtime-sha256/.test(error.stderr),
    );

    const installed = JSON.parse((await run(
      'install', '--version', '1.0.0', '--runtime-sha256', fx.runtimeSha256, ...common,
    )).stdout);
    assert.equal(installed.runtime.version, RUNTIME_ID);

    const attested = JSON.parse((await run(
      'attest', '--version', '1.0.0', '--runtime-sha256', fx.runtimeSha256, ...common,
    )).stdout);
    assert.deepEqual(attested, installed);

    await assert.rejects(
      run(
        'install', '--version', '2.0.0', '--runtime-sha256', fx.runtimeSha256,
        '--bundle', HOOK_BUNDLE_PATH, ...common,
      ),
      (error) => error.code === 1 && /--bundle/.test(error.stderr),
    );
    assert.equal(existsSync(path.join(fx.artifactRoot, '2.0.0')), false);

    await assert.rejects(
      run('quarantine', '--version', '1.0.0', '--runtime-sha256', fx.runtimeSha256, ...common),
      (error) => error.code === 1 && /--referenced/.test(error.stderr),
    );
    assert.doesNotThrow(() => attest(fx));
  });

  test('ships the operator surface the runbook names', async () => {
    const packed = JSON.parse((await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json'],
      { cwd: path.join(__dirname, '..'), maxBuffer: 8 * 1024 * 1024 },
    )).stdout);
    const files = packed[0].files.map((entry) => entry.path);

    for (const shipped of [
      'lib/codex/hook-artifacts.js',
      'lib/codex/hook-bundle.js',
      'lib/codex/hook-command.js',
      'lib/codex/hooks/hook-observer.bundle.js',
      'scripts/codex-hook-artifacts.js',
      'scripts/build-codex-hook-bundle.js',
      'docs/2026-08-16-003-codex-protected-hook-artifact-runbook.md',
    ]) {
      assert.equal(files.includes(shipped), true, `${shipped} must be published`);
    }

    const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(
      manifest.bin['polygram-codex-hook-artifacts'],
      'scripts/codex-hook-artifacts.js',
    );
    assert.equal(
      manifest.bin['polygram-build-codex-hook-bundle'],
      'scripts/build-codex-hook-bundle.js',
    );
    const runbook = readFileSync(
      path.join(__dirname, '..', 'docs', '2026-08-16-003-codex-protected-hook-artifact-runbook.md'),
      'utf8',
    );
    assert.equal(runbook.includes('polygram-codex-hook-artifacts'), true);
    assert.equal(runbook.includes('--bundle'), false);
  });

  test('leaves no descriptor of the closure open to hand editing', (t) => {
    const fx = fixture(t);
    const installed = install(fx);
    const manifestPath = path.join(fx.artifactRoot, '1.0.0', HOOK_ARTIFACT_MANIFEST_NAME);
    const manifest = readFileSync(manifestPath, 'utf8');

    for (const edit of [
      (text) => text.replace('"version"', '"Version"'),
      (text) => `${text}\n`,
      (text) => text.replace(/\n\s+/g, ' '),
      (text) => JSON.stringify({ ...JSON.parse(text), operator: 'ops' }, null, 2),
    ]) {
      writeFileSync(manifestPath, edit(manifest), { mode: 0o644 });
      chmodSync(manifestPath, 0o644);
      assert.throws(() => attest(fx), { code: 'CODEX_HOOK_ARTIFACT_MISMATCH' });
      writeFileSync(manifestPath, manifest, { mode: 0o644 });
      chmodSync(manifestPath, 0o644);
    }
    assert.deepEqual(attest(fx), installed);
  });
});

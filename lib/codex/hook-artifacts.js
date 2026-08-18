'use strict';

const { createHash, randomBytes } = require('node:crypto');
const {
  chmodSync,
  closeSync,
  constants: fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} = require('node:fs');
const path = require('node:path');

const { readCheckedInBundle } = require('./hook-bundle');

const HOOK_ARTIFACT_MANIFEST_SCHEMA = 'u23-hook-artifact-manifest/v1';
const HOOK_ARTIFACT_ROOT_SCHEMA = 'u23-hook-artifact-root/v1';
const HOOK_CLOSURE_SCHEMA = 'u23-hook-closure/v1';
const HOOK_ARTIFACT_MANIFEST_NAME = 'manifest.json';
const HOOK_ARTIFACT_ROOT_MARKER_NAME = 'artifact-root.json';
const HOOK_ARTIFACT_BUNDLE_NAME = 'hook-observer.js';
const HOOK_ARTIFACT_BUNDLE_ID = 'hook-bundle';
const HOOK_RUNTIME_ID = 'node';
const HOOK_RUNTIME_RELATIVE_PATH = 'bin/node';
const QUARANTINE_DIR_NAME = 'quarantine';
const LOCK_NAME = 'install.lock';
const STAGING_PREFIX = '.staging-';

// Closed mode sets. Every accepted mode is readable — and for a runtime or a
// directory, traversable — by an account that is neither the owner nor in the
// owning group, which is what a distinct service account needs; and none of
// them is writable by group or other. A `0700` runtime is refused for exactly
// that reason: the service could not execute it.
const DIRECTORY_MODES = new Set([0o755, 0o555]);
const MEMBER_MODES = new Set([0o644, 0o444]);
const RUNTIME_MODES = new Set([0o755, 0o555]);

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const RELATIVE_NAME_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const RESERVED_NAMES = new Set([
  'current',
  'latest',
  'stable',
  QUARANTINE_DIR_NAME,
]);
// The tree's own bookkeeping, which shares the character set a version name
// uses and must never be read as one.
const TREE_FILE_NAMES = new Set([HOOK_ARTIFACT_ROOT_MARKER_NAME, LOCK_NAME]);
const MAX_QUARANTINE_ATTEMPTS = 64;
const LOCK_TOKEN_BYTES = 16;

// A receipt is the only evidence a renderer accepts, and membership here is
// what distinguishes one from an object of the same shape. Identity is not a
// readable mark: a copy, a clone, or a forwarding proxy is a different object
// and is therefore not a receipt.
const ATTESTED_RECEIPTS = new WeakSet();

const INSTALL_ACTION = 'Install the hook artifact version as an operator-owned '
  + 'directory whose whole canonical chain is unwritable by the service account.';

class CodexHookArtifactError extends Error {
  constructor(message, code, action) {
    super(message);
    this.name = 'CodexHookArtifactError';
    this.code = code;
    this.action = action;
  }
}

function fail(message, code, action = INSTALL_ACTION) {
  return new CodexHookArtifactError(message, code, action);
}

function invalid(message) {
  return fail(
    message,
    'CODEX_HOOK_ARTIFACT_INVALID',
    'Name the artifact root, version, runtime identity, and account uids '
      + 'exactly, from configuration.',
  );
}

function unsafe(message) {
  return fail(message, 'CODEX_HOOK_ARTIFACT_UNSAFE');
}

function mismatch(message) {
  return fail(
    message,
    'CODEX_HOOK_ARTIFACT_MISMATCH',
    'Reinstall as a new version; a generated closure is never repaired in place.',
  );
}

function missing(message) {
  return fail(
    message,
    'CODEX_HOOK_ARTIFACT_MISSING',
    'Install the artifact version before referencing it.',
  );
}

function reserved(message) {
  return fail(
    message,
    'CODEX_HOOK_ARTIFACT_VERSION_RESERVED',
    'Release under a new version id; a retired id is never reused.',
  );
}

function locked(message) {
  return fail(
    message,
    'CODEX_HOOK_ARTIFACT_LOCKED',
    'Wait for the other operator run on this artifact root to finish.',
  );
}

// The expected accounts come from the caller's configuration. Nothing on disk
// is allowed to nominate the account that is trusted to own the tree.
function assertIdentities({ operatorUid, serviceUid }) {
  for (const [label, value] of [['operator', operatorUid], ['service', serviceUid]]) {
    if (!Number.isInteger(value) || value < 0) {
      throw invalid(`The expected ${label} uid must be configured explicitly.`);
    }
  }
  if (serviceUid === 0) {
    throw invalid(
      'A service account of root has no boundary to enforce; run the service '
        + 'as an unprivileged account.',
    );
  }
  if (serviceUid === operatorUid) {
    throw invalid('The service account must not be the operator account.');
  }
  return Object.freeze({ operatorUid, serviceUid });
}

function assertName(value, label) {
  if (typeof value !== 'string' || !VERSION_RE.test(value)
    || RESERVED_NAMES.has(value)) {
    throw invalid(
      `The ${label} must be an exact immutable name, never a moving alias or `
        + 'a path.',
    );
  }
  return value;
}

function canonicalDirectory(target, label) {
  if (typeof target !== 'string' || target.length === 0
    || !path.isAbsolute(target) || path.normalize(target) !== target) {
    throw invalid(`The ${label} must be a canonical absolute path.`);
  }
  let resolved;
  try {
    resolved = realpathSync(target);
  } catch (error) {
    throw missing(`The ${label} does not exist.`);
  }
  if (resolved !== target) {
    throw invalid(`The ${label} must not be reached through an alias.`);
  }
  return resolved;
}

// A tight file under a loose directory is not protected: the directory permits
// wholesale replacement of the file. Ownership and POSIX mode bits are all
// this can see — ACLs and extended attributes are not inspected, so this is a
// necessary condition, not a proof of unwritability.
function assertSafeChain(target, { operatorUid, serviceUid }) {
  const root = path.parse(target).root;
  let component = root;
  for (const part of target.slice(root.length).split('/').filter(Boolean)) {
    component = path.join(component, part);
    let stat;
    try {
      stat = lstatSync(component);
    } catch (error) {
      throw missing(`The artifact path component ${part} does not exist.`);
    }
    if (stat.isSymbolicLink()) {
      throw unsafe(`The artifact path component ${part} is a symbolic link.`);
    }
    if (stat.uid === serviceUid) {
      throw unsafe(`The artifact path component ${part} is service-owned.`);
    }
    if (stat.uid !== 0 && stat.uid !== operatorUid) {
      throw unsafe(
        `The artifact path component ${part} is owned by neither root nor the `
          + 'configured operator account.',
      );
    }
    if ((stat.mode & 0o022) !== 0) {
      throw unsafe(`The artifact path component ${part} is service-writable.`);
    }
    if ((stat.mode & 0o7000) !== 0) {
      throw unsafe(`The artifact path component ${part} carries a special mode bit.`);
    }
    if (stat.isDirectory() && (stat.mode & 0o001) === 0) {
      throw unsafe(
        `The artifact path component ${part} cannot be traversed by the `
          + 'service account.',
      );
    }
  }
}

function assertProtectedDirectory(target, identities, label) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    throw missing(`The ${label} does not exist.`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw unsafe(`The ${label} is not a directory.`);
  }
  if ((stat.mode & 0o7000) !== 0) {
    throw unsafe(`The ${label} carries a special mode bit.`);
  }
  if (!DIRECTORY_MODES.has(stat.mode & 0o777)) {
    throw unsafe(`The ${label} does not carry an accepted directory mode.`);
  }
  assertSafeChain(target, identities);
  return stat;
}

function assertProtectedFile(target, identities, { modes, label }) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    throw missing(`The ${label} is absent.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw unsafe(`The ${label} is not a regular file.`);
  }
  if (stat.nlink !== 1) {
    throw unsafe(`The ${label} is hard-linked.`);
  }
  if (stat.uid === identities.serviceUid) {
    throw unsafe(`The ${label} is service-owned.`);
  }
  if (stat.uid !== 0 && stat.uid !== identities.operatorUid) {
    throw unsafe(
      `The ${label} is owned by neither root nor the configured operator `
        + 'account.',
    );
  }
  if ((stat.mode & 0o7000) !== 0) {
    throw unsafe(`The ${label} carries a special mode bit.`);
  }
  if (!modes.has(stat.mode & 0o777)) {
    throw unsafe(`The ${label} does not carry an accepted file mode.`);
  }
  return stat;
}

// Staging is owner-only from the moment it exists, so a half-written closure
// is never readable — let alone executable — under any name.
function createPrivateStagingDirectory(root, version) {
  const staging = path.join(root, `${STAGING_PREFIX}${version}-${process.pid}`);
  mkdirSync(staging, { mode: 0o700 });
  chmodSync(staging, 0o700);
  return staging;
}

// Members are created inside that private directory, exclusively, and without
// following anything that may already be there; the final modes and the
// publish happen only once every member is written.
function writePrivateMember(target, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const descriptor = openSync(
    target,
    // eslint-disable-next-line no-bitwise
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    // A single write can be short, and a member that is only mostly there is
    // exactly the thing this whole boundary exists to prevent.
    let written = 0;
    while (written < bytes.length) {
      const chunk = writeSync(descriptor, bytes, written, bytes.length - written);
      if (chunk <= 0) {
        throw unsafe(`The member ${path.basename(target)} could not be written whole.`);
      }
      written += chunk;
    }
  } finally {
    closeSync(descriptor);
  }
}

function digestOf(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function readMember(target, label) {
  try {
    return readFileSync(target);
  } catch (error) {
    throw missing(`The ${label} is absent.`);
  }
}

// The closure U23 installs is derived here and nowhere else: callers cannot
// pass one in, widen it, or narrow it. A hand-maintained list is precisely how
// a member goes unlisted, so the build output is the only authority.
function createHookClosureDeclaration() {
  const bundle = readCheckedInBundle();
  const members = [Object.freeze({
    id: HOOK_ARTIFACT_BUNDLE_ID,
    mode: 0o644,
    relativePath: HOOK_ARTIFACT_BUNDLE_NAME,
    sha256: bundle.sha256,
    sourcePath: bundle.path,
  })];
  const ids = new Set(members.map((member) => member.id));
  const paths = new Set(members.map((member) => member.relativePath));
  if (members.length === 0 || ids.size !== members.length
    || paths.size !== members.length
    || members.some((member) => !RELATIVE_NAME_RE.test(member.relativePath))) {
    throw invalid('The generated hook closure is not a unique member set.');
  }
  return Object.freeze({
    memberCount: members.length,
    members: Object.freeze(members),
    runtime: Object.freeze({
      id: HOOK_RUNTIME_ID,
      mode: 0o755,
      relativePath: HOOK_RUNTIME_RELATIVE_PATH,
    }),
    schema: HOOK_CLOSURE_SCHEMA,
  });
}

function rootMarkerBytes() {
  return `${JSON.stringify({ schema: HOOK_ARTIFACT_ROOT_SCHEMA }, null, 2)}\n`;
}

function assertRootMarker(root, identities) {
  const markerPath = path.join(root, HOOK_ARTIFACT_ROOT_MARKER_NAME);
  assertProtectedFile(markerPath, identities, {
    modes: MEMBER_MODES,
    label: 'artifact root marker',
  });
  if (readFileSync(markerPath, 'utf8') !== rootMarkerBytes()) {
    throw mismatch('The artifact root marker is not the generated marker.');
  }
  return markerPath;
}

// The manifest is rendered from trusted expectations and compared byte for
// byte against what is installed. Nothing about the expected closure is ever
// read back out of it.
function renderManifest({ version, members, runtime }) {
  return `${JSON.stringify({
    artifacts: [...members]
      .map((member) => ({
        id: member.id,
        path: member.relativePath,
        sha256: member.sha256,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    runtime: {
      id: runtime.id,
      path: runtime.path,
      sha256: runtime.sha256,
      version: runtime.version,
    },
    schema: HOOK_ARTIFACT_MANIFEST_SCHEMA,
    version,
  }, null, 2)}\n`;
}

function closureDigest({ manifestSha256, runtime, artifacts }) {
  return digestOf(JSON.stringify({
    artifacts: artifacts.map((entry) => [entry.id, entry.sha256]),
    manifest: manifestSha256,
    runtime: runtime.sha256,
  }));
}

// The runtime is a versioned member of the tree's contract, not an arbitrary
// absolute path: it is named by an immutable identity under a configured root,
// and one identity may never denote two different binaries.
function measureRuntime({
  runtimeRoot,
  runtimeId,
  expectedSha256,
  identities,
  declaration,
}) {
  assertName(runtimeId, 'runtime identity');
  const root = canonicalDirectory(runtimeRoot, 'runtime root');
  const versionDir = path.join(root, runtimeId);
  assertProtectedDirectory(versionDir, identities, 'runtime version directory');
  const runtimePath = path.join(versionDir, declaration.runtime.relativePath);
  assertSafeChain(runtimePath, identities);
  assertProtectedFile(runtimePath, identities, {
    modes: RUNTIME_MODES,
    label: 'protected runtime',
  });
  const sha256 = digestOf(readMember(runtimePath, 'protected runtime'));
  if (expectedSha256 !== null && expectedSha256 !== undefined) {
    if (!SHA256_RE.test(expectedSha256)) {
      throw invalid('The expected runtime digest must be a lowercase SHA-256.');
    }
    if (expectedSha256 !== sha256) {
      throw mismatch('The protected runtime is not the expected binary.');
    }
  }
  return Object.freeze({
    id: declaration.runtime.id,
    kind: 'protected-runtime',
    path: runtimePath,
    sha256,
    version: runtimeId,
  });
}

// A probe for optional state answers one question — is it there — and nothing
// else. Any other error is damage, and damage fails the run closed.
function absent(error) {
  if (error?.code === 'ENOENT') return true;
  throw unsafe(`An artifact tree entry could not be inspected: ${error?.code}.`);
}

// Once a root is initialized, its contents are enumerable: bookkeeping, a
// quarantine, staging, and version directories. Anything else — a renamed
// quarantine among them — is unaccounted for, and an unaccounted entry could
// be holding the retired identities this tree relies on.
function assertRootOccupants(root) {
  for (const name of readdirSync(root)) {
    if (TREE_FILE_NAMES.has(name) || name === QUARANTINE_DIR_NAME
      || name.startsWith(STAGING_PREFIX)) {
      continue;
    }
    if (!VERSION_RE.test(name) || RESERVED_NAMES.has(name)) {
      throw unsafe(
        `The artifact root holds ${name}, which is neither a version nor part `
          + 'of the tree.',
      );
    }
  }
}

// Every version-shaped entry must actually be a version directory. A file or
// a symlink wearing a version name is damage, not something to step over.
function installedVersionNames(root) {
  const names = [];
  for (const name of readdirSync(root)) {
    if (!VERSION_RE.test(name) || RESERVED_NAMES.has(name)
      || TREE_FILE_NAMES.has(name)) {
      continue;
    }
    const stat = lstatSync(path.join(root, name));
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafe(`The artifact root holds ${name}, which is not a version directory.`);
    }
    names.push(name);
  }
  return names.sort();
}

// Retired identities are read exactly: one directory per retired version name,
// holding one numbered directory per retirement of that name. The quarantine
// is held to the same ownership, mode and type rules as the live tree — a
// retired closure the service can rewrite is no evidence at all — and anything
// unreadable or unexpected fails the run closed rather than silently freeing
// an id for reuse.
function retiredVersionNames(root, identities) {
  const quarantineRoot = path.join(root, QUARANTINE_DIR_NAME);
  try {
    lstatSync(quarantineRoot);
  } catch (error) {
    if (absent(error)) return new Set();
  }
  assertProtectedDirectory(quarantineRoot, identities, 'quarantine directory');
  let entries;
  try {
    entries = readdirSync(quarantineRoot);
  } catch (error) {
    throw unsafe('The quarantine directory cannot be read.');
  }
  const names = new Set();
  for (const name of entries) {
    if (!VERSION_RE.test(name) || RESERVED_NAMES.has(name)) {
      throw unsafe(`The quarantine directory holds ${name}, which is not a retired version.`);
    }
    assertProtectedDirectory(
      path.join(quarantineRoot, name),
      identities,
      `quarantine of version ${name}`,
    );
    names.add(name);
  }
  return names;
}

// Every manifest in the tree, live or retired, that the runtime-identity
// history must account for. A retired entry also carries the name it was
// retired under, so a renamed quarantine directory cannot pass its closure off
// as another identity — or hand the original identity back for reuse.
function manifestPathsForHistory(root, identities) {
  assertRootOccupants(root);
  const entries = installedVersionNames(root).map((version) => {
    // A sibling the service can rewrite cannot lend its manifest any weight.
    assertProtectedDirectory(
      path.join(root, version),
      identities,
      `artifact version ${version}`,
    );
    return {
      manifestPath: path.join(root, version, HOOK_ARTIFACT_MANIFEST_NAME),
      version,
    };
  });
  const quarantineRoot = path.join(root, QUARANTINE_DIR_NAME);
  for (const version of retiredVersionNames(root, identities)) {
    const versionRoot = path.join(quarantineRoot, version);
    for (const attempt of readdirSync(versionRoot)) {
      if (!/^[0-9]+$/.test(attempt)) {
        throw unsafe(
          `The retired version ${version} holds ${attempt}, which is not a closure.`,
        );
      }
      assertProtectedDirectory(
        path.join(versionRoot, attempt),
        identities,
        `retirement ${attempt} of version ${version}`,
      );
      entries.push({
        manifestPath: path.join(versionRoot, attempt, HOOK_ARTIFACT_MANIFEST_NAME),
        version,
      });
    }
  }
  return entries;
}

// One runtime identity, one binary — and no reading past damage. A manifest
// that cannot be read, parsed, or shown to carry a runtime binding is a broken
// tree, not a version to skip; a retired closure counts too, because a session
// may still be executing the runtime it named.
function assertRuntimeBindingsIntact(root, runtime, identities) {
  for (const { manifestPath, version } of manifestPathsForHistory(root, identities)) {
    assertProtectedFile(manifestPath, identities, {
      modes: MEMBER_MODES,
      label: `manifest of version ${version}`,
    });
    let document;
    try {
      document = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw mismatch(`A manifest in this tree cannot be read: ${manifestPath}.`);
    }
    if (document?.version !== version) {
      throw mismatch(
        `A closure filed under ${version} was written for a different version.`,
      );
    }
    const recorded = document?.runtime;
    if (!recorded || typeof recorded !== 'object'
      || typeof recorded.version !== 'string' || !VERSION_RE.test(recorded.version)
      || !SHA256_RE.test(recorded.sha256 ?? '')) {
      throw mismatch(`A manifest in this tree carries no runtime binding: ${manifestPath}.`);
    }
    if (recorded.version === runtime.version && recorded.sha256 !== runtime.sha256) {
      throw mismatch(
        `The runtime identity ${runtime.version} already denotes a different `
          + 'binary in this tree.',
      );
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// There is no automatic reclaim. A lock file cannot prove which run created
// it — a pid is reused, a token cannot be checked against a dead process — so
// an existing lock is a refusal, and clearing it is a deliberate act by the
// account that owns the tree.
function acquireArtifactRootLock(root) {
  const lockPath = path.join(root, LOCK_NAME);
  const token = randomBytes(LOCK_TOKEN_BYTES).toString('hex');
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o644);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw locked(
        'Another operator run holds this artifact root; clear the lock by hand '
          + 'once no run is in flight.',
      );
    }
    throw unsafe('The artifact root install lock could not be taken.');
  }
  try {
    writeSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
  } finally {
    closeSync(descriptor);
  }
  return Object.freeze({ lockPath, token });
}

function releaseArtifactRootLock(handle) {
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(handle.lockPath, 'utf8'));
  } catch (error) {
    throw locked('The artifact root lock was replaced while it was held.');
  }
  if (holder?.token !== handle.token) {
    throw locked('The artifact root lock is no longer the one this run took.');
  }
  rmSync(handle.lockPath, { force: true });
}

function withArtifactRootLock(root, run) {
  const handle = acquireArtifactRootLock(root);
  let result;
  try {
    result = run(handle);
  } catch (error) {
    try {
      releaseArtifactRootLock(handle);
    } catch (releaseError) {
      // The primary failure is the one worth reporting; a lock that is no
      // longer ours is left in place for the operator to inspect.
    }
    throw error;
  }
  releaseArtifactRootLock(handle);
  return result;
}

// Staging directories are cleared only after the root is known to be ours,
// and only the exact name this version would have used. Anything else with the
// staging prefix belongs to a run this one cannot account for.
function clearStagingRemnants(root, version, identities) {
  const prefix = `${STAGING_PREFIX}${version}-`;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const target = path.join(root, name);
    if (!name.startsWith(prefix) || !/^[0-9]+$/.test(name.slice(prefix.length))) {
      throw unsafe(`A staging directory ${name} from another run blocks the install.`);
    }
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || stat.uid === identities.serviceUid
      || (stat.uid !== 0 && stat.uid !== identities.operatorUid)) {
      throw unsafe(`A foreign staging directory ${name} blocks the install.`);
    }
    const pid = Number(name.slice(prefix.length));
    if (pid !== process.pid && processIsAlive(pid)) {
      throw locked(`A live staging directory ${name} blocks the install.`);
    }
    try {
      rmSync(target, { recursive: true });
    } catch (error) {
      throw unsafe(`The staging directory ${name} could not be removed.`);
    }
  }
}

function attestHookArtifactVersion({
  artifactRoot,
  version,
  runtimeRoot,
  runtimeId,
  runtimeSha256,
  operatorUid,
  serviceUid,
}) {
  const identities = assertIdentities({ operatorUid, serviceUid });
  const declaration = createHookClosureDeclaration();
  assertName(version, 'artifact version');
  if (!SHA256_RE.test(runtimeSha256 ?? '')) {
    throw invalid(
      'Attestation requires the expected runtime digest from configuration.',
    );
  }
  const root = canonicalDirectory(artifactRoot, 'artifact root');
  assertProtectedDirectory(root, identities, 'artifact root');
  assertRootMarker(root, identities);
  const runtime = measureRuntime({
    runtimeRoot,
    runtimeId,
    expectedSha256: runtimeSha256,
    identities,
    declaration,
  });
  assertRuntimeBindingsIntact(root, runtime, identities);

  const versionDir = path.join(root, version);
  assertProtectedDirectory(versionDir, identities, `artifact version ${version}`);

  const artifacts = declaration.members.map((member) => {
    const target = path.join(versionDir, member.relativePath);
    assertProtectedFile(target, identities, {
      modes: MEMBER_MODES,
      label: `artifact ${member.relativePath}`,
    });
    const sha256 = digestOf(readMember(target, `artifact ${member.relativePath}`));
    if (sha256 !== member.sha256) {
      throw mismatch(
        `The artifact ${member.relativePath} is not the released body.`,
      );
    }
    return Object.freeze({
      id: member.id,
      kind: 'protected-artifact',
      path: target,
      sha256,
    });
  });

  const manifestPath = path.join(versionDir, HOOK_ARTIFACT_MANIFEST_NAME);
  assertProtectedFile(manifestPath, identities, {
    modes: MEMBER_MODES,
    label: 'artifact manifest',
  });
  const present = readdirSync(versionDir).sort();
  const expected = [
    HOOK_ARTIFACT_MANIFEST_NAME,
    ...declaration.members.map((member) => member.relativePath),
  ].sort();
  if (present.length !== expected.length
    || present.some((name, index) => name !== expected[index])) {
    throw mismatch(
      `The artifact version ${version} does not hold exactly the declared `
        + 'closure.',
    );
  }
  const manifestText = readFileSync(manifestPath, 'utf8');
  if (manifestText !== renderManifest({
    version,
    members: declaration.members,
    runtime,
  })) {
    throw mismatch('The artifact manifest is not what the generator produces.');
  }

  const manifestSha256 = digestOf(manifestText);
  const receipt = {
    artifacts: Object.freeze(artifacts),
    closureSha256: closureDigest({ manifestSha256, runtime, artifacts }),
    manifestPath,
    manifestSha256,
    runtime,
    version,
    versionDir,
  };
  Object.freeze(receipt);
  ATTESTED_RECEIPTS.add(receipt);
  return receipt;
}

// A renderer must not act on a shape that merely looks like a receipt: only
// the object a full attestation returned carries the brand.
function isAttestationReceipt(value) {
  return Boolean(value) && typeof value === 'object'
    && ATTESTED_RECEIPTS.has(value);
}

function installHookArtifactVersion({
  artifactRoot,
  version,
  runtimeRoot,
  runtimeId,
  operatorUid,
  serviceUid,
  expectedRuntimeSha256,
}) {
  const identities = assertIdentities({ operatorUid, serviceUid });
  if (!SHA256_RE.test(expectedRuntimeSha256 ?? '')) {
    throw invalid(
      'Installing requires the expected runtime digest from configuration.',
    );
  }
  const uid = process.getuid?.() ?? 0;
  if (uid === serviceUid) {
    throw unsafe('The service account cannot install the artifacts it executes.');
  }
  if (uid !== 0 && uid !== operatorUid) {
    throw unsafe(
      'The installer must run as root or as the configured operator account.',
    );
  }
  const declaration = createHookClosureDeclaration();
  assertName(version, 'artifact version');
  const root = canonicalDirectory(artifactRoot, 'artifact root');
  assertProtectedDirectory(root, identities, 'artifact root');
  const runtime = measureRuntime({
    runtimeRoot,
    runtimeId,
    expectedSha256: expectedRuntimeSha256,
    identities,
    declaration,
  });

  withArtifactRootLock(root, (lock) => {
    const markerPath = path.join(root, HOOK_ARTIFACT_ROOT_MARKER_NAME);
    let marked = true;
    try {
      lstatSync(markerPath);
    } catch (error) {
      marked = !absent(error);
    }
    if (!marked) {
      // A marker is claimed only on a directory dedicated to this purpose:
      // the lock this run just created is the one thing allowed to be there.
      const occupants = readdirSync(root)
        .filter((name) => name !== path.basename(lock.lockPath));
      if (occupants.length !== 0) {
        throw unsafe(
          'The artifact root already holds unrelated entries; point the '
            + 'installer at a directory dedicated to hook artifacts.',
        );
      }
      writeFileSync(markerPath, rootMarkerBytes(), { mode: 0o644 });
      chmodSync(markerPath, 0o644);
    }
    assertRootMarker(root, identities);
    assertRuntimeBindingsIntact(root, runtime, identities);

    const versionDir = path.join(root, version);
    let installed = true;
    try {
      lstatSync(versionDir);
    } catch (error) {
      installed = !absent(error);
    }
    if (installed) {
      throw fail(
        `The artifact version ${version} is already installed.`,
        'CODEX_HOOK_ARTIFACT_VERSION_EXISTS',
        'Install a new version directory; a released version is never '
          + 'overwritten in place.',
      );
    }
    if (retiredVersionNames(root, identities).has(version)) {
      throw reserved(`The artifact version ${version} was retired already.`);
    }

    clearStagingRemnants(root, version, identities);
    const staging = createPrivateStagingDirectory(root, version);
    try {
      const published = [];
      for (const member of declaration.members) {
        const body = readMember(member.sourcePath, `source ${member.relativePath}`);
        if (digestOf(body) !== member.sha256) {
          throw mismatch(
            `The source of ${member.relativePath} changed during the install.`,
          );
        }
        const target = path.join(staging, member.relativePath);
        writePrivateMember(target, body);
        published.push([target, member.mode, member.sha256]);
      }
      const manifestPath = path.join(staging, HOOK_ARTIFACT_MANIFEST_NAME);
      const manifest = renderManifest({
        version,
        members: declaration.members,
        runtime,
      });
      writePrivateMember(manifestPath, manifest);
      published.push([manifestPath, 0o644, digestOf(manifest)]);
      // What is about to be published is re-read from disk and compared before
      // it takes its final name; a partial or altered staged member never
      // becomes a version.
      for (const [target, , expected] of published) {
        if (digestOf(readMember(target, `staged ${path.basename(target)}`)) !== expected) {
          throw mismatch(
            `The staged ${path.basename(target)} is not what this install wrote.`,
          );
        }
      }
      for (const [target, mode] of published) chmodSync(target, mode);
      chmodSync(staging, 0o755);
      renameSync(staging, versionDir);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    chmodSync(versionDir, 0o755);
  });

  return attestHookArtifactVersion({
    artifactRoot: root,
    version,
    runtimeRoot,
    runtimeId,
    runtimeSha256: runtime.sha256,
    operatorUid,
    serviceUid,
  });
}

function listHookArtifactVersions({ artifactRoot }) {
  return installedVersionNames(canonicalDirectory(artifactRoot, 'artifact root'));
}

// Retirement is recoverable by design. A caller's reference list cannot be
// verified from here, so a wrong list must never be able to destroy a release:
// the version is moved aside, and deleting it stays an operator decision. The
// root lock is taken before anything is inspected, so nothing can be swapped
// between the attestation and the rename.
function quarantineHookArtifactVersion({
  artifactRoot,
  version,
  runtimeRoot,
  runtimeId,
  runtimeSha256,
  operatorUid,
  serviceUid,
  referencedVersions,
}) {
  const identities = assertIdentities({ operatorUid, serviceUid });
  assertName(version, 'artifact version');
  const root = canonicalDirectory(artifactRoot, 'artifact root');
  // Nothing is written into a tree that has not first proved it is ours: the
  // marker is read, and only then does a lock file appear inside the root.
  assertProtectedDirectory(root, identities, 'artifact root');
  assertRootMarker(root, identities);

  return withArtifactRootLock(root, () => {
    const receipt = attestHookArtifactVersion({
      artifactRoot: root,
      version,
      runtimeRoot,
      runtimeId,
      runtimeSha256,
      operatorUid,
      serviceUid,
    });
    if (!Array.isArray(referencedVersions)
      || referencedVersions.some((entry) => typeof entry !== 'string')) {
      throw invalid(
        'Retiring a version requires the exact list of referenced versions.',
      );
    }
    if (referencedVersions.includes(version)) {
      throw fail(
        `The artifact version ${version} is still referenced.`,
        'CODEX_HOOK_ARTIFACT_VERSION_REFERENCED',
        'Retire every session holding the version before retiring the version.',
      );
    }

    // One directory per retired identity, one numbered directory per
    // retirement of it, so a retired id reads back exactly as it was named.
    const quarantineRoot = path.join(root, QUARANTINE_DIR_NAME);
    for (const [directory, mode] of [[quarantineRoot, 0o755], [path.join(quarantineRoot, version), 0o755]]) {
      let exists = true;
      try {
        lstatSync(directory);
      } catch (error) {
        exists = !absent(error);
      }
      if (!exists) {
        mkdirSync(directory, { mode: 0o700 });
        chmodSync(directory, mode);
      }
    }
    assertProtectedDirectory(quarantineRoot, identities, 'quarantine directory');
    const retiredRoot = path.join(quarantineRoot, version);
    assertProtectedDirectory(retiredRoot, identities, `quarantine of version ${version}`);

    for (let attempt = 1; attempt <= MAX_QUARANTINE_ATTEMPTS; attempt += 1) {
      const candidate = path.join(retiredRoot, String(attempt));
      try {
        lstatSync(candidate);
        continue;
      } catch (error) {
        // Only a genuinely free name is claimed; anything else is damage.
        absent(error);
        renameSync(receipt.versionDir, candidate);
        return Object.freeze({
          closureSha256: receipt.closureSha256,
          quarantinePath: candidate,
          version,
          versionDir: receipt.versionDir,
        });
      }
    }
    throw unsafe('The quarantine of this version has no free slot.');
  });
}

module.exports = {
  CodexHookArtifactError,
  HOOK_ARTIFACT_BUNDLE_ID,
  HOOK_ARTIFACT_BUNDLE_NAME,
  HOOK_ARTIFACT_MANIFEST_NAME,
  HOOK_ARTIFACT_MANIFEST_SCHEMA,
  HOOK_ARTIFACT_ROOT_MARKER_NAME,
  HOOK_ARTIFACT_ROOT_SCHEMA,
  HOOK_CLOSURE_SCHEMA,
  HOOK_RUNTIME_ID,
  HOOK_RUNTIME_RELATIVE_PATH,
  QUARANTINE_DIR_NAME,
  acquireArtifactRootLock,
  attestHookArtifactVersion,
  createHookClosureDeclaration,
  createPrivateStagingDirectory,
  isAttestationReceipt,
  installHookArtifactVersion,
  listHookArtifactVersions,
  quarantineHookArtifactVersion,
  releaseArtifactRootLock,
  writePrivateMember,
};

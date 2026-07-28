'use strict';

const {
  lstatSync,
  readFileSync,
  realpathSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const orchestra = require('@shumkov/orchestra');
const {
  resolvePinnedCodexBinary,
} = require('./binary');
const { resolveCodexHostIdentity } = require('./host-identity');
const {
  CODEX_PERMISSION_PROFILE_ID,
  resolveCodexTempDirectory,
} = require('./runtime-profile');
const {
  runtimeDirectory: resolveIpcRuntimeDirectory,
} = require('../ipc/runtime-directory');

const MAX_DETAIL_BYTES = 256;
const MAX_CONFIG_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const HOST_ID_RE = /^host:[a-f0-9]{64}$/;
const BOOT_ID_RE = /^boot:[a-f0-9]{64}$/;
const REASON_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function check(name, status, detail, extra) {
  if (
    typeof detail !== 'string'
    || Buffer.byteLength(detail, 'utf8') > MAX_DETAIL_BYTES
    || /[\u0000-\u001f\u007f]/u.test(detail)
  ) {
    throw new TypeError('Codex doctor detail must be a bounded single line');
  }
  return Object.freeze({
    name,
    status,
    detail,
    ...(extra === undefined ? {} : { extra: Object.freeze({ ...extra }) }),
  });
}

function safeErrorCode(error) {
  return typeof error?.code === 'string'
    && /^(?:CODEX|IPC)_[A-Z0-9_]{1,96}$/.test(error.code)
    ? error.code
    : null;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function defaultTemporaryRoots() {
  const roots = new Set();
  for (const candidate of [
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    '/private/var/folders',
  ]) {
    try {
      roots.add(realpathSync(candidate));
    } catch {}
  }
  return [...roots];
}

function assertOwnedPath(target, {
  directory,
  mode,
  temporaryRoots = [],
  genericCodexHome = null,
}) {
  if (
    typeof target !== 'string'
    || !path.isAbsolute(target)
    || realpathSync(target) !== target
    || temporaryRoots.some((root) => isWithin(root, target))
    || (genericCodexHome && target === genericCodexHome)
  ) {
    throw new Error('unsafe Codex deployment path');
  }
  const stat = lstatSync(target);
  if (
    stat.isSymbolicLink()
    || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o777) !== mode
    || (
      typeof process.getuid === 'function'
      && stat.uid !== process.getuid()
    )
    || (!directory && stat.nlink !== 1)
  ) {
    throw new Error('unsafe Codex deployment ownership or mode');
  }
}

function inspectCodexHome(codexHome, dependencies) {
  assertOwnedPath(codexHome, {
    directory: true,
    mode: 0o700,
    temporaryRoots: dependencies.temporaryRoots,
    genericCodexHome: dependencies.genericCodexHome,
  });
  for (const file of ['config.toml', 'auth.json']) {
    assertOwnedPath(path.join(codexHome, file), {
      directory: false,
      mode: 0o600,
    });
  }
}

function readCodexOwnedConfig(codexHome) {
  const configPath = path.join(codexHome, 'config.toml');
  const stat = lstatSync(configPath);
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new Error('Codex owned config exceeded the inspection bound');
  }
  return readFileSync(configPath, 'utf8');
}

function inspectCodexProfile(raw, profileId) {
  const escapedProfile = profileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const required = [
    new RegExp(`^default_permissions\\s*=\\s*"${escapedProfile}"\\s*$`, 'm'),
    /^approval_policy\s*=\s*"never"\s*$/m,
    /^web_search\s*=\s*"disabled"\s*$/m,
    new RegExp(
      `^\\[permissions\\."${escapedProfile}"\\.network\\]\\s*\\n`
        + 'enabled\\s*=\\s*false\\s*$',
      'm',
    ),
  ];
  if (!required.every((pattern) => pattern.test(raw))) {
    throw new Error('Codex owned profile is unavailable');
  }
}

function inspectCodexDenyRoot(raw, deniedRoot, profileId) {
  const lines = raw.split('\n');
  const filesystemSection =
    `[permissions.${JSON.stringify(profileId)}.filesystem]`;
  let inFilesystemSection = false;
  for (const line of lines) {
    const structuralLine = line.trim();
    if (structuralLine.startsWith('[')) {
      inFilesystemSection = structuralLine === filesystemSection;
      continue;
    }
    if (!inFilesystemSection) continue;
    const match = line.match(/^("(?:[^"\\]|\\.)*")\s*=\s*"deny"\s*$/u);
    if (!match) continue;
    let configuredRoot;
    try {
      configuredRoot = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (
      typeof configuredRoot === 'string'
      && path.isAbsolute(configuredRoot)
      && isWithin(configuredRoot, deniedRoot)
    ) {
      return;
    }
  }
  throw new Error('Codex protected root is absent from the owned profile');
}

function configuredWorkspaces(config) {
  const workspaces = new Set();
  const defaultCwd = config?.defaults?.cwd;
  for (const chat of Object.values(config?.chats ?? {})) {
    if (!chat || typeof chat !== 'object') continue;
    const chatCwd = chat.cwd ?? defaultCwd;
    if (typeof chatCwd === 'string') workspaces.add(chatCwd);
    for (const topic of Object.values(chat.topics ?? {})) {
      if (!topic || typeof topic !== 'object') continue;
      const topicCwd = topic.cwd ?? chatCwd;
      if (typeof topicCwd === 'string') workspaces.add(topicCwd);
    }
  }
  return [...workspaces];
}

function readLease(db) {
  if (!db || typeof db.prepare !== 'function') return undefined;
  return db.prepare(`
    SELECT generation_id, status, quarantine_reason
      FROM codex_daemon_lease
     WHERE singleton = 1
  `).get();
}

function leaseCheck(db) {
  if (!db) {
    return check(
      'codex-lease',
      'warn',
      'not checked because the database is unavailable',
      { runtime: 'codex', scope: 'daemon', status: 'unknown' },
    );
  }
  let lease;
  try {
    lease = readLease(db);
  } catch (error) {
    return check(
      'codex-lease',
      'warn',
      'lease table is unavailable; apply the Codex schema before enablement',
      {
        runtime: 'codex',
        scope: 'daemon',
        status: 'unknown',
        code: safeErrorCode(error),
      },
    );
  }
  if (!lease || lease.status === 'clear') {
    return check(
      'codex-lease',
      'ok',
      'daemon-wide native Codex lease is clear',
      {
        runtime: 'codex',
        scope: 'daemon',
        status: 'clear',
        ownerPresent: false,
        rebootRequired: false,
      },
    );
  }
  if (lease.status === 'active') {
    return check(
      'codex-lease',
      'warn',
      'one daemon-wide native Codex generation is active',
      {
        runtime: 'codex',
        scope: 'daemon',
        status: 'active',
        ownerPresent: typeof lease.generation_id === 'string',
        rebootRequired: false,
      },
    );
  }
  if (lease.status === 'quarantined') {
    const reasonCode = typeof lease.quarantine_reason === 'string'
      && lease.quarantine_reason.length <= 96
      && REASON_CODE_RE.test(lease.quarantine_reason)
      ? lease.quarantine_reason
      : null;
    return check(
      'codex-lease',
      'fail',
      'daemon-wide Codex quarantine is active; same-host reboot required before release',
      {
        runtime: 'codex',
        scope: 'daemon',
        status: 'quarantined',
        ownerPresent: typeof lease.generation_id === 'string',
        rebootRequired: true,
        reasonCode,
      },
    );
  }
  return check(
    'codex-lease',
    'fail',
    'daemon-wide Codex lease has an invalid state',
    {
      runtime: 'codex',
      scope: 'daemon',
      status: 'invalid',
      rebootRequired: true,
    },
  );
}

function dependenciesWithDefaults(input = {}) {
  let genericCodexHome = path.join(os.homedir(), '.codex');
  try {
    genericCodexHome = realpathSync(genericCodexHome);
  } catch {}
  return {
    resolveBinary:
      input.resolveBinary ?? resolvePinnedCodexBinary,
    resolveHostIdentity:
      input.resolveHostIdentity ?? resolveCodexHostIdentity,
    protocolSchema:
      input.protocolSchema ?? orchestra.codexProtocolSchema,
    resolveTargetPin:
      input.resolveTargetPin ?? orchestra.resolveCodexTargetPin,
    profileId:
      input.profileId ?? CODEX_PERMISSION_PROFILE_ID,
    temporaryRoots:
      input.temporaryRoots ?? defaultTemporaryRoots(),
    ipcTemporaryRoots:
      input.ipcTemporaryRoots ?? defaultTemporaryRoots(),
    resolveIpcRuntimeDirectory:
      input.resolveIpcRuntimeDirectory ?? resolveIpcRuntimeDirectory,
    genericCodexHome:
      input.genericCodexHome ?? genericCodexHome,
  };
}

async function collectCodexDoctorChecks({
  config,
  db,
  dependencies: dependencyOverrides,
  processEnv = process.env,
} = {}) {
  if (
    !config?.codex
    || typeof config.codex !== 'object'
    || Array.isArray(config.codex)
  ) {
    return [check(
      'codex-runtime',
      'ok',
      'not configured',
      { runtime: 'codex', configured: false },
    )];
  }

  const dependencies = dependenciesWithDefaults(dependencyOverrides);
  const checks = [];
  let targetPin;
  try {
    targetPin = dependencies.resolveTargetPin();
    const receipt = await dependencies.resolveBinary({
      binaryPath: config.codex.binary,
      env: { POLYGRAM_CODEX_BIN: config.codex.binary },
    });
    if (
      receipt?.target !== targetPin?.target
      || receipt?.version !== targetPin?.cliVersion
      || receipt?.sha256 !== targetPin?.binarySha256
    ) {
      throw new Error('pinned Codex binary receipt mismatch');
    }
    checks.push(check(
      'codex-binary',
      'ok',
      `pinned runtime verified (${targetPin.cliVersion})`,
      {
        runtime: 'codex',
        pinned: true,
        target: targetPin.target,
        version: targetPin.cliVersion,
      },
    ));
  } catch (error) {
    checks.push(check(
      'codex-binary',
      'fail',
      'pinned runtime verification failed',
      {
        runtime: 'codex',
        pinned: false,
        code: safeErrorCode(error),
      },
    ));
  }

  try {
    inspectCodexHome(config.codex.home, dependencies);
    checks.push(check(
      'codex-home',
      'ok',
      'dedicated persistent mode-0700 CODEX_HOME is provisioned',
      {
        runtime: 'codex',
        dedicated: true,
        credentialsPresent: true,
      },
    ));
  } catch (error) {
    checks.push(check(
      'codex-home',
      'fail',
      'dedicated CODEX_HOME is missing, temporary, aliased, or has unsafe permissions',
      {
        runtime: 'codex',
        dedicated: false,
        code: safeErrorCode(error),
      },
    ));
  }

  const schema = dependencies.protocolSchema;
  if (
    typeof targetPin?.target === 'string'
    && schema?.cliVersion === targetPin.cliVersion
    && schema?.binarySha256ByTarget?.[targetPin.target]
      === targetPin.binarySha256
    && SHA256_RE.test(schema?.generatedProtocolV2CanonicalSha256)
  ) {
    checks.push(check(
      'codex-protocol',
      'ok',
      'installed protocol schema matches the pinned runtime',
      {
        runtime: 'codex',
        target: targetPin.target,
        version: targetPin.cliVersion,
        schemaPinned: true,
      },
    ));
  } else {
    checks.push(check(
      'codex-protocol',
      'fail',
      'installed protocol schema does not match the pinned runtime',
      { runtime: 'codex', schemaPinned: false },
    ));
  }

  let ownedConfig;
  try {
    ownedConfig = readCodexOwnedConfig(config.codex.home);
    inspectCodexProfile(ownedConfig, dependencies.profileId);
    checks.push(check(
      'codex-profile',
      'ok',
      'owned no-approval, no-network permission profile is present',
      {
        runtime: 'codex',
        profile: dependencies.profileId,
        available: true,
      },
    ));
  } catch (error) {
    checks.push(check(
      'codex-profile',
      'fail',
      'owned Codex permission profile is missing or drifted',
      {
        runtime: 'codex',
        profile: dependencies.profileId,
        available: false,
        code: safeErrorCode(error),
      },
    ));
  }

  try {
    const ipcRuntimeDirectory = dependencies.resolveIpcRuntimeDirectory();
    assertOwnedPath(ipcRuntimeDirectory, {
      directory: true,
      mode: 0o700,
      temporaryRoots: dependencies.ipcTemporaryRoots,
    });
    checks.push(check(
      'codex-ipc-root',
      'ok',
      'owner-only daemon IPC runtime directory is protected from Codex',
      {
        runtime: 'codex',
        protected: true,
      },
    ));
  } catch (error) {
    checks.push(check(
      'codex-ipc-root',
      'fail',
      'daemon IPC runtime directory is missing, temporary, aliased, or has unsafe permissions',
      {
        runtime: 'codex',
        protected: false,
        code: safeErrorCode(error),
      },
    ));
  }

  try {
    const codexTmp = resolveCodexTempDirectory(processEnv);
    if (
      isWithin(config.codex.home, codexTmp)
      || isWithin(codexTmp, config.codex.home)
      || configuredWorkspaces(config).some((workspace) => (
        isWithin(workspace, codexTmp) || isWithin(codexTmp, workspace)
      ))
    ) {
      throw new Error('Codex temp root overlaps protected runtime state');
    }
    ownedConfig ??= readCodexOwnedConfig(config.codex.home);
    inspectCodexDenyRoot(
      ownedConfig,
      codexTmp,
      dependencies.profileId,
    );
    checks.push(check(
      'codex-tmpdir',
      'ok',
      'owner-only Codex child temp directory is protected from commands',
      {
        runtime: 'codex',
        protected: true,
        source: processEnv.POLYGRAM_CODEX_TMPDIR
          ? 'polygram'
          : 'inherited',
      },
    ));
  } catch (error) {
    checks.push(check(
      'codex-tmpdir',
      'fail',
      'Codex child temp directory is missing, aliased, overlapping, or has unsafe permissions',
      {
        runtime: 'codex',
        protected: false,
        code: safeErrorCode(error),
      },
    ));
  }

  checks.push(check(
    'codex-model-catalog',
    'warn',
    'offline doctor does not start Codex; authenticated profile and model availability require preflight',
    { runtime: 'codex', checked: false, requiresPreflight: true },
  ));

  try {
    const identity = dependencies.resolveHostIdentity();
    if (
      !HOST_ID_RE.test(identity?.stableHostId)
      || !BOOT_ID_RE.test(identity?.bootSessionId)
    ) {
      throw new Error('invalid Codex host identity projection');
    }
    checks.push(check(
      'codex-identity',
      'ok',
      'stable host and kernel boot-session identities are available',
      {
        runtime: 'codex',
        stableHostAvailable: true,
        bootSessionAvailable: true,
      },
    ));
  } catch (error) {
    checks.push(check(
      'codex-identity',
      'fail',
      'stable host or kernel boot-session identity is unavailable',
      {
        runtime: 'codex',
        stableHostAvailable: false,
        bootSessionAvailable: false,
        code: safeErrorCode(error),
      },
    ));
  }

  checks.push(leaseCheck(db));
  checks.push(check(
    'codex-native-background',
    'warn',
    'detached and background servers are unsupported in the native beta and may require a host reboot after hard loss',
    {
      runtime: 'codex',
      detachedBackgroundSupported: false,
      hardLossRebootRequired: true,
    },
  ));
  return checks;
}

module.exports = {
  collectCodexDoctorChecks,
};

'use strict';

const { createHash } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const {
  buildCodexAppServerEnv,
  CodexAppServerClient,
  codexProtocolSchema,
  characterizePinnedSessionLauncher,
  resolveCodexTargetPin,
} = require('@shumkov/orchestra');

const CODEX_PERMISSION_PROFILE_ID = 'polygram-session';
const CONTROLLED_PATH = '/usr/bin:/bin';
const MAX_PAGES = 16;
const MAX_PROFILES = 1_000;
const MAX_STRING_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

class CodexRuntimeProfileError extends Error {
  constructor(message, code, action, options) {
    super(message, options);
    this.name = 'CodexRuntimeProfileError';
    this.code = code;
    this.action = action;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  const input = typeof value === 'string'
    ? value
    : JSON.stringify(canonical(value));
  return createHash('sha256').update(input).digest('hex');
}

function fail(message, code, action, cause) {
  return new CodexRuntimeProfileError(
    message,
    code,
    action,
    cause ? { cause } : undefined,
  );
}

function requiredString(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > MAX_STRING_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw fail(
      `Codex ${label} must be a bounded string without control characters.`,
      'CODEX_RUNTIME_PROFILE_INVALID',
      'Correct the Codex runtime configuration before enabling it.',
    );
  }
  return value;
}

function requiredSha256(value, label) {
  if (!SHA256_RE.test(value)) {
    throw fail(
      `Codex ${label} must be a lowercase SHA-256.`,
      'CODEX_RUNTIME_POLICY_DRIFT',
      'Rerun Codex runtime characterization with the pinned client.',
    );
  }
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeDeniedRoots(roots) {
  const bySpecificity = [...new Set(roots)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const normalized = [];
  for (const root of bySpecificity) {
    if (!normalized.some((parent) => isWithin(parent, root))) {
      normalized.push(root);
    }
  }
  return normalized.sort();
}

function canonicalTemporaryRoots() {
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

function assertOwnedMode(target, {
  code,
  kind,
  expectedMode,
  directory,
  allowRoot = false,
}) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    throw fail(
      `Codex ${kind} could not be inspected.`,
      code,
      `Provision a canonical owner-only ${kind}.`,
      error,
    );
  }
  const expectedType = directory ? stat.isDirectory() : stat.isFile();
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink()
    || !expectedType
    || (uid !== undefined && stat.uid !== uid && !(allowRoot && stat.uid === 0))
    || (stat.mode & 0o777) !== expectedMode
    || (!directory && stat.nlink !== 1)
  ) {
    throw fail(
      `Codex ${kind} ownership, type, or mode is unsafe.`,
      code,
      `Provision a canonical owner-only ${kind} with mode ${
        expectedMode.toString(8).padStart(4, '0')
      }.`,
    );
  }
  return stat;
}

function assertSafeParentChain(target, kind, {
  code = 'CODEX_HOME_UNSAFE',
  remediation = `Move the Codex ${kind} under an owner-controlled path.`,
  allowRootOwnedSymlinks = false,
} = {}) {
  const root = path.parse(target).root;
  let component = root;
  for (const part of target.slice(root.length).split('/').filter(Boolean)) {
    component = path.join(component, part);
    const stat = lstatSync(component);
    const uid = process.getuid?.();
    const safeSystemSymlink =
      stat.isSymbolicLink()
      && allowRootOwnedSymlinks
      && stat.uid === 0;
    if (
      (stat.isSymbolicLink() && !safeSystemSymlink)
      || (uid !== undefined && ![0, uid].includes(stat.uid))
      || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)
    ) {
      throw fail(
        `Codex ${kind} path ownership or mode is unsafe.`,
        code,
        remediation,
      );
    }
  }
}

function canonicalDirectory(target, label) {
  requiredString(target, label);
  if (!path.isAbsolute(target)) {
    throw fail(
      `Codex ${label} must be absolute.`,
      'CODEX_RUNTIME_PROFILE_INVALID',
      `Configure a canonical absolute ${label}.`,
    );
  }
  let canonicalPath;
  try {
    canonicalPath = realpathSync(target);
  } catch (error) {
    throw fail(
      `Codex ${label} does not exist.`,
      'CODEX_RUNTIME_PROFILE_INVALID',
      `Provision the ${label} before enabling Codex.`,
      error,
    );
  }
  if (canonicalPath !== target || !lstatSync(target).isDirectory()) {
    throw fail(
      `Codex ${label} must be a canonical directory.`,
      'CODEX_RUNTIME_PROFILE_INVALID',
      `Remove aliases from the configured ${label}.`,
    );
  }
  return canonicalPath;
}

function ensurePrivateDirectory(target, code, kind) {
  if (!existsSync(target)) {
    try {
      mkdirSync(target, { mode: 0o700 });
      chmodSync(target, 0o700);
    } catch (error) {
      throw fail(
        `Codex ${kind} could not be provisioned.`,
        code,
        `Create the ${kind} as an owner-only mode-0700 directory.`,
        error,
      );
    }
  }
  let canonicalPath;
  try {
    canonicalPath = realpathSync(target);
  } catch (error) {
    throw fail(
      `Codex ${kind} could not be resolved.`,
      code,
      `Create the ${kind} as an owner-only mode-0700 directory.`,
      error,
    );
  }
  if (canonicalPath !== target) {
    throw fail(
      `Codex ${kind} must not be a path alias.`,
      code,
      `Replace the ${kind} with a canonical mode-0700 directory.`,
    );
  }
  assertOwnedMode(target, {
    code,
    kind,
    expectedMode: 0o700,
    directory: true,
  });
  return canonicalPath;
}

function tomlString(value) {
  requiredString(value, 'TOML value');
  return JSON.stringify(value);
}

function tomlKey(value) {
  return JSON.stringify(requiredString(value, 'TOML key'));
}

function buildOwnedConfig({
  codexHome,
  workspace,
  daemonSecretRoots,
  commandHome,
  commandTmp,
}) {
  const filesystem = {
    ':minimal': 'read',
    [codexHome]: 'deny',
  };
  for (const root of [...daemonSecretRoots].sort()) {
    filesystem[root] = 'deny';
  }
  filesystem[':workspace_roots'] = { '.': 'write' };
  return {
    cli_auth_credentials_store: 'file',
    model_provider: 'openai',
    default_permissions: CODEX_PERMISSION_PROFILE_ID,
    approval_policy: 'never',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    features: {
      goals: false,
    },
    shell_environment_policy: {
      inherit: 'none',
      ignore_default_excludes: false,
      set: {
        HOME: commandHome,
        TMPDIR: commandTmp,
        PATH: CONTROLLED_PATH,
      },
    },
    permissions: {
      [CODEX_PERMISSION_PROFILE_ID]: {
        filesystem,
        network: { enabled: false },
      },
    },
    projects: {
      [workspace]: { trust_level: 'untrusted' },
    },
  };
}

function renderOwnedConfig(config, {
  codexHome,
  workspace,
  daemonSecretRoots,
}) {
  const command = config.shell_environment_policy.set;
  const filesystem = config.permissions[
    CODEX_PERMISSION_PROFILE_ID
  ].filesystem;
  const lines = [
    'cli_auth_credentials_store = "file"',
    'model_provider = "openai"',
    `default_permissions = ${tomlString(CODEX_PERMISSION_PROFILE_ID)}`,
    'approval_policy = "never"',
    'approvals_reviewer = "user"',
    'web_search = "disabled"',
    'allow_login_shell = false',
    '',
    '[features]',
    'goals = false',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'ignore_default_excludes = false',
    '',
    '[shell_environment_policy.set]',
    `HOME = ${tomlString(command.HOME)}`,
    `TMPDIR = ${tomlString(command.TMPDIR)}`,
    `PATH = ${tomlString(command.PATH)}`,
    '',
    `[permissions.${tomlKey(CODEX_PERMISSION_PROFILE_ID)}.filesystem]`,
    `${tomlKey(':minimal')} = "read"`,
    `${tomlKey(codexHome)} = "deny"`,
  ];
  for (const root of [...daemonSecretRoots].sort()) {
    lines.push(`${tomlKey(root)} = "deny"`);
  }
  lines.push(
    `${tomlKey(':workspace_roots')} = { "." = "write" }`,
    '',
    `[permissions.${tomlKey(CODEX_PERMISSION_PROFILE_ID)}.network]`,
    'enabled = false',
    '',
    `[projects.${tomlKey(workspace)}]`,
    'trust_level = "untrusted"',
    '',
  );
  if (
    filesystem[':minimal'] !== 'read'
    || filesystem[codexHome] !== 'deny'
    || !isDeepStrictEqual(filesystem[':workspace_roots'], { '.': 'write' })
  ) {
    throw new Error('owned config rendering invariant failed');
  }
  return lines.join('\n');
}

function resolveCodexTempDirectory(processEnv) {
  const usesExplicitSelector = processEnv?.POLYGRAM_CODEX_TMPDIR !== undefined;
  const configured = requiredString(
    processEnv?.POLYGRAM_CODEX_TMPDIR ?? processEnv?.TMPDIR,
    'app-server TMPDIR',
  );
  if (
    !path.isAbsolute(configured)
    || (usesExplicitSelector && path.normalize(configured) !== configured)
  ) {
    throw fail(
      'Codex app-server TMPDIR must be a normalized absolute path.',
      'CODEX_TMPDIR_UNSAFE',
      'Configure a canonical owner-only Codex temp directory.',
    );
  }
  let canonicalPath;
  try {
    canonicalPath = realpathSync(configured);
  } catch (error) {
    throw fail(
      'Codex app-server TMPDIR could not be resolved.',
      'CODEX_TMPDIR_UNSAFE',
      'Provision a canonical owner-only mode-0700 Codex temp directory.',
      error,
    );
  }
  if (usesExplicitSelector && canonicalPath !== configured) {
    throw fail(
      'Codex app-server TMPDIR must not be a path alias.',
      'CODEX_TMPDIR_UNSAFE',
      'Replace it with a canonical owner-only mode-0700 directory.',
    );
  }
  if (!usesExplicitSelector) {
    assertSafeParentChain(configured, 'inherited app-server TMPDIR', {
      code: 'CODEX_TMPDIR_UNSAFE',
      remediation: 'Use an inherited temp path with only owner-controlled or root-controlled components.',
      allowRootOwnedSymlinks: true,
    });
  }
  assertOwnedMode(canonicalPath, {
    code: 'CODEX_TMPDIR_UNSAFE',
    kind: 'app-server TMPDIR',
    expectedMode: 0o700,
    directory: true,
  });
  assertSafeParentChain(canonicalPath, 'app-server TMPDIR', {
    code: 'CODEX_TMPDIR_UNSAFE',
    remediation: 'Move the Codex app-server TMPDIR under an owner-controlled path.',
  });
  return canonicalPath;
}

function buildControlledEnv(codexHome, processEnv, appServerTmp) {
  const home = requiredString(processEnv?.HOME, 'app-server HOME');
  if (!path.isAbsolute(home)) {
    throw fail(
      'Codex app-server HOME must be absolute.',
      'CODEX_RUNTIME_PROFILE_INVALID',
      'Configure an explicit absolute service HOME.',
    );
  }
  return buildCodexAppServerEnv(codexHome, {
    HOME: home,
    TMPDIR: appServerTmp,
    LANG: processEnv?.LANG,
    LC_ALL: processEnv?.LC_ALL,
  });
}

function validateBinaryReceipt(receipt, schema, targetPin) {
  if (
    !receipt
    || typeof receipt !== 'object'
    || !Object.isFrozen(receipt)
    || !path.isAbsolute(receipt.path ?? '')
    || typeof targetPin?.target !== 'string'
    || receipt.target !== targetPin.target
    || receipt.version !== targetPin.cliVersion
    || receipt.sha256 !== targetPin.binarySha256
    || schema?.cliVersion !== targetPin.cliVersion
    || schema?.binarySha256ByTarget?.[targetPin.target]
      !== targetPin.binarySha256
    || !SHA256_RE.test(schema?.generatedProtocolV2CanonicalSha256)
  ) {
    throw fail(
      'Codex binary receipt does not match the installed protocol pin.',
      'CODEX_RUNTIME_PIN_MISMATCH',
      'Resolve the pinned binary again with the exact installed Orchestra build.',
    );
  }
}

function assertRootSeparation(codexHome, workspace, daemonSecretRoots) {
  if (isWithin(codexHome, workspace) || isWithin(workspace, codexHome)) {
    throw fail(
      'Codex workspace and credential home overlap.',
      'CODEX_RUNTIME_ROOT_OVERLAP',
      'Use separate canonical workspace and credential roots.',
    );
  }
  for (const root of daemonSecretRoots) {
    if (
      isWithin(root, workspace)
      || isWithin(workspace, root)
      || isWithin(root, codexHome)
      || isWithin(codexHome, root)
    ) {
      throw fail(
        'Codex daemon-secret root overlaps the workspace or credential home.',
        'CODEX_RUNTIME_ROOT_OVERLAP',
        'Move daemon secrets outside the Codex workspace and credential home.',
      );
    }
  }
}

function provisionRuntimeFiles(options, temporaryRoots) {
  const workspace = canonicalDirectory(options.workspace, 'workspace');
  const appServerTmp = resolveCodexTempDirectory(
    options.processEnv ?? process.env,
  );
  const explicitDaemonSecretRoots = (options.daemonSecretRoots ?? []).map(
    (root) => canonicalDirectory(root, 'daemon-secret root'),
  );
  if (explicitDaemonSecretRoots.length === 0) {
    throw fail(
      'Codex requires at least one explicit daemon-secret root.',
      'CODEX_RUNTIME_PROFILE_INVALID',
      'Configure every daemon-secret root before enabling Codex.',
    );
  }
  const daemonSecretRoots = normalizeDeniedRoots([
    ...explicitDaemonSecretRoots,
    appServerTmp,
  ]);

  const configuredHome = requiredString(options.codexHome, 'credential home');
  if (!path.isAbsolute(configuredHome) || path.normalize(configuredHome) !== configuredHome) {
    throw fail(
      'Codex credential home must be a normalized absolute path.',
      'CODEX_HOME_UNSAFE',
      'Configure a canonical non-temporary mode-0700 credential home.',
    );
  }
  if (temporaryRoots.some((root) => isWithin(root, configuredHome))) {
    throw fail(
      'Codex credential home cannot be inside a temporary root.',
      'CODEX_HOME_UNSAFE',
      'Move CODEX_HOME to a persistent owner-only deployment directory.',
    );
  }
  if (!existsSync(configuredHome)) {
    const parent = path.dirname(configuredHome);
    if (realpathSync(parent) !== parent) {
      throw fail(
        'Codex credential-home parent must be canonical.',
        'CODEX_HOME_UNSAFE',
        'Provision CODEX_HOME under an owner-controlled canonical parent.',
      );
    }
    assertSafeParentChain(parent, 'credential home');
  }
  const codexHome = ensurePrivateDirectory(
    configuredHome,
    'CODEX_HOME_UNSAFE',
    'credential home',
  );
  assertSafeParentChain(codexHome, 'credential home');
  assertRootSeparation(codexHome, workspace, daemonSecretRoots);

  const commandHome = ensurePrivateDirectory(
    path.join(workspace, '.codex-command-home'),
    'CODEX_COMMAND_DIR_UNSAFE',
    'command HOME',
  );
  const commandTmp = ensurePrivateDirectory(
    path.join(workspace, '.codex-command-tmp'),
    'CODEX_COMMAND_DIR_UNSAFE',
    'command TMPDIR',
  );
  const ownedConfig = buildOwnedConfig({
    codexHome,
    workspace,
    daemonSecretRoots,
    commandHome,
    commandTmp,
  });
  const rawConfig = renderOwnedConfig(ownedConfig, {
    codexHome,
    workspace,
    daemonSecretRoots,
  });
  const configPath = path.join(codexHome, 'config.toml');
  if (existsSync(configPath)) {
    assertOwnedMode(configPath, {
      code: 'CODEX_OWNED_CONFIG_DRIFT',
      kind: 'owned config.toml',
      expectedMode: 0o600,
      directory: false,
    });
    if (readFileSync(configPath, 'utf8') !== rawConfig) {
      throw fail(
        'Codex owned config.toml differs from the native-beta policy.',
        'CODEX_OWNED_CONFIG_DRIFT',
        'Back up config.toml outside CODEX_HOME, then remove or move the original and rerun startup to reprovision the exact owned config; Polygram never migrates or overwrites it automatically.',
      );
    }
  } else {
    try {
      writeFileSync(configPath, rawConfig, { flag: 'wx', mode: 0o600 });
      chmodSync(configPath, 0o600);
    } catch (error) {
      throw fail(
        'Codex owned config.toml could not be provisioned.',
        'CODEX_OWNED_CONFIG_DRIFT',
        'Provision the exact owner-only config before enabling Codex.',
        error,
      );
    }
  }

  const authPath = path.join(codexHome, 'auth.json');
  if (existsSync(authPath)) {
    assertOwnedMode(authPath, {
      code: 'CODEX_HOME_UNSAFE',
      kind: 'auth.json',
      expectedMode: 0o600,
      directory: false,
    });
  }

  return {
    codexHome,
    workspace,
    daemonSecretRoots,
    commandHome,
    commandTmp,
    ownedConfig,
    rawConfig,
    ownedConfigSha256: digest(rawConfig),
    env: buildControlledEnv(
      codexHome,
      options.processEnv ?? process.env,
      appServerTmp,
    ),
  };
}

function expectedFilesystem(materialized) {
  return {
    glob_scan_max_depth: null,
    ...materialized.ownedConfig.permissions[
      CODEX_PERMISSION_PROFILE_ID
    ].filesystem,
  };
}

function validateProjectedConfig(config, materialized) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('effective config projection is missing');
  }
  const allowedKeys = [
    'sha256',
    'model',
    'modelProvider',
    'defaultPermissions',
    'approvalPolicy',
    'approvalsReviewer',
    'webSearch',
    'allowLoginShell',
    'shellEnvironmentInherit',
    'permissionProfiles',
    'mcpServers',
    'plugins',
    'modelProviders',
  ].sort();
  if (
    JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(allowedKeys)
    || !SHA256_RE.test(config.sha256)
    || (config.model !== null && typeof config.model !== 'string')
    || config.modelProvider !== 'openai'
    || config.defaultPermissions !== CODEX_PERMISSION_PROFILE_ID
    || config.approvalPolicy !== 'never'
    || config.approvalsReviewer !== 'user'
    || config.webSearch !== 'disabled'
    || config.allowLoginShell !== false
    || config.shellEnvironmentInherit !== 'none'
    || !isDeepStrictEqual(config.mcpServers, { count: 0, keySha256: [] })
    || !isDeepStrictEqual(config.plugins, { count: 0, keySha256: [] })
    || !isDeepStrictEqual(config.modelProviders, {
      count: 0,
      keySha256: [],
    })
    || !Array.isArray(config.permissionProfiles)
    || config.permissionProfiles.length !== 1
  ) {
    throw new Error('effective config projection is outside owned policy');
  }

  const profile = config.permissionProfiles[0];
  const filesystem = expectedFilesystem(materialized);
  const rules = Object.entries(filesystem)
    .filter(([, access]) => typeof access === 'string')
    .map(([root, access]) => ({ rootSha256: digest(root), access }))
    .sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  if (
    profile?.id !== CODEX_PERMISSION_PROFILE_ID
    || profile.extends !== null
    || profile.networkEnabled !== false
    || profile.filesystemSha256 !== digest(filesystem)
    || !isDeepStrictEqual(profile.filesystem, rules)
  ) {
    throw new Error('permission profile projection is outside owned policy');
  }
}

function validateProjectedLayers(layers, materialized) {
  if (!Array.isArray(layers) || ![1, 2, 3].includes(layers.length)) {
    throw new Error('config layers are outside the owned layer set');
  }
  let userCount = 0;
  let systemCount = 0;
  let projectCount = 0;
  const emptyConfigSha256 = digest({});
  for (const layer of layers) {
    if (
      !layer
      || typeof layer !== 'object'
      || Array.isArray(layer)
      || JSON.stringify(Object.keys(layer).sort())
        !== JSON.stringify(['configSha256', 'disabled', 'type', 'version'])
      || typeof layer.version !== 'string'
      || layer.version.length === 0
      || !SHA256_RE.test(layer.configSha256)
    ) {
      throw new Error('config layer projection is malformed');
    }
    if (layer.type === 'user') {
      userCount += 1;
      if (
        layer.disabled !== false
        || layer.configSha256 !== digest(materialized.ownedConfig)
      ) {
        throw new Error('owned user layer hash changed');
      }
    } else if (layer.type === 'system') {
      systemCount += 1;
      if (
        layer.disabled !== false
        || layer.configSha256 !== emptyConfigSha256
      ) {
        throw new Error('system layer is not empty');
      }
    } else if (layer.type === 'project') {
      projectCount += 1;
      if (
        layer.disabled !== true
        || layer.configSha256 !== emptyConfigSha256
        || layer.version !== `sha256:${emptyConfigSha256}`
      ) {
        throw new Error('disabled project layer is not empty');
      }
    } else {
      throw new Error('unexpected config layer is active');
    }
  }
  if (userCount !== 1 || systemCount > 1 || projectCount > 1) {
    throw new Error('owned user layer is not unique');
  }
}

function validateRequirements(requirements) {
  if (
    !requirements
    || typeof requirements !== 'object'
    || Array.isArray(requirements)
    || Object.keys(requirements).length !== 1
    || requirements.requirements !== null
  ) {
    throw new Error(
      'managed requirements cannot be validated from the public projection',
    );
  }
}

async function collectPermissionProfiles(client, workspace) {
  const profiles = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = cursor === undefined
      ? { cwd: workspace }
      : { cwd: workspace, cursor };
    const result = await client.request('permissionProfile/list', params);
    if (
      !result
      || !Array.isArray(result.data)
      || result.data.length > 100
    ) {
      throw new Error('permission profile page is malformed');
    }
    for (const profile of result.data) {
      requiredString(profile?.id, 'permission profile ID');
      if (
        ids.has(profile.id)
        || typeof profile.allowed !== 'boolean'
        || (
          profile.descriptionSha256 !== null
          && !SHA256_RE.test(profile.descriptionSha256)
        )
      ) {
        throw new Error('permission profile catalog is malformed');
      }
      ids.add(profile.id);
      profiles.push({
        id: profile.id,
        allowed: profile.allowed,
        descriptionSha256: profile.descriptionSha256,
      });
      if (profiles.length > MAX_PROFILES) {
        throw new Error('permission profile catalog exceeded its bound');
      }
    }
    if (result.nextCursor == null) break;
    requiredString(result.nextCursor, 'permission profile cursor');
    if (cursors.has(result.nextCursor)) {
      throw new Error('permission profile cursor repeated');
    }
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
    if (page === MAX_PAGES - 1) {
      throw new Error('permission profile pagination exceeded its bound');
    }
  }
  const owned = profiles.filter(
    ({ id }) => id === CODEX_PERMISSION_PROFILE_ID,
  );
  if (owned.length !== 1 || owned[0].allowed !== true) {
    throw new Error('owned permission profile is not uniquely allowed');
  }
  return profiles.sort((left, right) => left.id.localeCompare(right.id));
}

async function characterizeRuntime(materialized, {
  binaryReceipt,
  sessionLauncherReceipt,
  clientFactory,
}) {
  let latchedFault = null;
  const client = clientFactory({
    binary: binaryReceipt.path,
    sessionLauncher: sessionLauncherReceipt?.path ?? null,
    expectedSessionLauncherSha256: sessionLauncherReceipt?.sha256 ?? null,
    cwd: materialized.workspace,
    codexHome: materialized.codexHome,
    env: materialized.env,
    expectedConfigSha256: materialized.ownedConfigSha256,
    onNotification: async () => {
      throw fail(
        'Codex runtime characterization received a state notification.',
        'CODEX_RUNTIME_POLICY_DRIFT',
        'Disable Codex and inspect the pinned app-server protocol drift.',
      );
    },
    onFault: (outcome) => {
      outcome?.assertActive?.();
      latchedFault = outcome;
    },
  });
  if (
    !client
    || typeof client.start !== 'function'
    || typeof client.request !== 'function'
    || typeof client.close !== 'function'
    || typeof client.waitForFault !== 'function'
  ) {
    throw new TypeError('Codex runtime clientFactory returned an invalid client');
  }

  let result;
  let failure = null;
  try {
    await client.start();
    const configRead = await client.request('config/read', {
      cwd: materialized.workspace,
      includeLayers: true,
    });
    const requirements = await client.request('configRequirements/read');
    const permissionProfiles = await collectPermissionProfiles(
      client,
      materialized.workspace,
    );
    validateProjectedConfig(configRead?.config, materialized);
    validateProjectedLayers(configRead?.layers, materialized);
    requiredSha256(configRead?.originsSha256, 'origins projection');
    validateRequirements(requirements);
    result = {
      config: configRead.config,
      layers: configRead.layers,
      originsSha256: configRead.originsSha256,
      requirements,
      permissionProfiles,
    };
  } catch (error) {
    failure = error;
  }

  try {
    await client.close();
  } catch (error) {
    throw fail(
      'Codex runtime characterization cleanup failed.',
      'CODEX_RUNTIME_CLIENT_CLOSE_FAILED',
      'Disable Codex and inspect the pinned app-server child cleanup.',
      error,
    );
  }

  let terminalFault;
  try {
    terminalFault = await client.waitForFault();
  } catch (error) {
    throw fail(
      'Codex runtime client fault handoff failed.',
      'CODEX_RUNTIME_CLIENT_FAULT',
      'Disable Codex and inspect the pinned app-server fault handoff.',
      error,
    );
  }
  if (latchedFault || terminalFault) {
    throw fail(
      'Codex runtime client faulted during policy characterization.',
      'CODEX_RUNTIME_CLIENT_FAULT',
      'Disable Codex and inspect the pinned app-server fault.',
    );
  }
  if (failure) {
    if (failure instanceof CodexRuntimeProfileError) throw failure;
    throw fail(
      'Codex runtime policy characterization failed closed.',
      'CODEX_RUNTIME_POLICY_DRIFT',
      'Restore the exact owned policy and rerun characterization.',
      failure,
    );
  }
  return result;
}

function createCodexRuntimeProfileBuilder({
  temporaryRoots = canonicalTemporaryRoots(),
  clientFactory = (options) => new CodexAppServerClient(options),
  protocolSchema = codexProtocolSchema,
  resolveTargetPin = resolveCodexTargetPin,
  attestSessionLauncher = characterizePinnedSessionLauncher,
} = {}) {
  if (
    !Array.isArray(temporaryRoots)
    || typeof clientFactory !== 'function'
    || typeof resolveTargetPin !== 'function'
    || !['undefined', 'function'].includes(typeof attestSessionLauncher)
  ) {
    throw new TypeError('Codex runtime profile builder options are invalid');
  }

  return Object.freeze({
    async prepare(options = {}) {
      const targetPin = resolveTargetPin();
      validateBinaryReceipt(options.binaryReceipt, protocolSchema, targetPin);
      if (
        options.sessionLauncher != null
        && typeof attestSessionLauncher !== 'function'
      ) {
        throw fail(
          'Codex session launcher attestation is unavailable.',
          'CODEX_SESSION_LAUNCHER_MISMATCH',
          'Install the Orchestra release that attests the session launcher.',
        );
      }
      const sessionLauncherReceipt = options.sessionLauncher == null
        ? null
        : await attestSessionLauncher(
          requiredString(options.sessionLauncher, 'session launcher'),
        );
      if (
        sessionLauncherReceipt !== null
        && (
          sessionLauncherReceipt.path !== options.sessionLauncher
          || !SHA256_RE.test(sessionLauncherReceipt.sha256)
        )
      ) {
        throw fail(
          'Codex session launcher attestation was inconsistent.',
          'CODEX_SESSION_LAUNCHER_MISMATCH',
          'Restore the exact root-owned session launcher before enabling Codex.',
        );
      }
      const materialized = provisionRuntimeFiles(options, temporaryRoots);
      const characterized = await characterizeRuntime(materialized, {
        binaryReceipt: options.binaryReceipt,
        sessionLauncherReceipt,
        clientFactory,
      });
      const model = requiredString(options.model, 'model');
      const effort = requiredString(options.effort, 'reasoning effort');
      return deepFreeze({
        runtime: 'codex',
        binary: options.binaryReceipt.path,
        target: targetPin.target,
        binarySha256: options.binaryReceipt.sha256,
        cliVersion: options.binaryReceipt.version,
        protocolSchemaSha256:
          protocolSchema.generatedProtocolV2CanonicalSha256,
        codexHome: materialized.codexHome,
        cwd: materialized.workspace,
        env: materialized.env,
        allowlistedEnvironmentFingerprint: digest(materialized.env),
        ownedConfigSha256: materialized.ownedConfigSha256,
        expectedConfigSha256: characterized.config.sha256,
        expectedConfig: characterized.config,
        expectedLayers: characterized.layers,
        expectedOriginsSha256: characterized.originsSha256,
        expectedRequirements: characterized.requirements.requirements,
        expectedPermissionProfiles: characterized.permissionProfiles,
        permissionProfileId: CODEX_PERMISSION_PROFILE_ID,
        model,
        effort,
        sessionLauncher: sessionLauncherReceipt?.path ?? null,
        sessionLauncherSha256: sessionLauncherReceipt?.sha256 ?? null,
      });
    },
  });
}

const defaultBuilder = createCodexRuntimeProfileBuilder();

async function prepareCodexRuntimeProfile(options) {
  return defaultBuilder.prepare(options);
}

module.exports = {
  CODEX_PERMISSION_PROFILE_ID,
  CodexRuntimeProfileError,
  createCodexRuntimeProfileBuilder,
  normalizeDeniedRoots,
  prepareCodexRuntimeProfile,
  resolveCodexTempDirectory,
};

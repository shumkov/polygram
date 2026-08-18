'use strict';

const { createHash, randomUUID } = require('node:crypto');
const {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const {
  attestHookArtifactVersion,
} = require('./hook-artifacts');
const { renderHookCommand } = require('./hook-command');

const HOOK_EVENTS = Object.freeze([
  Object.freeze({ configName: 'SessionStart', event: 'sessionStart' }),
  Object.freeze({ configName: 'UserPromptSubmit', event: 'userPromptSubmit' }),
  Object.freeze({ configName: 'Stop', event: 'stop' }),
]);
const CAPTURE_DIRECTORY = '.polygram-codex-hook-observations';
const LOCK_NAME = '.polygram-hooks.lock';
const SHA256_RE = /^[a-f0-9]{64}$/;
const CURRENT_HASH_RE = /^sha256:[a-f0-9]{64}$/;

class CodexHookRuntimeError extends Error {
  constructor(message, code, action, options) {
    super(message, options);
    this.name = 'CodexHookRuntimeError';
    this.code = code;
    this.action = action;
  }
}

function fail(message, code, action, cause) {
  return new CodexHookRuntimeError(
    message,
    code,
    action,
    cause ? { cause } : undefined,
  );
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tomlKey(value) {
  return JSON.stringify(value);
}

function hookToken(event) {
  return event.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function normalizeHookOptions(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(
      'Codex hook deployment configuration must be an object.',
      'CODEX_HOOK_CONFIG_INVALID',
      'Configure the complete protected hook deployment or omit it.',
    );
  }
  const keys = [
    'artifactRoot',
    'enabled',
    'operatorUid',
    'runtimeId',
    'runtimeRoot',
    'runtimeSha256',
    'serviceUid',
    'version',
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) {
    throw fail(
      'Codex hook deployment configuration has an unsupported shape.',
      'CODEX_HOOK_CONFIG_INVALID',
      'Configure exactly the documented protected hook deployment fields.',
    );
  }
  for (const key of ['artifactRoot', 'runtimeRoot']) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) {
      throw fail(
        `Codex hook ${key} must be absolute.`,
        'CODEX_HOOK_CONFIG_INVALID',
        'Use canonical absolute protected-tree paths.',
      );
    }
  }
  for (const key of ['runtimeId', 'version']) {
    if (
      typeof value[key] !== 'string'
      || value[key].length === 0
      || value[key].length > 128
      || /[\u0000-\u001f\u007f/\\]/u.test(value[key])
    ) {
      throw fail(
        `Codex hook ${key} is invalid.`,
        'CODEX_HOOK_CONFIG_INVALID',
        'Use a bounded immutable runtime and artifact identity.',
      );
    }
  }
  if (
    typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.operatorUid)
    || value.operatorUid < 0
    || !Number.isSafeInteger(value.serviceUid)
    || value.serviceUid < 0
    || !SHA256_RE.test(value.runtimeSha256)
  ) {
    throw fail(
      'Codex hook deployment identity or runtime digest is invalid.',
      'CODEX_HOOK_CONFIG_INVALID',
      'Use the measured runtime receipt and numeric host account identities.',
    );
  }
  return Object.freeze({ ...value });
}

function renderHooksJson(commands) {
  return `${JSON.stringify({
    hooks: Object.fromEntries(HOOK_EVENTS.map(({ configName, event }) => [
      configName,
      [{ hooks: [{ type: 'command', command: commands[event].command }] }],
    ])),
  }, null, 2)}\n`;
}

function createHookMaterial({ codexHome, workspace, hookOptions }) {
  const options = normalizeHookOptions(hookOptions);
  if (options == null) return null;
  const receipt = attestHookArtifactVersion({
    artifactRoot: options.artifactRoot,
    version: options.version,
    runtimeRoot: options.runtimeRoot,
    runtimeId: options.runtimeId,
    runtimeSha256: options.runtimeSha256,
    operatorUid: options.operatorUid,
    serviceUid: options.serviceUid,
  });
  const bundle = receipt.artifacts.find((entry) => (
    entry.kind === 'protected-artifact'
    && path.basename(entry.path) === 'hook-observer.js'
  ));
  if (!bundle) {
    throw fail(
      'The protected hook receipt does not contain the observer bundle.',
      'CODEX_HOOK_ARTIFACT_MISMATCH',
      'Reinstall the exact Polygram hook artifact version.',
    );
  }
  const commands = {};
  for (const { configName, event } of HOOK_EVENTS) {
    commands[event] = renderHookCommand({
      runtime: { path: receipt.runtime.path, kind: 'protected-runtime' },
      artifacts: [{ path: bundle.path, kind: 'protected-artifact' }],
      argv: [
        { kind: 'literal', value: configName },
        { kind: 'literal', value: CAPTURE_DIRECTORY },
      ],
    }, receipt);
  }
  const hooksPath = path.join(codexHome, 'hooks.json');
  const entries = HOOK_EVENTS.map(({ event }, ordinal) => Object.freeze({
    ordinal,
    configKey: `${hooksPath}:${hookToken(event)}:0:0`,
    sourcePath: hooksPath,
    event,
    handlerType: 'command',
    source: 'user',
    isManaged: false,
    displayOrder: ordinal,
    timeoutSec: 600,
    commandSha256: commands[event].sha256,
  }));
  const hooksJson = renderHooksJson(commands);
  const hookManifest = Object.freeze({
    ownedCwd: workspace,
    entries: Object.freeze(entries),
  });
  return Object.freeze({
    hookManifest,
    hooksJson,
    hooksPath,
    options,
    receipt,
    hookArtifactsSha256: digest(JSON.stringify({
      closureSha256: receipt.closureSha256,
      hooksSha256: digest(hooksJson),
    })),
  });
}

function withTrustState(baseOwnedConfig, manifest, projected) {
  if (
    !Array.isArray(projected)
    || projected.length !== manifest.entries.length
    || projected.some((entry, index) => (
      entry?.ordinal !== index
      || entry.trustStatus !== 'untrusted'
      || entry.enabled !== true
      || !CURRENT_HASH_RE.test(entry.currentHash ?? '')
    ))
  ) {
    throw fail(
      'Codex hook discovery did not return the exact untrusted manifest.',
      'CODEX_HOOK_TRUST_UNVERIFIED',
      'Restore the exact hooks file and reprovision the owned Codex home.',
    );
  }
  return {
    ...baseOwnedConfig,
    hooks: {
      state: Object.fromEntries(manifest.entries.map((entry, index) => [
        entry.configKey,
        { enabled: true, trusted_hash: projected[index].currentHash },
      ])),
    },
  };
}

function renderTrustTables(ownedConfig) {
  const state = ownedConfig.hooks?.state;
  if (!state) return '';
  const lines = [];
  for (const key of Object.keys(state).sort()) {
    const entry = state[key];
    if (entry?.enabled !== true || !CURRENT_HASH_RE.test(entry.trusted_hash ?? '')) {
      throw fail(
        'Codex hook trust state is malformed.',
        'CODEX_HOOK_TRUST_UNVERIFIED',
        'Reprovision the exact owned Codex configuration.',
      );
    }
    lines.push(
      `[hooks.state.${tomlKey(key)}]`,
      'enabled = true',
      `trusted_hash = ${JSON.stringify(entry.trusted_hash)}`,
      '',
    );
  }
  return lines.join('\n');
}

function extractTrustedState(configText, baseConfigText, manifest) {
  if (!configText.startsWith(baseConfigText)) return null;
  const suffix = configText.slice(baseConfigText.length);
  const hashes = [];
  for (const entry of manifest.entries) {
    const prefix = [
      `[hooks.state.${tomlKey(entry.configKey)}]`,
      'enabled = true',
      'trusted_hash = "',
    ].join('\n');
    const start = suffix.indexOf(prefix);
    if (start < 0) return null;
    const valueStart = start + prefix.length;
    const value = suffix.slice(valueStart, valueStart + 71);
    if (!CURRENT_HASH_RE.test(value) || suffix[valueStart + 71] !== '"') {
      return null;
    }
    hashes.push(value);
  }
  const projected = hashes.map((currentHash, ordinal) => ({
    ordinal,
    currentHash,
    trustStatus: 'untrusted',
    enabled: true,
  }));
  return projected;
}

function writeAtomic(target, contents) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.polygram-${path.basename(target)}-${process.pid}-${randomUUID()}.tmp`,
  );
  let fd = null;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, target);
    const dirFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function removeAtomic(target) {
  if (!existsSync(target)) return;
  unlinkSync(target);
  const dirFd = openSync(path.dirname(target), constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function acquireHomeLock(codexHome) {
  const lockPath = path.join(codexHome, LOCK_NAME);
  const token = `${process.pid}:${randomUUID()}`;
  let fd;
  try {
    fd = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${token}\n`);
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    throw fail(
      'Codex hook provisioning is already locked.',
      'CODEX_HOOK_PROVISION_LOCKED',
      `Confirm no Polygram process is provisioning this home, then remove ${LOCK_NAME}.`,
      error,
    );
  }
  return () => {
    let observed;
    try {
      observed = readFileSync(lockPath, 'utf8');
    } catch (error) {
      throw fail(
        'Codex hook provisioning lock disappeared.',
        'CODEX_HOOK_PROVISION_LOCKED',
        'Keep Codex admission closed and inspect the owned home.',
        error,
      );
    }
    if (observed !== `${token}\n`) {
      throw fail(
        'Codex hook provisioning lock ownership changed.',
        'CODEX_HOOK_PROVISION_LOCKED',
        'Keep Codex admission closed and inspect the owned home.',
      );
    }
    removeAtomic(lockPath);
  };
}

function assertHooksFile(material) {
  let stat;
  try {
    stat = lstatSync(material.hooksPath);
  } catch (error) {
    throw fail(
      'Codex hooks.json is missing.',
      'CODEX_OWNED_HOOKS_DRIFT',
      'Reprovision the exact owned hook manifest.',
      error,
    );
  }
  const uid = process.getuid?.();
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o777) !== 0o600
    || readFileSync(material.hooksPath, 'utf8') !== material.hooksJson
  ) {
    throw fail(
      'Codex hooks.json differs from the owned manifest.',
      'CODEX_OWNED_HOOKS_DRIFT',
      'Reprovision the exact owner-only hook manifest.',
    );
  }
}

async function prepareHookRuntime({
  hookOptions,
  codexHome,
  workspace,
  baseOwnedConfig,
  baseRawConfig,
  renderOwnedConfig,
  verifyDiscovery,
}) {
  const options = normalizeHookOptions(hookOptions);
  const configPath = path.join(codexHome, 'config.toml');
  if (options == null) {
    return {
      ownedConfig: baseOwnedConfig,
      rawConfig: baseRawConfig,
      hookManifest: null,
      hookArtifactsSha256: null,
      hookMaterial: null,
    };
  }
  const material = createHookMaterial({ codexHome, workspace, hookOptions: options });
  const release = acquireHomeLock(codexHome);
  try {
    const configText = existsSync(configPath)
      ? readFileSync(configPath, 'utf8')
      : null;
    const hooksText = existsSync(material.hooksPath)
      ? readFileSync(material.hooksPath, 'utf8')
      : null;
    const extracted = configText == null
      ? null
      : extractTrustedState(configText, baseRawConfig, material.hookManifest);
    const trustedConfig = extracted == null
      ? null
      : withTrustState(baseOwnedConfig, material.hookManifest, extracted);
    const trustedRaw = trustedConfig == null
      ? null
      : renderOwnedConfig(trustedConfig);
    const state = configText == null && hooksText == null
      ? 'absent'
      : configText === baseRawConfig && hooksText == null
        ? 'hooks-off'
        : configText === baseRawConfig && hooksText === material.hooksJson
          ? 'discovery'
          : trustedRaw === configText && hooksText === material.hooksJson
            ? 'trusted'
            : 'drift';
    if (state === 'drift') {
      throw fail(
        'Codex hook files are outside the owned state machine.',
        'CODEX_OWNED_HOOKS_DRIFT',
        'Back up the owned home, remove config.toml and hooks.json, then reprovision.',
      );
    }
    if (!options.enabled) {
      if (state === 'trusted') writeAtomic(configPath, baseRawConfig);
      if (state === 'trusted' || state === 'discovery') {
        removeAtomic(material.hooksPath);
      }
      if (state === 'absent') writeAtomic(configPath, baseRawConfig);
      return {
        ownedConfig: baseOwnedConfig,
        rawConfig: baseRawConfig,
        hookManifest: null,
        hookArtifactsSha256: null,
        hookMaterial: null,
      };
    }

    if (state === 'absent') writeAtomic(configPath, baseRawConfig);
    if (state === 'absent' || state === 'hooks-off') {
      writeAtomic(material.hooksPath, material.hooksJson);
    }
    if (state !== 'trusted') {
      assertHooksFile(material);
      const projected = await verifyDiscovery(
        material.hookManifest,
        digest(baseRawConfig),
      );
      const nextOwnedConfig = withTrustState(
        baseOwnedConfig,
        material.hookManifest,
        projected,
      );
      const nextRawConfig = renderOwnedConfig(nextOwnedConfig);
      writeAtomic(configPath, nextRawConfig);
      assertHooksFile(material);
      return {
        ownedConfig: nextOwnedConfig,
        rawConfig: nextRawConfig,
        hookManifest: material.hookManifest,
        hookArtifactsSha256: material.hookArtifactsSha256,
        hookMaterial: material,
      };
    }
    assertHooksFile(material);
    return {
      ownedConfig: trustedConfig,
      rawConfig: trustedRaw,
      hookManifest: material.hookManifest,
      hookArtifactsSha256: material.hookArtifactsSha256,
      hookMaterial: material,
    };
  } finally {
    release();
  }
}

function reattestHookRuntime({ hookOptions, codexHome, workspace, expected }) {
  const material = createHookMaterial({ codexHome, workspace, hookOptions });
  assertHooksFile(material);
  if (
    material.hookArtifactsSha256 !== expected.hookArtifactsSha256
    || JSON.stringify(material.hookManifest) !== JSON.stringify(expected.hookManifest)
  ) {
    throw fail(
      'Codex hook material changed after preflight.',
      'CODEX_OWNED_HOOKS_DRIFT',
      'Close admission and reprovision the exact hook deployment.',
    );
  }
  return material;
}

module.exports = {
  CAPTURE_DIRECTORY,
  CodexHookRuntimeError,
  HOOK_EVENTS,
  createHookMaterial,
  normalizeHookOptions,
  prepareHookRuntime,
  reattestHookRuntime,
  renderHooksJson,
  renderTrustTables,
  withTrustState,
};

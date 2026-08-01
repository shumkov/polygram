import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LLAMA_RUNTIME, LLAMA_SERVER_COMMAND } from '../adapters/llama.mjs';

export class LocalRuntimeAttestationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalRuntimeAttestationError';
    this.code = code;
  }
}

function fail(code) {
  throw new LocalRuntimeAttestationError(code);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256Json(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function sha256String(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function exactArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function sortedStrings(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return [...value].sort();
}

function dockerNoNewPrivileges(securityOptions) {
  return Array.isArray(securityOptions) && securityOptions.some((option) => (
    option === 'no-new-privileges' || option === 'no-new-privileges:true'
  ));
}

function dockerBuiltinSeccomp(securityOptions) {
  return Array.isArray(securityOptions) && securityOptions.some((option) => (
    option === 'seccomp=builtin' || option === 'seccomp=default'
  ));
}

export function attestServerCommand(command) {
  if (!exactArray(command, LLAMA_SERVER_COMMAND)) {
    fail('LOCAL_RUNTIME_SERVER_COMMAND_DRIFT');
  }
  return Object.freeze({ passed: true, commandHash: sha256Json(command) });
}

export function attestEntrypointEnvironment({ imageInspect, containerInspect }) {
  const imageEntrypoint = imageInspect?.Config?.Entrypoint;
  const imageEnvironment = sortedStrings(imageInspect?.Config?.Env);
  const config = containerInspect?.Config;
  if (!Array.isArray(imageEntrypoint)
      || imageEntrypoint.length !== 1
      || typeof imageEntrypoint[0] !== 'string'
      || !path.posix.isAbsolute(imageEntrypoint[0])
      || containerInspect?.Path !== imageEntrypoint[0]
      || !exactArray(config?.Entrypoint, imageEntrypoint)
      || !exactArray(containerInspect?.Args, LLAMA_SERVER_COMMAND)
      || !exactArray(config?.Cmd, LLAMA_SERVER_COMMAND)) {
    fail('LOCAL_RUNTIME_CONTAINER_ENTRYPOINT_INVALID');
  }
  if (imageEnvironment === null
      || !exactArray(sortedStrings(config?.Env), imageEnvironment)) {
    fail('LOCAL_RUNTIME_CONTAINER_ENVIRONMENT_INVALID');
  }
  return Object.freeze({
    passed: true,
    entrypointHash: sha256Json(imageEntrypoint),
    environmentHash: sha256Json(imageEnvironment),
  });
}

function attestTmpfs(host, runtime) {
  const tmpfs = host?.Tmpfs;
  if (!tmpfs || Object.keys(tmpfs).length !== 1
      || typeof tmpfs[runtime.tmpfs.destination] !== 'string') {
    fail('LOCAL_RUNTIME_CONTAINER_TMPFS_INVALID');
  }
  const options = new Set(tmpfs[runtime.tmpfs.destination].split(',').filter(Boolean));
  for (const option of runtime.tmpfs.options) {
    if (!options.has(option)) fail('LOCAL_RUNTIME_CONTAINER_TMPFS_INVALID');
  }
  if (!options.has(`size=${runtime.tmpfs.sizeBytes}`) && !options.has('size=64m')) {
    fail('LOCAL_RUNTIME_CONTAINER_TMPFS_INVALID');
  }
}

function attestCoreUlimit(host) {
  if (!Array.isArray(host?.Ulimits)
      || !host.Ulimits.some((limit) => (
        limit?.Name === 'core' && limit.Soft === 0 && limit.Hard === 0
      ))) {
    fail('LOCAL_RUNTIME_CONTAINER_ULIMIT_INVALID');
  }
}

function normalizeMount(mount) {
  return {
    type: mount?.Type,
    sourceHash: sha256String(mount?.Source),
    destination: mount?.Destination,
    readWrite: mount?.RW,
    propagation: mount?.Propagation || '',
  };
}

export function attestMountInventory(mounts, runtime = LLAMA_RUNTIME) {
  if (!Array.isArray(mounts)) fail('LOCAL_RUNTIME_CONTAINER_MOUNT_INVENTORY_INVALID');
  for (const mount of mounts) {
    const approvedTmpfs = mount?.Type === 'tmpfs'
      && mount.Destination === runtime.tmpfs.destination
      && mount.RW === true;
    if (mount?.Type !== 'bind' && !approvedTmpfs) {
      fail('LOCAL_RUNTIME_CONTAINER_EXTRA_MOUNT');
    }
  }
  const tmpfs = mounts.filter((mount) => mount?.Type === 'tmpfs');
  if (tmpfs.length > 1) fail('LOCAL_RUNTIME_CONTAINER_EXTRA_MOUNT');

  const binds = mounts.filter((mount) => mount?.Type === 'bind');
  const modelDestination = `/models/${runtime.modelFile}`;
  const socketDestination = path.posix.dirname(runtime.socketPath);
  if (binds.length !== 2
      || !binds.some((mount) => mount.Destination === modelDestination && mount.RW === false)
      || !binds.some((mount) => mount.Destination === socketDestination && mount.RW === true)) {
    fail('LOCAL_RUNTIME_CONTAINER_MOUNT_INVENTORY_INVALID');
  }
  return Object.freeze({
    passed: true,
    bindMounts: binds.map(normalizeMount)
      .sort((left, right) => left.destination.localeCompare(right.destination)),
    tmpfsPresent: tmpfs.length === 1,
  });
}

function normalizeExpectedMount(mount) {
  if (!mount || typeof mount.source !== 'string' || !path.isAbsolute(mount.source)) {
    fail('LOCAL_RUNTIME_EXPECTED_MOUNT_INVALID');
  }
  if (typeof mount.destination !== 'string' || !path.posix.isAbsolute(mount.destination)) {
    fail('LOCAL_RUNTIME_EXPECTED_MOUNT_INVALID');
  }
  return {
    type: mount.type || 'bind',
    sourceHash: sha256String(mount.source),
    destination: mount.destination,
    readWrite: mount.readWrite,
    propagation: mount.propagation || 'rprivate',
  };
}

function normalizeExpectedContainer(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    fail('LOCAL_RUNTIME_EXPECTED_CONTAINER_INVALID');
  }
  if (!Array.isArray(expected.command) || expected.command.length === 0
      || expected.command.some((item) => typeof item !== 'string')) {
    fail('LOCAL_RUNTIME_EXPECTED_COMMAND_INVALID');
  }
  attestServerCommand(expected.command);
  if (!Array.isArray(expected.environment)
      || expected.environment.some((item) => typeof item !== 'string')) {
    fail('LOCAL_RUNTIME_EXPECTED_ENVIRONMENT_INVALID');
  }
  if (typeof expected.user !== 'string' || expected.user.length === 0
      || ['0', 'root', '0:0', 'root:root'].includes(expected.user)) {
    fail('LOCAL_RUNTIME_EXPECTED_USER_INVALID');
  }
  if (!Array.isArray(expected.mounts) || expected.mounts.length !== 2) {
    fail('LOCAL_RUNTIME_EXPECTED_MOUNTS_INVALID');
  }

  const mounts = expected.mounts.map(normalizeExpectedMount)
    .sort((left, right) => left.destination.localeCompare(right.destination));
  if (mounts.filter((mount) => mount.readWrite === false).length !== 1
      || mounts.filter((mount) => mount.readWrite === true).length !== 1) {
    fail('LOCAL_RUNTIME_EXPECTED_MOUNTS_INVALID');
  }

  return {
    command: [...expected.command],
    environment: [...expected.environment].sort(),
    user: expected.user,
    workingDirectory: expected.workingDirectory || '',
    mounts,
  };
}

export async function inspectModelFile(modelPath, {
  stat = fs.promises.stat,
  createReadStream = fs.createReadStream,
} = {}) {
  if (typeof modelPath !== 'string' || !path.isAbsolute(modelPath)) {
    fail('LOCAL_RUNTIME_MODEL_PATH_INVALID');
  }

  const modelStat = await stat(modelPath);
  if (!modelStat.isFile()) fail('LOCAL_RUNTIME_MODEL_NOT_FILE');

  const digest = crypto.createHash('sha256');
  const stream = createReadStream(modelPath);
  for await (const chunk of stream) digest.update(chunk);
  return {
    bytes: modelStat.size,
    sha256: digest.digest('hex'),
  };
}

export function attestModelArtifact(observed, runtime = LLAMA_RUNTIME) {
  if (!observed || typeof observed !== 'object') fail('LOCAL_RUNTIME_MODEL_ATTESTATION_MISSING');
  if (observed.bytes !== runtime.modelBytes) fail('LOCAL_RUNTIME_MODEL_SIZE_MISMATCH');
  if (observed.sha256 !== runtime.modelSha256) fail('LOCAL_RUNTIME_MODEL_SHA256_MISMATCH');
  return Object.freeze({
    bytes: observed.bytes,
    sha256: observed.sha256,
    passed: true,
  });
}

export function attestDockerRuntime({
  imageInspect,
  containerInspect,
  expectedContainer,
  runtime = LLAMA_RUNTIME,
}) {
  if (!imageInspect || typeof imageInspect !== 'object') fail('LOCAL_RUNTIME_IMAGE_INSPECT_MISSING');
  if (!containerInspect || typeof containerInspect !== 'object') {
    fail('LOCAL_RUNTIME_CONTAINER_INSPECT_MISSING');
  }

  const repoDigests = sortedStrings(imageInspect.RepoDigests);
  if (!repoDigests?.includes(runtime.imageReference)) fail('LOCAL_RUNTIME_IMAGE_DIGEST_MISMATCH');
  if (imageInspect.Os !== 'linux' || imageInspect.Architecture !== 'amd64') {
    fail('LOCAL_RUNTIME_IMAGE_PLATFORM_MISMATCH');
  }
  if (typeof imageInspect.Id !== 'string' || containerInspect.Image !== imageInspect.Id) {
    fail('LOCAL_RUNTIME_CONTAINER_IMAGE_ID_MISMATCH');
  }

  const config = containerInspect.Config;
  const host = containerInspect.HostConfig;
  if (!config || !host) fail('LOCAL_RUNTIME_CONTAINER_CONFIG_MISSING');
  const entrypointEnvironment = attestEntrypointEnvironment({ imageInspect, containerInspect });
  const mountInventory = attestMountInventory(containerInspect.Mounts, runtime);
  if (config.Image !== runtime.imageReference) fail('LOCAL_RUNTIME_CONTAINER_IMAGE_REFERENCE_MISMATCH');
  if (containerInspect.State?.Running !== true || containerInspect.State?.OOMKilled === true) {
    fail('LOCAL_RUNTIME_CONTAINER_STATE_INVALID');
  }
  if (host.NetworkMode !== 'none') fail('LOCAL_RUNTIME_CONTAINER_NETWORK_INVALID');
  if (host.ReadonlyRootfs !== true) fail('LOCAL_RUNTIME_CONTAINER_ROOTFS_WRITABLE');
  if (host.Privileged !== false) fail('LOCAL_RUNTIME_CONTAINER_PRIVILEGED');
  if (!exactArray(sortedStrings(host.CapDrop), ['ALL'])) fail('LOCAL_RUNTIME_CONTAINER_CAPABILITIES_INVALID');
  if (!exactArray(sortedStrings(host.CapAdd) || [], [])) fail('LOCAL_RUNTIME_CONTAINER_CAPABILITIES_INVALID');
  if (!dockerNoNewPrivileges(host.SecurityOpt)) fail('LOCAL_RUNTIME_CONTAINER_SECURITY_OPT_INVALID');
  if (!dockerBuiltinSeccomp(host.SecurityOpt)) fail('LOCAL_RUNTIME_CONTAINER_SECURITY_OPT_INVALID');
  if (host.Memory !== runtime.memoryLimitBytes) fail('LOCAL_RUNTIME_CONTAINER_MEMORY_LIMIT_INVALID');
  if (host.MemorySwap !== runtime.memoryLimitBytes || host.MemorySwappiness !== 0) {
    fail('LOCAL_RUNTIME_CONTAINER_SWAP_INVALID');
  }
  if (host.RestartPolicy?.Name !== 'no') fail('LOCAL_RUNTIME_CONTAINER_RESTART_POLICY_INVALID');
  if (host.AutoRemove !== true) fail('LOCAL_RUNTIME_CONTAINER_AUTOREMOVE_INVALID');
  if (host.PidsLimit !== runtime.pidsLimit) fail('LOCAL_RUNTIME_CONTAINER_PIDS_LIMIT_INVALID');
  if (host.NanoCpus !== runtime.nanoCpus) fail('LOCAL_RUNTIME_CONTAINER_CPU_LIMIT_INVALID');
  attestTmpfs(host, runtime);
  attestCoreUlimit(host);
  if ((host.PortBindings && Object.keys(host.PortBindings).length > 0)
      || (containerInspect.NetworkSettings?.Ports
        && Object.values(containerInspect.NetworkSettings.Ports).some(Boolean))) {
    fail('LOCAL_RUNTIME_CONTAINER_PORT_BINDING_INVALID');
  }
  if ((host.Devices?.length || 0) !== 0 || (host.DeviceRequests?.length || 0) !== 0) {
    fail('LOCAL_RUNTIME_CONTAINER_DEVICE_ACCESS_INVALID');
  }

  const expected = normalizeExpectedContainer(expectedContainer);
  const observed = {
    command: Array.isArray(config.Cmd) ? [...config.Cmd] : null,
    environment: sortedStrings(config.Env),
    user: config.User,
    workingDirectory: config.WorkingDir || '',
    mounts: mountInventory.bindMounts,
  };
  if (stableJson(observed) !== stableJson(expected)) fail('LOCAL_RUNTIME_CONTAINER_CONFIG_DRIFT');

  const readOnlyMount = expected.mounts.find((mount) => mount.readWrite === false);
  const socketMount = expected.mounts.find((mount) => mount.readWrite === true);
  const expectedModelDestination = `/models/${runtime.modelFile}`;
  if (readOnlyMount?.destination !== expectedModelDestination
      || socketMount?.destination !== path.posix.dirname(runtime.socketPath)) {
    fail('LOCAL_RUNTIME_CONTAINER_MOUNT_POLICY_INVALID');
  }
  if (!expected.command.includes(runtime.socketPath)) {
    fail('LOCAL_RUNTIME_CONTAINER_SOCKET_ARGUMENT_MISSING');
  }

  const normalizedConfig = {
    imageReference: runtime.imageReference,
    imageId: imageInspect.Id,
    platform: runtime.platform,
    network: runtime.network,
    readOnlyRoot: runtime.readOnlyRoot,
    memoryLimitBytes: runtime.memoryLimitBytes,
    swapBytes: runtime.swapBytes,
    nanoCpus: runtime.nanoCpus,
    pidsLimit: runtime.pidsLimit,
    tmpfs: runtime.tmpfs,
    entrypointHash: entrypointEnvironment.entrypointHash,
    environmentHash: entrypointEnvironment.environmentHash,
    ...expected,
  };
  return Object.freeze({
    imageDigest: runtime.imageDigest,
    imageId: imageInspect.Id,
    entrypointHash: entrypointEnvironment.entrypointHash,
    environmentHash: entrypointEnvironment.environmentHash,
    configHash: sha256Json(normalizedConfig),
    passed: true,
  });
}

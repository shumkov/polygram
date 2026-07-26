import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  execFile,
  execFileSync,
  spawn as spawnChild,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const WRAPPER_MIN_VERSION = [2, 1, 208];
const DEFAULT_WRAPPER_PATH = fileURLToPath(
  new URL('./claude-process-wrapper.mjs', import.meta.url),
);

function parseVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new TypeError(`expectedVersion must be an exact version, got ${JSON.stringify(version)}`);
  }
  return version.split('.').map(Number);
}

function versionAtLeast(version, minimum) {
  const parts = parseVersion(version);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

function assertExecutable(executablePath, label) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new TypeError(`${label} must be an absolute executable path`);
  }
  const stat = fs.statSync(executablePath);
  if (!stat.isFile()) throw new TypeError(`${label} must be a regular file`);
  fs.accessSync(executablePath, fs.constants.X_OK);
}

export function hashSensitiveString(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function reportedClaudeVersion(executablePath) {
  const { stdout } = await execFileAsync(executablePath, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  const match = String(stdout).trim().match(/^(\d+\.\d+\.\d+)\s+\(Claude Code\)$/);
  if (!match) {
    throw new Error(`selected executable returned an unrecognized --version response`);
  }
  return match[1];
}

export function ensurePrivateArtifactBase(artifactBaseDir) {
  if (typeof artifactBaseDir !== 'string' || !path.isAbsolute(artifactBaseDir)) {
    throw new TypeError('artifactBaseDir must be an absolute path');
  }
  if (!fs.existsSync(artifactBaseDir)) {
    fs.mkdirSync(artifactBaseDir, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(artifactBaseDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError('artifactBaseDir must be a real directory');
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error('artifactBaseDir must already have mode 0700');
  }
  return fs.realpathSync(artifactBaseDir);
}

function createPrivateArtifactDir(artifactBaseDir, runId) {
  const privateBaseDir = ensurePrivateArtifactBase(artifactBaseDir);
  const artifactDir = path.join(privateBaseDir, runId);
  fs.mkdirSync(artifactDir, { mode: 0o700 });
  return fs.realpathSync(artifactDir);
}

export function registerGateSessionProject(selection, cwd) {
  if (!selection?.artifactDir || !path.isAbsolute(selection.artifactDir)) {
    throw new TypeError('selection must contain an absolute artifactDir');
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new TypeError('session project cwd must be absolute');
  }
  const realArtifactDir = fs.realpathSync(selection.artifactDir);
  const realCwd = fs.realpathSync(cwd);
  if (!realCwd.startsWith(`${realArtifactDir}${path.sep}`)) {
    throw new Error('session project cwd must stay inside the gate artifact directory');
  }

  const manifestPath = path.join(realArtifactDir, 'session-projects.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { schemaVersion: 1, cwds: [] };
  if (
    manifest.schemaVersion !== 1
    || !Array.isArray(manifest.cwds)
    || manifest.cwds.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('session project manifest is malformed');
  }
  if (!manifest.cwds.includes(realCwd)) manifest.cwds.push(realCwd);
  manifest.cwds.sort();

  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, manifestPath);
  fs.chmodSync(manifestPath, 0o600);
  return manifestPath;
}

function processSnapshot() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    }] : [];
  });
}

function descendantPids(snapshot, rootPid) {
  const children = new Map();
  for (const processInfo of snapshot) {
    if (!children.has(processInfo.ppid)) children.set(processInfo.ppid, []);
    children.get(processInfo.ppid).push(processInfo.pid);
  }
  const found = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    for (const pid of children.get(pending.pop()) || []) {
      if (found.has(pid)) continue;
      found.add(pid);
      pending.push(pid);
    }
  }
  return found;
}

function createSdkProcessEvidence(
  executablePath,
  { processSnapshotFn = processSnapshot } = {},
) {
  const realExecutable = fs.realpathSync(executablePath);
  const rootPids = new Set();
  const activeRoots = new Set();
  const selectedBinaryPids = new Set();
  let sampleCount = 0;
  let samplingFailureCount = 0;
  let samplingErrorHash = null;
  let timer = null;

  function isSelectedBinary(command) {
    if (!path.isAbsolute(command)) return false;
    try {
      return fs.realpathSync(command) === realExecutable;
    } catch {
      return false;
    }
  }

  function sample() {
    if (activeRoots.size === 0) return;
    const snapshot = processSnapshotFn();
    sampleCount += 1;
    for (const rootPid of activeRoots) {
      const descendants = descendantPids(snapshot, rootPid);
      for (const processInfo of snapshot) {
        if (descendants.has(processInfo.pid) && isSelectedBinary(processInfo.command)) {
          selectedBinaryPids.add(processInfo.pid);
        }
      }
    }
  }

  function refreshPublicEvidence(publicEvidence) {
    publicEvidence.rootPids = [...rootPids].sort((left, right) => left - right);
    publicEvidence.selectedBinaryPids = [...selectedBinaryPids]
      .sort((left, right) => left - right);
    publicEvidence.sampleCount = sampleCount;
    publicEvidence.samplingFailed = samplingFailureCount > 0;
    publicEvidence.samplingFailureCount = samplingFailureCount;
    publicEvidence.samplingErrorHash = samplingErrorHash;
  }

  function recordSamplingFailure(error) {
    samplingFailureCount += 1;
    if (!samplingErrorHash) {
      samplingErrorHash = hashSensitiveString(
        error?.stack || error?.message || String(error),
      );
    }
  }

  const publicEvidence = {
    rootPids: [],
    selectedBinaryPids: [],
    sampleCount: 0,
    samplingFailed: false,
    samplingFailureCount: 0,
    samplingErrorHash: null,
  };

  function stopTimerIfIdle() {
    if (activeRoots.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function spawnClaudeCodeProcess(options) {
    if (fs.realpathSync(options.command) !== realExecutable) {
      throw new Error('SDK attempted to spawn a different Claude executable');
    }
    const child = spawnChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (Number.isInteger(child.pid)) {
      rootPids.add(child.pid);
      activeRoots.add(child.pid);
      selectedBinaryPids.add(child.pid);
      refreshPublicEvidence(publicEvidence);
      try {
        sample();
      } catch (error) {
        recordSamplingFailure(error);
      }
      refreshPublicEvidence(publicEvidence);
      if (!timer) {
        timer = setInterval(() => {
          try {
            sample();
          } catch (error) {
            recordSamplingFailure(error);
          }
          refreshPublicEvidence(publicEvidence);
        }, 250);
        timer.unref?.();
      }
      child.once('exit', () => {
        try {
          sample();
        } catch (error) {
          recordSamplingFailure(error);
        }
        activeRoots.delete(child.pid);
        refreshPublicEvidence(publicEvidence);
        stopTimerIfIdle();
      });
    }
    return child;
  }

  return {
    publicEvidence,
    spawnClaudeCodeProcess,
    stop() {
      try {
        sample();
      } catch (error) {
        recordSamplingFailure(error);
      }
      activeRoots.clear();
      stopTimerIfIdle();
      refreshPublicEvidence(publicEvidence);
      return publicEvidence;
    },
  };
}

export async function createClaudeGateSelection({
  executablePath = process.env.CLAUDE_GATE_BIN || '',
  expectedVersion = process.env.CLAUDE_GATE_EXPECTED_VERSION || '',
  artifactBaseDir = process.env.CLAUDE_GATE_ARTIFACT_BASE
    || path.join(os.tmpdir(), 'polygram-claude-gates'),
  runId = process.env.CLAUDE_GATE_RUN_ID || crypto.randomUUID(),
  processEnv = process.env,
  processWrapperPath = DEFAULT_WRAPPER_PATH,
  processSnapshotFn = processSnapshot,
  model = processEnv.CLAUDE_GATE_MODEL || 'claude-sonnet-4-6',
  effort = processEnv.CLAUDE_GATE_EFFORT || 'medium',
} = {}) {
  parseVersion(expectedVersion);
  if (!RUN_ID_RE.test(runId) || /^\.+$/.test(runId)) {
    throw new TypeError(`runId must contain only letters, numbers, dot, underscore, or hyphen`);
  }
  assertExecutable(executablePath, 'Claude gate selector');

  const version = await reportedClaudeVersion(executablePath);
  if (version !== expectedVersion) {
    throw new Error(`expected Claude Code ${expectedVersion}, but selected executable reported ${version}`);
  }

  const wrapperRequired = versionAtLeast(version, WRAPPER_MIN_VERSION);
  if (wrapperRequired) assertExecutable(processWrapperPath, 'Claude process wrapper');

  const sha256 = await sha256File(executablePath);
  const artifactDir = createPrivateArtifactDir(artifactBaseDir, runId);
  const sdkCwdPath = path.join(artifactDir, 'sdk-workspace');
  fs.mkdirSync(sdkCwdPath, { mode: 0o700 });
  const sdkCwd = fs.realpathSync(sdkCwdPath);
  const sessionProjectsPath = registerGateSessionProject(
    { artifactDir },
    sdkCwd,
  );
  const sdkProcessTracker = createSdkProcessEvidence(executablePath, {
    processSnapshotFn,
  });
  const executablePathHash = hashSensitiveString(fs.realpathSync(executablePath));
  const selectorEnv = {
    CLAUDE_GATE_BIN: executablePath,
    CLAUDE_GATE_EXPECTED_VERSION: expectedVersion,
    CLAUDE_GATE_RUN_ID: runId,
    CLAUDE_GATE_ARTIFACT_DIR: artifactDir,
    CLAUDE_GATE_MODEL: model,
    CLAUDE_GATE_EFFORT: effort,
    ORCHESTRA_CLAUDE_BIN: executablePath,
    POLYGRAM_CLAUDE_BIN: executablePath,
  };
  const wrapperEnv = wrapperRequired
    ? {
        CLAUDE_CODE_PROCESS_WRAPPER: processWrapperPath,
        CLAUDE_CODE_GATE_RUN_ID: runId,
        CLAUDE_CODE_GATE_ARTIFACT_DIR: artifactDir,
      }
    : {};

  const privateMetadataPath = path.join(artifactDir, 'run-metadata.json');
  fs.writeFileSync(privateMetadataPath, `${JSON.stringify({
    runId,
    version,
    sha256,
    executablePath: fs.realpathSync(executablePath),
    executablePathHash,
    wrapperRequired,
    model,
    effort,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

  return {
    executablePath,
    version,
    sha256,
    runId,
    model,
    effort,
    artifactDir,
    privateMetadataPath,
    sessionProjectsPath,
    cliEnv: { ...selectorEnv, ...wrapperEnv },
    sessionLauncher: wrapperRequired ? processWrapperPath : null,
    sdkOptions: {
      pathToClaudeCodeExecutable: executablePath,
      cwd: sdkCwd,
      spawnClaudeCodeProcess: sdkProcessTracker.spawnClaudeCodeProcess,
      env: { ...processEnv, ...selectorEnv, ...wrapperEnv },
    },
    sdkCwd,
    sdkProcessEvidence: sdkProcessTracker.publicEvidence,
    stopSdkProcessSampling: sdkProcessTracker.stop,
    sanitizedAttestation: {
      runId,
      version,
      sha256,
      executablePathHash,
      wrapperRequired,
      model,
      effort,
    },
  };
}

export function buildClaudeGateSdkOptions(selection, overrides = {}) {
  if (!selection?.sdkOptions?.pathToClaudeCodeExecutable || !selection?.sdkOptions?.env) {
    throw new TypeError('selection must come from createClaudeGateSelection');
  }
  const { env: overrideEnv = {}, ...rest } = overrides;
  return {
    ...selection.sdkOptions,
    model: selection.model,
    effort: selection.effort,
    ...rest,
    env: {
      ...selection.sdkOptions.env,
      ...overrideEnv,
    },
  };
}

export function withClaudeGateTmuxEnv(tmuxRunner, selection) {
  if (typeof tmuxRunner?.spawn !== 'function') {
    throw new TypeError('tmuxRunner.spawn must be a function');
  }
  if (!selection?.cliEnv) {
    throw new TypeError('selection must come from createClaudeGateSelection');
  }
  return {
    ...tmuxRunner,
    spawn(options = {}) {
      return tmuxRunner.spawn({
        ...options,
        envExtras: {
          ...selection.cliEnv,
          ...(options.envExtras || {}),
        },
      });
    },
  };
}

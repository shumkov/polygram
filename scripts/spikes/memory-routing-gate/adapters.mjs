import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ROUTER_SCHEMA, ROUTER_SYSTEM_PROMPT } from './contract.mjs';

const execFileAsync = promisify(execFile);
const SAFE_ENV_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP', 'LANG',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

export function subscriptionOnlyEnv(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => (
    SAFE_ENV_KEYS.has(key) || key.startsWith('LC_')
  )));
}

function assertAbsolute(binary) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary)) throw new TypeError('router binary must be absolute');
}

export function buildClaudeInvocation({ binary, model, schema }) {
  assertAbsolute(binary);
  return {
    binary,
    argv: [
      '--print', '--safe-mode', '--model', model, '--effort', 'low', '--tools', '',
      '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--json-schema', JSON.stringify(schema), '--system-prompt', ROUTER_SYSTEM_PROMPT,
    ],
  };
}

function processError(code, diagnostics = {}) {
  const error = new Error(code);
  error.code = code;
  error.diagnostics = {
    exitCode: Number.isInteger(diagnostics.exitCode) ? diagnostics.exitCode : null,
    signal: typeof diagnostics.signal === 'string' ? diagnostics.signal : null,
    stderrBytes: Number.isInteger(diagnostics.stderrBytes) ? diagnostics.stderrBytes : 0,
    cleanupConfirmed: diagnostics.cleanupConfirmed === true,
  };
  return error;
}

function killProcessGroup(child) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
    }
  }
  try { child.kill('SIGKILL'); } catch { /* close/error decides the outcome */ }
}

export function runProcess({ binary, argv, cwd, input, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failureCode = null;
    let settled = false;
    let killDeadline = null;

    const diagnostics = (exitCode = null, signal = null, cleanupConfirmed = false) => ({
      exitCode,
      signal,
      stderrBytes,
      cleanupConfirmed,
    });
    const finishError = (code, details) => {
      if (settled) return;
      settled = true;
      clearTimeout(turnDeadline);
      if (killDeadline) clearTimeout(killDeadline);
      reject(processError(code, details));
    };
    const terminate = (code) => {
      if (settled || failureCode) return;
      failureCode = code;
      killProcessGroup(child);
      killDeadline = setTimeout(() => {
        finishError(code, diagnostics(null, null, false));
      }, 5_000);
    };
    const turnDeadline = setTimeout(() => terminate('ROUTER_TIMEOUT'), timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 1_000_000) {
        terminate('ROUTER_OUTPUT_TOO_LARGE');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 256_000) terminate('ROUTER_STDERR_TOO_LARGE');
    });
    child.on('error', () => {
      if (!child.pid) {
        failureCode = failureCode || 'ROUTER_PROCESS_EXIT';
        finishError(failureCode, diagnostics(null, null, true));
      } else {
        terminate('ROUTER_PROCESS_EXIT');
      }
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      clearTimeout(turnDeadline);
      if (killDeadline) clearTimeout(killDeadline);
      if (failureCode || code !== 0 || signal) {
        finishError(failureCode || 'ROUTER_PROCESS_EXIT', diagnostics(code, signal, true));
        return;
      }
      settled = true;
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.on('error', () => terminate('ROUTER_PROCESS_EXIT'));
    child.stdin.end(input);
  });
}

export function parseClaudeAuthStatus(stdout) {
  let status;
  try { status = JSON.parse(stdout); } catch { throw new Error('ROUTER_AUTH_AMBIGUOUS'); }
  if (status?.loggedIn !== true || status?.apiProvider !== 'firstParty'
      || status?.authMethod !== 'claude.ai') {
    throw new Error('ROUTER_AUTH_AMBIGUOUS');
  }
  return {
    loggedIn: true,
    authMethod: status.authMethod,
    apiProvider: 'firstParty',
  };
}

export function parseCodexLoginStatus(stdout, stderr = '') {
  const statuses = [stdout, stderr].map((value) => value.trim()).filter(Boolean);
  if (statuses.length !== 1 || statuses[0] !== 'Logged in using ChatGPT') {
    throw new Error('ROUTER_AUTH_AMBIGUOUS');
  }
  return { loggedIn: true, authMethod: 'chatgpt' };
}

async function authCommand(binary, argv, parser) {
  assertAbsolute(binary);
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(binary, argv, {
      env: subscriptionOnlyEnv(),
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16_384,
    }));
  } catch {
    throw Object.assign(new Error('ROUTER_AUTH_UNAVAILABLE'), { code: 'ROUTER_AUTH_UNAVAILABLE' });
  }
  return parser(stdout, stderr);
}

export function inspectClaudeAuth(binary) {
  return authCommand(binary, ['auth', 'status', '--json'], parseClaudeAuthStatus);
}

export function inspectCodexAuth(binary) {
  return authCommand(binary, ['login', 'status'], parseCodexLoginStatus);
}

export function parseClaudeResult(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch {
    throw Object.assign(new Error('ROUTER_OUTPUT_MALFORMED'), { code: 'ROUTER_OUTPUT_MALFORMED' });
  }
  if (envelope?.is_error === true || envelope?.terminal_reason === 'api_error') {
    throw Object.assign(new Error('ROUTER_AUTH_UNAVAILABLE'), { code: 'ROUTER_AUTH_UNAVAILABLE' });
  }
  let raw;
  if (envelope && typeof envelope.structured_output === 'object' && envelope.structured_output) {
    raw = JSON.stringify(envelope.structured_output);
  } else if (typeof envelope?.result === 'string') {
    raw = envelope.result;
  } else {
    throw Object.assign(new Error('ROUTER_OUTPUT_MISSING'), { code: 'ROUTER_OUTPUT_MISSING' });
  }
  const observedModels = envelope?.modelUsage && typeof envelope.modelUsage === 'object'
    ? Object.keys(envelope.modelUsage).sort()
    : [];
  return { raw, observedModels };
}

function inputFor(request) {
  return `${ROUTER_SYSTEM_PROMPT}\n\nINPUT_JSON=${JSON.stringify(request)}\n`;
}

export function createClaudeAdapter({
  binary,
  model = 'haiku',
  expectedObservedModel,
  timeoutMs = 60_000,
  tempRoot = os.tmpdir(),
} = {}) {
  assertAbsolute(binary);
  return {
    id: `claude:${model}`,
    requireModelEvidence: true,
    expectedObservedModel,
    async route({ request }) {
      const cwd = await mkdtemp(path.join(tempRoot, 'polygram-u24-claude-'));
      try {
        const invocation = buildClaudeInvocation({ binary, model, schema: ROUTER_SCHEMA });
        const stdout = await runProcess({
          ...invocation, cwd, input: inputFor(request), timeoutMs, env: subscriptionOnlyEnv(),
        });
        return { ...parseClaudeResult(stdout), toolCalls: 0 };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ROUTER_SCHEMA, ROUTER_SYSTEM_PROMPT } from './contract.mjs';

const execFileAsync = promisify(execFile);
const MAX_ATTEMPT_OFFSET_MS = 180_000;
const MAX_CLAUDE_DURATION_MS = 120_000;
const MAX_STDOUT_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 256_000;
const OVER_LIMIT = 'over_limit';
const CLAUDE_ENVELOPE_FAILURE = Object.freeze({
  JSON_FRAMING: 'json-framing',
  OUTPUT_MISSING: 'output-missing',
  DURATION_METRICS_INVALID: 'duration-metrics-invalid',
  TURN_COUNT_INVALID: 'turn-count-invalid',
  DURATION_AND_TURN_COUNT_INVALID: 'duration-and-turn-count-invalid',
});
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

function processError(code, diagnostics = {}, attemptEvidence, stdout) {
  const error = new Error(code);
  error.code = code;
  error.diagnostics = {
    exitCode: Number.isInteger(diagnostics.exitCode) ? diagnostics.exitCode : null,
    signal: typeof diagnostics.signal === 'string' ? diagnostics.signal : null,
    stderrBytes: diagnostics.stderrBytes === OVER_LIMIT || Number.isInteger(diagnostics.stderrBytes)
      ? diagnostics.stderrBytes
      : 0,
    cleanupConfirmed: diagnostics.cleanupConfirmed === true,
  };
  error.attemptEvidence = attemptEvidence;
  if (typeof stdout === 'string') {
    Object.defineProperty(error, 'stdout', { value: stdout });
  }
  return error;
}

function elapsedMs(startedAt) {
  const elapsed = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  return elapsed <= MAX_ATTEMPT_OFFSET_MS ? elapsed : null;
}

function jsonCandidateTracker(onComplete) {
  let started = false;
  let inString = false;
  let escaped = false;
  let invalid = false;
  let complete = false;
  const stack = [];
  return (chunk) => {
    if (complete || invalid) return;
    for (const byte of chunk) {
      if (!started) {
        if ([0x09, 0x0a, 0x0d, 0x20].includes(byte)) continue;
        if (byte !== 0x7b && byte !== 0x5b) {
          invalid = true;
          return;
        }
        started = true;
        stack.push(byte === 0x7b ? 0x7d : 0x5d);
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
        continue;
      }
      if (byte === 0x22) {
        inString = true;
      } else if (byte === 0x7b) {
        stack.push(0x7d);
      } else if (byte === 0x5b) {
        stack.push(0x5d);
      } else if (byte === 0x7d || byte === 0x5d) {
        if (stack.pop() !== byte) {
          invalid = true;
          return;
        }
        if (stack.length === 0) {
          complete = true;
          onComplete();
          return;
        }
      }
    }
  };
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
    const startedAt = process.hrtime.bigint();
    const child = spawn(binary, argv, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverLimit = false;
    let stderrOverLimit = false;
    let failureCode = null;
    let settled = false;
    let killDeadline = null;
    let phase = 'starting';
    const offsets = {
      stdin_flush_ms: null,
      first_stdout_ms: null,
      complete_json_candidate_ms: null,
      stdout_end_ms: null,
      close_ms: null,
      total_elapsed_ms: null,
    };
    const advancePhase = (next) => {
      const order = ['starting', 'awaiting_output', 'output_started', 'awaiting_close'];
      if (order.indexOf(next) > order.indexOf(phase)) phase = next;
    };
    const recordOffset = (field) => {
      if (offsets[field] === null) offsets[field] = elapsedMs(startedAt);
    };
    const evidence = () => ({
      phase,
      ...offsets,
      stdout_bytes: stdoutOverLimit ? OVER_LIMIT : stdoutBytes,
      stderr_bytes: stderrOverLimit ? OVER_LIMIT : stderrBytes,
      payload_valid: false,
      duration_ms: null,
      duration_api_ms: null,
      num_turns: null,
    });
    const trackJsonCandidate = jsonCandidateTracker(() => {
      recordOffset('complete_json_candidate_ms');
    });

    const diagnostics = (exitCode = null, signal = null, cleanupConfirmed = false) => ({
      exitCode,
      signal,
      stderrBytes: stderrOverLimit ? OVER_LIMIT : stderrBytes,
      cleanupConfirmed,
    });
    const bufferedStdout = () => (
      stdoutOverLimit ? undefined : Buffer.concat(stdout).toString('utf8')
    );
    const finishError = (code, details) => {
      if (settled) return;
      settled = true;
      clearTimeout(turnDeadline);
      if (killDeadline) clearTimeout(killDeadline);
      recordOffset('total_elapsed_ms');
      reject(processError(code, details, evidence(), bufferedStdout()));
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
      if (offsets.first_stdout_ms === null) {
        recordOffset('first_stdout_ms');
        advancePhase('output_started');
      }
      const remaining = Math.max(0, MAX_STDOUT_BYTES - stdoutBytes);
      if (remaining > 0) trackJsonCandidate(chunk.subarray(0, remaining));
      if (chunk.length > remaining) {
        stdoutOverLimit = true;
        terminate('ROUTER_OUTPUT_TOO_LARGE');
        return;
      }
      stdoutBytes += chunk.length;
      stdout.push(chunk);
    });
    child.stdout.on('end', () => {
      recordOffset('stdout_end_ms');
      advancePhase('awaiting_close');
    });
    child.stderr.on('data', (chunk) => {
      if (chunk.length > Math.max(0, MAX_STDERR_BYTES - stderrBytes)) {
        stderrOverLimit = true;
        terminate('ROUTER_STDERR_TOO_LARGE');
        return;
      }
      stderrBytes += chunk.length;
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
      recordOffset('close_ms');
      recordOffset('total_elapsed_ms');
      if (failureCode || code !== 0 || signal) {
        finishError(failureCode || 'ROUTER_PROCESS_EXIT', diagnostics(code, signal, true));
        return;
      }
      settled = true;
      resolve({ stdout: bufferedStdout(), attemptEvidence: evidence() });
    });
    child.stdin.on('error', () => terminate('ROUTER_PROCESS_EXIT'));
    try {
      child.stdin.end(input, () => {
        recordOffset('stdin_flush_ms');
        advancePhase('awaiting_output');
      });
    } catch {
      terminate('ROUTER_PROCESS_EXIT');
    }
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

export function sanitizeClaudeMetrics(envelope = {}) {
  return claudeMetricValidation(envelope).claudeMetrics;
}

function claudeMetricValidation(envelope = {}) {
  const boundedDuration = (value) => (
    Number.isInteger(value) && value >= 0 && value <= MAX_CLAUDE_DURATION_MS ? value : null
  );
  const durationMs = boundedDuration(envelope.duration_ms);
  const durationApiMs = boundedDuration(envelope.duration_api_ms);
  const durationMetricsValid = durationMs !== null && durationApiMs !== null;
  const turnCountValid = envelope.num_turns === 1;
  return {
    durationMetricsValid,
    turnCountValid,
    claudeMetrics: durationMetricsValid && turnCountValid ? {
      duration_ms: durationMs,
      duration_api_ms: durationApiMs,
      num_turns: 1,
    } : null,
  };
}

function withClaudeEnvelopeFailure(error, claudeEnvelopeFailure) {
  Object.defineProperty(error, 'claudeEnvelopeFailure', { value: claudeEnvelopeFailure });
  return error;
}

export function parseClaudeResult(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch {
    throw withClaudeEnvelopeFailure(
      Object.assign(new Error('ROUTER_OUTPUT_MALFORMED'), { code: 'ROUTER_OUTPUT_MALFORMED' }),
      CLAUDE_ENVELOPE_FAILURE.JSON_FRAMING,
    );
  }
  const observedModels = envelope?.modelUsage && typeof envelope.modelUsage === 'object'
    ? Object.keys(envelope.modelUsage).sort()
    : [];
  const envelopeError = (code) => Object.assign(new Error(code), { code, observedModels });
  const envelopeFailure = (code, failure) => withClaudeEnvelopeFailure(
    envelopeError(code), failure,
  );
  if (envelope?.is_error === true || envelope?.terminal_reason === 'api_error') {
    throw envelopeError('ROUTER_AUTH_UNAVAILABLE');
  }
  let raw;
  if (envelope && typeof envelope.structured_output === 'object' && envelope.structured_output) {
    raw = JSON.stringify(envelope.structured_output);
  } else if (typeof envelope?.result === 'string') {
    raw = envelope.result;
  } else {
    throw envelopeFailure('ROUTER_OUTPUT_MISSING', CLAUDE_ENVELOPE_FAILURE.OUTPUT_MISSING);
  }
  const metrics = claudeMetricValidation(envelope);
  if (!metrics.durationMetricsValid || !metrics.turnCountValid) {
    const failure = !metrics.durationMetricsValid && !metrics.turnCountValid
      ? CLAUDE_ENVELOPE_FAILURE.DURATION_AND_TURN_COUNT_INVALID
      : !metrics.durationMetricsValid
        ? CLAUDE_ENVELOPE_FAILURE.DURATION_METRICS_INVALID
        : CLAUDE_ENVELOPE_FAILURE.TURN_COUNT_INVALID;
    throw envelopeFailure('ROUTER_OUTPUT_MALFORMED', failure);
  }
  const { claudeMetrics } = metrics;
  const result = { raw, observedModels };
  Object.defineProperty(result, 'claudeMetrics', { value: claudeMetrics });
  return result;
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
    requireAttemptEvidence: true,
    expectedObservedModel,
    async route({ request }) {
      const cwd = await mkdtemp(path.join(tempRoot, 'polygram-u24-claude-'));
      try {
        const invocation = buildClaudeInvocation({ binary, model, schema: ROUTER_SCHEMA });
        let processResult;
        try {
          processResult = await runProcess({
            ...invocation, cwd, input: inputFor(request), timeoutMs, env: subscriptionOnlyEnv(),
          });
        } catch (error) {
          if (typeof error?.stdout === 'string'
              && Number.isInteger(error?.attemptEvidence?.stdout_end_ms)) {
            try {
              const parsed = parseClaudeResult(error.stdout);
              error.attemptEvidence = { ...error.attemptEvidence, ...parsed.claudeMetrics };
              Object.defineProperty(error, 'routeResponse', {
                value: { ...parsed, toolCalls: 0 },
              });
            } catch { /* the process-boundary error remains primary */ }
          }
          throw error;
        }
        try {
          const parsed = parseClaudeResult(processResult.stdout);
          return {
            ...parsed,
            toolCalls: 0,
            attemptEvidence: { ...processResult.attemptEvidence, ...parsed.claudeMetrics },
          };
        } catch (error) {
          error.attemptEvidence = processResult.attemptEvidence;
          throw error;
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

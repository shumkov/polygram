#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const cwd = process.cwd();
const scenarioPath = path.join(cwd, '.fake-codex-app-server.json');
const requestLogPath = path.join(cwd, 'fake-codex-requests.jsonl');
const spawnLogPath = path.join(cwd, 'fake-codex-spawn.json');
const signalLogPath = path.join(cwd, 'fake-codex-signals.jsonl');
const scenario = existsSync(scenarioPath)
  ? JSON.parse(readFileSync(scenarioPath, 'utf8'))
  : {};

writeFileSync(spawnLogPath, `${JSON.stringify({
  argv: process.argv.slice(2),
  cwd,
  env: {
    HOME: process.env.HOME ?? null,
    PATH: process.env.PATH ?? null,
    TMPDIR: process.env.TMPDIR ?? null,
    LANG: process.env.LANG ?? null,
    LC_ALL: process.env.LC_ALL ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
  },
  forbiddenEnvPresent: Object.hasOwn(process.env, 'ORCHESTRA_TEST_SECRET'),
})}\n`);

let keepAlive;
if (scenario.ignoreSigterm) {
  keepAlive = setInterval(() => {}, 1_000);
}

process.on('SIGTERM', () => {
  appendFileSync(signalLogPath, `${JSON.stringify({ signal: 'SIGTERM' })}\n`);
  if (!scenario.ignoreSigterm) process.exit(0);
});
process.on('SIGINT', () => {
  appendFileSync(signalLogPath, `${JSON.stringify({ signal: 'SIGINT' })}\n`);
  process.exit(0);
});
process.on('exit', () => {
  if (keepAlive) clearInterval(keepAlive);
});

const pendingBatch = [];
const methodCalls = new Map();

function appendInbound(message) {
  appendFileSync(requestLogPath, `${JSON.stringify(message)}\n`);
}

function splitBuffer(buffer, sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0) return [buffer];
  const parts = [];
  let offset = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size <= 0 || offset >= buffer.length) break;
    parts.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    offset += size;
  }
  if (offset < buffer.length) parts.push(buffer.subarray(offset));
  return parts;
}

async function writeRaw(buffer, descriptor = {}) {
  const chunks = descriptor.splitEveryByte
    ? Array.from(buffer, (_byte, index) => buffer.subarray(index, index + 1))
    : splitBuffer(buffer, descriptor.splitChunkBytes ?? scenario.splitChunkBytes);
  for (const chunk of chunks) {
    process.stdout.write(chunk);
    if (descriptor.chunkDelayMs || scenario.chunkDelayMs) {
      await new Promise((resolve) => {
        setTimeout(resolve, descriptor.chunkDelayMs ?? scenario.chunkDelayMs);
      });
    }
  }
}

async function writeMessages(messages, descriptor = {}) {
  const lineEnding = descriptor.lineEnding ?? scenario.lineEnding ?? '\n';
  const raw = messages
    .map((message) => `${JSON.stringify(message)}${lineEnding}`)
    .join('');
  await writeRaw(Buffer.from(raw), descriptor);
}

async function writeMalformed(raw, descriptor = {}) {
  const lineEnding = descriptor.lineEnding ?? scenario.lineEnding ?? '\n';
  await writeRaw(Buffer.from(`${raw}${lineEnding}`), descriptor);
}

function descriptorFor(method) {
  const configured = scenario.methods?.[method] ?? {};
  if (!Array.isArray(configured)) return configured;
  const index = methodCalls.get(method) ?? 0;
  methodCalls.set(method, index + 1);
  return configured[Math.min(index, configured.length - 1)] ?? {};
}

function defaultResult(method, params) {
  if (method === 'initialize') {
    return {
      codexHome: process.env.CODEX_HOME,
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
      platformOs: process.platform === 'darwin' ? 'macos' : process.platform,
      userAgent: 'fake-codex-app-server/0.145.0',
    };
  }
  if (method === 'config/read') {
    return { config: {}, layers: [], origins: {} };
  }
  if (method === 'configRequirements/read') return { requirements: null };
  if (method === 'permissionProfile/list') return { data: [], nextCursor: null };
  if (method === 'account/read') {
    return {
      account: { type: 'chatgpt', email: null, planType: 'pro' },
      requiresOpenaiAuth: true,
    };
  }
  if (method === 'model/list') return { data: [], nextCursor: null };
  if (method === 'thread/backgroundTerminals/list') {
    return { data: [], nextCursor: null };
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    return {
      thread: {
        cliVersion: '0.145.0',
        createdAt: 1,
        cwd,
        ephemeral: false,
        id: params?.threadId ?? 'thread-1',
        modelProvider: 'openai',
        preview: '',
        sessionId: params?.threadId ?? 'thread-1',
        source: 'appServer',
        status: { type: 'idle' },
        turns: [],
        updatedAt: 1,
      },
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      cwd,
      model: params?.model ?? 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      runtimeWorkspaceRoots: [cwd],
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
      activePermissionProfile: {
        id: 'polygram-session',
        extends: null,
      },
    };
  }
  if (method === 'turn/start') {
    return {
      turn: {
        id: 'turn-1',
        status: 'inProgress',
        items: [],
      },
    };
  }
  if (method === 'turn/steer') {
    return { turnId: params?.expectedTurnId ?? 'turn-1' };
  }
  if (
    method === 'turn/interrupt'
    || method === 'thread/backgroundTerminals/clean'
  ) {
    return {};
  }
  throw new Error(`fake app-server has no default result for ${method}`);
}

async function emitDescriptorMessages(descriptor) {
  if (Array.isArray(descriptor.beforeResponseMessages)) {
    await writeMessages(descriptor.beforeResponseMessages, descriptor);
  }
}

async function waitForResponseRelease(file) {
  if (file == null) return;
  if (
    typeof file !== 'string'
    || file.length === 0
    || path.basename(file) !== file
  ) {
    throw new Error('waitForResponseFile must be a basename');
  }
  const releasePath = path.join(cwd, file);
  while (!existsSync(releasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function sendResponse(entry) {
  const { message, descriptor } = entry;
  if (descriptor.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, descriptor.delayMs));
  }
  await emitDescriptorMessages(descriptor);
  await waitForResponseRelease(descriptor.waitForResponseFile);
  if (descriptor.stderr) process.stderr.write(descriptor.stderr);
  if (descriptor.closeAfterRead) {
    process.exit(descriptor.exitCode ?? 0);
    return;
  }
  if (descriptor.partialThenExit) {
    const response = Buffer.from(JSON.stringify({
      id: message.id,
      result: descriptor.result ?? defaultResult(message.method, message.params),
    }));
    process.stdout.write(response.subarray(0, Math.max(1, response.length - 2)));
    process.exit(descriptor.exitCode ?? 0);
    return;
  }
  if (descriptor.rawMalformed !== undefined) {
    await writeMalformed(descriptor.rawMalformed, descriptor);
    return;
  }
  if (descriptor.oversizedBytes) {
    await writeMessages([{
      id: message.id,
      result: { value: 'x'.repeat(descriptor.oversizedBytes) },
    }], descriptor);
    return;
  }
  if (descriptor.malformedMatching === 'both-result-and-error') {
    await writeMessages([{
      id: message.id,
      result: {},
      error: { code: -32603, message: 'SECRET_MALFORMED_ERROR' },
    }], descriptor);
    return;
  }
  if (descriptor.mismatchedId !== undefined) {
    await writeMessages([{
      id: descriptor.mismatchedId,
      result: descriptor.result ?? {},
    }], descriptor);
    return;
  }
  if (descriptor.hold) return;
  const response = descriptor.error
    ? { id: message.id, error: descriptor.error }
    : {
        id: message.id,
        result: descriptor.result ?? defaultResult(message.method, message.params),
      };
  await writeMessages([response], descriptor);
  if (descriptor.exitAfterResponse) {
    process.stdout.end(() => process.exit(descriptor.exitCode ?? 0));
    return;
  }
  if (descriptor.lateMessages) {
    await new Promise((resolve) => setTimeout(resolve, descriptor.lateDelayMs ?? 25));
    await writeMessages(descriptor.lateMessages, descriptor);
  }
}

async function flushBatch() {
  const entries = pendingBatch.splice(0);
  if (scenario.reverseBatch) entries.reverse();
  const responses = [];
  for (const { message, descriptor } of entries) {
    await emitDescriptorMessages(descriptor);
    if (descriptor.error) {
      responses.push({ id: message.id, error: descriptor.error });
    } else {
      responses.push({
        id: message.id,
        result: descriptor.result ?? defaultResult(message.method, message.params),
      });
    }
  }
  await writeMessages(responses, scenario);
}

async function handleClientMessage(message) {
  appendInbound(message);
  if (
    Object.hasOwn(message, 'id')
    && !Object.hasOwn(message, 'method')
  ) {
    if (scenario.exitAfterServerResponse) process.exit(0);
    return;
  }
  if (!Object.hasOwn(message, 'method')) return;
  if (!Object.hasOwn(message, 'id')) {
    if (message.method === 'initialized') {
      if (scenario.stderrAfterInitialized) {
        process.stderr.write(scenario.stderrAfterInitialized);
      }
      if (Array.isArray(scenario.afterInitialized)) {
        await writeMessages(scenario.afterInitialized, scenario);
      }
      if (scenario.exitAfterInitialized) process.exit(0);
    }
    return;
  }

  const descriptor = descriptorFor(message.method);
  if (message.method === 'initialize' && scenario.initializeDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, scenario.initializeDelayMs));
  }
  if (
    message.method !== 'initialize'
    && Number.isSafeInteger(scenario.batchSize)
    && scenario.batchSize > 1
  ) {
    pendingBatch.push({ message, descriptor });
    if (pendingBatch.length >= scenario.batchSize) await flushBatch();
    return;
  }
  await sendResponse({ message, descriptor });
}

const lines = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on('line', (line) => {
  chain = chain
    .then(() => handleClientMessage(JSON.parse(line)))
    .catch((error) => {
      process.stderr.write(`fake app-server fixture failed: ${error.message}\n`);
      process.exitCode = 70;
    });
});
lines.on('close', () => {
  void chain.finally(() => {
    if (!scenario.ignoreStdinClose && !scenario.ignoreSigterm) process.exit(0);
  });
});

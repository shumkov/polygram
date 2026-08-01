import {
  MAX_CANDIDATES,
  PROCESSOR_JSON_SCHEMA,
  PROCESSOR_SYSTEM_PROMPT,
} from '../contract.mjs';

const MODEL_ID = 'scoped-memory-qwen3-4b-q4km';
const IMAGE_DIGEST = 'sha256:d281935c6cb43621ec96b187c3636c257ca19223068f8f1fe3038fdbc89f9548';
const MODEL_FILE = 'Qwen3-4B-Q4_K_M.gguf';
const MODEL_PATH = `/models/${MODEL_FILE}`;
const SOCKET_PATH = '/run/llama/extractor.sock';

export const LLAMA_SERVER_COMMAND = Object.freeze([
  '-m', MODEL_PATH,
  '--alias', MODEL_ID,
  '--host', SOCKET_PATH,
  '--offline',
  '--log-disable',
  '--no-webui',
  '--no-slots',
  '--no-cache-prompt',
  '--jinja',
  '--chat-template-kwargs', '{"enable_thinking":false}',
  '--reasoning', 'off',
  '--reasoning-format', 'none',
  '-c', '8192',
  '-n', '2048',
  '-np', '1',
  '-t', '4',
  '-tb', '4',
  '--no-context-shift',
  '--timeout', '65',
]);

export const LLAMA_RUNTIME = Object.freeze({
  image: 'ghcr.io/ggml-org/llama.cpp',
  imageDigest: IMAGE_DIGEST,
  imageReference: `ghcr.io/ggml-org/llama.cpp@${IMAGE_DIGEST}`,
  platform: 'linux/amd64',
  network: 'none',
  transport: 'unix',
  socketPath: SOCKET_PATH,
  apiPath: '/v1/chat/completions',
  model: 'Qwen/Qwen3-4B-GGUF',
  modelRevision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
  modelFile: MODEL_FILE,
  modelBytes: 2_497_280_256,
  modelSha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  contextTokens: 8_192,
  maxOutputTokens: 2_048,
  maxCandidates: MAX_CANDIDATES,
  parallelSlots: 1,
  cpuThreads: 4,
  nanoCpus: 4_000_000_000,
  pidsLimit: 128,
  memoryLimitBytes: 6 * 1024 ** 3,
  swapBytes: 0,
  readOnlyRoot: true,
  offline: true,
  webUi: false,
  slotsEndpoint: false,
  promptCache: false,
  contextShift: false,
  reasoning: false,
  logs: false,
  serverTimeoutSeconds: 65,
  tmpfs: Object.freeze({
    destination: '/tmp',
    sizeBytes: 64 * 1024 ** 2,
    options: Object.freeze(['rw', 'noexec', 'nosuid', 'nodev']),
  }),
});

function cloneSchema() {
  return structuredClone(PROCESSOR_JSON_SCHEMA);
}

export function buildLlamaRequest(processorRequest) {
  if (
    processorRequest === null
    || typeof processorRequest !== 'object'
    || Array.isArray(processorRequest)
  ) {
    throw new TypeError('Llama processor request must be an object');
  }

  return {
    model: MODEL_ID,
    stream: false,
    messages: [
      { role: 'system', content: PROCESSOR_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(processorRequest) },
    ],
    max_tokens: LLAMA_RUNTIME.maxOutputTokens,
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    presence_penalty: 1.5,
    seed: 42,
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: 'none',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'scoped_memory_candidates',
        strict: true,
        schema: cloneSchema(),
      },
    },
  };
}

export function normalizeLlamaResponse(response) {
  const choices = response?.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    return emptyResponse();
  }

  const choice = choices[0];
  const message = choice?.message;
  if (message === null || typeof message !== 'object') {
    return emptyResponse();
  }

  if (typeof message.refusal === 'string' && message.refusal.length > 0) {
    return emptyResponse('refusal', response?.usage);
  }
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim().length > 0) {
    return emptyResponse('reasoning', response?.usage);
  }
  if (typeof message.content !== 'string') {
    return emptyResponse('error', response?.usage);
  }

  const stopReason = {
    stop: 'end_turn',
    length: 'max_tokens',
    content_filter: 'refusal',
  }[choice.finish_reason] ?? 'error';

  return {
    stopReason,
    content: stopReason === 'end_turn' ? message.content : '',
    usage: normalizeUsage(response?.usage),
  };
}

export const parseLlamaResponse = normalizeLlamaResponse;

function emptyResponse(stopReason = 'error', usage) {
  return { stopReason, content: '', usage: normalizeUsage(usage) };
}

function normalizeUsage(usage) {
  return {
    inputTokens: Number.isInteger(usage?.prompt_tokens) ? usage.prompt_tokens : 0,
    outputTokens: Number.isInteger(usage?.completion_tokens) ? usage.completion_tokens : 0,
    totalTokens: Number.isInteger(usage?.total_tokens) ? usage.total_tokens : 0,
  };
}

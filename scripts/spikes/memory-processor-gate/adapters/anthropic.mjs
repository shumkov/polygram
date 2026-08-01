import {
  MAX_CANDIDATES,
  PROCESSOR_JSON_SCHEMA,
  PROCESSOR_SYSTEM_PROMPT,
} from '../contract.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 2048;

function assertPreparedRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Anthropic processor request must be an object');
  }
}

function anthropicSchema(value) {
  if (Array.isArray(value)) return value.map(anthropicSchema);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'minLength' && key !== 'maxLength')
    .map(([key, nested]) => [key, anthropicSchema(nested)]));
}

export function buildAnthropicRequest(request) {
  assertPreparedRequest(request);

  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: PROCESSOR_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify(request) }],
    }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: anthropicSchema(PROCESSOR_JSON_SCHEMA),
      },
    },
  };
}

export function normalizeAnthropicResponse(response) {
  const textBlocks = Array.isArray(response?.content)
    ? response.content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    : [];
  const usage = response?.usage;
  const normalizedUsage = {};
  for (const [source, target] of [
    ['input_tokens', 'inputTokens'],
    ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
    ['cache_read_input_tokens', 'cacheReadInputTokens'],
    ['output_tokens', 'outputTokens'],
  ]) {
    if (Number.isSafeInteger(usage?.[source]) && usage[source] >= 0) {
      normalizedUsage[target] = usage[source];
    }
  }
  if (typeof usage?.service_tier === 'string') normalizedUsage.serviceTier = usage.service_tier;
  if (typeof usage?.inference_geo === 'string') normalizedUsage.inferenceGeo = usage.inference_geo;

  return {
    stopReason: typeof response?.stop_reason === 'string' ? response.stop_reason : null,
    content: textBlocks.length === 1 ? textBlocks[0].text : '',
    usage: normalizedUsage,
  };
}

export const ANTHROPIC_PROCESSOR = Object.freeze({
  model: MODEL,
  maxTokens: MAX_TOKENS,
  maxCandidates: MAX_CANDIDATES,
  apiVersion: '2023-06-01',
  endpoint: 'https://api.anthropic.com/v1/messages',
});

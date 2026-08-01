import { performance } from 'node:perf_hooks';

import { LLAMA_RUNTIME } from '../adapters/llama.mjs';

export class LocalRuntimePreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalRuntimePreflightError';
    this.code = code;
  }
}

function fail(code) {
  throw new LocalRuntimePreflightError(code);
}

function finiteDuration(value) {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

export function buildApplyTemplateRequest(providerRequest) {
  if (!providerRequest || typeof providerRequest !== 'object' || Array.isArray(providerRequest)) {
    fail('LOCAL_RUNTIME_PROVIDER_REQUEST_INVALID');
  }
  if (!Array.isArray(providerRequest.messages) || providerRequest.messages.length === 0) {
    fail('LOCAL_RUNTIME_PROVIDER_MESSAGES_INVALID');
  }

  const request = { messages: structuredClone(providerRequest.messages) };
  if (providerRequest.chat_template_kwargs !== undefined) {
    request.chat_template_kwargs = structuredClone(providerRequest.chat_template_kwargs);
  }
  return request;
}

export function parseAppliedTemplate(response) {
  if (!response || typeof response !== 'object' || typeof response.prompt !== 'string'
      || response.prompt.length === 0) {
    fail('LOCAL_RUNTIME_APPLY_TEMPLATE_RESPONSE_INVALID');
  }
  return response.prompt;
}

export function buildTokenizeRequest(appliedPrompt) {
  if (typeof appliedPrompt !== 'string' || appliedPrompt.length === 0) {
    fail('LOCAL_RUNTIME_APPLIED_PROMPT_INVALID');
  }
  return {
    content: appliedPrompt,
    add_special: true,
    parse_special: true,
  };
}

export function parseTokenCount(response) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.tokens)
      || response.tokens.some((token) => !Number.isInteger(token))) {
    fail('LOCAL_RUNTIME_TOKENIZE_RESPONSE_INVALID');
  }
  return response.tokens.length;
}

export function assertTokenBudget({
  inputTokens,
  maxOutputTokens = LLAMA_RUNTIME.maxOutputTokens,
  contextTokens = LLAMA_RUNTIME.contextTokens,
}) {
  if (!Number.isInteger(inputTokens) || inputTokens < 0
      || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1
      || !Number.isInteger(contextTokens) || contextTokens < 1) {
    fail('LOCAL_RUNTIME_TOKEN_BUDGET_INVALID');
  }
  const reservedTokens = inputTokens + maxOutputTokens;
  if (reservedTokens > contextTokens) fail('LOCAL_RUNTIME_CONTEXT_BUDGET_EXCEEDED');
  return Object.freeze({
    inputTokens,
    maxOutputTokens,
    contextTokens,
    reservedTokens,
    remainingTokens: contextTokens - reservedTokens,
  });
}

export async function preflightTokenBudget({
  providerRequest,
  postJson,
  signal,
  runtime = LLAMA_RUNTIME,
  now = () => performance.now(),
}) {
  if (typeof postJson !== 'function') fail('LOCAL_RUNTIME_TRANSPORT_INVALID');
  const started = now();
  const templateResponse = await postJson(
    '/apply-template',
    buildApplyTemplateRequest(providerRequest),
    { signal },
  );
  const templateFinished = now();
  const appliedPrompt = parseAppliedTemplate(templateResponse);
  const tokenizeResponse = await postJson(
    '/tokenize',
    buildTokenizeRequest(appliedPrompt),
    { signal },
  );
  const finished = now();
  const budget = assertTokenBudget({
    inputTokens: parseTokenCount(tokenizeResponse),
    maxOutputTokens: runtime.maxOutputTokens,
    contextTokens: runtime.contextTokens,
  });

  return Object.freeze({
    ...budget,
    applyTemplateMs: finiteDuration(templateFinished - started),
    tokenizeMs: finiteDuration(finished - templateFinished),
    preflightMs: finiteDuration(finished - started),
  });
}

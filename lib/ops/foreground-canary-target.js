'use strict';

const {
  createHash,
  createHmac,
  timingSafeEqual,
} = require('node:crypto');
const {
  getSessionKey,
  getTopicName,
} = require('../session-key');

const SHA256_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVIDERS = new Set(['claude', 'codex']);
const LIVE_HANDLER_STATUSES = new Set(['dispatched', 'processing']);
const DEPLOY_REQUEST_KEYS = new Set([
  'op',
  'id',
  'secret',
  'foreground_expectation',
  'qualification_expectation',
]);
const EXPECTATION_KEYS = [
  'schema_version',
  'daemon_instance_id',
  'pid',
  'provider',
  'configured_scope_sha256',
  'target_token',
];
const PROBE_KEYS = [
  'op',
  'id',
  'secret',
  'provider',
  'configured_scope_sha256',
];

function isPlainObject(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedString(value, maxBytes = 256) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !/[\x00-\x1f\x7f]/.test(value);
}

function validRequestId(value) {
  return isBoundedString(value, 128);
}

function configuredScopeSha256({
  botName,
  chatId,
  threadId,
  chatName,
  topicName,
  isolateTopics,
} = {}) {
  return createHash('sha256').update(JSON.stringify([
    String(botName),
    String(chatId),
    threadId == null ? null : String(threadId),
    String(chatName),
    topicName == null ? null : String(topicName),
    isolateTopics === true,
  ])).digest('hex');
}

function configuredScopes({ config, botName } = {}) {
  const scopes = [];
  for (const [chatId, chatConfig] of Object.entries(config?.chats ?? {})) {
    if (!chatConfig || typeof chatConfig !== 'object') continue;
    const base = {
      botName,
      chatId: String(chatId),
      threadId: null,
      chatName: String(chatConfig.name ?? ''),
      topicName: null,
      isolateTopics: chatConfig.isolateTopics === true,
      sessionKey: getSessionKey(String(chatId), null, chatConfig),
    };
    scopes.push(Object.freeze({
      ...base,
      digest: configuredScopeSha256(base),
    }));
    for (const threadId of Object.keys(chatConfig.topics ?? {})) {
      const topic = {
        ...base,
        threadId: String(threadId),
        topicName: getTopicName(chatConfig, String(threadId)),
        sessionKey: getSessionKey(String(chatId), String(threadId), chatConfig),
      };
      scopes.push(Object.freeze({
        ...topic,
        digest: configuredScopeSha256(topic),
      }));
    }
  }
  return scopes;
}

function resolveConfiguredScope({ config, botName, digest } = {}) {
  if (!SHA256_RE.test(digest ?? '')) return null;
  const matches = configuredScopes({ config, botName })
    .filter((scope) => scope.digest === digest);
  return matches.length === 1 ? matches[0] : null;
}

function normalizeDeployForegroundExpectation(request) {
  if (!isPlainObject(request)) return null;
  const keys = Object.keys(request);
  const unknown = keys.some((key) => !DEPLOY_REQUEST_KEYS.has(key));
  const present = Object.hasOwn(request, 'foreground_expectation');
  if (!present && !unknown) return undefined;
  if (unknown) return null;

  const expectation = request.foreground_expectation;
  if (
    !hasExactKeys(expectation, EXPECTATION_KEYS)
    || expectation.schema_version !== 1
    || !UUID_RE.test(expectation.daemon_instance_id ?? '')
    || !Number.isSafeInteger(expectation.pid)
    || expectation.pid <= 0
    || !PROVIDERS.has(expectation.provider)
    || !SHA256_RE.test(expectation.configured_scope_sha256 ?? '')
    || !TOKEN_RE.test(expectation.target_token ?? '')
  ) {
    return null;
  }
  return Object.freeze({
    daemonInstanceId: expectation.daemon_instance_id,
    pid: expectation.pid,
    provider: expectation.provider,
    configuredScopeSha256: expectation.configured_scope_sha256,
    targetToken: expectation.target_token,
  });
}

function normalizedActiveTarget(value) {
  if (!isPlainObject(value)) return null;
  const sessionKey = value.sessionKey;
  const chatId = value.chatId;
  const threadId = value.threadId;
  const telegramMessageId = value.telegramMessageId;
  if (
    !isBoundedString(sessionKey, 512)
    || !isBoundedString(chatId, 128)
    || !(threadId === null || isBoundedString(threadId, 128))
    || !isBoundedString(telegramMessageId, 128)
  ) return null;
  return {
    sessionKey,
    chatId,
    threadId,
    telegramMessageId,
  };
}

function normalizedSelectedTarget(value) {
  if (!isPlainObject(value)) return null;
  if (
    !Number.isSafeInteger(value.messageId)
    || value.messageId <= 0
    || !isBoundedString(value.chatId, 128)
    || !(value.threadId === null || isBoundedString(value.threadId, 128))
    || !isBoundedString(value.telegramMessageId, 128)
    || !isBoundedString(value.sessionKey, 512)
    || !PROVIDERS.has(value.provider)
    || !isBoundedString(value.handlerStatus, 64)
  ) return null;
  return {
    messageId: value.messageId,
    chatId: value.chatId,
    threadId: value.threadId,
    telegramMessageId: value.telegramMessageId,
    sessionKey: value.sessionKey,
    provider: value.provider,
    handlerStatus: value.handlerStatus,
  };
}

function sameTarget(left, right) {
  return left.sessionKey === right.sessionKey
    && left.chatId === right.chatId
    && left.threadId === right.threadId
    && left.telegramMessageId === right.telegramMessageId;
}

function sameBinding(left, right) {
  return sameTarget(left, right)
    && left.messageId === right.messageId
    && left.provider === right.provider
    && left.scopeDigest === right.scopeDigest;
}

function safeTokenEqual(left, right) {
  if (!TOKEN_RE.test(left ?? '') || !TOKEN_RE.test(right ?? '')) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function createForegroundCanaryAuthorizer({
  botName,
  daemonIdentity,
  config,
  tokenSecret,
  getActiveHandlerTargets,
  getForegroundCanaryTarget,
  now = Date.now,
  tokenTtlMs = 300_000,
} = {}) {
  if (!isBoundedString(botName, 128)) {
    throw new TypeError('foreground canary bot name is required');
  }
  if (
    !isPlainObject(daemonIdentity)
    || !UUID_RE.test(daemonIdentity.daemon_instance_id ?? '')
    || !Number.isSafeInteger(daemonIdentity.pid)
    || daemonIdentity.pid <= 0
    || !isBoundedString(daemonIdentity.package_version, 128)
  ) {
    throw new TypeError('foreground canary daemon identity is invalid');
  }
  if (!isBoundedString(tokenSecret, 1024)) {
    throw new TypeError('foreground canary token secret is required');
  }
  if (typeof getActiveHandlerTargets !== 'function') {
    throw new TypeError('foreground canary active-handler reader is required');
  }
  if (typeof getForegroundCanaryTarget !== 'function') {
    throw new TypeError('foreground canary database reader is required');
  }
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs <= 0) {
    throw new TypeError('foreground canary token TTL is invalid');
  }

  const tokens = new Map();

  function reject(rejectionCode) {
    return { rejectionCode };
  }

  function inspectLiveTarget({ provider, scopeDigest }) {
    const scope = resolveConfiguredScope({ config, botName, digest: scopeDigest });
    if (!scope) return reject('configured-scope-mismatch');

    let active;
    try {
      active = getActiveHandlerTargets();
    } catch {
      return reject('target-unavailable');
    }
    if (!Array.isArray(active) || active.length !== 1) {
      return reject('daemon-busy');
    }
    const activeTarget = normalizedActiveTarget(active[0]);
    if (!activeTarget) return reject('source-mismatch');
    if (
      activeTarget.chatId !== scope.chatId
      || activeTarget.threadId !== scope.threadId
      || activeTarget.sessionKey !== scope.sessionKey
    ) {
      return reject('source-mismatch');
    }

    let selected;
    try {
      selected = normalizedSelectedTarget(getForegroundCanaryTarget({
        botName,
        chatId: activeTarget.chatId,
        telegramMessageId: activeTarget.telegramMessageId,
      }));
    } catch {
      return reject('target-unavailable');
    }
    if (!selected) return reject('target-not-live');
    if (!sameTarget(activeTarget, selected)) return reject('source-mismatch');
    if (selected.provider !== provider) return reject('provider-mismatch');
    if (!LIVE_HANDLER_STATUSES.has(selected.handlerStatus)) {
      return reject('target-not-live');
    }
    return {
      binding: Object.freeze({
        ...selected,
        scopeDigest,
      }),
    };
  }

  function probe(request) {
    if (
      !hasExactKeys(request, PROBE_KEYS)
      || request.op !== 'foreground_canary_target'
      || !validRequestId(request.id)
      || !isBoundedString(request.secret, 1024)
      || !PROVIDERS.has(request.provider)
      || !SHA256_RE.test(request.configured_scope_sha256 ?? '')
    ) {
      return {
        outcome: 'rejected',
        rejection_code: 'invalid-request',
      };
    }

    const inspected = inspectLiveTarget({
      provider: request.provider,
      scopeDigest: request.configured_scope_sha256,
    });
    if (!inspected.binding) {
      return {
        outcome: 'rejected',
        rejection_code: inspected.rejectionCode,
      };
    }

    const issuedAt = now();
    const token = createHmac('sha256', tokenSecret).update(JSON.stringify([
      request.id,
      daemonIdentity.daemon_instance_id,
      daemonIdentity.pid,
      inspected.binding.provider,
      inspected.binding.scopeDigest,
      inspected.binding.sessionKey,
      inspected.binding.messageId,
      inspected.binding.telegramMessageId,
      issuedAt,
    ])).digest('hex');
    tokens.set(request.id, Object.freeze({
      token,
      binding: inspected.binding,
      expiresAt: issuedAt + tokenTtlMs,
    }));
    return {
      outcome: 'live',
      bot: botName,
      daemon_instance_id: daemonIdentity.daemon_instance_id,
      pid: daemonIdentity.pid,
      package_version: daemonIdentity.package_version,
      provider: request.provider,
      configured_scope_sha256: request.configured_scope_sha256,
      target_token: token,
    };
  }

  function authorizeRestart({ requestId, expectation } = {}) {
    if (!validRequestId(requestId) || !isPlainObject(expectation)) {
      return { accepted: false, rejectionCode: 'invalid-request' };
    }
    if (
      expectation.daemonInstanceId !== daemonIdentity.daemon_instance_id
      || expectation.pid !== daemonIdentity.pid
    ) {
      return { accepted: false, rejectionCode: 'daemon-identity-mismatch' };
    }

    const stored = tokens.get(requestId);
    if (!stored || !safeTokenEqual(stored.token, expectation.targetToken)) {
      return { accepted: false, rejectionCode: 'target-token-invalid' };
    }
    if (now() > stored.expiresAt) {
      tokens.delete(requestId);
      return { accepted: false, rejectionCode: 'target-token-expired' };
    }
    if (
      expectation.provider !== stored.binding.provider
      || expectation.configuredScopeSha256 !== stored.binding.scopeDigest
    ) {
      tokens.delete(requestId);
      return { accepted: false, rejectionCode: 'target-binding-mismatch' };
    }

    const inspected = inspectLiveTarget({
      provider: expectation.provider,
      scopeDigest: expectation.configuredScopeSha256,
    });
    if (!inspected.binding) {
      tokens.delete(requestId);
      return { accepted: false, rejectionCode: inspected.rejectionCode };
    }
    if (!sameBinding(stored.binding, inspected.binding)) {
      tokens.delete(requestId);
      return { accepted: false, rejectionCode: 'source-mismatch' };
    }

    tokens.delete(requestId);
    return {
      accepted: true,
      authorizationEvent: Object.freeze({
        bot: botName,
        daemon_instance_id: daemonIdentity.daemon_instance_id,
        pid: daemonIdentity.pid,
        package_version: daemonIdentity.package_version,
        provider: stored.binding.provider,
        configured_scope_sha256: stored.binding.scopeDigest,
        session_key: stored.binding.sessionKey,
        source_message_id: stored.binding.messageId,
        restart_request_sha256: createHash('sha256')
          .update(requestId)
          .digest('hex'),
      }),
    };
  }

  return Object.freeze({
    probe,
    authorizeRestart,
  });
}

module.exports = {
  configuredScopeSha256,
  createForegroundCanaryAuthorizer,
  normalizeDeployForegroundExpectation,
  resolveConfiguredScope,
};

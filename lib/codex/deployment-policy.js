'use strict';

const { createHash } = require('node:crypto');
const { lstatSync, readFileSync } = require('node:fs');
const path = require('node:path');

const TRUSTED_PROFILE_ID = 'polygram-trusted';

function invalid(message) {
  const error = new Error(`Codex ${message}.`);
  error.code = 'CODEX_DEPLOYMENT_CONFIG_INVALID';
  error.action = 'Correct the explicit Codex deployment configuration before enabling it.';
  return error;
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validateAccess(access) {
  if (access === undefined) return null;
  if (!exactObject(access, ['mode', 'chatIds', 'commandPath'])
    || access.mode !== 'trusted'
    || !Array.isArray(access.chatIds) || access.chatIds.length === 0
    || access.chatIds.some((id) => typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id))
    || typeof access.commandPath !== 'string' || access.commandPath.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(access.commandPath)
    || access.commandPath.split(':').some((entry) => !path.isAbsolute(entry))) {
    throw invalid('trusted access requires exact positive private chat IDs and an absolute-entry commandPath');
  }
  return { mode: 'trusted', chatIds: [...access.chatIds], commandPath: access.commandPath };
}

function accessAllowsChat(access, chatId) {
  try {
    const trusted = validateAccess(access);
    return trusted === null || trusted.chatIds.includes(String(chatId));
  } catch {
    return false;
  }
}

function readProxy(proxy) {
  if (proxy === undefined) return null;
  let endpoint;
  try { endpoint = new URL(proxy?.baseUrl); } catch {}
  if (!exactObject(proxy, ['baseUrl', 'clientKeyFile'])
    || !endpoint || endpoint.protocol !== 'http:'
    || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/v1'
    || typeof proxy.clientKeyFile !== 'string' || !path.isAbsolute(proxy.clientKeyFile)
    || /[\u0000-\u001f\u007f]/u.test(proxy.clientKeyFile)) {
    throw invalid('proxy requires a loopback HTTP /v1 endpoint and an absolute private clientKeyFile');
  }
  let stat;
  let key;
  let contents;
  try {
    stat = lstatSync(proxy.clientKeyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0
      || ![0, process.getuid?.()].includes(stat.uid)) throw new Error();
    contents = readFileSync(proxy.clientKeyFile, 'utf8');
    key = contents.trim();
    if (!key || key.length > 16384 || /\s/u.test(key)) throw new Error();
  } catch {
    // File errors must never include key contents or provider-supplied text.
    throw invalid('proxy client key is missing, unsafe, or malformed');
  }
  return {
    provider: {
      name: 'CLIProxyAPI',
      base_url: proxy.baseUrl,
      wire_api: 'responses',
      requires_openai_auth: true,
      experimental_bearer_token: key,
      supports_websockets: true,
    },
    identity: {
      baseUrl: proxy.baseUrl,
      clientKeyFile: proxy.clientKeyFile,
      dev: String(stat.dev), ino: String(stat.ino),
      mode: stat.mode, uid: stat.uid,
      sha256: createHash('sha256').update(contents).digest('hex'),
    },
  };
}

module.exports = { TRUSTED_PROFILE_ID, validateAccess, accessAllowsChat, readProxy };

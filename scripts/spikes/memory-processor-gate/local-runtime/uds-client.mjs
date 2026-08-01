import http from 'node:http';
import path from 'node:path';

const ALLOWED_PATHS = new Set([
  '/apply-template',
  '/tokenize',
  '/v1/chat/completions',
]);

export class LocalRuntimeTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalRuntimeTransportError';
    this.code = code;
  }
}

function fail(code) {
  throw new LocalRuntimeTransportError(code);
}

function transportError(code) {
  return new LocalRuntimeTransportError(code);
}

export function assertUnixSocketPath(socketPath) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)
      || Buffer.byteLength(socketPath, 'utf8') >= 104) {
    fail('LOCAL_RUNTIME_SOCKET_PATH_INVALID');
  }
  return socketPath;
}

export function createUnixJsonTransport({
  socketPath,
  request = http.request,
  maxResponseBytes = 4 * 1024 * 1024,
} = {}) {
  const absoluteSocketPath = assertUnixSocketPath(socketPath);
  if (typeof request !== 'function') fail('LOCAL_RUNTIME_HTTP_REQUEST_INVALID');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    fail('LOCAL_RUNTIME_RESPONSE_LIMIT_INVALID');
  }

  async function postJson(endpoint, payload, { signal } = {}) {
    if (!ALLOWED_PATHS.has(endpoint)) fail('LOCAL_RUNTIME_ENDPOINT_INVALID');
    if (signal?.aborted) throw transportError('LOCAL_RUNTIME_JOB_DEADLINE');

    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      fail('LOCAL_RUNTIME_REQUEST_SERIALIZATION_FAILED');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        callback(value);
      };
      const rejectCode = (code) => finish(reject, transportError(code));
      const abort = () => {
        req.destroy(transportError('LOCAL_RUNTIME_JOB_DEADLINE'));
        rejectCode('LOCAL_RUNTIME_JOB_DEADLINE');
      };

      const req = request({
        socketPath: absoluteSocketPath,
        path: endpoint,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized),
        },
        signal,
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            req.destroy(transportError('LOCAL_RUNTIME_RESPONSE_TOO_LARGE'));
            rejectCode('LOCAL_RUNTIME_RESPONSE_TOO_LARGE');
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          if (!Number.isInteger(response.statusCode)
              || response.statusCode < 200 || response.statusCode >= 300) {
            rejectCode('LOCAL_RUNTIME_HTTP_STATUS');
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            rejectCode('LOCAL_RUNTIME_RESPONSE_MALFORMED');
            return;
          }
          finish(resolve, parsed);
        });
        response.on('error', () => rejectCode('LOCAL_RUNTIME_RESPONSE_FAILED'));
      });

      signal?.addEventListener('abort', abort, { once: true });
      req.on('error', (error) => {
        if (error?.code === 'LOCAL_RUNTIME_JOB_DEADLINE') {
          rejectCode('LOCAL_RUNTIME_JOB_DEADLINE');
        } else if (error?.code === 'LOCAL_RUNTIME_RESPONSE_TOO_LARGE') {
          rejectCode('LOCAL_RUNTIME_RESPONSE_TOO_LARGE');
        } else {
          rejectCode('LOCAL_RUNTIME_SOCKET_FAILED');
        }
      });
      req.end(serialized);
    });
  }

  return Object.freeze({
    kind: 'unix-domain-socket',
    socketPath: absoluteSocketPath,
    postJson,
  });
}

export function assertUnixTransport(transport, expectedSocketPath) {
  if (!transport || transport.kind !== 'unix-domain-socket'
      || transport.socketPath !== assertUnixSocketPath(expectedSocketPath)
      || typeof transport.postJson !== 'function') {
    fail('LOCAL_RUNTIME_TRANSPORT_NOT_PINNED_UDS');
  }
  return transport;
}

'use strict';

// Generated from the checked-in Codex hook sources by the bundle build
// step. Bundled modules see only the frozen facades passed in below, so
// the protected closure is the runtime, this file, and nothing else.
// Edit the sources and rebuild; never edit this file by hand.

(function (__facades, __process) {
  const __definitions = Object.create(null);
  const __instances = Object.create(null);

  function __load(__specifier) {
    if (Object.hasOwn(__facades, __specifier)) return __facades[__specifier];
    const __definition = __definitions[__specifier];
    if (__definition === undefined) {
      throw new Error('bundled module ' + __specifier + ' is outside the closure');
    }
    let __instance = __instances[__specifier];
    if (__instance === undefined) {
      __instance = { exports: {} };
      __instances[__specifier] = __instance;
      __definition(
        __instance, __instance.exports, __load, __process,
        undefined, undefined, undefined,
      );
    }
    return __instance.exports;
  }

  __definitions["./observer-capture.js"] = function (module, exports, require, process, globalThis, global, Function) {
'use strict';

const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const CAPTURE_SCHEMA = 'u23-hook-observation/v1';
const MAX_CAPTURE_ATTEMPTS = 64;

// The observation carries digests and the turn identity only. A hook payload
// can contain prompt text and paths, so nothing derived from it is written
// verbatim: the capture is evidence that a hook ran and which turn it ran for,
// not a copy of the turn.
function buildCaptureRecord({
  event,
  status,
  observedAtEpochMs,
  payload,
  payloadBytes,
  parsed,
}) {
  let turnId = null;
  if (status === 'ok' && parsed && typeof parsed === 'object'
    && typeof parsed.turn_id === 'string') {
    turnId = parsed.turn_id;
  }
  return {
    schema: CAPTURE_SCHEMA,
    event,
    status,
    observedAtEpochMs,
    payloadBytes,
    payloadSha256: typeof payload === 'string'
      ? createHash('sha256').update(payload).digest('hex')
      : null,
    pid: process.pid,
    turnId,
  };
}

// One event can fire many times in a session, so the writer claims a fresh
// name with an exclusive create instead of overwriting an earlier capture.
function writeCaptureRecord(captureDir, record) {
  const serialized = `${JSON.stringify(record, Object.keys(record).sort(), 2)}\n`;
  for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    const file = path.join(
      captureDir,
      `${record.event}-${record.pid}-${attempt}.json`,
    );
    try {
      writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
      return file;
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('hook observation capture names are exhausted');
}

module.exports = { buildCaptureRecord, writeCaptureRecord, CAPTURE_SCHEMA };
  };

  __definitions["./observer-entry.js"] = function (module, exports, require, process, globalThis, global, Function) {
'use strict';

// Stamped at process entry, before stdin is touched. Stamping after the drain
// measures the writer rather than the hook, which silently inflates every
// margin derived from the capture.
const OBSERVED_AT_EPOCH_MS = Date.now();

const { buildCaptureRecord, writeCaptureRecord } = require('./observer-capture.js');

const MAX_PAYLOAD_BYTES = 256 * 1024;
const STDIN_TIMEOUT_MS = 5_000;

// An oversized payload is rejected whole. Parsing the prefix that arrived
// before the limit would record a truncated turn as a complete observation.
function readPayload(stdin, limit, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (status, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeAllListeners();
      stdin.pause();
      resolve({ status, payload, bytes });
    };
    const timer = setTimeout(() => finish('timeout', null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    stdin.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        finish('overflow', null);
        return;
      }
      chunks.push(chunk);
    });
    stdin.once('error', () => finish('unreadable', null));
    stdin.once('end', () => finish('ok', Buffer.concat(chunks).toString('utf8')));
  });
}

async function main(argv, stdin) {
  const [event, captureDir] = argv;
  if (typeof event !== 'string' || event.length === 0
    || typeof captureDir !== 'string' || captureDir.length === 0) {
    process.setExitCode(2);
    return;
  }
  const read = await readPayload(stdin, MAX_PAYLOAD_BYTES, STDIN_TIMEOUT_MS);
  let status = read.status;
  let parsed = null;
  if (status === 'ok') {
    try {
      parsed = JSON.parse(read.payload);
    } catch {
      status = 'unparsable';
    }
  }
  writeCaptureRecord(captureDir, buildCaptureRecord({
    event,
    status,
    observedAtEpochMs: OBSERVED_AT_EPOCH_MS,
    payload: read.payload,
    payloadBytes: read.bytes,
    parsed,
  }));
}

main(process.argv.slice(2), process.stdin).catch(() => {
  // A hook that cannot record its observation must not take the turn down
  // with it; the missing capture is the signal the gate reads.
  process.setExitCode(1);
});
  };

  __load("./observer-entry.js");
}(
  Object.freeze({
    "node:crypto": Object.freeze({ createHash: require("node:crypto").createHash }),
    "node:fs": Object.freeze({ writeFileSync: require("node:fs").writeFileSync }),
    "node:path": Object.freeze({ join: require("node:path").join })
  })
,
  Object.freeze({
    argv: Object.freeze(process.argv.slice()),
    pid: process.pid,
    setExitCode(code) { process.exitCode = code; },
    stdin: process.stdin,
  })
));

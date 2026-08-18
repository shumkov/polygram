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

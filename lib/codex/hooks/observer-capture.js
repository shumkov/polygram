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

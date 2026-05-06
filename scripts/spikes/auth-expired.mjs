/**
 * G5: Auth-expired UX.
 *
 * Validates the 5-behaviour flow per v4 plan §8 invariant 25:
 *   (a) user sees friendly "🔑 needs re-auth" not "💥 crashed"
 *   (b) admin chat is notified
 *   (c) auth-expired event is logged
 *   (d) doctor.js raises alarm (separate check)
 *   (e) classifier returns kind: 'authExpired'
 *
 * DESTRUCTIVE: this script does NOT actually revoke OAuth (would
 * disrupt prod). Instead it tests the classifier directly on
 * synthetic 401 errors and SDK assistant.error: 'authentication_failed'
 * shapes.
 *
 * Pass criterion: classifier returns kind='authExpired' for both
 * shapes; userMessage is the friendly variant; no enum leak.
 */

import { classify } from '../../lib/error/classify.js';

const cases = [
  { name: 'HTTP 401 string', input: 'HTTP 401 Unauthorized' },
  { name: 'authentication_failed assistant.error', input: 'authentication_failed' },
  { name: 'OAuth token expired prose', input: 'OAuth token expired; please re-authenticate.' },
  { name: 'invalid_request with expired text', input: 'Invalid request: token expired.' },
  // Result subtype shape:
  { name: 'result subtype with 401 message', input: { subtype: 'error_during_execution', error: 'HTTP 401' } },
  { name: 'bare 403', input: 'HTTP 403 Forbidden' },
];

let allPass = true;
for (const c of cases) {
  const cls = classify(c.input);
  const ok = cls.kind === 'authExpired';
  // userMessage should be friendly, not leak the SDK enum
  const friendly = cls.userMessage && !/authentication_failed|HTTP 4\d\d/.test(cls.userMessage);
  console.log(`${ok && friendly ? 'OK ' : 'FAIL'} ${c.name}`);
  console.log(`     kind=${cls.kind}`);
  console.log(`     userMessage=${(cls.userMessage || '').slice(0, 70)}`);
  if (!ok || !friendly) allPass = false;
}

console.log(allPass ? '\nPASS' : '\nFAIL');
process.exit(allPass ? 0 : 1);

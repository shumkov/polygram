'use strict';

/**
 * Tiered secret detection + in-place redaction (0.15).
 *
 * Pure (no I/O) so the sweep, the redact_secret MCP tool, and tests all share
 * one ruleset. Detection of KNOWN-SHAPE secrets is deterministic → regex here
 * (reliable + free); the model handles fuzzy/prose secrets via the redact_secret
 * tool, not a second pass (CLAUDE.md rule 5).
 *
 * Tiers:
 *   high   — unmistakable token shapes (near-zero false positive) → auto-redact
 *   medium — token-shaped but slightly FP-prone (JWT)             → auto-redact
 *   low    — generic key=value ("password: ...") + lookalikes     → FLAG only
 *            (never auto-destroy on "password: required"); the model/operator
 *            confirms a low hit before it's redacted.
 *
 * A rule may set `group` to redact only a capture group (the value), not the
 * whole match (e.g. the token after "Bearer", the value after "password:").
 *
 * Two consumers, two policies over the same rules:
 *   redactText              — after-the-fact cleanup (sweep / redact tool):
 *                             high+medium redacted, low only flagged.
 *   sanitizeForDurableWrite — the pre-write boundary: low is masked too,
 *                             because an unresolved credential must not land
 *                             in SQLite/FTS. A narrow value allowlist keeps
 *                             ordinary vocabulary ("password: required")
 *                             readable. The live turn keeps the original text.
 */

const PLACEHOLDER = (rule) => `‹redacted:${rule}›`; // ‹redacted:rule› — never re-matches a rule

/**
 * The value half of a declared credential (`password: …`, `my password is …`).
 *
 * Three alternatives, tried in order, because a declared value has three
 * shapes and stopping at the first whitespace gets two of them wrong:
 *   1. double-quoted — everything up to the closing quote, spaces included
 *   2. single-quoted — same
 *   3. unquoted      — up to a safe delimiter or end of line
 *
 * An unquoted value is ambiguous: "password: correct horse battery" could be
 * three words of one passphrase or one word followed by prose. It is read as
 * the passphrase and masked to the delimiter, because over-masking a stored
 * copy is recoverable and under-masking a credential is not. Escaped quotes
 * (`\"secret\"`, as a serializer would write them) fall into the unquoted
 * branch and are masked with their backslashes.
 *
 * There is no minimum length: `password=abc` is as much a credential as a
 * 40-character token. The benign-value allowlist, not a length floor, is what
 * keeps "password: required" readable.
 */
const VALUE = '(?:"([^"\\n]{1,256})"|\'([^\'\\n]{1,256})\'|([^\\s,;)}\\]\\n][^,;)}\\]\\n]{0,255}))';
const VALUE_GROUPS = [1, 2, 3];

// Keywords that declare a credential. Shared by the assignment and CLI-flag
// shapes so both stay in step.
const KV_KEYWORDS = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret';

const RULES = [
  // ── HIGH ──────────────────────────────────────────────────────────────
  { name: 'private-key', tier: 'high', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { name: 'aws-akia',     tier: 'high', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'gcp-api',      tier: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'github-pat',   tier: 'high', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: 'github-token', tier: 'high', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'anthropic',    tier: 'high', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI keys come in two real shapes: sk-proj-<token> (project keys,
  // hyphens/underscores allowed in the body) and legacy sk-<base62, 40+>.
  // The body class must NOT allow hyphens after a bare `sk-` — ordinary
  // hyphenated slugs ("sk-refactor-the-database-layer") would auto-redact
  // at high tier, irreversibly destroying user/bot text. `sk-ant-` and
  // `sk-proj-` can't reach the legacy rule: their 3-4 alnum chars end at
  // a hyphen long before the 40-char floor.
  { name: 'openai',       tier: 'high', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  // Review (security + adversarial): sk-proj- isn't the only hyphenated-
  // prefix shape OpenAI issues — service-account and admin keys follow the
  // same pattern and were slipping past undetected after the tighten above.
  { name: 'openai',       tier: 'high', re: /\bsk-(?:svcacct|admin)-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai',       tier: 'high', re: /\bsk-[A-Za-z0-9]{40,}\b/g },
  { name: 'slack',        tier: 'high', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe',       tier: 'high', re: /\bsk_live_[A-Za-z0-9]{20,}\b/g },
  { name: 'tg-bot-token', tier: 'high', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  // `d` flag (hasIndices) on group rules so we splice the exact capture-group
  // span — NOT the first incidental occurrence of the value substring, which
  // mislocates when the value also appears inside the key (e.g. the literal
  // `secret` in `client_secret=secret`). See detectSecrets.
  { name: 'bearer',       tier: 'high', re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/gid, group: 1 },
  // ── MEDIUM ────────────────────────────────────────────────────────────
  { name: 'jwt',          tier: 'medium', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // ── LOW (flag only) ───────────────────────────────────────────────────
  // `token` is included in the ASSIGNMENT form only (`--token=…`, `token: …`):
  // a bare noun in prose usually describes auth state, but an assignment to it
  // is a credential. The plural ("tokens: 1500") can't match — \b requires a
  // boundary right after the word.
  // Two assignment shapes: `key: value` / `key=value`, and the CLI flag form
  // `--password value`. The flag form requires the leading dash, so ordinary
  // prose ("password required") cannot reach it — only a command line can.
  // `--password-file /etc/x` is not a hit: the character after the keyword
  // must be `=` or a space.
  { name: 'kv-secret',    tier: 'low', re: new RegExp(`(?:\\b(?:${KV_KEYWORDS})\\b\\s*[:=]\\s*|(?:^|[\\s"'])--?(?:${KV_KEYWORDS})[=\\s]\\s*)${VALUE}`, 'gid'), groups: VALUE_GROUPS },
  // Prose form of the same declaration ("my password is hunter2"). Kept
  // deliberately tight — a credential noun immediately followed by is/was and
  // the value. Free prose that never names the credential is NOT detectable
  // here; the shape must be declared for this rule to fire.
  { name: 'prose-secret', tier: 'low', re: new RegExp(`\\b(?:password|passphrase|passwd|api[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret)\\s+(?:is|was)\\s+${VALUE}`, 'gid'), groups: VALUE_GROUPS },
];

/**
 * Values a low-tier rule may capture that are ordinary vocabulary, not
 * credentials ("password: required"). Deliberately small and deterministic:
 * everything not listed here is masked at the durable boundary, so growing
 * this list is the only way to weaken it. Compared case-insensitively against
 * the FIRST word of the captured value, after trailing punctuation is
 * trimmed, so a benign word introducing prose ("password: required for the
 * staging box") is recognized even though the captured span runs on.
 */
const DURABLE_VALUE_ALLOWLIST = new Set([
  'required', 'optional', 'unknown', 'missing', 'hidden', 'redacted',
  // "correct" is deliberately absent: it opens "correct horse battery
  // staple", the canonical passphrase shape, through the first-word check.
  'omitted', 'enabled', 'disabled', 'expired', 'invalid',
  'incorrect', 'rotated', 'changed', 'unchanged', 'unset',
  // Short forms, reachable now that an explicit assignment has no length floor.
  'true', 'false', 'yes', 'no', 'none', 'null', 'nil', 'empty', 'blank',
  'n/a', 'na', 'tbd', 'todo', 'set', 'ok',
]);

// A value already replaced by this module. Allowlisted so masking a text
// twice yields the same text instead of nesting placeholders.
const PLACEHOLDER_VALUE = /^‹redacted:[a-z-]+›$/;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"–—]+$/;

/**
 * Field names that declare a credential in structured data. Matched on the
 * key with separators and case removed, and by SUFFIX, so `DB_PASSWORD`,
 * `apiKey`, `x-api-key` and `client_secret` all count while `cache_key` and
 * `sort_key` do not — `key` alone is not a credential noun. A trailing plural
 * is folded in (`secrets`, `tokens`).
 *
 * A pagination cursor named `next_token` is masked by this rule. That is the
 * intended direction: over-masking a stored copy is recoverable, and the
 * live value the caller passes is never touched.
 */
const CREDENTIAL_KEY_SUFFIXES = [
  'password', 'passwd', 'pwd', 'passphrase', 'secret', 'token',
  'apikey', 'accesstoken', 'authtoken', 'clientsecret', 'refreshtoken',
  'privatekey', 'credential',
];

function isCredentialKey(key) {
  if (typeof key !== 'string' || !key) return false;
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
  return CREDENTIAL_KEY_SUFFIXES.some((noun) => normalized.endsWith(noun));
}

function isAllowedDurableValue(value) {
  const bare = String(value).trim().replace(TRAILING_PUNCTUATION, '');
  if (PLACEHOLDER_VALUE.test(bare)) return true;
  const firstWord = bare.split(/\s+/)[0].replace(TRAILING_PUNCTUATION, '');
  return DURABLE_VALUE_ALLOWLIST.has(firstWord.toLowerCase());
}

/**
 * Detect secrets in `text`. Returns non-overlapping detections ordered by
 * position, each {rule, tier, start, end, value}. On overlap, the earlier /
 * higher-tier match wins.
 */
function detectSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0] === '') { rule.re.lastIndex += 1; continue; } // guard zero-width
      let start = m.index;
      let value = m[0];
      // `group` names one capture; `groups` names alternatives (a value can be
      // double-quoted, single-quoted or bare) of which exactly one matches.
      const candidates = rule.groups || (rule.group ? [rule.group] : []);
      const g = candidates.find((n) => m[n] != null);
      if (g != null) {
        // Exact group span from the `d` flag (m.indices). Fall back to
        // lastIndexOf (the captured value sits at the TAIL of these matches,
        // so the last occurrence is the right one) if indices are unavailable.
        const span = m.indices && m.indices[g];
        if (span) {
          start = span[0]; value = m[g];
        } else {
          const off = m[0].lastIndexOf(m[g]);
          if (off >= 0) { start = m.index + off; value = m[g]; }
        }
        // Trailing whitespace belongs to the sentence, not the credential.
        const trimmed = value.replace(/\s+$/, '');
        value = trimmed;
      }
      hits.push({ rule: rule.name, tier: rule.tier, start, end: start + value.length, value });
    }
  }
  // Resolve overlaps: sort by start asc, then high>medium>low, then longer first.
  const tierRank = { high: 0, medium: 1, low: 2 };
  hits.sort((a, b) => a.start - b.start || tierRank[a.tier] - tierRank[b.tier] || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start >= lastEnd) { out.push(h); lastEnd = h.end; }
  }
  return out;
}

/**
 * Redact a text. By default redacts `high` + `medium` tiers in place (low is
 * flagged, not redacted). Idempotent: the placeholder never re-matches a rule.
 *
 * Records are content-free: rule, tier and length only. No digest of the
 * value is produced anywhere in this module — an unsalted hash of a guessable
 * secret is a correlation handle for that secret.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]} [opts.redactTiers]  tiers to actually redact (default high+medium)
 * @returns {{ text:string, changed:boolean, redacted:Array<{rule,tier,length}>, flagged:Array<{rule,tier,length}> }}
 */
function redactText(text, opts = {}) {
  const redactTiers = new Set(opts.redactTiers || ['high', 'medium']);
  const dets = detectSecrets(text);
  const redacted = [];
  const flagged = [];
  // apply right-to-left so earlier indices stay valid
  let out = text;
  for (let i = dets.length - 1; i >= 0; i--) {
    const d = dets[i];
    const rec = { rule: d.rule, tier: d.tier, length: d.value.length };
    if (redactTiers.has(d.tier)) {
      out = out.slice(0, d.start) + PLACEHOLDER(d.rule) + out.slice(d.end);
      redacted.push(rec);
    } else {
      flagged.push(rec);
    }
  }
  redacted.reverse(); flagged.reverse();
  return { text: out, changed: redacted.length > 0, redacted, flagged };
}

/**
 * Mask a text for DURABLE storage. Unlike redactText (which mirrors the
 * sweep's "low tier is flagged, a human confirms"), this is the pre-write
 * boundary: a low-tier hit is an actual-or-unresolved credential and is masked
 * unless its value is in the narrow allowlist. Callers pass the ORIGINAL text
 * to the live turn and only the returned text to SQLite/FTS.
 *
 * The returned records are content-free — rule/tier only, no value, length or
 * fingerprint — so nothing secret-derived travels with them.
 *
 * @param {string} text
 * @returns {{ text:string, changed:boolean, masked:Array<{rule,tier}>, allowed:Array<{rule,tier}> }}
 */
function sanitizeForDurableWrite(text) {
  if (typeof text !== 'string' || !text) {
    return { text, changed: false, masked: [], allowed: [] };
  }
  const dets = detectSecrets(text);
  const masked = [];
  const allowed = [];
  // apply right-to-left so earlier indices stay valid
  let out = text;
  for (let i = dets.length - 1; i >= 0; i--) {
    const d = dets[i];
    if (d.tier === 'low' && isAllowedDurableValue(d.value)) {
      allowed.push({ rule: d.rule, tier: d.tier });
      continue;
    }
    out = out.slice(0, d.start) + PLACEHOLDER(d.rule) + out.slice(d.end);
    masked.push({ rule: d.rule, tier: d.tier });
  }
  masked.reverse(); allowed.reverse();
  return { text: out, changed: masked.length > 0, masked, allowed };
}

// A structure deeper than this is malformed rather than legitimate payload,
// and is dropped instead of walked.
const MAX_STRUCTURE_DEPTH = 12;

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const DROP = Symbol('drop');

/**
 * Mask every string reachable in a structured payload, returning a new value
 * with the same shape. The caller's object is never mutated, so the live turn
 * keeps its original.
 *
 * Sanitize BEFORE serialization, never after: `JSON.stringify` escapes the
 * quotes around a declared value, and the escaped form no longer looks like a
 * quoted value to the detector — a credential that would be caught in the
 * object survives in the string. Masking the serialized form can also splice
 * across JSON delimiters.
 *
 * Only plain objects and arrays are walked. Anything else that is not a
 * primitive — a Date, a Map, a class instance, a function — is DROPPED rather
 * than passed through, because its serialized form is not something this
 * module can inspect.
 */
function sanitizeDurableStructured(value) {
  const walk = (v, depth, underCredential) => {
    if (typeof v === 'string') {
      // A structured payload declares the credential in the KEY, so the value
      // carries no `password:` prefix for the text rules to find:
      // `{"password":"hunter2"}` is as much a declaration as
      // `password: hunter2`. The key is the declaration here, and the whole
      // value is the credential.
      //
      // The declaration also covers what is nested under it —
      // `{"password":{"value":"…"}}` and `{"credentials":[…]}` wrap the same
      // claim — so the context travels down to every string leaf. This
      // over-masks a benign sibling under a credential key; that is the
      // chosen direction, because the stored copy is recoverable from the
      // live turn and an unmasked credential is not.
      if (underCredential && !isAllowedDurableValue(v)) {
        return PLACEHOLDER('kv-secret');
      }
      return sanitizeForDurableWrite(v).text;
    }
    // A BigInt has no JSON representation: leaving it in place makes the whole
    // document throw at serialization, which loses the write with no record.
    if (typeof v === 'bigint') return DROP;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (depth >= MAX_STRUCTURE_DEPTH) return DROP;
    if (Array.isArray(v)) {
      // An array under a credential key inherits it: `{"passwords":["a","b"]}`
      // declares every element.
      return v.map((item) => {
        const walked = walk(item, depth + 1, underCredential);
        return walked === DROP ? null : walked;
      });
    }
    if (isPlainObject(v)) {
      const out = {};
      for (const [k, item] of Object.entries(v)) {
        const walked = walk(item, depth + 1, underCredential || isCredentialKey(k));
        if (walked === DROP || walked === undefined) continue;
        // A key can carry a secret of its own — a payload keyed by a token,
        // or a stringified assignment used as a field name. Only a key with a
        // detectable signal is rewritten; ordinary keys are left exactly as
        // they are, so shapes stay recognizable.
        const safeKey = sanitizeForDurableWrite(k).text;
        if (safeKey !== k && Object.prototype.hasOwnProperty.call(out, safeKey)) continue;
        out[safeKey] = walked;
      }
      return out;
    }
    return DROP;
  };
  const walked = walk(value, 0, false);
  if (walked === DROP || walked === undefined) return isPlainObject(value) ? {} : {};
  return walked;
}

/**
 * Sanitize text that is expected to be a serialized JSON document: parse it,
 * sanitize the structure, and reserialize. A caller that hands over an
 * already-serialized payload gets the same treatment as one that hands over
 * the object — including key-aware masking, which a text pass cannot do.
 *
 * Text that is not a JSON document (a shell command, a plain string) falls
 * back to text masking, so nothing is lost by trying.
 *
 * @returns {{ text:string, changed:boolean }} `changed` compares against a
 *          reserialization of the same parse, so reformatting alone never
 *          counts as a change — callers key dedupe decisions on it.
 */
function sanitizeDurableJsonText(text) {
  if (typeof text !== 'string') return { text, changed: false };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return textResult(text); }
  if (parsed === null || typeof parsed !== 'object') return textResult(text);
  const baseline = JSON.stringify(parsed);
  const sanitized = JSON.stringify(sanitizeDurableStructured(parsed));
  return { text: sanitized, changed: sanitized !== baseline };
}

function textResult(text) {
  const res = sanitizeForDurableWrite(text);
  return { text: res.text, changed: res.changed };
}

module.exports = {
  detectSecrets,
  redactText,
  sanitizeForDurableWrite,
  sanitizeDurableStructured,
  sanitizeDurableJsonText,
  RULES,
  PLACEHOLDER,
  DURABLE_VALUE_ALLOWLIST,
};

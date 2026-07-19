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
 */

const crypto = require('crypto');

const PLACEHOLDER = (rule) => `‹redacted:${rule}›`; // ‹redacted:rule› — never re-matches a rule

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
  { name: 'kv-secret',    tier: 'low', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"']{6,})/gid, group: 1 },
];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

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
      if (rule.group && m[rule.group] != null) {
        // Exact group span from the `d` flag (m.indices). Fall back to
        // lastIndexOf (the captured value sits at the TAIL of these matches,
        // so the last occurrence is the right one) if indices are unavailable.
        const span = m.indices && m.indices[rule.group];
        if (span) {
          start = span[0]; value = m[rule.group];
        } else {
          const off = m[0].lastIndexOf(m[rule.group]);
          if (off >= 0) { start = m.index + off; value = m[rule.group]; }
        }
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
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]} [opts.redactTiers]  tiers to actually redact (default high+medium)
 * @returns {{ text:string, changed:boolean, redacted:Array<{rule,tier,length,sha256}>, flagged:Array<{rule,tier,length,sha256}> }}
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
    const rec = { rule: d.rule, tier: d.tier, length: d.value.length, sha256: sha256(d.value) };
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

module.exports = { detectSecrets, redactText, sha256, RULES, PLACEHOLDER };

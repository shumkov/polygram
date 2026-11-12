'use strict';

// The rules the daemon enforces on messages between role sessions, as pure
// functions over configuration and already-read facts. Storage and delivery
// live in store.js and service.js.

const { createHash } = require('node:crypto');
const { sanitizeDurableStructured } = require('../secret-detect');

const ROLE_ID = /^[a-z][a-z0-9_-]*$/;
const MAILBOX_KEYS = ['enabled', 'roles', 'allow', 'mirror', 'limits', 'systemSenders'];
// The maxBodyBytes default is also the ceiling: a mirrored body plus its
// header must fit one Telegram message.
const DEFAULT_LIMITS = Object.freeze({ maxDepth: 2, perPairPerHour: 10, maxBodyBytes: 3500, systemPerHour: 60 });
const MAX_BODY_BYTES = 3500;
// Where each message is posted: nowhere, the target role's topic, or the
// target's and the sending role's topics.
const MIRROR_MODES = new Map([[false, false], [true, 'target'], ['target', 'target'], ['both', 'both']]);
const MAX_ABOUT = 300;
const MAX_KEY_BYTES = 256;
const MAX_REF_BYTES = 512;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const SYSTEM_ADDRESS = 'system:polygram';
// The daemon's own notices come from system:polygram, so no configured
// sender may take that name.
const RESERVED_SENDER = 'polygram';

// A refusal a caller outside the daemon must classify (retry later or give
// up) carries one of these codes. The strings are a contract with those
// callers, so they never change.
const REFUSAL = Object.freeze({
  disabled: 'MAILBOX_DISABLED',
  unknownRole: 'MAILBOX_UNKNOWN_ROLE',
  tooLarge: 'MAILBOX_TOO_LARGE',
  rateLimited: 'MAILBOX_RATE_LIMITED',
  notSystemSender: 'MAILBOX_NOT_SYSTEM_SENDER',
  keyConflict: 'MAILBOX_KEY_CONFLICT',
});
const refusal = (code, message) => Object.assign(new Error(message), { code });

const roleAddress = (name) => `role:${name}`;
const bodyHash = (cleanText) => createHash('sha256').update(cleanText).digest('hex');
const systemAddress = (name) => `system:${name}`;
const roleFromAddress = (address) => (typeof address === 'string' && address.startsWith('role:') ? address.slice(5) : null);

// Returns null when the mailbox is absent or not explicitly enabled, so a bot
// without a `mailbox` key behaves exactly as before. Any other problem is a
// configuration error and throws, failing boot.
function readMailboxConfig(bot, resolveTarget) {
  const settings = bot?.mailbox;
  if (settings?.enabled !== true) return null;
  for (const key of Object.keys(settings)) {
    if (!MAILBOX_KEYS.includes(key)) throw new Error(`Unknown mailbox key ${key}: use ${MAILBOX_KEYS.join(', ')}`);
  }
  const jobs = bot.externalJobs;
  if (jobs?.enabled !== true) throw new Error('Mailbox requires enabled external jobs');
  const roles = new Map();
  const sessions = new Map();
  for (const [name, entry] of Object.entries(settings.roles || {})) {
    if (!ROLE_ID.test(name)) throw new Error(`Invalid mailbox role name ${JSON.stringify(name)}: use lowercase letters, digits, - and _`);
    const about = entry?.about ?? '';
    if (typeof about !== 'string' || about.length > MAX_ABOUT) throw new Error(`Invalid mailbox role about text for ${name}`);
    const route = Object.hasOwn(jobs.routes || {}, name) ? jobs.routes[name] : null;
    if (!route || route.enabled === false) throw new Error(`Mailbox role ${name} has no enabled external-job route`);
    let target;
    try { target = resolveTarget(route, name); }
    catch (error) { throw new Error(`Mailbox role ${name}: ${error.message}`); }
    if (sessions.has(target.sessionKey)) throw new Error(`Mailbox roles ${sessions.get(target.sessionKey)} and ${name} share a session`);
    sessions.set(target.sessionKey, name);
    roles.set(name, Object.freeze({ name, about: about.trim(), routeId: name, target }));
  }
  const allow = new Map();
  for (const [from, list] of Object.entries(settings.allow || {})) {
    if (!roles.has(from) || !Array.isArray(list) || list.some((to) => to !== '*' && !roles.has(to))) {
      throw new Error(`Invalid mailbox allow entry for ${JSON.stringify(from)}: list configured roles or "*"`);
    }
    allow.set(from, new Set(list));
  }
  const systemSenders = settings.systemSenders ?? [];
  if (!Array.isArray(systemSenders) || systemSenders.some((name) => typeof name !== 'string' || !ROLE_ID.test(name))
    || new Set(systemSenders).size !== systemSenders.length) {
    throw new Error('Invalid mailbox systemSenders: list distinct names of lowercase letters, digits, - and _');
  }
  if (systemSenders.includes(RESERVED_SENDER)) throw new Error(`Invalid mailbox systemSenders: ${RESERVED_SENDER} is reserved for the daemon's own notices`);
  // `true` predates the sender line and keeps meaning the target topic only.
  const mirror = MIRROR_MODES.get(settings.mirror ?? true);
  if (mirror === undefined) throw new Error('Mailbox mirror must be true, false, "target" or "both"');
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(settings.limits || {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid mailbox limit ${key}`);
    limits[key] = value;
  }
  if (limits.maxBodyBytes > MAX_BODY_BYTES) throw new Error(`Invalid mailbox limit maxBodyBytes: at most ${MAX_BODY_BYTES}`);
  return Object.freeze({
    roles, mirror, limits: Object.freeze(limits), systemSenders: new Set(systemSenders),
    roleForSession: (sessionKey) => sessions.get(sessionKey) ?? null,
    allowed: (from, to) => from !== to && roles.has(to) && (allow.get(from)?.has('*') || allow.get(from)?.has(to) || false),
  });
}

// An ask or tell may only go to another configured role on the sender's
// allowlist. Replies are checked by checkReply instead.
function checkStart(cfg, { from, to, kind }) {
  if (kind !== 'ask' && kind !== 'tell') throw new Error('Message kind must be ask or tell');
  if (typeof to !== 'string' || !cfg.roles.has(to)) throw refusal(REFUSAL.unknownRole, 'Unknown role');
  if (from === to) throw new Error('A role cannot message itself');
  if (!cfg.allowed(from, to)) throw new Error(`${roleAddress(from)} is not allowed to message ${roleAddress(to)}`);
}

function nextDepth(currentDepth, maxDepth) {
  const depth = currentDepth + 1;
  if (depth > maxDepth) throw new Error(`Depth limit ${maxDepth} reached: this turn can reply but cannot start a new message`);
  return depth;
}

function checkRate(recentCount, perPairPerHour) {
  if (recentCount >= perPairPerHour) throw refusal(REFUSAL.rateLimited, `Rate limit reached: at most ${perPairPerHour} asks and tells per role pair per hour`);
}

function checkSystemRate(recentCount, systemPerHour) {
  if (recentCount >= systemPerHour) throw refusal(REFUSAL.rateLimited, `Rate limit reached: at most ${systemPerHour} messages per system sender per hour`);
}

function checkSystemSender(cfg, sender) {
  if (typeof sender !== 'string' || !cfg.systemSenders.has(sender)) throw refusal(REFUSAL.notSystemSender, 'Not a system sender listed in mailbox.systemSenders');
  return sender;
}

function checkKey(key) {
  if (typeof key !== 'string' || !key || Buffer.byteLength(key) > MAX_KEY_BYTES) throw new Error(`Idempotency key required: a string of 1 to ${MAX_KEY_BYTES} bytes`);
  return key;
}

const redact = (text) => sanitizeDurableStructured({ body: text }).body;

// An opaque reference the sender attaches. It is stored and shown to the
// receiving session, so it is redacted like a body.
function cleanRef(ref) {
  if (ref === undefined || ref === null) return null;
  if (typeof ref !== 'string' || !ref.trim() || Buffer.byteLength(ref) > MAX_REF_BYTES) throw new Error(`Invalid ref: a string of 1 to ${MAX_REF_BYTES} bytes`);
  return redact(ref);
}

function requireBody(body) {
  if (typeof body !== 'string' || !body.trim()) throw new Error('Message body required');
  return body;
}

// The hash a body is stored under: of its redacted text, so two bodies that
// differ only in a secret are the same message.
const redactedBodyHash = (body) => bodyHash(redact(requireBody(body)));

// Redaction happens before anything is persisted, hashed or mirrored, and the
// redacted text must still fit, because placeholders can be longer than what
// they replace.
function cleanBody(body, maxBodyBytes) {
  requireBody(body);
  if (Buffer.byteLength(body) > maxBodyBytes) throw refusal(REFUSAL.tooLarge, `Message body exceeds ${maxBodyBytes} bytes`);
  const clean = redact(body);
  if (Buffer.byteLength(clean) > maxBodyBytes) throw refusal(REFUSAL.tooLarge, `Redacted message body exceeds ${maxBodyBytes} bytes`);
  return clean;
}

function checkReply({ ask, caller, replied }) {
  if (!ask) throw new Error('No such ask');
  if (ask.kind !== 'ask') throw new Error('That message is not an ask');
  if (ask.to_addr !== roleAddress(caller)) throw new Error('That ask is not addressed to this role');
  if (replied) throw new Error('That ask already has a reply');
}

module.exports = {
  readMailboxConfig, checkStart, nextDepth, checkRate, cleanBody, bodyHash, checkReply,
  checkSystemSender, checkSystemRate, checkKey, cleanRef, requireBody, redactedBodyHash,
  roleAddress, systemAddress, roleFromAddress, SYSTEM_ADDRESS, DEFAULT_LIMITS, RATE_WINDOW_MS, DUPLICATE_WINDOW_MS, REFUSAL, refusal,
};

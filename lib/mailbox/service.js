'use strict';

const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const rules = require('./rules');
const { createMailboxStore } = require('./store');

const SCRIPT = path.resolve(__dirname, '../../skills/mailbox/scripts/msg.js');
const MAILBOX_REQUEST = 'mailbox:';
const NOTICE_REQUEST = 'mailbox-notice:';

function checkFields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Mailbox input object required');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown mailbox field: ${key}`);
}

// Messages between role sessions. Each role session holds one in-memory token
// that resolves to its role and to the depth of the last prompt polygram sent
// it, so the daemon, never the agent, decides who is speaking and how deep
// the conversation already is.
function createMailboxService({ config, db, botName, jobs, resolveTarget, now = Date.now }) {
  const cfg = rules.readMailboxConfig(config.bot, resolveTarget);
  const raw = db?.raw;
  const store = cfg ? createMailboxStore(raw, { botName, now }) : null;
  const tokens = new Map();
  const tokenBySession = new Map();
  const depths = new Map();
  const transaction = (fn) => raw.transaction(fn).immediate();
  const requireEnabled = () => { if (!cfg) throw new Error('Mailbox is disabled'); };
  const roleOf = (sessionKey) => cfg?.roleForSession(sessionKey) ?? null;

  function caller(token) {
    const sessionKey = typeof token === 'string' ? tokens.get(token) : undefined;
    const role = sessionKey ? roleOf(sessionKey) : null;
    if (!role) throw new Error('Mailbox token is not valid; use the command from your current turn');
    // A session that has not been prompted since boot can only reply.
    return { role, depth: depths.get(sessionKey) ?? cfg.limits.maxDepth };
  }
  function receipt(row, extra = {}) {
    const target = cfg.roles.get(row.route_id)?.target;
    return { id: row.id, state: target && jobs.isPaused(target.sessionKey) ? 'paused' : 'queued', ...extra };
  }
  function record(message) {
    return store.insert({ ...message, id: `m_${randomBytes(8).toString('hex')}` });
  }

  const api = {
    enabled: cfg !== null,
    scope(sessionKey) {
      if (!roleOf(sessionKey)) return null;
      let token = tokenBySession.get(sessionKey);
      if (!token) { token = randomUUID(); tokens.set(token, sessionKey); tokenBySession.set(sessionKey, token); }
      return token;
    },
    // An inbound human message: the human is in the loop, so the turn may
    // start a fresh chain.
    noteHumanPrompt(sessionKey) {
      if (roleOf(sessionKey)) depths.set(sessionKey, 0);
    },
    // Called at the moment an external job's prompt is actually sent. A
    // mailbox delivery carries its message depth; every other job, notices
    // included, gets maxDepth so its turn can reply but not start a chain.
    noteJobSend(job) {
      const sessionKey = job?.target?.sessionKey;
      if (!roleOf(sessionKey)) return;
      const id = typeof job.requestId === 'string' && job.requestId.startsWith(MAILBOX_REQUEST) ? job.requestId.slice(MAILBOX_REQUEST.length) : null;
      const row = id ? store.get(id) : null;
      depths.set(sessionKey, row && row.route_id === job.routeId ? row.depth : cfg.limits.maxDepth);
    },
    instructions(sessionKey) {
      const role = roleOf(sessionKey);
      if (!role) return '';
      const command = [process.execPath, SCRIPT, botName, api.scope(sessionKey)].map((part) => JSON.stringify(part)).join(' ');
      const targets = [...cfg.roles.values()].filter((other) => cfg.allowed(role, other.name))
        .map((other) => (other.about ? `${other.name} (${other.about})` : other.name));
      return `\nInter-session mailbox: you are role:${role} in an organization of agent sessions. Roles you may message: ${targets.length ? targets.join('; ') : 'none (you can still reply to asks you receive)'}.`
        + ` Ask or tell another role: run ${command} send '{"to":"<role>","kind":"ask","body":"..."}' (kind "tell" expects no reply).`
        + ` Reply to an ask you received: run ${command} reply '{"id":"<message id>","body":"..."}'.`
        + ' An ask states the answer you need; do not hand work off through the mailbox yet. Send summaries and file paths, never transcripts.'
        + ' Reply exactly once to each ask you receive. Replies arrive as a new turn after your turn ends, so never wait or poll for them.\n';
    },
    send(token, input) {
      requireEnabled();
      const from = caller(token);
      checkFields(input, ['to', 'kind', 'body']);
      rules.checkStart(cfg, { from: from.role, to: input.to, kind: input.kind });
      const body = rules.cleanBody(input.body, cfg.limits.maxBodyBytes);
      const hash = rules.bodyHash(body);
      const fromAddr = rules.roleAddress(from.role);
      const toAddr = rules.roleAddress(input.to);
      return transaction(() => {
        const duplicate = store.findDuplicate(fromAddr, toAddr, hash, now() - rules.DUPLICATE_WINDOW_MS);
        if (duplicate) return receipt(duplicate, { duplicate: true });
        const depth = rules.nextDepth(from.depth, cfg.limits.maxDepth);
        rules.checkRate(store.countPair(fromAddr, toAddr, now() - rules.RATE_WINDOW_MS), cfg.limits.perPairPerHour);
        return receipt(record({ kind: input.kind, from: fromAddr, to: toAddr, routeId: input.to, body, inReplyTo: null, depth, bodyHash: hash }));
      });
    },
    reply(token, input) {
      requireEnabled();
      const from = caller(token);
      checkFields(input, ['inReplyTo', 'body']);
      const body = rules.cleanBody(input.body, cfg.limits.maxBodyBytes);
      const hash = rules.bodyHash(body);
      const fromAddr = rules.roleAddress(from.role);
      return transaction(() => {
        const ask = typeof input.inReplyTo === 'string' ? store.get(input.inReplyTo) : null;
        const existing = ask ? store.replyTo(ask.id) : null;
        // A retried reply with the same text returns the stored one.
        if (existing && existing.from_addr === fromAddr && existing.body_hash === hash) return receipt(existing, { duplicate: true });
        rules.checkReply({ ask, caller: from.role, replied: existing !== null });
        const asker = rules.roleFromAddress(ask.from_addr);
        if (!cfg.roles.has(asker)) throw new Error('The asking role is no longer configured');
        return receipt(record({ kind: 'reply', from: fromAddr, to: ask.from_addr, routeId: asker, body, inReplyTo: ask.id, depth: ask.depth, bodyHash: hash }));
      });
    },
  };
  return api;
}

module.exports = { createMailboxService, MAILBOX_REQUEST, NOTICE_REQUEST };

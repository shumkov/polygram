'use strict';

const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const rules = require('./rules');
const envelope = require('./envelope');
const { createMailboxStore } = require('./store');

const SCRIPT = path.resolve(__dirname, '../../skills/mailbox/scripts/msg.js');
const MAILBOX_REQUEST = 'mailbox:';
const NOTICE_REQUEST = 'mailbox-notice:';
const POLL_MS = 5000;
const RETRY_MS = 60000;
const RETRY_MAX_MS = 30 * 60000;
const SETTLED = new Set(['succeeded', 'failed', 'interrupted', 'unknown']);

const isMailboxRequest = (requestId) => typeof requestId === 'string'
  && (requestId.startsWith(MAILBOX_REQUEST) || requestId.startsWith(NOTICE_REQUEST));

function checkFields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Mailbox input object required');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown mailbox field: ${key}`);
}

// Messages between role sessions. Each role session holds one in-memory token
// that resolves to its role and to the depth of the last prompt polygram sent
// it, so the daemon, never the agent, decides who is speaking and how deep
// the conversation already is.
// `ipcDir` is the daemon's IPC runtime directory. The agent's command carries
// it because a CLI session inherits its environment from whoever started the
// tmux server, which is often not the daemon; msg.js then finds the socket
// and the 0600 secret file there.
function createMailboxService({ config, db, botName, jobs, resolveTarget, bot = null, tg = null, ipcDir = null, now = Date.now, logger = console }) {
  const cfg = rules.readMailboxConfig(config.bot, resolveTarget);
  const raw = db?.raw;
  const store = cfg ? createMailboxStore(raw, { botName, now }) : null;
  const tokens = new Map();
  const tokenBySession = new Map();
  const depths = new Map();
  const transaction = (fn) => raw.transaction(fn).immediate();
  const requireEnabled = () => { if (!cfg) throw rules.refusal(rules.REFUSAL.disabled, 'Mailbox is disabled'); };
  const roleOf = (sessionKey) => cfg?.roleForSession(sessionKey) ?? null;
  let started = false;
  let timer = null;
  let polling = null;
  const retries = new Map();
  const waiting = (key) => (retries.get(key)?.at ?? 0) > now();
  function backOff(key) {
    const attempts = (retries.get(key)?.attempts ?? 0) + 1;
    retries.set(key, { attempts, at: now() + Math.min(RETRY_MS * 2 ** (attempts - 1), RETRY_MAX_MS) });
  }

  function caller(token) {
    const sessionKey = typeof token === 'string' ? tokens.get(token) : undefined;
    const role = sessionKey ? roleOf(sessionKey) : null;
    if (!role) throw new Error('Mailbox token is not valid; use the command from your current turn');
    // A session that has not been prompted since boot can only reply.
    return { role, depth: depths.get(sessionKey) ?? cfg.limits.maxDepth };
  }
  // The message's real delivery state, so a retried send whose first
  // delivery already failed, was withdrawn or became uncertain says so.
  function receipt(row, extra = {}) {
    const { job } = jobs.get({ routeId: row.route_id, requestId: MAILBOX_REQUEST + row.id });
    return { id: row.id, state: job.state === 'queued' && job.paused ? 'paused' : job.state, ...extra };
  }
  function record(message) {
    return store.insert({ ...message, id: `m_${randomBytes(8).toString('hex')}` });
  }
  // Runs inside the caller's transaction, so a refused submit also rolls the
  // message row back and the refusal reaches the sender synchronously.
  function deliver(row, ask = null) {
    jobs.submit({ routeId: row.route_id, requestId: MAILBOX_REQUEST + row.id, task: envelope.renderTask(row), payload: envelope.renderPayload(row, ask) });
  }
  // Posted once, after the message commits, never from the dispatch path,
  // which retries on deferral. A failed post is logged and never blocks
  // delivery or the other post; the target's final text reaches the same
  // topic as the job report. Only a role sender has a topic of its own.
  function mirror(row) {
    if (!cfg.mirror || !tg) return;
    post(cfg.roles.get(row.route_id)?.target, envelope.renderMirror(row), 'mailbox-mirror', `mirror of ${row.id}`);
    if (cfg.mirror === 'both') {
      const sender = rules.roleFromAddress(row.from_addr);
      post(sender ? cfg.roles.get(sender)?.target : null, envelope.renderSenderMirror(row), 'mailbox-sender-mirror', `sender mirror of ${row.id}`);
    }
  }
  function post(target, text, source, what) {
    if (!target) return;
    Promise.resolve()
      .then(() => tg(bot, 'sendMessage', { chat_id: target.chatId, ...(target.threadId == null ? {} : { message_thread_id: target.threadId }), text },
        { source, botName, sessionKey: target.sessionKey, plainText: true, strictDestination: true }))
      // Telegram's description is API text, not message content.
      .catch((error) => logger.error?.(`[mailbox] ${what} failed: ${error?.error_code ?? error?.code ?? error?.name ?? 'Error'}${error?.description ? ` ${error.description}` : ''}`));
  }
  // Only a missing job means "not there"; any other lookup failure is
  // rethrown so the caller holds the work instead of guessing.
  function lookup(routeId, requestId) {
    try { return jobs.get({ routeId, requestId }).job; }
    catch (error) { if (error?.code === 'EXTERNAL_JOB_NOT_FOUND') return null; throw error; }
  }
  const held = (what, error) => logger.error?.(`[mailbox] ${what} held: ${error?.code || error?.name || 'Error'}`);
  // A notice about an ask is keyed on the ask; one about a reply that never
  // arrived is keyed on the reply, so a late reply that fails after a "no
  // reply" notice is still reported. Either marks the ask as notified.
  function notify(ask, requestId, task, payload) {
    const routeId = rules.roleFromAddress(ask.from_addr);
    transaction(() => {
      if (!lookup(routeId, requestId)) jobs.submit({ routeId, requestId, task, payload });
      store.markNoticeSent(ask.id);
    });
  }
  // One notice per open ask once its delivery job has settled, and a
  // recovery probe for every mailbox-owned job left unknown, so an uncertain
  // turn does not block its session's queue. Neither ever replays a message.
  // Every failure is logged with its ids and code and backs off, from one
  // minute up to thirty, so a stuck item never retries on every poll.
  async function poll() {
    const live = new Set();
    for (const ask of store.noticeCandidates()) {
      if (!started) return;
      const key = `notice:${ask.id}`;
      live.add(key);
      if (waiting(key)) continue;
      try {
        const delivery = lookup(ask.route_id, MAILBOX_REQUEST + ask.id);
        if (!delivery) throw Object.assign(new Error('Ask delivery job is missing'), { code: 'MAILBOX_DELIVERY_MISSING' });
        if (!SETTLED.has(delivery.state)) continue;
        notify(ask, NOTICE_REQUEST + ask.id, envelope.renderNoticeTask(ask, delivery.state), envelope.renderNoticePayload(ask, delivery));
        retries.delete(key);
      } catch (error) { backOff(key); held(`notice for ask ${ask.id}`, error); }
    }
    for (const row of store.undeliveredReplies()) {
      if (!started) return;
      const key = `reply-notice:${row.id}`;
      live.add(key);
      if (waiting(key)) continue;
      try {
        const ask = store.get(row.in_reply_to);
        const delivery = lookup(row.route_id, MAILBOX_REQUEST + row.id);
        if (!ask || !delivery) throw Object.assign(new Error('Reply or its delivery job is missing'), { code: 'MAILBOX_REPLY_MISSING' });
        const reply = { ...delivery, id: row.id };
        const reason = reply.state === 'unknown' ? 'reply-uncertain' : 'reply-undelivered';
        notify(ask, NOTICE_REQUEST + row.id, envelope.renderNoticeTask(ask, reason), envelope.renderNoticePayload(ask, null, reply));
        retries.delete(key);
      } catch (error) { backOff(key); held(`notice for reply ${row.id}`, error); }
    }
    for (const job of store.unrecoveredJobs()) {
      if (!started) return;
      const key = `recover:${job.route_id}:${job.request_id}`;
      live.add(key);
      if (waiting(key)) continue;
      // Recovery refuses while the session is paused or busy; retry later.
      try { await jobs.prepareRecovery({ routeId: job.route_id, requestId: job.request_id }); retries.delete(key); }
      catch (error) { backOff(key); held(`recovery for ${job.request_id}`, error); }
    }
    // Asks that were answered or notified and jobs that became inactive by
    // other means keep no retry state.
    for (const key of retries.keys()) if (!live.has(key)) retries.delete(key);
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
      const command = [...(ipcDir ? [`POLYGRAM_IPC_DIR=${JSON.stringify(ipcDir)}`] : []),
        ...[process.execPath, SCRIPT, botName, api.scope(sessionKey)].map((part) => JSON.stringify(part))].join(' ');
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
      const { result, row } = transaction(() => {
        const duplicate = store.findDuplicate(fromAddr, toAddr, input.kind, hash, now() - rules.DUPLICATE_WINDOW_MS);
        if (duplicate) return { result: receipt(duplicate, { duplicate: true }) };
        const depth = rules.nextDepth(from.depth, cfg.limits.maxDepth);
        rules.checkRate(store.countPair(fromAddr, toAddr, now() - rules.RATE_WINDOW_MS), cfg.limits.perPairPerHour);
        const created = record({ kind: input.kind, from: fromAddr, to: toAddr, routeId: input.to, body, inReplyTo: null, depth, bodyHash: hash });
        deliver(created);
        return { result: receipt(created), row: created };
      });
      if (row) mirror(row);
      return result;
    },
    reply(token, input) {
      requireEnabled();
      const from = caller(token);
      checkFields(input, ['inReplyTo', 'body']);
      const body = rules.cleanBody(input.body, cfg.limits.maxBodyBytes);
      const hash = rules.bodyHash(body);
      const fromAddr = rules.roleAddress(from.role);
      const { result, row } = transaction(() => {
        const ask = typeof input.inReplyTo === 'string' ? store.get(input.inReplyTo) : null;
        const existing = ask ? store.replyTo(ask.id) : null;
        // A retried reply with the same text returns the stored one.
        if (existing && existing.from_addr === fromAddr && existing.body_hash === hash) return { result: receipt(existing, { duplicate: true }) };
        rules.checkReply({ ask, caller: from.role, replied: existing !== null });
        const asker = rules.roleFromAddress(ask.from_addr);
        if (!cfg.roles.has(asker)) throw new Error('The asking role is no longer configured');
        const created = record({ kind: 'reply', from: fromAddr, to: ask.from_addr, routeId: asker, body, inReplyTo: ask.id, depth: ask.depth, bodyHash: hash });
        deliver(created, ask);
        return { result: receipt(created), row: created };
      });
      if (row) mirror(row);
      return result;
    },
    // The role behind a live role-session token, so a tool an agent runs
    // (such as the task CLI) learns who is calling from the daemon instead
    // of trusting the agent's word. `depth` is the depth send would use:
    // 0 only while the last prompt polygram sent the session was a human
    // message, so the tool can tell whether a human asked in this turn.
    identify(input) {
      requireEnabled();
      checkFields(input, ['token']);
      const { role, depth } = caller(input.token);
      return { role, depth };
    },
    // A tell from a configured process outside any session, such as the
    // organization's task runner, which has no token. The caller's key, not
    // a time window, decides what is new: it is looked up before any other
    // check, so a retry of an accepted message always gets that message's
    // receipt, even when a limit would now refuse a new one.
    submit(input) {
      requireEnabled();
      checkFields(input, ['sender', 'to', 'body', 'key', 'ref']);
      const fromAddr = rules.systemAddress(rules.checkSystemSender(cfg, input.sender));
      const key = rules.checkKey(input.key);
      const ref = rules.cleanRef(input.ref);
      if (typeof input.to !== 'string') throw rules.refusal(rules.REFUSAL.unknownRole, 'Unknown role');
      const toAddr = rules.roleAddress(input.to);
      const hash = rules.redactedBodyHash(input.body);
      const { result, row } = transaction(() => {
        const existing = store.findByKey(fromAddr, key);
        if (existing) {
          if (existing.to_addr !== toAddr || existing.body_hash !== hash) {
            throw rules.refusal(rules.REFUSAL.keyConflict, 'Idempotency key already used for a different target or body');
          }
          return { result: receipt(existing, { duplicate: true }) };
        }
        if (!cfg.roles.has(input.to)) throw rules.refusal(rules.REFUSAL.unknownRole, 'Unknown role');
        const body = rules.cleanBody(input.body, cfg.limits.maxBodyBytes);
        rules.checkSystemRate(store.countFrom(fromAddr, now() - rules.RATE_WINDOW_MS), cfg.limits.systemPerHour);
        // Depth 1, one below a human message: depth 0 stays reserved for a
        // turn a human started, while the receiving role can still ask or
        // tell another role under the default maxDepth.
        const created = record({ kind: 'tell', from: fromAddr, to: toAddr, routeId: input.to, body, inReplyTo: null, depth: 1, bodyHash: hash, idemKey: key, ref });
        deliver(created);
        return { result: receipt(created), row: created };
      });
      if (row) mirror(row);
      return result;
    },
    tick() {
      if (!started) return Promise.resolve();
      if (!polling) polling = poll().catch((error) => logger.error?.(`[mailbox] polling failed: ${error?.code || error?.name || 'Error'}`)).finally(() => { polling = null; });
      return polling;
    },
    start() {
      if (started || !cfg) return;
      started = true;
      timer = setInterval(() => void api.tick(), POLL_MS); timer.unref?.();
      void api.tick();
    },
    stop() { started = false; clearInterval(timer); timer = null; },
  };
  return api;
}

module.exports = { createMailboxService, isMailboxRequest, MAILBOX_REQUEST, NOTICE_REQUEST };

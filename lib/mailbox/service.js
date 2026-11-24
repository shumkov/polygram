'use strict';

const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const rules = require('./rules');
const envelope = require('./envelope');
const { createMailboxStore } = require('./store');
const addresses = require('./addresses');
const { sendRichCard } = require('../telegram/rich-card-send');
const { topicLink, messageLink, parseMessageLink, landedAt } = require('../telegram/links');
const { getSessionKey: defaultGetSessionKey } = require('../session-key');

const SCRIPT = path.resolve(__dirname, '../../skills/mailbox/scripts/msg.js');
const MAILBOX_REQUEST = 'mailbox:';
const NOTICE_REQUEST = 'mailbox-notice:';
const POLL_MS = 5000;
const RETRY_MS = 60000;
const RETRY_MAX_MS = 30 * 60000;
const SETTLED = new Set(['succeeded', 'failed', 'interrupted', 'unknown']);
// How many replaced grants per session still answer asks. A turn overtaken by
// a queued message keeps its own command for a reply; anything older stops.
const MAX_REPLACED_GRANTS = 4;
const INVALID_TOKEN = 'Mailbox token is not valid; use the command from your current turn';
// How long a card waits for Telegram to say whether a chat is a forum, and
// how long a failed answer is remembered before asking again.
const FORUM_PROBE_MS = 3000;
const FORUM_RETRY_MS = 5 * 60000;

const isMailboxRequest = (requestId) => typeof requestId === 'string'
  && (requestId.startsWith(MAILBOX_REQUEST) || requestId.startsWith(NOTICE_REQUEST));

function checkFields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Mailbox input object required');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown mailbox field: ${key}`);
}

// Messages between the sessions of one bot. Every prompt polygram sends a
// session that may start messages mints a grant: the token in that prompt's
// mailbox command, recording the prompt's depth and whether the session has
// seen foreign content. The daemon, never the agent, decides who is speaking,
// how deep the conversation already is, and what the caller may do. A newer
// prompt demotes the previous grant to reply-only, so neither a background
// process nor a later turn reusing an old command can start a message with an
// older, stronger grant.
// `ipcDir` is the daemon's IPC runtime directory. The agent's command carries
// it because a CLI session inherits its environment from whoever started the
// tmux server, which is often not the daemon; msg.js then finds the socket
// and the 0600 secret file there.
function createMailboxService({ config, db, botName, jobs, resolveTarget, resolveBackend = null, getSessionKey = defaultGetSessionKey,
  bot = null, tg = null, sendRich, getChat = bot?.api?.getChat ? (chatId) => bot.api.getChat(chatId) : null, forumProbeMs = FORUM_PROBE_MS,
  ipcDir = null, now = Date.now, logger = console }) {
  const cfg = rules.readMailboxConfig(config.bot, resolveTarget);
  const raw = db?.raw;
  const store = cfg ? createMailboxStore(raw, { botName, now }) : null;
  const grants = new Map();
  const currentGrant = new Map();
  const pendingGrant = new Map();
  const replacedGrants = new Map();
  const taintedSessions = new Set();
  const transaction = (fn) => raw.transaction(fn).immediate();
  const requireEnabled = () => { if (!cfg) throw rules.refusal(rules.REFUSAL.disabled, 'Mailbox is disabled'); };
  const roleOf = (sessionKey) => cfg?.roleForSession(sessionKey) ?? null;
  // Read from the live chat config, so a renamed or added topic counts at once.
  const sessions = () => addresses.listSessions({ config, getSessionKey, resolveBackend, roles: cfg.roles, rolesOnly: cfg.intra === 'roles' });
  const sessionByKey = (sessionKey) => (cfg ? sessions().find((session) => session.sessionKey === sessionKey) ?? null : null);
  // Who gets grants: in a roles bot its roles, in an open bot every session
  // that can receive (Claude CLI or Codex), since a sender must be able to get
  // replies.
  const mayStart = (session) => session !== null && (cfg.intra === 'roles' ? session.role !== null : session.receivable);
  let started = false;
  let timer = null;
  let polling = null;
  const retries = new Map();
  const waiting = (key) => (retries.get(key)?.at ?? 0) > now();
  function backOff(key) {
    const attempts = (retries.get(key)?.attempts ?? 0) + 1;
    retries.set(key, { attempts, at: now() + Math.min(RETRY_MS * 2 ** (attempts - 1), RETRY_MAX_MS) });
  }

  function mint(sessionKey, fields) {
    const token = randomUUID();
    grants.set(token, { sessionKey, depth: cfg.limits.maxDepth, tainted: false, state: 'pending', ...fields });
    return token;
  }
  // Makes a grant the session's current one; the previous current grant can
  // still reply, and only the newest few replaced grants are kept.
  function activate(sessionKey, token, depth) {
    const grant = grants.get(token);
    Object.assign(grant, { state: 'current', depth, tainted: taintedSessions.has(sessionKey) });
    const previous = currentGrant.get(sessionKey);
    if (previous && previous !== token && grants.has(previous)) {
      grants.get(previous).state = 'replaced';
      const replaced = [...(replacedGrants.get(sessionKey) ?? []), previous];
      while (replaced.length > MAX_REPLACED_GRANTS) grants.delete(replaced.shift());
      replacedGrants.set(sessionKey, replaced);
    }
    currentGrant.set(sessionKey, token);
    return token;
  }
  function dropPending(sessionKey) {
    const token = pendingGrant.get(sessionKey);
    if (token) { grants.delete(token); pendingGrant.delete(sessionKey); }
  }
  // The session's current grant; one minted at maxDepth, reply-only in
  // effect, when polygram has not prompted the session since boot.
  function currentToken(sessionKey) {
    const token = currentGrant.get(sessionKey);
    return token && grants.has(token) ? token : activate(sessionKey, mint(sessionKey, {}), cfg.limits.maxDepth);
  }

  function caller(token) {
    const grant = typeof token === 'string' ? grants.get(token) : undefined;
    const session = grant && grant.state !== 'pending' ? sessionByKey(grant.sessionKey) : null;
    if (!session || !mayStart(session)) throw new Error(INVALID_TOKEN);
    // A replaced or tainted grant reports maxDepth: it can never pass as a
    // human asking now, to send() or to a tool that reads identify.
    const current = grant.state === 'current';
    return { session, current, tainted: grant.tainted, depth: current && !grant.tainted ? grant.depth : cfg.limits.maxDepth };
  }
  // Starting a message needs the session's current, untainted grant.
  function starter(token) {
    const from = caller(token);
    if (!from.current) {
      throw rules.refusal(rules.REFUSAL.notAllowed, 'This command was replaced by a newer prompt: it can still reply, but start messages only with the command from your current turn');
    }
    if (from.tainted) {
      throw rules.refusal(rules.REFUSAL.notAllowed, 'This turn carries foreign content, so it cannot start a message; report in your topic and let the operator decide');
    }
    return from;
  }
  // The session `to` names, refused with a stable code when there is none.
  function target(to) {
    const found = addresses.resolveAddress(sessions(), to);
    if (found?.ambiguous) {
      throw rules.refusal(rules.REFUSAL.unknownAddress, `Ambiguous address ${JSON.stringify(to)}: use one of ${found.ambiguous.map((s) => `${s.address} (${s.name})`).join(', ')}`);
    }
    if (found) return found.session;
    if (cfg.intra === 'roles') throw rules.refusal(rules.REFUSAL.unknownRole, 'Unknown role');
    throw rules.refusal(rules.REFUSAL.unknownAddress, `Unknown address ${JSON.stringify(typeof to === 'string' ? to : String(to))}: run directory for the names you can use`);
  }
  // The session an address names, for routing replies, notices and mirrors.
  function sessionAt(address) {
    if (typeof address !== 'string') return null;
    const role = rules.roleFromAddress(address);
    if (role !== null) return cfg.roles.has(role) ? sessions().find((session) => session.role === role) ?? null : null;
    return address.startsWith(addresses.SESSION_PREFIX) ? sessionByKey(address.slice(addresses.SESSION_PREFIX.length)) : null;
  }
  // A role keeps its configured route; any other session's route id is its
  // address (an implicit `session:` route).
  const routeOf = (session) => session.role ?? session.address;
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
  // which retries on deferral. The target's card goes first: once Telegram
  // proves where it landed, the sender's copy links to it and later answers
  // and notices link back to it. A failed post is logged and never blocks
  // delivery or the other post; the target's final text reaches the same
  // topic as the job report. A system sender has no topic of its own.
  function mirror(row) {
    if (!cfg.mirror || !tg) return;
    const card = (links) => ({ blocks: envelope.renderRichMirror(row, links), html: envelope.renderMirror(row, links) });
    let targetCard = null;
    enqueue(`mirror of ${row.id}`, async () => {
      targetCard = await post(() => sessionAt(row.to_addr)?.target, 'mailbox-mirror', `mirror of ${row.id}`,
        async (at) => card(await cardLinks(at, row, () => targetExtra(row))));
      if (targetCard) {
        try { store.setTargetCard(row.id, targetCard); }
        catch (error) { logger.error?.(`[mailbox] target card of ${row.id} not recorded: ${errorCode(error)}`); }
      }
    });
    if (cfg.mirror === 'both') {
      enqueue(`sender mirror of ${row.id}`, () => post(() => sessionAt(row.from_addr)?.target, 'mailbox-sender-mirror', `sender mirror of ${row.id}`,
        async (at) => card(await cardLinks(at, row, () => (targetCard ? [{ label: '↗ open', url: targetCard }] : [])))));
    }
  }
  // A notice in the asker's topic, linking the question card. Best effort,
  // like any mirror: the notice job does not depend on it.
  function noticeCard(ask, reason) {
    if (!cfg.mirror || !tg) return;
    enqueue(`notice card for ${ask.id}`, () => post(() => sessionAt(ask.from_addr)?.target, 'mailbox-notice', `notice card for ${ask.id}`, async (at) => {
      const links = await cardLinks(at, ask, () => (ask.target_card ? [{ label: '↗ question', url: ask.target_card }] : []));
      return { blocks: envelope.renderNoticeCard(ask, reason, links), html: envelope.renderNoticeCardHtml(ask, reason, links) };
    }));
  }
  // Every card goes out in the order its message committed, one at a time,
  // so each topic reads in commit order and a sender's copy can wait for its
  // target card. A step that fails is logged by its code and the queue moves
  // on; nothing here ever reaches the caller.
  let cards = Promise.resolve();
  function enqueue(what, step) {
    cards = cards.then(step).catch((error) => logger.error?.(`[mailbox] ${what} skipped: ${errorCode(error)}`));
  }
  // One card in one topic. Resolves the card's link when Telegram's receipt
  // proves it landed there, else null; never rejects.
  async function post(destination, source, what, render) {
    try {
      const target = destination();
      if (!target) return null;
      const { blocks, html } = await render(target);
      const { result } = await sendRichCard({ sendRich, tg, bot, chatId: target.chatId, threadId: target.threadId,
        blocks, fallback: { text: html, parse_mode: 'HTML' }, meta: { source, botName, sessionKey: target.sessionKey } });
      if (!landedAt(result, target)) {
        logger.warn?.(`[mailbox] ${what} landed outside its topic; nothing will link to it`);
        return null;
      }
      // Null in a chat without message links (a DM or a basic group).
      return messageLink({ chatId: target.chatId, threadId: target.threadId, messageId: result.message_id });
    } catch (error) {
      // Telegram's description is API text, not message content.
      logger.error?.(`[mailbox] ${what} failed: ${error?.error_code ?? error?.code ?? error?.name ?? 'Error'}${error?.description ? ` ${error.description}` : ''}`);
      return null;
    }
  }
  const errorCode = (error) => error?.code || error?.name || 'Error';

  // The links a target card carries besides names: a Notion page for a
  // sender whose ref is one, a proven jump link, and for an answer the card
  // of the question it answers.
  function targetExtra(row) {
    const extra = [];
    const sender = row.from_addr.startsWith('system:') ? row.from_addr.slice('system:'.length) : null;
    const notion = sender !== null && cfg.notionRefs.has(sender) ? rules.notionPageLink(row.ref) : null;
    if (notion) extra.push({ label: '↗ Notion', url: notion });
    if (row.link) extra.push({ label: '↗ open', url: row.link });
    const question = row.kind === 'reply' ? store.get(row.in_reply_to)?.target_card : null;
    if (question) extra.push({ label: '↗ question', url: question });
    return extra;
  }
  // Whether a chat is a forum, as Telegram says: /1 opens General only in a
  // forum. Asked once per chat, only for a General session a card names, and
  // never for longer than forumProbeMs, so a slow Bot API costs the link and
  // not the card. A failure or timeout is remembered for a while, so the
  // cards after it do not wait again.
  const forums = new Map();
  function isForum(chatId) {
    if (!getChat) return Promise.resolve(false);
    const known = forums.get(chatId);
    if (known instanceof Promise) return known;
    if (known && known.retryAt > now()) return Promise.resolve(false);
    let timer;
    const answer = Promise.race([
      Promise.resolve().then(() => getChat(chatId)).then((chat) => chat?.is_forum === true),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('getChat timed out'), { code: 'FORUM_PROBE_TIMEOUT' })), forumProbeMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    forums.set(chatId, answer);
    answer.catch(() => forums.set(chatId, { retryAt: now() + FORUM_RETRY_MS }));
    return answer;
  }
  // A name opens its session's topic, from the live config: the label is the
  // name the session had when the message was sent, the link the session the
  // message went to. A system sender or an unconfigured session has none.
  async function nameLink(address) {
    const session = sessionAt(address);
    if (!session) return null;
    const forum = session.threadId == null && /^-100\d+$/.test(String(session.chatId)) ? await isForum(session.chatId) : false;
    return topicLink({ chatId: session.chatId, threadId: session.threadId, forum });
  }
  // An open bot may span unrelated chats, such as a partner group, so its
  // cards link only into their own chat; a roles bot's operator placed each
  // role, so links may cross its chats.
  function within(card, url) {
    if (!url || cfg.intra === 'roles') return url;
    const channel = /^https:\/\/t\.me\/c\/(\d+)\//.exec(url)?.[1];
    return channel === undefined || `-100${channel}` === String(card.chatId) ? url : null;
  }
  // Everything a card links to. Each part is computed on its own, so a failure
  // costs that link and never the card.
  async function cardLinks(card, row, extra) {
    const safely = async (what, compute) => {
      try { return await compute(); }
      catch (error) { logger.warn?.(`[mailbox] ${what} link for ${row.id} left out: ${errorCode(error)}`); return null; }
    };
    const [from, to, more] = await Promise.all([safely('sender name', () => nameLink(row.from_addr)),
      safely('target name', () => nameLink(row.to_addr)), safely('jump', extra)]);
    return { from: within(card, from), to: within(card, to), extra: (more ?? []).filter(({ url }) => within(card, url)) };
  }
  // A system sender's jump link is kept only when it points into a role's
  // topic and names a message this bot sent there for that sender, as the
  // outbound history records it. Anything else is dropped rather than
  // refused: it is display data.
  function proveLink(link, sender) {
    if (link === undefined || link === null) return null;
    try {
      const at = parseMessageLink(link);
      const inRoleTopic = at !== null && [...cfg.roles.values()].some(({ target }) => String(target.chatId) === at.chatId
        && String(target.threadId ?? '') === String(at.threadId ?? ''));
      if (inRoleTopic && store.sentBy(sender, at)) return messageLink(at);
      logger.warn?.(`[mailbox] mailbox-link-dropped: a ${sender} link names no message ${sender} sent into a role's topic through this bot`);
    } catch (error) {
      logger.warn?.(`[mailbox] mailbox-link-dropped: the ${sender} link could not be checked: ${errorCode(error)}`);
    }
    return null;
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
  // Returns whether this call created the notice job.
  function notify(ask, requestId, task, payload) {
    // A session no longer listed still has its implicit route, which the
    // external-job route check settles.
    const asker = sessionAt(ask.from_addr);
    const routeId = asker ? routeOf(asker) : rules.roleFromAddress(ask.from_addr) ?? ask.from_addr;
    let created = false;
    transaction(() => {
      if (!lookup(routeId, requestId)) { jobs.submit({ routeId, requestId, task, payload }); created = true; }
      store.markNoticeSent(ask.id);
    });
    return created;
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
        if (notify(ask, NOTICE_REQUEST + ask.id, envelope.renderNoticeTask(ask, delivery.state), envelope.renderNoticePayload(ask, delivery))) noticeCard(ask, delivery.state);
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
        if (notify(ask, NOTICE_REQUEST + row.id, envelope.renderNoticeTask(ask, reason), envelope.renderNoticePayload(ask, null, reply))) noticeCard(ask, reason);
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
    roleForSession: roleOf,
    // Whether the mailbox can deliver into this session: a role, or in an open
    // bot any session that can receive.
    receivesMail: (sessionKey) => mayStart(sessionByKey(sessionKey)),
    // The session's current grant token, or null for a session that may not
    // start messages (a non-role session of a roles bot, an SDK session).
    scope(sessionKey) {
      return mayStart(sessionByKey(sessionKey)) ? currentToken(sessionKey) : null;
    },
    // An inbound human message: the human is in the loop, so the turn may
    // start a fresh chain. Only the operator's own message that starts a new
    // turn clears taint: a message from anyone else, or one folded into a
    // running turn, keeps it.
    noteHumanPrompt(sessionKey, { operator = false, newTurn = true } = {}) {
      if (!mayStart(sessionByKey(sessionKey))) return;
      if (operator && newTurn) taintedSessions.delete(sessionKey);
      activate(sessionKey, mint(sessionKey, {}), 0);
    },
    // Called at the moment an external job's prompt is actually sent: the
    // grant minted with that prompt's instructions takes effect now, never
    // earlier, and a job that deferred never activates its grant. A mailbox
    // delivery carries its message depth; every other job, notices included,
    // gets maxDepth so its turn can reply but not start a chain.
    noteJobSend(job) {
      const sessionKey = job?.target?.sessionKey;
      if (!mayStart(sessionByKey(sessionKey))) return;
      const id = typeof job.requestId === 'string' && job.requestId.startsWith(MAILBOX_REQUEST) ? job.requestId.slice(MAILBOX_REQUEST.length) : null;
      const row = id ? store.get(id) : null;
      const pending = pendingGrant.get(sessionKey);
      const prepared = pending && grants.get(pending)?.job === `${job.routeId}\0${job.requestId}` ? pending : null;
      if (prepared) pendingGrant.delete(sessionKey); else dropPending(sessionKey);
      activate(sessionKey, prepared ?? mint(sessionKey, {}), row && row.route_id === job.routeId ? row.depth : cfg.limits.maxDepth);
    },
    // Marks a session as having seen foreign content: its current grant and
    // every grant it gets until the operator writes again cannot start a
    // message. A personal ask counts as Ivan elsewhere only because of this.
    taint(sessionKey) {
      taintedSessions.add(sessionKey);
      const token = currentGrant.get(sessionKey);
      if (token && grants.has(token)) grants.get(token).tainted = true;
    },
    // The mailbox block appended to a prompt. For an external job it carries a
    // new grant that takes effect when the job's prompt is sent; for a human
    // message, the grant noteHumanPrompt just made current.
    instructions(sessionKey, job = null) {
      const session = sessionByKey(sessionKey);
      if (!mayStart(session)) return '';
      let token;
      if (job) {
        dropPending(sessionKey);
        token = mint(sessionKey, { job: `${job.routeId}\0${job.requestId}` });
        pendingGrant.set(sessionKey, token);
      } else token = currentToken(sessionKey);
      const command = [...(ipcDir ? [`POLYGRAM_IPC_DIR=${JSON.stringify(ipcDir)}`] : []),
        ...[process.execPath, SCRIPT, botName, token].map((part) => JSON.stringify(part))].join(' ');
      const guidance = ' Reply exactly once to each ask you receive. Replies arrive as a new turn after your turn ends, so never wait or poll for them.\n';
      if (cfg.intra === 'roles') {
        const role = session.role;
        const targets = [...cfg.roles.values()].filter((other) => cfg.allowed(role, other.name))
          .map((other) => (other.about ? `${other.name} (${other.about})` : other.name));
        return `\nInter-session mailbox: you are role:${role} in an organization of agent sessions. Roles you may message: ${targets.length ? targets.join('; ') : 'none (you can still reply to asks you receive)'}.`
          + ` Ask or tell another role: run ${command} send '{"to":"<role>","kind":"ask","body":"..."}' (kind "tell" expects no reply).`
          + ` Reply to an ask you received: run ${command} reply '{"id":"<message id>","body":"..."}'.`
          + ' An ask states the answer you need; do not hand work off through the mailbox yet. Send summaries and file paths, never transcripts.'
          + guidance;
      }
      return `\nInter-session mailbox: you are ${session.label}, one of this bot's sessions; you can ask or tell any other session of it.`
        + ` Message one: run ${command} send '{"to":"<name>","kind":"ask","body":"..."}' (kind "tell" expects no reply).`
        + ` List the names you can use: run ${command} directory. List your asks still waiting for a reply: run ${command} open.`
        + ` Reply to an ask you received: run ${command} reply '{"id":"<message id>","body":"..."}'.`
        + ' An ask states the answer you need. Send summaries and file paths, never transcripts. Use the command from your current turn: an older one can only reply.'
        + guidance;
    },
    send(token, input) {
      requireEnabled();
      const from = starter(token);
      checkFields(input, ['to', 'kind', 'body', 'summary']);
      if (input.kind !== 'ask' && input.kind !== 'tell') throw new Error('Message kind must be ask or tell');
      const to = target(input.to);
      rules.checkStart(cfg, { from: from.session, to, kind: input.kind });
      const body = rules.cleanBody(input.body, cfg.limits.maxBodyBytes);
      const summary = rules.cleanSummary(input.summary);
      const hash = rules.summaryMessageHash(body, summary);
      const fromAddr = from.session.address;
      const toAddr = to.address;
      const { result, row } = transaction(() => {
        const duplicate = store.findDuplicate(fromAddr, toAddr, input.kind, hash, now() - rules.DUPLICATE_WINDOW_MS);
        if (duplicate) return { result: receipt(duplicate, { duplicate: true }) };
        const depth = rules.nextDepth(from.depth, cfg.limits.maxDepth);
        rules.checkRate(store.countPair(fromAddr, toAddr, now() - rules.RATE_WINDOW_MS), cfg.limits.perPairPerHour);
        const created = record({ kind: input.kind, from: fromAddr, to: toAddr, routeId: routeOf(to), body, inReplyTo: null, depth, bodyHash: hash, summary,
          fromLabel: from.session.label, toLabel: to.label });
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
      const fromAddr = from.session.address;
      const { result, row } = transaction(() => {
        const ask = typeof input.inReplyTo === 'string' ? store.get(input.inReplyTo) : null;
        const existing = ask ? store.replyTo(ask.id) : null;
        // A retried reply with the same text returns the stored one.
        if (existing && existing.from_addr === fromAddr && existing.body_hash === hash) return { result: receipt(existing, { duplicate: true }) };
        rules.checkReply({ ask, caller: fromAddr, replied: existing !== null });
        const asker = sessionAt(ask.from_addr);
        if (!asker) throw new Error(rules.roleFromAddress(ask.from_addr) !== null ? 'The asking role is no longer configured' : 'The asking session is no longer configured');
        const created = record({ kind: 'reply', from: fromAddr, to: ask.from_addr, routeId: routeOf(asker), body, inReplyTo: ask.id, depth: ask.depth, bodyHash: hash,
          fromLabel: from.session.label, toLabel: asker.label });
        deliver(created, ask);
        return { result: receipt(created), row: created };
      });
      if (row) mirror(row);
      return result;
    },
    // Whom the caller may message, by the name to use. Targets that cannot
    // receive yet are listed too, so an agent learns why a send would fail.
    directory(token, input) {
      requireEnabled();
      const from = caller(token);
      checkFields(input, []);
      const all = sessions();
      const targets = all.filter((other) => other.sessionKey !== from.session.sessionKey
        && (cfg.intra === 'open' || (from.session.role !== null && other.role !== null && cfg.allowed(from.session.role, other.role))))
        .map((other) => {
          const about = other.role ? cfg.roles.get(other.role)?.about : '';
          return { to: addresses.preferredName(all, other), address: other.address, name: other.name, canReceive: other.receivable, ...(about ? { about } : {}) };
        });
      return { you: from.session.label, targets };
    },
    // The caller's asks that have no reply yet, with their delivery state.
    open(token, input) {
      requireEnabled();
      const from = caller(token);
      checkFields(input, []);
      return { asks: store.openAsks(from.session.address).map((ask) => ({
        id: ask.id, to: envelope.displayAddress(ask.to_addr, ask.to_label), state: receipt(ask).state, createdAt: ask.created_at })) };
    },
    // The role behind a live role-session token, so a tool an agent runs
    // (such as the task CLI) learns who is calling from the daemon instead
    // of trusting the agent's word. `depth` is the depth send would use:
    // 0 only while the caller's grant is the current one and the last prompt
    // polygram sent the session was a human message or a system tell relaying
    // a human's words, so the tool can tell whether a human asked in this turn.
    identify(input) {
      requireEnabled();
      checkFields(input, ['token']);
      const { session, depth } = caller(input.token);
      if (session.role === null) throw new Error(INVALID_TOKEN);
      return { role: session.role, depth };
    },
    // A tell from a configured process outside any session, such as the
    // organization's task runner, which has no token. An optional origin
    // says a human wrote it, which only a configured sender can claim. The
    // caller's key, not a time window, decides what is new: it is looked up
    // before any other check, so a retry of an accepted message always gets
    // that message's receipt, even when a limit would now refuse a new one.
    submit(input) {
      requireEnabled();
      checkFields(input, ['sender', 'to', 'body', 'key', 'ref', 'origin', 'summary', 'link']);
      const fromAddr = rules.systemAddress(rules.checkSystemSender(cfg, input.sender));
      const key = rules.checkKey(input.key);
      const ref = rules.cleanRef(input.ref);
      const originName = rules.cleanOriginName(input.origin);
      const summary = rules.cleanSummary(input.summary);
      if (typeof input.to !== 'string') throw rules.refusal(rules.REFUSAL.unknownRole, 'Unknown role');
      const toAddr = rules.roleAddress(input.to);
      const hash = rules.summaryMessageHash(input.body, summary, originName);
      const { result, row } = transaction(() => {
        const existing = store.findByKey(fromAddr, key);
        if (existing) {
          if (existing.to_addr !== toAddr || existing.body_hash !== hash) {
            throw rules.refusal(rules.REFUSAL.keyConflict, 'Idempotency key already used for a different target, body, origin or summary');
          }
          return { result: receipt(existing, { duplicate: true }) };
        }
        if (!cfg.roles.has(input.to)) throw rules.refusal(rules.REFUSAL.unknownRole, 'Unknown role');
        const body = rules.cleanBody(input.body, cfg.limits.maxBodyBytes);
        rules.checkSystemRate(store.countFrom(fromAddr, now() - rules.RATE_WINDOW_MS), cfg.limits.systemPerHour);
        // Depth 1, one below a human message: depth 0 stays reserved for a
        // turn a human started, while the receiving role can still ask or
        // tell another role under the default maxDepth. A message a human
        // wrote and the sender only relays is that human asking: depth 0.
        const depth = originName === null ? 1 : 0;
        const created = record({ kind: 'tell', from: fromAddr, to: toAddr, routeId: input.to, body, inReplyTo: null, depth, bodyHash: hash, idemKey: key, ref, originName, summary,
          link: proveLink(input.link, input.sender) });
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

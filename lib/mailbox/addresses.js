'use strict';

// The sessions of this bot the mailbox can address, and the names agents use
// for them. A configured role keeps `role:<name>`; every other session is
// `session:<sessionKey>`. The list is read from the live chat config on each
// call, so a renamed or added topic counts at once, while stored rows keep the
// canonical address, so a rename never redirects an open ask.

const { isForumChat, isJobBackend } = require('../external-jobs/runtime');

const SESSION_PREFIX = 'session:';
const sessionAddress = (sessionKey) => `${SESSION_PREFIX}${sessionKey}`;
const MAX_SLUG = 48;

// A topic or chat name as an alias: lowercase ASCII letters and digits joined
// by single dashes. A name with no such characters (Cyrillic, emoji) has no
// slug, and the session keeps only its other aliases.
function slug(name) {
  if (typeof name !== 'string') return null;
  const value = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/, '');
  return value ? value : null;
}
const topicName = (entry) => (typeof entry === 'string' ? entry : typeof entry?.name === 'string' ? entry.name : null);

// Every session the chat config defines: each chat's bare session (a plain
// chat, a forum's General, or the one shared session of a forum that does not
// isolate topics), and each configured topic of a forum that does. Roles are
// matched by their resolved session key. With `rolesOnly` (a roles bot) only
// the role sessions and the configured people's assistants are listed: no
// other chat of such a bot can be named.
function listSessions({ config, getSessionKey, resolveBackend, roles, assistants = new Map(), rolesOnly = false }) {
  const chats = rolesOnly ? [] : Object.entries(config.chats || {}).filter(([, chat]) => chat && typeof chat === 'object');
  const oneForum = chats.filter(([, chat]) => isForumChat(chat)).length === 1;
  const backendOf = (chatId, threadId) => {
    try { return resolveBackend ? resolveBackend({ chatId, threadId }) : 'cli'; } catch { return 'unknown'; }
  };
  const byKey = new Map();
  const add = (chatId, chat, threadId, name, aliases) => {
    const sessionKey = getSessionKey(chatId, threadId, chat);
    byKey.set(sessionKey, { sessionKey, chatId, threadId, name, aliases, receivable: isJobBackend(backendOf(chatId, threadId)) });
  };
  for (const [chatId, chat] of chats) {
    const forum = isForumChat(chat);
    const chatName = typeof chat.name === 'string' && chat.name ? chat.name : chatId;
    add(chatId, chat, null, forum ? `${chatName} / General` : chatName, [forum && oneForum ? 'general' : null, slug(chat.name)]);
    if (!forum || chat.isolateTopics !== true) continue;
    for (const [threadId, entry] of Object.entries(chat.topics || {})) {
      if (!/^[1-9]\d*$/.test(threadId)) continue;
      const named = topicName(entry);
      add(chatId, chat, threadId, `${chatName} / ${named || `topic ${threadId}`}`, [slug(named), `t${threadId}`]);
    }
  }
  // A role's session was resolved and checked for a job backend at boot.
  const roleBySession = new Map();
  for (const role of roles.values()) {
    const { chatId, threadId, sessionKey } = role.target;
    roleBySession.set(sessionKey, role.name);
    if (!byKey.has(sessionKey)) byKey.set(sessionKey, { sessionKey, chatId, threadId: threadId ?? null, name: role.name, aliases: [], receivable: true });
  }
  // A person's assistant is their direct chat: its session key is the chat id.
  // Its key ("dina") and `person:<key>` name it. It receives on the same
  // backends any session does (the Claude CLI or Codex).
  const assistantBySession = new Map();
  for (const assistant of assistants.values()) {
    assistantBySession.set(assistant.chatId, assistant);
    byKey.set(assistant.chatId, { sessionKey: assistant.chatId, chatId: assistant.chatId, threadId: null, name: assistant.label,
      aliases: [assistant.key, `person:${assistant.key}`], receivable: isJobBackend(backendOf(assistant.chatId, null)) });
  }
  const sessions = [...byKey.values()].map((entry) => {
    const role = roleBySession.get(entry.sessionKey) ?? null;
    const assistant = role ? null : assistantBySession.get(entry.sessionKey)?.key ?? null;
    return {
      sessionKey: entry.sessionKey, chatId: entry.chatId, threadId: entry.threadId, role, assistant, name: entry.name,
      address: role ? `role:${role}` : sessionAddress(entry.sessionKey),
      aliases: Object.freeze([...new Set([role, ...entry.aliases].filter(Boolean))]),
      receivable: role ? true : entry.receivable,
      target: Object.freeze({ chatId: entry.chatId, threadId: entry.threadId, sessionKey: entry.sessionKey }),
    };
  });
  // The label shown in trusted headers and cards must name only this
  // session, so a reader can never mistake the sender: the name an agent
  // would type for it (lib/mailbox/addresses.js preferredName).
  for (const session of sessions) session.label = session.assistant ? assistants.get(session.assistant).label : preferredName(sessions, session);
  return sessions.map((session) => Object.freeze(session));
}

// What `to` names: a canonical address, a role name (roles win over every
// other alias), or an alias. Returns { session }, { ambiguous: [...] } or null.
// Sessions are compared by key, since labels are added after resolution.
function resolveAddress(sessions, to) {
  if (typeof to !== 'string' || !to) return null;
  if (to.startsWith('role:')) {
    const session = sessions.find((s) => s.role === to.slice(5));
    return session ? { session } : null;
  }
  if (to.startsWith(SESSION_PREFIX)) {
    const session = sessions.find((s) => s.sessionKey === to.slice(SESSION_PREFIX.length));
    return session ? { session } : null;
  }
  const role = sessions.find((s) => s.role === to);
  if (role) return { session: role };
  const matches = sessions.filter((s) => s.aliases.includes(to));
  if (matches.length === 1) return { session: matches[0] };
  return matches.length > 1 ? { ambiguous: matches } : null;
}

// The name an agent should type for a session: its role, else its first alias
// that names only it, else its canonical address.
function preferredName(sessions, session) {
  if (session.role) return session.role;
  return session.aliases.find((alias) => resolveAddress(sessions, alias)?.session?.sessionKey === session.sessionKey) ?? session.address;
}

module.exports = { listSessions, resolveAddress, preferredName, sessionAddress, slug, SESSION_PREFIX };

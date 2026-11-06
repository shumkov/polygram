'use strict';

// SQL access for mailbox_messages. Every query is scoped to one bot.
function createMailboxStore(db, { botName, now = Date.now }) {
  const byId = db.prepare('SELECT * FROM mailbox_messages WHERE id=? AND bot_name=?');
  return {
    insert(m) {
      db.prepare(`INSERT INTO mailbox_messages(id,bot_name,kind,from_addr,to_addr,route_id,body,in_reply_to,depth,body_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(m.id, botName, m.kind, m.from, m.to, m.routeId, m.body, m.inReplyTo ?? null, m.depth, m.bodyHash, now());
      return byId.get(m.id, botName);
    },
    get(id) { return byId.get(id, botName) ?? null; },
    replyTo(askId) {
      return db.prepare("SELECT * FROM mailbox_messages WHERE bot_name=? AND in_reply_to=? AND kind='reply'").get(botName, askId) ?? null;
    },
    countPair(from, to, since) {
      return db.prepare(`SELECT count(*) n FROM mailbox_messages WHERE bot_name=? AND from_addr=? AND to_addr=?
        AND created_at>=? AND kind IN ('ask','tell')`).get(botName, from, to, since).n;
    },
    // Once the sender has had a notice about a message, an identical send is
    // a deliberate re-ask rather than a retry, so it no longer matches.
    findDuplicate(from, to, kind, bodyHash, since) {
      return db.prepare(`SELECT * FROM mailbox_messages WHERE bot_name=? AND from_addr=? AND to_addr=? AND created_at>=?
        AND body_hash=? AND kind=? AND notice_sent=0 ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(botName, from, to, since, bodyHash, kind) ?? null;
    },
    // Asks whose asker has not been told how the delivery ended and that are
    // not answered. An ask counts as answered only while its reply's own
    // delivery has not failed, been interrupted or become uncertain.
    noticeCandidates() {
      return db.prepare(`SELECT * FROM mailbox_messages m WHERE m.bot_name=? AND m.kind='ask' AND m.notice_sent=0
        AND NOT EXISTS (SELECT 1 FROM mailbox_messages r
          JOIN external_jobs j ON j.bot_name=r.bot_name AND j.route_id=r.route_id AND j.request_id='mailbox:' || r.id
          WHERE r.in_reply_to=m.id AND r.kind='reply' AND j.state NOT IN ('failed','interrupted','unknown'))
        ORDER BY m.created_at, m.rowid`).all(botName);
    },
    markNoticeSent(id) { db.prepare('UPDATE mailbox_messages SET notice_sent=1 WHERE id=? AND bot_name=?').run(id, botName); },
    // Mailbox-owned external jobs whose outcome is unknown and whose session
    // is not yet proven idle, so its queue stays blocked.
    unrecoveredJobs() {
      return db.prepare(`SELECT route_id, request_id FROM external_jobs WHERE bot_name=? AND state='unknown' AND inactive=0
        AND (request_id GLOB 'mailbox:*' OR request_id GLOB 'mailbox-notice:*') ORDER BY id`).all(botName);
    },
  };
}

module.exports = { createMailboxStore };

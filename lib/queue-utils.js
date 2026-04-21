/**
 * Pure helpers for per-chat message queues. Kept separate from bridge.js so
 * they can be unit-tested without spinning up the whole bridge.
 */

// Drop queued items belonging to a chatId across all its thread-scoped
// sessionKeys (formatted as `<chatId>` or `<chatId>:<threadId>`). Mutates
// `queues` in place; returns the number of dropped items.
//
// Called before `pm.killChat(chatId)` whenever per-chat config changes
// (/model, /effort, migrate_to_chat_id). Without this, items enqueued under
// the OLD config would be processed by the freshly-spawned process under
// the NEW config — a correctness bug the user never sees but that silently
// mixes turns across configurations.
function drainQueuesForChat(queues, chatId) {
  const prefix = String(chatId);
  let dropped = 0;
  for (const key of Object.keys(queues)) {
    if (key === prefix || key.startsWith(prefix + ':')) {
      dropped += queues[key]?.length || 0;
      queues[key] = [];
    }
  }
  return dropped;
}

module.exports = { drainQueuesForChat };

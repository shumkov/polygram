/**
 * Pure helpers for per-chat message queues. Kept separate from polygram.js so
 * they can be unit-tested without spinning up the whole polygram.
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

// Total handler count across every session. `inFlightHandlers` is the
// dispatcher's Map<sessionKey, count>; it is null before the dispatcher is
// wired and can be read again while the daemon tears itself down, so a missing
// map counts as zero rather than throwing.
function countInFlight(inFlightHandlers) {
  if (!inFlightHandlers) return 0;
  let total = 0;
  for (const n of inFlightHandlers.values()) total += n || 0;
  return total;
}

// Point-in-time view of what the daemon is working on, for the IPC `busy` op.
//
// A deploy needs to know whether a restart would interrupt anyone. The only
// exact answer is the dispatcher's in-flight map: a chat's tmux session exists
// for the whole LRU lifetime of that chat, so counting live sessions reports
// "busy" almost always and tells an operator nothing.
//
// Sessions at zero are omitted — they have finished, and listing them would
// make every deploy look unsafe.
function buildBusySnapshot({ inFlightHandlers, botName } = {}) {
  const sessions = [];
  if (inFlightHandlers) {
    for (const [sessionKey, n] of inFlightHandlers.entries()) {
      if (n > 0) sessions.push({ session_key: sessionKey, in_flight: n });
    }
  }
  return {
    bot: botName ?? null,
    in_flight: countInFlight(inFlightHandlers),
    sessions,
  };
}

module.exports = { drainQueuesForChat, countInFlight, buildBusySnapshot };

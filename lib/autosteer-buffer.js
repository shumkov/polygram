/**
 * Per-session buffer for mid-turn user follow-ups (autosteer + /steer).
 *
 * 0.8.0-rc.9: lands the steer mechanism that survived production. Earlier
 * rcs pushed `priority:'now'` SDKUserMessages onto the SDK input
 * iterable mid-tool-use; the CLI binary's `m87` gate rejected them with
 * `result.subtype = error_during_execution` because the transcript shape
 * (assistant ending with tool_use → next user message NOT being a
 * tool_result) is malformed per Anthropic's API contract.
 *
 * The mechanism we landed on: append the follow-up to a per-session
 * buffer; on every PostToolBatch hook fire, drain the buffer into the
 * hook's `additionalContext` field wrapped in a `<channel
 * source="user-followup">…</channel>` tag — the same framing Channels
 * MCP uses, which Claude is trained to trust as legitimate
 * out-of-band user context (vs. prompt-injection inside tool output,
 * which the model defends against by refusing to follow).
 *
 * Spike result (post-tool-batch-spike-v2.mjs): with this framing, the
 * marker "spike-marker-9d3e" injected via additionalContext was
 * incorporated verbatim into the assistant's final answer. With the
 * earlier `<user_message_during_turn>` framing, the model recognised
 * it as prompt-injection-shaped and refused.
 *
 * Why a buffer module instead of inlining: per-sessionKey state lives
 * outside the pm and outside polygram.js's handleMessage so both
 * autosteer (handleMessage line ~2418) and /steer (line ~1975) can
 * share it. pm-sdk binds a hook callback per spawn that closes over
 * its sessionKey and drains this buffer.
 *
 * Edge: tool-less turns (Claude answers without firing a tool). The
 * hook never fires, so a queued message would be lost. pm-sdk's
 * onResult handler MUST drain the buffer at turn-end and push the
 * remainder via `inputController.push(..., { shouldQuery: false })`
 * for next-turn injection — no m87 risk because the previous turn
 * ended cleanly with text/end_turn before the push lands.
 */

'use strict';

function createAutosteerBuffer() {
  // sessionKey → array of strings (in order of arrival)
  const queues = new Map();

  function append(sessionKey, text) {
    if (!sessionKey || typeof text !== 'string' || text.length === 0) return false;
    let q = queues.get(sessionKey);
    if (!q) { q = []; queues.set(sessionKey, q); }
    q.push(text);
    return true;
  }

  function drain(sessionKey) {
    const q = queues.get(sessionKey);
    if (!q || q.length === 0) return [];
    queues.delete(sessionKey);
    return q;
  }

  function size(sessionKey) {
    return queues.get(sessionKey)?.length ?? 0;
  }

  function clear(sessionKey) {
    queues.delete(sessionKey);
  }

  // Format the drained messages as the additionalContext payload that
  // Claude trusts. Multiple messages are joined with a blank line so
  // the model sees them as a sequence within a single channel tag.
  function formatForHook(messages) {
    if (!messages || messages.length === 0) return null;
    const body = messages.join('\n\n');
    return `<channel source="user-followup">\n${body}\n</channel>`;
  }

  return { append, drain, size, clear, formatForHook };
}

/**
 * Build the PostToolBatch hook callback that drains the buffer for
 * a specific sessionKey on each tool boundary. The callback shape
 * matches `@anthropic-ai/claude-agent-sdk`'s HookCallback contract
 * (sdk.d.ts:726-728): returns a HookJSONOutput; never throws.
 *
 * @param {object} opts
 * @param {object} opts.buffer        — the per-session buffer instance
 * @param {string} opts.sessionKey    — closure-bound at Query spawn time
 * @param {(kind: string, detail: object) => void} [opts.logEvent]
 *   — optional events.table emitter; called when a drain produces
 *     non-empty output, with kind='autosteer-hook-drained'.
 * @param {string|null} [opts.chatId] — for the logEvent payload only.
 * @param {object} [opts.logger]      — for error logging (must have .error).
 * @param {(sessionKey: string, drainedCount: number) => void} [opts.onDrained]
 *   — fired AFTER the hook successfully injects additionalContext.
 *     rc.37 wires this to clearAutosteeredReactions so the ✍ reaction
 *     fades the moment the agent absorbs the follow-up — not at SDK
 *     turn-end, which under autosteer can stretch tens of minutes
 *     (one SDK turn keeps absorbing follow-ups via additionalContext
 *     and never emits result, so the old turn-end-only cleanup left
 *     ✍ stuck across many user messages).
 *
 * @returns {async () => Promise<HookJSONOutput>}
 */
function makePostToolBatchHook({ buffer, sessionKey, logEvent = null, chatId = null, logger = console, onDrained = null } = {}) {
  if (!buffer) throw new TypeError('buffer required');
  if (!sessionKey) throw new TypeError('sessionKey required');
  return async () => {
    try {
      const drained = buffer.drain(sessionKey);
      if (drained.length === 0) return { continue: true };
      const additionalContext = buffer.formatForHook(drained);
      if (typeof logEvent === 'function') {
        try {
          logEvent('autosteer-hook-drained', {
            chat_id: chatId,
            session_key: sessionKey,
            message_count: drained.length,
          });
        } catch { /* logger errors must not break the hook */ }
      }
      if (typeof onDrained === 'function') {
        try { onDrained(sessionKey, drained.length); }
        catch (err) { logger?.error?.(`[${sessionKey}] onDrained: ${err?.message || err}`); }
      }
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolBatch',
          additionalContext,
        },
      };
    } catch (err) {
      logger?.error?.(`[${sessionKey}] PostToolBatch hook error: ${err?.message || err}`);
      // Never throw out of a hook — the SDK may treat it as a hard
      // fail (`stop_hook_prevented` result subtype). Drop the
      // queued messages on the floor; the user can re-send.
      return { continue: true };
    }
  };
}

module.exports = { createAutosteerBuffer, makePostToolBatchHook };

/**
 * SessionLogParser — converts claude's per-session JSONL file
 * (`~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl`) into the
 * Process abstraction's event surface.
 *
 * This is the REAL structured-event channel for the tmux backend.
 * Previously the plan called for parsing `--debug-file` debug logs,
 * but the v9 probe (one $0.02 haiku turn) revealed that channel
 * emits ONLY infra messages (MDM settings, MCP/LSP lifecycle); the
 * actual conversation events live in the per-session JSONL claude
 * writes to disk for /resume to work.
 *
 * Each JSONL line is a JSON object with `type` discriminator:
 *
 *   { type: 'user',           message: {...} }
 *   { type: 'assistant',      message: {... content: [...], stop_reason: 'end_turn'} }
 *   { type: 'attachment',     attachment: {...} }
 *   { type: 'last-prompt',    lastPrompt: '...' }
 *   { type: 'queue-operation', operation: 'enqueue', content: '...' }
 *
 * # Mapping to Process events
 *
 * - assistant with `content[].type === 'text'`   → emit 'assistant-chunk' { text }
 * - assistant with `content[].type === 'tool_use'` → emit 'tool-use' { name, input }
 * - assistant with `message.stop_reason`         → emit 'result' { subtype, text, ... }
 * - last-prompt                                  → emit 'last-prompt' (fallback complete signal)
 *
 * Robust against malformed lines: returns null and skips.
 *
 * @see lib/tmux/log-tail.js — generic file tailer
 * @see docs/0.10.0-process-manager-abstraction-plan.md v9
 */

'use strict';

const path = require('path');
const os = require('os');

/**
 * Encode an absolute cwd path the way claude does for its
 * ~/.claude/projects/<cwd-encoded> directory. Replaces `/` with `-`
 * and strips leading `-` (since `/Users/x` → `Users-x` per filesystem
 * but claude prepends `-` for absolute paths → `-Users-x`).
 *
 * Example:
 *   /Users/ivanshumkov/Projects/polygram
 *   → -Users-ivanshumkov-Projects-polygram
 */
function encodeCwd(cwd) {
  // Replace path separator with dash; leading dash signals absolute path.
  return cwd.replace(/\//g, '-');
}

// SECURITY (audit L3): sessionId is interpolated into a filesystem
// path. Today it always comes from crypto.randomUUID() or DB
// `chat_state.last_session_id`, but a defensive assert prevents
// future path-traversal regressions if either source ever gets
// tainted (malformed import, etc).
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Build the JSONL session file path for a given cwd + sessionId.
 *
 * @param {string} cwd        — absolute path
 * @param {string} sessionId  — UUID v4
 * @param {string} [homeDir]  — defaults to os.homedir()
 */
function sessionLogPath(cwd, sessionId, homeDir = os.homedir()) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new TypeError(`sessionLogPath: sessionId must be a UUID, got ${JSON.stringify(sessionId)}`);
  }
  return path.join(homeDir, '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

/**
 * Parse one JSONL line into a Process-shaped event, OR null when the
 * line carries nothing observable. Malformed JSON → null.
 *
 * Events returned (each with `type` field):
 *   - 'assistant-chunk' { text }
 *   - 'tool-use'        { name, input, id }
 *   - 'result'          { subtype, text, stopReason }
 *   - 'last-prompt'     { text }
 *
 * @param {string} line
 * @returns {object[]} array of events (a single line CAN produce
 *   multiple — e.g. an assistant message with both text and tool_use
 *   content blocks emits both 'assistant-chunk' and 'tool-use').
 */
function parseLine(line) {
  if (!line || typeof line !== 'string') return [];
  let obj;
  try { obj = JSON.parse(line); }
  catch { return []; }
  if (!obj || typeof obj !== 'object') return [];

  const out = [];

  if (obj.type === 'assistant' && obj.message) {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          out.push({ type: 'assistant-chunk', text: block.text });
        } else if (block.type === 'tool_use' && block.name) {
          out.push({
            type: 'tool-use',
            name: block.name,
            input: block.input ?? null,
            id: block.id ?? null,
          });
        }
      }
    }
    // Token-usage telemetry. Every assistant message carries the
    // cumulative usage snapshot — input_tokens + cache_creation +
    // cache_read = current context size. TmuxProcess uses the latest
    // such event to implement getContextUsage().
    if (obj.message.usage) {
      const u = obj.message.usage;
      out.push({
        type: 'usage',
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        model: obj.message.model ?? null,
      });
    }
    // stop_reason marks end of an assistant turn segment. 'end_turn'
    // is the canonical complete; 'tool_use' / 'max_tokens' / etc. are
    // partial-with-continuation. We forward all stop_reasons so the
    // caller can decide.
    if (obj.message.stop_reason) {
      // Collect all text from the message for the result.text field.
      const text = Array.isArray(content)
        ? content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
        : '';
      out.push({
        type: 'result',
        subtype: obj.message.stop_reason === 'end_turn' ? 'success' : obj.message.stop_reason,
        text,
        stopReason: obj.message.stop_reason,
        sessionId: obj.sessionId ?? null,
      });
    }
  } else if (obj.type === 'last-prompt') {
    out.push({ type: 'last-prompt', text: obj.lastPrompt ?? '' });
  }

  return out;
}

/**
 * Wrap a LogTail (or any EventEmitter that emits 'line') and
 * forward parsed events via 'event'. Returns the emitter so callers
 * can chain `.on('event', ...)`.
 */
function pipeToParser(tail) {
  tail.on('line', (line) => {
    const events = parseLine(line);
    for (const ev of events) tail.emit('event', ev);
  });
  return tail;
}

module.exports = {
  encodeCwd,
  sessionLogPath,
  parseLine,
  pipeToParser,
};

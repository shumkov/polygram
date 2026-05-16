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
 * # Two parsers, one event surface
 *
 * - `parseLine(line)` — STATELESS, one JSONL line → events. Kept for
 *   single-line use and its test coverage. Cannot coalesce a logical
 *   assistant message that spans multiple JSONL lines.
 * - `SessionEventAggregator` — STATEFUL, the primary path used by
 *   `pipeToParser`. It coalesces by `message.id` (0.10.0 Phase 1).
 *
 * ## Why the aggregator exists — the empty-turn bug
 *
 * Verified against real claude 2.1.142 JSONL: ONE logical assistant
 * message is written across MULTIPLE JSONL lines that all share the
 * same `message.id` and all repeat the message-level `stop_reason`.
 * A terminal message commonly arrives as a `thinking` line then a
 * `text` line — both `stop_reason: end_turn`, same id.
 *
 * The stateless parser fires a `result` for EVERY line carrying a
 * stop_reason. The `thinking` line has `end_turn` but no text → it
 * resolves the turn with text='' BEFORE the real-text line is read.
 * That is the zero-concurrency empty-turn bug. The aggregator fixes
 * it by buffering lines per `message.id` and firing `result` ONCE,
 * when the message finalizes, with the full coalesced text.
 *
 * # JSONL line shapes (claude 2.1.142, verified)
 *
 *   { type: 'user',           message: {...}, parentUuid, promptId }
 *   { type: 'assistant',      message: {id, content:[...], stop_reason} }
 *   { type: 'last-prompt',    lastPrompt?: '...' }
 *   { type: 'queue-operation', operation: 'enqueue'|'dequeue', content? }
 *   { type: 'system' | 'attachment' | 'permission-mode' | ... }
 *
 * # Mapping to Process events
 *
 * - assistant text block      → 'assistant-chunk' { text }     (eager, per-line)
 * - assistant tool_use block  → 'tool-use' { name, input, id } (eager, per-line)
 * - assistant usage block     → 'usage' {...}                  (eager, per-line)
 * - assistant message end     → 'result' { subtype, text, stopReason }
 *                               (ONCE per message.id, on finalize)
 * - last-prompt               → 'last-prompt' (fallback complete signal)
 * - user (top-level string)   → 'user-message' { text, parentUuid, promptId }
 * - queue-operation           → 'queue-operation' { operation, content }
 *
 * Robust against malformed lines: skips them.
 *
 * @see lib/tmux/log-tail.js — generic file tailer
 * @see docs/0.10.0-tmux-concurrency-solution.md §3 (Phase 1)
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

// ─── shared content-block extraction ─────────────────────────────────

/**
 * Pull the text + tool_use blocks out of an assistant message's
 * `content` array. Shared by `parseLine` and `SessionEventAggregator`
 * so both surface byte-identical text/tool extraction.
 *
 * @returns {{textParts: string[], toolUses: object[]}}
 */
function extractContentBlocks(content) {
  const textParts = [];
  const toolUses = [];
  if (!Array.isArray(content)) return { textParts, toolUses };
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      textParts.push(block.text);
    } else if (block.type === 'tool_use' && block.name) {
      toolUses.push({
        type: 'tool-use',
        name: block.name,
        input: block.input ?? null,
        id: block.id ?? null,
      });
    }
  }
  return { textParts, toolUses };
}

/**
 * Join assistant text blocks the way the SDK backend's
 * `extractAssistantText` does (rc.8 cross-backend parity): blocks
 * joined with '\n\n', trimmed, with a trailing-colon → ellipsis
 * transform ("Listing deps:" → "Listing deps…") so streamed-but-not-
 * final text reads complete during a pause while a tool runs.
 */
function joinAssistantText(textParts) {
  return textParts.join('\n\n').trim().replace(/([^:]):\s*$/, '$1…');
}

/**
 * Extract the token-usage snapshot from an assistant line, or null.
 * Every assistant message carries the cumulative usage; the latest
 * such event wins downstream.
 */
function extractUsage(obj) {
  const u = obj.message && obj.message.usage;
  if (!u) return null;
  return {
    type: 'usage',
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    model: obj.message.model ?? null,
  };
}

/**
 * Parse one JSONL line into Process-shaped events, OR [] when the
 * line carries nothing observable. Malformed JSON → [].
 *
 * STATELESS — cannot coalesce a multi-line assistant message. For the
 * live tail path use `SessionEventAggregator` (via `pipeToParser`).
 *
 * @param {string} line
 * @returns {object[]}
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
    const { textParts, toolUses } = extractContentBlocks(content);
    // Emit text FIRST then tool-uses — text-then-tool is the dominant
    // real-world shape.
    if (textParts.length > 0) {
      const joined = joinAssistantText(textParts);
      if (joined.length > 0) out.push({ type: 'assistant-chunk', text: joined });
    }
    for (const t of toolUses) out.push(t);
    const usage = extractUsage(obj);
    if (usage) out.push(usage);
    // stop_reason marks end of an assistant turn segment.
    if (obj.message.stop_reason) {
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
  } else if (obj.type === 'user' && obj.message) {
    // Top-level user message — only emit when content is a non-empty
    // string. Array content carries tool_result blocks (API-shaped
    // tool feedback), NOT a user prompt — skip those.
    const content = obj.message.content;
    if (typeof content === 'string' && content.length > 0) {
      out.push({ type: 'user-message', text: content });
    }
  } else if (obj.type === 'attachment' && obj.attachment) {
    const a = obj.attachment;
    if (a.type === 'queued_command' && typeof a.prompt === 'string' && a.prompt.length > 0) {
      out.push({ type: 'queue-folded', prompt: a.prompt });
    }
  }

  return out;
}

// ─── stateful aggregator (0.10.0 Phase 1) ────────────────────────────

/**
 * SessionEventAggregator — stateful JSONL → event translator that
 * coalesces a logical assistant message spanning multiple JSONL lines
 * (all sharing one `message.id`).
 *
 * Contract:
 *   - `assistant-chunk` / `tool-use` / `usage` are emitted EAGERLY,
 *     per JSONL line — live streaming granularity is preserved.
 *   - `result` is emitted ONCE per `message.id`, when that message
 *     FINALIZES. A message finalizes when (a) a line with a different
 *     message.id arrives, (b) any non-assistant line arrives, or
 *     (c) `flush()` is called (turn-complete / tail-close safety net).
 *   - An assistant line WITHOUT a `message.id` is treated as its own
 *     standalone message and parsed per-line via `parseLine` — real
 *     claude always writes `message.id`; absent id only occurs in
 *     synthetic test fixtures, which keep their legacy behaviour.
 *
 * This is what fixes the zero-concurrency empty-turn bug: a `thinking`
 * line no longer resolves the turn before its sibling `text` line.
 */
class SessionEventAggregator {
  constructor() {
    // Buffered in-flight assistant message, or null.
    //   { id, sessionId, parentUuid, textParts: string[], stopReason }
    this._asm = null;
  }

  /**
   * Feed one raw JSONL line. Returns the events it produced (which may
   * include the finalize of a PREVIOUSLY buffered message).
   * @param {string} line
   * @returns {object[]}
   */
  push(line) {
    if (!line || typeof line !== 'string') return [];
    let obj;
    try { obj = JSON.parse(line); }
    catch { return []; }
    if (!obj || typeof obj !== 'object') return [];

    const out = [];

    if (obj.type === 'assistant' && obj.message) {
      const msg = obj.message;
      const id = (typeof msg.id === 'string' && msg.id.length > 0) ? msg.id : null;

      // No message.id — synthetic/legacy line. Finalize any open
      // buffer, then emit this line's events per-line exactly as the
      // stateless parser would (no coalescing without an id to key on).
      if (id === null) {
        if (this._asm) out.push(...this._finalize());
        out.push(...parseLine(line));
        return out;
      }

      // A different message id means the previously buffered message
      // is now complete.
      if (this._asm && this._asm.id !== id) out.push(...this._finalize());
      if (!this._asm) {
        this._asm = {
          id,
          sessionId: obj.sessionId ?? null,
          parentUuid: obj.parentUuid ?? null,
          textParts: [],
          stopReason: null,
        };
      }

      // Eager per-line events. `result` is the ONLY deferred event.
      const { textParts, toolUses } = extractContentBlocks(msg.content);
      if (textParts.length > 0) {
        const joined = joinAssistantText(textParts);
        if (joined.length > 0) {
          this._asm.textParts.push(joined);
          out.push({ type: 'assistant-chunk', text: joined });
        }
      }
      for (const t of toolUses) out.push(t);
      const usage = extractUsage(obj);
      if (usage) out.push(usage);
      // Every line of a message repeats the message-level stop_reason;
      // the last non-null one wins.
      if (msg.stop_reason) this._asm.stopReason = msg.stop_reason;
      return out;
    }

    // Any non-assistant line ends the current assistant message.
    if (this._asm) out.push(...this._finalize());

    if (obj.type === 'user' && obj.message) {
      const content = obj.message.content;
      if (typeof content === 'string' && content.length > 0) {
        out.push({
          type: 'user-message',
          text: content,
          parentUuid: obj.parentUuid ?? null,
          promptId: obj.promptId ?? null,
        });
      }
    } else if (obj.type === 'last-prompt') {
      out.push({ type: 'last-prompt', text: obj.lastPrompt ?? '' });
    } else if (obj.type === 'queue-operation') {
      // The live queue-activity signal (0.10.0 §3). `enqueue` carries
      // the pasted `content`; `dequeue` is bare. Phase 2's turn ledger
      // consumes this to correlate folds vs new-turns by token.
      out.push({
        type: 'queue-operation',
        operation: typeof obj.operation === 'string' ? obj.operation : null,
        content: typeof obj.content === 'string' ? obj.content : null,
      });
    } else if (obj.type === 'attachment' && obj.attachment
      && obj.attachment.type === 'queued_command'
      && typeof obj.attachment.prompt === 'string'
      && obj.attachment.prompt.length > 0) {
      // Retained for parity with `parseLine`. Confirmed ABSENT from
      // real claude 2.1.142 JSONL — the live fold signal is
      // `queue-operation`. Harmless dead branch; Phase 2 retires it.
      out.push({ type: 'queue-folded', prompt: obj.attachment.prompt });
    }
    return out;
  }

  /**
   * Finalize any buffered assistant message. Called on turn-complete
   * and on tail close so the genuinely-last message of a session
   * (which has no trailing line to trigger finalize) still surfaces
   * its `result`. Idempotent.
   * @returns {object[]}
   */
  flush() {
    return this._asm ? this._finalize() : [];
  }

  /** @returns {object[]} the buffered message's `result`, or []. */
  _finalize() {
    const asm = this._asm;
    this._asm = null;
    // A message that never carried a stop_reason produced no turn end
    // — its text already streamed via eager `assistant-chunk`. No
    // `result`. (The `last-prompt` fallback in TmuxProcess covers a
    // genuinely missing end_turn.)
    if (!asm || !asm.stopReason) return [];
    return [{
      type: 'result',
      subtype: asm.stopReason === 'end_turn' ? 'success' : asm.stopReason,
      text: asm.textParts.join('\n\n'),
      stopReason: asm.stopReason,
      sessionId: asm.sessionId,
      parentUuid: asm.parentUuid,
    }];
  }
}

/**
 * Wrap a LogTail (or any EventEmitter that emits 'line') with a
 * `SessionEventAggregator` and forward parsed events via 'event'.
 *
 * The aggregator is flushed on the tail's 'close' so a session whose
 * last assistant message has no trailing line still emits its
 * `result`. The tail is also given a `flushParser()` method so the
 * consumer (TmuxProcess) can force a flush at turn-complete.
 *
 * @returns the same emitter (chainable).
 */
function pipeToParser(tail) {
  const aggregator = new SessionEventAggregator();
  tail.on('line', (line) => {
    for (const ev of aggregator.push(line)) tail.emit('event', ev);
  });
  tail.on('close', () => {
    for (const ev of aggregator.flush()) tail.emit('event', ev);
  });
  // Exposed so TmuxProcess can finalize the buffered message the
  // instant a turn is judged complete (e.g. capture-pane quiescence
  // won the race) instead of waiting for the next JSONL line.
  tail.flushParser = () => {
    for (const ev of aggregator.flush()) tail.emit('event', ev);
  };
  tail._aggregator = aggregator;
  return tail;
}

module.exports = {
  encodeCwd,
  sessionLogPath,
  parseLine,
  SessionEventAggregator,
  pipeToParser,
};

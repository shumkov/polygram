/**
 * Typed content-free schema for `events.detail_json`.
 *
 * Telemetry is a durable text sink written from hundreds of call sites, in
 * this repository and in Orchestra, which calls `db.logEvent` directly. A
 * field-name allowlist is not enough on its own: names like `error` or
 * `reason` are permanent invitations for a message body to be logged under an
 * approved name. So every field declares a TYPE, and a value that does not
 * satisfy it is dropped.
 *
 * The permitted types are all content-free by construction:
 *
 *   id      opaque identifier (session key, turn id, chat id, digest-like)
 *   token   short enum / code / classification, no spaces
 *   int     count, length, byte size, duration, epoch
 *   number  cost, ratio
 *   bool    flag
 *   digest  hex fingerprint of a non-secret (a request id, a config)
 *   ids     bounded array of ids or tokens
 *   shape   nested object whose own fields are typed the same way
 *
 * There is no free-text type. A caller with something to say says it as a
 * code (`error_code`), a classification (`error_class`), a size
 * (`stderr_len`) or a flag (`quarantined`) — never as prose. Fields that used
 * to carry prose (`error`, `message`, `path`, `old_value`, `value`, `topics`,
 * `stderr_tail`, `pane_tail`, `excerpt_head`, `text`, `original`, `note`,
 * `name`) are absent from the schema, so they are dropped wherever they are
 * logged, including from Orchestra.
 *
 * Dropped field NAMES are reported so a loss is visible; values never are.
 * A field carrying `undefined` is simply absent, not a loss, and is not
 * reported.
 */

'use strict';

// Fields deliberately absent. Kept as a list so the intent survives review:
// each one carried a message body, a reply, a TUI tail or a filesystem path.
const REMOVED_FIELDS = Object.freeze([
  'text', 'text_preview', 'original', 'pane_tail', 'paneTail', 'excerpt_head',
  'note', 'name', 'error', 'message', 'path', 'old_value', 'value', 'topics',
  'stderr_tail', 'prompt', 'caption', 'transcript', 'body', 'content',
  'snippet', 'preview', 'answer', 'question', 'raw_truncated', 'parse_error',
]);

// `trigger` is KEPT, typed as a token: producers use it for a cause label
// ('boot', 'auto'), and the type rejects the user's own phrasing that once
// rode in on this name. `name` is not kept — a filename is often a single
// token, so typing alone would not stop it.

const ID = /^[A-Za-z0-9_.:@\/-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9/][A-Za-z0-9_./:@-]{0,63}$/;
const DIGEST = /^[a-f0-9]{8,64}$/;

const isInt = (v) => Number.isSafeInteger(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const TYPES = {
  id: (v) => (typeof v === 'string' && ID.test(v)) || isInt(v),
  token: (v) => typeof v === 'string' && TOKEN.test(v),
  int: isInt,
  number: isNumber,
  bool: (v) => typeof v === 'boolean',
  digest: (v) => typeof v === 'string' && DIGEST.test(v),
  // A code is a short symbol OR a numeric exit/status code — both bounded,
  // neither able to carry a sentence.
  code: (v) => (typeof v === 'string' && TOKEN.test(v)) || isInt(v),
  counts: (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    const entries = Object.entries(v);
    return entries.length <= 32
      && entries.every(([k, n]) => TOKEN.test(k) && Number.isSafeInteger(n));
  },
  ids: (v) => Array.isArray(v) && v.length <= 64
    && v.every((item) => (typeof item === 'string' && ID.test(item)) || isInt(item)),
};

// Nested shapes. Only these keys may appear inside the named field, with the
// same typing rules, so a transcript tail cannot ride one level down.
const SHAPES = {
  busy_probe: {
    busy: 'bool', streaming: 'bool', in_flight: 'bool',
    pending_turns: 'int', captured: 'bool',
  },
  before: { model: 'token', effort: 'token', agent: 'token', pm: 'token' },
  after: { model: 'token', effort: 'token', agent: 'token', pm: 'token' },
};

/**
 * field name → type. Grouped by where the field comes from so the list stays
 * reviewable: Orchestra's process/guard telemetry lands here under its own
 * names, unchanged.
 */
const FIELDS = {
  // ── identity / routing ──────────────────────────────────────────────
  bot: 'token',
  bot_name: 'token',
  chat_id: 'id',
  thread_id: 'id',
  session_key: 'id',
  session_id: 'id',
  claude_session_id: 'id',
  provider_session_id: 'id',
  msg_id: 'id',
  message_id: 'id',
  source_msg_id: 'id',
  source_message_id: 'id',
  target_msg_id: 'id',
  anchor_msg_id: 'id',
  update_id: 'id',
  turn_id: 'id',
  tool_call_id: 'id',
  tool_use_id: 'id',
  attempt_id: 'id',
  target_attempt_id: 'id',
  retry_attempt_id: 'id',
  generation_id: 'id',
  request_id: 'id',
  restart_request_id: 'id',
  restartRequestId: 'id',
  invocationId: 'id',
  reservation_id: 'id',
  linked_input_id: 'id',
  item_id: 'id',
  agent_id: 'id',
  daemon_instance_id: 'id',
  invocation_id: 'id',
  pid: 'int',
  tmux_name: 'id',
  tmux_session: 'id',
  user_id: 'id',
  // The Telegram display name is user-controlled free text, so it is not a
  // telemetry field: `user_id` identifies the actor without it.
  preview_turn_id: 'id',
  reply_turn_id: 'id',
  resumed_session_id: 'id',
  threadId: 'id',
  from_user: 'id',
  from_chat: 'id',
  by: 'id',
  owner: 'id',
  id: 'id',
  new_id: 'id',
  old_chat_id: 'id',
  new_chat_id: 'id',
  original_thread_id: 'id',
  requested_thread_id: 'id',
  echoed_thread_id: 'id',
  expected: 'id',
  topic_ids: 'ids',
  pending_turn_ids: 'ids',
  fields: 'ids',
  reasons: 'ids',
  signals: 'ids',

  // ── classification / state ──────────────────────────────────────────
  kind: 'token',
  action: 'token',
  status: 'token',
  state: 'token',
  from_state: 'token',
  to_state: 'token',
  decision: 'token',
  behavior: 'token',
  outcome: 'token',
  outcome_code: 'code',
  disposition: 'token',
  phase: 'token',
  stage: 'token',
  branch: 'token',
  reason: 'token',
  backend: 'token',
  provider: 'token',
  model: 'token',
  from_model: 'token',
  effort: 'token',
  from_effort: 'token',
  agent: 'token',
  agent_type: 'token',
  pipeline: 'token',
  source: 'token',
  session_source: 'token',
  transport: 'token',
  method: 'token',
  match_type: 'token',
  scope: 'token',
  field: 'token',
  command: 'token',
  command_kind: 'token',
  cancel_mode: 'token',
  kill_reason: 'token',
  shutdown_reason: 'token',
  restart_trigger: 'token',
  trigger: 'token',
  hook_event_name: 'token',
  // SDK hook telemetry: the hook's own classification, whether a Stop hook
  // was already active, and when the daemon received it. All bounded; the
  // hook's payload body is not a field here.
  hook_type: 'token',
  stop_hook_active: 'bool',
  received_at_ms: 'int',
  parse_error_code: 'code',
  result_subtype: 'token',
  subtype: 'token',
  type: 'token',
  tier: 'token',
  priority: 'token',
  language: 'token',
  api_root: 'token',
  tool: 'token',
  tool_name: 'token',
  via: 'token',
  migration: 'token',
  process_state: 'token',
  package_version: 'token',
  from_emoji: 'token',
  to_emoji: 'token',
  error_code: 'code',
  error_class: 'code',
  error_name: 'code',
  errCode: 'code',
  api_error_code: 'code',
  queue_drain_error_code: 'code',
  stop_error_code: 'code',
  feedback_clear_error_code: 'code',
  cause_code: 'code',
  code: 'code',
  prev: 'token',
  next: 'token',
  value_type: 'token',
  when: 'token',

  // ── digests (of non-secret material) ────────────────────────────────
  configured_scope_sha256: 'digest',
  restart_request_sha256: 'digest',
  generation_digest: 'digest',
  attempt_id_hash: 'digest',
  from_hint_hash: 'digest',
  to_hint_hash: 'digest',

  // ── sizes, counts, timings ──────────────────────────────────────────
  text_len: 'int',
  original_len: 'int',
  final_len: 'int',
  reply_len: 'int',
  rescued_len: 'int',
  ack_len: 'int',
  prev_len: 'int',
  new_len: 'int',
  old_len: 'int',
  len: 'int',
  length: 'int',
  error_len: 'int',
  stderr_len: 'int',
  parse_error_len: 'int',
  raw_len: 'int',
  chars: 'int',
  char_count: 'int',
  bytes: 'int',
  byte_size: 'int',
  size: 'int',
  transcript_bytes: 'int',
  post_tokens: 'int',
  pre_tokens: 'int',
  count: 'int',
  total: 'int',
  cap: 'int',
  default: 'int',
  diagnostic: 'int',
  limit: 'int',
  threshold: 'int',
  before: 'shape',
  after: 'shape',
  row_count: 'int',
  chunks: 'int',
  replies: 'int',
  reply_count: 'int',
  receipt_count: 'int',
  recovered_count: 'int',
  skipped_count: 'int',
  codex_scheduled_count: 'int',
  admitted_count: 'int',
  terminal_count: 'int',
  noticed_count: 'int',
  notice_failed_count: 'int',
  deferred_count: 'int',
  interim_count: 'int',
  block_count: 'int',
  media_count: 'int',
  photo_count: 'int',
  video_count: 'int',
  animation_count: 'int',
  shell_count: 'int',
  open_count: 'int',
  pending_count: 'int',
  pending_turns: 'int',
  queue_len: 'int',
  queue_cap: 'int',
  accepted_count: 'int',
  rejected_count: 'int',
  dropped_count: 'int',
  dropped_turns: 'int',
  deleted_attempts: 'int',
  deleted_generations: 'int',
  drained_pendings: 'int',
  resume_intents_recorded: 'int',
  topics_cleared: 'int',
  imported: 'int',
  files: 'int',        // the inbox sweep's file COUNT, not a list of names
  q_index: 'int',
  calls: 'int',
  attempt: 'int',
  active_turn_count: 'int',
  pending_delivery_count: 'int',
  background_owner_count: 'int',
  background_terminal_count: 'int',
  num_assistant_messages: 'int',
  num_tool_uses: 'int',
  policy_version: 'int',
  retention_days: 'int',
  days_left: 'int',
  oom_kill_delta: 'int',
  observed_at_ms: 'int',
  expected_activity_epoch: 'int',
  observed_activity_epoch: 'int',
  original_ts: 'int',
  ts: 'int',
  duration_ms: 'int',
  duration_sec: 'number',
  elapsed_ms: 'int',
  elapsed: 'number',
  idle_ms: 'int',
  lag_ms: 'int',
  stall_ms: 'int',
  wait_ms: 'int',
  window_ms: 'int',
  timeout_ms: 'int',
  turn_timeout_ms: 'int',
  hard_backstop_ms: 'int',
  retry_after_ms: 'int',
  last_hook_age_ms: 'int',
  refresh_token_expires_at: 'int',
  after_failures: 'int',
  failures: 'int',
  cost_usd: 'number',
  cost: 'number',
  total_cost: 'number',
  budget: 'number',
  pct: 'number',

  // ── flags ───────────────────────────────────────────────────────────
  ok: 'bool',
  applied: 'bool',
  aborted: 'bool',
  ambiguous: 'bool',
  active: 'int',       // a live-process COUNT, not a flag
  attempted: 'bool',
  attributed: 'bool',
  already_delivered: 'bool',
  busy: 'bool',
  busy_probe: 'shape',
  captured: 'bool',
  clean: 'bool',
  closed: 'bool',
  consumed_acked: 'bool',
  continuation_authorized: 'bool',
  deferred: 'bool',
  deferred_for_subagent: 'bool',
  deletion_failed: 'bool',
  delivered: 'bool',
  eligible: 'bool',
  exact_match: 'bool',
  failed: 'bool',
  first_event: 'bool',
  had_active: 'bool',
  had_stop: 'bool',
  has_stop_data: 'bool',
  in_flight: 'bool',
  in_flight_at_signal: 'bool',
  interim_only: 'bool',
  is_error: 'bool',
  killed_background_shell: 'bool',
  media_delivered: 'bool',
  media_failed: 'bool',
  noticed: 'bool',
  notice_failed: 'bool',
  oom_shutdown: 'bool',
  pinned: 'bool',
  quarantined: 'bool',
  queue_drained: 'bool',
  recovered: 'bool',
  replay: 'bool',
  replay_marked: 'bool',
  requested: 'bool',
  rescued: 'bool',
  resumed: 'bool',
  sent: 'bool',
  should_query: 'bool',
  skipped: 'bool',
  stop_verified: 'bool',
  streaming: 'bool',
  stopped: 'bool',
  text_failed: 'bool',
  via_text_fallback: 'bool',
  background_terminal_registry_complete: 'bool',

  // ── background sweep + lifecycle diagnostics ────────────────────────
  // The secret sweep's own summary: counts of what it scanned, changed and
  // flagged, plus per-rule counts. Nothing here is derived from a secret's
  // value.
  scanned: 'int',
  redactedMsgs: 'int',
  redactions: 'int',
  flagged: 'int',
  ruleCounts: 'counts',
  dryRun: 'bool',
  reachedCap: 'bool',
  remaining: 'int',
  deleted: 'bool',
  dropped: 'bool',
  overflow: 'bool',

  // ── Orchestra's camelCase counters and identifiers ──────────────────
  // Orchestra logs directly into this sink and names some fields in camel
  // case. They are the same content-free counters and ids as their snake_case
  // neighbours; listing them keeps its telemetry intact without asking an
  // external package to rename anything.
  sessionKey: 'id',
  turnId: 'id',
  totalCost: 'number',
  newCost: 'number',
  turnTimeoutMs: 'int',
  queueCap: 'int',
  drainedPendings: 'int',
  pinnedSkipped: 'int',
  callback: 'token',
  background_shell: 'bool',
  fired: 'bool',

  // ── audit of this boundary itself ───────────────────────────────────
  dropped_fields: 'ids',
  dropped_field_count: 'int',
};

const REMOVED_NAMES = new Set(REMOVED_FIELDS);
const SHAPE_FIELD_NAMES = new Set(
  Object.values(SHAPES).flatMap((shape) => Object.keys(shape)),
);

// Deeper than this is malformed rather than legitimate telemetry.
const MAX_DEPTH = 8;

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function accepts(type, value, key) {
  if (type === 'shape') {
    if (!isPlainObject(value)) return false;
    return true; // fields are checked individually by the caller
  }
  const check = TYPES[type];
  return typeof check === 'function' ? check(value, key) : false;
}

/**
 * Filter a telemetry payload down to the typed schema.
 *
 * A rejected field's NAME is only echoed back when it belongs to this
 * schema's own closed vocabulary — a declared field whose value failed its
 * type, or one of the deliberately removed names. Anything else is counted
 * and nothing more: a key can be caller-controlled (a payload spread from a
 * map keyed by user data puts arbitrary text in the key position), so an
 * unknown name is content, not a diagnostic.
 *
 * @param {object} detail
 * @returns {{ detail:object, dropped:string[], droppedCount:number }} Absent
 *          (`undefined`) fields are not losses and are not counted.
 */
function enforceEventDetailSchema(detail) {
  const dropped = new Set();
  let droppedCount = 0;

  const knownName = (key) => (
    Object.prototype.hasOwnProperty.call(FIELDS, key)
    || REMOVED_NAMES.has(key)
    || SHAPE_FIELD_NAMES.has(key)
  );
  const reject = (key) => {
    droppedCount += 1;
    if (knownName(key)) dropped.add(key);
  };

  const filter = (obj, fieldMap, depth) => {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue; // absent, not dropped
      const type = fieldMap[key];
      if (!type) { reject(key); continue; }
      if (type === 'shape') {
        const shape = SHAPES[key];
        if (!shape || depth >= MAX_DEPTH || !accepts(type, value, key)) {
          reject(key);
          continue;
        }
        out[key] = filter(value, shape, depth + 1);
        continue;
      }
      if (value === null) { out[key] = null; continue; }
      if (!accepts(type, value, key)) { reject(key); continue; }
      out[key] = value;
    }
    return out;
  };

  return {
    detail: isPlainObject(detail) ? filter(detail, FIELDS, 0) : {},
    dropped: [...dropped].sort(),
    droppedCount,
  };
}

module.exports = {
  enforceEventDetailSchema,
  EVENT_DETAIL_FIELDS: FIELDS,
  EVENT_DETAIL_SHAPES: SHAPES,
  REMOVED_FIELDS,
};

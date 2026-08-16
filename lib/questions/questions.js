/**
 * Interactive-question state machine + Telegram rendering (0.12 ask feature).
 *
 * Pure, I/O-free: given an `ask` tool call's questions and the accumulated state,
 * produce the Telegram message body + inline keyboard for the CURRENT question,
 * apply a button tap or a free-text reply, and assemble the final answer payload.
 * All Telegram sends / DB writes / bridge writes live in the callers
 * (lib/handlers/questions.js, callbacks.js, cli-process.js) — this module is the
 * testable core.
 *
 * Design: docs/0.12.0-interactive-questions-design.md. Sequential, one question
 * at a time (P1–P2: single-select, multiSelect, free-text "Other"). Body is
 * rendered PLAIN-TEXT (no parse_mode) because option labels/descriptions are
 * agent-authored and must not reach the Markdown→HTML pipeline (security finding).
 */

'use strict';

const { sanitizeForDurableWrite } = require('../secret-detect');

const MAX_LABEL = 40;       // Telegram button labels truncate ~64; keep well under
const MAX_OTHER = 1000;     // cap on the user's free-text answer entering claude's context
const MAX_PREVIEW = 500;

function truncLabel(label) {
  const s = String(label ?? '');
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s;
}

/** Initial state for an ask call's questions array. */
function initState(questions) {
  return {
    questions: Array.isArray(questions) ? questions : [],
    qIndex: 0,
    answers: [],          // accumulated: [{ header, selected:[label...], other? }]
    toggles: {},          // current multiSelect question: { '<optIndex>': true }
    awaitingOther: false, // current question is in free-text capture mode
  };
}

function currentQuestion(state) {
  return state.questions[state.qIndex] || null;
}

function isDone(state) {
  return state.qIndex >= state.questions.length;
}

/**
 * Render the CURRENT question as { text, reply_markup }. callbackBase is the
 * `q:<qid>:<token>` prefix; actions append `:opt:<i>` / `:submit` / `:other`.
 * Returns null when the set is already done.
 */
function renderCurrent(state, callbackBase) {
  const q = currentQuestion(state);
  if (!q) return null;
  const multi = q.multiSelect === true;
  const total = state.questions.length;
  const opts = Array.isArray(q.options) ? q.options : [];

  const lines = [];
  if (total > 1) lines.push(`Question ${state.qIndex + 1} of ${total}`);
  if (q.header) lines.push(String(q.header));
  lines.push(String(q.question ?? ''));
  lines.push('');
  opts.forEach((o, i) => {
    // Multi-select renders as a checklist (☐ unchecked / ☑️ checked) so it's legible as a
    // tap-to-toggle-then-Submit control, NOT a single-select button. Single-select keeps `•`.
    const mark = multi ? (state.toggles[i] ? '☑️ ' : '☐ ') : '• ';
    lines.push(`${mark}${truncLabel(o.label)}${o.description ? ` — ${o.description}` : ''}`);
    if (o.preview) lines.push(String(o.preview).slice(0, MAX_PREVIEW));
  });
  if (multi) lines.push('\nTap to check/uncheck — pick one or more, then Submit.');

  const rows = opts.map((o, i) => ([{
    // The checkbox glyph on the BUTTON is the load-bearing affordance: an unchecked option
    // must show ☐ (not a bare label) or it reads like a single-select tap-to-submit button.
    text: `${multi ? (state.toggles[i] ? '☑️ ' : '☐ ') : ''}${truncLabel(o.label)}`,
    callback_data: `${callbackBase}:opt:${i}`,
  }]));
  if (multi) {
    const any = Object.values(state.toggles).some(Boolean);
    rows.push([{
      text: any ? '✅ Submit' : '✅ Submit (pick at least one)',
      callback_data: `${callbackBase}:submit`,
    }]);
  }
  if (q.allowOther !== false) {
    rows.push([{ text: '✏️ Type my own', callback_data: `${callbackBase}:other` }]);
  }

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

/** Parse the action suffix of a callback (everything after `q:<qid>:<token>:`). */
function parseAction(suffix) {
  const s = String(suffix ?? '');
  if (s === 'submit') return { type: 'submit' };
  if (s === 'other') return { type: 'other' };
  const m = s.match(/^opt:(\d+)$/);
  if (m) return { type: 'opt', i: Number(m[1]) };
  return { type: 'unknown' };
}

function recordAndAdvance(state, answer) {
  const next = {
    ...state,
    answers: [...state.answers, answer],
    qIndex: state.qIndex + 1,
    toggles: {},
    awaitingOther: false,
  };
  return next;
}

/**
 * Apply a button tap. Returns:
 *   { state, kind:'toggled' }                 — multiSelect toggle, re-render
 *   { state, kind:'awaiting-other' }          — user wants to type their own
 *   { state, kind:'reject', message }         — invalid (e.g. submit with none)
 *   { state, kind:'advanced', receipt, done } — answer recorded; done if set complete
 */
function applyTap(state, action) {
  const q = currentQuestion(state);
  if (!q) return { state, kind: 'reject', message: 'No active question.' };
  const opts = Array.isArray(q.options) ? q.options : [];
  const multi = q.multiSelect === true;

  if (action.type === 'other') {
    if (q.allowOther === false) return { state, kind: 'reject', message: 'Free text not allowed here.' };
    return { state: { ...state, awaitingOther: true }, kind: 'awaiting-other' };
  }

  if (action.type === 'opt') {
    if (action.i < 0 || action.i >= opts.length) {
      return { state, kind: 'reject', message: 'Unknown option.' };
    }
    if (multi) {
      const toggles = { ...state.toggles };
      if (toggles[action.i]) delete toggles[action.i]; else toggles[action.i] = true;
      return { state: { ...state, toggles }, kind: 'toggled' };
    }
    // single-select: record + advance
    const label = opts[action.i].label;
    const next = recordAndAdvance(state, { header: q.header, selected: [label] });
    return { state: next, kind: 'advanced', receipt: label, done: isDone(next) };
  }

  if (action.type === 'submit') {
    if (!multi) return { state, kind: 'reject', message: 'Nothing to submit.' };
    const picked = Object.keys(state.toggles).filter(k => state.toggles[k]).map(Number).sort((a, b) => a - b);
    if (picked.length === 0) return { state, kind: 'reject', message: 'Pick at least one option.' };
    const labels = picked.map(i => opts[i].label);
    const next = recordAndAdvance(state, { header: q.header, selected: labels });
    return { state: next, kind: 'advanced', receipt: labels.join(', '), done: isDone(next) };
  }

  return { state, kind: 'reject', message: 'Unknown action.' };
}

/**
 * Apply a free-text reply (the user's "Other" answer). Only valid when the
 * current question is in awaitingOther mode. Returns the same advanced shape.
 */
function applyFreeText(state, text) {
  const q = currentQuestion(state);
  if (!q || !state.awaitingOther) return { state, kind: 'reject', message: 'Not awaiting a typed answer.' };
  const other = String(text ?? '').slice(0, MAX_OTHER);
  const next = recordAndAdvance(state, { header: q.header, selected: [], other });
  return { state: next, kind: 'advanced', receipt: other, done: isDone(next) };
}

/**
 * Whether a recorded answer carries a credential the durable boundary would
 * mask. It lives beside the answer shape so a new field cannot be added
 * without this seeing it. Every text-bearing part counts: the header copied
 * from the agent's question, the selected option labels, and a typed value.
 * The durable-write sanitizer decides, so its allowlist applies — "password:
 * required" is ordinary vocabulary, not a secret.
 */
function answerIsFlagged(answer) {
  const parts = [
    ...(answer?.header != null ? [answer.header] : []),
    ...(answer?.selected || []),
    ...(answer?.other != null ? [answer.other] : []),
  ];
  return parts.some((part) => sanitizeForDurableWrite(String(part)).changed);
}

/**
 * The durable stand-in for an answer whose text is being held live. It carries
 * no answer text at all — a placeholder string would be indistinguishable from
 * something the user actually chose, and could be delivered as one. The header
 * is sanitized because it is copied from the agent's question.
 */
function markOmitted(answer) {
  return {
    header: sanitizeForDurableWrite(String(answer?.header ?? '')).text,
    selected: [],
    secret_omitted: true,
  };
}

const isOmitted = (answer) => !!(answer && answer.secret_omitted);

/**
 * Resolve the answers for delivery. Returns a discriminated result rather than
 * throwing or substituting: a marker means the exact answer was held live and
 * the holder is gone, and the caller must cancel instead of sending anything
 * upstream. No value or marker is ever put in an error.
 */
function resolveForDelivery(state) {
  const answers = Array.isArray(state?.answers) ? state.answers : [];
  if (answers.some(isOmitted)) return { ok: false, reason: 'live-answer-missing' };
  return { ok: true, result: { answers } };
}

/** Final tool result once the set is done. */
function assemble(state) {
  return { answers: state.answers };
}

module.exports = {
  initState,
  currentQuestion,
  isDone,
  renderCurrent,
  parseAction,
  applyTap,
  applyFreeText,
  assemble,
  answerIsFlagged,
  markOmitted,
  isOmitted,
  resolveForDelivery,
  MAX_LABEL,
  MAX_OTHER,
};

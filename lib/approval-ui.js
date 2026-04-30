/**
 * Pure UI builders for the approval flow's Telegram surface.
 *
 *   - 2-button keyboard (CLI pm IPC approval-hook flow)
 *   - 4-button keyboard (rc.6 SDK pm canUseTool flow with persisted
 *     "Always allow / Always deny" via chat_tool_decisions)
 *   - Card text with friendly heading + clipped tool_input body
 *
 * No runtime dependencies — these are pure transforms suitable for
 * unit-testing in isolation. The polygram.js side wires them to
 * `tg(bot, 'sendMessage', ...)` / `editMessageText`.
 */

'use strict';

/**
 * 2-button keyboard for the legacy IPC approval flow.
 * @param {number|string} approvalId
 * @param {string} token
 */
function buildApprovalKeyboard(approvalId, token) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${approvalId}:${token}` },
      { text: '❌ Deny',    callback_data: `deny:${approvalId}:${token}` },
    ]],
  };
}

/**
 * 4-button keyboard for the SDK canUseTool flow (rc.6 Phase 2 step 6).
 * "Always allow" / "Always deny" rows persist the decision into
 * `chat_tool_decisions` so subsequent invocations of the same tool
 * with the same input short-circuit.
 *
 * Callback_data conventions:
 *   approve:<id>:<token>          — one-time allow
 *   deny:<id>:<token>             — one-time deny
 *   approve-always:<id>:<token>   — allow + persist
 *   deny-always:<id>:<token>      — deny + persist
 *
 * @param {number|string} approvalId
 * @param {string} token
 */
function buildApprovalKeyboardWithAlways(approvalId, token) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${approvalId}:${token}` },
        { text: '❌ Deny',    callback_data: `deny:${approvalId}:${token}` },
      ],
      [
        { text: '🔁 Always allow', callback_data: `approve-always:${approvalId}:${token}` },
        { text: '🚫 Always deny',  callback_data: `deny-always:${approvalId}:${token}` },
      ],
    ],
  };
}

/**
 * Format a tool_input value for the inline-keyboard card body.
 * Clips aggressively so the whole card stays under Telegram's
 * 4096-char limit (approval card has surrounding metadata too).
 *
 * @param {unknown} input — string OR any JSON-able object
 * @returns {string}
 */
function formatToolInputForCard(input) {
  let s;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch {
    s = String(input);
  }
  // JSON.stringify(undefined) returns undefined, and objects with
  // a circular toJSON could surface odd values too. Fall back to
  // String() so we always operate on a real string.
  if (typeof s !== 'string') s = String(input);
  if (s.length <= 1200) return s;
  return s.slice(0, 900) + '\n…[clipped]…\n' + s.slice(-200);
}

/**
 * Approval card text. Plain-text only (NO parse_mode) — tool_input
 * originates from Claude and could contain Markdown specials or
 * tg:// links crafted for phishing.
 *
 * @param {object} row             — approval row from the approvals store
 * @param {string} row.tool_name
 * @param {number|string|null} row.turn_id
 * @param {string} row.requester_chat_id
 * @param {object|string|null} [row.tool_input_json]
 * @param {object|string|null} [row.tool_input]    — alias for tool_input_json
 * @param {number} row.timeout_ts  — unix ms when the row expires
 * @param {object} [opts]
 * @param {string} [opts.resolvedBy] — heading override for resolved cards
 *                                     (e.g. "✓ Approved by ivan").
 *                                     When set, footer is dropped.
 *                                     When unset, heading is "Approval needed — <tool>"
 *                                     and footer shows seconds-to-expire.
 * @param {() => number} [opts.now]  — clock injection for tests
 *
 * @returns {string}
 */
function approvalCardText(row, opts = {}) {
  const now = (typeof opts.now === 'function' ? opts.now : Date.now)();
  const heading = opts.resolvedBy
    ? opts.resolvedBy
    : `Approval needed — ${row.tool_name}`;
  // tool_input may arrive as a parsed object OR a JSON string under
  // either key name depending on the call site.
  const inputSource = row.tool_input_json !== undefined
    ? row.tool_input_json
    : row.tool_input;
  const parsed = typeof inputSource === 'string'
    ? safeParse(inputSource)
    : inputSource;
  const body = formatToolInputForCard(parsed);
  const ttl = Math.max(0, Math.round((row.timeout_ts - now) / 1000));
  const footer = opts.resolvedBy ? '' : `\n\n⏱ expires in ${ttl}s`;
  return `${heading}\nChat: ${row.requester_chat_id}\nTurn: ${row.turn_id || '-'}\n\n${body}${footer}`;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = {
  buildApprovalKeyboard,
  buildApprovalKeyboardWithAlways,
  formatToolInputForCard,
  approvalCardText,
  // Internals exposed for tests
  _safeParse: safeParse,
};

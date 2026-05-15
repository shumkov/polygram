/**
 * Normalize the tool-input string parsed from a claude TUI approval
 * prompt into a canUseTool-shaped object — so the rest of polygram's
 * approval plumbing (chat_tool_decisions persistence, approvalCardText
 * rendering, matchesApprovalPattern gating) works uniformly across
 * SDK and tmux backends.
 *
 * The TUI's invocation line looks like:
 *
 *   ⏺ Bash(rm /tmp/foo.txt)
 *   ⏺ Read(/Users/x/y.txt)
 *   ⏺ Write(/path/file, "contents")
 *
 * What lands in `rawArg` is everything between the parens. Mapping is
 * heuristic — the TUI doesn't tag args by name, so we map common tools
 * to their known field shapes; anything else becomes `{ _raw: <str> }`
 * so the approval card still renders something readable.
 *
 * The shape doesn't need to be byte-identical to what SDK's canUseTool
 * receives — it only needs to be:
 *   - consistent enough that chat_tool_decisions can hash + match it
 *   - readable enough that the approval card body shows useful info
 *   - serializable to JSON
 */

'use strict';

/**
 * @param {string} toolName  — e.g. 'Bash', 'Read', 'Write'
 * @param {string} rawArg    — the parenthesised content
 * @returns {object}
 */
function normalizeTuiToolInput(toolName, rawArg) {
  const arg = typeof rawArg === 'string' ? rawArg : '';
  switch (toolName) {
    case 'Bash':
      return { command: arg };
    case 'Read':
    case 'Glob':
      return { file_path: arg };
    case 'Write':
    case 'Edit': {
      // Best-effort split on first comma; the TUI doesn't escape so
      // commands with commas inside arg #1 will misparse. The
      // approval card still shows the raw shape, so the operator
      // can read the actual command before approving.
      const commaIdx = arg.indexOf(',');
      if (commaIdx === -1) return { file_path: arg };
      return {
        file_path: arg.slice(0, commaIdx).trim(),
        _raw_tail: arg.slice(commaIdx + 1).trim(),
      };
    }
    case 'WebFetch':
    case 'WebSearch':
      return { url: arg };
    default:
      return { _raw: arg };
  }
}

module.exports = { normalizeTuiToolInput };

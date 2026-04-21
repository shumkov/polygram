#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook -> bridge daemon approval round-trip.
 *
 * Installed into an agent's settings.json:
 *   { "hooks": { "PreToolUse": [
 *     { "matcher": "Bash|WebFetch|mcp__*", "hooks": [
 *       { "type": "command",
 *         "command": "/Users/YOURNAME/polygram/bin/bridge-approval-hook.js" }
 *     ]}
 *   ]}}
 *
 * Environment (set by the bridge when spawning Claude):
 *   BRIDGE_BOT       - bot name owning this session (socket suffix)
 *   BRIDGE_CHAT_ID   - chat whose message triggered this turn (for the card)
 *   BRIDGE_TURN_ID   - optional; helps dedupe re-fires on Claude retries
 *
 * Contract (Claude Code):
 *   stdin  JSON: { session_id, hook_event_name: "PreToolUse",
 *                  tool_name, tool_input, ... }
 *   stdout JSON reply for PreToolUse: either pass-through (exit 0 empty stdout),
 *          or a block decision:
 *     {"hookSpecificOutput": {"hookEventName":"PreToolUse",
 *                             "permissionDecision":"allow"|"deny"|"ask",
 *                             "permissionDecisionReason":"..."}}
 *   Exit codes:
 *     0 - allow (empty stdout) or structured decision in stdout
 *     2 - block (deny)
 *
 * Failure policy: on IPC error (bridge down, socket missing, timeout) we
 * deny by default. Better to block a legitimate tool call than to let a
 * destructive one through when the approver is unreachable.
 */

const fs = require('fs');

(async () => {
  const botName = process.env.BRIDGE_BOT;
  const chatId  = process.env.BRIDGE_CHAT_ID;
  const turnId  = process.env.BRIDGE_TURN_ID || null;

  if (!botName || !chatId) {
    deny('bridge-approval-hook: BRIDGE_BOT and BRIDGE_CHAT_ID env vars required');
    return;
  }

  let req;
  try {
    req = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (err) {
    deny(`bad hook input: ${err.message}`);
    return;
  }
  if (req.hook_event_name !== 'PreToolUse') {
    // Not our event; pass through silently.
    process.exit(0);
  }

  // Resolve relative to this hook's own location rather than a hardcoded
  // absolute path — an absolute-path require is a symlink-swap RCE vector
  // (anyone who can write to that path gets code execution in-bridge).
  const path = require('path');
  const { call, socketPathFor, readSecret } = require(path.join(__dirname, '..', 'lib', 'ipc-client'));
  let res;
  try {
    res = await call({
      path: socketPathFor(botName),
      op: 'approval_request',
      secret: readSecret(botName),
      payload: {
        bot_name: botName,
        chat_id: chatId,
        turn_id: turnId,
        tool_name: req.tool_name,
        tool_input: req.tool_input,
      },
    });
  } catch (err) {
    deny(`bridge unreachable: ${err.message}`);
    return;
  }

  if (!res || !res.ok) {
    deny(`bridge error: ${res?.error || 'unknown'}`);
    return;
  }

  // Bridge signals one of: 'not-gated' | 'approved' | 'denied' | 'timeout' | 'auto-approved'
  if (res.decision === 'not-gated' || res.decision === 'approved' || res.decision === 'auto-approved') {
    // Pass through — let the default permission flow decide. An empty
    // stdout + exit 0 means "no opinion" from this hook.
    process.exit(0);
  }

  const reason = res.reason || `approval ${res.decision}`;
  deny(reason, res.decision);
})().catch((err) => {
  deny(`hook crashed: ${err.message}`);
});

function deny(reason, decision = 'denied') {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[${decision}] ${reason}`,
    },
  };
  try {
    process.stdout.write(JSON.stringify(out));
  } catch {}
  process.exit(2);
}

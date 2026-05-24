/**
 * Bridge ↔ daemon socket protocol — typed schemas.
 *
 * Wire format: newline-delimited JSON over a unix socket per session.
 * Both endpoints (ChannelsProcess and channels-bridge.mjs) speak the same
 * message kinds. This module centralizes the shape so both sides safeParse
 * inbound messages with the same constraints — protecting against malformed
 * payloads silently corrupting pending-state Maps.
 *
 * Adding a new message kind:
 *   1. Define its schema below as `<KindName>MessageSchema`
 *   2. Add it to `AnyDaemonToBridgeMessage` or `AnyBridgeToDaemonMessage`
 *   3. Handle it in the corresponding switch (channels-process.js
 *      _onBridgeMsg or channels-bridge.mjs handleDaemonMessage)
 *
 * Validation policy:
 *   - Daemon side uses `safeParse` and drops malformed messages with a warn
 *     (downgrades silent corruption into observable log)
 *   - Bridge side does the same on inbound from daemon
 *   - All validation happens AFTER hello-handshake auth (the auth gate is
 *     the first line of defense; schema is the second)
 */

'use strict';

const { z } = require('zod');

// ─── shared primitives ─────────────────────────────────────────────

const NonEmptyString = z.string().min(1);
const OptionalString = z.string().optional();
const ToolCallId     = z.string().min(1);
const RequestId      = z.string().min(1);
const TurnId         = z.string().min(1);

// ─── bridge → daemon ───────────────────────────────────────────────

const HelloSchema = z.object({
  kind: z.literal('hello'),
  session_key: NonEmptyString,
  secret:      NonEmptyString,
}).passthrough();

const SessionInitSchema = z.object({
  kind: z.literal('session_init'),
  claude_session_id: z.string(),   // may be empty if claude generated one before bridge sees it
}).passthrough();

const ToolCallMessageSchema = z.object({
  kind: z.literal('tool'),
  session: NonEmptyString,
  tool_call_id: ToolCallId,
  name: z.enum(['reply', 'react', 'edit_message']),
  args: z.object({}).passthrough(),
}).passthrough();

const PermRequestMessageSchema = z.object({
  kind: z.literal('perm_req'),
  session: NonEmptyString,
  request_id: RequestId,
  tool_name: NonEmptyString,
  description: z.string(),
  input_preview: z.string(),
}).passthrough();

const PongMessageSchema = z.object({
  kind: z.literal('pong'),
}).passthrough();

const AnyBridgeToDaemonMessage = z.discriminatedUnion('kind', [
  HelloSchema,
  SessionInitSchema,
  ToolCallMessageSchema,
  PermRequestMessageSchema,
  PongMessageSchema,
]);

// ─── daemon → bridge ───────────────────────────────────────────────

const HelloAckSchema = z.object({
  kind: z.literal('hello_ack'),
}).passthrough();

const HelloRejectSchema = z.object({
  kind: z.literal('hello_reject'),
  reason: z.string().optional(),
}).passthrough();

const UserMessageSchema = z.object({
  kind: z.literal('user_msg'),
  text: z.string(),
  chat_id: z.union([z.string(), z.number()]).optional(),
  user:    OptionalString,
  msg_id:  z.union([z.string(), z.number()]).optional(),
  turn_id: OptionalString,
}).passthrough();

const PermVerdictMessageSchema = z.object({
  kind: z.literal('perm_verdict'),
  request_id: RequestId,
  behavior: z.enum(['allow', 'deny']),
}).passthrough();

const ToolAckMessageSchema = z.object({
  kind: z.literal('tool_ack'),
  tool_call_id: ToolCallId,
  ok: z.boolean(),
  error: z.string().optional(),
}).passthrough();

const PingMessageSchema = z.object({
  kind: z.literal('ping'),
}).passthrough();

const AnyDaemonToBridgeMessage = z.discriminatedUnion('kind', [
  HelloAckSchema,
  HelloRejectSchema,
  UserMessageSchema,
  PermVerdictMessageSchema,
  ToolAckMessageSchema,
  PingMessageSchema,
]);

// ─── helpers ──────────────────────────────────────────────────────

/**
 * Parse + validate a bridge → daemon message. Returns
 * {ok:true, msg} on success or {ok:false, error} on failure.
 *
 * @param {unknown} raw — already JSON.parsed object
 * @returns {{ok: true, msg: object}|{ok: false, error: string}}
 */
function parseBridgeToDaemonMessage(raw) {
  const r = AnyBridgeToDaemonMessage.safeParse(raw);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: zodErrorBrief(r.error, raw?.kind) };
}

function parseDaemonToBridgeMessage(raw) {
  const r = AnyDaemonToBridgeMessage.safeParse(raw);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: zodErrorBrief(r.error, raw?.kind) };
}

function zodErrorBrief(err, kindHint) {
  const issues = (err?.issues || []).slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`);
  return `kind=${kindHint || '?'} — ${issues.join('; ') || 'unknown'}`;
}

module.exports = {
  // schemas (exported for tests + downstream consumers)
  HelloSchema,
  SessionInitSchema,
  ToolCallMessageSchema,
  PermRequestMessageSchema,
  PongMessageSchema,
  AnyBridgeToDaemonMessage,
  HelloAckSchema,
  HelloRejectSchema,
  UserMessageSchema,
  PermVerdictMessageSchema,
  ToolAckMessageSchema,
  PingMessageSchema,
  AnyDaemonToBridgeMessage,
  // helpers
  parseBridgeToDaemonMessage,
  parseDaemonToBridgeMessage,
};

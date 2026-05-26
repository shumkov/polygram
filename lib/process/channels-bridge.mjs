#!/usr/bin/env node
// polygram-bridge — production Channels MCP bridge for ChannelsProcess.
//
// Runs as stdio child of `claude --dangerously-load-development-channels server:polygram-bridge`.
// Connects back to its parent ChannelsProcess (in the polygram daemon) over a per-session
// unix socket whose path + auth secret are passed via env.
//
// Owns nothing semantic. Pure proxy:
//   daemon  → bridge:  user_msg, perm_verdict, tool_ack, ping
//   bridge → daemon:   hello, session_init, tool, perm_req, pong
//
// The bridge process exits on any of:
//   - stdin EOF/close                       (claude crashed or shutdown)
//   - no ping from daemon for 30s           (daemon stalled or crashed)
//   - hello handshake rejected by daemon
//   - unix socket disconnect
//
// All inbound user content is XML-escaped before placement into the
// <channel> body — prompt-injection defense (P1 security finding).
//
// See docs/0.11.0-channels-driver-plan.md for the full design.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
// Review F#15: validate daemon→bridge messages with the shared zod schema.
// Pre-fix handleDaemonMessage operated on raw JSON.parse output — a
// malformed user_msg (e.g. text=undefined) silently injected the literal
// string "undefined" into Claude's prompt; a malformed tool_ack with
// null tool_call_id silently no-op'd and the bridge timed out on
// awaitToolAck → isError → Claude retry.
import { parseDaemonToBridgeMessage } from './channels-bridge-protocol.js'
import { z } from 'zod'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SESSION_KEY = process.env.POLYGRAM_SESSION_KEY
const SOCK        = process.env.POLYGRAM_SOCK
const SOCK_SECRET = process.env.POLYGRAM_SOCK_SECRET
// P3 naming: align internal variable with the env-var name + wire-format field.
const CLAUDE_SESSION_ID = process.env.POLYGRAM_CLAUDE_SESSION_ID

if (!SESSION_KEY || !SOCK || !SOCK_SECRET) {
  process.stderr.write('[polygram-bridge] missing required env (POLYGRAM_SESSION_KEY/SOCK/SOCK_SECRET)\n')
  process.exit(2)
}

// rc.11 diagnostic: bridge stderr goes to claude's TUI which is a tiny
// scrollback. The Music-topic shumorobot live failure leaves no trace of
// whether user_msg ever reached the bridge or whether the MCP notification
// dispatched successfully. Mirror every log line to a per-session file so
// we can definitively pin the failure point.
const LOG_DIR = join(homedir(), '.polygram', 'bridge-logs')
try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
// Filename: session-key gets sanitized (`:` → `_`) for file safety.
const LOG_FILE = join(LOG_DIR, `${String(SESSION_KEY).replace(/[^a-zA-Z0-9_-]/g, '_')}.${process.pid}.log`)
const fileWrite = (line) => { try { appendFileSync(LOG_FILE, line + '\n') } catch {} }

const log = (kind, payload = {}) => {
  const line = `[polygram-bridge] ${JSON.stringify({ t: Date.now(), kind, ...payload })}`
  process.stderr.write(line + '\n')
  fileWrite(line)
}
log('boot', { session_key: SESSION_KEY, log_file: LOG_FILE, pid: process.pid })

// ─── Stdin EOF → claude crashed; we exit so the daemon notices via socket close ──
process.stdin.on('end',   () => { log('stdin', { event: 'end'   }); process.exit(0) })
process.stdin.on('close', () => { log('stdin', { event: 'close' }); process.exit(0) })

// ─── Watchdog: exit if daemon stops pinging ──
let lastPing = Date.now()
setInterval(() => {
  if (Date.now() - lastPing > 30_000) {
    log('watchdog', { event: 'ping-timeout' })
    process.exit(3)
  }
}, 5_000).unref()

// ─── XML-escape inbound user content (prompt-injection defense) ──
// Body escape: covers &, <, > so user text can't open/close <channel> tags
// or inject entity references.
const escapeChannelBody = s =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Attribute escape: review #10. Meta values (chat_id, user, msg_id, turn_id)
// end up inside <channel ... key="value"> attributes. Telegram first_name is
// fully user-controlled and can contain double-quote, single-quote, &, <, >.
// Without escaping, a display name like `" injected="...</channel><system>...`
// breaks out of the attribute and injects into Claude's prompt.
const escapeChannelAttr = s =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

// ─── Per-call pending map: tool calls wait for daemon tool_ack ──
const pendingToolCalls = new Map() // tool_call_id → { resolve, reject, timer }
const TOOL_ACK_TIMEOUT_MS = 30_000

function awaitToolAck(toolCallId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingToolCalls.delete(toolCallId)
      reject(new Error('daemon ack timeout'))
    }, TOOL_ACK_TIMEOUT_MS)
    pendingToolCalls.set(toolCallId, { resolve, reject, timer })
  })
}

function resolveToolAck(toolCallId, ok, error) {
  const p = pendingToolCalls.get(toolCallId)
  if (!p) return
  pendingToolCalls.delete(toolCallId)
  clearTimeout(p.timer)
  ok ? p.resolve() : p.reject(new Error(error || 'daemon rejected delivery'))
}

// ─── Socket: connect, handshake, then bidirectional JSON-lines ──
const sock = connect(SOCK)

sock.on('connect', () => {
  log('socket', { event: 'connect' })
  // hello + announce session_id in the same flush; daemon validates secret
  sock.write(JSON.stringify({ kind: 'hello', session_key: SESSION_KEY, secret: SOCK_SECRET }) + '\n')
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: CLAUDE_SESSION_ID }) + '\n')
})

sock.on('error', err => {
  log('socket', { event: 'error', message: err.message })
  process.exit(4)
})

sock.on('close', () => {
  log('socket', { event: 'close' })
  process.exit(5)
})

// ─── Inbound from daemon → forward into Claude as MCP notifications ──
let buf = ''
sock.on('data', chunk => {
  // Review R5: only `ping` resets the watchdog. Non-ping noise (user_msg
  // bursts, tool_acks, perm_verdicts) used to satisfy the liveness check
  // even when the daemon's ping loop had silently died. lastPing is now
  // updated ONLY in the case 'ping' branch below.
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { log('parse-error', { line: line.slice(0, 200) }); continue }
    // Review F#15: zod-validate before dispatch. Malformed messages drop with
    // a log instead of silently corrupting downstream state. hello_ack /
    // hello_reject are skipped here because they're pre-auth and the
    // discriminated union expects only post-auth shapes — handle them
    // directly off the raw payload.
    if (raw.kind === 'hello_ack' || raw.kind === 'hello_reject') {
      handleDaemonMessage(raw)
      continue
    }
    const parsed = parseDaemonToBridgeMessage(raw)
    if (!parsed.ok) {
      log('daemon-msg-schema-invalid', { kind: raw?.kind, error: parsed.error })
      continue
    }
    handleDaemonMessage(parsed.msg)
  }
})

function handleDaemonMessage(msg) {
  switch (msg.kind) {
    case 'hello_ack':
      log('handshake', { event: 'ack' })
      break

    case 'hello_reject':
      log('handshake', { event: 'reject', reason: msg.reason })
      process.exit(6)
      break

    case 'user_msg':
      log('user_msg-rx', { text_len: msg.text?.length, turn_id: msg.turn_id, chat_id: msg.chat_id })
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: escapeChannelBody(msg.text),
          meta: {
            // Review #10: attribute-safe escape for ALL meta values, not just
            // content. Telegram first_name is user-controlled and was previously
            // raw — could break out of the attribute via quote injection.
            chat_id: escapeChannelAttr(msg.chat_id ?? ''),
            user:    escapeChannelAttr(msg.user ?? ''),
            msg_id:  escapeChannelAttr(msg.msg_id ?? ''),
            turn_id: escapeChannelAttr(msg.turn_id ?? ''),
          },
        },
      }).then(
        () => log('user_msg-notify-ok', { turn_id: msg.turn_id }),
        (e) => log('notify-error', { kind: 'user_msg', error: e.message }),
      )
      break

    case 'perm_verdict':
      mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      }).catch(e => log('notify-error', { kind: 'perm_verdict', error: e.message }))
      break

    case 'tool_ack':
      resolveToolAck(msg.tool_call_id, msg.ok, msg.error)
      break

    case 'ping':
      // R5: ping is the ONLY signal that proves the daemon's ping-loop is
      // healthy. Update watchdog timestamp here, not on the generic 'data'
      // event — otherwise unrelated traffic could mask a dead ping-loop.
      lastPing = Date.now()
      sock.write(JSON.stringify({ kind: 'pong' }) + '\n')
      break

    default:
      log('unknown-kind', { kind: msg.kind })
  }
}

// ─── MCP server: capabilities + reply tool ──
const mcp = new Server(
  { name: 'polygram-bridge', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    // Phase 0 finding: Claude refers to tools by their prefixed MCP name.
    // Mention the prefixed form explicitly so reasoning doesn't drift.
    instructions:
      'Inbound user messages arrive as <channel source="polygram-bridge" chat_id="..." user="..."> tags. ' +
      'Always reply via the `mcp__polygram-bridge__reply` tool — passing chat_id verbatim — before ending a turn. ' +
      'For long tool calls, send a brief progress reply first so the user is not waiting in silence.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back to the originating Telegram chat. ' +
                 'chat_id MUST match the chat_id from the inbound <channel> tag. ' +
                 'turn_id MUST echo the turn_id from the inbound <channel> tag (when present) ' +
                 'so concurrent turns route their replies correctly.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Echo of chat_id from inbound channel meta.' },
        turn_id: { type: 'string', description: 'Echo of turn_id from inbound channel meta (required for correct turn routing).' },
        text:    { type: 'string', description: 'Message body (markdown ok).' },
        files:   { type: 'array',  items: { type: 'string' }, description: 'Optional absolute file paths to attach.' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  const toolCallId = randomUUID()
  const ackP = awaitToolAck(toolCallId)
  sock.write(JSON.stringify({
    kind: 'tool',
    session: SESSION_KEY,
    tool_call_id: toolCallId,
    name: req.params.name,
    args: req.params.arguments,
  }) + '\n')
  try {
    await ackP
    return { content: [{ type: 'text', text: 'sent' }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `delivery failed: ${err.message}` }], isError: true }
  }
})

// ─── Permission relay: Claude Code → bridge → daemon → human → verdict back ──
// Review F#14: only request_id + tool_name are required. description /
// input_preview MAY be empty (Bash with no args, future tool variants, slim
// tools that don't carry a preview). Pre-fix any of those four being absent
// or empty rejected the whole notification — MCP silently dropped the perm
// request, no approval card surfaced, Claude blocked forever waiting for a
// verdict that never came. Now those two are optional+defaulted to '' so
// the perm request always relays.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id:    z.string().min(1),
    tool_name:     z.string().min(1),
    description:   z.string().optional().default(''),
    input_preview: z.string().optional().default(''),
  }).passthrough(),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  sock.write(JSON.stringify({
    kind: 'perm_req',
    session: SESSION_KEY,
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  }) + '\n')
})

await mcp.connect(new StdioServerTransport())
log('startup', { pid: process.pid, node: process.version, session_key: SESSION_KEY })

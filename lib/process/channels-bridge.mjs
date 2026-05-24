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
import { z } from 'zod'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'

const SESSION_KEY = process.env.POLYGRAM_SESSION_KEY
const SOCK        = process.env.POLYGRAM_SOCK
const SOCK_SECRET = process.env.POLYGRAM_SOCK_SECRET
const CLAUDE_SID  = process.env.POLYGRAM_CLAUDE_SESSION_ID

if (!SESSION_KEY || !SOCK || !SOCK_SECRET) {
  process.stderr.write('[polygram-bridge] missing required env (POLYGRAM_SESSION_KEY/SOCK/SOCK_SECRET)\n')
  process.exit(2)
}

const log = (kind, payload = {}) =>
  process.stderr.write(`[polygram-bridge] ${JSON.stringify({ t: Date.now(), kind, ...payload })}\n`)

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
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: CLAUDE_SID }) + '\n')
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
  lastPing = Date.now()    // any inbound traffic counts as liveness
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { log('parse-error', { line: line.slice(0, 200) }); continue }
    handleDaemonMessage(msg)
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
      }).catch(e => log('notify-error', { kind: 'user_msg', error: e.message }))
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
      // already updated lastPing above; respond
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
                 'chat_id MUST match the chat_id from the inbound <channel> tag.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Echo of chat_id from inbound channel meta.' },
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
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id:    z.string(),
    tool_name:     z.string(),
    description:   z.string(),
    input_preview: z.string(),
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

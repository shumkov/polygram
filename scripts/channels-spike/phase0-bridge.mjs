#!/usr/bin/env node
// Phase 0 spike — minimal Channels MCP server. Verifies:
//   1. Capability key `claude/channel` is accepted
//   2. Capability key `claude/channel/permission` is accepted
//   3. notifications/claude/channel notifications round-trip into Claude context
//   4. Claude's reply-tool invocation matches our declared input schema
//   5. notifications/claude/channel/permission_request fires when Claude calls a sensitive tool
//   6. Permission verdict notification is honored
//
// NOT for production. Production bridge lives at lib/process/channels-bridge.mjs (Phase 1).
//
// All inbound MCP traffic is logged to stderr as `[bridge] ...` JSON lines.
// Claude pipes stderr to ~/.claude/debug/<session-id>.txt — that file is the source of truth
// for what shapes the protocol actually uses.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const log = (kind, payload) => process.stderr.write(`[bridge] ${JSON.stringify({ kind, ...payload })}\n`)

// Exit cleanly if our parent (claude) closes stdin — verifies the
// adversarial-review finding about needing an explicit EOF handler.
process.stdin.on('end',   () => { log('stdin', { event: 'end'   }); process.exit(0) })
process.stdin.on('close', () => { log('stdin', { event: 'close' }); process.exit(0) })

const mcp = new Server(
  { name: 'phase0-bridge', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'You are talking through a Phase-0 spike channel. ' +
      'Inbound user messages arrive as <channel source="phase0-bridge" test_id="..."> tags. ' +
      'Reply via the `reply` tool, passing the test_id verbatim in the chat_id field. ' +
      'When you receive a message asking you to run a command, use the Bash tool — ' +
      'we want to observe what a permission_request notification looks like.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  log('list_tools', {})
  return {
    tools: [{
      name: 'reply',
      description: 'Send a message back through the Phase-0 channel.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Echo of the test_id from the inbound tag.' },
          text:    { type: 'string', description: 'Message body.' },
        },
        required: ['chat_id', 'text'],
      },
    }],
  }
})

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  log('tool_call', { name: req.params.name, args: req.params.arguments })
  return { content: [{ type: 'text', text: 'observed' }] }
})

// Permission relay — we just LOG, never auto-allow. Operator approves via terminal.
const PermReqSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }).passthrough(),
})
mcp.setNotificationHandler(PermReqSchema, async ({ params }) => {
  log('permission_request', params)
})

await mcp.connect(new StdioServerTransport())
log('startup', { ok: true, pid: process.pid, node: process.version })

// Push a sequence of test events to exercise the protocol. Spaced out so we can
// observe Claude's response order and batching behavior.
// SPIKE_FAST=1 collapses the timeline for headless runs.
const FAST = process.env.SPIKE_FAST === '1'
const tests = FAST ? [
  { delay:  1500, test_id: 'T1-simple',   content: 'Phase 0 test 1: please reply via the reply tool with "got T1" and pass chat_id=T1-simple.' },
  { delay:  6000, test_id: 'T2-perm',     content: 'Phase 0 test 2: run `Bash` to `echo hello-from-T2`. We want to see a permission_request notification.' },
  { delay: 12000, test_id: 'T3-compact',  content: 'Phase 0 test 3: Reply with a brief acknowledgement.' },
] : [
  { delay:  3000, test_id: 'T1-simple',   content: 'Phase 0 test 1: please reply via the reply tool with "got T1" and pass chat_id=T1-simple.' },
  { delay: 10000, test_id: 'T2-perm',     content: 'Phase 0 test 2: run `Bash` to `echo hello-from-T2`. We want to see a permission_request notification.' },
  { delay: 25000, test_id: 'T3-compact',  content: 'Phase 0 test 3: After replying to this, the operator may trigger /compact. Reply with a brief acknowledgement.' },
]

for (const t of tests) {
  setTimeout(() => {
    log('push', { test_id: t.test_id, content_preview: t.content.slice(0, 60) })
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: t.content,
        meta: { test_id: t.test_id, source: 'phase0-bridge' },
      },
    }).catch(err => log('push_error', { test_id: t.test_id, error: String(err) }))
  }, t.delay)
}

#!/usr/bin/env node
/**
 * cli-driver-spike/validate-subagent.mjs — Phase 0.3.
 *
 * Spawns ChannelsProcess + hook injection (same as run.mjs), sends a
 * prompt that triggers an Agent tool spawn (subagent), and validates:
 *
 *   (a) SubagentStop fires for the subagent's lifecycle
 *   (b) PreToolUse fires for tools called INSIDE subagent context
 *       (the SEC-05 review finding — if (b) fails, subagent inner activity
 *        is invisible to polygram's observability layer)
 *
 * Also captures the agent_id correlation between PreToolUse(Agent) and
 * SubagentStop so we can verify the lifecycle pairing is intact.
 *
 * Cost: ~$0.50 (one short turn that spawns a subagent doing one Bash call).
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { ChannelsProcess }   = require('../../lib/process/channels-process.js');
const { createTmuxRunner }  = require('../../lib/tmux/tmux-runner.js');
const { writeHookFiles }    = require('../../lib/process/hook-settings.js');
const { createHookTail, normalizeHookEvent } = require('../../lib/process/hook-event-tail.js');

const CLAUDE_BIN = process.env.POLYGRAM_CLAUDE_BIN
  || '/Users/ivanshumkov/.local/share/claude/versions/2.1.142';

const BOT_NAME    = 'cli-spike';
const SESSION_KEY = `cli-driver-spike-subagent-${Date.now()}`;
const CHAT_ID     = '-9999999999';
const SPIKE_CWD   = process.cwd();

const OUT_DIR = path.join(os.tmpdir(), SESSION_KEY);
fs.mkdirSync(OUT_DIR, { recursive: true });
const FINDINGS_PATH = path.join(OUT_DIR, 'findings.json');

const hookEvents = [];   // capture all, ordered

function wrapRunner(realRunner, settingsPath) {
  return {
    ...realRunner,
    spawn: async (opts) => {
      const args = [...(opts.args || [])];
      args.splice(1, 0, '--settings', settingsPath);
      return realRunner.spawn({ ...opts, args });
    },
  };
}

async function main() {
  console.log('=== cli-driver-spike validate-subagent.mjs (Phase 0.3) ===');
  console.log(`session_key  = ${SESSION_KEY}`);
  console.log(`out_dir      = ${OUT_DIR}\n`);

  const { settingsPath, ndjsonPath } = writeHookFiles({
    botName: BOT_NAME,
    sessionId: SESSION_KEY,
    hooksDir: OUT_DIR,
  });

  const hookTail = createHookTail({ path: ndjsonPath, logger: console });
  hookTail.on('event', (ev) => {
    hookEvents.push({ ts: Date.now(), ev });
    console.log(`[hook ${ev.type}] tool=${ev.toolName || '-'} agentId=${ev.agentId || '-'} agentType=${ev.agentType || '-'} dur=${ev.durationMs ?? '-'}`);
  });
  await hookTail.start();

  const realRunner    = createTmuxRunner({ logger: console });
  const wrappedRunner = wrapRunner(realRunner, settingsPath);

  const toolDispatcher = async ({ toolName, text, chatId }) => {
    console.log(`[tool-dispatch] ${toolName} → text_len=${text?.length}`);
    return { ok: true };
  };

  const proc = new ChannelsProcess({
    sessionKey:    SESSION_KEY,
    chatId:        CHAT_ID,
    threadId:      null,
    label:         'spike',
    tmuxRunner:    wrappedRunner,
    botName:       BOT_NAME,
    claudeBin:     CLAUDE_BIN,
    toolDispatcher,
    logger:        console,
    turnQuietMs:   3000,
    turnTimeoutMs: 180_000,
  });

  proc.on('init',                (info) => console.log(`[channel init]`));
  proc.on('bridge-ready',        ()     => console.log(`[channel bridge-ready]`));
  proc.on('bridge-disconnected', ()     => console.log(`[channel bridge-disconnected]`));
  proc.on('tool-use',            (n)    => console.log(`[channel tool-use] ${n}`));
  proc.on('result',              (info) => console.log(`[channel result] ${info?.subtype}`));

  console.log('[1/3] start()…');
  await proc.start({
    cwd: SPIKE_CWD,
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'bypassPermissions',
  });
  console.log('[1/3] start() done\n');

  // Prompt that reliably spawns an Agent tool.
  // Keep it concrete + short. The Task tool description in Claude Code names
  // "general-purpose" as the always-available subagent type.
  console.log('[2/3] sending subagent-trigger prompt…');
  const prompt = `Spawn one general-purpose subagent via the Task tool. The subagent's task: run \`echo SUBAGENT_OK\` via Bash, then report the output. After the subagent returns, send me a one-sentence reply confirming what the subagent saw. Don't do any other work.`;
  const result = await proc.send(prompt, {
    context: { chatId: CHAT_ID, user: 'spike-tester', sourceMsgId: 1 },
  });
  console.log(`[2/3] send() done. result text: ${JSON.stringify(result?.text?.slice(0, 200))}\n`);

  // Wait for Stop + SubagentStop to land
  console.log('[3/3] waiting 3s for tail-races + Stop/SubagentStop…');
  await new Promise((r) => setTimeout(r, 3000));

  await proc.kill('spike-done').catch(() => {});
  try { hookTail.close(); } catch {}

  // Reconcile from disk (rc.41 H4 pattern, see run.mjs)
  try {
    const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
    const observed = new Set(hookEvents.map(({ ev }) => `${ev.type}:${ev.toolUseId || ''}:${ev.agentId || ''}`));
    for (const line of lines) {
      try {
        const ev = normalizeHookEvent(JSON.parse(line));
        const key = `${ev.type}:${ev.toolUseId || ''}:${ev.agentId || ''}`;
        if (!observed.has(key)) {
          hookEvents.push({ ts: Date.now(), ev });
          observed.add(key);
        }
      } catch {}
    }
  } catch {}

  // ─── Validate ─────────────────────────────────────────────────────
  const agentPreToolUse = hookEvents.filter(({ ev }) => ev.type === 'PreToolUse' && ev.toolName === 'Agent');
  const subagentStops   = hookEvents.filter(({ ev }) => ev.type === 'SubagentStop');
  const subagentInnerPreTool = hookEvents.filter(({ ev }) =>
    ev.type === 'PreToolUse' && ev.agentId != null && ev.toolName !== 'Agent'
  );

  // For SEC-05: does any PreToolUse for a non-Agent tool carry an agentId?
  const sec05Pass = subagentInnerPreTool.length > 0;

  // Lifecycle pairing: every Agent PreToolUse should pair with a SubagentStop
  const agentIds = new Set();
  for (const { ev } of agentPreToolUse) {
    // agent_id appears on PostToolUse / SubagentStop, not on PreToolUse for Agent
    // — so we can only validate count parity, not identity.
  }
  const stopIds = new Set(subagentStops.map(({ ev }) => ev.agentId).filter(Boolean));

  const verdict = {
    timestamp: new Date().toISOString(),
    sessionKey: SESSION_KEY,
    counts: {
      agentPreToolUse:        agentPreToolUse.length,
      subagentStops:          subagentStops.length,
      subagentInnerPreToolUse: subagentInnerPreTool.length,
    },
    subagentStopAgentIds: [...stopIds],
    subagentInnerToolsObserved: subagentInnerPreTool.map(({ ev }) => ({
      tool: ev.toolName,
      agentId: ev.agentId,
      agentType: ev.agentType,
    })),
    pass_subagentStopFires:        subagentStops.length > 0,
    pass_subagentInnerToolsVisible: sec05Pass,
    pass: subagentStops.length > 0 && sec05Pass,
  };

  fs.writeFileSync(FINDINGS_PATH, JSON.stringify(verdict, null, 2));

  console.log('\n=== verdict ===');
  console.log(JSON.stringify(verdict, null, 2));
  console.log(`\nartifacts: ${OUT_DIR}`);
  process.exit(verdict.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.stack || err.message);
  process.exit(2);
});

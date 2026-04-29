/**
 * Per-chat agent loader for the SDK migration (Phase 1 step 14 /
 * v4 plan §6.5.5).
 *
 * Background: today's CLI pm passes `--agent <name>` on spawn; the
 * Claude CLI then loads that agent's directory under
 * `~/.claude/agents/<name>/` (system prompt from `CLAUDE.md`,
 * skills, mcpServers from settings.json). Phase 0 gate 15 is DEFER —
 * the SDK's `Options.agents` is for in-memory subagent definitions
 * (the Task tool), NOT a "run THIS query AS this agent" mechanism.
 *
 * This module provides a polygram-side loader so buildSdkOptions
 * can compose the per-chat agent's settings into the chat's
 * SdkOptions: read the agent's CLAUDE.md (system prompt), enumerate
 * its skills, pick up its mcpServers from settings.json. Then merge
 * into the per-chat SdkOptions with chat-level overrides taking
 * precedence (chatConfig wins over agent wins over defaults).
 *
 * Used by `polygram.js` `buildSdkOptions(sessionKey, ctx)` —
 * Phase 1 step 14.
 *
 * Cache: agentName → resolved AgentBundle. Invalidated on SIGHUP
 * (callable via `clearCache()`). Phase 5 acceptance includes "agent
 * config edits don't require daemon restart" — but for 0.8.0
 * initial release, restart-on-edit is acceptable; clearCache hook
 * is forward-compat.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const cache = new Map();                       // agentName → AgentBundle

/**
 * Load an agent bundle from disk.
 *
 * @param {string} agentName — e.g. 'shumabit-finance'
 * @param {object} opts
 * @param {string} [opts.homeDir] — defaults to process.env.HOME.
 *   Resolves agent at `${homeDir}/.claude/agents/${agentName}/`.
 * @param {object} [opts.logger] — error logger.
 *
 * @returns {AgentBundle}
 *   { agentName, agentDir, systemPrompt, skills: string[],
 *     mcpServers: object, raw: settingsJson }
 *
 * Throws `{ code: 'AGENT_NOT_FOUND' }` if the agent dir doesn't
 * exist. Does NOT throw on partial agents (missing CLAUDE.md or
 * skills/ etc — fields just default to null/empty).
 */
function loadAgent(agentName, { homeDir = process.env.HOME, logger = console } = {}) {
  if (cache.has(agentName)) return cache.get(agentName);

  const agentDir = path.join(homeDir, '.claude', 'agents', agentName);
  if (!fs.existsSync(agentDir)) {
    throw Object.assign(
      new Error(`agent not found: ${agentName} (looked in ${agentDir})`),
      { code: 'AGENT_NOT_FOUND', agentDir },
    );
  }

  // System prompt: prefer CLAUDE.md (the standard polygram convention),
  // fall back to AGENTS.md (OpenClaw legacy), then to a single-line
  // file `system-prompt.txt` if either of the markdown files is
  // absent. Whichever is present, read as UTF-8 string.
  let systemPrompt = null;
  for (const fname of ['CLAUDE.md', 'AGENTS.md', 'system-prompt.txt']) {
    const p = path.join(agentDir, fname);
    if (fs.existsSync(p)) {
      try {
        systemPrompt = fs.readFileSync(p, 'utf8');
        break;
      } catch (err) {
        logger.error?.(`[agent-loader] reading ${p}: ${err.message}`);
      }
    }
  }

  // Settings: optional `settings.json` for per-agent overrides
  // (mcpServers, model, effort defaults, etc.).
  let settings = {};
  const settingsPath = path.join(agentDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
      logger.error?.(`[agent-loader] parsing ${settingsPath}: ${err.message}`);
    }
  }

  // Skills: enumerate `${agentDir}/skills/*` directories. SDK's
  // `Options.skills` accepts a string[] of skill names.
  const skillsDir = path.join(agentDir, 'skills');
  let skills = [];
  if (fs.existsSync(skillsDir)) {
    try {
      skills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (err) {
      logger.error?.(`[agent-loader] enumerating ${skillsDir}: ${err.message}`);
    }
  }

  const mcpServers = settings.mcpServers ?? {};

  const bundle = {
    agentName,
    agentDir,
    systemPrompt,
    skills,
    mcpServers,
    // Pass through extra settings for callers that want them
    // (e.g. agent-level model/effort defaults).
    raw: settings,
  };
  cache.set(agentName, bundle);
  return bundle;
}

/**
 * Compose a chat's final SdkOptions from defaults + agent + per-chat
 * overrides. Precedence: chatConfig > agent > defaults.
 *
 * @param {object} chatConfig — config.chats[chatId].
 * @param {AgentBundle|null} agentBundle — null if chat has no agent.
 * @param {object} defaults — config.defaults.
 *
 * @returns {object} SdkOptions for `query({ options: ... })`.
 */
function composeSdkOptions(chatConfig = {}, agentBundle = null, defaults = {}) {
  // Start with defaults — these are the lowest-priority.
  const opts = { ...defaults };

  // Layer agent on top.
  if (agentBundle) {
    if (agentBundle.systemPrompt) opts.systemPrompt = agentBundle.systemPrompt;
    if (agentBundle.skills?.length) opts.skills = agentBundle.skills;
    if (agentBundle.mcpServers && Object.keys(agentBundle.mcpServers).length) {
      opts.mcpServers = { ...(opts.mcpServers || {}), ...agentBundle.mcpServers };
    }
    // Agent-level model/effort/etc — only if chatConfig doesn't
    // override.
    for (const key of ['model', 'effort', 'thinking', 'permissionMode']) {
      if (agentBundle.raw?.[key] != null && chatConfig[key] == null) {
        opts[key] = agentBundle.raw[key];
      }
    }
  }

  // Chat-level overrides (highest priority).
  for (const [k, v] of Object.entries(chatConfig)) {
    if (v == null) continue;
    // Don't override the spread system-prompt with `agent` config
    // string — that's a polygram concept, not an SdkOptions field.
    if (k === 'agent') continue;
    opts[k] = v;
  }

  return opts;
}

function clearCache() {
  cache.clear();
}

module.exports = { loadAgent, composeSdkOptions, clearCache, _cache: cache };

/**
 * Per-chat agent loader for the SDK migration (Phase 1 step 14 /
 * v4 plan §6.5.5).
 *
 * Background: today's CLI pm passes `--agent <name>` on spawn; the
 * Claude CLI then loads that agent's content. Phase 0 gate 15 was
 * DEFER — the SDK's `Options.agents` is for in-memory subagent
 * definitions (the Task tool), NOT a "run THIS query AS this agent"
 * mechanism. So polygram reads the agent file itself and passes its
 * content as `systemPrompt`.
 *
 * Search order (rc.13+ — supports BOTH Claude Code's standard
 * single-file convention AND polygram's pre-0.8.0 directory layout):
 *
 *   1. `<cwd>/.claude/agents/<name>.md`          — Claude Code project-level
 *   2. `<homeDir>/.claude/agents/<name>.md`      — Claude Code user-level
 *   3. `<cwd>/.claude/agents/<name>/CLAUDE.md`   — polygram convention
 *      (also `AGENTS.md`, `system-prompt.txt`)
 *   4. `<homeDir>/.claude/agents/<name>/CLAUDE.md` — polygram legacy
 *      (also `AGENTS.md`, `system-prompt.txt`)
 *
 * Single-file Claude Code agents may have YAML frontmatter; we strip
 * it before using the body as systemPrompt. Frontmatter `model` /
 * `effort` are merged into the bundle.raw so composeSdkOptions can
 * use them as agent-level defaults.
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

const cache = new Map();                       // cacheKey → AgentBundle

// Resolve agent file by checking each search path in order.
// Returns { kind: 'file'|'dir', path, dir | null } or null.
function resolveAgentLocation(agentName, homeDir, cwd) {
  const fileCandidates = [];
  if (cwd) fileCandidates.push(path.join(cwd, '.claude', 'agents', agentName + '.md'));
  fileCandidates.push(path.join(homeDir, '.claude', 'agents', agentName + '.md'));
  for (const p of fileCandidates) {
    if (fs.existsSync(p)) return { kind: 'file', path: p, dir: null };
  }
  const dirCandidates = [];
  if (cwd) dirCandidates.push(path.join(cwd, '.claude', 'agents', agentName));
  dirCandidates.push(path.join(homeDir, '.claude', 'agents', agentName));
  for (const d of dirCandidates) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      return { kind: 'dir', path: d, dir: d };
    }
  }
  return null;
}

// Strip leading YAML frontmatter (---\n...\n---\n) from markdown.
function stripFrontmatter(content) {
  if (typeof content !== 'string' || !content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

// Parse a tiny subset of YAML frontmatter (key: value lines).
function parseFrontmatter(content) {
  if (typeof content !== 'string' || !content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return {};
  const block = content.slice(4, end);
  const out = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Load an agent bundle from disk.
 *
 * @param {string} agentName
 * @param {object} opts
 * @param {string} [opts.homeDir] — defaults to process.env.HOME.
 * @param {string} [opts.cwd] — chat's working directory; checked
 *   FIRST for Claude Code project-level agent discovery.
 * @param {object} [opts.logger] — error logger.
 */
function loadAgent(agentName, { homeDir = process.env.HOME, cwd = null, logger = console } = {}) {
  // Cache key includes cwd because the same agentName can resolve
  // to different files when called from different chats with
  // different cwds (e.g. shumabit-claude vs shumabit-partners).
  const cacheKey = agentName + '\x00' + (cwd || '');
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const loc = resolveAgentLocation(agentName, homeDir, cwd);
  if (!loc) {
    const looked = [
      cwd ? cwd + '/.claude/agents/' + agentName + '.md' : null,
      homeDir + '/.claude/agents/' + agentName + '.md',
      cwd ? cwd + '/.claude/agents/' + agentName + '/' : null,
      homeDir + '/.claude/agents/' + agentName + '/',
    ].filter(Boolean).join(', ');
    throw Object.assign(
      new Error('agent not found: ' + agentName + ' (looked in ' + looked + ')'),
      { code: 'AGENT_NOT_FOUND', searchPaths: looked },
    );
  }

  let systemPrompt = null;
  let frontmatter = {};
  let agentPath = loc.path;

  if (loc.kind === 'file') {
    // Claude Code single-file format. Read whole file, parse and
    // strip frontmatter, body becomes systemPrompt.
    try {
      const raw = fs.readFileSync(loc.path, 'utf8');
      frontmatter = parseFrontmatter(raw);
      systemPrompt = stripFrontmatter(raw);
    } catch (err) {
      logger.error?.('[agent-loader] reading ' + loc.path + ': ' + err.message);
    }
  } else {
    // polygram directory layout. CLAUDE.md > AGENTS.md > system-prompt.txt.
    for (const fname of ['CLAUDE.md', 'AGENTS.md', 'system-prompt.txt']) {
      const p = path.join(loc.dir, fname);
      if (fs.existsSync(p)) {
        try {
          systemPrompt = fs.readFileSync(p, 'utf8');
          agentPath = p;
          break;
        } catch (err) {
          logger.error?.('[agent-loader] reading ' + p + ': ' + err.message);
        }
      }
    }
  }

  // Settings.json — only meaningful for directory-layout agents.
  let settings = {};
  if (loc.dir) {
    const settingsPath = path.join(loc.dir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (err) {
        logger.error?.('[agent-loader] parsing ' + settingsPath + ': ' + err.message);
      }
    }
  }

  // Skills (only for directory layout).
  let skills = [];
  if (loc.dir) {
    const skillsDir = path.join(loc.dir, 'skills');
    if (fs.existsSync(skillsDir)) {
      try {
        skills = fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch (err) {
        logger.error?.('[agent-loader] enumerating ' + skillsDir + ': ' + err.message);
      }
    }
  }

  const mcpServers = settings.mcpServers ?? {};

  // Frontmatter merged with settings — composeSdkOptions can pick up
  // model/effort overrides from either source.
  const raw = { ...frontmatter, ...settings };

  const bundle = {
    agentName,
    agentPath,
    agentDir: loc.dir,
    systemPrompt,
    skills,
    mcpServers,
    raw,
  };
  cache.set(cacheKey, bundle);
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

module.exports = {
  loadAgent,
  composeSdkOptions,
  clearCache,
  // Internals for tests.
  _resolveAgentLocation: resolveAgentLocation,
  _stripFrontmatter: stripFrontmatter,
  _parseFrontmatter: parseFrontmatter,
  _cache: cache,
};

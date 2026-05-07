/**
 * Per-chat agent loader.
 *
 * polygram reads the per-chat agent file itself and passes its
 * content as `systemPrompt`. The SDK's `Options.agents` is for
 * in-memory subagent definitions (the Task tool), NOT a "run THIS
 * query AS this agent" mechanism — so we resolve the agent file
 * out-of-band and inject the system prompt directly.
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
// Restrict agent names to a conservative charset so they can't
// path-traverse out of the `.claude/agents/` directory. Pre-fix, an
// agent name like `../../etc/passwd` silently resolved to whatever
// existed at that path, loading arbitrary file content as the
// system prompt. Chat configs are operator-controlled (not user
// input), so the practical threat is operator typos — but pinning
// the contract removes the foot-gun.
//
// Allowed: alphanumerics, hyphen, underscore, single dots inside
// (e.g. "shumabit-finance.v2"). Forbidden: leading/trailing dot,
// consecutive dots, slashes, NUL.
const AGENT_NAME_RE = /^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*$/;

// rc.49: parse `<plugin>:<agent>` qualified names. Each side must
// independently satisfy AGENT_NAME_RE. Returns { plugin, agent } or
// null if not qualified or malformed.
function parseQualifiedName(name) {
  if (typeof name !== 'string' || !name.includes(':')) return null;
  const parts = name.split(':');
  if (parts.length !== 2) return null;
  const [plugin, agent] = parts;
  if (!AGENT_NAME_RE.test(plugin) || !AGENT_NAME_RE.test(agent)) return null;
  return { plugin, agent };
}

// rc.49: look up a plugin's installPath in
// ~/.claude/plugins/installed_plugins.json. Keys are
// `<name>@<marketplace>` — match by the bare `<name>` prefix and
// return the first installed entry's `installPath`. Returns null if
// not enrolled or registry unreadable.
function lookupInstalledPlugin(pluginName, homeDir) {
  const registryPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(registryPath)) return null;
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    return null;
  }
  const plugins = registry?.plugins || {};
  const prefix = pluginName + '@';
  for (const key of Object.keys(plugins)) {
    if (key.startsWith(prefix)) {
      const entries = plugins[key];
      if (Array.isArray(entries) && entries[0]?.installPath) {
        return entries[0].installPath;
      }
    }
  }
  return null;
}

function resolveAgentLocation(agentName, homeDir, cwd) {
  if (typeof agentName !== 'string') return null;

  // rc.49: plugin-qualified `<plugin>:<agent>` names look up the plugin
  // from the installed registry (with fallback to ~/.claude-plugins-local/).
  // Resolution is intentionally NARROW — only the qualified form
  // searches plugin directories. Plain unqualified names keep the
  // pre-rc.49 ~/.claude/agents/ + <cwd>/.claude/agents/ behaviour.
  const qualified = parseQualifiedName(agentName);
  if (qualified) {
    const { plugin, agent } = qualified;
    const installPath = lookupInstalledPlugin(plugin, homeDir);
    if (installPath) {
      const p = path.join(installPath, 'agents', agent + '.md');
      if (fs.existsSync(p)) return { kind: 'file', path: p, dir: null };
    }
    // Fallback: ~/.claude-plugins-local/<plugin>/agents/<agent>.md
    const localPath = path.join(homeDir, '.claude-plugins-local', plugin, 'agents', agent + '.md');
    if (fs.existsSync(localPath)) return { kind: 'file', path: localPath, dir: null };
    // Last fallback: <cwd>/.claude-plugins-local/<plugin>/agents/<agent>.md.
    // Matches a project's `extraKnownMarketplaces.<m>.source.path =
    // <cwd>/.claude-plugins-local` setup — the project vendors plugins
    // under its own tree without polluting ~/.claude-plugins-local/.
    // Lowest precedence so registry + user-local still win.
    if (cwd) {
      const cwdLocal = path.join(cwd, '.claude-plugins-local', plugin, 'agents', agent + '.md');
      if (fs.existsSync(cwdLocal)) return { kind: 'file', path: cwdLocal, dir: null };
    }
    return null;
  }

  if (!AGENT_NAME_RE.test(agentName)) return null;

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

// Recursively expand Claude Code @<file> import directives. A line
// starting with `@<path>` is replaced with the file's contents
// (frontmatter stripped, imports recursively expanded). Paths
// resolve relative to the importing file's directory FIRST, then
// fall back to cwd. Cycle detection via visited Set.
//
// rc.15: pre-rc.15 the literal "@_shumabit-base.md" reached the
// model verbatim because polygram's loader didn't process imports.
// Symptom: agent appeared loaded but the system prompt was
// effectively empty (just an unresolved import directive).
function expandImports(content, importingFile, cwd, visited, logger) {
  if (typeof content !== 'string' || !content) return content;
  const lines = content.split('\n');
  const out = [];
  for (const line of lines) {
    const m = /^@(\S+)\s*$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const ref = m[1];
    const importingDir = path.dirname(importingFile);
    // Resolution order: relative to importing file's dir; relative
    // to cwd; absolute path as-is.
    const candidates = [];
    if (path.isAbsolute(ref)) {
      candidates.push(ref);
    } else {
      candidates.push(path.join(importingDir, ref));
      if (cwd) candidates.push(path.join(cwd, ref));
    }
    let resolved = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { resolved = c; break; }
    }
    if (!resolved) {
      logger?.warn?.(`[agent-loader] @-import not found: ${ref} (in ${importingFile})`);
      out.push(line);
      continue;
    }
    if (visited.has(resolved)) {
      logger?.warn?.(`[agent-loader] @-import cycle: ${resolved}`);
      continue;
    }
    visited.add(resolved);
    let imported = '';
    try {
      imported = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      logger?.error?.(`[agent-loader] reading @-import ${resolved}: ${err.message}`);
      out.push(line);
      continue;
    }
    // Strip frontmatter from imported file (same convention as
    // top-level agent file) and recursively expand its imports.
    imported = stripFrontmatter(imported);
    imported = expandImports(imported, resolved, cwd, visited, logger);
    out.push(imported);
  }
  return out.join('\n');
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
    // strip frontmatter, body becomes systemPrompt. Then expand
    // any @<file> import directives recursively (rc.15).
    try {
      const raw = fs.readFileSync(loc.path, 'utf8');
      frontmatter = parseFrontmatter(raw);
      const stripped = stripFrontmatter(raw);
      const visited = new Set([loc.path]);
      systemPrompt = expandImports(stripped, loc.path, cwd, visited, logger);
    } catch (err) {
      logger.error?.('[agent-loader] reading ' + loc.path + ': ' + err.message);
    }
  } else {
    // polygram directory layout. CLAUDE.md > AGENTS.md > system-prompt.txt.
    for (const fname of ['CLAUDE.md', 'AGENTS.md', 'system-prompt.txt']) {
      const p = path.join(loc.dir, fname);
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, 'utf8');
          // Expand @-imports for directory-layout agents too —
          // their content might also reference shared base files.
          const visited = new Set([p]);
          systemPrompt = expandImports(raw, p, cwd, visited, logger);
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
 * overrides + per-topic overrides. Precedence (highest to lowest):
 *   topicConfig > chatConfig > agent.raw > defaults
 *
 * rc.48 added the per-topic layer (`topicConfig` arg). Per-topic
 * overrides are the principal rc.48 use case — typically loosening
 * an agent's `bypassPermissions` default to `default` for a sensitive
 * topic (so canUseTool prompts fire there) while keeping the rest of
 * the chat in bypass mode. Per-topic permissionMode MUST override the
 * chat-level one for this to work.
 *
 * @param {object} chatConfig — config.chats[chatId].
 * @param {AgentBundle|null} agentBundle — null if chat has no agent.
 * @param {object} defaults — config.defaults.
 * @param {object} [topicConfig] — per-topic overrides from
 *   getTopicConfig(chatConfig, threadId). Empty object when there's
 *   no active topic, no override config, or topic uses legacy string
 *   form. Highest precedence — overrides chatConfig.
 *
 * @returns {object} SdkOptions for `query({ options: ... })`.
 */
function composeSdkOptions(chatConfig = {}, agentBundle = null, defaults = {}, topicConfig = {}) {
  // Start with defaults — these are the lowest-priority.
  const opts = { ...defaults };

  // Layer agent on top.
  if (agentBundle) {
    if (agentBundle.systemPrompt) opts.systemPrompt = agentBundle.systemPrompt;
    if (agentBundle.skills?.length) opts.skills = agentBundle.skills;
    if (agentBundle.mcpServers && Object.keys(agentBundle.mcpServers).length) {
      opts.mcpServers = { ...(opts.mcpServers || {}), ...agentBundle.mcpServers };
    }
    // Agent-level model/effort/etc — only if chatConfig AND
    // topicConfig don't override.
    for (const key of ['model', 'effort', 'thinking', 'permissionMode']) {
      if (agentBundle.raw?.[key] != null
          && chatConfig[key] == null
          && topicConfig?.[key] == null) {
        opts[key] = agentBundle.raw[key];
      }
    }
  }

  // Chat-level overrides.
  for (const [k, v] of Object.entries(chatConfig)) {
    if (v == null) continue;
    // Don't override the spread system-prompt with `agent` config
    // string — that's a polygram concept, not an SdkOptions field.
    if (k === 'agent') continue;
    opts[k] = v;
  }

  // rc.48: per-topic overrides (highest priority). Same `agent` exclusion
  // — `agent` here is a polygram name reference, NOT an SdkOptions
  // field. polygram's spawn flow resolves topicConfig.agent into the
  // correct agentBundle BEFORE calling composeSdkOptions, so by the
  // time we get here, agentBundle already reflects the topic's agent
  // choice and the `agent` string itself shouldn't leak into opts.
  for (const [k, v] of Object.entries(topicConfig || {})) {
    if (v == null) continue;
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
  _expandImports: expandImports,
  _cache: cache,
};

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// 0.12 Phase 4: moved from lib/process/tmux-process.js into the helper module
// that consumes it, so the constant survives TmuxProcess deletion. CliProcess
// + spike scripts + polygram boot all import from here now.
const CLAUDE_CLI_PINNED_VERSION = '2.1.142';

/**
 * Resolve + verify the pinned claude CLI binary.
 *
 * Why this exists: the tmux + CLI backends read claude CLI internal
 * artefacts (TUI banner ASCII, READY hint strings, channel notification
 * registration timing, MCP-init order) — none a stable public contract.
 * polygram pins ONE version (`CLAUDE_CLI_PINNED_VERSION`) and must
 * spawn THAT binary, never whatever `claude` on $PATH happens to
 * resolve to.
 *
 * Before this module the tmux runner spawned the bare string
 * `claude`, resolved through $PATH. The claude CLI installs each
 * version as a standalone binary at
 *   ~/.local/share/claude/versions/<version>
 * and points ~/.local/bin/claude (a symlink) at the active one.
 * Its auto-updater re-points that symlink whenever a new version
 * lands — so a $PATH spawn silently drifts (shumorobot 2026-05-16:
 * CLI auto-updated 2.1.142 → 2.1.143 between deploys).
 *
 * Spawning the ABSOLUTE versioned path is immune to that: the
 * updater only ADDS new version files, it never overwrites an
 * existing one. `versions/2.1.142` stays byte-identical forever.
 */

/**
 * Absolute path to the pinned claude binary.
 *
 * Resolution order:
 *   1. POLYGRAM_CLAUDE_BIN env — explicit override (non-standard
 *      installs, CI, hosts where the layout differs).
 *   2. ~/.local/share/claude/versions/<version> — the standard
 *      claude-CLI install location.
 *
 * The returned path is NOT guaranteed to exist — callers verify
 * via verifyPinnedClaudeBin().
 *
 * @param {string} version — pinned version, e.g. '2.1.142'
 * @returns {string} absolute path
 */
function resolvePinnedClaudeBin(version) {
  const override = process.env.POLYGRAM_CLAUDE_BIN;
  if (override) return override;
  return path.join(os.homedir(), '.local', 'share', 'claude', 'versions', version);
}

/**
 * Verify the pinned binary exists and is executable.
 *
 * @param {string} version — pinned version, e.g. '2.1.142'
 * @returns {{ ok: boolean, path: string, reason?: string }}
 *   ok=true → path is a spawnable binary.
 *   ok=false → reason carries an operator-actionable message.
 */
function verifyPinnedClaudeBin(version) {
  const binPath = resolvePinnedClaudeBin(version);
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return { ok: true, path: binPath };
  } catch (err) {
    const code = err && err.code ? err.code : (err && err.message) || 'unknown';
    return {
      ok: false,
      path: binPath,
      reason: `pinned claude CLI v${version} not found or not executable at `
        + `${binPath} (${code}). Install it with \`claude install ${version}\` `
        + 'or set POLYGRAM_CLAUDE_BIN to the correct binary path.',
    };
  }
}

module.exports = { resolvePinnedClaudeBin, verifyPinnedClaudeBin, CLAUDE_CLI_PINNED_VERSION };

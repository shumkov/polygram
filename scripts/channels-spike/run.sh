#!/usr/bin/env bash
# Phase 0 spike runner — launches pinned claude 2.1.142 with the phase0-bridge as a custom channel.
#
# Run from the worktree root: ./scripts/channels-spike/run.sh
#
# What it does:
#   1. Uses POLYGRAM_CLAUDE_BIN if set, else ~/.local/share/claude/versions/2.1.142
#   2. Registers phase0-bridge via inline --mcp-config (resolves the `server:` ref)
#   3. Boots channels with the dangerous-flag because custom channels aren't on the allowlist
#
# Expected: see ~/.claude/debug/<session>.txt for `[bridge] ...` lines from phase0-bridge stderr.
# That file is the source of truth for what protocol shapes actually work.

set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKTREE_ROOT="$(cd "$SPIKE_DIR/../.." && pwd)"

PINNED_VERSION="${POLYGRAM_PINNED_CLAUDE:-2.1.142}"
CLAUDE_BIN="${POLYGRAM_CLAUDE_BIN:-$HOME/.local/share/claude/versions/$PINNED_VERSION}"

if [[ ! -x "$CLAUDE_BIN" ]]; then
  echo "error: pinned claude not executable at $CLAUDE_BIN" >&2
  echo "       set POLYGRAM_CLAUDE_BIN if your install path differs" >&2
  exit 2
fi

if [[ ! -d "$SPIKE_DIR/node_modules" ]]; then
  echo "error: spike deps not installed. Run: (cd $SPIKE_DIR && npm install)" >&2
  exit 2
fi

cd "$WORKTREE_ROOT"

echo "spike-bridge: claude=$CLAUDE_BIN"
echo "spike-bridge: cwd=$(pwd)"
echo "spike-bridge: tail debug log in another terminal:"
echo "    tail -F ~/.claude/debug/*.txt | grep '\\[bridge\\]'"
echo ""

exec "$CLAUDE_BIN" \
  --mcp-config "$SPIKE_DIR/mcp-config.json" \
  --channels "server:phase0-bridge" \
  --dangerously-load-development-channels

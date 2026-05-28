#!/usr/bin/env bash
# cli-driver-preflight — Phase 0.6 binary-bump guard.
#
# Runs Phase 0.1 + 0.2 + 0.3 in CI-friendly mode (parseable output, exit 0/1).
# Invoke before any claude binary version bump or as a GitHub Action.
#
# Excludes 0.4 lag measurement (longer-running, environment-sensitive).
# Add `--with-lag` to include it.
#
# Usage:
#   scripts/cli-driver-spike/preflight.sh                # 0.1 + 0.2 + 0.3
#   scripts/cli-driver-spike/preflight.sh --with-lag     # adds 0.4
#   POLYGRAM_CLAUDE_BIN=/path/to/claude scripts/cli-driver-spike/preflight.sh
#
# Exit:
#   0  all selected steps PASS
#   1  any step FAIL
#   2  spike script crashed (not the protocol's fault)

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE_DIR="$REPO_ROOT/scripts/cli-driver-spike"
WITH_LAG=0
for arg in "$@"; do
  case "$arg" in
    --with-lag) WITH_LAG=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

results=()
overall_rc=0

run_step() {
  local label="$1"; shift
  local script="$1"; shift
  echo "════════ $label ════════"
  if node "$SPIKE_DIR/$script"; then
    results+=("PASS  $label")
  else
    rc=$?
    results+=("FAIL($rc)  $label")
    overall_rc=1
  fi
  echo ""
}

# 0.1 main spike — proves hooks fire alongside --dangerously-load-development-channels
run_step "0.1  main spike (hooks + channels)" "run.mjs"

# 0.2 validate payloads — re-uses 0.1's artifact, no claude run
run_step "0.2  validate hook payload shapes" "validate-payloads.mjs"

# 0.3 subagent observability — separate claude run
run_step "0.3  subagent observability (SEC-05)" "validate-subagent.mjs"

# 0.4 lag (optional)
if [ "$WITH_LAG" = "1" ]; then
  run_step "0.4  hook lag measurement" "measure-lag.mjs"
fi

echo "════════ preflight summary ════════"
for r in "${results[@]}"; do
  echo "  $r"
done
echo ""
[ "$overall_rc" = "0" ] && echo "preflight: PASS" || echo "preflight: FAIL"
exit "$overall_rc"

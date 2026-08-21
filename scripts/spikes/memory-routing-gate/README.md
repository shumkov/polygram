# U24 memory routing gate

This bounded spike proves one fixed cheap subscription-backed Claude/Haiku
router for facts extracted from either Claude or Codex sessions. Codex CLI
0.145 is recorded as a rejected router candidate because it has no preventive
all-tools-off switch; using post-hoc tool-event rejection would be too late.
The spike does not replace native memory extraction and does not publish or
persist facts.

The runner forwards only a small non-credential environment allowlist, proves
the Codex login is ChatGPT and the Claude login is first-party/non-API-key,
sends only synthetic facts to Claude, disables Claude customizations and tools,
and accepts only the closed routing schema. Its JSON receipt contains fixture
IDs and outcomes, never fixture text or credentials.

Run the small invocation-shape check first:

```sh
node scripts/spikes/memory-routing-gate/run.mjs \
  --codex-bin /absolute/path/to/pinned/codex-0.145.0 \
  --claude-bin /absolute/path/to/vendored/claude-2.1.220 \
  --output /private/mode-0700/u24-shape.json \
  --mode shape
```

After the shape receipt is `CONTINUE`, run the pre-registered full gate:

```sh
node -p "require('/private/mode-0700/u24-shape.json').routing.adapters[0].observedModels[0]"
# Copy the printed exact ID into this quoted value.
expected_model='claude-haiku-exact-id-from-shape'
node scripts/spikes/memory-routing-gate/run.mjs \
  --codex-bin /absolute/path/to/pinned/codex-0.145.0 \
  --claude-bin /absolute/path/to/vendored/claude-2.1.220 \
  --output /private/mode-0700/u24-full.json \
  --mode full \
  --expected-model "$expected_model"
```

`shape` runs one fixture from each of the six families. `full` runs the frozen
26-case corpus five times through the exact Claude/Haiku model recorded by the
shape receipt (130 routing outcomes) plus the
four destination-free fault classes five times (20 fault outcomes). Output
creation is exclusive so an earlier receipt is never silently overwritten.

## Timeout characterization runner

`diagnose-timeouts.mjs` is the zero-Polygram-retry diagnostic core for the
separately reviewed timeout characterization. It keeps the existing `shape`
and `full` runner unchanged. The diagnostic wrapper uses the same Claude
adapter and single-pass routing case, but fixes the corpus to the 22 non-secret
fixtures in manifest order for five repetitions. The campaign ceiling is 110
serial outer invocations, with a 60-second soft observation threshold and a
120-second deadline for each outer invocation. Claude's reported `num_turns`
is an observed internal agent-loop turn count, not an outer invocation,
provider HTTP request, or billable API-call count. Internal agent-loop turns
are not separately pre-capped, and provider retries remain opaque.

The module includes an executable Linux `systemd --user` launcher plus an
injected portable test seam. Before its first model-backed outer invocation the real boundary
attests the canonical pinned Claude path, version, SHA-256, device, inode,
size, mode, ctime, and mtime. Before every spawn it performs only the cheap
realpath plus opened-file identity check after busy/reservation checks and
before incrementing the outer ordinal or invoking the adapter. Runtime drift
therefore records an exact pre-invocation out-of-band stop. After the service stops it recomputes
the full SHA-256 once, before interpreting the receipt. It also proves Claude Code
2.1.220, first-party
`claude.ai` authentication, the exact observed Haiku identity, the unchanged
prompt/schema/tool/environment/security contract, private paths, and an
authorized transient systemd **service**. A scope is not accepted. The service
properties are fixed to:

```text
KillMode=control-group
RuntimeMaxSec=14940s
TimeoutStopSec=10s
SendSIGKILL=yes
RemainAfterExit=yes
StandardOutput=null
StandardError=null
WorkingDirectory=<private scratch>
```

Each outer invocation reserves 130 seconds: 120 for its deadline, five for
process cleanup, and a separate five for the durable checkpoint. The internal
terminal-checkpoint deadline is 14,930 seconds; 110 reservations consume
14,300 seconds and retain 630 seconds for preflight, busy checks, and campaign
overhead. `14940s + 10s = 14950s` is the outer systemd bound.

The outside launcher and independent in-service verifier confirm the unique unit identity,
runner and detached-child cgroup membership. The service remains inspectable
after a clean exit. Completion polling binds Node's Linux monotonic clock to
the unit's activation timestamp, clamps every manager timeout and sleep to the
remaining absolute wall deadline, and treats its iteration cap as a secondary
bound. The outside launcher issues an explicit bounded stop, then
independently proves the unit inactive and its cgroup empty. Missing manager
evidence and cgroup errors other than `ENOENT` after that inactive proof fail
closed. Local tests inject this seam and never contact a
model or require systemd. The bounded real-Linux capability preflight and the
one authorized campaign belong to the later operational step.

The in-service runner queries the authenticated production IPC endpoint for
both fixed bot identities (`shumabit` and `umi-assistant`) before every outer invocation.
Only exact `{bot,in_flight}` responses are accepted; malformed or unavailable
evidence fails closed. The launcher never executes an operator-supplied shell
command.

The receipt lives in a separate mode-0700 evidence directory, is created
exclusively at mode 0600 and sequence 0, records preflight at sequence 1, and is
atomically replaced with an fsynced checkpoint once per completed attempt. A
terminal event outside an attempt gets at most one additional checkpoint;
sequence 112 is the hard bound. The separate mode-0600 unit witness is created
only by the outside launcher after final unit inspection. Both artifacts are
closed and content-free: they retain no prompts, result bodies, stderr, paths,
unit names, PIDs, process names, or source-derived digests. The unit witness
also records whether the outside launcher independently reopened and fsynced
the terminal receipt. Each v2 out-of-band terminal also records the closed
boolean `out_of_band_outer_invocation_started`: pre-spawn busy, reservation,
budget, and arithmetic stops are `false`, while route, result-validation, and
attempt-checkpoint failures after launch are `true`. Historical v1 receipts
remain read-only and retain their legacy reason-based interpretation. A nonterminal
receipt or any unconfirmed close/cgroup cleanup is interpreted as
`diagnostic-failure` without rewriting the preserved receipt.

Every newly written v2 attempt has the exact content-free fields
`router_quality_code` and `router_quality_observed_category`, normally `null`.
Only the terminal `router-quality-failure` attempt may carry one of the ten
closed router-quality codes; only `ROUTER_EXPECTATION_MISMATCH` carries an
observed `work`, `personal`, or `mixed` category. Ordinary in-memory campaign
results omit both fields. The launcher reports the discriminator only after it
reopens and validates the receipt with the unit witness, and the launch command
returns it only after the final evidence copy and hashes succeed. Earlier v2
working receipts were internal, undeployed spike artifacts and are not migrated;
their committed findings and hashes remain the historical record.

If post-run runtime verification and artifact reopening both fail, the already
established local unit witness preserves `integrity-failure` after confirmed
cleanup or `cleanup-unconfirmed` otherwise; accounting remains unavailable.
An artifact-read failure without runtime drift remains `checkpoint-unconfirmed`.

The launcher derives accounting only after reopening and validating those
artifacts. It reports checkpointed outer invocations, the exact sum of known
internal agent-loop turns, rows whose turn evidence is unknown, whether an
exact internal-turn total is available, and an exact or one-invocation-wide
outer range. Unknown or possibly uncheckpointed internal work has no invented
finite upper bound. These derived values are not stored back into either
artifact. Aggregate turn overflow still fails closed during a clean
interpretation, but it cannot mask cleanup-unconfirmed or an explicit launcher
primary failure; those retain their reason with accounting unavailable.

For the later authorized Linux step, stage only the reviewed source files from
one immutable Git object. The global package dependency tree is fixed at
`/usr/lib/node_modules/polygram/node_modules`; the staged owner-only source root
links to that exact tree rather than installing or resolving dependencies. Run
these commands from the reviewed Polygram checkout, replacing the placeholder
with the reviewed 40-hex commit:

```sh
umask 077
set -C
source_commit=REVIEWED_40_HEX_COMMIT
state_root="$HOME/.local/state/polygram/u24-timeout"
source_root="$state_root/source-$source_commit"
archive="$state_root/source-$source_commit.tar"
evidence="$state_root/evidence-$source_commit"
durable="$state_root/durable-$source_commit"
source_receipt="$state_root/source-receipt-$source_commit.json"
dependency_root=/usr/lib/node_modules/polygram/node_modules
test "$source_commit" = "$(git rev-parse "$source_commit^{commit}")"
test -d "$dependency_root"
test ! -e "$source_root"
test ! -e "$source_receipt"
install -d -m 0700 "$state_root" "$source_root" "$evidence" "$durable"
git archive --format=tar "$source_commit" -- \
  scripts/spikes/memory-routing-gate/diagnose-timeouts.mjs \
  scripts/spikes/memory-routing-gate/runtime-attestation.mjs \
  scripts/spikes/memory-routing-gate/adapters.mjs \
  scripts/spikes/memory-routing-gate/fixtures.mjs \
  scripts/spikes/memory-routing-gate/harness.mjs \
  scripts/spikes/memory-routing-gate/contract.mjs \
  lib/secret-detect.js >"$archive"
archive_sha256="$(sha256sum "$archive" | cut -d' ' -f1)"
tar -xf "$archive" -C "$source_root"
ln -s "$dependency_root" "$source_root/node_modules"
find "$source_root" -type d -exec chmod 0700 {} +
find "$source_root" -type f -exec chmod 0400 {} +
printf '{"source_commit":"%s","source_archive_sha256":"%s","dependency_root":"%s"}\n' \
  "$source_commit" "$archive_sha256" "$dependency_root" >"$source_receipt"
chmod 0600 "$archive" "$source_receipt"
test "$archive_sha256" = "$(sha256sum "$archive" | cut -d' ' -f1)"
/usr/bin/node --input-type=module -e \
  "import('$source_root/scripts/spikes/memory-routing-gate/diagnose-timeouts.mjs').then(m=>{if(m.STAGING_SOURCE_FILES.length!==7)process.exit(1)})"
```

The source receipt binds the exact commit, archive digest, and dependency root.
The deterministic top-level import above is the no-systemd staging smoke; the
portable test suite additionally exercises the injected launch seam from an
equivalent staged tree.

Next supply new, nonexistent scratch paths under `/run/user/$UID`; durable
source and evidence remain under `$HOME/.local/state/polygram/u24-timeout`.
The capability command is bounded and does not contact a model:

```sh
/usr/bin/node "$source_root/scripts/spikes/memory-routing-gate/diagnose-timeouts.mjs" capability \
  --scratch "/run/user/$UID/polygram-u24-timeout-capability-$source_commit"
```

Only after that succeeds, launch the single authorized campaign. The earlier
approval is consumed: obtain new approval that names the reviewed immutable
40-hex commit, the ceiling of at most 110 serial outer invocations, the
120-second deadline for each outer invocation, and acknowledges that internal
agent-loop turns are observed but not separately pre-capped while provider
retries are opaque and not separately pre-capped. Approval using an ambiguous
term such as "calls" is insufficient. This command
creates the scratch directory exclusively, runs the explicit `inside` command
as the transient service process, and derives its answer only from the reopened
receipt and unit witness:

```sh
/usr/bin/node "$source_root/scripts/spikes/memory-routing-gate/diagnose-timeouts.mjs" launch \
  --claude-bin /absolute/path/to/vendored/claude-2.1.220 \
  --expected-model claude-haiku-exact-id-from-shape \
  --scratch "/run/user/$UID/polygram-u24-timeout-campaign-$source_commit" \
  --receipt "$evidence/receipt.json" \
  --unit-witness "$evidence/unit-witness.json" \
  --destination "$durable"
```

Do not run either operational command from the portable test suite. Do not
repeat a terminal or inconclusive campaign unchanged.

Run the portable contract suite with the repository's Node 24 runtime:

```sh
/Users/ivanshumkov/.nvm/versions/node/v24.4.0/bin/node \
  --test tests/scoped-memory-routing-gate.test.js \
  tests/memory-routing-timeout-diagnostic.test.js
```

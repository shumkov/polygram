# U24 narrow memory-routing gate findings

Date: 2026-08-18  
Status: the reviewed single-retry implementation and VPS shape gate passed;
the one authorized full VPS gate stopped on two exhausted process timeouts,
the first timeout characterization stopped safely on its first call with an
ambiguous invalid-envelope result, and the reviewed discriminator rerun stopped
safely on its first call with `invalid-envelope-turn-count`. U24 remains
blocked. The turn-count correction then completed, and its one approved changed
campaign stopped cleanly at outer invocation 53 with
`router-quality-failure` on `personal-01` repetition 3. The next gate is a
reviewed router-contract or prompt revision; do not rerun the unchanged route.

## Decision

Use one fixed Claude CLI/Haiku router for facts extracted from both Claude and
Codex sessions. Do not use Codex CLI 0.145 as the router: it exposes built-in
tools and has no preventive equivalent of Claude CLI's `--tools ""`. Rejecting
a tool event after the turn would be too late. This decision avoids adding a
new filesystem/process sandbox to Polygram.

Native memsearch extraction remains unchanged. U24 classifies or splits only
the already-extracted synthetic fact shape. It does not publish memory and is
not production memory code.

## Verified locally

- Frozen corpus: 26 synthetic facts — 8 ordinary work, 8 personal, 4 mixed,
  2 uncertain-but-non-private work, 2 known-shape secrets, and 2 prose-form
  credentials.
- Full-gate arithmetic: 26 facts × 5 repetitions × 1 fixed router = 130
  routing outcomes; 4 injected fault classes × 5 = 20 fault outcomes.
- Deterministic secret rejection runs before the adapter and the four secret
  fixtures never reach a model.
- For non-mixed facts, Haiku decides only `work` versus `personal`; the
  validator discards model-rewritten text and returns the original sanitized
  source fact. For mixed facts, both parts must be exact source spans with a
  unique, non-overlapping decomposition. Only the closed interior connector
  `because` or `after` may be omitted; accepted text is sliced from the source.
- Mixed projection is part-scoped: work writes to own-private plus general;
  sensitive writes only to own-private.
- Eligible operational faults retry internally without an intermediate
  projection. A terminal failure selects no destination and produces one
  destination-free queue-request projection in the gate receipt; U15/U16 own
  the future durable production queue.
- Claude invocation fixes `--safe-mode`, `--tools ""`, empty strict MCP config,
  schema output, no session persistence, and low effort.
- Child environment is a positive non-credential allowlist. Claude auth must
  report exactly `loggedIn: true`, `apiProvider: firstParty`, and
  `authMethod: claude.ai`. Codex must report `Logged in using ChatGPT`.
- Uncertain meaning without a personal-sensitive cue is ordinary `work`.
  There is no operationally redundant `semantic_uncertain` output category.
- Shape mode accepts exactly one observed `claude-haiku-*` model. Full mode
  requires the exact model ID recorded by the shape receipt.
- Timeout handling kills the owned process group, waits for confirmed close,
  and removes the adapter temp directory. The child/grandchild regression
  passed three consecutive runs.
- STOP evidence retains only closed error codes, exit/signal, stderr byte
  count, and cleanup confirmation. It stores no stderr, source-derived digest,
  fact text, account identifier, or credential.

Focused plus adjacent verification under Node 24.4.0:

```text
tests 127
pass 127
fail 0
skipped 0
```

The default shell currently resolves Node 26, while `better-sqlite3` is built
for Node 24. The first adjacent test attempt therefore had 25 ABI load failures
before SQLite tests started. Re-running the unchanged command with the
repository Node 24.4.0 runtime passed 127/127; no dependency was rebuilt.

The later single-retry amendment was independently reviewed after its
red-to-green implementation. Its focused suite passed 28/28 and the adjacent
six-file suite passed 92/92 under Node 24, with no skipped tests. The retry
wrapper permits at most two adapter attempts, projects only one terminal
result, stops all later cases after unconfirmed process cleanup, and preserves
bounded all-attempt model/privacy evidence.

## Exact local preflight evidence

The executable runner attested these local binaries:

| Runtime | Version | SHA-256 | Local path |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.145.0` | `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590` | `/Users/ivanshumkov/.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex` |
| Claude | `2.1.220 (Claude Code)` | `8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081` | `/Users/ivanshumkov/.local/share/polygram/claude-bin/2.1.220` |

Codex login status was ChatGPT. Claude 2.1.220 auth status was
`loggedIn: false`, `authMethod: none`, `apiProvider: firstParty`. The local
shape command therefore wrote a content-free `ROUTER_AUTH_AMBIGUOUS` STOP
receipt and made zero routing model calls. This is the expected result for an
unauthorized host, not a classifier failure.

## VPS live evidence after the single-retry amendment

The gate ran from a mode-0700 temporary directory with Node 24.18.1. It did
not change installed Polygram 0.38.9, service configuration, its database, or
production data. The initial Linux auth preflight exposed one cross-platform
CLI difference: Codex 0.145 writes its successful login-status line to stderr
on Linux and stdout on macOS. The runner accepts the exact ChatGPT status from
exactly one stream and rejects duplicates, warnings, or any other value.

Final attested runtime evidence:

| Runtime | Version/model | SHA-256/auth |
| --- | --- | --- |
| Codex | `codex-cli 0.145.0`, `x86_64-unknown-linux-musl` | `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14`; ChatGPT |
| Claude | `2.1.220 (Claude Code)`, observed `claude-haiku-4-5-20251001` | `674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863`; first-party `claude.ai` |

The first shape receipt used `/usr/bin/codex`, which is an npm wrapper rather
than the native executable. Binary attestation correctly returned `STOP` with
zero model calls. This was a preflight-path error, not routing evidence. The
corrected receipt used the native executable inside the installed Codex npm
package.

| Receipt | SHA-256 | Bytes | Result |
| --- | --- | ---: | --- |
| `shape.json` | `5541f48188ebc4ab09bfb69cd5eaf0981f751830f9b2972ec4af0fa42e97902f` | 279 | `STOP`: wrapper failed native attestation |
| `shape-native.json` | `c032b080971a62a4aea91a154dab151d66e1b618fc24c22efae287776c61ebba` | 11,539 | `CONTINUE` |
| `full.json` | `559ae954b59b400e9b4e3f74fc07762a653c4df0b26d13a2e2b357f22603b51f` | 78,462 | `STOP`: retry budget/exhaustion |

The corrected shape receipt was `CONTINUE` for manifest
`0da0532765f350f1dc89287d5feb5e8ecd2ff16a84d8b7e2b73b2fc7a4b87d48`.
Its six logical cases produced four accepted results, two pre-model secret
quarantines, four adapter attempts, and no retry, recovery, exhaustion,
mismatch, or privacy flag. The exact observed model was
`claude-haiku-4-5-20251001`. All projection and arithmetic checks passed. The
fault suite also passed all 20 logical cases with 40 attempts, 20 exhausted
synthetic retries, 20 destination-free terminal queue requests, and no
destination. The shape retry budget of zero natural retries passed.

The one authorized full receipt was `STOP`:

```text
logical routing outcomes               130
accepted                               108
secret-quarantined                      20
terminal operational errors              2
mismatches                                0
zero-attempt cases                       20
first-attempt cases                     110
retried / recovered / exhausted     4 / 2 / 2
adapter attempts                        114
attempts with / without model evidence 109 / 5
all-attempt privacy flags                 0
terminal destination-free queues         2
fault outcomes / attempts / queues 20 / 40 / 20
```

Both recoveries completed within the gate contract: one `mixed-03` case
recovered after `ROUTER_MIXED_COVERAGE`, and one `personal-02` case recovered
after a timeout.
The exhausted cases were `personal-02` and `mixed-03`; each timed out twice,
with confirmed process cleanup after its process failures. Both terminal
failures selected no destination and each produced one destination-free
queue-request projection, two total. The receipt contained no privacy flags or
mismatches, observed only the exact pinned Haiku model, and passed its projection, arithmetic,
model-identity, and 20/20 fault checks.

The pre-registered full-mode budget permits at most one recovered natural retry
and no exhausted natural retry. Two recoveries plus two exhaustions therefore
fail it. This is operational timeout/process-boundary reliability evidence,
not a privacy, model-identity, projection, or arithmetic failure. The retry
implementation and review are complete, but U24 remains blocked. Do not rerun
the unchanged gate in hope that it happens to pass. The next decision requires
a signed immutable changed commit, fresh approval using the reviewed
outer-invocation accounting terms, and one bounded VPS campaign; it is not part
of this historical evidence run. A finite passing fixture would still leave
residual semantic-miss risk as an explicit rollout decision.

## VPS timeout-characterization evidence

On 2026-08-20, the separately reviewed timeout diagnostic ran once from exact
commit `d37de69d4198218bb0fac80432f7855ac0c43fa9`. It used Claude CLI
`2.1.220`, exact model `claude-haiku-4-5-20251001`, the verified transient
systemd user-service boundary, and fresh mode-0600 evidence paths. Both
Polygram bots were idle before launch; the runner retained its per-call busy
gate.

The campaign stopped after its first ordinary call:

```text
primary outcome        diagnostic-failure
reason                 invalid-envelope
fixture / repetition   work-01 / 1
attempts               1
elapsed                7,311 ms
stdout / stderr        1,608 / 0 bytes
JSON candidate         observed at 6,670 ms
process close          confirmed at 7,311 ms
payload valid          false
unit inactive          true
cgroup empty           true
scratch cleanup        confirmed
```

The durable receipt SHA-256 is
`95bef22ccb268eb3cde5b9250c58a719433e6013b5cb1a595cab70e6b690c4a7`;
the unit-witness SHA-256 is
`44d8f58c715b6f20f8a67697e79b508e9b70485dc298a54b49d85083dc49f317`.
The receipt and witness contain no prompt, result body, stderr, path, unit
name, PID, or source-derived digest.

This is diagnostic evidence, not a routing-quality, privacy, timeout, or
process-cleanup failure. The current content-free evidence cannot distinguish
invalid/trailing JSON from a structurally valid Claude envelope whose required
duration or turn-count fields failed the diagnostic contract. Per the reviewed
one-campaign rule, do not rerun the unchanged diagnostic. The next step is to
add a closed, content-free envelope-failure category, review that change, and
only then authorize a changed diagnostic run. No release or memory-feature
enablement follows from this result.

### Envelope-discriminator rerun

After the five-category discriminator was implemented, independently reviewed,
and committed, Ivan separately approved one changed campaign from exact commit
`dfd2fc271ce1f764b32d8ac88e3407bef444b53b`, with a hard ceiling of 110
Claude Haiku calls. The exact seven-file Git archive had SHA-256
`4034adeab65502019436d528a55f95a0051aa77bfa14057149693c1cee9598c4`.
Its commit-scoped owner-only staging receipt and no-model transient-systemd
capability check both passed before launch. The runtime, model, prompt, schema,
fixtures, auth, tools, environment, timeout, retry, and production boundaries
were unchanged from the first characterization.

The changed campaign again stopped after its first ordinary call, now with the
specific closed reason selected by the reviewed discriminator:

```text
primary outcome        diagnostic-failure
reason                 invalid-envelope-turn-count
fixture / repetition   work-01 / 1
attempts               1
campaign elapsed       17,511 ms
attempt elapsed        7,992 ms
stdout / stderr        1,610 / 0 bytes
JSON candidate         observed at 7,403 ms
process close          confirmed at 7,992 ms
payload valid          false
unit inactive          true
cgroup empty           true
scratch cleanup        confirmed
```

The durable receipt SHA-256 is
`2008bcc2356194c8ceda9e3fd738b7d87dd2c2be91274133a24df5eac0ca8525`;
the unit-witness SHA-256 is
`44d8f58c715b6f20f8a67697e79b508e9b70485dc298a54b49d85083dc49f317`.
The receipt reached sequence 2 with one attempt and no out-of-band terminal.
Its unit witness proves the transient service inactive, cgroup empty, detached
child removed, terminal receipt reopened/fsynced, and cleanup confirmed. The
fresh campaign scratch was removed. No service restart, package/configuration,
database, production-memory, or Telegram mutation occurred.

This result rules out framing, missing output, and duration-metric validation
as the selected clean-close failure class. It proves only that the returned
envelope failed the diagnostic's exact `num_turns === 1` contract; the
content-free receipt deliberately does not retain whether `num_turns` was
missing, malformed, or a different integer. Do not rerun this unchanged
implementation. That invariant has now been replaced by the reviewed positive
safe-integer turn-evidence contract, with actual values retained in fresh v2
receipts and aggregate accounting derived from reopened evidence. At that
point, U24 and memory-feature enablement remained blocked until a signed
immutable changed commit received fresh approval and its one bounded VPS
campaign was reviewed. The next section records that campaign.

### Turn-accounting campaign

The false exact-one invariant was replaced by the reviewed positive-safe
integer turn-evidence contract and committed as signed exact commit
`6db437798fc461f340b96e4a29cadfc3c123d242`. The exact seven-file Git archive
had SHA-256
`3e2d9efa8ee6d9a3d04b8f21067872e7af08d3dd47fd6e8940622c8553111a2f`.
Its commit-scoped staging import and no-model transient-systemd capability
check passed. Ivan then approved at most 110 serial outer Claude CLI
invocations, each limited to 120 seconds, while explicitly acknowledging that
internal agent-loop turns and provider retries were not separately pre-capped
or fully observable.

The campaign stopped once at its first terminal disposition:

```text
primary outcome        router-quality-failure
reason                 router-quality-failure
next decision          revise-router-contract-or-prompt-in-reviewed-plan
fixture / repetition   personal-01 / 3
outer ordinal          53
campaign elapsed       512,529 ms
terminal elapsed       40,460 ms
payload valid          false
Claude duration        37,658 ms
Claude API duration    38,680 ms
observed num_turns     2
slow-valid observed    false
cleanup confirmed      true
```

The reopened v2 receipt derives exact accounting: 53 checkpointed outer
invocations, no possible uncheckpointed outer invocation, 106 known internal
agent-loop turns, zero unknown-turn rows, and an exact internal-turn total. The
receipt reached sequence 54. Its 33,455 bytes hash to
`0de407bba54dfd106769935211c4e9add94d05572b94c0c292e405d30e30ebc3`.
The 221-byte unit witness hashes to
`44d8f58c715b6f20f8a67697e79b508e9b70485dc298a54b49d85083dc49f317`
and proves the transient service inactive, cgroup empty, detached child
removed, and terminal receipt durably reopened. Scratch cleanup also passed.

The content-free receipt intentionally retains neither the model output nor a
finer router error code, so this run cannot distinguish a category mismatch
from a schema or deterministic-guard rejection. It is nevertheless a terminal
router-quality result under the reviewed table. Do not rerun this unchanged
commit or route. U24 and memory-feature enablement remain blocked pending a
reviewed router-contract or prompt revision. No Polygram service, package,
configuration, database, Telegram, or production-memory state was changed.

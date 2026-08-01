# Scoped memory U1 findings

Date: 2026-08-01

Status: **partial; U1 and rollout gate G1 are not yet satisfied.** This file
records sanitized spike evidence. It is not a production approval.

## Memsearch isolation and concurrency

### Environment and pinned calls

- Production-class Linux host; disposable mode-0700 directories and sanitized
  fixture strings only.
- `memsearch==0.4.17`; `pymilvus==3.0.1` (Milvus-Lite).
- Public memsearch calls exercised: `MemSearch.index(force=True)`,
  `MemSearch.index_file(path)`, `MemSearch.search(query, top_k=...)`, and
  `MemSearch.close()`.
- Collection deletion currently requires `instance.store.drop()`. `store` is
  not part of the documented high-level `MemSearch` API, so this call is a
  compatibility risk that the locked environment and upgrade gate must cover.
- Embeddings came from a loopback-only deterministic OpenAI-compatible stub.
  No provider credential or embedding-network request was used. These runs
  measure storage behavior, not semantic quality or production-provider
  latency.

The authoritative invocation was equivalent to:

```sh
MEMSEARCH_GATE_EXPECTED_VERSION=0.4.17 \
uv run --offline --with memsearch==0.4.17 python run_gate.py \
  --adapter deployed_memsearch_adapter:create_adapter \
  --topology per-scope-file \
  --work-dir /absolute/disposable/mode-0700/directory
```

### Topology result

The shared-file topology is rejected. Opening independent memsearch clients
with distinct collections in the same Milvus-Lite file produced a deterministic
`MilvusException` connection-recovery failure. The selected fallback is one
Milvus-Lite file per scope.

The per-scope-file topology consistently passed the functional matrix:

- zero forbidden cross-scope sentinel IDs;
- zero staged-sibling IDs;
- no concurrent writer errors;
- all 41 alpha records and the beta sentinel visible before deletion;
- deleting alpha left beta intact and alpha empty;
- all 41 alpha records and beta were recoverable after full rebuild.

The initial rebuild oracle compared one semantic top-10 result set before and
after rebuild. It failed because equally relevant records may occupy a different
top-10 window after a valid rebuild. A regression test reproduced that behavior
and failed before the correction. The corrected oracle queries every known
fixture record independently and passes locally.

### Latency result and remaining blocker

The absolute concurrent-query p95 was consistently small, but the
pre-registered relative threshold was not stable across repeated corrected
runs:

| Run | Embedding stub placement | Idle p95 | Concurrent p95 | Ratio | G1 ratio |
|---|---|---:|---:|---:|---|
| A | same process | 44.191 ms | 83.866 ms | 1.898x | pass |
| B | same process | 35.215 ms | 81.399 ms | 2.311x | fail |
| C | separate process control | 37.035 ms | 87.588 ms | 2.365x | fail |

All three remain far inside the absolute 1200 ms budget, and every functional
check passed. Moving the synthetic embedding stub out of process did not retire
the ratio failure, so that extra implementation was removed rather than kept as
speculative complexity.

G1 requires both concurrent p95 no greater than 2x idle and no greater than
1200 ms. Therefore the memsearch portion of G1 remains blocked even though the
per-scope topology passes isolation and durability. Before U3, choose the actual
embedding boundary and the production write scheduler, encode their expected
burst shape in the gate, and rerun the unchanged functional matrix repeatedly.
Do not weaken or average away the 2x threshold merely to obtain a pass.

## Provider-session receipt tamper gate

Status: **PASS for the prototype behavior; protected storage and live-provider
replay remain U3/U7 runtime gates.**

The gate opens Polygram's real current schema in a private temporary database,
adds the two planned receipt columns there only, and seeds both persisted
session representations:

- Claude through `sessions`;
- Codex through `agent_runtime_sessions`.

An independent child process at the same uid then performs each direct SQLite
rewrite. The receipt authority remains outside that child and binds a random
256-bit opaque receipt to the exact `{session_key, provider_namespace,
provider_session_id, policy_identity}` tuple.

The sanitized matrix passed for both tables:

- a valid exact receipt resumes the persisted provider session;
- a missing receipt forces a fresh session and deletes the target row;
- restoring a previously valid receipt after rebinding the same logical
  session forces fresh because rebinding revokes its predecessor;
- changing only the provider session ID forces fresh;
- rewriting an old row's `memory_identity` to the current value forces fresh;
- copying both the provider session ID and receipt from another row forces
  fresh because the session key remains different.

Unit coverage also changes each tuple field independently, including provider
namespace. The standalone evidence required numeric and equal parent/child
UIDs, reported `same_uid_child: true`, and every check true. It verifies exact
target-row deletion after rejection while an unrelated sibling in each table
remains byte-for-byte unchanged. The first standalone regression failed before
the runner existed and passed after the separate-process tamper path was
implemented. A second regression restored a previously valid receipt after a
rebind; it resumed before predecessor revocation and forced fresh afterward.

This spike deliberately does not add production migrations or resume wiring.
Its in-memory authority is only a stand-in for protected memoryd state. U3/U7
must repeat the matrix against the real service, including already-live process
reuse and a real Claude/Codex child, before rollout.

## Linux systemd peer-attestation gate

Status: **PASS for the same-UID kernel/systemd mechanics; the final cross-owner
gate remains blocked on U10's service identity.**

The target Linux host ran one disposable auto-collected user-systemd unit. Its
main process and a child with the same uid, executable, invocation, and cgroup
connected to a private Unix socket and sent malformed bytes. The server:

1. captured PID and UID from Linux `SO_PEERCRED`;
2. obtained `SO_PEERPIDFD` atomically from the accepted socket, correlated its
   `/proc/self/fdinfo/<pidfd>` `Pid` to the credential PID, and checked pidfd
   liveness before and after numeric `/proc/<pid>` reads;
3. required an active/running unit with non-empty `MainPID`, `InvocationID`, and
   `ControlGroup`;
4. required the peer PID to equal `MainPID`, `/proc/<pid>/exe` to equal the
   pinned executable, and `/proc/<pid>/cgroup` to contain the exact unit cgroup;
5. reread the unit snapshot and required it to remain identical;
6. routed the sole request read through an instrumented authorization gate.

Sanitized evidence was `PASS`: the exact main process returned `accepted`, the
same-UID child returned `not-main-pid`, exactly one authorized request read
occurred, pidfd correlation stayed live, and the transient unit both exited
cleanly and was confirmed absent afterward. No production service was
restarted or reconfigured.

This same-UID run is necessary but not sufficient. Memoryd will run under a
different system identity. U10 must provision that identity and repeat the
same gate against a root-owned disposable system unit. The final gate must
prove that the client identity cannot start, stop, or reconfigure the unit;
the unit file, configuration, `ExecStart` argv, scripts, executable, and
package inputs are root-owned and immutable to it; deployed executable and
package digests match an allowlist; and both processes share the expected PID
namespace and hardened `/proc` visibility. It must also prove that memoryd can
read the cross-owner `/proc` evidence and query a stable system-manager
snapshot under production hardening. Any failure blocks U3; the design must
not silently fall back to UID-only authorization. This spike establishes only
the same-UID kernel/systemd mechanics, not production authorization.

## Partner publication atomicity gate

Status: **PASS for the process-crash visibility/reconciliation model; real
memsearch publication and concurrent boot admission remain U3/G5 gates.**

The gate checkpoints one normalized candidate and its complete partner/general
destination set in one SQLite transaction. The two siblings then use separate
body directories and index databases. Recall consults one protected logical
activation marker and validates the complete linked artifact set before either
scope can return the record.

An independent Node regression pins the exact ordered matrix of 22 child
process crashes:

- before, during, and after the candidate/destination checkpoint;
- before, during, and after each atomic staged-file write;
- before and after each staged-to-record move;
- before, during, and after each scope index transaction;
- before, during, and after the logical activation transaction.

Before the checkpoint, both recall scopes are unavailable. After the checkpoint
and before activation, both return no record. Only a crash after committed
activation exposes both. Every crash then starts a fresh recovery subprocess,
which must converge to one equivalent sibling in each destination. A second
fresh recovery must preserve an exact normalized snapshot of logical and
destination rows, all body/staging names and contents, every index row, and
both recall results. Missing persisted destinations fail closed; partial
staged bytes are rebuilt from the protected candidate checkpoint rather than
promoted.

The separate boot-sequencing prototype removed one active partner index entry
and one active general body. It rejected both recall scopes until repair
completed, then returned both siblings. This does not prove a concurrent
request-versus-boot race. The matrix proves abrupt userspace process-crash
recovery with SQLite-backed stand-in indexes, not power-loss durability or the
pinned memsearch mutation surface. U3 must run the unchanged crash matrix
through the real per-scope memsearch adapter and instrument the sole request
admission path while boot reconciliation is in flight. Direct memsearch access
must remain technically unavailable because it cannot apply the logical
visibility marker.

The Node regression failed before the gate existed and passed after the first
implementation. Independent review then demonstrated false-pass cases for a
vacuous crash list, pre-activation dual visibility, partial staged writes,
non-authoritative destination rows, and count-only idempotence; the final gate
pins all five corrections and passes 8 pure tests plus the 22-point standalone
matrix.

## Extraction processor G3 gate

Status: **the contract, corpus, and bounded runner code pass; neither candidate
has been executed or approved. U1 and G3 remain blocked.** No model, container,
or image was downloaded, no Anthropic request was sent, and no credential was
used.

### Frozen corpus and evidence contract

The shared provider-neutral harness now fixes the processor input/output
boundary and a canonical 200-fixture manifest:

- 60 team-private/private, 50 team-private/general, 25 team-shared, 20 partner,
  30 adversarial, and 15 no-durable-memory fixtures;
- 170 expected durable claims, including 64 critical private claims;
- 18 synthetic secret cases: six each at high, medium, and low detector tiers;
- 12 instruction attacks, each with an attack-specific rejection oracle; six
  true multi-fact fixtures and six instruction-plus-safe-fact cases; and
- 40 disjoint development fixtures which are never included in the locked
  score.

Every scored candidate must run the complete canonical corpus three times. A
run is rejected unless it contains 200 unique fixture receipts, the exact
170/64/12 denominators, the canonical fixture-manifest hash, and matching
non-empty prompt, schema, processor, and processor-config identities. Results
are never pooled: every run must independently meet the approved precision,
routing, private-recall, instruction-rejection, and zero-leak thresholds.

The text-free oracle self-test passes with 170/170 extraction and routing,
64/64 private recall, 12/12 instruction rejection, and zero secret hits. This
proves the harness and arithmetic only; it is not model-quality evidence.

### Anthropic comparator

The direct comparator is pinned to `claude-haiku-4-5-20251001`, synchronous
Messages API structured output, `standard_only`, temperature 0, and 2048 output
tokens. Each request is limited to 10 seconds; up to two retries with bounded
jitter share one hard 60-second whole-job deadline. Retry waits cannot exceed
the remaining deadline, response cleanup cannot stall it, and HTTP redirects
are rejected so the key and body stay at the pinned endpoint.

Durable evidence retains the validated processor ID and deterministic config
hash while excluding prompts, responses, candidate facts, exception messages,
and credentials. Billing is marked exact only when every fixture used one
attempt and returned valid input/output usage for the expected standard/global
route with no prompt-cache token classes. Missing metadata can no longer appear
as an exact zero-dollar result.

This comparator still requires Ivan's explicit approval for sanitized
synthetic-fixture egress and a dedicated commercial Anthropic API credential.
A Claude consumer subscription is not API authentication. The documented
retention mode must be selected for the exact API organization; Zero Data
Retention is never assumed.

### Local comparator

The local candidate remains pinned to `Qwen/Qwen3-4B-GGUF` revision
`bc640142c66e1fdd12af0bd68f40445458f3869b`, file
`Qwen3-4B-Q4_K_M.gguf`, 2,497,280,256 bytes, SHA-256
`7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`.
The llama.cpp Linux/amd64 image is pinned to digest
`sha256:d281935c6cb43621ec96b187c3636c257ca19223068f8f1fe3038fdbc89f9548`.

The dependency-injected local runner is explicitly a test core: it always
returns `admissible:false` and `passed:false`. The production entry point fails
closed with `LOCAL_RUNTIME_SEALED_COLLECTOR_REQUIRED`. Caller-supplied Docker
inspection, cgroup paths, model readers, or Unix transports therefore cannot
produce G3 evidence. Before a real local run, a separately reviewed collector
must bind the verified image, stable container ID/PID/start time, that PID's
cgroup-v2 limits and counters, the container-visible model inode/content, and
the private Unix socket to the same process for all three runs.

Running this candidate requires Ivan's approval to download approximately
2.5 GB of model data plus the pinned image and to start only the disposable
offline container. That approval has not been requested or granted yet.

### Verification and remaining decision

The focused processor suite passes 27/27 tests, both oracle/local self-tests
pass, and the final repository-wide suite passes 4,039 tests total: 4,024
passed, 0 failed, and 15 explicitly skipped. Three independent final reviews
covered fixture/scoring completeness, Anthropic evidence/security, and
local-runtime admissibility; their must-fixes were folded into the files above.

No processor recommendation can be made until both real candidates have valid
three-run evidence. G3 remains blocked on: (1) the sealed local collector and
approved local assets, (2) approved synthetic Anthropic egress plus a commercial
API key, (3) Ivan's review of the locked labels, and finally (4) Ivan's measured
processor/data-boundary choice. U3 must not begin before that choice.

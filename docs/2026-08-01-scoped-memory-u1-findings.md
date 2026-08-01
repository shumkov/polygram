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

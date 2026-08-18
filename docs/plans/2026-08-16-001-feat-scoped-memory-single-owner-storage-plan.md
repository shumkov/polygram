---
title: Scoped Memory Storage Ownership - Decision Spec
type: feat
date: 2026-08-16
revised: 2026-08-16 (review round 3)
topic: shumabit-scoped-memory
artifact_contract: decision-spec/v1
artifact_readiness: decision-pending
supersedes_within: U16 storage topology only
execution: none-yet
---

# Scoped Memory Storage Ownership — Decision Spec

Decision spec for user sync. It does **not** rewrite
`docs/plans/2026-07-31-002-feat-shumabit-scoped-memory-plan.md`; §12 lists what
would change there once a direction is chosen. No code, config, or production
state was touched.

**Revision 3** folds in the round-3 must-fixes: the fault-isolation claim is
corrected and the MVP blast radius is accepted explicitly, the security identity
prerequisite is rewritten because a Polygram-UID socket check does not exclude
provider children, physical idempotency becomes a proved gate rather than an
assertion, backups gain a real consistency boundary, S1 is ordered after S2 with
an exact oracle, estimates are renamed to envelopes, and protocol/client work is
assigned once. The recommendation is unchanged in direction.

## 1. The decision forced on us

U16 assumed a detached publisher process writes a scope's index while the recall
gateway holds that scope open. U16a proved that access is refused, on macOS and
on the production Linux host. Milvus-Lite 3.x permits **exactly one live process
per store**, so the split is unservable and G1 is unreachable for it.

---

## 2. Verified facts, assumptions, and what was not tested

### 2.1 Verified — U16a revision 3, both hosts

Source: `polygram.scoped-memory-latency-gate/docs/2026-08-11-u16a-memsearch-latency-findings.md`.

| # | Verified fact | Evidence |
| --- | --- | --- |
| VF-A | While one process holds a scope's store open, a second process **cannot open it**. Failure is at `open`, before any write. | §4, §8.3 |
| VF-B | The refusal is **clean**: zero writer ops, no partial record, no reader error, control writer succeeds **once the reader releases**. | §4, §8.3 |
| VF-C | The constraint is **exclusive open by a live process, not file corruption**. | §4 |
| VF-D | Reproduced on **two** combinations: macOS + stub, production Linux + ONNX. | §8.4 |
| VF-E | Milvus-**Lite** `shared-file` with a separate writer killed the reader's own connection. | §4 subsection |
| VF-F | Production boundary observed: `embedding.provider = "onnx"`, no credential, model staged; offline resolve memsearch 0.4.17 / pymilvus 3.0.1 / onnxruntime 1.28.0. | §8.2 |
| VF-G | **Production does not pin memsearch** — `uvx --upgrade`. | §8.2 |
| VF-H | The five-run Linux latency gate was **never started**. | §8.3 |

Source: `docs/2026-08-11-u21-scoped-memory-plugin-integration-findings.md`.

| # | Verified fact | Evidence |
| --- | --- | --- |
| VF-J | **The capture path never opens Milvus** — `stop.sh` only appends Markdown. | VF10 |
| VF-K | Only the `Stop` hook is registered, through a root-**owned** wrapper. | D1, D2 |
| VF-L | `MEMSEARCH_DIR` binds journal path and collection, and survives into the detached worker. | VF9 |

### 2.2 What was NOT tested

- macOS+ONNX and Linux+stub were never run. VF-D is two points, not a matrix.
- **Concurrent shared read/write was never survived** — the writer failed at
  `open`, so the reader ran 0 concurrent queries.
- **In-process concurrency has never been measured.** No overlap or visibility
  evidence from U16a transfers to an in-process write lane.
- **memsearch's physical idempotency is unknown.** Nothing in the cited sources
  establishes whether re-indexing the same `(part_id, destination)` upserts,
  duplicates, or errors. §5.3 makes this a gate, not an assumption.
- Milvus **server** mode has never been exercised here; its isolation, latency,
  and operational profile are unmeasured.

### 2.3 Corrections carried from earlier revisions

The approved plan defines **no** NDJSON/UDS gateway protocol — verified, zero
matches. Revision 1's claim that the owner extends an existing socket API was
false; the owner runtime is new work, assigned in §4.1.

---

## 3. The three options

### Option 1 — One long-lived memory owner (recommended, subject to gates)

One process holds every scope handle; recall and mutation are lanes inside it,
serialized per scope.

**For.** Removes the refused access rather than coordinating around it.
Preserves per-scope-file isolation (U1) and every settled capture decision
(VF-J). Polygram gains no Milvus dependency and no scope path.

**Against — stated precisely.** Recall and mutation for one scope contend inside
the owner; the contention is measurable but **unmeasured**. And the fault
boundary is weaker than option 2's: see §3.4.

### Option 2 — Explicit scope-ownership handoff

Gateway and publisher stay separate processes; the publisher acquires a scope
(gateway closes, publisher opens, mutates, closes, gateway reopens).

**For.** §4's control writer proves the mechanism. **It gives genuine
process-fault isolation:** a publisher that segfaults, wedges, or leaks cannot
take recall down, because recall is a different process. Option 1 cannot match
this (§3.4).

**Against.** Needs a lease protocol between two processes — acquire, fence,
renew, expire — plus recovery for a publisher that dies holding the lease.
Recall must fail or block for the handoff window, which includes the publisher's
open cost and plausibly ONNX embedder init. **Both costs are expected to be
significant and are unmeasured**; this spec asserts no number.

### Option 3 — Milvus server backend

memsearch supports a server URI. Server mode **could** permit concurrent
multi-process access and so **could** avoid this Milvus-Lite contention entirely.

**Against.** It is an **unvalidated escape candidate**. It adds a production
service to a host already carrying Chatwoot, PostgreSQL, Redis, two Polygram
bots, water and tmux owners, and introduces a network/auth boundary on the reply
path plus new backup semantics. Its isolation model changes from per-scope-file
to per-collection-in-one-server and **must be validated on its own** — VF-E is a
Milvus-**Lite** shared-file result and is **not** evidence about server-mode
collection isolation. No claim is made here about its footprint, throughput, or
whether it removes the latency question; that requires its own isolation,
latency, and operations gate.

### 3.4 Fault isolation — the honest comparison

Per-scope workers and per-scope quarantine (§5.5) contain **scope-attributable
handled errors only**: a Python exception, a refused open, a corrupt scope, a
failed index unit. They are **not** equivalent to option 2's process-fault
isolation.

A native crash in the embedder or storage layer, a process wedge, an OOM kill,
or an owner compromise **affects every scope in the one process**. Quarantine
cannot contain those, and this spec does not claim it can.

**MVP accepts that blast radius**, on these grounds: the MVP has one binding and
two scopes belonging to one person, so "every scope in the process" is one
person's own memory; memory failure never fails a Telegram reply (§5.6); and
recovery is bounded by §5.4's evidence-before-traffic rule.

**Recorded as a credible later alternative:** *one owner process per scope*. It
preserves the single-opener invariant while restoring process-fault isolation,
at the cost of N processes, N embedder residencies, and a supervisor. It is the
natural answer if the blast radius becomes unacceptable at full parity, and it
should be reconsidered at U20 rather than retrofitted under incident pressure.

---

## 4. Recommendation

**Adopt option 1**, subject to S1 and S3.

### 4.1 Unit ownership (assigned once, no double estimate)

| Unit | Owns |
| --- | --- |
| **U14** | The owner **process/runtime** and the **protocol**: lifecycle, single-instance fencing, per-scope handle registry, per-scope workers, socket server, peer authorization, framing/connection bounds, health, bounded shutdown. Defines **both** ops (`recall`, `publish_notify`) and ships the **reusable client contract/library**. Retains its approved obligations: mechanism decision, Orchestra release boundary, exact consumer pin, one model-visible Claude-CLI/Codex proof. |
| **U16** | **Publish semantics inside the owner**: what `publish_notify` does — staging claim, secret re-rejection, U24 routing call, fact identity, ledger fanout, terminal states, reconciliation, quarantine, registry/legacy isolation. Builds no process and defines no wire op. |
| **U17** | **Polygram call-site/runtime integration only**: wiring U14's client library into the turn flow, circuit breaker, config, protocol-version negotiation. Adds no protocol and no server behavior. |

Verification split, explicit: U14 proves `recall` and `publish_notify` at the
protocol/server level and the client contract in isolation; U16 proves
`publish_notify`'s *effects*; U17 proves the Polygram call sites. No estimate is
counted twice and no edge is hidden.

**Polygram remains a versioned protocol client only.** It does not know or
validate the memsearch version and never resolves a scope path; the owner and
infrastructure attest the memory runtime.

### 4.2 The ownership invariant

> For every scope S, **at most one OS process ever holds an open Milvus-Lite
> handle to S**, and that process is the memory owner. All reads and mutations of
> S go through the owner's protocol. A component that opens S directly is a
> defect, not a configuration choice.

### 4.3 Data flow

```text
Telegram turn ─► Polygram ─► provider session ─► Stop hook wrapper
                                                      │ Markdown only, no index
                                                      ▼
                                        write-only dropbox (§5.1)
                                                      │
Polygram ──publish_notify──►┌────────── memory owner (U14 runtime) ──────────┐
   recall ─────────────────►│  recall lane  │  write lane (U16 semantics)    │
   bounded results ◄────────│  per-scope worker: serialized, preemptible     │
                            │  handle registry: one handle per scope         │
                            └──────────┬─────────────────────────────────────┘
                                       ▼
                           per-scope Markdown journal + Milvus-Lite file
```

---

## 5. Smallest sufficient design

### 5.1 Security identity — corrected prerequisite

**The round-2 design was wrong.** Provider and app-server children normally
inherit Polygram's UID, so a socket check of "peer uid == Polygram" would admit
provider children exactly as it admits Polygram. And the hook wrapper is
root-*owned* but **executes as the session's UID** — it is not a privileged
component. There is no separate "capture identity" to authorize; inventing one
would have been fiction.

A sufficient boundary therefore requires **both** of:

**(a) Provider children cannot reach the owner.** Either
  - **a distinct provider execution UID** (children spawn under an identity that
    is not the Polygram service account, and the socket admits only Polygram), or
  - **a concrete containment mechanism** that denies provider children the owner
    socket path and every recall/binding capability. Codex already renders a
    filesystem-deny profile that could carry this; **the Claude CLI backend runs
    with broad permissions and has no equivalent**, so containment alone is not
    currently sufficient for both backends.

**(b) A write-only dropbox handoff producing an owner-owned sealed inode.**
  The session writes its turn entry into a dropbox it can create in but not list
  or read. Because a file created by the session is owned by the session, the
  owner **copies** it into the owner-owned claimed area and seals it there —
  rename cannot change ownership. Copy-then-seal is the primitive; rename is an
  optimization only when ownership already matches.

**If neither (a) nor a both-backend (b) containment ships, state plainly:**
scope isolation in MVP is **application hygiene, not a security boundary**, and
this spec **does not claim protected cross-person or cross-partner scope
isolation**.

**MVP consequence, stated exactly.** The MVP has **one** binding and two scopes,
both already readable by the one authorized person. A provider child that reached
recall would obtain what its own session is already entitled to, so the missing
boundary is not load-bearing in MVP. It becomes load-bearing at the **second
binding** — a second person, a team group, or a partner. Therefore:

> **U28 (provider execution identity separation) is a hard prerequisite for U20
> and is not an MVP blocker.** MVP ships with hygiene-only isolation and says so.
> No cross-principal protection may be claimed until U28 lands.

**The limit is mechanically enforced, not documentary.** The owner validates the
root-owned registry at **startup and at every configuration reload**, and **fails
closed** unless it contains **exactly the one approved single-person binding**.
A registry naming a second person, a shared UMI group, or a partner binding is
**rejected — the owner refuses to start, and a reload leaves the previous
configuration in force** — until an **attested U28 capability is active**. The
attestation is the gate: absent it, multi-principal configuration is
unrepresentable at runtime rather than merely discouraged. This makes the §11.5
enablement limit an invariant the deployment cannot drift past by editing a file.

U28 is estimated and graphed in §11.

### 5.2 Trust boundary mechanics (given §5.1)

Owner runs as a dedicated service account; stores/journals/dropbox/claimed/ledger
are owner-owned `0700`; the socket is owner-owned, mode `0660`, in an owner-owned
`0750` directory, group-restricted to the authorized client account.
`SO_PEERCRED` on accept, plus **per-operation authorization** — `recall` and
`publish_notify` are separately authorized. Each request carries the
non-forgeable per-turn receipt; the owner maps receipt → binding → scope. **The
caller never names a scope and the model never sees one.** Framing is
length-prefixed with max message size, max in-flight per connection, max
connections, and idle timeout. On startup the owner probes the socket: a live
peer means another instance (→ §5.4 fencing); only a proven-dead socket is
unlinked and rebound.

### 5.3 Physical idempotency and claim durability — a proved gate

**The missing crash boundary:** the journal/index mutation succeeds and the owner
dies **before the destination's success is durable in the ledger**. On restart the
ledger says "not written" while the store says otherwise. A naive retry
duplicates.

**Required primitive — one of, proven, not assumed:**

1. a stable `(part_id, destination)` **upsert/dedup** at the storage layer, or
2. a proven **read-before-retry** (query the destination for `part_id` before
   re-writing), or
3. a proven **rebuild** path that makes the index a pure function of the journal,
   so a duplicate index write is harmless by construction.

**Nothing in the cited sources says memsearch provides (1).** This spec does not
assert it. **S3** (§10) determines which primitive is available on the pinned
version and **blocks U16**.

**Durable ordering** for the dropbox → claimed → ledger path: write entry to a
temporary name; `fsync` the file; `fsync` the containing directory; owner copies
into the claimed area under a receipt-unique name; `fsync` file and directory;
**seal** (make immutable to further writes) before any ledger row is written.
Sealing before the ledger row is what defeats a late writer holding an open
descriptor: the descriptor writes into an inode that is no longer the claimed
material. Reboot loss is bounded by the directory `fsync`s, not by rename
ordering alone.

**Bounded claimed state.** Dropbox and claimed area are bounded by per-binding
and global **count, bytes, and age**. At capacity the owner **leaves entries
unclaimed and reports pressure**; the approved best-effort TTL may then expire
captures. That is accepted and visible. **No unbounded spool exists anywhere.**
Claimed and dropbox data are excluded from backups and telemetry.

**Reconciliation** scans dropbox + claimed + ledger + terminal tombstones:

| Crash point | Observed | Resolution |
| --- | --- | --- |
| after seal, before ledger row | sealed claim, no row | re-derive from sealed material; create row; publish |
| after ledger row, before mutation | sealed claim + row, store untouched | resume from the recorded state; publish the pending destinations |
| **after journal/index mutation, before destination durable** | row says pending, store may hold it | apply the S3 primitive: upsert, or read-before-retry, or rebuild |
| mid-fanout | partial destinations | retry **missing destinations only** |
| after terminal marker | tombstone + entry | delete entry; refuse late writers |

**Defensive recovery, not normal ordering.** A ledger row whose claim is missing
or unsealed cannot arise under the ordering above — sealing strictly precedes the
first ledger write. If reconciliation ever observes one, it is legacy or
corrupted state: the item is **quarantined, not published**, and counted. It is
never treated as "claim it and continue", because the sealed material that would
authorize publication does not exist.

A **duplicate `publish_notify` is a no-op** (claim identity is receipt-unique); a
**lost `publish_notify` costs latency only**, because the sweep and boot
reconciliation find the entry. Unresolvable entries are **quarantined**, counted,
and alerted content-free.

### 5.4 Recovery, fencing, isolation

- **Single-instance fencing before any scope open**: exclusive instance lock plus
  a live-peer probe. Two owners must be impossible.
- **Evidence before traffic**: after an abrupt kill, journal/index/ledger
  reconciliation completes and is reported **before** requests are accepted.
- **Bounded shutdown, no orphan operation.**
- **Per-scope worker exception isolation** — for handled, scope-attributable
  errors only (§3.4).
- **Fail-closed rule.** A scope that cannot be opened, reconciled, or trusted is
  **quarantined individually**; other scopes keep serving. Instance-lock loss,
  socket failure, ledger corruption, **or any native/process-wide failure** is a
  **global outage**: the owner refuses all traffic until an operator clears it.

### 5.5 Concurrency and reply isolation

One worker per scope; operations on S serialize there; scopes proceed in
parallel. Publication decomposes into bounded work units (one `index_file` per
unit; never `index(force=True)` in steady state); the worker drains pending
recalls between units, so a recall waits at most one unit. Recall carries a
client-owned deadline; on expiry Polygram returns `unavailable` locally and the
reply proceeds. **Memory never fails a Telegram reply.**

### 5.6 Backup and restore — with a real consistency boundary

- **Do not independently copy live files.** Journal, ledger, and tombstones are
  mutually dependent; copying them while the owner runs yields a torn set.
- Restore material is produced **only** by an **owner-coordinated per-scope
  checkpoint**: the owner quiesces that scope's worker, flushes and fsyncs
  journal + ledger + tombstones, emits a manifest, and resumes. An equivalent
  atomic filesystem snapshot taken under the same quiesce is acceptable.
- **The index is excluded and treated as rebuildable** from journal + ledger
  under an attested memsearch version and embedding model.
- **Dropbox and claimed data are excluded.**
- The manifest carries scope, memsearch version, embedding model, and content
  digests. Restore tests include **negative cross-scope and cross-version**
  restores.
- **Live restore remains DEFERRED beyond MVP.** MVP proves rebuild-from-journal
  on a synthetic copy under the pinned runtime.

---

## 6. Settled decisions preserved

Native memsearch extraction stays in-session on the already-authorized
subscription. No new extractor, no replacement capture path, no prompt retune, no
second extraction model. The `Stop` wrapper, `MEMSEARCH_DIR` binding, receipt
minting/correlation, per-turn staging, and the U22 rejection all stand.

---

## 7. memsearch pin (S2) — safe, decoupled, and negatively tested

1. **Full hash-locked offline closure**: memsearch, every transitive Python
   artifact, the interpreter, and the **embedding model digest**.
2. **Absolute executable path**; no PATH resolution, no `--upgrade`.
3. **Owner-side startup attestation**: the owner verifies the runtime and
   **refuses to start on mismatch, before any scope is opened**. Polygram
   performs no such check.
4. **Side-by-side immutable environments**, default-off, validated against a
   **synthetic copy** — never the live store.
5. **Atomic switch**, previous environment preserved for rollback.

**Acceptance negatives (all required):** offline install and offline run with no
network; **PATH-shadow rejection** (a same-named binary earlier in PATH must not
be selected); **interpreter, package, transitive-artifact, and model digest
mismatch each refuse startup before any scope open**; atomic side-by-side switch;
proven rollback to the previous environment.

**Removing `--upgrade` from the live plugin invocation is a later reviewed
production activation, not work this spec performs.**

---

## 8. Narrow MVP and non-goals

**MVP.** One owner process. Ivan's member DM: two scopes. Recall + write lanes.
Notify + sweep + boot reconciliation. Bounded dropbox/claimed state. Per-scope
quarantine for handled errors, with the §3.4 blast radius accepted. Pinned
runtime with startup attestation. Rebuild-from-journal on a synthetic copy.
**Hygiene-only isolation, with no cross-principal protection claimed.**

**Non-goals.** No second owner, multi-node ownership, distributed lock/lease/
fencing across hosts, or leader election. No external queue broker. No Milvus
server. No live restore. No new extractor. No group/partner enablement and no
Claude SDK transport. Per-scope owner processes are recorded (§3.4) but not built.

---

## 9. Changes by component

**Polygram** — versioned protocol client only: `recall` and `publish_notify` call
sites, version negotiation, socket config, circuit breaker. No memsearch version
knowledge, no scope paths, no store access.

**Memory owner** — §5, split U14 (runtime/protocol/client contract) and U16
(publish semantics).

**Infrastructure** — owner service account and unit; root-owned artifact and
digest allowlist; socket/dropbox/claimed/ledger paths and modes; S2's pinned
environment; monitoring for queue depth, oldest unclaimed age, claimed capacity,
publish failures, quarantine count. **U28** if/when cross-principal isolation is
required.

**Orchestra — no changes required.** U23 stands as approved; U14's Orchestra
release boundary for the model-facing recall mechanism is unchanged.

---

## 10. Sequencing and gates

**U16a A/B/C evidence is complete and spent at planned estimates; D remained
blocked and was never run.** Revision 3 is the authoritative record of
cross-process refusal for pieces A, B and C. Piece D — the five-run Linux latency
gate — was not started, because the compatibility check that precedes it returned
incompatible; it is retired rather than completed, since it would have measured
the topology this spec abandons. Nothing here is reworked, and A/B/C's overlap
proof does **not** transfer to an in-process lane.

| Old piece | Disposition |
| --- | --- |
| U16a-A / -B / -C | **completed** |
| U16a-D | **retired** — it would measure a topology we are not building; replaced by S1 (pre-build) and post-U16 G1 (authoritative) |

### S2 → S1 (ordering corrected)

S1's authoritative lane runs on pinned Linux + ONNX, so it **requires S2's
immutable pin**. The edge `S2 → S1` is explicit rather than assuming a second
attested pin.

### S1 — owner-shaped feasibility spike (before U14/U16)

A **minimal real owner process** accepting recall and mutation requests over its
socket and running the write lane **inside itself**. Newly proves, with no reuse
of U16a evidence: accountable overlap; visibility; bounded shutdown with no
orphan operation; **same-scope recall while indexing**; **scope-A recall while
scope-B indexes**.

Sequence: macOS screening, then **pinned Linux + ONNX as authoritative**.

**Oracle, pre-registered before the first run** — carried forward from the
established gate: `ratio ≤ 2.0` (concurrent p95 ÷ idle p95) **and** `concurrent
p95 ≤ 1200 ms`, over **40 idle + 40 concurrent** samples, on **three consecutive
runs** of the authoritative lane (S1 is a feasibility screen; the five-run rule
belongs to post-U16 G1).

**Three outcomes, distinguished:**

| Outcome | Meaning | Action |
| --- | --- | --- |
| **PASS** | thresholds met on three consecutive authoritative runs with sound evidence | proceed to U14/U16 on option 1 |
| **Valid performance FAIL** | evidence sound, thresholds missed | **return to §3 option comparison** with S1's numbers. Does **not** auto-select option 3 |
| **INCONCLUSIVE** | evidence, harness, or environment failure — unsound overlap, missing attestation, unpinned runtime, host contention | **fix the evidence and re-run. Do not reject the architecture on inconclusive data** |

### S3 — physical idempotency and durability spike (before U16, blocking)

Determines which §5.3 primitive the pinned memsearch actually provides: does
re-indexing the same `(part_id, destination)` upsert, duplicate, or error; is
read-before-retry sound; is rebuild-from-journal deterministic. Also validates
the fsync/copy/seal ordering against a late open-descriptor writer and a
simulated reboot. **U16 cannot be estimated as designed until S3 answers this.**

*(The round-2 "S3" — a static assertion that capture opens no store — remains
absorbed into U15 at no incremental cost. This S3 is a different, blocking unit.)*

### Post-U16 G1 — authoritative, after U14+U16, before U19

Measured against the **actual owner**. Thresholds carried forward: 2× ratio,
1200 ms, 40+40 samples, **five consecutive qualifying runs**, Linux, production
ONNX, authoritative adapter. Qualification is **proven, not labelled**: the run
records the owner's PID, proves that PID held the scope handle, and proves the
write lane executed **in that same process**.

### Dependency graph

```text
spine:   S2 ─► S1 ─► U14 ─► U16 ─► U17 ─► U18 ─► U26 ─► U19 ─► U20
                                    └─► G1 ────────────────┘

feeders into U14 :  U23                       (T14 = max(T23, TS1) + U14)
feeders into U16 :  U15, U24, U25, U27, S3    (S3 via S2; U15 via U23,U24)
feeder  into U20 :  U28  (U28 follows U16 and runs parallel to U19)

U23 ─┬─► U24 ─► U15 ─┐
     └─► U27 ────────┼─► U16        U25 ─► U16        S2 ─► S3 ─► U16
```

Recurrence (`U16a` spent ⇒ 0; U15's approved U16a dependency is satisfied by
completed evidence, which removes the old cycle):

```text
T23 = U23                     T24 = T23 + U24
T25 = U25                     T27 = T23 + U27
TS2 = S2                      TS1 = TS2 + S1        TS3 = TS2 + S3
T14 = max(T23, TS1) + U14     T15 = max(T23, T24) + U15
T16 = max(T14, T15, T24, T25, T27, TS3) + U16
TG1 = T16 + G1                T17 = T16 + U17
T18 = max(T16, T17) + U18     T26 = max(T25, T18) + U26
T19 = max(T18, T26, TG1, T27, T17) + U19
T28 = T16 + U28               T20 = max(T19, T28) + U20
```

**Direct-owner calls vs U14.** `publish_notify` and the operator/health surface
are direct owner-protocol calls and do not depend on the Orchestra-side
mechanism. Only the **model-facing** recall path depends on U14's Orchestra
release and consumer pin.

---

## 11. Estimates, critical path, failure/rollback, tests

### 11.1 Envelopes (renamed — no "total-from-zero")

The approved 32/56/91 was an **approval-time remaining-work envelope**, not a
project total. Historical actuals for U13/U21/U22 are unavailable, so no
project-lifetime total is claimed.

| View | Best | Likely | Worst |
| --- | ---: | ---: | ---: |
| Approved remaining envelope (at approval) | 32 | 56 | 91 |
| **Revised approval-onward envelope** | **40** | **69** | **115** |
| Spent since approval | 3 | 6 | 10 |
| **Remaining as of 2026-08-16 (MVP)** | **37** | **63** | **105** |
| Remaining, full parity (+U20 +U28) | 45 | 77 | 128 |

`spent + remaining = revised envelope`: 3+37=40, 6+63=69, 10+105=115 ✓.
"Spent since approval" is U16a-A/B/C at their planned estimates — actuals were
never tracked, and that is stated rather than invented. **U16a-D is retired, not
respent.**

### 11.2 Remaining work

| Unit | Best | Likely | Worst | Basis |
| --- | ---: | ---: | ---: | --- |
| U23 | 1 | 2 | 3 | unchanged |
| U24 | 3 | 5 | 8 | unchanged |
| U25 | 3 | 5 | 8 | unchanged |
| U27 | 1 | 2 | 4 | unchanged |
| **S2** | 1 | 2 | 4 | new; now precedes S1 |
| **S1** | 2 | 3 | 6 | new; owner-shaped, two hosts, pre-registered oracle |
| **S3** | 1 | 2 | 4 | **new**; idempotency primitive + durable ordering; blocks U16 |
| **U14** | 8 | 13 | 21 | was 4/7/12; +4/+6/+9 for owner runtime, protocol, client contract |
| U15 | 3 | 5 | 8 | unchanged; absorbs the capture-opens-no-store assertion |
| **U16** | 8 | 13 | 21 | was 8/13/20; loses process lifecycle to U14, gains bounded claim + reconciliation + quarantine |
| **G1** | 1 | 2 | 4 | new; authoritative post-U16 gate |
| U17 | 1 | 2 | 3 | unchanged; call-site integration only |
| U18 | 1 | 2 | 3 | unchanged |
| U26 | 1 | 2 | 4 | unchanged |
| U19 | 2 | 3 | 4 | unchanged |
| **Remaining MVP** | **37** | **63** | **105** | sum |
| U20 | 6 | 10 | 15 | unchanged |
| **U28** (identity separation) | **2** | **4** | **8** | **new**; U20 prerequisite, not MVP |
| **Remaining full parity** | **45** | **77** | **128** | 37+6+2 / 63+10+4 / 105+15+8 |

### 11.3 Critical path (from §10's recurrence)

| Node | Best | Likely | Worst |
| --- | ---: | ---: | ---: |
| TS1 = S2+S1 | 3 | 5 | 10 |
| TS3 = S2+S3 | 2 | 4 | 8 |
| T14 | 11 | 18 | 31 |
| T15 | 7 | 12 | 19 |
| T16 | 19 | 31 | 52 |
| TG1 | 20 | 33 | 56 |
| T17 | 20 | 33 | 55 |
| T18 | 21 | 35 | 58 |
| T26 | 22 | 37 | 62 |
| **T19 (MVP canary)** | **24** | **40** | **66** |
| T28 | 21 | 35 | 60 |
| **T20 (full parity)** | **30** | **50** | **81** |

Against the approved 20/34/53 and 26/44/68: **+4 / +6 / +13** to the canary.
**U14 is the pacing unit** on every column — the schedule turns on the owner
runtime. U28 runs in parallel with U19's canary and never reaches the path.
Revision 2's 23/38/62 is superseded by the `S2 → S1` edge and S3.

### 11.4 Failure modes and rollback

| Failure | Behavior | Mitigation |
| --- | --- | --- |
| Owner down | recall `unavailable`; capture keeps writing dropbox; replies unaffected | circuit breaker; reconciliation before traffic |
| Owner down past TTL | unclaimed captures expire | accepted best-effort; alert on oldest unclaimed age |
| Claimed capacity full | entries stay unclaimed; pressure reported | bounded by count/bytes/age |
| **Native crash / wedge / OOM** | **all scopes affected — global outage** | accepted MVP blast radius (§3.4); per-scope owner processes recorded as the later answer |
| Handled scope error | that scope quarantined; others serve | per-scope worker isolation |
| Crash after mutation, before ledger durability | resolved by the S3 primitive | S3 blocks U16 until the primitive is proven |
| Second owner instance | fail closed at startup fencing | instance lock + live-peer probe |
| Runtime drift | owner refuses to start before opening a scope | S2 attestation |
| Rollback | memory default-off; stop owner; nothing destroyed | never restores the unscoped legacy writer |

### 11.5 Acceptance matrix (additions)

**Authorization/protocol:** second-opener refused · startup fencing with a live
peer · stale-socket rebind only when proven dead · peer-credential rejection ·
per-operation authorization negatives · caller-supplied scope rejected ·
oversized frame, too many in-flight, too many connections, idle timeout ·
protocol version mismatch.

**Single-binding enforcement (§5.1) — startup and reload negatives:** a registry
with exactly the approved single-person binding starts · a registry adding a
second person **refuses startup** · adding a shared UMI group **refuses startup**
· adding a partner binding **refuses startup** · each of those presented at
**reload** is rejected and **the previous configuration stays in force** · the
same multi-principal registry **is accepted once an attested U28 capability is
active** · a forged, absent, or expired U28 attestation with a multi-principal
registry refuses · every refusal is content-free and names no binding content.

**Claim/ledger/durability:** duplicate `publish_notify` is a no-op · lost
`publish_notify` recovered by sweep · sealed claim material cannot be mutated ·
late writer holding an open descriptor cannot alter sealed material · late writer
after terminal refused · claimed-capacity-full leaves entries unclaimed and
reports pressure · bounds by count, bytes, age · **post-side-effect/pre-ledger
crash resolves to exactly one logical record**.

**Crash:** SIGKILL before copy, after copy/before seal, after seal/before ledger,
after ledger/before mutation, **after mutation/before destination durability**,
mid-fanout, after terminal marker — each reconciling to one outcome, missing
destinations retried, committed ones never re-published · simulated reboot after
each fsync boundary.

**Owner shape:** recorded PID holds the handle · write lane proven in the same
PID · scope-A recall while scope-B indexes · same-scope recall during indexing ·
single-scope quarantine leaves others serving · bounded shutdown, no orphan op.

**Backup:** checkpoint quiesces the scope · journal+ledger+tombstones captured as
one consistent set · index excluded · dropbox/claimed excluded · manifest carries
scope/version/model/digest · negative cross-scope restore · negative
cross-version restore · rebuild-from-journal on a synthetic copy.

**S2 negatives:** offline install and run · PATH-shadow rejection · interpreter,
package, transitive-artifact, and model digest mismatch each refuse startup
before any scope open · atomic side-by-side switch · rollback proof.

---

## 12. What changes from the approved plan, and why

1. **U16's detached publisher process is retired**; publication becomes the
   owner's write lane. *Why:* VF-A/VF-D.
2. **U14 grows to own the owner runtime, protocol, and client contract**
   (4/7/12 → 8/13/21); U16 owns publish semantics; U17 owns call-site
   integration. *Why:* no gateway service exists, and the round-2 draft assigned
   client work twice.
3. **U16's requirements carried correctly**: R6-R8, R11-R18a, R60-R69.
4. **U16a A/B/C closed as spent at planned estimates; D remained blocked and
   unrun** for the now-retired cross-process topology. A/B/C's evidence is
   non-transferable to an in-process lane.
5. **Three gates**: S2 → S1 (feasibility, three-outcome oracle), S3
   (idempotency/durability, blocks U16), and post-U16 G1 (authoritative, PID and
   same-process proof).
6. **Fault isolation claim corrected** (§3.4) and the MVP blast radius accepted;
   per-scope owner processes recorded as the later alternative.
7. **Security identity prerequisite rewritten** (§5.1): a Polygram-UID check does
   not exclude provider children, and the hook wrapper is not privileged. MVP
   ships hygiene-only isolation and claims no cross-principal protection; **U28
   gates U20**.
8. **Backups gain an owner-coordinated checkpoint**; independent live copying is
   invalid. Live restore stays deferred.
9. **Estimates renamed to envelopes**: remaining 37/63/105, revised
   approval-onward envelope 40/69/115, canary 24/40/66.
10. **Nothing else changes.** Product policy, the member/team/partner matrix,
    native capture, U22's rejection, secret boundaries, and the staging trust
    model are untouched.

### Open decisions for Ivan

1. **Approve option 1 subject to S1 and S3**, with options 2 and 3 both live if
   S1 records a valid performance failure — no automatic fallback to either.
2. **Approve `S2 → {S1, S3}` before U14/U16** — S2's pin first, then S1 and S3
   **in parallel**, matching the §10 graph. Effort and elapsed differ and are
   stated separately: **7 likely engineer-days total** (S2 2 + S1 3 + S3 2), but
   **about 5 likely elapsed days** when S1 and S3 run in parallel after S2
   (2 + max(3, 2)). This buys both answers at once — whether the owner shape
   meets the gate, and which idempotency primitive the pinned version provides.
3. **Accept the MVP blast radius** (§3.4): a native crash or wedge in the single
   owner is a global memory outage, not a per-scope one. Alternative is per-scope
   owner processes, which MVP does not build.
4. **Accept hygiene-only isolation for MVP** (§5.1), with **U28 (2/4/8) as a hard
   prerequisite for the second binding**. MVP claims no cross-principal
   protection.
   **Operational limit, binding and enforceable:** while isolation is
   hygiene-only, **only the single-person Ivan binding may be enabled.** No
   second person, no shared UMI group, and no partner binding may be enabled
   until U28 has proven the cross-principal boundary. Enabling any of them
   earlier would assert a protection the deployment does not have.
   If you want that protection from day one, U28 moves into the MVP and adds
   2/4/8 engineer-days plus a provider-spawn identity change on both backends —
   the Claude CLI backend being the hard half, since it has no equivalent to
   Codex's filesystem-deny profile.

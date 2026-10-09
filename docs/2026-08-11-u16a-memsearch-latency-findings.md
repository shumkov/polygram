# Scoped memory U16a findings — lane B/C (process writer, cross-process storage)

Date: 2026-08-16 (revision 3). Revisions 1-2: 2026-08-11 and 2026-08-14.

Revision 3 (2026-08-16) adds the first real evidence from the production Linux
host: piece A is **closed** — the effective embedding boundary is now observed,
not inferred — and piece D is **blocked** before its first measurement, because
the same-scope design-compatibility check reproduces on Linux, on the production
ONNX boundary, exactly as it did on macOS. §8 records both. The harness also
gained the `g1_qualifying_run` invariant (§2).

Revision 2 (2026-08-14) folds in the consolidated B/C review must-fixes: the
same-interpreter writer is removed rather than kept as a comparator, a clean
shared-scope refusal must now be proven, `shared-file` with a separate writer
process is refused outright, and production-class qualification became a named
conjunction that an incompatible multi-writer design cannot pass. §3 and §5 are
re-measured against the final harness; §1 and the environment are unchanged.

Status: **U16a pieces B, C and A are complete. Piece D is BLOCKED by an
architectural finding, not by effort: the storage layer does not serve the
concurrent access the publisher/gateway split needs (§8). G1 remains OPEN and
memory feature enablement stays blocked.** The harness proves the concurrent
writer was running across the measured window instead of assuming it, and it
answers the shared-scope storage question instead of leaving it deferred.

Where each piece stands:

- **A — closed (§8.2).** The effective embedding boundary was read on the
  production host: provider `onnx`, its default model already staged, offline
  resolve memsearch 0.4.17 / pymilvus 3.0.1 / onnxruntime 1.28.0.
- **B and C — complete (§1-§5, §8.3).** Overlap is evidenced, and shared-scope
  access is classified rather than assumed.
- **D — blocked before its first measurement (§8.3, §8.4).** C's check ran first
  on the production host and returned `design_compatible: false`, so the
  five-run latency gate was not started. It would have measured a topology the
  storage layer does not serve.

The latency numbers in §3 were taken on macOS against the loopback embedding
stub and are not the production gate; the only production-boundary measurement
in this document is the shared-scope classification in §8.3.

This document records only the evidence produced in this lane, in the worktree
`polygram.scoped-memory-latency-gate` (branch `spike/scoped-memory-latency-gate`,
based on `origin/main` at `2d8cfd8`). It does not restate, revise, or supersede
the **other lane's** memo of 2026-08-11 (its own revision 2, in the
`polygram.codex-support-estimate` worktree) — in particular its five unchanged-harness
runs, its `proc-writer` diagnostic, and its provider-boundary correction, which
were produced in a different lane and remain the record for those questions.

The 2× ratio, the 1200 ms absolute budget, the 40+40 sample count, and the
existing oracles are unchanged:
`GateThresholds(samples=40, max_concurrent_ratio=2.0, max_concurrent_p95_ms=1200.0)`.

---

## 1. The defect, measured before the fix

The prior memo's D1 said the writer was a same-process thread. Measuring the
unchanged harness shows a second, independent defect in the same place: the
writer did not merely share the interpreter, **it had finished before the
measurement began**, and nothing in the gate could tell.

Characterization run against the byte-identical committed harness
(`gate.py` SHA-256 `8cbf04a8…d4a9`, matching the 2026-08-11 memo's §1 table),
with an adapter that timestamps each `upsert` and each measured `search`,
8 samples, fake adapter:

| Observed | Value |
| --- | --- |
| Reader window | 0 → 701.913 ms |
| Writer window | −0.072 → **−0.043 ms** (i.e. it ended before the first sample) |
| Overlap with the measured window | **0.0 ms**, coverage **0.000** |
| Gate's `concurrent_latency` verdict | **PASS** |
| Gate's overlap evidence | **none emitted** |

The gate scored a "concurrent" p95 that had no concurrent writer in it, and
reported `PASS`. The same script against the corrected harness — measured while
a same-interpreter writer still existed, before §2 removed it — reported the
writer running from −11.9 ms to +1056.8 ms across a 1056.8 ms window, coverage
1.000, `writer_overlap: true`. The corrected harness's separate-process writer
covers its window in every run in §3.

This is a fixture demonstration of the failure mode, not a memsearch
measurement: the fake's `upsert` is a dictionary write and its `search` sleeps
10 ms, which makes the early-finishing writer deterministic. With the real
backend the writer happened to outlast the reader — but that was luck, and the
old harness had no way to distinguish the two cases.

---

## 2. What the corrected harness now proves

New in this lane (`scripts/spikes/memsearch-isolation/`):

- **`writer_process.py`** — the separate-process writer protocol. Ready/stop
  handshake, bounded timeouts, `CLOCK_MONOTONIC` stamps on both sides (a system
  clock on Linux and macOS, so a parent may compare its stamps with a child's),
  a result file checked against the pid actually spawned, and a sanitized JSON
  result.
- **The writer is a real OS process, and it is the only supported writer.** The
  same-interpreter comparator was removed rather than kept: a Python thread
  blocked in backend I/O cannot be cancelled, so the gate could not guarantee it
  had stopped writing before reporting, and a writer still running after the
  measurement is a writer the gate cannot account for. Its recorded comparison
  survives only as the historical diagnostic in §3.
- **The writer covers the measured window by synchronization, not arithmetic.**
  The child signals ready only after its *first write has completed*, and the
  reader stamps its window only after seeing ready — so "the writer's first
  write began no later than the first sample" holds by construction. It keeps
  writing until the reader stops it, and still performs the same 40 distinct
  record ids first, so the visibility oracle's expected id set is unchanged.
- **Repeat passes revise the record body.** memsearch's `_index_file` returns
  early when it already holds a chunk's content hash (`if not chunks: return 0`),
  so a writer repeating identical text would spin without storing anything. The
  writer also reports the chunks it actually indexed, and the gate rejects a
  writer whose reported index work is zero.
- **Unsound writer evidence sinks the latency verdict.** `writer_overlap` and
  `concurrent_latency` both fail when the evidence is missing, malformed,
  non-finite, from another process, from a non-zero exit, from a writer that
  reported its own failure, or does not cover the window — including the case
  where the reader took all 40 samples inside both thresholds while the writer
  had already died.
- **`shared-file` with a separate-process writer is refused** in the library and
  in the CLI, and is no longer in any default topology set. An empty topology
  set is refused too, rather than reporting `PASS` having measured nothing.
- **`provider_evidence`** fails when the adapter does not name its embedding
  boundary, and `MEMSEARCH_GATE_EMBEDDING` is required (`onnx` |
  `loopback-stub`).
- **`production_class` is a named conjunction**: Linux host, process writer,
  exactly 40 samples, the real (non-stub) embedding boundary, an authoritative
  adapter, **and** a multi-writer design the backend actually serves. The runner
  prints the unmet requirements, and every run also prints that a
  production-class run is still not a G1 pass — G1 needs five consecutive
  production-class runs in the piece D Linux matrix.
- **`same_scope_cross_process`** — the bounded check described in §4, which now
  carries a separate `design_compatible` field.
- **`g1_qualifying_run`** — production-class describes a run's *inputs*; this
  field additionally requires the run to have passed. Without it, "five
  consecutive production-class runs" could be counted from five consecutive
  *failing* runs. The D matrix counts `g1_qualifying_run`, never
  `production_class`.

Two deliberate properties of the measurement are stated rather than hidden: the
reader hands its writer-scope handle over before the writer starts (production's
publisher owns the file it writes, and §4 shows a second process cannot open a
scope the reader holds), and the writer process runs its own embedder, which is
also the production shape. The `process` and (removed) `thread` arms therefore
differed in more than the scheduler, and no claim here rests on them differing
only in that.

## 3. Measurements

Real adapter, `memsearch=0.4.17;pymilvus=3.0.1`, topology `per-scope-file`,
40 idle + 40 concurrent samples, `MEMSEARCH_GATE_EMBEDDING=loopback-stub`.
**`production_class: false` in every run; none of these is a G1 result.**

### 3.1 Final harness — separate-process writer

| Run | Idle p95 (ms) | Conc. p95 (ms) | Ratio | ≤ 2.0? | Writer ops / chunks | Coverage | Status |
| --- | ---: | ---: | ---: | --- | ---: | ---: | --- |
| 05 | 9.706 | 12.410 | 1.279 | pass | 40 / 40 | 1.000 | PASS |
| 06 | 11.608 | 10.515 | 0.906 | pass | 40 / 40 | 1.000 | PASS |
| 07 | 9.149 | 12.605 | 1.378 | pass | 40 / 40 | 1.000 | PASS |

Writer and reader windows, relative to the first measured sample:

| Run | Writer window (ms) | Reader window (ms) | Covers? |
| --- | --- | --- | --- |
| 05 | −27.296 → 609.177 | 0 → 370.202 (last sample starts 361.871) | yes |
| 06 | −14.954 → 582.164 | 0 → 338.795 (last sample starts 327.993) | yes |
| 07 | −25.035 → 602.460 | 0 → 367.115 (last sample starts 354.108) | yes |

All three exited **0** — every check passed, including the shared-scope check,
whose proven clean refusal (§4) completes it. All three are nonetheless
`production_class: false`, with unmet requirements
`linux_host`, `production_embedding_boundary`, and
`multi_writer_design_compatible`; the runner names them, and states that even a
production-class run would not be a G1 pass on its own.

The absolute 1200 ms budget was never in play (10.5–12.6 ms).

### 3.2 Historical diagnostic — the removed same-interpreter writer

Recorded earlier in this lane against a harness revision that no longer exists:
four runs with the writer as a thread in the reader's interpreter gave ratios
**2.596 / 2.421 / 2.143 / 2.431** (idle p95 9.5–11.0 ms, concurrent p95
23.5–24.7 ms), each with coverage 1.000 and 40 indexed chunks, against four
separate-process runs on the same host at **0.984 / 1.152 / 1.659 / 1.156**.
Those eight runs exited **1** because the gate's *status* was FAIL — the
shared-scope check was then scored as a failure in every run, and the thread arm
additionally failed the ratio — not because of the production-class banner,
which never affected the exit code without `--require-production-class`.

That comparison is kept as history, not as a claim. The thread arm cannot be
re-measured: the harness no longer supports it, and the two arms differed in
more than the scheduler (§2). It is consistent with the prior lane's
2.212–2.557 and with its root-cause attribution, and it is not evidence this
lane relies on.

### What §3.1 supports, and what it does not

Three overlap-verified runs of the corrected harness satisfy both unchanged
thresholds on this host. That is **not** a G1 pass: the boundary is the ~1 ms
loopback stub rather than CPU-bound int8 bge-m3 inference, the host is a
10-core Mac rather than the VPS, the multi-writer design the publisher/gateway
split needs is not served here (§4), and three runs are not the five consecutive
production-class runs the gate requires. The prior memo's warning stands — an
ONNX boundary moves the dominant cost into the resource the two processes
compete for, and the corrected gate may still fail on Linux.

Coverage is measured to the start of the reader's last sample rather than to its
return, because the writer stamps an operation's end before it can observe the
stop request; demanding that its last stamp outlast the reader's final return
rejects a writer that was in fact writing throughout, on a race of one operation
boundary. That was found by a flaking self-test, not reasoned about in advance.

---

## 4. Same-scope cross-process access — refused, and the refusal is proven

The prior memo deferred D4 ("whether the publisher process and the recall
gateway may open the same scope's Milvus-Lite file concurrently") to U16. The
check answers it on its own scope, with its own record ids, bounded to five
writes, five reads, one single-write control process, and the writer timeouts.
Only two outcomes complete it:

- `supported` — the access worked and every written record is visible. **Only
  this sets `design_compatible`.**
- `unsupported-clean` — the backend refused it outright and lost nothing, on
  proof: **zero** writer operations, no partial record left behind, no reader
  error, the pre-existing record still visible, and a control writer that
  succeeds on the same scope once the reader releases it.

Everything else is `unsafe-*` (accepted then lost, hid, or half-wrote data, or
damaged the reader) or `inconclusive-*` — including a refusal whose control
writer also fails, which is indistinguishable from a broken backend and is
reported as `inconclusive-ambiguous-error` rather than as a clean refusal.

The writer's own report must also be capable of being true before any of it is
read. The gate's writer loop exits zero exactly when it reports no failure,
counts operations upward from zero, and completes every record id it was asked
for before it may stop — so evidence that reports success with zero (or too few)
operations, a failure with a zero exit, no failure with a non-zero exit, or a
count that is negative or not a number cannot have come from it. Those shapes
are `inconclusive-invalid-evidence`. Before that rule they read as `supported`
or `unsupported-clean`: a writer claiming success without a single operation
completed the check, which is exactly the false pass the rule closes.

**Result on this host: `unsupported-clean`, with `refusal_proof: true`.** While
the reader holds the scope open, the writer process cannot open the same
Milvus-Lite file:

```
RuntimeError: Failed to open the local Milvus Lite database. If this database was
created with an older Milvus Lite release, it may not be compatible with Milvus
Lite 3.x. ...
```

The message is misleading — it advises about file format — so an isolated
reading would blame a corrupt database. The control writer is what discriminates
it: the same scope, written by a fresh child process, succeeds as soon as the
reader releases it. The constraint is exclusive open by a live process, not the
file. The gate records a bounded, path-free backend message alongside the
exception class, because the class name alone would send a reader to the wrong
conclusion.

Stated precisely, because the difference matters: the writer failed at **open**,
before any write, so the reader performed **0 concurrent queries** in that
window (the evidence records `reader queries 0/0`). What is proven is that the
shared open is refused, that nothing was lost, and that the scope is usable
again once released — not that concurrent shared reads and writes were survived.

**Consequence for U16, and for qualification.** On this host and version a
publisher process may not write a scope while the recall gateway holds it open.
The check completes — this is a design constraint, not a hazard — but
`design_compatible` is false, and `production_class` requires it. No run built
on this backend can qualify while the publisher/gateway split needs shared
access, which is the intended interlock: G1 cannot be claimed for a design the
storage layer does not serve. If Linux (piece D) reproduces this, U16's
publisher must route index mutations through the process that serves recall, or
release and reopen around publication — which changes U16's shape and needs its
own estimate.

### `shared-file` with a separate writer process: refused, not measured

Recorded earlier in this lane: with all scopes in one file, the writer child got
past its warm-up open and signalled ready, and the **reader's own connection
then died mid-measurement**, aborting the topology with

```
MilvusException: (code=2, message=Fail connecting to server on 127.0.0.1:<port>,
illegal connection params or server unavailable)
```

raised inside the parent's measured query on scope `beta`. The harness now
refuses that combination outright, in the library and in the CLI, and no default
topology set contains `shared-file`: a run whose reader dies because the writer
opened the file it holds measures a collision, not a latency, and the
shared-access question is answered deliberately by the check above.

---

## 5. Verification performed in this lane

```sh
python3 -m unittest discover -s scripts/spikes/memsearch-isolation -p 'test_*.py'
# Ran 54 tests — OK (72.0-131.4 s); repeated green runs, see below
```

The suite grew from 8 tests to 54. The original oracle tests are unchanged in
substance. The new ones cover the process writer covering the window; a writer
that stopped early, died mid-measurement, reported a failure on a clean exit, or
was never started at all sinking `concurrent_latency`; every
malformed/missing/foreign-pid/non-zero-exit/zero-index evidence case; a child
result whose pid is not the spawned process; ready being signalled only after
the first successful write, and never after a failed one; no writer process
surviving the topology it belongs to; the revise-on-repeat write loop; the child
protocol's no-result, unreadable-result and never-exits paths; the shared-scope
classification table (support, proven refusal, unproven refusal, partial write,
reader fault, data loss, silent divergence, protocol and evidence failures);
the refusal proof end to end against real child processes; contradictory
writer evidence failing closed; process plus
`shared-file` refused in library and CLI; an empty topology set refused; ratio
and absolute thresholds failing independently; an incompatible multi-writer
design blocking production-class; and no absolute path reaching the emitted
evidence. Four later additions pin production qualification from all sides: a
run with every production input mocked in (Linux host, ONNX boundary,
authoritative adapter, exactly 40 samples, a served multi-writer design) does
qualify; a production-class run that *failed* its checks is not
`g1_qualifying_run`; a **passing run that is not production-class** is not
either; and a matrix that could not run at all fails closed through both the
per-topology error fallback and the matrix aggregation.

The last two exist because a reviewer showed the first two were not enough:
mutating the invariant to `g1_qualifying_run = passed` — dropping the
production-class conjunct entirely — survived all 52 tests, because every case
then covered had `production_class` and `passed` agreeing. Three mutants are now
killed by the qualification tests alone: dropping the conjunct, flipping the
matrix error fallback to `True`, and stubbing the matrix aggregation to `True`.

**Each new rule was verified to be load-bearing**, by reverting it alone in a
scratch copy and confirming the matching test fails. All twelve came back red:

| Reverted rule | Result |
| --- | --- |
| refusal proof required for `unsupported-clean` | RED |
| partial write after refusal is unsafe | RED |
| reader fault during shared access is unsafe | RED |
| design compatibility blocks production-class | RED |
| process + `shared-file` refused (library and CLI) | RED |
| `concurrent_latency` requires sound writer evidence | RED |
| child result pid must match the spawned process | RED |
| writer `error_code` validated | RED |
| ready only after the first successful write | RED |
| independent ratio and absolute thresholds | RED |
| empty topology set refused | RED |
| absolute paths scrubbed from error evidence | RED |

A later review pass found one more false pass and it was fixed test-first:
contradictory writer evidence was being classified as an answer. Eight
contradiction fixtures were added and observed red — success with zero
operations and success with too few operations both read as `supported`; a
non-zero exit with no error, a zero exit with an error, and a non-name error all
read as `unsupported-clean`; a negative and a non-numeric operation count read
as `unsafe-partial-write` — and all eight are now
`inconclusive-invalid-evidence`.

Two test defects were found and fixed while doing this. The `ReaderWindow`
fixtures in two cases were bare two-element tuples that the code never unpacked,
because those cases return on the invalid path first — the assertions passed
without exercising anything; they are now well-formed three-element windows. And
the first pair of threshold-independence tests asserted a wall-clock ratio from
a live run, which flaked twice on this loaded host: a single slow idle sample
moves the ratio enough to hide which threshold failed. Threshold scoring is now
a pure function over fixed sample lists, tested deterministically, with one live
run kept to confirm a slow backend still fails the gate.

The real-backend runs used:

```sh
MEMSEARCH_GATE_EXPECTED_VERSION=0.4.17 \
MEMSEARCH_GATE_EMBEDDING=loopback-stub \
MEMSEARCH_GATE_WRITER=process \
uv run --offline --no-project --python 3.12 --with 'memsearch==0.4.17' \
  python scripts/spikes/memsearch-isolation/run_gate.py \
    --adapter deployed_memsearch_adapter:create_adapter \
    --topology per-scope-file \
    --work-dir <mode-0700 scratch> --output <scratch>.json
```

Each printed `HARNESS PASS (NOT PRODUCTION-CLASS): unmet ['linux_host',
'multi_writer_design_compatible', 'production_embedding_boundary']; this is a
diagnostic, not a G1 result` followed by the standing note that G1 requires five
consecutive production-class runs.

### Environment

| Item | Value |
| --- | --- |
| Host | `shumabook` (Ivan's Mac), Apple M1 Pro, 10 cores, 32 GiB |
| OS | macOS 26.6.1, build 25G76, arm64 |
| Python | 3.12 in a disposable `uv` ephemeral environment (3.14.6 for the self-tests) |
| uv | 0.12.3 |
| memsearch / pymilvus | **0.4.17** (gate pin, enforced) / **3.0.1** |
| Packages | resolved offline from the existing local `uv` cache; no network fetch |
| Embeddings | loopback-only deterministic stub, no credential, no embedding network request |
| Host load during runs | 1-minute load average 22–34 from unrelated user workloads |

The host was heavily loaded, which inflates tail variance — the decision
variable is a ratio of two p95 estimators and is sensitive to exactly that, as
the flaking threshold tests in §5 demonstrated directly. No absolute number here
is production-representative.

---

## 6. What remains open

- **A — host/provider boundary and model staging: CLOSED (§8.2).** The provider
  is `onnx`, pinned by a one-key host config with no credential in it; the
  default ONNX model was already staged; the offline resolve is memsearch
  0.4.17 / pymilvus 3.0.1 / onnxruntime 1.28.0. Nothing was downloaded or
  installed. One new item came out of it: production does **not** pin memsearch
  (`uvx --upgrade`), so the boundary floats and U16 must pin it before any G1
  claim means anything past today.
- **D — five production-class Linux runs: BLOCKED, not attempted (§8.3).** The
  pre-registered order runs the same-scope check first, and it returned
  `unsupported-clean` with `refusal_proof: true` and `design_compatible: false`
  on the real production boundary. The five runs were therefore not started:
  they would measure a topology the storage layer does not serve. The pass
  condition is unchanged and remains unmet.
- **G1 is still open**, and the §3 numbers must not be presented as closing it.
  A macOS run against a ~1 ms stub is not the Linux ONNX gate, and the harness
  now refuses to call any such run production-class.
- **Five consecutive production-class runs** remain the D-matrix qualification.
  The harness scores one run at a time and says so on every run; nothing here
  aggregates runs or claims a G1 pass from one.
- **U16 storage design — now the critical path (§8.4).** The Linux confirmation
  arrived and it is negative: Milvus-Lite 3.x permits one live process per
  store. U16 must choose between routing mutations through the recall process,
  an explicit scope-ownership handoff, or a different backend. Each needs its
  own estimate. Until one ships, `multi_writer_design_compatible` is false, no
  run is production-class, and G1 is unreachable.
- **Deferred to D hardening, deliberately:** harness drift control (pinning the
  gate files' own hashes at run time), strict JSON-only stdout separated from
  the human banner, an operator-supplied work-dir cleanup policy, and the
  owner/busy/cleanup attestations themselves. None is needed to make this lane's
  evidence sound; all are needed before the Linux matrix is run.

---

## 7. Changed files, and what was not touched

Changed in this repository — the harness and this document only:

- `scripts/spikes/memsearch-isolation/writer_process.py` (new)
- `scripts/spikes/memsearch-isolation/gate.py`
- `scripts/spikes/memsearch-isolation/deployed_memsearch_adapter.py`
- `scripts/spikes/memsearch-isolation/fake_adapter.py`
- `scripts/spikes/memsearch-isolation/run_gate.py`
- `scripts/spikes/memsearch-isolation/test_gate.py`
- `scripts/spikes/memsearch-isolation/README.md`
- `docs/2026-08-11-u16a-memsearch-latency-findings.md` (this file)

The harness files were brought into this worktree from the
`feat/shumabit-scoped-memory` branch at `ee08b86`, byte-identical to that commit
(SHA-256 verified against the 2026-08-11 memo's §1 table) before any edit.
`scripts/spikes/memsearch-isolation/` does not exist on `origin/main`, so all
seven files are untracked additions in this worktree, not modifications of
tracked files.

SHA-256 of the harness as it stands after the review must-fixes:

| File | SHA-256 |
| --- | --- |
| `gate.py` | `4d61ca233ea47b1293ceee363a679145ff17cc8588e551194c4e652f35622b76` |
| `writer_process.py` | `95f3a92cd9d6ff9161761748265907b6021efac175f9493b2d461c06c5811efe` |
| `deployed_memsearch_adapter.py` | `b489316ed497ae1152c38bd7dd1188c93d79e3717aca5f4676ec493d23ad83c4` |
| `fake_adapter.py` | `bf77deb6eabae6471db397e7d06c5d85972f2580b3876c6c8988675a12cfb9e9` |
| `run_gate.py` | `44e96969397a88285a3b99ffead7af9ab285449e9acf03b5acb5cc5f3d7cd6e6` |
| `test_gate.py` | `e23658f3284a473e6d611b3b1da1ee712ebefea534994f8b0fb98c6609a04f4e` |
| `README.md` | `31dcde456f4d612e26076a1a8ac2f46f47254ad02a886edd306cd282298216ff` |

Explicitly not touched:

- No application code, no `lib/`, no `polygram.js`, no migrations, no repository
  tests outside the spike directory.
- The approved plan was read only and not modified.
- Nothing was committed, pushed, deployed, restarted, or posted. **Nothing in
  production was written or mutated** — no configuration change, no service
  state change, no package installation, no write to any production store.
- Production state *was* read, in bounded read-only form, and §8 depends on it:
  allowlisted `systemctl show` metadata for the six current owners plus the
  absent legacy unit; authenticated IPC
  busy counts, parsed and never printed; and the single non-secret key of
  `~/.memsearch/config.toml` (`embedding.provider`), read through a parser that
  redacts the value of every field outside a fixed non-secret allowlist. No
  credential value, Telegram chat, transcript, raw journal, pane, environment,
  or memory body was read. `~/.memsearch` was read as metadata only (one config
  key plus mtimes) and never written — its mtimes are unchanged (§8.5).
- No host or provider staging: no HuggingFace fetch, no `memsearch[onnx]`
  install, and no global install. The ONNX model and the memsearch
  distributions were already present in the host's own caches.
- All runs used synthetic fixture strings (`gate-alpha`, `gate-beta`,
  `gate-concurrent-N`, `gate-sameproc-N`) in mode-0700 scratch directories
  outside the repository, removed after each run.
- Resource use was bounded: one gate process at a time, ~70–90 s per 40-sample
  run, no parallel fan-out.
- sccache was not started, stopped, or otherwise touched.

---

## 8. Production host evidence — piece A closed, piece D blocked

All of this was observed on the UMI VPS (`umi-vps.tail8aaf04.ts.net`,
Linux 6.8.0-136-generic x86_64, 8 cores, 23 GiB) on 2026-08-16, through
metadata-only allowlisted probes and one bounded disposable run. No service was
restarted, no configuration or production data was modified, nothing was
installed, and the disposable scratch was removed and proven absent.

### 8.1 Owner and busy attestation

`split-ready` before and after. The legacy `shumabit-sessions.service` is
`LoadState=not-found` / `ActiveState=inactive`, and both
`/etc/systemd/system/shumabit-sessions.service` and
`/home/shumabit/start-sessions.sh` are absent. All six current owners were
`enabled` + `active (running)` in their exact `/system.slice/<unit>` cgroup, and
each owner's `InvocationID`, `MainPID` and `NRestarts` were **byte-identical
before the probe, immediately after it, and after cleanup**:

| Owner | MainPID | NRestarts |
| --- | ---: | ---: |
| `polygram-shumabit.service` | 3235463 | 8 |
| `polygram-umi-assistant.service` | 1254190 | 3 |
| `polygram-tmux.service` | 2929566 | 0 |
| `water-tmux.service` | 2929588 | 0 |
| `shumabit-admin-tmux.service` | 2929574 | 0 |
| `water.service` | 6909 | 0 |

Authenticated busy checks returned `in_flight=0` for `shumabit`,
`umi-assistant` and `water` both before and after the run. No raw IPC response
was printed.

### 8.2 Piece A — the production embedding boundary, observed

The prior revision could only say the effective provider was unversioned host
state it had not read. It has now been read, and only the non-secret keys were
extracted:

- `~/.memsearch/config.toml` contains **exactly one key**:
  `embedding.provider = "onnx"`. The whole file is 30 bytes; there is no model
  override, no base URL, and **no credential of any kind** in it.
- No `.memsearch.toml` and no repo-level `.memsearch/config.toml` exists in
  `~/shumabit-claude`, so nothing overrides it at a higher precedence rung.
- The model is therefore memsearch's ONNX default, and it is **already staged**:
  `~/.cache/huggingface/hub/models--gpahal--bge-m3-onnx-int8` (561 MiB of HF
  cache). No download, and no approval for one, was needed.
- An offline resolve of the production extra resolves to **memsearch 0.4.17,
  pymilvus 3.0.1, onnxruntime 1.28.0** — the same memsearch version the gate
  pins, and the newest of the eleven versions (0.4.7 … 0.4.17) in the host's
  `uv` cache.

**One correction to carry forward, because it changes what a gate can promise:**
production does not pin memsearch. The plugin invokes
`uvx --upgrade --from 'memsearch[onnx]' memsearch`, so the effective version
floats to whatever resolves at invocation time. 0.4.17 is what it resolves to
today, not what it is guaranteed to run tomorrow. Any G1 claim is therefore a
claim about a moving boundary unless U16 pins it.

### 8.3 Piece D — blocked before the first measurement

The same-scope cross-process check was run first, exactly as the gate order
requires, against the **real production boundary** (`MEMSEARCH_GATE_EMBEDDING=onnx`,
`HF_HUB_OFFLINE=1`, memsearch 0.4.17 / pymilvus 3.0.1) in a mode-0700 disposable
scratch directory, with its own scope and its own record ids:

```
classification    : unsupported-clean
refusal_proof     : true
design_compatible : false
writer            : ops=0, exit_code=1, error_code=RuntimeError, separate_process=true
reader            : queries 0/0, no errors
sentinel          : visible before and after
visible_ids       : []
```

The writer process was refused at open with the same misleading
`Failed to open the local Milvus Lite database …` message seen on macOS, having
performed **zero** operations and left **no** partial record. The control writer
then succeeded on the same scope once the reader released it, which is what
makes `refusal_proof` true: the constraint is exclusive open by a live process,
not a damaged store.

**Per the pre-registered order, the five-run latency gate was not started.** It
would have measured a topology the storage layer does not serve, and no number
of passing latency runs could make that access exist. `production_class` was not
weakened to let it run, and no G1 claim is made.

### 8.4 The architectural blocker, stated plainly

Milvus-Lite 3.x permits exactly one live process per store. The design U16
depends on — a publisher process writing a scope while the recall gateway holds
that scope open — cannot be served by this backend on the production host. This
is now confirmed on the two combinations actually observed — macOS with the
loopback stub, and the production Linux host with the production ONNX boundary
— with a positive refusal proof in each. Those are two points, not a four-cell
matrix: macOS+ONNX and Linux+stub were never run, and nothing here claims them.

It is a clean constraint, not a hazard: nothing was lost, the reader was never
damaged, and the scope was usable again the moment it was released. But it is
architectural, and it lands before latency. U16 must choose one of:

1. route every index mutation through the process that serves recall (the
   publisher stops being a separate writer);
2. have the publisher acquire, mutate and release each scope while the gateway
   is not holding it (an explicit ownership handoff, with its own contention and
   staleness budget);
3. move off Milvus-Lite to a backend that serves concurrent access.

Each changes U16's shape and needs its own estimate. Until one is chosen and
implemented, `multi_writer_design_compatible` stays false, no run can be
production-class, and G1 cannot be reached — which is the interlock working as
designed rather than an obstacle to route around.

### 8.5 Containment and cleanup

The run created exactly one directory, `mktemp -d /home/shumabit/.u16a-gate-XXXXXX`,
mode 0700, containing the four harness files (SHA-256 verified identical to this
worktree), one probe driver, and the run's own scratch store — 50 entries,
340 KiB, all inside it. It was removed with `rm -rf` and proven absent; no
`.u16a-gate-*` directory remains in the home directory. No probe or `uv` process
survived the run. `~/.memsearch/.index-state.json` (2026-07-28),
`config.toml` (2026-04-17) and `milvus.db` (2026-07-15) kept their
pre-existing mtimes, so the production memory store was never written.

Disclosed rather than cleaned: `uv run` resolved offline from the host's
pre-existing `~/.cache/uv`, which may have gained an ephemeral environment entry.
That cache is uv's own, is shared with the production plugin's `uvx` runtime, and
deleting from it would degrade production's warm cache, so it was left alone.

---

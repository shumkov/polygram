# Scoped memory U16a findings — G1 memsearch latency gate

Date: 2026-08-11

Status: **G1 re-run FAILS, 5/5, on the unchanged harness. Root cause identified
and demonstrated: the harness performs its concurrent writes in the same
Python process as the reader, which is not the production write scheduler.
No corrected run has been made.** A read-only provider-boundary check (§9)
recommends `onnx` and corrects an incorrect claim in this memo's first
revision; it is pending one approval and one VPS-side confirmation.
Sanitized spike evidence only. Not a production approval, and not a G1 pass.

Revision 2 (2026-08-11) adds §1 facts 11–14 and rewrites §7 and §9. The
measurements in §4 and the verdict in §5 are unchanged.

Scope of this memo: U16a only. No U21, U22, or application implementation work
was started.

---

## 1. Verified facts

Each of these was read or measured during this session, not assumed.

1. **The gate harness is byte-identical to the committed version.**
   `git diff HEAD -- scripts/spikes/memsearch-isolation` is empty at
   `HEAD = ee08b8613f44c071e1093a994a7fbe915e51ae21`
   (branch `feat/shumabit-scoped-memory`). SHA-256 of the harness files at
   run time:

   | File | SHA-256 |
   | --- | --- |
   | `gate.py` | `8cbf04a8d8a6b77934804fa114f14cf698477ea0aa935f85c6226a2b8288d4a9` |
   | `deployed_memsearch_adapter.py` | `9bb5fe8e7ed9d04f4b9d42bfe1d8704ef33dd020f13c2489839d29c6c4ba07f2` |
   | `run_gate.py` | `d4e11f72d79b5c05aea5ecc01120f34ffb8b8a7f621d462c91e67872f1088149` |
   | `fake_adapter.py` | `e760916636456f371837e7eaa69f929a55dca453f44e738219a5b78bf5c8cf45` |
   | `test_gate.py` | `e0abc4c4099bbfbf5eba9594fe19a97f7db65c4ca988979d0ea0bb735873f2af` |

2. **The gate's own oracle self-tests pass in this environment** — 8/8 in
   26.1 s against the non-authoritative fake adapter. The oracles still reject
   the injected faults they were written to catch.

3. **G1's thresholds are exactly as recorded** and were not touched:
   `GateThresholds(samples=40, max_concurrent_ratio=2.0,
   max_concurrent_p95_ms=1200.0)` (`gate.py:18-22`).

4. **The absolute budget is not the problem, by three orders of magnitude.**
   Concurrent p95 measured 19.1–20.7 ms against the 1200 ms ceiling.

5. **The relative ratio fails, consistently, on a second and different host.**
   Five unchanged runs gave 2.212 / 2.557 / 2.520 / 2.464 / 2.271 (all > 2.0).
   The U1 runs on the Linux host gave 1.898 / 2.311 / 2.365. The failure is
   therefore not host-specific and not a one-off.

6. **Milvus-Lite 3.1.1 runs entirely inside the calling Python process.** Its
   own `server_manager.py` docstring: *"Starts a gRPC server in a background
   thread… Unlike milvus-lite v1 (which spawns a ~200MB C++ subprocess), this
   runs entirely in-process as pure Python threads."* Two scopes mean two
   in-process servers in one interpreter, sharing one GIL.

7. **Every memsearch query is two Python-heavy steps.** `MemSearch.search`
   (`core.py:247-249`) awaits `self._embedder.embed([query])` and then calls
   `self._store.search(...)`. In this harness the embedder is an in-process
   loopback HTTP server implemented in Python, and the store is the in-process
   pure-Python Milvus-Lite. Both compete for the same GIL as any same-process
   writer.

8. **The gate's writer is a same-process `threading.Thread`**
   (`gate.py:80-99`), and it writes to a *different* scope than the reader
   queries (writer → `alpha`, reader → `beta`). Under `per-scope-file` those
   are different Milvus-Lite files, so **no storage-level contention exists in
   this measurement at all** — the only coupling between reader and writer is
   the Python process.

9. **The plan's production write path is a separate process, not a thread.**
   The publisher "drains staging on its own schedule under its own identity"
   from a root-owned unit (plan lines ~189-192, ~320-334, KTD3), while recall
   is served by the gateway over a Unix socket with a 2 s caller deadline.
   Reader and writer are never the same interpreter in the intended design.

10. **The production embedding boundary is not chosen anywhere in the plan.**
    Grepping `embedding` across the plan returns only descriptive statements
    and the U16a requirement itself; there is no decision record. The
    available providers are
    `openai / google / voyage / jina / mistral / ollama / local / onnx`, with
    defaults `text-embedding-3-small`, `all-MiniLM-L6-v2` (local) and
    `gpahal/bge-m3-onnx-int8` (onnx).

11. **The upstream plugin default is ONNX, and the plan's Verified fact 2 is
    correct.** Two statements shipped inside the installed 0.4.17 distribution
    say so directly:
    - `memsearch/embeddings/onnx.py` docstring: *"No API key needed. **Used as
      the default provider by the Claude Code plugin** for zero-config memory
      search. Default model is a pre-quantized int8 bge-m3 ONNX export."*
    - the packaged README (`METADATA`): *"Defaults to **ONNX bge-m3** — runs
      locally on CPU, no API key, no cost. On first launch the model (~558 MB)
      is downloaded from HuggingFace Hub"*, with
      `memsearch config set embedding.provider onnx  # default — local, free`.

    `EmbeddingConfig.provider = "openai"` (`config.py:57`) is the **dataclass
    fallback for the Python API when no config file exists** — one layer in the
    documented precedence *dataclass defaults → `~/.memsearch/config.toml` →
    `.memsearch.toml` → CLI flags* (`config.py:4`, README line 697). It is not
    the plugin's default. See §9 for the correction this forces on this memo.

12. **Shumabit pins no embedding configuration in any versioned source.**
    `shumabit-claude` (`main`, `5142c07`) enables the plugin in the tracked
    `.claude/settings.json` (`"memsearch@memsearch-plugins": true`) and commits
    no `config.toml`/`.memsearch.toml`; a tracked-tree grep for
    `embedding|onnx|OPENAI_API_KEY` returns only unrelated prose.
    `umi-vps-infra` (`main`, `3e6612b`) installs `uv` as "memsearch's uvx
    runtime", seeds the same plugin from `zilliztech/memsearch`, and states in
    the task comment that "the plugin caches + `~/.memsearch` data are seeded
    by the out-of-band transfer". No provider, model, extra, or API-key
    variable name appears anywhere in that repo.

13. **The effective live provider is therefore unversioned host state.** It
    would be in `~/.memsearch/config.toml` on the VPS. That file was not read:
    it is live host state, and this check was scoped to versioned and
    non-secret installed metadata. `~/.memsearch` does not exist on this Mac
    and the memsearch plugin is not installed here, so there is no local copy
    to inspect. Consequently: **which provider Shumabit runs today is not
    determinable from the evidence this check is allowed to use.** Only the
    upstream default (fact 11) and the absence of any override in versioned
    config (fact 12) are established.

14. **Shumabit's current store shape, from the committed
    `.memsearch/.index-state.json`** (metadata only; no memory body was read):
    `collection = ms_shumabit_claude_2f892669`,
    `milvus_uri = ~/.memsearch/milvus.db` — one unscoped store, matching the
    plan's Verified fact 1 — `paths = ["/home/shumabit/shumabit-claude/.memsearch/memory"]`,
    i.e. a **directory root**, which is the configuration U13 requires for
    record-level removal; `indexed_files = 103`, `status = ok`, last successful
    index `2026-07-28T05:36:28Z`.

---

## 2. Harness validity

**Valid and unchanged for reproduction purposes.** The harness reproduces the
recorded U1 failure faithfully; nothing about it was corrected before
measuring, so §4's numbers are directly comparable to the U1 table.

**But it does not currently measure what U16a asks it to measure.** Four
defects, in descending order of impact. None of them is a reason to weaken the
2× threshold; all of them are reasons the current number is not the number
G1 is about.

- **D1 — The write scheduler is wrong (load-bearing).** The concurrent writer
  is a thread inside the reader's interpreter. Given facts 6 and 7, this makes
  the measurement dominated by GIL queueing rather than by storage behaviour.
  The production write scheduler is a separate process (fact 9). This is the
  root cause; §5 demonstrates it.
- **D2 — The embedding boundary is a stub.** The loopback deterministic stub
  costs ~1 ms per query (§4.3). The boundary that preserves current plugin
  behaviour is `onnx` (§9): CPU-bound int8 bge-m3 inference inside whichever
  process runs it, per query on the reader and per chunk on the writer. That is
  not a rescaling of the stub — it moves the dominant cost into exactly the
  resource D1 shows the two processes compete for, on a VPS with far fewer
  cores than this Mac. Until the gate runs on that boundary, no run of it can
  be the authoritative U16a run.
- **D3 — The decision variable is noisy at n=40.** `_p95` is nearest-rank:
  `ordered[ceil(0.95·40) - 1]` = index 37 = the 3rd-largest of 40 samples. The
  gate then divides two such estimators. In the no-writer control (§5) the
  ratio of two *identical* workloads came out at **0.774**, so the estimator's
  own spread is roughly ±25 % — wide enough that a single measured 2.2 is not
  by itself decisive, even though five consecutive failures and the median
  ratio are.
- **D4 — The concurrency shape does not include the risky case.** Reader and
  writer never touch the same scope (fact 8), so the gate never exercises
  "publisher indexes scope X while the gateway recalls scope X". Given fact 6
  and U1's finding that two clients on one Milvus-Lite file fail
  deterministically, whether two *processes* may share one scope's `.db` is an
  open design question that this gate does not answer.

No correction was applied to the harness. The diagnostics in §5 live entirely
in a disposable scratch directory and *import* the unchanged `gate.py` p95
function and the unchanged adapter, so they share the gate's arithmetic.

---

## 3. Environment

| Item | Value |
| --- | --- |
| Host | `shumabook` (Ivan's Mac), Apple M1 Pro, 10 cores, 32 GiB |
| OS | macOS 26.6, build 25G72, arm64 |
| Python | 3.12.12 in a disposable `uv` ephemeral environment |
| uv | 0.11.32 |
| memsearch | **0.4.17** (gate pin, enforced by the adapter) |
| pymilvus | **3.0.1** |
| milvus-lite | 3.1.1 |
| numpy | 2.5.2 |
| Packages resolved | offline, from the existing local `uv` cache; no network fetch |
| Embeddings | loopback-only deterministic stub, in-process; no credential, no embedding network request |
| Repo | `polygram.codex-support-estimate`, branch `feat/shumabit-scoped-memory`, HEAD `ee08b86` |
| Host load during runs | 1-minute load average 7.6–15.0 from unrelated user workloads (rekordbox, other agent sessions, Telegram, Docker) |

**Environment deviation, stated plainly:** U1 ran on a production-class Linux
host; this re-run is on macOS/arm64, and the host was busy. Absolute latencies
are consequently much lower here (idle p95 ~8 ms vs U1's 35–44 ms) while the
ratio failure is worse. The busy host inflates tail variance, which is exactly
what D3 says the decision variable is sensitive to. This memo therefore treats
the *reproduction* and the *root-cause attribution* as its results, and does
not present any number here as a production-representative latency.

---

## 4. Raw measurements

### 4.1 Percentile method and sample counts

Unchanged from `gate.py`: nearest-rank p95, `sorted(v)[ceil(0.95·n) - 1]`.
With n = 40 that is the 38th of 40 sorted samples. Every run measures
**40 idle samples then 40 concurrent samples** of `adapter.search(scope,
query, k=10)` on scope `beta`, while the concurrent phase overlaps 40 `upsert`
calls into scope `alpha`. Across the five gate runs: **200 idle + 200
concurrent samples**. The diagnostics add 4 × (40 + 40) = **320 more samples**.

### 4.2 Unchanged G1 gate, five consecutive runs

Command (identical for each run; `NN` = 01…05):

```sh
MEMSEARCH_GATE_EXPECTED_VERSION=0.4.17 \
uv run --offline --no-project --python 3.12 --with 'memsearch==0.4.17' \
  python scripts/spikes/memsearch-isolation/run_gate.py \
    --adapter deployed_memsearch_adapter:create_adapter \
    --topology per-scope-file \
    --work-dir <scratch>/u16a/runNN \
    --output <scratch>/u16a/runNN.json
```

| Run | Idle p95 (ms) | Concurrent p95 (ms) | Ratio | ≤ 2.0? | ≤ 1200 ms? | Gate |
| --- | ---: | ---: | ---: | --- | --- | --- |
| 01 | 9.357 | 20.697 | **2.212** | fail | pass | FAIL |
| 02 | 7.606 | 19.449 | **2.557** | fail | pass | FAIL |
| 03 | 7.983 | 20.119 | **2.520** | fail | pass | FAIL |
| 04 | 7.738 | 19.069 | **2.464** | fail | pass | FAIL |
| 05 | 8.798 | 19.983 | **2.271** | fail | pass | FAIL |

Ratio min 2.212, median 2.464, mean 2.405, max 2.557. Every other check passed
in every run: `cross_scope_isolation`, `staged_sibling_excluded`,
`concurrent_query_write`, `per_collection_delete`, `rebuild_equivalence`;
`writer_errors = 0`, `cross_scope_results = 0`, `staged_results = 0`.
`authoritative: true`, `backend_version: memsearch=0.4.17;pymilvus=3.0.1`.
Each run exits 1 solely on `concurrent_latency`.

Wall time ≈ 69 s per run at ≈ 14 % of one core — the gate is not CPU-saturating.

### 4.3 Attribution diagnostics

Driver: a disposable script that imports the unchanged `_p95`, `_query_ms` and
`create_adapter`, and varies **only who performs the concurrent writes**.

```sh
MEMSEARCH_GATE_EXPECTED_VERSION=0.4.17 \
uv run --offline --no-project --python 3.12 --with 'memsearch==0.4.17' \
  python <scratch>/u16a/diag.py --mode <MODE> \
    --work-dir <scratch>/u16a/diag-<MODE> --samples 40 \
    --output <scratch>/u16a/diag-<MODE>.json
```

| Mode | What differs | Idle p95 | Conc. p95 | **Ratio p95** | Ratio median |
| --- | --- | ---: | ---: | ---: | ---: |
| `no-writer` | nobody writes (control) | 11.566 | 8.957 | **0.774** | 1.015 |
| `thread-writer` | writer thread, same process (= the gate) | 8.099 | 19.577 | **2.417** | 1.908 |
| `proc-writer` | writer in a **separate OS process** | 8.734 | 8.608 | **0.986** | 1.076 |
| `embed-probe` | raw loopback embedding call only, thread writer | 0.999 | 3.269 | **3.272** | 1.343 |

Supporting detail:

- `no-writer` max 11.917 idle / 11.378 concurrent — the second phase is not
  inherently slower, so there is no warm-up or drift artifact to explain away.
- `thread-writer` max 10.484 idle / 21.879 concurrent, median 7.343 → 14.014.
  The penalty is in the body of the distribution, not only the tail.
- `proc-writer`: the child process reported `writer_wall_ms = 577.6` for its 40
  upserts, while the reader's 40 samples take ≈ 300 ms — so **the write burst
  covered the entire measurement window**; the pass is not an artifact of the
  writer finishing early. Child exit code 0.
- `embed-probe`: the stub embedding costs ~1 ms of a ~7–8 ms query, yet its
  own ratio is 3.27× under a same-process writer. Both halves of a query
  degrade, which is the signature of process-level contention rather than of
  either component.

---

## 5. Verdict

**U16a: FAIL.**

- G1 relative threshold (concurrent p95 ≤ 2× idle p95): **FAIL**, 5/5 runs,
  ratios 2.212–2.557.
- G1 absolute threshold (concurrent p95 ≤ 1200 ms): **PASS** with ~60× margin
  (19.1–20.7 ms).
- All non-latency checks in the matrix: **PASS**, 5/5.

The 2× threshold was not weakened, averaged, or re-baselined, and the failing
runs are reported as failing.

**The `proc-writer` result is explicitly not a G1 pass.** It is a diagnostic:
it corrects one input (the write scheduler) while still using the stub
embedding boundary (D2), and it was measured on the wrong host class. It shows
where the failure comes from; it does not retire the gate.

---

## 6. Root cause

**Determinable, and demonstrated.** The concurrent-to-idle ratio failure is an
artifact of the harness executing the concurrent writer as a thread inside the
reader's Python interpreter.

The chain, each link separately evidenced above: Milvus-Lite 3.1.1 is pure
Python in-process (fact 6); every query is an in-process embedding call plus an
in-process store call (fact 7); the gate's writer is a same-process thread
(fact 8); so reader and writer serialize on one GIL even though they touch
different scopes and different files. Moving that writer — and nothing else —
into a separate OS process takes the ratio from 2.417 to **0.986** and the
concurrent p95 from 19.6 ms to 8.6 ms, i.e. concurrency becomes free. The
no-writer control rules out drift, and the embed-probe shows the degradation
is process-wide rather than localized to one component.

That same-process arrangement is not the production write scheduler. The plan
puts the publisher in its own root-owned unit under its own identity, with no
endpoint the recall path shares (fact 9). So the gate is currently failing on a
configuration the design does not intend to ship.

**What this does not license.** It does not license declaring G1 satisfied. Two
things stand in the way: the embedding boundary is unchosen (D2), and the
same-scope cross-process case is unexercised and possibly unsupported by
Milvus-Lite's embedded model (D4). It is also plausible that a corrected gate
still fails once a real embedding boundary is in place — a `local`/`onnx`
embedder is CPU-bound work that will contend on a small VPS in a way a 10-core
Mac hides.

---

## 7. Smallest next action

One approval, one bounded harness correction, one rerun. Nothing here has been
executed: this section is the plan, and it stops before any remote or live step.

1. **Approve pre-staging the ONNX model** (the only approval needed; §9). The
   boundary itself is settled by evidence rather than preference — `onnx` is
   upstream's plugin default (fact 11) and adds no credential. What needs your
   word is the one-time ~558 MB HuggingFace fetch of
   `gpahal/bge-m3-onnx-int8` plus the `memsearch[onnx]` extra
   (`onnxruntime`, `tokenizers`, `huggingface-hub`). I have downloaded and
   installed nothing.
2. **Correct only the concurrency driver** in the isolation gate: run the
   concurrent writer as a separate OS process, matching the publisher/gateway
   split, and record the writer's wall time so the overlap is proven rather
   than assumed. Do not touch `GateThresholds`, the oracles, or any other
   check. Roughly a 40-line change confined to `gate.py`'s writer plus the
   adapter's process entry point, with the existing 8 self-tests as the
   regression floor.
3. **Re-run on the production-class Linux host**, exactly as below.

### The corrected cross-process Linux rerun, exactly

Host: the UMI VPS, under the same procedure the U13 certified run established —
**not** an ad-hoc production-host run.

Preflight, fail-closed, before anything is started:

```sh
# split-topology + owner verification, then bot-busy gate: all three must be idle
systemctl --no-pager show shumabit umi-assistant water \
  -p LoadState -p ActiveState -p SubState -p MainPID -p InvocationID -p NRestarts
# require in_flight=0 for shumabit and umi-assistant, and Water healthz HTTP 200
```

Stage the model once, deliberately, outside the measured run (this is the step
gated by §9 item 1):

```sh
export HF_HOME=/private/mode-0700/u16a-gate/hf
uv run --no-project --python 3.12 --with 'memsearch[onnx]==0.4.17' \
  python -c "from memsearch.embeddings.onnx import OnnxEmbedding; OnnxEmbedding()"
# then pin the run offline so the gate itself makes no network call
export HF_HUB_OFFLINE=1
```

Run the corrected matrix inside a memory-bounded transient scope, five times:

```sh
for i in 01 02 03 04 05; do
  systemd-run --user --scope --quiet \
    -p MemoryMax=1G -p MemoryHigh=768M -p TasksMax=512 -p MemoryAccounting=yes \
    env MEMSEARCH_GATE_EXPECTED_VERSION=0.4.17 \
        MEMSEARCH_GATE_EMBEDDING=onnx \
        MEMSEARCH_GATE_WRITER=process \
        HF_HOME=/private/mode-0700/u16a-gate/hf HF_HUB_OFFLINE=1 \
    uv run --offline --no-project --python 3.12 --with 'memsearch[onnx]==0.4.17' \
      python scripts/spikes/memsearch-isolation/run_gate.py \
        --adapter deployed_memsearch_adapter:create_adapter \
        --topology per-scope-file \
        --work-dir /private/mode-0700/u16a-gate/run$i \
        --output   /private/mode-0700/u16a-gate/run$i.json
done
```

`MEMSEARCH_GATE_EMBEDDING` and `MEMSEARCH_GATE_WRITER` are the two selectors the
step-2 correction adds; both must appear in the emitted evidence alongside
`backend_version`, so a run can never be read without knowing which boundary and
which scheduler produced it. Unchanged: `--topology per-scope-file`, 40 idle +
40 concurrent samples per run, the nearest-rank p95, the 2× ratio, and the
1200 ms ceiling.

Pass condition, pre-registered: **all five runs** satisfy both thresholds. Not
the mean, not the best of five, and the writer wall time must cover each
measurement window (the overlap check step 2 adds). Post-run, repeat the U13
closure: owner `InvocationID`/`MainPID`/`NRestarts` byte-identical to the
pre-run capture, both bots still `in_flight=0`, work directory removed.

Two outcomes worth naming in advance, so neither is a surprise:

- **It may still fail.** `OnnxEmbedding` builds a default
  `ort.InferenceSession` with no `SessionOptions` (`embeddings/onnx.py`), so
  onnxruntime sizes its intra-op thread pool to the machine's cores. Two
  processes each doing that on a small VPS will oversubscribe CPU — the very
  thing D1 showed is decisive. memsearch exposes no thread-count knob, so
  containing it would mean `OMP_NUM_THREADS`/ORT environment control or an
  upstream change, and that is a U16 design decision, not a threshold change.
- **The absolute budget stops being free.** int8 bge-m3 inference per query is
  orders of magnitude above the stub's ~1 ms, so the 1200 ms ceiling — which
  has never been in play (§4.2) — becomes a real constraint for the first time,
  alongside the 2 s recall deadline in KTD3.

Deferred, not silently dropped: **D4** — whether the publisher process and the
recall gateway may open the same scope's Milvus-Lite file concurrently. That
question belongs to U16's storage design; if the answer is no, U16's publisher
must route index mutations through the gateway process, which changes U16's
shape and would need its own estimate.

---

## 8. Changed files, and what was not touched

Changed in the repository — **this document only**:

- `docs/2026-08-11-u16a-memsearch-latency-findings.md` (new).

Everything else was left alone, explicitly:

- No application code, no `lib/`, no `polygram.js`, no migrations, no tests.
- The gate harness under `scripts/spikes/memsearch-isolation/` is byte-identical
  to `HEAD` (fact 1) — verified again after the runs.
- The main plan `docs/plans/2026-07-31-002-feat-shumabit-scoped-memory-plan.md`
  was read only; its pre-existing uncommitted edits are untouched, as are the
  other pre-existing untracked files
  (`docs/2026-08-06-u13-findings.md`, the two untracked plan drafts,
  `scripts/spikes/memsearch-deletion/`). A U21 findings file
  (`docs/2026-08-11-u21-scoped-memory-plugin-integration-findings.md`)
  appeared in the tree from a concurrent session during this work; it was
  neither read nor modified here.
- Nothing was committed, pushed, deployed, restarted, or posted.
- No production configuration, service, Telegram chat, VPS state, credential,
  or real memory/transcript content was read or written. All runs used
  synthetic fixture strings (`gate-alpha`, `gate-beta`, `gate-concurrent-N`)
  in mode-0700 scratch directories outside the repository.
- No credential and no embedding network request: the deterministic stub is
  bound to `127.0.0.1` on an ephemeral port. Packages resolved offline from the
  existing local cache.
- The §9 provider check was **read-only and local**. It read: this repo's plan
  and spike files; `shumabit-claude` `.claude/settings.json`, `.gitignore`, git
  log/grep over the tracked tree, and metadata-only fields of the committed
  `.memsearch/.index-state.json`; `umi-vps-infra` git grep and one task-file
  excerpt; and the already-cached `memsearch==0.4.17` distribution metadata and
  sources. Both of those repos were left untouched — no file written, nothing
  staged or committed, no branch or checkout changed. Excluded on purpose:
  every `.memsearch/memory/*.md` body, every credential value, and all VPS and
  service state.
- sccache was not started, stopped, or otherwise touched.
- Resource use was bounded: one gate process at a time, ≈14 % of one core,
  ≈69 s per run; no parallel fan-out, no host-saturating load.
- Temporary artifacts removed after the runs: all scratch work directories and
  Milvus-Lite files, and the `__pycache__` directory the runs created under
  `scripts/spikes/memsearch-isolation/`. Every measurement is transcribed into
  §4, so nothing outside this document needs to survive.

---

## 9. Provider boundary — correction, recommendation, one approval

### 9.1 Correcting this memo

An earlier revision of §1 fact 10 and §9 stated that memsearch's default
provider is `openai` and that this **contradicts** the plan's Verified fact 2
("Both use local ONNX embeddings by default"). That was wrong, and it was wrong
in a way that would have mattered: it framed a settled upstream default as an
open contradiction, and it put a credentialed remote boundary on the menu as if
it matched current behaviour.

The mistake was conflating two layers. `EmbeddingConfig.provider = "openai"`
(`config.py:57`) is the dataclass fallback for the Python API when no config
file exists — the first rung of *dataclass defaults →
`~/.memsearch/config.toml` → `.memsearch.toml` → CLI flags*. The plugins do not
ride that rung. The installed distribution says so in two places (fact 11), and
`embeddings/onnx.py` is explicit: ONNX is *"used as the default provider by the
Claude Code plugin"*. **The plan's Verified fact 2 is correct as written and
needs no amendment.**

The one true residue of the old claim: the spike adapter drives the *library*
API, so it inherits the `openai` rung unless it passes a provider explicitly —
which is exactly why the current adapter names one, and why the corrected gate
must name `onnx` rather than rely on any default.

### 9.2 What is actually in use today — honestly, unresolved

Not determinable from the evidence this check was scoped to. Versioned config
in both `shumabit-claude` and `umi-vps-infra` pins no provider, model, extra, or
key-variable name (fact 12), and ansible states that `~/.memsearch` was seeded
out-of-band, so the effective setting lives in unversioned host state on the
VPS (fact 13). I did not read it. The last successful index of the live store
was 2026-07-28 (fact 14), so *something* embedded successfully — but that is
equally consistent with the ONNX default and with a host-level override.

Resolving it is one read-only command, deferred until you authorize a VPS read:

```sh
# read-only; prints provider/model names, not key values
memsearch config get embedding.provider
memsearch config get embedding.model
```

If that returns anything other than `onnx`, the recommendation below changes and
this memo needs a further amendment — a boundary the gate measures must be the
boundary production runs, not the one upstream ships.

### 9.3 Recommendation: `onnx`, `gpahal/bge-m3-onnx-int8`

The no-new-credential boundary that best preserves current plugin behaviour.

- **No new credential, no per-query egress.** Recall content never leaves the
  host. `openai` would require a new secret, put memory text on the wire, and
  add RTT inside both the 1200 ms budget and KTD3's 2 s recall deadline.
- **It is what the plugin already does by default** (fact 11), so a gate run on
  it measures Shumabit's behaviour rather than a substitute — subject to §9.2.
- **`local`** (`all-MiniLM-L6-v2`) is the same shape with a heavier dependency
  tree and a different model, so it would measure something Shumabit does not
  run. **`ollama`** is excluded by your instruction and would in any case add a
  new always-on service to the VPS.

The honest cost, stated rather than buried: ~558 MB fetched once from
HuggingFace, the `memsearch[onnx]` extra, and CPU-bound int8 inference per
recall on the same VPS as both bots. §7 explains why that last point may well
make the corrected gate fail — which would be a real finding about the design,
not a harness defect.

### 9.4 The one approval I need

Permission to pre-stage `gpahal/bge-m3-onnx-int8` and install
`memsearch[onnx]==0.4.17` into a disposable mode-0700 directory on the gate
host, so the measured run itself is offline (`HF_HUB_OFFLINE=1`).

Nothing was downloaded, installed, started, or contacted for this check: it read
only versioned repository files and already-cached package metadata on this Mac.
No VPS was reached, no credential value read, and no memory body opened — the
`.memsearch/memory/*.md` files in `shumabit-claude` were deliberately excluded
from every grep and read.

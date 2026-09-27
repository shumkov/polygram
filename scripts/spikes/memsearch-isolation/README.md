# Scoped memsearch isolation gate

This gate exercises the safety matrix against one Milvus-Lite file per scope
(`per-scope-file`). The alternative — multiple collections in one file
(`shared-file`) — is refused with the only supported writer; see "What the gate
refuses to run".

It requires zero cross-scope and staged-record results, independent collection
deletion, rebuild equivalence, safe concurrent write/query, concurrent query
p95 no more than 2× idle p95, and absolute concurrent p95 no more than 1200 ms.
It additionally requires that the concurrent writer was demonstrably running
across the measured window, that shared-scope access between two processes is
classified rather than assumed, and that the run names the embedding boundary
that produced it.

## Two inputs every run must state

Neither has a safe default, so both are required and both appear in the emitted
evidence:

- `--writer` / `MEMSEARCH_GATE_WRITER` — `process`, the only supported
  scheduler. A same-interpreter writer was removed: a thread blocked in backend
  I/O cannot be cancelled, so it could still be writing after the gate reported.
- `MEMSEARCH_GATE_EMBEDDING` — `onnx` or `loopback-stub`. Only `onnx` is the
  production boundary; a `loopback-stub` run is stamped
  `production_class: false` and prints a loud banner naming what is unmet.
  `--require-production-class` makes such a run exit non-zero.

The writer signals ready only after its first write has succeeded and keeps
writing until the reader stops it, revising each record body on repeat passes —
memsearch skips embedding a chunk whose content hash it already holds, so a
writer repeating identical text would look busy and store nothing. The evidence
carries the writer's own `CLOCK_MONOTONIC` window, its pid, the chunks it
indexed, and whether it covered the measured window. Writer evidence that is
missing, malformed, failed, from another process, or non-covering sinks the
latency verdict instead of leaving it scored.

## What the gate refuses to run

- **`shared-file` with a separate-process writer**, in both the library
  (`check_writer_topology`, `run_topology`, `run_matrix`) and the CLI. The
  writer would have to open the storage file the reader holds, which measures a
  collision rather than a latency; the same-scope check below answers that
  question deliberately, on its own scope. `per-scope-file` is the only default.
- **An empty topology set**, which would otherwise report `PASS` having measured
  nothing.

## Production-class qualification

`production_class` is true only when every one of these holds, and any run that
is not production-class cannot be presented as a G1 result:

| Requirement | Why |
| --- | --- |
| `linux_host` | the production host class, not a developer Mac |
| `process_writer` | the production publication shape |
| `exact_production_samples` | the registered 40+40 sample count |
| `production_embedding_boundary` | the real provider, never the stub |
| `authoritative_adapter` | a real backend, never the fake |
| `multi_writer_design_compatible` | the shared-scope access the publisher/gateway split needs is actually served |

Even then, one production-class run is not a G1 pass: G1 requires five
consecutive production-class runs in the U16a piece D Linux matrix, which this
harness does not attempt and does not claim.

## Running it

The bundled fake proves only that these oracles fail when injected faults are
present, and that the cross-process writer protocol works. It is explicitly
non-authoritative and never production-class:

```sh
python3 -m unittest discover -s scripts/spikes/memsearch-isolation -p 'test_*.py'
python3 scripts/spikes/memsearch-isolation/run_gate.py --writer process
```

The bundled real adapter uses the installed memsearch/Milvus-Lite package. With
`MEMSEARCH_GATE_EMBEDDING=loopback-stub` it uses a loopback-only deterministic
OpenAI-compatible embedding stub and never needs an API credential or embedding
network request; with `onnx` it uses the provider the plugin defaults to, whose
model must be pre-staged out of band so the measured run stays offline:

```sh
MEMSEARCH_GATE_EXPECTED_VERSION=0.4.17 \
MEMSEARCH_GATE_EMBEDDING=onnx \
MEMSEARCH_GATE_WRITER=process \
HF_HUB_OFFLINE=1 \
python3 scripts/spikes/memsearch-isolation/run_gate.py \
  --adapter deployed_memsearch_adapter:create_adapter \
  --topology per-scope-file \
  --require-production-class \
  --work-dir /absolute/mode-0700/gate-directory \
  --output /absolute/private/sanitized-result.json
```

Run it from the environment that contains the exact expected memsearch package.
The adapter records both memsearch and pymilvus versions and refuses a mismatch.
The loopback embeddings test storage behavior only, not semantic quality, and
never a production latency.

Another authoritative adapter may also be supplied as `module:function`.

The factory receives `topology` and `work_dir` and returns an object with:

- identity fields `name`, `backend_version`, and `authoritative = True`;
- `embedding_descriptor` with `selector`, `provider`, `model`, and
  `production_boundary`;
- `write_source(scope, record_id, text, staged=False)`;
- `rebuild(scope)`;
- `upsert(scope, record_id, text)`, optionally returning the number of chunks
  it actually indexed;
- `search(scope, query, k)` returning records with stable `id` fields;
- `delete_collection(scope)`;
- `release_scope(scope)` dropping this process's handle without touching files;
- `start_writer_process(scope, prefix, text_prefix, count, control_dir,
  deadline_s)` returning a `writer_process.WriterProcessHandle`;
- optional `set_concurrent_probe(enabled)` for deterministic test doubles.

The last three are required for `--writer process` and for the shared-scope
classification; an adapter without them fails those checks rather than skipping
them.

## The shared-scope classification

The check writes a scope from one process while another reads it, on its own
scope and record ids, bounded by five writes, five reads, one single-write
control process, and the writer timeouts. Two answers complete it:

- `supported` — the access worked and every written record is visible. Only this
  sets `design_compatible`.
- `unsupported-clean` — the backend refused it outright, and that is proven:
  zero writer operations, no partial record left behind, no reader error, the
  pre-existing record still visible, and a control writer that succeeds on the
  same scope once the reader releases it. Without that control the failure is
  indistinguishable from a broken backend and the answer is
  `inconclusive-ambiguous-error`.

Everything else is `unsafe-*` (accepted then lost, hid, or half-wrote data, or
damaged the reader) or `inconclusive-*`, and neither completes the check.

Use sanitized fixtures only. Do not point the work directory or adapter at an
existing source tree, collection, index, or production database. The real run
must record the exact memsearch and Milvus-Lite versions; a fake `PASS` or a
`loopback-stub` run does not satisfy U1 or G1.

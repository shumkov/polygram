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

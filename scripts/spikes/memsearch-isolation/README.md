# Scoped memsearch isolation gate

This gate exercises the same safety matrix against both supported storage
topologies:

- multiple collections in one Milvus-Lite file (`shared-file`);
- one Milvus-Lite file per scope (`per-scope-file`).

It requires zero cross-scope and staged-record results, independent collection
deletion, rebuild equivalence, safe concurrent write/query, concurrent query
p95 no more than 2× idle p95, and absolute concurrent p95 no more than 1200 ms.

The bundled fake proves only that these oracles fail when injected faults are
present. It is explicitly non-authoritative:

```sh
python3 -m unittest discover -s scripts/spikes/memsearch-isolation -p 'test_*.py'
python3 scripts/spikes/memsearch-isolation/run_gate.py
```

An authoritative release gate supplies an adapter factory as
`module:function`:

```sh
python3 scripts/spikes/memsearch-isolation/run_gate.py \
  --adapter deployed_memsearch_adapter:create_adapter \
  --work-dir /absolute/mode-0700/gate-directory \
  --output /absolute/private/sanitized-result.json
```

The factory receives `topology` and `work_dir` and returns an object with:

- identity fields `name`, `backend_version`, and `authoritative = True`;
- `write_source(scope, record_id, text, staged=False)`;
- `rebuild(scope)`;
- `upsert(scope, record_id, text)`;
- `search(scope, query, k)` returning records with stable `id` fields;
- `delete_collection(scope)`;
- optional `set_concurrent_probe(enabled)` for deterministic test doubles.

Use sanitized fixtures only. Do not point the work directory or adapter at an
existing source tree, collection, index, or production database. The real run
must record the exact memsearch and Milvus-Lite versions; a fake `PASS` does not
satisfy U1 or G1.

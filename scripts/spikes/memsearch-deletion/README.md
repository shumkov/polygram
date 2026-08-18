# Scoped memory deletion-mechanism gate

Selects the removal mechanism the operator redaction runbook must document:

- **record-level removal** — delete one Markdown source, run the public rebuild;
- **scope-level rebuild fallback** — relocate the scope's Markdown, rebuild the
  scope from empty, restore the survivors.

Every phase uses documented `MemSearch` calls only. `PublicSurface` holds the
instance in a closure behind `__getattribute__`, `__slots__`, and guarded
`__setattr__`/`__delattr__`, so only `{index, search, close}` resolve and
`store.drop()` cannot be reached through the wrapper by attribute, mangled name,
`vars()`, or `__dict__`.

## What the oracles require

Negative recall establishes none of these on its own, so each is checked:

- **Attribution** — the target must still be retrievable after its source is
  deleted but *before* the rebuild. A backend that merely hides results whose
  source file vanished removes nothing and must not pass.
- **Anti-vacuity** — the target is retrievable before removal, and the surviving
  siblings after it, so a scope that returns nothing fails.
- **Containment** — every other scope survives each rebuild, so a rebuild that
  damages another principal's scope cannot pass.
- **Durability** — the result survives closing and reopening the store.
- **Non-saturated window** — absence counts only while the result window is
  larger than the scope, so it cannot be a top-k artifact.

## Precondition this gate pins

Record-level removal only works when a scope is configured with a **directory**
root. With explicit file paths a rebuild is a partial update and the deleted
record stays searchable. The `file-paths-precondition` phase characterizes that
and the emitted evidence carries a configuration fingerprint, so the mechanism
cannot be read without the condition it depends on.

## Running it

The bundled fake proves only that the oracles fail when faults are injected. A
fake `PASS` is not evidence about memsearch, so a non-authoritative run exits
non-zero unless you opt in:

```sh
python3 -m unittest discover -s scripts/spikes/memsearch-deletion -p 'test_*.py'
python3 scripts/spikes/memsearch-deletion/run_gate.py \
  --adapter fake_adapter:create_adapter --allow-non-authoritative
```

The authoritative run uses the installed memsearch/Milvus-Lite package and a
loopback-only deterministic embedding stub. It needs no credential; proxy
environment variables are cleared because httpx would otherwise route even a
loopback URL through a proxy, and the served-request counter in the evidence is
the positive proof that the embeddings were answered locally:

```sh
MEMSEARCH_GATE_EXPECTED_VERSION=0.4.17 \
uv run --offline --with memsearch==0.4.17 python run_gate.py \
  --adapter deployed_adapter:create_adapter \
  --work-dir /absolute/empty/mode-0700/directory \
  --output /absolute/private/sanitized-result.json
```

Omitting `--work-dir` uses an owned temporary directory. An existing one must be
an absolute, empty, non-symlink directory with mode 0700; the runner creates
0700 and sets a 0077 umask so fixtures, index files and the artifact stay
owner-only.

Run it from the environment holding the exact expected memsearch package; the
adapter records both memsearch and pymilvus versions and refuses a mismatch. The
loopback embeddings measure storage and removal behaviour only — they make no
claim about semantic quality or production embedding latency.

**On a host that also runs production services**, run it inside a memory-bounded
transient scope and only after checking that no bot is busy. The gate is small
(order 200 MiB, seconds) but it is not worth an incident.

Use sanitized fixtures only. Never point the work directory or adapter at an
existing source tree, collection, index, or production database.

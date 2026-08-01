"""Sanitized in-memory adapter for testing the gate itself."""

from __future__ import annotations

import time
from collections import defaultdict
from pathlib import Path


class FakeAdapter:
    name = "sanitized-fake"
    backend_version = "not-a-real-backend"
    authoritative = False

    def __init__(self, *, topology: str, work_dir: Path, faults: set[str] | None = None):
        self.topology = topology
        self.work_dir = work_dir
        self.faults = faults or set()
        self.sources: dict[str, dict[str, str]] = defaultdict(dict)
        self.staged: dict[str, dict[str, str]] = defaultdict(dict)
        self.indexes: dict[str, dict[str, str]] = defaultdict(dict)
        self.concurrent_probe = False

    def write_source(self, scope: str, record_id: str, text: str, *, staged: bool = False) -> None:
        target = self.staged if staged else self.sources
        target[scope][record_id] = text

    def rebuild(self, scope: str) -> None:
        records = dict(self.sources[scope])
        if "index_staged" in self.faults:
            records.update(self.staged[scope])
        self.indexes[scope] = records

    def upsert(self, scope: str, record_id: str, text: str) -> None:
        self.sources[scope][record_id] = text
        self.indexes[scope][record_id] = text

    def search(self, scope: str, query: str, *, k: int) -> list[dict[str, str]]:
        # Keep dry-run latency ratios deterministic; sub-millisecond interpreter
        # noise would otherwise dominate the ratio oracle.
        time.sleep(0.01)
        if self.concurrent_probe and "slow_concurrent_query" in self.faults:
            time.sleep(0.02)
        indexes = self.indexes.values() if "cross_scope_leak" in self.faults else [self.indexes[scope]]
        matches = []
        for index in indexes:
            for record_id, text in index.items():
                if query in text:
                    matches.append({"id": record_id, "text": text})
        return sorted(matches, key=lambda record: record["id"])[:k]

    def delete_collection(self, scope: str) -> None:
        self.indexes.pop(scope, None)
        if "delete_sibling" in self.faults:
            self.indexes.clear()

    def set_concurrent_probe(self, enabled: bool) -> None:
        self.concurrent_probe = enabled


def create_adapter(*, topology: str, work_dir: Path, faults: set[str] | None = None) -> FakeAdapter:
    if topology not in {"shared-file", "per-scope-file"}:
        raise ValueError(f"unsupported topology: {topology}")
    return FakeAdapter(topology=topology, work_dir=work_dir, faults=faults)

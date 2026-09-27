"""Sanitized in-memory adapter for testing the gate itself.

Records written by a separate-process writer live on disk under the work
directory, so the fake exercises the real cross-process writer protocol. It
proves the gate's oracles and that protocol only — it answers nothing about
whether the deployed backend tolerates shared-scope access.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from collections import defaultdict
from pathlib import Path

from writer_process import WriterProcessHandle, run_child_writer


class FakeAdapter:
    name = "sanitized-fake"
    backend_version = "not-a-real-backend"
    authoritative = False
    embedding_descriptor = {
        "selector": "sanitized-fake",
        "provider": "none",
        "model": "none",
        "production_boundary": False,
    }

    def __init__(self, *, topology: str, work_dir: Path, faults: set[str] | None = None):
        self.topology = topology
        self.work_dir = Path(work_dir)
        self.faults = faults or set()
        self.sources: dict[str, dict[str, str]] = defaultdict(dict)
        self.staged: dict[str, dict[str, str]] = defaultdict(dict)
        self.indexes: dict[str, dict[str, str]] = defaultdict(dict)
        self.dropped: set[str] = set()
        self.concurrent_probe = False
        self.after_delete = False

    def _process_records_dir(self, scope: str) -> Path:
        return self.work_dir / "process-records" / scope

    def _process_records(self, scope: str) -> dict[str, str]:
        if scope in self.dropped:
            return {}
        directory = self._process_records_dir(scope)
        if not directory.is_dir():
            return {}
        return {
            path.stem: path.read_text(encoding="utf-8")
            for path in sorted(directory.glob("*.txt"))
        }

    def write_source(self, scope: str, record_id: str, text: str, *, staged: bool = False) -> None:
        target = self.staged if staged else self.sources
        target[scope][record_id] = text

    def rebuild(self, scope: str) -> None:
        self.dropped.discard(scope)
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
        if "cross_scope_leak" in self.faults:
            scopes = sorted(set(self.indexes) | {scope})
        else:
            scopes = [scope]
        matches = []
        for candidate in scopes:
            index = dict(self.indexes[candidate])
            index.update(self._process_records(candidate))
            for record_id, text in index.items():
                if query in text or (
                    "unstable_tie_window" in self.faults
                    and query == "gate-alpha"
                    and scope == "alpha"
                ):
                    matches.append({"id": record_id, "text": text})
        ordered = sorted(
            matches,
            key=lambda record: record["id"],
            reverse=("unstable_tie_window" in self.faults and self.after_delete),
        )
        if "unstable_tie_window" in self.faults and query == "gate-alpha":
            sentinel = [record for record in ordered if record["id"] == "alpha-sentinel"]
            others = [record for record in ordered if record["id"] != "alpha-sentinel"]
            return (sentinel + others)[:k]
        return ordered[:k]

    def delete_collection(self, scope: str) -> None:
        self.indexes.pop(scope, None)
        self.dropped.add(scope)
        self.after_delete = True
        if "delete_sibling" in self.faults:
            self.indexes.clear()

    def release_scope(self, scope: str) -> None:
        # Every search re-reads the process-writer records, so this adapter holds
        # no per-scope handle to release.
        return

    def _fail_after(self, prefix: str) -> int:
        """Injected writer failures, so the shared-scope rules can be tested.

        The shared-scope check proves an exclusive-open refusal by running a
        control writer on the released scope, so a fault has to be able to hit
        the probing writer alone (`sameproc-`) or both it and the control.
        """

        probing = prefix == "sameproc-"
        if "same_scope_refusal" in self.faults and probing:
            return 0
        if "same_scope_broken" in self.faults and prefix.startswith("sameproc"):
            return 0
        if "same_scope_partial_write" in self.faults and probing:
            return 1
        if "concurrent_writer_dies" in self.faults and prefix == "concurrent-":
            return 2
        return -1

    def start_writer_process(
        self,
        *,
        scope: str,
        prefix: str,
        text_prefix: str,
        count: int,
        control_dir: Path,
        deadline_s: float,
    ) -> WriterProcessHandle:
        argv = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--child-writer",
            "--records-dir",
            str(self._process_records_dir(scope)),
            "--control-dir",
            str(control_dir),
            "--prefix",
            prefix,
            "--text-prefix",
            text_prefix,
            "--count",
            str(count),
            "--deadline-s",
            str(deadline_s),
            "--fail-after",
            str(self._fail_after(prefix)),
        ]
        return WriterProcessHandle(argv=argv, control_dir=Path(control_dir))

    def set_concurrent_probe(self, enabled: bool) -> None:
        self.concurrent_probe = enabled

    def close(self) -> None:
        shutil.rmtree(self.work_dir / "process-records", ignore_errors=True)


def create_adapter(*, topology: str, work_dir: Path, faults: set[str] | None = None) -> FakeAdapter:
    if topology not in {"shared-file", "per-scope-file"}:
        raise ValueError(f"unsupported topology: {topology}")
    return FakeAdapter(topology=topology, work_dir=work_dir, faults=faults)


def _child_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child-writer", action="store_true", required=True)
    parser.add_argument("--records-dir", type=Path, required=True)
    parser.add_argument("--control-dir", type=Path, required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--text-prefix", required=True)
    parser.add_argument("--count", type=int, required=True)
    parser.add_argument("--deadline-s", type=float, required=True)
    parser.add_argument("--fail-after", type=int, default=-1)
    args = parser.parse_args(argv)

    args.records_dir.mkdir(parents=True, exist_ok=True)
    written = 0

    def upsert(record_id: str, text: str) -> None:
        nonlocal written
        if args.fail_after >= 0 and written >= args.fail_after:
            raise RuntimeError(f"injected writer fault at {args.records_dir}")
        (args.records_dir / f"{record_id}.txt").write_text(text, encoding="utf-8")
        written += 1

    return run_child_writer(
        control_dir=args.control_dir,
        count=args.count,
        prefix=args.prefix,
        text_prefix=args.text_prefix,
        upsert=upsert,
        deadline_s=args.deadline_s,
    )


if __name__ == "__main__":
    raise SystemExit(_child_main())

"""Contract tests for the sanitized memsearch isolation gate harness."""

from __future__ import annotations

import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from unittest import mock

from fake_adapter import create_adapter
from gate import GateThresholds, run_matrix, run_topology
import run_gate


class MemsearchIsolationGateTests(unittest.TestCase):
    def test_dry_adapter_passes_the_same_matrix_for_both_topologies(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = run_matrix(
                adapter_factory=create_adapter,
                work_dir=Path(tmp),
                topologies=("shared-file", "per-scope-file"),
                thresholds=GateThresholds(samples=12, max_concurrent_p95_ms=1200),
            )

        self.assertEqual("PASS", evidence["status"])
        self.assertEqual(
            ["shared-file", "per-scope-file"],
            [result["topology"] for result in evidence["topologies"]],
        )
        self.assertTrue(all(result["status"] == "PASS" for result in evidence["topologies"]))

    def test_cross_scope_result_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = run_topology(
                adapter=create_adapter(
                    topology="shared-file",
                    work_dir=Path(tmp),
                    faults={"cross_scope_leak"},
                ),
                topology="shared-file",
                thresholds=GateThresholds(samples=8),
            )

        self.assertEqual("FAIL", evidence["status"])
        self.assertFalse(evidence["checks"]["cross_scope_isolation"])
        self.assertGreater(evidence["counts"]["cross_scope_results"], 0)

    def test_staged_sibling_result_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = run_topology(
                adapter=create_adapter(
                    topology="per-scope-file",
                    work_dir=Path(tmp),
                    faults={"index_staged"},
                ),
                topology="per-scope-file",
                thresholds=GateThresholds(samples=8),
            )

        self.assertEqual("FAIL", evidence["status"])
        self.assertFalse(evidence["checks"]["staged_sibling_excluded"])

    def test_concurrent_latency_must_pass_ratio_and_absolute_limits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = run_topology(
                adapter=create_adapter(
                    topology="shared-file",
                    work_dir=Path(tmp),
                    faults={"slow_concurrent_query"},
                ),
                topology="shared-file",
                thresholds=GateThresholds(
                    samples=8,
                    max_concurrent_ratio=2.0,
                    max_concurrent_p95_ms=5,
                ),
            )

        self.assertEqual("FAIL", evidence["status"])
        self.assertFalse(evidence["checks"]["concurrent_latency"])
        self.assertGreater(evidence["metrics_ms"]["concurrent_query_p95"], 5)

    def test_delete_and_rebuild_oracles_are_independent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = run_topology(
                adapter=create_adapter(
                    topology="shared-file",
                    work_dir=Path(tmp),
                    faults={"delete_sibling"},
                ),
                topology="shared-file",
                thresholds=GateThresholds(samples=8),
            )

        self.assertEqual("FAIL", evidence["status"])
        self.assertFalse(evidence["checks"]["per_collection_delete"])
        self.assertTrue(evidence["checks"]["rebuild_equivalence"])

    def test_runner_refuses_to_repurpose_an_existing_non_private_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "existing"
            path.mkdir(mode=0o755)
            with mock.patch("sys.argv", ["run_gate.py", "--work-dir", str(path)]):
                with redirect_stderr(StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        run_gate.main()

        self.assertEqual(2, raised.exception.code)


if __name__ == "__main__":
    unittest.main()

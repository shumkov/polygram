"""Contract tests for the sanitized memsearch isolation gate harness."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

from fake_adapter import FakeAdapter, create_adapter
from gate import (
    SAFE_SAME_SCOPE_CLASSIFICATIONS,
    WRITER_MODES,
    GateThresholds,
    ReaderWindow,
    WriterTimeouts,
    build_writer_evidence,
    check_writer_topology,
    classify_same_scope_access,
    evaluate_thresholds,
    run_matrix,
    run_same_scope_cross_process,
    run_topology,
    validate_writer_evidence,
)
import run_gate
from deployed_memsearch_adapter import deterministic_embedding
from writer_process import (
    WriterProcessHandle,
    WriterProtocolError,
    run_writer_loop,
    sanitize_error,
)


PROBE_TIMEOUTS = WriterTimeouts(ready_s=60.0, join_s=60.0, deadline_s=60.0)


def _sound_writer_evidence(**overrides):
    evidence = {
        "mode": "process",
        "ops": 57,
        "distinct_ids": 8,
        "first_op_start_ms": 1_000.0,
        "last_op_end_ms": 2_000.0,
        "wall_ms": 1_100.0,
        "error_code": None,
        "exit_code": 0,
        "pid": os.getpid() + 1,
    }
    evidence.update(overrides)
    return evidence


def _reader_window(start=1_000.0, last_sample_start=1_900.0, end=2_000.0) -> ReaderWindow:
    return ReaderWindow(start, last_sample_start, end)


def _same_scope_inputs(**overrides):
    base = {
        "protocol_error": None,
        "invalid_reason": None,
        "child_error_code": None,
        "child_exit_code": 0,
        "child_ops": 5,
        "reader_error_codes": [],
        "sentinel_before": True,
        "sentinel_after": True,
        "visible_ids": ["sameproc-0"],
        "expected_ids": ["sameproc-0"],
        "refusal_proof": None,
    }
    base.update(overrides)
    return base


def _run_fake_topology(tmp, *, faults=None, thresholds=None, adapter=None):
    return run_topology(
        adapter=adapter
        or create_adapter(topology="per-scope-file", work_dir=Path(tmp), faults=faults),
        topology="per-scope-file",
        thresholds=thresholds or GateThresholds(samples=8),
        writer_mode="process",
        control_dir=Path(tmp) / "control",
        timeouts=PROBE_TIMEOUTS,
    )


class MemsearchIsolationGateTests(unittest.TestCase):
    def test_dry_adapter_passes_the_matrix_for_the_supported_topology(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = run_matrix(
                adapter_factory=create_adapter,
                work_dir=Path(tmp),
                topologies=("per-scope-file",),
                thresholds=GateThresholds(samples=12, max_concurrent_p95_ms=1200),
                writer_mode="process",
                timeouts=PROBE_TIMEOUTS,
            )

        self.assertEqual("PASS", evidence["status"])
        self.assertEqual(["per-scope-file"], [r["topology"] for r in evidence["topologies"]])
        self.assertIn("five consecutive", evidence["g1_qualification"])

    def test_cross_scope_result_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(tmp, faults={"cross_scope_leak"})

        self.assertEqual("FAIL", evidence["status"])
        self.assertFalse(evidence["checks"]["cross_scope_isolation"])
        self.assertGreater(evidence["counts"]["cross_scope_results"], 0)

    def test_staged_sibling_result_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(tmp, faults={"index_staged"})

        self.assertEqual("FAIL", evidence["status"])
        self.assertFalse(evidence["checks"]["staged_sibling_excluded"])

    def test_delete_and_rebuild_oracles_are_independent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(tmp, faults={"delete_sibling"})

        self.assertEqual("FAIL", evidence["status"])
        self.assertFalse(evidence["checks"]["per_collection_delete"])
        self.assertTrue(evidence["checks"]["rebuild_equivalence"])

    def test_rebuild_accepts_a_changed_tie_window_when_every_record_is_recoverable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(
                tmp,
                faults={"unstable_tie_window"},
                thresholds=GateThresholds(samples=12),
            )

        self.assertEqual("PASS", evidence["status"])
        self.assertTrue(evidence["checks"]["rebuild_equivalence"])

    def test_runner_refuses_to_repurpose_an_existing_non_private_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "existing"
            path.mkdir(mode=0o755)
            argv = ["run_gate.py", "--writer", "process", "--work-dir", str(path)]
            with mock.patch("sys.argv", argv):
                with redirect_stderr(StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        run_gate.main()

        self.assertEqual(2, raised.exception.code)

    def test_loopback_embedding_is_deterministic_and_normalized(self) -> None:
        first = deterministic_embedding("gate alpha", dimension=32)
        repeated = deterministic_embedding("gate alpha", dimension=32)
        other = deterministic_embedding("gate beta", dimension=32)

        self.assertEqual(first, repeated)
        self.assertNotEqual(first, other)
        self.assertEqual(32, len(first))
        self.assertAlmostEqual(1.0, sum(value * value for value in first), places=6)


class ThresholdIndependenceTests(unittest.TestCase):
    """The two latency thresholds must be able to fail one at a time.

    These score fixed sample lists rather than a live run: a wall-clock
    measurement on a loaded host cannot pin which threshold failed, which is the
    whole point of the test.
    """

    def _score(self, baseline, concurrent, **threshold_overrides):
        thresholds = GateThresholds(samples=len(baseline), **threshold_overrides)
        return evaluate_thresholds(
            baseline_ms=baseline,
            concurrent_ms=concurrent,
            thresholds=thresholds,
        )["results"]

    def test_ratio_alone_can_fail_while_the_absolute_budget_passes(self) -> None:
        results = self._score([10.0] * 40, [25.0] * 40)

        self.assertFalse(results["ratio_within_threshold"])
        self.assertTrue(results["absolute_within_threshold"])
        self.assertTrue(results["measurement_complete"])

    def test_absolute_budget_alone_can_fail_while_the_ratio_passes(self) -> None:
        results = self._score([1_000.0] * 40, [1_500.0] * 40)

        self.assertTrue(results["ratio_within_threshold"])
        self.assertFalse(results["absolute_within_threshold"])

    def test_both_thresholds_can_fail_together(self) -> None:
        results = self._score([10.0] * 40, [3_000.0] * 40)

        self.assertFalse(results["ratio_within_threshold"])
        self.assertFalse(results["absolute_within_threshold"])

    def test_a_short_sample_set_is_never_a_complete_measurement(self) -> None:
        thresholds = GateThresholds(samples=40)
        results = evaluate_thresholds(
            baseline_ms=[10.0] * 40,
            concurrent_ms=[10.0] * 39,
            thresholds=thresholds,
        )["results"]

        self.assertFalse(results["measurement_complete"])
        self.assertTrue(results["ratio_within_threshold"])

    def test_a_slow_concurrent_backend_still_fails_a_live_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(
                tmp,
                faults={"slow_concurrent_query"},
                thresholds=GateThresholds(
                    samples=8,
                    max_concurrent_ratio=2.0,
                    max_concurrent_p95_ms=5.0,
                ),
            )

        self.assertFalse(evidence["threshold_results"]["absolute_within_threshold"])
        self.assertFalse(evidence["checks"]["concurrent_latency"])
        self.assertEqual("FAIL", evidence["status"])
        self.assertGreater(evidence["metrics_ms"]["concurrent_query_p95"], 5)


class WriterOverlapTests(unittest.TestCase):
    """The measurement is only worth reading if the writer was running during it."""

    def test_process_writer_runs_outside_the_reader_and_covers_the_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(tmp)

        writer = evidence["writer"]
        self.assertTrue(writer["valid"], writer["invalid_reason"])
        self.assertTrue(writer["separate_process"])
        self.assertEqual(0, writer["exit_code"])
        self.assertTrue(writer["covers_measurement_window"])
        self.assertGreaterEqual(writer["coverage_fraction"], 0.99)
        self.assertGreater(writer["ops"], 8)
        self.assertLessEqual(writer["writer_window_ms"]["start"], 0.0)
        self.assertGreaterEqual(
            writer["writer_window_ms"]["end"],
            writer["reader_window_ms"]["last_sample_start"],
        )
        self.assertTrue(evidence["checks"]["writer_overlap"])
        self.assertTrue(evidence["checks"]["concurrent_query_write"])
        self.assertEqual("PASS", evidence["status"])

    def test_writer_that_finished_before_the_window_closed_fails_the_gate(self) -> None:
        evidence = build_writer_evidence(
            raw=_sound_writer_evidence(first_op_start_ms=900.0, last_op_end_ms=1_010.0),
            reader_window=_reader_window(),
            protocol_error=None,
            expected_distinct_ids=8,
        )

        self.assertTrue(evidence["valid"])
        self.assertFalse(evidence["covers_measurement_window"])
        self.assertEqual(0.01, evidence["coverage_fraction"])

    def test_writer_that_covered_the_window_is_reported_as_covering(self) -> None:
        evidence = build_writer_evidence(
            raw=_sound_writer_evidence(first_op_start_ms=900.0, last_op_end_ms=2_100.0),
            reader_window=_reader_window(),
            protocol_error=None,
            expected_distinct_ids=8,
        )

        self.assertTrue(evidence["covers_measurement_window"])
        self.assertEqual(1.0, evidence["coverage_fraction"])
        self.assertEqual(1000.0, evidence["overlap_ms"])

    def test_writer_evidence_that_cannot_be_trusted_is_rejected(self) -> None:
        self.assertEqual(
            "writer evidence is not an object",
            validate_writer_evidence("nope", expected_distinct_ids=8),
        )
        for overrides, expected_fragment in (
            ({"first_op_start_ms": None}, "first_op_start_ms"),
            ({"last_op_end_ms": float("inf")}, "not finite"),
            ({"ops": 0}, "no write"),
            ({"ops": "many"}, "ops"),
            ({"distinct_ids": 3}, "distinct ids"),
            ({"mode": "thread"}, "expected 'process'"),
            ({"pid": os.getpid()}, "reader's process"),
            ({"exit_code": 1}, "exited with"),
            ({"exit_code": None}, "exited with"),
            ({"error_code": "MilvusException"}, "failed with MilvusException"),
            ({"error_code": 17}, "neither absent nor a name"),
            ({"first_op_start_ms": 3_000.0}, "ends before it starts"),
            ({"indexed_chunks": 0}, "indexed nothing"),
            ({"indexed_chunks": "lots"}, "indexed_chunks"),
        ):
            with self.subTest(overrides=overrides):
                reason = validate_writer_evidence(
                    _sound_writer_evidence(**overrides),
                    expected_distinct_ids=8,
                )
                self.assertIsNotNone(reason)
                self.assertIn(expected_fragment, reason)

    def test_missing_writer_evidence_never_reads_as_an_overlapping_writer(self) -> None:
        for raw, reader_window, protocol_error in (
            ({}, _reader_window(), None),
            (_sound_writer_evidence(), None, None),
            (
                _sound_writer_evidence(),
                _reader_window(),
                "writer process left no result evidence",
            ),
        ):
            with self.subTest(protocol_error=protocol_error):
                evidence = build_writer_evidence(
                    raw=raw,
                    reader_window=reader_window,
                    protocol_error=protocol_error,
                    expected_distinct_ids=8,
                )
                self.assertFalse(evidence["valid"])
                self.assertIsNotNone(evidence["invalid_reason"])
                self.assertFalse(evidence["covers_measurement_window"])

    def test_a_lost_writer_sinks_the_latency_verdict_instead_of_scoring_it(self) -> None:
        class NoProcessWriter(FakeAdapter):
            start_writer_process = None

        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(
                tmp,
                adapter=NoProcessWriter(topology="per-scope-file", work_dir=Path(tmp)),
            )

        self.assertEqual(0, evidence["counts"]["concurrent_samples"])
        self.assertFalse(evidence["checks"]["writer_overlap"])
        self.assertFalse(evidence["checks"]["concurrent_latency"])
        self.assertFalse(evidence["checks"]["concurrent_query_write"])
        self.assertEqual(1, evidence["counts"]["writer_errors"])
        self.assertEqual("FAIL", evidence["status"])

    def test_a_writer_that_died_mid_measurement_sinks_the_latency_verdict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(tmp, faults={"concurrent_writer_dies"})

        # The reader took every sample it was asked for, and they are within
        # both thresholds — but they were not taken under a live writer.
        self.assertEqual(8, evidence["counts"]["concurrent_samples"])
        self.assertTrue(evidence["threshold_results"]["measurement_complete"])
        self.assertTrue(evidence["threshold_results"]["ratio_within_threshold"])
        self.assertTrue(evidence["threshold_results"]["absolute_within_threshold"])
        self.assertFalse(evidence["writer"]["valid"])
        self.assertFalse(evidence["checks"]["concurrent_latency"])
        self.assertFalse(evidence["checks"]["writer_overlap"])
        self.assertEqual("FAIL", evidence["status"])

    def test_a_writer_that_reported_a_failure_is_rejected_even_on_a_clean_exit(self) -> None:
        # Only the error_code rule can catch this one: the process exited zero,
        # covered the window, and did all its writes.
        evidence = build_writer_evidence(
            raw=_sound_writer_evidence(error_code="MilvusException", exit_code=0),
            reader_window=_reader_window(),
            protocol_error=None,
            expected_distinct_ids=8,
        )

        self.assertFalse(evidence["valid"])
        self.assertIn("MilvusException", evidence["invalid_reason"])
        self.assertFalse(evidence["covers_measurement_window"])

    def test_an_early_writer_cannot_be_read_as_covering(self) -> None:
        evidence = build_writer_evidence(
            raw=_sound_writer_evidence(first_op_start_ms=1_500.0, last_op_end_ms=2_100.0),
            reader_window=_reader_window(),
            protocol_error=None,
            expected_distinct_ids=8,
        )

        self.assertTrue(evidence["valid"])
        self.assertFalse(evidence["covers_measurement_window"])


class WriteLoopTests(unittest.TestCase):
    """The sustained write has to stay real work, not a repeat of itself."""

    def test_repeat_passes_revise_the_record_so_the_backend_cannot_skip_them(self) -> None:
        writes: list[tuple[str, str]] = []
        checks = {"count": 0}

        def should_stop() -> bool:
            checks["count"] += 1
            return checks["count"] > 2

        payload = run_writer_loop(
            count=2,
            prefix="concurrent-",
            text_prefix="gate-concurrent-",
            upsert=lambda record_id, text: writes.append((record_id, text)),
            should_stop=should_stop,
            on_ready=lambda: None,
            deadline_s=5.0,
        )

        self.assertEqual(
            ["gate-concurrent-0", "gate-concurrent-1"],
            [text for _record_id, text in writes[:2]],
        )
        self.assertTrue(all("revision" in text for _record_id, text in writes[2:]))
        self.assertEqual({"concurrent-0", "concurrent-1"}, {record_id for record_id, _ in writes})
        self.assertEqual(2, payload["distinct_ids"])
        self.assertGreater(payload["revisions"], 0)
        self.assertIsNone(payload["indexed_chunks"])

    def test_ready_is_signalled_only_after_the_first_write_succeeds(self) -> None:
        events: list[str] = []

        run_writer_loop(
            count=1,
            prefix="concurrent-",
            text_prefix="gate-concurrent-",
            upsert=lambda record_id, text: events.append("write"),
            should_stop=lambda: True,
            on_ready=lambda: events.append("ready"),
            deadline_s=5.0,
            warmup=lambda: events.append("warmup"),
        )

        self.assertEqual(["warmup", "write", "ready"], events)

    def test_a_writer_that_fails_its_first_write_never_signals_ready(self) -> None:
        events: list[str] = []

        def explode(record_id: str, text: str) -> None:
            raise RuntimeError("no")

        payload = run_writer_loop(
            count=1,
            prefix="concurrent-",
            text_prefix="gate-concurrent-",
            upsert=explode,
            should_stop=lambda: True,
            on_ready=lambda: events.append("ready"),
            deadline_s=5.0,
        )

        self.assertEqual([], events)
        self.assertEqual(0, payload["ops"])
        self.assertEqual("RuntimeError", payload["error_code"])

    def test_indexed_chunks_are_summed_when_the_adapter_reports_them(self) -> None:
        payload = run_writer_loop(
            count=2,
            prefix="concurrent-",
            text_prefix="gate-concurrent-",
            upsert=lambda record_id, text: 3,
            should_stop=lambda: True,
            on_ready=lambda: None,
            deadline_s=5.0,
        )

        self.assertEqual(2, payload["ops"])
        self.assertEqual(6, payload["indexed_chunks"])

    def test_backend_failure_text_is_bounded_and_carries_no_absolute_path(self) -> None:
        error = RuntimeError("Failed to open /private/scratch/u16a/index/gamma.db " + "x" * 400)

        detail = sanitize_error(error)

        self.assertNotIn("/private/scratch", detail)
        self.assertIn("<path>", detail)
        self.assertLessEqual(len(detail), 241)


class WriterProcessProtocolTests(unittest.TestCase):
    """A child the gate cannot account for is never silently tolerated."""

    def test_a_child_that_leaves_no_result_is_a_protocol_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            handle = WriterProcessHandle(
                argv=[sys.executable, "-c", "pass"],
                control_dir=Path(tmp) / "control",
            )
            with self.assertRaises(WriterProtocolError):
                handle.wait_ready(10.0)
            with self.assertRaises(WriterProtocolError) as raised:
                handle.join(10.0)

        self.assertIn("no result evidence", str(raised.exception))

    def test_an_unreadable_child_result_is_a_protocol_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            control = Path(tmp) / "control"
            control.mkdir(parents=True)
            (control / "result.json").write_text("{not json", encoding="utf-8")
            handle = WriterProcessHandle(
                argv=[sys.executable, "-c", "pass"],
                control_dir=control,
            )
            with self.assertRaises(WriterProtocolError) as raised:
                handle.join(10.0)

        self.assertIn("unreadable", str(raised.exception))

    def test_a_result_from_another_process_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            control = Path(tmp) / "control"
            control.mkdir(parents=True)
            (control / "result.json").write_text(
                json.dumps({"pid": os.getpid(), "ops": 5, "mode": "process"}),
                encoding="utf-8",
            )
            handle = WriterProcessHandle(
                argv=[sys.executable, "-c", "pass"],
                control_dir=control,
            )
            with self.assertRaises(WriterProtocolError) as raised:
                handle.join(10.0)

        self.assertIn("different process", str(raised.exception))

    def test_a_child_that_never_stops_is_terminated_and_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            handle = WriterProcessHandle(
                argv=[sys.executable, "-c", "import time; time.sleep(60)"],
                control_dir=Path(tmp) / "control",
            )
            with self.assertRaises(WriterProtocolError) as raised:
                handle.join(1.0)

        self.assertIn("did not exit", str(raised.exception))
        self.assertIsNotNone(handle.process.poll())


class WorkerLifetimeTests(unittest.TestCase):
    """Nothing the gate started may still be writing once it has reported."""

    def test_no_writer_process_survives_the_topology_it_belongs_to(self) -> None:
        handles = []

        class RecordingAdapter(FakeAdapter):
            def start_writer_process(self, **kwargs):
                handle = super().start_writer_process(**kwargs)
                handles.append(handle)
                return handle

        with tempfile.TemporaryDirectory() as tmp:
            _run_fake_topology(
                tmp,
                adapter=RecordingAdapter(topology="per-scope-file", work_dir=Path(tmp)),
            )

        self.assertGreaterEqual(len(handles), 2)  # latency writer plus shared-scope probe
        for handle in handles:
            self.assertIsNotNone(handle.process.poll(), "a writer process outlived the run")

    def test_the_harness_supports_no_uncancellable_writer(self) -> None:
        # A thread blocked in backend I/O cannot be cancelled, so it could still
        # be writing after the gate reported. Only a killable process qualifies.
        self.assertEqual(("process",), WRITER_MODES)
        with self.assertRaises(ValueError):
            check_writer_topology("thread", ("per-scope-file",))


class SameScopeCrossProcessTests(unittest.TestCase):
    """Whether two processes may share one scope's storage is an answer, not a guess."""

    def _run_check(self, tmp, *, faults=None):
        return run_same_scope_cross_process(
            adapter=create_adapter(
                topology="per-scope-file", work_dir=Path(tmp), faults=faults
            ),
            scope="gamma",
            control_dir=Path(tmp) / "same-scope",
            probe_ops=3,
            timeouts=PROBE_TIMEOUTS,
        )

    def test_shared_scope_access_is_classified_from_a_real_child_process(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_check(tmp)

        self.assertEqual("supported", result["classification"])
        self.assertTrue(result["design_compatible"])
        self.assertTrue(result["writer"]["separate_process"])
        self.assertEqual(3, result["reader_queries_succeeded"])
        self.assertEqual(result["expected_ids"], result["visible_ids"])
        self.assertTrue(result["sentinel_visible_after"])

    def test_a_proven_exclusive_open_refusal_completes_the_check_but_not_the_design(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_check(tmp, faults={"same_scope_refusal"})

        self.assertEqual("unsupported-clean", result["classification"])
        self.assertTrue(result["refusal_proof"])
        self.assertFalse(result["design_compatible"])
        self.assertEqual(0, result["writer"]["ops"])
        self.assertEqual([], result["visible_ids"])
        self.assertTrue(result["sentinel_visible_after"])

    def test_a_refusal_without_a_control_proof_is_inconclusive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_check(tmp, faults={"same_scope_broken"})

        self.assertEqual("inconclusive-ambiguous-error", result["classification"])
        self.assertFalse(result["refusal_proof"])
        self.assertFalse(result["design_compatible"])

    def test_a_writer_that_half_wrote_before_failing_is_unsafe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_check(tmp, faults={"same_scope_partial_write"})

        self.assertEqual("unsafe-partial-write", result["classification"])
        self.assertFalse(result["design_compatible"])
        self.assertEqual(["sameproc-0"], result["visible_ids"])

    def test_an_adapter_without_a_cross_process_writer_cannot_claim_support(self) -> None:
        class NoProcessWriter(FakeAdapter):
            start_writer_process = None

        with tempfile.TemporaryDirectory() as tmp:
            result = run_same_scope_cross_process(
                adapter=NoProcessWriter(topology="per-scope-file", work_dir=Path(tmp)),
                scope="gamma",
                control_dir=Path(tmp) / "same-scope",
                probe_ops=3,
                timeouts=PROBE_TIMEOUTS,
            )

        self.assertEqual("inconclusive-not-run", result["classification"])
        self.assertFalse(result["design_compatible"])

    def test_classification_separates_support_refusal_and_unsafe_behaviour(self) -> None:
        for overrides, expected in (
            ({}, "supported"),
            (
                {
                    "child_error_code": "MilvusException",
                    "child_exit_code": 1,
                    "child_ops": 0,
                    "visible_ids": [],
                    "refusal_proof": True,
                },
                "unsupported-clean",
            ),
            (
                {
                    "child_error_code": "MilvusException",
                    "child_exit_code": 1,
                    "child_ops": 0,
                    "visible_ids": [],
                    "refusal_proof": False,
                },
                "inconclusive-ambiguous-error",
            ),
            (
                {
                    "child_error_code": "MilvusException",
                    "child_exit_code": 1,
                    "child_ops": 0,
                    "visible_ids": [],
                    "refusal_proof": None,
                },
                "inconclusive-ambiguous-error",
            ),
            (
                {
                    "child_error_code": "MilvusException",
                    "child_exit_code": 1,
                    "child_ops": 2,
                    "visible_ids": [],
                    "refusal_proof": True,
                },
                "unsafe-partial-write",
            ),
            (
                {
                    "child_error_code": "MilvusException",
                    "child_exit_code": 1,
                    "child_ops": 0,
                    "refusal_proof": True,
                },
                "unsafe-partial-write",
            ),
            ({"reader_error_codes": ["OperationalError"]}, "unsafe-reader-fault"),
            ({"visible_ids": []}, "unsafe-silent-divergence"),
            ({"sentinel_after": False}, "unsafe-data-loss"),
            ({"sentinel_before": False}, "unsafe-precondition"),
            (
                {"protocol_error": "writer process did not exit"},
                "inconclusive-writer-protocol",
            ),
            (
                {"invalid_reason": "writer ran in the reader's process"},
                "inconclusive-no-evidence",
            ),
        ):
            with self.subTest(expected=expected):
                classification, detail = classify_same_scope_access(
                    **_same_scope_inputs(**overrides)
                )
                self.assertEqual(expected, classification)
                self.assertTrue(detail)

    def test_contradictory_child_evidence_fails_closed(self) -> None:
        """A child that contradicts itself has told the gate nothing.

        Each of these is internally impossible for a writer that ran the gate's
        own loop, so none of them may be read as an answer about shared access.
        """

        for label, overrides in (
            (
                "success without a single operation",
                {"child_ops": 0},
            ),
            (
                "success with fewer operations than records asked for",
                {
                    "child_ops": 1,
                    "expected_ids": ["sameproc-0", "sameproc-1"],
                    "visible_ids": ["sameproc-0", "sameproc-1"],
                },
            ),
            (
                "no failure reported but a non-zero exit",
                {
                    "child_exit_code": 1,
                    "child_ops": 0,
                    "visible_ids": [],
                    "refusal_proof": True,
                },
            ),
            (
                "a failure reported but a zero exit",
                {
                    "child_error_code": "MilvusException",
                    "child_exit_code": 0,
                    "child_ops": 0,
                    "visible_ids": [],
                    "refusal_proof": True,
                },
            ),
            (
                "a negative operation count",
                {
                    "child_error_code": "MilvusException",
                    "child_exit_code": 1,
                    "child_ops": -1,
                    "visible_ids": [],
                    "refusal_proof": True,
                },
            ),
            (
                "an operation count that is not a number",
                {"child_ops": None},
            ),
            (
                "an exit code that is not a number",
                {"child_exit_code": "0"},
            ),
            (
                "an error name that is not a name",
                {
                    "child_error_code": 17,
                    "child_exit_code": 1,
                    "child_ops": 0,
                    "visible_ids": [],
                    "refusal_proof": True,
                },
            ),
        ):
            with self.subTest(label=label):
                classification, detail = classify_same_scope_access(
                    **_same_scope_inputs(**overrides)
                )
                self.assertEqual("inconclusive-invalid-evidence", classification)
                self.assertTrue(detail)
                self.assertNotIn(classification, SAFE_SAME_SCOPE_CLASSIFICATIONS)

    def test_only_supported_and_proven_refusal_complete_the_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            supported = _run_fake_topology(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            refused = _run_fake_topology(tmp, faults={"same_scope_refusal"})
        with tempfile.TemporaryDirectory() as tmp:
            ambiguous = _run_fake_topology(tmp, faults={"same_scope_broken"})

        self.assertTrue(supported["checks"]["same_scope_cross_process"])
        self.assertTrue(refused["checks"]["same_scope_cross_process"])
        self.assertFalse(ambiguous["checks"]["same_scope_cross_process"])
        self.assertEqual("FAIL", ambiguous["status"])


class ProductionQualificationTests(unittest.TestCase):
    """A run may only call itself production-class when every input is the real one."""

    def _run_with_descriptor(self, descriptor, tmp):
        class DescribedAdapter(FakeAdapter):
            embedding_descriptor = descriptor

        return _run_fake_topology(
            tmp,
            adapter=DescribedAdapter(topology="per-scope-file", work_dir=Path(tmp)),
        )

    def _production_like_adapter(self, tmp):
        class ProductionLikeAdapter(FakeAdapter):
            authoritative = True
            backend_version = "mocked-production-backend"
            embedding_descriptor = {
                "selector": "onnx",
                "provider": "onnx",
                "model": "gpahal/bge-m3-onnx-int8",
                "production_boundary": True,
            }

        return ProductionLikeAdapter(topology="per-scope-file", work_dir=Path(tmp))

    def _run_production_like(self, tmp, *, faults=None):
        adapter = self._production_like_adapter(tmp)
        adapter.faults = faults or set()
        with mock.patch("platform.system", return_value="Linux"):
            return run_topology(
                adapter=adapter,
                topology="per-scope-file",
                thresholds=GateThresholds(samples=40),
                writer_mode="process",
                control_dir=Path(tmp) / "control",
                timeouts=PROBE_TIMEOUTS,
            )

    def test_a_run_on_the_production_boundary_qualifies(self) -> None:
        """Every requirement must be satisfiable at once, or none of them gate."""

        with tempfile.TemporaryDirectory() as tmp:
            evidence = self._run_production_like(tmp)

        requirements = evidence["production_requirements"]
        self.assertEqual(
            [],
            sorted(name for name, met in requirements.items() if not met),
        )
        self.assertTrue(evidence["production_class"])
        self.assertEqual("Linux", evidence["host_platform"])
        self.assertEqual("PASS", evidence["status"])
        self.assertTrue(evidence["g1_qualifying_run"])

    def test_a_production_class_run_that_failed_is_not_g1_qualifying(self) -> None:
        """Five consecutive *failing* runs must never read as five qualifying ones.

        Production-class describes the inputs — right host, right boundary, right
        sample count, a design the backend serves. It says nothing about whether
        the measurement passed, so it cannot be the thing D counts to five.
        """

        with tempfile.TemporaryDirectory() as tmp:
            evidence = self._run_production_like(tmp, faults={"cross_scope_leak"})

        self.assertTrue(evidence["production_class"])
        self.assertEqual("FAIL", evidence["status"])
        self.assertFalse(evidence["g1_qualifying_run"])

    def test_a_non_production_class_pass_is_not_g1_qualifying(self) -> None:
        """Passing is not qualifying.

        This is the case that separates the invariant from `status == PASS`: a
        run can satisfy every oracle while measuring the wrong host, the wrong
        boundary and the wrong sample count, and it must not be one of the five
        the D matrix counts.
        """

        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(tmp)

        self.assertEqual("PASS", evidence["status"])
        self.assertFalse(evidence["production_class"])
        self.assertFalse(evidence["g1_qualifying_run"])

    def test_a_matrix_that_could_not_run_never_aggregates_a_qualifying_run(self) -> None:
        """The error fallback and the matrix aggregation both fail closed."""

        def refusing_factory(**_kwargs):
            raise RuntimeError("adapter unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            evidence = run_matrix(
                adapter_factory=refusing_factory,
                work_dir=Path(tmp),
                topologies=("per-scope-file",),
                thresholds=GateThresholds(samples=40),
                writer_mode="process",
            )

        topology = evidence["topologies"][0]
        self.assertEqual("FAIL", topology["status"])
        self.assertEqual("RuntimeError", topology["error_code"])
        self.assertFalse(topology["production_class"])
        self.assertFalse(topology["g1_qualifying_run"])
        self.assertFalse(evidence["production_class"])
        self.assertFalse(evidence["g1_qualifying_run"])

    def test_missing_or_malformed_embedding_evidence_fails_the_gate(self) -> None:
        for descriptor in (
            None,
            {},
            {"selector": "onnx", "provider": "onnx", "model": ""},
            {"selector": "onnx", "provider": "onnx", "model": "bge", "production_boundary": "yes"},
        ):
            with self.subTest(descriptor=descriptor):
                with tempfile.TemporaryDirectory() as tmp:
                    evidence = self._run_with_descriptor(descriptor, tmp)
                self.assertFalse(evidence["checks"]["provider_evidence"])
                self.assertEqual("FAIL", evidence["status"])
                self.assertFalse(evidence["production_class"])

    def test_a_stub_boundary_and_a_non_linux_host_are_never_production_class(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = _run_fake_topology(tmp)

        requirements = evidence["production_requirements"]
        self.assertFalse(evidence["production_class"])
        self.assertFalse(requirements["production_embedding_boundary"])
        self.assertFalse(requirements["authoritative_adapter"])
        self.assertFalse(requirements["exact_production_samples"])
        self.assertEqual(evidence["host_platform"] == "Linux", requirements["linux_host"])

    def test_an_incompatible_multi_writer_design_blocks_production_class(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            refused = _run_fake_topology(tmp, faults={"same_scope_refusal"})

        # The check completes, and the design the publisher/gateway split needs
        # is still unavailable, so no run built on it may qualify.
        self.assertTrue(refused["checks"]["same_scope_cross_process"])
        self.assertFalse(refused["production_requirements"]["multi_writer_design_compatible"])
        self.assertFalse(refused["production_class"])

    def test_runner_requires_an_explicit_write_scheduler(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MEMSEARCH_GATE_WRITER", None)
            with mock.patch("sys.argv", ["run_gate.py"]):
                with redirect_stderr(StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        run_gate.main()

        self.assertEqual(2, raised.exception.code)


class RefusedCombinationTests(unittest.TestCase):
    """A separate writer process and one shared storage file cannot be measured."""

    def test_library_refuses_a_process_writer_against_shared_file(self) -> None:
        with self.assertRaises(ValueError) as raised:
            check_writer_topology("process", ("per-scope-file", "shared-file"))
        self.assertIn("shared-file", str(raised.exception))

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                run_topology(
                    adapter=create_adapter(topology="shared-file", work_dir=Path(tmp)),
                    topology="shared-file",
                    thresholds=GateThresholds(samples=8),
                    writer_mode="process",
                    control_dir=Path(tmp) / "control",
                )
            with self.assertRaises(ValueError):
                run_matrix(
                    adapter_factory=create_adapter,
                    work_dir=Path(tmp),
                    topologies=("shared-file",),
                    thresholds=GateThresholds(samples=8),
                    writer_mode="process",
                )

    def test_cli_refuses_a_process_writer_against_shared_file(self) -> None:
        argv = ["run_gate.py", "--writer", "process", "--topology", "shared-file"]
        with mock.patch("sys.argv", argv):
            with redirect_stderr(StringIO()) as captured:
                with self.assertRaises(SystemExit) as raised:
                    run_gate.main()

        self.assertEqual(2, raised.exception.code)
        self.assertIn("shared-file", captured.getvalue())

    def test_the_process_default_topology_set_excludes_shared_file(self) -> None:
        self.assertEqual(("per-scope-file",), run_gate.DEFAULT_TOPOLOGIES)

    def test_an_empty_topology_set_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError) as raised:
                run_matrix(
                    adapter_factory=create_adapter,
                    work_dir=Path(tmp),
                    topologies=(),
                    thresholds=GateThresholds(samples=8),
                    writer_mode="process",
                )

        self.assertIn("empty matrix", str(raised.exception))


class EvidenceSanitizationTests(unittest.TestCase):
    """Evidence travels; the paths of the host that produced it do not."""

    def test_no_absolute_path_reaches_the_emitted_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = run_matrix(
                adapter_factory=lambda **kwargs: create_adapter(
                    faults={"same_scope_partial_write"}, **kwargs
                ),
                work_dir=Path(tmp),
                topologies=("per-scope-file",),
                thresholds=GateThresholds(samples=8),
                writer_mode="process",
                timeouts=PROBE_TIMEOUTS,
            )
            rendered = json.dumps(evidence, sort_keys=True)
            same_scope = evidence["topologies"][0]["same_scope_cross_process"]

            # The injected fault names its records directory, so there is a real
            # path for the sanitizer to have removed.
            self.assertIn("<path>", same_scope["detail"])
            self.assertNotIn(tmp, rendered)
            self.assertNotIn("/private", rendered)
            self.assertNotIn("/var/folders", rendered)


class RunnerOutputTests(unittest.TestCase):
    def test_a_non_production_run_names_what_it_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work_dir = Path(tmp) / "gate"
            argv = [
                "run_gate.py",
                "--writer",
                "process",
                "--samples",
                "5",
                "--work-dir",
                str(work_dir),
                "--require-production-class",
            ]
            with mock.patch("sys.argv", argv):
                with redirect_stdout(StringIO()) as captured:
                    exit_code = run_gate.main()

        printed = captured.getvalue()
        self.assertEqual(1, exit_code)
        self.assertIn("NOT PRODUCTION-CLASS", printed)
        self.assertIn("production_embedding_boundary", printed)
        self.assertIn("five consecutive", printed)


if __name__ == "__main__":
    unittest.main()

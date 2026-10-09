"""Backend-neutral release gate for scoped memsearch isolation.

Adapters deliberately expose only the operations this gate needs. A dry fake
can prove the oracles, never the deployed backend; authoritative adapters must
set ``authoritative = True`` and identify their backend version.

The concurrent writer runs as a separate OS process, because that is the shape
production publication and recall have and because a process can be guaranteed
dead when the gate returns — a Python thread blocked in backend I/O cannot be,
and a writer still running after the measurement is a writer the gate cannot
account for. Evidence carries the writer's own window, so the gate reports
whether the write burst covered the measured read window instead of assuming it.
Missing, malformed, failed, foreign-process, or non-covering writer evidence
sinks the latency verdict rather than leaving it scored.

Reader and writer never share a scope during the latency measurement. Whether
two processes may share one scope's storage at all is measured separately on its
own scope by ``run_same_scope_cross_process``, which reports both a safety
classification and whether the deployment design that needs shared access is
compatible with this backend.
"""

from __future__ import annotations

import math
import os
import platform
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, NamedTuple

from writer_process import (
    WriterProtocolError,
    monotonic_ms,
    sanitize_error,
)


WRITER_MODES = ("process",)
PROCESS_INCOMPATIBLE_TOPOLOGIES = ("shared-file",)
PRODUCTION_PLATFORM = "Linux"
PRODUCTION_SAMPLES = 40
SAME_SCOPE_PROBE_OPS = 5
SAME_SCOPE_SCOPE = "gamma"
SAFE_SAME_SCOPE_CLASSIFICATIONS = ("supported", "unsupported-clean")
G1_QUALIFICATION = (
    "a qualifying run is not a G1 pass: G1 requires five consecutive "
    "G1-qualifying runs in the U16a piece D Linux matrix. A run qualifies only "
    "when it is production-class AND passed every check; production-class alone "
    "describes the inputs, not the outcome"
)


@dataclass(frozen=True)
class GateThresholds:
    samples: int = 40
    max_concurrent_ratio: float = 2.0
    max_concurrent_p95_ms: float = 1200.0


class ReaderWindow(NamedTuple):
    """When the measured samples ran, on the writer's own clock."""

    start: float
    last_sample_start: float
    end: float


@dataclass(frozen=True)
class WriterTimeouts:
    """Bounds on every wait the gate performs on a writer."""

    ready_s: float = 180.0
    join_s: float = 120.0
    deadline_s: float = 600.0


def check_writer_topology(writer_mode: str, topologies: Iterable[str]) -> None:
    """Refuse combinations the gate cannot measure honestly.

    A separate writer process must open the storage file the reader holds when
    every scope lives in one file, which is the case this gate measures
    deliberately and separately — running the latency phase there measures a
    collision instead of a latency.
    """

    if writer_mode not in WRITER_MODES:
        raise ValueError(f"unsupported writer mode: {writer_mode}")
    if writer_mode == "process":
        refused = sorted(set(topologies) & set(PROCESS_INCOMPATIBLE_TOPOLOGIES))
        if refused:
            raise ValueError(
                "a separate-process writer cannot be measured against "
                f"{', '.join(refused)}; see the same-scope classification instead"
            )


def _p95(values: Iterable[float]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def evaluate_thresholds(
    *,
    baseline_ms: list[float],
    concurrent_ms: list[float],
    thresholds: GateThresholds,
) -> dict[str, Any]:
    """Score the samples against both thresholds, independently.

    The relative and absolute budgets answer different questions — contention
    and the recall deadline — so each is reported on its own and a run has to
    satisfy both.
    """

    baseline_p95 = _p95(baseline_ms)
    concurrent_p95 = _p95(concurrent_ms)
    latency_ratio = concurrent_p95 / max(baseline_p95, 0.001)
    return {
        "metrics_ms": {
            "idle_query_p95": round(baseline_p95, 3),
            "concurrent_query_p95": round(concurrent_p95, 3),
            "concurrent_to_idle_ratio": round(latency_ratio, 3),
        },
        "results": {
            "ratio_within_threshold": latency_ratio <= thresholds.max_concurrent_ratio,
            "absolute_within_threshold": concurrent_p95 <= thresholds.max_concurrent_p95_ms,
            "measurement_complete": (
                len(baseline_ms) == thresholds.samples
                and len(concurrent_ms) == thresholds.samples
            ),
        },
    }


def _ids(records: Iterable[dict[str, Any]]) -> list[str]:
    return sorted(str(record["id"]) for record in records)


def _query_ms(adapter: Any, scope: str, query: str) -> tuple[float, list[dict[str, Any]]]:
    started = time.perf_counter()
    records = adapter.search(scope, query, k=10)
    return (time.perf_counter() - started) * 1000, records


def _visible_probe_ids(
    adapter: Any,
    scope: str,
    probes: Iterable[tuple[str, str]],
) -> list[str]:
    visible = []
    for query, record_id in probes:
        if record_id in _ids(adapter.search(scope, query, k=10)):
            visible.append(record_id)
    return sorted(visible)


def _start_writer(
    *,
    adapter: Any,
    scope: str,
    prefix: str,
    text_prefix: str,
    count: int,
    control_dir: Path,
    timeouts: WriterTimeouts,
) -> Any:
    starter = getattr(adapter, "start_writer_process", None)
    if starter is None:
        raise WriterProtocolError("adapter provides no separate-process writer")
    return starter(
        scope=scope,
        prefix=prefix,
        text_prefix=text_prefix,
        count=count,
        control_dir=control_dir,
        deadline_s=timeouts.deadline_s,
    )


def _release_scope(adapter: Any, scope: str) -> None:
    release = getattr(adapter, "release_scope", None)
    if release is None:
        raise WriterProtocolError("adapter cannot release a scope for a separate-process writer")
    release(scope)


def validate_writer_evidence(raw: Any, *, expected_distinct_ids: int) -> str | None:
    """Return the reason the evidence is unusable, or ``None`` when it is sound.

    Sound means: this gate's own separate process wrote it, it finished cleanly,
    it did the work it claims, and its window is readable. Anything else is a
    measurement the latency verdict must not be computed from.
    """

    if not isinstance(raw, dict):
        return "writer evidence is not an object"
    for key in ("first_op_start_ms", "last_op_end_ms", "wall_ms"):
        value = raw.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return f"writer evidence field {key} is missing or not a number"
        if not math.isfinite(float(value)):
            return f"writer evidence field {key} is not finite"
    for key in ("ops", "distinct_ids", "pid"):
        value = raw.get(key)
        if not isinstance(value, int) or isinstance(value, bool):
            return f"writer evidence field {key} is missing or not an integer"
    if raw.get("mode") != "process":
        return f"writer evidence reports mode {raw.get('mode')!r}, expected 'process'"
    if raw["pid"] == os.getpid():
        return "writer ran in the reader's process"
    if raw.get("exit_code") != 0:
        return f"writer process exited with {raw.get('exit_code')!r}"
    error_code = raw.get("error_code")
    if error_code is not None:
        if not isinstance(error_code, str) or not error_code:
            return "writer evidence field error_code is neither absent nor a name"
        return f"writer failed with {error_code}"
    if raw["ops"] < 1:
        return "writer performed no write"
    if raw["distinct_ids"] != expected_distinct_ids:
        return (
            f"writer covered {raw['distinct_ids']} distinct ids, "
            f"expected {expected_distinct_ids}"
        )
    if float(raw["last_op_end_ms"]) < float(raw["first_op_start_ms"]):
        return "writer window ends before it starts"
    indexed = raw.get("indexed_chunks")
    if indexed is not None:
        # An adapter that reports its indexing work must show some: memsearch
        # skips a chunk whose content hash it already holds, so a writer can
        # look busy and store nothing.
        if not isinstance(indexed, int) or isinstance(indexed, bool):
            return "writer evidence field indexed_chunks is not an integer"
        if indexed < 1:
            return "writer indexed nothing during the measurement"
    return None


def validate_child_shape(raw: Any) -> str | None:
    """Minimal shape check for a child that is allowed to refuse its work.

    The latency writer must also have succeeded and covered the read window; a
    writer probing shared-scope access is permitted to fail, so only the
    identity and outcome fields have to be trustworthy.
    """

    if not isinstance(raw, dict):
        return "writer evidence is not an object"
    for key in ("ops", "pid", "exit_code"):
        value = raw.get(key)
        if not isinstance(value, int) or isinstance(value, bool):
            return f"writer evidence field {key} is missing or not an integer"
    if raw.get("mode") != "process":
        return f"writer evidence reports mode {raw.get('mode')!r}, expected 'process'"
    if raw["pid"] == os.getpid():
        return "writer ran in the reader's process"
    error_code = raw.get("error_code")
    if error_code is not None and not isinstance(error_code, str):
        return "writer evidence field error_code is not a string"
    return None


def build_writer_evidence(
    *,
    raw: Any,
    reader_window: ReaderWindow | None,
    protocol_error: str | None,
    expected_distinct_ids: int,
) -> dict[str, Any]:
    """Report whether the write burst was live across the measured window.

    The start predicate — the writer's first write began no later than the first
    sample — is sound because of the writer's own synchronization, not because
    of arithmetic: the child signals ready only after its first write completes,
    and the reader stamps its window only after it has seen ready.

    Coverage ends at the start of the reader's last sample rather than at its
    return, because the writer stamps an operation's end before it can observe
    the stop request; demanding that its last stamp outlast the reader's final
    return would reject a writer that was writing throughout, on a race of one
    operation boundary.
    """

    invalid_reason = protocol_error or validate_writer_evidence(
        raw,
        expected_distinct_ids=expected_distinct_ids,
    )
    if invalid_reason is None and reader_window is None:
        invalid_reason = "the measured read window was never recorded"

    evidence: dict[str, Any] = {
        "mode": "process",
        "valid": invalid_reason is None,
        "invalid_reason": invalid_reason,
        "clock": "CLOCK_MONOTONIC",
        "ops": raw.get("ops") if isinstance(raw, dict) else None,
        "distinct_ids": raw.get("distinct_ids") if isinstance(raw, dict) else None,
        "revisions": raw.get("revisions") if isinstance(raw, dict) else None,
        "indexed_chunks": raw.get("indexed_chunks") if isinstance(raw, dict) else None,
        "error_code": raw.get("error_code") if isinstance(raw, dict) else None,
        "error_detail": raw.get("error_detail") if isinstance(raw, dict) else None,
        "exit_code": raw.get("exit_code") if isinstance(raw, dict) else None,
        "stderr_bytes": raw.get("stderr_bytes") if isinstance(raw, dict) else None,
        "separate_process": (
            raw["pid"] != os.getpid()
            if isinstance(raw, dict) and isinstance(raw.get("pid"), int)
            else None
        ),
        "covers_measurement_window": False,
        "overlap_ms": None,
        "coverage_fraction": None,
        "reader_window_ms": None,
        "writer_window_ms": None,
    }
    if invalid_reason is not None:
        return evidence

    reader_started, reader_last_sample, reader_finished = reader_window  # type: ignore[misc]
    writer_started = float(raw["first_op_start_ms"])  # type: ignore[index]
    writer_finished = float(raw["last_op_end_ms"])  # type: ignore[index]
    reader_duration = reader_finished - reader_started
    overlap = max(
        0.0,
        min(writer_finished, reader_finished) - max(writer_started, reader_started),
    )
    covers = writer_started <= reader_started and writer_finished >= reader_last_sample
    # Windows are reported relative to the first read sample so evidence carries
    # no host-uptime-derived absolute clock value.
    evidence.update(
        {
            "covers_measurement_window": bool(covers),
            "overlap_ms": round(overlap, 3),
            "coverage_fraction": (
                round(overlap / reader_duration, 4) if reader_duration > 0 else None
            ),
            "reader_window_ms": {
                "start": 0.0,
                "last_sample_start": round(reader_last_sample - reader_started, 3),
                "end": round(reader_duration, 3),
                "duration": round(reader_duration, 3),
            },
            "writer_window_ms": {
                "start": round(writer_started - reader_started, 3),
                "end": round(writer_finished - reader_started, 3),
                "duration": round(writer_finished - writer_started, 3),
                "wall": round(float(raw["wall_ms"]), 3),  # type: ignore[index]
            },
        }
    )
    return evidence


def _child_evidence_contradiction(
    *,
    child_error_code: Any,
    child_exit_code: Any,
    child_ops: Any,
    expected_ops: int,
) -> str | None:
    """Name the way a child's own report contradicts itself, if it does.

    The writer loop exits zero exactly when it reports no failure, counts its
    operations upward from zero, and always completes every record id it was
    asked for before it may stop. Evidence that breaks one of those cannot have
    come from a run of it, so it says nothing about shared access either way.
    """

    if not isinstance(child_ops, int) or isinstance(child_ops, bool) or child_ops < 0:
        return f"the writer reported {child_ops!r} operations"
    if not isinstance(child_exit_code, int) or isinstance(child_exit_code, bool):
        return f"the writer reported exit code {child_exit_code!r}"
    if child_error_code is not None and not isinstance(child_error_code, str):
        return f"the writer reported {child_error_code!r} as a failure name"
    succeeded = child_error_code is None
    if succeeded and child_exit_code != 0:
        return f"the writer reported no failure but exited {child_exit_code}"
    if not succeeded and child_exit_code == 0:
        return f"the writer reported {child_error_code} but exited 0"
    if succeeded and child_ops < expected_ops:
        return (
            f"the writer reported success after {child_ops} operation(s), fewer "
            f"than the {expected_ops} record(s) it was asked to write"
        )
    return None


def classify_same_scope_access(
    *,
    protocol_error: str | None,
    invalid_reason: str | None,
    child_error_code: str | None,
    child_exit_code: Any,
    child_ops: Any,
    reader_error_codes: Iterable[str],
    sentinel_before: bool,
    sentinel_after: bool,
    visible_ids: list[str],
    expected_ids: list[str],
    refusal_proof: bool | None,
) -> tuple[str, str]:
    """Decide what two processes sharing one scope actually did.

    Only two answers complete this check. ``supported`` means the deployment
    design that writes a scope while another process reads it works here.
    ``unsupported-clean`` means the backend refused that design outright and
    nothing was lost — a design constraint, not a hazard — and it is only
    reachable on proof: the writer must have been refused with **zero**
    operations, left no partial record behind, not have disturbed the reader,
    and a control writer must succeed on the same scope once the reader releases
    it. Without that control the refusal is indistinguishable from a broken
    backend, so the answer is inconclusive rather than clean.

    Everything else is ``unsafe-*`` (the access was accepted and then lost, hid,
    or half-wrote data, or the reader was damaged) or ``inconclusive-*`` (the
    gate cannot say, which is never evidence of safety).
    """

    reader_errors = list(reader_error_codes)
    if not sentinel_before:
        return ("unsafe-precondition", "the scope's sentinel was not visible before the check")
    if protocol_error is not None:
        return ("inconclusive-writer-protocol", protocol_error)
    if invalid_reason is not None:
        return ("inconclusive-no-evidence", invalid_reason)
    if not sentinel_after:
        return ("unsafe-data-loss", "a pre-existing record stopped being visible")
    if reader_errors:
        return (
            "unsafe-reader-fault",
            f"the reader failed while the scope was shared ({sorted(set(reader_errors))})",
        )
    # Everything above is observed by the reader itself and stands whatever the
    # writer said. From here the answer is read out of the writer's own report,
    # so that report has to be capable of being true.
    contradiction = _child_evidence_contradiction(
        child_error_code=child_error_code,
        child_exit_code=child_exit_code,
        child_ops=child_ops,
        expected_ops=len(expected_ids),
    )
    if contradiction is not None:
        return ("inconclusive-invalid-evidence", contradiction)
    if child_error_code is None and child_exit_code == 0:
        if visible_ids == expected_ids:
            return ("supported", "both processes completed and every written record is visible")
        return (
            "unsafe-silent-divergence",
            "both processes reported success but the writer's records are not all visible",
        )
    if visible_ids:
        return (
            "unsafe-partial-write",
            f"the writer was refused but left {len(visible_ids)} record(s) visible",
        )
    if child_ops != 0:
        return (
            "unsafe-partial-write",
            f"the writer was refused after {child_ops} operation(s)",
        )
    if refusal_proof is not True:
        return (
            "inconclusive-ambiguous-error",
            "the writer failed and a control writer did not succeed on the released "
            f"scope, so {child_error_code!r} is not proof of an exclusive-open refusal",
        )
    return (
        "unsupported-clean",
        "the backend refused shared access before any write, lost nothing, and "
        f"accepted the same scope once released ({child_error_code})",
    )


def run_same_scope_cross_process(
    *,
    adapter: Any,
    scope: str,
    control_dir: Path,
    probe_ops: int,
    timeouts: WriterTimeouts,
) -> dict[str, Any]:
    """Bounded check: one process writes the scope another process is reading.

    The latency phase deliberately keeps reader and writer on different scopes,
    so this is the only place the gate exercises the case U16's publisher and
    gateway would need. It runs on its own scope and its own record ids, and is
    bounded by ``probe_ops`` writes, ``probe_ops`` reads, one single-write
    control process, and the writer timeouts.
    """

    prefix = "sameproc-"
    text_prefix = "gate-sameproc-"
    control_prefix = "sameproctrl-"
    control_text_prefix = "gate-sameproctrl-"
    sentinel_id = "sameproc-sentinel"
    sentinel_query = "gate-sameproc-sentinel"
    expected_ids = sorted(f"{prefix}{ordinal}" for ordinal in range(probe_ops))

    result: dict[str, Any] = {
        "scope": scope,
        "probe_ops": probe_ops,
        "expected_ids": expected_ids,
        "visible_ids": [],
        "reader_queries_attempted": 0,
        "reader_queries_succeeded": 0,
        "reader_error_codes": [],
        "sentinel_visible_before": False,
        "sentinel_visible_after": False,
        "refusal_proof": None,
        "design_compatible": False,
        "writer": None,
    }

    if getattr(adapter, "start_writer_process", None) is None or getattr(
        adapter, "release_scope", None
    ) is None:
        result.update(
            {
                "classification": "inconclusive-not-run",
                "detail": "adapter provides no separate-process writer or scope reopen",
            }
        )
        return result

    adapter.write_source(scope, sentinel_id, f"{sentinel_query} durable record")
    adapter.rebuild(scope)
    result["sentinel_visible_before"] = sentinel_id in _ids(
        adapter.search(scope, sentinel_query, k=10)
    )

    protocol_error: str | None = None
    raw: dict[str, Any] = {}
    reader_errors: list[str] = []
    succeeded = 0
    attempted = 0
    writer = None
    try:
        writer = _start_writer(
            adapter=adapter,
            scope=scope,
            prefix=prefix,
            text_prefix=text_prefix,
            count=probe_ops,
            control_dir=control_dir / "writer",
            timeouts=timeouts,
        )
        writer.wait_ready(timeouts.ready_s)
        for _ in range(probe_ops):
            attempted += 1
            try:
                adapter.search(scope, sentinel_query, k=10)
                succeeded += 1
            except Exception as error:  # sanitized: class name only
                reader_errors.append(type(error).__name__)
    except WriterProtocolError as error:
        protocol_error = str(error)
    finally:
        if writer is not None:
            try:
                writer.request_stop()
                raw = writer.join(timeouts.join_s)
                if protocol_error is not None and raw.get("error_code"):
                    # A writer that refused the shared scope and said why is a
                    # deterministic refusal, not a writer the gate lost track of.
                    protocol_error = None
            except WriterProtocolError as error:
                protocol_error = protocol_error or str(error)
            finally:
                writer.terminate()

    invalid_reason = None if protocol_error is not None else validate_child_shape(raw)
    child_ops = raw.get("ops") if isinstance(raw, dict) else None
    child_error_code = raw.get("error_code") if isinstance(raw, dict) else None

    # Release before anything else: the control writer below must find the scope
    # unheld, and a reader that only ever consults its own cached handle cannot
    # tell "the write never landed" from "this process never looked again".
    reopen_failed = False
    try:
        adapter.release_scope(scope)
    except Exception as error:  # sanitized: class name only
        reader_errors.append(type(error).__name__)
        reopen_failed = True

    refusal_proof: bool | None = None
    if not reopen_failed and child_error_code is not None and child_ops == 0:
        refusal_proof = _prove_exclusive_open_refusal(
            adapter=adapter,
            scope=scope,
            prefix=control_prefix,
            text_prefix=control_text_prefix,
            control_dir=control_dir / "control",
            timeouts=timeouts,
        )

    if reopen_failed:
        visible: list[str] = []
        sentinel_after = False
    else:
        try:
            visible = _visible_probe_ids(
                adapter,
                scope,
                [
                    (f"{text_prefix}{ordinal}", f"{prefix}{ordinal}")
                    for ordinal in range(probe_ops)
                ],
            )
            sentinel_after = sentinel_id in _ids(adapter.search(scope, sentinel_query, k=10))
        except Exception as error:  # sanitized: class name only
            reader_errors.append(type(error).__name__)
            visible = []
            sentinel_after = False

    classification, detail = classify_same_scope_access(
        protocol_error=protocol_error,
        invalid_reason=invalid_reason,
        child_error_code=child_error_code,
        child_exit_code=raw.get("exit_code") if isinstance(raw, dict) else None,
        child_ops=child_ops,
        reader_error_codes=reader_errors,
        sentinel_before=result["sentinel_visible_before"],
        sentinel_after=sentinel_after,
        visible_ids=visible,
        expected_ids=expected_ids,
        refusal_proof=refusal_proof,
    )

    child_detail = raw.get("error_detail") if isinstance(raw, dict) else None
    detail = f"{detail}; reader queries {succeeded}/{attempted}"
    if child_detail:
        detail = f"{detail}; writer said: {child_detail}"

    result.update(
        {
            "classification": classification,
            "detail": detail,
            # Only a backend that actually serves the shared access lets the
            # publisher/gateway split ship; a clean refusal is safe to measure
            # and still incompatible with that design.
            "design_compatible": classification == "supported",
            "visible_ids": visible,
            "reader_queries_attempted": attempted,
            "reader_queries_succeeded": succeeded,
            "reader_error_codes": sorted(set(reader_errors)),
            "sentinel_visible_after": sentinel_after,
            "refusal_proof": refusal_proof,
            "writer": {
                "ops": child_ops,
                "error_code": child_error_code,
                "error_detail": child_detail,
                "exit_code": raw.get("exit_code") if isinstance(raw, dict) else None,
                "separate_process": (
                    raw["pid"] != os.getpid()
                    if isinstance(raw, dict) and isinstance(raw.get("pid"), int)
                    else None
                ),
                "invalid_reason": protocol_error or invalid_reason,
            },
        }
    )
    return result


def _prove_exclusive_open_refusal(
    *,
    adapter: Any,
    scope: str,
    prefix: str,
    text_prefix: str,
    control_dir: Path,
    timeouts: WriterTimeouts,
) -> bool:
    """Can a writer process use this scope once the reader has let go of it?

    Yes means the earlier refusal was about the reader holding the scope. No
    means the scope, the backend, or the environment is broken, and the earlier
    failure proves nothing about shared access.
    """

    control = None
    try:
        control = _start_writer(
            adapter=adapter,
            scope=scope,
            prefix=prefix,
            text_prefix=text_prefix,
            count=1,
            control_dir=control_dir,
            timeouts=timeouts,
        )
        control.wait_ready(timeouts.ready_s)
        control.request_stop()
        evidence = control.join(timeouts.join_s)
    except WriterProtocolError:
        return False
    finally:
        if control is not None:
            control.terminate()
    return (
        validate_child_shape(evidence) is None
        and evidence.get("error_code") is None
        and evidence.get("exit_code") == 0
        and evidence.get("ops", 0) >= 1
    )


def _embedding_evidence(adapter: Any) -> tuple[dict[str, Any], str | None]:
    """Read the adapter's embedding boundary; a run without one is unreadable."""

    descriptor = getattr(adapter, "embedding_descriptor", None)
    if not isinstance(descriptor, dict):
        return ({}, "adapter reports no embedding descriptor")
    reported = {}
    for key in ("selector", "provider", "model"):
        value = descriptor.get(key)
        if not isinstance(value, str) or not value:
            return ({}, f"embedding descriptor field {key} is missing or empty")
        reported[key] = value
    production = descriptor.get("production_boundary")
    if not isinstance(production, bool):
        return ({}, "embedding descriptor field production_boundary is missing or not a boolean")
    reported["production_boundary"] = production
    return (reported, None)


def run_topology(
    *,
    adapter: Any,
    topology: str,
    thresholds: GateThresholds,
    writer_mode: str,
    control_dir: Path,
    timeouts: WriterTimeouts | None = None,
) -> dict[str, Any]:
    """Run the complete isolation matrix against one configured topology."""

    check_writer_topology(writer_mode, (topology,))
    timeouts = timeouts or WriterTimeouts()
    control_dir = Path(control_dir)

    alpha = "gate-alpha"
    beta = "gate-beta"
    adapter.write_source("alpha", "alpha-sentinel", f"{alpha} durable record")
    adapter.write_source("beta", "beta-sentinel", f"{beta} durable record")
    adapter.write_source("alpha", "alpha-staged", "gate-staged must stay hidden", staged=True)
    adapter.rebuild("alpha")
    adapter.rebuild("beta")

    forbidden_cross_scope = (
        _ids(adapter.search("alpha", beta, k=10)).count("beta-sentinel")
        + _ids(adapter.search("beta", alpha, k=10)).count("alpha-sentinel")
    )
    staged_results = _ids(
        adapter.search("alpha", "gate-staged", k=10)
    ).count("alpha-staged")

    baseline_ms = [
        _query_ms(adapter, "beta", beta)[0]
        for _ in range(thresholds.samples)
    ]

    if hasattr(adapter, "set_concurrent_probe"):
        adapter.set_concurrent_probe(True)

    protocol_error: str | None = None
    raw_writer: dict[str, Any] = {}
    reader_window: ReaderWindow | None = None
    concurrent_ms: list[float] = []
    writer = None
    try:
        # In production the publisher owns the file it writes. Handing the
        # writer's scope over keeps the latency phase a measurement of
        # concurrent load; shared-scope access is measured separately below.
        _release_scope(adapter, "alpha")
        writer = _start_writer(
            adapter=adapter,
            scope="alpha",
            prefix="concurrent-",
            text_prefix="gate-concurrent-",
            count=thresholds.samples,
            control_dir=control_dir / "writer",
            timeouts=timeouts,
        )
        writer.wait_ready(timeouts.ready_s)
        reader_started = monotonic_ms()
        last_sample_started = reader_started
        for _ in range(thresholds.samples):
            last_sample_started = monotonic_ms()
            concurrent_ms.append(_query_ms(adapter, "beta", beta)[0])
        reader_window = ReaderWindow(reader_started, last_sample_started, monotonic_ms())
    except WriterProtocolError as error:
        protocol_error = str(error)
    finally:
        if writer is not None:
            try:
                writer.request_stop()
                raw_writer = writer.join(timeouts.join_s)
            except WriterProtocolError as error:
                protocol_error = protocol_error or str(error)
            finally:
                # No writer outlives the measurement it belongs to.
                writer.terminate()
    if hasattr(adapter, "set_concurrent_probe"):
        adapter.set_concurrent_probe(False)

    writer_evidence = build_writer_evidence(
        raw=raw_writer,
        reader_window=reader_window,
        protocol_error=protocol_error,
        expected_distinct_ids=thresholds.samples,
    )
    writer_sound = bool(
        writer_evidence["valid"] and writer_evidence["covers_measurement_window"]
    )

    alpha_probes = [(alpha, "alpha-sentinel")] + [
        (f"gate-concurrent-{ordinal}", f"concurrent-{ordinal}")
        for ordinal in range(thresholds.samples)
    ]
    beta_probes = [(beta, "beta-sentinel")]
    expected_alpha = sorted(record_id for _query, record_id in alpha_probes)
    expected_beta = sorted(record_id for _query, record_id in beta_probes)
    visible_alpha_before_delete = _visible_probe_ids(adapter, "alpha", alpha_probes)
    visible_beta_before_delete = _visible_probe_ids(adapter, "beta", beta_probes)

    scored = evaluate_thresholds(
        baseline_ms=baseline_ms,
        concurrent_ms=concurrent_ms,
        thresholds=thresholds,
    )
    threshold_results = scored["results"]

    same_scope = run_same_scope_cross_process(
        adapter=adapter,
        scope=SAME_SCOPE_SCOPE,
        control_dir=control_dir / "same-scope",
        probe_ops=SAME_SCOPE_PROBE_OPS,
        timeouts=timeouts,
    )

    adapter.delete_collection("alpha")
    alpha_after_delete = adapter.search("alpha", alpha, k=10)
    beta_after_delete = _visible_probe_ids(adapter, "beta", beta_probes)
    delete_ok = not alpha_after_delete and beta_after_delete == expected_beta

    adapter.rebuild("alpha")
    adapter.rebuild("beta")
    rebuilt_alpha = _visible_probe_ids(adapter, "alpha", alpha_probes)
    rebuilt_beta = _visible_probe_ids(adapter, "beta", beta_probes)
    rebuild_ok = rebuilt_alpha == expected_alpha and rebuilt_beta == expected_beta

    embedding, embedding_error = _embedding_evidence(adapter)
    authoritative = bool(getattr(adapter, "authoritative", False))
    host_platform = platform.system()
    production_requirements = {
        "linux_host": host_platform == PRODUCTION_PLATFORM,
        "process_writer": writer_mode == "process",
        "exact_production_samples": thresholds.samples == PRODUCTION_SAMPLES,
        "production_embedding_boundary": bool(embedding.get("production_boundary")),
        "authoritative_adapter": authoritative,
        "multi_writer_design_compatible": bool(same_scope.get("design_compatible")),
    }

    checks = {
        "cross_scope_isolation": forbidden_cross_scope == 0,
        "staged_sibling_excluded": staged_results == 0,
        "concurrent_query_write": (
            writer_evidence["valid"]
            and visible_alpha_before_delete == expected_alpha
            and visible_beta_before_delete == expected_beta
        ),
        "concurrent_latency": (
            threshold_results["measurement_complete"]
            and writer_sound
            and threshold_results["absolute_within_threshold"]
            and threshold_results["ratio_within_threshold"]
        ),
        "writer_overlap": writer_sound,
        "same_scope_cross_process": (
            same_scope["classification"] in SAFE_SAME_SCOPE_CLASSIFICATIONS
        ),
        "provider_evidence": embedding_error is None,
        "per_collection_delete": delete_ok,
        "rebuild_equivalence": rebuild_ok,
    }
    production_class = all(production_requirements.values())
    passed = all(checks.values())
    return {
        "topology": topology,
        "adapter": str(getattr(adapter, "name", type(adapter).__name__)),
        "backend_version": str(getattr(adapter, "backend_version", "unknown")),
        "authoritative": authoritative,
        "host_platform": host_platform,
        "production_class": production_class,
        "production_requirements": production_requirements,
        # Production-class qualifies the inputs; only a production-class run that
        # also passed is one of the five the D matrix counts.
        "g1_qualifying_run": production_class and passed,
        "status": "PASS" if passed else "FAIL",
        "checks": checks,
        "counts": {
            "cross_scope_results": forbidden_cross_scope,
            "staged_results": staged_results,
            "writer_errors": 0 if writer_evidence["valid"] else 1,
            "baseline_samples": len(baseline_ms),
            "concurrent_samples": len(concurrent_ms),
        },
        "metrics_ms": scored["metrics_ms"],
        "threshold_results": threshold_results,
        "thresholds": {
            "samples": thresholds.samples,
            "max_concurrent_ratio": thresholds.max_concurrent_ratio,
            "max_concurrent_p95_ms": thresholds.max_concurrent_p95_ms,
        },
        "writer": writer_evidence,
        "same_scope_cross_process": same_scope,
        "embedding": embedding or {"error": embedding_error},
        "sanitized_diagnostics": {
            "expected_alpha_ids": expected_alpha,
            "expected_beta_ids": expected_beta,
            "visible_alpha_ids_before_delete": visible_alpha_before_delete,
            "visible_beta_ids_before_delete": visible_beta_before_delete,
            "alpha_ids_after_delete": _ids(alpha_after_delete),
            "beta_ids_after_delete": beta_after_delete,
            "rebuilt_alpha_ids": rebuilt_alpha,
            "rebuilt_beta_ids": rebuilt_beta,
        },
    }


def run_matrix(
    *,
    adapter_factory: Callable[..., Any],
    work_dir: Path,
    topologies: Iterable[str],
    thresholds: GateThresholds,
    writer_mode: str,
    timeouts: WriterTimeouts | None = None,
) -> dict[str, Any]:
    ordered_topologies = tuple(topologies)
    if not ordered_topologies:
        raise ValueError("at least one topology is required; an empty matrix proves nothing")
    check_writer_topology(writer_mode, ordered_topologies)

    results = []
    for topology in ordered_topologies:
        topology_dir = work_dir / topology
        topology_dir.mkdir(parents=True, exist_ok=True)
        adapter = None
        try:
            adapter = adapter_factory(topology=topology, work_dir=topology_dir)
            result = run_topology(
                adapter=adapter,
                topology=topology,
                thresholds=thresholds,
                writer_mode=writer_mode,
                control_dir=topology_dir / "control",
                timeouts=timeouts,
            )
        except Exception as error:  # sanitized release-gate evidence
            result = {
                "topology": topology,
                "adapter": str(getattr(adapter, "name", "unavailable")),
                "backend_version": str(getattr(adapter, "backend_version", "unknown")),
                "authoritative": bool(getattr(adapter, "authoritative", False)),
                "production_class": False,
                "g1_qualifying_run": False,
                "status": "FAIL",
                "error_code": type(error).__name__,
                "error_detail": sanitize_error(error),
            }
        finally:
            if adapter is not None and hasattr(adapter, "close"):
                adapter.close()
        results.append(result)

    return {
        "status": "PASS" if all(result["status"] == "PASS" for result in results) else "FAIL",
        "authoritative": all(result["authoritative"] for result in results),
        "production_class": all(result.get("production_class") for result in results),
        "g1_qualifying_run": all(result.get("g1_qualifying_run") for result in results),
        "g1_qualification": G1_QUALIFICATION,
        "writer_mode": writer_mode,
        "topologies": results,
    }

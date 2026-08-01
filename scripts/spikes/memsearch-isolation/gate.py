"""Backend-neutral release gate for scoped memsearch isolation.

Adapters deliberately expose only the operations this gate needs. A dry fake
can prove the oracles, never the deployed backend; authoritative adapters must
set ``authoritative = True`` and identify their backend version.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


@dataclass(frozen=True)
class GateThresholds:
    samples: int = 40
    max_concurrent_ratio: float = 2.0
    max_concurrent_p95_ms: float = 1200.0


def _p95(values: Iterable[float]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


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


def run_topology(*, adapter: Any, topology: str, thresholds: GateThresholds) -> dict[str, Any]:
    """Run the complete isolation matrix against one configured topology."""

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

    writer_errors: list[str] = []

    def writer() -> None:
        try:
            for ordinal in range(thresholds.samples):
                adapter.upsert(
                    "alpha",
                    f"concurrent-{ordinal}",
                    f"gate-concurrent-{ordinal}",
                )
        except Exception as error:  # pragma: no cover - real adapters exercise this
            writer_errors.append(type(error).__name__)

    if hasattr(adapter, "set_concurrent_probe"):
        adapter.set_concurrent_probe(True)
    thread = threading.Thread(target=writer, name="memsearch-gate-writer")
    thread.start()
    concurrent_ms = [
        _query_ms(adapter, "beta", beta)[0]
        for _ in range(thresholds.samples)
    ]
    thread.join()
    if hasattr(adapter, "set_concurrent_probe"):
        adapter.set_concurrent_probe(False)

    alpha_probes = [(alpha, "alpha-sentinel")] + [
        (f"gate-concurrent-{ordinal}", f"concurrent-{ordinal}")
        for ordinal in range(thresholds.samples)
    ]
    beta_probes = [(beta, "beta-sentinel")]
    expected_alpha = sorted(record_id for _query, record_id in alpha_probes)
    expected_beta = sorted(record_id for _query, record_id in beta_probes)
    visible_alpha_before_delete = _visible_probe_ids(adapter, "alpha", alpha_probes)
    visible_beta_before_delete = _visible_probe_ids(adapter, "beta", beta_probes)

    baseline_p95 = _p95(baseline_ms)
    concurrent_p95 = _p95(concurrent_ms)
    latency_ratio = concurrent_p95 / max(baseline_p95, 0.001)

    adapter.delete_collection("alpha")
    alpha_after_delete = adapter.search("alpha", alpha, k=10)
    beta_after_delete = _visible_probe_ids(adapter, "beta", beta_probes)
    delete_ok = not alpha_after_delete and beta_after_delete == expected_beta

    adapter.rebuild("alpha")
    adapter.rebuild("beta")
    rebuilt_alpha = _visible_probe_ids(adapter, "alpha", alpha_probes)
    rebuilt_beta = _visible_probe_ids(adapter, "beta", beta_probes)
    rebuild_ok = rebuilt_alpha == expected_alpha and rebuilt_beta == expected_beta

    checks = {
        "cross_scope_isolation": forbidden_cross_scope == 0,
        "staged_sibling_excluded": staged_results == 0,
        "concurrent_query_write": (
            not writer_errors
            and visible_alpha_before_delete == expected_alpha
            and visible_beta_before_delete == expected_beta
        ),
        "concurrent_latency": (
            concurrent_p95 <= thresholds.max_concurrent_p95_ms
            and latency_ratio <= thresholds.max_concurrent_ratio
        ),
        "per_collection_delete": delete_ok,
        "rebuild_equivalence": rebuild_ok,
    }
    return {
        "topology": topology,
        "adapter": str(getattr(adapter, "name", type(adapter).__name__)),
        "backend_version": str(getattr(adapter, "backend_version", "unknown")),
        "authoritative": bool(getattr(adapter, "authoritative", False)),
        "status": "PASS" if all(checks.values()) else "FAIL",
        "checks": checks,
        "counts": {
            "cross_scope_results": forbidden_cross_scope,
            "staged_results": staged_results,
            "writer_errors": len(writer_errors),
        },
        "metrics_ms": {
            "idle_query_p95": round(baseline_p95, 3),
            "concurrent_query_p95": round(concurrent_p95, 3),
            "concurrent_to_idle_ratio": round(latency_ratio, 3),
        },
        "thresholds": {
            "samples": thresholds.samples,
            "max_concurrent_ratio": thresholds.max_concurrent_ratio,
            "max_concurrent_p95_ms": thresholds.max_concurrent_p95_ms,
        },
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
) -> dict[str, Any]:
    results = []
    for topology in topologies:
        topology_dir = work_dir / topology
        topology_dir.mkdir(parents=True, exist_ok=True)
        adapter = None
        try:
            adapter = adapter_factory(topology=topology, work_dir=topology_dir)
            result = run_topology(
                adapter=adapter,
                topology=topology,
                thresholds=thresholds,
            )
        except Exception as error:  # sanitized release-gate evidence
            result = {
                "topology": topology,
                "adapter": str(getattr(adapter, "name", "unavailable")),
                "backend_version": str(getattr(adapter, "backend_version", "unknown")),
                "authoritative": bool(getattr(adapter, "authoritative", False)),
                "status": "FAIL",
                "error_code": type(error).__name__,
            }
        finally:
            if adapter is not None and hasattr(adapter, "close"):
                adapter.close()
        results.append(result)

    return {
        "status": "PASS" if all(result["status"] == "PASS" for result in results) else "FAIL",
        "authoritative": bool(results) and all(result["authoritative"] for result in results),
        "topologies": results,
    }

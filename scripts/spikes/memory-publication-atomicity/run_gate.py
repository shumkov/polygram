#!/usr/bin/env python3
"""Crash-injected gate for atomic partner/general memory publication."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from publication import (
    CRASH_POINTS,
    INITIALIZATION_CRASH_POINTS,
    LOGICAL_ID,
    RECORD_ID,
    RECONCILIATION_CRASH_POINTS,
    SCOPES,
    PublicationBootGate,
    PublicationNotReady,
    PublicationStore,
)


FIXTURE = "A sanitized durable partner fact."
CRASH_EXIT = 77
EXPECTED_CRASH_POINT_COUNT = 22


def crash_worker(root: Path, crash_point: str) -> int:
    store = PublicationStore(root)
    if crash_point in INITIALIZATION_CRASH_POINTS:
        store.initialize(
            FIXTURE,
            crash_point,
            crash=lambda: os._exit(CRASH_EXIT),
        )
    elif crash_point in RECONCILIATION_CRASH_POINTS:
        store.reconcile(crash_point, crash=lambda: os._exit(CRASH_EXIT))
    else:
        raise ValueError("unknown crash point")
    return 3


def recovery_worker(root: Path) -> int:
    store = PublicationStore(root)
    store.initialize(FIXTURE)
    store.reconcile()
    return 0


def both_recalled(store: PublicationStore) -> bool:
    recalled = [store.recall(scope) for scope in SCOPES]
    return recalled == [[FIXTURE], [FIXTURE]]


def exact_snapshot() -> dict[str, object]:
    return {
        "logical_rows": [(LOGICAL_ID, FIXTURE, "active")],
        "destination_rows": [
            (LOGICAL_ID, scope, RECORD_ID) for scope in sorted(SCOPES)
        ],
        "scopes": {
            scope: {
                "records": [(f"{RECORD_ID}.md", FIXTURE)],
                "staged": [],
                "index": [(RECORD_ID, FIXTURE)],
            }
            for scope in sorted(SCOPES)
        },
        "recall": {scope: [FIXTURE] for scope in sorted(SCOPES)},
    }


def run_child(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-B", str(Path(__file__).resolve()), *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )


def observed_visibility(store: PublicationStore) -> list[object]:
    observed = []
    for scope in SCOPES:
        try:
            observed.append(store.recall(scope))
        except PublicationNotReady:
            observed.append("unavailable")
    return observed


def run_gate() -> dict[str, object]:
    checks = {
        "no_half_visible_after_crash": True,
        "every_crash_recovers_both_siblings": True,
        "boot_repairs_before_recall": True,
        "reconciliation_is_idempotent": True,
        "crash_matrix_complete": len(CRASH_POINTS) == EXPECTED_CRASH_POINT_COUNT,
    }
    with tempfile.TemporaryDirectory(prefix="memory-publication-gate-") as temporary:
        root = Path(temporary)
        for ordinal, crash_point in enumerate(CRASH_POINTS):
            scenario = root / f"crash-{ordinal}"
            store = PublicationStore(scenario)
            if crash_point in RECONCILIATION_CRASH_POINTS:
                store.initialize(FIXTURE)
            worker = run_child("--worker", str(scenario), crash_point)
            if worker.returncode != CRASH_EXIT:
                checks["crash_matrix_complete"] = False
                checks["every_crash_recovers_both_siblings"] = False
                continue

            visibility = observed_visibility(store)
            if crash_point in ("before_checkpoint", "during_checkpoint"):
                expected_visibility = ["unavailable", "unavailable"]
            elif crash_point == "after_activation":
                expected_visibility = [[FIXTURE], [FIXTURE]]
            else:
                expected_visibility = [[], []]
            checks["no_half_visible_after_crash"] &= visibility == expected_visibility

            recovery = run_child("--recover", str(scenario))
            if recovery.returncode != 0:
                checks["every_crash_recovers_both_siblings"] = False
                checks["reconciliation_is_idempotent"] = False
                continue
            store = PublicationStore(scenario)
            checks["every_crash_recovers_both_siblings"] &= both_recalled(store)
            before = store.durable_snapshot()
            second_recovery = run_child("--recover", str(scenario))
            after = PublicationStore(scenario).durable_snapshot()
            checks["reconciliation_is_idempotent"] &= (
                second_recovery.returncode == 0
                and before == after
                and after == exact_snapshot()
            )

        repair_store = PublicationStore(root / "boot-repair")
        repair_store.initialize(FIXTURE)
        repair_store.reconcile()
        repair_store.remove_index_for_gate("partner")
        repair_store.remove_body_for_gate("general")
        boot = PublicationBootGate(repair_store)
        rejected_before_ready = []
        for scope in SCOPES:
            try:
                boot.recall(scope)
            except PublicationNotReady:
                rejected_before_ready.append(scope)
        boot.open()
        checks["boot_repairs_before_recall"] = (
            rejected_before_ready == list(SCOPES)
            and all(boot.recall(scope) == [FIXTURE] for scope in SCOPES)
            and repair_store.durable_snapshot() == exact_snapshot()
        )

    return {
        "status": "PASS" if all(checks.values()) else "FAIL",
        "crash_points_exercised": list(CRASH_POINTS),
        "scopes": len(SCOPES),
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--worker", nargs=2, metavar=("ROOT", "CRASH_POINT"))
    modes.add_argument("--recover", metavar="ROOT")
    args = parser.parse_args()
    if args.worker:
        return crash_worker(Path(args.worker[0]), args.worker[1])
    if args.recover:
        return recovery_worker(Path(args.recover))
    try:
        evidence = run_gate()
    except Exception:
        evidence = {"status": "FAIL", "error_code": "publication-gate-exception"}
    print(json.dumps(evidence, sort_keys=True))
    return 0 if evidence["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())

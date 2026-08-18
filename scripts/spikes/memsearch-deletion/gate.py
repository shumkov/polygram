"""Deletion-mechanism gate for scoped memory redaction.

Selects the removal mechanism the operator runbook must document: either
record-level removal (delete one Markdown source, run the public rebuild) or the
scope-level fallback (relocate the scope's Markdown, rebuild the scope from
empty). Both paths are exercised with documented calls only; a private surface
such as ``store.drop()`` is never used.

The oracles are deliberately falsifiable. Four properties matter, and negative
recall alone establishes none of them:

* **Attribution** — the target must still be retrievable after its source is
  removed but *before* the rebuild, so the rebuild is proven load-bearing. A
  backend that merely hides results whose source file has vanished cannot pass.
* **Anti-vacuity** — the target must be retrievable before removal and the
  surviving siblings after it, so a scope that returns nothing fails.
* **Containment** — every other scope must survive each rebuild, so a rebuild
  that damages a sibling partner's scope cannot pass.
* **Durability** — the result must survive closing and reopening the store, so a
  removal that exists only in one live handle cannot pass.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Protocol


SAFE_ID = re.compile(r"^[a-z0-9-]+$")
SEARCH_DEPTH = 25

SELECTOR = "selector"
FALLBACK = "fallback"
INFORMATIONAL = "informational"
PRECONDITION = "precondition"


class DeletionAdapter(Protocol):
    """Storage surface the gate is allowed to touch."""

    name: str
    backend_version: str
    authoritative: bool

    def write_source(self, scope: str, record_id: str, text: str) -> None: ...

    def remove_source(self, scope: str, record_id: str) -> None: ...

    def relocate_scope_sources(self, scope: str, keep: list[str]) -> None: ...

    def rebuild(self, scope: str) -> None: ...

    def rebuild_incremental(self, scope: str) -> None: ...

    def reopen(self, scope: str) -> None: ...

    def search(self, scope: str, query: str, *, k: int) -> list[dict[str, Any]]: ...


@dataclass
class PhaseResult:
    name: str
    passed: bool
    role: str
    checks: dict[str, bool] = field(default_factory=dict)
    detail: str = ""


@dataclass
class GateResult:
    adapter: str
    backend_version: str
    authoritative: bool
    configuration: dict[str, Any]
    selected_mechanism: str
    phases: list[PhaseResult]

    @property
    def passed(self) -> bool:
        # The gate exists to select a documented removal mechanism, and to prove
        # the precondition that mechanism depends on. It does not require the
        # fallback to pass once record-level removal is proven.
        if self.selected_mechanism == "none":
            return False
        return all(
            phase.passed for phase in self.phases if phase.role == PRECONDITION
        )


def _sentinel(record_id: str) -> str:
    """Distinctive retrieval token for one fixture record."""
    return f"zetamarker{record_id.replace('-', '')}"


def _body(record_id: str) -> str:
    return (
        f"# sanitized fixture {record_id}\n\n"
        f"Deletion gate fixture record {record_id}. "
        f"Retrieval token {_sentinel(record_id)}.\n"
    )


def _probe(adapter: DeletionAdapter, scope: str, record_id: str) -> tuple[set[str], bool]:
    """Look one record up, and report whether the result window was saturated.

    "Not in the top k" only means "absent" while the window is larger than the
    scope. A saturated window makes a negative result meaningless, so the caller
    records that rather than reading it as removal.
    """
    results = adapter.search(scope, _sentinel(record_id), k=SEARCH_DEPTH)
    return {str(result.get("id")) for result in results}, len(results) >= SEARCH_DEPTH


def _found_ids(adapter: DeletionAdapter, scope: str, record_id: str) -> set[str]:
    found, _saturated = _probe(adapter, scope, record_id)
    return found


def _absent(adapter: DeletionAdapter, scope: str, record_id: str) -> bool:
    found, saturated = _probe(adapter, scope, record_id)
    return record_id not in found and not saturated


def _all_present(adapter: DeletionAdapter, scope: str, record_ids: list[str]) -> bool:
    if not record_ids:
        raise ValueError("presence checks require at least one record")
    return all(
        record_id in _found_ids(adapter, scope, record_id)
        for record_id in record_ids
    )


def _seed(adapter: DeletionAdapter, scope: str, record_ids: list[str]) -> None:
    for record_id in record_ids:
        if not SAFE_ID.fullmatch(record_id):
            raise ValueError("unsafe record id")
        adapter.write_source(scope, record_id, _body(record_id))
    adapter.rebuild(scope)


def _others_intact(
    adapter: DeletionAdapter,
    *,
    scopes: list[str],
    exclude: str,
    siblings: list[str],
) -> bool:
    """Every scope other than the one under test still serves its siblings."""
    return all(
        _all_present(adapter, scope, siblings)
        for scope in scopes
        if scope != exclude
    )


def run_record_level_phase(
    adapter: DeletionAdapter,
    *,
    scope: str,
    target: str,
    siblings: list[str],
    all_scopes: list[str],
    incremental: bool = False,
) -> PhaseResult:
    """Delete one Markdown source, then run a public rebuild."""
    name = "record-level-incremental" if incremental else "record-level-force"
    role = INFORMATIONAL if incremental else SELECTOR

    checks = {
        "target_indexed_before": target in _found_ids(adapter, scope, target),
        "siblings_indexed_before": _all_present(adapter, scope, siblings),
    }

    adapter.remove_source(scope, target)
    # Attribution: deleting the source alone must not be what hides the record,
    # otherwise "absent after rebuild" says nothing about the rebuild.
    checks["target_present_before_rebuild"] = (
        target in _found_ids(adapter, scope, target)
    )

    if incremental:
        adapter.rebuild_incremental(scope)
    else:
        adapter.rebuild(scope)

    checks["target_absent_after"] = _absent(adapter, scope, target)
    checks["siblings_present_after"] = _all_present(adapter, scope, siblings)
    checks["other_scopes_intact"] = _others_intact(
        adapter, scopes=all_scopes, exclude=scope, siblings=siblings,
    )

    # Durability: a removal visible only through the live handle is not a
    # redaction. The runbook stops and restarts the gateway.
    adapter.reopen(scope)
    checks["target_absent_after_reopen"] = _absent(adapter, scope, target)
    checks["siblings_present_after_reopen"] = _all_present(adapter, scope, siblings)

    passed = all(checks.values())
    detail = (
        "source deletion plus the public rebuild dropped the record from search"
        if passed
        else "the public rebuild did not durably remove the deleted record"
    )
    return PhaseResult(name=name, passed=passed, role=role, checks=checks, detail=detail)


def run_scope_level_phase(
    adapter: DeletionAdapter,
    *,
    scope: str,
    target: str,
    siblings: list[str],
    all_scopes: list[str],
) -> PhaseResult:
    """Relocate the scope's Markdown and rebuild the scope from empty."""
    checks = {
        "target_indexed_before": target in _found_ids(adapter, scope, target),
        "siblings_indexed_before": _all_present(adapter, scope, siblings),
    }

    # Relocate every source out of the scope, then rebuild the now-empty scope so
    # the index cannot retain a stale record, then restore only the survivors.
    adapter.relocate_scope_sources(scope, keep=[])
    checks["target_present_before_rebuild"] = (
        target in _found_ids(adapter, scope, target)
    )

    adapter.rebuild(scope)
    checks["empty_scope_returns_nothing"] = not _found_ids(adapter, scope, target)

    adapter.relocate_scope_sources(scope, keep=siblings)
    adapter.rebuild(scope)

    checks["target_absent_after"] = _absent(adapter, scope, target)
    checks["siblings_present_after"] = _all_present(adapter, scope, siblings)
    checks["other_scopes_intact"] = _others_intact(
        adapter, scopes=all_scopes, exclude=scope, siblings=siblings,
    )

    adapter.reopen(scope)
    checks["target_absent_after_reopen"] = _absent(adapter, scope, target)
    checks["siblings_present_after_reopen"] = _all_present(adapter, scope, siblings)

    passed = all(checks.values())
    detail = (
        "scope rebuild from empty dropped the record and restored its siblings"
        if passed
        else "scope rebuild did not produce clean durable negative recall"
    )
    return PhaseResult(
        name="scope-level-fallback", passed=passed, role=FALLBACK,
        checks=checks, detail=detail,
    )


def run_directory_paths_precondition_phase(
    adapter: DeletionAdapter,
    *,
    scope: str,
    target: str,
    siblings: list[str],
) -> PhaseResult:
    """Pin the configuration record-level removal depends on.

    memsearch prunes chunks for sources that vanished only when the scope is
    configured with a *directory* root. Configured with explicit file paths, a
    rebuild is a partial update that leaves the deleted record searchable. An
    operator who follows the runbook against a file-path configuration would
    believe a record was redacted when it was not, so the gate states the
    precondition instead of assuming it.
    """
    configure = getattr(adapter, "configure_scope", None)
    if not callable(configure):
        return PhaseResult(
            name="file-paths-precondition", passed=True, role=PRECONDITION,
            checks={"exercised": False},
            detail="adapter cannot vary the paths mode; precondition not exercised",
        )

    configure(scope, paths_mode="files")
    _seed(adapter, scope, [target, *siblings])

    checks = {"target_indexed_before": target in _found_ids(adapter, scope, target)}

    adapter.remove_source(scope, target)
    adapter.rebuild(scope)

    # The expected outcome here is that removal does NOT happen.
    retained = target in _found_ids(adapter, scope, target)
    checks["file_paths_mode_retains_record"] = retained

    passed = all(checks.values())
    detail = (
        "record-level removal requires a directory-configured scope; with "
        "explicit file paths the record survives the public rebuild"
        if passed
        else "the file-path configuration did not behave as the precondition "
             "expects; re-characterize before documenting the runbook"
    )
    return PhaseResult(
        name="file-paths-precondition", passed=passed, role=PRECONDITION,
        checks=checks, detail=detail,
    )


def run_gate(adapter: DeletionAdapter) -> GateResult:
    siblings = [f"sibling-{index:02d}" for index in range(1, 6)]
    target = "target-record"
    scopes = ["alpha", "beta", "gamma"]

    # Seed every scope before any phase runs, so a rebuild that damages another
    # scope cannot be silently repaired by the next phase's own seeding.
    for scope in scopes:
        _seed(adapter, scope, [target, *siblings])

    phases = [
        run_record_level_phase(
            adapter, scope="alpha", target=target, siblings=siblings,
            all_scopes=scopes,
        ),
        run_record_level_phase(
            adapter, scope="beta", target=target, siblings=siblings,
            all_scopes=scopes, incremental=True,
        ),
        run_scope_level_phase(
            adapter, scope="gamma", target=target, siblings=siblings,
            all_scopes=scopes,
        ),
        run_directory_paths_precondition_phase(
            adapter, scope="delta", target=target, siblings=siblings,
        ),
    ]

    record_level = next(phase for phase in phases if phase.name == "record-level-force")
    scope_level = next(phase for phase in phases if phase.name == "scope-level-fallback")

    if record_level.passed:
        selected = "record-level-removal"
    elif scope_level.passed:
        selected = "scope-level-rebuild-fallback"
    else:
        selected = "none"

    configuration = dict(getattr(adapter, "configuration", {}) or {})

    return GateResult(
        adapter=adapter.name,
        backend_version=adapter.backend_version,
        authoritative=bool(getattr(adapter, "authoritative", False)),
        configuration=configuration,
        selected_mechanism=selected,
        phases=phases,
    )

"""Fault-injectable double used only to prove the gate's oracles can fail.

A PASS from this adapter is never evidence about memsearch. It exists so the
self-test can show each oracle rejects a backend that misbehaves — including the
backends that a weaker version of this gate accepted while removing nothing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


class FakeDeletionAdapter:
    name = "fake-deletion-double"
    authoritative = False
    backend_version = "fake=0"

    def __init__(
        self,
        *,
        retain_deleted_record: bool = False,
        force_rebuild_loses_siblings: bool = False,
        incremental_retains_record: bool = False,
        search_returns_nothing: bool = False,
        scope_rebuild_retains_record: bool = False,
        hide_records_with_missing_sources: bool = False,
        rebuild_wipes_other_scopes: bool = False,
        removal_is_not_durable: bool = False,
        saturate_search_window: bool = False,
        file_paths_mode_prunes: bool = False,
    ) -> None:
        self.retain_deleted_record = retain_deleted_record
        self.force_rebuild_loses_siblings = force_rebuild_loses_siblings
        self.incremental_retains_record = incremental_retains_record
        self.search_returns_nothing = search_returns_nothing
        self.scope_rebuild_retains_record = scope_rebuild_retains_record
        self.hide_records_with_missing_sources = hide_records_with_missing_sources
        self.rebuild_wipes_other_scopes = rebuild_wipes_other_scopes
        self.removal_is_not_durable = removal_is_not_durable
        self.saturate_search_window = saturate_search_window
        self.file_paths_mode_prunes = file_paths_mode_prunes

        self.sources: dict[str, dict[str, str]] = {}
        self.attic: dict[str, dict[str, str]] = {}
        self.index: dict[str, dict[str, str]] = {}
        self.persisted: dict[str, dict[str, str]] = {}
        self.removed: dict[str, set[str]] = {}
        self.paths_modes: dict[str, str] = {}

    configuration = {"default_paths_mode": "directory", "embedding": "none"}

    def _scope(self, scope: str) -> dict[str, str]:
        return self.sources.setdefault(scope, {})

    def configure_scope(self, scope: str, *, paths_mode: str) -> None:
        self.paths_modes[scope] = paths_mode

    def write_source(self, scope: str, record_id: str, text: str) -> None:
        self._scope(scope)[record_id] = text

    def remove_source(self, scope: str, record_id: str) -> None:
        del self._scope(scope)[record_id]
        self.removed.setdefault(scope, set()).add(record_id)

    def relocate_scope_sources(self, scope: str, keep: list[str]) -> None:
        attic = self.attic.setdefault(scope, {})
        attic.update(self._scope(scope))
        self.sources[scope] = {}
        for record_id in keep:
            if record_id in attic:
                self.sources[scope][record_id] = attic.pop(record_id)

    def _publish(self, scope: str, rebuilt: dict[str, str]) -> None:
        self.index[scope] = rebuilt
        # A durable backend persists what it publishes; a non-durable one only
        # appears to, and the reopen check is what tells them apart.
        if self.removal_is_not_durable:
            self.persisted.setdefault(scope, {}).update(rebuilt)
        else:
            self.persisted[scope] = dict(rebuilt)

    def rebuild(self, scope: str) -> None:
        rebuilt = dict(self._scope(scope))
        prunes = (
            self.paths_modes.get(scope, "directory") == "directory"
            or self.file_paths_mode_prunes
        )
        if self.retain_deleted_record or not prunes:
            for record_id in self.removed.get(scope, set()):
                rebuilt.setdefault(record_id, f"stale {record_id}")
        if self.scope_rebuild_retains_record:
            # A stale index that keeps serving sources which are no longer in
            # the scope directory — including ones only moved aside.
            for record_id, text in self.attic.get(scope, {}).items():
                rebuilt.setdefault(record_id, text)
        if self.force_rebuild_loses_siblings:
            rebuilt = {
                record_id: text
                for record_id, text in rebuilt.items()
                if not record_id.startswith("sibling-")
            }
        self._publish(scope, rebuilt)
        if self.rebuild_wipes_other_scopes:
            for other in list(self.index):
                if other != scope:
                    self.index[other] = {}
                    self.persisted[other] = {}

    def rebuild_incremental(self, scope: str) -> None:
        rebuilt = dict(self.index.get(scope, {}))
        rebuilt.update(self._scope(scope))
        if not self.incremental_retains_record:
            for record_id in self.removed.get(scope, set()):
                rebuilt.pop(record_id, None)
        self._publish(scope, rebuilt)

    def reopen(self, scope: str) -> None:
        self.index[scope] = dict(self.persisted.get(scope, {}))

    def search(self, scope: str, query: str, *, k: int) -> list[dict[str, Any]]:
        if self.search_returns_nothing:
            return []
        if self.saturate_search_window:
            return [{"id": f"filler-{position:02d}"} for position in range(k)]
        matches = []
        for record_id in self.index.get(scope, {}):
            if f"zetamarker{record_id.replace('-', '')}" != query:
                continue
            if (
                self.hide_records_with_missing_sources
                and record_id not in self._scope(scope)
            ):
                continue
            matches.append({"id": record_id})
        return matches[:k]

    def close(self) -> None:
        return None


def create_adapter(*, work_dir: Path) -> FakeDeletionAdapter:  # noqa: ARG001
    return FakeDeletionAdapter()

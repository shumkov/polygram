"""Process-crash partner-publication model for the scoped-memory gate."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Callable


LOGICAL_ID = "logical_partner_gate"
RECORD_ID = "record_partner_gate"
SCOPES = ("partner", "general")
INITIALIZATION_CRASH_POINTS = (
    "before_checkpoint",
    "during_checkpoint",
    "after_checkpoint",
    "before_partner_stage",
    "during_partner_stage",
    "after_partner_stage",
    "before_general_stage",
    "during_general_stage",
    "after_general_stage",
)
RECONCILIATION_CRASH_POINTS = (
    "before_partner_move",
    "after_partner_move",
    "before_general_move",
    "after_general_move",
    "before_partner_index",
    "during_partner_index",
    "after_partner_index",
    "before_general_index",
    "during_general_index",
    "after_general_index",
    "before_activation",
    "during_activation",
    "after_activation",
)
CRASH_POINTS = INITIALIZATION_CRASH_POINTS + RECONCILIATION_CRASH_POINTS


class PublicationNotReady(RuntimeError):
    pass


class PublicationStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.state_path = self.root / "state.sqlite"

    def initialize(
        self,
        content: str,
        crash_point: str | None = None,
        *,
        crash: Callable[[], None] | None = None,
    ) -> None:
        if crash_point is not None and crash_point not in INITIALIZATION_CRASH_POINTS:
            raise ValueError("unknown initialization crash point")

        def inject(point: str) -> None:
            if crash_point == point:
                if crash is None:
                    raise RuntimeError("crash callback is required")
                crash()

        self.root.mkdir(parents=True, exist_ok=True)
        connection = self._state()
        try:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS logical_records (
                    logical_id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ('inactive', 'active'))
                );
                CREATE TABLE IF NOT EXISTS destinations (
                    logical_id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    record_id TEXT NOT NULL,
                    PRIMARY KEY (logical_id, scope),
                    FOREIGN KEY (logical_id) REFERENCES logical_records(logical_id)
                );
                """
            )
            inject("before_checkpoint")
            connection.execute("BEGIN IMMEDIATE")
            logical = connection.execute(
                "SELECT content, state FROM logical_records WHERE logical_id = ?",
                (LOGICAL_ID,),
            ).fetchone()
            if logical is None:
                connection.execute(
                    """
                    INSERT INTO logical_records(logical_id, content, state)
                    VALUES (?, ?, 'inactive')
                    """,
                    (LOGICAL_ID, content),
                )
                connection.executemany(
                    """
                    INSERT INTO destinations(logical_id, scope, record_id)
                    VALUES (?, ?, ?)
                    """,
                    [(LOGICAL_ID, scope, RECORD_ID) for scope in SCOPES],
                )
                state = "inactive"
            else:
                if logical[0] != content:
                    raise PublicationNotReady("checkpoint content differs")
                state = logical[1]
                self._validate_destinations(connection)
            inject("during_checkpoint")
            connection.commit()
        finally:
            connection.close()
        inject("after_checkpoint")

        if state == "active":
            return
        for scope, record_id in self._destinations():
            if self._record_path(scope, record_id).is_file():
                continue
            inject(f"before_{scope}_stage")
            self._write_durable(
                self._staged_path(scope, record_id),
                content,
                before_replace=lambda scope=scope: inject(f"during_{scope}_stage"),
            )
            inject(f"after_{scope}_stage")

    def reconcile(
        self,
        crash_point: str | None = None,
        *,
        crash: Callable[[], None] | None = None,
    ) -> None:
        if crash_point is not None and crash_point not in RECONCILIATION_CRASH_POINTS:
            raise ValueError("unknown crash point")

        def inject(point: str) -> None:
            if crash_point == point:
                if crash is None:
                    raise RuntimeError("crash callback is required")
                crash()

        content = self._content()
        for scope, record_id in self._destinations():
            inject(f"before_{scope}_move")
            self._prepare_body(scope, record_id, content)
            inject(f"after_{scope}_move")

        for scope, record_id in self._destinations():
            inject(f"before_{scope}_index")
            self._prepare_index(
                scope,
                record_id,
                content,
                before_commit=lambda scope=scope: inject(f"during_{scope}_index"),
            )
            inject(f"after_{scope}_index")

        inject("before_activation")
        connection = self._state()
        try:
            connection.execute("BEGIN IMMEDIATE")
            if not self._fully_prepared(content):
                raise PublicationNotReady("linked destinations are incomplete")
            connection.execute(
                "UPDATE logical_records SET state = 'active' WHERE logical_id = ?",
                (LOGICAL_ID,),
            )
            inject("during_activation")
            connection.commit()
        finally:
            connection.close()
        inject("after_activation")

    def recall(self, scope: str) -> list[str]:
        destinations = dict(self._destinations())
        if scope not in destinations:
            raise ValueError("unknown scope")
        content, state = self._logical_record()
        if state != "active":
            return []
        if not self._fully_prepared(content):
            raise PublicationNotReady("active linked destinations require repair")
        return [content]

    def artifact_counts(self) -> dict[str, dict[str, int]]:
        counts = {}
        for scope, record_id in self._destinations():
            body_count = int(self._record_path(scope, record_id).is_file())
            connection = self._index(scope, create=False)
            try:
                index_count = 0 if connection is None else connection.execute(
                    "SELECT COUNT(*) FROM entries WHERE record_id = ?",
                    (record_id,),
                ).fetchone()[0]
            finally:
                if connection is not None:
                    connection.close()
            counts[scope] = {"body": body_count, "index": index_count}
        return counts

    def durable_snapshot(self) -> dict[str, object]:
        connection = self._state()
        try:
            logical_rows = connection.execute(
                "SELECT logical_id, content, state FROM logical_records ORDER BY logical_id"
            ).fetchall()
            destination_rows = connection.execute(
                """
                SELECT logical_id, scope, record_id
                  FROM destinations
                 ORDER BY logical_id, scope
                """
            ).fetchall()
        finally:
            connection.close()

        scopes = {}
        for scope, _record_id in self._destinations():
            index = self._index(scope, create=False)
            try:
                index_rows = [] if index is None else index.execute(
                    "SELECT record_id, content FROM entries ORDER BY record_id"
                ).fetchall()
            finally:
                if index is not None:
                    index.close()
            scopes[scope] = {
                "records": self._file_inventory(self._scope_root(scope) / "records"),
                "staged": self._file_inventory(self._scope_root(scope) / "staged"),
                "index": index_rows,
            }
        return {
            "logical_rows": logical_rows,
            "destination_rows": destination_rows,
            "scopes": scopes,
            "recall": {scope: self.recall(scope) for scope in sorted(scopes)},
        }

    def remove_body_for_gate(self, scope: str) -> None:
        record_id = dict(self._destinations())[scope]
        self._record_path(scope, record_id).unlink()

    def remove_index_for_gate(self, scope: str) -> None:
        record_id = dict(self._destinations())[scope]
        connection = self._index(scope, create=False)
        try:
            if connection is None:
                raise FileNotFoundError("index is absent")
            connection.execute("DELETE FROM entries WHERE record_id = ?", (record_id,))
        finally:
            if connection is not None:
                connection.close()

    def _state(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.state_path, isolation_level=None)
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        return connection

    def _logical_record(self) -> tuple[str, str]:
        connection = self._state()
        try:
            row = connection.execute(
                "SELECT content, state FROM logical_records WHERE logical_id = ?",
                (LOGICAL_ID,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise PublicationNotReady("logical record is absent")
        return row[0], row[1]

    @staticmethod
    def _validate_destinations(connection: sqlite3.Connection) -> tuple[tuple[str, str], ...]:
        rows = tuple(connection.execute(
            """
            SELECT scope, record_id
              FROM destinations
             WHERE logical_id = ?
             ORDER BY scope
            """,
            (LOGICAL_ID,),
        ).fetchall())
        expected = tuple(sorted((scope, RECORD_ID) for scope in SCOPES))
        if rows != expected:
            raise PublicationNotReady("linked destination checkpoint differs")
        return rows

    def _destinations(self) -> tuple[tuple[str, str], ...]:
        connection = self._state()
        try:
            return self._validate_destinations(connection)
        finally:
            connection.close()

    def _content(self) -> str:
        return self._logical_record()[0]

    def _scope_root(self, scope: str) -> Path:
        return self.root / "scopes" / scope

    @staticmethod
    def _file_inventory(root: Path) -> list[tuple[str, str]]:
        if not root.is_dir():
            return []
        return [
            (str(path.relative_to(root)), path.read_text(encoding="utf-8"))
            for path in sorted(root.rglob("*"))
            if path.is_file()
        ]

    def _staged_path(self, scope: str, record_id: str) -> Path:
        return self._scope_root(scope) / "staged" / f"{record_id}.md"

    def _record_path(self, scope: str, record_id: str) -> Path:
        return self._scope_root(scope) / "records" / f"{record_id}.md"

    def _index_path(self, scope: str) -> Path:
        return self._scope_root(scope) / "index.sqlite"

    @staticmethod
    def _write_durable(
        path: Path,
        content: str,
        *,
        before_replace: Callable[[], None] = lambda: None,
    ) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        before_replace()
        os.replace(temporary, path)
        PublicationStore._fsync_directory(path.parent)

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _prepare_body(self, scope: str, record_id: str, content: str) -> None:
        record = self._record_path(scope, record_id)
        if record.is_file():
            if record.read_text(encoding="utf-8") == content:
                return
        staged = self._staged_path(scope, record_id)
        if not staged.is_file() or staged.read_text(encoding="utf-8") != content:
            self._write_durable(staged, content)
        record.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged, record)
        self._fsync_directory(staged.parent)
        self._fsync_directory(record.parent)

    def _index(self, scope: str, *, create: bool) -> sqlite3.Connection | None:
        path = self._index_path(scope)
        if not create and not path.is_file():
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path, isolation_level=None)
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS entries (record_id TEXT PRIMARY KEY, content TEXT NOT NULL)"
        )
        return connection

    def _prepare_index(
        self,
        scope: str,
        record_id: str,
        content: str,
        *,
        before_commit: Callable[[], None],
    ) -> None:
        connection = self._index(scope, create=True)
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO entries(record_id, content) VALUES (?, ?)
                ON CONFLICT(record_id) DO UPDATE SET content = excluded.content
                """,
                (record_id, content),
            )
            before_commit()
            connection.commit()
        finally:
            connection.close()

    def _indexed_content(self, scope: str, record_id: str) -> str | None:
        connection = self._index(scope, create=False)
        try:
            if connection is None:
                return None
            row = connection.execute(
                "SELECT content FROM entries WHERE record_id = ?",
                (record_id,),
            ).fetchone()
        finally:
            if connection is not None:
                connection.close()
        return None if row is None else row[0]

    def _fully_prepared(self, content: str) -> bool:
        return all(
            self._record_path(scope, record_id).is_file()
            and self._record_path(scope, record_id).read_text(encoding="utf-8") == content
            and self._indexed_content(scope, record_id) == content
            for scope, record_id in self._destinations()
        )


class PublicationBootGate:
    def __init__(self, store: PublicationStore) -> None:
        self.store = store
        self.ready = False

    def open(self) -> None:
        self.store.reconcile()
        self.ready = True

    def recall(self, scope: str) -> list[str]:
        if not self.ready:
            raise PublicationNotReady("publication boot reconciliation is incomplete")
        return self.store.recall(scope)

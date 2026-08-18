"""Real memsearch/Milvus-Lite adapter restricted to the documented API.

Reuses the isolation gate's loopback-only deterministic embedding stub, so the
run needs no credential and makes no embedding network request. It measures
storage/removal behaviour only, never semantic quality.

Every memsearch call goes through ``PublicSurface``, which resolves only the
documented high-level API and refuses every other attribute — including the
wrapped instance itself, so ``store.drop()`` cannot be reached through the
wrapper by any accessor, mangled name, or ``__dict__`` lookup.
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import re
import shutil
import sys
import threading
from importlib.metadata import version
from pathlib import Path
from typing import Any


SAFE_ID = re.compile(r"^[a-z0-9-]+$")
PUBLIC_MEMSEARCH_API = frozenset({"index", "search", "close"})
PROXY_ENVIRONMENT_KEYS = (
    "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
    "ALL_PROXY", "all_proxy",
)


def _load_stub_module():
    """Load the sibling stub by path.

    Both spike directories contain modules with identical basenames, so putting
    either on ``sys.path`` makes plain imports resolve by accident of order.
    """
    source = (
        Path(__file__).resolve().parent.parent
        / "memsearch-isolation" / "deployed_memsearch_adapter.py"
    )
    spec = importlib.util.spec_from_file_location(
        "memsearch_isolation_embedding_stub", source,
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CountingLoopbackEmbeddingServer:
    """Loopback embedding stub that counts the requests it actually served.

    The count is what turns "no embedding left this host" from a claim in prose
    into something the evidence can assert: every embedding the run needed was
    answered here, so none of it went to a provider.
    """

    def __init__(self) -> None:
        module = _load_stub_module()

        class _CountingHandler(module._EmbeddingHandler):
            def do_POST(inner) -> None:  # noqa: N805 - handler contract
                inner.server.request_count += 1
                super().do_POST()

        self.server = module._EmbeddingServer(("127.0.0.1", 0), _CountingHandler)
        self.server.request_count = 0
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            name="memsearch-deletion-embeddings",
            daemon=True,
        )
        self.thread.start()

    @property
    def request_count(self) -> int:
        return int(self.server.request_count)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class PrivateSurfaceUsed(RuntimeError):
    """Raised when the gate reaches past the documented MemSearch API."""


class PublicSurface:
    """Attribute firewall around one MemSearch instance.

    The instance is held in a closure rather than an attribute, so there is no
    ``_instance`` to read back through ``__dict__``, ``vars()``, or
    ``object.__getattribute__``.
    """

    __slots__ = ("__resolve",)

    def __init__(self, instance: Any) -> None:
        def resolve(name: str) -> Any:
            return getattr(instance, name)

        object.__setattr__(self, "_PublicSurface__resolve", resolve)

    def __getattribute__(self, name: str) -> Any:
        if name not in PUBLIC_MEMSEARCH_API:
            raise PrivateSurfaceUsed(
                f"{name!r} is outside the documented MemSearch API",
            )
        resolve = object.__getattribute__(self, "_PublicSurface__resolve")
        return resolve(name)

    def __setattr__(self, name: str, value: Any) -> None:
        raise PrivateSurfaceUsed("the gate does not mutate MemSearch attributes")

    def __delattr__(self, name: str) -> None:
        raise PrivateSurfaceUsed("the gate does not delete MemSearch attributes")


class _AsyncWorker:
    def __init__(self, scope: str) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(
            target=self.loop.run_forever,
            name=f"memsearch-deletion-{scope}",
            daemon=True,
        )
        self.thread.start()

    def run(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result()

    def close(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
        self.loop.close()


class DeployedDeletionAdapter:
    name = "memsearch-milvus-lite-deletion"
    authoritative = True

    def __init__(self, *, work_dir: Path):
        expected = os.environ.get("MEMSEARCH_GATE_EXPECTED_VERSION")
        if not expected:
            raise RuntimeError("MEMSEARCH_GATE_EXPECTED_VERSION is required")
        actual = version("memsearch")
        if actual != expected:
            raise RuntimeError("installed memsearch version does not match the gate pin")

        # httpx honours proxy environment variables even for loopback targets, so
        # an ambient proxy would send fixture text off-box while the run still
        # looked local. The embedding-request counter below is the positive proof.
        for key in PROXY_ENVIRONMENT_KEYS:
            os.environ.pop(key, None)
        os.environ["NO_PROXY"] = "127.0.0.1,localhost"
        os.environ["no_proxy"] = "127.0.0.1,localhost"

        from memsearch import MemSearch

        logging.disable(logging.CRITICAL)
        for logger_name in ("pymilvus", "milvus_lite", "memsearch"):
            logging.getLogger(logger_name).setLevel(logging.CRITICAL)

        self.MemSearch = MemSearch
        self.work_dir = work_dir.resolve()
        self.backend_version = f"memsearch={actual};pymilvus={version('pymilvus')}"
        self.embedding_server = CountingLoopbackEmbeddingServer()
        self.instances: dict[str, PublicSurface] = {}
        self.workers: dict[str, _AsyncWorker] = {}
        self.paths_modes: dict[str, str] = {}
        self.max_chunk_size = 512
        self.overlap_lines = 0
        self.collection = "gate_records"
        self.rebuild_chunk_counts: dict[str, int] = {}

    @property
    def configuration(self) -> dict[str, Any]:
        """Fingerprint of what was actually exercised.

        Record-level removal depends on scopes being configured with directory
        roots, so the evidence must carry the configuration rather than leave a
        reader to assume it.
        """
        return {
            "default_paths_mode": "directory",
            "paths_mode_by_scope": dict(self.paths_modes),
            "collection": self.collection,
            "max_chunk_size": self.max_chunk_size,
            "overlap_lines": self.overlap_lines,
            "embedding": "loopback-deterministic-stub",
            "embedding_requests": self.embedding_requests,
        }

    @property
    def embedding_requests(self) -> int:
        return int(getattr(self.embedding_server, "request_count", 0))

    def _guarded(self, path: Path) -> Path:
        resolved = path.resolve()
        if not resolved.is_relative_to(self.work_dir):
            raise ValueError("path escaped the gate work directory")
        return resolved

    def _records_dir(self, scope: str) -> Path:
        if not SAFE_ID.fullmatch(scope):
            raise ValueError("unsafe scope id")
        records = self._guarded(self.work_dir / "sources" / scope / "records")
        records.mkdir(parents=True, exist_ok=True)
        return records

    def _attic_dir(self, scope: str) -> Path:
        if not SAFE_ID.fullmatch(scope):
            raise ValueError("unsafe scope id")
        attic = self._guarded(self.work_dir / "attic" / scope)
        attic.mkdir(parents=True, exist_ok=True)
        return attic

    def configure_scope(self, scope: str, *, paths_mode: str) -> None:
        if paths_mode not in {"directory", "files"}:
            raise ValueError("unsupported paths mode")
        if scope in self.instances:
            raise RuntimeError("scope paths mode must be set before it is opened")
        self.paths_modes[scope] = paths_mode

    def _paths_for(self, scope: str) -> list[Path]:
        records = self._records_dir(scope)
        if self.paths_modes.get(scope, "directory") == "files":
            return sorted(records.glob("*.md"))
        return [records]

    def _open(self, scope: str) -> PublicSurface:
        existing = self.instances.get(scope)
        if existing is not None:
            return existing
        index_root = self.work_dir / "index"
        index_root.mkdir(parents=True, exist_ok=True)
        instance = PublicSurface(self.MemSearch(
            paths=self._paths_for(scope),
            embedding_provider="openai",
            embedding_model="text-embedding-3-small",
            embedding_base_url=self.embedding_server.base_url,
            embedding_api_key="gate-loopback-only",
            embedding_batch_size=16,
            milvus_uri=str(index_root / f"{scope}.db"),
            collection=self.collection,
            description=f"sanitized deletion gate {scope}",
            max_chunk_size=self.max_chunk_size,
            overlap_lines=self.overlap_lines,
        ))
        self.instances[scope] = instance
        self.workers[scope] = _AsyncWorker(scope)
        return instance

    def write_source(self, scope: str, record_id: str, text: str) -> None:
        if not SAFE_ID.fullmatch(record_id):
            raise ValueError("unsafe record id")
        target = self._guarded(self._records_dir(scope) / f"{record_id}.md")
        target.write_text(text, encoding="utf-8")

    def remove_source(self, scope: str, record_id: str) -> None:
        if not SAFE_ID.fullmatch(record_id):
            raise ValueError("unsafe record id")
        self._guarded(self._records_dir(scope) / f"{record_id}.md").unlink()

    def relocate_scope_sources(self, scope: str, keep: list[str]) -> None:
        """Move the scope's Markdown aside, then restore only ``keep``."""
        records = self._records_dir(scope)
        attic = self._attic_dir(scope)
        for path in records.glob("*.md"):
            shutil.move(str(path), str(self._guarded(attic / path.name)))
        for record_id in keep:
            if not SAFE_ID.fullmatch(record_id):
                raise ValueError("unsafe record id")
            source = self._guarded(attic / f"{record_id}.md")
            shutil.move(str(source), str(self._guarded(records / source.name)))

    def _run_index(self, scope: str, *, force: bool) -> None:
        instance = self._open(scope)
        result = self.workers[scope].run(
            instance.index(force=True) if force else instance.index()
        )
        # A rebuild that silently indexed nothing must be visible in evidence:
        # unchanged files keep their existing chunks, so presence checks alone
        # cannot distinguish it from a healthy rebuild.
        if isinstance(result, int):
            self.rebuild_chunk_counts[scope] = result
        elif isinstance(result, dict):
            for key in ("chunks", "indexed", "total_chunks"):
                if isinstance(result.get(key), int):
                    self.rebuild_chunk_counts[scope] = result[key]
                    break

    def rebuild(self, scope: str) -> None:
        self._run_index(scope, force=True)

    def rebuild_incremental(self, scope: str) -> None:
        self._run_index(scope, force=False)

    def reopen(self, scope: str) -> None:
        """Close and reopen the scope so results come from persisted state."""
        instance = self.instances.pop(scope, None)
        if instance is None:
            return
        instance.close()
        self.workers.pop(scope).close()
        self._open(scope)

    def search(self, scope: str, query: str, *, k: int) -> list[dict[str, Any]]:
        instance = self._open(scope)
        results = self.workers[scope].run(instance.search(query, top_k=k))
        normalized = []
        for result in results:
            source = result.get("source") or result.get("path")
            record_id = Path(str(source)).stem if source else str(result.get("hash", "unknown"))
            normalized.append({"id": record_id})
        return normalized

    def close(self) -> None:
        for scope in list(self.instances):
            instance = self.instances.pop(scope)
            worker = self.workers.pop(scope, None)
            try:
                instance.close()
            finally:
                if worker is not None:
                    worker.close()
        self.embedding_server.close()


def create_adapter(*, work_dir: Path) -> DeployedDeletionAdapter:
    return DeployedDeletionAdapter(work_dir=work_dir)

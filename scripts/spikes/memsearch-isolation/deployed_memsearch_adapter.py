"""Real memsearch/Milvus-Lite adapter with loopback-only embeddings.

The deterministic embedding server exists only to exercise storage isolation;
it makes no network calls and gives the gate no semantic-quality claim.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path
from typing import Any


SAFE_ID = re.compile(r"^[a-z0-9-]+$")
EMBEDDING_DIMENSION = 1536


def deterministic_embedding(text: str, *, dimension: int = EMBEDDING_DIMENSION) -> list[float]:
    if dimension < 1:
        raise ValueError("dimension must be positive")
    tokens = re.findall(r"[a-z0-9]+", text.lower()) or ["empty"]
    vector = [0.0] * dimension
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimension
        vector[index] += -1.0 if digest[4] & 1 else 1.0
    magnitude = math.sqrt(sum(value * value for value in vector))
    return [value / magnitude for value in vector]


class _EmbeddingHandler(BaseHTTPRequestHandler):
    server: "_EmbeddingServer"

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path.rstrip("/") != "/v1/embeddings":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", "0"))
        if length < 1 or length > 1_000_000:
            self.send_error(400)
            return
        try:
            payload = json.loads(self.rfile.read(length))
            inputs = payload.get("input", [])
            if isinstance(inputs, str):
                inputs = [inputs]
            if not isinstance(inputs, list) or not all(isinstance(item, str) for item in inputs):
                raise ValueError("input must be text or a text list")
        except (ValueError, json.JSONDecodeError):
            self.send_error(400)
            return
        response = json.dumps({
            "object": "list",
            "model": "text-embedding-3-small",
            "data": [
                {
                    "object": "embedding",
                    "index": index,
                    "embedding": deterministic_embedding(text),
                }
                for index, text in enumerate(inputs)
            ],
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _EmbeddingServer(ThreadingHTTPServer):
    daemon_threads = True


class LoopbackEmbeddingServer:
    def __init__(self) -> None:
        self.server = _EmbeddingServer(("127.0.0.1", 0), _EmbeddingHandler)
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            name="memsearch-gate-embeddings",
            daemon=True,
        )
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class _AsyncWorker:
    def __init__(self, scope: str) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(
            target=self.loop.run_forever,
            name=f"memsearch-gate-{scope}",
            daemon=True,
        )
        self.thread.start()

    def run(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result()

    def close(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
        self.loop.close()


class DeployedMemsearchAdapter:
    name = "memsearch-milvus-lite-loopback"
    authoritative = True

    def __init__(self, *, topology: str, work_dir: Path):
        if topology not in {"shared-file", "per-scope-file"}:
            raise ValueError(f"unsupported topology: {topology}")
        expected = os.environ.get("MEMSEARCH_GATE_EXPECTED_VERSION")
        if not expected:
            raise RuntimeError("MEMSEARCH_GATE_EXPECTED_VERSION is required")
        actual = version("memsearch")
        if actual != expected:
            raise RuntimeError("installed memsearch version does not match the gate pin")

        from memsearch import MemSearch

        logging.disable(logging.CRITICAL)
        for logger_name in ("pymilvus", "milvus_lite", "memsearch"):
            logging.getLogger(logger_name).setLevel(logging.CRITICAL)

        self.MemSearch = MemSearch
        self.topology = topology
        self.work_dir = work_dir
        self.backend_version = f"memsearch={actual};pymilvus={version('pymilvus')}"
        self.embedding_server = LoopbackEmbeddingServer()
        self.instances: dict[str, Any] = {}
        self.workers: dict[str, _AsyncWorker] = {}

    def _scope_paths(self, scope: str) -> tuple[Path, Path]:
        if not SAFE_ID.fullmatch(scope):
            raise ValueError("unsafe scope id")
        root = self.work_dir / "sources" / scope
        records = root / "records"
        staged = root / "staged"
        records.mkdir(parents=True, exist_ok=True)
        staged.mkdir(parents=True, exist_ok=True)
        return records, staged

    def _descriptor(self, scope: str) -> tuple[str, str]:
        index_root = self.work_dir / "index"
        index_root.mkdir(parents=True, exist_ok=True)
        if self.topology == "shared-file":
            return str(index_root / "shared.db"), f"gate_{scope}"
        return str(index_root / f"{scope}.db"), "gate_records"

    def _open(self, scope: str):
        existing = self.instances.get(scope)
        if existing is not None:
            return existing
        records, _staged = self._scope_paths(scope)
        milvus_uri, collection = self._descriptor(scope)
        instance = self.MemSearch(
            paths=[records],
            embedding_provider="openai",
            embedding_model="text-embedding-3-small",
            embedding_base_url=self.embedding_server.base_url,
            embedding_api_key="gate-loopback-only",
            embedding_batch_size=16,
            milvus_uri=milvus_uri,
            collection=collection,
            description=f"sanitized isolation gate {scope}",
            max_chunk_size=512,
            overlap_lines=0,
        )
        self.instances[scope] = instance
        self.workers[scope] = _AsyncWorker(scope)
        return instance

    def write_source(self, scope: str, record_id: str, text: str, *, staged: bool = False) -> None:
        if not SAFE_ID.fullmatch(record_id):
            raise ValueError("unsafe record id")
        records, staged_dir = self._scope_paths(scope)
        target = staged_dir if staged else records
        (target / f"{record_id}.md").write_text(text + "\n", encoding="utf-8")

    def rebuild(self, scope: str) -> None:
        instance = self._open(scope)
        self.workers[scope].run(instance.index(force=True))

    def upsert(self, scope: str, record_id: str, text: str) -> None:
        self.write_source(scope, record_id, text)
        records, _staged = self._scope_paths(scope)
        instance = self._open(scope)
        self.workers[scope].run(instance.index_file(records / f"{record_id}.md"))

    def search(self, scope: str, query: str, *, k: int) -> list[dict[str, Any]]:
        instance = self._open(scope)
        results = self.workers[scope].run(instance.search(query, top_k=k))
        normalized = []
        for result in results:
            source = result.get("source") or result.get("path")
            record_id = Path(str(source)).stem if source else str(result.get("hash", "unknown"))
            normalized.append({"id": record_id})
        return normalized

    def delete_collection(self, scope: str) -> None:
        instance = self._open(scope)
        instance.store.drop()
        instance.close()
        self.instances.pop(scope, None)
        self.workers.pop(scope).close()

    def close(self) -> None:
        for scope, instance in self.instances.items():
            instance.close()
            self.workers[scope].close()
        self.instances.clear()
        self.workers.clear()
        self.embedding_server.close()


def create_adapter(*, topology: str, work_dir: Path) -> DeployedMemsearchAdapter:
    return DeployedMemsearchAdapter(topology=topology, work_dir=work_dir)

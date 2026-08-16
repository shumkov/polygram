"""Writer protocol shared by the gate and its adapters.

Recall and publication never share an interpreter in the intended design, so the
gate's concurrent writer runs as a real OS process. Both sides stamp
``CLOCK_MONOTONIC`` — system-wide on POSIX, therefore comparable between a
parent and its child — so the overlap between the write burst and the measured
read window is read out of evidence instead of assumed.

The writer signals ready only after its first write has succeeded, and keeps
writing until the reader asks it to stop. That is what makes the gate's start
predicate sound: the reader does not stamp its window until it has seen ready,
so "the writer's first write began before the first sample" holds by
construction rather than by luck.

It always performs at least ``count`` distinct record ids first, which keeps the
visibility oracle's expected id set exactly what it was before, and revises the
record body on every later pass: memsearch skips embedding a chunk whose content
hash it already holds, so a writer repeating identical text would keep the loop
busy while doing no storage work at all.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


READY_FILE = "ready"
STOP_FILE = "stop"
RESULT_FILE = "result.json"
STDERR_FILE = "writer.stderr"
POLL_INTERVAL_S = 0.005
TERMINATE_GRACE_S = 5.0
ERROR_DETAIL_LIMIT = 240
ABSOLUTE_PATH = re.compile(r"(?<![\w])/[^\s'\"]*")


def sanitize_error(error: BaseException) -> str:
    """A bounded backend message with every absolute path removed.

    Backends do not always name their failure well — an exclusive-open refusal
    can arrive as advice about file format — so the class name alone can send a
    reader to the wrong conclusion. The message is still evidence, so it carries
    no filesystem path of the host that produced it.
    """

    detail = ABSOLUTE_PATH.sub("<path>", " ".join(str(error).split()))
    if len(detail) > ERROR_DETAIL_LIMIT:
        detail = detail[:ERROR_DETAIL_LIMIT] + "…"
    return detail


class WriterProtocolError(RuntimeError):
    """The writer never reached, or never left, a state the gate can evidence."""


def monotonic_ms() -> float:
    """System-wide monotonic clock in milliseconds.

    ``time.monotonic`` is only guaranteed to be comparable inside one process;
    ``clock_gettime(CLOCK_MONOTONIC)`` is a system clock on Linux and macOS, so
    a parent may compare its own stamps with a child's.
    """

    return time.clock_gettime(time.CLOCK_MONOTONIC) * 1000.0


def run_writer_loop(
    *,
    count: int,
    prefix: str,
    text_prefix: str,
    upsert: Callable[[str, str], Any],
    should_stop: Callable[[], bool],
    on_ready: Callable[[], None],
    deadline_s: float,
    warmup: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Write until the reader stops asking, and return sanitized evidence.

    Ready is signalled after the first write has completed, never before: a
    reader that started measuring on a writer which had only opened its scope
    could not claim the writer was writing across the window. Nothing but
    counters, timings, and a bounded path-free failure description leaves this
    function.
    """

    if count < 1:
        raise ValueError("count must be positive")
    started_ms = monotonic_ms()
    deadline_ms = started_ms + deadline_s * 1000.0
    ops = 0
    indexed_chunks: int | None = None
    first_op_start_ms: float | None = None
    last_op_end_ms: float | None = None
    error_code: str | None = None
    error_detail: str | None = None
    try:
        if warmup is not None:
            warmup()
        while True:
            if first_op_start_ms is None:
                first_op_start_ms = monotonic_ms()
            ordinal = ops % count
            revision = ops // count
            text = f"{text_prefix}{ordinal}"
            if revision:
                text = f"{text} revision {revision}"
            written = upsert(f"{prefix}{ordinal}", text)
            if isinstance(written, int) and not isinstance(written, bool):
                indexed_chunks = (indexed_chunks or 0) + written
            ops += 1
            last_op_end_ms = monotonic_ms()
            if ops == 1:
                on_ready()
            if ops >= count and should_stop():
                break
            if last_op_end_ms >= deadline_ms:
                error_code = "WriterDeadlineExceeded"
                break
    except Exception as error:  # sanitized: class name and bounded message
        error_code = type(error).__name__
        error_detail = sanitize_error(error)
    return {
        "ops": ops,
        "distinct_ids": min(ops, count),
        "revisions": max(0, (ops - 1) // count) if ops else 0,
        "indexed_chunks": indexed_chunks,
        "first_op_start_ms": first_op_start_ms,
        "last_op_end_ms": last_op_end_ms,
        "wall_ms": monotonic_ms() - started_ms,
        "error_code": error_code,
        "error_detail": error_detail,
        "pid": os.getpid(),
    }


def run_child_writer(
    *,
    control_dir: Path,
    count: int,
    prefix: str,
    text_prefix: str,
    upsert: Callable[[str, str], Any],
    deadline_s: float,
    warmup: Callable[[], None] | None = None,
) -> int:
    """Child-process entry point: file-signalled ready/stop, JSON result."""

    control_dir = Path(control_dir)
    control_dir.mkdir(parents=True, exist_ok=True)
    ready_path = control_dir / READY_FILE
    stop_path = control_dir / STOP_FILE
    result_path = control_dir / RESULT_FILE

    payload = run_writer_loop(
        count=count,
        prefix=prefix,
        text_prefix=text_prefix,
        upsert=upsert,
        should_stop=stop_path.exists,
        on_ready=lambda: ready_path.write_text("ready\n", encoding="utf-8"),
        deadline_s=deadline_s,
        warmup=warmup,
    )
    payload["mode"] = "process"
    result_path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    return 0 if payload["error_code"] is None else 1


class WriterProcessHandle:
    """Parent-side handle for a writer running in a separate OS process."""

    mode = "process"

    def __init__(
        self,
        *,
        argv: Sequence[str],
        control_dir: Path,
        env: Mapping[str, str] | None = None,
    ) -> None:
        control_dir = Path(control_dir)
        control_dir.mkdir(parents=True, exist_ok=True)
        self.control_dir = control_dir
        self.ready_path = control_dir / READY_FILE
        self.stop_path = control_dir / STOP_FILE
        self.result_path = control_dir / RESULT_FILE
        self.stderr_path = control_dir / STDERR_FILE
        # A file, not a pipe: the gate never drains the child while it runs, and
        # a full pipe buffer would deadlock the join.
        self._stderr = self.stderr_path.open("wb")
        self.process = subprocess.Popen(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=self._stderr,
            env=dict(env) if env is not None else None,
        )

    def wait_ready(self, timeout_s: float) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.ready_path.exists():
                return
            if self.process.poll() is not None:
                raise WriterProtocolError("writer process exited before signalling ready")
            time.sleep(POLL_INTERVAL_S)
        self.terminate()
        raise WriterProtocolError("writer process did not signal ready before the deadline")

    def request_stop(self) -> None:
        self.stop_path.write_text("stop\n", encoding="utf-8")

    def join(self, timeout_s: float) -> dict[str, Any]:
        try:
            self.process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            self.terminate()
            raise WriterProtocolError("writer process did not exit before the deadline")
        finally:
            self._close_stderr()
        evidence = self._read_result()
        # The result file is the only channel the child reports through, so the
        # gate confirms the file was written by the process it actually spawned
        # before believing anything else in it.
        if evidence.get("pid") != self.process.pid:
            raise WriterProtocolError(
                "writer result evidence came from a different process than the one spawned"
            )
        evidence["exit_code"] = self.process.returncode
        evidence["mode"] = "process"
        evidence["stderr_bytes"] = self._stderr_bytes()
        return evidence

    def terminate(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=TERMINATE_GRACE_S)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=TERMINATE_GRACE_S)
        self._close_stderr()

    def _close_stderr(self) -> None:
        if not self._stderr.closed:
            self._stderr.close()

    def _stderr_bytes(self) -> int:
        try:
            return self.stderr_path.stat().st_size
        except OSError:
            return -1

    def _read_result(self) -> dict[str, Any]:
        if not self.result_path.exists():
            raise WriterProtocolError("writer process left no result evidence")
        try:
            evidence = json.loads(self.result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise WriterProtocolError("writer process result evidence was unreadable")
        if not isinstance(evidence, dict):
            raise WriterProtocolError("writer process result evidence was malformed")
        return evidence

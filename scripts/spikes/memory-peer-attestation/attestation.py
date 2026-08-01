"""Pure peer-attestation decision core for the scoped-memory Linux spike."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class UnitSnapshot:
    main_pid: int
    invocation_id: str
    control_group: str
    active_state: str
    sub_state: str


@dataclass(frozen=True)
class ProcessEvidence:
    executable: str
    cgroups: tuple[str, ...]


@dataclass(frozen=True)
class PeerDecision:
    allowed: bool
    code: str


class PeerAttestor:
    def __init__(
        self,
        *,
        expected_uid: int,
        expected_executable: str,
        snapshot_reader: Callable[[], UnitSnapshot],
        process_reader: Callable[[int], ProcessEvidence],
        pidfd_reader: Callable[[object], int],
    ) -> None:
        self.expected_uid = expected_uid
        self.expected_executable = os.path.realpath(expected_executable)
        self.snapshot_reader = snapshot_reader
        self.process_reader = process_reader
        self.pidfd_reader = pidfd_reader

    @staticmethod
    def _close_pidfd(pidfd: object) -> None:
        if isinstance(pidfd, int):
            os.close(pidfd)
        elif hasattr(pidfd, "close"):
            pidfd.close()

    def verify(
        self,
        *,
        peer_pid: int,
        peer_uid: int,
        peer_pidfd: object | None,
    ) -> PeerDecision:
        if peer_pidfd is None:
            return PeerDecision(False, "peer-pidfd-unavailable")

        try:
            try:
                if self.pidfd_reader(peer_pidfd) != peer_pid:
                    return PeerDecision(False, "peer-pidfd-mismatch")
            except Exception:
                return PeerDecision(False, "peer-exited")

            if peer_uid != self.expected_uid:
                return PeerDecision(False, "uid-mismatch")
            try:
                before = self.snapshot_reader()
            except Exception:
                return PeerDecision(False, "unit-unavailable")

            if before.active_state != "active" or before.sub_state != "running":
                return PeerDecision(False, "unit-not-active")
            if (
                before.main_pid <= 0
                or not before.invocation_id
                or not before.control_group.startswith("/")
            ):
                return PeerDecision(False, "unit-evidence-missing")
            if peer_pid != before.main_pid:
                return PeerDecision(False, "not-main-pid")

            try:
                process = self.process_reader(peer_pid)
            except Exception:
                return PeerDecision(False, "process-evidence-unavailable")
            if os.path.realpath(process.executable) != self.expected_executable:
                return PeerDecision(False, "executable-mismatch")
            if before.control_group not in process.cgroups:
                return PeerDecision(False, "cgroup-mismatch")

            try:
                if self.pidfd_reader(peer_pidfd) != peer_pid:
                    return PeerDecision(False, "peer-pidfd-mismatch")
            except Exception:
                return PeerDecision(False, "peer-exited")

            try:
                after = self.snapshot_reader()
            except Exception:
                return PeerDecision(False, "unit-unavailable")
            if after != before:
                return PeerDecision(False, "unit-changed")
            return PeerDecision(True, "accepted")
        finally:
            self._close_pidfd(peer_pidfd)
